/**
 * Boot-announcement suppression window.
 *
 * The daemon builds the startup prompt itself, before and independently of
 * anything the agent reads, so an agent-level doc cannot opt out of the
 * mandated "tell the user you are back" instruction. Restart clusters therefore
 * produced several near-identical announcements minutes apart. These tests pin
 * the suppression decision: the window, the config override, and — most
 * importantly — that every uncertain path fails OPEN and still announces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  isAwaitingInteractiveConfirmation: vi.fn().mockReturnValue(false),
  onExit: vi.fn(),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: vi.fn(),
  MessageDedup: class { isDuplicate() { return false; } },
}));
vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));
vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));
vi.mock('../../../src/bus/reminders.js', () => ({
  getOverdueReminders: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }),
}));

// The unit under test here is the daemon's *decision*, not the log parsing
// (which tests/unit/telegram/logging.test.ts covers). Stubbing the reader lets
// each case state "last send was N minutes ago" directly.
const mockGetLastOutbound = vi.fn();
vi.mock('../../../src/telegram/logging.js', () => ({
  getLastOutboundTimestamp: (...args: unknown[]) => mockGetLastOutbound(...args),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

const ANNOUNCE = 'saying you are back online';
const HANDOFF_UX = 'VERY FIRST tool call MUST be';
const minutesAgo = (m: number) => Date.now() - m * 60_000;

const fakeTelegramApi = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;

/** Boot an agent and return the startup prompt the PTY was spawned with. */
async function bootPrompt(config: Record<string, unknown> = {}): Promise<string> {
  const ap = new AgentProcess('alice', mockEnv, config);
  ap.setTelegramHandle(fakeTelegramApi, '8501517499');
  await ap.start();
  return (mockPty.spawn.mock.calls[0]?.[1] as string) ?? '';
}

/** Make the boot look like a context-handoff restart (marker + doc present). */
function stageHandoffRestart(): void {
  fsMocks.existsSync.mockImplementation((p: string) => {
    if (typeof p !== 'string') return false;
    if (p.endsWith('/.handoff-doc-path')) return true;
    if (p === '/tmp/handoff.md') return true;
    if (p.endsWith('/.onboarded')) return true;
    return false;
  });
  fsMocks.readFileSync.mockImplementation((p: string) =>
    (typeof p === 'string' && p.endsWith('/.handoff-doc-path')) ? '/tmp/handoff.md' : '');
}

beforeEach(() => {
  mockPty.spawn.mockClear();
  mockPty.onExit.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockGetLastOutbound.mockReset().mockReturnValue(null);
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('boot announcement — default 10 minute window', () => {
  it('announces when the agent has never messaged this chat', async () => {
    mockGetLastOutbound.mockReturnValue(null);
    expect(await bootPrompt()).toContain(ANNOUNCE);
  });

  it('suppresses when the agent messaged 2 minutes ago', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(2));
    expect(await bootPrompt()).not.toContain(ANNOUNCE);
  });

  it('announces when the last message was 30 minutes ago', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(30));
    expect(await bootPrompt()).toContain(ANNOUNCE);
  });

  it('announces at 11 minutes but suppresses at 9 — the boundary is real', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(11));
    expect(await bootPrompt()).toContain(ANNOUNCE);

    mockPty.spawn.mockClear();
    mockGetLastOutbound.mockReturnValue(minutesAgo(9));
    expect(await bootPrompt()).not.toContain(ANNOUNCE);
  });

  it('queries the log for this agent and this chat', async () => {
    await bootPrompt();
    expect(mockGetLastOutbound).toHaveBeenCalledWith('/tmp/test-ctx', 'alice', '8501517499');
  });
});

describe('boot announcement — fails open', () => {
  it('announces when the last-send time is unknown (null)', async () => {
    mockGetLastOutbound.mockReturnValue(null);
    expect(await bootPrompt()).toContain(ANNOUNCE);
  });

  it('announces when the logged timestamp is in the future (clock skew / corruption)', async () => {
    // A future timestamp must not be read as "just messaged them", or one bad
    // record would mute the agent until real time caught up.
    mockGetLastOutbound.mockReturnValue(Date.now() + 60 * 60_000);
    expect(await bootPrompt()).toContain(ANNOUNCE);
  });
});

describe('boot announcement — boot_message_suppression_minutes override', () => {
  it('a wider window suppresses a send the default would have allowed', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(30));
    expect(await bootPrompt({ boot_message_suppression_minutes: 60 })).not.toContain(ANNOUNCE);
  });

  it('0 disables suppression entirely', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(1));
    expect(await bootPrompt({ boot_message_suppression_minutes: 0 })).toContain(ANNOUNCE);
  });

  it('a negative or non-finite value disables suppression rather than misbehaving', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(1));
    expect(await bootPrompt({ boot_message_suppression_minutes: -5 })).toContain(ANNOUNCE);

    mockPty.spawn.mockClear();
    expect(await bootPrompt({ boot_message_suppression_minutes: NaN })).toContain(ANNOUNCE);
  });
});

describe('boot announcement — context handoff restarts', () => {
  it('suppresses the mandated first-call Telegram inside the window', async () => {
    stageHandoffRestart();
    mockGetLastOutbound.mockReturnValue(minutesAgo(2));
    const prompt = await bootPrompt();
    expect(prompt).toContain('CONTEXT HANDOFF');   // still a handoff boot...
    expect(prompt).not.toContain(HANDOFF_UX);      // ...minus the forced ping
  });

  it('still mandates it outside the window', async () => {
    stageHandoffRestart();
    mockGetLastOutbound.mockReturnValue(minutesAgo(30));
    expect(await bootPrompt()).toContain(HANDOFF_UX);
  });
});

describe('boot announcement — unrelated gates still hold', () => {
  it('telegram_polling:false suppresses regardless of a stale last-send', async () => {
    mockGetLastOutbound.mockReturnValue(minutesAgo(999));
    expect(await bootPrompt({ telegram_polling: false })).not.toContain(ANNOUNCE);
  });

  it('does not consult the outbound log when Telegram is disabled', async () => {
    await bootPrompt({ telegram_polling: false });
    expect(mockGetLastOutbound).not.toHaveBeenCalled();
  });
});
