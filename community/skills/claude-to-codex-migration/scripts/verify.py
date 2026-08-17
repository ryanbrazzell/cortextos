#!/usr/bin/env python3
"""
verify.py — VERIFY stage (Tier 1 static) of the Claude->Codex migration.

Asserts the converted codex tree is well-formed. Read-only. Exit non-zero if any
check fails. Tier 2 (live boot probe) is NOT done here — it enables a live agent,
costs tokens, and must be run by the operator with explicit go (see SKILL.md
Step 5 / the boot/loop/skills signals).

Usage:
  verify.py --target-dir <tgt> --target-agent <name> --ctx-root <CTX_ROOT>
            [--expect-boot] [--expect-cutover --source-dir <src> --source-agent <name>]

End-state expectation flags (set by the implementing agent from the user's Step 2
answers). Default = today's behavior (assert codex DISABLED in both places):
  (none)           : assert codex enabled:false in config.json AND registry.
  --expect-boot    : the user chose to boot -> assert codex enabled:true in BOTH.
  --expect-cutover : the user chose bot reuse -> implies boot AND additionally
                     asserts the SOURCE is enabled:false in BOTH config.json and
                     the registry (the cutover source-disable). Needs --source-dir
                     and --source-agent.
"""
import argparse
import json
import os
import re
import sys

# Approval guardrail marker — instance-GENERAL cortextOS safety, always asserted.
APPROVAL_MARKERS = ("explicit per-item go", "per-item go")
# The routing guardrail is instance-SPECIFIC; its presence is asserted (and its
# marker built) only when an orchestrator is known — see routing_guardrail_present().


def _looks_numeric_id(v):
    return bool(v) and str(v).strip().isdigit()


def _read_env_value(env_path, *keys):
    if not os.path.isfile(env_path):
        return None
    lut = {}
    with open(env_path, errors="ignore") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                lut[k.strip()] = v.strip()
    for k in keys:
        if lut.get(k):
            return lut[k]
    return None


def resolve_principal_chat_id(target_dir, param=None):
    """Principal chat id, derived the SAME way convert did but from the TARGET .env
    (the target inherited the source .env). param -> CHAT_ID -> ALLOWED_USER(numeric)
    -> None."""
    if param:
        return str(param).strip()
    env = os.path.join(target_dir, ".env")
    v = _read_env_value(env, "CHAT_ID")
    if v:
        return v
    au = _read_env_value(env, "ALLOWED_USER")
    return au if _looks_numeric_id(au) else None


def resolve_principal_name(target_dir, param=None):
    if param:
        return str(param).strip()
    au = _read_env_value(os.path.join(target_dir, ".env"), "ALLOWED_USER")
    return au if (au and not _looks_numeric_id(au)) else None


def _principal_prose_res(principal_name):
    """Per-instance prose-intent regexes (mirror convert.principal_prose_send_res).
    Empty when the principal name is unknown (prose leg disabled)."""
    if not principal_name:
        return []
    p = re.escape(principal_name)
    return [
        re.compile(
            r"\b(send|sends|sending|tell|telling|notify|notifying|message|messaging|"
            r"ping|pinging|remind|reminding|reminder\s+to|alert|alerting|dm|email|"
            r"emailing|text|texting)\b[^.\n]{0,40}\b" + p + r"\b", re.IGNORECASE),
        re.compile(
            r"\b" + p + r"\b[^.\n]{0,30}\b(a\s+reminder|directly|right away|immediately|"
            r"a\s+summary|a\s+message|a\s+ping|a\s+heads.?up)\b", re.IGNORECASE),
    ]


def _orchestrator_route_re(orchestrator):
    if not orchestrator:
        return None
    o = re.escape(orchestrator)
    return re.compile(
        r"(send-message\s+" + o + r"|through\s+" + o + r"|via\s+" + o +
        r"|route\s+(it\s+)?through\s+" + o + r"|to\s+" + o + r"\b|" + o +
        r"\s+\(route|MIGRATION ROUTING GUARD)", re.IGNORECASE)


def _routes_to_principal(prompt, principal_chat_id, principal_name, orchestrator):
    """True if a cron prompt sends to the principal by chat-id OR prose intent and
    does NOT route through the orchestrator / carry a migration routing guard. Each
    leg is gated on its instance value being known (unknown -> that leg is off)."""
    if principal_chat_id and principal_chat_id in prompt:
        route_re = _orchestrator_route_re(orchestrator)
        if not (route_re and route_re.search(prompt)):
            return True
    prose_res = _principal_prose_res(principal_name)
    if prose_res and any(rx.search(prompt) for rx in prose_res):
        route_re = _orchestrator_route_re(orchestrator)
        return not (route_re and route_re.search(prompt))
    return False


def _source_recurring_crons_still_enabled(source_dir, ctx_root, source_agent):
    """defect 11a OUTCOME-ASSERTION: return the names of RECURRING source crons
    that are STILL enabled in the live registry (crons.json) post-cutover. A clean
    cutover disables every recurring source cron (one-shots are HELD until re-armed
    on the target, so they are excluded). Verify by OUTCOME — re-read the artifact,
    never assume disable_source_crons ran. Non-empty result = the disable step did
    not effectively run (the exact class-bug that hid behind manual rescue)."""
    once_names = set()
    cfg = _load_json(os.path.join(source_dir, "config.json")) or {}
    for c in (cfg.get("crons") or []):
        nm = c.get("name")
        if nm and (c.get("type") == "once" or c.get("fire_at") or c.get("fireAt")):
            once_names.add(nm)
    reg = _load_json(os.path.join(ctx_root, ".cortextOS", "state", "agents",
                                  source_agent, "crons.json"))
    still = []
    if isinstance(reg, dict):
        for c in (reg.get("crons") or []):
            nm = c.get("name")
            if nm and nm not in once_names and c.get("enabled") is not False:
                still.append(nm)
    return sorted(still)


def _load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def _source_cron_union_names(source_dir, ctx_root, source_agent):
    """Names of the EXPECTED migrated cron set: UNION of the source config.json
    crons[] and the source live registry crons.json, deduped by name."""
    names = set()
    cfg = _load_json(os.path.join(source_dir, "config.json")) or {}
    for c in (cfg.get("crons") or []):
        if c.get("name"):
            names.add(c["name"])
    reg = _load_json(os.path.join(ctx_root, ".cortextOS", "state", "agents",
                                  source_agent, "crons.json"))
    if isinstance(reg, dict):
        for c in (reg.get("crons") or []):
            if c.get("name"):
                names.add(c["name"])
    return names


def _sqlite_ok(path):
    """True if `path` is a sound sqlite DB (or a 0-byte placeholder). False if it
    fails PRAGMA integrity_check or cannot be opened. Read-only open — never mutates
    the file. Mirror of convert._sqlite_ok so verify is the INDEPENDENT outcome gate
    for the torn-DB class (#15), not trusting that the convert-time repair ran."""
    try:
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            return True
        import sqlite3
        c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = c.execute("PRAGMA integrity_check;").fetchone()
        finally:
            c.close()
        return bool(row) and row[0] == "ok"
    except Exception:
        return False


def _torn_target_dbs(target_dir):
    """#15 OUTCOME-ASSERTION. Walk the TARGET tree for the agent's OWN *.db files
    (os.walk does NOT follow symlinks, so shared symlinked skill DBs are skipped)
    and return any that fail an integrity_check. A torn copy reads malformed and
    dies on first use; the convert-time backup-API repair is best-effort — THIS is
    the independent gate that FAILS if any migrated DB landed corrupt."""
    torn = []
    for root, dirs, files in os.walk(target_dir):
        dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
        for fn in files:
            if fn.endswith(".db"):
                fp = os.path.join(root, fn)
                # Skip symlinked DBs (a symlink = shared, not the agent's OWN copy).
                # os.walk already won't recurse symlinked DIRS; this also skips a
                # symlinked .db FILE, which os.walk does still list.
                if os.path.islink(fp):
                    continue
                if not _sqlite_ok(fp):
                    torn.append(os.path.relpath(fp, target_dir))
    return sorted(torn)


def _skill_link_resolves(link, skill_dir):
    """A migrated skill symlink must FOLLOW THROUGH to its skill dir. os.path.islink
    is True even for a DANGLING link (target gone) — Codex then fails to load the
    skill while a links-exist check passes. Require the link to resolve AND point at
    this skill dir (catches dangling, missing, and mis-targeted links)."""
    return (os.path.islink(link) and os.path.exists(link)
            and os.path.realpath(link) == os.path.realpath(skill_dir))


def _cron_missing_skill_paths(prompt, target_dir):
    """OUTCOME-ASSERTION (stronger than absence-only): every skills path a migrated
    cron will actually execute must RESOLVE in the target. The cron translation
    rewrites `.claude/skills/<x>` -> `plugins/cortextos-agent-skills/skills/<x>`, where
    convert places BOTH bundled and custom skills. A NEEDS-HUMAN/leaky skill is NOT
    copied (convert.copy_custom_skills skips it) yet its cron ref is still translated —
    leaving a dangling `plugins/.../skills/<x>` the cron fires against nothing. The old
    verify only asserted the source `.claude/skills` substring was ABSENT, which the
    translated prompt satisfies while still pointing at a missing dir. Return the
    referenced skill names whose target dir does NOT exist. Slash-command skill refs
    (e.g. `/humanify`) are not filesystem paths and are intentionally not checked."""
    missing = []
    for rel in re.findall(r"plugins/cortextos-agent-skills/skills/([\w.-]+)", prompt or ""):
        if not os.path.isdir(os.path.join(
                target_dir, "plugins", "cortextos-agent-skills", "skills", rel)):
            missing.append(rel)
    return missing


def _agent_seg_re(agent):
    """Match `agents/<agent>` ONLY as a complete path segment — a trailing name
    char means a DIFFERENT agent (agents/<src> must NOT match agents/<src>-codex).
    The segment ends at /, whitespace, a quote, or end-of-string."""
    return re.compile(r"agents/" + re.escape(agent) + r"(?![\w-])")


def _source_config_recurring_still_enabled(source_dir):
    """Phase-2 config-drift guard. Mirror of _source_recurring_crons_still_enabled
    but for the source CONFIG.JSON (not the live registry).
    convert.disable_source_crons flips the recurring source crons enabled:false in
    BOTH the registry AND config.json; the registry half is asserted (defect 11a)
    but the config.json half was not. A config that still says enabled:true can
    re-enable a disabled cron on the next daemon config-read (the config==registry
    drift class — no hot-reload means the two can diverge). Return recurring crons
    still enabled in source config.json (one-shots excluded — held until re-armed)."""
    cfg = _load_json(os.path.join(source_dir, "config.json")) or {}
    crons = cfg.get("crons") or []
    once_names = set()
    for c in crons:
        nm = c.get("name")
        if nm and (c.get("type") == "once" or c.get("fire_at") or c.get("fireAt")):
            once_names.add(nm)
    still = []
    for c in crons:
        nm = c.get("name")
        if nm and nm not in once_names and c.get("enabled") is not False:
            still.append(nm)
    return sorted(still)


def _stranded_cross_agent_refs(source_dir, source_agent, target_agent):
    """Phase-2 cross-agent OUTCOME-ASSERTION (the migration-strands class).

    Migrating one agent renames its workspace (e.g. agents/<src> -> agents/<src>-
    codex). On CUTOVER the source is retired, so any SIBLING agent that hardcodes
    `agents/<source>/...` now reads a path the producer no longer feeds — an
    empty/stale read that is indistinguishable from a true gap (a stale cross-agent read-
    stale-agents/data class, 4+ confirmed instances). The migration must NOT
    silently rewrite siblings (surgical scope), so verify FAILS LOUD and the
    operator repoints them to agents/<target>.

    Scan every sibling agent dir under the source's agents/ root for an
    `agents/<source>` path SEGMENT ref. Return [(sibling_agent, relpath), ...].
    Excludes the source and target agents themselves."""
    hits = []
    agents_root = os.path.dirname(os.path.normpath(source_dir))
    if not os.path.isdir(agents_root):
        return hits
    seg = _agent_seg_re(source_agent)
    skip = {os.path.basename(os.path.normpath(source_dir)), source_agent, target_agent}
    for sib in sorted(os.listdir(agents_root)):
        sib_dir = os.path.join(agents_root, sib)
        if sib in skip or not os.path.isdir(sib_dir):
            continue
        for dp, dn, fns in os.walk(sib_dir):
            dn[:] = [d for d in dn if d not in ("node_modules", ".git", "state", "logs")]
            for fn in fns:
                if not fn.endswith((".md", ".sh", ".txt", ".json", ".py", ".js", ".ts")):
                    continue
                fp = os.path.join(dp, fn)
                try:
                    with open(fp, errors="ignore") as f:
                        if seg.search(f.read()):
                            hits.append((sib, os.path.relpath(fp, agents_root)))
                except Exception:
                    pass
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target-dir", required=True)
    ap.add_argument("--target-agent", required=True)
    ap.add_argument("--ctx-root", required=True)
    ap.add_argument("--expect-boot", action="store_true",
                    help="assert codex agent is ENABLED (config.json + registry)")
    ap.add_argument("--expect-cutover", action="store_true",
                    help="implies --expect-boot AND asserts the source is disabled")
    ap.add_argument("--source-dir", default=None, help="source agent dir (for --expect-cutover + cron-union check)")
    ap.add_argument("--source-agent", default=None, help="source agent name (for --expect-cutover + cron-union check)")
    ap.add_argument("--orchestrator", default=None,
                    help="orchestrator the reroute targets; the routing OUTCOME-ASSERTION "
                         "fires ONLY when this is known (else safe-degrade no-op). Pass "
                         "the same value convert used.")
    ap.add_argument("--principal-name", default=None,
                    help="principal name for prose-intent detection (else derived from "
                         "target .env ALLOWED_USER if non-numeric).")
    ap.add_argument("--migration-start-ts", type=float, default=None,
                    help="epoch seconds of migration start; the carried handoff in the "
                         "target must have mtime AFTER this (the fresh-handoff assertion)")
    args = ap.parse_args()
    expect_boot = args.expect_boot or args.expect_cutover

    td = args.target_dir
    # INSTANCE-DISCOVERY (mirror convert): who the principal + orchestrator are for
    # THIS deployment. principal_chat_id/name derived from the TARGET .env; the
    # orchestrator comes from --orchestrator (verify does not auto-scan). When the
    # orchestrator is unknown the routing assertion safe-degrades to a no-op.
    v_principal_chat_id = resolve_principal_chat_id(td, None)
    v_principal_name = resolve_principal_name(td, args.principal_name)
    v_orchestrator = args.orchestrator.strip() if args.orchestrator else None
    checks = []  # (ok, label)

    def chk(ok, label):
        checks.append((bool(ok), label))

    # config.json
    cfg_path = os.path.join(td, "config.json")
    cfg = {}
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
        except Exception:
            pass
    chk(cfg.get("runtime") == "codex-app-server", "config.runtime == codex-app-server")
    chk(bool(cfg.get("model")), "config.model present")
    chk("dangerously_skip_permissions" not in cfg, "dangerously_skip_permissions dropped")
    chk("ecosystem" not in cfg, "ecosystem block dropped")

    # Enabled-state assertion is expectation-aware. The daemon reads the REGISTRY
    # ($CTX_ROOT/config/enabled-agents.json), not the agent-dir config.json, for
    # live enable state — so we assert BOTH places against the expected end state.
    reg_path = os.path.join(args.ctx_root, "config", "enabled-agents.json")
    reg = _load_json(reg_path)
    reg_entry = (reg or {}).get(args.target_agent) if isinstance(reg, dict) else None
    chk(reg_entry is not None,
        f"registry entry present for '{args.target_agent}' in enabled-agents.json")
    if expect_boot:
        # Booted path: codex must be ENABLED in both config.json and registry.
        chk(cfg.get("enabled") is True, "target ENABLED (config.json) [--expect-boot]")
        chk(isinstance(reg_entry, dict) and reg_entry.get("enabled") is True,
            "registry entry enabled:true (target enabled in enabled-agents.json) [--expect-boot]")
    else:
        # Default path: codex must be DISABLED in both (the safe end state).
        chk(cfg.get("enabled") is False, "target starts disabled (config.json)")
        chk(isinstance(reg_entry, dict) and reg_entry.get("enabled") is False,
            "registry entry enabled:false (target disabled in enabled-agents.json)")

    # Cutover: the SOURCE must be DISABLED in both config.json AND the registry
    # (the bot-reuse source-disable). Only checked with --expect-cutover.
    if args.expect_cutover:
        if not (args.source_dir and args.source_agent):
            chk(False, "--expect-cutover requires --source-dir and --source-agent")
        else:
            src_cfg = _load_json(os.path.join(args.source_dir, "config.json")) or {}
            chk(src_cfg.get("enabled") is False,
                f"source '{args.source_agent}' config.json enabled:false [--expect-cutover]")
            src_entry = (reg or {}).get(args.source_agent) if isinstance(reg, dict) else None
            chk(isinstance(src_entry, dict) and src_entry.get("enabled") is False,
                f"source '{args.source_agent}' registry enabled:false [--expect-cutover]")
            # The JSON flips alone do NOT stop a live poller — the daemon reads the
            # registry only at startup (no fs.watch). A real cutover must have run
            # `cortextos disable <source>`, which writes a `.user-disable` marker at
            # $CTX_ROOT/state/<source>/.user-disable. Assert it to prove the
            # process-STOP path was taken (not just the JSON edited) — the
            # discriminating signal between "config flipped" and "poller stopped".
            src_marker = os.path.join(args.ctx_root, "state", args.source_agent,
                                      ".user-disable")
            chk(os.path.isfile(src_marker),
                f"source '{args.source_agent}' .user-disable marker present "
                f"(proves `cortextos disable` STOPPED the poller, not just JSON flipped) "
                f"[--expect-cutover]")
            # defect 11a OUTCOME-ASSERTION (the keystone): disabling the source
            # AGENT does NOT disable its CRONS — those stay enabled:true in the live
            # registry and re-fire on any daemon restart/re-enable = durable
            # dual-scheduler. A clean cutover must have disabled every RECURRING
            # source cron. Re-read the registry and FAIL if any is still enabled.
            # This is what catches the "disable step never ran / was hand-rescued"
            # class-bug automatically, instead of trusting the step ran.
            still_enabled = _source_recurring_crons_still_enabled(
                args.source_dir, args.ctx_root, args.source_agent)
            chk(not still_enabled,
                f"all RECURRING source crons disabled post-cutover; still-enabled="
                f"{still_enabled} (one-shots excluded — held until re-armed on target) "
                f"[defect 11a]")
            # Phase 2 config-drift half: the SAME recurring crons must read
            # enabled:false in the source config.json too, or a later daemon
            # config-read re-enables them (config==registry drift; no hot-reload).
            still_cfg = _source_config_recurring_still_enabled(args.source_dir)
            chk(not still_cfg,
                f"all RECURRING source crons disabled in source config.json too; "
                f"still-enabled={still_cfg} (config==registry drift guard) "
                f"[defect 11a / config-drift]")
            # Phase 2 cross-agent strands: no SIBLING agent may keep a hardcoded
            # ref to the retired source's agents/<source> path (it reads stale/empty
            # post-cutover). FAIL LOUD; operator repoints to agents/<target>.
            stranded = _stranded_cross_agent_refs(
                args.source_dir, args.source_agent, args.target_agent)
            chk(not stranded,
                f"no SIBLING agent strands a ref to retired source "
                f"agents/{args.source_agent} (repoint to agents/{args.target_agent}); "
                f"stranded={stranded} [cross-agent strands]")

    # no claude cruft
    chk(not os.path.isfile(os.path.join(td, "CLAUDE.md")), "no CLAUDE.md in target")
    chk(not os.path.isfile(os.path.join(td, ".claude", "settings.json")),
        "no .claude/settings.json")
    chk(not os.path.isdir(os.path.join(td, ".claude")), "no .claude/ dir")

    # core files
    chk(os.path.isfile(os.path.join(td, "AGENTS.md")), "AGENTS.md present")
    chk(os.path.isfile(os.path.join(td, ".agents", "plugins", "marketplace.json")),
        ".agents/plugins/marketplace.json present (codex skeleton)")

    # .env perms
    env_path = os.path.join(td, ".env")
    if os.path.isfile(env_path):
        mode = oct(os.stat(env_path).st_mode & 0o777)
        chk(mode == "0o600", f".env is 0600 (got {mode})")

    # custom skills present + symlinked
    skills_root = os.path.join(td, "plugins", "cortextos-agent-skills", "skills")
    codex_skills = os.path.join(os.path.expanduser("~"), ".codex", "skills")
    if os.path.isdir(skills_root):
        for name in os.listdir(skills_root):
            sp = os.path.join(skills_root, name)
            if not os.path.isdir(sp):
                continue
            link = os.path.join(codex_skills, f"{args.target_agent}__{name}")
            # Phase 2: assert the skill RESOLVES, not merely that a symlink exists.
            chk(_skill_link_resolves(link, sp),
                f"skill '{name}' symlink RESOLVES to its skill dir "
                f"(~/.codex/skills/{args.target_agent}__{name}; not dangling/mis-targeted)")

    # no .claude/skills refs left anywhere
    leaked = []
    for dp, dn, fns in os.walk(td):
        dn[:] = [d for d in dn if d not in ("node_modules", ".git")]
        for fn in fns:
            if fn.endswith((".md", ".sh", ".txt", ".json", ".py", ".js", ".ts")):
                try:
                    with open(os.path.join(dp, fn), errors="ignore") as f:
                        if ".claude/skills" in f.read():
                            leaked.append(os.path.relpath(os.path.join(dp, fn), td))
                except Exception:
                    pass
    chk(not leaked, f"no '.claude/skills' refs left ({len(leaked)} found)" if leaked
        else "no '.claude/skills' refs left")

    # --- DEFECT 15: torn-sqlite outcome gate. Every migrated *.db in the target
    # workspace must pass integrity_check (a live DB raw-copied mid-write tears).
    # The convert-time backup-API repair is best-effort; this is the independent
    # gate that FAILS LOUD if any landed corrupt. ---
    torn_dbs = _torn_target_dbs(td)
    chk(not torn_dbs, f"all migrated *.db pass integrity_check; torn={torn_dbs} [defect 15]")

    # state: fresh boot guaranteed
    state_dir = os.path.join(args.ctx_root, "state", args.target_agent)
    chk(os.path.isfile(os.path.join(state_dir, ".force-fresh")),
        ".force-fresh marker present")
    chk(not os.path.isfile(os.path.join(state_dir, "codex-app-server-thread.json")),
        "no stale codex-app-server-thread.json")

    # --- DEFECT 1: boot-state continuity. .onboarded MUST be present so the daemon
    # does NOT cold-onboard the migrated agent (agent-process.ts gate ~699-713). ---
    chk(os.path.isfile(os.path.join(state_dir, ".onboarded")),
        "target state/.onboarded present (no cold-onboard) [defect 1]")
    # The stale session transcripts MUST be excluded (no *thread.json carried).
    stale_threads = [fn for fn in (os.listdir(state_dir) if os.path.isdir(state_dir) else [])
                     if fn.endswith("thread.json")]
    chk(not stale_threads, f"no stale *thread.json in target state ({stale_threads}) [defect 1]")

    # --- DEFECT 3: read-side handoff. The source-generated fresh handoff is the
    # NEWEST file in the target handoffs/ AND the boot directive references it. ---
    # The read-side handoff carry happens ONLY on a cutover. Its discriminating
    # signal is the .handoff-doc-path boot directive. Only assert the handoff
    # invariants when that directive exists (cutover) OR when --expect-cutover was
    # requested — a non-cutover migration carries no boot directive (and may carry
    # an empty source handoffs/ dir, which must NOT trip the assertion).
    tgt_handoffs = os.path.join(state_dir, "handoffs")
    marker_path = os.path.join(state_dir, ".handoff-doc-path")
    if os.path.isfile(marker_path) or args.expect_cutover:
        files = []
        if os.path.isdir(tgt_handoffs):
            for fn in os.listdir(tgt_handoffs):
                fp = os.path.join(tgt_handoffs, fn)
                if os.path.isfile(fp):
                    files.append((os.path.getmtime(fp), fp))
        newest = max(files)[1] if files else None
        chk(newest is not None, "target handoffs/ contains a handoff file [defect 3]")
        # newest handoff must be AFTER migration start (the FRESH source handoff)
        if newest is not None and args.migration_start_ts is not None:
            chk(os.path.getmtime(newest) > args.migration_start_ts,
                "newest target handoff is FRESH (mtime > migration start) [defect 3]")
        # boot directive references the newest handoff
        directive = None
        if os.path.isfile(marker_path):
            try:
                with open(marker_path) as f:
                    directive = f.read().strip()
            except Exception:
                directive = None
        chk(directive is not None, ".handoff-doc-path boot directive present [defect 3]")
        if directive and newest:
            chk(os.path.abspath(directive) == os.path.abspath(newest),
                "boot directive points at the newest carried handoff [defect 3]")
        # DETERMINISTIC dual-location (defect 3 + 8i): the fresh handoff is ALSO carried
        # into the target WORKSPACE memory/handoffs/ so the agent's native boot/resume
        # path reads it regardless of which location boot consults.
        if newest is not None:
            ws_copy = os.path.join(td, "memory", "handoffs", os.path.basename(newest))
            chk(os.path.isfile(ws_copy),
                "fresh handoff also carried into target workspace memory/handoffs/ "
                "(deterministic dual-location boot read) [defect 3 / 8i]")

    # --- DEFECT 4+5: cron migration. Target cron set MATCHES the source UNION (no
    # drops) and every migrated cron's cd/skills path resolves in the TARGET
    # workspace (no leftover agents/<source> or .claude/skills). DEFECT 6c: no
    # migrated cron sends DIRECT to the principal. ---
    tgt_crons = (cfg.get("crons") or [])
    tgt_cron_names = {c.get("name") for c in tgt_crons if c.get("name")}
    if args.source_dir and args.source_agent:
        want = _source_cron_union_names(args.source_dir, args.ctx_root, args.source_agent)
        missing = sorted(want - tgt_cron_names)
        chk(not missing,
            f"all source-union crons migrated (no drops); missing={missing} [defect 5]")
        chk(len(tgt_cron_names) >= len(want),
            f"target cron count {len(tgt_cron_names)} >= source union {len(want)} [defect 5]")
    # path resolution + direct-to-principal across every migrated cron prompt
    src_agent_for_path = args.source_agent
    bad_path = []
    direct_principal = []
    leftover_skills = []
    # Match `agents/<source>` ONLY as a complete path segment — a trailing name
    # char means it is a DIFFERENT agent (e.g. the translated `agents/<src>-codex`
    # legitimately contains the substring `agents/<src>`). The segment ends at /,
    # whitespace, a quote, or end-of-string.
    src_seg_re = _agent_seg_re(src_agent_for_path) if src_agent_for_path else None
    for c in tgt_crons:
        p = c.get("prompt", "")
        if src_seg_re and src_seg_re.search(p):
            bad_path.append(c.get("name"))
        if ".claude/skills" in p:
            leftover_skills.append(c.get("name"))
        # defect 6c + 14 routing OUTCOME-ASSERTION: catch a send to the principal by
        # EITHER the literal chat id OR prose intent that does not route through the
        # orchestrator / carry a migration routing guard. Fires ONLY when the
        # orchestrator is known (else the reroute was safe-degraded on purpose and
        # asserting it would hard-fail a legitimate degraded migration).
        if v_orchestrator and _routes_to_principal(
                p, v_principal_chat_id, v_principal_name, v_orchestrator):
            direct_principal.append(c.get("name"))
    chk(not bad_path,
        f"no cron retains an unresolvable agents/<source> cd path ({bad_path}) [defect 4]")
    chk(not leftover_skills,
        f"no cron retains a .claude/skills path ({leftover_skills}) [defect 4]")
    chk(not direct_principal,
        f"no migrated cron routes to the principal by chat-id OR prose intent "
        f"({direct_principal}) [defect 6c + 14]"
        + ("" if v_orchestrator else " [SAFE-DEGRADE: orchestrator unknown, assertion off]"))
    # EXISTENCE (stronger than absence): the translated skills path a cron will run
    # must resolve in the target. Catches a NEEDS-HUMAN skill that was cron-referenced
    # but never copied (dangling plugins/.../skills/<x>) — which the absence-only checks
    # above pass GREEN because the source `.claude/skills` substring is gone.
    missing_skill_paths = []
    for c in tgt_crons:
        for rel in _cron_missing_skill_paths(c.get("prompt", ""), td):
            missing_skill_paths.append((c.get("name"), rel))
    chk(not missing_skill_paths,
        f"every migrated-cron skills path resolves in target ({missing_skill_paths}) "
        f"[defect 4 existence]")

    # --- DEFECT 6a/6b: routing + approval guardrails present in target bootstrap. ---
    guard_text = ""
    for fn in ("GUARDRAILS.md", "SOUL.md", "USER.md", "AGENTS.md"):
        gp = os.path.join(td, fn)
        if os.path.isfile(gp):
            try:
                with open(gp, errors="ignore") as f:
                    guard_text += f.read()
            except Exception:
                pass
    gt_low = guard_text.lower()
    has_approval = any(m in guard_text for m in APPROVAL_MARKERS)
    # ROUTING guardrail is instance-specific: assert its presence ONLY when the
    # orchestrator is known (convert injects it only then). Its stable marker phrase
    # names the orchestrator. When unknown, the row is legitimately absent (safe-
    # degrade) — asserting it would hard-fail a valid degraded migration.
    if v_orchestrator:
        has_routing = ("route every principal-facing send through" in gt_low
                       and v_orchestrator.lower() in gt_low)
        chk(has_routing,
            f"routing guardrail present in target bootstrap (principal-facing sends via "
            f"'{v_orchestrator}') [defect 6a]")
    # APPROVAL guardrail is instance-GENERAL — ALWAYS required.
    chk(has_approval,
        "approval guardrail present in target bootstrap (no external action without go) [defect 6b]")
    # config approval_rules gates external-comms
    chk("external-comms" in ((cfg.get("approval_rules") or {}).get("always_ask") or []),
        "config approval_rules.always_ask gates external-comms [defect 6b]")

    # --- DEFECT 7: skill-depth-delta compat symlink. codex skills sit one dir deeper
    # than claude, so scripts anchoring workspace output via __file__ at a fixed depth
    # (../../../docs, parents[3]/"docs") resolve one level short to plugins/docs; a
    # plugins/docs -> ../docs symlink restores writes into <ws>/docs. Asserted only
    # when the target actually carries a plugins/ skill tree. ---
    plugins_dir = os.path.join(td, "plugins")
    if os.path.isdir(plugins_dir):
        compat = os.path.join(plugins_dir, "docs")
        real_docs = os.path.join(td, "docs")
        ok_link = (os.path.islink(compat)
                   and os.path.realpath(compat) == os.path.realpath(real_docs))
        chk(ok_link,
            "plugins/docs -> ../docs compat symlink resolves to <ws>/docs "
            "(depth-short __file__ docs anchors write into workspace) [defect 7]")

        # Informational (NOT a pass/fail gate): the docs compat symlink only covers
        # the workspace-DOCS anchor. Flag any migrated script that anchors a NON-docs
        # workspace path via a fixed __file__ depth (e.g. ROOT/".env", secrets) — those
        # still resolve one level short under the deeper codex layout and need a manual
        # review (per the documented defect-7 caveat).
        skills_root = os.path.join(plugins_dir, "cortextos-agent-skills", "skills")
        anchor_re = re.compile(r"parents\[\d\]|(?:\.\./){3,}")
        nondocs_re = re.compile(r"\.env|secrets|/data\b", re.IGNORECASE)
        flagged = []
        if os.path.isdir(skills_root):
            for dp, dn, fns in os.walk(skills_root):
                dn[:] = [d for d in dn if d not in ("node_modules", ".git", "digests")]
                for fn in fns:
                    if not fn.endswith(".py"):
                        continue
                    fp = os.path.join(dp, fn)
                    try:
                        with open(fp, errors="ignore") as f:
                            txt = f.read()
                    except Exception:
                        continue
                    if "__file__" in txt and anchor_re.search(txt) and nondocs_re.search(txt):
                        flagged.append(os.path.relpath(fp, td))
        if flagged:
            print("  [WARN] non-docs __file__ depth anchors need manual review "
                  f"(not covered by the docs symlink) [defect 7 caveat]: {flagged}")

    # fix #16 OUTCOME-ASSERTION: every MCP server the source declared in .mcp.json
    # must be present as a [mcp_servers.<name>] table in the host-global
    # ~/.codex/config.toml, and every http server's bearer-token env var must be SET
    # in org secrets.env (else the server 401s the moment Codex calls it). This is
    # the gate that FAILS when emit_mcp_toml didn't actually install — the old
    # print-only stub wrote nothing and nothing caught it, so Codex started zero
    # migrated servers undetected. (Live "Codex actually starts it" is the Tier-2
    # boot probe below.) Only checked when --source-dir is given (the .mcp.json
    # ground truth); a source with no MCP servers adds no checks.
    if args.source_dir:
        src_mcp = _load_json(os.path.join(args.source_dir, ".mcp.json"))
        mcp_servers = (src_mcp or {}).get("mcpServers", {}) if isinstance(src_mcp, dict) else {}
        if mcp_servers:
            codex_cfg = os.path.join(os.path.expanduser("~"), ".codex", "config.toml")
            cfg_text = ""
            if os.path.isfile(codex_cfg):
                with open(codex_cfg, errors="ignore") as f:
                    cfg_text = f.read()
            present = set(re.findall(r"(?m)^\s*\[mcp_servers\.([^\].]+)\]\s*$", cfg_text))
            secrets_path = os.path.join(
                os.path.dirname(os.path.dirname(os.path.normpath(td))), "secrets.env")
            secrets_text = ""
            if os.path.isfile(secrets_path):
                with open(secrets_path, errors="ignore") as f:
                    secrets_text = f.read()
            for name, spec in mcp_servers.items():
                chk(name in present,
                    f"MCP '{name}' installed as [mcp_servers.{name}] in ~/.codex/config.toml")
                is_http = "url" in spec or spec.get("type") == "http"
                if is_http:
                    env_var = re.sub(r"[^A-Z0-9]", "_", name.upper()) + "_MCP_TOKEN"
                    has_tok = re.search(r"(?m)^\s*%s\s*=\s*\S" % re.escape(env_var), secrets_text)
                    chk(bool(has_tok),
                        f"MCP '{name}' bearer token {env_var} set in secrets.env (else live 401)")

    # report
    passed = sum(1 for ok, _ in checks if ok)
    print(f"=== Tier 1 static verify: {passed}/{len(checks)} passed ===")
    for ok, label in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if leaked:
        print("  leaked refs:", leaked)
    print("\nTier 2 (live boot probe) NOT run — operator runs it with explicit go.")
    print("Boot OK signal:  [codex-app-server] ready thread=<id>")
    print("Boot FAIL signal: [codex-app-server] degraded:")
    print("Loop OK: turn/completed + last_idle.flag written. Skills: skills/list returns set.")
    print("MCP OK: [codex-app-server] mcp server <name> ready  (FAIL: 'failed to start'/'401'/"
          "server absent from tools/list) — the live half of the #16 MCP gate.")
    sys.exit(0 if passed == len(checks) else 1)


if __name__ == "__main__":
    main()
