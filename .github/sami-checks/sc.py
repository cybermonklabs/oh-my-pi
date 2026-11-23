#!/usr/bin/env python3
"""sami-checks: the plan, the counters and the summary of .github/workflows/sami-checks.yml.

  sc.py plan                       GITHUB_OUTPUT lines: the commit, the job matrices, the control
  sc.py shard WHO N K META WEIGHTS the pi-shell test binaries of shard N of K, one "id<TAB>path" a line
  sc.py ts-small                   the small TypeScript suites, one "unit<TAB>dir<TAB>bound<TAB>args" a line
  sc.py libtest LOG EXIT SECS ROW UNIT WHO   one libtest binary's result (JSON on stdout)
  sc.py nextest JUNIT EXIT SECS ROW UNIT WHO one nextest run's result
  sc.py bun JUNIT LOG EXIT SECS ROW UNIT     one `bun test` run's result
  sc.py plain EXIT SECS ROW UNIT LOG         a command whose exit is its verdict (check:ts)
  sc.py clippy-crates METADATA CRATE...     "crate<TAB>dir<TAB>library root" a line, from `cargo metadata`
  sc.py clippy LOG EXIT SECS CRATE DIR CONTROL_LOG CONTROL_FILE   one crate's clippy result
  sc.py platforms PC OUT                   one result per platform from platform-checks' pc-report under PC
  sc.py summary RESULTS BUILD              the step summary (markdown) on stdout; exit 1 unless every row passed
  sc.py selftest                           the counters and the summary against hand-made inputs

The counter rule (the fork's gate kit): a result is PASS or FAIL only when it was read. A libtest
binary whose exit is neither 0 nor 101, a nextest run whose exit is neither 0 nor 100, a bun run
with no JUnit report or no summary line, a command the time bound or a signal ended, a clippy run
whose exit is neither 0 nor 101 or whose control was not caught, a platform the platform report
gives no verdict for, and a unit the plan expects that no job reported, or that two jobs reported,
are UNKNOWN, and so is every row they belong to. A test that passed after printing a skip marker
compared nothing: it is counted apart, named, and its unit is UNKNOWN. A test that started and
never ended is named.
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
# A marker counts at the start of a line or after a `<case name>: ` prefix (`t: not run: ...`);
# a line that only mentions the word later (`the host half is skipped: ...`) does not.
SKIP_MARKER = re.compile(r"^\s*(?:[^\n:]{1,200}:\s+)?(?:skipped:|skipping\b|SKIP\b|not run\b|UNKNOWN:)|UNCOMPARED", re.M)
# The platform rows: platform-checks.yml, called on the candidate, tests these crates on these
# platforms (the fork's hand-run platform rows: pi-shell, macOS and Windows).
PLATFORMS = ("macos", "windows")
PLATFORM_CRATES = "pi-shell"
# The clippy row: the crates the fork's hand-run clippy gate linted, one unit each.
CLIPPY_CRATES = ("pi-shell", "pi-vcs", "pi-vfs", "pi-walker", "pi-builtins", "pi-natives")
# The name of the unused import clippy.sh plants as the clippy row's control.
CLIPPY_CONTROL = "ScClippyControl"

ROWS = (
    ("pi-shell set (runner)", "set-runner"),
    ("pi-shell set (root)", "set-root"),
    ("pi-shell lib, one process, 4 threads (runner)", "lib4"),
    ("pi-builtins, nextest default profile", "builtins"),
    ("workspace, nextest (not pi-shell, pi-builtins)", "workspace"),
    ("TypeScript suites", "ts-small"),
    ("coding-agent --isolate", "ts-ca"),
    ("check:ts", "checkts"),
    ("macOS: pi-shell, platform checks", "macos"),
    ("Windows: pi-shell, platform checks", "windows"),
    ("clippy --tests -D warnings, per crate (failed: findings)", "clippy"),
)


def set_matrix():
    return [{"who": w, "shard": s, "name": f"set-{w}-{s}"} for w in SET_WHO for s in range(1, SET_SHARDS + 1)]


def builtins_matrix():
    return [{"who": w, "name": f"builtins-{w}"} for w in SET_WHO]


def workspace_matrix():
    return [{"who": w, "part": p, "name": f"workspace-{w}-{p}"} for w in SET_WHO for p in range(1, WORKSPACE_PARTS + 1)]


def ts_matrix():
    return [{"shard": s, "name": f"ts-ca-{s}"} for s in range(1, CODING_AGENT_SHARDS + 1)]


def all_job_names():
    names = [m["name"] for m in set_matrix()] + [m["name"] for m in workspace_matrix()]
    names += [m["name"] for m in builtins_matrix()] + [m["name"] for m in ts_matrix()]
    names += ["ts-small", "checkts", "platforms", "clippy"]
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
        "builtins": json.dumps(builtins_matrix()),
        "workspace_parts": WORKSPACE_PARTS,
        "ts": json.dumps(ts_matrix()),
        "ca_shards": CODING_AGENT_SHARDS,
        "platforms": ",".join(PLATFORMS),
        "platform_crates": PLATFORM_CRATES,
        "clippy_crates": " ".join(CLIPPY_CRATES),
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
            res["skip_only"] = True
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
    # bun's own counts must agree with what the JUnit reader counted.
    own = {k: int(n) for n, k in re.findall(r"^\s*(\d+) (pass|fail)\s*$", text, re.M)}
    if res["status"] != "UNKNOWN" and (own.get("pass"), own.get("fail", 0)) != (res["passed"] + len(res["self_skipped"]), res["failed"]):
        res["status"] = "UNKNOWN"
        res["note"] = (f"bun counts {own.get('pass')} pass and {own.get('fail', 0)} fail, the JUnit report "
                       f"{res['passed'] + len(res['self_skipped'])} and {res['failed']}")
    return res


def parse_plain(exit_code, secs, row, unit, log):
    try:
        tail = open(log, encoding="utf-8", errors="replace").read().splitlines()[-15:]
    except OSError:
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note="no log")
    if exit_code in ("124", "125", "126", "127", "137") or (exit_code.isdigit() and int(exit_code) > 128):
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note=f"exit {exit_code}: the time bound or a signal ended it")
    ok = exit_code == "0"
    return result(row, unit, "runner", "PASS" if ok else "FAIL", exit_code, secs, int(ok), int(not ok),
                  failures=[] if ok else [f"{unit}: exit {exit_code}: " + " / ".join(l.strip() for l in tail if l.strip())[-600:]])


# A finding: `file:line:col: warning|error[code]: message`, as cargo prints it with
# --message-format=short (the kit's finding_lines pattern).
FINDING = re.compile(r"^(?P<file>\S+?):\d+:\d+: (?:warning|error)(?:\[[^\]]*\])?: (?P<msg>.*)$")


def read_lines(path):
    try:
        return open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return None


def findings(lines):
    return [(m["file"], m["msg"]) for m in map(FINDING.match, lines) if m]


def clippy_crates(metadata, crates):
    """Each crate's directory and library root, relative to the workspace root, from
    `cargo metadata --no-deps`; "-" for what the tree does not have."""
    meta = json.load(open(metadata, encoding="utf-8"))
    root = meta["workspace_root"]
    pkgs = {p["name"]: p for p in meta["packages"]}
    for c in crates:
        p = pkgs.get(c)
        if p is None:
            print(f"{c}\t-\t-")
            continue
        lib = next((t["src_path"] for t in p["targets"] if any(k.endswith("lib") or k == "proc-macro" for k in t["kind"])), None)
        print(f"{c}\t{os.path.relpath(os.path.dirname(p['manifest_path']), root)}\t{os.path.relpath(lib, root) if lib else '-'}")


def parse_clippy(log, exit_code, secs, crate, crate_dir, ctl_log, ctl_file):
    """One crate's clippy result. Its findings are the lines in files under its own directory: a
    dependency's warnings, which --no-deps leaves at their own level, are not this crate's.
    FAIL: exit 101 and findings, each named with its count. PASS: exit 0, no finding, and the
    control run read the unused import clippy.sh planted in the crate's library root as a
    finding. Anything else is UNKNOWN."""
    def r(status, own=(), note=""):
        counts = {}
        for f, m in own:
            counts[f"{f}: {m}"] = counts.get(f"{f}: {m}", 0) + 1
        named = [k if n == 1 else f"{k} ({n} times)" for k, n in sorted(counts.items())]
        return result("clippy", crate, "runner", status, exit_code, secs, failed=len(own), failures=named, note=note)

    if crate_dir == "-":
        return r("UNKNOWN", note=f"the tree has no package {crate}")
    lines = read_lines(log)
    if lines is None:
        return r("UNKNOWN", note="no log")
    own = [(f, m) for f, m in findings(lines) if f.startswith(crate_dir.rstrip("/") + "/")]
    try:
        code = int(exit_code)
    except ValueError:
        code = None
    if code not in (0, 101):
        return r("UNKNOWN", own, f"exit {exit_code}: clippy did not finish" + (" (the time bound ended it)" if code == 124 else ""))
    if code == 101 and not own:
        first = next((l for l in lines if l.startswith("error")), "no error line")
        return r("UNKNOWN", note=f"exit 101 and no finding under {crate_dir}/, so it was not linted: {first[:300]}")
    if code == 0 and own:
        return r("UNKNOWN", own, f"exit 0 with {len(own)} findings under -D warnings")
    if own:
        return r("FAIL", own)
    ctl = read_lines(ctl_log)
    if ctl is None:
        return r("UNKNOWN", note="the control left no log, so a clean result proves nothing")
    if not any(f == ctl_file and CLIPPY_CONTROL in m for f, m in findings(ctl)):
        return r("UNKNOWN", note=f"the control's unused import planted in {ctl_file} was not read as a finding, so a clean result proves nothing")
    return r("PASS")


def read_kv(path):
    out = {}
    for line in read_lines(path) or ():
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip()
    return out


def read_tsv(path):
    rows = [l.split("\t") for l in read_lines(path) or ()]
    return [dict(zip(rows[0], r)) for r in rows[1:]] if rows else None


def platform_results(pc_dir, commit):
    """One result per platform in PLATFORMS from the platform checks' own report (pc-report:
    summary.md, verdicts.tsv, tests.tsv) and each leg's meta.env and JUnit report, all found
    under pc_dir. The verdict is the report's own, for the head tree and the runner's user: PASS
    reads PASS; FAIL, TIMEOUT and FLAKY read FAIL with each test that did not pass named; any
    other verdict, a report of another commit, or a platform it gives no verdict for reads UNKNOWN.
    An UNKNOWN names the head build's failure on that platform, when its build record
    (pc-build-<platform>-head) shows one, with the first compiler error."""
    where = {}
    for dirpath, _, names in os.walk(pc_dir):
        for n in names:
            where.setdefault(n, []).append(os.path.join(dirpath, n))
    unit = PLATFORM_CRATES

    def unknown(note):
        return [result(p, unit, "runner", "UNKNOWN", "-", 0, note=note) for p in PLATFORMS]

    if len(where.get("verdicts.tsv", ())) != 1:
        return unknown(f"the platform checks' report (pc-report) was not read: {len(where.get('verdicts.tsv', ()))} verdicts.tsv found")
    report = os.path.dirname(where["verdicts.tsv"][0])
    summary = "\n".join(read_lines(os.path.join(report, "summary.md")) or ())
    verdicts = read_tsv(os.path.join(report, "verdicts.tsv"))
    tests = read_tsv(os.path.join(report, "tests.tsv"))
    if verdicts is None or tests is None:
        return unknown("the platform checks' report has no verdicts.tsv or tests.tsv to read")
    m = re.search(r"^\| head \| `([0-9a-f]{40})` \|$", summary, re.M)
    if not m or m.group(1) != commit:
        return unknown(f"the platform checks' report is of head {m.group(1) if m else '(none named)'}, not {commit}")
    legs = {}
    for path in where.get("meta.env", ()):
        kv = read_kv(path)
        if (kv.get("tree"), kv.get("who")) == ("head", "user"):
            legs.setdefault(kv.get("platform"), []).append((kv, os.path.dirname(path)))

    def build_failure(p):
        for path in where.get("build.env", ()):
            d = os.path.dirname(path)
            kv = read_kv(path)
            if os.path.basename(d) != f"pc-build-{p}-head" or kv.get("exit") in (None, "0"):
                continue
            log = read_lines(os.path.join(d, "build-head.log")) or []
            for i, l in enumerate(log):
                if re.match(r"error(\[E\d+\])?: ", l):
                    at = next((x.split("-->", 1)[1].strip() for x in log[i + 1:i + 3] if "-->" in x), "")
                    return f"the head's test build failed (exit {kv['exit']}): {l.strip()}" + (f" at {at}" if at else "")
            return f"the head's test build failed (exit {kv['exit']})"
        return ""

    out = []
    for p in PLATFORMS:
        key = lambda row: (row.get("platform"), row.get("tree"), row.get("user")) == (p, "head", "user")
        lines = [v.get("verdict", "") for v in verdicts if key(v)]
        if len(lines) != 1:
            bf = build_failure(p)
            out.append(result(p, unit, "runner", "UNKNOWN", "-", 0, note=f"the platform checks' report gives {len(lines)} verdicts "
                              f"for the head on {p}, not 1" + (f"; {bf}" if bf else "")))
            continue
        line = lines[0]
        mine = [t for t in tests if key(t)]
        # A failure is named as the JUnit report names the test (binary::test), so the known-failure
        # list can name it; a verdict other than FAIL is added, so a timeout is another failure.
        bad = [f"{t.get('binary')}::{t.get('test')}" + ("" if t.get("verdict") == "FAIL" else f" ({t.get('verdict')})")
               for t in mine if t.get("verdict") != "PASS"]
        times = []
        for _, d in legs.get(p, ()):
            try:
                times += [(c[0], c[2]) for c in junit_cases(os.path.join(d, "junit.xml")) if c[1] != "skipped"]
            except (OSError, ET.ParseError):
                pass
        secs = max((int(kv.get("run_seconds") or 0) for kv, _ in legs.get(p, ())), default=0)
        exit_code = ",".join(kv.get("run_exit", "?") for kv, _ in legs.get(p, ())) or "-"
        ign = re.search(r"\bignored=(\d+)", line)
        status = {"PASS": "PASS", "FAIL": "FAIL", "TIMEOUT": "FAIL", "FLAKY": "FAIL"}.get(line.split(" ", 1)[0], "UNKNOWN")
        note = line if status == "UNKNOWN" else ""
        if (status == "PASS" and (bad or not mine)) or (status == "FAIL" and not bad):
            status, note = "UNKNOWN", f"the verdict ({line}) and the report's test list disagree"
        if status == "UNKNOWN" and build_failure(p):
            note += "; " + build_failure(p)
        out.append(result(p, unit, "runner", status, exit_code, secs, len(mine) - len(bad), len(bad),
                          int(ign.group(1)) if ign else 0, bad, times, note))
    return out


def cmd_platforms(pc_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for r in platform_results(pc_dir, os.environ.get("SC_COMMIT", "")):
        json.dump(r, open(os.path.join(out_dir, f"{r['row']}.json"), "w", encoding="utf-8"))
        print(f"PLATFORM {r['row']} {r['status']}: {r['passed']} passed, {r['failed']} not passed {r['note']}")


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
    for who in SET_WHO:
        exp.append(("builtins", "pi-builtins", who))
    for who in SET_WHO:
        for p in range(1, WORKSPACE_PARTS + 1):
            exp.append(("workspace", f"part {p}/{WORKSPACE_PARTS}", who))
    for unit, _, _, _ in TS_SMALL:
        exp.append(("ts-small", unit, "runner"))
    for s in range(1, CODING_AGENT_SHARDS + 1):
        exp.append(("ts-ca", f"shard {s}/{CODING_AGENT_SHARDS}", "runner"))
    exp.append(("checkts", "check:ts", "runner"))
    for p in PLATFORMS:
        exp.append((p, PLATFORM_CRATES, "runner"))
    for c in CLIPPY_CRATES:
        exp.append(("clippy", c, "runner"))
    return exp, notes


def fmt_secs(s):
    s = float(s)
    return f"{s / 60:.1f} min" if s >= 90 else f"{s:.0f} s"


def read_known(path):
    """known-failures.txt: (row, user, unit, test) -> reason."""
    known = {}
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            if not line.strip() or line.startswith("#"):
                continue
            f = line.rstrip("\n").split("\t")
            if len(f) != 5:
                sys.exit(f"known-failures.txt: not five tab-separated fields: {line!r}")
            known[tuple(f[:4])] = f[4]
    return known


def cmd_summary(results_dir, build_dir, known_path=None):
    known = read_known(known_path)
    results = load_results(results_dir)
    got, dup = {}, set()
    for r in results:
        k = (r["row"], r["unit"], r["who"])
        if k in got:
            dup.add(k)
        got[k] = r
    # The tests each (unit, user) passed without a skip marker: a test that skipped itself as one
    # user is covered when the same test passed as the other.
    passed_as = {}
    for r in results:
        bad = set(r["failures"]) | set(r.get("self_skipped", []))
        passed_as.setdefault((r["unit"], r["who"]), set()).update(n for n, _ in r["tests"] if n not in bad)
    exp, notes = expected_units(build_dir)
    lines = []
    commit = os.environ.get("SC_COMMIT", "?")
    lines.append(f"## sami checks of `{commit}`")
    lines.append("")
    lines.append("Report only: nothing here gates a release. A row passes when every unit in it was read and passed, "
                 "and reads KNOWN when its only failures are on the known-failure list. A unit is UNKNOWN when its "
                 "runner did not end normally (libtest 0/101, nextest 0/100, bun 0/1 with its summary line, clippy "
                 "0/101), when a passing test printed a skip marker and passed as no other user, when a clean clippy "
                 "crate's planted control was not caught, when the platform checks gave its platform no verdict, or "
                 "when no job (or more than one) reported it; its row is then UNKNOWN too.")
    lines.append("")
    lines.append("| Row | Verdict | Units: pass / known / fail / UNKNOWN | Tests: passed / failed / ignored / skipped themselves | Longest unit |")
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
            elif r.get("skip_only") and r["status"] == "UNKNOWN":
                others = [w for w in SET_WHO if w != r["who"]]
                open_ = [s for s in r["self_skipped"] if not any(s in passed_as.get((r["unit"], w), ()) for w in others)]
                if open_:
                    r = dict(r, note=f"{len(open_)} test(s) skipped themselves here and passed as no other user: " + ", ".join(open_[:12]))
                else:
                    r = dict(r, status="PASS", note=f"{len(r['self_skipped'])} test(s) skipped themselves as {r['who']} and passed as {', '.join(others)}")
            if r["status"] == "FAIL" and r["failures"] and all((key, r["who"], r["unit"], f) in known for f in r["failures"]):
                r = dict(r, status="KNOWN")
            rs.append(r)
        if key in notes and not units:
            verdict, counts = "UNKNOWN", "-"
            details.append(f"- **{title}**: UNKNOWN: {notes[key]}")
        else:
            n = {s: sum(1 for r in rs if r["status"] == s) for s in ("PASS", "KNOWN", "FAIL", "UNKNOWN")}
            verdict = ("UNKNOWN" if n["UNKNOWN"] or not rs else "FAIL" if n["FAIL"] else "KNOWN" if n["KNOWN"] else "PASS")
            counts = f"{n['PASS']} / {n['KNOWN']} / {n['FAIL']} / {n['UNKNOWN']}"
        tp = sum(r["passed"] for r in rs)
        tf = sum(r["failed"] for r in rs)
        ti = sum(r["ignored"] for r in rs)
        ts = sum(len(r.get("self_skipped", [])) for r in rs)
        longest = max(rs, key=lambda r: r["seconds"], default=None)
        lu = f"{longest['unit']} ({longest['who']}), {fmt_secs(longest['seconds'])}" if longest else "-"
        lines.append(f"| {title} | **{verdict}** | {counts} | {tp} / {tf} / {ti} / {ts} | {lu} |")
        if verdict not in ("PASS", "KNOWN"):
            all_ok = False
        for r in rs:
            if r["status"] == "UNKNOWN":
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNKNOWN: {r['note']}")
            for f in r["failures"]:
                why = known.get((key, r["who"], r["unit"], f))
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): FAILED `{f}`: "
                               + (f"KNOWN ({why})" if why else "**NEW**"))
            for f in r.get("self_skipped", []):
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): SKIPPED ITSELF `{f}`")
    lines.append("")
    # A known entry whose test passed, or that its unit no longer has, is listed for removal, and the
    # summary fails until it is removed: the list only shrinks. An entry whose unit did not report is
    # neither: it stays.
    stale = []
    for (row, who, unit, test), why in sorted(known.items()):
        r = got.get((row, unit, who))
        if r is None or r["status"] == "UNKNOWN" or test in r["failures"]:
            continue
        names = {n for n, _ in r["tests"]}
        stale.append(f"- `{unit}` ({who}) `{test}`: " + ("passed" if test in names else "no longer in its unit")
                     + f" (listed for: {why})")
    if stale:
        all_ok = False
        lines.append("### Known-failure entries to remove (their test did not fail)")
        lines.append("")
        lines.extend(stale)
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
        f.write(" 1 pass\n 1 skip\n 1 fail\nRan 3 tests across 1 file. [2.00s]\n")
    check("bun fail", parse_bun(ju, blog, "1", 1, "ts-small", "u")["status"], "FAIL")
    blog2 = os.path.join(d, "b2.log")
    with open(blog2, "w") as f:
        f.write(" 2 pass\n 1 fail\nRan 3 tests across 1 file. [2.00s]\n")
    check("bun counts that differ from the JUnit report", parse_bun(ju, blog2, "1", 1, "ts-small", "u")["status"], "UNKNOWN")
    check("check:ts timed out", parse_plain("124", 1, "checkts", "check:ts", blog)["status"], "UNKNOWN")
    check("check:ts could not run", parse_plain("127", 1, "checkts", "check:ts", blog)["status"], "UNKNOWN")
    check("check:ts failed", parse_plain("2", 1, "checkts", "check:ts", blog)["status"], "FAIL")
    for line, want in (("t: not run: this process cannot give a file to uid 65534", True),
                       ("fifo-case: skipped: no FIFO", True), ("skipped: bare", True),
                       ("cp --reflink=always: the host half is skipped: no reflink", False),
                       ("running 1 test", False), ("test result: ok. 1 passed", False)):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line + "\n")), want)

    check("assign is longest-first", assign(["a", "b", "c", "d"], {"a": 100, "b": 60, "c": 50, "d": 10}, 2),
          {"a": 1, "b": 2, "c": 2, "d": 1})
    wf = os.path.join(d, "w.txt")
    with open(wf, "w") as f:
        f.write("# c\n10 x\n600 x root\n")
    check("weights per user", (read_weights(wf, "runner")["x"], read_weights(wf, "root")["x"]), (10.0, 600.0))

    # clippy: a crate's own findings fail it; a clean crate passes only when its control was caught.
    def write(name, text):
        p = os.path.join(d, name)
        with open(p, "w") as f:
            f.write(text)
        return p

    own_f = "crates/pi-vfs/src/a.rs:3:5: error: redundant clone\n"
    dep_f = "crates/pi-shell/src/b.rs:1:1: warning: unused variable: `x`\n"
    ctl = write("ctl.log", f"crates/pi-vfs/src/lib.rs:90:1: error: unused import: `std::collections::BTreeMap as {CLIPPY_CONTROL}`\n")
    noctl = write("noctl.log", "    Checking pi-vfs v0.1.0\n")

    def cl(text, ex, c=ctl):
        return parse_clippy(write("c.log", text), str(ex), 1, "pi-vfs", "crates/pi-vfs", c, "crates/pi-vfs/src/lib.rs")

    r = cl(dep_f + own_f + own_f + "error: could not compile `pi-vfs`\n", 101)
    check("clippy fail names its own findings only", (r["status"], r["failures"], r["failed"]),
          ("FAIL", ["crates/pi-vfs/src/a.rs: redundant clone (2 times)"], 2))
    check("clippy clean with its control caught", cl(dep_f + "    Finished\n", 0)["status"], "PASS")
    check("clippy clean with its control not caught", cl("    Finished\n", 0, noctl)["status"], "UNKNOWN")
    check("clippy clean with no control log", cl("    Finished\n", 0, os.path.join(d, "absent"))["status"], "UNKNOWN")
    check("clippy killed", cl(own_f, 137)["status"], "UNKNOWN")
    check("clippy ended by its bound", "time bound" in cl("", 124)["note"], True)
    check("clippy 101 with no finding of its own", cl(dep_f + "error: failed to run custom build command for `x`\n", 101)["status"], "UNKNOWN")
    check("clippy 0 with a finding", cl(own_f, 0)["status"], "UNKNOWN")
    check("clippy crate the tree lacks", parse_clippy(ctl, "0", 1, "pi-x", "-", ctl, "-")["status"], "UNKNOWN")

    # The platform rows: the platform checks' own report, read per platform.
    commit = "c" * 40
    pc = os.path.join(d, "pc")
    rep = os.path.join(pc, "pc-report")
    leg = os.path.join(pc, "pc-results-macos-head-user-1")
    os.makedirs(rep)
    os.makedirs(leg)

    def pc_report(head, verdicts):
        write("pc/pc-report/summary.md", f"| what | commit |\n|---|---|\n| head | `{head}` |\n| base | `-` |\n")
        write("pc/pc-report/verdicts.tsv", "platform\ttree\tuser\tverdict\n" + "".join(f"{p}\thead\tuser\t{v}\n" for p, v in verdicts))

    write("pc/pc-report/tests.tsv", "platform\ttree\tuser\tbinary\ttest\tverdict\tpassed\tflaky\tfailed\ttimed_out\tnot_run\n"
          "macos\thead\tuser\tpi-shell\ta::x\tPASS\t1/1\t0\t0\t0\t0\nmacos\thead\tuser\tpi-shell\ta::y\tTIMEOUT\t0/1\t0\t0\t1\t0\n")
    write("pc/pc-results-macos-head-user-1/meta.env", "platform=macos\ntree=head\nwho=user\nleg=1\nrun_exit=100\nrun_seconds=2220\n")
    pc_report(commit, [("macos", "TIMEOUT (1 past the time bound: pi-shell a::y) run=2 ignored=1")])
    got = {r["row"]: r for r in platform_results(pc, commit)}
    check("platform timeout reads FAIL with its test named",
          (got["macos"]["status"], got["macos"]["failures"], got["macos"]["passed"], got["macos"]["ignored"], got["macos"]["seconds"]),
          ("FAIL", ["pi-shell::a::y (TIMEOUT)"], 1, 1, 2220.0))
    check("platform the report gives no verdict for", got["windows"]["status"], "UNKNOWN")
    # A platform whose head build failed: its UNKNOWN names the first compiler error.
    os.makedirs(os.path.join(pc, "pc-build-windows-head"))
    write("pc/pc-build-windows-head/build.env", "sha=x\nexit=101\nseconds=898\n")
    write("pc/pc-build-windows-head/build-head.log", "   Compiling pi-shell v1.0.0\r\nerror[E0063]: missing field `on_busy`\r\n"
          "   --> crates\\pi-shell\\src\\sys\\spawn\\windows\\tests.rs:688:11\r\nerror: could not compile `pi-shell`\r\n")
    note = {r["row"]: r for r in platform_results(pc, commit)}["windows"]["note"]
    check("platform build failure named", "failed (exit 101): error[E0063]: missing field `on_busy` at crates\\pi-shell\\src\\sys\\spawn\\windows\\tests.rs:688:11" in note, True)
    pc_report(commit, [("macos", "UNKNOWN (no test list: no archive) run=? ignored=?")])
    check("platform UNKNOWN verdict", platform_results(pc, commit)[0]["status"], "UNKNOWN")
    pc_report(commit, [("macos", "PASS (2 passed in 1 of 1 repeats) run=2 ignored=0")])
    check("platform PASS beside a test that did not pass", platform_results(pc, commit)[0]["status"], "UNKNOWN")
    pc_report("d" * 40, [("macos", "TIMEOUT (1 past the time bound: pi-shell a::y) run=2 ignored=1")])
    check("platform report of another commit", {r["status"] for r in platform_results(pc, commit)}, {"UNKNOWN"})
    check("no platform report", {r["status"] for r in platform_results(os.path.join(d, "nopc"), commit)}, {"UNKNOWN"})

    # The summary: a unit no job reported is UNKNOWN, and so is its row (the silent-shard control):
    # a pi-shell binary, a clippy crate and a platform.
    silent = {("set-root", "pi-shell::zle_pty", "root"), ("clippy", "pi-vfs", "runner"), ("windows", PLATFORM_CRATES, "runner")}
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
        if (row, unit, who) in silent:
            continue
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1, tests=[("t", 1.0)]),
                  open(os.path.join(res, f"{i}.json"), "w"))

    known_file = os.path.join(d, "known.txt")
    open(known_file, "w").write("# none\n")

    def summary():
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = cmd_summary(res, build, known_file)
        return rc, buf.getvalue()

    rc, out = summary()
    check("summary exit with a silent unit", rc, 1)
    check("summary names the silent unit UNKNOWN", "`pi-shell::zle_pty` (root): UNKNOWN: no result" in out, True)
    check("summary row of the silent unit", "| pi-shell set (root) | **UNKNOWN** | 1 / 0 / 0 / 1 |" in out, True)
    check("summary other rows pass", "| pi-shell set (runner) | **PASS** | 2 / 0 / 0 / 0 |" in out, True)
    check("summary names the silent clippy crate UNKNOWN", "`pi-vfs` (runner): UNKNOWN: no result" in out, True)
    check("summary row of the silent clippy crate", "| clippy --tests -D warnings, per crate (failed: findings) | **UNKNOWN** | 5 / 0 / 0 / 1 |" in out, True)
    check("summary row of the silent platform", "| Windows: pi-shell, platform checks | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("summary row of a platform that reported", "| macOS: pi-shell, platform checks | **PASS** | 1 / 0 / 0 / 0 |" in out, True)
    # And the same with every unit present passes.
    for i, (row, unit, who) in enumerate(sorted(silent)):
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1), open(os.path.join(res, f"silent-{i}.json"), "w"))
    rc, _ = summary()
    check("summary exit when every unit passed", rc, 0)
    # A unit two jobs reported is UNKNOWN.
    json.dump(result("checkts", "check:ts", "runner", "PASS", 0, 1, passed=1), open(os.path.join(res, "dup.json"), "w"))
    rc, out = summary()
    check("summary with a unit reported twice", (rc, "two jobs reported this unit" in out), (1, True))
    os.remove(os.path.join(res, "dup.json"))
    # A test that skipped itself as the runner's user and passed as root is covered; one that
    # skipped itself as both users is not.
    def nx(who, skipped, passed):
        return dict(result("builtins", "pi-builtins", who, "UNKNOWN" if skipped else "PASS", 0, 1, passed=len(passed),
                           tests=[(n, 1.0) for n in passed + skipped], self_skipped=skipped), skip_only=bool(skipped))
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if r["row"] == "builtins":
            os.remove(os.path.join(res, f))
    json.dump(nx("runner", ["c"], ["a"]), open(os.path.join(res, "b-runner.json"), "w"))
    json.dump(nx("root", [], ["a", "c"]), open(os.path.join(res, "b-root.json"), "w"))
    rc, out = summary()
    check("a self-skip covered by root", ("| pi-builtins, nextest default profile | **PASS** |" in out, rc), (True, 0))
    json.dump(nx("root", ["c"], ["a"]), open(os.path.join(res, "b-root.json"), "w"))
    rc, out = summary()
    check("a self-skip as both users", ("| pi-builtins, nextest default profile | **UNKNOWN** |" in out, rc), (True, 1))
    json.dump(nx("root", [], ["a", "c"]), open(os.path.join(res, "b-root.json"), "w"))
    # The known-failure list: a failure it names reads KNOWN, one it does not is NEW, and an entry
    # whose test passed is listed for removal and fails the summary.
    json.dump(result("set-runner", "pi-shell::zle_pty", "runner", "FAIL", 101, 1, passed=1, failed=1,
                     failures=["k"], tests=[("k", 1.0), ("p", 1.0)]),
              open(os.path.join(res, "zle-runner.json"), "w"))
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if (r["row"], r["unit"], r["who"]) == ("set-runner", "pi-shell::zle_pty", "runner") and f != "zle-runner.json":
            os.remove(os.path.join(res, f))
    rc, out = summary()
    check("an unlisted failure is NEW", ("FAILED `k`: **NEW**" in out, "| pi-shell set (runner) | **FAIL** |" in out, rc), (True, True, 1))
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    rc, out = summary()
    check("a listed failure is KNOWN", ("FAILED `k`: KNOWN (the host's zsh)" in out, "| pi-shell set (runner) | **KNOWN** |" in out, rc), (True, True, 0))
    open(known_file, "a").write("set-runner\trunner\tpi-shell::zle_pty\tp\tfixed since\n")
    rc, out = summary()
    check("a listed test that passed is to be removed", ("`p`: passed (listed for: fixed since)" in out, rc), (True, 1))
    open(known_file, "w").write("# none\n")
    # A platform failure on the list reads KNOWN too; a timeout of the same test is another failure.
    for f in os.listdir(res):
        if json.load(open(os.path.join(res, f)))["row"] == "macos":
            os.remove(os.path.join(res, f))
    json.dump(result("macos", PLATFORM_CRATES, "runner", "FAIL", "100", 1, passed=1, failed=1,
                     failures=["pi-shell::a::y"], tests=[("pi-shell::a::y", 1.0), ("pi-shell::a::x", 1.0)]),
              open(os.path.join(res, "macos.json"), "w"))
    open(known_file, "w").write("macos\trunner\tpi-shell\tpi-shell::a::y\tmacOS's own bash\n"
                                "set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    rc, out = summary()
    check("a listed platform failure is KNOWN", ("| macOS: pi-shell, platform checks | **KNOWN** |" in out, rc), (True, 0))
    json.dump(result("macos", PLATFORM_CRATES, "runner", "FAIL", "100", 1, passed=1, failed=1,
                     failures=["pi-shell::a::y (TIMEOUT)"], tests=[("pi-shell::a::x", 1.0)]),
              open(os.path.join(res, "macos.json"), "w"))
    rc, out = summary()
    check("a platform timeout of a listed failure is NEW", ("| macOS: pi-shell, platform checks | **FAIL** |" in out, rc), (True, 1))
    os.remove(os.path.join(res, "macos.json"))
    json.dump(result("macos", PLATFORM_CRATES, "runner", "PASS", 0, 1, passed=1), open(os.path.join(res, "macos.json"), "w"))
    open(known_file, "w").write("# none\n")
    # No binary list: the set rows are UNKNOWN, not empty passes.
    os.remove(os.path.join(build, "binaries-metadata.json"))
    rc, out = summary()
    check("summary without a binary list", ("| pi-shell set (runner) | **UNKNOWN** | - |" in out, rc), (True, 1))

    if fails:
        for f in fails:
            print(f"SELFTEST FAIL {f}")
        sys.exit(1)
    print("SELFTEST OK: libtest (60 s warning, hang, kill, self-skip), nextest, bun and clippy counters, the "
          "platform report reader, the shard assignment and per-user weights, and the summary's UNKNOWN for a "
          "unit no job or two jobs reported")


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
    elif c == "clippy-crates":
        clippy_crates(a[0], a[1:])
    elif c == "clippy":
        print(json.dumps(parse_clippy(*a)))
    elif c == "platforms":
        cmd_platforms(*a)
    elif c == "summary":
        sys.exit(cmd_summary(*a))
    elif c == "selftest":
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
