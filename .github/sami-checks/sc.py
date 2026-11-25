#!/usr/bin/env python3
"""sami-checks: the plan, the counters and the summary of .github/workflows/sami-checks.yml.

  sc.py plan                       GITHUB_OUTPUT lines: the commit, the job matrices, the control
  sc.py shard WHO N K META WEIGHTS the pi-shell test binaries of shard N of K, one "id<TAB>path" a line
  sc.py ts-small                   the small TypeScript suites, one "unit<TAB>dir<TAB>bound<TAB>args" a line
  sc.py libtest LOG EXIT SECS ROW UNIT WHO   one libtest binary's result (JSON on stdout)
  sc.py nextest JUNIT EXIT SECS ROW UNIT WHO one nextest run's result
  sc.py gv-control LOG EXIT SECS ROW UNIT WHO the map-limit control: gv-libtest, UNKNOWN unless each ORPHAN_CONTROL_TESTS test ran
  sc.py bun JUNIT LOG EXIT SECS ROW UNIT     one `bun test` run's result
  sc.py plain EXIT SECS ROW UNIT LOG         a command whose exit is its verdict (check:ts)
  sc.py clippy-crates METADATA CRATE...     "crate<TAB>dir<TAB>library root" a line, from `cargo metadata`
  sc.py clippy LOG EXIT SECS CRATE DIR CONTROL_LOG CONTROL_FILE   one crate's clippy result against clippy-baseline.txt
  sc.py clippy-baseline LOG CRATE DIR      one crate's findings as clippy-baseline.txt lines (to regenerate it)
  sc.py platforms PC OUT                   one result per platform from platform-checks' pc-report under PC
  sc.py summary RESULTS BUILD [KNOWN]      the step summary (markdown) on stdout; exit 1 unless every row passed
  sc.py skip-forms TREE NOT_MARKERS        each print of TREE/crates that says skip is read or named (JSON)
  sc.py skip-lines RESULTS NOT_MARKERS     each skip line a passing test printed is read or named (JSON)
  sc.py flaky-failed RESULT KNOWN          the failed tests of one result with a `flaky: ` entry, one a line
  sc.py retried RESULT TEST REPORT SHAPE [SCOPE]   adds one retry (pass, partial, skip or fail) to RESULT;
                                           SCOPE whole-unit (the default) or own-process (nextest)
  sc.py junit-merge OUT JUNIT...           one JUnit report of several (nextest.sh's two passes)
  sc.py selftest                           the counters and the summary against hand-made inputs
  sc.py docs UNIT STREAM LOG EXIT SECS     `cargo doc --message-format=json -p pi-shell`: each broken intra-doc link (docs.sh)
  sc.py changelog LOG EXIT SECS FILES DIFF WRITE_EXIT  `fix-changelogs.ts --check`: each CHANGELOG it would rewrite (changelog.sh)
  sc.py plant WHAT TREE                    the docs or changelog row's control: puts its planted fault in TREE

The counter rule (the fork's gate kit): a result is PASS or FAIL only when it was read. A libtest
binary whose exit is neither 0 nor 101, a nextest run whose exit is neither 0 nor 100, a bun run
with no JUnit report or no summary line, a command the time bound or a signal ended, a clippy run
whose exit is neither 0 nor 101 or whose control was not caught, a platform the platform report
gives no verdict for, and a unit the plan expects that no job reported, or that two jobs reported,
are UNKNOWN, and so is every row they belong to. A test that passed after printing a skip marker
compared nothing: it is counted apart, named, and its unit is UNKNOWN, unless each of its skip
lines is a sub-case that partial-skips.txt lets that test skip and the entry's witness line is in
its output (then it passes and is listed as partial), it passed as the other user, or
known-failures.txt names each of its skip lines for that row and user (`skips: `; then it reads
KNOWN). A test that started and never ended is named. A failure with a `flaky: ` entry reads KNOWN
only when the test passed in a retry of its whole unit in the same job (the unit's command again,
at most twice; on the platform rows, nextest's own retry of the test's own process).
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
# The map-limit control (gvisor-run.sh) runs the lib's orphan_jobs module at 4 threads. A filter that
# selects nothing (the module renamed or moved) lets libtest exit 0 having run nothing, so the control
# needs each of the module's tests by name: these, its #[test] functions at 509a2d77 and a72018dd.
ORPHAN_CONTROL_TESTS = tuple(f"testkit::suites::orphan_jobs::{t}" for t in (
    "a_subshell_exit_ends_its_background_native_task",
    "a_subshell_exit_ends_its_background_shell_loop",
    "a_subshell_exit_ends_a_background_loop_waiting_on_an_external",
    "a_background_job_that_is_just_an_external_outlives_its_subshell",
    "a_nested_job_is_judged_on_its_own_when_its_parent_job_ends",
    "a_detached_tree_outlives_its_subshell",
    "orphans_are_found_again_after_a_restore",
    "without_the_knob_orphaned_jobs_run_on",
))
# Seconds a pi-shell binary is assumed to take when the weights file does not name it.
DEFAULT_WEIGHT = 5.0
# The platform rows: platform-checks.yml, called on the candidate, tests these crates on these
# platforms (the fork's hand-run platform rows: pi-shell, macOS and Windows).
PLATFORMS = ("macos", "windows")
PLATFORM_CRATES = "pi-shell"
# Each platform's tests run in this many parallel legs, one nextest partition each (count:k/N).
PLATFORM_PARTITIONS = 3
# A failed platform test runs once more (nextest retries): one that then passes reads FLAKY, which
# is a pass a flaky known-failure entry needs; with a single repeat a failure alone shows none.
PLATFORM_RETRIES = 1
# The clippy row: the crates the fork's hand-run clippy gate linted, one unit each.
CLIPPY_CRATES = ("pi-shell", "pi-vcs", "pi-vfs", "pi-walker", "pi-builtins", "pi-natives")
# The name of the unused import clippy.sh plants as the clippy row's control.
CLIPPY_CONTROL = "ScClippyControl"
# What a test prints when it returns early having checked nothing: a passing test that prints one
# did not pass. The forms are the tree's own (sc.py skip-forms lists every print of the tree that
# says skip, not run or nothing checked, and fails on one this rule does not read): `skipped: ...`,
# `skipped, ...`, `skipped mode 0200: ...`, `skipping ...`, `SKIP: ...`, `NOT-RUN ...`,
# `UNKNOWN: ...`, `not checked`, each at the start of a line, after one capitalised word
# (`CHILD skipped: ...`) or a subject and `is`/`are` (pi-builtins file_backup/tests.rs prints
# `cp: the host half is skipped: ...`, pi-shell zsh_mod_zftp/io.rs `...: the mark is not checked`),
# and after up to 8 `<prefix>: ` segments, since a case name can itself hold ": " (pi-iso cow.rs
# prints `/dev/shm: 3 bytes onto 5, ... failing: skipped, ...`); and `UNCOMPARED`, `nothing was
# checked`, `the test saw nothing` and `nothing to test` anywhere in a line. A skip of part of a
# test is a skip too: partial-skips.txt is where a test may skip a part and still pass. Each segment
# ends at its first colon and takes all the blanks after it, and a subject is at most 200
# characters, so a line is tried in a bounded number of ways.
SKIP_MARKER = re.compile(
    r"^[ \t]*(?![ \t])(?:[^\n:]{0,200}:[ \t]+(?![ \t])){0,8}"
    r"(?:[A-Z][A-Z0-9_-]*[ \t]+|[^\n:]{0,200}?\b(?:is|are)[ \t]+)?"
    r"(?:skipped\b|skipping\b|SKIP\b|not run\b|NOT-RUN\b|UNKNOWN:|not checked\b)"
    r"|UNCOMPARED|nothing was checked|the test saw nothing|nothing to test",
    re.M,
)
# A line or literal that says it skips, did not run, gave up or checked nothing (sc.py skip-forms
# and skip-lines): each one must be read by SKIP_MARKER or be named in skip-forms-not-markers.txt.
SKIP_WORD = re.compile(
    r"\bskip(?:ped|ping|s)?\b|\bnot[ -]run\b|NOT-RUN|UNCOMPARED|nothing was checked|nothing to test"
    r"|\bnot checked\b|\bchecked nothing\b|\bnot compared\b",
    re.I,
)
# A NOT-RUN line a test writes past libtest's capture, to stderr (parse_libtest matches it to its test).
NOT_RUN = re.compile(r"NOT-RUN ([A-Za-z0-9_]+): [^\n]*")

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
    ("clippy --tests -D warnings, per crate (failed: findings beyond clippy-baseline.txt)", "clippy"),
    ("skip prints the summary reads", "skipforms"),
    ("pi-shell set, gVisor (uid 1000)", "gv-set-uid1000"),
    ("pi-shell set, gVisor (root)", "gv-set-root"),
    ("pi-shell lib, one process, 4 threads, gVisor (uid 1000)", "gv-lib4-uid1000"),
    ("pi-shell lib, one process, 4 threads, gVisor (root)", "gv-lib4-root"),
    ("pi-builtins, nextest default profile, gVisor (uid 1000)", "gv-builtins-uid1000"),
    ("pi-builtins, nextest default profile, gVisor (root)", "gv-builtins-root"),
    ("pi-shell orphan_jobs at 4 threads, gVisor: the map-limit control (uid 1000)", "gv-orphan-uid1000"),
    ("pi-shell orphan_jobs at 4 threads, gVisor: the map-limit control (root)", "gv-orphan-root"),
    ("rustdoc intra-doc links (pi-shell)", "docs"),
    ("CHANGELOG format (fix-changelogs --check)", "changelog"),
)
# The Rust tests (sami-rust-test.yml) report no units here: each of its two jobs is a row of its own,
# read from the job's conclusion, which sami-checks.yml passes as SC_RUST_TESTS.
RUST_JOBS = (
    ("Rust tests, Bazel and the other cargo workspaces (sami-rust-test.yml rust_test)", "rust_test"),
    ("Rust tests, macOS only (sami-rust-test.yml rust_test_macos)", "rust_test_macos"),
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
    names += [m["name"] for m in builtins_matrix()] + [m["name"] for m in ts_matrix()]
    # macos-bash is no job: it skips the macOS legs' Homebrew bash install (the platform checks'
    # skip_bash_install), whose check must then stop the legs, so the macOS row reads UNKNOWN.
    names += ["ts-small", "checkts", "skip-forms", "platforms", "clippy", "macos-bash"]
    names += [m["name"] for m in gvisor_matrix()]
    names += ["docs", "changelog"]
    return names


def cmd_plan():
    event = os.environ["GITHUB_EVENT_NAME"]
    ref = os.environ["GITHUB_REF"]
    if event == "workflow_dispatch":
        commit = os.environ.get("SC_INPUT_COMMIT", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            sys.exit(f"::error::the commit input must be a full 40-character lowercase id, not '{commit}'")
    elif event == "push" and ref == "refs/heads/release-candidate":
        commit = os.environ["GITHUB_SHA"]
    else:
        # A push of this tool's own branch: its controls only (the selftest), no tree.
        commit = ""
    silent = os.environ.get("SC_INPUT_SILENT", "")
    if silent and silent not in all_job_names():
        sys.exit(f"::error::the silent input names no job of the plan: '{silent}' (one of {', '.join(all_job_names())})")
    plant = os.environ.get("SC_INPUT_PLANT", "")
    if plant and plant not in PLANTS:
        sys.exit(f"::error::the plant input names no row's control: '{plant}' (one of {', '.join(PLANTS)})")
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
        "platform_partitions": PLATFORM_PARTITIONS,
        "platform_retries": PLATFORM_RETRIES,
        "clippy_crates": " ".join(CLIPPY_CRATES),
        "gvisor": json.dumps(gvisor_matrix()),
        "gv_set_shards": GV_SET_SHARDS,
        "plant": plant,
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
           note="", self_skipped=(), partial=(), skip_lines=None, retries=None):
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
        # Every skip line of each test in self_skipped, which known-failures.txt's `skips: ` entries
        # match: a test reads as a known skip only when each of its lines matches, so none is dropped.
        "skip_lines": {n: list(ls) for n, ls in (skip_lines or {}).items()},
        "partial": [list(p) for p in partial],
        # Each failed test's retries in this job (record_retry, or nextest's own retries read from its
        # JUnit report): [{outcome, ran, of, shape, scope}].
        "retries": {n: list(rs) for n, rs in (retries or {}).items()},
        "failures": list(failures),
        "tests": [[n, round(t, 3)] for n, t in tests],
        "note": note,
    }


PARTIAL_SKIPS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "partial-skips.txt")


def literal_pattern(lit):
    """A format literal as a pattern of the whole line it prints, each `{...}` argument any text."""
    parts = re.split(r"(\{\{|\}\}|\{[^{}]*\})", lit)
    return re.compile("".join(
        re.escape(p[0]) if p in ("{{", "}}") else ".*" if p.startswith("{") else re.escape(p) for p in parts))


def read_partial_skips(path=PARTIAL_SKIPS):
    """partial-skips.txt: [test, format literal, witness regex, reason] per entry."""
    out = []
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            if line.strip() and not line.startswith("#"):
                f = line.rstrip("\n").split("\t")
                if len(f) != 4:
                    sys.exit(f"{path}: not four tab-separated fields: {line!r}")
                out.append(f)
    return out


def partial_rules(path=PARTIAL_SKIPS):
    """test -> [(the literal's line pattern, the witness, the reason)]."""
    rules = {}
    for test, lit, witness, reason in read_partial_skips(path):
        rules.setdefault(test, []).append((literal_pattern(lit), re.compile(witness, re.M), reason))
    return rules


def skip_reading(name, out, rules):
    """How a passing test's output reads: None when no line of it holds a skip marker; else (its
    skip lines, the reason) when each skip line is printed by a literal the partial-skip list lets
    this test skip and that entry's witness is in the output (a partial pass), else (lines, None)."""
    lines = [l.strip() for l in out.splitlines() if SKIP_MARKER.search(l)]
    if not lines:
        return None
    live = [(p, r) for p, w, r in rules.get(name, ()) if w.search(out)]
    used = []
    for l in lines:
        why = next((r for p, r in live if p.fullmatch(l)), None)
        if why is None:
            return lines, None
        if why not in used:
            used.append(why)
    return lines, "; ".join(used)


def skip_verdict(res):
    """A unit whose passing tests printed a skip marker: those tests are not passes, and the unit
    is UNKNOWN unless it already failed or is UNKNOWN for another reason. A partial pass (the
    partial-skip list) stays a pass and is only listed."""
    s = res["self_skipped"]
    if s:
        res["passed"] -= len(s)
        if res["status"] == "PASS":
            res["status"] = "UNKNOWN"
            res["skip_only"] = True
            res["note"] = f"{len(s)} passing test(s) printed a skip marker and checked nothing: " + ", ".join(s[:12])
    return res


EVENT_START = re.compile(r'\{\s*"type"\s*:')


def libtest_event(line):
    """The libtest JSON event on a line, or None. A child process that writes to the binary's stdout
    can leave a line unfinished, so an event can start after its text (`test x ... { "type": ...`,
    run 45287678343) or have text after it."""
    m = EVENT_START.search(line)
    if not m:
        return None
    try:
        ev, _ = json.JSONDecoder().raw_decode(line, m.start())
    except ValueError:
        return None
    return ev if isinstance(ev, dict) else None


def parse_libtest(log, exit_code, secs, row, unit, who, partial_path=PARTIAL_SKIPS):
    """libtest's JSON events (-Z unstable-options --format json --report-time, --show-output).
    Text that is not an event (a child's or a thread's own writes) is ignored. libtest's
    `timeout` event is its 60 s warning, not a verdict: the test's own ok or failed comes later."""
    started, ended, slow, times, failures, skipped, partial, skip_lines, oks = set(), set(), set(), {}, [], [], [], {}, set()
    passed = failed = ignored = 0
    suite_end = None
    rules = partial_rules(partial_path)
    try:
        lines = open(log, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return result(row, unit, who, "UNKNOWN", exit_code, secs, note="no log")
    for line in lines:
        ev = libtest_event(line)
        if ev is None:
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
                    k = skip_reading(name, ev.get("stdout") or "", rules)
                    if k and k[1]:
                        partial.append((name, len(k[0]), k[1]))
                    elif k:
                        skipped.append(name)
                        skip_lines[name] = k[0]
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
    for m in NOT_RUN.finditer("\n".join(lines)):
        nr = m.group(1)
        hit = [t for t in oks if t == nr or t.endswith("::" + nr)]
        if len(hit) == 1:
            if hit[0] not in skipped:
                skipped.append(hit[0])
            # The known-skip entries match a test's skip lines (known_skip).
            if m.group(0).strip() not in skip_lines.setdefault(hit[0], []):
                skip_lines[hit[0]].append(m.group(0).strip())
        elif nr not in unmatched:
            unmatched.append(nr)

    def r(status, note=""):
        return result(row, unit, who, status, exit_code, secs, passed, failed, ignored, failures, tests, note, skipped,
                      partial, skip_lines)

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


def gv_control(log, exit_code, secs, row, unit, who):
    """The map-limit control's result: libtest's result, UNKNOWN unless every test of
    ORPHAN_CONTROL_TESTS ran to a verdict; the ones that did not are named."""
    res = parse_libtest(log, exit_code, secs, row, unit, who)
    ran = {n for n, _ in res["tests"]} | set(res["failures"])
    missing = [t for t in ORPHAN_CONTROL_TESTS if t not in ran]
    if missing:
        note = (f"{len(missing)} of the {len(ORPHAN_CONTROL_TESTS)} control tests did not run: "
                + ", ".join(t.rsplit("::", 1)[-1] for t in missing))
        res["note"] = note if res["status"] != "UNKNOWN" else f"{res['note']}; {note}"
        res["status"] = "UNKNOWN"
    return res


def passed_attempt(out):
    """How an attempt that passed reads: `skip` when its output holds a skip marker (it checked
    nothing), else `pass`. The one rule for every retry: record_retry's and nextest's own."""
    return "skip" if SKIP_MARKER.search(out or "") else "pass"


def nextest_attempts(flaky, rerun, out):
    """The outcomes of nextest's own retries after a test's first attempt: for a flaky case (its
    <flakyFailure>/<flakyError> attempts, then a last attempt whose output is the case's own), each
    flaky attempt after the first failed and the last attempt passed or skipped; for a failed case's
    <rerunFailure>/<rerunError> retries, each failed."""
    if flaky:
        return ["fail"] * (flaky - 1) + [passed_attempt(out)]
    return ["fail"] * rerun


def junit_cases(path):
    """(full name, kind, seconds, output, (retries, first failure, nextest's retry elements)) of
    each <testcase> once. bun nests a <testsuite> per describe block, so walking every suite's
    cases would count a nested case once per enclosing suite. kind is ok, failed, skipped or flaky.
    nextest's own retries (its Jenkins JUnit: <flakyFailure>/<flakyError> for each failed attempt of
    a test that passed in the end, <rerunFailure>/<rerunError> for each failed retry of a test that
    failed every attempt) give `flaky` (failed, then passed: not a pass) and the retries' outcomes
    after the first attempt (nextest_attempts), with the first failure's message. A case with
    <failure> as well as flaky attempts (nextest's flaky-fail) is `failed`: the runner counted it
    failed."""
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
        failed = [e for e in case if e.tag in ("failure", "error")]
        flaky = [e for e in case if e.tag in ("flakyFailure", "flakyError")]
        rerun = [e for e in case if e.tag in ("rerunFailure", "rerunError")] if failed else []
        if case.find("skipped") is not None:
            kind = "skipped"
        elif failed:
            kind = "failed"
        else:
            kind = "flaky" if flaky else "ok"
        out = "".join((e.text or "") for e in case if e.tag in ("system-out", "system-err"))
        first = flaky[0] if flaky else failed[0] if rerun else None
        message = ""
        if first is not None:
            lines = [l.strip() for l in (first.text or "").split("\n") if l.strip()]
            message = (first.get("message") or " ".join(lines[:2]))[:200]
        elements = len(flaky) or len(rerun)
        retries = nextest_attempts(len(flaky), len(rerun), out) if elements else []
        yield full, kind, t, out, (retries, message, elements)


def junit_merge(out, paths):
    """One JUnit report of several (nextest.sh's two passes): every <testsuite> of each under one
    <testsuites>. Each input must exist and parse; else nothing is written, and the unit has no
    report (UNKNOWN). Returns the number of test cases written."""
    if os.path.exists(out):
        os.remove(out)
    merged = ET.Element("testsuites")
    for p in paths:
        root = ET.parse(p).getroot()
        merged.extend(root.findall("testsuite") if root.tag == "testsuites" else [root])
    ET.ElementTree(merged).write(out, encoding="unicode")
    return sum(1 for _ in merged.iter("testcase"))


def parse_junit(junit, exit_code, secs, row, unit, who, ok_exits, fail_exits, partial_path=PARTIAL_SKIPS):
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
    # A flaky case failed first and passed on nextest's own retry: it is a failure the known-failure
    # list's `flaky: ` rule reads with its retries; the runner counted it passed, so the exit check
    # reads only the cases the runner counted failed.
    hard = [c[0] for c in cases if c[1] == "failed"]
    failures = hard + [c[0] for c in cases if c[1] == "flaky"]
    ignored = sum(1 for c in cases if c[1] == "skipped")
    rules = partial_rules(partial_path)
    skipped, partial, skip_lines = [], [], {}
    for c in cases:
        k = skip_reading(c[0], c[3], rules) if c[1] == "ok" else None
        if k and k[1]:
            partial.append((c[0], len(k[0]), k[1]))
        elif k:
            skipped.append(c[0])
            skip_lines[c[0]] = k[0]
    tests = [(c[0], c[2]) for c in cases if c[1] != "skipped"]
    of = len({n for n, _ in tests} | set(failures))
    retries = {}
    for c in cases:
        outcomes, first, _ = c[4]
        if outcomes:
            retries[c[0]] = [{"outcome": o, "ran": 1, "of": of, "shape": f"nextest's own retry {i} of {len(outcomes)}",
                              "scope": "own-process", "first_failure": first} for i, o in enumerate(outcomes, 1)]

    def r(s, note=""):
        return result(row, unit, who, s, exit_code, secs, passed, len(failures), ignored, failures, tests, note, skipped,
                      partial, skip_lines, retries)

    if code not in ok_exits + fail_exits:
        return r("UNKNOWN", f"exit {exit_code}: the run did not finish")
    if not cases:
        return r("UNKNOWN", "the JUnit report names no test")
    # Each of nextest's retry elements of a case has its retry record: else the reading of them is
    # broken, and a flaky or failed case would read without its retries.
    unrecorded = [c[0] for c in cases if len(retries.get(c[0], [])) != c[4][2]]
    if unrecorded:
        return r("UNKNOWN", "a flaky case has no recorded retry: " + ", ".join(unrecorded[:12]))
    if (code in ok_exits) != (not hard):
        return r("UNKNOWN", f"exit {exit_code} with {len(hard)} failed")
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


# The clippy row applies the cut's rule (Cut7's kit: a crate fails only on findings beyond what the
# release already has) without linting the release a second time: the findings the release has
# are checked in, one line per (crate, file, lint code, message) with a count. See the file's
# header for how to regenerate it.
CLIPPY_BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clippy-baseline.txt")


def read_lines(path):
    try:
        return open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return None


# The key of a compile error that carries no lint code (rustc gives a syntax error none). It is a
# finding that no baseline line holds: a target that did not compile was never linted.
UNCODED_ERROR = "error"


def clippy_diagnostics(path):
    """The findings in a `cargo clippy --message-format=json` log, and the numbers of its lines that
    look like cargo messages (`{"reason":`) but do not parse: ({(file, code, message): {(line,
    column)}}, [line number]). A finding is a compiler message with a primary span and a code: its
    lint or error code (diagnostic `code.code`), or UNCODED_ERROR for an error with none. The same
    finding in several of a crate's targets (a module that the lib test and a test binary both
    build) is one, by its place. None when there is no log."""
    lines = read_lines(path)
    if lines is None:
        return None
    out, unread = {}, []
    for n, line in enumerate(lines, 1):
        if not line.startswith('{"reason":'):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            unread.append(n)
            continue
        if ev.get("reason") != "compiler-message":
            continue
        m = ev.get("message") or {}
        code = (m.get("code") or {}).get("code") or (UNCODED_ERROR if m.get("level") == "error" else None)
        span = next((s for s in m.get("spans") or () if s.get("is_primary")), None)
        if code and span:
            out.setdefault((span["file_name"], code, m.get("message", "")), set()).add((span["line_start"], span["column_start"]))
    return out, unread


def read_clippy_baseline(path):
    """{(crate, file, code, message): count} from the baseline file: `crate<TAB>file<TAB>code<TAB>
    count<TAB>message` a line, `#` comments. A missing or malformed file stops sc.py: the crate then
    has no result, and reads UNKNOWN."""
    lines = read_lines(path)
    if lines is None:
        sys.exit(f"no clippy baseline at {path}")
    base = {}
    for n, line in enumerate(lines, 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t", 4)
        if len(parts) != 5 or not parts[3].isdigit():
            sys.exit(f"{path}:{n}: want crate<TAB>file<TAB>code<TAB>count<TAB>message")
        crate, f, code, count, msg = parts
        base[(crate, f, code, msg)] = int(count)
    return base


def clippy_baseline_lines(log, crate, crate_dir):
    """The baseline lines of one crate's findings in its log (the regeneration step's input). A
    compile error with no code is never a baseline line; it and any line that did not parse are
    named in a comment line instead, so a regenerated baseline cannot take them in unseen."""
    diags, unread = clippy_diagnostics(log) or ({}, ["(no log)"])
    own = {k: v for k, v in diags.items() if k[0].startswith(crate_dir.rstrip("/") + "/")}
    for (f, code, msg), locs in sorted(own.items()):
        if code == UNCODED_ERROR:
            print(f"# {crate}: a compile error, not a baseline line: {f}:{min(locs)[0]}: {msg}")
        else:
            print(f"{crate}\t{f}\t{code}\t{len(locs)}\t{msg}")
    if unread:
        print(f"# {crate}: log lines that did not parse, so their findings are missing here: {', '.join(map(str, unread[:12]))}")


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


def parse_clippy(log, exit_code, secs, crate, crate_dir, ctl_log, ctl_file, baseline_path=CLIPPY_BASELINE):
    """One crate's clippy result, by the cut's rule against the baseline. Its findings are those in
    files under its own directory (a dependency's are not this crate's). FAIL: a finding whose key
    the baseline lacks, a key with more places than the baseline counts, or a compile error with no
    code (UNCODED_ERROR, which no baseline line holds: its target was never linted), each place
    named `file:line: code: message`. KNOWN: findings, each within the baseline. PASS: no finding.
    A baseline key with fewer places here is listed (baseline_fell) with the line that replaces it,
    never a failure. KNOWN and PASS also need the control run to read the unused import clippy.sh
    planted in the crate's library root, a finding the baseline lacks. Anything else is UNKNOWN: no
    log, a log line that looks like a cargo message but does not parse (its finding is unread), an
    exit other than 0 or 101 (clippy did not finish), exit 101 with no finding of its own, exit 0
    with findings."""
    base = {(f, code, msg): n for (c, f, code, msg), n in read_clippy_baseline(baseline_path).items()
            if c == crate and code != UNCODED_ERROR}

    def r(status, failures=(), note="", fell=()):
        res = result("clippy", crate, "runner", status, exit_code, secs, failed=len(failures), failures=failures, note=note)
        res["baseline_fell"] = list(fell)
        return res

    if crate_dir == "-":
        return r("UNKNOWN", note=f"the tree has no package {crate}")
    got = clippy_diagnostics(log)
    if got is None:
        return r("UNKNOWN", note="no log")
    diags, unread = got
    own = {k: v for k, v in diags.items() if k[0].startswith(crate_dir.rstrip("/") + "/")}
    try:
        code = int(exit_code)
    except ValueError:
        code = None
    if code not in (0, 101):
        return r("UNKNOWN", note=f"exit {exit_code}: clippy did not finish" + (" (the time bound ended it)" if code == 124 else ""))
    if code == 101 and not own and not unread:
        first = next((l for l in read_lines(log) or () if l.startswith("error")), "no error line")
        return r("UNKNOWN", note=f"exit 101 and no finding under {crate_dir}/, so it was not linted: {first[:300]}")
    if code == 0 and own:
        return r("UNKNOWN", note=f"exit 0 with {sum(map(len, own.values()))} findings under -D warnings")
    beyond, known = [], 0
    for (f, lint, msg), places in sorted(own.items()):
        b = base.get((f, lint, msg), 0)
        if len(places) > b:
            more = f" ({len(places)} here, {b} in the baseline)" if b else ""
            beyond += [f"{f}:{line}: {lint}: {msg}{more}" for line, _ in sorted(places)]
        else:
            known += len(places)
    fell = []
    for (f, lint, msg), b in sorted(base.items()):
        n = len(own.get((f, lint, msg), ()))
        if n < b:
            fix = "delete its line" if n == 0 else f"its line becomes `{crate}\t{f}\t{lint}\t{n}\t{msg}` (tab-separated)"
            fell.append(f"{f}: {lint}: {msg} ({n} here, {b} in the baseline): {fix}")
    if unread:
        return r("UNKNOWN", beyond, f"log line(s) {', '.join(map(str, unread[:12]))} look like cargo messages and do not parse, "
                                    "so their findings are unread", fell)
    ctl = clippy_diagnostics(ctl_log)
    caught = ctl is not None and any(f == ctl_file and lint == "unused_imports" and CLIPPY_CONTROL in msg for f, lint, msg in ctl[0])
    said = "the planted control read as a finding beyond the baseline" if caught else (
        "the control left no log" if ctl is None else f"the control's unused import planted in {ctl_file} was not read as a finding")
    if beyond:
        return r("FAIL", beyond, f"{len(beyond)} finding(s) beyond the baseline; {known} within it; {said}", fell)
    if not caught:
        return r("UNKNOWN", note=f"{said}, so a clean result proves nothing", fell=fell)
    if known:
        return r("KNOWN", note=f"{known} finding(s), each within the baseline; {said}", fell=fell)
    return r("PASS", note=said, fell=fell)


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
        # list can name it. A timeout, or a test with no verdict, gets its verdict after the name, so no
        # entry makes it KNOWN. Its retries are nextest's own, in the same run (the shared reader,
        # junit_cases: a <flakyFailure> attempt that then passed is a fail then a pass; each
        # <rerunFailure> is a fail), one record each, scope own-process, over every repeat of every
        # leg: failure_reason gives a flaky entry its reason only when one of them passed.
        bad = []
        for t in mine:
            v = t.get("verdict")
            if v != "PASS":
                bad.append(f"{t.get('binary')}::{t.get('test')}" + ("" if v in ("FAIL", "FLAKY") else f" ({v})"))
        times, retries, unrecorded = [], {}, []
        for _, d in legs.get(p, ()):
            try:
                cases = list(junit_cases(os.path.join(d, "junit.xml")))
            except (OSError, ET.ParseError):
                continue
            times += [(c[0], c[2]) for c in cases if c[1] != "skipped"]
            of = len({c[0] for c in cases if c[1] != "skipped"})
            for c in cases:
                outcomes, first, elements = c[4]
                # Each of nextest's retry elements has its record, as parse_junit requires: else the
                # reading of them is broken, and the case would read without its retries.
                if len(outcomes) != elements:
                    unrecorded.append(c[0])
                retries.setdefault(c[0], []).extend(
                    {"outcome": o, "ran": 1, "of": of, "shape": f"nextest's own retry {i} of {len(outcomes)}",
                     "scope": "own-process", "first_failure": first} for i, o in enumerate(outcomes, 1))
        secs = max((int(kv.get("run_seconds") or 0) for kv, _ in legs.get(p, ())), default=0)
        exit_code = ",".join(kv.get("run_exit", "?") for kv, _ in legs.get(p, ())) or "-"
        ign = re.search(r"\bignored=(\d+)", line)
        status = {"PASS": "PASS", "FAIL": "FAIL", "TIMEOUT": "FAIL", "FLAKY": "FAIL"}.get(line.split(" ", 1)[0], "UNKNOWN")
        note = line if status == "UNKNOWN" else ""
        if (status == "PASS" and (bad or not mine)) or (status == "FAIL" and not bad):
            status, note = "UNKNOWN", f"the verdict ({line}) and the report's test list disagree"
        if unrecorded:
            status, note = "UNKNOWN", "a flaky case has no recorded retry: " + ", ".join(sorted(set(unrecorded))[:12])
        if status == "UNKNOWN" and build_failure(p):
            note += "; " + build_failure(p)
        out.append(result(p, unit, "runner", status, exit_code, secs, len(mine) - len(bad), len(bad),
                          int(ign.group(1)) if ign else 0, bad, times, note,
                          retries={f: retries[f] for f in bad if retries.get(f)}))
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
        for who in GV_WHO:
            exp += [(f"gv-set-{who}", ident, who) for ident, _ in bins]
            if any(i == PI_SHELL for i, _ in bins):
                exp.append((f"gv-lib4-{who}", PI_SHELL, who))
                exp.append((f"gv-orphan-{who}", "testkit::suites::orphan_jobs", who))
    else:
        for key in ["set-runner", "set-root", "lib4"] + [f"gv-{r}-{w}" for r in ("set", "lib4", "orphan") for w in GV_WHO]:
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
    for p in PLATFORMS:
        exp.append((p, PLATFORM_CRATES, "runner"))
    for c in CLIPPY_CRATES:
        exp.append(("clippy", c, "runner"))
    exp.append(("skipforms", "tree", "runner"))
    for who in GV_WHO:
        exp.append((f"gv-builtins-{who}", "pi-builtins", who))
    # The run-time half, which the summary job runs on the results before the summary (sc.py skip-lines).
    exp.append(("skipforms", "runtime", "runner"))
    for u in DOCS_UNITS:
        exp.append(("docs", u, "runner"))
    exp.append(("changelog", "changelogs", "runner"))
    return exp, notes


def fmt_secs(s):
    s = float(s)
    return f"{s / 60:.1f} min" if s >= 90 else f"{s:.0f} s"


# The rows whose units are shards a test moves between (ts-ca: files by sorted index; workspace:
# nextest's count partitions), where a known-failure entry may name `*` for any unit. On the other
# rows a unit is a binary or a suite, and a test's name is unique only inside it.
ANY_UNIT_ROWS = ("ts-ca", "workspace")


def known_rows(path):
    """known-failures.txt's entries as lists of fields: five, or six for a `skips: ` entry."""
    rows = []
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            if not line.strip() or line.startswith("#"):
                continue
            f = line.rstrip("\n").split("\t")
            if len(f) != (6 if len(f) > 4 and f[4].startswith("skips: ") else 5):
                sys.exit(f"known-failures.txt: not five tab-separated fields (six for `skips: `): {line!r}")
            if f[2] == "*" and f[0] not in ANY_UNIT_ROWS:
                sys.exit(f"known-failures.txt: unit `*` only on the rows {', '.join(ANY_UNIT_ROWS)}: {line!r}")
            rows.append(f)
    return rows


def read_known(path):
    """known-failures.txt's failures: (row, user, unit, test) -> reason. A unit of `*` is any unit
    of the row (ANY_UNIT_ROWS only)."""
    return {tuple(f[:4]): f[4] for f in known_rows(path) if len(f) == 5}


def read_known_skips(path):
    """known-failures.txt's known self-skips: (row, user, unit, test) -> [(the skip line's start as
    a pattern, each `{...}` any text; the reason; the start as written)]."""
    skips = {}
    for f in known_rows(path):
        if len(f) == 6:
            skips.setdefault(tuple(f[:4]), []).append((literal_pattern(f[5]), f[4][len("skips: "):], f[5]))
    return skips


def known_reason(known, row, who, unit, test):
    """The reason the known-failure list gives for a failure: its entry for the unit, else its entry
    for any unit of the row (`*`: a coding-agent shard is the files' sorted index mod 10, so a test
    moves to another shard when a file is added before it). None when the list does not name it."""
    why = known.get((row, who, unit, test))
    return why if why is not None else known.get((row, who, "*", test))


def known_skip(skips, row, who, unit, test, lines):
    """The reason the known-failure list gives for a test that skipped itself: each of its skip lines
    starts as one of the test's `skips: ` entries for this row and user (unit or `*`) says. None when
    a line matches none, or no skip line was kept."""
    entries = skips.get((row, who, unit, test), []) + skips.get((row, who, "*", test), [])
    if not entries or not lines:
        return None
    used = []
    for line in lines:
        why = next((w for p, w, _ in entries if p.match(line)), None)
        if why is None:
            return None
        if why not in used:
            used.append(why)
    return "; ".join(used)


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


# A format argument as `x`, and as a value that itself holds ": ", blanks and a comma, as a case name
# built with format! does at run time (pi-iso cow.rs: `{case}: skipped, ...`, case `{place}: ...`).
ARG_SAMPLES = ("x", "x: y, z")


def literal_sample(lit, arg="x"):
    """What a format literal prints, roughly: line continuations joined, each `{...}` argument as `arg`."""
    s = re.sub(r"\\\n\s*", "", lit).replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    s = s.replace("{{", "\0").replace("}}", "\1")
    s = re.sub(r"\{[^{}]*\}", lambda _: arg, s)
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


def read_not_markers(path):
    """skip-forms-not-markers.txt: [path, start of the printed text with arguments as x, reason]."""
    out = []
    for line in open(path, encoding="utf-8"):
        if line.strip() and not line.startswith("#"):
            f = line.rstrip("\n").split("\t")
            if len(f) != 3:
                sys.exit(f"{path}: not three tab-separated fields: {line!r}")
            out.append(f)
    return out


def skip_forms(tree, exceptions_path, partial_path=PARTIAL_SKIPS):
    """Every literal under <tree>/crates that says skip, not run, gave up or checked nothing must be
    read by SKIP_MARKER, with its arguments as each of ARG_SAMPLES, or be named in the exceptions file
    (`<path>\\t<start of the literal, arguments as x>\\t<reason>`) as not a skip marker. A literal of
    the partial-skip list must still be printed somewhere. Returns (unread literals, exceptions and
    partial-skip entries that match nothing, the number of .rs files read)."""
    exc = [[e[0], e[1], False] for e in read_not_markers(exceptions_path)]
    partial = [(e[0], e[1]) for e in read_partial_skips(partial_path)]
    partial_lits = {lit for _, lit in partial}
    printed_lits = set()
    unread, files_read = [], 0
    for dp, dirs, files in os.walk(os.path.join(tree, "crates")):
        dirs[:] = sorted(d for d in dirs if d != "target")
        for f in sorted(files):
            if not f.endswith(".rs"):
                continue
            files_read += 1
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, tree)
            text = open(p, encoding="utf-8", errors="replace").read()
            for off, lit in rust_literals(text):
                if lit in partial_lits and printed(text, off):
                    printed_lits.add(lit)
                samples = [literal_sample(lit, a) for a in ARG_SAMPLES]
                bad = [s for s in samples if SKIP_WORD.search(s) and not SKIP_MARKER.search(s)]
                if not bad or not printed(text, off):
                    continue
                hit = [e for e in exc if e[0] == rel and samples[0].startswith(e[1])]
                for e in hit:
                    e[2] = True
                if not hit:
                    unread.append(f"{rel}:{text.count(chr(10), 0, off) + 1}: {bad[0][:160]!r}")
    stale = [f"{e[0]}: {e[1]!r}" for e in exc if not e[2]]
    stale += [f"partial-skips.txt, {test}: {lit!r}" for test, lit in partial if lit not in printed_lits]
    return unread, stale, files_read


def cmd_skip_forms(tree, exceptions_path):
    unread, stale, files_read = skip_forms(tree, exceptions_path)
    fails = [f"a skip print the summary does not read: {u}" for u in unread]
    fails += [f"an entry that names no printed literal of the tree any more: {s}" for s in stale]
    if fails:
        status, note = "FAIL", ""
    elif not files_read:
        status, note = "UNKNOWN", f"no .rs file under {tree}/crates: nothing was scanned"
    else:
        status, note = "PASS", f"every skip print of the {files_read} .rs files is read or named as not a marker"
    return result("skipforms", "tree", "runner", status, 0, 0, int(status == "PASS"), len(fails), failures=fails, note=note)


def passing_outputs(results_dir, unreadable):
    """(report, test, output) of each test that passed in a results directory: the passing cases of
    each JUnit report (nextest, bun) and the `ok` events of each libtest log (the pi-shell set).
    A report that does not parse is added to `unreadable`."""
    for dp, dirs, files in os.walk(results_dir):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(dp, f)
            if f.endswith(".junit.xml"):
                try:
                    cases = list(junit_cases(p))
                except ET.ParseError:
                    unreadable.append(os.path.relpath(p, results_dir))
                    continue
                for name, kind, _, out, _ in cases:
                    if kind == "ok":
                        yield p, name, out
            elif f.endswith(".log"):
                for line in open(p, encoding="utf-8", errors="replace"):
                    ev = libtest_event(line)
                    if ev and ev.get("type") == "test" and ev.get("event") == "ok":
                        yield p, ev.get("name", "?"), ev.get("stdout") or ""


def skip_lines(results_dir, exceptions_path):
    """The run-time half of skip-forms: each line a passing test printed that SKIP_WORD selects must be
    read by SKIP_MARKER or match an entry of the exceptions file (its text from the line's start,
    each `x` any text). Returns ({unread line: [report and test, ...]}, tests read, unreadable reports)."""
    pats = [re.compile(r"[ \t]*" + ".*?".join(re.escape(p) for p in e[1].split("x")))
            for e in read_not_markers(exceptions_path)]
    unread, tests, unreadable = {}, 0, []
    for p, name, out in passing_outputs(results_dir, unreadable):
        tests += 1
        for line in out.splitlines():
            if SKIP_WORD.search(line) and not SKIP_MARKER.search(line) and not any(r.match(line) for r in pats):
                unread.setdefault(line.strip()[:200], []).append(f"{os.path.relpath(p, results_dir)} {name}")
    return unread, tests, unreadable


def cmd_skip_lines(results_dir, exceptions_path):
    unread, tests, unreadable = skip_lines(results_dir, exceptions_path)
    fails = [f"a skip line the summary does not read: {line!r}, printed {len(w)} time(s), first by {w[0]}"
             for line, w in sorted(unread.items())]
    if fails:
        status, note = "FAIL", ""
    elif not tests:
        status, note = "UNKNOWN", f"no passing test's output under {results_dir}: nothing was read"
    elif unreadable:
        status, note = "UNKNOWN", f"{len(unreadable)} JUnit report(s) do not parse: " + ", ".join(unreadable[:5])
    else:
        status, note = "PASS", f"every skip line of {tests} passing tests is read or named as not a marker"
    return result("skipforms", "runtime", "runner", status, 0, 0, int(status == "PASS"), len(fails), failures=fails, note=note)


def flaky_failed(result_path, known_path):
    """The failed tests of one result that the known-failure list names `flaky: ` for its row,
    user and unit (or `*`): the job runs the whole unit again, at most twice, while one is left."""
    r = json.load(open(result_path, encoding="utf-8"))
    known = read_known(known_path)
    return [f for f in r["failures"]
            if (known_reason(known, r["row"], r["who"], r["unit"], f) or "").startswith("flaky: ")]


def record_retry(result_path, test, report, shape, scope="whole-unit"):
    """Reads one retry and adds to the result's `retries` for `test`: the outcome, how many of the
    unit's tests the retry ran, `shape` (the script's words for how it ran) and `scope`. REPORT is a
    libtest log or a JUnit report (nextest, bun). The outcome is `pass`, `partial`, `skip` (it passed
    after a skip marker, or was skipped) or `fail` (it failed, did not end, or is not in the report).
    With scope `whole-unit`, the retry is the unit's command again (the same binary or filter,
    threads and user), and a pass in it that did not run every test the unit ran is `partial`: a
    test alone or at another size is not the same race. With scope `own-process`, the runner gives
    each test a process of its own (nextest), so its retry alone is that same process again, as in
    nextest's own retries; a pass then counts however many tests ran. Returns the outcome."""
    if scope not in ("whole-unit", "own-process"):
        sys.exit(f"retried: scope {scope!r} is neither whole-unit nor own-process")
    outcome, ran = "fail", set()
    if report.endswith(".xml"):
        try:
            for name, kind, _, out, _ in junit_cases(report):
                if kind != "skipped":
                    ran.add(name)
                if name == test:
                    outcome = "fail" if kind == "failed" else "skip" if kind == "skipped" else passed_attempt(out)
        except (OSError, ET.ParseError):
            pass
    else:
        try:
            lines = open(report, encoding="utf-8", errors="replace").read().splitlines()
        except OSError:
            lines = []
        for line in lines:
            ev = libtest_event(line)
            if ev and ev.get("type") == "test" and ev.get("event") in ("ok", "failed"):
                ran.add(ev.get("name"))
                if ev.get("name") == test:
                    outcome = "fail" if ev["event"] == "failed" else passed_attempt(ev.get("stdout"))
    r = json.load(open(result_path, encoding="utf-8"))
    unit = {n for n, _ in r["tests"]} | set(r["failures"])
    of = len(unit)
    n = len(ran & unit)
    if outcome == "pass" and n < of and scope == "whole-unit":
        outcome = "partial"
    r.setdefault("retries", {}).setdefault(test, []).append(
        {"outcome": outcome, "ran": n, "of": of, "shape": shape, "scope": scope})
    json.dump(r, open(result_path, "w", encoding="utf-8"))
    return outcome


def cmd_summary(results_dir, build_dir, known_path=None):
    known = read_known(known_path)
    skips = read_known_skips(known_path)

    def failure_reason(r, row, f):
        """(the reason, how the summary shows it) for failure f of result r; no reason when the
        failure is NEW. A flaky entry gives its reason only when the test passed in a retry of the
        shape it failed in, in the same job: the whole unit again (set.sh, nextest.sh, ts.sh), or,
        where each test has a process of its own (nextest), that process again (record_retry's
        scope): a retry of a test alone from a shared process does not show the race of the full run."""
        why = known_reason(known, row, r["who"], r["unit"], f)
        tries = r.get("retries", {}).get(f, [])
        outcomes = [t["outcome"] for t in tries]

        def told(t):
            what = "in its own process again" if t["scope"] == "own-process" else "a rerun of the unit"
            return f"{what}: {t['ran']} of {t['of']} tests, {t['shape']}"

        def first(t):
            return f"; first failure: {t['first_failure']}" if t.get("first_failure") else ""

        if why is None:
            if "pass" in outcomes:
                t = tries[outcomes.index("pass")]
                return None, (f"**NEW** (flaky, and not on the known-failure list: it passed on retry "
                              f"{outcomes.index('pass') + 1} of {len(tries)}, {told(t)}{first(t)})")
            return None, "**NEW**"
        if not why.startswith("flaky: "):
            return why, f"KNOWN ({why})"
        if "pass" in outcomes:
            t = tries[outcomes.index("pass")]
            return why, f"KNOWN ({why}; it passed on retry {outcomes.index('pass') + 1} of {len(tries)}, {told(t)}{first(t)})"
        if not tries:
            return None, f"**NEW** (listed as `{why}`, but no retry of its unit ran)"
        seen = "; ".join(f"{t['outcome']} ({told(t)})" for t in tries)
        return None, f"**NEW** (listed as `{why}`, but no retry of its shape passed it: {seen}{first(tries[0])})"

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
                 "runner did not end normally (libtest 0/101, nextest 0/100, bun 0/1 with its summary line, clippy "
                 "0/101), when a passing test printed a skip marker and passed as no other user (even when every "
                 "failure of the unit is known), when a clean clippy crate's planted control was not caught, when the "
                 "platform checks gave its platform no verdict, or when no job (or more than one) reported it; its "
                 "row is then UNKNOWN too. A test whose only skip lines are sub-cases the partial-skip list names for "
                 "it, with that entry's witness line in its output, passes and is listed as partial. A self-skip the "
                 "known-failure list names (`skips: `, for that row and user) reads KNOWN; a failure with a `flaky: ` "
                 "entry reads KNOWN only when a retry of the test in the same job passed.")
    lines.append("")
    lines.append("| Row | Verdict | Units: pass / known / fail / UNKNOWN | Tests: passed / failed / ignored / skipped themselves | Longest unit |")
    lines.append("|---|---|---|---|---|")
    all_ok = True
    details = []
    verdicts = {}
    for title, key in ROWS:
        units = [e for e in exp if e[0] == key]
        rs = []
        for e in units:
            r = got.get(e)
            unlisted = []
            if r is None:
                r = result(key, e[1], e[2], "UNKNOWN", "-", 0, note="no result: its job reported nothing (it failed before its upload, did not run, or its upload was planted away)")
            elif e in dup:
                r = dict(r, status="UNKNOWN", note="two jobs reported this unit")
            else:
                # A self-skip is covered when the same test passed as the other user on the same runtime, and known when
                # each of its skip lines is a `skips: ` entry of this row and user.
                others = [w for w in (GV_WHO if runtime(key) == "gvisor" else SET_WHO) if w != r["who"]]
                open_ = [s for s in r.get("self_skipped", []) if not any(s in passed_as.get((runtime(key), r["unit"], w), ()) for w in others)]
                listed = {}
                for s in open_:
                    why = known_skip(skips, key, r["who"], r["unit"], s, r.get("skip_lines", {}).get(s))
                    if why is not None:
                        listed[s] = why
                unlisted = [s for s in open_ if s not in listed]
                r = dict(r, known_skips=listed)
                if r.get("skip_only") and r["status"] == "UNKNOWN":
                    if unlisted:
                        r["note"] = f"{len(unlisted)} test(s) skipped themselves here and passed as no other user: " + ", ".join(unlisted[:12])
                    elif listed:
                        r.update(status="KNOWN", note=f"{len(listed)} test(s) skipped themselves as the known-failure list says")
                    else:
                        r.update(status="PASS", note=f"{len(r['self_skipped'])} test(s) skipped themselves as {r['who']} and passed as {', '.join(others)}")
            # Known failures make a unit KNOWN only when nothing else is open: a test that skipped
            # itself here, passed as no other user and is not a known skip makes it UNKNOWN.
            if r["status"] == "FAIL" and r["failures"] and all(failure_reason(r, key, f)[0] for f in r["failures"]):
                if unlisted:
                    r = dict(r, status="UNKNOWN", note=f"every failure is known, but {len(unlisted)} test(s) skipped themselves here "
                                                       "and passed as no other user: " + ", ".join(unlisted[:12]))
                else:
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
        verdicts[key] = (verdict, rs)
        if verdict not in ("PASS", "KNOWN"):
            all_ok = False
        for r in rs:
            if r["status"] == "UNKNOWN":
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNKNOWN: {r['note']}")
            for f in r["failures"]:
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): FAILED `{f}`: {failure_reason(r, key, f)[1]}")
            for f in r.get("baseline_fell", []):
                details.append(f"- **{title}** `{r['unit']}`: fewer here than in the clippy baseline (a change of the baseline, not a failure): {f}")
            for f in r.get("self_skipped", []):
                why = r.get("known_skips", {}).get(f)
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): SKIPPED ITSELF `{f}`" + (f": KNOWN ({why})" if why else ""))
            for f, n, why in r.get("partial", []):
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): `{f}`: partial: {n} sub-cases skipped ({why})")
    # SC_RUST_TESTS is "rust_test=<result> rust_test_macos=<result>". Absent: a caller from before
    # those jobs, and no Rust rows. success passes and failure fails; a job with no result, or with
    # any other (cancelled, skipped), is UNKNOWN.
    rust = os.environ.get("SC_RUST_TESTS")
    if rust is not None:
        conclusions = dict(p.split("=", 1) for p in rust.split() if "=" in p)
        for title, job in RUST_JOBS:
            conclusion = conclusions.get(job, "")
            verdict = {"success": "PASS", "failure": "FAIL"}.get(conclusion, "UNKNOWN")
            lines.append(f"| {title} | **{verdict}** | - | - | - |")
            if verdict != "PASS":
                all_ok = False
                details.append(f"- **{title}**: {verdict}: the job's conclusion is [{conclusion or 'none'}]; "
                               "its failing tests are in that job's annotations and log")
    # A planted run (the dispatch input `plant`) says so first, and whether the control caught its plant.
    plant = os.environ.get("SC_PLANT", "")
    if plant:
        path, text, needle = PLANTS[plant]
        v, rs = verdicts.get(plant, ("absent", []))
        # Each unit of the row must name the plant (docs: the public and the private build).
        missed = [r["unit"] for r in rs if r["status"] != "FAIL" or not any(needle in f for f in r["failures"])]
        each = ", ".join(f"`{r['unit']}`" for r in rs)
        all_ok = False
        lines[2:2] = [f"**Planted run (`plant={plant}`)**: the {plant} job added `` {text} `` to `{path}` before it ran. "
                      + (f"The control caught it: the row reads FAIL, and each of its units ({each}) names `{needle}`."
                         if rs and not missed else
                         f"**THE CONTROL FAILED**: the row reads {v}, and these units do not read FAIL naming `{needle}`: "
                         + (", ".join(f"`{u}`" for u in missed) or "the row has no unit") + "."), ""]
    lines.append("")
    # A known entry whose test passed, or that its unit no longer has, is listed for removal, and the
    # summary fails until it is removed: the list only shrinks. An entry whose unit did not report is
    # neither: it stays, and so does a `*` entry while any unit of its row did not report. A flaky
    # entry (its reason starts `flaky: `) is not listed when its test passed. A `skips: ` entry is
    # listed when its test ran without skipping itself, or printed no skip line that starts so.
    def entry_results(row, who, unit):
        if unit == "*":
            return [got.get(e) for e in exp if e[0] == row and e[2] == who], "its row"
        return [got.get((row, unit, who))], "its unit"

    stale = []
    for (row, who, unit, test), why in sorted(known.items()):
        rs, where = entry_results(row, who, unit)
        if not rs or any(r is None or r["status"] == "UNKNOWN" or test in r["failures"] for r in rs):
            continue
        names = {n for r in rs for n, _ in r["tests"]}
        if test in names and why.startswith("flaky: "):
            continue
        stale.append(f"- `{unit}` ({who}) `{test}`: " + ("passed" if test in names else f"no longer in {where}")
                     + f" (listed for: {why})")
    for (row, who, unit, test), entries in sorted(skips.items()):
        rs, where = entry_results(row, who, unit)
        if not rs or any(r is None or (r["status"] == "UNKNOWN" and not r.get("skip_only")) or test in r["failures"]
                         for r in rs):
            continue
        names = {n for r in rs for n, _ in r["tests"]}
        printed = [line for r in rs for line in r.get("skip_lines", {}).get(test, [])]
        for pattern, why, start in entries:
            if test not in names:
                gone = f"no longer in {where}"
            elif not printed:
                gone = "ran without skipping itself"
            elif not any(pattern.match(line) for line in printed):
                gone = "printed no skip line that starts so"
            else:
                continue
            stale.append(f"- `{unit}` ({who}) `{test}`: {gone} (listed: skips `{start}`: {why})")
    if stale:
        all_ok = False
        lines.append("### Known-failure entries to remove (their test did not fail or skip itself so)")
        lines.append("")
        lines.extend(stale)
        lines.append("")
    if details:
        lines.append("### Each failing test, each UNKNOWN and each partial pass")
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
    r = lt([s0, a_s, a_ok, nr_s, nr_ok, nr_end], 0, nr_line)
    check("a NOT-RUN line is kept as that test's skip line", r["skip_lines"].get(busy_t), [nr_line.strip()])
    # A child that shares the binary's stdout left `test x ... ` unfinished, and the next event came
    # after it on the same line (run 45287678343, pi-shell lib): the event still counts.
    p = os.path.join(d, "glued.log")
    with open(p, "w") as f:
        f.write(json.dumps(s0) + "\n" + json.dumps(a_s) + "\n" + json.dumps(b_s) + "\nrunning 1 test\nTerminated\n"
                "test shell::tests::process_control::kill_builtin_signals_only_the_shell_at_its_own_pid ... "
                '{ "type": "test", "name": "a", "event": "ok", "exec_time": 0.013708871 }\nok\n'
                + json.dumps({"type": "test", "event": "ok", "name": "b", "exec_time": 0.1}) + "\n"
                + json.dumps({"type": "suite", "event": "ok", "passed": 2, "failed": 0}) + "\n")
    r = parse_libtest(p, "0", 1, "set-runner", "x", "runner")
    check("libtest event after a child's unfinished line", (r["status"], r["passed"]), ("PASS", 2))

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
    # nextest.sh's two passes: one report of both, and none when a pass left no report.
    jm = os.path.join(d, "merged.xml")
    r = parse_junit(jm, "100", 1, "b", "u", "r", (0,), (100,)) if junit_merge(jm, [ju, js]) == 4 else {}
    check("JUnit merge of two passes", (r.get("failures"), r.get("ignored"), r.get("self_skipped")),
          (["pi-builtins::t2"], 1, ["p::t1"]))
    try:
        junit_merge(jm, [ju, os.path.join(d, "no-pass2.xml")])
    except OSError:
        pass
    check("JUnit merge with a missing pass writes nothing", os.path.exists(jm), False)
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
                       ("cp --reflink=always: the host half is skipped: no reflink", True),
                       ("running 1 test", False), ("test result: ok. 1 passed", False)):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line + "\n")), want)
    # The tree's real skip lines at run time (run 45272140047 on 509a2d77): pi-iso cow.rs:928, whose
    # case name holds ": ", and pi-shell zsh_mod_zftp.rs:352's give-up; and lines that are no marker.
    cow = [f"/dev/shm: {n}, the clone into the emptied file{w} failing: skipped, this filesystem does not clone"
           for n in ("3 bytes onto 5", "4101 bytes onto 8192") for w in ("", " and the clone back", " and both ways back")]
    zftp = "no free /etc/services port: nothing to test"
    for line in cow + [zftp, "a: b: c: d: e: f: g: h: skipped, eight prefixes"]:
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line + "\n")), True)
    for line in ("cp --reflink=always: the host half is skipped: names do not fold in /mnt/sc/tmp-root/.tmp5Dxs0i",
                 "mv: the host half is skipped: names do not fold in /mnt/sc/tmp-runner/.tmpsbHh4I",
                 "this system carries no TCP urgent data: the mark is not checked", "x: the rows are skipped"):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line + "\n")), True)
    for line in ("the temporary directory: FICLONE says yes", "/dev/shm: FICLONE says Operation not supported (os error 95)",
                 "a: b: c: d: e: f: g: h: i: skipped, nine prefixes", "x: the test passed, it skipped nothing",
                 "x: the run was not skipped"):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line + "\n")), False)
    # The partial-skip list: cow.rs's test passes as partial only with its witness and only those lines.
    from xml.sax.saxutils import escape
    pf = os.path.join(d, "partial.txt")
    open(pf, "w").write("p::cow\t{case}: skipped, this filesystem does not clone\t^the temporary directory: FICLONE says yes$\ttmpfs rows\n"
                        "cow\t{case}: skipped, this filesystem does not clone\t^the temporary directory: FICLONE says yes$\ttmpfs rows\n")
    witness = "the temporary directory: FICLONE says yes\n/dev/shm: FICLONE says Operation not supported (os error 95)\n"
    cow_err = witness + "\n".join(cow) + "\n"

    def jx(name, err):
        p = os.path.join(d, "cow.xml")
        with open(p, "w") as f:
            f.write(f'<testsuites><testsuite name="p"><testcase classname="p" name="{name}" time="1"><system-out>\n'
                    f'running 1 test\n\n</system-out><system-err>{escape(err)}</system-err></testcase></testsuite></testsuites>')
        r = parse_junit(p, "0", 1, "workspace", "u", "r", (0,), (100,), pf)
        return r["status"], r["self_skipped"], r["partial"]

    def lx(name, out):
        p = os.path.join(d, "cow.log")
        with open(p, "w") as f:
            for e in (s0, {"type": "test", "event": "started", "name": name},
                      {"type": "test", "event": "ok", "name": name, "exec_time": 0.1, "stdout": out}, end_ok):
                f.write(json.dumps(e) + "\n")
        r = parse_libtest(p, "0", 1, "set-runner", "u", "runner", pf)
        return r["status"], r["self_skipped"], r["partial"]

    check("JUnit: cow.rs's lines with the witness", jx("cow", cow_err), ("PASS", [], [["p::cow", 6, "tmpfs rows"]]))
    check("JUnit: cow.rs's lines without the witness", jx("cow", "\n".join(cow) + "\n"), ("UNKNOWN", ["p::cow"], []))
    check("JUnit: cow.rs's lines and one more skip line", jx("cow", cow_err + "skipped: no FIFO\n"), ("UNKNOWN", ["p::cow"], []))
    check("JUnit: cow.rs's lines in a test the list does not name", jx("other", cow_err), ("UNKNOWN", ["p::other"], []))
    check("JUnit: zftp's give-up", jx("zftp", zftp + "\n"), ("UNKNOWN", ["p::zftp"], []))
    check("libtest: cow.rs's lines with the witness", lx("cow", cow_err), ("PASS", [], [["cow", 6, "tmpfs rows"]]))
    check("libtest: cow.rs's lines without the witness", lx("cow", "\n".join(cow) + "\n"), ("UNKNOWN", ["cow"], []))
    check("libtest: zftp's give-up", lx("zftp", zftp + "\n"), ("UNKNOWN", ["zftp"], []))

    check("assign is longest-first", assign(["a", "b", "c", "d"], {"a": 100, "b": 60, "c": 50, "d": 10}, 2),
          {"a": 1, "b": 2, "c": 2, "d": 1})
    wf = os.path.join(d, "w.txt")
    with open(wf, "w") as f:
        f.write("# c\n10 x\n600 x root\n")
    check("weights per user", (read_weights(wf, "runner")["x"], read_weights(wf, "root")["x"]), (10.0, 600.0))

    # clippy, by the cut's rule against the checked-in baseline: a crate's own findings beyond the
    # baseline fail it (a new key, or a key with more places), findings within it read KNOWN, a key
    # with fewer places is listed for removal; a clean or known result needs its control caught.
    def write(name, text):
        p = os.path.join(d, name)
        with open(p, "w") as f:
            f.write(text)
        return p

    def diag(f, line, code, msg, level="error"):
        return json.dumps({"reason": "compiler-message", "message": {"message": msg, "level": level, "code": {"code": code},
                           "spans": [{"file_name": f, "line_start": line, "column_start": 5, "is_primary": True}]}}) + "\n"

    hashes = "unnecessary hashes around raw string literal"
    own_a = diag("crates/pi-vfs/src/a.rs", 3, "clippy::needless_raw_string_hashes", hashes)
    own_b = diag("crates/pi-vfs/src/a.rs", 9, "clippy::needless_raw_string_hashes", hashes)
    cast = diag("crates/pi-vfs/src/b.rs", 86, "function_casts_as_integer", "direct cast of function item into an integer")
    dep_f = diag("crates/pi-shell/src/b.rs", 1, "unused_variables", "unused variable: `x`", "warning")
    # The same place twice (a module two targets build) is one finding.
    again = own_a
    noise = '    Checking pi-vfs v0.1.0\n{"reason":"compiler-artifact"}\n' + json.dumps(
        {"reason": "compiler-message", "message": {"message": "aborting due to 2 previous errors", "code": None, "spans": []}}) + "\n"
    ctl = write("ctl.log", diag("crates/pi-vfs/src/lib.rs", 90, "unused_imports",
                                f"unused import: `std::collections::BTreeMap as {CLIPPY_CONTROL}`"))
    noctl = write("noctl.log", "    Checking pi-vfs v0.1.0\n")
    bl = write("baseline.txt", "# a comment\n"
               f"pi-vfs\tcrates/pi-vfs/src/a.rs\tclippy::needless_raw_string_hashes\t1\t{hashes}\n"
               f"pi-vfs\tcrates/pi-vfs/src/c.rs\tclippy::doc_markdown\t2\titem in documentation is missing backticks\n"
               f"pi-shell\tcrates/pi-shell/src/b.rs\tunused_variables\t1\tunused variable: `x`\n")

    def cl(text, ex, c=ctl, base=bl):
        return parse_clippy(write("c.log", text), str(ex), 1, "pi-vfs", "crates/pi-vfs", c, "crates/pi-vfs/src/lib.rs", base)

    r = cl(noise + dep_f + own_a + again + cast, 101)
    check("clippy: a key the baseline lacks fails, named by place and lint",
          (r["status"], r["failures"], r["baseline_fell"]),
          ("FAIL", ["crates/pi-vfs/src/b.rs:86: function_casts_as_integer: direct cast of function item into an integer"],
           [f"crates/pi-vfs/src/c.rs: clippy::doc_markdown: item in documentation is missing backticks (0 here, 2 in the baseline): delete its line"]))
    r = cl(own_a + own_b, 101)
    check("clippy: a key with more places than the baseline fails, each place named",
          (r["status"], r["failures"]),
          ("FAIL", [f"crates/pi-vfs/src/a.rs:3: clippy::needless_raw_string_hashes: {hashes} (2 here, 1 in the baseline)",
                    f"crates/pi-vfs/src/a.rs:9: clippy::needless_raw_string_hashes: {hashes} (2 here, 1 in the baseline)"]))
    r = cl(dep_f + own_a, 101)
    check("clippy: findings within the baseline read KNOWN, a fallen key listed for removal",
          (r["status"], r["failed"], len(r["baseline_fell"]), "planted control read" in r["note"]), ("KNOWN", 0, 1, True))
    check("clippy: clean with its control caught", cl(dep_f, 0)["status"], "PASS")
    check("clippy: findings within the baseline, control not caught", cl(own_a, 101, noctl)["status"], "UNKNOWN")
    check("clippy: clean with no control log", cl("", 0, os.path.join(d, "absent"))["status"], "UNKNOWN")
    check("clippy: a new finding fails even with the control not caught", cl(cast, 101, noctl)["status"], "FAIL")
    check("clippy: killed", cl(own_a, 137)["status"], "UNKNOWN")
    check("clippy: ended by its bound", "time bound" in cl("", 124)["note"], True)
    check("clippy: 101 with no finding of its own", cl(dep_f + "error: failed to run custom build command for `x`\n", 101)["status"], "UNKNOWN")
    check("clippy: 0 with a finding", cl(own_a, 0)["status"], "UNKNOWN")
    # A missing log is UNKNOWN by itself, at exit 0 as at 101 (at 101 another branch also gives UNKNOWN).
    for ex in ("0", "101"):
        r = parse_clippy(os.path.join(d, "absent"), ex, 1, "pi-vfs", "crates/pi-vfs", ctl, "crates/pi-vfs/src/lib.rs", bl)
        check(f"clippy: no log, exit {ex}", (r["status"], r["note"]), ("UNKNOWN", "no log"))
    check("clippy: a crate the tree lacks", parse_clippy(ctl, "0", 1, "pi-x", "-", ctl, "-", bl)["status"], "UNKNOWN")
    check("clippy: the short format names no lint code, so it reads nothing",
          clippy_diagnostics(write("short.log", "crates/pi-vfs/src/a.rs:3:5: error: unnecessary hashes around raw string literal\n")), ({}, []))
    # A compile error with no code (rustc gives a syntax error code=null) is a finding no baseline
    # line holds: its target was never linted, so the crate fails beside findings within the baseline.
    broken = json.dumps({"reason": "compiler-message", "message": {
        "message": "expected expression, found `;`", "level": "error", "code": None,
        "spans": [{"file_name": "crates/pi-vfs/tests/broken.rs", "line_start": 3, "column_start": 13, "is_primary": True}]}}) + "\n"
    uncoded = "crates/pi-vfs/tests/broken.rs:3: error: expected expression, found `;`"
    r = cl(noise + own_a + broken, 101)
    check("clippy: a compile error with no code fails beside findings within the baseline",
          (r["status"], r["failures"]), ("FAIL", [uncoded]))
    in_base = write("baseline-error.txt", f"pi-vfs\tcrates/pi-vfs/tests/broken.rs\terror\t1\texpected expression, found `;`\n")
    check("clippy: a compile error with no code fails even when a baseline line names it",
          cl(broken, 101, base=in_base)["failures"], [uncoded])
    warned = broken.replace('"level": "error"', '"level": "warning"')
    check("clippy: a warning with no code is no finding", clippy_diagnostics(write("w.log", warned)), ({}, []))
    # A line that looks like a cargo message and does not parse hides its finding: UNKNOWN, named.
    cut = noise + own_a + broken[:60] + "\n"
    r = cl(cut, 101)
    check("clippy: a cargo message line that does not parse", (r["status"], r["note"]),
          ("UNKNOWN", "log line(s) 5 look like cargo messages and do not parse, so their findings are unread"))
    # A fallen count names the line that replaces it.
    r = cl(own_a, 101, base=write("baseline-3.txt", f"pi-vfs\tcrates/pi-vfs/src/a.rs\tclippy::needless_raw_string_hashes\t3\t{hashes}\n"))
    check("clippy: a fallen count names its replacement line", (r["status"], r["baseline_fell"]),
          ("KNOWN", [f"crates/pi-vfs/src/a.rs: clippy::needless_raw_string_hashes: {hashes} (1 here, 3 in the baseline): its line becomes "
                     f"`pi-vfs\tcrates/pi-vfs/src/a.rs\tclippy::needless_raw_string_hashes\t1\t{hashes}` (tab-separated)"]))
    # The baseline lines a log gives (the regeneration step), read back as the same baseline.
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        clippy_baseline_lines(write("c.log", noise + dep_f + own_a + own_b + again + cast + broken), "pi-vfs", "crates/pi-vfs")
    check("clippy: a regenerated baseline names a compile error in a comment, not a line",
          "# pi-vfs: a compile error, not a baseline line: crates/pi-vfs/tests/broken.rs:3: expected expression, found `;`" in buf.getvalue(), True)
    regen = write("regen.txt", buf.getvalue())
    check("clippy: regenerated baseline lines", read_clippy_baseline(regen),
          {("pi-vfs", "crates/pi-vfs/src/a.rs", "clippy::needless_raw_string_hashes", hashes): 2,
           ("pi-vfs", "crates/pi-vfs/src/b.rs", "function_casts_as_integer", "direct cast of function item into an integer"): 1})
    check("clippy: against its own regenerated baseline, a log reads KNOWN",
          cl(noise + own_a + own_b + cast, 101, base=regen)["status"], "KNOWN")

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
    paths = {}
    for i, (row, unit, who) in enumerate(exp):
        paths[(row, unit, who)] = os.path.join(res, f"{i}.json")
        if (row, unit, who) in silent:
            continue
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
    check("summary names the silent clippy crate UNKNOWN", "`pi-vfs` (runner): UNKNOWN: no result" in out, True)
    check("summary row of the silent clippy crate",
          "| clippy --tests -D warnings, per crate (failed: findings beyond clippy-baseline.txt) | **UNKNOWN** | 5 / 0 / 0 / 1 |" in out, True)
    check("summary row of the silent platform", "| Windows: pi-shell, platform checks | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("summary row of a platform that reported", "| macOS: pi-shell, platform checks | **PASS** | 1 / 0 / 0 / 0 |" in out, True)
    # And the same with every unit present passes.
    for row, unit, who in sorted(silent):
        # The root unit's file is silent.json: a later case replaces it under that name.
        name = "silent.json" if row == "set-root" else f"silent-{row}.json"
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1), open(os.path.join(res, name), "w"))
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
    # A partial pass is a pass, listed with its reason.
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if (r["row"], r["unit"], r["who"]) == ("workspace", "part 1/2", "runner"):
            os.remove(os.path.join(res, f))
    json.dump(result("workspace", "part 1/2", "runner", "PASS", 0, 1, passed=1, tests=[("p::cow", 1.0)],
                     partial=[("p::cow", 6, "tmpfs rows")]), open(os.path.join(res, "ws.json"), "w"))
    rc, out = summary()
    check("a partial pass in the summary", ("| workspace, nextest (not pi-shell, pi-builtins) | **PASS** |" in out,
          "`part 1/2` (runner): `p::cow`: partial: 6 sub-cases skipped (tmpfs rows)" in out, rc), (True, True, 0))
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
    # Known failures do not hide a self-skip: a unit whose failures are all known and in which a test
    # skipped itself and passed as no other user is UNKNOWN (the zsh_zcompile probe on gVisor's root
    # set); with the test passed as root it is KNOWN.
    zle_runner = json.load(open(os.path.join(res, "zle-runner.json")))
    json.dump(dict(zle_runner, self_skipped=["s"], tests=zle_runner["tests"] + [["s", 1.0]]),
              open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("known failures and an open self-skip", ("| pi-shell set (runner) | **UNKNOWN** |" in out,
          "every failure is known, but 1 test(s) skipped themselves here" in out, rc), (True, True, 1))
    json.dump(result("set-root", "pi-shell::zle_pty", "root", "PASS", 0, 1, passed=1, tests=[("s", 1.0)]),
              open(os.path.join(res, "silent.json"), "w"))
    rc, out = summary()
    check("known failures and a self-skip root covered", ("| pi-shell set (runner) | **KNOWN** |" in out, rc), (True, 0))
    json.dump(zle_runner, open(os.path.join(res, "zle-runner.json"), "w"))
    open(known_file, "a").write("set-runner\trunner\tpi-shell::zle_pty\tp\tfixed since\n")
    rc, out = summary()
    check("a listed test that passed is to be removed", ("`p`: passed (listed for: fixed since)" in out, rc), (True, 1))
    # The Rust tests' rows, from their two jobs' conclusions: success passes, failure fails, and a
    # missing, cancelled or skipped result is UNKNOWN. Without SC_RUST_TESTS there is no Rust row.
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    rc, out = summary()
    check("no Rust rows without SC_RUST_TESTS", ("| Rust tests" in out, rc), (False, 0))
    os.environ["SC_RUST_TESTS"] = "rust_test=success rust_test_macos=success"
    rc, out = summary()
    check("both Rust jobs passed", (f"| {RUST_JOBS[0][0]} | **PASS** |" in out, f"| {RUST_JOBS[1][0]} | **PASS** |" in out, rc), (True, True, 0))
    os.environ["SC_RUST_TESTS"] = "rust_test=failure rust_test_macos=cancelled"
    rc, out = summary()
    check("a failed and a cancelled Rust job", (f"| {RUST_JOBS[0][0]} | **FAIL** |" in out, f"| {RUST_JOBS[1][0]} | **UNKNOWN** |" in out, rc), (True, True, 1))
    os.environ["SC_RUST_TESTS"] = "rust_test= rust_test_macos=skipped"
    rc, out = summary()
    check("a Rust job with no result", (f"| {RUST_JOBS[0][0]} | **UNKNOWN** |" in out, "conclusion is [none]" in out, rc), (True, True, 1))
    del os.environ["SC_RUST_TESTS"]
    # A flaky entry (its reason starts `flaky: `): its failure reads KNOWN only when the test passed in
    # a retry of its whole unit in the same job (the unit's command again: the same binary or filter,
    # threads and user), and NEW when no retry ran, every retry failed, or it passed only in a retry
    # that did not run the whole unit (CiReview at 55a3d02c and at ee06226f: a race that fails at 4
    # threads and passes alone read KNOWN). It is not listed for removal when its test passed, and is
    # when its test is no longer in its unit.
    def rt(outcome, ran=2, of=2, shape="the binary again, --test-threads=4", scope="whole-unit"):
        return {"outcome": outcome, "ran": ran, "of": of, "shape": shape, "scope": scope}

    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tflaky: a race\n"
                                "set-runner\trunner\tpi-shell::zle_pty\tp\tflaky: a race\n")
    rc, out = summary()
    check("a flaky failure with no retry", ("FAILED `k`: **NEW** (listed as `flaky: a race`, but no retry of its unit ran)" in out, rc),
          (True, 1))
    json.dump(dict(zle_runner, retries={"k": [rt("fail"), rt("pass")]}), open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("a flaky failure that passed on a retry of the whole unit",
          ("FAILED `k`: KNOWN (flaky: a race; it passed on retry 2 of 2, a rerun of the unit: 2 of 2 tests, "
           "the binary again, --test-threads=4)" in out, "`p`: passed" in out,
           "| pi-shell set (runner) | **KNOWN** |" in out, rc), (True, False, True, 0))
    json.dump(dict(zle_runner, retries={"k": [rt("fail"), rt("fail")]}), open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("a flaky failure that failed every try",
          ("FAILED `k`: **NEW** (listed as `flaky: a race`, but no retry of its shape passed it: fail" in out,
           "| pi-shell set (runner) | **FAIL** |" in out, rc), (True, True, 1))
    json.dump(dict(zle_runner, retries={"k": [rt("fail"), rt("partial", 1, 2, "the test alone, 1 thread")]}),
              open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("a flaky failure that passes alone and fails at the unit's threads",
          ("FAILED `k`: **NEW** (listed as `flaky: a race`, but no retry of its shape passed it: fail (a rerun of the unit: "
           "2 of 2 tests, the binary again, --test-threads=4); partial (a rerun of the unit: 1 of 2 tests, the test alone, "
           "1 thread))" in out,
           "| pi-shell set (runner) | **FAIL** |" in out, rc), (True, True, 1))
    # Where each test has a process of its own (nextest, record_retry's scope own-process), a retry of
    # the test alone is that process again, as nextest's own retries are, and its pass counts.
    json.dump(dict(zle_runner, retries={"k": [rt("pass", 1, 2, "nextest's retry", "own-process")]}),
              open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("a flaky failure that passed in its own process again",
          ("FAILED `k`: KNOWN (flaky: a race; it passed on retry 1 of 1, in its own process again: 1 of 2 tests, "
           "nextest's retry)" in out, rc), (True, 0))
    json.dump(dict(zle_runner, retries={"k": [rt("fail"), rt("skip")]}), open(os.path.join(res, "zle-runner.json"), "w"))
    rc, out = summary()
    check("a flaky failure whose retry skipped itself", ("FAILED `k`: **NEW**" in out, rc), (True, 1))
    json.dump(dict(zle_runner, retries={"k": [rt("pass")]}), open(os.path.join(res, "zle-runner.json"), "w"))
    open(known_file, "a").write("set-runner\trunner\tpi-shell::zle_pty\tgone\tflaky: a race\n")
    rc, out = summary()
    check("a flaky entry whose test left its unit is to be removed",
          ("`gone`: no longer in its unit (listed for: flaky: a race)" in out, rc), (True, 1))
    json.dump(zle_runner, open(os.path.join(res, "zle-runner.json"), "w"))
    # The scripts' retries: flaky_failed names the failed tests with a flaky entry, and record_retry
    # adds one retry of the whole unit: `pass` only when the retry ran every test the unit ran and the
    # test passed; a pass in a smaller run (the test alone) is `partial`. An event after other text
    # on its line counts.
    rj, rl = os.path.join(d, "retry.json"), os.path.join(d, "retry.log")
    json.dump(result("set-runner", "pi-shell::zle_pty", "runner", "FAIL", 101, 1, passed=1, failed=2, failures=["k", "q"],
                     tests=[("a", 1.0), ("k", 1.0), ("q", 1.0)]), open(rj, "w"))
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tflaky: a race\n"
                                "set-runner\trunner\tpi-shell::zle_pty\tq\tthe host\n")
    check("flaky_failed", flaky_failed(rj, known_file), ["k"])

    def ev(name, event, stdout=""):
        return json.dumps({"type": "test", "event": event, "name": name, "stdout": stdout}) + "\n"

    open(rl, "w").write(ev("a", "ok") + ev("k", "failed") + ev("q", "failed"))
    o1 = record_retry(rj, "k", rl, "4 threads")
    open(rl, "w").write(ev("k", "ok"))
    o2 = record_retry(rj, "k", rl, "alone")
    open(rl, "w").write(ev("a", "ok") + "test k ... " + ev("k", "ok") + ev("q", "failed"))
    o3 = record_retry(rj, "k", rl, "4 threads")
    check("record_retry of the whole unit and of the test alone", (o1, o2, o3, json.load(open(rj))["retries"]["k"]),
          ("fail", "partial", "pass", [{"outcome": "fail", "ran": 3, "of": 3, "shape": "4 threads", "scope": "whole-unit"},
                                       {"outcome": "partial", "ran": 1, "of": 3, "shape": "alone", "scope": "whole-unit"},
                                       {"outcome": "pass", "ran": 3, "of": 3, "shape": "4 threads", "scope": "whole-unit"}]))
    # nextest's and bun's retries are JUnit reports of the whole unit.
    jb = os.path.join(d, "bun-retry.xml")
    open(jb, "w").write('<testsuites><testsuite name="test/x.test.ts"><testsuite name="PDF pages"><testcase '
                        'name="paints (each) page." classname="PDF pages" file="test/x.test.ts"/></testsuite></testsuite></testsuites>')
    rjb = os.path.join(d, "retry-bun.json")
    json.dump(result("ts-ca", "shard 1/10", "runner", "FAIL", 1, 1, failed=1, failures=["PDF pages::paints (each) page."],
                     tests=[("PDF pages::paints (each) page.", 1.0)]), open(rjb, "w"))
    rjn = os.path.join(d, "retry-nextest.json")
    json.dump(result("builtins", "pi-builtins", "runner", "FAIL", 100, 1, passed=1, failed=1, failures=["pi-builtins::t2"],
                     tests=[("pi-builtins::t1", 1.0), ("pi-builtins::t2", 1.0)]), open(rjn, "w"))
    check("record_retry from a JUnit report", (record_retry(rjb, "PDF pages::paints (each) page.", jb, "the shard"),
          record_retry(rjn, "pi-builtins::t2", ju, "the unit"), record_retry(rjn, "absent", jb, "the unit")),
          ("pass", "fail", "fail"))
    jo = os.path.join(d, "own-retry.xml")
    open(jo, "w").write('<testsuites><testsuite name="pi-builtins"><testcase classname="pi-builtins" name="t2" time="1"/>'
                        '</testsuite></testsuites>')
    check("record_retry of a nextest test alone: partial for a whole-unit scope, pass in its own process",
          (record_retry(rjn, "pi-builtins::t2", jo, "alone"), record_retry(rjn, "pi-builtins::t2", jo, "alone", "own-process")),
          ("partial", "pass"))
    # A retry that passed after a skip marker checked nothing: `skip`, from a libtest log and from a
    # JUnit report.
    open(rl, "w").write(ev("a", "ok") + ev("k", "ok", "skipped: no zsh here\n") + ev("q", "failed"))
    jsk = os.path.join(d, "skip-retry.xml")
    open(jsk, "w").write('<testsuites><testsuite name="p"><testcase classname="p" name="t" time="1"><system-err>'
                         'p: the host half is skipped: names do not fold\n</system-err></testcase></testsuite></testsuites>')
    check("record_retry of a retry that skipped itself", (record_retry(rj, "k", rl, "4 threads"),
          record_retry(rj, "p::t", jsk, "the unit")), ("skip", "skip"))
    # Known self-skips (`skips: `, a sixth field: the skip line's start): a self-skip reads KNOWN only
    # when each of its lines starts as an entry of its row and user says; one user's entry never
    # covers the other user.
    def bx(who, skipped, lines):
        return dict(result("builtins", "pi-builtins", who, "UNKNOWN", 0, 1, passed=1,
                           tests=[("a", 1.0)] + [(s, 1.0) for s in skipped], self_skipped=skipped,
                           skip_lines={s: lines for s in skipped}), skip_only=True)

    json.dump(bx("runner", ["c"], ["c -p a b: skipped, it needs root"]), open(os.path.join(res, "b-runner.json"), "w"))
    json.dump(bx("root", ["c"], ["c --reflink a b: skipped, this filesystem does not clone (x)"]),
              open(os.path.join(res, "b-root.json"), "w"))
    zle_k = "set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n"
    need_root = "builtins\trunner\tpi-builtins\tc\tskips: it needs root\tc {} a b: skipped, it needs root\n"
    no_clone = "builtins\troot\tpi-builtins\tc\tskips: no clone here\tc --reflink a b: skipped, this filesystem does not clone\n"
    open(known_file, "w").write(zle_k + need_root)
    rc, out = summary()
    check("a known skip for one user only", ("SKIPPED ITSELF `c`: KNOWN (it needs root)" in out,
          "| pi-builtins, nextest default profile | **UNKNOWN** |" in out, rc), (True, True, 1))
    open(known_file, "a").write(no_clone)
    rc, out = summary()
    check("a known skip for each user", ("| pi-builtins, nextest default profile | **KNOWN** |" in out, rc), (True, 0))
    open(known_file, "w").write(zle_k + need_root.replace("builtins\trunner", "builtins\troot") + no_clone)
    rc, out = summary()
    check("a known skip listed for the other user", ("`pi-builtins` (runner): UNKNOWN: 1 test(s) skipped themselves" in out, rc),
          (True, 1))
    open(known_file, "w").write(zle_k + need_root.replace("builtins", "workspace", 1) + no_clone)
    rc, out = summary()
    check("a known skip listed for another row", ("`pi-builtins` (runner): UNKNOWN: 1 test(s) skipped themselves" in out, rc),
          (True, 1))
    open(known_file, "w").write(zle_k + need_root + no_clone)
    json.dump(bx("runner", ["c"], ["c -p a b: skipped, it needs root", "c -p a b: skipped, no FIFO"]),
              open(os.path.join(res, "b-runner.json"), "w"))
    rc, out = summary()
    check("a self-skip with one line no entry starts", ("`pi-builtins` (runner): UNKNOWN" in out, rc), (True, 1))
    # Every skip line counts: twenty lines an entry names and a twenty-first it does not is UNKNOWN
    # (CiReview at 15d6f1a9: only the first 20 lines were kept, so the 21st was never matched).
    json.dump(bx("runner", ["c"], [f"c -p a b: skipped, it needs root ({i})" for i in range(20)] + ["c -p a b: skipped, no FIFO"]),
              open(os.path.join(res, "b-runner.json"), "w"))
    rc, out = summary()
    check("a self-skip whose 21st line no entry starts", ("`pi-builtins` (runner): UNKNOWN" in out, rc), (True, 1))
    json.dump(bx("runner", ["c"], ["c -p a b: skipped, it needs root"]), open(os.path.join(res, "b-runner.json"), "w"))
    open(known_file, "a").write("builtins\trunner\tpi-builtins\ta\tskips: stale\ta: skipped\n")
    rc, out = summary()
    check("a known skip whose test ran without skipping itself is to be removed",
          ("`a`: ran without skipping itself (listed: skips `a: skipped`: stale)" in out, rc), (True, 1))
    json.dump(nx("runner", ["c"], ["a"]), open(os.path.join(res, "b-runner.json"), "w"))
    json.dump(nx("root", [], ["a", "c"]), open(os.path.join(res, "b-root.json"), "w"))
    # nextest's own retries, in its JUnit report as nexte.st documents it (docs/machine-readable/junit,
    # the fixture-project example): a test that failed and then passed has <flakyFailure> children
    # and reads FLAKY, a failure with its retries for the `flaky: ` rule; a test that failed every
    # attempt keeps <failure> with <rerunFailure> children; nextest exits 0 when only flaky tests
    # failed first.
    def attempt(tag, msg):
        return (f'<{tag} timestamp="2024-01-09T07:50:12.665+00:00" time="0.004" type="test failure">{msg}\n'
                'note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n'
                '<system-out>\nrunning 1 test\ntest x ... FAILED\n</system-out><system-err>panicked</system-err>'
                f'</{tag}>')

    cwd = '<testcase name="test_cwd" classname="fixture-project::basic" time="0.004"></testcase>'
    fail_assert = ('<testcase name="test_failure_assert" classname="fixture-project::basic" time="0.004">'
                   '<failure type="test failure">thread &apos;test_failure_assert&apos; panicked at tests/basic.rs:19:5:\n'
                   'assertion `left == right` failed: this is an assertion</failure>'
                   + attempt("rerunFailure", "thread &apos;test_failure_assert&apos; panicked at tests/basic.rs:19:5:")
                   + attempt("rerunFailure", "thread &apos;test_failure_assert&apos; panicked at tests/basic.rs:19:5:")
                   + '<system-out>\nrunning 1 test\n</system-out></testcase>')
    flaky_mod_4 = ('<testcase name="test_flaky_mod_4" classname="fixture-project::basic" time="0.004">'
                   + "".join(attempt("flakyFailure", f"thread &apos;test_flaky_mod_4&apos; panicked at tests/basic.rs:43:9:\n"
                                                     f"Failed because attempt {i} % 4 != 0") for i in (1, 2, 3))
                   + '</testcase>')
    nj = os.path.join(d, "nextest-retries.xml")

    def nextest(cases, code):
        with open(nj, "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="nextest-run" tests="3" failures="1" errors="0">'
                    f'<testsuite name="fixture-project::basic" tests="3" disabled="0" errors="0" failures="1">{cases}'
                    '</testsuite></testsuites>')
        return parse_junit(nj, str(code), 1, "builtins", "pi-builtins", "runner", (0,), (100,))

    fm4, fa = "fixture-project::basic::test_flaky_mod_4", "fixture-project::basic::test_failure_assert"
    r = nextest(cwd + flaky_mod_4, 0)
    check("nextest: exit 0 with a flaky test", (r["status"], r["passed"], r["failures"], [t["outcome"] for t in r["retries"][fm4]],
                                                r["retries"][fm4][0]["first_failure"]),
          ("FAIL", 1, [fm4], ["fail", "fail", "pass"],
           "thread 'test_flaky_mod_4' panicked at tests/basic.rs:43:9: Failed because attempt 1 % 4 != 0"))
    json.dump(r, open(os.path.join(res, "b-runner.json"), "w"))
    open(known_file, "w").write(zle_k + f"builtins\trunner\tpi-builtins\t{fm4}\tflaky: attempt % 4\n")
    rc, out = summary()
    check("nextest: a listed flaky test that passed on its own retry", (
        f"FAILED `{fm4}`: KNOWN (flaky: attempt % 4; it passed on retry 3 of 3, in its own process again: 1 of 2 tests, "
        "nextest's own retry 3 of 3; first failure: thread 'test_flaky_mod_4' panicked" in out,
        "| pi-builtins, nextest default profile | **KNOWN** |" in out, rc), (True, True, 0))
    open(known_file, "w").write(zle_k)
    rc, out = summary()
    check("nextest: an unlisted flaky test", (
        f"FAILED `{fm4}`: **NEW** (flaky, and not on the known-failure list: it passed on retry 3 of 3" in out,
        "| pi-builtins, nextest default profile | **FAIL** |" in out, rc), (True, True, 1))
    r = nextest(cwd + fail_assert + flaky_mod_4, 100)
    check("nextest: a test that failed every retry", (r["status"], r["failures"], [t["outcome"] for t in r["retries"].get(fa, [])]),
          ("FAIL", [fa, fm4], ["fail", "fail"]))
    check("nextest: a test that failed every retry, with exit 0", nextest(cwd + fail_assert, 0)["status"], "UNKNOWN")
    json.dump(r, open(os.path.join(res, "b-runner.json"), "w"))
    open(known_file, "w").write(zle_k + f"builtins\trunner\tpi-builtins\t{fm4}\tflaky: attempt % 4\n"
                                f"builtins\trunner\tpi-builtins\t{fa}\tflaky: an assertion\n")
    rc, out = summary()
    check("nextest: a listed flaky test that failed every retry", (
        f"FAILED `{fa}`: **NEW** (listed as `flaky: an assertion`, but no retry of its shape passed it: fail (in its own "
        "process again: 1 of 3 tests, nextest's own retry 1 of 2); fail" in out,
        "| pi-builtins, nextest default profile | **FAIL** |" in out, rc), (True, True, 1))
    # The last attempt of a flaky case is its own output: one that printed a skip marker checked
    # nothing, so it is `skip` (passed_attempt, as for record_retry) and the listed test reads NEW
    # (CiReview at 075957a9: it read KNOWN).
    flaky_skip = flaky_mod_4.replace("</testcase>", "<system-out>skipped: no zsh here\n</system-out></testcase>")
    r = nextest(cwd + flaky_skip, 0)
    check("nextest: a flaky test whose passing attempt printed a skip line", [t["outcome"] for t in r["retries"][fm4]],
          ["fail", "fail", "skip"])
    json.dump(r, open(os.path.join(res, "b-runner.json"), "w"))
    open(known_file, "w").write(zle_k + f"builtins\trunner\tpi-builtins\t{fm4}\tflaky: attempt % 4\n")
    rc, out = summary()
    check("nextest: a listed flaky test whose passing attempt skipped", (
        f"FAILED `{fm4}`: **NEW** (listed as `flaky: attempt % 4`, but no retry of its shape passed it" in out,
        "| pi-builtins, nextest default profile | **FAIL** |" in out, rc), (True, True, 1))
    # A case with nextest's retry elements and no record of them is UNKNOWN by name (the reading of the
    # elements planted broken: no outcome for any retry).
    g = globals()
    kept = g["nextest_attempts"]
    g["nextest_attempts"] = lambda flaky, rerun, out: []
    try:
        r = nextest(cwd + fail_assert + flaky_mod_4, 100)
    finally:
        g["nextest_attempts"] = kept
    check("nextest: a case with retry elements and no record", (r["status"], r["note"]),
          ("UNKNOWN", f"a flaky case has no recorded retry: {fa}, {fm4}"))
    open(known_file, "w").write("# none\n")
    json.dump(nx("runner", ["c"], ["a"]), open(os.path.join(res, "b-runner.json"), "w"))
    # A `*` entry names its test in any unit of its row (a coding-agent shard moves when a file is added).
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if (r["row"], r["unit"]) == ("ts-ca", "shard 3/10"):
            os.remove(os.path.join(res, f))
    json.dump(result("ts-ca", "shard 3/10", "runner", "FAIL", 1, 1, passed=1, failed=1, failures=["w"],
                     tests=[("w", 1.0), ("t", 1.0)]), open(os.path.join(res, "ca3.json"), "w"))
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n"
                                "ts-ca\trunner\t*\tw\tno WebMCP\n")
    rc, out = summary()
    check("a * entry names its test in any shard", ("FAILED `w`: KNOWN (no WebMCP)" in out,
          "| coding-agent --isolate | **KNOWN** |" in out, rc), (True, True, 0))
    open(known_file, "a").write("ts-ca\trunner\t*\tgone\tno WebMCP\nts-ca\trunner\t*\tt\tno WebMCP\n")
    rc, out = summary()
    check("a * entry whose test passed or is in no shard is to be removed",
          ("`gone`: no longer in its row (listed for: no WebMCP)" in out, "`t`: passed (listed for: no WebMCP)" in out, rc),
          (True, True, 1))
    # `*` only on the rows whose units are shards: on the set rows a test's name is unique only in
    # its binary (CiReview at 55a3d02c).
    open(known_file, "w").write("set-runner\trunner\t*\tk\tthe host's zsh\n")
    try:
        read_known(known_file)
        refused = False
    except SystemExit:
        refused = True
    check("a * entry on a set row is refused", refused, True)
    json.dump(result("ts-ca", "shard 3/10", "runner", "PASS", 0, 1, passed=1, tests=[("t", 1.0)]),
              open(os.path.join(res, "ca3.json"), "w"))
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
    # A platform failure's retries are nextest's own, read from the head leg's JUnit report by the
    # shared reader: a flaky entry gives KNOWN only when a retry passed (<flakyFailure> then a pass);
    # failing every try (<rerunFailure>) reads NEW; a repeat that passed is not a retry and counts
    # for nothing; a test that passed only on its retry and has no entry reads NEW, as flaky.
    def platform_run(name, line, verdict, passed, cases):
        os.makedirs(os.path.join(d, name, "pc-report"))
        leg = os.path.join(d, name, "pc-results-macos-head-user-1")
        os.makedirs(leg)
        write(f"{name}/pc-report/summary.md", f"| what | commit |\n|---|---|\n| head | `{commit}` |\n")
        write(f"{name}/pc-report/verdicts.tsv", f"platform\ttree\tuser\tverdict\nmacos\thead\tuser\t{line}\n")
        write(f"{name}/pc-report/tests.tsv", "platform\ttree\tuser\tbinary\ttest\tverdict\tpassed\tflaky\tfailed\ttimed_out\tnot_run\n"
              f"macos\thead\tuser\tpi-shell::zle_widgets_pty\ttransposes\t{verdict}\t{passed}\t0\t0\t0\t0\n"
              "macos\thead\tuser\tpi-shell::zle_widgets_pty\tother\tPASS\t2/2\t0\t0\t0\t0\n")
        write(f"{name}/pc-results-macos-head-user-1/meta.env", "platform=macos\ntree=head\nwho=user\nleg=1\nrun_exit=100\nrun_seconds=60\n")
        suites = "".join(f'<testsuite name="pi-shell::zle_widgets_pty@stress-{i}">'
                         f'<testcase classname="pi-shell::zle_widgets_pty" name="transposes" time="1">{c}</testcase>'
                         '<testcase classname="pi-shell::zle_widgets_pty" name="other" time="1"/></testsuite>'
                         for i, c in enumerate(cases))
        write(f"{name}/pc-results-macos-head-user-1/junit.xml", f"<testsuites>{suites}</testsuites>")
        r = {x["row"]: x for x in platform_results(os.path.join(d, name), commit)}["macos"]
        json.dump(r, open(os.path.join(res, "macos.json"), "w"))
        return r, summary()

    t = "`pi-shell::zle_widgets_pty::transposes`"
    tn = "pi-shell::zle_widgets_pty::transposes"
    failed_twice = '<failure message="left 1, right 2"/><rerunFailure message="left 1, right 2"/>'
    flaky_pass = '<flakyFailure message="no end within 30s"/>'
    flaky_entry = f"macos\trunner\tpi-shell\t{tn}\tflaky: fails 1 of 2 upstream\n"
    open(known_file, "w").write(flaky_entry + "set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    r, (rc, out) = platform_run("pcf1", "FAIL (1 failed: x) run=4 ignored=0", "FAIL", "0/2", [failed_twice, failed_twice])
    check("a platform test listed flaky that failed every retry is NEW",
          ([x["outcome"] for x in r["retries"].get(tn, [])], {x["scope"] for x in r["retries"].get(tn, [])},
           f"FAILED {t}: **NEW** (listed as `flaky: fails 1 of 2 upstream`, but no retry of its shape passed it: fail (in its own process again" in out,
           "| macOS: pi-shell, platform checks | **FAIL** |" in out, rc),
          (["fail", "fail"], {"own-process"}, True, True, 1))
    r, (rc, out) = platform_run("pcf2", "FAIL (1 failed: x) run=4 ignored=0", "FAIL", "1/2", [failed_twice, ""])
    check("a platform test listed flaky that passed only in another repeat is NEW",
          (f"FAILED {t}: **NEW** (listed as `flaky: fails 1 of 2 upstream`, but no retry of its shape passed it" in out, rc), (True, 1))
    r, (rc, out) = platform_run("pcf3", "FLAKY (1 passed only on a retry: x) run=3 ignored=0", "FLAKY", "1/1", [flaky_pass])
    check("a platform test listed flaky that passed on its retry is KNOWN",
          ([x["outcome"] for x in r["retries"].get(tn, [])],
           f"FAILED {t}: KNOWN (flaky: fails 1 of 2 upstream; it passed on retry 1 of 1, in its own process again: 1 of 2 tests, "
           "nextest's own retry 1 of 1; first failure: no end within 30s)" in out,
           "| macOS: pi-shell, platform checks | **KNOWN** |" in out, rc),
          (["pass"], True, True, 0))
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    r, (rc, out) = platform_run("pcf4", "FLAKY (1 passed only on a retry: x) run=3 ignored=0", "FLAKY", "1/1", [flaky_pass])
    check("a platform test that passed only on its retry, with no entry, is NEW and flaky",
          (f"FAILED {t}: **NEW** (flaky, and not on the known-failure list: it passed on retry 1 of 1" in out,
           "| macOS: pi-shell, platform checks | **FAIL** |" in out, rc),
          (True, True, 1))
    # A listed flaky test whose passing retry printed a skip line checked nothing on that try: the
    # shared reader (passed_attempt) gives `skip`, and the test reads NEW.
    open(known_file, "w").write(flaky_entry + "set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    r, (rc, out) = platform_run("pcf5", "FLAKY (1 passed only on a retry: x) run=3 ignored=0", "FLAKY", "1/1",
                                [flaky_pass + "<system-out>skipped: no zsh here\n</system-out>"])
    check("a platform test listed flaky whose passing retry skipped is NEW",
          ([x["outcome"] for x in r["retries"].get(tn, [])],
           f"FAILED {t}: **NEW** (listed as `flaky: fails 1 of 2 upstream`, but no retry of its shape passed it: skip" in out,
           "| macOS: pi-shell, platform checks | **FAIL** |" in out, rc),
          (["skip"], True, True, 1))
    # A case with nextest's retry elements and no record of them is UNKNOWN by name (the reading of the
    # elements planted broken, as for parse_junit).
    g = globals()
    kept = g["nextest_attempts"]
    g["nextest_attempts"] = lambda flaky, rerun, out: []
    try:
        r, _ = platform_run("pcf6", "FAIL (1 failed: x) run=4 ignored=0", "FAIL", "0/2", [failed_twice, failed_twice])
    finally:
        g["nextest_attempts"] = kept
    check("a platform case with retry elements and no record", (r["status"], r["note"]),
          ("UNKNOWN", f"a flaky case has no recorded retry: {tn}"))
    os.remove(os.path.join(res, "macos.json"))
    json.dump(result("macos", PLATFORM_CRATES, "runner", "PASS", 0, 1, passed=1), open(os.path.join(res, "macos.json"), "w"))
    open(known_file, "w").write("# none\n")
    # A gVisor job that reports nothing: gv-builtins-root (its one unit), and the uid 1000 set shard
    # that holds the lib binary (its set unit and the lib row both come from that job).
    check("the plan names the gVisor jobs", {"gv-builtins-root", "gv-set-uid1000-1", "gv-set-root-4"} <= set(all_job_names()), True)
    check("the gVisor set jobs are the shards assign() gives", set(assign([f"b{i}" for i in range(40)], {}, GV_SET_SHARDS).values()),
          {m["shard"] for m in gvisor_matrix() if m["part"] == "set" and m["who"] == "root"})
    check("the gVisor rows expect both users", {("gv-builtins-uid1000", "pi-builtins", "uid1000"), ("gv-lib4-root", "pi-shell", "root"),
                                                ("gv-set-root", "pi-shell::zle_pty", "root")} <= set(exp), True)
    check("the map-limit control row is expected for both users", {("gv-orphan-uid1000", "testkit::suites::orphan_jobs", "uid1000"),
                                                                   ("gv-orphan-root", "testkit::suites::orphan_jobs", "root")} <= set(exp), True)
    gv_silent = [("gv-builtins-root", "pi-builtins", "root"), ("gv-set-uid1000", "pi-shell", "uid1000"), ("gv-lib4-uid1000", "pi-shell", "uid1000"),
                 ("gv-orphan-uid1000", "testkit::suites::orphan_jobs", "uid1000")]
    for k in gv_silent:
        if k in paths:
            os.rename(paths[k], paths[k] + ".planted")
    rc, out = summary()
    check("summary exit with a silent gVisor job", rc, 1)
    check("a silent gVisor builtins job reads UNKNOWN", "| pi-builtins, nextest default profile, gVisor (root) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("a silent gVisor builtins job is named", "`pi-builtins` (root): UNKNOWN: no result" in out, True)
    check("a silent gVisor set shard reads UNKNOWN", "| pi-shell set, gVisor (uid 1000) | **UNKNOWN** | 1 / 0 / 0 / 1 |" in out, True)
    check("its control row reads UNKNOWN", "| pi-shell orphan_jobs at 4 threads, gVisor: the map-limit control (uid 1000) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
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
    pfs = os.path.join(d, "partial-forms.txt")
    open(pfs, "w").write("c::t\t{case}: skipped, it needs root\tw\tr\n")
    open(os.path.join(tree, "crates", "c", "src", "more.rs"), "w").write(
        'fn m(case: &str) {\n    eprintln!("{case}: skipped, this filesystem does not clone");\n'
        '    eprintln!("no free /etc/services port: nothing to test");\n'
        '    eprintln!("this system carries no TCP urgent data: the mark is not checked");\n'
        '    eprintln!("{case}: it skipped nothing");\n}\n')
    open(exf, "w").write("crates/c/src/more.rs\tx: it skipped nothing\tsays nothing was skipped\n")
    check("skip-forms on known forms", skip_forms(tree, exf, pfs), ([], [], 2))
    # skip-lines, the run-time half, on a results directory: cow.rs's lines are read, the named partial
    # check is not a marker, and a failed test's lines are not read at all.
    rt = os.path.join(d, "rt")
    os.makedirs(os.path.join(rt, "sc-res-w", "logs"))
    check("skip-lines with no report", cmd_skip_lines(rt, exf)["status"], "UNKNOWN")
    with open(os.path.join(rt, "sc-res-w", "logs", "w.junit.xml"), "w") as f:
        f.write('<testsuites><testsuite name="p"><testcase classname="p" name="cow" time="1"><system-err>'
                + escape(cow_err + zftp + "\ncp: the host half is skipped: names do not fold in /tmp/.tmpX\n"
                         + "case: it skipped nothing\n")
                + '</system-err></testcase><testcase classname="p" name="f" time="1"><failure/><system-err>'
                'a failed test, skipping in a new way\n</system-err></testcase></testsuite></testsuites>')
    check("skip-lines on read and named lines", cmd_skip_lines(rt, exf)["status"], "PASS")
    # Controls: b523cbf8's rule read one `<prefix>: ` and no `nothing to test`; with it both halves
    # report cow.rs's form and the zftp give-up.
    g = globals()
    kept = g["SKIP_MARKER"]
    g["SKIP_MARKER"] = re.compile(r"^\s*(?:[^\n:]{1,200}:\s+|[A-Z][A-Z0-9_-]*\s+)?(?:skipped\b|skipping\b|SKIP\b|"
                                  r"not run\b|NOT-RUN\b|UNKNOWN:)|UNCOMPARED|nothing was checked|the test saw nothing", re.M)
    try:
        unread = skip_forms(tree, exf, pfs)[0]
        lines = cmd_skip_lines(rt, exf)["failures"]
    finally:
        g["SKIP_MARKER"] = kept
    check("skip-forms with the one-prefix rule", [u for u in unread if "more.rs" in u],
          ["crates/c/src/more.rs:2: 'x: y, z: skipped, this filesystem does not clone'",
           "crates/c/src/more.rs:3: 'no free /etc/services port: nothing to test'",
           "crates/c/src/more.rs:4: 'this system carries no TCP urgent data: the mark is not checked'"])
    check("skip-lines with the one-prefix rule", (len(lines), sum(zftp in l for l in lines),
          sum("host half" in l for l in lines)), (8, 1, 1))
    open(src, "a").write('fn u() { eprintln!("no check here, skipping quietly"); }\n')
    unread = skip_forms(tree, exf, pfs)[0]
    check("skip-forms catches a planted new form", unread, ["crates/c/src/lib.rs:10: 'no check here, skipping quietly'"])
    with open(os.path.join(rt, "sc-res-w", "logs", "set.log"), "w") as f:
        f.write(json.dumps({"type": "test", "event": "ok", "name": "q", "stdout": "no clone here, skipping quietly\n"}) + "\n")
    r = cmd_skip_lines(rt, exf)
    check("skip-lines catches a planted line", (r["status"], r["failures"]),
          ("FAIL", ["a skip line the summary does not read: 'no clone here, skipping quietly', printed 1 time(s), "
                    "first by sc-res-w/logs/set.log q"]))
    open(exf, "a").write("crates/c/src/lib.rs\tgone\tstale\n")
    check("skip-forms names a stale exception", skip_forms(tree, exf, pfs)[1], ["crates/c/src/lib.rs: 'gone'"])
    open(pfs, "a").write("c::t\t{case}: gone too\tw\tr\n")
    check("skip-forms names a stale partial-skip entry", skip_forms(tree, exf, pfs)[1],
          ["crates/c/src/lib.rs: 'gone'", "partial-skips.txt, c::t: '{case}: gone too'"])
    for line in ("x: skipped, this filesystem does not clone", "CHILD skipped: uid 1000", "skipped mode 0200: root",
                 "NOT-RUN t: this kernel", "SKIP: running as root", "skipping reftable coverage: x"):
        check(f"skip marker in {line!r}", bool(SKIP_MARKER.search(line)), True)
    # No binary list: the set rows are UNKNOWN, not empty passes.
    os.remove(os.path.join(build, "binaries-metadata.json"))
    rc, out = summary()
    check("summary without a binary list", ("| pi-shell set (runner) | **UNKNOWN** | - |" in out, rc), (True, 1))
    check("summary without a binary list (gVisor)", "| pi-shell set, gVisor (root) | **UNKNOWN** | - |" in out, True)

    # Known skips for the gVisor rows (known-failures.txt `skips: `): an entry for a gVisor row clears
    # that row's self-skip; the same skip in a host row stays open.
    for f in os.listdir(res):
        r = json.load(open(os.path.join(res, f)))
        if r["row"] in ("builtins", "gv-builtins-uid1000", "gv-builtins-root"):
            os.remove(os.path.join(res, f))
    gline = "skipped: under gVisor an attribute set after the mode changed is refused in some runs"

    def gskip(row, who):
        return dict(result(row, "pi-builtins", who, "UNKNOWN", 0, 1, passed=1, tests=[("a", 1.0), ("ro", 1.0)],
                           self_skipped=["ro"], skip_lines={"ro": [gline]}), skip_only=True)
    for row, who in (("gv-builtins-uid1000", "uid1000"), ("gv-builtins-root", "root"), ("builtins", "runner"), ("builtins", "root")):
        json.dump(gskip(row, who), open(os.path.join(res, f"ks-{row}-{who}.json"), "w"))
    open(known_file, "w").write("".join(f"gv-builtins-{w}\t{w}\tpi-builtins\tro\tskips: gVisor\tskipped: under gVisor {{}}\n" for w in GV_WHO))
    rc, out = summary()
    check("a gVisor known skip clears its gVisor row", ("| pi-builtins, nextest default profile, gVisor (root) | **KNOWN** |" in out,
          "| pi-builtins, nextest default profile, gVisor (uid 1000) | **KNOWN** |" in out), (True, True))
    check("the same skip in a host row stays open", "| pi-builtins, nextest default profile | **UNKNOWN** |" in out, True)
    open(known_file, "w").write("# none\n")
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

    # The map-limit control needs each of its tests by name: a filter that selects nothing (the module
    # renamed or moved) exits 0 having run nothing, and must read UNKNOWN, not PASS.
    def ctl(names):
        p = os.path.join(d, "ctl.log")
        ev = [{"type": "suite", "event": "started", "test_count": len(names)}]
        for n in names:
            ev += [{"type": "test", "event": "started", "name": n}, {"type": "test", "event": "ok", "name": n, "exec_time": 0.1}]
        ev.append({"type": "suite", "event": "ok", "passed": len(names), "failed": 0})
        with open(p, "w") as f:
            f.write("".join(json.dumps(e) + "\n" for e in ev))
        return gv_control(p, "0", 1, "gv-orphan-root", "testkit::suites::orphan_jobs", "root")
    check("the map-limit control with each of its tests passes", ctl(list(ORPHAN_CONTROL_TESTS))["status"], "PASS")
    r = ctl([])
    check("a control whose filter selects nothing (the module renamed) is UNKNOWN",
          (r["status"], f"{len(ORPHAN_CONTROL_TESTS)} of the {len(ORPHAN_CONTROL_TESTS)} control tests did not run" in r["note"]), ("UNKNOWN", True))
    r = ctl(list(ORPHAN_CONTROL_TESTS[1:]))
    check("a control test that did not run is UNKNOWN and named",
          (r["status"], r["note"].endswith(ORPHAN_CONTROL_TESTS[0].rsplit("::", 1)[-1])), ("UNKNOWN", True))
    # The docs and changelog rows. The plan takes `plant` as docs, changelog or nothing.
    for plant_in, ok in (("", True), ("docs", True), ("changelog", True), ("both", False)):
        env = dict(GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_REF="refs/heads/x", SC_INPUT_COMMIT="a" * 40,
                   SC_INPUT_SILENT="", SC_INPUT_PLANT=plant_in)
        kept_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                cmd_plan()
            got = f"plant={plant_in}" in buf.getvalue().splitlines()
        except SystemExit:
            got = False
        for k, v in kept_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        check(f"plan with plant={plant_in!r}", got, ok)
    check("docs and changelog are job names silent takes", {"docs", "changelog"} <= set(all_job_names()), True)
    # Each plant lands where the job's tool reads it.
    ptree = os.path.join(d, "ptree")
    for what, body in (("docs", "//! pi-shell\n#![allow(x)]\nmod a;\npub mod bash;\npub mod b;\n"),
                       ("changelog", "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- x\n")):
        p = os.path.join(ptree, PLANTS[what][0])
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").write(body)
        with contextlib.redirect_stdout(io.StringIO()):
            cmd_plant(what, ptree)
        check(f"the {what} plant", open(p).read().split("\n")[3:6],
              {"docs": [PLANTS["docs"][1], "pub mod bash;", "pub mod b;"],
               "changelog": ["", PLANTS["changelog"][1], ""]}[what])
    # A unified diff's first change in each file; a removed line that starts `-- ` is no header.
    dfile = os.path.join(d, "c.diff")
    open(dfile, "w").write("--- a/p/x.md\n+++ b/p/x.md\n@@ -3,5 +3,3 @@\n ## [Unreleased]\n \n-### Planted\n--- dashes\n"
                           " ## [1.0.0]\n@@ -20,2 +18,1 @@\n a\n-b\n--- a/p/y.md\n+++ b/p/y.md\n@@ -1 +1 @@\n-old\n+new\n")
    check("changed_lines", changed_lines(dfile), {"p/x.md": (5, ["-### Planted", "--- dashes"]), "p/y.md": (1, ["-old", "+new"])})
    # The summary: a docs or changelog job that reports nothing is UNKNOWN, and so is its row; a
    # planted run says whether its control caught the plant.
    res2, build2 = os.path.join(d, "res2"), os.path.join(d, "build2")
    os.makedirs(res2)
    os.makedirs(build2)
    json.dump(meta, open(os.path.join(build2, "binaries-metadata.json"), "w"))
    known2 = os.path.join(d, "known2.txt")
    open(known2, "w").write("# none\n")
    for i, (row, unit, who) in enumerate(expected_units(build2)[0]):
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1), open(os.path.join(res2, f"{i}.json"), "w"))

    def summary2(drop=(), plant_env=""):
        for k in drop:
            os.remove(os.path.join(res2, k))
        os.environ["SC_PLANT"] = plant_env
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc2 = cmd_summary(res2, build2, known2)
        os.environ.pop("SC_PLANT")
        return rc2, buf.getvalue()

    # parse_docs on cargo's own JSON lines, cut to the fields it reads: run 45370356750 (85936bf7),
    # run 45370374136 (plant=docs), and cargo doc of a crate that imports a crate that does not exist.
    planted = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"error","code":{"code":'
               '"rustdoc::broken_intra_doc_links"},"message":"unresolved link to `NoSuchItemPlanted`","spans":[{"file_name":'
               '"crates/pi-shell/src/lib.rs","line_start":36,"column_start":1,"is_primary":true,"label":null}],"rendered":'
               '"error: unresolved link to `NoSuchItemPlanted`"}}')
    tg = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"error","code":{"code":'
          '"rustdoc::broken_intra_doc_links"},"message":"unresolved link to `TERM_GRACE`","spans":[{"file_name":'
          '"crates/pi-shell/src/session.rs","line_start":%d,"column_start":%d,"is_primary":true,"label":'
          '"no item named `TERM_GRACE` in scope"}],"rendered":"error: unresolved link to `TERM_GRACE`"}}')
    nameddir = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"error","code":{"code":'
                '"rustdoc::broken_intra_doc_links"},"message":"unresolved link to `crate::bash::vm::zsh::nameddir`","spans":'
                '[{"file_name":"crates/pi-shell/src/bash/store.rs","line_start":1243,"column_start":9,"is_primary":true,'
                '"label":"no item named `zsh` in module `vm`"}],"rendered":"error: unresolved link to '
                '`crate::bash::vm::zsh::nameddir`"}}')
    private_warning = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"warning","code":{"code":'
                       '"rustdoc::private_intra_doc_links"},"message":"public documentation for `value` links to private '
                       'item `ASSIGN_PREVIEW_BYTES`","spans":[{"file_name":"crates/pi-shell/src/bash/event.rs","line_start":'
                       '812,"column_start":23,"is_primary":true,"label":"this item is private"}],"rendered":"warning: public '
                       'documentation for `value` links to private item `ASSIGN_PREVIEW_BYTES`"}}')
    e0432 = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"error","code":{"code":"E0432"},'
             '"message":"unresolved import `nosuch`","spans":[{"file_name":"src/lib.rs","line_start":1,"column_start":5,'
             '"is_primary":true,"label":"use of unresolved module or unlinked crate `nosuch`"}],"rendered":'
             '"error[E0432]: unresolved import `nosuch`"}}')
    note_e0432 = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"failure-note","code":null,'
                  '"message":"For more information about this error, try `rustc --explain E0432`.","spans":[],"rendered":'
                  '"For more information about this error, try `rustc --explain E0432`."}}')
    artifact = '{"reason":"compiler-artifact","target":{"name":"clean","kind":["lib"]}}'
    finished_no, finished_yes = '{"reason":"build-finished","success":false}', '{"reason":"build-finished","success":true}'

    def docs(lines, code):
        p = os.path.join(d, "docs.jsonl")
        open(p, "w").write("\n".join(lines) + "\n")
        r = parse_docs("public", p, os.path.join(d, "docs-absent.log"), code, 1)
        return r["status"], r["failures"], r["note"]

    pl = "crates/pi-shell/src/lib.rs:36:1: unresolved link to 'NoSuchItemPlanted'"
    tg40 = "crates/pi-shell/src/session.rs:40:27: unresolved link to 'TERM_GRACE' (no item named 'TERM_GRACE' in scope)"
    tg42 = "crates/pi-shell/src/session.rs:42:46: unresolved link to 'TERM_GRACE' (no item named 'TERM_GRACE' in scope)"
    nd = ("crates/pi-shell/src/bash/store.rs:1243:9: unresolved link to 'crate::bash::vm::zsh::nameddir' "
          "(no item named 'zsh' in module 'vm')")
    check("docs: the planted link", docs([planted, finished_no], "101"),
          ("FAIL", [pl], "1 broken intra-doc link(s), to 1 distinct target(s)"))
    check("docs: two links, and a warning of another lint", docs([private_warning, tg % (40, 27), nameddir, finished_no], "101"),
          ("FAIL", [tg40, nd], "2 broken intra-doc link(s), to 2 distinct target(s)"))
    check("docs: one target linked twice", docs([tg % (40, 27), tg % (42, 46), finished_no], "101"),
          ("FAIL", [tg40, tg42], "2 broken intra-doc link(s), to 1 distinct target(s)"))
    # The lint's other form in the private build of run 45442475434: a link that names two items.
    ambiguous = ('{"reason":"compiler-message","package_id":"pi-shell","message":{"level":"error","code":{"code":'
                 '"rustdoc::broken_intra_doc_links"},"message":"`deref` is both a function and a macro","spans":[{"file_name":'
                 '"crates/pi-shell/src/bash/vm/state.rs","line_start":310,"column_start":26,"is_primary":true,"label":'
                 '"ambiguous link"}],"rendered":"error: `deref` is both a function and a macro"}}')
    check("docs: an ambiguous link", docs([ambiguous, finished_no], "101")[:2],
          ("FAIL", ["crates/pi-shell/src/bash/vm/state.rs:310:26: 'deref' is both a function and a macro (ambiguous link)"]))
    check("docs: another error", docs([e0432, note_e0432, finished_no], "101"),
          ("UNKNOWN", [], "exit 101, and no broken-link error: error[E0432]: unresolved import `nosuch`"))
    check("docs: clean", docs([artifact, finished_yes], "0")[:2], ("PASS", []))
    check("docs: exit 0 with no build-finished", docs([artifact], "0")[0], "UNKNOWN")
    check("docs: the time bound", docs([planted], "124")[0], "UNKNOWN")
    check("docs: no output", parse_docs("private", os.path.join(d, "absent.jsonl"), "x", "0", 1)["status"], "UNKNOWN")
    # parse_changelog on fix-changelogs.ts's own output: run 45370388127 (plant=changelog on 85936bf7)
    # with its diff of the planted file; the tool at 85936bf7 on a clean tagged repository, with an
    # argument it does not take, and outside a repository (git exits 128).
    six = ("Fixed 6 changelog(s) since v18.18.6-sami.20261123-214229 (check, not written):\n"
           + "".join(f"  packages/{p}/CHANGELOG.md: 0 promoted item(s), 0 merged duplicate heading(s), 0 dropped released "
                     f"duplicate(s), {e} removed empty heading(s){c}\n"
                     for p, e, c in (("agent", 0, ""), ("ai", 0, ", 18 collapsed release(s)"), ("browser-relay", 1, ""),
                                     ("coding-agent", 0, ", 9 collapsed release(s)"), ("natives", 0, ""),
                                     ("tui", 0, ", 5 collapsed release(s)"))))
    relay_diff = ("--- a/packages/browser-relay/CHANGELOG.md\n+++ b/packages/browser-relay/CHANGELOG.md\n@@ -2,8 +2,6 @@\n"
                  " \n ## [Unreleased]\n \n-### Planted empty heading\n-\n ## [18.18.2] - 2026-11-08\n \n ### Added\n")

    def clog(text, code, diff_text="", write_exit="0"):
        lp, dp = os.path.join(d, "changelog.log"), os.path.join(d, "changelog.diff")
        open(lp, "w").write(text)
        open(dp, "w").write(diff_text)
        return parse_changelog(lp, code, 1, "14", dp, write_exit)

    r = clog(six, "1", relay_diff)
    check("changelog: the planted heading", (r["status"], r["passed"], r["failed"], r["note"], r["failures"][2:3]),
          ("FAIL", 8, 6, "6 of 14 CHANGELOGs would be rewritten (since v18.18.6-sami.20261123-214229)",
           ["packages/browser-relay/CHANGELOG.md: 0 promoted item(s), 0 merged duplicate heading(s), 0 dropped released "
            "duplicate(s), 1 removed empty heading(s); from line 5: -### Planted empty heading | -"]))
    check("changelog: a file the write run left unchanged", r["failures"][:1] and r["failures"][0].endswith(
          "; the write run left it unchanged"), True)
    r = clog(six, "1", "", "1")
    check("changelog: the write run failed", (r["status"], r["failures"][2:3]), ("FAIL", [
          "packages/browser-relay/CHANGELOG.md: 0 promoted item(s), 0 merged duplicate heading(s), 0 dropped released "
          "duplicate(s), 1 removed empty heading(s); the write run failed (exit 1)"]))
    check("changelog: a list shorter than its count", clog(six.rsplit("  packages/tui", 1)[0], "1")["status"], "UNKNOWN")
    r = clog("Changelogs already clean since v1.0.0.\n", "0")
    check("changelog: clean", (r["status"], r["passed"], r["note"]), ("PASS", 14, "14 CHANGELOGs, clean since v1.0.0"))
    check("changelog: exit 0 with no clean line", clog("", "0")["status"], "UNKNOWN")
    check("changelog: an argument the tool does not take", (clog("Unknown argument: --bogus\n", "1")["status"],
          clog("Unknown argument: --bogus\n", "1")["note"]), ("UNKNOWN", "exit 1: Unknown argument: --bogus"))
    check("changelog: git failed", clog("Failed with exit code 128\n", "1")["note"], "exit 1: Failed with exit code 128")
    check("changelog: the time bound", clog(six, "124")["note"], "exit 124: the time bound or a signal ended it")
    # An internal compiler error: the level rustc's JSON gives one (rustc_errors Level::Bug).
    ice = json.dumps({"reason": "compiler-message", "package_id": "pi-shell", "message": {
        "level": "error: internal compiler error", "code": None, "message": "unexpected panic", "spans": [],
        "rendered": "error: internal compiler error: unexpected panic"}})
    check("docs: a link and an internal compiler error", docs([planted, ice, finished_no], "101"),
          ("FAIL", [pl], "1 broken intra-doc link(s), to 1 distinct target(s); and 1 other error(s), the first: "
                         "error: internal compiler error: unexpected panic"))
    check("docs: an internal compiler error alone", docs([ice, finished_no], "101"),
          ("UNKNOWN", [], "exit 101, and no broken-link error: error: internal compiler error: unexpected panic"))
    # The summary with these rows: the docs row's two units, each planted run's verdict, and a docs or
    # changelog job that reports nothing.
    docs_i = {json.load(open(os.path.join(res2, f)))["unit"]: f for f in os.listdir(res2)
              if json.load(open(os.path.join(res2, f)))["row"] == "docs"}
    log_i = [f for f in os.listdir(res2) if json.load(open(os.path.join(res2, f)))["row"] == "changelog"]
    check("the docs row's units", sorted(docs_i), ["private", "public"])
    docs_i = {u: docs_i.get(u, f"docs-{u}.json") for u in ("public", "private")}
    rc, out = summary2()
    check("summary: docs and changelog rows pass", ("| rustdoc intra-doc links (pi-shell) | **PASS** | 2 / 0 / 0 / 0 |" in out,
          "| CHANGELOG format (fix-changelogs --check) | **PASS** | 1 / 0 / 0 / 0 |" in out, rc), (True, True, 0))
    rc, out = summary2(plant_env="docs")
    check("summary: a planted docs run whose row passed", ("**Planted run (`plant=docs`)**" in out,
          "**THE CONTROL FAILED**: the row reads PASS, and these units do not read FAIL naming `NoSuchItemPlanted`: "
          "`public`, `private`." in out, rc), (True, True, 1))
    # On the real tree the row fails without the plant (run 45442475434: 21 and 46 links), so a FAIL
    # that does not name the plant must read as a control that failed.
    for u in ("public", "private"):
        json.dump(result("docs", u, "runner", "FAIL", "101", 1, 0, 1, failures=[tg40]), open(os.path.join(res2, docs_i[u]), "w"))
    rc, out = summary2(plant_env="docs")
    check("summary: a planted docs run whose units fail without naming the plant",
          ("**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `NoSuchItemPlanted`: "
           "`public`, `private`." in out, rc), (True, 1))
    json.dump(result("docs", "public", "runner", "FAIL", "101", 1, 0, 1, failures=[pl]), open(os.path.join(res2, docs_i["public"]), "w"))
    rc, out = summary2(plant_env="docs")
    check("summary: a planted docs run that only one unit names",
          ("| rustdoc intra-doc links (pi-shell) | **FAIL** | 0 / 0 / 2 / 0 |" in out,
           "**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `NoSuchItemPlanted`: `private`." in out,
           rc), (True, True, 1))
    json.dump(result("docs", "private", "runner", "FAIL", "101", 1, 0, 2, failures=[pl, tg40]),
              open(os.path.join(res2, docs_i["private"]), "w"))
    rc, out = summary2(plant_env="docs")
    check("summary: a planted docs run that both units name",
          ("The control caught it: the row reads FAIL, and each of its units (`public`, `private`) names `NoSuchItemPlanted`." in out,
           f"`private` (runner): FAILED `{tg40}`: **NEW**" in out, rc), (True, True, 1))
    six_r = clog(six, "1", relay_diff)
    json.dump(dict(six_r, failures=[f for f in six_r["failures"] if "browser-relay" not in f]), open(os.path.join(res2, log_i[0]), "w"))
    rc, out = summary2(plant_env="changelog")
    check("summary: a planted changelog run whose row fails without naming the plant",
          ("**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `Planted empty heading`: "
           "`changelogs`." in out, rc), (True, 1))
    json.dump(six_r, open(os.path.join(res2, log_i[0]), "w"))
    rc, out = summary2(plant_env="changelog")
    check("summary: a planted changelog run that names the plant",
          ("The control caught it: the row reads FAIL, and each of its units (`changelogs`) names `Planted empty heading`." in out,
           rc), (True, 1))
    rc, out = summary2(drop=[f for f in docs_i.values() if os.path.exists(os.path.join(res2, f))] + log_i)
    check("summary: no docs or changelog result", ("| rustdoc intra-doc links (pi-shell) | **UNKNOWN** | 0 / 0 / 0 / 2 |" in out,
          "| CHANGELOG format (fix-changelogs --check) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out,
          "`public` (runner): UNKNOWN: no result" in out, "`private` (runner): UNKNOWN: no result" in out,
          "`changelogs` (runner): UNKNOWN: no result" in out, rc), (True, True, True, True, True, 1))

    if fails:
        for f in fails:
            print(f"SELFTEST FAIL {f}")
        sys.exit(1)
    print("SELFTEST OK: libtest (60 s warning, hang, kill, self-skip), nextest, bun and clippy counters, the "
          "platform report reader, the tree's real skip lines and partial passes, the shard assignment and "
          "per-user weights, the summary's UNKNOWN for a unit no job or two jobs reported, the known and flaky "
          "entries, skip-forms and skip-lines with their controls, the gVisor rows and their known skips, the "
          "docs and changelog rows with their planted controls, and the Rust tests' rows from their jobs' "
          "conclusions")


# The docs row (docs.sh): `cargo doc --no-deps -p pi-shell` with -D rustdoc::broken_intra_doc_links,
# once as published (public) and once with --document-private-items (private), each a unit. cargo's
# JSON names each diagnostic's lint, so every form of that lint's error is read, not only
# `unresolved link to`.
DOCS_LINT = "rustdoc::broken_intra_doc_links"
DOCS_UNITS = ("public", "private")
# The changelog row (changelog.sh): scripts/fix-changelogs.ts --check prints the first line, or the
# second and then each file it would rewrite, one a line; anything else is the tool's own error.
CHANGELOG_CLEAN = re.compile(r"^Changelogs already clean since (.*)\.$", re.M)
CHANGELOG_FIXED = re.compile(r"^Fixed (\d+) changelog\(s\) since (.*) \(check, not written\):$", re.M)
CHANGELOG_FILE = re.compile(r"^  (\S+): (\d+ promoted item\(s\), .*)$", re.M)
# Each row's control, the dispatch input `plant`: row key -> (the file, the line the job adds to it
# before it runs, the words a failure of the row must then hold). pi-shell's first public module
# gets a doc comment that links to no item; a small CHANGELOG gets an empty category heading after
# its first `## [` heading ([Unreleased] in this tree), which fix-changelogs removes.
PLANTS = {
    "docs": ("crates/pi-shell/src/lib.rs", "/// See [`NoSuchItemPlanted`].", "NoSuchItemPlanted"),
    "changelog": ("packages/browser-relay/CHANGELOG.md", "### Planted empty heading", "Planted empty heading"),
}


def stopped(exit_code):
    """Whether the time bound, a signal or a missing command ended a run (parse_plain's rule)."""
    return exit_code in ("124", "125", "126", "127", "137") or (exit_code.isdigit() and int(exit_code) > 128)


def first_line(text):
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def parse_docs(unit, stream, log, exit_code, secs, row="docs"):
    """`cargo doc --message-format=json` (STREAM, its stdout) and its stderr (LOG). FAIL names each
    error of rustdoc's broken_intra_doc_links lint as `path:line:col: message (label)`. PASS needs
    exit 0, cargo's build-finished with success and no error. Any other end is UNKNOWN with its first
    error line. Backticks become ' so that a name reads as one code span in the summary."""
    try:
        text = open(stream, encoding="utf-8", errors="replace").read()
    except OSError:
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note="no cargo output")
    try:
        err = open(log, encoding="utf-8", errors="replace").read()
    except OSError:
        err = ""
    links, targets, others, finished = [], set(), [], None
    for line in text.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if not isinstance(m, dict):
            continue
        if m.get("reason") == "build-finished":
            finished = m.get("success")
        d = m.get("message") if m.get("reason") == "compiler-message" else None
        # rustc gives an internal compiler error the level `error: internal compiler error`.
        if not isinstance(d, dict) or not str(d.get("level", "")).startswith("error"):
            continue
        if (d.get("code") or {}).get("code") == DOCS_LINT:
            spans = d.get("spans") or [{}]
            sp = next((s for s in spans if s.get("is_primary")), spans[0])
            name = f"{sp.get('file_name', '?')}:{sp.get('line_start', '?')}:{sp.get('column_start', '?')}: {d.get('message', '')}"
            if sp.get("label"):
                name += f" ({sp['label']})"
            name = name.replace("`", "'")
            if name not in links:
                links.append(name)
                targets.add(d.get("message", ""))
        elif not d.get("message", "").startswith("aborting due to"):
            others.append(first_line(d.get("rendered") or d.get("message", "")))
    if stopped(exit_code):
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note=f"exit {exit_code}: the time bound or a signal ended it")
    if links:
        note = f"{len(links)} broken intra-doc link(s), to {len(targets)} distinct target(s)"
        if others:
            note += f"; and {len(others)} other error(s), the first: {others[0]}"
        return result(row, unit, "runner", "FAIL", exit_code, secs, 0, len(links), failures=links, note=note)
    if exit_code == "0" and finished is True and not others:
        return result(row, unit, "runner", "PASS", exit_code, secs, 1, note="no broken intra-doc link")
    why = others[0] if others else next((line.strip() for line in err.splitlines() if line.startswith("error")), "")
    if not why and exit_code == "0":
        why = "cargo reported no successful build-finished"
    return result(row, unit, "runner", "UNKNOWN", exit_code, secs,
                  note=f"exit {exit_code}, and no broken-link error: {why or 'no error line'}")


def changed_lines(diff_path):
    """{path: (the old file's line of the first change, the first 4 changed lines)} of each file's
    first hunk in `diff -u` output whose new-file label is b/<path>. Hunk lengths are counted, so a
    removed line that starts `-- ` is not read as a file header."""
    out, cur = {}, None
    try:
        lines = open(diff_path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        return out
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("--- ") and i + 1 < len(lines) and lines[i + 1].startswith("+++ b/"):
            cur = lines[i + 1][len("+++ b/"):]
            i += 2
            continue
        m = re.match(r"@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@", line)
        i += 1
        if not m or cur is None:
            continue
        old, n_old, n_new = int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1)
        first, changed = None, []
        while (n_old > 0 or n_new > 0) and i < len(lines):
            tag = lines[i][:1] or " "
            if tag in "-+" and first is None:
                first = old
            if tag in "-+" and len(changed) < 4:
                changed.append(lines[i])
            if tag in " -":
                old += 1
                n_old -= 1
            if tag in " +":
                n_new -= 1
            i += 1
        if cur not in out and first is not None:
            out[cur] = (first, changed)
    return out


def parse_changelog(log, exit_code, secs, files, diff, write_exit="0", row="changelog", unit="changelogs"):
    """fix-changelogs.ts --check (LOG, its stdout and stderr) over FILES CHANGELOGs. PASS on exit 0
    with its clean line; FAIL on exit 1 with its list of the files it would rewrite, each named with
    its counts and the first lines the rewrite changes (DIFF: changelog.sh's `diff -u` of each file
    before and after the tool's write mode, which exited WRITE_EXIT); any other end (the tool's own
    error) is UNKNOWN with its message."""
    try:
        text = open(log, encoding="utf-8", errors="replace").read()
    except OSError:
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note="no log")
    n = int(files)
    if stopped(exit_code):
        return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note=f"exit {exit_code}: the time bound or a signal ended it")
    clean, fixed = CHANGELOG_CLEAN.search(text), CHANGELOG_FIXED.search(text)
    if exit_code == "0" and clean and not fixed:
        return result(row, unit, "runner", "PASS", exit_code, secs, n, note=f"{n} CHANGELOGs, clean since {clean.group(1)}")
    listed = CHANGELOG_FILE.findall(text[fixed.end():]) if fixed else []
    if exit_code == "1" and listed and len(listed) == int(fixed.group(1)):
        heads = changed_lines(diff)
        fails = []
        for path, counts in listed:
            h = heads.get(path)
            gone = "the write run left it unchanged" if write_exit == "0" else f"the write run failed (exit {write_exit})"
            where = f"from line {h[0]}: " + " | ".join(h[1]) if h else gone
            fails.append(f"{path}: {counts}; {where}"[:400].replace("`", "'"))
        note = f"{len(listed)} of {n} CHANGELOGs would be rewritten (since {fixed.group(2)})"
        extra = sorted(set(heads) - {p for p, _ in listed})
        if extra:
            note += "; the write run also changed " + ", ".join(extra)
        return result(row, unit, "runner", "FAIL", exit_code, secs, n - len(listed), len(listed), failures=fails, note=note)
    said = " / ".join(line.strip() for line in text.splitlines() if line.strip())
    return result(row, unit, "runner", "UNKNOWN", exit_code, secs, note=f"exit {exit_code}: {said[:400] or 'no output'}")


def cmd_plant(what, tree):
    """Puts a row's planted fault (PLANTS) in TREE and prints where."""
    path, text, _ = PLANTS[what]
    p = os.path.join(tree, path)
    lines = open(p, encoding="utf-8").read().split("\n")
    if what == "docs":
        at, new = next((i for i, line in enumerate(lines) if line.startswith("pub mod ")), None), [text]
    else:
        at, new = next((i + 1 for i, line in enumerate(lines) if line.startswith("## [")), None), ["", text]
    if at is None:
        sys.exit(f"::error::{path} has no place for the {what} plant")
    lines[at:at] = new
    open(p, "w", encoding="utf-8").write("\n".join(lines))
    print(f"PLANT {what}: {path}:{at + len(new)}: {text}")


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
    elif c == "gv-control":
        print(json.dumps(gv_control(*a)))
    elif c == "bun":
        print(json.dumps(parse_bun(*a)))
    elif c == "plain":
        print(json.dumps(parse_plain(*a)))
    elif c == "clippy-crates":
        clippy_crates(a[0], a[1:])
    elif c == "clippy":
        print(json.dumps(parse_clippy(*a)))
    elif c == "clippy-baseline":
        clippy_baseline_lines(*a)
    elif c == "platforms":
        cmd_platforms(*a)
    elif c == "summary":
        sys.exit(cmd_summary(*a))
    elif c == "skip-forms":
        print(json.dumps(cmd_skip_forms(*a)))
    elif c == "skip-lines":
        print(json.dumps(cmd_skip_lines(*a)))
    elif c == "flaky-failed":
        for f in flaky_failed(*a):
            print(f)
    elif c == "retried":
        print(record_retry(*a))
    elif c == "junit-merge":
        print(f"{junit_merge(a[0], a[1:])} test cases in {a[0]}")
    elif c == "docs":
        print(json.dumps(parse_docs(*a)))
    elif c == "changelog":
        print(json.dumps(parse_changelog(*a)))
    elif c == "plant":
        cmd_plant(*a)
    elif c == "selftest":
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
