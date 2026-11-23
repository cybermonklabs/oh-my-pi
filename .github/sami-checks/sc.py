#!/usr/bin/env python3
"""sami-checks: the plan, the counters and the summary of .github/workflows/sami-checks.yml.

  sc.py plan                       GITHUB_OUTPUT lines: the commit, the job matrices, the control
  sc.py shard WHO N K META WEIGHTS the pi-shell test binaries of shard N of K, one "id<TAB>path" a line
  sc.py ts-small                   the small TypeScript suites, one "unit<TAB>dir<TAB>bound<TAB>args" a line
  sc.py libtest LOG EXIT SECS ROW UNIT WHO   one libtest binary's result (JSON on stdout)
  sc.py nextest JUNIT EXIT SECS ROW UNIT WHO one nextest run's result
  sc.py bun JUNIT LOG EXIT SECS ROW UNIT     one `bun test` run's result
  sc.py plain EXIT SECS ROW UNIT LOG         a command whose exit is its verdict (check:ts)
  sc.py summary RESULTS BUILD              the step summary (markdown) on stdout; exit 1 unless every row passed
  sc.py selftest                           the counters and the summary against hand-made inputs

The counter rule (the fork's gate kit): a result is PASS or FAIL only when it was read. A libtest
binary whose exit is neither 0 nor 101, a nextest run whose exit is neither 0 nor 100, a bun run
with no JUnit report or no summary line, a command the time bound or a signal ended, and a unit
the plan expects that no job reported, or that two jobs reported, are UNKNOWN, and so is every row
they belong to. A test that passed after printing a skip marker compared nothing: it is counted
apart, named, and its unit is UNKNOWN. A test that started and never ended is named.
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

# The plan. One place: the workflow's matrices come from here, and the summary expects exactly
# these units, so a job that never reports reads UNKNOWN.
SET_SHARDS = 4
SET_WHO = ("runner", "root")
WORKSPACE_PARTS = 2
CODING_AGENT_SHARDS = 10
# The small TypeScript suites, run one after another in one job (ts.sh small reads this):
# (unit, directory in the tree, bound in seconds, `bun test` arguments).
TS_SMALL = (
    ("natives", "packages/natives", 900, ["test"]),
    ("utils", "packages/utils", 900, ["test"]),
    ("ci-release-publish", ".", 300, ["./scripts/ci-release-publish.test.ts"]),
    ("mnemopi", "packages/mnemopi", 1200, ["--isolate", "test"]),
)
PI_SHELL = "pi-shell"
# Seconds a pi-shell binary is assumed to take when the weights file does not name it.
DEFAULT_WEIGHT = 5.0
# What a test prints when it returns early having checked nothing (the markers sami-build's
# rust_test reads, .github/sami/rust-test.sh): a passing test that prints one did not pass.
SKIP_MARKER = re.compile(r"^\s*(skipped:|skipping\b|SKIP\b|not run:|UNKNOWN:)|UNCOMPARED", re.M)

ROWS = (
    ("pi-shell set (runner)", "set-runner"),
    ("pi-shell set (root)", "set-root"),
    ("pi-shell lib, one process, 4 threads (runner)", "lib4"),
    ("pi-builtins, nextest default profile", "builtins"),
    ("workspace, nextest (not pi-shell, pi-builtins)", "workspace"),
    ("TypeScript suites", "ts-small"),
    ("coding-agent --isolate", "ts-ca"),
    ("check:ts", "checkts"),
)


def set_matrix():
    return [{"who": w, "shard": s, "name": f"set-{w}-{s}"} for w in SET_WHO for s in range(1, SET_SHARDS + 1)]


def workspace_matrix():
    return [{"part": p, "name": f"workspace-{p}"} for p in range(1, WORKSPACE_PARTS + 1)]


def ts_matrix():
    return [{"shard": s, "name": f"ts-ca-{s}"} for s in range(1, CODING_AGENT_SHARDS + 1)]


def all_job_names():
    names = [m["name"] for m in set_matrix()] + [m["name"] for m in workspace_matrix()]
    names += [m["name"] for m in ts_matrix()] + ["builtins", "ts-small", "checkts"]
    return names


def cmd_plan():
    event = os.environ["GITHUB_EVENT_NAME"]
    ref = os.environ["GITHUB_REF"]
    if event == "workflow_dispatch":
        commit = os.environ.get("SC_INPUT_COMMIT", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            sys.exit(f"::error::the commit input must be a full 40-character lowercase id, not '{commit}'")
    elif event == "push" and ref == "refs/heads/sami-candidate":
        commit = os.environ["GITHUB_SHA"]
    else:
        # A push of this tool's own branch: its controls only (the selftest), no tree.
        commit = ""
    silent = os.environ.get("SC_INPUT_SILENT", "")
    if silent and silent not in all_job_names():
        sys.exit(f"::error::the silent input names no job of the plan: '{silent}' (one of {', '.join(all_job_names())})")
    out = {
        "commit": commit,
        "silent": silent,
        "set": json.dumps(set_matrix()),
        "set_shards": SET_SHARDS,
        "workspace": json.dumps(workspace_matrix()),
        "workspace_parts": WORKSPACE_PARTS,
        "ts": json.dumps(ts_matrix()),
        "ca_shards": CODING_AGENT_SHARDS,
    }
    for k, v in out.items():
        print(f"{k}={v}")


def cmd_ts_small():
    for unit, d, bound, args in TS_SMALL:
        print("\t".join([unit, d, str(bound)] + args))


def read_weights(path, who):
    """`<seconds> <binary id> [user]` lines; a line naming the user wins over one naming none."""
    w, mine = {}, {}
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            f = line.split("#", 1)[0].split()
            if len(f) == 2:
                w[f[1]] = float(f[0])
            elif len(f) == 3 and f[2] == who:
                mine[f[1]] = float(f[0])
    w.update(mine)
    return w


def pi_shell_binaries(meta_path):
    """The pi-shell test binaries the archive holds: [(binary-id, path)], sorted by id."""
    meta = json.load(open(meta_path, encoding="utf-8"))
    target = os.environ.get("CARGO_TARGET_DIR", "")
    out = []
    for b in meta["rust-binaries"].values():
        ident = b["binary-id"]
        if ident != PI_SHELL and not ident.startswith(PI_SHELL + "::"):
            continue
        path = b["binary-path"]
        if not os.path.isabs(path) and target:
            path = os.path.join(target, path)
        out.append((ident, path))
    return sorted(out)


def assign(idents, weights, k):
    """Longest-first onto the lightest shard: shard number (1..k) per id. Ties go by id, so
    every job computes the same assignment."""
    loads = [0.0] * k
    where = {}
    for ident in sorted(idents, key=lambda i: (-weights.get(i, DEFAULT_WEIGHT), i)):
        s = min(range(k), key=lambda j: (loads[j], j))
        where[ident] = s + 1
        loads[s] += weights.get(ident, DEFAULT_WEIGHT)
    return where


def cmd_shard(who, n, k, meta, weights_path):
    bins = pi_shell_binaries(meta)
    if not bins:
        sys.exit("the archive holds no pi-shell test binary")
    where = assign([b[0] for b in bins], read_weights(weights_path, who), int(k))
    for ident, path in bins:
        if where[ident] == int(n):
            print(f"{ident}\t{path}")


def result(row, unit, who, status, exit_code, secs, passed=0, failed=0, ignored=0, failures=(), tests=(),
           note="", self_skipped=()):
    return {
        "row": row,
        "unit": unit,
        "who": who,
        "status": status,
        "exit": exit_code,
        "seconds": round(float(secs), 1),
        "passed": passed,
        "failed": failed,
        "ignored": ignored,
        "self_skipped": list(self_skipped),
        "failures": list(failures),
        "tests": [[n, round(t, 3)] for n, t in tests],
        "note": note,
    }


def skip_verdict(res):
    """A unit whose passing tests printed a skip marker: those tests are not passes, and the unit
    is UNKNOWN unless it already failed or is UNKNOWN for another reason."""
    s = res["self_skipped"]
    if s:
        res["passed"] -= len(s)
        if res["status"] == "PASS":
            res["status"] = "UNKNOWN"
            res["note"] = f"{len(s)} passing test(s) printed a skip marker and checked nothing: " + ", ".join(s[:12])
    return res


def parse_libtest(log, exit_code, secs, row, unit, who):
    """libtest's JSON events (-Z unstable-options --format json --report-time, --show-output).
    Lines that are not events (a child's or a thread's own writes) are ignored. libtest's
    `timeout` event is its 60 s warning, not a verdict: the test's own ok or failed comes later."""
    started, ended, slow, times, failures, skipped = set(), set(), set(), {}, [], []
    passed = failed = ignored = 0
    suite_end = None
    try:
        lines = open(log, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return result(row, unit, who, "UNKNOWN", exit_code, secs, note="no log")
    for line in lines:
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "suite" and ev.get("event") in ("ok", "failed"):
            suite_end = ev
        elif ev.get("type") == "test":
            name = ev.get("name", "?")
            e = ev.get("event")
            if e == "started":
                started.add(name)
            elif e == "timeout":
                slow.add(name)
            elif e in ("ok", "failed", "ignored"):
                ended.add(name)
                if e == "ok":
                    passed += 1
                    if SKIP_MARKER.search(ev.get("stdout") or ""):
                        skipped.append(name)
                elif e == "ignored":
                    ignored += 1
                else:
                    failed += 1
                    failures.append(name)
                if "exec_time" in ev:
                    times[name] = float(ev["exec_time"])
    try:
        code = int(exit_code)
    except ValueError:
        code = None
    tests = sorted(times.items())
    unfinished = sorted(started - ended)

    def r(status, note=""):
        return result(row, unit, who, status, exit_code, secs, passed, failed, ignored, failures, tests, note, skipped)

    if code not in (0, 101):
        note = f"exit {exit_code}: the binary did not finish"
        if code == 124:
            note = "exit 124: the hang bound ended it"
        if unfinished:
            note += "; started and never ended: " + ", ".join(unfinished[:10])
        return r("UNKNOWN", note)
    if suite_end is None:
        return r("UNKNOWN", "no suite result read (was it run with --format json?)")
    if (suite_end.get("passed"), suite_end.get("failed")) != (passed, failed):
        return r("UNKNOWN", f"the suite says passed={suite_end.get('passed')} failed={suite_end.get('failed')}, "
                            f"the events {passed} and {failed}")
    if (code == 0) != (failed == 0):
        return r("UNKNOWN", f"exit {exit_code} with {failed} failed")
    res = r("FAIL" if failed else "PASS")
    if slow:
        res["note"] = "past 60 s: " + ", ".join(sorted(slow)[:10])
    return skip_verdict(res)


def junit_cases(path):
    """Each <testcase> once. bun nests a <testsuite> per describe block, so walking every suite's
    cases would count a nested case once per enclosing suite."""
    root = ET.parse(path).getroot()
    parent = {c: p for p in root.iter() for c in p}
    for case in root.iter("testcase"):
        name = case.get("name", "?")
        cls = case.get("classname", "")
        if not cls:
            p = parent.get(case)
            cls = p.get("name", "") if p is not None and p.tag == "testsuite" else ""
        full = f"{cls}::{name}" if cls and not name.startswith(cls) else name
        t = float(case.get("time") or 0)
        if case.find("skipped") is not None:
            kind = "skipped"
        elif case.find("failure") is not None or case.find("error") is not None:
            kind = "failed"
        else:
            kind = "ok"
        out = "".join((e.text or "") for e in case if e.tag in ("system-out", "system-err"))
        yield full, kind, t, out


def parse_junit(junit, exit_code, secs, row, unit, who, ok_exits, fail_exits):
    try:
        code = int(exit_code)
    except ValueError:
        code = None
    if not os.path.exists(junit):
        return result(row, unit, who, "UNKNOWN", exit_code, secs, note=f"exit {exit_code}, and no JUnit report")
    try:
        cases = list(junit_cases(junit))
    except ET.ParseError as e:
        return result(row, unit, who, "UNKNOWN", exit_code, secs, note=f"the JUnit report does not parse: {e}")
    passed = sum(1 for c in cases if c[1] == "ok")
    failures = [c[0] for c in cases if c[1] == "failed"]
    ignored = sum(1 for c in cases if c[1] == "skipped")
    skipped = [c[0] for c in cases if c[1] == "ok" and SKIP_MARKER.search(c[3])]
    tests = [(c[0], c[2]) for c in cases if c[1] != "skipped"]

    def r(s, note=""):
        return result(row, unit, who, s, exit_code, secs, passed, len(failures), ignored, failures, tests, note, skipped)

    if code not in ok_exits + fail_exits:
        return r("UNKNOWN", f"exit {exit_code}: the run did not finish")
    if not cases:
        return r("UNKNOWN", "the JUnit report names no test")
    if (code in ok_exits) != (not failures):
        return r("UNKNOWN", f"exit {exit_code} with {len(failures)} failed")
    return skip_verdict(r("FAIL" if failures else "PASS"))


def parse_bun(junit, log, exit_code, secs, row, unit):
    try:
        text = open(log, encoding="utf-8", errors="replace").read()
    except OSError:
        text = ""
    res = parse_junit(junit, exit_code, secs, row, unit, "runner", (0,), (1,))
    m = re.search(r"^Ran (\d+) tests? across (\d+) files?\.", text, re.M)
    if res["status"] != "UNKNOWN" and not m:
        res["status"] = "UNKNOWN"
        res["note"] = "bun ended without its summary line (`Ran N tests across M files.`), so the files after its last output never ran"
    return res


def parse_plain(exit_code, secs, row, unit, log):
    try:
        tail = open(log, encoding="utf-8", errors="replace").read().splitlines()[-15:]
    except OSError:
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note="no log")
    if exit_code in ("124", "137") or (exit_code.isdigit() and int(exit_code) > 128):
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note=f"exit {exit_code}: the time bound or a signal ended it")
    ok = exit_code == "0"
    return result(row, unit, "runner", "PASS" if ok else "FAIL", exit_code, secs, int(ok), int(not ok),
                  failures=[] if ok else [f"{unit}: exit {exit_code}: " + " / ".join(l.strip() for l in tail if l.strip())[-600:]])


def load_results(results_dir):
    out = []
    for dirpath, _, files in os.walk(results_dir):
        for f in files:
            if f.endswith(".json"):
                try:
                    out.append(json.load(open(os.path.join(dirpath, f), encoding="utf-8")))
                except ValueError:
                    pass
    return out


def expected_units(build_dir):
    """(row key, unit, who) the plan expects, and a note per row that cannot be planned."""
    exp, notes = [], {}
    meta = os.path.join(build_dir, "binaries-metadata.json")
    if os.path.exists(meta):
        bins = pi_shell_binaries(meta)
        for who in SET_WHO:
            for ident, _ in bins:
                exp.append((f"set-{who}", ident, who))
        if any(i == PI_SHELL for i, _ in bins):
            exp.append(("lib4", PI_SHELL, "runner"))
    else:
        notes["set-runner"] = notes["set-root"] = notes["lib4"] = "the build gave no binary list, so the set could not run"
    exp.append(("builtins", "pi-builtins", "runner"))
    for p in range(1, WORKSPACE_PARTS + 1):
        exp.append(("workspace", f"part {p}/{WORKSPACE_PARTS}", "runner"))
    for unit, _, _, _ in TS_SMALL:
        exp.append(("ts-small", unit, "runner"))
    for s in range(1, CODING_AGENT_SHARDS + 1):
        exp.append(("ts-ca", f"shard {s}/{CODING_AGENT_SHARDS}", "runner"))
    exp.append(("checkts", "check:ts", "runner"))
    return exp, notes


def fmt_secs(s):
    s = float(s)
    return f"{s / 60:.1f} min" if s >= 90 else f"{s:.0f} s"


def cmd_summary(results_dir, build_dir):
    results = load_results(results_dir)
    got, dup = {}, set()
    for r in results:
        k = (r["row"], r["unit"], r["who"])
        if k in got:
            dup.add(k)
        got[k] = r
    exp, notes = expected_units(build_dir)
    lines = []
    commit = os.environ.get("SC_COMMIT", "?")
    lines.append(f"## sami checks of `{commit}`")
    lines.append("")
    lines.append("Report only: nothing here gates a release. A row passes when every unit in it was read and passed. "
                 "A unit is UNKNOWN when its runner did not end normally (libtest 0/101, nextest 0/100, bun 0/1 with "
                 "its summary line), when a passing test printed a skip marker, or when no job (or more than one) "
                 "reported it; its row is then UNKNOWN too.")
    lines.append("")
    lines.append("| Row | Verdict | Units: pass / fail / UNKNOWN | Tests: passed / failed / ignored / skipped themselves | Longest unit |")
    lines.append("|---|---|---|---|---|")
    all_ok = True
    details = []
    for title, key in ROWS:
        units = [e for e in exp if e[0] == key]
        rs = []
        for e in units:
            r = got.get(e)
            if r is None:
                r = result(key, e[1], e[2], "UNKNOWN", "-", 0, note="no result: its job reported nothing (it failed before its upload, did not run, or its upload was planted away)")
            elif e in dup:
                r = dict(r, status="UNKNOWN", note="two jobs reported this unit")
            rs.append(r)
        if key in notes and not units:
            verdict, counts = "UNKNOWN", "-"
            details.append(f"- **{title}**: UNKNOWN: {notes[key]}")
        else:
            n = {s: sum(1 for r in rs if r["status"] == s) for s in ("PASS", "FAIL", "UNKNOWN")}
            verdict = "UNKNOWN" if n["UNKNOWN"] or not rs else ("FAIL" if n["FAIL"] else "PASS")
            counts = f"{n['PASS']} / {n['FAIL']} / {n['UNKNOWN']}"
        tp = sum(r["passed"] for r in rs)
        tf = sum(r["failed"] for r in rs)
        ti = sum(r["ignored"] for r in rs)
        ts = sum(len(r.get("self_skipped", [])) for r in rs)
        longest = max(rs, key=lambda r: r["seconds"], default=None)
        lu = f"{longest['unit']} ({longest['who']}), {fmt_secs(longest['seconds'])}" if longest else "-"
        lines.append(f"| {title} | **{verdict}** | {counts} | {tp} / {tf} / {ti} / {ts} | {lu} |")
        if verdict != "PASS":
            all_ok = False
        for r in rs:
            if r["status"] == "UNKNOWN":
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNKNOWN: {r['note']}")
            for f in r["failures"]:
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): FAILED `{f}`")
            for f in r.get("self_skipped", []):
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): SKIPPED ITSELF `{f}`")
    lines.append("")
    if details:
        lines.append("### Each failing test and each UNKNOWN")
        lines.append("")
        lines.extend(details[:400])
        if len(details) > 400:
            lines.append(f"- ... and {len(details) - 400} more (sc-report artifact, results.json)")
        lines.append("")
    slow = []
    for r in results:
        for n, t in r["tests"]:
            slow.append((t, n, r["row"], r["unit"], r["who"]))
    slow.sort(reverse=True)
    lines.append("### The 20 slowest tests")
    lines.append("")
    lines.append("| Seconds | Test | Unit | User |")
    lines.append("|---|---|---|---|")
    for t, n, row, unit, who in slow[:20]:
        lines.append(f"| {t:.1f} | `{n}` | {row} `{unit}` | {who} |")
    lines.append("")
    lines.append("### Units by time")
    lines.append("")
    lines.append("| Row | Unit | User | Verdict | Seconds | Exit |")
    lines.append("|---|---|---|---|---|---|")
    for r in sorted(results, key=lambda r: -r["seconds"])[:60]:
        lines.append(f"| {r['row']} | `{r['unit']}` | {r['who']} | {r['status']} | {r['seconds']:.0f} | {r['exit']} |")
    print("\n".join(lines))
    return 0 if all_ok else 1


def selftest():
    import contextlib
    import io
    import tempfile

    d = tempfile.mkdtemp()
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append(f"{label}: got {got!r}, want {want!r}")

    def lt(events, exit_code, extra=""):
        p = os.path.join(d, "lt.log")
        with open(p, "w") as f:
            f.write(extra)
            for e in events:
                f.write(json.dumps(e) + "\n")
        return parse_libtest(p, str(exit_code), 1, "set-runner", "x", "runner")

    s0 = {"type": "suite", "event": "started", "test_count": 2}
    a_s = {"type": "test", "event": "started", "name": "a"}
    a_ok = {"type": "test", "event": "ok", "name": "a", "exec_time": 0.5}
    a_slow = {"type": "test", "event": "timeout", "name": "a"}
    a_skip = {"type": "test", "event": "ok", "name": "a", "exec_time": 0.1, "stdout": "skipped: no zsh\n"}
    b_s = {"type": "test", "event": "started", "name": "b"}
    b_f = {"type": "test", "event": "failed", "name": "b", "exec_time": 2.0}
    end_ok = {"type": "suite", "event": "ok", "passed": 1, "failed": 0}
    end_f = {"type": "suite", "event": "failed", "passed": 1, "failed": 1}
    check("libtest pass", lt([s0, a_s, a_ok, end_ok], 0)["status"], "PASS")
    check("libtest pass with raw lines", lt([s0, a_s, a_ok, end_ok], 0, "a child's line\n{not json\n")["status"], "PASS")
    r = lt([s0, a_s, a_slow, a_ok, end_ok], 0)
    check("libtest 60 s warning then ok", (r["status"], r["failed"], "a" in r["note"]), ("PASS", 0, True))
    r = lt([s0, a_s, a_ok, b_s, b_f, end_f], 101)
    check("libtest fail", (r["status"], r["failures"]), ("FAIL", ["b"]))
    r = lt([s0, a_s, a_ok, b_s, {"type": "test", "event": "timeout", "name": "b"}], 124)
    check("libtest hang bound", r["status"], "UNKNOWN")
    check("libtest hang names the test past its warning", "never ended: b" in r["note"], True)
    check("libtest killed", lt([s0, a_s, a_ok, end_ok], 137)["status"], "UNKNOWN")
    check("libtest no suite end", lt([s0, a_s, a_ok], 0)["status"], "UNKNOWN")
    check("libtest nothing read", lt([], 0)["status"], "UNKNOWN")
    check("libtest exit 0 with a failure", lt([s0, a_s, a_ok, b_s, b_f, end_f], 0)["status"], "UNKNOWN")
    check("libtest no log", parse_libtest(os.path.join(d, "absent"), "0", 1, "r", "u", "w")["status"], "UNKNOWN")
    r = lt([s0, a_s, a_skip, end_ok], 0)
    check("libtest self-skip", (r["status"], r["passed"], r["self_skipped"]), ("UNKNOWN", 0, ["a"]))

    ju = os.path.join(d, "j.xml")
    with open(ju, "w") as f:
        f.write('<testsuites><testsuite name="pi-builtins"><testcase classname="pi-builtins" name="t1" time="1.5"/>'
                '<testcase classname="pi-builtins" name="t2" time="3"><failure message="x"/></testcase>'
                '<testcase name="t3" time="0"><skipped/></testcase></testsuite></testsuites>')
    r = parse_junit(ju, "100", 1, "builtins", "u", "runner", (0,), (100,))
    check("nextest fail", (r["status"], r["passed"], r["failed"], r["ignored"]), ("FAIL", 1, 1, 1))
    check("nextest error exit", parse_junit(ju, "101", 1, "b", "u", "r", (0,), (100,))["status"], "UNKNOWN")
    check("nextest no junit", parse_junit(os.path.join(d, "no.xml"), "0", 1, "b", "u", "r", (0,), (100,))["status"], "UNKNOWN")
    js = os.path.join(d, "s.xml")
    with open(js, "w") as f:
        f.write('<testsuites><testsuite name="p"><testcase classname="p" name="t1" time="1"><system-out>'
                'skipped: no reflink here\n</system-out></testcase></testsuite></testsuites>')
    r = parse_junit(js, "0", 1, "b", "u", "r", (0,), (100,))
    check("nextest self-skip", (r["status"], r["self_skipped"]), ("UNKNOWN", ["p::t1"]))
    jn = os.path.join(d, "n.xml")
    with open(jn, "w") as f:
        f.write('<testsuites><testsuite name="file.test.ts"><testsuite name="outer"><testcase classname="outer" '
                'name="a" time="1"><failure/></testcase><testsuite name="inner"><testcase classname="outer inner" '
                'name="b" time="1"/></testsuite></testsuite></testsuite></testsuites>')
    r = parse_junit(jn, "100", 1, "b", "u", "r", (0,), (100,))
    check("JUnit nested suites count each case once", (r["passed"], r["failed"], r["failures"]), (1, 1, ["outer::a"]))
    blog = os.path.join(d, "b.log")
    with open(blog, "w") as f:
        f.write("(pass) x\n")
    check("bun without its summary line", parse_bun(ju, blog, "1", 1, "ts-small", "u")["status"], "UNKNOWN")
    with open(blog, "a") as f:
        f.write("Ran 3 tests across 1 file. [2.00s]\n")
    check("bun fail", parse_bun(ju, blog, "1", 1, "ts-small", "u")["status"], "FAIL")
    check("check:ts timed out", parse_plain("124", 1, "checkts", "check:ts", blog)["status"], "UNKNOWN")
    check("check:ts failed", parse_plain("2", 1, "checkts", "check:ts", blog)["status"], "FAIL")

    check("assign is longest-first", assign(["a", "b", "c", "d"], {"a": 100, "b": 60, "c": 50, "d": 10}, 2),
          {"a": 1, "b": 2, "c": 2, "d": 1})
    wf = os.path.join(d, "w.txt")
    with open(wf, "w") as f:
        f.write("# c\n10 x\n600 x root\n")
    check("weights per user", (read_weights(wf, "runner")["x"], read_weights(wf, "root")["x"]), (10.0, 600.0))

    # The summary: a unit no job reported is UNKNOWN, and so is its row (the silent-shard control).
    res = os.path.join(d, "res")
    build = os.path.join(d, "build")
    os.makedirs(res)
    os.makedirs(build)
    target = os.path.join(d, "target")
    meta = {"rust-binaries": {
        "x": {"binary-id": "pi-shell", "binary-path": f"{target}/debug/deps/pi_shell-1"},
        "y": {"binary-id": "pi-shell::zle_pty", "binary-path": f"{target}/debug/deps/zle_pty-1"},
        "z": {"binary-id": "pi-vcs", "binary-path": f"{target}/debug/deps/pi_vcs-1"},
    }}
    json.dump(meta, open(os.path.join(build, "binaries-metadata.json"), "w"))
    exp, _ = expected_units(build)
    for i, (row, unit, who) in enumerate(exp):
        if (row, unit, who) == ("set-root", "pi-shell::zle_pty", "root"):
            continue  # the planted silent unit
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1, tests=[("t", 1.0)]),
                  open(os.path.join(res, f"{i}.json"), "w"))

    def summary():
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = cmd_summary(res, build)
        return rc, buf.getvalue()

    rc, out = summary()
    check("summary exit with a silent unit", rc, 1)
    check("summary names the silent unit UNKNOWN", "`pi-shell::zle_pty` (root): UNKNOWN: no result" in out, True)
    check("summary row of the silent unit", "| pi-shell set (root) | **UNKNOWN** | 1 / 0 / 1 |" in out, True)
    check("summary other rows pass", "| pi-shell set (runner) | **PASS** | 2 / 0 / 0 |" in out, True)
    # And the same with every unit present passes.
    json.dump(result("set-root", "pi-shell::zle_pty", "root", "PASS", 0, 1, passed=1),
              open(os.path.join(res, "silent.json"), "w"))
    rc, _ = summary()
    check("summary exit when every unit passed", rc, 0)
    # A unit two jobs reported is UNKNOWN.
    json.dump(result("checkts", "check:ts", "runner", "PASS", 0, 1, passed=1), open(os.path.join(res, "dup.json"), "w"))
    rc, out = summary()
    check("summary with a unit reported twice", (rc, "two jobs reported this unit" in out), (1, True))
    os.remove(os.path.join(res, "dup.json"))
    # No binary list: the set rows are UNKNOWN, not empty passes.
    os.remove(os.path.join(build, "binaries-metadata.json"))
    rc, out = summary()
    check("summary without a binary list", ("| pi-shell set (runner) | **UNKNOWN** | - |" in out, rc), (True, 1))

    if fails:
        for f in fails:
            print(f"SELFTEST FAIL {f}")
        sys.exit(1)
    print("SELFTEST OK: libtest (60 s warning, hang, kill, self-skip), nextest and bun counters, the shard "
          "assignment and per-user weights, and the summary's UNKNOWN for a unit no job or two jobs reported")


def main(argv):
    if not argv:
        sys.exit(__doc__)
    c, a = argv[0], argv[1:]
    if c == "plan":
        cmd_plan()
    elif c == "shard":
        cmd_shard(*a)
    elif c == "ts-small":
        cmd_ts_small()
    elif c == "libtest":
        print(json.dumps(parse_libtest(*a)))
    elif c == "nextest":
        junit, ex, secs, row, unit, who = a
        print(json.dumps(parse_junit(junit, ex, secs, row, unit, who, (0,), (100,))))
    elif c == "bun":
        print(json.dumps(parse_bun(*a)))
    elif c == "plain":
        print(json.dumps(parse_plain(*a)))
    elif c == "summary":
        sys.exit(cmd_summary(*a))
    elif c == "selftest":
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
