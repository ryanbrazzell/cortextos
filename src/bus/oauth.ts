/**
 * OAuth token rotation system for cortextOS.
 *
 * Manages multi-account Claude OAuth credentials with automatic rotation
 * based on utilization thresholds.
 *
 * Key invariants:
 * - Refresh tokens are one-time use — always write accounts.json atomically
 *   BEFORE any preflight that could fail
 * - CLAUDE_CODE_OAUTH_TOKEN is a bare access token string (not JSON blob)
 * - accounts.json lives at state/oauth/accounts.json (per-instance, not per-org)
 * - Usage cache TTL = 3 minutes (API rate limit ~5 req/token)
 */

import { existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';

// --- Types ---

export interface OAuthAccount {
  label: string;
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix ms
  last_refreshed: string; // ISO 8601
  five_hour_utilization: number; // 0.0–1.0
  seven_day_utilization: number; // 0.0–1.0
}

export interface AccountsStore {
  active: string;
  accounts: Record<string, OAuthAccount>;
  rotation_log: RotationLogEntry[];
}

export interface RotationLogEntry {
  timestamp: string;
  from: string;
  to: string;
  reason: string;
  five_hour_util: number;
  seven_day_util: number;
}

export interface UsageSnapshot {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  fetched_at: string;
}

export interface UsageCache {
  snapshot: UsageSnapshot;
  expires_at: number; // Unix ms
}

export interface CheckUsageResult {
  account: string;
  five_hour_utilization: number;
  seven_day_utilization: number;
  cached: boolean;
  fetched_at: string;
}

export interface RotateResult {
  rotated: boolean;
  reason: string;
  from?: string;
  to?: string;
}

const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const ROTATION_LOG_MAX = 50;

// Utilization thresholds for rotation trigger
const THRESHOLD_5H = 0.85;
const THRESHOLD_7D = 0.80;
// Alert thresholds (warn before rotating)
export const ALERT_5H = 0.80;
export const ALERT_7D = 0.70;

// --- Path helpers ---

function oauthDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth');
}

function accountsPath(ctxRoot: string): string {
  return join(oauthDir(ctxRoot), 'accounts.json');
}

function usageDir(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'usage');
}

function usageCachePath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'cache.json');
}

function usageLatestPath(ctxRoot: string): string {
  return join(usageDir(ctxRoot), 'latest.json');
}

function usageDailyPath(ctxRoot: string): string {
  const today = new Date().toISOString().split('T')[0];
  return join(usageDir(ctxRoot), `${today}.jsonl`);
}

// --- Account store helpers ---

export function loadAccounts(ctxRoot: string): AccountsStore | null {
  const path = accountsPath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccountsStore;
  } catch {
    return null;
  }
}

function saveAccounts(ctxRoot: string, store: AccountsStore): void {
  ensureDir(oauthDir(ctxRoot));
  const path = accountsPath(ctxRoot);
  atomicWriteSync(path, JSON.stringify(store, null, 2));
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

/**
 * Run a read-modify-write against accounts.json under an inter-process mutex.
 *
 * The atomic rename inside `saveAccounts` makes each individual WRITE safe. It
 * does nothing for the load → mutate → save *sequence* around it: two processes
 * that both load before either saves will each write a whole-store snapshot,
 * and the later writer silently reverts the earlier one's account. For an
 * account that just refreshed, the reverted value is an already-spent
 * refresh_token, so the next refresh fails and the account is stranded.
 *
 * The store is re-loaded INSIDE the lock — callers must apply their change to
 * the store handed to `mutate`, never to a copy read before the lock.
 *
 * `mutate` MUST be synchronous. `withFileLockSync` is a synchronous mutex, so
 * anything deferred past its return (an await, a callback) runs UNLOCKED. Do
 * network work before calling this and apply only the result in here.
 *
 * `afterCommit` runs INSIDE the same critical section, immediately after
 * accounts.json is saved, and only on the path where it was saved. It exists for
 * writes that must not be observable separately from the commit — see phase 2 of
 * rotateOAuth, where a lock released between the two leaves agents holding a
 * token accounts.json no longer names as active. It deliberately runs after the
 * save rather than inside `mutate`, so the durability order (accounts.json, then
 * anything derived from it) is the same as when the two were separate.
 *
 * It carries the same synchronous requirement as `mutate`: an `async` afterCommit
 * type-checks against a `void` return, then resumes its body after the lock is
 * gone and silently reinstates the exact bug this parameter was added to remove.
 * The thenable check below DETECTS that; it does not prevent it. By the time a
 * Promise comes back the callback has already started, and throwing here cannot
 * cancel its post-await continuation — that continuation still runs unlocked,
 * and its rejection surfaces as an unhandled one rather than through this throw.
 * The check is a loud failure at the call site instead of a silent race, and
 * that is all it is. `mutate` has the identical trap with no check at all; it is
 * left alone rather than widening this change to three existing call sites that
 * are all synchronous today.
 *
 * If `afterCommit` throws, accounts.json has ALREADY been replaced — this
 * function throws instead of returning true, so a caller cannot distinguish
 * "committed, follow-up failed" from "committed nothing" by return value alone.
 * Treat a throw as "the commit landed, the follow-up state is unknown". No
 * current caller can reach it (writeTokenToAgents swallows every per-agent
 * error), but the contract permits it.
 *
 * Returns false without writing when accounts.json is missing or `mutate`
 * returns false; callers decide whether that is benign or an error.
 */
function withAccountsLock(
  ctxRoot: string,
  mutate: (store: AccountsStore) => boolean,
  afterCommit?: (store: AccountsStore) => void,
): boolean {
  const dir = oauthDir(ctxRoot);
  ensureDir(dir);
  return withFileLockSync(dir, () => {
    const store = loadAccounts(ctxRoot);
    if (!store) return false;
    if (!mutate(store)) return false;
    saveAccounts(ctxRoot, store);
    if (afterCommit) {
      const returned: unknown = afterCommit(store);
      if (typeof (returned as { then?: unknown } | null | undefined)?.then === 'function') {
        throw new Error(
          'withAccountsLock: afterCommit returned a thenable. It must be synchronous — ' +
          'its body would otherwise resume after the lock is released.',
        );
      }
    }
    return true;
  });
}

/**
 * A witness for "has any rotation committed since this store was read".
 *
 * `active` cannot answer that question. A -> B -> A inside one call's await
 * window leaves `active` byte-identical to the snapshot while two rotations
 * have landed, so an active-compare sees no race and a decision made before
 * either of them commits over both — writing a rotation_log entry for a
 * transition that never happened and pushing a superseded account's token to
 * every agent. That is the ABA hole, and it is why the guard needs a second
 * predicate rather than a sharper version of the first.
 *
 * rotation_log is the store's only append-on-every-rotation field, so its head
 * changes exactly when a rotation commits — including the A -> B -> A case,
 * where the head afterwards describes B -> A rather than whatever preceded it.
 *
 * The LENGTH is deliberately not used: the log is sliced to ROTATION_LOG_MAX,
 * so at steady state it stops growing while rotations keep happening, and a
 * length compare would silently stop detecting anything at exactly the point
 * the store has seen the most rotations.
 *
 * Compares equal for an empty or absent log, which is correct: no rotation has
 * ever committed, so there is nothing for a competing one to have changed yet.
 */
function rotationWitness(store: AccountsStore): string {
  return JSON.stringify(store.rotation_log?.[0] ?? null);
}

export function getActiveAccount(ctxRoot: string): { name: string; account: OAuthAccount } | null {
  const store = loadAccounts(ctxRoot);
  if (!store) return null;
  const account = store.accounts[store.active];
  if (!account) return null;
  return { name: store.active, account };
}

// --- Usage cache helpers ---

function loadCache(ctxRoot: string): UsageCache | null {
  const path = usageCachePath(ctxRoot);
  if (!existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, 'utf-8')) as UsageCache;
    return cache;
  } catch {
    return null;
  }
}

function saveCache(ctxRoot: string, snapshot: UsageSnapshot): void {
  ensureDir(usageDir(ctxRoot));
  const cache: UsageCache = {
    snapshot,
    expires_at: Date.now() + CACHE_TTL_MS,
  };
  atomicWriteSync(usageCachePath(ctxRoot), JSON.stringify(cache, null, 2));
  atomicWriteSync(usageLatestPath(ctxRoot), JSON.stringify(snapshot, null, 2));

  // Append to daily JSONL log
  const { appendFileSync } = require('fs');
  try {
    appendFileSync(usageDailyPath(ctxRoot), JSON.stringify(snapshot) + '\n');
  } catch { /* ignore */ }
}

// --- check-usage-api ---

/**
 * Fetch utilization from Anthropic usage API for the active account.
 * Respects 3-minute TTL cache to avoid hitting rate limits.
 */
export async function checkUsageApi(
  ctxRoot: string,
  opts: { force?: boolean; account?: string; accessToken?: string } = {},
): Promise<CheckUsageResult> {
  // Check cache first (unless force)
  if (!opts.force) {
    const cache = loadCache(ctxRoot);
    if (cache && cache.expires_at > Date.now()) {
      return { ...cache.snapshot, cached: true };
    }
  }

  // Determine which account to check
  let accessToken: string | undefined;
  let accountName: string;

  if (opts.account) {
    if (opts.accessToken !== undefined) {
      // The caller pinned the exact credential to verify. rotateOAuth needs
      // this: it uses the preflight to prove that one specific token works and
      // then guards the commit on that same token still being on file. If this
      // function re-read the store instead, "the preflighted credential" would
      // be whatever a concurrent refresh happened to leave behind at the moment
      // of THIS read — a different instant from the caller's — and the guard
      // downstream would be comparing against a token it never verified.
      accessToken = opts.accessToken;
      accountName = opts.account;
    } else {
      const store = loadAccounts(ctxRoot);
      const acct = store?.accounts[opts.account];
      if (!acct) throw new Error(`Account "${opts.account}" not found in accounts.json`);
      accessToken = acct.access_token;
      accountName = opts.account;
    }
  } else {
    // Fall back to env / Keychain
    const active = getActiveAccount(ctxRoot);
    if (active) {
      accessToken = active.account.access_token;
      accountName = active.name;
    } else {
      accessToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      accountName = 'env';
      if (!accessToken) throw new Error('No OAuth token available (no accounts.json and CLAUDE_CODE_OAUTH_TOKEN not set)');
    }
  }

  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });

  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}: ${await response.text()}`);
  }

  // The Anthropic OAuth usage API returns NESTED objects:
  //   { five_hour: { utilization, resets_at }, seven_day: {...}, ... }
  // The earlier flat-only parsing always returned undefined → normalize → 0
  // → "100% remaining" regardless of real usage. That made the watchdog
  // blind to real burn (it tripped only on ccusage's heuristic) and
  // hid Sondre's actual quota in the dashboard. Keep flat fallbacks in
  // case the API ever returns either shape.
  const data = await response.json() as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  // Convert percentage points → fraction. The usage API reports utilization on a
  // 0–100 scale, ALWAYS — `seven_day.utilization: 4.0` means 4%, not 400%.
  //
  // This was previously `v > 1 ? v / 100 : v`, which assumed any value <= 1 was
  // already a fraction. That inflated the entire 0–1% band by 100x: a real 1%
  // came through as 1.0 (= 100%). Consequences were not cosmetic — the value is
  // persisted to accounts.json below, where rotateOAuth reads it against
  // THRESHOLD_5H (0.85), so an almost-idle account could trigger a rotation, and
  // the watchdog fired CODE RED alerts on ~1% real usage.
  const normalize = (v: number | undefined) => {
    if (v === undefined) return 0;
    return v / 100;
  };

  const fiveHour = normalize(
    data.five_hour?.utilization ?? data.five_hour_utilization ?? data.fiveHourUtilization,
  );
  const sevenDay = normalize(
    data.seven_day?.utilization ?? data.seven_day_utilization ?? data.sevenDayUtilization,
  );
  const fetchedAt = new Date().toISOString();

  const snapshot: UsageSnapshot = {
    account: accountName,
    five_hour_utilization: fiveHour,
    seven_day_utilization: sevenDay,
    fetched_at: fetchedAt,
  };

  // Update cache and accounts.json utilization fields
  saveCache(ctxRoot, snapshot);

  // Same read-modify-write shape as the refresh path: the whole store is
  // rewritten, so it must re-read under the lock. A missing store or account is
  // benign here (utilization is a cache), hence the ignored return.
  withAccountsLock(ctxRoot, (store) => {
    const account = store.accounts[accountName];
    if (!account) return false;
    account.five_hour_utilization = fiveHour;
    account.seven_day_utilization = sevenDay;
    return true;
  });

  return { ...snapshot, cached: false };
}

// --- refresh-oauth-token ---

/**
 * Refresh an OAuth token for the given account.
 * CRITICAL: writes accounts.json atomically BEFORE returning.
 * Refresh tokens are one-time use — the write must never be deferred.
 */
export async function refreshOAuthToken(
  ctxRoot: string,
  accountName?: string,
): Promise<{ account: string; expires_at: number }> {
  const store = loadAccounts(ctxRoot);
  if (!store) throw new Error('No accounts.json found. Cannot refresh.');

  const name = accountName || store.active;
  const account = store.accounts[name];
  if (!account) throw new Error(`Account "${name}" not found in accounts.json`);
  if (!account.refresh_token) throw new Error(`Account "${name}" has no refresh_token`);

  const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Token refresh response missing access_token or refresh_token');
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

  // ATOMIC WRITE — must happen before any further use of the new tokens.
  // Locked read-modify-write: `store` above was loaded BEFORE the await and is
  // now potentially stale, so the new tokens are applied to a copy re-read
  // inside the lock. Writing `store` back here would revert any account another
  // process refreshed while this fetch was in flight.
  const persisted = withAccountsLock(ctxRoot, (fresh) => {
    const current = fresh.accounts[name];
    if (!current) return false;
    fresh.accounts[name] = {
      ...current,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      last_refreshed: new Date().toISOString(),
    };
    return true;
  });

  if (!persisted) {
    // The refresh already succeeded, so the OLD refresh_token is spent. Failing
    // loudly is the only honest option — swallowing this loses the only copy of
    // the new one and strands the account on a token the server has revoked.
    throw new Error(
      `Refreshed account "${name}" but could not persist the new tokens: ` +
      `accounts.json or the account entry disappeared mid-refresh. ` +
      `The previous refresh_token is now spent.`,
    );
  }

  return { account: name, expires_at: expiresAt };
}

// --- rotate-oauth ---

/**
 * Rotate the active OAuth account based on utilization thresholds.
 *
 * Two-phase write, both phases in ONE critical section:
 *   Phase 1: accounts.json (permanent, written after refresh)
 *   Phase 2: agent .env files (conditional on preflight passing)
 *
 * The phases are ordered but not separable. A lock released between them lets a
 * competing rotation commit and distribute in the gap, after which this call's
 * phase 2 overwrites every agent .env with the token its own — now superseded —
 * phase 1 chose.
 */
export async function rotateOAuth(
  ctxRoot: string,
  frameworkRoot: string,
  org: string,
  opts: { reason?: string; agent?: string; force?: boolean } = {},
): Promise<RotateResult> {
  const store = loadAccounts(ctxRoot);
  if (!store) return { rotated: false, reason: 'No accounts.json found' };

  const currentName = store.active;
  const current = store.accounts[currentName];
  if (!current) return { rotated: false, reason: `Active account "${currentName}" not found` };

  // Captured from the SAME read as `currentName` — the whole point is that both
  // describe the store as it looked before the awaits below. See rotationWitness.
  const witness = rotationWitness(store);

  // Check utilization thresholds (or force flag)
  const needsRotation = opts.force ||
    current.five_hour_utilization >= THRESHOLD_5H ||
    current.seven_day_utilization >= THRESHOLD_7D;

  if (!needsRotation) {
    return {
      rotated: false,
      reason: `Utilization within limits (5h: ${pct(current.five_hour_utilization)}, 7d: ${pct(current.seven_day_utilization)})`,
    };
  }

  // Find the next account with lowest 5h utilization
  const candidates = Object.entries(store.accounts)
    .filter(([name]) => name !== currentName)
    .sort(([, a], [, b]) => a.five_hour_utilization - b.five_hour_utilization);

  if (candidates.length === 0) {
    return { rotated: false, reason: 'No alternate accounts available for rotation' };
  }

  let [nextName, nextAccount] = candidates[0];

  // Refresh next account token if expiring within 2 hours
  if (nextAccount.expires_at - Date.now() < 2 * 60 * 60 * 1000) {
    await refreshOAuthToken(ctxRoot, nextName);
    // Reload after refresh (accounts.json was rewritten)
    const refreshed = loadAccounts(ctxRoot)!;
    nextAccount = refreshed.accounts[nextName];
    if (!nextAccount) {
      // The destination was deleted while we refreshed it. Checked here because
      // the capture below dereferences it; without this the call dies on a
      // TypeError instead of returning the same benign "cannot rotate" result
      // every other vanished-destination path returns.
      return {
        rotated: false,
        reason: `Account "${nextName}" disappeared from accounts.json during token refresh`,
      };
    }
  }

  // The exact credential this rotation is about to verify, captured BEFORE the
  // preflight await and passed into it, so that "the token that was preflighted"
  // is defined by this line rather than inferred from a later read of a store
  // that anyone may have rewritten in between.
  const preflightedToken = nextAccount.access_token;

  // PREFLIGHT: verify next account's token works
  let preflight: CheckUsageResult;
  try {
    preflight = await checkUsageApi(ctxRoot, {
      force: true,
      account: nextName,
      accessToken: preflightedToken,
    });
  } catch (err) {
    // Preflight failed — do NOT write .env files
    return {
      rotated: false,
      reason: `Preflight failed for account "${nextName}": ${err}`,
    };
  }

  // PHASE 1: Update accounts.json (active + rotation_log)
  // Locked: the preflight above is awaited, so anything read before it is stale.
  const logEntry: RotationLogEntry = {
    timestamp: new Date().toISOString(),
    from: currentName,
    to: nextName,
    reason: opts.reason || buildRotationReason(current),
    five_hour_util: current.five_hour_utilization,
    seven_day_util: current.seven_day_utilization,
  };

  // Everything decided above — rotate AWAY from `currentName`, TO `nextName` —
  // rests on a snapshot read before the refresh and preflight awaits. If another
  // rotation (or an admin edit) moved `active` during those awaits, that premise
  // is void: someone else has already rotated, to a destination THEY preflighted.
  // Committing here would demote a verified newer selection to a staler one and
  // append a from->to entry describing a transition that never happened.
  //
  // Abort rather than recompute. Recomputing the destination inside the lock
  // would pick an account this call never refreshed and never preflighted, so a
  // race that had already resolved correctly would be traded for an unverified
  // token written to every agent's .env — the one invariant rotation exists to
  // protect.
  //
  // TWO predicates, because they detect different things and neither implies
  // the other. `active` moving catches a competing rotation or an admin edit
  // that left the store somewhere new. The rotation witness catches a rotation
  // that committed and landed `active` back on `currentName` — A -> B -> A —
  // which the first predicate reports as "no race" precisely when two rotations
  // have happened. An admin edit that restores `active` by hand appends no log
  // entry and is indistinguishable from no change at all; that is accepted, and
  // is the same blind spot the store has had all along.
  let supersededBy: string | undefined;
  let raced = false;
  let credentialMoved = false;
  const committed = withAccountsLock(ctxRoot, (reloaded) => {
    if (reloaded.active !== currentName) {
      supersededBy = reloaded.active;
      return false;
    }
    if (rotationWitness(reloaded) !== witness) {
      raced = true;
      return false;
    }
    const next = reloaded.accounts[nextName];
    if (!next) return false;
    // The destination survived by NAME, but the preflight proved a token, not a
    // name. A concurrent refresh or an admin edit can swap this account's
    // credential inside the same await window, and then the thing that was
    // verified and the thing about to be distributed are two different tokens.
    // Neither predicate above sees it: `active` never moved and no rotation
    // committed, so this is a third, independent way for the decision's premise
    // to go stale.
    //
    // Abort rather than distribute the newer token: an unverified credential
    // written to every agent .env breaks every agent at once, and not
    // distributing an unpreflighted token is the invariant the preflight exists
    // to enforce.
    //
    // The cost is NOT zero, and the tradeoff is deliberate. Anything that
    // refreshes this account in step with the rotation cycle — a synchronized
    // watchdog, an admin reconciler — can keep landing inside this same window
    // and starve rotation, leaving an over-quota account active. That is a real
    // failure mode; it is accepted here because its worst case is degraded
    // throughput on an account that still works, while the alternative's worst
    // case is every agent holding a credential nobody checked. A bounded retry
    // on a fresh snapshot would relieve it without weakening the invariant.
    if (next.access_token !== preflightedToken) {
      credentialMoved = true;
      return false;
    }
    reloaded.active = nextName;
    next.five_hour_utilization = preflight.five_hour_utilization;
    next.seven_day_utilization = preflight.seven_day_utilization;
    reloaded.rotation_log = [logEntry, ...reloaded.rotation_log].slice(0, ROTATION_LOG_MAX);
    return true;
  },
  // PHASE 2, inside the SAME critical section as phase 1 rather than after it.
  //
  // Distribute the token the guard above just proved is both preflighted and
  // committed — NOT a fresh read of the store. That read happened after the
  // lock was released, so a refresh landing in the gap would push a token no
  // one verified to every agent, re-opening on the unlocked side exactly the
  // hole the in-lock credential check closes. It also dropped the store's
  // reload behind a non-null assertion that would throw if accounts.json became
  // unreadable in that same gap.
  //
  // Holding the lock across it closes a second, independent hole. With phase 2
  // outside, a rotation that had already committed could be descheduled here
  // while another process ran a whole rotation — commit and distribution both —
  // and then overwrite every agent .env with its own superseded token. The
  // store named the winner while every agent ran the loser, and a partial
  // interleave could strand different agents on different tokens. Serializing
  // the two writes is what makes "the active account and the distributed token
  // agree" a property of the file rather than of scheduling luck.
  //
  // Scope of that claim, precisely — it is narrower than "atomic" on its own
  // suggests. It serializes rotation's two writes against another WRITER. It
  // does not make them atomic to a READER: nothing that reads an agent .env
  // takes this lock, so an agent starting up mid-distribution can still observe
  // some .env files updated and others not. And it does not make accounts.json
  // and the .env files agree in general — refreshOAuthToken commits a new
  // access_token for an account without touching any .env, an `opts.agent`-scoped
  // rotation updates one agent and leaves the rest, and writeTokenToAgents
  // swallows per-agent write failures, so a rotation can report success having
  // updated only some agents. All three survive this change untouched.
  //
  // Cost, deliberately accepted: the lock is now held across N synchronous
  // .env writes instead of released before them. Those are microseconds against
  // withFileLockSync's 5s acquire timeout, but the extra contention is not paid
  // by rotation — it is paid by a concurrent refreshOAuthToken, whose persist
  // throws on acquire timeout AFTER the network refresh has already spent the
  // old refresh_token. Small odds, expensive failure; worth naming rather than
  // rounding to zero.
  () => writeTokenToAgents(frameworkRoot, org, preflightedToken, opts.agent));

  if (!committed) {
    // Distinguish a lost race from a corrupted store — they need different
    // responses, and the generic message reads as data loss for a benign race.
    // Three distinct outcomes, kept distinct. The ABA case must NOT reuse the
    // superseded wording: it would render as active changing from "primary" to
    // "primary", which reads as a bug in the guard rather than a description of
    // one it caught.
    let reason: string;
    if (supersededBy !== undefined) {
      reason = `Rotation superseded: active account changed from "${currentName}" to "${supersededBy}" `
        + `while this rotation was preflighting "${nextName}"; not overwriting the newer selection`;
    } else if (raced) {
      reason = `Rotation superseded: another rotation committed while this one was preflighting `
        + `"${nextName}" and left "${currentName}" active again; this decision predates it and `
        + `is not being applied`;
    } else if (credentialMoved) {
      reason = `Rotation aborted: the credential for "${nextName}" changed between preflight and `
        + `commit, so the token this rotation verified is no longer the one on file; not `
        + `distributing an unpreflighted token`;
    } else {
      reason = `Account "${nextName}" disappeared from accounts.json before the rotation could be committed`;
    }
    return { rotated: false, reason };
  }

  return {
    rotated: true,
    reason: logEntry.reason,
    from: currentName,
    to: nextName,
  };
}

// --- Helpers ---

function buildRotationReason(account: OAuthAccount): string {
  if (account.five_hour_utilization >= THRESHOLD_5H) {
    return `5h utilization at ${pct(account.five_hour_utilization)} (threshold: ${pct(THRESHOLD_5H)})`;
  }
  return `7d utilization at ${pct(account.seven_day_utilization)} (threshold: ${pct(THRESHOLD_7D)})`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Write the bare access token to agent .env files.
 * Writes CLAUDE_CODE_OAUTH_TOKEN=<token> — bare string, not JSON.
 * Scoped to a specific agent if opts.agent is set, otherwise all agents in org.
 */
function writeTokenToAgents(
  frameworkRoot: string,
  org: string,
  token: string,
  targetAgent?: string,
): void {
  const agentsBase = join(frameworkRoot, 'orgs', org, 'agents');
  if (!existsSync(agentsBase)) return;

  const { readdirSync, writeFileSync } = require('fs');

  let agentNames: string[];
  if (targetAgent) {
    agentNames = [targetAgent];
  } else {
    try {
      agentNames = readdirSync(agentsBase, { withFileTypes: true })
        .filter((d: { isDirectory(): boolean }) => d.isDirectory())
        .map((d: { name: string }) => d.name);
    } catch {
      return;
    }
  }

  for (const name of agentNames) {
    const envPath = join(agentsBase, name, '.env');
    if (!existsSync(envPath)) continue;

    try {
      let content = readFileSync(envPath, 'utf-8');

      if (content.includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
        // Replace existing line
        content = content.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*$/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
        );
      } else {
        // Append new line
        content = content.trimEnd() + `\nCLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
      }

      atomicWriteSync(envPath, content);
      try { chmodSync(envPath, 0o600); } catch { /* ignore */ }
    } catch { /* skip agents whose .env we can't write */ }
  }
}
