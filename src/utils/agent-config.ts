import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { withFileLockSync, FileLockOptions } from './lock.js';
import { atomicWriteSync } from './atomic.js';

/**
 * An agent's `config.json`. Deliberately open-ended: the file is written by the
 * CLI, the dashboard and agent templates, and each knows about a different
 * subset of keys. Anything a writer does not recognise must survive the
 * round-trip untouched, which is the whole point of doing this under a lock.
 */
export type AgentConfig = Record<string, any>;

/** `<agentDir>/config.json` — the orgs-side path, not the state-side one. */
export function agentConfigPath(agentDir: string): string {
  return join(agentDir, 'config.json');
}

/**
 * The lock directory for an agent's `config.json` is the agent directory itself
 * (`orgs/<org>/agents/<agent>/`), i.e. `dirname(configPath)`.
 *
 * This is load-bearing and is the reason this helper exists rather than each
 * call site picking its own directory. The dashboard's config and crons routes
 * lock `dirname(configPath)`; `src/bus/crons.ts` locks the *state* directory
 * (`$CTX_ROOT/.cortextOS/state/agents/<agent>/`) because that is where
 * `crons.json` lives. Those are two different directories, so a writer that
 * takes the state lock is not excluded from a writer holding this one. Deriving
 * the lock dir from the config path — never re-deriving it independently — is
 * what keeps the CLI and the dashboard on the same mutex.
 */
function lockDirFor(agentDir: string): string {
  // `acquireLock` mkdirs `<dir>/.lock.d` non-recursively, so `dir` must exist.
  mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

/**
 * Locked read-modify-write of an agent's `config.json`.
 *
 * The lock spans read -> mutate -> write. A lock that only spanned the write
 * would be decoration: the loss these call sites suffer is a stale snapshot
 * being written back, and that is decided by where the *read* happened.
 *
 * `mutate` receives the parsed config (an empty object if the file does not
 * exist yet) and may return `false` to decline the write entirely. Returns
 * whether a write happened.
 *
 * Throws if the lock cannot be acquired within the timeout, or if an existing
 * config.json is not valid JSON — callers decide how loud that should be.
 */
export function mutateAgentConfig(
  agentDir: string,
  mutate: (cfg: AgentConfig, existed: boolean) => void | false,
  opts: FileLockOptions = {},
): boolean {
  const path = agentConfigPath(agentDir);
  return withFileLockSync(lockDirFor(agentDir), () => {
    const existed = existsSync(path);
    const cfg: AgentConfig = existed
      ? JSON.parse(readFileSync(path, 'utf-8'))
      : {};
    if (mutate(cfg, existed) === false) return false;
    // atomicWriteSync appends its own trailing newline — do not add one here or
    // every write gains a blank line.
    atomicWriteSync(path, JSON.stringify(cfg, null, 2));
    return true;
  }, opts);
}

/**
 * Locked, atomic whole-file write of an agent's `config.json`, for the callers
 * that legitimately replace the file rather than amend it (`import-agent`).
 *
 * Still takes the lock even though it reads nothing: without it this write can
 * land in the middle of another process's read-modify-write and be discarded by
 * that process's write-back.
 */
export function writeAgentConfig(
  agentDir: string,
  cfg: AgentConfig,
  opts: FileLockOptions = {},
): void {
  withFileLockSync(lockDirFor(agentDir), () => {
    atomicWriteSync(agentConfigPath(agentDir), JSON.stringify(cfg, null, 2));
  }, opts);
}
