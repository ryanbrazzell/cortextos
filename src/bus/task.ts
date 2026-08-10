import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { Task, Priority, TaskStatus, BusPaths, StaleTaskReport, ArchiveReport } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomDigits } from '../utils/random.js';
import { validatePriority, validateTaskId } from '../utils/validate.js';
import { logEvent } from './event.js';

/**
 * Coerce a `blocked_by`/`blocks` field to the `string[]` the type
 * declares. Task JSON is hand-editable and was hand-edited in the
 * field: a single id written as a bare string instead of a one-element
 * array type-checks nowhere but parses fine, and every consumer here
 * iterates the value directly. `for (const id of "task_123")` yields
 * CHARACTERS, so a string-shaped blocker made `check-deps` report 27
 * missing dependencies named "t", "a", "s", "k"... and — the damaging
 * one — kept the real id out of compactTasks' still-needed-as-blocker
 * set, silently defeating the guard that stops a live blocker being
 * archived. Normalising on read makes that shape degrade to the
 * obvious interpretation instead of shredding it.
 */
function normalizeEdgeList(value: string[] | string | undefined): string[] {
  if (!value) return [];
  return typeof value === 'string' ? [value] : value;
}

/**
 * Create a new task. Identical JSON format to bash create-task.sh.
 */
export function createTask(
  paths: BusPaths,
  agentName: string,
  org: string,
  title: string,
  options: {
    description?: string;
    assignee?: string;
    priority?: Priority;
    project?: string;
    needsApproval?: boolean;
    dueDate?: string;
    blockedBy?: string[];
    blocks?: string[];
  } = {},
): string {
  const {
    description = '',
    assignee = agentName,
    priority = 'normal',
    project = '',
    needsApproval = false,
    dueDate = '',
    blockedBy = [],
    blocks = [],
  } = options;

  validatePriority(priority);

  const epoch = Date.now();
  // 8 digits: same-millisecond collision probability is ~1e-8 instead of ~1e-3.
  // Two createTask calls in the same ms with a 3-digit suffix collided in CI
  // (run 25618845172), making the new task's id equal to its declared blocker
  // and tripping detectCycleOrThrow with "X ultimately blocks itself via X".
  const rand = randomDigits(8);
  const taskId = `task_${epoch}_${rand}`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Dependency validation FIRST — a cycle must never be allowed to
  // leave partial state on disk. Earlier iteration wrote the task
  // JSON before detectCycleOrThrow ran, so a failed cycle check left
  // a dangling task with a one-way edge and no symmetric peer update.
  // Order is: validate → mutate peers → write task → audit. The
  // cycle walker gets a `virtual` description of the not-yet-written
  // task so chains that pass through it are still detectable.
  validateNewPeerIds(blockedBy, blocks);

  const virtualTask = { id: taskId, blocked_by: blockedBy };
  if (blockedBy.length) detectCycleOrThrow(paths, taskId, blockedBy, virtualTask);
  if (blocks.length) {
    for (const downId of blocks) detectCycleOrThrow(paths, downId, [taskId], virtualTask);
  }

  // Peers BEFORE the task itself, so a failed create commits no orphan task
  // under an assignee who is never notified (the id is returned at the very
  // end, so a throw here would also swallow it).
  //
  // Every applied edge is then ROLLED BACK if any peer fails. The earlier
  // claim here — that a leftover edge is a tolerated dangling ref and a
  // re-run is a genuine retry — was FALSE for create, and the difference is
  // `taskId`: updateTask is handed a stable id, so its retry recomputes the
  // same diff and the idempotent helpers converge. Here the id is GENERATED
  // per call. A failed create's id never reaches disk and never will, so a
  // peer left pointing at it is blocked by a task that cannot be created,
  // repaired, or completed; check-deps reports it as an open dependency
  // while `listTasks --respect-deps` ignores missing ids and shows the same
  // task as unblocked. Re-running mints a DIFFERENT id, adding a second
  // edge beside the stranded one instead of replacing it.
  //
  // Rollback removes ONLY edges this call actually inserted (`changed`), not
  // every edge it found in place. An earlier version recorded no-ops too and
  // justified it with "the id is fresh, so nothing can already reference it".
  // That argument rests on uniqueness the generator does not provide — the id
  // is `task_<epoch_ms>_<8 random digits>` with no existence check, and this
  // module has already seen a same-millisecond collision in CI. On a collision
  // the no-op branch is reachable against a REAL pre-existing edge belonging
  // to the colliding task, and blanket rollback would delete it. Tracking the
  // mutation instead makes rollback correct without depending on the id being
  // unique at all, which is the weaker and therefore safer premise.
  const edgeFailures: string[] = [];
  const applied: Array<{ peerId: string; field: 'blocks' | 'blocked_by' }> = [];
  for (const depId of blockedBy) {
    const outcome = addSymmetricEdge(paths, depId, 'blocks', taskId);
    if (!outcome.ok) edgeFailures.push(outcome.reason);
    else if (outcome.changed) applied.push({ peerId: depId, field: 'blocks' });
  }
  for (const downId of blocks) {
    const outcome = addSymmetricEdge(paths, downId, 'blocked_by', taskId);
    if (!outcome.ok) edgeFailures.push(outcome.reason);
    else if (outcome.changed) applied.push({ peerId: downId, field: 'blocked_by' });
  }
  if (edgeFailures.length) {
    edgeFailures.push(...rollbackAppliedEdges(paths, taskId, applied));
    throwIfCreateEdgesFailed(taskId, edgeFailures);
  }

  const task: Task = {
    id: taskId,
    title,
    description,
    type: 'agent',
    needs_approval: needsApproval,
    status: 'pending',
    assigned_to: assignee,
    created_by: agentName,
    org,
    priority,
    project,
    kpi_key: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    due_date: dueDate || null,
    archived: false,
    ...(blockedBy.length ? { blocked_by: [...blockedBy] } : {}),
    ...(blocks.length ? { blocks: [...blocks] } : {}),
  };

  // The task's OWN write gets the same rollback the peer loop gets. Rollback
  // used to run only inside `if (edgeFailures.length)`, so the one path where
  // every peer SUCCEEDED and this write then threw walked straight out of the
  // function with `applied` edges still on disk, pointing at an id that never
  // reached it — exactly the stranded-peer state the loop above exists to
  // prevent, reached through the only door left open. Found in round 5; it is
  // the residual flagged in round 3 as the "phantom blocker" trade and then
  // left alone for two rounds because it was already written down.
  try {
    ensureDir(paths.taskDir);
    atomicWriteSync(join(paths.taskDir, `${taskId}.json`), JSON.stringify(task));
  } catch (err) {
    throwTaskWriteFailed(taskId, err, rollbackAppliedEdges(paths, taskId, applied));
  }

  // DELIBERATELY OUTSIDE the guard above, and it must stay that way.
  //
  // Accuracy note (round 6): as this file stands the hazard is not reachable —
  // appendTaskAudit swallows its own filesystem failures, and its one uncaught
  // call, validateTaskId, cannot reject an id this function just generated. So
  // this placement is DEFENSIVE, not a fix for a live bug; do not read it as
  // evidence that an audit failure has ever escaped here.
  //
  // It still must not move. By this line the task file IS on disk, so if that
  // internal catch is ever narrowed or removed, a rollback wired in here would
  // strip reverse edges from a task that genuinely exists and still declares
  // those edges in its own JSON — promoting a lost audit line into real graph
  // corruption. Outside the guard, that stays correct without depending on
  // appendTaskAudit's internals, which is the weaker and safer premise.
  appendTaskAudit(paths, taskId, { event: 'create', agent: agentName, to: 'pending', note: title });

  return taskId;
}

/**
 * Outcome of one peer-edge mutation. A missing peer counts as `ok`: a
 * dangling reference is legal here (detectCycleOrThrow calls it "not a
 * cycle, just a dangling ref" and checkTaskDependencies reports it as
 * `missing`). Anything else — an unreadable, corrupt or unwritable peer
 * file — is a real failure the caller MUST NOT report as success.
 */
type EdgeOutcome = { ok: true; changed: boolean } | { ok: false; reason: string };

const edgeFailure = (
  taskId: string,
  op: 'add' | 'remove',
  field: 'blocks' | 'blocked_by',
  err: unknown,
): EdgeOutcome => ({
  ok: false,
  // Name the operation and the field, not just the peer: with several
  // mutations in one command, "peer X failed" does not tell an operator
  // WHICH reverse edge to repair — least of all when the same peer is
  // touched through both directions in the same edit.
  reason: `${op} ${taskId}.${field} (${err instanceof Error ? err.message : String(err)})`,
});

/**
 * Mutate an existing task to add an edge to its blocks/blocked_by list.
 * No-op if the peer id is already present. Used to maintain symmetric
 * edges when a new task declares its dependencies.
 *
 * Returns an outcome rather than swallowing: a half-applied edge leaves
 * an ASYMMETRIC graph, and the swallowed-removal case leaves a stale
 * reverse edge that reads as a live dependency and pins the peer against
 * compaction indefinitely. Reporting success over that is the exact
 * silent-failure class this module is meant to eliminate.
 */
function addSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): EdgeOutcome {
  let filePath: string | null;
  // findTaskFile validates the id and THROWS on a malformed one, so it has
  // to be inside the guard too — it used to sit outside and escape.
  try {
    filePath = findTaskFile(paths, taskId);
  } catch (err) {
    return edgeFailure(taskId, 'add', field, err);
  }
  // Peer task missing — surfaced at resolution time. `changed: false`: there
  // is no file, so nothing was inserted and there is nothing to roll back.
  if (!filePath) return { ok: true, changed: false };
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = normalizeEdgeList(task[field]);
    // `changed` reports whether THIS call inserted the edge. An edge that was
    // already present is a no-op, and a caller rolling back must not remove
    // it: it belongs to whatever put it there, not to us.
    if (list.includes(peerId)) return { ok: true, changed: false };
    task[field] = [...list, peerId];
    atomicWriteSync(filePath, JSON.stringify(task));
    return { ok: true, changed: true };
  } catch (err) {
    return edgeFailure(taskId, 'add', field, err);
  }
}

/**
 * Inverse of `addSymmetricEdge`: drop `peerId` from the peer's
 * blocks/blocked_by list. Used when an update REPLACES a dependency
 * list — without this the old peer keeps a reverse edge pointing at a
 * task that no longer declares it, which reads as a live dependency to
 * compactTasks and pins the peer in place forever.
 */
function removeSymmetricEdge(
  paths: BusPaths,
  taskId: string,
  field: 'blocks' | 'blocked_by',
  peerId: string,
): EdgeOutcome {
  let filePath: string | null;
  try {
    filePath = findTaskFile(paths, taskId);
  } catch (err) {
    return edgeFailure(taskId, 'remove', field, err);
  }
  if (!filePath) return { ok: true, changed: false };
  try {
    const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
    const list = normalizeEdgeList(task[field]);
    if (!list.includes(peerId)) return { ok: true, changed: false };
    const next = list.filter(id => id !== peerId);
    if (next.length) task[field] = next;
    else delete task[field];
    atomicWriteSync(filePath, JSON.stringify(task));
    return { ok: true, changed: true };
  } catch (err) {
    return edgeFailure(taskId, 'remove', field, err);
  }
}

/**
 * Reject malformed peer ids BEFORE any file is written.
 *
 * The cycle walk resolves every `blocked_by` id as it walks, so that
 * direction was validated incidentally. Nothing ever resolves a `blocks`
 * id — the walk starts at the task itself and returns via the `virtual`
 * short-circuit — so an invalid downstream id first reached findTaskFile
 * (and its validateTaskId throw) during peer maintenance, i.e. AFTER the
 * task file had already been committed. That left the rejected dependency
 * on disk with no audit entry, from a command that reported failure.
 *
 * Only ids the CALLER supplied are checked. Ids already on disk are left
 * alone deliberately: failing the whole update on a pre-existing malformed
 * edge would make a hand-corrupted task impossible to repair through the
 * very command you would use to repair it.
 */
function validateNewPeerIds(...lists: Array<string[] | undefined>): void {
  for (const list of lists) {
    if (!list) continue;
    for (const id of list) validateTaskId(id);
  }
}

/**
 * Turn collected peer-edge failures into one loud, actionable error.
 *
 * Called BEFORE the task's own write, so the advice it gives is true: the
 * task is unchanged and re-running really does retry the failed peers.
 * An earlier version threw after the write and still said "re-run", which
 * was actively harmful — the retry saw its own committed state, computed
 * an empty diff, and reported success over a graph it had not repaired.
 *
 * Peers that already succeeded are left applied rather than rolled back:
 * both helpers are idempotent, so the retry converges on them harmlessly,
 * and an add is a no-op the reconciliation will simply re-affirm.
 *
 * That rationale depends on `taskId` being STABLE across the retry, which
 * is true of updateTask (the caller supplies it) and false of createTask
 * (it is generated per call). createTask therefore rolls back and uses
 * `throwIfCreateEdgesFailed` instead — do not reuse this one there.
 */
function throwIfEdgesFailed(taskId: string, failures: string[]): void {
  if (!failures.length) return;
  throw new Error(
    `Task ${taskId} NOT updated: ${failures.length} symmetric edge update(s) failed — ` +
    `${failures.join('; ')}. The task itself is unchanged; any peer edges that did apply are ` +
    `idempotent. Fix the peer task file(s) and re-run this command to complete the edit.`,
  );
}

/**
 * Undo the peer edges a failing createTask already applied.
 *
 * Returns the reasons for any removals that themselves failed, so the
 * caller can name them in the thrown error. A rollback that silently
 * fails would recreate the exact stranded-edge state this exists to
 * prevent, while reporting a clean abort — the same swallow-and-claim-
 * success shape the module is meant to eliminate. Best-effort by
 * necessity: the remaining peers are still attempted after one fails,
 * because a peer we CAN repair should not be left broken by one we
 * cannot.
 */
function rollbackAppliedEdges(
  paths: BusPaths,
  taskId: string,
  applied: Array<{ peerId: string; field: 'blocks' | 'blocked_by' }>,
): string[] {
  const failures: string[] = [];
  for (const { peerId, field } of applied) {
    const outcome = removeSymmetricEdge(paths, peerId, field, taskId);
    if (!outcome.ok) failures.push(`ROLLBACK FAILED: ${outcome.reason}`);
  }
  return failures;
}

/**
 * The one instruction that must read identically no matter WHICH createTask
 * failure produced it: some peer still points at an id that will never exist,
 * and only a human can remove it. Shared so the two throw sites cannot drift
 * into describing the same manual repair two different ways.
 */
const strandedByHandTail = (taskId: string, stranded: number): string =>
  `${stranded} peer edge(s) could NOT be rolled back and still reference ${taskId}, ` +
  `which will never exist — remove that id from those peer files by hand.`;

/**
 * createTask's OTHER failure mode: every peer edge applied cleanly and the
 * task's own write then failed.
 *
 * Deliberately not routed through `throwIfCreateEdgesFailed`. That helper
 * reports a count of failed edge updates, and here that count is ZERO — the
 * edges all worked, the file write did not. Reusing it would print
 * "0 symmetric edge update(s) failed" beside a real failure and send the
 * operator looking at peer files that are fine.
 *
 * Returns `never`: the caller's `try` block must not fall through to the
 * audit append after this runs.
 */
function throwTaskWriteFailed(taskId: string, err: unknown, rollbackFailures: string[]): never {
  const reason = err instanceof Error ? err.message : String(err);
  const tail = rollbackFailures.length
    ? strandedByHandTail(taskId, rollbackFailures.length)
    : `No task was created and all applied peer edges were rolled back; ` +
      `create the task again (it will get a new id).`;
  throw new Error(
    `Task ${taskId} NOT created: writing the task file failed — ${reason}. ` +
    (rollbackFailures.length ? `${rollbackFailures.join('; ')}. ` : '') +
    tail,
  );
}

/**
 * createTask's counterpart to `throwIfEdgesFailed`.
 *
 * Says "create a new task" rather than "re-run this command to complete
 * the edit": the id in this message is dead, so advice phrased around
 * completing THIS task would be false. When rollback also failed the
 * message must be explicit that manual repair is needed, because that is
 * the one path where a peer really is left pointing at a task that will
 * never exist.
 */
function throwIfCreateEdgesFailed(taskId: string, failures: string[]): void {
  if (!failures.length) return;
  const stranded = failures.filter(f => f.startsWith('ROLLBACK FAILED:'));
  const tail = stranded.length
    ? strandedByHandTail(taskId, stranded.length)
    : `No task was created and all applied peer edges were rolled back; fix the peer task ` +
      `file(s) and create the task again (it will get a new id).`;
  throw new Error(
    `Task ${taskId} NOT created: ${failures.length - stranded.length} symmetric edge update(s) ` +
    `failed — ${failures.join('; ')}. ${tail}`,
  );
}

/**
 * Walk the dependency DAG rooted at `newTaskId` depth-first along its
 * proposed `blocked_by` edges and throw if the walk re-enters
 * `newTaskId`. Only checks the `blocked_by` direction — cycles are
 * topologically symmetric, so walking one direction catches them all.
 *
 * `virtual` lets the caller describe a task that does not yet exist
 * on disk (the task being created). Without this, running the check
 * BEFORE the task JSON is written would miss cycles that pass
 * through the new task itself.
 */
function detectCycleOrThrow(
  paths: BusPaths,
  newTaskId: string,
  initialBlockers: string[],
  virtual?: { id: string; blocked_by: string[] },
): void {
  const seen = new Set<string>();
  const stack = [...initialBlockers];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === newTaskId) {
      throw new Error(`Dependency cycle: ${newTaskId} ultimately blocks itself via ${cur}`);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (virtual && cur === virtual.id) {
      if (virtual.blocked_by.length) stack.push(...virtual.blocked_by);
      continue;
    }
    const filePath = findTaskFile(paths, cur);
    if (!filePath) continue; // Missing peer is not a cycle, just a dangling ref.
    try {
      const task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
      stack.push(...normalizeEdgeList(task.blocked_by));
    } catch { /* skip */ }
  }
}

/**
 * Resolve blockers for `taskId`: returns the list of tasks in its
 * `blocked_by` that are NOT yet completed. Empty list = good to go.
 * A missing peer is reported as `{ id, status: 'missing' }` so callers
 * can distinguish "dependency cleared" from "dependency references a
 * task that no longer exists".
 */
export function checkTaskDependencies(
  paths: BusPaths,
  taskId: string,
): Array<{ id: string; status: TaskStatus | 'missing' }> {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) return [];
  let task: Task;
  try { task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task; }
  catch { return []; }
  const deps = normalizeEdgeList(task.blocked_by);
  const open: Array<{ id: string; status: TaskStatus | 'missing' }> = [];
  for (const depId of deps) {
    const depPath = findTaskFile(paths, depId);
    if (!depPath) { open.push({ id: depId, status: 'missing' }); continue; }
    try {
      const dep = JSON.parse(readFileSync(depPath, 'utf-8')) as Task;
      if (dep.status !== 'completed') open.push({ id: depId, status: dep.status });
    } catch {
      open.push({ id: depId, status: 'missing' });
    }
  }
  return open;
}

/**
 * Find the on-disk path of a task file by ID, supporting cross-org lookup.
 *
 * cortextOS's standard dispatch pattern is an orchestrator in one org
 * filing tasks that get assigned to specialists in other orgs. Before
 * this helper existed, updateTask
 * and completeTask hardcoded `join(paths.taskDir, taskId + '.json')` — which
 * points at the CURRENT agent's org tasks dir — so the specialist could not
 * drive the lifecycle of any task that was filed from a sibling org. Every
 * cross-org assignment required a manual workaround dance where the filer
 * ran update/complete on behalf of the assignee.
 *
 * This helper fixes that by using a two-tier lookup:
 *
 *   1. Fast path: check the caller's OWN org tasks dir first. Most tasks
 *      live there and this check pays zero scan cost when it hits.
 *   2. Fallback: scan every sibling org under `<ctxRoot>/orgs/*` for a
 *      matching task file. Only runs when the fast path missed, so
 *      same-org operations take no perf hit.
 *
 * Task IDs are generated as `task_<epoch_ms>_<3digit_random>` so real
 * collisions are effectively impossible — but if the scan ever finds the
 * same ID in multiple orgs (e.g. due to a bug in ID generation or a manual
 * file copy), we warn loudly naming the task ID, the match count, AND the
 * org names so an operator can investigate without having to grep the IDs
 * themselves. We still return the first match and keep operations flowing;
 * erroring on a theoretical collision would be worse UX than the warn.
 *
 * Exported because the helper is a useful primitive for any future caller
 * that needs cross-org task lookup (e.g. a hypothetical `get-task` command,
 * task-graph visualization, or cross-org list-tasks flag).
 */
export function findTaskFile(paths: BusPaths, taskId: string): string | null {
  // Reject path-traversal task ids before they reach any join() below. This is
  // the chokepoint for updateTask/claimTask/completeTask/checkTaskDependencies.
  validateTaskId(taskId);
  // Fast path: same-org lookup.
  const sameOrg = join(paths.taskDir, `${taskId}.json`);
  if (existsSync(sameOrg)) return sameOrg;

  // Fallback: cross-org scan.
  const orgsRoot = join(paths.ctxRoot, 'orgs');
  const matches: Array<{ path: string; org: string }> = [];
  try {
    for (const entry of readdirSync(orgsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(orgsRoot, entry.name, 'tasks', `${taskId}.json`);
      if (existsSync(candidate)) {
        matches.push({ path: candidate, org: entry.name });
      }
    }
  } catch {
    return null; // orgs/ missing or unreadable
  }

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const orgList = matches.map((m) => m.org).join(', ');
    console.warn(
      `[task] Ambiguous task id ${taskId}: found in ${matches.length} orgs (${orgList}). ` +
      `Operating on the first match in org '${matches[0].org}'. ` +
      `Review task ID generation if this recurs.`,
    );
  }
  return matches[0].path;
}

/**
 * Update a task's status. Matches bash update-task.sh behavior, with the
 * cross-org fallback from findTaskFile so an assignee in one org can drive
 * the lifecycle of a task filed by an orchestrator in a sibling org.
 */
export function updateTask(
  paths: BusPaths,
  taskId: string,
  status: TaskStatus,
  options: {
    blockedBy?: string[];
    blocks?: string[];
    description?: string;
    assigned_to?: string;
    project?: string;
    priority?: Priority;
  } = {},
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  // `undefined` = leave the edge list alone; a provided array REPLACES
  // it (same set-the-whole-list semantics as create-task's flags).
  const { blockedBy, blocks } = options;
  const editsEdges = blockedBy !== undefined || blocks !== undefined;

  // Before ANY write: a malformed peer id must fail the command outright,
  // not surface from inside peer maintenance after the task is committed.
  validateNewPeerIds(blockedBy, blocks);

  // Same pre-write contract for priority. The CLI's `as Priority` cast is
  // erased at runtime and validates nothing, so an invalid value would
  // otherwise reach disk. Rejecting here also protects the peer writes
  // below, which land on OTHER task files before this task is committed.
  if (options.priority !== undefined) validatePriority(options.priority);

  let task: Task;
  let oldBlockedBy: string[] = [];
  let oldBlocks: string[] = [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    task = JSON.parse(content);
    oldBlockedBy = normalizeEdgeList(task.blocked_by);
    oldBlocks = normalizeEdgeList(task.blocks);

    // Validate BEFORE any write, for the same reason createTask does:
    // a rejected cycle must not leave a half-applied edge on disk. The
    // walker reads this task's OLD list off disk when it reaches it, so
    // hand it a `virtual` view carrying the PROPOSED list instead.
    if (editsEdges) {
      const nextBlockedBy = blockedBy ?? oldBlockedBy;
      const virtual = { id: taskId, blocked_by: nextBlockedBy };
      if (nextBlockedBy.length) detectCycleOrThrow(paths, taskId, nextBlockedBy, virtual);
      for (const downId of blocks ?? oldBlocks) {
        detectCycleOrThrow(paths, downId, [taskId], virtual);
      }
    }
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }

  // Peer maintenance BEFORE the task's own write, and this ordering is
  // load-bearing rather than cosmetic.
  //
  // Which peers to touch is derived by diffing the requested lists against
  // the task's CURRENT on-disk lists. Committing the task first therefore
  // destroyed the very state that diff reads: on a retry `oldBlockedBy`
  // already equalled the requested list, the diff came out empty, no peer
  // write was re-attempted, and the command reported SUCCESS over a still
  // asymmetric graph — while its own error message had told the operator to
  // re-run. Silent corruption that a retry appears to fix is worse than the
  // swallowed error this replaced.
  //
  // With the write last, a failure leaves the task untouched, so the retry
  // recomputes the identical diff and genuinely repairs. Both edge helpers
  // are idempotent (add no-ops when present, remove no-ops when absent), so
  // re-running over already-applied peers is safe.
  const edgeFailures: string[] = [];
  const record = (outcome: EdgeOutcome) => { if (!outcome.ok) edgeFailures.push(outcome.reason); };

  if (blockedBy !== undefined) {
    for (const depId of blockedBy.filter(id => !oldBlockedBy.includes(id))) {
      record(addSymmetricEdge(paths, depId, 'blocks', taskId));
    }
    for (const depId of oldBlockedBy.filter(id => !blockedBy.includes(id))) {
      record(removeSymmetricEdge(paths, depId, 'blocks', taskId));
    }
  }
  if (blocks !== undefined) {
    for (const downId of blocks.filter(id => !oldBlocks.includes(id))) {
      record(addSymmetricEdge(paths, downId, 'blocked_by', taskId));
    }
    for (const downId of oldBlocks.filter(id => !blocks.includes(id))) {
      record(removeSymmetricEdge(paths, downId, 'blocked_by', taskId));
    }
  }
  throwIfEdgesFailed(taskId, edgeFailures);

  const prevStatus = task.status;
  const assignee = task.assigned_to;

  // Which scalar fields were supplied AND actually differ from disk.
  // `--project x` on a task already in project x is a no-op, not an edit:
  // it must not show up in the audit entry, and must not on its own cause
  // a write. Every guard below is `!== undefined`, never truthiness —
  // `--desc ""` is a legitimate clear and an empty string is falsy.
  const changedFields: string[] = [];
  if (options.description !== undefined && task.description !== options.description) changedFields.push('description');
  if (options.assigned_to !== undefined && task.assigned_to !== options.assigned_to) changedFields.push('assigned_to');
  if (options.project !== undefined && task.project !== options.project) changedFields.push('project');
  if (options.priority !== undefined && task.priority !== options.priority) changedFields.push('priority');

  // Edges are "supplied" whenever the flag appears, but only CHANGED when
  // the resulting list actually differs from what is on disk.
  // Order carries no meaning here — the add/remove helpers above operate by
  // membership — so `--blocked-by B,A` against a stored [A,B] is a no-op,
  // not an edit. Compare as multisets so a pure reorder neither forces a
  // write nor advances `updated_at`.
  const sameList = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
  };
  const nextBlockedBy = blockedBy ?? oldBlockedBy;
  const nextBlocks = blocks ?? oldBlocks;
  const changedEdges: string[] = [];
  if (!sameList(nextBlockedBy, oldBlockedBy)) changedEdges.push('blocked_by');
  if (!sameList(nextBlocks, oldBlocks)) changedEdges.push('blocks');
  const edgesChanged = changedEdges.length > 0;

  const statusChanged = prevStatus !== status;
  const fieldsChanged = changedFields.length > 0;

  try {
    // Previously this block wrote unconditionally, so even a pure no-op
    // advanced `updated_at`. Skipping the write when nothing changed keeps
    // `updated_at` meaning "last time this task actually changed".
    if (statusChanged || edgesChanged || fieldsChanged) {
      task.status = status;
      if (blockedBy !== undefined) {
        if (blockedBy.length) task.blocked_by = [...blockedBy];
        else delete task.blocked_by;
      }
      if (blocks !== undefined) {
        if (blocks.length) task.blocks = [...blocks];
        else delete task.blocks;
      }
      if (options.description !== undefined) task.description = options.description;
      if (options.assigned_to !== undefined) task.assigned_to = options.assigned_to;
      if (options.project !== undefined) task.project = options.project;
      if (options.priority !== undefined) task.priority = options.priority;
      task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      atomicWriteSync(filePath, JSON.stringify(task));
    }
  } catch (err) {
    throw new Error(`Task ${taskId} update failed: ${err}`);
  }

  // NO non-status edit may forge a `pending -> pending` transition that reads
  // as real lifecycle work in the audit log — that applies to edge edits just
  // as much as to scalar ones. `from`/`to` are emitted when the status
  // changed, and for a pure no-op to preserve the previous behavior.
  // `fields`/`edges` name what actually moved, so dropping the forged
  // transition never leaves an entry that says nothing at all.
  const entry: Omit<TaskAuditEntry, 'ts'> = { event: 'update', agent: assignee || 'unknown' };
  if (statusChanged || (!fieldsChanged && !edgesChanged)) {
    entry.from = prevStatus;
    entry.to = status;
  }
  if (fieldsChanged) entry.fields = [...changedFields];
  if (edgesChanged) entry.edges = [...changedEdges];
  appendTaskAudit(paths, taskId, entry);
}

/**
 * One audit entry written to a task's append-only JSONL log. Every
 * status transition, claim, and completion emits one of these so the
 * full lifecycle can be replayed from disk.
 */
export interface TaskAuditEntry {
  ts: string; // ISO 8601
  event: 'create' | 'claim' | 'update' | 'complete';
  agent: string; // who caused the event
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
  /**
   * Names of the scalar fields changed by a field edit (description,
   * assigned_to, project, priority). Present only when at least one
   * actually changed; a field-only edit omits `from`/`to` entirely so it
   * cannot be replayed as a status transition.
   */
  fields?: string[];
  /**
   * Names of the edge lists changed by a dependency edit (`blocked_by`,
   * `blocks`). Same contract as `fields`: present only when the list
   * actually changed, and an edge-only edit omits `from`/`to` so it cannot
   * be replayed as a status transition either.
   */
  edges?: string[];
}

/**
 * Append one audit line to `<taskDir>/audit/<taskId>.jsonl`. Uses
 * appendFileSync so concurrent writers each get O_APPEND semantics on
 * POSIX — partial interleaving at the sub-line level is possible on
 * some filesystems for lines over PIPE_BUF, but our entries are
 * ~200 bytes, comfortably under the 4096-byte atomicity bound.
 *
 * Best-effort: a failing audit write never blocks the caller. The
 * audit log is an observability aid, not the source of truth.
 */
export function appendTaskAudit(
  paths: BusPaths,
  taskId: string,
  entry: Omit<TaskAuditEntry, 'ts'>,
): void {
  // Validate before the try so a traversal id is rejected loudly rather than
  // swallowed by the audit-never-blocks catch below.
  validateTaskId(taskId);
  try {
    const auditDir = join(paths.taskDir, 'audit');
    ensureDir(auditDir);
    const line: TaskAuditEntry = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      ...entry,
    };
    appendFileSync(join(auditDir, `${taskId}.jsonl`), JSON.stringify(line) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Never block a real operation on audit-log write failure.
  }
}

/**
 * Read all audit entries for a task in write-order. Returns empty
 * array if no audit log exists. Corrupt lines are skipped so a
 * partially-written line (rare: write crashed mid-line) does not
 * block history replay of surrounding entries.
 */
export function readTaskAudit(
  paths: BusPaths,
  taskId: string,
): TaskAuditEntry[] {
  validateTaskId(taskId);
  const path = join(paths.taskDir, 'audit', `${taskId}.jsonl`);
  if (!existsSync(path)) return [];
  const entries: TaskAuditEntry[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed) as TaskAuditEntry); } catch { /* skip corrupt */ }
  }
  return entries;
}

/**
 * Atomically claim a task for an agent. Prevents two agents from double-
 * picking the same task — a race that previously could happen because
 * `update-task <id> in_progress` was a read-modify-write with no lock.
 *
 * Mechanism: write a companion claim-lock file via the POSIX O_EXCL
 * path (`writeFileSync` with `flag: 'wx'`). The first writer wins; the
 * second gets EEXIST and claimTask throws "already claimed by X". Only
 * after the lock is taken do we flip the task's status + assigned_to.
 *
 * Re-claiming a task you already own is idempotent (returns the task
 * without mutation). Claiming a non-pending task is rejected with a
 * message that names the current status so operators can diagnose.
 *
 * Claim-lock files live at `<taskDir>/.claims/<taskId>.claim` and carry
 * `<agent>\t<iso8601>` for audit. A later compaction pass can prune
 * claim-locks for completed tasks; for now they are append-only.
 */
export function claimTask(
  paths: BusPaths,
  taskId: string,
  agent: string,
): Task {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }

  let task: Task;
  try {
    task = JSON.parse(readFileSync(filePath, 'utf-8')) as Task;
  } catch (err) {
    throw new Error(`Task ${taskId} claim failed (unreadable): ${err}`);
  }

  const claimsDir = join(paths.taskDir, '.claims');
  ensureDir(claimsDir);
  const claimPath = join(claimsDir, `${taskId}.claim`);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Idempotency: if this agent already owns the claim, succeed silently.
  if (existsSync(claimPath)) {
    try {
      const owner = readFileSync(claimPath, 'utf-8').split('\t')[0];
      if (owner === agent) {
        return task;
      }
      throw new Error(
        `Task ${taskId} already claimed by ${owner} (current status=${task.status})`,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(`Task ${taskId} already claimed`)) throw err;
      // Unreadable claim file — fall through and try the exclusive write.
    }
  }

  if (task.status !== 'pending') {
    throw new Error(
      `Task ${taskId} is not pending (status=${task.status}); cannot claim`,
    );
  }

  // Atomic: O_EXCL fails if the file exists, giving us true mutual
  // exclusion even under concurrent claims from two agents.
  try {
    writeFileSync(claimPath, `${agent}\t${now}\n`, { flag: 'wx', encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // Someone else won the race — read the winner and surface it.
    let owner = 'unknown';
    try { owner = readFileSync(claimPath, 'utf-8').split('\t')[0]; } catch { /* stays 'unknown' */ }
    if (owner === agent) return task; // Benign race with self — treat as idempotent success.
    throw new Error(`Task ${taskId} already claimed by ${owner}`);
  }

  // Lock held — safe to mutate the task JSON.
  const prevStatus = task.status;
  task.status = 'in_progress';
  task.assigned_to = agent;
  task.updated_at = now;
  try {
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    // Roll back the claim so a retry can succeed; we never want a ghost
    // lock surviving a write failure on the task JSON itself.
    try { unlinkSync(claimPath); } catch { /* best-effort */ }
    throw new Error(`Task ${taskId} claim commit failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'claim', agent, from: prevStatus, to: 'in_progress' });
  return task;
}

/**
 * Complete a task. Sets status to done, completed_at, and optional result.
 * Matches bash complete-task.sh behavior, with the cross-org fallback from
 * findTaskFile so an assignee in one org can complete a task filed by an
 * orchestrator in a sibling org.
 *
 * Side-effect: emits a `task/task_completed` event on the activity feed so
 * completions are visible on the dashboard without agents having to follow
 * every complete-task call with a separate log-event. The event is written
 * best-effort — a failing event write never unblocks task completion from
 * persisting to disk.
 */
export function completeTask(
  paths: BusPaths,
  taskId: string,
  result?: string,
): void {
  const filePath = findTaskFile(paths, taskId);
  if (!filePath) {
    throw new Error(
      `Task ${taskId} not found in any org under ${paths.ctxRoot}/orgs/`,
    );
  }
  let prevStatus: TaskStatus | undefined;
  let assignee: string | undefined;
  let taskOrg: string = '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const task: Task = JSON.parse(content);
    prevStatus = task.status;
    assignee = task.assigned_to;
    taskOrg = task.org || '';
    task.status = 'completed';
    task.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    task.completed_at = task.updated_at;
    if (result) {
      task.result = result;
    }
    atomicWriteSync(filePath, JSON.stringify(task));
  } catch (err) {
    throw new Error(`Task ${taskId} complete failed: ${err}`);
  }
  appendTaskAudit(paths, taskId, { event: 'complete', agent: assignee || 'unknown', from: prevStatus, to: 'completed', note: result });

  // Activity-feed event. Best-effort — the task is already persisted.
  if (assignee) {
    try {
      // Cross-org completion (caller's org ≠ task's org) is allowed via
      // findTaskFile, but the caller's `paths.analyticsDir` is scoped to
      // the caller's org. Rewrite the analytics path to the task's actual
      // org so dashboards/metrics see the completion under the right tree.
      // Only rewrite analyticsDir when the resolved task path is in the
      // nested cross-org layout: <ctxRoot>/orgs/<org>/tasks/<taskId>.json.
      // Flat/single-org test harnesses use <ctxRoot>/tasks + <ctxRoot>/analytics
      // and should keep the caller-provided analyticsDir unchanged.
      const pathOrgMatch = filePath.match(/[\\/]orgs[\\/](?<org>[^\\/]+)[\\/]tasks[\\/]/);
      const fileOrg = pathOrgMatch?.groups?.org || '';
      const eventPaths: BusPaths = fileOrg
        ? { ...paths, analyticsDir: join(paths.ctxRoot, 'orgs', fileOrg, 'analytics') }
        : paths;
      logEvent(eventPaths, assignee, taskOrg, 'task', 'task_completed', 'info', {
        task_id: taskId,
        ...(result ? { result } : {}),
      });
    } catch {
      // Never let observability break task completion.
    }
  }
}

/**
 * List tasks with optional filters.
 * Matches bash list-tasks.sh behavior.
 */
export function listTasks(
  paths: BusPaths,
  filters?: {
    agent?: string;
    status?: TaskStatus;
    priority?: Priority;
    respectDeps?: boolean;
  },
): Task[] {
  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      const task: Task = JSON.parse(content);

      // Apply filters
      if (filters?.agent && task.assigned_to !== filters.agent) continue;
      if (filters?.status && task.status !== filters.status) continue;
      if (filters?.priority && task.priority !== filters.priority) continue;
      if (task.archived) continue;

      tasks.push(task);
    } catch {
      // Skip corrupt files
    }
  }

  const sorted = tasks.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  if (!filters?.respectDeps) return sorted;

  // DAG-aware ordering: unblocked tasks first, blocked ones after, with
  // the secondary order preserving created_at DESC within each bucket.
  // "Blocked" = any blocked_by entry resolves to non-completed.
  const byId = new Map<string, Task>();
  for (const t of sorted) byId.set(t.id, t);
  const isBlocked = (t: Task): boolean => {
    for (const depId of normalizeEdgeList(t.blocked_by)) {
      const dep = byId.get(depId);
      // Out-of-list deps are checked on-disk via checkTaskDependencies,
      // but the list-view only considers in-list tasks for speed.
      if (!dep) continue;
      if (dep.status !== 'completed') return true;
    }
    return false;
  };
  const unblocked: Task[] = [];
  const blocked: Task[] = [];
  for (const t of sorted) (isBlocked(t) ? blocked : unblocked).push(t);
  return [...unblocked, ...blocked];
}

/**
 * Helper: read all task JSON files from a directory (non-recursive).
 */
function readAllTasks(taskDir: string): Task[] {
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(
      f => f.startsWith('task_') && f.endsWith('.json'),
    );
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(taskDir, file), 'utf-8');
      tasks.push(JSON.parse(content));
    } catch {
      // Skip corrupt files
    }
  }
  return tasks;
}

/**
 * Check for stale tasks. Matches bash check-stale-tasks.sh behavior.
 */
export function checkStaleTasks(paths: BusPaths): StaleTaskReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_IN_PROGRESS = 7200;   // 2 hours
  const STALE_PENDING = 86400;      // 24 hours
  const STALE_HUMAN = 86400;        // 24 hours

  const report: StaleTaskReport = {
    stale_in_progress: [],
    stale_pending: [],
    stale_human: [],
    overdue: [],
  };

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Skip completed/done tasks
    if (task.status === 'completed' || task.status === 'cancelled') continue;

    const updatedEpoch = Math.floor(new Date(task.updated_at).getTime() / 1000);
    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - updatedEpoch;
    const createdAge = nowEpoch - createdEpoch;

    // Stale in_progress: updated_at > 2 hours ago
    if (task.status === 'in_progress' && age > STALE_IN_PROGRESS) {
      report.stale_in_progress.push(task);
    }

    // Stale pending: created_at > 24 hours ago
    if (task.status === 'pending' && createdAge > STALE_PENDING) {
      report.stale_pending.push(task);
    }

    // Human tasks: assigned to "human" or "user", or in human-tasks project
    if (
      (['human', 'user'].includes(task.assigned_to ?? '') ||
        task.project === 'human-tasks') &&
      createdAge > STALE_HUMAN
    ) {
      report.stale_human.push(task);
    }

    // Overdue: has due_date and it's in the past
    if (task.due_date) {
      const dueEpoch = Math.floor(new Date(task.due_date).getTime() / 1000);
      if (dueEpoch > 0 && nowEpoch > dueEpoch) {
        report.overdue.push(task);
      }
    }
  }

  return report;
}

/**
 * Archive completed tasks older than 7 days. Matches bash archive-tasks.sh behavior.
 */
export function archiveTasks(paths: BusPaths, dryRun: boolean = false): ArchiveReport {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ARCHIVE_AGE = 604800; // 7 days

  let archived = 0;
  let skipped = 0;

  const tasks = readAllTasks(paths.taskDir);

  for (const task of tasks) {
    // Only archive completed tasks
    if (task.status !== 'completed') continue;

    if (!task.completed_at) {
      skipped++;
      continue;
    }

    const completedEpoch = Math.floor(new Date(task.completed_at).getTime() / 1000);
    const age = nowEpoch - completedEpoch;

    if (age > ARCHIVE_AGE) {
      // task.id comes from the file's JSON body and is used to build the
      // rename source/dest below; a tampered id must not escape the task tree.
      try { validateTaskId(task.id); } catch { skipped++; continue; }
      if (!dryRun) {
        const archiveDir = join(paths.taskDir, 'archive');
        ensureDir(archiveDir);

        // Mark as archived
        task.archived = true;
        const srcPath = join(paths.taskDir, `${task.id}.json`);
        atomicWriteSync(srcPath, JSON.stringify(task));

        // Move to archive
        renameSync(srcPath, join(archiveDir, `${task.id}.json`));
      }
      archived++;
    }
  }

  return { archived, skipped, dry_run: dryRun };
}

/**
 * Semantic compaction of old completed tasks (beads-inspired). Each
 * eligible task becomes a one-line summary entry in a monthly
 * `archive-YYYY-MM.jsonl` file (bucketed by the task's completed_at
 * month), and the active task JSON is removed to keep the task board
 * small. The audit log (audit/<id>.jsonl) is intentionally preserved
 * so full lifecycle history survives compaction.
 *
 * Guards (a task is SKIPPED if any of the following holds):
 *   - status !== 'completed'
 *   - completed_at missing OR completed_at within the cutoff window
 *   - the task is still listed in some OTHER task's `blocked_by` where
 *     that other task is not yet completed (compaction must not
 *     orphan dependency references for unresolved dependents)
 *
 * No LLM calls. The "summary" is just title + result + key metadata;
 * callers supply clean result strings via `complete-task --result`.
 *
 * Idempotent: running twice over the same data does nothing the
 * second time because eligible tasks have already been removed.
 */
export interface CompactTasksReport {
  archived: Array<{ id: string; archive_file: string }>;
  skipped: Array<{ id: string; reason: string }>;
  dry_run: boolean;
}

export function compactTasks(
  paths: BusPaths,
  options: { olderThanDays?: number; dryRun?: boolean } = {},
): CompactTasksReport {
  const { olderThanDays = 30, dryRun = false } = options;
  const report: CompactTasksReport = { archived: [], skipped: [], dry_run: dryRun };
  const cutoffMs = Date.now() - olderThanDays * 86400_000;

  const { taskDir } = paths;
  let files: string[];
  try {
    files = readdirSync(taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
  } catch {
    return report;
  }

  // First pass: load every task so we can check cross-task dependency
  // references without re-reading files per candidate.
  const tasks: Task[] = [];
  for (const f of files) {
    try { tasks.push(JSON.parse(readFileSync(join(taskDir, f), 'utf-8')) as Task); }
    catch { /* skip corrupt */ }
  }

  // Build a "still-needed" set: the TRANSITIVE blocker closure of
  // every open task. A completed blocker must survive compaction as
  // long as ANY open task has it in its blocked_by chain — not just
  // direct parents. With A <- B <- C and C open, the direct-only
  // guard preserved B but archived A, leaving B with a dangling
  // reference to an archived task. Phase 4 directive was
  // "still in the blocked_by chain of a pending task" — the
  // full-chain reading is the correct one.
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);
  const stillNeededAsBlocker = new Set<string>();
  const stack: string[] = [];
  for (const t of tasks) {
    if (t.status === 'completed') continue;
    stack.push(...normalizeEdgeList(t.blocked_by));
  }
  while (stack.length) {
    const cur = stack.pop()!;
    if (stillNeededAsBlocker.has(cur)) continue;
    stillNeededAsBlocker.add(cur);
    const parent = byId.get(cur);
    if (parent) stack.push(...normalizeEdgeList(parent.blocked_by));
  }

  for (const task of tasks) {
    if (task.status !== 'completed') continue;
    if (!task.completed_at) { report.skipped.push({ id: task.id, reason: 'no completed_at timestamp' }); continue; }
    const completedMs = new Date(task.completed_at).getTime();
    if (isNaN(completedMs) || completedMs > cutoffMs) {
      report.skipped.push({ id: task.id, reason: 'completed_at within cutoff' });
      continue;
    }
    if (stillNeededAsBlocker.has(task.id)) {
      report.skipped.push({ id: task.id, reason: 'still referenced by an open task\'s blocked_by chain' });
      continue;
    }

    // task.id (from the file's JSON body) is used to unlink the source file
    // below; a tampered id must not delete a file outside the task tree.
    try { validateTaskId(task.id); } catch { report.skipped.push({ id: String(task.id), reason: 'invalid task id (path-traversal guard)' }); continue; }

    const yyyymm = task.completed_at.substring(0, 7); // YYYY-MM
    // completed_at is from the JSON body and feeds the archive filename below;
    // reject anything that isn't a literal YYYY-MM so a tampered timestamp can't
    // traverse out of the task tree via the archive path.
    if (!/^\d{4}-\d{2}$/.test(yyyymm)) {
      report.skipped.push({ id: String(task.id), reason: 'invalid completed_at (path-traversal guard)' });
      continue;
    }
    const archiveFile = `archive-${yyyymm}.jsonl`;
    const archivePath = join(taskDir, archiveFile);
    const entry = {
      id: task.id,
      title: task.title,
      org: task.org,
      assigned_to: task.assigned_to,
      completed_at: task.completed_at,
      archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      result: task.result ?? '',
    };

    if (!dryRun) {
      try {
        appendFileSync(archivePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
        unlinkSync(join(taskDir, `${task.id}.json`));
      } catch (err) {
        report.skipped.push({ id: task.id, reason: `archive write failed: ${err}` });
        continue;
      }
    }
    report.archived.push({ id: task.id, archive_file: archiveFile });
  }

  return report;
}

/**
 * Find stale human-assigned tasks. Matches bash check-human-tasks.sh behavior.
 */
export function checkHumanTasks(paths: BusPaths): Task[] {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const STALE_THRESHOLD = 86400; // 24 hours

  const tasks = readAllTasks(paths.taskDir);
  const result: Task[] = [];

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'cancelled') continue;
    if (task.assigned_to !== 'human' && task.assigned_to !== 'user') continue;

    const createdEpoch = Math.floor(new Date(task.created_at).getTime() / 1000);
    const age = nowEpoch - createdEpoch;

    if (age > STALE_THRESHOLD) {
      result.push(task);
    }
  }

  return result;
}
