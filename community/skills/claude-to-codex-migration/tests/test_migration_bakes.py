#!/usr/bin/env python3
"""Targeted tests for the 4 bakes: 11a (disable_source_crons + outcome-assert),
11b (once-cron registry-form preference), 14 (prose reroute + routing assert),
13 is doc-only. Functional + negative + idempotency. Plus PR#849 review fixes:
R1 (MCP re-run idempotent self-owned overwrite), R2 (cron skills-path existence),
R3 (live-disabled cron survives the union). Each convicts old behavior AND acquits."""
import importlib.util, json, os, sys, tempfile, shutil

SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts")

def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, f"{name}.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

convert = load("convert")
verify = load("verify")

P = F = 0
def ok(cond, label):
    global P, F
    if cond: P += 1; print(f"  PASS {label}")
    else: F += 1; print(f"  FAIL {label}")

# ---------- defect 14 + instance-discovery: parameterized principal-send reroute ----------
# FAKE discovered values only (synthetic names, no roster names/real-chatid anywhere).
print("[14] principal-send reroute (discovered orchestrator/principal, nothing hardcoded)")
CHAT, ORCH, PRIN = "1000000000", "hub", "Casey"
acts = []
new, rr = convert._reroute_principal_sends("Send Casey a reminder to respond to a post.", "c1", acts, CHAT, ORCH, PRIN)
ok(rr and "MIGRATION ROUTING GUARD" in new and ORCH in new, "prose 'Send Casey a reminder' -> guard injected naming the orchestrator")

acts = []
new, rr = convert._reroute_principal_sends("Ask hub to send Casey a summary via hub.", "c2", acts, CHAT, ORCH, PRIN)
ok(not rr, "already orchestrator-routed prose -> NOT double-routed")

acts = []
new, rr = convert._reroute_principal_sends("cortextos bus send-telegram 1000000000 'hi'", "c3", acts, CHAT, ORCH, PRIN)
ok(rr and "send-message hub normal" in new and CHAT not in new, "literal chat-id -> rewritten to the discovered orchestrator")

acts = []
new, rr = convert._reroute_principal_sends("Run the daily metrics scan and log results.", "c4", acts, CHAT, ORCH, PRIN)
ok(not rr, "no principal intent -> not flagged")

# GAP C: known chat_id but UNKNOWN orchestrator -> NO rewrite (no send-into-the-void)
acts = []
new, rr = convert._reroute_principal_sends("cortextos bus send-telegram 1000000000 'hi'", "c5", acts, CHAT, None, PRIN)
ok(not rr and CHAT in new, "GAP C: unknown orchestrator -> literal id left intact, NOT rerouted")

# #10 cross-check: prose fires for the DISCOVERED name, and NOT for a synthetic non-principal 'Rowan'
acts = []
_, rr_casey = convert._reroute_principal_sends("notify Casey directly about the outage", "c6", acts, CHAT, ORCH, PRIN)
_, rr_rowan = convert._reroute_principal_sends("notify Rowan directly about the outage", "c7", acts, CHAT, ORCH, PRIN)
ok(rr_casey, "prose fires for the discovered principal 'Casey'")
ok(not rr_rowan, "DISCRIMINATING: prose does NOT fire for 'Rowan' (proves no hardcoded principal name remains)")

# verify side helper (parameterized, gated legs)
ok(verify._routes_to_principal("Notify Casey directly about the outage.", CHAT, PRIN, ORCH), "verify catches prose to principal")
ok(not verify._routes_to_principal("Send Casey a summary — route through hub.", CHAT, PRIN, ORCH), "verify: orchestrator-routed prose passes")
ok(verify._routes_to_principal("ping 1000000000 now", CHAT, PRIN, ORCH), "verify catches the literal chat-id")
ok(not verify._routes_to_principal("notify Rowan directly", CHAT, PRIN, ORCH), "verify: 'Rowan' is not the principal -> not flagged")

# ---------- F1: routing guardrail on ORCHESTRATOR-KNOWN ALONE (principal_name=None) ----------
# The COMMON live case has a NUMERIC ALLOWED_USER -> resolve_principal_name=None. The
# routing guardrail must STILL inject (gated on the orchestrator, not the name), and
# verify's routing assertion (orchestrator-gated, name-INDEPENDENT) must PASS on it —
# else the ordinary migration hard-fails "routing guardrail present [6a]". Every OTHER
# test sets both values, so this None-principal path was previously untested.
print("[F1] routing guardrail injects + verify agrees when principal_name is None")
_gd = tempfile.mkdtemp()
try:
    convert.ensure_guardrails(_gd, True, [], orchestrator="hub", principal_name=None)
    _gt_low = open(os.path.join(_gd, "GUARDRAILS.md"), errors="ignore").read().lower()
    ok("route every principal-facing send through" in _gt_low and "hub" in _gt_low,
       "F1: routing row injected on orchestrator-known + principal_name=None")
    ok("the principal" in _gt_low and "('none')" not in _gt_low,
       "F1: generic 'the principal' used when name unknown (no literal None leaked into the row)")
    # verify.py's routing assertion is EXACTLY this predicate (verify.py ~617, orchestrator-
    # gated, name-independent). Asserting it True proves convert+verify AGREE — no false-fail.
    ok(("route every principal-facing send through" in _gt_low) and ("hub" in _gt_low),
       "F1: verify routing assertion AGREES (PASSES) on the None-principal migration")
    # the always-injected approval row is present regardless
    _gtext = open(os.path.join(_gd, "GUARDRAILS.md"), errors="ignore").read()
    ok(any(_m in _gtext for _m in verify.APPROVAL_MARKERS),
       "F1: approval guardrail (instance-general) still injected alongside routing")
finally:
    shutil.rmtree(_gd, ignore_errors=True)

# ---------- defect 11b: once-cron registry-form preference (migrate_crons) ----------
print("[11b] once-cron registry crontab preference")
tmp = tempfile.mkdtemp()
try:
    src = os.path.join(tmp, "src"); tgt = os.path.join(tmp, "tgt")
    ctx = os.path.join(tmp, "ctx", "default")
    reg_dir = os.path.join(ctx, ".cortextOS", "state", "agents", "srcagent")
    os.makedirs(src); os.makedirs(tgt); os.makedirs(reg_dir)
    # source config.json: once-cron in type:once form + a recurring + a prose-to-principal cron
    json.dump({"crons": [
        {"name": "annual-task", "type": "once", "fire_at": "2026-06-16T13:00:00Z", "prompt": "cancel annual-task"},
        {"name": "heartbeat", "type": "recurring", "interval": "4h", "prompt": "do heartbeat"},
        {"name": "noregister-once", "type": "once", "fire_at": "2026-06-20T09:00:00Z", "prompt": "remind Casey a reminder"},
    ]}, open(os.path.join(src, "config.json"), "w"))
    # live registry: annual-task as a dated CRONTAB (daemon-loadable) + heartbeat; NOT noregister-once
    json.dump({"crons": [
        {"name": "annual-task", "schedule": "0 13 16 6 *", "enabled": True, "prompt": "cancel annual-task"},
        {"name": "heartbeat", "schedule": "4h", "enabled": True, "prompt": "do heartbeat"},
    ]}, open(os.path.join(reg_dir, "crons.json"), "w"))
    json.dump({"crons": []}, open(os.path.join(tgt, "config.json"), "w"))

    acts = []
    out = convert.migrate_crons(src, tgt, "srcagent", "srcagent-codex", ctx, True, acts, orchestrator="hub", principal_name="Casey")
    by = {c["name"]: c for c in out}
    ok(by["annual-task"].get("type") == "crontab" and by["annual-task"].get("crontab") == "0 13 16 6 *",
       "annual-task once-cron carried as registry crontab (not dropped)")
    ok("type" not in by["annual-task"] or by["annual-task"]["type"] != "once", "annual-task no longer type:once")
    # noregister-once has no registry form -> kept as record + needs-rearm flag
    ok(by["noregister-once"].get("type") == "once", "noregister-once kept as record")
    flagged_rearm = any("NEEDS-REARM" in a and "noregister-once" in a for a in acts)
    ok(flagged_rearm, "noregister-once emitted a NEEDS-REARM flag (not silent)")
    flagged_conv = any("registry's dated crontab" in a and "annual-task" in a for a in acts)
    ok(flagged_conv, "annual-task emitted a converted-crontab flag with re-fire caveat")
    # prose-to-principal (noregister-once prompt 'remind Casey a reminder') -> routing guard in output
    ok("MIGRATION ROUTING GUARD" in by["noregister-once"]["prompt"], "prose-to-principal once-cron got routing guard (discovered orchestrator)")

    # ---------- defect 11a: disable_source_crons ----------
    print("[11a] disable_source_crons")
    acts = []
    disabled, held = convert.disable_source_crons(src, ctx, "srcagent", True, acts)
    ok("heartbeat" in disabled, "recurring 'heartbeat' disabled")
    ok("annual-task" in held, "once 'annual-task' HELD (not disabled)")
    reg2 = json.load(open(os.path.join(reg_dir, "crons.json")))
    rb = {c["name"]: c for c in reg2["crons"]}
    ok(rb["heartbeat"]["enabled"] is False, "registry heartbeat enabled:false")
    ok(rb["annual-task"]["enabled"] is True, "registry annual-task still enabled:true (held)")
    cfg2 = json.load(open(os.path.join(src, "config.json")))
    cb = {c["name"]: c for c in cfg2["crons"]}
    ok(cb["heartbeat"].get("enabled") is False, "config heartbeat enabled:false")

    # outcome-assertion helper: recurring all disabled -> empty
    still = verify._source_recurring_crons_still_enabled(src, ctx, "srcagent")
    ok(still == [], "outcome-assert: no recurring source cron still enabled")

    # idempotency: run disable again -> still clean, no new disables
    acts = []
    d2, h2 = convert.disable_source_crons(src, ctx, "srcagent", True, acts)
    ok(d2 == [], "idempotent: second disable finds nothing recurring to disable")
    ok(verify._source_recurring_crons_still_enabled(src, ctx, "srcagent") == [], "idempotent: still 0 recurring enabled")

    # ---------- 11a NEGATIVE: leave a recurring cron enabled -> assertion catches it ----------
    print("[11a-neg] outcome-assertion catches a missed disable")
    reg3 = json.load(open(os.path.join(reg_dir, "crons.json")))
    for c in reg3["crons"]:
        if c["name"] == "heartbeat": c["enabled"] = True  # simulate the step no-opping
    json.dump(reg3, open(os.path.join(reg_dir, "crons.json"), "w"))
    still_neg = verify._source_recurring_crons_still_enabled(src, ctx, "srcagent")
    ok(still_neg == ["heartbeat"], "NEGATIVE: assertion flags the still-enabled recurring cron")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- defect 15: safe sqlite copy + integrity outcome-assertion ----------
import sqlite3
print("[15] _sqlite_ok unit")
tmp = tempfile.mkdtemp()
try:
    good = os.path.join(tmp, "good.db")
    c = sqlite3.connect(good); c.execute("CREATE TABLE t(x)"); c.executemany("INSERT INTO t VALUES(?)", [(i,) for i in range(50)]); c.commit(); c.close()
    ok(convert._sqlite_ok(good), "_sqlite_ok: valid db -> True")
    garbage = os.path.join(tmp, "torn.db")
    open(garbage, "wb").write(b"SQLite format 3\x00" + os.urandom(4000))  # plausible header, junk body
    ok(not convert._sqlite_ok(garbage), "_sqlite_ok: malformed db -> False")
    empty = os.path.join(tmp, "empty.db"); open(empty, "wb").close()
    ok(convert._sqlite_ok(empty), "_sqlite_ok: 0-byte placeholder -> True")

    # functional: torn target restored from valid source via backup API
    print("[15] ensure_sqlite_integrity restore")
    src = os.path.join(tmp, "src"); tgt = os.path.join(tmp, "tgt")
    srel = os.path.join(".claude", "skills", "dsp", "data")
    trel = os.path.join("plugins", "cortextos-agent-skills", "skills", "dsp", "data")
    os.makedirs(os.path.join(src, srel)); os.makedirs(os.path.join(tgt, trel))
    sdb = os.path.join(src, srel, "signals.db")
    cs = sqlite3.connect(sdb); cs.execute("CREATE TABLE items(id INTEGER, v TEXT)")
    cs.executemany("INSERT INTO items VALUES(?,?)", [(i, f"r{i}") for i in range(200)]); cs.commit(); cs.close()
    tdb = os.path.join(tgt, trel, "signals.db")
    open(tdb, "wb").write(b"SQLite format 3\x00" + os.urandom(3000))  # torn copy
    ok(not convert._sqlite_ok(tdb), "precondition: target db is torn/malformed")
    acts = []
    rep, okl, unrep = convert.ensure_sqlite_integrity(src, tgt, True, acts)
    ok(os.path.join(trel, "signals.db") in rep, "torn target listed as repaired")
    ok(unrep == [], "no unrepairable when source is intact")
    ok(convert._sqlite_ok(tdb), "target db integrity_check ok AFTER restore")
    n = sqlite3.connect(tdb).execute("SELECT COUNT(*) FROM items").fetchone()[0]
    ok(n == 200, "restored target carries full source history (200 rows)")

    # negative: torn target + NO source -> unrepairable (HARD fail, not silent)
    print("[15-neg] unrepairable when source missing -> hard-fail signal")
    tgt2 = os.path.join(tmp, "tgt2"); src2 = os.path.join(tmp, "src2")
    os.makedirs(os.path.join(tgt2, trel)); os.makedirs(src2)
    tdb2 = os.path.join(tgt2, trel, "signals.db")
    open(tdb2, "wb").write(b"SQLite format 3\x00" + os.urandom(3000))
    acts = []
    rep2, okl2, unrep2 = convert.ensure_sqlite_integrity(src2, tgt2, True, acts)
    ok(os.path.join(trel, "signals.db") in unrep2, "NEGATIVE: source-missing torn db -> unrepairable (default-deny gate fires)")
    ok(not convert._sqlite_ok(tdb2), "NEGATIVE: unrepairable db left detectably-bad, not silently passed")
    ok(rep2 == [], "NEGATIVE: nothing falsely reported repaired")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- defect 16: emit_mcp_toml actually installs servers (+ verify gate) ----------
print("[16] MCP emit writes config.toml tables + carries token + collision hard-stop")
import re as _re
tmp = tempfile.mkdtemp()
_orig_home = os.environ.get("HOME")
try:
    home = os.path.join(tmp, "home"); os.makedirs(os.path.join(home, ".codex"))
    os.environ["HOME"] = home  # isolate ~/.codex/config.toml
    tdir = os.path.join(tmp, "orgs", "testorg", "agents", "newagent"); os.makedirs(tdir)
    manifest = {"mcp": {"servers": [
        {"name": "notion", "transport": "http", "url": "https://mcp.notion.com/mcp",
         "command": None, "args": [], "env": {},
         "headers": {"Authorization": "Bearer ntn_SECRET123"}},
        {"name": "local-fs", "transport": "stdio", "url": None, "command": "npx",
         "args": ["-y", "fs-mcp"], "env": {"ROOT": "/data"}, "headers": {}},
    ]}}
    acts = []
    written, needs, coll = convert.emit_mcp_toml(manifest, "newagent", tdir, True, acts)
    cfg_text = open(os.path.join(home, ".codex", "config.toml")).read()
    secrets_text = open(os.path.join(tmp, "orgs", "testorg", "secrets.env")).read()
    # DISCRIMINATING: the old print-only stub wrote NOTHING to config.toml, so every
    # "table present in config.toml" assertion FAILS on the stub and passes only on
    # the real install (the #16 A/B — a same-stderr test would pass on broken code).
    ok("[mcp_servers.notion]" in cfg_text, "http table written to config.toml (stub wrote nothing)")
    ok('bearer_token_env_var = "NOTION_MCP_TOKEN"' in cfg_text, "http: bearer_token_env_var set")
    ok("ntn_SECRET123" not in cfg_text, "http: raw token NOT inlined in config.toml")
    ok("NOTION_MCP_TOKEN=ntn_SECRET123" in secrets_text, "http: token carried into secrets.env from source headers")
    ok("[mcp_servers.local-fs]" in cfg_text and 'command = "npx"' in cfg_text, "stdio table + command written")
    ok('args = ["-y", "fs-mcp"]' in cfg_text, "stdio: args written (stub left a placeholder comment)")
    ok("[mcp_servers.local-fs.env]" in cfg_text and 'ROOT = "/data"' in cfg_text, "stdio: env sub-table written")
    ok(coll == [] and set(written) == {"notion", "local-fs"}, "both servers written, no collision")

    print("[16-neg] host-global name collision -> hard-stop, writes nothing")
    open(os.path.join(home, ".codex", "config.toml"), "w").write('[mcp_servers.notion]\nurl = "x"\n')
    before = open(os.path.join(home, ".codex", "config.toml")).read()
    acts = []
    w2, n2, c2 = convert.emit_mcp_toml(manifest, "newagent", tdir, True, acts)
    after = open(os.path.join(home, ".codex", "config.toml")).read()
    ok("notion" in c2, "NEGATIVE: collision detected and returned")
    ok(w2 == [], "NEGATIVE: nothing reported written on collision")
    ok(before == after, "NEGATIVE: config.toml UNCHANGED on collision (no partial install)")

    print("[16-verify] verify MCP presence gate discriminates absent vs installed")
    rgx = r"(?m)^\s*\[mcp_servers\.([^\].]+)\]\s*$"
    ok("notion" not in set(_re.findall(rgx, "")), "verify: empty config.toml -> server absent (gate FAILS)")
    ok("notion" in set(_re.findall(rgx, "[mcp_servers.notion]\n")), "verify: installed -> server present (gate PASSES)")
finally:
    if _orig_home is not None: os.environ["HOME"] = _orig_home
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- Phase 2A: skill symlink must RESOLVE, not just exist ----------
print("[P2a] skill symlink resolution (dangling/mis-targeted caught)")
tmp = tempfile.mkdtemp()
try:
    skill_dir = os.path.join(tmp, "skills", "myskill"); os.makedirs(skill_dir)
    links = os.path.join(tmp, "links"); os.makedirs(links)
    good = os.path.join(links, "agent__good"); os.symlink(skill_dir, good)
    ok(verify._skill_link_resolves(good, skill_dir), "valid symlink -> resolves (PASS)")
    # DISCRIMINATING: dangling link — os.path.islink is True, so the OLD islink-only
    # check passed; the resolution check must FAIL it.
    missing_target = os.path.join(tmp, "skills", "gone")
    dangling = os.path.join(links, "agent__dangling"); os.symlink(missing_target, dangling)
    ok(os.path.islink(dangling), "precondition: dangling link IS a symlink (old check passed)")
    ok(not verify._skill_link_resolves(dangling, missing_target),
       "DISCRIMINATING: dangling symlink -> does NOT resolve (gate FAILS, islink-only would PASS)")
    # absent link
    ok(not verify._skill_link_resolves(os.path.join(links, "agent__absent"), skill_dir),
       "absent link -> does not resolve")
    # mis-targeted: link exists + resolves but points at the WRONG skill dir
    other = os.path.join(tmp, "skills", "other"); os.makedirs(other)
    mis = os.path.join(links, "agent__mis"); os.symlink(other, mis)
    ok(not verify._skill_link_resolves(mis, skill_dir),
       "mis-targeted symlink (resolves but wrong dir) -> FAILS")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- Phase 2B: cross-agent strands (sibling refs to retired source) ----------
print("[P2b] cross-agent strands scan + segment boundary")
tmp = tempfile.mkdtemp()
try:
    agents = os.path.join(tmp, "orgs", "x", "agents"); os.makedirs(agents)
    src = os.path.join(agents, "alpha"); os.makedirs(src)
    tgt = os.path.join(agents, "alpha-codex"); os.makedirs(tgt)
    sib = os.path.join(agents, "beta"); os.makedirs(os.path.join(sib, "scripts"))
    # sibling hardcodes the retired source path
    stray = os.path.join(sib, "scripts", "read.py")
    open(stray, "w").write("PATH = 'orgs/x/agents/alpha/docs/brief.md'\n")
    hits = verify._stranded_cross_agent_refs(src, "alpha", "alpha-codex")
    ok(("beta", os.path.relpath(stray, agents)) in hits,
       "sibling ref to agents/alpha flagged as stranded")
    # DISCRIMINATING boundary: a sibling pointing at agents/alpha-codex (the TARGET,
    # longer name) must NOT be a false positive when source is 'alpha'.
    open(os.path.join(sib, "scripts", "read.py"), "w").write(
        "PATH = 'orgs/x/agents/alpha-codex/docs/brief.md'\n")
    hits2 = verify._stranded_cross_agent_refs(src, "alpha", "alpha-codex")
    ok(hits2 == [], "DISCRIMINATING: repointed to agents/alpha-codex -> NOT flagged (segment boundary)")
    # source's OWN files are excluded (only siblings count)
    open(os.path.join(src, "self.md"), "w").write("see agents/alpha/x\n")
    ok(verify._stranded_cross_agent_refs(src, "alpha", "alpha-codex") == [],
       "source's own agents/alpha refs excluded (only siblings strand)")
    # convert-side best-effort surface returns the same hits
    open(os.path.join(sib, "scripts", "read.py"), "w").write(
        "PATH = 'orgs/x/agents/alpha/docs/brief.md'\n")
    acts = []
    chits = convert.scan_cross_agent_strands(src, "alpha", "alpha-codex", acts)
    ok(("beta", os.path.relpath(stray, agents)) in chits, "convert surface finds the same strand")
    ok(any("REPOINT" in a for a in acts), "convert surface logs a REPOINT action (not silent)")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- Phase 2C: source crons disabled in config.json too (drift guard) ----------
print("[P2c] source config.json recurring-disable drift guard")
tmp = tempfile.mkdtemp()
try:
    src = os.path.join(tmp, "src"); os.makedirs(src)
    ctx = os.path.join(tmp, "ctx", "default")
    reg_dir = os.path.join(ctx, ".cortextOS", "state", "agents", "srcagent"); os.makedirs(reg_dir)
    json.dump({"crons": [
        {"name": "heartbeat", "type": "recurring", "interval": "4h", "enabled": True, "prompt": "hb"},
        {"name": "annual-task", "type": "once", "fire_at": "2026-06-20T09:00:00Z", "enabled": True, "prompt": "once"},
    ]}, open(os.path.join(src, "config.json"), "w"))
    json.dump({"crons": [
        {"name": "heartbeat", "schedule": "4h", "enabled": True, "prompt": "hb"},
    ]}, open(os.path.join(reg_dir, "crons.json"), "w"))
    # before disable: config helper flags the recurring cron
    ok(verify._source_config_recurring_still_enabled(src) == ["heartbeat"],
       "pre-disable: config.json recurring cron flagged")
    # DISCRIMINATING: disable ONLY the registry (simulate config-half skipped) ->
    # registry helper passes but config helper still catches the drift.
    reg = json.load(open(os.path.join(reg_dir, "crons.json")))
    for c in reg["crons"]:
        if c["name"] == "heartbeat": c["enabled"] = False
    json.dump(reg, open(os.path.join(reg_dir, "crons.json"), "w"))
    ok(verify._source_recurring_crons_still_enabled(src, ctx, "srcagent") == [],
       "registry-only disable: registry helper now passes")
    ok(verify._source_config_recurring_still_enabled(src) == ["heartbeat"],
       "DISCRIMINATING: config helper still flags drift (config half not disabled)")
    # full disable_source_crons flips BOTH -> both helpers clean
    acts = []
    convert.disable_source_crons(src, ctx, "srcagent", True, acts)
    ok(verify._source_config_recurring_still_enabled(src) == [],
       "post full disable: config.json recurring all disabled")
    # one-shot never flagged by the config helper
    cfg = json.load(open(os.path.join(src, "config.json")))
    pj = {c["name"]: c for c in cfg["crons"]}
    ok(pj["annual-task"].get("enabled") is True, "one-shot annual-task left enabled (held), not flagged")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- Phase 3: verify is the INDEPENDENT torn-db gate (#15 verify side) ----------
print("[P3-15v] verify._torn_target_dbs independent integrity gate")
tmp = tempfile.mkdtemp()
try:
    td = os.path.join(tmp, "tgt")
    good_dir = os.path.join(td, "plugins", "x", "skills", "a"); os.makedirs(good_dir)
    gdb = os.path.join(good_dir, "ok.db")
    cc = sqlite3.connect(gdb); cc.execute("CREATE TABLE t(x)"); cc.commit(); cc.close()
    ok(verify._torn_target_dbs(td) == [], "clean target -> no torn dbs")
    # DISCRIMINATING: a torn target DB is caught by verify even if convert's repair
    # never ran (the independent outcome gate).
    torn_dir = os.path.join(td, "plugins", "x", "skills", "b"); os.makedirs(torn_dir)
    tdbp = os.path.join(torn_dir, "bad.db")
    open(tdbp, "wb").write(b"SQLite format 3\x00" + os.urandom(3000))
    ok(verify._torn_target_dbs(td) == [os.path.relpath(tdbp, td)],
       "DISCRIMINATING: torn target db flagged by verify gate (convert repair independent)")
    # symlinked shared DB is NOT walked (os.walk does not follow symlinks)
    shared = os.path.join(tmp, "shared.db")
    open(shared, "wb").write(b"SQLite format 3\x00" + os.urandom(3000))  # torn, but shared
    link_dir = os.path.join(td, "plugins", "x", "skills", "c"); os.makedirs(link_dir)
    os.symlink(shared, os.path.join(link_dir, "shared.db"))
    ok(verify._torn_target_dbs(td) == [os.path.relpath(tdbp, td)],
       "symlinked shared db skipped (only agent's OWN real dbs gated)")
    # 0-byte placeholder is fine
    os.remove(tdbp)
    open(os.path.join(torn_dir, "bad.db"), "wb").close()
    ok(verify._torn_target_dbs(td) == [], "0-byte placeholder db -> ok")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- review MED#1: MCP re-run is idempotent (self-owned overwrite, not self-collision) ----------
print("[R1] MCP re-run: own prior block idempotently overwritten, not a false self-collision")
tmp = tempfile.mkdtemp()
_orig_home = os.environ.get("HOME")
try:
    home = os.path.join(tmp, "home"); os.makedirs(os.path.join(home, ".codex"))
    os.environ["HOME"] = home  # isolate ~/.codex/config.toml
    tdir = os.path.join(tmp, "orgs", "testorg", "agents", "newagent"); os.makedirs(tdir)
    manifest = {"mcp": {"servers": [
        {"name": "notion", "transport": "http", "url": "https://mcp.notion.com/mcp",
         "command": None, "args": [], "env": {}, "headers": {"Authorization": "Bearer ntn_S"}},
    ]}}
    acts = []
    w1, n1, c1 = convert.emit_mcp_toml(manifest, "newagent", tdir, True, acts)
    ok(c1 == [] and w1 == ["notion"], "first run installs notion, no collision")
    # DISCRIMINATING: the OLD code parsed its own written [mcp_servers.notion] back as a
    # host-global name on a second --apply -> false collision hard-stop (exit path). The
    # fix recognizes the self-owned block by the migration header agent-name and overwrites.
    acts = []
    w2, n2, c2 = convert.emit_mcp_toml(manifest, "newagent", tdir, True, acts)
    ok(c2 == [], "DISCRIMINATING: re-run does NOT self-collide (old code returned ['notion'])")
    ok(w2 == ["notion"], "re-run re-writes the self-owned server (idempotent)")
    cfg_text = open(os.path.join(home, ".codex", "config.toml")).read()
    ok(cfg_text.count("[mcp_servers.notion]") == 1, "exactly ONE notion table after re-run (no duplicate)")
    # ACQUIT: a DIFFERENT agent's prior migrated block IS still a real host-global collision
    open(os.path.join(home, ".codex", "config.toml"), "a").write(
        "\n# === migrated MCP servers for agent 'otheragent' (claude-to-codex-migration) ===\n"
        "[mcp_servers.notion]\nurl = \"x\"\n")
    acts = []
    w3, n3, c3 = convert.emit_mcp_toml(manifest, "newagent", tdir, True, acts)
    ok("notion" in c3, "ACQUIT: a DIFFERENT agent's block is still a real collision (hard-stop preserved)")
    # helper unit: self-owned name extracted + its region stripped from foreign text
    fk, owned = convert._split_self_owned_mcp_region(
        "[mcp_servers.keep]\n# === migrated MCP servers for agent 'a' (claude-to-codex-migration) ===\n[mcp_servers.x]\n", "a")
    ok("x" in owned and "[mcp_servers.x]" not in fk and "[mcp_servers.keep]" in fk,
       "helper: self-owned name extracted, own region stripped, foreign kept")
finally:
    if _orig_home is not None: os.environ["HOME"] = _orig_home
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- review MED#2: verify asserts the translated cron skills path EXISTS ----------
print("[R2] cron skills-leg existence: dangling translated skill path is caught")
tmp = tempfile.mkdtemp()
try:
    td = os.path.join(tmp, "tgt")
    os.makedirs(os.path.join(td, "plugins", "cortextos-agent-skills", "skills", "humanify"))
    ok(verify._cron_missing_skill_paths(
        "cd agents/x && run plugins/cortextos-agent-skills/skills/humanify", td) == [],
       "present skill path -> nothing missing")
    # DISCRIMINATING: a NEEDS-HUMAN skill not copied but still cron-referenced. The old
    # verify only checked absence of '.claude/skills' (satisfied by the translated prompt)
    # and passed GREEN; the existence check flags the dangling target path.
    prompt = "cd agents/x && run plugins/cortextos-agent-skills/skills/leaky-custom"
    ok(".claude/skills" not in prompt, "precondition: translated prompt has NO source substring (old check GREEN)")
    ok(verify._cron_missing_skill_paths(prompt, td) == ["leaky-custom"],
       "DISCRIMINATING: dangling translated skill path flagged (absence-only check missed it)")
    # ACQUIT: a slash-command skill ref is not a filesystem path -> not falsely flagged
    ok(verify._cron_missing_skill_paths("run /humanify then /docx now", td) == [],
       "ACQUIT: slash-command skill refs not path-checked (no false positive)")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- review LOW-MED#3: live-disabled cron stays disabled through the union ----------
print("[R3] disabled-recurring cron enabled-state survives the config-wins union")
tmp = tempfile.mkdtemp()
try:
    src = os.path.join(tmp, "src"); tgt = os.path.join(tmp, "tgt")
    ctx = os.path.join(tmp, "ctx", "default")
    reg_dir = os.path.join(ctx, ".cortextOS", "state", "agents", "srcagent")
    os.makedirs(src); os.makedirs(tgt); os.makedirs(reg_dir)
    # config says ENABLED, but the LIVE REGISTRY has it DISABLED (someone disabled the
    # cron, which flips the registry). The old config-wins union would resurrect it.
    json.dump({"crons": [
        {"name": "nightly", "type": "recurring", "interval": "24h", "enabled": True, "prompt": "do nightly"},
        {"name": "beat", "type": "recurring", "interval": "4h", "enabled": True, "prompt": "beat"},
    ]}, open(os.path.join(src, "config.json"), "w"))
    json.dump({"crons": [
        {"name": "nightly", "schedule": "24h", "enabled": False, "prompt": "do nightly"},
        {"name": "beat", "schedule": "4h", "enabled": True, "prompt": "beat"},
    ]}, open(os.path.join(reg_dir, "crons.json"), "w"))
    json.dump({"crons": []}, open(os.path.join(tgt, "config.json"), "w"))
    acts = []
    out = convert.migrate_crons(src, tgt, "srcagent", "srcagent-codex", ctx, True, acts, orchestrator="hub", principal_name="Casey")
    by = {c["name"]: c for c in out}
    # DISCRIMINATING: old union dropped registry enabled in normalization + let config
    # (enabled:True) win -> nightly would be enabled:True at target (resurrected).
    ok(by["nightly"].get("enabled") is False,
       "DISCRIMINATING: registry-disabled 'nightly' stays disabled at target (old code resurrected it)")
    ok(by["beat"].get("enabled") is True, "ACQUIT: a genuinely-enabled cron stays enabled")
    # registry-only disabled cron: enabled carried through normalization too
    json.dump({"crons": [{"name": "regonly", "schedule": "6h", "enabled": False, "prompt": "ro"}]},
              open(os.path.join(reg_dir, "crons.json"), "w"))
    json.dump({"crons": []}, open(os.path.join(src, "config.json"), "w"))
    json.dump({"crons": []}, open(os.path.join(tgt, "config.json"), "w"))
    acts = []
    out2 = {c["name"]: c for c in convert.migrate_crons(src, tgt, "srcagent", "srcagent-codex", ctx, True, acts, orchestrator="hub", principal_name="Casey")}
    ok(out2["regonly"].get("enabled") is False,
       "registry-only disabled cron carries enabled:false through normalization")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# ---------- GAP H (#9) + F2/F3 (R3): leakage guard = GENERIC detectors shipped + author-specific fixture external ----------
# DESIGN (R3): the SHIPPED guard carries ZERO author-specific value in ANY form
# (plaintext / base64 / split-assembly / hash are all recoverable and were rejected).
#   - GENERIC, always-on, always-shipped: (1) a host/URL/IP allowlist detector — the
#     positive allowlist is the SOLE infra gate, so it flags ANY non-allowlisted host
#     (incl a reintroduced private prod host) WITHOUT the guard shipping/knowing the
#     secret host names; (2) a hardcoded-chat-id-literal detector (send context) that
#     needs no author value.
#   - AUTHOR-SPECIFIC (fleet roster + the specific real chat-id) live ONLY in an
#     EXTERNAL, CI/local-only fixture (CTX_LEAKAGE_FIXTURE -> JSON {roster:[],chat_ids:[]}),
#     which is gitignored and NEVER shipped. When the fixture is absent (the DEFAULT
#     public path — zero setup, no error) that leg SKIPS with a log; the generic
#     detectors above still enforce.
print("[GAP-H] leakage guard: generic host + chat-id-literal detectors + external author fixture")
import re as _reH, json as _jsonH
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_THIS = os.path.abspath(__file__)

# F2-GAP-A: scan EVERY shipped text file under the skill dir (the R1 leak was in
# references/, and references/*.txt was previously UNSCANNED). Walk the tree; keep known
# text extensions + extensionless. Invariant asserted below: references/*.txt covered.
_TEXT_EXT = {".md", ".txt", ".py", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini", ".sh", ""}
_scan = []
for _dp, _dns, _fns in os.walk(_ROOT):
    _dns[:] = [_d for _d in _dns if not _d.startswith(".")]  # prune hidden dirs RELATIVE to the walk
    for _fn in _fns:
        if os.path.splitext(_fn)[1].lower() in _TEXT_EXT:
            _scan.append(os.path.abspath(os.path.join(_dp, _fn)))
_scan = sorted(set(_scan))
# The host + chat-id detectors necessarily flag adversarial fixtures. This test file is
# the ONE file that must carry such fixtures (to prove the detectors fire), so the
# host/chat-id FILE scans run over the runtime surface = every shipped file EXCEPT this
# one; the detectors themselves are proven by inline convict/acquit unit tests. The
# author-specific (roster/chat-id) scan below still covers ALL files incl this one.
_runtime_surface = [_f for _f in _scan if _f != _THIS]
def _ln(_txt, _pos):
    return _txt[:_pos].count(chr(10)) + 1
def _rel(_f):
    return os.path.relpath(_f, _ROOT)
ok(any(_p.endswith(os.path.join("references", "leakage-tokens.txt")) for _p in _scan)
   and any(_p.endswith(os.path.join("references", "codex-bundled-skills.txt")) for _p in _scan),
   "F2-GAP-A: scan set covers references/*.txt (the prior blind spot)")

# --- GENERIC detector 1: host/URL/IP allowlist (F2-GAP-B: scheme-OPTIONAL + bare host + IPv4). ---
_HOST_ALLOW = {"mcp.notion.com", "mcp.supabase.com"}  # public well-known endpoints; *.example.com always ok
_HOST_RE = _reH.compile(
    r"(?P<scheme>[a-z][a-z0-9+.-]*://)?"
    r"(?P<host>(?:(?:\d{1,3}\.){3}\d{1,3})"                              # IPv4
    r"|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})", _reH.IGNORECASE)
def _host_allowed(_h):
    _h = _h.lower().rstrip(".")
    return _h in _HOST_ALLOW or _h == "example.com" or _h.endswith(".example.com")
# real public TLDs we care about for a host leak. Combined with the subdomain/hyphen
# rule below, this keeps Python attr chains (os.path.join, subprocess.run, args.org)
# and filenames (self.md, read.py) from reading as hosts, while still catching a
# reintroduced managed/PaaS host (e.g. a "<svc>.up.<provider>.app" style deploy host).
_REAL_TLD = {"com", "net", "org", "io", "app", "dev", "co", "ai", "cloud", "run", "sh",
             "xyz", "us", "uk", "gg", "tv", "me", "info", "biz", "page", "site", "tech"}
def _host_leak_hits(_text):
    """Return non-allowlisted host/URL/IP tokens. CONVICTS scheme://host of ANY scheme
    (ws/postgres/http...), IPv4 literals, and bare hosts with a real TLD that carry a
    subdomain or a hyphenated label (a reintroduced managed/PaaS deploy host). ACQUITS
    Python attr-access look-alikes (args.org, subprocess.run, os.path.join) and filenames."""
    _out = []
    for _m in _HOST_RE.finditer(_text):
        _h, _scheme = _m.group("host"), _m.group("scheme")
        if _host_allowed(_h):
            continue
        if _reH.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", _h):
            if _h not in ("127.0.0.1", "0.0.0.0"):
                _out.append(("ip", _h, _m.start()))
            continue
        if _scheme:
            _out.append(("host", _h, _m.start()))  # explicit scheme = a real URL, any TLD
            continue
        _labels = _h.split(".")
        if _labels[-1].lower() in _REAL_TLD and (len(_labels) >= 3 or any("-" in _l for _l in _labels)):
            _out.append(("host", _h, _m.start()))
    return _out
_host_hits = []
for _f in _runtime_surface:
    _txt = open(_f, errors="ignore").read()
    for _kind, _h, _pos in _host_leak_hits(_txt):
        _host_hits.append(f"{_rel(_f)}:{_ln(_txt,_pos)}:{_kind}:{_h}")
ok(_host_hits == [], f"NO non-allowlisted host/URL/IP across the skill runtime surface (hits={_host_hits})")
# discriminating unit test for the host detector: convict + acquit. The convict host is
# FABRICATED (acme placeholder) — no real infra host name ships in this file.
ok(_host_leak_hits("url = svc-prod.up.acmepaas.app/mcp") and
   _host_leak_hits("dsn = postgres://db.internal.acme.net:5432/x") and
   _host_leak_hits("ws://10.11.12.13:9000"),
   "host detector CONVICTS bare PaaS host + non-http scheme + IPv4")
ok(not _host_leak_hits("subprocess.run(args) and args.org and os.path.join") and
   not _host_leak_hits("see https://mcp.notion.com/mcp and your-mcp-server.example.com") and
   not _host_leak_hits("files self.md config.json read.py"),
   "host detector ACQUITS attr-access / allowlisted host / filenames")

# --- GENERIC detector 2: hardcoded-chat-id-literal in a telegram/message send. ---
def _chatid_leak_hits(_text):
    """Flag a plausibly-real hardcoded numeric chat-id passed to a send-telegram/
    send-message call. CONVICTS a bare >=7-digit id in send context. ACQUITS env/param
    refs ($VAR, {param}, an orchestrator name) and obvious placeholders (>=4 trailing
    zeros or a repdigit) — which disclose nothing. Needs NO author value to ship."""
    _out = []
    for _m in _reH.finditer(r"send-(?:telegram|message)\s+(-?[^\s'\"]+)", _text):
        _arg = _m.group(1)
        if not _arg.lstrip("-").isdigit():
            continue
        _d = _arg.lstrip("-")
        if len(_d) < 7 or _d.endswith("0000") or len(set(_d)) == 1:
            continue
        _out.append((_arg, _m.start()))
    return _out
# scanned over _runtime_surface (defined above) — every shipped file except this test,
# whose adversarial fixtures intentionally contain synthetic send-telegram calls.
_chatid_hits = []
for _f in _runtime_surface:
    _txt = open(_f, errors="ignore").read()
    for _arg, _pos in _chatid_leak_hits(_txt):
        _chatid_hits.append(f"{_rel(_f)}:{_ln(_txt,_pos)}:chat-id:{_arg}")
ok(_chatid_hits == [], f"NO hardcoded chat-id literal in send context across the skill runtime surface (hits={_chatid_hits})")
# discriminating unit test: 5551234987 is a FABRICATED non-round id (NOT any real chat-id)
ok(_chatid_leak_hits("cortextos bus send-telegram 5551234987 'x'"),
   "chat-id detector CONVICTS a plausibly-real hardcoded id in send context")
ok(not _chatid_leak_hits("send-telegram 1000000000 'hi'") and
   not _chatid_leak_hits("send-telegram $CTX_TELEGRAM_CHAT_ID 'x'") and
   not _chatid_leak_hits("send-message hub normal 'x'") and
   not _chatid_leak_hits("fire_at 2026-06-20T09:00:00Z ran 1785437536491"),
   "chat-id detector ACQUITS placeholder / env / param / non-send numerics")

# --- AUTHOR-SPECIFIC leg: roster + specific chat-id from the EXTERNAL fixture only. ---
# Shape: CTX_LEAKAGE_FIXTURE -> JSON {"roster": ["..."], "chat_ids": ["..."]}. Gitignored,
# never shipped. Absent -> SKIP (default public path); present (our CI/local) -> full scan.
_fix_path = os.environ.get("CTX_LEAKAGE_FIXTURE")
if _fix_path and os.path.isfile(_fix_path):
    _fx = _jsonH.load(open(_fix_path))
    _author_ban = {}
    for _n in (_fx.get("roster") or []):
        _author_ban[f"roster:{_n}"] = _reH.compile(r"(?i)\b" + _reH.escape(str(_n)) + r"\b")
    for _c in (_fx.get("chat_ids") or []):
        _author_ban[f"chat-id:{_c}"] = _reH.compile(_reH.escape(str(_c)))
    _author_hits = []
    for _f in _scan:
        _txt = open(_f, errors="ignore").read()
        for _label, _rx in _author_ban.items():
            for _m in _rx.finditer(_txt):
                _author_hits.append(f"{_rel(_f)}:{_ln(_txt,_m.start())}:{_label}")
    ok(_author_hits == [],
       f"NO author-specific tokens (roster/chat-id from CTX_LEAKAGE_FIXTURE) in ANY shipped file (hits={_author_hits})")
else:
    print("  SKIP author-specific fixture scan: CTX_LEAKAGE_FIXTURE not set/found "
          "(default public path — generic detectors above still enforce)")

print(f"\n=== {P} passed, {F} failed ===")
sys.exit(1 if F else 0)
