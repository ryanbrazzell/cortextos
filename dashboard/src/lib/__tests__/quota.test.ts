/**
 * quota.ts — utilization scale parsing.
 *
 * Why this file exists: the fix in 960db02 changed normalize() from
 * `v > 1 ? v / 100 : v` to `v / 100`, because the usage API reports
 * utilization on a 0–100 scale ALWAYS — `{ utilization: 4.0 }` means 4%,
 * not 400%. The old conditional assumed any value <= 1 was already a
 * fraction, which inflated the entire 0–1% band by 100x. At 1% real usage
 * it normalized to 1.0 and the indicator rendered "0% remaining" — the
 * dashboard telling you your account is exhausted when you had barely
 * touched it.
 *
 * That fix shipped with typecheck-only verification and no tests. It also
 * cannot be caught by looking at the running dashboard: for every value
 * ABOVE 1 the old and new expressions are mathematically identical, so a
 * browser check at ordinary usage renders the same either way. The 0–1%
 * band below is the only place the two disagree, which makes these
 * assertions the sole durable guard on the fix.
 *
 * normalize() is module-private, so these drive the exported
 * fetchQuotaSnapshot() with a stubbed fetch — that also covers the
 * remaining-pct arithmetic and rounding the component actually renders.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// CACHE_DIR is a module-level const derived from CTX_ROOT, so this must be
// set before quota.ts is imported. Isolates the cache from the real one.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'));
process.env.CTX_ROOT = tmpDir;
// getOAuthToken() checks this first, so the test never reads real credentials.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';

let fetchQuotaSnapshot: typeof import('../quota').fetchQuotaSnapshot;

beforeAll(async () => {
  ({ fetchQuotaSnapshot } = await import('../quota'));
});

/** Stub the usage API with a given nested-shape utilization payload. */
function stubUsage(fiveHour: number | undefined, sevenDay: number | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        five_hour: fiveHour === undefined ? undefined : { utilization: fiveHour },
        seven_day: sevenDay === undefined ? undefined : { utilization: sevenDay },
      }),
    })),
  );
}

beforeEach(() => {
  // The cache is last-good fallback; a leftover file would mask a failure.
  const cache = path.join(tmpDir, 'state', 'dashboard', 'quota-last-good.json');
  if (fs.existsSync(cache)) fs.unlinkSync(cache);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('quota utilization scale — the 0–1% band', () => {
  // THE REGRESSION. Pre-fix this returned 0, and the indicator rendered a red
  // "0% left" for an account at 1% usage.
  it('1% utilization is 99% remaining, not 0%', async () => {
    stubUsage(1.0, 1.0);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.five_hour_remaining_pct).toBe(99);
    expect(snap?.seven_day_remaining_pct).toBe(99);
  });

  it('sub-1% utilization stays near-full rather than collapsing', async () => {
    stubUsage(0.5, 0.25);
    const snap = await fetchQuotaSnapshot();
    // Math.round((1 - 0.005) * 100) === 100. Pre-fix these were 50 and 75.
    expect(snap?.five_hour_remaining_pct).toBe(100);
    expect(snap?.seven_day_remaining_pct).toBe(100);
  });

  it('exactly 1.0 is the boundary and is read as one percent, not as a fraction', async () => {
    // 1.0 is the exact value the old `v > 1` conditional fell through on, so
    // it is the single most important input in this file.
    stubUsage(1.0, 100.0);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.five_hour_remaining_pct).toBe(99);
    // ...and a genuinely exhausted window still reads as 0, so "0% left" keeps
    // its real meaning instead of being a bug signature.
    expect(snap?.seven_day_remaining_pct).toBe(0);
  });
});

describe('quota utilization scale — values the browser could already verify', () => {
  // These pass BOTH pre- and post-fix (for v > 1 the two expressions are
  // identical). Kept deliberately, and labelled, so nobody mistakes them for
  // coverage of the fix — they guard the surrounding arithmetic, not normalize.
  it('ordinary usage is unchanged by the fix (non-discriminating control)', async () => {
    stubUsage(3.0, 64.0);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.five_hour_remaining_pct).toBe(97);
    expect(snap?.seven_day_remaining_pct).toBe(36);
  });

  it('zero utilization is 100% remaining', async () => {
    stubUsage(0, 0);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.five_hour_remaining_pct).toBe(100);
    expect(snap?.seven_day_remaining_pct).toBe(100);
  });

  it('a missing utilization field is treated as zero usage, not as an error', async () => {
    stubUsage(undefined, undefined);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.five_hour_remaining_pct).toBe(100);
    expect(snap?.seven_day_remaining_pct).toBe(100);
  });

  it('marks a fresh snapshot as not stale', async () => {
    stubUsage(10.0, 20.0);
    const snap = await fetchQuotaSnapshot();
    expect(snap?.stale).toBe(false);
    expect(snap?.cache_age_ms).toBe(0);
  });
});
