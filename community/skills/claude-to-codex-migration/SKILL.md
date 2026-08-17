---
name: claude-to-codex-migration
description: >-
  Migrate ANY cortextOS agent from the claude-code runtime to the live
  codex-app-server runtime. Use this whenever a user wants to convert,
  port, move, or switch a Claude-cortextOS agent to Codex / gpt-5-codex /
  gpt-5.5, "make agent X run on codex", "turn this claude agent into a codex
  agent", or asks how a Claude agent's CLAUDE.md / .claude/skills / .mcp.json /
  hooks map onto the codex-app-server adapter. Takes a source agent name and
  produces a SEPARATE codex-shaped agent (non-destructive, dry-run by default).
  Trigger even if they only say "migrate <agent> to codex" without naming the
  artifacts. Do NOT use for creating a brand-new codex agent from scratch
  (use `cortextos add-agent`) or for hermes/orchestrator/analyst runtimes.
---

# Claude -> Codex Agent Migration

Convert a `runtime: claude-code` cortextOS agent into a `runtime: codex-app-server`
agent that the live `CodexAppServerPTY` adapter can boot and loop. The migration is
mostly a transform of the agent's in-repo directory plus a `config.json` runtime/model
flip; the bus, crons, heartbeat, dashboard, and Telegram surfaces are already
runtime-agnostic and carry over unchanged.

This skill is GENERAL: it takes any source agent name/path as input. It is
NON-DESTRUCTIVE: the source agent is never modified or deleted; you produce a
separate codex-form agent. It is DRY-RUN BY DEFAULT: nothing is written until you
pass `--apply`.

## The promise and the contract

The codex adapter (`src/pty/codex-app-server-pty.ts`) re-implements most of what
Claude's `.claude/settings.json` hooks did, natively in code. So the migration is
NOT "everything Claude-specific is lost." The honest decomposition is:

- **1:1** -> copy verbatim (identity/soul/goals/memory/.env/workspaces/crons).
- **TRANSFORM** -> rewrite into codex shape (config.json, CLAUDE.md, skills, MCP, refs).
- **DROPPED (no equivalent)** -> exactly THREE in-turn Telegram behaviors lose their
  hook: plan-mode->Telegram, AskUserQuestion->Telegram, PreCompact->Telegram. Re-home
  them to the out-of-band bus `approvals` flow.
- **NEEDS-HUMAN** -> items that cannot be mechanically converted and block enable.

The cardinal rule: **never silently drop an artifact.** Every file the source agent
owns lands in a bucket and appears in the report, including files this skill has no
specific rule for (they go to a `port-verbatim` catch-all). If the tree-walk finds
something with no rule, it is surfaced, not skipped.

## How to run this: walk the USER through it (interactive, 5 steps)

You (the implementing agent) do NOT run this silently. Migration changes a live
agent's runtime and can take over a Telegram bot — the user must steer the
irreversible choices. Run a conversation in exactly these five steps. The scripts
below do the work; THIS section is the script YOU follow with the user.

The whole flow maps onto the engine flags like this: STEP 1-2 gather the user's
answers; STEP 3 is the deterministic convert; the bot/boot choices from STEP 2
become `--bot-mode` / `--boot` / `--new-bot-token` on `convert.py`; STEP 5 reads
the engine's `end_state`. With NO flags the engine is fully non-destructive
(dry-run, source untouched, codex disabled) — so always do the STEP 1 detect as a
dry-run first, ask, THEN apply with the user-confirmed flags.

### STEP 1 — DETECT + plain-language SUMMARY (no changes yet)
Run Step 0 + Step 1 (DETECT) below, read the manifest, then tell the user, in
plain language (not JSON):
- the agent name and its current runtime,
- N skills (X custom / Y bundled-for-free),
- M crons, the MCP servers (or "none"),
- the Telegram bot it runs on,
- what migrates CLEAN (1:1), what is LOSSY (the 3 dropped Telegram behaviors,
  any leaky skills), and what will NEED THEM (the needs-human set).
Make NO changes. This is the orientation read.

### STEP 2 — ASK the user these 3 decisions, then WAIT for answers
Present all three with their defaults; do not proceed until answered.

- **Q1 TARGET.** Create a new agent `<name>-codex` ALONGSIDE the original
  (DEFAULT — safe, fully rollbackable), OR replace the original in place?
  Default is new-alongside. "Replace" is advanced/destructive — warn explicitly
  that it removes the rollback path.
- **Q2 BOT TOKEN (the key one).**
  - **(a) REUSE the existing Telegram bot** -> the skill performs a CUTOVER: it
    DISABLES the source Claude agent, copies its bot token into the codex agent,
    and boots the codex agent on the SAME token. Telegram allows only ONE poller
    per bot, so reuse REQUIRES disabling the source — this is intended and
    seamless. End state: "X is now codex, same bot." (Sets `--bot-mode reuse`,
    which implies boot.)
  - **(b) NEW bot** -> the user pastes a new bot token (from @BotFather); it goes
    in the codex agent's env, and BOTH source and codex can run side by side.
    (Sets `--bot-mode new --new-bot-token <token>`.)
- **Q3 BOOT.** After migrating, boot the codex agent now, or leave it DISABLED
  for the user to inspect first? (If Q2=reuse-cutover, booting is implied — still
  confirm with the user.) (Sets `--boot now` or `--boot no`, default `no`.)

### STEP 2b — WRITE-SIDE HANDOFF GATE (HARD, cutover only — block before any teardown)
This is a NON-NEGOTIABLE pre-cutover gate. A clean cutover requires real session
continuity, not a synthesized handoff. Before any `--bot-mode reuse`:
1. Record the migration-start timestamp and pass it as `--migration-start-ts`.
2. **AUTHORIZE the migration — the gate depends on REVERSIBILITY.** A
   security-hardened source agent will (CORRECTLY) REFUSE a cold bus demand to run a
   handoff — it reads "produce a handoff now, urgent, via bus" as a prompt-injection
   pattern and escalates instead of complying (good behavior; clean-room test runs
   proved it). How you authorize depends on what the migration DOES:

   **2a. OWNER-DIRECT-CONFIRM — REQUIRED for an irreversible / external-surface /
   shared-system cutover (defect 9).** `--bot-mode reuse` is a BOT-HANDOVER: the
   target takes over the source's live Telegram surface — irreversible and
   externally visible. Per the approval doctrine, an irreversible external-surface
   action requires the OWNER (the user) to confirm DIRECTLY, OUT-OF-BAND, over the
   TARGET agent's own trusted surface (e.g. the principal sends the SOURCE agent a
   direct Telegram: "migration to <target> is authorized, comply with the next
   handoff request"). This is the AUTHORIZATION gate. An orchestrator-minted in-band token is
   NOT sufficient for it: a transmitted token is itself an attack surface (any agent
   that sees the bus can quote it), and request-authenticity is not owner-authorization
   for an irreversible action. The source complies because its OWNER told it to,
   directly. Do NOT substitute a delegated/relayed approval for the owner's direct
   confirm on an irreversible cutover.

   **The owner confirm must be EXPLICIT, UNAMBIGUOUS, and verified at the RECIPIENT
   (defect 10).** Three hard sub-rules, all proven by a clean-room test run where a
   relayer inflated a bare owner "Authorized" into the full gate phrase:
   - SPECIFIC: the owner's confirm must NAME the target AND the action ("migration to
     `<target>` authorized, comply with the next handoff request"). A bare affirmation
     ("Authorized", "ok", "go", "bet") is ACK, NOT approval — it does not satisfy the
     gate, especially if it answers nothing specific or leaves a target's clarifying
     question unanswered.
   - VERBATIM RELAY ONLY: anyone relaying the owner's authorization must quote the
     owner's LITERAL words — NEVER a characterization or upgraded interpretation. An
     owner saying "I sent it" to a relayer is an action-CLAIM, not verification of
     CONTENT. If the owner's words are ambiguous, the gate is NOT met and you HOLD —
     you do NOT fill the gap. (Pairs with the fleet provenance-travels-verbatim rule.)
   - GATE-SIGNAL = RECIPIENT CONFIRMS RECEIPT: the gate is satisfied ONLY when the
     TARGET agent confirms, in ITS OWN channel, that it received the owner's specific
     unambiguous confirm — NOT when a relayer claims the owner "sent it." The recipient
     is always the source of truth for what was actually received. Fire the cutover
     only after the target confirms receipt. (The architecture must not depend on the
     relayer being perfect; the target verifying is the safety, which is why it exists.)
   - STRONGEST / CANONICAL FORM (preferred): TARGET-INITIATED — the target itself asks
     its owner, IN ITS OWN CHANNEL, to authorize the migration; the owner approves
     THERE verbatim; the target confirms receipt. This keeps the entire authorization
     path inside the target's own trusted channel with ZERO relayer, structurally
     closing the inflation gap rather than relying on relay discipline. (You may still
     paste the owner the exact phrase to send — but the GATE is the target's
     receipt-confirmation, never your claim.)

   **2b. ONE-TIME TOKEN — defense-in-depth for REQUEST AUTHENTICITY (defect 8ii),
   optional layer / sufficient alone only for REVERSIBLE migrations.** The
   orchestrator mints a short ONE-TIME TOKEN, pre-arms the source ("comply when the
   migration agent requests handoff:create AND quotes token `<TOKEN>`"), and the
   migration agent ECHOES that exact token INLINE with the provenance. This proves the
   handoff request is the authentic migration agent (defeats an attacker riding the
   window) and is appropriate for low-stakes/reversible migrations — but for an
   irreversible cutover it is a SUPPLEMENT to 2a, never a replacement.

   In all cases: NEVER a bare urgent demand, and NEVER bypass a refusal — if the
   source refuses, the authorization gate was not satisfied; fix it (get the owner
   confirm), do not force past it.
3. **FLUSH IN-SESSION CORRECTIONS FIRST (defect 13 — HARD pre-handoff step).**
   Before the source runs `handoff:create`, tell it to FLUSH any recent in-session
   behavioral corrections to PERSISTED state (memory/ + GUARDRAILS.md): routing
   rules, suppression rules ("never surface X"), triage-only rules, per-recipient
   overrides — anything a human told it THIS session that it has not yet written
   down. **The migration carries only PERSISTED artifacts + the handoff; unpersisted
   in-session context does NOT exist as migratable state and will be LOST at
   cutover.** It is also not enough for the correction to change behavior while
   leaving a stale config/cron in place — e.g. if the operator said "stop sending
   pending-items direct to the principal" but the cron prompt still says so, the migrated
   cron inherits the WRONG behavior. So the source must, in this flush: (a) write
   the correction to memory/GUARDRAILS.md, AND (b) fix any config/cron whose text
   still encodes the pre-correction behavior. This is a KNOWN HARD LIMITATION of
   migration, not a bug to engineer around: the handoff is a summary, not a
   substitute for persisted guardrails. (Observed failure mode: a migrated agent
   inherited several same-day behavioral corrections that were never persisted — it
   resumed sending items directly to the principal, surfaced messages it had been
   told to suppress, and re-surfaced a suppressed item — because the source agent
   never wrote those corrections down before cutover.)
4. Tell the (now pre-armed) LIVE source agent to run its NORMAL handoff procedure
   (the same `handoff:create` it runs at its context-handoff threshold). Do NOT
   synthesize a handoff yourself.
5. convert.py BLOCKS and polls the SOURCE WORKSPACE `<src-dir>/memory/handoffs/` —
   where agents ACTUALLY write handoffs (defect 8i: NOT `state/<source>/handoffs/`,
   which usually does not exist) — for a handoff whose mtime is AFTER the
   migration-start timestamp. A pre-existing stale handoff does NOT satisfy the gate.
   If no fresh handoff appears within `--handoff-wait` seconds (default 300), the
   cutover ABORTS: the source is NOT disabled, the target is NOT enabled (end_state
   `cutover-aborted`).
That fresh handoff is then carried into a DETERMINISTIC location in the new agent's
dir so it is ALWAYS reliably read on boot (not a "newest file" guess): into BOTH the
daemon boot-state dir `state/<target>/handoffs/` AND the new agent's WORKSPACE
`memory/handoffs/` (its native handoff:resume dir), as the NEWEST file in each, and a
deterministic boot directive (`state/<target>/.handoff-doc-path`) is written so the
daemon points the new agent at the exact file as its FIRST action on boot (the same
CONTEXT HANDOFF injection mechanism the daemon uses for restarts). The side-by-side
(`--bot-mode new`) and disabled (default) paths do NOT take over the source and are
NOT gated.

### STEP 3 — AUTOMATE everything else SILENTLY (no questions)
Run CONVERT (Step 3 below) with the flags from STEP 2. The script does, with no
further questions: config flip, skill relayout + symlinks, CLAUDE.md->AGENTS.md
fold, boot-state continuity carry (`.onboarded` + markers + handoffs/ so the agent
does NOT cold-onboard), stale-session-transcript exclusion, the cron UNION
migration (config.json + live registry, deduped, paths translated, direct-to-principal
sends re-routed through the orchestrator by BOTH chat-id token AND prose intent — defect 14;
one-shot crons carried as their daemon-loadable registry crontab form instead of
the config `type:once`/`fire_at` form the daemon silently drops — defect 11b, with
a loud per-cron flag), guardrail-into-template (routing + approval rules),
memory, MCP TOML emit, registry-disable, plus (from the flags) the bot-token write,
the write-side handoff gate, the cutover source-disable, **the cutover
SOURCE-CRON-disable (defect 11a: disabling the source AGENT does NOT disable its
CRONS — they stay enabled in the registry and re-fire on daemon restart/re-enable =
durable dual-scheduler; the script disables every RECURRING source cron and HOLDS
one-shots until the operator re-arms them on the target)**, and the boot. It also runs a
SQLITE-INTEGRITY pass (defect 15): skill data is raw-copied, and copying a LIVE
sqlite DB tears it (an agent's live signals DB came over malformed) — so every copied
`*.db` is integrity-checked, any torn one is re-copied from source via the sqlite
backup API (a consistent snapshot, even of a live DB) and re-asserted; a DB that
still cannot be made sound is a HARD cutover-blocking failure (default-deny: abort
before any source teardown, exit non-zero — a migration that cannot produce a valid
DB copy must not report success). `os.walk` skips symlinks, so shared skills are
untouched — only the agent's own copies. Two of these are guaranteed by `verify.py`
OUTCOME-ASSERTIONS, not by trusting the step ran: (1) no RECURRING source cron
stays enabled post-cutover (defect 11a), and (2) no migrated cron routes to the principal
by token OR prose (defect 14); the sqlite pass is itself prevent-plus-assert. Verify by OUTCOME,
never assume a step ran — a skilled operator hand-rescuing during a test masks a
missing step completely (this exact class-bug hid behind manual rescue across two
live migrations).

### STEP 4 — PAUSE for the genuinely-human items only
List the needs-human set from the manifest/convert log and let the user pick
handle-now or skip for each:
- the 3 dropped in-turn Telegram behaviors (re-home to the bus approvals flow),
- leaky custom skills to rewrite (hand to skill-creator),
- AGENTS.md de-dup after the fold,
- TOOLS.md Claude-auth-env flag.
These are the items no script can safely auto-do (Step 4 below has the detail).

### STEP 5 — FINAL REPORT (end-state aware)
Render the report (Step 6 below). Read the engine's `end_state` and lead with the
matching line:
- cutover: "**<X>-codex is live on the original bot; Claude <X> is disabled.**"
- new-bot + boot: "**<X>-codex is live on its new bot; <X> is still running.**"
- left disabled (default): "**Ready — run `cortextos enable <name>-codex` when
  you're happy.**"

## Instance-discovery (routing is parameterized, not baked to any fleet)

cortextOS fleets often run a routing rule: **principal-facing sends route THROUGH an
orchestrator agent** (the one that owns the principal's Telegram surface). This skill
KEEPS that rule but discovers WHO the principal and orchestrator are for YOUR
deployment — nothing is hardcoded. Three values, each discovered-then-safe-degraded:

| Value | `convert.py` param | Discovery precedence | If unknown (safe-degrade) |
|-------|--------------------|----------------------|---------------------------|
| Principal chat id | `--principal-chat-id` | param -> source `.env` `CHAT_ID` -> `ALLOWED_USER` (if numeric) | literal-id reroute leg OFF (nothing hunted) |
| Principal name | `--principal-name` | param -> source `.env` `ALLOWED_USER` (if non-numeric) | prose-intent reroute leg OFF (no false name match) |
| Orchestrator (reroute target) | `--orchestrator <name>` | param -> auto-scan siblings for a POSITIVE role signal (config `role`/`template`==orchestrator OR an IDENTITY/SOUL self-declaration), exactly-one match only | **whole reroute OFF**; principal-facing crons FLAGGED needs-human |
| Org | `--org <org>` | param (no default) | — |

Key behaviors:
- **The reroute is GATED on the orchestrator being known.** A known principal chat id
  with an UNKNOWN orchestrator does NOT rewrite anything (no send-into-the-void). Pass
  `--orchestrator <name>` to enable routing, or the crons are surfaced for manual review.
- **Auto-scan never guesses.** It requires a positive role declaration; it will NOT
  pick the lone sibling in a 2-agent fleet. A single positive hit is SURFACED in the
  report for you to confirm before trusting the reroute. In most fleets it finds
  nothing and you simply pass `--orchestrator` — that is the expected, honest path.
- **Guardrails split.** The APPROVAL guardrail ("no external action without an explicit
  per-item go") is always injected. The ROUTING guardrail (naming the orchestrator) is
  injected ONLY when both orchestrator and principal are known.
- **Double-unknown** (no orchestrator AND no principal) emits ONE loud needs-human line
  in the report — routing reroute disabled; review crons manually.

## The flow: DETECT -> MAP -> CONVERT -> VERIFY -> REPORT

```
/migrate-agent-to-codex <source-agent> [--org <org>] [--target-name <name>]
    [--dry-run | --apply]      # default: --dry-run
    [--instance <id>]          # default: default
    [--orchestrator <name>]    # reroute target; else auto-scan -> safe-degrade
    [--principal-chat-id <id>] [--principal-name <name>]  # else from source .env
```

Run the bundled scripts in order. They do the deterministic work; YOU do the
judgment work (the fold review, the leakage adjudication, the needs-human decisions).
Read `references/` files when a step points you there.

### Step 0 — Resolve paths and orient

```bash
# SKILL_DIR is the directory holding THIS SKILL.md and its scripts/. This file is
# READ by you, not executed, so there is no $0 — set it to the absolute path of the
# skill dir you are reading from (or `cd` into it and use `SKILL_DIR="$(pwd)"`).
SKILL_DIR="<absolute path to the dir containing this SKILL.md>"
SRC_AGENT="<source-agent>"
ORG="<org>"                          # your org (no default — pass it explicitly)
INSTANCE="default"
# CTX_ROOT comes from the source agent's .cortextos-env, NOT a guess:
CTX_ROOT="$(grep -E '^CTX_ROOT=' orgs/$ORG/agents/$SRC_AGENT/.cortextos-env | cut -d= -f2-)"
SRC_DIR="orgs/$ORG/agents/$SRC_AGENT"
# Migration-start cutoff for the write-side handoff gate: only a source handoff
# produced AFTER this timestamp satisfies the gate. Capture it ONCE, before the
# source is told to run handoff:create, and reuse it for convert.py + verify.py.
MIGRATION_START_TS="$(date +%s)"
```

Confirm the source is a Claude agent. Refuse if `config.json.runtime` is already
`codex-app-server` (nothing to migrate) or `hermes` (out of scope).

### Step 1 — DETECT (always runs, even in dry-run)

```bash
python3 "$SKILL_DIR/scripts/detect.py" \
  --src-dir "$SRC_DIR" --ctx-root "$CTX_ROOT" --agent "$SRC_AGENT" \
  > /tmp/migrate-$SRC_AGENT-manifest.json
```

`detect.py` walks the whole agent dir and the relevant `$CTX_ROOT` state, classifies
every artifact into a bucket (`one_to_one`, `transform`, `dropped`, `needs_human`,
`port_verbatim`), greps custom skills for Claude-only leakage, and emits a JSON
manifest. The catch-all `port_verbatim` bucket guarantees no file is dropped just
because there is no rule for it.

Read the manifest. It is the heart of the dry-run. Pay attention to:
- `hard_stops` — non-empty means STOP and report before any convert (see Step 2).
- `needs_human` — the blocking set; the migrated agent stays disabled until resolved.
- `skills.custom` with `leakage_hits` — these need your adjudication (Step 4).
- `mcp.servers` — each populated server is real host-config + secrets work.

### Step 2 — Pre-flight hard stops (block before convert)

Surface these BEFORE writing anything. They are non-negotiable:

1. **Non-codex template — HUMAN pre-check (not automated).** If the source was
   scaffolded from `orchestrator`, `analyst`, or `m2c1-worker`, there is no codex
   variant — do NOT migrate it (`add-agent` rejects the combo; hand-building a
   degraded agent is wrong). The `hermes` runtime IS caught automatically (it shows
   up as `config.json.runtime == hermes` and detect.py hard-stops on it). The other
   three are NOT reliably auto-detectable: no template field is persisted in
   config.json, the runtime is plain `claude-code`, and identity files diverge from
   the template after customization, so by migration time they look like an ordinary
   `agent` scaffold. detect.py emits a best-effort ADVISORY note when source files
   resemble one of these templates, but YOU must confirm the source's lineage before
   proceeding — this skill does not (and cannot) mechanically enforce it.
2. **Target name collision.** If `--target-name` resolves to an existing dir,
   `add-agent` refuses. Same-name reuse requires disabling/renaming the source FIRST
   — ask, never auto-clobber. Safe default: `--target-name <source>-codex`.
3. **MCP host-global name collision.** Codex MCP server names are host-wide (NOT
   `<agent>__`-namespaced like skills). If the source's `.mcp.json` declares a server
   whose name already exists in `~/.codex/config.toml` for a DIFFERENT definition,
   that is a collision a human must resolve. HARD STOP until decided.
4. **BOT_TOKEN reuse.** The source `.env` BOT_TOKEN cannot be shared by two live
   agents (Telegram `getUpdates` conflict). The target needs EITHER a new bot token
   OR the source disabled first. Decide before enable. Do not copy a live BOT_TOKEN
   into a second agent that will run concurrently.

### Step 3 — CONVERT (only on --apply)

**MANDATORY, ORDERED prerequisite:** lay the codex skeleton with `add-agent`
FIRST, then run convert. This is not optional and not reversible in order: convert
overlays onto the skeleton and hard-refuses (exit 1) if
`.agents/plugins/marketplace.json` is absent in the target. Reusing `add-agent`
gets you the marketplace.json, the 23-skill codex stdlib, symlink wiring, config
defaults, a correct per-agent `.cortextos-env`, org-context seeding, and
enabled-agents registration for free.

```bash
TARGET="${TARGET_NAME:-${SRC_AGENT}-codex}"
cortextos add-agent "$TARGET" --template agent-codex --runtime codex-app-server --org "$ORG"
# add-agent MUST have created orgs/$ORG/agents/$TARGET/.agents/plugins/marketplace.json
# before convert will proceed.
```

Then run the converter, which overlays everything the skeleton does not provide:

```bash
python3 "$SKILL_DIR/scripts/convert.py" \
  --manifest /tmp/migrate-$SRC_AGENT-manifest.json \
  --src-dir "$SRC_DIR" \
  --target-dir "orgs/$ORG/agents/$TARGET" \
  --target-agent "$TARGET" \
  --ctx-root "$CTX_ROOT" \
  --source-agent "$SRC_AGENT" --migration-start-ts "$MIGRATION_START_TS" \
  --apply
  # --migration-start-ts is the write-side handoff-gate cutoff (STEP 2b); on a
  # cutover convert.py BLOCKS up to --handoff-wait (default 300s) for a source
  # handoff newer than it, and ABORTS the cutover if none appears.
  # Interactive-flow flags from STEP 2 (omit all for the SAFE default:
  # source untouched, codex disabled, no boot — exactly the legacy behavior):
  #   --bot-mode reuse                 # CUTOVER: disable source, copy its bot
  #                                    # token to codex, IMPLY boot (one bot)
  #   --bot-mode new --new-bot-token T # write a fresh token; both run side-by-side
  #   --boot now                       # enable+start codex (implied by reuse)
  #   --source-agent "$SRC_AGENT" --org "$ORG" --instance "$INSTANCE"
  #                                    # required for reuse-cutover + boot
```

**Flag semantics (engine):** all four flags default to the SAFE path. `--bot-mode
none` (default) and `--boot no` (default) = source untouched, codex disabled, no
token change — byte-identical to running with no flags at all. The destructive
parts ONLY happen when the user-confirmed flags are present:
- `--bot-mode reuse` -> (i) source `config.json` enabled:false AND source registry
  entry enabled:false (the cutover source-disable), (ii) source BOT_TOKEN copied
  into the codex `.env` (0600), (iii) boot implied.
- `--bot-mode new` -> writes `--new-bot-token` into the codex `.env`; if the token
  is omitted it writes a `REPLACE_ME_WITH_NEW_BOT_TOKEN` placeholder and emits a
  needs-human line. Source is NOT touched.
- `--boot now` (or implied by reuse) -> flips codex `config.json` + registry to
  enabled:true and runs `cortextos enable <target> --org <org>` to start it.
The engine prints an `end_state` (`disabled` | `live` | `cutover-live`) on stdout;
STEP 5 of the report keys off it.

`convert.py` performs the deterministic transforms (detailed per-artifact in the next
section). It does NOT make judgment calls: it stages the CLAUDE.md fold for your
review, copies leakage-clean custom skills, rewrites mechanical refs, transforms
`.mcp.json` into TOML it prints for you to merge, and drops the `.force-fresh` marker.
After it runs, do the human steps it flags (fold review, leakage rewrites, MCP merge,
symlink install).

**By default it leaves the agent DISABLED in BOTH places.** `add-agent` registers the
new agent in the instance registry `$CTX_ROOT/config/enabled-agents.json` as
`enabled:true`, and the daemon reads THAT registry (not the agent-dir config.json) for
live enable state. So setting only config.json `enabled:false` would leave a migrated
agent LIVE. With no interactive flags, convert.py flips the target's registry entry to
`enabled:false` too (merge-only, touching no other agent's key), and verify.py asserts
both — enabling is then a separate explicit step. **The ONLY way the target boots (or the
source gets disabled) is when the user-confirmed STEP 2 flags are passed:** `--boot now`
re-enables the target in both places and starts it via `cortextos enable`; `--bot-mode
reuse` additionally disables the SOURCE in both places (the cutover). Absent those flags,
nothing is enabled and the source is never touched.

### Step 4 — Human judgment steps (the parts no script can do)

1. **Review the folded AGENTS.md.** `convert.py` appends the source CLAUDE.md's
   substantive content under a clearly-labeled section. A blind concat can put
   contradictory instructions into the ONE file codex auto-reads. Read the merged
   AGENTS.md end to end, de-duplicate overlapping sections (session-start protocol,
   etc.), and resolve conflicts in favor of the codex-tuned wording. This is mandatory.
2. **Adjudicate leakage-flagged custom skills.** For each custom skill with
   `leakage_hits`: if the hits are mechanically rewritable (a `.claude/skills/x` path,
   an `ANTHROPIC_API_KEY` mention) `convert.py` already rewrote them — confirm. If the
   skill embeds Claude-Code-only BEHAVIOR (relies on `ExitPlanMode`, the Claude `Agent`
   tool's subagent types, or `mcp__<x>__*` tool calls), it is NEEDS-HUMAN: hand it to
   the `skill-creator` skill for a codex rewrite. Do not ship a broken skill — it
   degrades the codex agent on first boot. Note: grep-clean is necessary, not
   sufficient; a skill can pass the grep and still depend on Claude tool semantics, so
   a boot-probe (Step 5 Tier 2) is the real confirmation.
3. **Install the symlinks.** After custom skills are in
   `plugins/cortextos-agent-skills/skills/`, ensure every one has a host symlink:
   `~/.codex/skills/<target>__<skill>`. Re-running `cortextos add-agent`'s symlink path
   is the cleanest way; `convert.py --apply` also creates them directly. The installer
   ONLY walks `plugins/cortextos-agent-skills/skills/*` — so put ALL custom skills
   there, never in `.agents/skills/` (which gets no symlink). Symlinks are REQUIRED,
   not optional; do not rely on cwd-relative discovery masking a miss.
4. **Merge MCP servers + provision secrets.** For each populated MCP server,
   `convert.py` printed a `[mcp_servers.<name>]` TOML block. MERGE it into the
   host-global `~/.codex/config.toml` (never overwrite the file — it is shared by all
   codex agents). The secret is NOT in the block: it is referenced via
   `bearer_token_env_var`. Add that env var to `orgs/<org>/secrets.env` (or the shell
   profile). Codex resolves it at app-server startup.
5. **Verify host model auth exists.** Codex model auth is host-global
   (`~/.codex/auth.json`), selected as `model` in `~/.codex/config.toml`. VERIFY it
   exists (`codex` is logged in); NEVER mint or copy model credentials per agent. The
   agent `.env` stays Telegram/bus/tool secrets only — no gpt-5.5 auth in `.env`.
   `cortextos doctor` covers host-level auth/binary checks; reuse it.

### Step 5 — VERIFY

**THE GATE (NON-NEGOTIABLE).** The migration is NOT "done" until `verify.py` exits
`0`. Every step before this is best-effort; `verify.py` is the OUTCOME-ASSERTION that
the agent actually WORKS after cutover, not merely that files COPIED. A non-zero exit
is a HARD STOP: do NOT report success, do NOT enable the target, do NOT tell the user
"migrated" — fix the failing assertion (or surface it as a blocking needs-human) and
re-run until it passes. Verify is mandatory and runs on BOTH the dry-run and the
`--apply` pass; the `--apply` run's green is the one that authorizes "done".

```bash
python3 "$SKILL_DIR/scripts/verify.py" \
  --target-dir "orgs/$ORG/agents/$TARGET" --target-agent "$TARGET" --ctx-root "$CTX_ROOT" \
  --source-dir "$SRC_DIR" --source-agent "$SRC_AGENT" \
  --migration-start-ts "$MIGRATION_START_TS"
  # --source-dir/--source-agent enable the cron-UNION assertion (and the cutover
  # source-disable check); --migration-start-ts enables the fresh-handoff assertion.
  # Match the assertion to the end state the user chose in STEP 2:
  #   (no flag)         default -> assert codex DISABLED in config.json + registry
  #   --expect-boot     user chose --boot now (new-bot path) -> assert codex ENABLED
  #   --expect-cutover  user chose bot reuse -> assert codex ENABLED *and* the
  #                     SOURCE disabled in both config.json + registry
```

- **Tier 1 (static, always).** Asserts the codex tree is well-formed:
  `config.json.runtime == codex-app-server`, `model` present, the codex
  enabled-state matches the chosen end state (DEFAULT: `enabled:false` in
  config.json AND in the registry `$CTX_ROOT/config/enabled-agents.json` — the
  daemon reads the registry, so it is the load-bearing assertion; with
  `--expect-boot`/`--expect-cutover` it instead asserts `enabled:true` in both, and
  `--expect-cutover` additionally asserts the SOURCE is `enabled:false` in both),
  NO `CLAUDE.md`, NO `.claude/settings.json`,
  AGENTS.md present, every custom skill present under `plugins/.../skills/` AND
  symlinked, `.env` present and 0600, no stale `codex-app-server-thread.json` (and
  no `*thread.json`), `.force-fresh` marker present. ALSO asserts the migration
  invariants: `state/<target>/.onboarded` present (no cold-onboard); the
  source-generated fresh handoff is the NEWEST file in `state/<target>/handoffs/`
  and `.handoff-doc-path` references it; the target cron set matches the source
  union (no drops) and every cron's cd/skills path resolves in the target workspace;
  no migrated cron sends direct to the principal; the routing+approval guardrails are
  present in the target bootstrap (`GUARDRAILS.md` + `approval_rules`).
  ALSO the does-it-WORK assertions: every custom skill symlink RESOLVES (not just
  exists — a dangling/mis-targeted link FAILS, since Codex can't load it); every
  MCP server the source declared is installed as `[mcp_servers.<name>]` in
  `~/.codex/config.toml` with its bearer token in `secrets.env` (else a live 401);
  every migrated `*.db` passes a sqlite `integrity_check` (no torn live-copy);
  and on `--expect-cutover`: the recurring source crons are disabled in the source
  `config.json` too (not just the registry — the config==registry drift guard), and
  NO sibling agent strands a hardcoded ref to the retired `agents/<source>` path
  (it would read stale/empty post-cutover — repoint it to `agents/<target>`).
- **Tier 2 (live boot probe, only on explicit go).** This enables the agent for a
  bounded probe, watches the log, then disables it. It costs codex tokens and briefly
  puts the agent live — never run it in dry-run, never without explicit user go.
  Signals (from the adapter):
  - boot OK: log contains `[codex-app-server] ready thread=<id>` (BOOTSTRAP_PATTERN).
  - boot FAIL: log contains `[codex-app-server] degraded:`.
  - loop OK: a `turn/completed` fires and `last_idle.flag` is written after a trivial
    probe turn.
  - skills wired: `skills/list` returns the expected custom-skill names.
  This is a boot probe, not a soak. Label it as such; do not claim a soak passed.

### Step 6 — REPORT

Render `references/report-template.md`, filled from the manifest + convert log +
verify results. Rules:
- **Lossy / dropped items are NEVER silent.** Every dropped or transformed artifact
  gets a line with a reason and the codex-native alternative (or an honest "lost").
- **Order by severity:** hard-stops first, then dropped (no-equivalent), then
  needs-human, then transformed, then the clean 1:1 list last. Do not bury a dropped
  behavior under green checkmarks.
- **Separate "done" from "needs you."** The needs-human section is the blocking set;
  the agent stays disabled until those are resolved.
- The dry-run report IS the approval artifact: the user reads it, then re-runs
  `--apply` with the STEP 2 flags. LEAD with the END STATE line matching the
  engine's `end_state` (cutover-live / live / disabled — see report-template.md).
- For the DISABLED end state, end with the exact enable command, gated on review:
  `cortextos enable <target> --org <org>`. For LIVE / CUTOVER-LIVE, the agent is
  already booting — give the boot-probe + rollback commands from the template
  instead.

## Per-artifact handling (the mapping)

This is the lookup the scripts implement. Use it to read the manifest and the report.

### config.json — TRANSFORM (mechanical)
Flip `runtime` `"claude-code"` -> `"codex-app-server"` (this is the ONLY field the
daemon branches on to select the codex PTY — setting it wrong silently keeps the
claude PTY). Set `model` to a codex model (`gpt-5-codex` template default; `gpt-5.5`
also valid). DROP `dangerously_skip_permissions` (meaningless — codex hardcodes
`approvalPolicy:'never'` / `danger-full-access`). DROP the `ecosystem` block (the
codex template does not carry it). ADD `codex_context_cap` (default 256000) so codex
has a context-window fallback when the app-server reports null `modelContextWindow`.
CARRY all runtime-agnostic knobs from the source: `timezone`, `day_mode_*`,
`communication_style`, `approval_rules`, `startup_delay`,
`max_session_seconds`, `max_crashes_per_day`, `crash_window`, `telegram_polling`.
`crons[]` is NOT carried here — it is migrated separately (see Crons below)
because config.json can DIVERGE from the live registry.
`agent_name` is set to the TARGET name (not the source). `working_directory` is
NOT carried verbatim: if the source pins a launch path INSIDE its own agent dir,
the target would inherit the same `~/.claude/projects/<dashed-path>/` JSONL key
and share the source's stale session state (defeating the `.force-fresh` guard) —
that case is a HARD STOP, and the target is left with `working_directory=""` (its
own dir). A working_directory pointing OUTSIDE the source agent dir (a genuine
external repo) is carried.

Cost note: `dashboard/src/lib/cost-parser.ts` maps any model containing `gpt-5` to
`gpt-5-codex` PRICING. So a `gpt-5.5` agent is costed at gpt-5-codex rates. If gpt-5.5
has different real pricing, flag it as needs-human (cost rows will be wrong until a
dedicated `gpt-5.5` pricing entry is added) — the migration does not block on it but
the report must name it.

### CLAUDE.md -> AGENTS.md fold — TRANSFORM + NEEDS-HUMAN review
Codex has NO `CLAUDE.md`; `AGENTS.md` is the only file codex auto-reads. If the source
CLAUDE.md is a thin `@AGENTS.md` wrapper, just drop it. If it has real per-agent
content (inbox routing, graphify rules, etc.), fold that content into AGENTS.md under a
labeled heading, rewrite Claude-isms during the fold (`.claude/skills/x` paths,
`~/.claude/` mentions, CLAUDE.md-cascade phrasing), then DELETE CLAUDE.md from the
target. The concat is automatic; the semantic de-dup is a mandatory human review.

### Skills relayout — TRANSFORM
`.claude/skills/<skill>/` -> `plugins/cortextos-agent-skills/skills/<skill>/SKILL.md`.
Diff the source skill set against the 23-skill codex stdlib (see
`references/codex-bundled-skills.txt`): skills already in the bundle come for free via
`add-agent` — do NOT re-copy. RE-EXAMINE any skill that is a Claude-STANDARD/bundled
skill but absent from the codex 23 (e.g. `one-big-feature`, `skill-creator`, `docx`,
`code-review`): the grep treats it as plain custom, but it can carry Claude-specific
orchestration semantics (subagent types, plan-mode loops, ExitPlanMode) that a token
grep misses. detect.py flags these as needs-human; confirm a codex equivalent exists
or rewrite via skill-creator before shipping. For each CUSTOM skill (not in the bundle):
leakage-grep first (`references/leakage-tokens.txt`); if clean, copy the whole dir verbatim
(SKILL.md + resources/ + templates/); if it has mechanically-rewritable refs, copy +
rewrite; if it embeds non-portable Claude behavior, NEEDS-HUMAN -> skill-creator.
Then `convert.py` re-runs the FULL symlink install over EVERY dir in
`plugins/cortextos-agent-skills/skills/*` (bundled + custom), creating/refreshing
`~/.codex/skills/<target>__<skill>` for each — idempotent, and it never clobbers a
real (non-symlink) file at the link path. This is deliberate: verify.py asserts a
symlink for every skill dir incl the 23 bundled ones, and add-agent's installer
silently no-ops on a pre-existing non-symlink, so the scripted path must guarantee
the links itself rather than assume them. The marketplace.json registration ships
with the codex skeleton from `add-agent`.

### Hooks (.claude/settings.json) — mostly RE-EXPRESSED, three DROPPED
DELETE `.claude/settings.json`; no codex file replaces it. See
`references/hooks-disposition.md` for the per-hook table. Summary: the allowlist and
auto-allow are SUPERSEDED by codex's hardcoded autonomy; idle-flag, context-status,
crash-alert, typing, and boot-notify are RE-EXPRESSED natively by the adapter/daemon
(NOT lost); only three behaviors genuinely DROP — plan-mode->Telegram,
AskUserQuestion->Telegram, PreCompact->Telegram. Re-home those to the bus `approvals`
flow and report them as needs-human. NEVER emit a blanket "hooks lost."

### MCP (.mcp.json) -> ~/.codex/config.toml [mcp_servers.<id>] — TRANSFORM + NEEDS-HUMAN
Empty `.mcp.json` -> no-op (report "no MCP servers"). Populated -> for each server emit
a `[mcp_servers.<name>]` TOML table into the HOST-GLOBAL `~/.codex/config.toml` (MERGE,
never overwrite). Each server sets EITHER `command` (stdio) OR `url` (HTTP). HTTP:
`url` + `bearer_token_env_var` (the token is referenced, never inlined). stdio:
`command`, `args`, `env` (canonical sub-table `[mcp_servers.<id>.env]` with `KEY = "VALUE"` lines, per OpenAI docs), `cwd`, `enabled`, `startup_timeout_sec` (alias
`startup_timeout_ms`), `tool_timeout_sec`, `required`, `enabled_tools`,
`disabled_tools`, `default_tools_approval_mode` (auto|prompt|approve).
`bearer_token_env_var` is HTTP-only. Secrets move to env vars (not auto-carried).
See `references/mcp-toml-keys.md`. Host-global name collisions are a hard stop (Step 2).

### Slash commands -> /goal + slash->$skill rewrite — mostly NO-EQUIVALENT
Codex handles only `/goal` locally; every other `/foo` is auto-rewritten to `$foo` and
resolved as a skill. So a slash command whose name matches a present skill works for
free. A Claude-CLI macro with NO backing skill (`commit`, `pr`, `worktree`) becomes
`$macro` and fails skill lookup — author a skill (skill-creator) or report needs-human.
Per-agent `~/.claude/commands/` is usually absent (machine-wide Plane C, out of scope).

### Subagents (.claude/agents/*.md) -> in-session multi-agent — NO-EQUIVALENT on disk
No codex per-agent subagent file exists. If the source defines none (common), report
"no on-disk subagents." If it defines some, do NOT silently drop: list each subagent
name + purpose and re-express as a codex skill or a bus worker-agent (worker-agents
skill). NEEDS-HUMAN.

### Auth env + instruction cross-refs — mixed (one FLAG, one mechanical)
TOOLS.md references to `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are FLAGGED
for human review, NOT auto-stripped: codex model auth is host `~/.codex/auth.json`,
but TOOLS.md is prose and auto-editing it can mangle surrounding instructions, so
`convert.py` emits a needs-human REPORT line and leaves the text in place for you to
edit. (Script and mapping agree: flag-only, not a mechanical transform.) The agent
`.env` (BOT_TOKEN/CHAT_ID/ALLOWED_USER) ports 1:1. The `.claude/skills` ->
`plugins/cortextos-agent-skills/skills` ref-rewrite IS mechanical and automatic:
`convert.py` greps the whole target dir and rewrites every hit in instruction files
and scripts.

### Crons — TRANSFORM (UNION + path-translate + reroute)
Migrate ALL crons, not just config.json's. The source config.json `crons[]` can
DIVERGE from the live cron registry (`$CTX_ROOT/.cortextOS/state/agents/<source>/
crons.json` — the file the daemon actually fires from). convert.py takes the UNION
of both, deduped by name (config.json wins on conflict since it carries the
canonical schedule TYPE), so a cron present in config.json but absent from the live
registry (or vice versa) is still migrated. For each cron prompt it translates BOTH
legs together so the command resolves in the TARGET workspace: the skills path
(`.claude/skills/<x>` -> `plugins/cortextos-agent-skills/skills/<x>`) AND the
workspace path (`agents/<source>` -> `agents/<target>`, matched as a complete path
segment so it never touches a prefix or prose), plus any hardcoded absolute
source-workspace path. Translating only one leg (the prod defect) yields a
`cd agents/<source>` referencing a plugins path that only resolves under
`agents/<target>`. Finally, any cron that sends DIRECT to the principal
(`send-telegram <principal-chat-id>`) is re-routed through the orchestrator (`send-message <orchestrator>`)
per the fleet routing guardrail. verify.py asserts the target cron set matches the
source union, every path resolves in the target, and no cron sends direct to the principal.

### Skill-depth delta — COMPAT SYMLINK (defect 7)
Path translation in the cron PROMPT is not enough: the cron prompts only fix where
the command `cd`s and which script it calls. The SCRIPTS THEMSELVES compute their
workspace-relative output paths from `__file__` at a FIXED depth — e.g.
`OUTPUT_BASE = dirname(__file__)/../../../docs` or `ROOT = Path(__file__).parents[3];
ROOT/"docs"`. Those were correct at claude's depth-3 layout (`.claude/skills/<x>`)
but codex skills sit ONE directory deeper (`plugins/cortextos-agent-skills/skills/<x>`),
so the same anchor resolves to `<ws>/plugins/docs` — one level short — and the script
silently mis-writes output there instead of `<ws>/docs`. (Observed in a real
migration: several skills with depth-pinned output anchors all hit this; a cron can
FIRE yet its command write to the wrong place — scheduler-fire and command-success
are distinct.) `create_skill_depth_compat_symlink` lays a single
`<ws>/plugins/docs -> ../docs` symlink so every depth-short `docs` anchor resolves back
to the real workspace docs (idempotent; merges any mis-written contents first, never
clobbers). verify.py asserts the symlink resolves. CAVEAT: this covers the workspace
DOCS anchor (the observed output class); scripts that anchor NON-docs workspace paths
via the same fixed depth (e.g. `ROOT/".env"`) need manual review.

### Guardrails — ENSURED IN TEMPLATE (routing + approval)
The fleet routing+approval guardrails must land in the migration so EVERY migrated
agent inherits them, not as a per-workspace patch. convert.py's `ensure_guardrails`
guarantees the target bootstrap carries (a) "all principal-facing sends route through
the orchestrator" and (b) "no external action without an explicit per-item go + approval":
it appends both as red-flag rows to the target `GUARDRAILS.md` (idempotent — skipped
if already present) and ensures `config.json.approval_rules.always_ask` gates
`external-comms`. verify.py asserts both the prose markers and the config gate.

### Stale Claude session state — EXCLUDE NARROWLY (the crash-loop footgun)
NEVER carry the stale SESSION TRANSCRIPTS, but DO carry the boot-state continuity
markers. Claude JSONL session state lives in Plane C
(`~/.claude/projects/<dashed-launch-path>/*.jsonl`); codex ignores it for
`shouldContinue` (it keys on `codex-app-server-thread.json` existence), but a stale
`codex-app-server-thread.json` (or any `*thread.json`) would make codex attempt a
`thread/resume` against a thread that never existed for it -> resume timeout ->
crash loop. So convert.py: (1) CARRIES the boot-state continuity markers
source->target so the agent does NOT cold-onboard — `.onboarded` (the daemon
onboarding gate, agent-process.ts ~699-713, runs ONBOARDING.md when this is absent),
`heartbeat.json`, `.telegram-offset`, `cron-state.json`, `.message-dedup-hashes`,
`.crash_alert_dedup.json`, `.ctx-circuit.json`, `pending-reminders.json`, and the
`handoffs/` directory; (2) EXCLUDES ONLY the stale session transcript(s)
(`codex-app-server-thread.json` / `*thread.json`); (3) drops a `.force-fresh` marker
at `$CTX_ROOT/state/<target>/.force-fresh`. It NEVER wipes the whole state dir (the
over-broad wipe dropped `.onboarded` and forced a cold onboard). verify.py asserts
`.onboarded` is present and no `*thread.json` was carried.

### Everything else — 1:1 / port-verbatim
IDENTITY/SOUL/GUARDRAILS/HEARTBEAT/USER/SYSTEM/MEMORY .md (bodies, after ref-rewrite),
goals.json/GOALS.md, memory/, workspaces (repos/work/staging/projects/experiments/
docs/etc.), skills/drafts/, in-repo state/, and all Plane-B runtime state (crons
registry, heartbeat, flags, daily memory, handoffs, bus inbox/outbox) port 1:1 or are
daemon/bus-regenerated. The catch-all in detect.py ensures any unlisted file lands in
`port_verbatim` and shows up in the report rather than being dropped.

EXCEPTION — identity/path-pinned dot-state is NEVER carried (it goes to `dropped`,
not `port_verbatim`): `.cortextos-env` pins `CTX_AGENT_NAME`/`CTX_AGENT_DIR`/etc to
the SOURCE — copying it makes the target boot AS the source and share the live
source's inbox/state/heartbeat. add-agent regenerates a correct per-agent one.
`.playwright-mcp` is host/session-pinned MCP state. convert.py skips both even if
they somehow reach port_verbatim.

CREDENTIAL DIRS — `auth/`-class dirs are copied but get an explicit REPORT line
("carried — review for stale/agent-specific tokens"), never a silent bulk copy.
Review them before enable; the copied tokens may be source-specific or stale.

## Safety invariants (do not violate)

- Source agent is NEVER modified or deleted, EXCEPT the one explicit cutover case:
  `--bot-mode reuse` disables the source (config.json + registry) so the codex agent
  can take over the single Telegram bot. No other flag, and no default run, touches
  the source. Output is otherwise always a separate codex agent.
- Dry-run is the default. Nothing writes without `--apply`.
- With NO interactive flags the target is left scaffolded + DISABLED in BOTH
  config.json AND the instance registry (enabled-agents.json — the file the daemon
  actually reads). convert.py flips the registry entry merge-only (no other agent
  touched); verify.py asserts it. Enabling is then a separate explicit user step.
  The target ONLY boots when the user passes `--boot now` (or `--bot-mode reuse`,
  which implies boot) — both are user-confirmed STEP 2 choices, never automatic.
- No artifact is silently dropped — catch-all bucket + severity-ordered report.
- Never copy `.claude/settings.json`, Claude JSONL state, or model-auth credentials.
- Never copy `.cortextos-env` or `.playwright-mcp` — they pin the SOURCE's identity/
  session; the target keeps its add-agent-generated `.cortextos-env`.
- Never carry `working_directory` that points inside the source agent dir (shared
  JSONL session key) — that is a hard stop.
- `auth/`-class credential dirs are copied with a loud REPORT line, never silently.
- Merge `~/.codex/config.toml`, never overwrite it (host-shared).
