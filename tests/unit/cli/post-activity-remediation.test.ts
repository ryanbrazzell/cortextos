/**
 * `cortextos bus post-activity` failure message must name the file the loader
 * actually reads.
 *
 * Bug context (verified 2026-08-04 in the rally-engineering org): the message
 * said "Check that ACTIVITY_CHAT_ID is set in your org secrets.env or .env
 * file", but postActivity() (src/bus/system.ts) opens only
 * `activity-channel.env`, from two candidate paths, and needs
 * ACTIVITY_BOT_TOKEN as well. The org had a real ACTIVITY_CHAT_ID sitting in
 * secrets.env and no activity-channel.env anywhere — exactly the state the old
 * message steers an operator into: right value, file nobody reads.
 *
 * The second test is the one that matters. It does not check the wording — it
 * takes the path out of the error message and writes the config there. If the
 * message ever names a path the loader does not consult, that arm fails.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { tmpdir } from 'os';

/**
 * True only if `target` is genuinely inside `root`. A `startsWith` check is not
 * enough: a sibling directory sharing a name prefix passes it, and `..`
 * segments escape after resolution.
 */
function isInside(root: string, target: string): boolean {
  const rel = relative(realpathSync(root), resolve(target));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

import { busCommand } from '../../../src/cli/bus';

let tempCtx: string;
let tempCwd: string;
let originalCwd: string;
// resolveEnv() reads several ambient CTX_* vars. Under the live agent shell
// CTX_AGENT_DIR points at the real org directory, so anything derived from it
// resolves OUTSIDE the temp sandbox — an earlier draft of this test wrote a
// config file into the real org. Save and override every var that feeds the
// resolution, and assert the sandbox holds before writing (see arm 2).
const ENV_KEYS = [
  'CTX_ROOT',
  'CTX_ORG',
  'CTX_AGENT_NAME',
  'CTX_AGENT_DIR',
  'CTX_PROJECT_ROOT',
  'CTX_FRAMEWORK_ROOT',
] as const;
let originalEnv: Record<string, string | undefined> = {};
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** Everything the command wrote to stderr for this invocation, joined. */
function stderrText(): string {
  return errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  tempCtx = mkdtempSync(join(tmpdir(), 'postactivity-ctx-'));
  tempCwd = mkdtempSync(join(tmpdir(), 'postactivity-cwd-'));

  originalCwd = process.cwd();
  originalEnv = {};
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

  process.env.CTX_ROOT = tempCtx;
  process.env.CTX_ORG = 'test-org';
  process.env.CTX_AGENT_NAME = 'test-agent';
  // Deliberately NOT under `<ctxRoot>/orgs/<org>`, so the orgDir-derived path
  // and the ctxRoot fallback path are distinguishable. If they collided, a test
  // could not tell which branch produced the path it saw.
  process.env.CTX_AGENT_DIR = join(tempCtx, 'agent-org', 'agents', 'test-agent');
  process.env.CTX_PROJECT_ROOT = tempCtx;
  process.env.CTX_FRAMEWORK_ROOT = tempCtx;
  process.chdir(tempCwd);

  sendMessageSpy.mockClear();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  process.chdir(originalCwd);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k]!;
  }
  rmSync(tempCtx, { recursive: true, force: true });
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('post-activity failure message points at the file the loader reads', () => {
  it('names activity-channel.env and BOTH required keys, and does not name secrets.env/.env', async () => {
    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });

    const text = stderrText();
    expect(text).toContain('activity-channel.env');
    expect(text).toContain('ACTIVITY_BOT_TOKEN');
    expect(text).toContain('ACTIVITY_CHAT_ID');
    // The regression itself: the old text told operators to SET the keys in
    // secrets.env / .env — files postActivity never opens. Mentioning those
    // names is fine and useful (this org has a stray ACTIVITY_CHAT_ID sitting
    // in secrets.env, so saying they are not consulted is the point). What
    // must not come back is directing the fix at them.
    expect(text).not.toMatch(/set in[^.]*secrets\.env/);
  });

  it('the path it prints is one postActivity actually loads', async () => {
    // Arm 1 — no config anywhere: the command fails and prints a path.
    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });
    expect(sendMessageSpy).not.toHaveBeenCalled();

    const printedPath = stderrText().match(/(\S*activity-channel\.env)/)?.[1];
    expect(printedPath, 'failure message must name a concrete config path').toBeTruthy();

    // It must be the orgDir-derived candidate, not merely *a* candidate — a
    // message naming the fallback while the agent dir is set would still let
    // this arm pass on the loader's second lookup.
    expect(printedPath).toBe(join(tempCtx, 'agent-org', 'activity-channel.env'));

    // SAFETY GATE — this arm writes to a path the code under test chose, so it
    // must be proven inside the sandbox first. Without this, an ambient
    // CTX_AGENT_DIR resolves the path into the real org directory and the test
    // writes a fake bot token into live config. That is not hypothetical; it
    // happened while writing this test.
    expect(
      isInside(tempCtx, printedPath!),
      `refusing to write outside the sandbox: ${printedPath}`,
    ).toBe(true);

    // Arm 2 — take the command at its word: write the config exactly where it
    // said, with exactly the two keys it named, and change nothing else.
    mkdirSync(dirname(printedPath!), { recursive: true });
    writeFileSync(
      printedPath!,
      'ACTIVITY_BOT_TOKEN=fake-token-for-test\nACTIVITY_CHAT_ID=12345\n',
      'utf-8',
    );
    errSpy.mockClear();

    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });

    // If the remediation named a path the loader does not consult, postActivity
    // would still bail before the send and this stays at zero calls.
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe('hello');
    expect(stderrText()).toBe('');
  });

  it('falls back to the ctxRoot candidate when there is no agent dir, and that one loads too', async () => {
    // With no agent dir resolvable, orgDir is empty and the message must name
    // postActivity's SECOND candidate: <ctxRoot>/orgs/<org>/activity-channel.env.
    // Both must be cleared — resolveEnv derives an agent dir from projectRoot.
    delete process.env.CTX_AGENT_DIR;
    delete process.env.CTX_PROJECT_ROOT;

    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });

    const printedPath = stderrText().match(/(\S*activity-channel\.env)/)?.[1];
    expect(printedPath).toBe(join(tempCtx, 'orgs', 'test-org', 'activity-channel.env'));
    expect(isInside(tempCtx, printedPath!)).toBe(true);

    mkdirSync(dirname(printedPath!), { recursive: true });
    writeFileSync(
      printedPath!,
      'ACTIVITY_BOT_TOKEN=fake-token-for-test\nACTIVITY_CHAT_ID=12345\n',
      'utf-8',
    );
    errSpy.mockClear();

    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(stderrText()).toBe('');
  });

  it('does not blame configuration for a send failure it cannot diagnose', async () => {
    // Config present and valid, but the send throws. postActivity collapses
    // this into the same `false`, so the message must not assert that the
    // config is wrong — it is the one thing here that is demonstrably right.
    const configPath = join(tempCtx, 'agent-org', 'activity-channel.env');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      'ACTIVITY_BOT_TOKEN=fake-token-for-test\nACTIVITY_CHAT_ID=12345\n',
      'utf-8',
    );
    sendMessageSpy.mockRejectedValueOnce(new Error('telegram 500'));

    await busCommand.parseAsync(['post-activity', 'hello'], { from: 'user' });

    const text = stderrText();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(text).not.toMatch(/^Failed to post activity\. Check that/);
    expect(text).toMatch(/send itself failed/);
  });
});
