/**
 * Handoff boot prompt: informs, does not mandate.
 *
 * The daemon builds the startup prompt before and independently of anything the
 * agent reads, so a directive placed here is executed by a session that has not
 * yet loaded its own docs. The handoff block used to order an unconditional
 * "CRITICAL ... your VERY FIRST tool call MUST be ... send-telegram ... BEFORE
 * running heartbeat" — which fired on every handoff restart with Telegram
 * configured, at any hour, whether or not an earlier message was unanswered and
 * whether or not the work was worth reporting.
 *
 * The daemon cannot see any of those conditions, so these tests pin that it no
 * longer mandates the send and instead defers to the agent's own online-status
 * judgment — while keeping the two things it CAN correctly assert: that this is
 * a continuation, and that the cold-boot greeting does not belong on one.
 *
 * Every absence assertion below is paired with a positive anchor. On its own,
 * "the prompt does not say VERY FIRST tool call" also passes when the handoff
 * block failed to render at all, which is the bug this file exists to witness.
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

const HANDOFF_DOC = '/tmp/handoff.md';
const fakeTelegramApi = { sendMessage: vi.fn().mockResolvedValue(undefined) } as never;

/** Boot an agent and return the startup prompt the PTY was spawned with. */
async function bootPrompt(opts: { telegram?: boolean } = {}): Promise<string> {
  const ap = new AgentProcess('alice', mockEnv, {});
  if (opts.telegram !== false) ap.setTelegramHandle(fakeTelegramApi, '111222333');
  await ap.start();
  return (mockPty.spawn.mock.calls[0]?.[1] as string) ?? '';
}

/** Make the boot look like a context-handoff restart (marker + doc present). */
function stageHandoffRestart(): void {
  fsMocks.existsSync.mockImplementation((p: string) => {
    if (typeof p !== 'string') return false;
    if (p.endsWith('/.handoff-doc-path')) return true;
    if (p === HANDOFF_DOC) return true;
    if (p.endsWith('/.onboarded')) return true;
    return false;
  });
  fsMocks.readFileSync.mockImplementation((p: string) =>
    (typeof p === 'string' && p.endsWith('/.handoff-doc-path')) ? HANDOFF_DOC : '');
}

/** A plain cold boot: onboarded, no handoff marker. */
function stageColdBoot(): void {
  fsMocks.existsSync.mockImplementation((p: string) => {
    if (typeof p !== 'string') return false;
    if (p.endsWith('/.onboarded')) return true;
    return false;
  });
}

beforeEach(() => {
  mockPty.spawn.mockClear();
  mockPty.onExit.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.unlinkSync.mockReset();
});

describe('handoff boot prompt — informs, does not mandate a Telegram send', () => {
  it('does not order a first-call Telegram send on a handoff restart', async () => {
    stageHandoffRestart();
    const prompt = await bootPrompt();

    // Positive anchor first: without this, every absence below is vacuous
    // because an unrendered handoff block would satisfy all of them.
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(prompt).toContain('HANDOFF UX');

    // The mandate and its urgency framing are gone.
    expect(prompt).not.toContain('VERY FIRST tool call');
    expect(prompt).not.toContain('CRITICAL');
    expect(prompt).not.toContain('BEFORE running heartbeat');
    // No pre-filled message body for the agent to emit unthinkingly.
    expect(prompt).not.toContain("'back — [what you were just working on]'");
  });

  it('defers the messaging decision to the agent and names silence as the default', async () => {
    stageHandoffRestart();
    const prompt = await bootPrompt();

    expect(prompt).toContain('your judgment');
    expect(prompt).toContain('the default is silence');
  });

  it('still suppresses the cold-boot greeting on a handoff restart', async () => {
    stageHandoffRestart();
    const prompt = await bootPrompt();

    // The one send the daemon CAN correctly rule out: a continuation is not a
    // cold boot, so the cold-boot greeting is wrong regardless of conditions.
    expect(prompt).toContain('Booting up... one moment');
    expect(prompt).toContain('skip AGENTS.md step 1');
    // ...and the cold-boot online instruction must not ride along with it.
    expect(prompt).not.toContain('saying you are back online');
  });

  // Control arm for the assertion above. If this fails, the harness cannot
  // produce that string at all and the absence check proves nothing.
  it('still instructs a plain cold boot to announce it is back online', async () => {
    stageColdBoot();
    const prompt = await bootPrompt();

    expect(prompt).toContain('saying you are back online');
    // A cold boot is not a handoff and must not carry the handoff note.
    expect(prompt).not.toContain('HANDOFF UX');
  });

  it('omits the handoff note entirely when the agent has no Telegram configured', async () => {
    stageHandoffRestart();
    const prompt = await bootPrompt({ telegram: false });

    // Anchor: the handoff itself still happened...
    expect(prompt).toContain('CONTEXT HANDOFF');
    // ...but a messaging note is pointless without a channel to message on.
    expect(prompt).not.toContain('HANDOFF UX');
  });
});
