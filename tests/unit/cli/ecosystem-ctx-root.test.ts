/**
 * `cortextos ecosystem` must hand the daemon and the dashboard the SAME
 * CTX_ROOT, under every combination of the env vars PM2 evaluates when it
 * loads the generated file. Both apps resolve their entire state tree from
 * CTX_ROOT, so a disagreement is a silent split brain: every dashboard panel
 * renders one instance's state while the daemon runs another's, with no error
 * raised anywhere.
 *
 * The generated file is loaded here the way PM2 loads it — a real require()
 * under a real process.env — because the whole contract lives in expressions
 * that are evaluated at startup, not at generation time. Asserting on the
 * file's text would restate the template instead of testing what it produces.
 *
 * Two independent ways this used to split, one arm each below:
 *
 *   - an ambient CTX_ROOT (every agent shell exports one) was inherited by the
 *     daemon block alone, via `process.env.CTX_ROOT || ...`;
 *   - the daemon's CTX_ROOT was a literal baked at generation time, so the
 *     `CTX_INSTANCE_ID=foo pm2 restart` switch that the generated header
 *     advertises moved the dashboard's root and the --instance arg but left
 *     the daemon's CTX_ROOT on the instance the file was generated for.
 *
 * Both now derive from the same instance-id expression, which is also what the
 * daemon itself does at runtime (src/daemon/index.ts: "Always derive ctxRoot
 * from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';
import { ecosystemCommand } from '../../../src/cli/ecosystem';

/** Load the generated config through a genuine CJS require under `env`. */
function loadUnder(configPath: string, env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key]!;
  }
  try {
    const req = createRequire(import.meta.url);
    // The file is evaluated fresh on every arm: PM2 reads it in one env, and a
    // cached module would silently reuse the previous arm's resolved values.
    delete req.cache[req.resolve(configPath)];
    const config = req(configPath) as { apps: Array<{ name: string; env: Record<string, string> }> };
    const byName = Object.fromEntries(config.apps.map(a => [a.name, a.env]));
    return {
      daemon: byName['cortextos-daemon'],
      dashboard: byName['cortextos-dashboard'],
    };
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

describe('cortextos ecosystem: daemon and dashboard resolve one CTX_ROOT', () => {
  let tmpHome: string;
  let projectRoot: string;
  let configPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ['HOME', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_ROOT', 'CTX_INSTANCE_ID', 'CTX_ORG']) {
      saved[key] = process.env[key];
    }
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-eco-'));
    projectRoot = join(tmpHome, 'cortextos');

    // One agent, so the generator does not bail with "No agents found".
    mkdirSync(join(projectRoot, 'orgs', 'test-org', 'agents', 'test-agent'), { recursive: true });
    // The dashboard block is only emitted when both of these exist.
    mkdirSync(join(projectRoot, 'dashboard', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(projectRoot, 'dashboard', 'package.json'), '{"name":"dashboard"}');
    writeFileSync(join(projectRoot, 'dashboard', 'node_modules', '.bin', 'next'), '');

    process.env.HOME = tmpHome;
    process.env.CTX_FRAMEWORK_ROOT = projectRoot;
    delete process.env.CTX_PROJECT_ROOT;
    delete process.env.CTX_ROOT;
    delete process.env.CTX_INSTANCE_ID;

    configPath = join(tmpHome, 'ecosystem.config.js');
    await ecosystemCommand.parseAsync(
      ['--instance', 'staging', '--org', 'test-org', '--output', configPath],
      { from: 'user' },
    );
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('emits a dashboard block at all', () => {
    // Guards the arms below: if the dashboard block were dropped, every
    // agreement assertion would compare against undefined and pass vacuously.
    const { daemon, dashboard } = loadUnder(configPath, { CTX_ROOT: undefined, CTX_INSTANCE_ID: undefined });
    expect(daemon).toBeDefined();
    expect(dashboard).toBeDefined();
    expect(daemon.CTX_ROOT).toBeTruthy();
    expect(dashboard.CTX_ROOT).toBeTruthy();
  });

  it('agrees in a clean env, on the instance the file was generated for', () => {
    const { daemon, dashboard } = loadUnder(configPath, { CTX_ROOT: undefined, CTX_INSTANCE_ID: undefined });
    const expected = join(tmpHome, '.cortextos', 'staging');
    expect(daemon.CTX_ROOT).toBe(expected);
    expect(dashboard.CTX_ROOT).toBe(expected);
  });

  it('ignores an ambient CTX_ROOT rather than letting it reach one app only', () => {
    const stray = join(tmpdir(), 'some-parent-cortextos');
    const { daemon, dashboard } = loadUnder(configPath, { CTX_ROOT: stray, CTX_INSTANCE_ID: undefined });
    const expected = join(tmpHome, '.cortextos', 'staging');
    expect(daemon.CTX_ROOT).toBe(expected);
    expect(dashboard.CTX_ROOT).toBe(expected);
    // Stated separately: the two could agree *on the stray value* and still be
    // wrong, since the daemon derives its own root and would ignore it.
    expect(daemon.CTX_ROOT).not.toBe(stray);
  });

  it('moves both roots together when CTX_INSTANCE_ID switches the instance', () => {
    const { daemon, dashboard } = loadUnder(configPath, { CTX_ROOT: undefined, CTX_INSTANCE_ID: 'other' });
    const expected = join(tmpHome, '.cortextos', 'other');
    expect(daemon.CTX_ROOT).toBe(expected);
    expect(dashboard.CTX_ROOT).toBe(expected);
    expect(daemon.CTX_INSTANCE_ID).toBe('other');
    expect(dashboard.CTX_INSTANCE_ID).toBe('other');
  });

  it('keeps the daemon --instance arg on the same instance as its CTX_ROOT', () => {
    // The arg and the env are two separate expressions in the template; a fix
    // applied to one and not the other reproduces the split via the daemon's
    // own --instance flag.
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve(configPath)];
    process.env.CTX_INSTANCE_ID = 'other';
    try {
      const config = req(configPath) as { apps: Array<{ name: string; args?: string; env: Record<string, string> }> };
      const daemon = config.apps.find(a => a.name === 'cortextos-daemon')!;
      expect(daemon.args).toBe('--instance other');
      expect(daemon.env.CTX_ROOT).toBe(join(tmpHome, '.cortextos', 'other'));
    } finally {
      delete process.env.CTX_INSTANCE_ID;
    }
  });
});
