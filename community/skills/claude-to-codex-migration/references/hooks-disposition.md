# Hooks disposition — `.claude/settings.json` -> codex

Codex has NO `settings.json` and NO Claude-Code hook event model. DELETE the file;
no codex file replaces it. The capability does not vanish — it splits three ways.
This table is the canonical source for the migration report's hook lines. Derive
report logic from THIS table (verified against `src/pty/codex-app-server-pty.ts`),
NOT from any per-agent settings.json guess.

Three buckets:
- **SUPERSEDED** — codex's hardcoded autonomy makes the hook unnecessary.
- **RE-EXPRESSED** — the adapter/daemon already does this natively; capability survives,
  just not as a configurable hook. NOT a loss.
- **DROPPED** — genuinely no codex equivalent. There are exactly THREE.

| Claude hook (settings.json) | What it did | Codex disposition | Where it lives on codex |
|---|---|---|---|
| `permissions.allow` / `defaultMode: bypassPermissions` | tool allowlist | **SUPERSEDED** | `approvalPolicy:'never'` + `sandbox:'danger-full-access'` (adapter `:70-78`; host `~/.codex/config.toml`) |
| `PermissionRequest` catch-all (auto-allow `echo`) | auto-approves perms | **SUPERSEDED** | same autonomous policy |
| `Stop` -> `hook-idle-flag` | writes idle flag on stop | **RE-EXPRESSED** | adapter `writeIdleFlag()` on idle/turn-completed -> same `last_idle.flag` |
| `statusLine` -> `hook-context-status` | polls, writes context_status.json | **RE-EXPRESSED** (event-driven) | adapter `writeContextStatus()` on `thread/tokenUsage/updated` -> same-shape `context_status.json` (note: `cache_creation_input_tokens` is hardcoded 0 under codex — small lossy field) |
| `SessionEnd` -> `cortextos crash-alert` | crash alert on exit | **RE-EXPRESSED** (daemon) | daemon `handleExit` (counter, backoff, crash-loop pauser, restarts.log) |
| (implicit) typing indicator | — | **RE-EXPRESSED (bonus)** | adapter `maybeFireTyping()` on turn activity |
| (implicit) "back online" telegram | inline boot instruction | **RE-EXPRESSED (daemon)** | `maybeSendCodexBootNotification` (codex doesn't reliably run the inline instruction, Issue #392) |
| `PermissionRequest` matcher `ExitPlanMode` -> `hook-planmode-telegram` | plan -> Telegram approval gate | **DROPPED** | none — codex has no ExitPlanMode lifecycle event |
| `PreToolUse` matcher `AskUserQuestion` -> `hook-ask-telegram` | interactive question -> Telegram | **DROPPED** | none — no AskUserQuestion tool / PreToolUse interception |
| `PreCompact` -> `hook-compact-telegram` | compaction Telegram notice | **DROPPED** | none — codex has no Claude-style compaction event; session pressure handled by `max_session_seconds` session-refresh |

## The three DROPPED behaviors (the real functional loss)

All three are "in-turn human-in-the-loop over Telegram." A codex agent runs fully
autonomous (`approvalPolicy:'never'`), so the conceptual replacement is the
**out-of-band bus `approvals` flow** (create approval object -> notify -> block), NOT an
in-turn hook. Report them as needs-human:

1. plan-mode -> Telegram approval gate (`hook-planmode-telegram`)
2. interactive AskUserQuestion -> Telegram (`hook-ask-telegram`)
3. compaction -> Telegram notice (`hook-compact-telegram`)

The migration verifies the target AGENTS.md carries the approval-via-bus contract
(the codex template's AGENTS.md already mandates the `approvals` skill +
`cortextos bus create-approval`).

## NOTE on phantom hooks

Do NOT report `hook-loop-detector` or a catch-all `hook-permission-telegram` as lost.
Those were fabricated in an earlier mapping draft and are not present in real agent
settings.json files. Only report hooks the source's ACTUAL `.claude/settings.json`
wires (detect.py reads the real file).
