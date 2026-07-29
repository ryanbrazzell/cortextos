/**
 * PATCH /api/goals must create the org's state directory before writing.
 *
 * `getGoalsPath` falls back to `$CTX_ROOT/orgs/<org>/goals.json` and its own
 * comment promises the caller "will create if needed".  The shared writer in
 * lib/data/goals.ts honours that; this route did not, so the first-ever write
 * for an org with no state directory failed ENOENT and surfaced as a 500.
 *
 * `org` is arbitrary request input — it is checked against /^[a-z0-9_-]+$/ and
 * nothing else — so reaching a directory that was never created takes only a
 * new org name, not an exotic deployment.
 *
 * HONEST SCOPE.  This asserts the directory is created and the write lands.  It
 * says nothing about concurrent writers (two PATCHes can still lose an update),
 * about durability (no fsync anywhere on this path), or about the mode bits the
 * rename discards.  Those are pre-existing and tracked separately.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { NextRequest } from 'next/server';

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-neworg-state-'));
const frameworkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-neworg-fw-'));
process.env.CTX_ROOT = stateRoot;
process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;

let goalsRoute: typeof import('../route');

beforeAll(async () => {
  goalsRoute = await import('../route');
});

afterAll(() => {
  for (const dir of [stateRoot, frameworkRoot]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const patchReq = (org: string, body: Record<string, unknown>): NextRequest =>
  ({
    nextUrl: new URL(`http://localhost/api/goals?org=${org}`),
    json: async () => body,
  }) as unknown as NextRequest;

describe('PATCH /api/goals for an org with no state directory', () => {
  it('creates the directory and writes goals.json instead of failing 500', async () => {
    const org = 'brand-new-org';
    const goalsPath = path.join(stateRoot, 'orgs', org, 'goals.json');

    // The precondition the bug needs: nothing has ever created this directory.
    expect(fs.existsSync(path.dirname(goalsPath))).toBe(false);

    const res = await goalsRoute.PATCH(patchReq(org, { north_star: 'ship it' }));

    expect(res.status).toBe(200);
    expect(fs.existsSync(goalsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(goalsPath, 'utf-8')).north_star).toBe('ship it');
  });

  // What this one actually detects is the `readdirSync` below throwing ENOENT
  // when the directory was never created. The `.tmp.` assertion is vacuously
  // green after a successful rename — it guards the atomic path's own failure
  // mode and does not distinguish a working writer from a broken one.
  it('creates the directory for a second new org, leaving no temp file', async () => {
    const org = 'another-new-org';
    const orgDir = path.join(stateRoot, 'orgs', org);

    const res = await goalsRoute.PATCH(patchReq(org, { bottleneck: 'none' }));

    expect(res.status).toBe(200);
    expect(fs.readdirSync(orgDir).filter(f => f.startsWith('.tmp.'))).toEqual([]);
  });
});
