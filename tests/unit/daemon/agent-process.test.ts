import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the PTY exit handler so tests can simulate exits at controlled times
let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(12345),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockPty; },
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
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
  // Mocked so consumeHandoffBlock's marker unlink does not fall through to real fs.
  // Unmocked it throws ENOENT on the fake /tmp/test-ctx paths, which consumeHandoffBlock
  // swallows — silently emptying the handoff block and making every handoff-branch
  // assertion below vacuously pass.
  unlinkSync: vi.fn(),
  // Defaults to [] so shouldContinue()'s JSONL probe reports "no history" (the prior
  // behavior when this went to real fs on nonexistent /tmp paths). The --continue test
  // overrides it to select continue mode.
  readdirSync: vi.fn(() => [] as string[]),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  // Getter-based exposure of the fsMocks vi.fn()s. Two consumer patterns
  // need to coexist on this file:
  //   (1) `fsMocks.X.mockReset()` — used by the BUG-040 / restarts.log
  //       tests added by this patch
  //   (2) `vi.mocked(fs.X).mockImplementation(...)` — used by the
  //       verifyCronsAfterIdle tests + BUG-048 reschedule tests
  // For (2) to work, `fs.X` MUST resolve to the same vi.fn() instance as
  // `fsMocks.X`. Naive direct reference (`existsSync: fsMocks.existsSync`)
  // breaks because vi.mock factories are hoisted + executed BEFORE the
  // `const fsMocks = {...}` initializer — so the lookup captures
  // `undefined`. Arrow wrappers (`(...args) => fsMocks.X(...args)`) keep
  // (1) working but break (2) because `fs.X` is no longer a vi.fn — it's
  // a plain arrow function, and `vi.mocked()` does not recognize it as
  // mockable. Getters thread the needle: the lookup is deferred until
  // call time (after fsMocks is initialized), and the value returned IS
  // the underlying vi.fn so `vi.mocked()` recognizes it.
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get unlinkSync() { return fsMocks.unlinkSync; },
    get readdirSync() { return fsMocks.readdirSync; },
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

beforeEach(() => {
  capturedOnExit = null;
  mockPty.spawn.mockClear();
  mockPty.kill.mockClear();
  mockPty.write.mockClear();
  mockPty.isAlive.mockClear();
  mockPty.isAlive.mockReturnValue(true);
  mockPty.onExit.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess - BUG-011 fix (stop awaits PTY exit)', () => {
  it('stop() awaits the PTY exit handler before resolving', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(capturedOnExit).not.toBeNull();
    expect(ap.getStatus().status).toBe('running');

    let stopResolved = false;
    const stopPromise = ap.stop().then(() => { stopResolved = true; });

    // Give stop() a moment to enter its kill phase. The 4s of internal sleeps
    // (1s after Ctrl-C + 3s after /exit) plus the awaitExit will keep stop()
    // in flight. After 100ms, it should NOT have resolved.
    await new Promise(r => setTimeout(r, 100));
    expect(stopResolved).toBe(false);

    // Now simulate the PTY exit firing
    capturedOnExit!(0, 0);

    // After the exit fires, stop() should be able to resolve
    // (after its internal sleeps finish — wait long enough)
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('stop() does NOT trigger crash recovery on intentional stop (the BUG-011 regression)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Stop and have the exit fire DURING the await window
    const stopPromise = ap.stop();
    await new Promise(r => setTimeout(r, 100));
    capturedOnExit!(0, 0);
    await stopPromise;

    // The agent should be 'stopped', NOT 'crashed'.
    // Before the fix, the exit handler could fire after stopping=false and
    // call into the crash recovery branch, leaving status='crashed'.
    expect(ap.getStatus().status).toBe('stopped');
  }, 10000);

  it('handleExit DOES trigger crash recovery on UNINTENTIONAL exit (regression check)', async () => {
    // Make sure we didn't accidentally break the real crash recovery path
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire the exit handler WITHOUT calling stop() first — simulates a real crash
    capturedOnExit!(1, 0);

    // The agent should be in 'crashed' state (crash recovery scheduled)
    expect(ap.getStatus().status).toBe('crashed');
  });

  it('unexpected PTY exit persists a CRASH line to restarts.log', async () => {
    // Default fs mocks: no .daemon-stop marker, no .crash_count_today file.
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // Fire exit handler WITHOUT calling stop() first — simulates a real crash.
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    // restarts.log must have received a CRASH entry with the exit code and
    // crash counter. Before the fix, daemon-classified crashes only wrote
    // to stdout and left restarts.log empty.
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    const [logPath, logLine] = fsMocks.appendFileSync.mock.calls[0];
    expect(String(logPath)).toContain('/logs/alice/restarts.log');
    expect(String(logLine)).toMatch(/\] CRASH: exit_code=1 crash_count=1 backoff_s=5\b/);
    expect(String(logLine).endsWith('\n')).toBe(true);
  });

  it('PTY exit during daemon shutdown is NOT classified as a crash', async () => {
    // Simulate agent-manager.ts:stopAll() having written a fresh .daemon-stop
    // marker moments ago. handleExit should recognize the shutdown-in-progress
    // signal and bail out before touching the crash counter or restarts.log.
    fsMocks.existsSync.mockImplementation((p: any) => {
      const path = String(p);
      return path.endsWith('/state/alice/.daemon-stop');
    });
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 2_000 }));

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    expect(ap.getStatus().status).toBe('running');

    // PM2 SIGTERM propagated to the PTY's Claude Code child: it exits
    // cleanly with code 0 before its own stopAgent() call has a chance to
    // set stopRequested. Before the fix, this produced a phantom crash
    // and incremented .crash_count_today.
    capturedOnExit!(0, 0);

    // Agent state is 'running' still — handleExit returned early without
    // toggling status. No crash write, no log append, no restart scheduled.
    expect(ap.getStatus().status).toBe('running');
    expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('.crash_count_today'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('stale .daemon-stop marker (>60s old) does NOT mask a real crash', async () => {
    // Regression guard: if a prior shutdown failed to clean up its marker,
    // we do NOT want it to silently swallow genuine crashes hours later.
    // The 60s window in isDaemonShuttingDown() is the load-bearing check.
    fsMocks.existsSync.mockImplementation((p: any) =>
      String(p).endsWith('/state/alice/.daemon-stop'),
    );
    fsMocks.statSync.mockImplementation((p: any) => ({ mtimeMs: Date.now() - 3_600_000 })); // 1h old

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();
    capturedOnExit!(1, 0);

    expect(ap.getStatus().status).toBe('crashed');
    expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1);
    expect(String(fsMocks.appendFileSync.mock.calls[0][1])).toMatch(/\] CRASH: /);
  });

  it('sessionRefresh() delegates to stop() then start() (in order)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    // Spy on stop and start so we can verify the delegation
    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(ap, 'start').mockResolvedValue();

    await ap.sessionRefresh();

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    // Verify call order: stop must complete before start
    const stopOrder = stopSpy.mock.invocationCallOrder[0];
    const startOrder = startSpy.mock.invocationCallOrder[0];
    expect(stopOrder).toBeLessThan(startOrder);
  });

  it('sessionRefresh() writes .session-refresh marker before stop (false-crash FP fix)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const stopSpy = vi.spyOn(ap, 'stop').mockResolvedValue();
    vi.spyOn(ap, 'start').mockResolvedValue();
    fsMocks.writeFileSync.mockReset();

    await ap.sessionRefresh();

    const writeIdx = fsMocks.writeFileSync.mock.calls.findIndex(
      (call) => String(call[0]).endsWith('.session-refresh'),
    );
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(String(fsMocks.writeFileSync.mock.calls[writeIdx][0])).toBe('/tmp/test-ctx/state/alice/.session-refresh');
    // The marker must be written BEFORE stop() — a SessionEnd hook firing as
    // the PTY dies must already see the marker, or it classifies a false crash.
    const markerWriteOrder = fsMocks.writeFileSync.mock.invocationCallOrder[writeIdx];
    expect(markerWriteOrder).toBeLessThan(stopSpy.mock.invocationCallOrder[0]);
  });
});

describe('AgentProcess - BUG-048 fix (session timer re-reads config)', () => {
  it('fires sessionRefresh when config on disk still matches original short duration', async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('reschedules when config.json on disk has a longer max_session_seconds', async () => {
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);

    // Config on disk says 1 hour — much longer than initial 1s
    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3600 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 1 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      await ap.start();
      // Advance past the initial 1s timer — should reschedule, not fire refresh
      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    // sessionRefresh must NOT have been called — config said 1h, not 1s
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not loop when max_session_seconds overflows int32 setTimeout (regression)', async () => {
    // Without the clamp, max_session_seconds: 3600000 (1000h = 3.6T ms) would
    // exceed Node's int32 setTimeout max (~2.147B ms), get coerced to 1ms,
    // fire immediately, re-read the same overflow value, reschedule, and loop
    // tightly — locking the daemon. Clamp at the call site prevents this.
    const fs = await import('fs');
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockReadFileSync = vi.mocked(fs.readFileSync);

    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const logSpy = vi.fn();

    mockExistsSync.mockImplementation((p: unknown) =>
      typeof p === 'string' && p.endsWith('config.json'),
    );
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('config.json')) {
        return JSON.stringify({ max_session_seconds: 3_600_000 });
      }
      return '';
    });

    vi.useFakeTimers();
    try {
      const ap = new AgentProcess('alice', mockEnv, { max_session_seconds: 3_600_000 });
      vi.spyOn(ap, 'sessionRefresh').mockImplementation(refreshSpy);
      vi.spyOn(ap as unknown as { log: (m: string) => void }, 'log').mockImplementation(logSpy);
      await ap.start();
      // Advance past the int32 setTimeout cap. Without clamp this would log
      // thousands of "rescheduling" lines as the 1ms-coerced timer keeps firing.
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReset();
    }

    const rescheduleCount = logSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('rescheduling'),
    ).length;
    expect(rescheduleCount).toBeLessThan(5);
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('AgentProcess — CrashLoopPauser (instar-inspired sliding window)', () => {
  it('triggers CRASH_LOOP halt when crash_window fills', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      crash_window: { seconds: 60, max_crashes: 3 },
    });
    await ap.start();

    // Fire 3 crashes in rapid succession (well within the 60s window).
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // first crash — normal recovery

    // Reset mocks and simulate the restart + second crash
    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    expect(ap.getStatus().status).toBe('crashed'); // second crash — still normal

    mockPty.spawn.mockClear();
    mockPty.onExit.mockClear();
    capturedOnExit = null;
    await ap.start();
    capturedOnExit!(1, 0);
    // Third crash in window → CRASH_LOOP → halted
    expect(ap.getStatus().status).toBe('halted');
  });

  it('does not trigger CRASH_LOOP when no crash_window is configured (backward compat)', async () => {
    const ap = new AgentProcess('alice', mockEnv, {
      max_crashes_per_day: 5,
    });
    await ap.start();

    // 3 crashes — without crash_window, these are just normal crash recovery
    for (let i = 0; i < 3; i++) {
      capturedOnExit!(1, 0);
      if (ap.getStatus().status !== 'halted') {
        mockPty.spawn.mockClear();
        mockPty.onExit.mockClear();
        capturedOnExit = null;
        await ap.start();
      }
    }
    // Should be 'crashed' (recovering), NOT 'halted', because daily max is 5
    expect(ap.getStatus().status).not.toBe('halted');
  });
});

describe('AgentProcess - onboarding marker (do not auto-write .onboarded on heartbeat)', () => {
  // Regression: buildStartupPrompt used to auto-write the .onboarded marker
  // whenever a heartbeat.json existed, on the assumption the agent had
  // onboarded and just forgot the marker. That silently suppressed FIRST BOOT
  // for agents that were manually scaffolded (heartbeat present) but never
  // actually ran onboarding. The marker must be explicit: a heartbeat alone
  // must NOT mark an agent onboarded. This is general daemon behavior (it was
  // surfaced via a manually-scaffolded opencode agent, but applies to any
  // runtime).
  it('does not auto-mark a heartbeat-only agent as onboarded (still routes to FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return false;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('FIRST BOOT');
    expect(prompt).toContain('read ONBOARDING.md and complete the onboarding protocol');
    // The buggy auto-write must be gone: no .onboarded written from heartbeat presence.
    expect(fsMocks.writeFileSync).not.toHaveBeenCalledWith(
      expect.stringContaining('/.onboarded'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('respects an existing .onboarded marker (suppresses FIRST BOOT)', async () => {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/heartbeat.json')) return true;
      if (path.endsWith('/ONBOARDING.md')) return true;
      return false;
    });

    const ap = new AgentProcess('alice', mockEnv, {});
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).not.toContain('FIRST BOOT');
    expect(prompt).not.toContain('complete the onboarding protocol');
  });
});

describe('AgentProcess — boot announce gated on restart reason (.restart-planned)', () => {
  // 332 restarts over 11 days on the reference host were ALL planned and ZERO were
  // crashes, so the ungated announce was ~100% false-positive by volume.
  //
  // There are TWO mutually-exclusive announce branches in buildStartupPrompt, and the
  // handoff one carries ~96% of real traffic (318/332 restarts are context handoffs).
  // Gating only `onlineMessage` covers the 4% while looking like a fix, so each branch
  // is asserted separately below.
  const HANDOFF_DOC = '/tmp/handoff.md';
  const SEND_MANDATE = 'VERY FIRST tool call';
  const STEP_ONE_SUPPRESSION = 'Do NOT send "Booting up... one moment"';
  const COLD_BOOT_ANNOUNCE = 'saying you are back online';

  /** @param plannedAgeMs age of .restart-planned, or null for "no marker at all" */
  function setupFs(opts: { handoff: boolean; plannedAgeMs: number | null }) {
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.force-fresh')) return false;
      if (path.endsWith('/.onboarded')) return true;
      if (path.endsWith('/.handoff-doc-path')) return opts.handoff;
      if (path.endsWith('/.restart-planned')) return opts.plannedAgeMs !== null;
      if (path === HANDOFF_DOC) return true;
      return false;
    });
    fsMocks.readFileSync.mockImplementation((path: string) =>
      path.endsWith('/.handoff-doc-path') ? HANDOFF_DOC : '',
    );
    fsMocks.statSync.mockImplementation(() => ({
      mtimeMs: Date.now() - (opts.plannedAgeMs ?? 0),
    }));
  }

  // Every negative assertion below is `not.toContain`, which passes trivially on ''.
  // `spawn.mock.calls[0]?.[1] ?? ''` yields '' whenever spawn did not happen, so a
  // broken setup would make the suppression tests pass for the wrong reason. Assert the
  // prompt was really built and carries a stable sentinel before returning it.
  function assertRealPrompt(prompt: string) {
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('You are starting a new session');
    return prompt;
  }

  async function promptFor(opts: { handoff: boolean; plannedAgeMs: number | null }) {
    setupFs(opts);
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle({} as never, '12345');
    await ap.start();
    return assertRealPrompt(mockPty.spawn.mock.calls[0]?.[1] ?? '');
  }

  it('handoff + planned restart: suppresses the ping but KEEPS the step-1 suppression', async () => {
    const prompt = await promptFor({ handoff: true, plannedAgeMs: 1_000 });

    // Control arm: prove we are on the handoff branch at all, so the negative
    // assertion below cannot pass merely because the block is missing entirely.
    expect(prompt).toContain('HANDOFF UX');
    expect(prompt).toContain('memory is intact via the handoff doc');

    expect(prompt).not.toContain(SEND_MANDATE);
    expect(prompt).not.toContain('send-telegram');

    // THE REGRESSION GUARD. Gating the whole block off drops this clause, and
    // AGENTS.md:26 / CLAUDE.md:22 then unconditionally tell the fresh session to send
    // 'Booting up... one moment' — trading the ping for a worse, cold-boot one.
    expect(prompt).toContain(STEP_ONE_SUPPRESSION);
  });

  it('handoff + UNplanned restart: still sends the pickup ping', async () => {
    const prompt = await promptFor({ handoff: true, plannedAgeMs: null });
    expect(prompt).toContain(SEND_MANDATE);
    expect(prompt).toContain('send-telegram');
    expect(prompt).toContain(STEP_ONE_SUPPRESSION);
  });

  it('handoff + STALE marker: treats it as unplanned and announces (TTL backstop)', async () => {
    // A start that dies before its first heartbeat never runs clearEndMarkers, so the
    // marker outlives its restart. Without the TTL it would suppress the announce for
    // every later restart, including a genuine crash.
    const prompt = await promptFor({ handoff: true, plannedAgeMs: 300_001 });
    expect(prompt).toContain(SEND_MANDATE);
  });

  it('cold boot + planned restart: no "back online" announce', async () => {
    const prompt = await promptFor({ handoff: false, plannedAgeMs: 1_000 });
    expect(prompt).not.toContain(COLD_BOOT_ANNOUNCE);
    expect(prompt).not.toContain('HANDOFF UX');
  });

  it('cold boot + UNplanned restart: announces (a real crash must still be heard)', async () => {
    const prompt = await promptFor({ handoff: false, plannedAgeMs: null });
    expect(prompt).toContain(COLD_BOOT_ANNOUNCE);
  });

  it('fails OPEN toward announcing when the marker mtime is unreadable', async () => {
    setupFs({ handoff: false, plannedAgeMs: 1_000 });
    fsMocks.statSync.mockImplementation(() => { throw new Error('EIO'); });
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle({} as never, '12345');
    await ap.start();
    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain(COLD_BOOT_ANNOUNCE);
  });

  it('a CRASH following a planned restart still announces (marker is stale-but-fresh)', async () => {
    // The hole marker-only logic would leave open: clearEndMarkers needs a heartbeat
    // past its 120s grace to remove .restart-planned, so a session that dies before
    // then leaves a marker that still passes the TTL. Marker alone => a genuine crash
    // reads as planned and stays silent, for up to 5 minutes after EVERY restart.
    setupFs({ handoff: false, plannedAgeMs: 1_000 });
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle({} as never, '12345');
    await ap.start();

    // Control arm: the planned restart itself is correctly silent.
    expect(mockPty.spawn.mock.calls[0]?.[1] ?? '').not.toContain(COLD_BOOT_ANNOUNCE);

    // Now crash it — unintentional exit, no stop() requested.
    mockPty.spawn.mockClear();
    capturedOnExit?.(1);
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain(COLD_BOOT_ANNOUNCE);
  });

  it('does not announce at all when Telegram is not wired up', async () => {
    setupFs({ handoff: false, plannedAgeMs: null });
    const ap = new AgentProcess('alice', mockEnv, {}); // no setTelegramHandle
    await ap.start();
    const prompt = assertRealPrompt(mockPty.spawn.mock.calls[0]?.[1] ?? '');
    expect(prompt).not.toContain(COLD_BOOT_ANNOUNCE);
  });

  it('a future-stamped marker does NOT suppress (negative age is rejected)', async () => {
    // `ageMs <= TTL` alone accepts every negative age, so a marker stamped in the future
    // — clock correction, restored fs metadata, volume skew — would suppress announces
    // until wall time caught up.
    const prompt = await promptFor({ handoff: false, plannedAgeMs: -3_600_000 });
    expect(prompt).toContain(COLD_BOOT_ANNOUNCE);
  });

  it('suppresses exactly AT the TTL boundary and announces just past it', async () => {
    expect(await promptFor({ handoff: false, plannedAgeMs: 300_000 }))
      .not.toContain(COLD_BOOT_ANNOUNCE);
    mockPty.spawn.mockClear();
    expect(await promptFor({ handoff: false, plannedAgeMs: 300_001 }))
      .toContain(COLD_BOOT_ANNOUNCE);
  });

  it('--continue refresh is gated on the same seam', async () => {
    // buildContinuePrompt is a separate production behavior change and needs its own
    // coverage, not inheritance from the startup-path tests.
    setupFs({ handoff: false, plannedAgeMs: 1_000 });
    fsMocks.existsSync.mockImplementation((path: string) => {
      if (path.endsWith('/.restart-planned')) return true;
      if (path.endsWith('/.onboarded')) return true;
      return false;
    });
    const ap = new AgentProcess('alice', mockEnv, {});
    ap.setTelegramHandle({} as never, '12345');
    // Select continue mode directly. shouldContinue() probes the Claude projects dir via
    // `require('fs').readdirSync`, which the ESM `vi.mock('fs')` above does not intercept,
    // so the marker-based setup cannot reach this branch. Stubbing the branch SELECTOR is
    // safe here — the gate under test (shouldAnnounceOnBoot) is untouched and still runs
    // for real against the .restart-planned marker set above.
    vi.spyOn(ap as never, 'shouldContinue').mockReturnValue(true as never);
    await ap.start();

    const prompt = mockPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(mockPty.spawn).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('SESSION CONTINUATION');
    expect(prompt).not.toContain(COLD_BOOT_ANNOUNCE);
  });
});
