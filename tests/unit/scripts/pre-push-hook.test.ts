import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Coverage for scripts/hooks/pre-push — specifically the dirty-primary-checkout
// guard, which exists because `npm run build` in this repo writes a gitignored
// dist/ that has no separate install step: the build IS the live deploy, so a
// push from a dirty primary checkout would ship uncommitted code.
//
// Before this file the hook had no test coverage at all, which is how the
// ref-gating and env-scrub fixes previously survived only inside .git/hooks and
// never reached the repo. A shell hook is testable; it just has to be driven
// the way git drives it.
//
// Two things have to be faked, and only two:
//
//   npm   The hook's last two steps are `npm run build` and `npm test`. Running
//         the real ones would take ~50s per case and would test tsup/vitest, not
//         the guard. A stub that exits 0 means "everything downstream of the
//         guard succeeded", so a non-zero exit can only have come from a guard.
//
//   node  The dependency preflight resolves vitest/next/better-sqlite3 via
//         `node -e require.resolve`. A throwaway repo has no node_modules, so
//         the real node would make the preflight refuse first and every case
//         would exit 1 for the wrong reason — the control arms would "pass"
//         while proving nothing. The stub reports deps present.
//
// Everything else is real: a real git repo, real commits, real worktrees, the
// real hook script, and refs fed on stdin exactly as git feeds them.
// ---------------------------------------------------------------------------

const HOOK = path.resolve(__dirname, '../../../scripts/hooks/pre-push');

let tmpRoot: string;
let stubDir: string;

/** Run the hook inside `cwd`, feeding it the ref line git would supply. */
function runHook(cwd: string, refLine?: string) {
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  // Default to pushing exactly HEAD so the ref-gating block upstream of the
  // guard always passes; otherwise it would refuse first and mask the result.
  const stdin = refLine ?? `refs/heads/main ${headSha} refs/heads/main ${'0'.repeat(40)}\n`;
  return spawnSync('bash', [HOOK], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-'));

  stubDir = path.join(tmpRoot, 'stub-bin');
  fs.mkdirSync(stubDir);
  for (const name of ['npm', 'node']) {
    const p = path.join(stubDir, name);
    fs.writeFileSync(p, '#!/usr/bin/env bash\nexit 0\n');
    fs.chmodSync(p, 0o755);
  }
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A fresh primary checkout with one commit containing a tracked source file. */
function makeRepo(name: string): string {
  const repo = path.join(tmpRoot, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'src.ts'), 'export const a = 1;\n');
  // The dependency preflight probes the dashboard tree with `cd dashboard`, so
  // a repo without that directory refuses for a missing-deps reason before the
  // guard is ever reached — which would make every should-pass arm below exit 1
  // and look like the guard misfiring. Tracked, not just mkdir'd, because the
  // worktree arm needs git to materialize it in the linked checkout too.
  fs.mkdirSync(path.join(repo, 'dashboard'));
  fs.writeFileSync(path.join(repo, 'dashboard', '.keep'), '');
  git(repo, 'add', 'src.ts', 'dashboard/.keep');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('pre-push hook: dirty-primary-checkout guard', () => {
  it('REFUSES a push from a primary checkout with uncommitted tracked changes', () => {
    const repo = makeRepo('dirty-primary');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const a = 999; // uncommitted\n');

    const r = runHook(repo);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncommitted tracked changes/i);
    // The operator has to be told WHICH files would ship, or the refusal is
    // unactionable and gets bypassed rather than fixed.
    expect(r.stderr).toContain('src.ts');
    expect(r.stderr).toMatch(/Push aborted/);
  });

  // -- control arms: each proves the guard does NOT fire where it must not. --

  it('ALLOWS a push from a primary checkout with a clean tree', () => {
    const repo = makeRepo('clean-primary');

    const r = runHook(repo);

    // Guard must not fire; with npm stubbed, reaching the end means exit 0.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/uncommitted tracked changes/i);
  });

  it('ALLOWS a dirty LINKED WORKTREE, whose build writes its own throwaway dist', () => {
    const repo = makeRepo('wt-parent');
    const wt = path.join(tmpRoot, 'wt-child');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature');
    fs.writeFileSync(path.join(wt, 'src.ts'), 'export const a = 999; // uncommitted\n');

    const r = runHook(wt);

    // This is the whole point of scoping the guard: the worktree is the
    // recommended escape hatch, so it must stay usable while dirty. If this
    // ever fails, the guard is refusing the very workflow it tells people to
    // use, and --no-verify becomes the only way out.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/uncommitted tracked changes/i);
  });

  it('ALLOWS a primary checkout dirty only with UNTRACKED files', () => {
    const repo = makeRepo('untracked-primary');
    fs.writeFileSync(path.join(repo, 'scratch.log'), 'noise\n');

    const r = runHook(repo);

    // Untracked files are the steady state of a working checkout and are not
    // compiled unless something tracked imports them. Blocking on them would
    // make the guard fire constantly for no safety gain.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/uncommitted tracked changes/i);
  });

  it('counts STAGED-but-uncommitted changes as dirty', () => {
    const repo = makeRepo('staged-primary');
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export const a = 999;\n');
    git(repo, 'add', 'src.ts');

    // `git diff --quiet HEAD` is deliberately used rather than a bare
    // `git diff`: staging a change does not make it committed, and the build
    // would still compile it. A guard that only saw unstaged edits would miss
    // the case where someone staged everything and then pushed.
    const r = runHook(repo);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncommitted tracked changes/i);
  });
});
