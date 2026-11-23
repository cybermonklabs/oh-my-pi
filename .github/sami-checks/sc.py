#!/usr/bin/env python3
"""sami-checks: the plan, the counters and the summary of .github/workflows/sami-checks.yml.

  sc.py plan                       GITHUB_OUTPUT lines: the commit, the job matrices, the control
  sc.py shard WHO N K META WEIGHTS the pi-shell test binaries of shard N of K, one "id<TAB>path" a line
  sc.py ts-small                   the small TypeScript suites, one "unit<TAB>dir<TAB>bound<TAB>args" a line
  sc.py libtest LOG EXIT SECS ROW UNIT WHO   one libtest binary's result (JSON on stdout)
  sc.py nextest JUNIT EXIT SECS ROW UNIT WHO one nextest run's result
  sc.py gv-libtest ..., gv-nextest ...       the same for a gVisor row, with GV_ENVIRONMENT's tests set apart
  sc.py bun JUNIT LOG EXIT SECS ROW UNIT     one `bun test` run's result
  sc.py plain EXIT SECS ROW UNIT LOG         a command whose exit is its verdict (check:ts)
  sc.py summary RESULTS BUILD              the step summary (markdown) on stdout; exit 1 unless every row passed
  sc.py selftest                           the counters and the summary against hand-made inputs

The counter rule (the fork's gate kit): a result is PASS or FAIL only when it was read. A libtest
binary whose exit is neither 0 nor 101, a nextest run whose exit is neither 0 nor 100, a bun run
with no JUnit report or no summary line, a command the time bound or a signal ended, and a unit
the plan expects that no job reported, or that two jobs reported, are UNKNOWN, and so is every row
they belong to. A test that passed after printing a skip marker compared nothing: it is counted
apart, named, and its unit is UNKNOWN. A test that started and never ended is named. In a gVisor
row only, a test GV_ENVIRONMENT names (one gVisor cannot pass) is listed with its line and reason
apart from the tree's failures, and does not count in its unit's verdict.
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
# The gVisor rows (sami-checks-gvisor.yml): the pi-shell set, one libtest process per binary, over
# GV_SET_SHARDS shards (its run of the lib binary is also the one-process lib row), and pi-builtins
# under nextest, each in a runsc container, as uid 1000 and as root.
GV_SET_SHARDS = 4
GV_WHO = ("uid1000", "root")
# Tests a gVisor row cannot pass for a reason in gVisor, not in the tree: test name -> the reason.
# In a gVisor unit their failures and self-skips do not count in the verdict; the summary lists
# each one, with the line it printed, apart from the tree's failures. Each entry needs evidence.
BUSY_EXEC = ("gVisor runs a program held open for writing (no ETXTBSY), so there is no busy exec to retry; the test "
             "says NOT-RUN (spawn/unix/tests.rs busy_exec_refused); the policy tests cover the retry")
GV_ENVIRONMENT = {
    "sys::fs::fifo::tests::an_open_that_may_create_is_refused_in_a_sticky_directory_as_the_plain_open_is":
        "gVisor has no /proc/sys/fs/protected_fifos (its procfs fs/ lists only aio-max-nr, aio-nr, file-max, "
        "file-nr, mount-max, nr_open, pipe-max-size), so the test checks nothing",
    "pi-builtins::cp::tests::a_read_only_file_cp_wrote_gets_its_attributes":
        "the test skips itself under gVisor, where an attribute set after the mode changed is refused in some runs "
        "(its own skip line)",
    "sys::spawn::unix::tests::a_background_jobs_pid_is_known_while_its_program_is_busy": BUSY_EXEC,
    "sys::spawn::unix::tests::a_background_program_that_stays_busy_fails_as_in_the_foreground": BUSY_EXEC,
    "sys::spawn::unix::tests::a_busy_background_script_without_a_shebang_still_runs_as_a_script": BUSY_EXEC,
    "sys::spawn::unix::tests::a_busy_program_runs_once_its_holder_lets_go": BUSY_EXEC,
    "sys::spawn::unix::tests::a_busy_spawn_leaves_its_thread_to_other_tasks": BUSY_EXEC,
    "sys::spawn::unix::tests::a_program_that_stays_busy_fails_after_the_waits": BUSY_EXEC,
    "sys::spawn::unix::tests::a_timeout_ends_a_run_whose_program_is_busy": BUSY_EXEC,
    "sys::spawn::unix::tests::an_abort_ends_a_run_whose_program_is_busy": BUSY_EXEC,
}
# Seconds a pi-shell binary is assumed to take when the weights file does not name it.
DEFAULT_WEIGHT = 5.0
# What a test prints when it returns early having checked nothing: a passing test that prints one
# did not pass. The forms are the tree's own (sc.py skip-forms lists every print of the tree that
# says skip, not run or nothing checked, and fails on one this rule does not read): `skipped: ...`,
# `skipped, ...`, `skipped mode 0200: ...`, `skipping ...`, `SKIP: ...`, `NOT-RUN ...`,
# `UNKNOWN: ...`, `UNCOMPARED`, each at the start of a line or after a `<case>: ` prefix or one
# capitalised word (`CHILD skipped: ...`). A line that says the word later (`<util>: the host half
# is skipped: ...`, a partial check) does not count.
SKIP_MARKER = re.compile(
    r"^\s*(?:[^\n:]{1,200}:\s+|[A-Z][A-Z0-9_-]*\s+)?(?:skipped\b|skipping\b|SKIP\b|not run\b|NOT-RUN\b|UNKNOWN:)|UNCOMPARED|nothing was checked|the test saw nothing",
    re.M,
)
# A literal of the tree that says it skips, did not run or checked nothing (sc.py skip-forms).
SKIP_WORD = re.compile(r"\bskip(?:ped|ping|s)?\b|\bnot[ -]run\b|NOT-RUN|UNCOMPARED|nothing was checked", re.I)
# A NOT-RUN line a test writes past libtest's capture, to stderr (parse_libtest matches it to its test).
NOT_RUN = re.compile(r"NOT-RUN ([A-Za-z0-9_]+): ")

ROWS = (
    ("pi-shell set (runner)", "set-runner"),
    ("pi-shell set (root)", "set-root"),
    ("pi-shell lib, one process, 4 threads (runner)", "lib4"),
    ("pi-builtins, nextest default profile", "builtins"),
    ("workspace, nextest (not pi-shell, pi-builtins)", "workspace"),
    ("TypeScript suites", "ts-small"),
    ("coding-agent --isolate", "ts-ca"),
    ("check:ts", "checkts"),
    ("skip prints the summary reads", "skipforms"),
    ("pi-shell set, gVisor (uid 1000)", "gv-set-uid1000"),
    ("pi-shell set, gVisor (root)", "gv-set-root"),
    ("pi-shell lib, one process, 4 threads, gVisor (uid 1000)", "gv-lib4-uid1000"),
    ("pi-shell lib, one process, 4 threads, gVisor (root)", "gv-lib4-root"),
    ("pi-builtins, nextest default profile, gVisor (uid 1000)", "gv-builtins-uid1000"),
    ("pi-builtins, nextest default profile, gVisor (root)", "gv-builtins-root"),
)


def set_matrix():
    return [{"who": w, "shard": s, "name": f"set-{w}-{s}"} for w in SET_WHO for s in range(1, SET_SHARDS + 1)]


def builtins_matrix():
    return [{"who": w, "name": f"builtins-{w}"} for w in SET_WHO]


def workspace_matrix():
    return [{"who": w, "part": p, "name": f"workspace-{w}-{p}"} for w in SET_WHO for p in range(1, WORKSPACE_PARTS + 1)]


def ts_matrix():
    return [{"shard": s, "name": f"ts-ca-{s}"} for s in range(1, CODING_AGENT_SHARDS + 1)]


def gvisor_matrix():
    m = []
    for w in GV_WHO:
        m += [{"who": w, "part": "set", "shard": s, "name": f"gv-set-{w}-{s}"} for s in range(1, GV_SET_SHARDS + 1)]
        m.append({"who": w, "part": "builtins", "shard": 0, "name": f"gv-builtins-{w}"})
    return m


def all_job_names():
    names = [m["name"] for m in set_matrix()] + [m["name"] for m in workspace_matrix()]
    names += [m["name"] for m in builtins_matrix()] + [m["name"] for m in ts_matrix()] + ["ts-small", "checkts", "skip-forms"]
    names += [m["name"] for m in gvisor_matrix()]
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
        "gvisor": json.dumps(gvisor_matrix()),
        "gv_set_shards": GV_SET_SHARDS,
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
    started, ended, slow, times, failures, skipped, oks = set(), set(), set(), {}, [], [], set()
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
                    oks.add(name)
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
    # A test that writes "NOT-RUN <its name>: <why>" straight to the binary's stderr, past libtest's
    # capture (pi-shell's spawn tests do), skipped itself: the line names the test, so it is matched
    # to the one passing test whose name ends in that name. A line that names no passing test, or
    # more than one, makes the unit UNKNOWN.
    unmatched = []
    for nr in sorted(set(NOT_RUN.findall("\n".join(lines)))):
        hit = [t for t in oks if t == nr or t.endswith("::" + nr)]
        if len(hit) == 1:
            if hit[0] not in skipped:
                skipped.append(hit[0])
        else:
            unmatched.append(nr)

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
    if unmatched and not failed:
        return r("UNKNOWN", "NOT-RUN line(s) that name no one passing test: " + ", ".join(unmatched[:10]))
    res = r("FAIL" if failed else "PASS")
    if slow:
        res["note"] = "past 60 s: " + ", ".join(sorted(slow)[:10])
    return skip_verdict(res)


def libtest_slow(path):
    """The tests libtest warned about at 60 s (its `timeout` event), sorted."""
    slow = set()
    try:
        for line in open(path, encoding="utf-8", errors="replace"):
            if line.startswith("{") and '"timeout"' in line:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "test" and ev.get("event") == "timeout":
                    slow.add(ev.get("name", "?"))
    except OSError:
        pass
    return sorted(slow)


def test_outputs(path, kind):
    """{test: what it printed} from a libtest JSON log (kind libtest) or a nextest JUnit report."""
    out = {}
    try:
        if kind == "libtest":
            for line in open(path, encoding="utf-8", errors="replace"):
                if line.startswith("{"):
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    if ev.get("type") == "test" and ev.get("event") in ("ok", "failed"):
                        out[ev.get("name", "?")] = ev.get("stdout") or ""
            text = open(path, encoding="utf-8", errors="replace").read()
            for m in re.finditer(r"NOT-RUN ([A-Za-z0-9_]+): [^\n]*", text):
                hit = [t for t in out if t == m.group(1) or t.endswith("::" + m.group(1))]
                if len(hit) == 1:
                    out[hit[0]] = m.group(0) + "\n" + out[hit[0]]
        else:
            for name, _, _, text in junit_cases(path):
                out[name] = text
    except (OSError, ET.ParseError):
        pass
    return out


def why_line(text):
    """The line that says why: a skip marker, else a panic's message, else the first line."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if SKIP_MARKER.search(line):
            return line[:300]
    for i, line in enumerate(lines):
        if "panicked at" in line:
            return (lines[i + 1] if i + 1 < len(lines) else line)[:300]
    return lines[0][:300] if lines else "(it printed nothing)"


def gv_environment(res, outputs, slow=()):
    """A gVisor unit's GV_ENVIRONMENT tests leave its failures and self-skips for its `environment`
    list (each with its line and reason); the unit gets the verdict the rest of its tests give.
    `slow`: the tests libtest warned about at 60 s, for the note a re-judged unit gets back."""
    env = []
    for kind, key in (("failed", "failures"), ("skipped itself", "self_skipped")):
        for t in [t for t in res[key] if t in GV_ENVIRONMENT]:
            res[key].remove(t)
            if key == "failures":
                res["failed"] -= 1
            env.append({"test": t, "kind": kind, "line": why_line(outputs.get(t, "")), "reason": GV_ENVIRONMENT[t]})
    res["environment"] = env
    # Re-judge only a unit whose FAIL or skip-marker UNKNOWN came from set-apart tests alone (an
    # UNKNOWN for its exit or its counts stays). As skip_verdict does: a self-skip left keeps it UNKNOWN.
    if env and not res["failures"] and (res["status"] == "FAIL" or
                                        (res["status"] == "UNKNOWN" and "printed a skip marker" in res["note"])):
        res["status"], res["note"] = "PASS", ("past 60 s: " + ", ".join(list(slow)[:10]) if slow else "")
        res["passed"] += len(res["self_skipped"])
        res.pop("skip_only", None)
        skip_verdict(res)
    return res


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
        for who in GV_WHO:
            exp += [(f"gv-set-{who}", ident, who) for ident, _ in bins]
            if any(i == PI_SHELL for i, _ in bins):
                exp.append((f"gv-lib4-{who}", PI_SHELL, who))
    else:
        for key in ["set-runner", "set-root", "lib4"] + [f"gv-{r}-{w}" for r in ("set", "lib4") for w in GV_WHO]:
            notes[key] = "the build gave no binary list, so the set could not run"
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
    exp.append(("skipforms", "tree", "runner"))
    for who in GV_WHO:
        exp.append((f"gv-builtins-{who}", "pi-builtins", who))
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


def rust_literals(text):
    """The string literals of Rust source (plain, byte and raw), comments and chars left out:
    [(offset, text)]."""
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if text.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif text.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif re.match(r'b?r#*"', text[i:i + 66]) and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == "_")):
            m = re.match(r'(b?r)(#*)"', text[i:])
            close = '"' + m.group(2)
            start = i + len(m.group(0))
            j = text.find(close, start)
            j = n if j < 0 else j
            out.append((i, text[start:j]))
            i = j + len(close)
        elif c == '"' or (c == "b" and text.startswith('b"', i) and (i == 0 or not text[i - 1].isalnum())):
            start = i + (2 if c == "b" else 1)
            j = start
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append((i, text[start:j]))
            i = j + 1
        elif c == "'":
            m = re.match(r"'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'", text[i:])
            i += len(m.group(0)) if m else 1
        else:
            i += 1
    return out


def literal_sample(lit):
    """What a format literal prints, roughly: line continuations joined, `{...}` arguments as `x`."""
    s = re.sub(r"\\\n\s*", "", lit).replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    s = s.replace("{{", "\0").replace("}}", "\1")
    s = re.sub(r"\{[^{}]*\}", "x", s)
    return s.replace("\0", "{").replace("\1", "}")


PRINT_CALL = re.compile(r"\b(?:e?print(?:ln)?|writeln|write)!\s*\(")


def printed(text, off):
    """Whether the literal at `off` is an argument of a print macro: eprintln!, println!, eprint!,
    print!, or write!/writeln! to std::io::stderr() or stdout() (pi-shell's say_not_run)."""
    window = text[max(0, off - 400):off]
    for m in reversed(list(PRINT_CALL.finditer(window))):
        inner = window[m.end():]
        if inner.count("(") >= inner.count(")"):
            return not m.group(0).startswith("write") or "stderr()" in inner or "stdout()" in inner
    return False


def skip_forms(tree, exceptions_path):
    """Every literal under <tree>/crates that says skip, not run or nothing checked must be read by
    SKIP_MARKER or be named in the exceptions file (`<path>\\t<start of the literal>\\t<reason>`) as
    not a skip marker. Returns (unread literals, exceptions that match nothing)."""
    exc = []
    for line in open(exceptions_path, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            f = line.rstrip("\n").split("\t")
            if len(f) != 3:
                sys.exit(f"{exceptions_path}: not three tab-separated fields: {line!r}")
            exc.append([f[0], f[1], False])
    unread = []
    for dp, dirs, files in os.walk(os.path.join(tree, "crates")):
        dirs[:] = sorted(d for d in dirs if d != "target")
        for f in sorted(files):
            if not f.endswith(".rs"):
                continue
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, tree)
            text = open(p, encoding="utf-8", errors="replace").read()
            for off, lit in rust_literals(text):
                s = literal_sample(lit)
                if not SKIP_WORD.search(s) or SKIP_MARKER.search(s) or not printed(text, off):
                    continue
                hit = [e for e in exc if e[0] == rel and s.startswith(e[1])]
                for e in hit:
                    e[2] = True
                if not hit:
                    unread.append(f"{rel}:{text.count(chr(10), 0, off) + 1}: {s[:160]!r}")
    stale = [f"{e[0]}: {e[1]!r}" for e in exc if not e[2]]
    return unread, stale


def cmd_skip_forms(tree, exceptions_path):
    unread, stale = skip_forms(tree, exceptions_path)
    fails = [f"a skip print the summary does not read: {u}" for u in unread]
    fails += [f"an exception that names no literal of the tree any more: {s}" for s in stale]
    return result("skipforms", "tree", "runner", "FAIL" if fails else "PASS", 0, 0, int(not fails), len(fails),
                  failures=fails, note="" if fails else "every skip print of the tree is read or named as not a marker")


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
    # user is covered when the same test passed as the other, on the same runtime (a gVisor row's
    # self-skip only by a gVisor row's pass).
    def runtime(row):
        return "gvisor" if row.startswith("gv-") else "host"

    passed_as = {}
    for r in results:
        bad = set(r["failures"]) | set(r.get("self_skipped", []))
        passed_as.setdefault((runtime(r["row"]), r["unit"], r["who"]), set()).update(n for n, _ in r["tests"] if n not in bad)
    exp, notes = expected_units(build_dir)
    lines = []
    commit = os.environ.get("SC_COMMIT", "?")
    lines.append(f"## sami checks of `{commit}`")
    lines.append("")
    lines.append("Report only: nothing here gates a release. A row passes when every unit in it was read and passed, "
                 "and reads KNOWN when its only failures are on the known-failure list. A unit is UNKNOWN when its "
                 "runner did not end normally (libtest 0/101, nextest 0/100, bun 0/1 with its summary line), when a "
                 "passing test printed a skip marker and passed as no other user, or when no job (or more than one) "
                 "reported it; its row is then UNKNOWN too.")
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
                others = [w for w in (GV_WHO if runtime(key) == "gvisor" else SET_WHO) if w != r["who"]]
                open_ = [s for s in r["self_skipped"] if not any(s in passed_as.get((runtime(key), r["unit"], w), ()) for w in others)]
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
    env = [(r, e) for r in results for e in r.get("environment", [])]
    if env:
        lines.append("### gVisor: tests gVisor cannot pass (the environment, not the tree; not in the verdicts)")
        lines.append("")
        for r, e in sorted(env, key=lambda x: (x[0]["row"], x[1]["test"])):
            lines.append(f"- {r['row']} `{r['unit']}` ({r['who']}): {e['kind']} `{e['test']}`: \"{e['line']}\" ({e['reason']})")
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
    busy_t = "sys::spawn::unix::tests::a_busy_program_runs_once_its_holder_lets_go"
    nr_s = {"type": "test", "event": "started", "name": busy_t}
    nr_ok = {"type": "test", "event": "ok", "name": busy_t, "exec_time": 0.1}
    nr_end = {"type": "suite", "event": "ok", "passed": 2, "failed": 0}
    nr_line = "NOT-RUN a_busy_program_runs_once_its_holder_lets_go: this kernel runs a program held open for writing\n"
    r = lt([s0, a_s, a_ok, nr_s, nr_ok, nr_end], 0, nr_line)
    check("a NOT-RUN line on stderr is that test's self-skip", (r["status"], r["self_skipped"]), ("UNKNOWN", [busy_t]))
    r = lt([s0, a_s, a_ok, nr_s, nr_ok, nr_end], 0, "NOT-RUN no_such_test: why\n")
    check("a NOT-RUN line that names no test is UNKNOWN", (r["status"], "no_such_test" in r["note"]), ("UNKNOWN", True))
    p = os.path.join(d, "lt.log")
    with open(p, "w") as f:
        f.write(nr_line)
        for e in [s0, a_s, a_ok, nr_s, nr_ok, nr_end]:
            f.write(json.dumps(e) + "\n")
    r = gv_environment(parse_libtest(p, "0", 1, "gv-set-root", "pi-shell", "root"), test_outputs(p, "libtest"), libtest_slow(p))
    check("a GV_ENVIRONMENT NOT-RUN test is set apart with its line", (r["status"], r["environment"][0]["line"][:28]),
          ("PASS", "NOT-RUN a_busy_program_runs_"))

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
    paths = {}
    for i, (row, unit, who) in enumerate(exp):
        paths[(row, unit, who)] = os.path.join(res, f"{i}.json")
        if (row, unit, who) == ("set-root", "pi-shell::zle_pty", "root"):
            continue  # the planted silent unit
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1, tests=[("t", 1.0)]),
                  open(paths[(row, unit, who)], "w"))

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
    # A gVisor job that reports nothing: gv-builtins-root (its one unit), and the uid 1000 set shard
    # that holds the lib binary (its set unit and the lib row both come from that job).
    check("the plan names the gVisor jobs", {"gv-builtins-root", "gv-set-uid1000-1", "gv-set-root-4"} <= set(all_job_names()), True)
    check("the gVisor set jobs are the shards assign() gives", set(assign([f"b{i}" for i in range(40)], {}, GV_SET_SHARDS).values()),
          {m["shard"] for m in gvisor_matrix() if m["part"] == "set" and m["who"] == "root"})
    check("the gVisor rows expect both users", {("gv-builtins-uid1000", "pi-builtins", "uid1000"), ("gv-lib4-root", "pi-shell", "root"),
                                                ("gv-set-root", "pi-shell::zle_pty", "root")} <= set(exp), True)
    gv_silent = [("gv-builtins-root", "pi-builtins", "root"), ("gv-set-uid1000", "pi-shell", "uid1000"), ("gv-lib4-uid1000", "pi-shell", "uid1000")]
    for k in gv_silent:
        if k in paths:
            os.rename(paths[k], paths[k] + ".planted")
    rc, out = summary()
    check("summary exit with a silent gVisor job", rc, 1)
    check("a silent gVisor builtins job reads UNKNOWN", "| pi-builtins, nextest default profile, gVisor (root) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("a silent gVisor builtins job is named", "`pi-builtins` (root): UNKNOWN: no result" in out, True)
    check("a silent gVisor set shard reads UNKNOWN", "| pi-shell set, gVisor (uid 1000) | **UNKNOWN** | 1 / 0 / 0 / 1 |" in out, True)
    check("its lib row reads UNKNOWN", "| pi-shell lib, one process, 4 threads, gVisor (uid 1000) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("the other gVisor rows pass", "| pi-builtins, nextest default profile, gVisor (uid 1000) | **PASS** | 1 / 0 / 0 / 0 |" in out
          and "| pi-shell set, gVisor (root) | **PASS** | 2 / 0 / 0 / 0 |" in out, True)
    # A gVisor unit that ran and failed reads FAIL with its test named.
    for k in gv_silent:
        if k in paths:
            os.rename(paths[k] + ".planted", paths[k])
    json.dump(result("gv-builtins-root", "pi-builtins", "root", "FAIL", 100, 1, passed=1, failed=1, failures=["pi-builtins::cp::tests::x"]),
              open(paths.get(("gv-builtins-root", "pi-builtins", "root"), os.path.join(res, "gv-builtins-root.json")), "w"))
    rc, out = summary()
    check("a failing gVisor unit fails its row", ("| pi-builtins, nextest default profile, gVisor (root) | **FAIL** | 0 / 0 / 1 / 0 |" in out, rc), (True, 1))
    check("a failing gVisor test is named", "`pi-builtins` (root): FAILED `pi-builtins::cp::tests::x`: **NEW**" in out, True)
    # A gVisor row's failure that the list names under its gVisor row key reads KNOWN.
    open(known_file, "w").write("gv-builtins-root\troot\tpi-builtins\tpi-builtins::cp::tests::x\tthe host's too\n")
    rc, out = summary()
    check("a listed gVisor failure is KNOWN", "| pi-builtins, nextest default profile, gVisor (root) | **KNOWN** | 0 / 1 / 0 / 0 |" in out, True)
    open(known_file, "w").write("# none\n")
    # skip-forms: a literal that says it skips is read by SKIP_MARKER or named as not a marker; a new
    # form fails the check until one of the two is true.
    tree = os.path.join(d, "tree")
    os.makedirs(os.path.join(tree, "crates", "c", "src"))
    src = os.path.join(tree, "crates", "c", "src", "lib.rs")
    exf = os.path.join(d, "exc.txt")
    open(src, "w").write('// skipped: a comment is no print\nfn t(case: &str) {\n'
                         '    eprintln!("{case}: skipped, it needs root");\n    eprintln!("CHILD skipped: {}", 1);\n'
                         '    eprintln!("NOT-RUN {case}: this kernel runs a program held open for writing");\n'
                         '    let c = \'"\';\n    eprintln!(r#"skipped mode 0200: "raw" ok"#);\n'
                         '    eprintln!("{case}: the host half is skipped: names do not fold");\n}\n')
    open(exf, "w").write("crates/c/src/lib.rs\tx: the host half is skipped\ta partial check\n")
    check("skip-forms on known forms", skip_forms(tree, exf), ([], []))
    open(src, "a").write('fn u() { eprintln!("no check here, skipping quietly"); }\n')
    unread, _ = skip_forms(tree, exf)
    check("skip-forms catches a planted new form", unread, ["crates/c/src/lib.rs:10: 'no check here, skipping quietly'"])
    open(exf, "a").write("crates/c/src/lib.rs\tgone\tstale\n")
    check("skip-forms names a stale exception", skip_forms(tree, exf)[1], ["crates/c/src/lib.rs: 'gone'"])
    for line in ("x: skipped, this filesystem does not clone", "CHILD skipped: uid 1000", "skipped mode 0200: root",
                 "NOT-RUN t: this kernel", "SKIP: running as root", "skipping reftable coverage: x"):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line)), True)
    # No binary list: the set rows are UNKNOWN, not empty passes.
    os.remove(os.path.join(build, "binaries-metadata.json"))
    rc, out = summary()
    check("summary without a binary list", ("| pi-shell set (runner) | **UNKNOWN** | - |" in out, rc), (True, 1))
    check("summary without a binary list (gVisor)", "| pi-shell set, gVisor (root) | **UNKNOWN** | - |" in out, True)

    # GV_ENVIRONMENT: in a gVisor row a listed test's self-skip or failure is set apart with its
    # line; in a host row the same self-skip still makes the unit UNKNOWN; a real failure beside it
    # still fails the unit.
    envt = next(iter(GV_ENVIRONMENT))
    e_s = {"type": "test", "event": "started", "name": envt}
    e_skip = {"type": "test", "event": "ok", "name": envt, "exec_time": 0.1,
              "stdout": "UNKNOWN: fs.protected_fifos is None, not 1 or more; nothing was checked\n"}
    e_fail = {"type": "test", "event": "failed", "name": envt, "exec_time": 0.1,
              "stdout": "thread 'x' panicked at src/x.rs:1:2:\nassertion failed: refused\n"}
    end_2ok = {"type": "suite", "event": "ok", "passed": 2, "failed": 0}
    end_2f = {"type": "suite", "event": "failed", "passed": 1, "failed": 1}
    end_3f = {"type": "suite", "event": "failed", "passed": 1, "failed": 2}

    def gvlt(events, exit_code, row="gv-set-root"):
        p = os.path.join(d, "gv.log")
        with open(p, "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")
        return gv_environment(parse_libtest(p, str(exit_code), 1, row, "pi-shell", "root"), test_outputs(p, "libtest"), libtest_slow(p))

    r = gvlt([s0, a_s, a_ok, e_s, e_skip, end_2ok], 0)
    check("gVisor env self-skip set apart", (r["status"], r["passed"], r["self_skipped"], [e["kind"] for e in r["environment"]]),
          ("PASS", 1, [], ["skipped itself"]))
    check("gVisor env line", r["environment"][0]["line"], "UNKNOWN: fs.protected_fifos is None, not 1 or more; nothing was checked")
    r = gvlt([s0, a_s, a_ok, e_s, e_fail, end_2f], 101)
    check("gVisor env failure set apart", (r["status"], r["failed"], r["failures"], r["environment"][0]["line"]),
          ("PASS", 0, [], "assertion failed: refused"))
    r = gvlt([s0, a_s, a_ok, b_s, b_f, e_s, e_fail, end_3f], 101)
    check("a real failure beside it still fails", (r["status"], r["failures"]), ("FAIL", ["b"]))
    end_1p1f = {"type": "suite", "event": "failed", "passed": 1, "failed": 1}
    r = gvlt([s0, a_s, a_skip, e_s, e_fail, end_1p1f], 101)
    check("a self-skip beside a set-apart failure keeps the unit UNKNOWN", (r["status"], r["self_skipped"]), ("UNKNOWN", ["a"]))
    e_slow = {"type": "test", "event": "timeout", "name": "a"}
    r = gvlt([s0, a_s, e_slow, a_ok, e_s, e_skip, end_2ok], 0)
    check("a re-judged unit keeps its 60 s warning note", (r["status"], r["note"]), ("PASS", "past 60 s: a"))
    p = os.path.join(d, "host.log")
    with open(p, "w") as f:
        for e in [s0, a_s, a_ok, e_s, e_skip, end_2ok]:
            f.write(json.dumps(e) + "\n")
    check("a host row keeps the self-skip UNKNOWN", parse_libtest(p, "0", 1, "set-root", "pi-shell", "root")["status"], "UNKNOWN")
    json.dump(gvlt([s0, a_s, a_ok, e_s, e_skip, end_2ok], 0), open(os.path.join(res, "gv-env.json"), "w"))
    rc, out = summary()
    check("the summary lists the gVisor environment test", f"skipped itself `{envt}`: \"UNKNOWN: fs.protected_fifos" in out, True)
    # The same through a nextest JUnit report (the gv-nextest path and its test names).
    gj = os.path.join(d, "gv.xml")
    with open(gj, "w") as f:
        f.write('<testsuites><testsuite name="pi-builtins"><testcase classname="pi-builtins" name="cp::tests::ok" time="1"/>'
                '<testcase classname="pi-builtins" name="cp::tests::a_read_only_file_cp_wrote_gets_its_attributes" time="1">'
                '<system-out>skipped: under gVisor an attribute set after the mode changed is refused in some runs\n'
                '</system-out></testcase></testsuite></testsuites>')
    r = gv_environment(parse_junit(gj, "0", 1, "gv-builtins-root", "pi-builtins", "root", (0,), (100,)), test_outputs(gj, "junit"))
    check("gVisor env self-skip set apart (JUnit)", (r["status"], [e["test"] for e in r["environment"]], r.get("skip_only")),
          ("PASS", ["pi-builtins::cp::tests::a_read_only_file_cp_wrote_gets_its_attributes"], None))
    # A gVisor self-skip is covered by the other user's gVisor pass, never by a host row's.
    def gnx(who, skipped, passed):
        return dict(result(f"gv-builtins-{who}", "pi-builtins", who, "UNKNOWN" if skipped else "PASS", 0, 1, passed=len(passed),
                           tests=[(n, 1.0) for n in passed + skipped], self_skipped=skipped), skip_only=bool(skipped))
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if r["row"].startswith("gv-builtins") or r["row"] == "builtins":
            os.remove(os.path.join(res, f))
    json.dump(nx("root", [], ["a", "c"]), open(os.path.join(res, "b-root.json"), "w"))
    json.dump(gnx("uid1000", ["c"], ["a"]), open(os.path.join(res, "gb-uid1000.json"), "w"))
    json.dump(gnx("root", ["c"], ["a"]), open(os.path.join(res, "gb-root.json"), "w"))
    rc, out = summary()
    check("a gVisor self-skip is not covered by a host pass", "| pi-builtins, nextest default profile, gVisor (uid 1000) | **UNKNOWN** |" in out, True)
    json.dump(gnx("root", [], ["a", "c"]), open(os.path.join(res, "gb-root.json"), "w"))
    rc, out = summary()
    check("a gVisor self-skip is covered by the other user's gVisor pass",
          "| pi-builtins, nextest default profile, gVisor (uid 1000) | **PASS** |" in out, True)

    if fails:
        for f in fails:
            print(f"SELFTEST FAIL {f}")
        sys.exit(1)
    print("SELFTEST OK: libtest (60 s warning, hang, kill, self-skip), nextest and bun counters, the shard "
          "assignment and per-user weights, and the summary's UNKNOWN for a unit no job or two jobs reported "
          "(also a gVisor job), and gVisor's environment tests set apart")


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
    elif c == "gv-libtest":
        print(json.dumps(gv_environment(parse_libtest(*a), test_outputs(a[0], "libtest"), libtest_slow(a[0]))))
    elif c == "gv-nextest":
        junit, ex, secs, row, unit, who = a
        print(json.dumps(gv_environment(parse_junit(junit, ex, secs, row, unit, who, (0,), (100,)), test_outputs(junit, "junit"))))
    elif c == "bun":
        print(json.dumps(parse_bun(*a)))
    elif c == "plain":
        print(json.dumps(parse_plain(*a)))
    elif c == "summary":
        sys.exit(cmd_summary(*a))
    elif c == "skip-forms":
        print(json.dumps(cmd_skip_forms(*a)))
    elif c == "selftest":
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
