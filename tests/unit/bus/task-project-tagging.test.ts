/**
 * tests/unit/bus/task-project-tagging.test.ts
 *
 * Library-layer coverage for the three capabilities added by
 * `feat(bus): default new tasks to backlog, validate project names, allow
 * field-only update-task` on top of PR #38's field-edit shape:
 *
 *   1. `createTask` defaults an omitted `project` to `'backlog'`.
 *      Before this the default was `''`, which left tasks untagged and
 *      invisible to every project-scoped query.
 *   2. `validateProject()` — a printable-ASCII ALLOWLIST plus a 64-char cap,
 *      rejecting empty and whitespace-padded names. Enforced by both
 *      `createTask` and `updateTask` BEFORE anything reaches disk.
 *   3. `status` is optional on `updateTask`; a call that supplies neither a
 *      status nor any editable field is rejected outright rather than
 *      absorbed as a no-op.
 *
 * Plus the audit contract that carries the field edit: `TaskAuditEntry.changes`
 * records from/to for `assigned_to`, `project` and `priority` — and
 * DELIBERATELY NOT for `description`, whose unbounded text would let one task's
 * append-only log outgrow the tree. That exclusion is asserted here, because
 * nothing in the type system prevents an implementation from including it.
 *
 * File named for the surviving design. An earlier, abandoned iteration of this
 * work encoded project moves as a distinct `retag` audit event with
 * `from_project`/`to_project`; no such event exists in the shipped code, so the
 * name would point at nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTask, updateTask, readTaskAudit, findTaskFile } from '../../../src/bus/task';
import { validateProject, PROJECT_NAME_MAX } from '../../../src/utils/validate';
import type { BusPaths } from '../../../src/types';
// `TaskAuditEntry` is declared and exported by src/bus/task.ts, NOT by
// src/types. Importing it from src/types raised TS2305 (no exported member) —
// invisible in CI because tsconfig.json excludes `tests/` and vitest erases
// type-only imports without checking them, so the file ran green while never
// type-checking.
import type { TaskAuditEntry } from '../../../src/bus/task';

// ---------------------------------------------------------------------------
// The project-name grammar, unit level.
//
// `validateProject` is the gate both task entry points call, so its arms are
// kept beside the task behaviour they govern rather than in the generic
// validator file — the reason each rule exists is a task-output concern.
// ---------------------------------------------------------------------------

describe('validateProject — the project-name grammar', () => {
  it('accepts ordinary project names', () => {
    for (const name of ['backlog', 'sbc-edge', 'cortextos-framework', 'human-tasks', 'other']) {
      expect(() => validateProject(name)).not.toThrow();
    }
  });

  it('accepts the full printable-ASCII range the allowlist names', () => {
    // ' ' (0x20) through '~' (0x7E). Interior spaces and punctuation are legal;
    // only the ENDS are whitespace-checked. A grammar that quietly rejected
    // these would break real callers rather than attackers.
    expect(() => validateProject('a b')).not.toThrow();
    expect(() => validateProject('q1 2026 / launch (v2)')).not.toThrow();
    expect(() => validateProject(' ')).toThrow(); // a lone space is padding, not a name

    // Every codepoint in 0x20..0x7E, walked in chunks that stay under the
    // length cap so the CHARACTER rule is what is being exercised and not the
    // 64-char one. Each chunk is trimmed so the padding rule is not either.
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    for (let i = 0; i < printable.length; i += 32) {
      const chunk = printable.slice(i, i + 32).trim();
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(PROJECT_NAME_MAX);
      expect(() => validateProject(chunk)).not.toThrow();
    }
  });

  it('rejects the empty string with the non-empty message', () => {
    expect(() => validateProject('')).toThrow(/non-empty/);
  });

  it('rejects a whitespace-only name — as PADDING, not as empty', () => {
    // Deliberately pinning the message, not just the throw. `'   '` trims to
    // `''`, so it is tempting to assume it reports "non-empty"; the source
    // checks padding first and reports that instead. A test written against
    // /non-empty/ here goes red against correct code.
    expect(() => validateProject('   ')).toThrow(/begin or end with whitespace/);
    expect(() => validateProject('\t')).toThrow(/begin or end with whitespace/);
  });

  it('rejects leading and trailing whitespace rather than silently trimming', () => {
    expect(() => validateProject(' backlog')).toThrow(/begin or end with whitespace/);
    expect(() => validateProject('backlog ')).toThrow(/begin or end with whitespace/);
    // Silent trimming would make ' backlog' and 'backlog' the same tag while
    // the caller believes it stored what it passed.
    expect(() => validateProject('backlog')).not.toThrow();
  });

  describe('the allowlist exists because a C0 blocklist leaked these', () => {
    /**
     * Each of these defeated an earlier blocklist-shaped version of this check
     * that enumerated the C0 controls: every one of them is above U+001F, so a
     * "reject the control characters" rule waves them through. U+2028/U+2029/
     * U+0085 are line terminators (a terminal or line-oriented log reader
     * treats them as a row break, which is what makes output forging possible);
     * U+202E visually reverses the remainder of the rendered line; U+200B makes
     * two distinct project tags render identically.
     *
     * The allowlist rejects the whole class at once, which is why these are
     * regression arms and not a growing enumeration.
     */
    const escapes: Array<[string, string]> = [
      ['U+2028 LINE SEPARATOR', '\u2028'],
      ['U+2029 PARAGRAPH SEPARATOR', '\u2029'],
      ['U+0085 NEL', '\u0085'],
      ['U+202E RIGHT-TO-LEFT OVERRIDE', '\u202e'],
      ['U+200B ZERO WIDTH SPACE', '\u200b'],
    ];

    for (const [name, ch] of escapes) {
      it(`rejects ${name}`, () => {
        expect(() => validateProject(`backlog${ch}forged`)).toThrow(/printable ASCII/);
        // ATTRIBUTION CONTROL: the identical name with the one character
        // removed must be ACCEPTED. Without this, the rejection could be
        // coming from anything else about the string and the arm would prove
        // nothing about this codepoint.
        expect(() => validateProject('backlogforged')).not.toThrow();
        // And the reason a C0 blocklist missed it, stated as an assertion
        // rather than as a comment.
        expect(ch.charCodeAt(0)).toBeGreaterThan(0x1f);
      });
    }

    it('still rejects the C0 characters the old blocklist did catch', () => {
      for (const ch of ['\n', '\r', '\t', '\x00', '\x1b', '\x7f']) {
        expect(() => validateProject(`a${ch}b`)).toThrow(/printable ASCII/);
      }
    });
  });

  describe('the 64-character cap', () => {
    it('ACCEPTS a name of exactly 64 characters', () => {
      // The boundary pair matters as a pair: a suite that only checks 65 passes
      // just as happily against an off-by-one that rejects 64 as well.
      expect(PROJECT_NAME_MAX).toBe(64);
      expect(() => validateProject('x'.repeat(64))).not.toThrow();
    });

    it('REJECTS a name of exactly 65 characters, and names the actual length', () => {
      expect(() => validateProject('x'.repeat(65))).toThrow(/64 characters or fewer \(got 65\)/);
    });
  });
});

// ---------------------------------------------------------------------------
// Task-layer behaviour.
// ---------------------------------------------------------------------------

describe('project tagging (library layer)', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-project-tag-'));
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
      deliverablesDir: join(testDir, 'deliverables'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const read = (id: string) => JSON.parse(readFileSync(findTaskFile(paths, id)!, 'utf-8'));
  const taskFiles = () =>
    (existsSync(paths.taskDir) ? readdirSync(paths.taskDir) : []).filter(f => f.endsWith('.json'));
  /** Audit rows for the task, excluding the `create` row every task starts with. */
  const rows = (id: string): TaskAuditEntry[] => readTaskAudit(paths, id).filter(e => e.event !== 'create');

  describe('createTask — the default project', () => {
    it("defaults an omitted project to 'backlog'", () => {
      const id = createTask(paths, 'paul', 'acme', 'No project given');
      expect(read(id).project).toBe('backlog');
    });

    it("defaults to 'backlog' when the options bag is present but carries no project", () => {
      // The CLI hands `project: opts.project`, i.e. an explicit `undefined`,
      // rather than omitting the key. Destructuring defaults fire for both, but
      // an implementation that switched to `options.project || 'backlog'` vs
      // `?? 'backlog'` diverges on `''` — pinned separately below.
      const id = createTask(paths, 'paul', 'acme', 'Explicit undefined', { project: undefined, priority: 'high' });
      expect(read(id).project).toBe('backlog');
    });

    it('honours an explicitly supplied project', () => {
      const id = createTask(paths, 'paul', 'acme', 'Tagged', { project: 'sbc-edge' });
      expect(read(id).project).toBe('sbc-edge');
    });

    it("rejects project '' instead of recreating the untagged value the default exists to eliminate", () => {
      // A default fixes OMISSION, not empty INPUT. Without validation,
      // `--project ''` stays a supported way to write the exact `''` this
      // change removes.
      expect(() => createTask(paths, 'paul', 'acme', 'Empty tag', { project: '' })).toThrow(/non-empty/);
      expect(taskFiles()).toHaveLength(0);
    });

    it('rejects a whitespace-only project without leaving a task behind', () => {
      expect(() => createTask(paths, 'paul', 'acme', 'Padded tag', { project: '   ' }))
        .toThrow(/begin or end with whitespace/);
      expect(taskFiles()).toHaveLength(0);
    });

    it('validates BEFORE anything reaches disk — no task file, no audit log', () => {
      // Ordering claim from the source comment: validateProject runs before the
      // id is generated. A rejected create must not leave a partial task.
      expect(() => createTask(paths, 'paul', 'acme', 'Injected', { project: 'backlog\nforged' }))
        .toThrow(/printable ASCII/);
      expect(taskFiles()).toHaveLength(0);
      expect(existsSync(join(paths.taskDir, 'audit'))).toBe(false);

      // POSITIVE CONTROL for the two absence assertions above: the same helpers
      // DO observe a successful create, so "nothing on disk" is a real absence
      // and not a broken probe.
      const ok = createTask(paths, 'paul', 'acme', 'Accepted', { project: 'backlog' });
      expect(taskFiles()).toHaveLength(1);
      expect(existsSync(join(paths.taskDir, 'audit', `${ok}.jsonl`))).toBe(true);
    });

    it('accepts a 64-character project and rejects a 65-character one, end to end', () => {
      const at = 'x'.repeat(64);
      const id = createTask(paths, 'paul', 'acme', 'At the limit', { project: at });
      expect(read(id).project).toBe(at);

      expect(() => createTask(paths, 'paul', 'acme', 'Over the limit', { project: 'x'.repeat(65) }))
        .toThrow(/64 characters or fewer/);
      expect(taskFiles()).toHaveLength(1); // only the accepted one
    });
  });

  describe('updateTask — status is optional', () => {
    it('retags a task with no status supplied, leaving the status alone', () => {
      const id = createTask(paths, 'paul', 'acme', 'Retag me', { project: 'wrong' });
      updateTask(paths, id, 'in_progress');
      updateTask(paths, id, undefined, { project: 'right' });

      const t = read(id);
      expect(t.project).toBe('right');
      expect(t.status).toBe('in_progress'); // preserved, not reset, not undefined
    });

    it('never writes `undefined` into status on a field-only edit', () => {
      // The literal failure mode the `if (status !== undefined)` guard prevents:
      // an unconditional `task.status = status` serialises the key away entirely.
      const id = createTask(paths, 'paul', 'acme', 'Status integrity', { project: 'p' });
      updateTask(paths, id, undefined, { priority: 'urgent' });

      const raw = readFileSync(findTaskFile(paths, id)!, 'utf-8');
      expect(raw).not.toContain('"status":null');
      expect(JSON.parse(raw)).toHaveProperty('status', 'pending');
    });

    it('edits every non-status field on its own, with no status argument', () => {
      const id = createTask(paths, 'paul', 'acme', 'All fields', { project: 'p', assignee: 'paul' });
      updateTask(paths, id, undefined, { description: 'new desc' });
      updateTask(paths, id, undefined, { assigned_to: 'boris' });
      updateTask(paths, id, undefined, { priority: 'urgent' });

      const t = read(id);
      expect(t.description).toBe('new desc');
      expect(t.assigned_to).toBe('boris');
      expect(t.priority).toBe('urgent');
      expect(t.status).toBe('pending');
    });

    it('still applies a status and a field together', () => {
      const id = createTask(paths, 'paul', 'acme', 'Both', { project: 'old' });
      updateTask(paths, id, 'blocked', { project: 'new' });

      const t = read(id);
      expect(t.status).toBe('blocked');
      expect(t.project).toBe('new');
    });

    it('can retag a legacy task already carrying the empty-string project', () => {
      // Validation applies to INCOMING values only. Tasks already on disk with
      // the pre-change `''` must stay updatable, or the fix cannot repair the
      // very population that motivated it.
      const id = createTask(paths, 'paul', 'acme', 'Legacy', { project: 'tmp' });
      const file = findTaskFile(paths, id)!;
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), project: '' }));

      expect(() => updateTask(paths, id, undefined, { project: 'rescued' })).not.toThrow();
      expect(read(id).project).toBe('rescued');
    });
  });

  describe('updateTask — nothing to update', () => {
    it('throws when neither a status nor any field is supplied, and does not rewrite the file', () => {
      const id = createTask(paths, 'paul', 'acme', 'Untouched', { project: 'orig' });
      const before = readFileSync(findTaskFile(paths, id)!, 'utf-8');
      const auditBefore = rows(id).length;

      expect(() => updateTask(paths, id)).toThrow(/nothing to update/);

      // The guard must run BEFORE the read-modify-write, not merely report an
      // error after bumping `updated_at`.
      expect(readFileSync(findTaskFile(paths, id)!, 'utf-8')).toBe(before);
      expect(rows(id)).toHaveLength(auditBefore);
    });

    it('throws for an empty options bag too, not only for an omitted one', () => {
      const id = createTask(paths, 'paul', 'acme', 'Empty bag', { project: 'orig' });
      expect(() => updateTask(paths, id, undefined, {})).toThrow(/nothing to update/);
    });

    it('rejects the shape before touching the filesystem — a MISSING task id reports nothing-to-update', () => {
      // Pins the documented ordering: the argument-shape check depends on
      // nothing on disk and runs ahead of findTaskFile. If it moved below the
      // lookup, this would report "not found" instead, and the operator would
      // be sent to look for a task rather than at their own call site.
      expect(() => updateTask(paths, 'task_0000000000000_00000000'))
        .toThrow(/nothing to update/);
    });

    it('is satisfied by a field whose value equals what is on disk (supplied, not changed)', () => {
      // `--project p` on a task already in p is a legal instruction that happens
      // to be a no-op; it is NOT "nothing to update", which is an argument-shape
      // error. Conflating the two would make the guard reject valid calls.
      const id = createTask(paths, 'paul', 'acme', 'Same value', { project: 'p' });
      expect(() => updateTask(paths, id, undefined, { project: 'p' })).not.toThrow();
    });

    it('appends NO audit row for a supplied-but-unchanged FIELD edit — no contentless phantom entry', () => {
      // Guards the early return in `updateTask` that runs when the status was
      // omitted and nothing actually changed. Delete it and this call still
      // appends `{ ts, event: 'update', agent }`: no `from`/`to`, no `fields`,
      // no `changes`, no `edges` — a lifecycle event recording nothing, which
      // then reads as real work in `task-history` and in any audit rollup.
      //
      // Asserted on the audit CONTENTS, deliberately. The sibling test above
      // pins only `.not.toThrow()`, and a contentless row is silent on that
      // assertion — removing the guard throws nothing, so a no-throw check
      // cannot distinguish "correctly skipped" from "wrote a phantom".
      //
      // The row is contentless rather than malformed because the `statusSupplied &&`
      // arm on the from/to branch already prevents a `to: undefined`.
      const id = createTask(paths, 'paul', 'acme', 'Same value', { project: 'p' });
      expect(rows(id)).toHaveLength(0);

      updateTask(paths, id, undefined, { project: 'p' });

      expect(rows(id)).toHaveLength(0);
    });

    it('appends NO audit row for a supplied-but-unchanged EDGE edit either', () => {
      // Same guard, the other arm. Re-supplying an identical `blocked_by` list
      // is a no-op, and an edges-only call clears the argument-shape check, so
      // it reaches the audit append with `edgesChanged === false`.
      const blocker = createTask(paths, 'paul', 'acme', 'Blocker');
      const work = createTask(paths, 'paul', 'acme', 'Work');

      updateTask(paths, work, undefined, { blockedBy: [blocker] });
      const afterRealEdit = rows(work).length;
      expect(afterRealEdit).toBeGreaterThan(0); // the real edge edit DID log

      updateTask(paths, work, undefined, { blockedBy: [blocker] });

      expect(rows(work)).toHaveLength(afterRealEdit);
    });

    it("treats `description: ''` as a supplied field, not as absence", () => {
      // Empty string is falsy; a truthiness-based `editsAnyField` would call
      // this "nothing to update" and refuse a legitimate clear.
      const id = createTask(paths, 'paul', 'acme', 'Clear me', { description: 'text', project: 'p' });
      expect(() => updateTask(paths, id, undefined, { description: '' })).not.toThrow();
      expect(read(id).description).toBe('');
    });
  });

  describe('updateTask — project validation on the edit path', () => {
    it("rejects a retag to '' or to whitespace without mutating the task", () => {
      const id = createTask(paths, 'paul', 'acme', 'Guarded', { project: 'orig' });
      const before = readFileSync(findTaskFile(paths, id)!, 'utf-8');

      expect(() => updateTask(paths, id, undefined, { project: '' })).toThrow(/non-empty/);
      expect(() => updateTask(paths, id, undefined, { project: '  ' })).toThrow(/begin or end with whitespace/);
      expect(readFileSync(findTaskFile(paths, id)!, 'utf-8')).toBe(before);
    });

    it('rejects an injected line terminator even when a valid status rides along', () => {
      // The validation must not be skippable by pairing it with a legitimate
      // status change — the whole call has to fail, status included.
      const id = createTask(paths, 'paul', 'acme', 'Injection target', { project: 'original' });
      expect(() => updateTask(paths, id, 'completed', { project: 'backlog\nUpdated victim -> completed' }))
        .toThrow(/printable ASCII/);

      const t = read(id);
      expect(t.project).toBe('original');
      expect(t.status).toBe('pending'); // the status change died with the call
      expect(rows(id)).toHaveLength(0);
    });

    it("distinguishes an omitted project from an empty one (undefined vs '')", () => {
      const id = createTask(paths, 'paul', 'acme', 'Identity', { project: 'orig' });
      expect(() => updateTask(paths, id, 'pending', { project: '' })).toThrow(/non-empty/);
      expect(() => updateTask(paths, id, 'pending', {})).not.toThrow();
      expect(read(id).project).toBe('orig');
    });
  });

  // -------------------------------------------------------------------------
  // TaskAuditEntry.changes — the from/to values.
  //
  // `fields` (from PR #38) already said WHICH field moved. `changes` says what
  // it moved FROM, which is the difference between detecting a mis-retag and
  // being able to reverse it.
  // -------------------------------------------------------------------------

  describe('audit `changes` — from/to for the short scalar fields', () => {
    it('records project from and to, in that direction', () => {
      const id = createTask(paths, 'paul', 'acme', 'Audit retag', { project: 'before' });
      updateTask(paths, id, undefined, { project: 'after' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0].event).toBe('update');
      // Asserting the pair as one object pins DIRECTION: two separate
      // `toBe` checks pass identically against a from/to swap only if both are
      // written, which is exactly the plausible mutation here.
      expect(r[0].changes).toEqual({ project: { from: 'before', to: 'after' } });
      expect(r[0].fields).toEqual(['project']);
      // A field edit is not lifecycle work: no forged status transition.
      expect(r[0]).not.toHaveProperty('from');
      expect(r[0]).not.toHaveProperty('to');
    });

    it('records assigned_to and priority alongside project in one entry', () => {
      const id = createTask(paths, 'paul', 'acme', 'Multi', {
        project: 'p1', assignee: 'paul', priority: 'normal',
      });
      updateTask(paths, id, undefined, { project: 'p2', assigned_to: 'boris', priority: 'urgent' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0].changes).toEqual({
        assigned_to: { from: 'paul', to: 'boris' },
        project: { from: 'p1', to: 'p2' },
        priority: { from: 'normal', to: 'urgent' },
      });
    });

    it('EXCLUDES description from `changes` while still naming it in `fields`', () => {
      // The deliberate omission: description is unbounded free text, and
      // copying both versions into an append-only log on every edit would let
      // one task's history outgrow every other file in the tree. Nothing in
      // TaskAuditEntry's type stops an implementation from including it, so it
      // has to be asserted as an absence.
      const id = createTask(paths, 'paul', 'acme', 'Desc audit', {
        project: 'p1', description: 'the old description',
      });
      updateTask(paths, id, undefined, { description: 'the new description', project: 'p2' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      // POSITIVE CONTROL inside the same entry: `project` IS present, so the
      // absence of `description` is attributable to the exclusion rule and not
      // to `changes` being empty or unwritten.
      expect(Object.keys(r[0].changes!)).toEqual(['project']);
      expect(r[0].changes).not.toHaveProperty('description');
      expect(r[0].fields).toEqual(['description', 'project']);

      // And the text itself must not appear anywhere in the audit line — an
      // implementation that stored it under some other key is the same bloat.
      const raw = readFileSync(join(paths.taskDir, 'audit', `${id}.jsonl`), 'utf-8');
      expect(raw).not.toContain('the old description');
      expect(raw).not.toContain('the new description');
    });

    it('omits `changes` entirely when description is the ONLY field that changed', () => {
      const id = createTask(paths, 'paul', 'acme', 'Desc only', { description: 'old', project: 'p' });
      updateTask(paths, id, undefined, { description: 'new' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0].fields).toEqual(['description']);
      expect(r[0]).not.toHaveProperty('changes');
    });

    it('omits a SUPPLIED but unchanged field from `changes`', () => {
      const id = createTask(paths, 'paul', 'acme', 'Same tag', { project: 'p', priority: 'normal' });
      updateTask(paths, id, undefined, { project: 'p', priority: 'high' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0].changes).toEqual({ priority: { from: 'normal', to: 'high' } });
      expect(r[0].fields).toEqual(['priority']);
    });

    it("records a legacy '' project as the empty string it really is, not as a placeholder", () => {
      const id = createTask(paths, 'paul', 'acme', 'Legacy audit', { project: 'tmp' });
      const file = findTaskFile(paths, id)!;
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), project: '' }));

      updateTask(paths, id, undefined, { project: 'backlog' });

      expect(rows(id)[0].changes).toEqual({ project: { from: '', to: 'backlog' } });
    });

    it('emits `changes` beside a real status transition when both happen at once', () => {
      const id = createTask(paths, 'paul', 'acme', 'Both audit', { project: 'p1' });
      updateTask(paths, id, 'in_progress', { project: 'p2' });

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0].from).toBe('pending');
      expect(r[0].to).toBe('in_progress');
      expect(r[0].changes).toEqual({ project: { from: 'p1', to: 'p2' } });
    });

    it('writes no `changes` for a status-only update', () => {
      const id = createTask(paths, 'paul', 'acme', 'Status only', { project: 'keepme' });
      updateTask(paths, id, 'in_progress');

      const r = rows(id);
      expect(r).toHaveLength(1);
      expect(r[0]).not.toHaveProperty('changes');
      expect(r[0]).not.toHaveProperty('fields');
      expect(read(id).project).toBe('keepme');
    });
  });
});
