#!/usr/bin/env python3
"""
detect.py — DETECT stage of the Claude->Codex agent migration.

Walks a source Claude-cortextOS agent dir, classifies EVERY artifact into a
bucket, greps custom skills for Claude-only leakage, and emits a JSON manifest on
stdout. The catch-all `port_verbatim` bucket guarantees no file is silently
dropped just because there is no specific rule for it.

Read-only: never writes to or modifies the source agent.

Usage:
  detect.py --src-dir orgs/<org>/agents/<agent> --ctx-root <CTX_ROOT> --agent <name>
"""
import argparse
import json
import os
import re
import sys

# 23-skill codex stdlib (templates/agent-codex/.../skills). Skills in this set
# ship for free via add-agent; only skills NOT here are "custom".
BUNDLED_SKILLS = {
    "activity-channel", "agent-browser", "agent-management", "approvals",
    "auto-skill", "autoresearch", "bus-reference", "comms", "cron-management",
    "env-management", "event-logging", "guardrails-reference", "heartbeat",
    "human-tasks", "knowledge-base", "m2c1-worker", "memory", "onboarding",
    "soul-philosophy", "system-diagnostics", "tasks", "tool-registration",
    "worker-agents",
}

# Leakage tokens. Split: rewritable (mechanical) vs behavioral (needs-human).
LEAKAGE_REWRITABLE = [".claude/skills", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
LEAKAGE_BEHAVIORAL = ["ExitPlanMode", "bypassPermissions", "hook-", "mcp__", "/loop"]

NON_CODEX_TEMPLATES = {"orchestrator", "analyst", "m2c1-worker", "hermes"}

# Claude-STANDARD / Claude-bundled skills that are NOT in the codex 23-skill
# stdlib. If a source agent carries one of these, it is "custom" by our test
# (absent from BUNDLED_SKILLS) so it gets ported + grepped — but it may embed
# Claude-Code-specific orchestration semantics (subagent types, ExitPlanMode,
# plan-mode loops) that a token grep does NOT catch. Surface for human re-exam.
CLAUDE_STANDARD_NON_CODEX = {
    "one-big-feature", "skill-creator", "docx", "pdf", "pptx", "xlsx",
    "code-review", "security-review", "m2c1", "video-to-skill-pipeline",
}

# Top-level files that are part of the codex instruction family (port, possibly
# with ref-rewrite). Bodies are runtime-agnostic.
ONE_TO_ONE_MD = {
    "IDENTITY.md", "SOUL.md", "GUARDRAILS.md", "HEARTBEAT.md", "USER.md",
    "SYSTEM.md", "MEMORY.md", "GOALS.md",
}


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


# A token appearing ONLY in a skill's NON-INVOCATION surface (its own prose/docs,
# OR its scraped/generated data corpus) means the skill DOCUMENTS or STORES the
# token, not that it DEPENDS on Claude semantics. Two classes:
#  - NARRATIVE: the skill's own human docs (SKILL.md, README, references/docs).
#  - DATA corpus: generated/scraped output the skill writes (transcripts of
#    YouTube videos, digests, cached analysis) — a `/loop` inside a scraped
#    transcript or a "hook-writing" phrase in a video analysis is content ABOUT
#    the world, never a skill invocation.
# An INVOCATION hit (anywhere else — scripts, config, the skill body proper) still
# flags. This is conservative: a real Claude-tool call lives in scripts/SKILL body,
# not in a transcripts/ JSON blob.
NARRATIVE_BASENAMES = {"SKILL.md", "README.md", "README", "CHANGELOG.md"}
NARRATIVE_DIRS = {"references", "docs", "reference", "examples"}
# Data/output subtrees a monitor-style skill populates with scraped/generated content.
DATA_DIRS = {
    "data", "transcripts", "digests", "output", "outputs", "cache", "state",
    "logs", "results", "downloads", "raw", "snapshots", "archive",
}


def _is_non_invocation(relpath):
    """True if relpath is the skill's own prose/docs OR its scraped/generated data
    corpus — i.e. NOT a Claude-tool invocation surface. A token found only in such
    files is documented/stored, not depended on."""
    parts = relpath.split(os.sep)
    base = parts[-1]
    if base in NARRATIVE_BASENAMES:
        return True
    dirparts = parts[:-1]
    if any(p in NARRATIVE_DIRS for p in dirparts):
        return True
    if any(p in DATA_DIRS for p in dirparts):
        return True
    return False


def grep_tokens(root, tokens, prose_aware=False):
    """Return {token: [relpaths]} for any token found under root (text files).

    When prose_aware=True, a token that appears ONLY in the skill's own
    narrative/docs (SKILL.md, README, references/) is NOT reported as a hit:
    documenting a token (e.g. a SKILL.md that explains `/loop`) is not the same
    as depending on it. A token that appears in ANY non-narrative file (scripts,
    config, invocation surfaces) is still reported, with the prose paths included
    for context. This cuts the obvious prose false-positives while staying
    conservative: a real invocation anywhere still flags."""
    raw = {}  # token -> {"narrative": [...], "invocation": [...]}
    for dirpath, dirnames, filenames in os.walk(root):
        # don't descend into binary-ish / vendored trees
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                with open(fp, "r", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue
            rel = os.path.relpath(fp, root)
            narrative = _is_non_invocation(rel)
            for tok in tokens:
                if tok in content:
                    bucket = raw.setdefault(tok, {"narrative": [], "invocation": []})
                    bucket["narrative" if narrative else "invocation"].append(rel)
    if not prose_aware:
        return {tok: b["narrative"] + b["invocation"] for tok, b in raw.items()}
    # prose_aware: drop tokens that are narrative-only; keep ones with any
    # invocation hit (report invocation paths first, then prose for context).
    hits = {}
    for tok, b in raw.items():
        if b["invocation"]:
            hits[tok] = b["invocation"] + b["narrative"]
    return hits


def grep_prose_only(root, tokens):
    """Return {token: [relpaths]} for tokens that appear ONLY in narrative/docs
    (no invocation hit). Used to note 'documents token (prose-only)' in the
    report without firing a needs-human flag."""
    raw = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                with open(fp, "r", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue
            rel = os.path.relpath(fp, root)
            narrative = _is_non_invocation(rel)
            for tok in tokens:
                if tok in content:
                    b = raw.setdefault(tok, {"narrative": [], "invocation": []})
                    b["narrative" if narrative else "invocation"].append(rel)
    return {tok: b["narrative"] for tok, b in raw.items()
            if b["narrative"] and not b["invocation"]}


def detect(src_dir, ctx_root, agent):
    m = {
        "source_agent": agent,
        "source_dir": src_dir,
        "ctx_root": ctx_root,
        "hard_stops": [],
        "config": {},
        "claude_md": {},
        "hooks": {},
        "skills": {"bundled_present": [], "custom": []},
        "mcp": {"present": False, "servers": []},
        "subagents": {"present": False, "names": []},
        "buckets": {
            "one_to_one": [],
            "transform": [],
            "dropped": [],
            "needs_human": [],
            "port_verbatim": [],
        },
        "notes": [],
    }

    if not os.path.isdir(src_dir):
        m["hard_stops"].append(f"source dir not found: {src_dir}")
        return m

    # --- config.json ---
    cfg_path = os.path.join(src_dir, "config.json")
    cfg = read_json(cfg_path)
    if cfg is None:
        m["hard_stops"].append("config.json missing or unparseable")
    else:
        runtime = cfg.get("runtime", "claude-code")
        m["config"] = {
            "runtime": runtime,
            "model": cfg.get("model"),
            "has_ecosystem": "ecosystem" in cfg,
            "has_dangerously_skip": "dangerously_skip_permissions" in cfg,
            "has_codex_context_cap": "codex_context_cap" in cfg,
            "carry_knobs": {k: cfg.get(k) for k in (
                "timezone", "day_mode_start", "day_mode_end", "communication_style",
                "approval_rules", "startup_delay", "max_session_seconds",
                "max_crashes_per_day", "crash_window", "working_directory",
                "telegram_polling") if k in cfg},
            "cron_count": len(cfg.get("crons", []) or []),
        }
        if runtime == "codex-app-server":
            m["hard_stops"].append("source is ALREADY codex-app-server — nothing to migrate")
        elif runtime == "hermes":
            m["hard_stops"].append("source runtime is hermes — out of scope")
        # Best-effort, ADVISORY-only template-lineage check for the three
        # non-codex templates that are NOT distinguishable by runtime
        # (orchestrator/analyst/m2c1-worker all run as claude-code). No template
        # field is persisted in config.json, so this is a heuristic on identity
        # files — it NEVER hard-stops (would false-fire on customized agents);
        # the operator must confirm lineage (SKILL.md Step 2 #1, a HUMAN pre-check).
        for marker_file, phrases in (
            ("IDENTITY.md", ("Analyst Identity", "Orchestrator Identity")),
            ("SYSTEM.md", ("You are the orchestrator", "You are the analyst")),
        ):
            mp = os.path.join(src_dir, marker_file)
            if os.path.isfile(mp):
                try:
                    with open(mp, errors="ignore") as f:
                        head = f.read(2000)
                except Exception:
                    head = ""
                for ph in phrases:
                    if ph in head:
                        m["notes"].append(
                            f"ADVISORY (template lineage): {marker_file} contains "
                            f"'{ph}' — source may be scaffolded from a NON-CODEX "
                            f"template (orchestrator/analyst/m2c1-worker). Confirm "
                            f"before migrating; no codex variant exists for these.")
        m["buckets"]["transform"].append("config.json")
        model = cfg.get("model", "")
        if isinstance(model, str) and model.startswith("gpt-5.5"):
            m["notes"].append("target model gpt-5.5 is costed as gpt-5-codex in cost-parser; confirm pricing")

    # --- CLAUDE.md ---
    claude_md = os.path.join(src_dir, "CLAUDE.md")
    if os.path.isfile(claude_md):
        with open(claude_md, errors="ignore") as f:
            body = f.read()
        # thin wrapper detection: body is essentially @AGENTS.md + boilerplate
        stripped = re.sub(r"\s+", " ", body).strip()
        thin = ("@AGENTS.md" in body and len(stripped) < 200)
        m["claude_md"] = {"present": True, "thin_wrapper": thin, "bytes": len(body)}
        m["buckets"]["transform"].append("CLAUDE.md (fold into AGENTS.md)")
        m["buckets"]["needs_human"].append("review folded AGENTS.md for duplication/conflict")
    else:
        m["claude_md"] = {"present": False}

    # --- AGENTS.md ---
    if os.path.isfile(os.path.join(src_dir, "AGENTS.md")):
        m["buckets"]["one_to_one"].append("AGENTS.md (becomes sole boot contract; ref-rewrite)")

    # --- instruction family ---
    for fn in sorted(ONE_TO_ONE_MD):
        if os.path.isfile(os.path.join(src_dir, fn)):
            m["buckets"]["one_to_one"].append(fn)
    if os.path.isfile(os.path.join(src_dir, "TOOLS.md")):
        # TOOLS.md ports 1:1 (the .claude/skills ref-rewrite is mechanical), but any
        # Claude auth env names are FLAGGED for human review, not auto-stripped
        # (editing prose is risky). convert.py is flag-only here; surfaced below if hit.
        m["buckets"]["one_to_one"].append("TOOLS.md (ports 1:1; Claude auth env names flagged for human strip if present)")
    if os.path.isfile(os.path.join(src_dir, "ONBOARDING.md")):
        m["buckets"]["transform"].append("ONBOARDING.md (rewrite .claude/skills refs)")

    # --- hooks (.claude/settings.json) ---
    settings = read_json(os.path.join(src_dir, ".claude", "settings.json"))
    if settings is not None:
        events = list((settings.get("hooks") or {}).keys())
        wired = []
        for ev, arr in (settings.get("hooks") or {}).items():
            for entry in (arr or []):
                for h in (entry.get("hooks") or []):
                    cmd = h.get("command", "")
                    wired.append({"event": ev, "matcher": entry.get("matcher"), "command": cmd})
        if "statusLine" in settings:
            wired.append({"event": "statusLine", "matcher": None,
                          "command": (settings["statusLine"] or {}).get("command", "")})
        m["hooks"] = {"present": True, "events": events, "wired": wired}
        m["buckets"]["dropped"].append(".claude/settings.json (delete; 3 in-turn behaviors lost — see hooks-disposition.md)")
        m["buckets"]["needs_human"].append("re-home plan-mode/ask-user/compact Telegram prompts to bus approvals flow")
    else:
        m["hooks"] = {"present": False}

    # --- skills ---
    skills_root = os.path.join(src_dir, ".claude", "skills")
    if os.path.isdir(skills_root):
        for name in sorted(os.listdir(skills_root)):
            sp = os.path.join(skills_root, name)
            if not os.path.isdir(sp):
                continue
            if name in BUNDLED_SKILLS:
                m["skills"]["bundled_present"].append(name)
                continue
            # custom skill — leakage grep.
            # Rewritable tokens (paths/env names): match everywhere (they get
            # mechanically rewritten regardless of where they sit).
            rew = grep_tokens(sp, LEAKAGE_REWRITABLE)
            # Behavioral tokens (Claude tool/runtime semantics): prose-aware, so a
            # skill that merely DOCUMENTS `/loop` in its SKILL.md isn't false-flagged
            # needs_human. Only an INVOCATION hit (a non-narrative file) flags.
            beh = grep_tokens(sp, LEAKAGE_BEHAVIORAL, prose_aware=True)
            # Behavioral tokens that appear ONLY in prose/docs — noted, not flagged.
            beh_prose_only = grep_prose_only(sp, LEAKAGE_BEHAVIORAL)
            entry = {
                "name": name,
                "path": os.path.relpath(sp, src_dir),
                "leakage_rewritable": rew,
                "leakage_behavioral": beh,
                "behavioral_prose_only": beh_prose_only,
                "disposition": "needs_human" if beh else "transform",
            }
            # Claude-standard-but-not-codex-bundled: re-exam even if grep is clean.
            if name in CLAUDE_STANDARD_NON_CODEX:
                entry["claude_standard_non_codex"] = True
                m["buckets"]["needs_human"].append(
                    f"custom skill '{name}' is a Claude-STANDARD skill absent from the "
                    f"codex 23 — re-examine for Claude-specific orchestration semantics "
                    f"the grep can miss (subagent types, plan-mode); verify a codex "
                    f"equivalent or rewrite via skill-creator")
            m["skills"]["custom"].append(entry)
            if beh:
                m["buckets"]["needs_human"].append(f"custom skill '{name}' has behavioral leakage {list(beh.keys())} (invocation) -> skill-creator")
            else:
                m["buckets"]["transform"].append(f"custom skill '{name}' -> plugins/.../skills + symlink")
            if beh_prose_only:
                m["notes"].append(
                    f"custom skill '{name}' DOCUMENTS {list(beh_prose_only.keys())} "
                    f"in prose only (no invocation) — NOT a leak, no needs_human flag")

    # --- MCP ---
    mcp = read_json(os.path.join(src_dir, ".mcp.json"))
    if mcp is not None:
        servers = mcp.get("mcpServers", {}) or {}
        m["mcp"]["present"] = True
        for name, spec in servers.items():
            is_http = "url" in spec or spec.get("type") == "http"
            # Capture the FULL server spec — emit_mcp_toml needs args/env/headers/cwd
            # to write a WORKING config.toml table, not a placeholder. (fix #16: the
            # old parse dropped everything but url/command, so even a non-stub emit
            # had nothing to write for stdio args/env or the http bearer token.)
            m["mcp"]["servers"].append({
                "name": name,
                "transport": "http" if is_http else "stdio",
                "url": spec.get("url"),
                "command": spec.get("command"),
                "args": spec.get("args") or [],
                "env": spec.get("env") or {},
                "cwd": spec.get("cwd"),
                "headers": spec.get("headers") or {},
            })
        if servers:
            m["buckets"]["transform"].append(f".mcp.json -> {len(servers)} server(s) into ~/.codex/config.toml")
            m["buckets"]["needs_human"].append("provision MCP bearer-token env vars + check host-global name collisions")
        else:
            m["notes"].append(".mcp.json present but empty — no MCP servers to migrate")
    else:
        m["notes"].append("no .mcp.json in source — no MCP servers to migrate")

    # --- subagents ---
    agents_dir = os.path.join(src_dir, ".claude", "agents")
    if os.path.isdir(agents_dir):
        names = [f[:-3] for f in os.listdir(agents_dir) if f.endswith(".md")]
        if names:
            m["subagents"] = {"present": True, "names": names}
            m["buckets"]["needs_human"].append(f"on-disk subagents {names} -> re-express as skills/worker-agents")

    # --- .env (secret-leak guard) ---
    if os.path.isfile(os.path.join(src_dir, ".env")):
        m["buckets"]["one_to_one"].append(".env (BOT_TOKEN/CHAT_ID/ALLOWED_USER)")
        m["buckets"]["needs_human"].append("confirm target uses a NEW bot OR source disabled (BOT_TOKEN reuse conflict)")

    # --- stale Claude session state footgun ---
    work_dir = (cfg or {}).get("working_directory") or src_dir
    launch = os.path.abspath(work_dir)
    dashed = launch.replace(os.sep, "-")
    home = os.path.expanduser("~")
    jsonl_dir = os.path.join(home, ".claude", "projects", dashed)
    m["stale_jsonl_dir"] = jsonl_dir
    m["stale_jsonl_present"] = os.path.isdir(jsonl_dir)
    m["buckets"]["dropped"].append("Claude JSONL session state (excluded; .force-fresh on target)")

    # --- catch-all: every other top-level entry ports verbatim ---
    # Identity/path-pinning dot-state is EXCLUDED from port_verbatim: copying the
    # source's .cortextos-env would overwrite the target's per-agent identity
    # (CTX_AGENT_NAME/CTX_AGENT_DIR/...), making it boot AS the source and share
    # the source's live inbox/state/heartbeat. add-agent regenerates a correct
    # per-agent one in the target. .playwright-mcp is host/session-pinned MCP
    # state and must not carry either.
    identity_pinning = {".cortextos-env", ".playwright-mcp"}
    known_handled = {
        "config.json", "CLAUDE.md", "AGENTS.md", "TOOLS.md", "ONBOARDING.md",
        ".claude", ".mcp.json", ".env",
    } | ONE_TO_ONE_MD | {"goals.json"} | identity_pinning
    for name in sorted(os.listdir(src_dir)):
        if name in known_handled:
            continue
        if name in (".git", "node_modules"):
            continue
        m["buckets"]["port_verbatim"].append(name)
    for name in sorted(identity_pinning):
        if os.path.exists(os.path.join(src_dir, name)):
            m["buckets"]["dropped"].append(
                f"{name} (identity/path-pinned; NOT carried — target's add-agent-generated one stands)")

    if os.path.isfile(os.path.join(src_dir, "goals.json")):
        m["buckets"]["one_to_one"].append("goals.json")

    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-dir", required=True)
    ap.add_argument("--ctx-root", required=True)
    ap.add_argument("--agent", required=True)
    args = ap.parse_args()
    manifest = detect(args.src_dir, args.ctx_root, args.agent)
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")
    # exit non-zero if hard stops, so a caller can gate on it
    sys.exit(2 if manifest["hard_stops"] else 0)


if __name__ == "__main__":
    main()
