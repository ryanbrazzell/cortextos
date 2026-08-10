/**
 * tests/unit/cli/bus-task-field-edits.test.ts
 *
 * Coverage for `bus update-task --desc/--assignee/--project/--priority`
 * (the four scalar fields that were settable at create time and immutable
 * afterwards), plus the two behaviour changes that shipped with them:
 * the conditional task write and the field-edit audit matrix.
 *
 * Strategy
 * --------
 * `busCommand` is a module-level singleton, so it is imported once and driven
 * with `parseAsync(..., { from: 'user' })`. Isolation is the tricky part:
 *
 *   `resolvePaths()` (src/utils/paths.ts:32) hardcodes
 *   `join(homedir(), '.cortextos', instanceId)` and IGNORES `CTX_ROOT`.
 *
 * So pointing `CTX_ROOT` at a tempdir does NOT isolate task files — it would
 * silently read and write the live agent's tasks. Isolation here comes from a
 * unique `CTX_INSTANCE_ID` (which relocates the whole ctxRoot) plus a private
 * `CTX_ORG`, and every `CTX_*` var env.ts reads is saved/set/restored so
 * nothing leaks in from the live agent process.
 *
 * Which arms prove the feature
 * ----------------------------
 * Every arm below was observed RED against `d424eb7^` (pre-change code) except
 * the one labelled REGRESSION, which is expected green in both states and is
 * NOT feature coverage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Task, TaskStatus, Priority } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// atomicWriteSync spy.
//
// "Performs no write" cannot be observed as unchanged bytes: an implementation
// that rewrites byte-identical content while preserving `updated_at` satisfies
// a byte-equality check and still violates the intent. The spy delegates to the
// real implementation so behaviour is unchanged — it only records calls.
//
// `ensureDir` must keep working: the audit append depends on it, and by the
// audit matrix a no-op MUST still append.
// ---------------------------------------------------------------------------
const atomicSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/atomic')>();
  return {
    ...actual,
    atomicWriteSync: (filePath: string, data: string, keepBak?: boolean) => {
      atomicSpy(filePath, data, keepBak);
      return actual.atomicWriteSync(filePath, data, keepBak);
    },
  };
});

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

/** Every var resolveEnv() reads (src/utils/env.ts:25-62). */
const CTX_VARS = [
  'CTX_INSTANCE_ID',
  'CTX_ROOT',
  'CTX_FRAMEWORK_ROOT',
  'CTX_AGENT_NAME',
  'CTX_ORG',
  'CTX_PROJECT_ROOT',
  'CTX_AGENT_DIR',
] as const;

const savedEnv: Record<string, string | undefined> = {};

const TEST_AGENT = 'boris';
const TEST_ORG = 'taskeditorg';
const TASK_ID = 'task_1700000000000_abc123';

let instanceId: string;
let ctxRoot: string;
let taskDir: string;
let seq = 0;

function taskPath(): string {
  return join(taskDir, `${TASK_ID}.json`);
}

function auditPath(): string {
  return join(taskDir, 'audit', `${TASK_ID}.jsonl`);
}

/**
 * Seed a task file directly rather than via createTask, so `updated_at` can be
 * pinned to a fixed OLD value. `updateTask` strips milliseconds, so a
 * create-then-update in the same second can show an unchanged timestamp even on
 * code that rewrites it unconditionally — the seeded old value removes that.
 */
function seedTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: TASK_ID,
    title: 'Seeded task',
    description: 'original description',
    type: 'agent',
    needs_approval: false,
    status: 'pending',
    assigned_to: 'original-agent',
    created_by: 'seeder',
    org: TEST_ORG,
    priority: 'normal',
    project: 'original-project',
    kpi_key: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
    completed_at: null,
    due_date: null,
    archived: false,
    ...overrides,
  };
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(taskPath(), JSON.stringify(task), 'utf-8');
  return task;
}

function readTask(): Task {
  return JSON.parse(readFileSync(taskPath(), 'utf-8')) as Task;
}

function readAudit(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath())) return [];
  return readFileSync(auditPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  for (const v of CTX_VARS) savedEnv[v] = process.env[v];

  // Unique per test: relocates the ENTIRE ctxRoot, including the cross-org
  // fallback scan in findTaskFile(), away from the live agent's tree.
  instanceId = `taskedit-test-${process.pid}-${++seq}`;
  ctxRoot = join(homedir(), '.cortextos', instanceId);
  taskDir = join(ctxRoot, 'orgs', TEST_ORG, 'tasks');

  process.env.CTX_INSTANCE_ID = instanceId;
  process.env.CTX_ROOT = ctxRoot;
  process.env.CTX_AGENT_NAME = TEST_AGENT;
  process.env.CTX_ORG = TEST_ORG;
  process.env.CTX_FRAMEWORK_ROOT = '';
  process.env.CTX_PROJECT_ROOT = '';
  process.env.CTX_AGENT_DIR = '';

  atomicSpy.mockClear();
});

afterEach(() => {
  for (const v of CTX_VARS) {
    if (savedEnv[v] !== undefined) process.env[v] = savedEnv[v] as string;
    else delete process.env[v];
  }
  // Guard the rm: only ever remove a path we generated under the test prefix.
  if (ctxRoot.includes('.cortextos') && ctxRoot.includes('taskedit-test-')) {
    try { rmSync(ctxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

import { busCommand } from '../../../src/cli/bus';

/** `bus.ts` has 75 `process.exit` calls; un-mocked, an error arm kills the worker. */
function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

async function runUpdate(...args: string[]): Promise<void> {
  await busCommand.parseAsync(['update-task', ...args], { from: 'user' });
}

// ---------------------------------------------------------------------------
// Sanity: the isolation actually isolates.
// A test that silently wrote to the live tree would still pass every assertion
// below, so prove where the bytes landed before trusting any of them.
// ---------------------------------------------------------------------------

describe('test isolation', () => {
  it('writes the task under the per-test instance root, not the live root', async () => {
    mockExit();
    seedTask();
    await runUpdate(TASK_ID, 'pending', '--project', 'moved');

    expect(taskPath()).toContain(`/.cortextos/${instanceId}/`);
    expect(existsSync(taskPath())).toBe(true);
    expect(readTask().project).toBe('moved');
    // Every recorded write stayed inside this test's own root.
    for (const call of atomicSpy.mock.calls) {
      expect(String(call[0])).toContain(instanceId);
    }
  });
});

// ---------------------------------------------------------------------------
// One arm per flag: the value lands on its OWN field, other three unchanged.
// A --desc/--project wiring swap goes red here.
// ---------------------------------------------------------------------------

describe('bus update-task — per-flag field edits', () => {
  const cases: Array<{
    flag: string;
    value: string;
    field: keyof Task;
    others: Array<[keyof Task, string]>;
  }> = [
    {
      flag: '--desc', value: 'rewritten description', field: 'description',
      others: [['assigned_to', 'original-agent'], ['project', 'original-project'], ['priority', 'normal']],
    },
    {
      flag: '--assignee', value: 'new-agent', field: 'assigned_to',
      others: [['description', 'original description'], ['project', 'original-project'], ['priority', 'normal']],
    },
    {
      flag: '--project', value: 'backlog', field: 'project',
      others: [['description', 'original description'], ['assigned_to', 'original-agent'], ['priority', 'normal']],
    },
    {
      flag: '--priority', value: 'high', field: 'priority',
      others: [['description', 'original description'], ['assigned_to', 'original-agent'], ['project', 'original-project']],
    },
  ];

  for (const c of cases) {
    it(`${c.flag} sets ${String(c.field)} and leaves the other three untouched`, async () => {
      mockExit();
      seedTask();

      await runUpdate(TASK_ID, 'pending', c.flag, c.value);

      const t = readTask();
      expect(t[c.field]).toBe(c.value);
      for (const [otherField, expected] of c.others) {
        expect(t[otherField]).toBe(expected);
      }
      // Status argument is still honoured alongside a field edit.
      expect(t.status).toBe('pending');
    });
  }

  it('--desc "" clears a NONEMPTY description (empty string is a value, not absence)', async () => {
    mockExit();
    seedTask({ description: 'a genuinely nonempty description' });

    await runUpdate(TASK_ID, 'pending', '--desc', '');

    // Guarding with truthiness instead of `!== undefined` leaves the old text here.
    expect(readTask().description).toBe('');
  });

  it('applies status and field edits together in one call', async () => {
    mockExit();
    seedTask();

    await runUpdate(TASK_ID, 'in_progress', '--project', 'backlog', '--priority', 'urgent');

    const t = readTask();
    expect(t.status).toBe('in_progress');
    expect(t.project).toBe('backlog');
    expect(t.priority).toBe('urgent');
  });
});

// ---------------------------------------------------------------------------
// Priority validation, through the update path.
// The CLI's `as Priority` cast is erased at runtime and validates nothing.
// ---------------------------------------------------------------------------

describe('bus update-task — priority validation', () => {
  it('rejects --priority medium, echoes the valid set, and leaves the file byte-unchanged', async () => {
    mockExit();
    seedTask();
    const before = readFileSync(taskPath());

    // `medium` is severity vocabulary, not priority vocabulary — the exact
    // neighbouring-vocabulary confusion this validation exists to catch.
    await expect(runUpdate(TASK_ID, 'pending', '--priority', 'medium')).rejects.toThrow(
      /Invalid priority 'medium'.*urgent, high, normal, low/s,
    );

    expect(readFileSync(taskPath()).equals(before)).toBe(true);
    expect(atomicSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit matrix. `from`/`to` are BOTH optional in TaskAuditEntry, so nothing in
// the type system catches an implementation that emits {from,to,fields} on a
// fields-only edit — it has to be asserted as an absence.
// ---------------------------------------------------------------------------

describe('bus update-task — audit matrix', () => {
  it('fields-only edit emits `fields` with `from` and `to` both ABSENT', async () => {
    mockExit();
    seedTask({ status: 'pending' });

    await runUpdate(TASK_ID, 'pending', '--project', 'backlog');

    const entries = readAudit();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.fields).toEqual(['project']);
    // A forged pending -> pending transition replays as real lifecycle work.
    expect(e).not.toHaveProperty('from');
    expect(e).not.toHaveProperty('to');
  });

  it('omits a supplied SAME-VALUE field from `fields`', async () => {
    mockExit();
    seedTask({ project: 'original-project', priority: 'normal' });

    // priority genuinely changes; project is supplied but identical to disk.
    await runUpdate(TASK_ID, 'pending', '--project', 'original-project', '--priority', 'high');

    const e = readAudit()[0];
    expect(e.fields).toEqual(['priority']);
  });

  it('status change alongside a field edit emits from/to AND fields', async () => {
    mockExit();
    seedTask({ status: 'pending' });

    await runUpdate(TASK_ID, 'in_progress', '--project', 'backlog');

    const e = readAudit()[0];
    expect(e.from).toBe('pending');
    expect(e.to).toBe('in_progress');
    expect(e.fields).toEqual(['project']);
  });
});

// ---------------------------------------------------------------------------
// No-op behaviour — the user-visible change that ships with this feature.
// ---------------------------------------------------------------------------

describe('bus update-task — no-op does not write', () => {
  it('performs no task write and leaves updated_at unchanged, but still audits', async () => {
    mockExit();
    seedTask({ status: 'pending', project: 'original-project', updated_at: '2020-01-01T00:00:00Z' });

    // POSITIVE CONTROL: prove the spy is actually wired to the write path
    // before trusting the absence assertion below. A dead spy would make
    // "never called" pass no matter what the implementation does.
    await runUpdate(TASK_ID, 'pending', '--project', 'genuinely-different');
    expect(atomicSpy).toHaveBeenCalled();
    expect(readTask().updated_at).not.toBe('2020-01-01T00:00:00Z');

    // Re-pin the timestamp, then issue a true no-op.
    const pinned = '2020-01-01T00:00:00Z';
    const t = readTask();
    writeFileSync(taskPath(), JSON.stringify({ ...t, updated_at: pinned }), 'utf-8');
    atomicSpy.mockClear();
    const auditCountBefore = readAudit().length;

    await runUpdate(TASK_ID, 'pending', '--project', 'genuinely-different');

    expect(atomicSpy).not.toHaveBeenCalled();
    expect(readTask().updated_at).toBe(pinned);
    // The audit append must still happen — a no-op is still an event.
    expect(readAudit().length).toBe(auditCountBefore + 1);
  });

  it('a bare status-only no-op still emits from/to', async () => {
    mockExit();
    seedTask({ status: 'pending' });

    await runUpdate(TASK_ID, 'pending');

    const e = readAudit()[0];
    expect(e.from).toBe('pending');
    expect(e.to).toBe('pending');
    expect(e).not.toHaveProperty('fields');
    expect(atomicSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION ARM — EXEMPT from "must go red on pre-change code".
// Expected green in BOTH states. It proves the change broke nothing; it is
// NOT evidence that the feature works and must not be counted as coverage.
// ---------------------------------------------------------------------------

describe('bus update-task — REGRESSION (exempt: green before and after)', () => {
  it('status-only change preserves all four scalar fields and emits no `fields` key', async () => {
    mockExit();
    seedTask({
      status: 'pending',
      description: 'original description',
      assigned_to: 'original-agent',
      project: 'original-project',
      priority: 'normal',
    });

    await runUpdate(TASK_ID, 'completed');

    const t = readTask();
    expect(t.status).toBe('completed');
    expect(t.description).toBe('original description');
    expect(t.assigned_to).toBe('original-agent');
    expect(t.project).toBe('original-project');
    expect(t.priority).toBe('normal');

    const e = readAudit()[0];
    expect(e.from).toBe('pending');
    expect(e.to).toBe('completed');
    expect(e).not.toHaveProperty('fields');
  });
});
