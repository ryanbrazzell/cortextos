/**
 * Inter-process exclusion on `orgs/<org>/agents/<agent>/config.json`.
 *
 * Several processes amend this file with DISJOINT field sets: `add-agent`
 * creates it and later seeds org tuning knobs into it, `import-agent` replaces
 * it wholesale, and the dashboard's config and crons routes edit `crons`,
 * `enabled` and friends. Each writer serialises the WHOLE object back, so an
 * unlocked read-modify-write does not corrupt the file — it silently discards
 * whatever the other writer had just put there. `mutateAgentConfig` /
 * `writeAgentConfig` (src/utils/agent-config.ts) now wrap read+mutate+write in
 * `withFileLockSync` on the agent directory itself.
 *
 * WHY REAL CHILD PROCESSES: an in-process test cannot prove this. Vitest is
 * single-threaded, so the lock is uncontended on every acquire and the test goes
 * green whether or not the lock exists — it would only be pinning the refactor.
 * The exclusion is between OS processes, so the test spawns OS processes.
 *
 * WHAT THIS FILE DOES *NOT* CLAIM. There is no CLI-vs-CLI lost-update test here,
 * and that is deliberate rather than an omission: `add-agent` (src/cli/add-agent.ts,
 * the `existsSync(agentDir)` guard) and `import-agent` both exit 1 when the agent
 * directory already exists, so two CLI invocations can never both reach the
 * config.json writes for the same agent. The real concurrent writer is the
 * dashboard (whose routes take this same lock). What is proven below is (a) the
 * helper genuinely excludes concurrent OS processes, and (b) the CLI call site
 * actually goes through it — which is what makes (a) apply to the CLI at all.
 *
 * SANDBOXING: children run with cwd set to a temp dir, HOME overridden
 * (os.homedir() honours $HOME on POSIX), CTX_ROOT pointed INSIDE the sandbox
 * (set, not merely deleted, so a misconfigured child cannot reach the real
 * ~/.cortextos or its daemon socket), and CTX_FRAMEWORK_ROOT / CTX_PROJECT_ROOT
 * deleted so projectRoot resolves to the sandbox.
 *
 * NO dist/ GATE. Every arm here runs under `tsx` (a devDependency), never
 * `dist/cli.js`. CI's `test` job runs without a build, so a dist-gated test
 * would skip itself there forever and report green while proving nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mutateAgentConfig, writeAgentConfig, agentConfigPath } from '../../src/utils/agent-config';

const execFileAsync = promisify(execFile);

const REPO_ROOT = join(__dirname, '..', '..');
const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const HELPER_MODULE = join(REPO_ROOT, 'src', 'utils', 'agent-config.js');

const ORG = 'raceorg';
const AGENT = 'racer';

/** Sandboxed $HOME, which doubles as the project root (cwd) for the children. */
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'agent-config-race-'));
  mkdirSync(agentDir(), { recursive: true });
});

afterEach(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

const agentDir = () => join(sandbox, 'orgs', ORG, 'agents', AGENT);
const configPath = () => join(agentDir(), 'config.json');
const barrierDir = () => join(sandbox, 'barrier');
const tornDir = () => join(sandbox, 'torn');

/** Torn reads observed by the children — a second, independent loss signal. */
const tornReads = () => readdirSync(tornDir());

/**
 * Padding keys nobody mutates, present only to make the file big.
 *
 * Load-bearing, not decoration. The unlocked window is
 * parse -> mutate -> serialise -> write, and against a small file that window is
 * far shorter than process startup jitter, so the children would rarely overlap
 * and a broken build would go green. Every writer preserves unknown keys, so
 * padding survives a correct run untouched — and a stale-snapshot write drops
 * keys wholesale, so padding doubles as a second, independent loss signal.
 */
const PADDING_ENTRIES = 2000;

/** Concurrent writers, and how many mutations each performs. */
const WRITERS = 4;
const ITERATIONS = 6;

function seed(): void {
  const cfg: Record<string, any> = { agent_name: AGENT, enabled: true, counter: 0 };
  for (let i = 0; i < PADDING_ENTRIES; i++) cfg[`padding_${i}`] = 'x'.repeat(200);
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
  for (const d of [barrierDir(), tornDir()]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
}

/**
 * The detector, shared by both arms so the control arm validates the exact
 * assertion the locked arm relies on. Returns the list of things that were lost;
 * empty means every mutation survived.
 *
 * TWO INDEPENDENT INVARIANTS, because either one alone can be fooled:
 *
 *  - DISJOINT KEYS. Each writer owns `writer_<i>`. A lost update is invisible if
 *    both writers set the same field to a coherent value — "last writer wins"
 *    then looks identical to a correct locked run. Disjoint keys that must ALL
 *    survive is what makes the loss observable at all.
 *  - AN ACCUMULATING COUNTER. Disjoint keys only catch the LAST write of each
 *    writer; with several iterations apiece, a writer could lose four updates in
 *    the middle and still leave its key behind. `counter` is incremented under
 *    the same read-modify-write, so the sum is exact: anything below
 *    WRITERS*ITERATIONS is a proven lost update, not an inference.
 */
function losses(expectedCounter = WRITERS * ITERATIONS): string[] {
  const raw = readFileSync(configPath(), 'utf-8');
  let cfg: Record<string, any>;
  try {
    cfg = JSON.parse(raw);
  } catch {
    // A torn/truncated file is worse than a lost field: the daemon, the CLI and
    // the dashboard all read this file and several of them fall back to
    // defaults on a parse error rather than refusing to start.
    return [`config.json is not valid JSON (${raw.length} bytes)`];
  }

  const lost: string[] = [];
  for (let i = 0; i < WRITERS; i++) {
    if (cfg[`writer_${i}`] !== i) {
      lost.push(`writer_${i}: expected ${i}, got ${JSON.stringify(cfg[`writer_${i}`])}`);
    }
  }
  if (cfg.counter !== expectedCounter) {
    lost.push(`counter: expected ${expectedCounter}, got ${JSON.stringify(cfg.counter)}`);
  }
  const paddingPresent = Object.keys(cfg).filter(k => k.startsWith('padding_')).length;
  if (paddingPresent !== PADDING_ENTRIES) {
    lost.push(`padding keys: expected ${PADDING_ENTRIES}, found ${paddingPresent}`);
  }
  return lost;
}

/** Child env: sandboxed HOME and CTX_ROOT, every projectRoot override cleared. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: sandbox, CTX_ROOT: join(sandbox, '.cortextos-sandbox') };
  delete env.CTX_FRAMEWORK_ROOT;
  delete env.CTX_PROJECT_ROOT;
  return env;
}

/**
 * A filesystem start barrier, inlined into every child.
 *
 * Without it the arms are flaky in the direction that matters: interpreter
 * startup jitter (tens to hundreds of milliseconds, and different for `node`
 * and `tsx`) dwarfs the read-modify-write window, so the children would mostly
 * run one after another and BOTH arms would pass. A wall-clock deadline is not
 * enough either — it has to absorb however long the slowest interpreter took to
 * boot. Each child announces itself, then spins until all of them have.
 */
const BARRIER_SRC = (lang: 'cjs' | 'esm') => `
${lang === 'cjs'
  ? "const { writeFileSync, readdirSync } = require('fs');\nconst { join } = require('path');"
  : "import { writeFileSync, readdirSync } from 'fs';\nimport { join } from 'path';"}
const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function barrier(dir, index, total) {
  writeFileSync(join(dir, 'ready-' + index), '');
  for (;;) {
    if (readdirSync(dir).length >= total) return;
    spin(2);
  }
}
`;

/**
 * Control-arm harness: the *unlocked* read-modify-write these call sites used to
 * do, as a standalone script with no repo imports. Its job is to prove the
 * detector above can actually see a lost update — without it, a green locked arm
 * is indistinguishable from a test that checks nothing.
 */
const UNSAFE_CHILD = `${BARRIER_SRC('cjs')}
const { readFileSync } = require('fs');
const [file, barrierPath, indexRaw, totalRaw, itersRaw, tornDir] = process.argv.slice(2);
const index = Number(indexRaw);
barrier(barrierPath, index, Number(totalRaw));

for (let n = 0; n < Number(itersRaw); n++) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf-8'));       // read...
  } catch (e) {
    // A TORN READ: plain writeFileSync is not atomic, so a reader can catch the
    // file mid-truncate. Recorded rather than thrown — an unhandled crash here
    // would fail the control arm as an error instead of scoring it as the
    // observation it is. (The locked helper writes via atomicWriteSync, so this
    // branch is one of the things the locked arm rules out.)
    writeFileSync(join(tornDir, 'torn-' + index + '-' + n), String(e && e.message));
    continue;
  }
  spin(20);                                             // ...window...
  cfg['writer_' + index] = index;
  cfg.counter = (cfg.counter || 0) + 1;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\\n');  // ...write. No lock.
}
`;

/**
 * Locked arm: the same workload, routed through the real helper. Imported by
 * absolute path so the child can live in the sandbox while the module it
 * exercises stays the one under test.
 */
const LOCKED_CHILD = `${BARRIER_SRC('esm')}
import { mutateAgentConfig } from ${JSON.stringify(HELPER_MODULE)};
const [dir, barrierPath, indexRaw, totalRaw, itersRaw, tornDir] = process.argv.slice(2);
const index = Number(indexRaw);
barrier(barrierPath, index, Number(totalRaw));

for (let n = 0; n < Number(itersRaw); n++) {
  try {
    mutateAgentConfig(dir, (cfg) => {
      spin(20);                     // same window the control arm loses in
      cfg['writer_' + index] = index;
      cfg.counter = (cfg.counter || 0) + 1;
    }, { timeoutMs: 60_000 });      // generous: contention here is the point
  } catch (e) {
    // Symmetric with the control child, and load-bearing for the same reason:
    // if this arm could not report a torn read, the parent's torn-read
    // assertion would be green by construction. mutateAgentConfig's own
    // JSON.parse throws on a partially written file, so this is the branch a
    // tear would take here.
    writeFileSync(join(tornDir, 'torn-' + index + '-' + n), String(e && e.message));
  }
}
`;

function runWriters(interpreter: string, script: string, firstArg: string) {
  return Promise.all(
    Array.from({ length: WRITERS }, (_, i) =>
      execFileAsync(
        interpreter,
        [script, firstArg, barrierDir(), String(i), String(WRITERS), String(ITERATIONS), tornDir()],
        { cwd: sandbox, env: childEnv() },
      ),
    ),
  );
}

describe('agent config.json: concurrent mutation', () => {
  it('CONTROL ARM: unlocked read-modify-write loses updates, and the detector sees it', async () => {
    const script = join(sandbox, 'unsafe-rmw.cjs');
    writeFileSync(script, UNSAFE_CHILD);
    seed();

    await runWriters(process.execPath, script, configPath());

    // The lost-update detector specifically, not "something went wrong": the
    // locked arm's green rests on THIS assertion being able to fire, and torn
    // reads alone would not exercise it.
    expect(
      losses(),
      'control arm lost nothing — the detector cannot see the failure the locked ' +
        'arm claims to rule out, so the locked arm would prove nothing',
    ).not.toEqual([]);
  }, 120_000);

  /**
   * THIS TEST MUST STILL BE ABLE TO FAIL. Verified by mutation: replacing the
   * `withFileLockSync` call in src/utils/agent-config.ts with a direct call to
   * its callback makes it fail. The detection rate over repeated runs is
   * recorded in the commit message — a single observed failure would not have
   * been enough, because whether the children's write windows overlap is
   * probabilistic. Re-run that experiment if you change PADDING_ENTRIES,
   * WRITERS, ITERATIONS or the in-mutate `spin`: every one of those knobs
   * controls whether the children collide, and a green here means nothing if
   * they never do.
   */
  it('mutateAgentConfig serialises concurrent processes: every mutation survives', async () => {
    expect(existsSync(TSX), 'tsx (devDependency) is required — this arm must never self-skip').toBe(true);
    const script = join(sandbox, 'locked-rmw.ts');
    writeFileSync(script, LOCKED_CHILD);
    seed();

    await runWriters(TSX, script, agentDir());

    expect(losses(), 'no concurrent mutation may be lost under the lock').toEqual([]);
    // The control arm also observed torn reads (plain writeFileSync truncates
    // in place); the lock plus atomicWriteSync must eliminate those too.
    expect(tornReads(), 'no reader may see a partially written config.json').toEqual([]);
    expect(existsSync(join(agentDir(), '.lock.d')), 'lock must not be left behind').toBe(false);
  }, 120_000);
});

/**
 * Does the CLI actually route through the helper?
 *
 * The arm above proves the helper excludes other processes; it says nothing
 * about whether `add-agent` calls it. This proves that WITHOUT needing two CLI
 * runs to collide (they cannot — the `existsSync(agentDir)` guard makes the
 * second one exit 1): an adversary takes the agent directory's lock and holds it
 * past the 5s default timeout, and we check whether the CLI's config.json write
 * was excluded by it.
 *
 * Against an unlocked add-agent the held lock is invisible and config.json is
 * written anyway — which is exactly the failure this asserts against.
 */
describe('add-agent: the config.json write takes the agent-directory lock', () => {
  /**
   * Spins until the agent directory appears, then takes the lock the way
   * `acquireLock` does — mkdir `.lock.d` plus a pid file naming a LIVE process
   * (its own), so the holder passes the `process.kill(pid, 0)` liveness check
   * and is not stolen as stale.
   *
   * It reports whether config.json already existed at the moment it acquired.
   * That is the validity signal for the whole test and it is derived from the
   * filesystem, not from the code under test: the template used here ships no
   * config.json, so `configExisted === false` proves the adversary got in ahead
   * of add-agent's config.json write. If it lost the race the iteration is
   * discarded rather than scored — otherwise a lost race would read as a pass.
   */
  const ADVERSARY = `
const { mkdirSync, writeFileSync, existsSync, rmSync } = require('fs');
const { join } = require('path');
const [agentDir, reportPath, holdMsRaw] = process.argv.slice(2);
const spin = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockDir = join(agentDir, '.lock.d');
const configPath = join(agentDir, 'config.json');

for (;;) {
  if (existsSync(agentDir)) {
    try {
      mkdirSync(lockDir);                                   // atomic; EEXIST if taken
      const configExisted = existsSync(configPath);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      writeFileSync(reportPath, JSON.stringify({ configExisted }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // add-agent already holds it: we lost the race. Report and stop.
      writeFileSync(reportPath, JSON.stringify({ configExisted: true, lostRace: true }));
      break;
    }
  }
  spin(0);
}
spin(Number(holdMsRaw));
rmSync(lockDir, { recursive: true, force: true });
`;

  /** A template with NO config.json — see the adversary's validity signal. */
  const TEMPLATE = 'racetpl';

  function seedProject(): void {
    // The agent dir must NOT exist: add-agent exits 1 if it does.
    rmSync(join(sandbox, 'orgs'), { recursive: true, force: true });
    mkdirSync(join(sandbox, 'orgs', ORG, 'agents'), { recursive: true });
    const tpl = join(sandbox, 'templates', TEMPLATE);
    mkdirSync(tpl, { recursive: true });
    writeFileSync(join(tpl, 'IDENTITY.md'), '# {{AGENT_NAME}} of {{ORG_NAME}}\n');
    writeFileSync(join(tpl, 'AGENTS.md'), '# agents\n');
  }

  it('a foreign holder of <agentDir>/.lock.d blocks it, and it says so', async () => {
    expect(existsSync(TSX), 'tsx (devDependency) is required — this arm must never self-skip').toBe(true);

    const script = join(sandbox, 'adversary.cjs');
    writeFileSync(script, ADVERSARY);

    const ATTEMPTS = 3;
    let scored = 0;
    const failures: string[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      seedProject();
      const reportPath = join(sandbox, `adversary-report-${attempt}.json`);

      // Hold past add-agent's 5s default so the wait provably times out.
      const adversary = execFileAsync(process.execPath, [script, agentDir(), reportPath, '7000'], {
        cwd: sandbox, env: childEnv(),
      });

      const cli = await execFileAsync(
        TSX,
        [CLI_ENTRY, 'add-agent', AGENT, '--template', TEMPLATE, '--org', ORG],
        { cwd: sandbox, env: childEnv() },
      );
      await adversary;

      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (report.configExisted) continue;  // adversary lost the race — not scorable
      scored++;

      if (existsSync(configPath())) {
        failures.push(
          `attempt ${attempt}: config.json was written while a foreign process held ` +
            `${join(agentDir(), '.lock.d')} — the write does not take the lock`,
        );
      }
      if (!/failed to write config\.json/.test(cli.stderr)) {
        failures.push(
          `attempt ${attempt}: no warning on stderr; a blocked write must not be silent. ` +
            `stderr was: ${JSON.stringify(cli.stderr)}`,
        );
      }
      // Blocked config.json must not abort the run: the rest of the agent
      // directory is still created and the command still succeeds.
      if (!existsSync(join(agentDir(), 'IDENTITY.md'))) {
        failures.push(`attempt ${attempt}: template files missing — add-agent aborted on the lock timeout`);
      }
    }

    expect(scored, 'the adversary never won the race to the lock; nothing was actually tested').toBeGreaterThan(0);
    expect(failures, 'add-agent must be excluded by the agent-directory lock').toEqual([]);
  }, 180_000);
});

describe('agent config.json: lock protocol', () => {
  const lockDir = () => join(agentDir(), '.lock.d');

  /**
   * Pins the literal rendezvous path. NOT a concurrency claim — a path
   * assertion, and it matters because a lock only excludes writers that lock the
   * SAME directory. The dashboard's config and crons routes lock
   * `dirname(configPath)`, i.e. this directory; `src/bus/crons.ts` locks the
   * STATE directory instead, which is a different door entirely. If this side
   * ever drifted, every other test here would still pass while the two processes
   * locked different directories.
   */
  it('holds <agentDir>/.lock.d during the mutation, and releases it', () => {
    expect(agentConfigPath(agentDir())).toBe(join(agentDir(), 'config.json'));
    expect(existsSync(lockDir())).toBe(false);

    let heldDuringMutate: boolean | null = null;
    mutateAgentConfig(agentDir(), (cfg) => {
      heldDuringMutate = existsSync(lockDir());
      cfg.agent_name = AGENT;
    });

    expect(heldDuringMutate, 'lock marker must exist while mutate runs').toBe(true);
    expect(existsSync(lockDir()), 'lock marker must be released afterwards').toBe(false);
  });

  it('writeAgentConfig takes the same lock even though it reads nothing', () => {
    // A bare atomic write still has to be excluded: landing between another
    // process's read and its write-back is precisely how it gets discarded.
    let held: boolean | null = null;
    const spy = { toJSON() { held = existsSync(lockDir()); return { agent_name: AGENT }; } };
    writeAgentConfig(agentDir(), spy as any);

    expect(held, 'lock must be held while the replacement is serialised and written').toBe(true);
    expect(existsSync(lockDir())).toBe(false);
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).agent_name).toBe(AGENT);
  });

  it('creates the file when absent, reporting existed=false', () => {
    let sawExisted: boolean | null = null;
    const wrote = mutateAgentConfig(agentDir(), (cfg, existed) => {
      sawExisted = existed;
      cfg.agent_name = AGENT;
    });

    expect(sawExisted).toBe(false);
    expect(wrote).toBe(true);
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).agent_name).toBe(AGENT);
  });

  it('creates the agent directory when absent, so the lock has somewhere to live', () => {
    // acquireLock mkdirs `<dir>/.lock.d` NON-recursively, so a missing agent dir
    // would make every call throw ENOENT rather than lock anything.
    const fresh = join(sandbox, 'orgs', ORG, 'agents', 'brand-new');
    expect(existsSync(fresh)).toBe(false);
    mutateAgentConfig(fresh, (cfg) => { cfg.agent_name = 'brand-new'; });
    expect(existsSync(join(fresh, 'config.json'))).toBe(true);
  });

  it('declines the write when mutate returns false, leaving the file byte-identical', () => {
    writeFileSync(configPath(), JSON.stringify({ agent_name: AGENT }, null, 2) + '\n');
    const before = readFileSync(configPath(), 'utf-8');

    const wrote = mutateAgentConfig(agentDir(), (cfg) => {
      cfg.enabled = false;
      return false;
    });

    expect(wrote).toBe(false);
    // Byte-identical matters beyond the field values: declining exists so a
    // no-op run does not churn the mtime the daemon's config watcher keys on.
    expect(readFileSync(configPath(), 'utf-8')).toBe(before);
    expect(existsSync(lockDir()), 'lock must be released on the decline path').toBe(false);
  });

  it('preserves keys it does not know about', () => {
    // The whole reason the lock is worth having: the CLI, the dashboard and the
    // templates each own a different subset of this file.
    writeFileSync(configPath(), JSON.stringify({
      agent_name: AGENT, crons: [{ name: 'heartbeat' }], some_future_field: 42,
    }, null, 2) + '\n');

    mutateAgentConfig(agentDir(), (cfg) => { cfg.runtime = 'opencode'; });

    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.crons).toEqual([{ name: 'heartbeat' }]);
    expect(cfg.some_future_field).toBe(42);
    expect(cfg.runtime).toBe('opencode');
  });

  it('refuses to overwrite a corrupt file rather than resetting it to defaults', () => {
    // Treating a parse failure as `{}` would let add-agent's create branch
    // rewrite a recoverable config.json down to bare defaults and report success.
    const corrupt = '{ this is not json';
    writeFileSync(configPath(), corrupt);

    expect(() => mutateAgentConfig(agentDir(), (cfg) => { cfg.agent_name = 'clobbered'; })).toThrow();
    expect(readFileSync(configPath(), 'utf-8'), 'original must be untouched').toBe(corrupt);
    expect(existsSync(lockDir()), 'lock must be released even when mutate throws').toBe(false);
  });

  it('writes exactly one trailing newline, matching the previous hand-rolled writes', () => {
    // atomicWriteSync appends its own newline. Every call site used to append
    // `+ '\n'` explicitly; if one of those had been left in place the file would
    // gain a blank line on every write.
    mutateAgentConfig(agentDir(), (cfg) => { cfg.agent_name = AGENT; });
    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
  });

  it('does not leave temp files beside config.json', () => {
    mutateAgentConfig(agentDir(), (cfg) => { cfg.agent_name = AGENT; });
    expect(readdirSync(agentDir())).toEqual(['config.json']);
  });
});
