import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Delegating spy on the lock boundary: records which directory each
// read-modify-write locked, while still running the REAL lock so behaviour is
// unchanged. Lets a single-process test assert the lock is actually applied.
// `lockedSections` additionally records what each locked critical section did to
// `active`, so a test can attribute a lock to the specific write it cares about
// rather than to a total count of acquisitions (which couples unrelated call
// sites together and misreports which one regressed).
const { lockedDirs, lockedSections } = vi.hoisted(() => ({
  lockedDirs: [] as string[],
  lockedSections: [] as { dir: string; activeBefore?: string; activeAfter?: string }[],
}));
vi.mock('../../../src/utils/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/lock.js')>();
  return {
    ...actual,
    withFileLockSync: <T,>(dir: string, fn: () => T, opts?: unknown): T => {
      lockedDirs.push(dir);
      const { readFileSync } = require('fs') as typeof import('fs');
      const { join: pjoin } = require('path') as typeof import('path');
      const readActive = (): string | undefined => {
        try {
          return JSON.parse(readFileSync(pjoin(dir, 'accounts.json'), 'utf-8')).active;
        } catch {
          return undefined;
        }
      };
      // Read INSIDE the delegating wrapper but OUTSIDE the real lock body is not
      // possible without racing, so both reads happen within the real critical
      // section by wrapping `fn` itself.
      return actual.withFileLockSync(
        dir,
        () => {
          const activeBefore = readActive();
          const result = fn();
          lockedSections.push({ dir, activeBefore, activeAfter: readActive() });
          return result;
        },
        opts as never,
      );
    },
  };
});

// Spy on the persistence boundary so the refresh-durability tests below can
// observe WHEN the write happens and simulate it failing. The default
// implementation is the real one, so every other test here is unaffected.
vi.mock('../../../src/utils/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/atomic.js')>();
  return { ...actual, atomicWriteSync: vi.fn(actual.atomicWriteSync) };
});

const actualAtomic = await vi.importActual<typeof import('../../../src/utils/atomic.js')>(
  '../../../src/utils/atomic.js',
);
const { atomicWriteSync } = await import('../../../src/utils/atomic.js');
const mockAtomicWrite = vi.mocked(atomicWriteSync);

const {
  loadAccounts,
  getActiveAccount,
  checkUsageApi,
  refreshOAuthToken,
  rotateOAuth,
  ALERT_5H,
  ALERT_7D,
} = await import('../../../src/bus/oauth.js');

// Use 4h expiry to stay above the 2h refresh-before-use threshold
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const SAMPLE_STORE = {
  active: 'primary',
  accounts: {
    primary: {
      label: 'Primary Account',
      access_token: 'tok_primary_abc',
      refresh_token: 'rtok_primary_xyz',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.3,
      seven_day_utilization: 0.2,
    },
    secondary: {
      label: 'Secondary Account',
      access_token: 'tok_secondary_def',
      refresh_token: 'rtok_secondary_uvw',
      expires_at: Date.now() + FOUR_HOURS_MS,
      last_refreshed: '2026-04-05T00:00:00Z',
      five_hour_utilization: 0.1,
      seven_day_utilization: 0.05,
    },
  },
  rotation_log: [],
};

let tmpDir: string;

function oauthDirPath() {
  return join(tmpDir, 'state', 'oauth');
}

function accountsFile() {
  return join(oauthDirPath(), 'accounts.json');
}

function writeStore(store = SAMPLE_STORE) {
  const { mkdirSync, writeFileSync } = require('fs');
  mkdirSync(oauthDirPath(), { recursive: true });
  writeFileSync(accountsFile(), JSON.stringify(store, null, 2));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortextos-oauth-test-'));
  mockFetch.mockReset();
  // Full reset, then reinstall the real implementation — mockClear() would
  // leave a mockImplementationOnce queued by a failed test to leak forward.
  mockAtomicWrite.mockReset();
  mockAtomicWrite.mockImplementation(actualAtomic.atomicWriteSync);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('loadAccounts', () => {
  it('returns null when no accounts.json', () => {
    expect(loadAccounts(tmpDir)).toBeNull();
  });

  it('loads valid accounts.json', () => {
    writeStore();
    const store = loadAccounts(tmpDir);
    expect(store?.active).toBe('primary');
    expect(store?.accounts.primary.access_token).toBe('tok_primary_abc');
  });
});

describe('getActiveAccount', () => {
  it('returns null when no store', () => {
    expect(getActiveAccount(tmpDir)).toBeNull();
  });

  it('returns active account', () => {
    writeStore();
    const result = getActiveAccount(tmpDir);
    expect(result?.name).toBe('primary');
    expect(result?.account.access_token).toBe('tok_primary_abc');
  });
});

describe('checkUsageApi', () => {
  it('fetches and caches usage data', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 42, seven_day_utilization: 18 }),
    });

    const result = await checkUsageApi(tmpDir);
    expect(result.five_hour_utilization).toBeCloseTo(0.42);
    expect(result.seven_day_utilization).toBeCloseTo(0.18);
    expect(result.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('converts percentage points to a fraction', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 42, seven_day_utilization: 18 }),
    });

    const result = await checkUsageApi(tmpDir, { force: true });
    expect(result.five_hour_utilization).toBeCloseTo(0.42);
    expect(result.seven_day_utilization).toBeCloseTo(0.18);
  });

  // Regression: normalize() used to be `v > 1 ? v / 100 : v`, so the whole
  // 0–1% band was inflated 100x. A real 1% arrived as 1.0 (= 100%), which is
  // both a false CODE RED and — because the value is persisted to
  // accounts.json — enough to trip rotateOAuth's 0.85 threshold on an
  // almost-idle account. Values above 1% were unaffected, which is why this
  // survived: it only misfires when usage is low.
  it('does not inflate sub-1% utilization (regression)', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 1 },
        seven_day: { utilization: 4 },
      }),
    });

    const result = await checkUsageApi(tmpDir, { force: true });
    expect(result.five_hour_utilization).toBeCloseTo(0.01);
    expect(result.seven_day_utilization).toBeCloseTo(0.04);
    // Must stay well clear of THRESHOLD_5H (0.85) — the rotation trigger.
    expect(result.five_hour_utilization).toBeLessThan(0.85);
  });

  // The live API returns the NESTED shape; every other test here feeds the flat
  // fallback, so without this the real response shape goes unexercised.
  it('reads the nested five_hour/seven_day shape the live API returns', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 42, resets_at: '2026-07-27T23:00:00Z' },
        seven_day: { utilization: 18, resets_at: '2026-08-01T00:00:00Z' },
      }),
    });

    const result = await checkUsageApi(tmpDir, { force: true });
    expect(result.five_hour_utilization).toBeCloseTo(0.42);
    expect(result.seven_day_utilization).toBeCloseTo(0.18);
  });

  it('returns cached result within TTL', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir); // prime cache
    const cached = await checkUsageApi(tmpDir); // should hit cache
    expect(cached.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce(); // only one real fetch
  });

  it('bypasses cache with --force', async () => {
    writeStore();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.5, seven_day_utilization: 0.3 }),
    });

    await checkUsageApi(tmpDir);
    const fresh = await checkUsageApi(tmpDir, { force: true });
    expect(fresh.cached).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on non-ok API response', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(checkUsageApi(tmpDir, { force: true })).rejects.toThrow('401');
  });

  it('uses Bearer token from active account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    await checkUsageApi(tmpDir, { force: true });
    const call = mockFetch.mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tok_primary_abc');
    expect(call[1].headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('performs the utilization write under the inter-process lock', async () => {
    // checkUsageApi awaits the usage API and then rewrites the WHOLE store, so
    // it has the same read-modify-write exposure as the refresh path. In one
    // process the re-read alone makes behaviour correct, so the lock cannot be
    // observed behaviourally — its ACQUISITION is asserted instead. This proves
    // the lock is applied, NOT that cross-process exclusion works.
    //
    // This test exists so that deleting the lock from checkUsageApi is caught by
    // a test NAMED for checkUsageApi. Previously the only thing that went red was
    // the rotateOAuth lock-count test, which attributed the failure to the wrong
    // function.
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    lockedDirs.length = 0;
    await checkUsageApi(tmpDir, { force: true });

    expect(lockedDirs).toEqual([join(tmpDir, 'state', 'oauth')]);
  });
});

describe('refreshOAuthToken', () => {
  it('throws when no accounts.json', async () => {
    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('No accounts.json');
  });

  it('refreshes active account and writes atomically', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new_access_tok',
        refresh_token: 'new_refresh_tok',
        expires_in: 3600,
      }),
    });

    const result = await refreshOAuthToken(tmpDir);
    expect(result.account).toBe('primary');
    expect(result.expires_at).toBeGreaterThan(Date.now());

    // Verify accounts.json was rewritten with new tokens
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.primary.access_token).toBe('new_access_tok');
    expect(store.accounts.primary.refresh_token).toBe('new_refresh_tok');
  });

  it('refreshes named account', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'sec_new_tok',
        refresh_token: 'sec_new_rtok',
        expires_in: 3600,
      }),
    });

    await refreshOAuthToken(tmpDir, 'secondary');
    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.secondary.access_token).toBe('sec_new_tok');
    // Primary should be unchanged
    expect(store.accounts.primary.access_token).toBe('tok_primary_abc');
  });

  it('throws on failed refresh', async () => {
    writeStore();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('400');
  });

  // Refresh tokens are ONE-TIME USE. The moment the token endpoint returns 200
  // the old refresh_token is spent server-side, so the new one existing only in
  // memory is an account that can never be refreshed again — unrecoverable by
  // retry, though interactive reauthorization would still restore it. That
  // makes persistence the highest-consequence step in this file, and it is
  // exactly what the tests above do not pin down: they
  // reload accounts.json only after the call has returned, so they would still
  // pass if the write were deferred behind another fallible operation, or if
  // saveAccounts quietly stopped writing atomically.
  describe('one-time-token durability', () => {
    function mockSuccessfulRefresh() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new_access_tok',
          refresh_token: 'new_refresh_tok',
          expires_in: 3600,
        }),
      });
    }

    it('completes the write before any consumer of the returned promise runs', async () => {
      writeStore();
      mockSuccessfulRefresh();

      const order: string[] = [];
      mockAtomicWrite.mockImplementation((path: string, data: string, keepBak?: boolean) => {
        if (path === accountsFile()) order.push('write');
        actualAtomic.atomicWriteSync(path, data, keepBak);
      });

      const pending = refreshOAuthToken(tmpDir);
      // Queued before the test's own await, so it is the first fulfillment
      // reaction to run. Precisely what this pins down: the write lands before
      // any consumer of the promise gets to act on the success — NOT before the
      // promise itself fulfills, which is a weaker moment and one this cannot
      // observe. Verified by mutation: it catches a write pushed onto the
      // macrotask queue (setTimeout, an fs callback, anything after the
      // return). It does NOT catch a write detached onto a microtask — the
      // FIFO job queue still runs that one first — and what that shape really
      // breaks is error propagation, which the two rejection tests below cover.
      const observed = pending.then(() => { order.push('resolve'); });
      await pending;
      await observed;

      expect(order).toEqual(['write', 'resolve']);
    });

    it('routes the write through atomicWriteSync with the new tokens already in the payload', async () => {
      writeStore();
      mockSuccessfulRefresh();

      await refreshOAuthToken(tmpDir);

      const write = mockAtomicWrite.mock.calls.find(([path]) => path === accountsFile());
      // Fails if saveAccounts is ever switched to a plain writeFileSync, which
      // would reintroduce the torn-file window atomic rename exists to close.
      expect(write, 'accounts.json was not written via atomicWriteSync').toBeDefined();

      // Asserted against the bytes handed to the boundary, not the file after
      // the fact, so a later second write cannot paper over a wrong first one.
      const payload = JSON.parse(write![1] as string);
      expect(payload.accounts.primary.access_token).toBe('new_access_tok');
      expect(payload.accounts.primary.refresh_token).toBe('new_refresh_tok');
    });

    it('rejects when the write fails instead of reporting success', async () => {
      writeStore();
      mockSuccessfulRefresh();
      mockAtomicWrite.mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      // The spent refresh token is unrecoverable either way; what this pins is
      // that the caller is TOLD, rather than handed a success it cannot trust.
      // Deliberately no on-disk assertion here — the stub throws before any
      // real write runs, so "the file is unchanged" would be asserting the
      // mock. The real-filesystem test below covers that for real.
      await expect(refreshOAuthToken(tmpDir)).rejects.toThrow('ENOSPC');
    });

    // Real filesystem, and the real atomicWriteSync implementation reached
    // through the default delegating spy — the failure is genuine, not stubbed.
    // The test above proves refreshOAuthToken propagates a throw; this proves
    // the write actually throws when the disk says no, which is what catches
    // the boundary being changed to swallow its own errors. Skipped as root,
    // where the permission bits would not bite; a non-root process holding
    // CAP_DAC_OVERRIDE would also slip through.
    const notRoot = typeof process.getuid === 'function' && process.getuid() !== 0;
    it.skipIf(!notRoot)('rejects when the real filesystem write fails', async () => {
      writeStore();
      mockSuccessfulRefresh();

      chmodSync(oauthDirPath(), 0o500); // r-x: temp-file write inside atomicWriteSync fails
      try {
        await expect(refreshOAuthToken(tmpDir)).rejects.toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(oauthDirPath(), 0o700); // restore so afterEach can clean up
      }

      const store = loadAccounts(tmpDir)!;
      expect(store.accounts.primary.refresh_token).toBe('rtok_primary_xyz');
    });
  });
});

describe('refreshOAuthToken — concurrent refresh of a different account', () => {
  // Race 1: refreshOAuthToken loads the WHOLE store, awaits the network, then
  // writes the WHOLE store back. Two refreshes for different accounts overlap
  // on that await, so the second writer's snapshot — taken before the first
  // writer's save — reverts the first account to its already-spent
  // refresh_token. The next refresh of that account then fails: stranded.
  function deferredFetch() {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  }

  function tokenResponse(access: string, refresh: string) {
    return {
      ok: true,
      json: async () => ({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
    };
  }

  it('does not revert a field another writer changed on the SAME account mid-refresh', async () => {
    // Kills the mutation `...current` -> `...account`: spreading the pre-fetch
    // snapshot of this account would revert non-token fields written while the
    // refresh was in flight, even though the re-read store is used elsewhere.
    writeStore();
    const a = deferredFetch();
    mockFetch.mockImplementationOnce(() => a.promise);

    const call = refreshOAuthToken(tmpDir, 'primary');

    // Another process updates primary's utilization while the fetch is pending.
    const mid = loadAccounts(tmpDir)!;
    mid.accounts.primary.five_hour_utilization = 0.99;
    const { writeFileSync } = require('fs');
    writeFileSync(
      join(tmpDir, 'state', 'oauth', 'accounts.json'),
      JSON.stringify(mid, null, 2),
    );

    a.resolve(tokenResponse('tok_primary_NEW', 'rtok_primary_NEW'));
    await call;

    const store = loadAccounts(tmpDir)!;
    expect(store.accounts.primary.refresh_token).toBe('rtok_primary_NEW');
    expect(store.accounts.primary.five_hour_utilization).toBe(0.99);
  });

  it('performs the accounts.json read-modify-write under the inter-process lock', async () => {
    // The two tests above run in ONE process, where the re-read alone is enough
    // to make them pass — they cannot observe the lock at all. The lock is what
    // makes the sequence safe against OTHER processes, so it is pinned here
    // directly. Without this, deleting withFileLockSync leaves the suite green.
    writeStore();
    lockedDirs.length = 0;
    mockFetch.mockResolvedValueOnce(tokenResponse('tok_x', 'rtok_x'));

    await refreshOAuthToken(tmpDir, 'primary');

    expect(lockedDirs).toContain(join(tmpDir, 'state', 'oauth'));
  });

  it('does not revert the other account to its spent refresh_token', async () => {
    writeStore();
    const a = deferredFetch();
    const b = deferredFetch();
    mockFetch
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);

    // Both calls run synchronously up to their `await fetch(...)`, so both
    // hold the same pre-refresh snapshot of accounts.json.
    const callA = refreshOAuthToken(tmpDir, 'primary');
    const callB = refreshOAuthToken(tmpDir, 'secondary');

    // A completes and saves first; B then saves its older snapshot.
    a.resolve(tokenResponse('tok_primary_NEW', 'rtok_primary_NEW'));
    await callA;
    b.resolve(tokenResponse('tok_secondary_NEW', 'rtok_secondary_NEW'));
    await callB;

    const store = loadAccounts(tmpDir)!;
    // The later writer's own account must land — this passes even unfixed.
    expect(store.accounts.secondary.refresh_token).toBe('rtok_secondary_NEW');
    // The earlier writer's account must survive the later write. Unfixed, this
    // is 'rtok_primary_xyz' — the token the server has already invalidated.
    expect(store.accounts.primary.refresh_token).toBe('rtok_primary_NEW');
    expect(store.accounts.primary.access_token).toBe('tok_primary_NEW');
  });

  it('throws instead of reporting success when the refreshed account vanishes mid-refresh', async () => {
    // The refresh itself SUCCEEDED, so the old refresh_token is now spent and the
    // response holds the only copy of the new one. If the account is gone by the
    // time we take the lock there is nowhere to persist it. Returning success
    // would strand the account on a token the server has already revoked, and
    // report that as a win. Failing loudly is the only honest option.
    writeStore();
    const a = deferredFetch();
    mockFetch.mockImplementationOnce(() => a.promise);

    const call = refreshOAuthToken(tmpDir, 'primary');

    // Another process removes the account while the token fetch is in flight.
    const mid = loadAccounts(tmpDir)!;
    delete (mid.accounts as Record<string, unknown>).primary;
    const { writeFileSync } = require('fs');
    writeFileSync(
      join(tmpDir, 'state', 'oauth', 'accounts.json'),
      JSON.stringify(mid, null, 2),
    );

    a.resolve(tokenResponse('tok_primary_NEW', 'rtok_primary_NEW'));

    await expect(call).rejects.toThrow(/could not persist the new tokens/);
    // And it must not have resurrected the deleted account as a side effect.
    expect(loadAccounts(tmpDir)!.accounts.primary).toBeUndefined();
  });
});

describe('rotateOAuth', () => {
  const frameworkRoot = '/tmp/fw';

  it('does not rotate when utilization is low', async () => {
    writeStore(); // primary at 30%/20% — below thresholds
    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('within limits');
  });

  it('commits the phase-1 accounts.json write under the inter-process lock', async () => {
    // rotateOAuth awaits the preflight, so its phase-1 write has the same
    // read-modify-write exposure as the refresh path. In one process the
    // re-read alone makes rotation behave correctly, so behaviour cannot
    // distinguish locked from unlocked — the acquisition is asserted instead.
    // Attribution matters: asserting a total lock COUNT here would also go red
    // if checkUsageApi's lock were removed, blaming rotateOAuth for someone
    // else's regression. So this asserts that exactly one LOCKED critical
    // section is the one that flipped `active` primary -> secondary. Unlocked,
    // the phase-1 write happens outside any critical section and no locked
    // section shows that transition.
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    lockedDirs.length = 0;
    lockedSections.length = 0;
    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(true);

    const oauthStateDir = join(tmpDir, 'state', 'oauth');
    const activated = lockedSections.filter(
      (s) => s.dir === oauthStateDir
        && s.activeBefore === 'primary'
        && s.activeAfter === 'secondary',
    );
    expect(activated).toHaveLength(1);
  });

  it('rotates when 5h utilization exceeds threshold', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fetch for secondary
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(true);
    expect(result.from).toBe('primary');
    expect(result.to).toBe('secondary');

    // accounts.json should show secondary as active
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('secondary');
    expect(store.rotation_log).toHaveLength(1);
    expect(store.rotation_log[0].from).toBe('primary');
  });

  it('does not rotate when preflight fails', async () => {
    const highUtilStore = {
      ...SAMPLE_STORE,
      accounts: {
        ...SAMPLE_STORE.accounts,
        primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      },
    };
    writeStore(highUtilStore);

    // Preflight fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme');
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('Preflight failed');

    // accounts.json active should be unchanged
    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('primary');
  });

  it('force-rotates regardless of utilization', async () => {
    writeStore(); // low utilization

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ five_hour_utilization: 0.1, seven_day_utilization: 0.05 }),
    });

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(true);
  });

  it('returns error when no alternate accounts', async () => {
    const singleAccountStore = {
      active: 'primary',
      accounts: { primary: SAMPLE_STORE.accounts.primary },
      rotation_log: [],
    };
    writeStore(singleAccountStore);
    const store = loadAccounts(tmpDir)!;
    store.accounts.primary.five_hour_utilization = 0.90;
    const { mkdirSync, writeFileSync } = require('fs');
    const oauthDir = join(tmpDir, 'state', 'oauth');
    mkdirSync(oauthDir, { recursive: true });
    writeFileSync(join(oauthDir, 'accounts.json'), JSON.stringify(store, null, 2));

    const result = await rotateOAuth(tmpDir, frameworkRoot, 'acme', { force: true });
    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('No alternate accounts');
  });
});

describe('rotateOAuth — active account moved during preflight', () => {
  // rotateOAuth snapshots `active` (currentName) and the candidate list, then
  // awaits the network for the refresh and the preflight. A competing rotation
  // that lands inside that window leaves this call holding a decision whose
  // premise — "active is still currentName" — is no longer true.

  function deferredFetch() {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  }

  const usageResponse = (five: number, seven: number) => ({
    ok: true,
    json: async () => ({ five_hour_utilization: five, seven_day_utilization: seven }),
  });

  // primary is over threshold so rotation targets `secondary` (lowest 5h util).
  // `tertiary` exists only as the destination a COMPETING rotation picks, so the
  // superseding value is distinguishable from this call's own choice.
  const THREE_ACCOUNT_STORE = {
    active: 'primary',
    accounts: {
      ...SAMPLE_STORE.accounts,
      primary: { ...SAMPLE_STORE.accounts.primary, five_hour_utilization: 0.90 },
      tertiary: {
        label: 'Tertiary Account',
        access_token: 'tok_tertiary_ghi',
        refresh_token: 'rtok_tertiary_rst',
        expires_at: Date.now() + FOUR_HOURS_MS,
        last_refreshed: '2026-04-05T00:00:00Z',
        five_hour_utilization: 0.2,
        seven_day_utilization: 0.1,
      },
    },
    rotation_log: [],
  };

  function overwriteStore(mutate: (s: ReturnType<typeof loadAccounts>) => void) {
    const store = loadAccounts(tmpDir)!;
    mutate(store);
    const { writeFileSync } = require('fs');
    writeFileSync(
      join(tmpDir, 'state', 'oauth', 'accounts.json'),
      JSON.stringify(store, null, 2),
    );
  }

  it('aborts instead of overwriting a newer active chosen during preflight', async () => {
    writeStore(THREE_ACCOUNT_STORE);
    const preflight = deferredFetch();
    mockFetch.mockImplementationOnce(() => preflight.promise);

    const call = rotateOAuth(tmpDir, '/tmp/fw', 'acme');

    // A competing rotation commits primary -> tertiary while our preflight is
    // still in flight. Ours still believes it is rotating away from primary.
    overwriteStore((s) => { s!.active = 'tertiary'; });

    preflight.resolve(usageResponse(0.1, 0.05));
    const result = await call;

    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/superseded/i);
    expect(result.reason).toContain('tertiary');

    const store = loadAccounts(tmpDir)!;
    // Unguarded this is 'secondary': the newer, already-preflighted selection
    // silently demoted by a decision taken before it existed.
    expect(store.active).toBe('tertiary');
    // ...and no fictional primary -> secondary entry in the audit log.
    expect(store.rotation_log).toHaveLength(0);
  });

  it('does not push the superseded account token into agent .env files', async () => {
    // The user-visible harm. Phase 2 writes the destination's access_token to
    // every agent .env; if phase 1 aborted, running agents must keep the token
    // belonging to whoever actually won the rotation.
    const { mkdirSync, writeFileSync } = require('fs');
    const fwRoot = mkdtempSync(join(tmpdir(), 'cortextos-fw-'));
    const envPath = join(fwRoot, 'orgs', 'acme', 'agents', 'rally-builder', '.env');
    mkdirSync(join(fwRoot, 'orgs', 'acme', 'agents', 'rally-builder'), { recursive: true });
    writeFileSync(envPath, 'CLAUDE_CODE_OAUTH_TOKEN=tok_primary_abc\n');

    try {
      writeStore(THREE_ACCOUNT_STORE);
      const preflight = deferredFetch();
      mockFetch.mockImplementationOnce(() => preflight.promise);

      const call = rotateOAuth(tmpDir, fwRoot, 'acme');
      overwriteStore((s) => { s!.active = 'tertiary'; });
      preflight.resolve(usageResponse(0.1, 0.05));

      expect((await call).rotated).toBe(false);
      // Unguarded, phase 2 runs and this file holds secondary's token.
      expect(readFileSync(envPath, 'utf-8')).not.toContain('tok_secondary_def');
      expect(readFileSync(envPath, 'utf-8')).toContain('tok_primary_abc');
    } finally {
      rmSync(fwRoot, { recursive: true, force: true });
    }
  });

  it('reports a vanished destination distinctly from a superseded rotation', async () => {
    // Both failures come back through the same `!committed` branch. Collapsing
    // them into one message would turn a benign race into what reads as store
    // corruption, so the two paths are pinned apart.
    writeStore(THREE_ACCOUNT_STORE);
    const preflight = deferredFetch();
    mockFetch.mockImplementationOnce(() => preflight.promise);

    const call = rotateOAuth(tmpDir, '/tmp/fw', 'acme');

    // active is left ALONE; the destination disappears instead.
    overwriteStore((s) => {
      delete (s!.accounts as Record<string, unknown>).secondary;
    });

    preflight.resolve(usageResponse(0.1, 0.05));
    const result = await call;

    expect(result.rotated).toBe(false);
    expect(result.reason).toContain('disappeared');
    expect(result.reason).not.toMatch(/superseded/i);
  });

  /**
   * THE ABA CASE — the one an active-compare structurally cannot see.
   *
   * The guard above asks "is `active` still currentName?". Two competing
   * rotations, primary -> tertiary -> primary, answer YES while having moved
   * the store twice. This call's decision predates both, so committing it
   * demotes a selection that won a race it never knew it was in, and appends a
   * primary -> secondary log entry for a transition that never happened.
   *
   * Note what this test does NOT rely on: `active` differs from the snapshot.
   * It is byte-identical. Only the rotation witness can fire here, which is why
   * this is the arm that proves the second predicate earns its place.
   */
  function rotationEntry(from: string, to: string, timestamp: string) {
    return {
      timestamp,
      from,
      to,
      reason: 'competing rotation',
      five_hour_util: 0.9,
      seven_day_util: 0.5,
    };
  }

  it('aborts when a rotation committed and landed active back on the same account', async () => {
    writeStore(THREE_ACCOUNT_STORE);
    const preflight = deferredFetch();
    mockFetch.mockImplementationOnce(() => preflight.promise);

    const call = rotateOAuth(tmpDir, '/tmp/fw', 'acme');

    // Two real rotations land while our preflight is in flight. Real rotations
    // prepend to rotation_log, which is what makes them visible at all.
    overwriteStore((s) => {
      s!.active = 'tertiary';
      s!.rotation_log = [rotationEntry('primary', 'tertiary', '2026-04-05T01:00:00Z')];
    });
    overwriteStore((s) => {
      s!.active = 'primary';
      s!.rotation_log = [rotationEntry('tertiary', 'primary', '2026-04-05T02:00:00Z'), ...s!.rotation_log];
    });

    preflight.resolve(usageResponse(0.1, 0.05));
    const result = await call;

    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/superseded/i);
    // Must NOT render as 'changed from "primary" to "primary"' — that reads as a
    // broken guard rather than a caught race.
    expect(result.reason).not.toMatch(/changed from "primary" to "primary"/);
    expect(result.reason).toContain('active again');

    const store = loadAccounts(tmpDir)!;
    // Unguarded this is 'secondary': the decision that predates both rotations
    // wins anyway, which is the whole bug.
    expect(store.active).toBe('primary');
    // Exactly the two competing entries — no fictional primary -> secondary.
    expect(store.rotation_log).toHaveLength(2);
    expect(store.rotation_log.map((e) => `${e.from}->${e.to}`)).toEqual([
      'tertiary->primary',
      'primary->tertiary',
    ]);
  });

  /**
   * WHY THE HEAD ENTRY AND NOT `rotation_log.length`.
   *
   * Length is the obvious cheap witness and it is wrong in the one state a
   * long-lived store spends all its time in. rotation_log is sliced to
   * ROTATION_LOG_MAX (50) on every commit, so once it is full a competing
   * rotation prepends one entry and drops one — length before and length after
   * are identical, and a length-compare reports "nothing happened" forever.
   *
   * Without this arm the code comment claiming length is unusable would be an
   * untested assertion, and a later simplification to `.length` would keep every
   * other test in this file green while silently reopening the ABA hole for
   * exactly the stores that have rotated the most.
   */
  it('detects a competing rotation once rotation_log is full and its length stops changing', async () => {
    const FULL_LOG = Array.from({ length: 50 }, (_, i) =>
      rotationEntry('old', 'older', `2026-04-0${(i % 9) + 1}T00:00:00Z`));
    writeStore({ ...THREE_ACCOUNT_STORE, rotation_log: FULL_LOG });

    const preflight = deferredFetch();
    mockFetch.mockImplementationOnce(() => preflight.promise);

    const call = rotateOAuth(tmpDir, '/tmp/fw', 'acme');

    // A competing primary -> tertiary -> primary, each prepending and slicing
    // exactly as the real commit path does. Length never moves off 50.
    overwriteStore((s) => {
      s!.active = 'tertiary';
      s!.rotation_log = [rotationEntry('primary', 'tertiary', '2026-04-05T01:00:00Z'), ...s!.rotation_log].slice(0, 50);
    });
    overwriteStore((s) => {
      s!.active = 'primary';
      s!.rotation_log = [rotationEntry('tertiary', 'primary', '2026-04-05T02:00:00Z'), ...s!.rotation_log].slice(0, 50);
    });

    // The premise of this arm: length is genuinely unchanged, so anything that
    // fires below fired on the head entry and not on the count.
    expect(loadAccounts(tmpDir)!.rotation_log).toHaveLength(FULL_LOG.length);

    preflight.resolve(usageResponse(0.1, 0.05));
    const result = await call;

    expect(result.rotated).toBe(false);
    expect(result.reason).toMatch(/superseded/i);
    expect(loadAccounts(tmpDir)!.active).toBe('primary');
  });

  /**
   * THE VACUITY GUARD, and it is not optional.
   *
   * A witness that compared anything touched by the refresh or the preflight
   * would make EVERY rotation abort — and the ABA test above would still pass,
   * because a guard that always aborts aborts correctly by accident. This is
   * the arm that says the witness only fires on an actual competing rotation.
   *
   * A non-empty starting rotation_log is the load-bearing detail: with an empty
   * one the witness is `null` on both sides and a broken implementation that
   * ignored the log entirely would look identical.
   */
  it('still commits a normal rotation when nothing else touches the store', async () => {
    writeStore({
      ...THREE_ACCOUNT_STORE,
      rotation_log: [rotationEntry('older', 'primary', '2026-04-04T00:00:00Z')],
    });
    const preflight = deferredFetch();
    mockFetch.mockImplementationOnce(() => preflight.promise);

    const call = rotateOAuth(tmpDir, '/tmp/fw', 'acme');
    preflight.resolve(usageResponse(0.1, 0.05));
    const result = await call;

    expect(result.rotated, `rotation was blocked with: ${result.reason}`).toBe(true);

    const store = loadAccounts(tmpDir)!;
    expect(store.active).toBe('secondary');
    // The new entry on top, the pre-existing one preserved beneath it.
    expect(store.rotation_log).toHaveLength(2);
    expect(store.rotation_log[0].from).toBe('primary');
    expect(store.rotation_log[0].to).toBe('secondary');
    expect(store.rotation_log[1].from).toBe('older');
  });
});

describe('alert thresholds', () => {
  it('ALERT_5H is 0.80', () => {
    expect(ALERT_5H).toBe(0.80);
  });
  it('ALERT_7D is 0.70', () => {
    expect(ALERT_7D).toBe(0.70);
  });
});
