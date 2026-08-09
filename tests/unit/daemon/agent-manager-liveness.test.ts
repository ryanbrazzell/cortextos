import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// liveness fix: mirror the mock harness of agent-manager-inspect-op.test.ts so
// AgentManager can be constructed without spawning anything real. These tests
// exercise the true-liveness distinction: presence in the agents Map is NOT
// proof of life. We control what getStatus() reports for injected fakes and
// spy on process.kill to simulate OS-level pid liveness (NEVER a real pid).
vi.mock('../../../src/daemon/agent-process.js', () => ({
  AgentProcess: class {
    name: string;
    dir: string;
    constructor(name: string, dir: string) { this.name = name; this.dir = dir; }
    async start() { /* no-op */ }
    async stop() { /* no-op */ }
    getStatus() { return { name: this.name, status: 'stopped' }; }
    onExit() { /* no-op */ }
  },
}));
vi.mock('../../../src/daemon/fast-checker.js', () => ({
  FastChecker: class { start() {} stop() {} wake() {} },
}));
vi.mock('../../../src/telegram/api.js', () => ({ TelegramAPI: class { constructor() {} } }));
vi.mock('../../../src/telegram/poller.js', () => ({ TelegramPoller: class { start() {} stop() {} } }));

const { AgentManager } = await import('../../../src/daemon/agent-manager.js');

type AgentsMap = Map<string, unknown>;
const agentsOf = (am: unknown) => (am as { agents: AgentsMap }).agents;
const pendingOf = (am: unknown) => (am as { pendingRestarts: Set<string> }).pendingRestarts;

// pids used only inside the process.kill spy — never signalled for real.
const LIVE_PID = 1234;
const DEAD_PID = 4321;

function spyKill() {
  return vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (pid === DEAD_PID) {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    return true;
  }) as typeof process.kill);
}

describe('AgentManager liveness — inspectAgentOp(start) distinguishes map-membership from real liveness', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof spyKill>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-liveness-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = spyKill();
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('mapped-but-halted entry: start proceeds (ok true, NOT DEDUPED)', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'halted' }) } });
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(true);
  });

  it('mapped-but-stopped entry: start proceeds (ok true)', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'stopped' }) } });
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(true);
  });

  it('running entry with a DEAD pid: start proceeds (ok true)', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'running', pid: DEAD_PID }) } });
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(true);
  });

  it('genuinely-running entry with a LIVE pid: DEDUPED (preservation guard)', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'running', pid: LIVE_PID }) } });
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('DEDUPED');
      expect(r.message).toContain('alice');
    }
  });

  it("'starting' in-flight entry with no pid: DEDUPED (guards BUG-011 special-case)", () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'starting' }) } });
    const r = am.inspectAgentOp('start', 'alice');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('DEDUPED');
  });

  it('inspectAgentOp(start) does not mutate the agents map', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'halted' }) } });
    const before = agentsOf(am).size;
    am.inspectAgentOp('start', 'alice');
    expect(agentsOf(am).size).toBe(before);
  });
});

describe('AgentManager liveness — startAgent evicts a dead entry but preserves a live one', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof spyKill>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-liveness-start-test-'));
    // Deliberately do NOT create orgs/acme/agents/alice — startAgent will evict
    // the stale entry, then bail at the "Agent directory not found" early return
    // (agentDir passed empty). This exercises eviction without the spawn tail.
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = spyKill();
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('dead entry (halted): evicts — stop called, unmapped, not queued', async () => {
    const processStop = vi.fn(async () => {});
    const checkerStop = vi.fn();
    const stale = {
      process: { getStatus: () => ({ name: 'alice', status: 'halted' }), stop: processStop },
      checker: { stop: checkerStop },
    };
    agentsOf(am).set('alice', stale);

    await am.startAgent('alice', '');

    expect(processStop).toHaveBeenCalled();
    expect(checkerStop).toHaveBeenCalled();
    expect(pendingOf(am).has('alice')).toBe(false);
    expect(agentsOf(am).has('alice')).toBe(false);
  });

  it('genuinely-alive entry (running, live pid): preserved — queued, not stopped', async () => {
    const processStop = vi.fn(async () => {});
    const checkerStop = vi.fn();
    const alive = {
      process: { getStatus: () => ({ name: 'alice', status: 'running', pid: LIVE_PID }), stop: processStop },
      checker: { stop: checkerStop },
    };
    agentsOf(am).set('alice', alive);

    await am.startAgent('alice', '');

    expect(pendingOf(am).has('alice')).toBe(true);
    expect(processStop).not.toHaveBeenCalled();
    expect(agentsOf(am).has('alice')).toBe(true);
  });

  it('concurrent starts on a dead entry evict once (evictingAgents guard, no double-spawn)', async () => {
    // Deterministic race: stop() is deferred so the first startAgent parks
    // mid-eviction (marker held) while the second must hit the guard and return.
    // Without the guard both callers fall through and stop() is called twice.
    let resolveStop!: () => void;
    const stopPromise = new Promise<void>((r) => { resolveStop = r; });
    const stopSpy = vi.fn(() => stopPromise);
    const dead = {
      process: { getStatus: () => ({ name: 'alice', status: 'halted' }), stop: stopSpy },
      checker: { stop: vi.fn() },
    };
    agentsOf(am).set('alice', dead);

    const p1 = am.startAgent('alice', '');   // enters eviction, parks on stopSpy
    const p2 = am.startAgent('alice', '');    // must hit the guard and return
    await p2;

    expect(stopSpy).toHaveBeenCalledTimes(1);            // discriminates: 2 without guard
    expect((am as unknown as { evictingAgents: Set<string> }).evictingAgents.has('alice')).toBe(true);

    resolveStop();
    await p1;

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect((am as unknown as { evictingAgents: Set<string> }).evictingAgents.has('alice')).toBe(false);
  });
});

describe('AgentManager liveness — getAllStatuses corrects a running-but-dead entry', () => {
  let testDir: string;
  let am: InstanceType<typeof AgentManager>;
  let killSpy: ReturnType<typeof spyKill>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-liveness-status-test-'));
    mkdirSync(join(testDir, 'framework'), { recursive: true });
    am = new AgentManager('test-instance', join(testDir, 'instance'), join(testDir, 'framework'), 'acme');
    killSpy = spyKill();
  });

  afterEach(() => {
    killSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('running entry with a dead pid is reported as stopped', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'running', pid: DEAD_PID }) } });
    const statuses = am.getAllStatuses();
    expect(statuses[0].status).toBe('stopped');
  });

  it('running entry with a live pid stays running', () => {
    agentsOf(am).set('alice', { process: { getStatus: () => ({ name: 'alice', status: 'running', pid: LIVE_PID }) } });
    const statuses = am.getAllStatuses();
    expect(statuses[0].status).toBe('running');
  });
});
