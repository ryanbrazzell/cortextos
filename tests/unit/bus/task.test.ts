import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Lets ONE test force an id collision (see the round-4 block at the end of
// this file). Defaults to the real implementation, so every other test in
// here keeps its normal unique ids — a blanket mock would make them collide
// with each other, which is the opposite of what we want.
const forced = vi.hoisted(() => ({ digits: null as string | null }));
vi.mock('../../../src/utils/random', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/utils/random')>();
  return { ...actual, randomDigits: (n: number) => forced.digits ?? actual.randomDigits(n) };
});
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, completeTask, claimTask, readTaskAudit, checkTaskDependencies, compactTasks, listTasks, findTaskFile, archiveTasks } from '../../../src/bus/task';
import type { BusPaths } from '../../../src/types';

describe('Task Management', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-task-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'paul'),
      inflight: join(testDir, 'inflight', 'paul'),
      processed: join(testDir, 'processed', 'paul'),
      logDir: join(testDir, 'logs', 'paul'),
      stateDir: join(testDir, 'state', 'paul'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('path-traversal hardening (#13/#14)', () => {
    it('findTaskFile rejects a traversal task id', () => {
      expect(() => findTaskFile(paths, '../../etc/passwd')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task/../../secrets')).toThrow(/Invalid task id/);
      expect(() => findTaskFile(paths, 'task_1.json')).toThrow(/Invalid task id/);
    });

    it('readTaskAudit rejects a traversal task id', () => {
      expect(() => readTaskAudit(paths, '../../../etc/shadow')).toThrow(/Invalid task id/);
    });

    it('findTaskFile still resolves a legitimate task', () => {
      const id = createTask(paths, 'paul', 'acme', 'T', { assignee: 'boris' });
      expect(findTaskFile(paths, id)).toContain(`${id}.json`);
    });

    it('archiveTasks skips a task whose JSON id is tampered with traversal (no escape)', () => {
      mkdirSync(paths.taskDir, { recursive: true });
      // Safe filename, but the internal id carries traversal that would resolve
      // to testDir/escaped.json (outside the task tree) on archive write/rename.
      writeFileSync(join(paths.taskDir, 'task_evil_1.json'), JSON.stringify({
        id: '../escaped', status: 'completed', completed_at: '2020-01-01T00:00:00Z',
        assigned_to: 'boris', org: 'acme',
      }));
      expect(() => archiveTasks(paths)).not.toThrow();
      // The guard must have prevented the out-of-tree write.
      expect(existsSync(join(testDir, 'escaped.json'))).toBe(false);
    });
  });

  describe('createTask', () => {
    it('creates task with correct JSON format', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Build landing page', {
        description: 'Create a product landing page',
        assignee: 'boris',
        priority: 'high',
      });

      expect(taskId).toMatch(/^task_\d+_\d{8}$/);

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));

      // Verify all 17 fields match bash create-task.sh format
      expect(content.id).toBe(taskId);
      expect(content.title).toBe('Build landing page');
      expect(content.description).toBe('Create a product landing page');
      expect(content.type).toBe('agent');
      expect(content.needs_approval).toBe(false);
      expect(content.status).toBe('pending');
      expect(content.assigned_to).toBe('boris');
      expect(content.created_by).toBe('paul');
      expect(content.org).toBe('acme');
      expect(content.priority).toBe('high');
      // 'backlog', not '': an omitted project now defaults to the backlog
      // rather than leaving the task untagged and invisible to every
      // project-scoped query.
      expect(content.project).toBe('backlog');
      expect(content.kpi_key).toBeNull();
      expect(content.created_at).toBeTruthy();
      expect(content.updated_at).toBeTruthy();
      expect(content.completed_at).toBeNull();
      expect(content.due_date).toBeNull();
      expect(content.archived).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('updates task status', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      updateTask(paths, taskId, 'in_progress');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('in_progress');
    });
  });

  describe('completeTask', () => {
    it('sets status to completed and completed_at', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Test task');
      completeTask(paths, taskId, 'Landing page done, committed at abc123');

      const content = JSON.parse(readFileSync(join(paths.taskDir, `${taskId}.json`), 'utf-8'));
      expect(content.status).toBe('completed');
      expect(content.completed_at).toBeTruthy();
      expect(content.result).toBe('Landing page done, committed at abc123');
    });

    it('emits a task/task_completed activity event for the assignee', () => {
      const taskId = createTask(paths, 'paul', 'acme', 'Complete-event task', {
        assignee: 'boris',
      });
      completeTask(paths, taskId, 'shipped');

      // Event file: <analyticsDir>/events/boris/<YYYY-MM-DD>.jsonl
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'boris', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);

      const events = readFileSync(eventFile, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const completedEvents = events.filter((e) => e.event === 'task_completed');
      expect(completedEvents).toHaveLength(1);
      const evt = completedEvents[0];
      expect(evt.agent).toBe('boris');
      expect(evt.org).toBe('acme');
      expect(evt.category).toBe('task');
      expect(evt.severity).toBe('info');
      expect(evt.metadata.task_id).toBe(taskId);
      expect(evt.metadata.result).toBe('shipped');
    });
  });

  describe('listTasks', () => {
    it('returns all non-archived tasks', () => {
      createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');

      const tasks = listTasks(paths);
      expect(tasks.length).toBe(2);
    });

    it('filters by agent', () => {
      createTask(paths, 'paul', 'acme', 'For boris', { assignee: 'boris' });
      createTask(paths, 'paul', 'acme', 'For paul', { assignee: 'paul' });

      const borisTasks = listTasks(paths, { agent: 'boris' });
      expect(borisTasks.length).toBe(1);
      expect(borisTasks[0].title).toBe('For boris');
    });

    it('filters by status', () => {
      const id1 = createTask(paths, 'paul', 'acme', 'Task 1');
      createTask(paths, 'paul', 'acme', 'Task 2');
      updateTask(paths, id1, 'completed');

      const pending = listTasks(paths, { status: 'pending' });
      expect(pending.length).toBe(1);
    });
  });
});

/**
 * Cross-org task lifecycle — exercises the findTaskFile fallback so an
 * assignee in one org can drive the lifecycle of a task filed by an
 * orchestrator in a sibling org. Standard cortextOS dispatch pattern:
 * an orchestrator in one org files a task, a specialist in another org
 * needs to update and complete it from their own agent session.
 *
 * These tests build a REAL nested filesystem layout (matching the
 * production shape at ~/.cortextos/<instance>/orgs/<org>/tasks/) so they
 * cover the actual cross-org path resolution, not a mocked shortcut.
 */
describe('Cross-org task lifecycle', () => {
  let testDir: string;
  let orgAPaths: BusPaths;
  let orgBTaskDir: string;
  let warnLog: string[];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-crossorg-test-'));
    // Nested layout: <ctxRoot>/orgs/{OrgA,OrgB}/tasks/
    mkdirSync(join(testDir, 'orgs', 'OrgA', 'tasks'), { recursive: true });
    mkdirSync(join(testDir, 'orgs', 'OrgB', 'tasks'), { recursive: true });

    orgAPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'agentA'),
      inflight: join(testDir, 'inflight', 'agentA'),
      processed: join(testDir, 'processed', 'agentA'),
      logDir: join(testDir, 'logs', 'agentA'),
      stateDir: join(testDir, 'state', 'agentA'),
      taskDir: join(testDir, 'orgs', 'OrgA', 'tasks'),
      approvalDir: join(testDir, 'orgs', 'OrgA', 'approvals'),
      analyticsDir: join(testDir, 'orgs', 'OrgA', 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    orgBTaskDir = join(testDir, 'orgs', 'OrgB', 'tasks');

    warnLog = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnLog.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
    rmSync(testDir, { recursive: true, force: true });
  });

  /** Helper: drop a raw task JSON file into OrgB's tasks dir without
   * going through createTask (which only knows about OrgA's taskDir). */
  function writeOrgBTask(taskId: string, overrides: Record<string, unknown> = {}): void {
    const task = {
      id: taskId,
      title: 'Cross-org task',
      description: '',
      type: 'agent',
      needs_approval: false,
      status: 'pending',
      assigned_to: 'agentA',
      created_by: 'orchestrator',
      org: 'OrgB',
      priority: 'normal',
      project: '',
      kpi_key: null,
      created_at: '2026-04-11T20:00:00Z',
      updated_at: '2026-04-11T20:00:00Z',
      completed_at: null,
      due_date: null,
      archived: false,
      ...overrides,
    };
    writeFileSync(join(orgBTaskDir, `${taskId}.json`), JSON.stringify(task), 'utf-8');
  }

  it('updateTask same-org happy path: still works via the fast path', () => {
    // Regression guard for the existing single-org behavior. This is the
    // hot path and must not pay any cross-org scan cost when it hits.
    const taskId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    updateTask(orgAPaths, taskId, 'in_progress');

    const content = JSON.parse(
      readFileSync(join(orgAPaths.taskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(content.status).toBe('in_progress');
  });

  it('updateTask cross-org: finds task in sibling org via findTaskFile fallback', () => {
    // Repro: file a task in OrgB, try to update it from an OrgA-scoped
    // session. Before findTaskFile, this threw "Task not found" because
    // updateTask only looked at orgAPaths.taskDir.
    const taskId = 'task_test_001';
    writeOrgBTask(taskId);

    updateTask(orgAPaths, taskId, 'in_progress');

    // Verify the OrgB file got updated, NOT the (nonexistent) OrgA file.
    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('in_progress');
    // Explicit timestamp comparison: the seed updated_at is a fixed moment
    // in the past, so the real Date.now() that updateTask stamps MUST be
    // strictly greater. Avoids the brittle string-inequality form that
    // would silently pass on any future refactor that changed the seed.
    expect(new Date(orgBContent.updated_at).getTime()).toBeGreaterThan(
      new Date('2026-04-11T20:00:00Z').getTime(),
    );
    expect(existsSync(join(orgAPaths.taskDir, `${taskId}.json`))).toBe(false);
  });

  it('updateTask not found anywhere: throws with a clear error naming ctxRoot', () => {
    expect(() => updateTask(orgAPaths, 'task_999_000', 'in_progress')).toThrow(
      /not found in any org under .*\/orgs\//,
    );
  });

  it('completeTask cross-org: finds task in sibling org and marks it done', () => {
    const taskId = 'task_test_002';
    writeOrgBTask(taskId);

    completeTask(orgAPaths, taskId, 'cross-org completion');

    const orgBContent = JSON.parse(
      readFileSync(join(orgBTaskDir, `${taskId}.json`), 'utf-8'),
    );
    expect(orgBContent.status).toBe('completed');
    expect(orgBContent.completed_at).toBeTruthy();
    expect(orgBContent.result).toBe('cross-org completion');
  });

  it('findTaskFile ambiguity: same ID in two orgs triggers warn naming both orgs', () => {
    // Manually create the same task id in BOTH orgs. Real collisions
    // should be vanishingly rare (epoch_ms + 3 digits), but the warn path
    // must be tested so operators hitting it in production get actionable
    // information.
    const taskId = 'task_1_000';
    writeOrgBTask(taskId);
    // Write the same ID to OrgA via direct filesystem (bypassing
    // createTask so we can reuse the exact ID).
    const orgATaskPath = join(orgAPaths.taskDir, `${taskId}.json`);
    writeFileSync(
      orgATaskPath,
      JSON.stringify({
        id: taskId,
        title: 'OrgA collision',
        status: 'pending',
        org: 'OrgA',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    // findTaskFile should return the OrgA path (same-org fast path wins)
    // without ever emitting the ambiguity warning. The fast path only
    // checks same-org; the cross-org scan is ONLY exercised when same-org
    // misses. So the ambiguity warning path requires same-org to miss
    // AND multiple sibling orgs to hit.
    //
    // To exercise the warn, delete the OrgA copy and write collisions
    // into two OTHER orgs.
    rmSync(orgATaskPath);
    mkdirSync(join(testDir, 'orgs', 'OrgC', 'tasks'), { recursive: true });
    writeFileSync(
      join(testDir, 'orgs', 'OrgC', 'tasks', `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        title: 'OrgC collision',
        status: 'pending',
        org: 'OrgC',
        updated_at: '2026-04-11T20:00:00Z',
        created_at: '2026-04-11T20:00:00Z',
      }),
      'utf-8',
    );

    const result = findTaskFile(orgAPaths, taskId);
    expect(result).not.toBeNull();
    // Warn must have fired and must name BOTH the task id and the two orgs.
    expect(warnLog.length).toBeGreaterThanOrEqual(1);
    const warn = warnLog[0];
    expect(warn).toContain(taskId);
    expect(warn).toMatch(/found in 2 orgs/);
    expect(warn).toContain('OrgB');
    expect(warn).toContain('OrgC');
  });

  it('listTasks scoping regression: must remain single-org, NO cross-org leakage', () => {
    // CRITICAL regression guard. Scoping contract:
    // listTasks must remain single-org by default — cross-org listing
    // requires an explicit opt-in flag that does not exist yet. A future
    // well-meaning refactor that 'helpfully' makes listTasks cross-org by
    // default would silently break the dashboard, which depends on
    // per-org scoping for its sync loop. If this test fails, the refactor
    // broke the contract and must be reverted or gated behind an opt-in
    // flag.
    const sameOrgId = createTask(orgAPaths, 'agentA', 'OrgA', 'Same-org task');
    writeOrgBTask('task_other_1', { title: 'Sibling-org task 1' });
    writeOrgBTask('task_other_2', { title: 'Sibling-org task 2' });

    const tasks = listTasks(orgAPaths);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(sameOrgId);
    expect(tasks[0].title).toBe('Same-org task');
  });
});

describe('claimTask — atomic claim (beads-inspired)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-claim-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('happy path: claims a pending task, flips status + assignee, writes lock file', () => {
    const id = createTask(paths, 'alice', 'acme', 'Claimable work');
    const task = claimTask(paths, id, 'alice');
    expect(task.status).toBe('in_progress');
    expect(task.assigned_to).toBe('alice');

    // Persisted to disk
    const onDisk = JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
    expect(onDisk.status).toBe('in_progress');
    expect(onDisk.assigned_to).toBe('alice');

    // Lock file recorded the claimant + timestamp
    const lock = readFileSync(join(paths.taskDir, '.claims', `${id}.claim`), 'utf-8');
    expect(lock.split('\t')[0]).toBe('alice');
  });

  it('rejects second claim with a named owner when the lock already exists', () => {
    const id = createTask(paths, 'alice', 'acme', 'Race target');
    claimTask(paths, id, 'alice');
    expect(() => claimTask(paths, id, 'bob-agent')).toThrow(/already claimed by alice/);
  });

  it('is idempotent when the same agent re-claims (no throw, returns the task)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Re-claim');
    claimTask(paths, id, 'alice');
    const again = claimTask(paths, id, 'alice');
    expect(again.assigned_to).toBe('alice');
    expect(again.status).toBe('in_progress');
  });

  it('rejects claim on a non-pending task with a clear status message', () => {
    const id = createTask(paths, 'alice', 'acme', 'Already done');
    updateTask(paths, id, 'completed');
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not pending.*status=completed/);
  });

  it('throws "not found" for an unknown task id', () => {
    expect(() => claimTask(paths, 'task_nonexistent_000', 'alice')).toThrow(/not found in any org/);
  });

  it('rolls back the lock if the task-JSON write fails (so retry can still succeed)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Rollback probe');
    const claimPath = join(paths.taskDir, '.claims', `${id}.claim`);

    // Force atomicWriteSync to fail by deleting the task file mid-flight.
    // Simplest repro: remove the task json right after the lock is taken
    // by intercepting findTaskFile's call path — instead just delete the
    // task file before claimTask reads it, and reuse the existing
    // not-found path. Then confirm no stale .claim file is left behind.
    rmSync(join(paths.taskDir, `${id}.json`));
    expect(() => claimTask(paths, id, 'alice')).toThrow(/not found in any org/);
    expect(existsSync(claimPath)).toBe(false);
  });
});

describe('Task audit log (append-only JSONL)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  it('createTask writes one "create" audit entry', () => {
    const id = createTask(paths, 'alice', 'acme', 'First task', { description: 'd' });
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(1);
    expect(log[0].event).toBe('create');
    expect(log[0].agent).toBe('alice');
    expect(log[0].to).toBe('pending');
    expect(log[0].note).toBe('First task');
  });

  it('full lifecycle records create + claim + complete in order', () => {
    const id = createTask(paths, 'alice', 'acme', 'Lifecycle');
    claimTask(paths, id, 'alice');
    completeTask(paths, id, 'shipped');

    const log = readTaskAudit(paths, id);
    expect(log.map(e => e.event)).toEqual(['create', 'claim', 'complete']);
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('in_progress');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('in_progress');
    expect(log[2].to).toBe('completed');
    expect(log[2].note).toBe('shipped');
  });

  it('updateTask audit captures from->to transition with assignee as agent', () => {
    const id = createTask(paths, 'alice', 'acme', 'Updatable', { assignee: 'alice' });
    updateTask(paths, id, 'blocked');
    updateTask(paths, id, 'pending');

    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(3); // create + 2 updates
    expect(log[1].event).toBe('update');
    expect(log[1].from).toBe('pending');
    expect(log[1].to).toBe('blocked');
    expect(log[1].agent).toBe('alice');
    expect(log[2].from).toBe('blocked');
    expect(log[2].to).toBe('pending');
  });

  it('audit log is append-only — existing entries are never overwritten', () => {
    const id = createTask(paths, 'alice', 'acme', 'Append proof');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    const before = readFileSync(path, 'utf-8');
    updateTask(paths, id, 'blocked');
    const after = readFileSync(path, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('corrupt lines are skipped without blocking replay of surrounding entries', () => {
    const id = createTask(paths, 'alice', 'acme', 'Corrupt survivor');
    const path = join(paths.taskDir, 'audit', `${id}.jsonl`);
    // Inject a malformed line between two valid ones
    writeFileSync(path, readFileSync(path, 'utf-8') + 'not-json-at-all\n');
    updateTask(paths, id, 'in_progress');
    const log = readTaskAudit(paths, id);
    expect(log.length).toBe(2); // create + update, corrupt middle line skipped
    expect(log[0].event).toBe('create');
    expect(log[1].event).toBe('update');
  });

  it('readTaskAudit returns [] for a task with no history', () => {
    expect(readTaskAudit(paths, 'task_nonexistent_000')).toEqual([]);
  });
});

describe('Task dependency DAG (blocks / blocked_by)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-dag-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  function readTask(id: string) {
    return JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  }

  it('blocked_by stores the declared dependency + the peer gets a symmetric blocks edge', () => {
    const a = createTask(paths, 'alice', 'acme', 'A (blocker)');
    const b = createTask(paths, 'alice', 'acme', 'B (blocked)', { blockedBy: [a] });

    expect(readTask(b).blocked_by).toEqual([a]);
    expect(readTask(a).blocks).toEqual([b]);
  });

  it('blocks is the symmetric reverse of blocked_by', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blocks: [a] });

    // "B blocks A" means A is blocked_by B
    expect(readTask(a).blocked_by).toEqual([b]);
    expect(readTask(b).blocks).toEqual([a]);
  });

  it('checkTaskDependencies returns open blockers with their current status', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });

    let open = checkTaskDependencies(paths, blocked);
    expect(open.length).toBe(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');

    completeTask(paths, blocker, 'done');
    open = checkTaskDependencies(paths, blocked);
    expect(open).toEqual([]);
  });

  it('checkTaskDependencies reports missing:true for dangling dep references', () => {
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: ['task_nonexistent_777'] });
    const open = checkTaskDependencies(paths, b);
    expect(open).toEqual([{ id: 'task_nonexistent_777', status: 'missing' }]);
  });

  it('cycle detection: A blocked_by B, B blocked_by A throws at creation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    // A declares new blocked_by edge to B — would form A -> B -> A cycle.
    expect(() => createTask(paths, 'alice', 'acme', 'A-rewrite', { blockedBy: [b], blocks: [a] })).toThrow(/cycle/i);
  });

  it('REGRESSION: cycle-rejected createTask leaves ZERO state on disk — no task json, no audit, no peer mutation', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });

    // Snapshot A's blocks list before the cycle-try attempt.
    const aBlocksBefore = readTask(a).blocks ?? [];

    // Attempt a cycle: new task blocked_by c + blocks a → cycle-try → a → b → c → cycle-try.
    const filesBefore = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(() => createTask(paths, 'alice', 'acme', 'cycle-try', { blockedBy: [c], blocks: [a] })).toThrow(/cycle/i);

    // Invariants: (1) no new task JSON, (2) no audit directory entry for the rejected id,
    // (3) peer A's blocks list unchanged.
    const filesAfter = readdirSync(paths.taskDir).filter(f => f.startsWith('task_')).sort();
    expect(filesAfter).toEqual(filesBefore);
    // A's `blocks` list must not have been mutated by the attempted creation.
    expect(readTask(a).blocks ?? []).toEqual(aBlocksBefore);
    // No dangling audit dir file for a task id that never existed.
    const auditDir = join(paths.taskDir, 'audit');
    if (existsSync(auditDir)) {
      const auditFiles = readdirSync(auditDir);
      // No audit file for any task whose id isn't one of the 3 we successfully created.
      const validIds = new Set([a, b, c]);
      for (const f of auditFiles) {
        const id = f.replace(/\.jsonl$/, '');
        expect(validIds.has(id)).toBe(true);
      }
    }
  });

  it('listTasks --respect-deps orders unblocked tasks before blocked ones', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const blocked = createTask(paths, 'alice', 'acme', 'Blocked', { blockedBy: [blocker] });
    const free = createTask(paths, 'alice', 'acme', 'Free');

    const ordered = listTasks(paths, { respectDeps: true });
    const ids = ordered.map(t => t.id);
    // All 3 present
    expect(ids).toContain(blocker);
    expect(ids).toContain(blocked);
    expect(ids).toContain(free);
    // `blocked` must come after both `blocker` and `free` in the list.
    const idx = (id: string) => ids.indexOf(id);
    expect(idx(blocked)).toBeGreaterThan(idx(blocker));
    expect(idx(blocked)).toBeGreaterThan(idx(free));

    // Once blocker completes, respectDeps no longer demotes blocked.
    completeTask(paths, blocker, 'done');
    const reordered = listTasks(paths, { respectDeps: true });
    const blockedTask = reordered.find(t => t.id === blocked)!;
    expect(blockedTask.status).toBe('pending');
    // Specifically: blocked should no longer be forced after 'free'
    // (both unblocked now, fall back to created_at ordering).
  });
});

describe('compactTasks — semantic compaction of old completed tasks', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-compact-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Helper: age a completed task's completed_at by overwriting the JSON.
  function backdateCompletion(id: string, daysAgo: number) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    t.updated_at = ts;
    writeFileSync(p, JSON.stringify(t));
  }

  it('archives a completed task older than cutoff — removes active JSON, preserves audit log', () => {
    const id = createTask(paths, 'alice', 'acme', 'Old done', { assignee: 'alice' });
    completeTask(paths, id, 'shipped');
    backdateCompletion(id, 40);

    const auditPath = join(paths.taskDir, 'audit', `${id}.jsonl`);
    expect(existsSync(auditPath)).toBe(true);

    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived.map(a => a.id)).toEqual([id]);
    expect(report.skipped).toEqual([]);

    // Active JSON gone, audit log still there
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(false);
    expect(existsSync(auditPath)).toBe(true);

    // Archive entry written to the correct month file
    const archiveFile = report.archived[0].archive_file;
    const archiveLine = readFileSync(join(paths.taskDir, archiveFile), 'utf-8').trim();
    const entry = JSON.parse(archiveLine);
    expect(entry.id).toBe(id);
    expect(entry.title).toBe('Old done');
    expect(entry.result).toBe('shipped');
    expect(entry.assigned_to).toBe('alice');
  });

  it('skips recently-completed tasks (within cutoff)', () => {
    const id = createTask(paths, 'alice', 'acme', 'Fresh done');
    completeTask(paths, id, 'ok');
    // Leave completed_at as "just now" — should be skipped.
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === id)?.reason).toMatch(/within cutoff/);
  });

  it('skips in-progress and blocked tasks regardless of age', () => {
    const a = createTask(paths, 'alice', 'acme', 'In progress');
    claimTask(paths, a, 'alice'); // -> in_progress
    const b = createTask(paths, 'alice', 'acme', 'Blocked');
    updateTask(paths, b, 'blocked');

    const report = compactTasks(paths, { olderThanDays: 0 });
    expect(report.archived).toEqual([]);
  });

  it('NEVER archives a completed task still referenced by an open task\'s blocked_by chain', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);

    // Dependent is still pending → blocker must not be compacted away.
    expect(dependent).toBeDefined();
    const report = compactTasks(paths, { olderThanDays: 30 });
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/still.*blocked_by/);
    expect(existsSync(join(paths.taskDir, `${blocker}.json`))).toBe(true);
  });

  it('REGRESSION: transitive blocker guard — A<-B<-C with C open preserves BOTH A and B', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });
    const c = createTask(paths, 'alice', 'acme', 'C', { blockedBy: [b] });
    expect(c).toBeDefined();

    // A + B both completed and aged out; C stays open.
    completeTask(paths, a, 'done-a');
    completeTask(paths, b, 'done-b');
    backdateCompletion(a, 60);
    backdateCompletion(b, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    // Neither A nor B should be archived — both are in the transitive
    // blocker closure of open C.
    expect(report.archived).toEqual([]);
    const skippedIds = report.skipped.map(s => s.id).sort();
    expect(skippedIds).toContain(a);
    expect(skippedIds).toContain(b);
    // Both must still be on disk.
    expect(existsSync(join(paths.taskDir, `${a}.json`))).toBe(true);
    expect(existsSync(join(paths.taskDir, `${b}.json`))).toBe(true);
  });

  it('once the dependent completes, the blocker becomes eligible', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const dependent = createTask(paths, 'alice', 'acme', 'Dependent', { blockedBy: [blocker] });
    completeTask(paths, blocker, 'done');
    backdateCompletion(blocker, 60);
    completeTask(paths, dependent, 'done');
    backdateCompletion(dependent, 60);

    const report = compactTasks(paths, { olderThanDays: 30 });
    const archivedIds = report.archived.map(a => a.id).sort();
    expect(archivedIds).toEqual([blocker, dependent].sort());
  });

  it('is idempotent — running a second time on the same data archives nothing', () => {
    const id = createTask(paths, 'alice', 'acme', 'Run-twice');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const first = compactTasks(paths, { olderThanDays: 30 });
    expect(first.archived.map(a => a.id)).toEqual([id]);

    const second = compactTasks(paths, { olderThanDays: 30 });
    expect(second.archived).toEqual([]);
  });

  it('dry-run reports candidates without modifying anything', () => {
    const id = createTask(paths, 'alice', 'acme', 'Dry-run target');
    completeTask(paths, id, 'ok');
    backdateCompletion(id, 60);

    const report = compactTasks(paths, { olderThanDays: 30, dryRun: true });
    expect(report.dry_run).toBe(true);
    expect(report.archived.map(a => a.id)).toEqual([id]);
    // Active JSON still present
    expect(existsSync(join(paths.taskDir, `${id}.json`))).toBe(true);
  });
});

describe('updateTask dependency editing (--blocked-by / --blocks)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-updatedeps-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  const read = (id: string) => JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));

  it('sets blocked_by on an EXISTING task and writes the symmetric blocks edge', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Human step');

    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });

    // The whole point of the gap: this used to be unreachable from the CLI.
    expect(read(work).blocked_by).toEqual([blocker]);
    expect(read(work).status).toBe('blocked');
    // Symmetric reverse edge, same as create-task maintains.
    expect(read(blocker).blocks).toEqual([work]);
    // And the dependency is now actually visible to the resolver.
    expect(checkTaskDependencies(paths, work).map(d => d.id)).toEqual([blocker]);
  });

  it('replacing the list retires the reverse edge on the dropped peer', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const first = createTask(paths, 'alice', 'acme', 'First');
    const second = createTask(paths, 'alice', 'acme', 'Second');

    updateTask(paths, work, 'blocked', { blockedBy: [first] });
    updateTask(paths, work, 'blocked', { blockedBy: [second] });

    expect(read(work).blocked_by).toEqual([second]);
    expect(read(second).blocks).toEqual([work]);
    // A stale reverse edge here would pin `first` against compaction forever.
    expect(read(first).blocks).toBeUndefined();
  });

  it('an empty list clears the field and unblocks the task', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });
    // Anchor the precondition: without it this test passes vacuously
    // against a build that ignores the option entirely, because an
    // edge that was never set is also an edge that reads as cleared.
    expect(read(work).blocked_by).toEqual([blocker]);

    updateTask(paths, work, 'in_progress', { blockedBy: [] });

    expect(read(work).blocked_by).toBeUndefined();
    expect(read(blocker).blocks).toBeUndefined();
    expect(checkTaskDependencies(paths, work)).toEqual([]);
  });

  it('rejects a dependency cycle and leaves the task file unchanged', () => {
    const a = createTask(paths, 'alice', 'acme', 'A');
    const b = createTask(paths, 'alice', 'acme', 'B', { blockedBy: [a] });

    // a blocked_by b would close the loop a -> b -> a.
    expect(() => updateTask(paths, a, 'blocked', { blockedBy: [b] })).toThrow(/cycle/i);

    // Validation runs before the write, so nothing partial landed.
    expect(read(a).blocked_by).toBeUndefined();
    expect(read(a).status).toBe('pending');
  });

  it('the 3-argument call still works and does not disturb existing edges', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });

    updateTask(paths, work, 'in_progress');

    expect(read(work).status).toBe('in_progress');
    expect(read(work).blocked_by).toEqual([blocker]);
  });
});

describe('string-shaped blocked_by (hand-edited task JSON) is not shredded into characters', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-strdep-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  // Write blocked_by as a bare string, exactly as a hand-edit produces.
  function setStringBlockedBy(id: string, blockerId: string) {
    const p = join(paths.taskDir, `${id}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    t.blocked_by = blockerId; // NOT [blockerId]
    writeFileSync(p, JSON.stringify(t));
  }

  it('checkTaskDependencies reports ONE real blocker, not one per character', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    setStringBlockedBy(work, blocker);

    const open = checkTaskDependencies(paths, work);

    // Before normalisation this returned 27 entries: 't','a','s','k','_',...
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(blocker);
    expect(open[0].status).toBe('pending');
  });

  it('compactTasks still protects a blocker referenced as a bare string', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const work = createTask(paths, 'alice', 'acme', 'Work');
    setStringBlockedBy(work, blocker);

    completeTask(paths, blocker, 'done');
    const p = join(paths.taskDir, `${blocker}.json`);
    const t = JSON.parse(readFileSync(p, 'utf-8'));
    const ts = new Date(Date.now() - 60 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    t.completed_at = ts;
    writeFileSync(p, JSON.stringify(t));

    const report = compactTasks(paths, { olderThanDays: 30 });

    // The damaging case: character-splitting kept the real id out of the
    // still-needed set, so a live blocker was archived out from under an
    // open dependent.
    expect(report.archived).toEqual([]);
    expect(report.skipped.find(s => s.id === blocker)?.reason).toMatch(/blocked_by chain/);
  });
});

describe('edge maintenance is atomic and never silently partial (PR #36 review, HIGH 1 + HIGH 2)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-edgefail-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  const read = (id: string) => JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));
  const corrupt = (id: string) => writeFileSync(join(paths.taskDir, `${id}.json`), '{not json');

  // ---- HIGH 2: an invalid peer id must be rejected BEFORE the self write ----
  //
  // The cycle walk resolves each `blocked_by` id as it walks, so that
  // direction is validated incidentally. Nothing ever resolves a `blocks`
  // id — the walk starts at [taskId] — so it first reached findTaskFile
  // (and its validateTaskId throw) during peer maintenance, i.e. AFTER the
  // self file had already been committed.

  it('rejects an invalid --blocks id and leaves ZERO partial state on disk', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const before = read(work);

    expect(() => updateTask(paths, work, 'blocked', { blocks: ['../../../etc/passwd'] }))
      .toThrow(/Invalid task id/);

    // The rejected dependency must NOT be on disk, and the status must not
    // have moved. Both of these failed before the fix.
    expect(read(work).blocks).toBeUndefined();
    expect(read(work).status).toBe('pending');
    expect(read(work).updated_at).toBe(before.updated_at);
    // A rejected command must not claim a transition in the audit log.
    expect(readTaskAudit(paths, work).filter(e => e.event === 'update')).toEqual([]);
  });

  it('rejects an invalid --blocked-by id and leaves ZERO partial state on disk', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');

    expect(() => updateTask(paths, work, 'blocked', { blockedBy: ['../../../etc/shadow'] }))
      .toThrow(/Invalid task id/);

    expect(read(work).blocked_by).toBeUndefined();
    expect(read(work).status).toBe('pending');
    expect(readTaskAudit(paths, work).filter(e => e.event === 'update')).toEqual([]);
  });

  it('createTask rejects an invalid --blocks id and leaves ZERO state on disk', () => {
    // A decoy first, so taskDir exists and the count below measures the
    // rejected create rather than the absence of the directory.
    createTask(paths, 'alice', 'acme', 'Decoy');
    const jsonCount = () => readdirSync(paths.taskDir).filter(f => f.endsWith('.json')).length;
    const before = jsonCount();

    expect(() => createTask(paths, 'alice', 'acme', 'Work', { blocks: ['../../../etc/passwd'] }))
      .toThrow(/Invalid task id/);

    // Same guarantee the cycle-rejection regression test pins: a rejected
    // create leaves no task json behind.
    expect(jsonCount()).toBe(before);
  });

  // ---- HIGH 1: a failed peer write must never report success ----

  it('reports failure when the peer write fails while ADDING an edge', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    corrupt(blocker); // peer JSON unreadable -> its `blocks` edge cannot be written

    // Before the fix this returned normally: the self task recorded the
    // dependency, the peer never got the reverse edge, and the command
    // reported success over a now-asymmetric graph.
    expect(() => updateTask(paths, work, 'blocked', { blockedBy: [blocker] }))
      .toThrow(/edge update\(s\) failed/i);

    // Round 2 changed what the task looks like afterwards: peers are now
    // written BEFORE the task, so a peer failure aborts the edit entirely
    // instead of committing the task and leaving the graph asymmetric.
    expect(read(work).blocked_by).toBeUndefined();
    expect(read(work).status).toBe('pending');
  });

  it('reports failure when the peer write fails while REMOVING an edge', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });
    expect(read(blocker).blocks).toEqual([work]);

    corrupt(blocker);

    // This is the damaging direction: a swallowed REMOVAL leaves a stale
    // reverse edge that reads as a live dependency and pins the peer
    // against compaction indefinitely.
    expect(() => updateTask(paths, work, 'in_progress', { blockedBy: [] }))
      .toThrow(/asymmetric|edge/i);
  });

  // Round 1 asserted the INVERSE of this: that a peer failure still wrote
  // the task and still recorded the transition, on the reasoning that the
  // self write "really happened" so the audit must not omit it. Round 2
  // removed the premise — the task is no longer written at all — and the
  // audit invariant flips with it. Kept as an explicit test rather than
  // deleted, because "no transition happened, so none is recorded" is the
  // property that makes the audit log trustworthy.
  it('records NO audit transition when the edit was aborted by a peer failure', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    corrupt(blocker);

    expect(() => updateTask(paths, work, 'blocked', { blockedBy: [blocker] })).toThrow();

    expect(read(work).status).toBe('pending');
    expect(readTaskAudit(paths, work).filter(e => e.event === 'update')).toEqual([]);
  });

  // ---- Preservation: a dangling ref is NOT a failure ----

  it('PRESERVES dangling-reference tolerance: a missing peer is not an error', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');

    // Well-formed id that resolves to nothing. detectCycleOrThrow calls this
    // "not a cycle, just a dangling ref" and checkTaskDependencies reports it
    // as missing — so it must stay a successful update, not become a throw.
    expect(() => updateTask(paths, work, 'blocked', { blockedBy: ['task_1700000000_00000001'] }))
      .not.toThrow();

    expect(read(work).blocked_by).toEqual(['task_1700000000_00000001']);
    expect(checkTaskDependencies(paths, work)).toEqual([
      { id: 'task_1700000000_00000001', status: 'missing' },
    ]);
  });

  it('PRESERVES the happy path: a well-formed edit still writes both sides', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');

    expect(() => updateTask(paths, work, 'blocked', { blockedBy: [blocker] })).not.toThrow();

    expect(read(work).blocked_by).toEqual([blocker]);
    expect(read(blocker).blocks).toEqual([work]);
  });
});

describe('recovery is real: a retry after a peer failure repairs the graph (round 2)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-retry-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); });

  const path = (id: string) => join(paths.taskDir, `${id}.json`);
  const read = (id: string) => JSON.parse(readFileSync(path(id), 'utf-8'));
  const breakPeer = (id: string) => {
    const saved = readFileSync(path(id), 'utf-8');
    writeFileSync(path(id), '{not json');
    return () => writeFileSync(path(id), saved); // operator repairs the file
  };

  it('ADD direction: re-running the command after fixing the peer writes the reverse edge', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const repair = breakPeer(blocker);

    expect(() => updateTask(paths, work, 'blocked', { blockedBy: [blocker] })).toThrow();
    repair();

    // The error tells the operator to re-run. That instruction has to be TRUE:
    // the retry must either repair the graph or fail again — never report
    // success over a still-asymmetric graph.
    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });

    expect(read(work).blocked_by).toEqual([blocker]);
    expect(read(blocker).blocks).toEqual([work]);
  });

  it('REMOVE direction: re-running after fixing the peer retires the stale reverse edge', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    updateTask(paths, work, 'blocked', { blockedBy: [blocker] });
    expect(read(blocker).blocks).toEqual([work]);

    const repair = breakPeer(blocker);
    expect(() => updateTask(paths, work, 'in_progress', { blockedBy: [] })).toThrow();
    repair();

    updateTask(paths, work, 'in_progress', { blockedBy: [] });

    // A surviving reverse edge here pins `blocker` against compaction forever.
    expect(read(work).blocked_by).toBeUndefined();
    expect(read(blocker).blocks).toBeUndefined();
  });

  it('a failed edit leaves the task itself UNCHANGED, so the retry has correct old state', () => {
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const before = read(work);
    breakPeer(blocker);

    expect(() => updateTask(paths, work, 'blocked', { blockedBy: [blocker] })).toThrow();

    // Committing the self side first is what made the retry a no-op.
    expect(read(work).status).toBe(before.status);
    expect(read(work).blocked_by).toBeUndefined();
  });

  it('createTask leaves NO orphan when a peer write fails — nothing to notify, nothing to duplicate', () => {
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    const before = readdirSync(paths.taskDir).filter(f => f.endsWith('.json')).length;
    breakPeer(blocker);

    // Previously: the task was committed and assigned, then the throw ate the
    // returned id — so the CLI never printed it and never notified the
    // assignee, and the advised re-run produced a DUPLICATE rather than a fix.
    expect(() => createTask(paths, 'bob', 'acme', 'Work', { blockedBy: [blocker] })).toThrow();

    expect(readdirSync(paths.taskDir).filter(f => f.endsWith('.json')).length).toBe(before);
  });

  it('createTask STRANDS NO PEER: an earlier peer that succeeded is rolled back (round 3 HIGH)', () => {
    // The single-peer test above cannot reach this: with the only peer already
    // corrupt, no EARLIER peer is ever successfully mutated, so the multi-peer
    // case it is named for never happens, and asserting the task-file count
    // says nothing about what happened to the peers.
    const d1 = createTask(paths, 'alice', 'acme', 'Downstream 1');
    const d2 = createTask(paths, 'alice', 'acme', 'Downstream 2');
    const before = readdirSync(paths.taskDir).filter(f => f.endsWith('.json')).length;
    breakPeer(d2); // d1 is mutated successfully first, THEN d2 fails

    expect(() => createTask(paths, 'bob', 'acme', 'Work', { blocks: [d1, d2] })).toThrow();

    // Without rollback d1.blocked_by holds a generated id that was never
    // written and never will be: check-deps calls d1 blocked forever, and a
    // re-run mints a DIFFERENT id beside the stranded one instead of
    // replacing it. Peer state, not the task count, is the assertion.
    expect(read(d1).blocked_by).toBeUndefined();
    // d2 stays corrupt — that is the premise, not a failure. Assert rollback
    // left it byte-identical rather than parsing it (parsing it here was a
    // bug that made this test fail for the wrong reason).
    expect(readFileSync(join(paths.taskDir, `${d2}.json`), 'utf-8')).toBe('{not json');
    expect(readdirSync(paths.taskDir).filter(f => f.endsWith('.json')).length).toBe(before);
  });

  it('a failed createTask names a DEAD id: advice is "create again", never "re-run to complete"', () => {
    const d1 = createTask(paths, 'alice', 'acme', 'Downstream 1');
    const d2 = createTask(paths, 'alice', 'acme', 'Downstream 2');
    breakPeer(d2);

    let msg = '';
    try { createTask(paths, 'bob', 'acme', 'Work', { blocks: [d1, d2] }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }

    // updateTask's message tells the operator to re-run and complete the edit.
    // For create that instruction is FALSE — the id is gone with the call.
    expect(msg).toContain('NOT created');
    expect(msg).toMatch(/new id/i);
    expect(msg).not.toMatch(/complete the edit/i);
  });

  it('the failure message names the direction and field, not just the peer id (round 1, not round 2)', () => {
    // HONESTY NOTE, added in round 3: this test sits in the round-2 block but
    // guards a ROUND-1 property. Round 1 already added the directional detail,
    // so this passes with round 2's reorder reverted — it is not evidence for
    // the reorder. The tests that actually discriminate round 2 are 'a failed
    // edit leaves the task itself UNCHANGED' (update) and the orphan/stranded
    // peer tests (create). Left here, relabelled, rather than deleted: the
    // property is still worth guarding, it just proves something else.
    const work = createTask(paths, 'alice', 'acme', 'Work');
    const blocker = createTask(paths, 'alice', 'acme', 'Blocker');
    breakPeer(blocker);

    // With five mutations and one failure, "peer 3 failed" alone does not tell
    // an operator which reverse edge to repair.
    let msg = '';
    try { updateTask(paths, work, 'blocked', { blockedBy: [blocker] }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }

    expect(msg).toContain(blocker);
    expect(msg).toMatch(/add/i);
    expect(msg).toMatch(/blocks/);
  });
});

describe('rollback removes only what it inserted (round 4 HIGH: id collision)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-collide-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'x'),
      inflight: join(testDir, 'inflight', 'x'),
      processed: join(testDir, 'processed', 'x'),
      logDir: join(testDir, 'logs', 'x'),
      stateDir: join(testDir, 'state', 'x'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
  });

  afterEach(() => {
    forced.digits = null;
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  const read = (id: string) => JSON.parse(readFileSync(join(paths.taskDir, `${id}.json`), 'utf-8'));

  it('a colliding id does NOT let a failed create delete a real pre-existing edge', () => {
    // Setup tasks keep REAL unique ids. Freezing the clock/digits up here
    // instead would give all three the same id and collapse the fixture into
    // a self-cycle that never reaches the code under test.
    const existing = createTask(paths, 'alice', 'acme', 'Existing task E');
    const peer = createTask(paths, 'alice', 'acme', 'Peer P', { blocks: [existing] });
    // P legitimately blocks E, written by a DIFFERENT call than the one below.
    expect(read(peer).blocks).toContain(existing);

    const corrupt = createTask(paths, 'alice', 'acme', 'Corrupt peer');
    writeFileSync(join(paths.taskDir, `${corrupt}.json`), '{not json');

    // NOW force the next generated id to collide with `existing`, by replaying
    // its exact epoch and digits. Eight random digits make this rare, not
    // impossible, and the generator does no existence check — this module has
    // already had a same-millisecond collision in CI.
    const [, epoch, digits] = existing.split('_');
    forced.digits = digits;
    vi.spyOn(Date, 'now').mockReturnValue(Number(epoch));

    // This create generates the SAME id as `existing`. Adding it to P.blocks
    // is a no-op because P already blocks that id — but the edge is not ours.
    expect(() =>
      createTask(paths, 'bob', 'acme', 'Colliding', { blockedBy: [peer], blocks: [corrupt] }),
    ).toThrow();

    // Recording no-ops as "applied" made rollback delete P's real edge to E —
    // and because it was the only entry, the field vanished entirely. Asserted
    // as an exact list so the failure reads as the lost edge, not as a
    // toContain() misuse against undefined.
    expect(read(peer).blocks).toEqual([existing]);
  });

  it('a failed TASK write rolls back peers that already succeeded (round 5 HIGH)', () => {
    // The round-3 tests cannot reach this: they all fail INSIDE the peer loop,
    // so `edgeFailures` is non-empty and rollback runs. Here every peer edge
    // succeeds and the task's own write is what fails — the one path that used
    // to skip rollback entirely.
    const peer = createTask(paths, 'alice', 'acme', 'Peer P');

    // Force the id so the write destination is known in advance, then park a
    // DIRECTORY on it: atomicWriteSync's final renameSync onto a directory
    // fails, which is a real filesystem failure arriving after the peer loop
    // rather than a mocked throw. Digits are forced only for the call under
    // test, so `peer` above keeps a real unique id.
    const epoch = Date.now();
    forced.digits = '12345678';
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    mkdirSync(join(paths.taskDir, `task_${epoch}_12345678.json`), { recursive: true });

    expect(() => createTask(paths, 'bob', 'acme', 'Doomed', { blockedBy: [peer] })).toThrow();

    // `blockedBy: [peer]` writes the REVERSE edge, so the field to assert on
    // is peer.BLOCKS. Asserting peer.blocked_by here passed pre-fix — not
    // because rollback worked, but because that field was never written in
    // either direction, which is a test that proves nothing.
    //
    // Pre-fix this held the generated id forever: the task it names was never
    // written and never will be, so check-deps calls P blocked by a task that
    // cannot be created, completed, or repaired. Peer state is the assertion —
    // a task-file COUNT would be wrong here, because the directory parked
    // above ends with .json and readdirSync counts it.
    expect(read(peer).blocks).toBeUndefined();
  });

  it('the task-write failure does NOT claim zero edges failed', () => {
    // Routing this path through throwIfCreateEdgesFailed printed
    // "0 symmetric edge update(s) failed" — true but useless, and it points
    // the operator at peer files that are perfectly fine.
    const peer = createTask(paths, 'alice', 'acme', 'Peer P');
    const epoch = Date.now();
    forced.digits = '87654321';
    vi.spyOn(Date, 'now').mockReturnValue(epoch);
    mkdirSync(join(paths.taskDir, `task_${epoch}_87654321.json`), { recursive: true });

    let msg = '';
    try { createTask(paths, 'bob', 'acme', 'Doomed', { blockedBy: [peer] }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }

    expect(msg).toContain('NOT created');
    expect(msg).toMatch(/writing the task file failed/i);
    expect(msg).not.toMatch(/0 symmetric edge update\(s\) failed/);
    // Rollback succeeded here, so it must NOT tell anyone to repair by hand.
    expect(msg).not.toMatch(/by hand/i);
    expect(msg).toMatch(/new id/i);
  });
});
