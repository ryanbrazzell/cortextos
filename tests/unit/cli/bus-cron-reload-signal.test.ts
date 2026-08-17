/**
 * tests/unit/cli/bus-cron-reload-signal.test.ts
 *
 * A cron mutation reaches the running daemon ONLY via the reload-crons IPC
 * signal. `CronScheduler` calls `loadCrons()` from exactly two places —
 * `start()` and `reload()` — and `tick()` dispatches from the definition it
 * already holds in memory. There is no periodic re-read.
 *
 * The code these tests pin used to claim the opposite, in two comments, and
 * swallow the failure: `add-cron`/`remove-cron`/`update-cron` printed success
 * unconditionally while a dropped signal left the daemon firing the OLD prompt
 * indefinitely. `list-crons` reads the FILE, so it shows the new value either
 * way and cannot be used to detect this.
 *
 * The subtle half, and the reason a try/catch alone was never enough:
 * `IPCClient.send()` RESOLVES with `{ success: false }` when the daemon is down
 * (ECONNREFUSED/ENOENT) rather than rejecting. The single most common failure
 * therefore never threw at all — it arrived as a return value that was dropped
 * on the floor.
 *
 * Each test asserts BOTH halves of the contract: the warning fires, and it
 * describes a LIVENESS problem while the write itself still landed on disk.
 * A warning that read as "the save failed" would send an operator to re-run a
 * write that was never the problem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CronDefinition } from '../../../src/types/index';

// Default mock: daemon running, reload acknowledged. Individual tests override.
const mockIpcSend = vi.fn().mockResolvedValue({ success: true, data: 'mocked' });
const mockIpcIsDaemonRunning = vi.fn().mockResolvedValue(true);

vi.mock('../../../src/daemon/ipc-server.js', () => {
  class MockIPCClient {
    send = mockIpcSend;
    isDaemonRunning = mockIpcIsDaemonRunning;
  }
  return { IPCClient: MockIPCClient };
});

let tmpRoot: string;
let frameworkRoot: string;
const originalCtxRoot = process.env.CTX_ROOT;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;
const originalAgentName = process.env.CTX_AGENT_NAME;
const originalInstanceId = process.env.CTX_INSTANCE_ID;

const TEST_AGENT = 'boris';

function cronsJsonPath(): string {
  return join(tmpRoot, '.cortextOS', 'state', 'agents', TEST_AGENT, 'crons.json');
}

function readCronsFile(): CronDefinition[] {
  return JSON.parse(readFileSync(cronsJsonPath(), 'utf-8')).crons as CronDefinition[];
}

function seedCrons(crons: CronDefinition[]): void {
  const dir = join(tmpRoot, '.cortextOS', 'state', 'agents', TEST_AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'crons.json'),
    JSON.stringify({ updated_at: '2026-04-01T00:00:00.000Z', crons }, null, 2),
    'utf-8'
  );
}

function makeCron(name: string, overrides: Partial<CronDefinition> = {}): CronDefinition {
  return {
    name,
    prompt: `Execute ${name} workflow.`,
    schedule: '6h',
    enabled: true,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Join every console.warn call into one string for phrase assertions. */
function warnText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c) => c.join(' ')).join('\n');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-reload-test-'));
  frameworkRoot = mkdtempSync(join(tmpdir(), 'cron-reload-fw-'));
  mkdirSync(join(frameworkRoot, 'orgs', 'lifeos', 'agents', TEST_AGENT), { recursive: true });

  process.env.CTX_ROOT = tmpRoot;
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_INSTANCE_ID = 'default';

  // Reset to the acknowledged-reload default so one test cannot leak into another.
  mockIpcSend.mockReset().mockResolvedValue({ success: true, data: 'mocked' });
});

afterEach(() => {
  if (originalCtxRoot !== undefined) process.env.CTX_ROOT = originalCtxRoot;
  else delete process.env.CTX_ROOT;
  if (originalFrameworkRoot !== undefined) process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  else delete process.env.CTX_FRAMEWORK_ROOT;
  if (originalAgentName !== undefined) process.env.CTX_AGENT_NAME = originalAgentName;
  else delete process.env.CTX_AGENT_NAME;
  if (originalInstanceId !== undefined) process.env.CTX_INSTANCE_ID = originalInstanceId;
  else delete process.env.CTX_INSTANCE_ID;

  try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ }
  try { rmSync(frameworkRoot, { recursive: true }); } catch { /* ignore */ }
  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

describe('cron reload signal — failure is surfaced, not swallowed', () => {
  it('add-cron warns when the daemon is DOWN — the case that resolves rather than throws', async () => {
    // Exactly what IPCClient.send() does on ECONNREFUSED/ENOENT: resolve, not reject.
    mockIpcSend.mockResolvedValue({
      success: false,
      error: 'Daemon is not running. Start it with: cortextos start',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Run the heartbeat workflow.',
    ]);

    expect(warnSpy).toHaveBeenCalled();
    expect(warnText(warnSpy)).toContain('Daemon is not running');

    // The write still succeeded — the warning must not be read as a failed save.
    expect(logSpy).toHaveBeenCalledWith(`Added cron 'heartbeat' for ${TEST_AGENT}`);
    expect(readCronsFile()).toHaveLength(1);
  });

  it('add-cron warns when send() THROWS (timeout), the case the old bare catch did reach', async () => {
    mockIpcSend.mockRejectedValue(new Error('IPC request timed out'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Run the heartbeat workflow.',
    ]);

    expect(warnText(warnSpy)).toContain('IPC request timed out');
    expect(readCronsFile()).toHaveLength(1);
  });

  it('says the change is NOT LIVE, and does not imply the save failed', async () => {
    mockIpcSend.mockResolvedValue({ success: false, error: 'Daemon is not running.' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Run the heartbeat workflow.',
    ]);

    const text = warnText(warnSpy);
    // Persistence succeeded and the operator must be told so explicitly.
    expect(text).toContain('saved');
    // The whole point: no promise of an automatic pickup on a timer.
    expect(text).not.toMatch(/30s tick|next tick/i);
    expect(text).toMatch(/does not re-read|restart/i);
  });

  it('add-cron stays SILENT when the daemon acknowledges the reload', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Run the heartbeat workflow.',
    ]);

    expect(logSpy).toHaveBeenCalledWith(`Added cron 'heartbeat' for ${TEST_AGENT}`);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('update-cron warns — the mutation that motivated this, since list-crons cannot reveal it', async () => {
    seedCrons([makeCron('heartbeat')]);
    mockIpcSend.mockResolvedValue({ success: false, error: 'Daemon is not running.' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'update-cron', TEST_AGENT, 'heartbeat', '--prompt', 'A materially new prompt.',
    ]);

    expect(warnSpy).toHaveBeenCalled();
    // list-crons reads the FILE, so the new prompt is visible on disk while the
    // running daemon still fires the old one. Only the warning discriminates.
    expect(readCronsFile()[0].prompt).toBe('A materially new prompt.');
  });

  it('remove-cron warns too — a stale daemon keeps firing a cron that is gone from disk', async () => {
    seedCrons([makeCron('heartbeat')]);
    mockIpcSend.mockResolvedValue({ success: false, error: 'Daemon is not running.' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync(['node', 'bus', 'remove-cron', TEST_AGENT, 'heartbeat']);

    expect(warnSpy).toHaveBeenCalled();
    expect(readCronsFile()).toHaveLength(0);
  });

  it('a rejection with NO error string still warns, rather than reading as success', async () => {
    mockIpcSend.mockResolvedValue({ success: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await busCommand.parseAsync([
      'node', 'bus', 'add-cron', TEST_AGENT, 'heartbeat', '6h', 'Run the heartbeat workflow.',
    ]);

    expect(warnSpy).toHaveBeenCalled();
    expect(warnText(warnSpy)).toMatch(/without giving a reason/i);
  });
});
