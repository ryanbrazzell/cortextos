# Migration Report: <source> (claude-code) -> <target> (codex-app-server)

Mode: DRY-RUN | APPLIED          Date: <iso>

## END STATE  (lead with the ONE line that matches the engine's `end_state`)
- cutover-live: **<target> is live on the ORIGINAL bot; Claude <source> is disabled.**
- live:         **<target> is live on its NEW bot; <source> is still running.**
- disabled:     **Ready — run `cortextos enable <target> --org <org>` when you're happy.**

## Summary
- Portable 1:1:    N artifacts
- Transformed:     M artifacts
- Dropped (no eq): K artifacts
- Needs human:     J items
- Verify:          BOOT <pass|fail|not-run> · LOOP <...> · SKILLS <n/n wired>
- Bot strategy:    REUSE (cutover) | NEW (side-by-side) | unchanged
- End state:       <disabled | live | cutover-live>
                   disabled  -> codex enabled:false in config.json AND registry
                   live      -> codex enabled:true in both; source untouched
                   cutover-live -> codex enabled:true in both; SOURCE disabled in both

## HARD STOPS  (must resolve before --apply; none = good)
- <e.g. MCP server "supabase" name-collision in ~/.codex/config.toml — resolve first>
- <e.g. target name collides with existing dir — disable/rename source or use -codex suffix>

## NOT migrated — no codex equivalent (DROPPED, with reason)
- Hooks: plan-mode -> Telegram approval gate (hook-planmode-telegram) — codex has no
  ExitPlanMode event. Replacement: bus approvals flow.
- Hooks: AskUserQuestion -> Telegram (hook-ask-telegram) — no codex AskUserQuestion
  tool. Replacement: normal Telegram message via cortextos bus send-telegram.
- Hooks: PreCompact -> Telegram notice (hook-compact-telegram) — codex has no
  compaction event. Continuity rides max_session_seconds session-refresh.
- Claude JSONL session state — intentionally excluded (stale resume = crash loop).
- <any custom skill / subagent that could not be ported>

## NEEDS HUMAN INPUT (blocking — agent left DISABLED)
- Review folded AGENTS.md for duplication/conflict (CLAUDE.md content merged in).
- MCP secrets: add <ENV_VAR> to orgs/<org>/secrets.env for each migrated server.
- Telegram creds: confirm target uses a NEW bot OR source is disabled (BOT_TOKEN reuse).
- Custom skill "<x>" failed leakage adjudication (INVOCATION hit) -> hand to skill-creator.
- Custom skill "<x>" is a Claude-STANDARD skill absent from the codex 23
  (one-big-feature/skill-creator/docx/...) -> re-examine for Claude orchestration
  semantics the grep misses; verify codex equivalent or rewrite.
- TOOLS.md references Claude auth env (ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN) ->
  flagged for human strip (prose not auto-edited).
- Slash macro "<y>" has no backing skill -> author a skill or drop.
- gpt-5.5 cost: priced as gpt-5-codex in cost-parser; confirm pricing if on gpt-5.5.
- Verify host codex login exists (~/.codex/auth.json) — do NOT mint per-agent.

## Transformed (artifact -> change applied)
- config.json -> runtime flipped, model=<codex model>, dangerously_skip_permissions +
  ecosystem dropped, codex_context_cap added, knobs carried.
- CLAUDE.md -> folded into AGENTS.md (review required), source CLAUDE.md deleted.
- .claude/settings.json -> deleted (idle/context/crash RE-EXPRESSED natively; 3 dropped above).
- skill "<custom>" -> moved to plugins/.../skills + symlinked; <leakage result>.
- .mcp.json -> N servers -> [mcp_servers.*] TOML printed for config.toml merge.
- instruction refs -> .claude/skills paths rewritten to plugins/.../skills.
- .force-fresh marker dropped; stale codex-app-server-thread.json removed.
- registry enabled-agents.json[<target>].enabled -> false (merge-only; daemon-read disable).
- nested .claude/ + CLAUDE.md inside copied content removed (recursive sweep).

## Carried items to confirm (large / binary / scratch — not silently bulk-copied)
- <e.g. example-image.png (519 KB) — confirm it belongs in the codex agent>
- <large/binary/scratch carried items each get a line; review before enable>

## Migrated 1:1
- IDENTITY/SOUL/GUARDRAILS/HEARTBEAT/USER/SYSTEM/MEMORY .md, goals.json, GOALS.md,
  memory/, .env (BOT_TOKEN/CHAT_ID/ALLOWED_USER), crons[], workspaces, skills/drafts/,
  in-repo state/, <any port_verbatim catch-all files>.

## How to finish
    # DISABLED end state (default): after reviewing everything above and
    # resolving needs-human items, boot it when ready:
    cortextos enable <target> --org <org>

    # LIVE / CUTOVER-LIVE end state: the agent is already booting. Confirm health
    # with the boot probe (verify.py Tier 2) and watch the bot. For a CUTOVER,
    # the source is disabled — to roll back, re-enable the source and disable the
    # codex agent:
    #   cortextos enable <source> --org <org>
    #   cortextos disable <target> --org <org>
