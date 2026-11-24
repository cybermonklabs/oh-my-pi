#!/usr/bin/env python3
"""Platform checks: plan a dispatch, classify its nextest results, and scan logs before upload.

  pc.py plan               check the inputs of a dispatch or a call (PC_* environment
                           variables) as given, tell a dispatch from a call, and write the
                           build and leg matrices as step outputs
  pc.py selftest           the controls on hand-made inputs: classifier rows with known
                           verdicts, planted tokens the scan must find, and the plan's scope
                           rows; exit 1 on a miss (controls.sh runs the same classifier on real
                           nextest output)
  pc.py scan PATH...       exit 1 when a file under PATH holds a private key block, a token
                           shape, the run's own token or an ACTIONS_* value; prints file, line
                           and pattern name only, never the text. Runs the planted-token
                           control first and exits 2 when the scan misses its own canaries.
  pc.py brief JUNIT        one console line for one leg's JUnit report
  pc.py verdict DIR        the verdict of one leg's results (DIR: meta.env, list.json,
                           junit.xml), then one line per test
  pc.py report RESULTS BUILDS OUT
                           the verdicts as markdown on stdout, plus OUT/summary.md,
                           OUT/verdicts.tsv and OUT/tests.tsv; exit 1 unless the run passed

Verdicts follow the PP109 classifier (scratch-pp109-run.sh), read from nextest's test list
and JUnit report instead of libtest's text. Per tree, platform and user, over every repeat:
  TIMEOUT  a test the filter selects ran past the per-test time bound and nextest ended it
           (nextest's own TIMEOUT status, with the test named)
  FAIL     a test the filter selects failed in some repeat
  UNKNOWN  the leg was cut short by its deadline (leg.sh stops nextest in time for it to write
           its report before the job limit) with no failure in the repeats it finished; the
           repeat it stopped is never counted
  UNKNOWN  the filter selected no test that runs here (none, or only #[ignore] ones), no test
           list, a repeat with no JUnit report (build failed, crash, job ended), a selected
           test missing from a report or unable to start, a reported test the list did not
           select
  FLAKY    every selected test passed in every repeat, some only on a nextest retry
  PASS     every selected test passed on its first try in every repeat, at least one ran;
           #[ignore] tests are counted apart, never as a pass or a failure
"""

import json
import os
import random
import re
import string
import sys
import tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
RUNNERS = {"macos": "macos-15", "windows": "windows-2025", "ubuntu": "ubuntu-24.04"}
# A nextest filterset: names, regexes and operators only. No quotes, backticks, semicolons,
# redirections or newlines: a public run shows its inputs, and the scripts pass this one on.
FILTER_OK = re.compile(r"^[A-Za-z0-9_:/^$.*+?|&!=~(),#{}\[\] \\-]{1,500}$")
CRATES_OK = re.compile(r"^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$")
WHOLE = re.compile(r"^(0|[1-9][0-9]{0,3})$")
STRESS = re.compile(r"@stress-([0-9]+)$")
MAX_LEGS = 200
# nextest's JUnit types (nextest-runner reporter/aggregator/junit.rs): a timed-out test is
# `test timeout`; a test failed for leaked handles is an <error> of this type.
TIMEOUT_TYPE = "test timeout"
LEAK_FAIL = "leaked handles so was marked failed"


def die(msg):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def whole(name, value, lo, hi):
    """A whole number exactly as the scripts will read it: no sign, spaces or leading zeros."""
    if not WHOLE.fullmatch(value or ""):
        die(f"{name} must be a whole number from {lo} to {hi} written plainly, not {value!r}")
    n = int(value)
    if not lo <= n <= hi:
        die(f"{name} must be from {lo} to {hi}, not {n}")
    return n


# ---------------------------------------------------------------- plan

THIS_FILE = ".github/workflows/platform-checks.yml"


def scope(env):
    """(called, refusal) for this run.

    A dispatch of this file runs only from the ref platform-checks, whose caches no release ref
    reads. A call is told apart by github.workflow_ref, which names the caller's file: it runs in
    the caller's ref with the cache access the caller gives it (cache-mode), and the cache-prune
    job, which deletes this ref's superseded caches, does not run.
    """
    workflow = env.get("GITHUB_WORKFLOW_REF", "").split("@", 1)[0]
    if not workflow:
        return False, "GITHUB_WORKFLOW_REF is empty, so a dispatch cannot be told from a call"
    if not workflow.endswith("/" + THIS_FILE):
        return True, ""
    if env.get("GITHUB_REF") != "refs/heads/platform-checks":
        return False, (f"dispatch this workflow with --ref platform-checks, not {env.get('GITHUB_REF')}: "
                       "its caches and its permissions are scoped to that ref")
    return False, ""


# The settings a dispatch gives in one `options` input, because GitHub takes at most 10
# workflow_dispatch inputs: `name=value` pairs separated by spaces, in any order. Each name is a
# call input of this workflow too, and a caller passes it on its own. The value of each is its
# PC_ environment variable's, so a dispatch and a call reach the jobs the same way.
OPTIONS = ("legs", "retries", "flaky_passes", "partitions", "as_root", "keep_success_output", "skip_bash_install")
OPTION_OK = re.compile(r"[A-Za-z0-9_]+=[A-Za-z0-9_.,:/-]*")


def options(env):
    """{name: value} of the `options` input (PC_OPTIONS), checked against OPTIONS. Empty on a call,
    where each setting is an input of its own. Dies on a pair that does not parse, a name that is
    not a setting, or a name given twice."""
    text = env.get("PC_OPTIONS", "").strip()
    if not text:
        return {}
    got = {}
    for pair in text.split():
        if not OPTION_OK.fullmatch(pair):
            die(f"options: [{pair}] is not name=value, of A-Z a-z 0-9 _ . , : / -")
        name, _, value = pair.partition("=")
        if name not in OPTIONS:
            die(f"options: {name} is no setting; one of {', '.join(OPTIONS)}")
        if name in got:
            die(f"options: {name} is given twice")
        got[name] = value
    return got


def setting(env, opts, name, default):
    """One setting's value: from `options` on a dispatch, else from its own input, else default."""
    if name in opts:
        return opts[name]
    value = env.get("PC_" + name.upper(), "")
    return value if value != "" else default


def plan():
    """Check each input exactly as the jobs will use it (nothing is stripped or rewritten), and
    print each setting the jobs need, whether it came from `options` or from its own input."""
    env = os.environ
    called, refusal = scope(env)
    if refusal:
        die(refusal)
    opts = options(env)
    if called and opts:
        die("options is a dispatch input; a caller passes each setting on its own")
    head, base, plant = env.get("PC_HEAD", ""), env.get("PC_BASE", ""), env.get("PC_PLANT", "")
    if not SHA.fullmatch(head):
        die("head must be a full 40-character commit id")
    for name, value in (("base", base), ("plant", plant)):
        if value and not SHA.fullmatch(value):
            die(f"{name} must be empty or a full 40-character commit id")
    platforms = env.get("PC_PLATFORMS", "").split(",")
    if len(set(platforms)) != len(platforms) or any(p not in RUNNERS for p in platforms):
        die(f"platforms must be a comma-separated list of {', '.join(RUNNERS)}, with no spaces")
    if not CRATES_OK.fullmatch(env.get("PC_CRATES", "")):
        die("crates must be a comma-separated list of package names, with no spaces")
    if not FILTER_OK.fullmatch(env.get("PC_FILTER", "")):
        die("filter must be a nextest filterset of at most 500 characters from "
            "A-Z a-z 0-9 _ : / ^ $ . * + ? | & ! = ~ ( ) , # { } [ ] \\ - and space")
    repeat = whole("repeat", env.get("PC_REPEAT"), 1, 500)
    legs = whole("legs", setting(env, opts, "legs", "1"), 1, 20)
    # partitions N splits the selected tests into N parallel legs (nextest --partition count:k/N);
    # each partition runs every repeat, split over `legs` as before.
    partitions = whole("partitions", setting(env, opts, "partitions", "1"), 1, 20)
    if legs > repeat:
        die(f"legs ({legs}) must not exceed repeat ({repeat})")
    retries = whole("retries", setting(env, opts, "retries", "0"), 0, 5)
    timeout_minutes = whole("timeout_minutes", env.get("PC_TIMEOUT_MINUTES"), 1, 60)
    flags = {}
    for name in ("flaky_passes", "as_root", "keep_success_output", "skip_bash_install"):
        value = setting(env, opts, name, "false")
        if value not in ("true", "false"):
            die(f"{name} must be true or false, not [{value}]")
        flags[name] = value
    as_root = flags["as_root"] == "true"

    # Leg k of L runs its share of the repeats as one nextest stress run.
    shares, offset = [], 0
    for k in range(1, legs + 1):
        count = repeat // legs + (1 if k <= repeat % legs else 0)
        shares.append((k, offset, count))
        offset += count
    out, total = {}, 0
    for p in RUNNERS:
        builds, leg_rows = [], []
        if p in platforms:
            for tree in ["head"] + (["base"] if base else []):
                builds.append({"platform": p, "runner": RUNNERS[p], "tree": tree})
            for tree in ["head"] + (["plant"] if plant else []) + (["base"] if base else []):
                for who in ["user"] + (["root"] if as_root and p == "ubuntu" else []):
                    n = 0
                    for part in range(1, partitions + 1):
                        for k, off, count in shares:
                            n += 1
                            leg_rows.append({
                                "platform": p, "runner": RUNNERS[p], "tree": tree,
                                "build": "base" if tree == "base" else "head", "who": who,
                                "leg": n, "offset": off, "count": count,
                                "partition": part, "partitions": partitions,
                            })
        out[f"builds_{p}"], out[f"legs_{p}"] = builds, leg_rows
        total += len(leg_rows)
    if total > MAX_LEGS:
        die(f"{total} test legs; at most {MAX_LEGS}: lower legs or platforms")
    compact = {"separators": (",", ":")}
    for k, v in out.items():
        print(f"{k}={json.dumps(v, **compact)}")
    print(f"builds={json.dumps([b for p in RUNNERS for b in out[f'builds_{p}']], **compact)}")
    print(f"legs={json.dumps([l for p in RUNNERS for l in out[f'legs_{p}']], **compact)}")
    print(f"called={str(called).lower()}")
    # Each setting the platform jobs take, resolved here: a dispatch gives some of them in
    # `options`, a caller as inputs of its own, and the jobs read only these.
    print(f"legs_n={legs}")
    print(f"retries={retries}")
    print(f"timeout_minutes={timeout_minutes}")
    print(f"partitions={partitions}")
    for name, value in flags.items():
        print(f"{name}={value}")
    print(f"PLAN {sum(len(out[f'builds_{p}']) for p in RUNNERS)} build jobs, {total} test legs; "
          + (f"called by {env.get('GITHUB_WORKFLOW_REF')}" if called else "a dispatch"), file=sys.stderr)


# ---------------------------------------------------------------- nextest results


def junit_runs(path):
    """{sub-run index: {(binary id, test name): status}} for one JUnit report.

    A stress run names each suite `<binary id>@stress-<N>` (N from 0); a plain run is sub-run 0.
    Status: PASS, FLAKY, FAIL, TIMEOUT, ERROR (could not start) or SKIPPED. Only nextest's
    `type` attribute decides TIMEOUT; the message (a panic line naming the test) never does.
    """
    runs = defaultdict(dict)
    for suite in ET.parse(path).getroot().iter("testsuite"):
        m = STRESS.search(suite.get("name", ""))
        index = int(m.group(1)) if m else 0
        for case in suite.iter("testcase"):
            binary = case.get("classname") or STRESS.sub("", suite.get("name", ""))
            key = (binary, case.get("name", ""))
            types = {child.tag: [] for child in case}
            for child in case:
                types[child.tag].append(child.get("type") or "")
            timed_out = TIMEOUT_TYPE in types.get("failure", []) + types.get("rerunFailure", [])
            if "skipped" in types:
                status = "SKIPPED"
            elif "error" in types:
                status = "FAIL" if any(LEAK_FAIL in t for t in types["error"]) else "ERROR"
            elif "failure" in types:
                status = "TIMEOUT" if timed_out else "FAIL"
            elif "flakyFailure" in types or "flakyError" in types:
                status = "FLAKY"
            else:
                status = "PASS"
            runs[index][key] = status
    return dict(runs)


def list_sets(path):
    """(runnable, ignored) test sets the filter selects, from `nextest list --run-ignored all`."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    runnable, ignored = set(), set()
    for binary_id, suite in data.get("rust-suites", {}).items():
        cases = suite.get("testcases", {})
        items = cases.items() if isinstance(cases, dict) else ((c.get("name"), c) for c in cases)
        for name, case in items:
            if (case.get("filter-match") or {}).get("status") != "matches":
                continue
            (ignored if case.get("ignored") else runnable).add((binary_id, name))
    return runnable, ignored


def classify(runnable, ignored, reports, repeat, listed=True, cut_short=False):
    """One group's verdict: one tree, platform and user over every repeat.

    reports: {repeat index from 1: {key: status}, or None when that repeat left no report}.
    Returns (verdict line, {key: per-test row}).
    """
    if not listed:
        return "UNKNOWN (no test list: no archive, the list failed, or the leg did not run) run=? ignored=?", {}
    n_ign = len(ignored)
    if not runnable:
        return f"UNKNOWN (ran nothing: the filter selects no test that runs here) run=0 ignored={n_ign}", {}
    rows = {key: {"PASS": 0, "FLAKY": 0, "FAIL": 0, "TIMEOUT": 0, "ERROR": 0, "MISSING": 0} for key in runnable}
    no_report, extra = [], set()
    for i in range(1, repeat + 1):
        got = reports.get(i)
        if got is None:
            no_report.append(i)
            for key in runnable:
                rows[key]["MISSING"] += 1
            continue
        ran = {k: v for k, v in got.items() if v != "SKIPPED"}
        extra |= set(ran) - runnable
        for key in runnable:
            status = ran.get(key)
            rows[key]["MISSING" if status is None else status] += 1
    tests = {}
    for key, c in rows.items():
        if c["TIMEOUT"]:
            v = "TIMEOUT"
        elif c["FAIL"]:
            v = "FAIL"
        elif c["ERROR"] or c["MISSING"]:
            v = "UNKNOWN"
        elif c["FLAKY"]:
            v = "FLAKY"
        else:
            v = "PASS"
        tests[key] = dict(c, verdict=v, passed=c["PASS"] + c["FLAKY"], of=repeat)
    counts = defaultdict(int)
    for t in tests.values():
        counts[t["verdict"]] += 1

    def named(v):
        return ", ".join(sorted(f"{b} {n}" for (b, n), t in tests.items() if t["verdict"] == v)[:5])

    tail = f"run={len(runnable)} ignored={n_ign}"
    done = repeat - len(no_report)
    cut = f"cut short by the leg's deadline after {done} of {repeat} repeats; the repeat it stopped is not counted"
    # A failure in a finished repeat stands even when the leg was cut short.
    if counts["TIMEOUT"]:
        return f"TIMEOUT ({counts['TIMEOUT']} past the time bound: {named('TIMEOUT')}) {tail}" + (f" ({cut})" if cut_short else ""), tests
    if counts["FAIL"]:
        return f"FAIL ({counts['FAIL']} failed: {named('FAIL')}) {tail}" + (f" ({cut})" if cut_short else ""), tests
    if cut_short:
        return f"UNKNOWN ({cut}) {tail}", tests
    if no_report:
        shown = ",".join(map(str, no_report[:10])) + ("..." if len(no_report) > 10 else "")
        return f"UNKNOWN (no JUnit report for repeat {shown}) {tail}", tests
    if extra:
        return f"UNKNOWN (the reports hold {len(extra)} tests the list did not select) {tail}", tests
    if counts["UNKNOWN"]:
        return f"UNKNOWN ({counts['UNKNOWN']} tests missing from a report or not started: {named('UNKNOWN')}) {tail}", tests
    if counts["FLAKY"]:
        return f"FLAKY ({counts['FLAKY']} passed only on a retry: {named('FLAKY')}) {tail}", tests
    return f"PASS ({len(runnable)} passed in {repeat} of {repeat} repeats) {tail}", tests


def brief(path):
    try:
        runs = junit_runs(path)
    except (OSError, ET.ParseError) as err:
        print(f"no JUnit report ({type(err).__name__})")
        return
    c = defaultdict(int)
    for statuses in runs.values():
        for v in statuses.values():
            c[v] += 1
    parts = [f"{k.lower()} {c[k]}" for k in ("PASS", "FLAKY", "FAIL", "TIMEOUT", "ERROR", "SKIPPED") if c[k]]
    print(f"{len(runs)} sub-run(s): " + (", ".join(parts) or "no tests"))


def read_kv(path):
    out = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def leg_results(d, offset, count):
    """(runnable, ignored, {repeat: statuses or None}, cut_short, note) for one leg's folder;
    runnable is None when the leg left no usable test list."""
    meta = read_kv(d / "meta.env")
    reports = {offset + s + 1: None for s in range(count)}
    if meta.get("list_exit") != "0" or not (d / "list.json").is_file():
        return None, None, reports, False, meta.get("note") or "no results (the leg failed early, or the scan refused its logs)"
    try:
        runnable, ignored = list_sets(d / "list.json")
    except (OSError, ValueError) as err:
        return None, None, reports, False, f"test list unreadable ({type(err).__name__})"
    note = ""
    try:
        runs = junit_runs(d / "junit.xml") if (d / "junit.xml").is_file() else {}
    except ET.ParseError:
        runs, note = {}, "JUnit report unreadable"
    cut = meta.get("cancelled") == "deadline"
    if cut and runs:
        # The repeat the deadline stopped is no repeat: the tests it stopped are not failures.
        runs.pop(max(runs))
    for s in range(count):
        reports[offset + s + 1] = runs.get(s)
    return runnable, ignored, reports, cut, note or meta.get("note", "")


def verdict(d):
    d = Path(d)
    meta = read_kv(d / "meta.env")
    offset, count = int(meta.get("offset", "0")), int(meta.get("count", "1"))
    runnable, ignored, reports, cut, _ = leg_results(d, offset, count)
    line, tests = classify(runnable or set(), ignored or set(), {i - offset: r for i, r in reports.items()},
                           count, runnable is not None, cut)
    print(line)
    for (binary, name), t in sorted(tests.items()):
        print(f"  {binary} {name} {t['verdict']} {t['passed']}/{t['of']}")


# ---------------------------------------------------------------- report


def group_results(results_dir, platform, tree, who, members, repeat, images):
    """(runnable, ignored, reports, listed, cut, notes) of one tree, platform and user over its legs.

    The legs of one partition run the same tests (their lists must agree); the partitions'
    lists must not share a test, and the group's tests are their union. A repeat has a report
    only when every partition reported it, and its statuses are the partitions' together.
    """
    parts = defaultdict(list)
    for leg in members:
        parts[leg.get("partition", 1)].append(leg)
    runnable, ignored, notes = set(), set(), []
    reports = {i: {} for i in range(1, repeat + 1)}
    listed, cut = True, False
    for part, legs in sorted(parts.items()):
        pr = pi = None
        preps = {}
        for leg in legs:
            d = Path(results_dir) / f"pc-results-{platform}-{tree}-{who}-{leg['leg']}"
            meta = read_kv(d / "meta.env")
            if meta.get("image"):
                images[platform].add(meta["image"])
            if d.is_dir() and [meta.get(k) for k in ("platform", "tree", "who", "leg")] != [platform, tree, who, str(leg["leg"])]:
                listed = False
                notes.append(f"leg {leg['leg']}: its meta.env names another leg")
                continue
            r, ig, reps, leg_cut, note = leg_results(d, leg["offset"], leg["count"])
            preps.update(reps)
            cut = cut or leg_cut
            if note:
                notes.append(f"leg {leg['leg']}: {note}")
            if r is None:
                listed = False
            elif pr is None:
                pr, pi = r, ig
            elif (r, ig) != (pr, pi):
                listed = False
                notes.append(f"leg {leg['leg']}: its test list differs from another leg's")
        if pr is not None:
            if runnable & pr or ignored & pi:
                listed = False
                notes.append(f"partition {part}: its test list shares tests with another partition's")
            runnable |= pr
            ignored |= pi
        for i in range(1, repeat + 1):
            got = preps.get(i)
            reports[i] = None if got is None or reports[i] is None else {**reports[i], **got}
    return runnable, ignored, reports, listed, cut, notes


def report(results_dir, builds_dir, out_dir):
    env = os.environ
    repeat = int(env["PC_REPEAT"])
    legs = json.loads(env["PC_LEGS_JSON"])
    builds = json.loads(env["PC_BUILDS_JSON"])
    flaky_passes = env.get("PC_FLAKY_PASSES") == "true"
    passing = ("PASS", "FLAKY") if flaky_passes else ("PASS",)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    md = []
    ok = True

    md.append("## Commits")
    md.append("")
    md.append("| what | commit |")
    md.append("|---|---|")
    md.append(f"| workflow ({env.get('GITHUB_REF_NAME', '?')}) | `{env.get('GITHUB_SHA', '?')}` |")
    md.append(f"| head | `{env['PC_HEAD']}` |")
    md.append(f"| base | `{env.get('PC_BASE') or '-'}` |")
    if env.get("PC_PLANT"):
        md.append(f"| plant: its own change applied to head | `{env['PC_PLANT']}`, planted tree `{env.get('PC_PLANT_TREE') or '?'}` |")
    md.append("")
    md.append(f"crates `{env['PC_CRATES']}`, filter `{env['PC_FILTER']}`, {repeat} repeat(s) over "
              f"{env['PC_LEGS']} leg(s), nextest retries {env['PC_RETRIES']} (a pass on a retry "
              f"{'counts as a pass' if flaky_passes else 'fails the run'}), time bound per test "
              f"{env['PC_TIMEOUT_MINUTES']} min, as root on ubuntu: {env['PC_AS_ROOT']}")
    md.append("")

    images = defaultdict(set)
    md.append("## Builds")
    md.append("")
    md.append("| platform | tree | result | cargo cache | build s | plant build s | image | rustc |")
    md.append("|---|---|---|---|---|---|---|---|")
    for b in builds:
        kv = read_kv(Path(builds_dir) / f"pc-build-{b['platform']}-{b['tree']}" / "build.env")
        if not kv:
            ok = False
            md.append(f"| {b['platform']} | {b['tree']} | UNKNOWN (no build record: the job failed early, "
                      "or the scan refused its logs) | | | | | |")
            continue
        images[b["platform"]].add(kv.get("image", "?"))
        result = "built" if kv.get("exit") == "0" else f"FAILED (exit {kv.get('exit', '?')})"
        if kv.get("exit") != "0":
            ok = False
        if kv.get("plant_exit", "") not in ("", "0"):
            ok = False
            result += f"; plant: {kv['plant_exit']}"
        want = env.get("PC_BASE") if b["tree"] == "base" else env["PC_HEAD"]
        if kv.get("sha") != want:
            ok = False
            result += f"; built {kv.get('sha', '?')}, not {want}"
        if env.get("PC_PLANT") and b["tree"] == "head" and kv.get("plant_tree") != env.get("PC_PLANT_TREE"):
            ok = False
            result += f"; planted tree {kv.get('plant_tree', '?')}, not {env.get('PC_PLANT_TREE')}"
        if kv.get("cache_hit") == "true":
            cache = "hit (exact key)"
        elif kv.get("restored_deps", "0") != "0":
            cache = f"hit (key prefix; {kv['restored_deps']} dependency files restored)"
        else:
            cache = "miss (nothing restored)"
        md.append(f"| {b['platform']} | {b['tree']} | {result} | {cache} | {kv.get('seconds', '?')} | "
                  f"{kv.get('plant_seconds', '-')} | {kv.get('image', '?')} | {kv.get('rustc', '?')} |")
    md.append("")

    groups = defaultdict(list)
    for leg in legs:
        groups[(leg["platform"], leg["tree"], leg["who"])].append(leg)
    verdict_rows, test_rows, group_tests, group_lines = [], [], {}, {}
    md.append("## Verdicts")
    md.append("")
    md.append("| platform | tree | user | verdict |")
    md.append("|---|---|---|---|")
    for (platform, tree, who), members in groups.items():
        runnable, ignored, reports, listed, cut, notes = group_results(results_dir, platform, tree, who, members, repeat, images)
        line, tests = classify(runnable, ignored, reports, repeat, listed, cut)
        if notes:
            line += " (" + "; ".join(notes) + ")"
        group_tests[(platform, tree, who)] = tests
        group_lines[(platform, tree, who)] = line
        verdict_rows.append((platform, tree, who, line))
        md.append(f"| {platform} | {tree} | {who} | {line} |")
        for (binary, test), t in sorted(tests.items()):
            test_rows.append((platform, tree, who, binary, test, t["verdict"], f"{t['passed']}/{t['of']}",
                              t["FLAKY"], t["FAIL"], t["TIMEOUT"], t["ERROR"] + t["MISSING"]))
    md.append("")

    # The run passes when head and base pass everywhere and, with a plant, the plant is caught
    # everywhere: some test fails or times out at the plant and passes at head.
    caught = {}
    for (platform, tree, who), line in group_lines.items():
        if tree != "plant":
            if not line.startswith(passing):
                ok = False
            continue
        th, tp = group_tests.get((platform, "head", who), {}), group_tests[(platform, tree, who)]
        if line.startswith("UNKNOWN") or not tp:
            caught[(platform, who)] = None  # nothing usable ran at the plant: not a blind test
        else:
            caught[(platform, who)] = sorted(k for k, t in tp.items()
                                             if t["verdict"] in ("FAIL", "TIMEOUT") and th.get(k, {}).get("verdict") in passing)
    if any(not keys for keys in caught.values()):
        ok = False

    mixed = {p: sorted(v) for p, v in images.items() if len(v) > 1}
    if mixed:
        ok = False
        md.append("## The runner image changed inside one platform")
        md.append("")
        for p, v in mixed.items():
            md.append(f"- {p}: {', '.join(v)}. The trees did not all run on one image; compare them with care.")
        md.append("")

    shown = [r for r in test_rows if r[5] != "PASS" or len(test_rows) <= 60]
    if shown:
        md.append("## Tests" + ("" if len(shown) == len(test_rows) else " that did not pass every repeat (all in tests.tsv)"))
        md.append("")
        md.append("| platform | tree | user | binary | test | verdict | passed | flaky | failed | timed out | not run |")
        md.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for r in shown[:300]:
            md.append("| " + " | ".join(str(x) for x in r[:4]) + f" | `{r[4]}` | " + " | ".join(str(x) for x in r[5:]) + " |")
        if len(shown) > 300:
            md.append(f"\n{len(shown) - 300} more rows in tests.tsv (artifact pc-report).")
        md.append("")

    head_only = []
    for (platform, tree, who) in groups:
        if tree == "head" and (platform, "base", who) in groups:
            th, tb = group_tests[(platform, "head", who)], group_tests[(platform, "base", who)]
            keys = sorted(k for k, t in th.items() if t["verdict"] in ("FAIL", "TIMEOUT") and tb.get(k, {}).get("verdict") in passing)
            head_only.append(f"- {platform} {who}, head-only failures (fail at head, pass at base): {len(keys)}"
                             + ("" if not keys else ": " + ", ".join(f"`{k[0]} {k[1]}`" for k in keys[:20])))
    def plant_line(platform, who, keys):
        if keys is None:
            return f"- {platform} {who}: PLANT UNKNOWN: {group_lines[(platform, 'plant', who)]}"
        if not keys:
            return f"- {platform} {who}: PLANT NOT CAUGHT: no test fails at the plant and passes at head"
        return (f"- {platform} {who}: PLANT CAUGHT by {len(keys)} test(s) that fail at the plant and pass at head: "
                + ", ".join(f"`{k[0]} {k[1]}`" for k in keys[:20]))

    plant_lines = [plant_line(platform, who, keys) for (platform, who), keys in caught.items()]
    if head_only or plant_lines:
        md.append("## Comparisons")
        md.append("")
        md.extend(head_only + plant_lines)
        md.append("")

    md.append("Run conclusion: " + ("PASS: head" + (" and base" if env.get("PC_BASE") else "") + " passed everywhere"
                                    + (", and every plant was caught." if caught else ".")
                                    if ok else "not PASS (see the verdicts and comparisons above)."))
    with open(out_dir / "verdicts.tsv", "w", encoding="utf-8") as f:
        f.write("platform\ttree\tuser\tverdict\n")
        for r in verdict_rows:
            f.write("\t".join(r) + "\n")
    with open(out_dir / "tests.tsv", "w", encoding="utf-8") as f:
        f.write("platform\ttree\tuser\tbinary\ttest\tverdict\tpassed\tflaky\tfailed\ttimed_out\tnot_run\n")
        for r in test_rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    text = "\n".join(md) + "\n"
    (out_dir / "summary.md").write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0 if ok else 1


# ---------------------------------------------------------------- scan

PATTERNS = [
    ("private key block", r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    ("GitHub fine-grained token", r"\bgithub_pat_[A-Za-z0-9_]{40,}"),
    ("AWS access key id", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("Slack token", r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    ("Slack app token", r"\bxapp-[0-9]-[A-Za-z0-9-]{10,}"),
    ("Slack webhook", r"hooks\.slack\.com/services/[A-Za-z0-9_/]{20,}"),
    ("OpenAI or Anthropic key", r"\bsk-[A-Za-z0-9_-]{20,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}"),
    ("Google OAuth client secret", r"\bGOCSPX-[A-Za-z0-9_-]{20,}"),
    ("Google OAuth access token", r"\bya29\.[0-9A-Za-z_-]{20,}"),
    # A JSON web token, such as the runner's ACTIONS_RUNTIME_TOKEN, which run steps never see.
    ("JSON web token", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\."),
]


def literals():
    """The run's own secrets as text to look for: its token and every ACTIONS_* value."""
    vals = []
    if os.environ.get("PC_SCAN_TOKEN"):
        vals.append(("the run's GITHUB_TOKEN", os.environ["PC_SCAN_TOKEN"]))
    for k, v in os.environ.items():
        if k.startswith("ACTIONS_") and len(v) >= 16 and not re.fullmatch(r"https?://\S+", v):
            vals.append((k, v))
    return vals


def scan_files(paths, lits):
    regex = re.compile("|".join(f"(?P<p{i}>{p})" for i, (_, p) in enumerate(PATTERNS)).encode())
    hits, count = [], 0
    for root in paths:
        root = Path(root)
        files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file())
        for f in files:
            count += 1
            with open(f, "rb") as fh:
                for n, line in enumerate(fh, 1):
                    m = regex.search(line)
                    if m:
                        hits.append((str(f), n, PATTERNS[int(m.lastgroup[1:])][0]))
                    for name, value in lits:
                        if value.encode() in line:
                            hits.append((str(f), n, name))
    return hits, count


def canaries():
    """Token-shaped strings made at run time, so this file holds none."""
    r = random.Random()

    def s(n, alphabet=string.ascii_letters + string.digits):
        return "".join(r.choice(alphabet) for _ in range(n))

    up = string.ascii_uppercase + string.digits
    return [
        ("private key block", "-----BEGIN " + "RSA PRIVATE" + " KEY-----"),
        ("GitHub token", "gh" + "p_" + s(36)),
        ("GitHub fine-grained token", "github" + "_pat_" + s(22) + "_" + s(59)),
        ("AWS access key id", "AK" + "IA" + s(16, up)),
        ("Slack token", "xo" + "xb-" + s(12, string.digits) + "-" + s(24)),
        ("Slack app token", "xa" + "pp-1-" + s(11, up) + "-" + s(30)),
        ("Slack webhook", "https://hooks.slack" + ".com/services/T" + s(10, up) + "/B" + s(10, up) + "/" + s(24)),
        ("OpenAI or Anthropic key", "sk-" + "ant-api03-" + s(40)),
        ("Google API key", "AI" + "za" + s(35)),
        ("Google OAuth client secret", "GOC" + "SPX-" + s(28)),
        ("Google OAuth access token", "ya" + "29." + s(60)),
        ("JSON web token", "ey" + "J" + s(20) + ".ey" + "J" + s(40) + "." + s(43)),
    ]


def scan_selftest():
    """The planted-token control: every pattern finds its canary; known lookalikes pass."""
    bad = []
    token = "gh" + "s_" + "".join(random.choice(string.ascii_letters) for _ in range(36))
    lits = [("the run's GITHUB_TOKEN", token)]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "planted.log"
        # The token sits inside a word, where no pattern sees it: only the literal check can.
        for name, value in canaries() + [("the run's GITHUB_TOKEN", "x" + token + "x")]:
            f.write_text(f"before\nsome log text {value} more text\nafter\n", encoding="utf-8")
            hits, _ = scan_files([d], lits)
            if not any(h[2] == name and h[1] == 2 for h in hits):
                bad.append(f"planted {name} not found")
        f.write_text("sk-short AKIA1234 ghp_short xoxb- BEGIN PUBLIC KEY risk-free-task-name "
                     "test(/^ghp_/) AIza eyJhbGciOi.short\n", encoding="utf-8")
        hits, _ = scan_files([d], lits)
        if hits:
            bad.append(f"lookalikes matched: {sorted({h[2] for h in hits})}")
    return bad


def scan(paths):
    bad = scan_selftest()
    if bad:
        for b in bad:
            print(f"SCAN CONTROL FAILED: {b}")
        print("::error::the scan missed its own planted tokens; nothing is uploaded")
        return 2
    print(f"SCAN CONTROL ok: {len(PATTERNS)} patterns and the token literal found their planted canaries")
    if not os.environ.get("PC_SCAN_TOKEN"):
        print("::error::SCAN UNKNOWN: PC_SCAN_TOKEN is empty, so the run's own token cannot be looked for")
        return 1
    lits = literals()
    present = [p for p in paths if Path(p).exists()]
    if not present:
        print(f"::error::SCAN UNKNOWN: none of {' '.join(paths)} exists; nothing to upload")
        return 1
    hits, count = scan_files(present, lits)
    if count == 0:
        print(f"::error::SCAN UNKNOWN: {' '.join(present)} holds no file; nothing to upload")
        return 1
    if hits:
        for f, line, name in hits[:50]:
            print(f"SCAN MATCH {f}:{line}: {name}")
        print(f"::error::{len(hits)} matches in {count} files; the upload is skipped")
        return 1
    print(f"SCAN clean: {count} files, {len(PATTERNS)} patterns, {len(lits)} literal values")
    return 0


# ---------------------------------------------------------------- controls on hand-made inputs


def _junit(runs):
    """A JUnit report shaped like nextest's. runs: one list of (binary, name, kind) per sub-run;
    kind pass|fail|timeout|flaky|error|leak|skip. More than one sub-run names suites @stress-N."""
    root = ET.Element("testsuites")
    for index, cases in enumerate(runs):
        suites = {}
        for binary, name, kind in cases:
            suite = suites.get(binary)
            if suite is None:
                suite_name = binary + (f"@stress-{index}" if len(runs) > 1 else "")
                suite = suites[binary] = ET.SubElement(root, "testsuite", name=suite_name)
            case = ET.SubElement(suite, "testcase", name=name, classname=binary)
            panic = f"thread '{name}' panicked at src/lib.rs:1:1"
            if kind == "fail":
                ET.SubElement(case, "failure", type="test failure with exit code 101", message=panic)
            elif kind == "timeout":
                ET.SubElement(case, "failure", type=TIMEOUT_TYPE)
            elif kind == "flaky":
                ET.SubElement(case, "flakyFailure", type="test failure with exit code 101", message=panic)
            elif kind == "error":
                ET.SubElement(case, "error", type="execution failure")
            elif kind == "leak":
                ET.SubElement(case, "error", type="test exited with code 0, but " + LEAK_FAIL)
            elif kind == "skip":
                ET.SubElement(case, "skipped", message="Skipped: test ignored")
    return ET.tostring(root)


def classifier_selftest():
    rows = []
    with tempfile.TemporaryDirectory() as d:
        def reports(*per_repeat):
            """One report per repeat, as separate plain runs (None: no report)."""
            out = {}
            for i, cases in enumerate(per_repeat, 1):
                if cases is None:
                    out[i] = None
                    continue
                f = Path(d) / f"j{i}.xml"
                f.write_bytes(_junit([cases]))
                out[i] = junit_runs(f).get(0, {})
            return out

        def lst(runnable, ignored=(), unmatched=()):
            suites = defaultdict(lambda: {"testcases": {}})
            for b, n in runnable:
                suites[b]["testcases"][n] = {"ignored": False, "filter-match": {"status": "matches"}}
            for b, n in ignored:
                suites[b]["testcases"][n] = {"ignored": True, "filter-match": {"status": "matches"}}
            for b, n in unmatched:
                suites[b]["testcases"][n] = {"ignored": False, "filter-match": {"status": "mismatch", "reason": "expression"}}
            f = Path(d) / "list.json"
            f.write_text(json.dumps({"rust-suites": suites}), encoding="utf-8")
            return list_sets(f)

        eleven = [("pi-shell", f"a::t{i}") for i in range(11)]
        r, ig = lst(eleven, [("pi-shell", "a::slow")], [("pi-shell", "b::other")])
        rows.append(("11 passed + 1 ignored (TxtBusy2's case)", "PASS (11 passed in 1 of 1 repeats) run=11 ignored=1",
                     classify(r, ig, reports([(b, n, "pass") for b, n in eleven] + [("pi-shell", "a::slow", "skip")]), 1)))
        r, ig = lst([], [("pi-shell", "a::x"), ("pi-shell", "a::y")])
        rows.append(("only ignored tests", "UNKNOWN (ran nothing: the filter selects no test that runs here) run=0 ignored=2",
                     classify(r, ig, reports([]), 1)))
        r, ig = lst([], [], [("pi-shell", "b::other")])
        rows.append(("matches nothing (a blind spot)", "UNKNOWN (ran nothing: the filter selects no test that runs here) run=0 ignored=0",
                     classify(r, ig, reports([]), 1)))
        two = [("pi-shell", "a::x"), ("pi-shell", "a::y")]
        r, ig = lst(two)
        rows.append(("a selected test failed", "FAIL (1 failed: pi-shell a::y) run=2 ignored=0",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "fail")]), 1)))
        rows.append(("a selected test ran past the time bound", "TIMEOUT (1 past the time bound: pi-shell a::y) run=2 ignored=0",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "timeout")]), 1)))
        rt, igt = lst([("pi-shell", "a::waits_for_a_timeout")])
        rows.append(("a failed test whose name holds 'timeout' is FAIL, not TIMEOUT",
                     "FAIL (1 failed: pi-shell a::waits_for_a_timeout)",
                     classify(rt, igt, reports([("pi-shell", "a::waits_for_a_timeout", "fail")]), 1)))
        rows.append(("failed once, passed on the nextest retry", "FLAKY (1 passed only on a retry: pi-shell a::x)",
                     classify(r, ig, reports([("pi-shell", "a::x", "flaky"), ("pi-shell", "a::y", "pass")]), 1)))
        rows.append(("no report for a repeat (a crash, a failed build)", "UNKNOWN (no JUnit report for repeat 2)",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass")], None), 2)))
        rows.append(("a selected test missing from the report (counts do not add up)", "UNKNOWN (1 tests missing",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass")]), 1)))
        rows.append(("a test that could not start", "UNKNOWN (1 tests missing from a report or not started: pi-shell a::y)",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "error")]), 1)))
        rows.append(("a test nextest failed for leaked handles", "FAIL (1 failed: pi-shell a::y)",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "leak")]), 1)))
        rows.append(("a test the list did not select in the report", "UNKNOWN (the reports hold 1 tests",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass"), ("pi-shell", "c::z", "pass")]), 1)))
        rows.append(("ignored tests outside the filter in the report are not counted", "PASS (2 passed in 1 of 1 repeats) run=2 ignored=0",
                     classify(r, ig, reports([("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass"), ("pi-shell", "z::ign", "skip")]), 1)))
        rows.append(("no test list (no archive, the leg did not run)", "UNKNOWN (no test list",
                     classify(set(), set(), {}, 1, listed=False)))
        # A leg the deadline stopped inside its second repeat: the stopped test (an abort, which
        # nextest writes as a failure) must not read FAIL, here or in the head-only list.
        leg = Path(d) / "cut"
        leg.mkdir()
        (leg / "meta.env").write_text("list_exit=0\ncancelled=deadline\n", encoding="utf-8")
        (leg / "list.json").write_text(json.dumps({"rust-suites": {"pi-shell": {"testcases": {
            n: {"ignored": False, "filter-match": {"status": "matches"}} for _, n in two}}}}), encoding="utf-8")
        (leg / "junit.xml").write_bytes(_junit([[("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass")],
                                                [("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "fail")]]))
        rc, igc, repc, cutc, _ = leg_results(leg, 0, 2)
        line, tests = classify(rc, igc, repc, 2, True, cutc)
        rows.append(("a leg its deadline stopped in repeat 2", "UNKNOWN (cut short by the leg's deadline after 1 of 2", (line, tests)))
        rows.append(("  the test it stopped is not a FAIL", "UNKNOWN 1/2",
                     (f"{tests[('pi-shell', 'a::y')]['verdict']} {tests[('pi-shell', 'a::y')]['passed']}/2", None)))
        (leg / "junit.xml").write_bytes(_junit([[("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "fail")],
                                                [("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass")]]))
        rows.append(("a failure in a finished repeat of a cut leg stands", "FAIL (1 failed: pi-shell a::y) run=2 ignored=0 (cut short",
                     classify(*leg_results(leg, 0, 2)[:3], 2, True, True)))
        # A stress run of 3: one JUnit report, suites named @stress-0..2, repeat 2 fails.
        f = Path(d) / "stress.xml"
        f.write_bytes(_junit([
            [("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass")],
            [("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "fail")],
            [("pi-shell", "a::x", "pass"), ("pi-shell", "a::y", "pass")],
        ]))
        runs = junit_runs(f)
        line, tests = classify(r, ig, {s + 1: runs.get(s) for s in range(3)}, 3)
        rows.append(("stress run of 3, one failed: FAIL", "FAIL (1 failed: pi-shell a::y) run=2 ignored=0", (line, tests)))
        per = tests[("pi-shell", "a::y")]
        rows.append(("per-test count n/N", "2/3", (f"{per['passed']}/{per['of']}", None)))
        rows.append(("a stress run that stopped after 2 of 3", "UNKNOWN (no JUnit report for repeat 3)",
                     classify(r, ig, {1: runs.get(0), 2: runs.get(2), 3: runs.get(3)}, 3)))
    bad = 0
    for name, want, (got, _) in rows:
        if got.startswith(want):
            print(f"OK       {name}: {got}")
        else:
            print(f"MISMATCH {name}: want {want!r}, got {got!r}")
            bad = 1
    return bad


def partition_selftest():
    """Two partitions of one group: disjoint lists read as one; a shared test, or a partition
    with no report, is UNKNOWN."""
    rows = []
    with tempfile.TemporaryDirectory() as d:
        def leg(n, part, tests, kinds=None):
            f = Path(d) / f"pc-results-macos-head-user-{n}"
            f.mkdir(exist_ok=True)
            (f / "meta.env").write_text(f"platform=macos\ntree=head\nwho=user\nleg={n}\nlist_exit=0\n", encoding="utf-8")
            (f / "list.json").write_text(json.dumps({"rust-suites": {"pi-shell": {"testcases": {
                t: {"ignored": False, "filter-match": {"status": "matches"}} for t in tests}}}}), encoding="utf-8")
            if kinds is not None:
                (f / "junit.xml").write_bytes(_junit([[("pi-shell", t, k) for t, k in zip(tests, kinds)]]))
            return {"platform": "macos", "tree": "head", "who": "user", "leg": n, "offset": 0, "count": 1,
                    "partition": part, "partitions": 2}

        def verdict(members):
            r, ig, reps, listed, cut, notes = group_results(d, "macos", "head", "user", members, 1, defaultdict(set))
            return classify(r, ig, reps, 1, listed, cut)[0] + (" (" + "; ".join(notes) + ")" if notes else "")

        a, b = leg(1, 1, ["a::x", "a::y"], ["pass", "pass"]), leg(2, 2, ["b::z"], ["fail"])
        rows.append(("two partitions, one failure", "FAIL (1 failed: pi-shell b::z) run=3", verdict([a, b])))
        b = leg(2, 2, ["b::z"], ["pass"])
        rows.append(("two partitions, all passed", "PASS (3 passed in 1 of 1 repeats) run=3", verdict([a, b])))
        b = leg(2, 2, ["a::y", "b::z"], ["pass", "pass"])
        rows.append(("partitions that share a test", "UNKNOWN (no test list", verdict([a, b])))
        b = leg(2, 2, ["b::z"])
        (Path(d) / "pc-results-macos-head-user-2" / "junit.xml").unlink()
        rows.append(("a partition with no report", "UNKNOWN (no JUnit report for repeat 1)", verdict([a, b])))
    bad = 0
    for name, want, got in rows:
        print(f"{'OK      ' if got.startswith(want) else 'MISMATCH'} partitions: {name}: {got}")
        bad |= not got.startswith(want)
    return int(bad)


def options_selftest():
    """The `options` input: what it accepts, what it refuses, and that each setting reaches the
    plan the same way from `options` as from its own input."""
    rows = [
        ("empty", "", {}),
        ("one pair", "legs=4", {"legs": "4"}),
        ("every setting", " ".join(f"{n}=x" for n in OPTIONS), {n: "x" for n in OPTIONS}),
        ("a flag", "as_root=true keep_success_output=false", {"as_root": "true", "keep_success_output": "false"}),
        ("an empty value", "retries=", {"retries": ""}),
        ("extra spaces", "  legs=2   retries=1  ", {"legs": "2", "retries": "1"}),
        ("no equals", "legs", None),
        ("a name that is no setting", "legs=2 threads=4", None),
        ("a name given twice", "legs=2 legs=3", None),
        ("a value with a space", "filter=a b", None),
        ("a quoted value", "legs='2'", None),
    ]
    bad = 0
    for name, text, want in rows:
        try:
            got = options({"PC_OPTIONS": text})
        except SystemExit:
            got = None
        print(f"{'OK      ' if got == want else 'MISMATCH'} options: {name}: {got}")
        bad |= got != want
    # setting(): `options` first, then the setting's own input, then the default.
    cases = [
        ("from options", {"PC_LEGS": "9"}, {"legs": "4"}, "4"),
        ("from its own input", {"PC_LEGS": "9"}, {}, "9"),
        ("the default", {"PC_LEGS": ""}, {}, "1"),
    ]
    for name, env, opts, want in cases:
        got = setting(env, opts, "legs", "1")
        print(f"{'OK      ' if got == want else 'MISMATCH'} setting: {name}: {got}")
        bad |= got != want
    return int(bad)


def scope_selftest():
    """The plan's scope rows: a dispatch runs only from platform-checks; a call runs anywhere."""
    caller = "cybermonklabs/oh-my-pi/.github/workflows/sami-checks.yml"
    rows = [
        ("a dispatch from platform-checks", (False, False),
         {"GITHUB_WORKFLOW_REF": f"cybermonklabs/oh-my-pi/{THIS_FILE}@refs/heads/platform-checks", "GITHUB_REF": "refs/heads/platform-checks"}),
        ("a dispatch from another ref is refused", (False, True),
         {"GITHUB_WORKFLOW_REF": f"cybermonklabs/oh-my-pi/{THIS_FILE}@refs/heads/sami-candidate", "GITHUB_REF": "refs/heads/sami-candidate"}),
        ("a call from a push to sami-candidate", (True, False),
         {"GITHUB_WORKFLOW_REF": f"{caller}@refs/heads/sami-candidate", "GITHUB_REF": "refs/heads/sami-candidate"}),
        ("a call from a dispatch of another branch", (True, False),
         {"GITHUB_WORKFLOW_REF": f"{caller}@refs/heads/feat/x", "GITHUB_REF": "refs/heads/feat/x"}),
        ("no workflow ref is refused", (False, True), {"GITHUB_REF": "refs/heads/platform-checks"}),
    ]
    bad = 0
    for name, want, env in rows:
        called, refusal = scope(env)
        got = (called, bool(refusal))
        print(f"{'OK      ' if got == want else 'MISMATCH'} scope: {name}: called={called} refused={bool(refusal)}")
        bad |= got != want
    return int(bad)


def selftest():
    bad = classifier_selftest() | scope_selftest() | partition_selftest() | options_selftest()
    problems = scan_selftest()
    for p in problems:
        print(f"MISMATCH scan control: {p}")
    if not problems:
        print(f"OK       scan control: {len(PATTERNS)} planted tokens and the run's token found; lookalikes pass")
    return 1 if bad or problems else 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "plan":
        plan()
        return 0
    if cmd == "selftest":
        return selftest()
    if cmd == "scan" and len(argv) > 2:
        return scan(argv[2:])
    if cmd == "brief" and len(argv) == 3:
        brief(argv[2])
        return 0
    if cmd == "verdict" and len(argv) == 3:
        verdict(argv[2])
        return 0
    if cmd == "report" and len(argv) == 5:
        return report(argv[2], argv[3], argv[4])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
