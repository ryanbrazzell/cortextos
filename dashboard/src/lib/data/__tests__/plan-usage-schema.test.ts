/**
 * getPlanUsage() reads state/usage/latest.json, which has two writers that
 * disagree on its schema: `scrape-usage` writes nested PlanUsage with
 * `used_pct` on a 0-100 scale, while the OAuth usage refresh writes a FLAT
 * UsageSnapshot with utilization as a 0.0-1.0 fraction.
 *
 * The two states each test must distinguish are named in the test titles.
 * The one that matters most is 6 vs 0.06: a mapper that renames the fields
 * without rescaling turns a real 6% into 0.06%, which renders green and looks
 * healthy. Asserting "is a number" or "is truthy" would pass against that bug.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-usage-test-'));
process.env.CTX_ROOT = tmpDir;

const usageDir = path.join(tmpDir, 'state', 'usage');
const latestFile = path.join(usageDir, 'latest.json');

function writeLatest(contents: unknown): void {
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(latestFile, JSON.stringify(contents, null, 2));
}

async function getPlanUsage() {
  const mod = await import('../reports');
  return mod.getPlanUsage();
}

beforeEach(() => {
  fs.rmSync(usageDir, { recursive: true, force: true });
});

describe('getPlanUsage schema collision', () => {
  describe('flat OAuth UsageSnapshot (fraction scale)', () => {
    // The exact shape src/bus/oauth.ts writes.
    const oauthSnapshot = {
      account: 'primary',
      five_hour_utilization: 0.06,
      seven_day_utilization: 0.31,
      fetched_at: '2026-07-29T16:36:57.356Z',
    };

    it('scales the fraction to percentage points: 6, NOT 0.06', async () => {
      writeLatest(oauthSnapshot);
      const usage = await getPlanUsage();

      // 6 vs 0.06 is the whole point. toBeCloseTo guards float noise from
      // 0.06 * 100 while still being 100x away from the rename-only bug.
      expect(usage?.session.used_pct).toBeCloseTo(6, 10);
      expect(usage?.week_all_models.used_pct).toBeCloseTo(31, 10);

      // Belt and braces: state the wrong value explicitly, so a future
      // refactor that drops the * 100 fails on a named expectation.
      expect(usage?.session.used_pct).not.toBeCloseTo(0.06, 10);
    });

    it('populates the nested fields the card dereferences (blind cast returned undefined)', async () => {
      writeLatest(oauthSnapshot);
      const usage = await getPlanUsage();

      // cost-tracking.tsx does planUsage.week_all_models.used_pct — the old
      // bare JSON.parse cast returned the flat object, so this threw.
      expect(usage?.week_all_models).toBeDefined();
      expect(usage?.session).toBeDefined();
      expect(typeof usage?.session.used_pct).toBe('number');
      expect(usage?.agent).toBe('primary');
      expect(usage?.timestamp).toBe('2026-07-29T16:36:57.356Z');
    });

    it('omits week_sonnet entirely rather than reporting a false 0%', async () => {
      writeLatest(oauthSnapshot);
      const usage = await getPlanUsage();

      // OAuth has no per-model breakdown. 0 would render as a real "0% of
      // Sonnet used" bar, which is a claim we cannot make.
      expect(usage?.week_sonnet).toBeUndefined();
      expect(usage?.week_sonnet?.used_pct).not.toBe(0);
    });
  });

  describe('nested PlanUsage from scrape-usage', () => {
    const scraped = {
      agent: 'claude-max',
      timestamp: '2026-07-29T10:00:00.000Z',
      session: { used_pct: 6, resets: 'Jul 29, 5PM' },
      week_all_models: { used_pct: 31, resets: 'Aug 2' },
      week_sonnet: { used_pct: 12 },
    };

    it('passes through unchanged — already 0-100, must NOT be scaled again', async () => {
      writeLatest(scraped);
      const usage = await getPlanUsage();

      // If the flat branch ever swallowed this shape, 6 would become 600.
      expect(usage?.session.used_pct).toBe(6);
      expect(usage?.week_all_models.used_pct).toBe(31);
      expect(usage?.week_sonnet?.used_pct).toBe(12);
      expect(usage?.session.resets).toBe('Jul 29, 5PM');
      expect(usage?.agent).toBe('claude-max');
    });
  });

  describe('shapes it cannot map', () => {
    it('returns null for an unrecognised object instead of casting it blind', async () => {
      // The old code returned this verbatim as a PlanUsage.
      writeLatest({ something: 'else', five_hour: { utilization: 0.5 } });
      expect(await getPlanUsage()).toBeNull();
    });

    it('returns null when latest.json is absent', async () => {
      expect(await getPlanUsage()).toBeNull();
    });
  });
});
