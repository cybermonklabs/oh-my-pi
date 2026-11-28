#!/usr/bin/env python3
"""sami-checks: the plan, the counters and the summary of .github/workflows/sami-checks.yml.

  sc.py plan                       GITHUB_OUTPUT lines: the commit, the rows and jobs that run, the job matrices, the controls
  sc.py shard WHO N K META WEIGHTS the pi-shell test binaries of shard N of K, one "id<TAB>path" a line
  sc.py ts-small                   the small TypeScript suites, one "unit<TAB>dir<TAB>bound<TAB>args" a line
  sc.py libtest LOG EXIT SECS ROW UNIT WHO   one libtest binary's result (JSON on stdout)
  sc.py nextest JUNIT EXIT SECS ROW UNIT WHO one nextest run's result
  sc.py gv-control LOG EXIT SECS ROW UNIT WHO the map-limit control: gv-libtest, UNKNOWN unless each ORPHAN_CONTROL_TESTS test ran
  sc.py bun JUNIT LOG EXIT SECS ROW UNIT     one `bun test` run's result
  sc.py plain EXIT SECS ROW UNIT LOG         a command whose exit is its verdict (check:ts)
  sc.py clippy-crates METADATA CRATE...     "crate<TAB>dir<TAB>library root" a line, from `cargo metadata`
  sc.py clippy LOG EXIT SECS CRATE DIR CONTROL_LOG CONTROL_FILE METADATA
                                           one crate's clippy result against clippy-baseline.txt, each unit of the crate
                                           (METADATA: `cargo metadata --no-deps`) that it did not lint named UNKNOWN
  sc.py clippy-baseline LOG CRATE DIR METADATA   one crate's findings as clippy-baseline.txt lines (to regenerate it);
                                           a crate not linted whole keeps its baseline lines
  sc.py platforms PC OUT                   one result per platform from platform-checks' pc-report under PC
  sc.py summary RESULTS BUILD [KNOWN]      the step summary (markdown) on stdout, its verdict line also to $SC_VERDICT;
                                           a row SC_ROWS does not name reads NOT RUN; exit 0 when every row that ran
                                           passed, 1 when it found a fault, else 2 when a row (or the summary) could not be read
  sc.py unreadable-pass SUMMARY VERDICT WHY   a passing summary's report that could not be written (WHY): the verdict
                                           file and SUMMARY read UNKNOWN, and the new exit line on stdout
  sc.py skip-forms TREE NOT_MARKERS        each print of TREE/crates that says skip is read or named (JSON)
  sc.py skip-lines RESULTS NOT_MARKERS     each skip line a passing test printed is read or named (JSON)
  sc.py flaky-failed RESULT KNOWN          the failed tests of one result with a `flaky: ` entry, one a line
  sc.py retried RESULT TEST REPORT SHAPE [SCOPE]   adds one retry (pass, partial, skip or fail) to RESULT;
                                           SCOPE whole-unit (the default) or own-process (nextest)
  sc.py junit-merge OUT JUNIT...           one JUnit report of several (nextest.sh's two passes)
  sc.py selftest                           the counters and the summary against hand-made inputs
  sc.py docs UNIT STREAM LOG EXIT SECS     `cargo doc --message-format=json -p pi-shell`: each broken intra-doc link (docs.sh)
  sc.py changelog LOG EXIT SECS FILES DIFF WRITE_EXIT  `fix-changelogs.ts --check`: each CHANGELOG it would rewrite (changelog.sh)
  sc.py plant WHAT TREE                    the docs, changelog, rustfmt, membench, builtins-lint or bazel-lock row's control: puts its
                                           planted fault in TREE
  sc.py rustfmt-workspaces                 the manifests of the cargo workspaces the rustfmt row checks, one a line
  sc.py rustfmt UNIT LOG EXIT SECS TREE [BASE_LOG BASE_EXIT BASE_TREE BASE_SHA FORK_DIFF]
                                           one workspace's `cargo fmt --all --check -v -- -v`, each place sorted by the same
                                           run at the tree's upstream base, through the fork's diff from it, into
                                           upstream's own and the fork's (rustfmt.sh)
  sc.py membench-bin STREAM                the memory bench's executable, from `cargo bench --no-run --message-format=json` (membench.sh)
  sc.py membench UNIT OUT ERR EXIT SECS BUILD_EXIT BUILD_LOG
                                           one run of pi-shell's memory bench: each PASS/MISS target line, its exit, and every
                                           line it printed (membench.sh)
  sc.py builtins-lint-lift TREE DIR        lifts the crate in TREE/DIR out of its own lint opt-outs, for the builtins-lint row: its
                                           Cargo.toml's [lints] becomes the workspace's, and rustfmt.toml ignores it no more
  sc.py builtins-lint-files TREE DIR CLIPPY_LOG FMT_LOG
                                           "clippy|rustfmt<TAB>file" for each file under DIR with a finding (builtins-lint.sh)
  sc.py builtins-clippy LOG EXIT SECS TREE DIR [BASE_LOG BASE_EXIT BASE_TREE BASE_SHA FORK_DIFF]
  sc.py builtins-rustfmt LOG EXIT SECS TREE DIR [BASE_LOG BASE_EXIT BASE_TREE BASE_SHA FORK_DIFF]
                                           the builtins-lint row's units: each finding of `cargo clippy` (every lint a
                                           warning) or `cargo fmt --check` of the crate in DIR, sorted as the rustfmt row
                                           sorts its places, into upstream's own and the fork's (builtins-lint.sh)
  sc.py bazel-lock LOG EXIT SECS TREE      `bun scripts/gen-bazel-lock.ts --check` in TREE: whether MODULE.bazel.lock is current,
                                           and when Bazel names a file of the tree that changed, each file the lock's record
                                           of differs from (bazel-lock.sh)
  sc.py previous-report OUT                the previous cut's sc-report (results.json, verdict.json) into OUT, beside
                                           about.json naming its run, or why none could be read: the summary's
                                           SC_PREVIOUS, which it compares this run's failures with (first seen at this cut)
  sc.py rust-findings FINDINGS OUT         one unit result per step of the Rust rows that writes a findings file
                                           (.github/sami/findings.sh), from the sc-findings-<job> artifacts under
                                           FINDINGS, so that the summary compares each of their findings and not only
                                           the row's verdict; SC_RUST_JOBS names each job's result

The counter rule (the fork's gate kit): a result is PASS or FAIL only when it was read. A libtest
binary whose exit is neither 0 nor 101, a nextest run whose exit is neither 0 nor 100, a bun run
with no JUnit report or no summary line, a command the time bound or a signal ended, a clippy run
whose exit is neither 0 nor 101 or whose control was not caught, a clippy run that did not lint
every unit of its crate (each such unit is named; a finding it did read still fails it), a
platform the platform report
gives no verdict for, a memory bench that did not build, did not end on its own or printed no
target line, and a unit the plan expects that no job reported, or that two jobs reported,
are UNKNOWN, and so is every row they belong to unless another unit of it failed (a fault outranks
a unit that could not be read). A test that passed after printing a skip marker
compared nothing: it is counted apart, named, and its unit is UNKNOWN, unless each of its skip
lines is a sub-case that partial-skips.txt lets that test skip and the entry's witness line is in
its output (then it passes and is listed as partial), it passed as the other user, or
known-failures.txt names each of its skip lines for that row and user (`skips: `; then it reads
KNOWN). A test that started and never ended is named. A failure with a `flaky: ` entry reads KNOWN
only when the test passed in a retry of its whole unit in the same job (the unit's command again,
at most twice; on the platform rows, nextest's own retry of the test's own process).

First seen at this cut: the summary compares each failure with the previous cut's report (the newest
completed push of release-candidate before the run, or the run the dispatch input `previous` names).
A failure that report does not hold, by its words less the line or column that moves with other
lines of the tree (FINDING_MOVES), or holds fewer times (finding_keys), heads the summary and is in
verdict.json's first_seen. A report that could not be read makes first_seen the string UNKNOWN,
and the summary says why: it never reads as nothing first seen. Every row is compared finding by
finding, the Rust rows too: their jobs' scripts write each `::error` they print to a findings file
(.github/sami/findings.sh), whose records are the row's units here, so that a finding first made at
a cut is named at that cut even where the row read FAIL at the cut before for other findings. A
step whose findings file is missing or was cut short reads UNKNOWN, named under "Not compared"; a
step whose job did not run reads NOT RUN, which is no gap.
"""

import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib
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
    ("clippy --tests, every lint a warning, per crate (failed: findings beyond clippy-baseline.txt)", "clippy"),
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
    ("rustfmt: cargo fmt --check, per cargo workspace", "rustfmt"),
    ("pi-shell memory bench, release (benches/memory.rs: its PASS/MISS targets)", "membench"),
    ("pi-builtins lint: clippy at the workspace's lint levels and rustfmt, the crate's opt-outs lifted (failed: a finding the fork "
     "added)", "builtins-lint"),
    ("MODULE.bazel.lock current for the tree (gen-bazel-lock --check; failed: Bazel names a file of the tree that changed)",
     "bazel-lock"),
)
# The Rust tests (sami-rust-test.yml) report no test units here: each of its two jobs is a row of
# its own, read from the job's conclusion, which sami-checks.yml passes as SC_RUST_TESTS. The
# findings of those rows' jobs (each `::error` their scripts wrote, .github/sami/findings.sh) are
# units of the row all the same, so that the first-seen comparison reads each finding of a row
# whose verdict is one word over all of them (RUST_FINDING_STEPS, sc.py rust-findings).
RUST_JOBS = (
    ("Rust tests, Bazel and the other cargo workspaces (sami-rust-test.yml rust_test)", "rust_test"),
    ("Rust tests, macOS only (sami-rust-test.yml rust_test_macos)", "rust_test_macos"),
)
# The names the dispatch input `rows` takes, one per row of the summary.
ROW_KEYS = tuple(k for _, k in ROWS) + tuple(k for _, k in RUST_JOBS)
# The row keys of the Rust rows, whose findings move between their jobs (FINDING_MOVES, ANY_UNIT_ROWS).
RUST_ROW_KEYS = tuple(k for _, k in RUST_JOBS)
# The steps of each Rust row that write a findings file, by the job they run in: the unit of the
# summary is `<job>/<step>`, and the file is <step>.tsv of the artifact sc-findings-<job>. The jobs
# are the ones row_work gives the row (the selftest checks that they agree), so a job of a Rust row
# that writes no findings file is named here all the same, and its unit reads UNKNOWN.
RUST_FINDING_STEPS = {
    "rust_test": (("rust-test", ("rust-test", "parity")),
                  ("rust-test-cold", ("rust-test", "parity")),
                  ("rust-test-drift", ("drift",)),
                  ("rust-test-compare", ("verdict", "compare"))),
    "rust_test_macos": (("rust-test-macos", ("inventory", "rust-test")),),
}
# The summary's exit for its verdict: a run that could not look (UNKNOWN) never exits with the code
# of one that found a fault (FAIL), and a fault outranks a row that could not be read.
SUMMARY_EXIT = {"PASS": 0, "FAIL": 1, "UNKNOWN": 2}
# sami-checks.yml, whose jobs' `needs:` the plan reads (the plan job checks out .github/workflows too).
WORKFLOW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "workflows", "sami-checks.yml")
# The jobs every run has: the plan, and the summary that reads every other job.
ALWAYS_JOBS = ("plan", "summary")
# The Rust gate's build seed (the dispatch input `seed`, .github/sami/gate-seed.sh): the newest
# cut's seed, one this run's own seed jobs build, or none.
SEEDS = ("auto", "build", "off")
# The cut whose run also builds the Linux gate cold and compares the two, test by test: every fifth.
SEED_CONTROL_EVERY = 5
# The rows whose results hold their passing tests' output (libtest logs, JUnit reports), which the
# skip prints row's run-time unit reads (sc.py skip-lines, passing_outputs). The gVisor set shards
# also hold the gVisor lib and map-limit rows' logs.
TEST_OUTPUT_ROWS = ("set-runner", "set-root", "builtins", "workspace", "ts-small", "ts-ca", "gv-set-uid1000",
                    "gv-set-root", "gv-builtins-uid1000", "gv-builtins-root")


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
    names += ["docs", "changelog", "rustfmt", "membench", "builtins-lint", "bazel-lock"]
    return names


def row_work():
    """{row: the (job, matrix entry) pairs whose results its reading uses}. An entry of a job with no
    matrix is named as its job. A row runs when each of its pairs is planned, so that it reads the same
    alone as in a run of every row; rows that share entries run together:
      - a test that skipped itself as one user is covered by the same test's pass as the other user, on
        the same runtime (cmd_summary's passed_as), so the pi-shell set of both users and the one-process
        lib row are one group, and so are both users' gVisor set shards (with the gVisor lib and
        map-limit rows), and both users' gVisor pi-builtins;
      - sami-rust-test.yml runs in two calls, rust-test (the rust_test row) and rust-test-macos (the
        rust_test_macos row); rust-test-drift's result is part of the rust_test row (SC_RUST_TESTS);
      - the skip prints row's run-time unit (sc.py skip-lines) reads the output of every passing test of
        the run, so that row needs the jobs of each row in TEST_OUTPUT_ROWS too."""
    def entries(job, matrix, **want):
        return frozenset((job, m["name"]) for m in matrix if all(m[k] == v for k, v in want.items()))

    def one(job):
        return frozenset({(job, job)})

    work = {
        "builtins": entries("builtins", builtins_matrix()),
        "workspace": entries("workspace", workspace_matrix()),
        "ts-small": one("ts-small"),
        "ts-ca": entries("ts-ca", ts_matrix()),
        "checkts": one("checkts"),
        "clippy": one("clippy"),
        "docs": one("docs"),
        "changelog": one("changelog"),
        "rustfmt": one("rustfmt"),
        "membench": one("membench"),
        "builtins-lint": one("builtins-lint"),
        "bazel-lock": one("bazel-lock"),
        # rust-test-drift's result is part of this row, and so is the seed's control: the cold run
        # of the same commit (rust-test-cold) and the comparison of the two (rust-test-compare).
        "rust_test": one("rust-test") | one("rust-test-drift") | one("rust-test-cold") | one("rust-test-compare"),
        "rust_test_macos": one("rust-test-macos"),
    }
    for r in ("set-runner", "set-root", "lib4"):
        work[r] = entries("set", set_matrix())
    for p in PLATFORMS:
        work[p] = frozenset({("platforms", p)})
    for w in GV_WHO:
        for r in ("set", "lib4", "orphan"):
            work[f"gv-{r}-{w}"] = entries("gvisor", gvisor_matrix(), part="set")
        work[f"gv-builtins-{w}"] = entries("gvisor", gvisor_matrix(), part="builtins")
    work["skipforms"] = one("skip-forms").union(*(work[r] for r in TEST_OUTPUT_ROWS))
    return work


def workflow_jobs(path=WORKFLOW):
    """{job: {"needs": [job, ...], "if": text}} of a workflow file, read with yq (mikefarah's yq v4:
    on the ubuntu-24.04 runner image, and in mise)."""
    try:
        out = subprocess.run(["yq", "-o=json", ".jobs", path], capture_output=True, text=True, check=True).stdout
        jobs = json.loads(out)
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        sys.exit(f"::error::the jobs of {path} could not be read with yq: {e}")
    if not isinstance(jobs, dict) or not jobs:
        sys.exit(f"::error::{path} has no jobs to read")
    out = {}
    for job, body in jobs.items():
        needs = body.get("needs") or []
        out[job] = {"needs": [needs] if isinstance(needs, str) else list(needs), "if": str(body.get("if", ""))}
    return out


def plan_rows(selected, jobs):
    """(the planned (job, entry) pairs, the rows that run, the jobs that run) for the selected rows,
    given the workflow's jobs (workflow_jobs). A job runs when it has a planned entry or a job that
    runs needs it, transitively; the prerequisite builds come only from the workflow's own `needs:`."""
    work = row_work()
    planned = frozenset().union(*(work[r] for r in selected))
    rows = [k for k in ROW_KEYS if work[k] <= planned]
    run, todo = set(), sorted({j for j, _ in planned})
    while todo:
        j = todo.pop()
        if j in run or j in ALWAYS_JOBS:
            continue
        if j not in jobs:
            sys.exit(f"::error::the plan needs the job '{j}', which the workflow does not have (its jobs: {', '.join(jobs)})")
        run.add(j)
        todo += jobs[j]["needs"]
    return planned, rows, [j for j in jobs if j in run]


def parse_rows(text):
    """The rows the dispatch input `rows` selects: `all`, or a comma list of ROW_KEYS."""
    names = [n.strip() for n in text.split(",")]
    if names == ["all"]:
        return list(ROW_KEYS)
    bad = [n for n in names if n not in ROW_KEYS]
    if bad:
        sys.exit(f"::error::the rows input names no row: {', '.join(repr(n) for n in bad)}. Give all (alone), or a comma "
                 f"list of row names: {', '.join(ROW_KEYS)}")
    return names


def gate(job):
    """The expression each job's if: holds, so that it runs only when the plan plans it."""
    return f"contains(fromJSON(needs.plan.outputs.jobs), '{job}')"


def cmd_plan():
    event = os.environ["GITHUB_EVENT_NAME"]
    ref = os.environ["GITHUB_REF"]
    if event == "workflow_dispatch":
        commit = os.environ.get("SC_INPUT_COMMIT", "")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            sys.exit(f"::error::the commit input must be a full 40-character lowercase id, not '{commit}'")
        selected = parse_rows(os.environ.get("SC_INPUT_ROWS", ""))
        silent = os.environ.get("SC_INPUT_SILENT", "")
        plant = os.environ.get("SC_INPUT_PLANT", "")
        seed = os.environ.get("SC_INPUT_SEED", "") or "auto"
        if seed not in SEEDS:
            sys.exit(f"::error::the seed input names no build seed: '{seed}' (one of {', '.join(SEEDS)})")
        # A dispatch that builds a seed is the seed's own proof, so it runs the cold control and the
        # comparison beside the seeded jobs, on the one commit.
        control = seed == "build"
    elif event == "push" and ref == "refs/heads/release-candidate":
        # The cut: every row, and no control, whatever an input says.
        commit = os.environ["GITHUB_SHA"]
        selected, silent, plant = list(ROW_KEYS), "", ""
        # It builds its own seed from its own commit and reads that one. The seed's cold control
        # runs on every fifth cut, read from the newest `sami release CutN` commit of this
        # candidate's history (SC_CUT, which the plan job's step before this one found).
        seed = "build"
        cut = os.environ.get("SC_CUT", "").strip()
        control = cut.isdigit() and int(cut) % SEED_CONTROL_EVERY == 0
        if not cut.isdigit():
            print(f"::warning title=The cut of this candidate::UNKNOWN: no 'sami release CutN' commit in this "
                  f"candidate's last 300 (SC_CUT is '{cut}'), so the seed's cold control does not run", file=sys.stderr)
    else:
        sys.exit(f"::error::sami checks runs on a push of release-candidate or a dispatch, not on {event} of {ref}")
    planned, rows, jobs = plan_rows(selected, workflow_jobs())
    if silent and silent not in all_job_names():
        sys.exit(f"::error::the silent input names no job of the plan: '{silent}' (one of {', '.join(all_job_names())})")
    # A control must have its job in the run: one on a row that does not run would pass quietly.
    names = {n for _, n in planned} | ({"platforms"} if "platforms" in jobs else set())
    names |= {"macos-bash"} if ("platforms", "macos") in planned else set()
    if silent and silent not in names:
        sys.exit(f"::error::the silent input names the job '{silent}', which this run does not run (its rows: {', '.join(rows)})")
    if plant and plant not in PLANTS:
        sys.exit(f"::error::the plant input names no row's control: '{plant}' (one of {', '.join(PLANTS)})")
    if plant and plant not in rows:
        sys.exit(f"::error::the plant input plants a fault in the row '{plant}', which this run does not run (its rows: {', '.join(rows)})")
    print(f"PLAN rows ({len(rows)} of {len(ROW_KEYS)}): {', '.join(rows)}; jobs: {', '.join(jobs)}; "
          f"seed: {seed}; the seed's cold control: {'yes' if control else 'no'}", file=sys.stderr)
    if len(rows) < len(ROW_KEYS):
        print(f"::notice title=A subset of the rows::{len(rows)} of {len(ROW_KEYS)} rows run ({', '.join(rows)}); "
              "the summary reads the others NOT RUN", file=sys.stderr)

    def only(job, matrix):
        return json.dumps([m for m in matrix if (job, m["name"]) in planned])

    out = {
        "commit": commit,
        "rows": ",".join(rows),
        "jobs": json.dumps(jobs),
        "silent": silent,
        "set": only("set", set_matrix()),
        "set_shards": SET_SHARDS,
        "workspace": only("workspace", workspace_matrix()),
        "builtins": only("builtins", builtins_matrix()),
        "workspace_parts": WORKSPACE_PARTS,
        "ts": only("ts-ca", ts_matrix()),
        "ca_shards": CODING_AGENT_SHARDS,
        "platforms": ",".join(p for p in PLATFORMS if ("platforms", p) in planned),
        "platform_crates": PLATFORM_CRATES,
        "platform_partitions": PLATFORM_PARTITIONS,
        "platform_retries": PLATFORM_RETRIES,
        "clippy_crates": " ".join(CLIPPY_CRATES),
        "gvisor": only("gvisor", gvisor_matrix()),
        "gv_set_shards": GV_SET_SHARDS,
        "plant": plant,
        # The Rust gate jobs' build seed, and whether the cold control runs beside them.
        "seed": seed,
        "seed_control": "true" if control else "false",
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


def cargo_messages(path):
    """The cargo messages of a `--message-format=json` log, and the numbers of its lines that look
    like cargo messages (`{"reason":`) but do not parse: ([message], [line number]). None when there
    is no log."""
    lines = read_lines(path)
    if lines is None:
        return None
    out, unread = [], []
    for n, line in enumerate(lines, 1):
        if not line.startswith('{"reason":'):
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            unread.append(n)
    return out, unread


def clippy_diagnostics(path):
    """The findings in a `cargo clippy --message-format=json` log, and the numbers of its lines that
    look like cargo messages (`{"reason":`) but do not parse: ({(file, code, message): {(line,
    column)}}, [line number]). A finding is a compiler message with a primary span and a code: its
    lint or error code (diagnostic `code.code`), or UNCODED_ERROR for an error with none. The same
    finding in several of a crate's targets (a module that the lib test and a test binary both
    build) is one, by its place. None when there is no log."""
    got = cargo_messages(path)
    if got is None:
        return None
    events, unread = got
    out = {}
    for ev in events:
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


def clippy_baseline_lines(log, crate, crate_dir, metadata, baseline_path=CLIPPY_BASELINE):
    """The baseline lines of one crate's findings in its log (the regeneration step's input). A
    compile error with no code is never a baseline line; it and any line that did not parse are
    named in a comment line instead, so a regenerated baseline cannot take them in unseen. A crate
    the log shows was not linted whole (clippy_not_linted) gives its lines in the baseline at
    BASELINE_PATH unchanged, after a comment naming the units it did not lint: a regenerated
    baseline cannot drop a line for a unit that was not linted."""
    seen = clippy_not_linted(log, crate, metadata)
    if seen is None or seen[0]:
        why = (f"the cargo metadata ({metadata}) names no units of {crate}" if seen is None else
               f"{len(seen[0])} unit(s) were not linted: " + ", ".join(u for u, _ in seen[0][:12]) + (", ..." if len(seen[0]) > 12 else ""))
        print(f"# {crate}: not linted whole ({why}), so its lines are the baseline's, unchanged")
        for (c, f, code, msg), n in sorted(read_clippy_baseline(baseline_path).items()):
            if c == crate:
                print(f"{c}\t{f}\t{code}\t{n}\t{msg}")
        return
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


# The kinds of a cargo target that cargo calls "lib" (cargo metadata names a cdylib-only library
# `cdylib`; cargo's "could not compile" line still says `(lib test)`).
CLIPPY_LIB_KINDS = ("lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro")


def clippy_target(kinds, name):
    """A cargo target in cargo's own words: `lib`, `build script`, or `<kind> "<name>"`."""
    if any(k in CLIPPY_LIB_KINDS for k in kinds):
        return "lib"
    if "custom-build" in kinds:
        return "build script"
    return f'{kinds[0] if kinds else "?"} "{name}"'


def clippy_unit(kinds, name, test):
    """A unit cargo builds, in the words of its `could not compile `crate` (<unit>)` line: the
    target, and ` test` for one built as a test harness, except a test or bench target (cargo
    says `lib test`, `bin "obash" test`, `test "comptest"`)."""
    target = clippy_target(kinds, name)
    return target + " test" if test and not target.startswith(("test ", "bench ")) else target


def clippy_unit_target(unit):
    """The target of a unit clippy_unit names."""
    return unit[:-len(" test")] if unit.endswith(" test") and not unit.startswith(("test ", "bench ")) else unit


def clippy_units(metadata, crate):
    """(manifest path, [unit]) for the units `cargo clippy -p CRATE --tests` builds, from `cargo
    metadata --no-deps`: its build script, each target cargo tests (`test` true in the metadata),
    built as a test, and `lib` when another of those targets needs the library. None when the
    metadata cannot be read, names no such package, or names no unit of it: a crate with no unit
    to compare has not been seen linted, so it can never read clean."""
    try:
        pkg = next((p for p in json.load(open(metadata, encoding="utf-8"))["packages"] if p["name"] == crate), None)
        if pkg is None:
            return None
        units, has_lib, needs_lib = [], False, False
        for t in pkg["targets"]:
            target = clippy_target(t["kind"], t["name"])
            has_lib |= target == "lib"
            if target == "build script":
                units.append(target)
            elif t.get("test", target == "lib" or t["kind"][0] in ("bin", "test")):
                units.append(clippy_unit(t["kind"], t["name"], True))
                needs_lib |= target != "lib"
        if has_lib and needs_lib:
            units.insert(units.index("lib test") if "lib test" in units else len(units), "lib")
        return (pkg["manifest_path"], units) if units else None
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None


def clippy_not_linted(log, crate, metadata):
    """Each unit of CRATE that its `cargo clippy --tests --message-format=json` log (stdout and
    stderr) shows clippy did not lint, with why, and the number it did lint: ([[unit, why]],
    linted); None when the metadata names no units of the crate. A unit was linted when cargo
    reports its artifact, or reports that it did not compile while every error rustc gave its
    target was a lint (rustc runs all of a crate's lints before it stops on lint errors). A unit
    whose target had another error (a code E0000-E9999 or none) was not linted whole: rustc stops
    on it before its later lints. A unit cargo neither built nor reported was not linted at all:
    cargo builds no unit whose dependency did not compile (at Cut15, Cut16 and Cut17, pi-shell's
    lib failed on one lint under -D warnings, and none of its 71 tests nor obash was linted)."""
    got = clippy_units(metadata, crate)
    if got is None:
        return None
    manifest, units = got
    built, failed, others, lint_errors, errors = set(), [], [], set(), {}
    for ev in (cargo_messages(log) or ([], []))[0]:
        if ev.get("manifest_path") != manifest or not isinstance(ev.get("target"), dict):
            continue
        kinds, name = ev["target"].get("kind") or [], ev["target"].get("name", "")
        if ev.get("reason") == "compiler-artifact":
            built.add(clippy_unit(kinds, name, (ev.get("profile") or {}).get("test")))
        elif ev.get("reason") == "compiler-message" and (ev.get("message") or {}).get("level") == "error":
            code = ((ev["message"].get("code") or {}).get("code")) or ""
            if re.fullmatch(r"E\d{4}|", code):
                errors.setdefault(clippy_target(kinds, name), ev["message"].get("message", ""))
            else:
                lint_errors.add(clippy_target(kinds, name))
    lines = read_lines(log) or []
    for line in lines:
        m = re.match(r"error: could not compile `([^`]+)` \((.+?)\)", line)
        if m and m[1] == crate:
            failed.append(m[2])
        elif m:
            others.append(f"`{m[1]}` ({m[2]})")
    needed = [f"`{u}`" for u in failed if u in ("lib", "build script")] + others
    first = next((l for l in lines if l.startswith("error") and "could not compile" not in l), None)
    skipped = (f"cargo did not build it: {', '.join(needed)} did not compile" if needed else
               f"cargo did not build it: {first[:300]}" if first else "cargo neither built it nor said that it failed")
    out = []
    for u in dict.fromkeys(units + failed):
        target = clippy_unit_target(u)
        if u in built or (u in failed and target in lint_errors and target not in errors):
            continue
        if u in failed:
            why = f"error: {errors[target][:300]}" if target in errors else "no error message"
            out.append([u, f"it did not compile ({why}), so rustc did not run all its lints"])
        else:
            out.append([u, skipped])
    return out, len(dict.fromkeys(units + failed)) - len(out)


def parse_clippy(log, exit_code, secs, crate, crate_dir, ctl_log, ctl_file, metadata, baseline_path=CLIPPY_BASELINE):
    """One crate's clippy result, by the cut's rule against the baseline. Its findings are those in
    files under its own directory (a dependency's are not this crate's). FAIL: a finding whose key
    the baseline lacks, a key with more places than the baseline counts, or a compile error with no
    code (UNCODED_ERROR, which no baseline line holds: its target was never linted), each place
    named `file:line: code: message`. KNOWN: findings, each within the baseline. PASS: no finding.
    Each unit of the crate that it did not lint (clippy_not_linted, from METADATA's targets) is
    named in not_linted and reads UNKNOWN: the crate cannot read PASS or KNOWN then, a finding it
    did read still fails it, and no baseline line is listed as fallen (a key with fewer places here
    may be in a unit it did not lint).
    A baseline key with fewer places here is listed (baseline_fell) with the line that replaces it,
    never a failure. KNOWN and PASS also need the control run to read the unused import clippy.sh
    planted in the crate's library root, a finding the baseline lacks. Anything else is UNKNOWN: no
    log, a log line that looks like a cargo message but does not parse (its finding is unread), an
    exit other than 0 or 101 (clippy did not finish), exit 101 with no finding of its own. Every
    lint is a warning (clippy.sh: --cap-lints warn), so a finding comes with exit 0 as with 101."""
    base = {(f, code, msg): n for (c, f, code, msg), n in read_clippy_baseline(baseline_path).items()
            if c == crate and code != UNCODED_ERROR}
    unlinted = []

    def r(status, failures=(), note="", fell=()):
        res = result("clippy", crate, "runner", status, exit_code, secs, failed=len(failures), failures=failures, note=note)
        res["baseline_fell"] = list(fell)
        res["not_linted"] = list(unlinted)
        return res

    if crate_dir == "-":
        return r("UNKNOWN", note=f"the tree has no package {crate}")
    got = clippy_diagnostics(log)
    if got is None:
        return r("UNKNOWN", note="no log")
    diags, unread = got
    own = {k: v for k, v in diags.items() if k[0].startswith(crate_dir.rstrip("/") + "/")}
    seen = clippy_not_linted(log, crate, metadata)
    if seen is None:
        return r("UNKNOWN", note=f"the cargo metadata ({metadata}) names no units of {crate}, so what clippy linted is not known")
    unlinted[:] = seen[0]
    gap = (f"{len(unlinted)} of {len(unlinted) + seen[1]} unit(s) of {crate} were not linted, each named UNKNOWN"
           if unlinted else "")
    try:
        code = int(exit_code)
    except ValueError:
        code = None
    if code not in (0, 101):
        return r("UNKNOWN", note=f"exit {exit_code}: clippy did not finish" + (" (the time bound ended it)" if code == 124 else ""))
    if code == 101 and not own and not unread:
        first = next((l for l in read_lines(log) or () if l.startswith("error")), "no error line")
        return r("UNKNOWN", note=f"exit 101 and no finding under {crate_dir}/, so it was not linted: {first[:300]}")
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
    if unlinted and fell:
        gap += f"; {len(fell)} baseline line(s) with fewer places here are not listed for removal, as a unit not linted may hold them"
        fell = []
    if unread:
        return r("UNKNOWN", beyond, f"log line(s) {', '.join(map(str, unread[:12]))} look like cargo messages and do not parse, "
                                    "so their findings are unread", fell)
    ctl = clippy_diagnostics(ctl_log)
    caught = ctl is not None and any(f == ctl_file and lint == "unused_imports" and CLIPPY_CONTROL in msg for f, lint, msg in ctl[0])
    said = "the planted control read as a finding beyond the baseline" if caught else (
        "the control left no log" if ctl is None else f"the control's unused import planted in {ctl_file} was not read as a finding")
    if beyond:
        return r("FAIL", beyond, f"{len(beyond)} finding(s) beyond the baseline; {known} within it; {said}" + (f"; {gap}" if gap else ""), fell)
    if unlinted:
        return r("UNKNOWN", note=f"{gap}; in the units it linted, {known} finding(s), each within the baseline; {said}")
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
    ws = rustfmt_workspaces()
    if ws is None:
        notes["rustfmt"] = f"no list of cargo workspaces at {RUSTFMT_WORKSPACES_LIST}, so no workspace can be checked"
    else:
        for m in ws:
            exp.append(("rustfmt", m, "runner"))
    exp.append(("membench", MEMBENCH_UNIT, "runner"))
    for u in BUILTINS_LINT_UNITS:
        exp.append(("builtins-lint", u, "runner"))
    exp.append(("bazel-lock", BAZEL_LOCK_UNIT, "runner"))
    return exp, notes


def fmt_secs(s):
    s = float(s)
    return f"{s / 60:.1f} min" if s >= 90 else f"{s:.0f} s"


# The rows whose units are shards a test moves between (ts-ca: files by sorted index; workspace:
# nextest's count partitions), where a known-failure entry may name `*` for any unit, and the first-
# seen comparison reads a finding in any unit of the row. The Rust rows are here for the second
# reason only: one job's step and the cold control's find the same thing, and the control runs every
# fifth cut, so a finding compared in its own unit would read first seen at each cut that runs it.
# On the other rows a unit is a binary or a suite, and a test's name is unique only inside it.
ANY_UNIT_ROWS = ("ts-ca", "workspace") + RUST_ROW_KEYS


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


# The summary's comparison with the previous cut ("First seen at this cut"). A failure's words hold
# parts that move when other lines of the tree move (a line number, a column): each (rows, pattern,
# replacement) here takes one out in those rows, so that finding_key names the same finding at two
# cuts, and keeps what tells one finding from another (its file, lint and message; the source line
# where the row prints it, as builtins-lint does; a panic's assertion). A row this does not name
# keeps its words whole, so a finding there that only moved reads first seen, never standing. What it
# cannot tell apart: a finding fixed at one place and made again, with the same words, at another
# place of the same file in the same cut reads as one that moved. The clippy and docs rows print no
# source line, so there the same words are a file, a lint (or a link) and a message.
FINDING_MOVES = (
    # A lint place, `path:line[:col]: ...` (cargo clippy, rustdoc, rustfmt): its line and column.
    (("clippy", "builtins-lint", "docs", "rustfmt"), re.compile(r"^([^\s:]+):\d+(?::\d+)?(?=: )"), r"\1"),
    # The clippy row's count of a finding beyond its baseline, ` (3 here, 1 in the baseline)`: the
    # comparison counts the places itself.
    (("clippy",), re.compile(r" \(\d+ here, \d+ in the baseline\)$"), ""),
    # A skip print of the tree, `...: path:line: 'text'`: its line; a skip line a test printed: how
    # often, and which test printed it first.
    (("skipforms",), re.compile(r"^(a skip print the summary does not read: [^\s:]+):\d+(?=: )"), r"\1"),
    (("skipforms",), re.compile(r", printed \d+ time\(s\), first by .*$"), ""),
    # A memory bench target that missed: its name, without its measured numbers; the bench's exit
    # and its panic (`exit 101: thread 'main' panicked at path:line:col: <assertion>`): the panic's
    # line and column, its assertion kept whole.
    (("membench",), re.compile(r"^([^:]+): .*\(target\b.*$"), r"\1"),
    (("membench",), re.compile(r"^(exit [^\s:]+: .*? panicked at [^\s:]+):\d+:\d+(?=:)"), r"\1"),
    # A command's exit, `unit: exit N: <its last lines>` (check:ts): each error's place in its last
    # lines (`(line,col)`, `:line:col`), so the same errors elsewhere are standing and another is not.
    (("checkts",), re.compile(r"^(.*?: exit [^\s:]+: )(.*)$"), lambda m: m[1] + re.sub(r"\(\d+,\d+\)|:\d+:\d+", "(#)", m[2])),
    # A platform test that did not pass: the verdict the platform checks add to it (` (TIMEOUT)`).
    (PLATFORMS, re.compile(r" \([A-Z_]+\)$"), ""),
    # A Rust row's finding (`<title>: <message>`, the annotation its job's script wrote): the sample
    # of what it found that the message ends with (the first line of many, the line a test printed,
    # the tests a filter took out, the names libtest-bound stopped), each place's line and column,
    # and every count. What is left is the title, the target, the test and the complaint, so that a
    # target that fails to build is one finding at every cut, and one more test of it is not another.
    # Each rule is applied at every place of the words, not only the first.
    (RUST_ROW_KEYS, re.compile(r", the first: .*$"), ""),
    (RUST_ROW_KEYS, re.compile(r"(so it checked nothing): .*$"), r"\1"),
    (RUST_ROW_KEYS, re.compile(r"(, not exactly that one of \S+): .*$"), r"\1"),
    (RUST_ROW_KEYS, re.compile(r"(; libtest-bound\.py stopped it and failed these[^:]*): .*$"), r"\1"),
    (RUST_ROW_KEYS, re.compile(r"(reported )\[[^\]]*\]"), r"\1[the tests it reported]"),
    (RUST_ROW_KEYS, re.compile(r"([^\s:]+\.(?:rs|ts|toml|tsv|txt|log|json|awk|sh)):\d+(?::\d+)?"), r"\1"),
    # A count stands alone and is no exit code: a digit joined to a word by `-` or `_` is part of a
    # name, and an invocation's name (`own-0`, `own-1`, `sticky-root-2`, `ignored-opt-3`) tells one
    # test's own run from another's where the message names the invocation and not the test; a
    # number after `exited ` is a command's exit code, and Bazel's 8 (interrupted) and 36 (a local
    # environment it cannot trust) are different faults.
    (RUST_ROW_KEYS, re.compile(r"(?<!exited )(?<![\w-])\d+(?![\w-])"), "#"),
)
# A CHANGELOG the check would rewrite, `path: 0 promoted item(s), ..., 28 collapsed release(s); from
# line N: <its first changed lines>` (parse_changelog): one finding per kind of rewrite, counted.
CHANGELOG_KINDS = re.compile(r"^([^\s:]+): ([^;]*)(?:; .*)?$")
# check:ts's one failure, `check:ts: exit N: <its last lines, joined by ` / `>` (parse_plain): one
# finding per type error of those lines, `path: error TSnnnn: <message>`, so that another error
# among them is first seen. The line and column are left out, as FINDING_MOVES leaves them out of
# the whole failure. What it cannot see: an error above the last lines parse_plain keeps.
CHECKTS_ERROR = re.compile(r"(\S+)\(\d+,\d+\): (error TS\d+: .*?)(?= / |$)")
# How many of the failures of a unit with no result at the previous cut its first_seen entry names
# (and each that names a planted run's plant).
FIRST_SEEN_NAMED = 10


def finding_key(row, failure):
    """A failure's identity across cuts: its words without what FINDING_MOVES says moves in its row,
    taken out at every place of the words (each rule of the rows before the Rust ones can match only
    once: it is anchored to the start or the end of the failure)."""
    for rows, pattern, repl in FINDING_MOVES:
        if row in rows:
            failure = pattern.sub(repl, failure)
    return failure


def finding_keys(row, failure):
    """The findings one failure names, {key: how many}: a CHANGELOG the check would rewrite is one
    finding per kind of rewrite it needs, `path: <kind>`, as many as the check counts (so one more
    empty heading in a file that had one is first seen); check:ts's one failure is one finding per
    type error of the lines it holds, so that another error among them is first seen; any other
    failure is one, finding_key."""
    m = CHANGELOG_KINDS.match(failure) if row == "changelog" else None
    kinds = {f"{m[1]}: {k.strip()}": int(n) for n, k in re.findall(r"(\d+) ([^,]+)", m[2]) if n != "0"} if m else {}
    if not kinds and row == "checkts":
        for path, said in CHECKTS_ERROR.findall(failure):
            kinds[f"{path}: {said}"] = kinds.get(f"{path}: {said}", 0) + 1
    return kinds or {finding_key(row, failure): 1}


def compared_unit(row, unit):
    """The unit a failure is compared in: its own, or `*`, any unit of its row, in ANY_UNIT_ROWS (a
    coding-agent test moves to another shard when a file is added before it)."""
    return "*" if row in ANY_UNIT_ROWS else unit


def read_previous(path):
    """The previous cut's report for "First seen at this cut": PATH, the directory sc.py
    previous-report fills (that run's sc-report: results.json and verdict.json; about.json naming the
    run, or why none could be read). Returns (index, rows, against, why). index is {(row, who,
    compared unit): ({finding key: places}, {test that passed}, {unit status})}, and rows the row
    verdicts of its verdict.json (None when it has none to read); against names the report. A test
    that skipped itself did not pass. A unit two jobs reported (which its summary read UNKNOWN)
    counts each finding at the fewest places either report names, as UNKNOWN, so that a double count
    never makes a new place of a finding read standing. index is None, and why says why, when there is
    nothing to compare with: no report named, one the fetch step could not get, a results.json that is
    missing, does not parse or is no list of unit results, and one that holds no result, since against
    nothing every failure would read first seen."""
    if not path:
        return None, None, "nothing", "no previous report was given to the summary (SC_PREVIOUS is not set)"
    about = {}
    about_path = os.path.join(path, "about.json")
    if os.path.exists(about_path):
        try:
            about = json.load(open(about_path, encoding="utf-8"))
            if not isinstance(about, dict):
                raise ValueError("it is no JSON object")
        except (OSError, ValueError) as e:
            return None, None, path, f"{about_path}, which names the previous report, does not parse ({e})"
    against = about.get("from") or path
    if about.get("why"):
        return None, None, against, about["why"]
    results_path = os.path.join(path, "results.json")
    try:
        prev = json.load(open(results_path, encoding="utf-8"))
    except FileNotFoundError:
        return None, None, against, (f"its results.json is not there ({results_path})"
                                     + ("" if about else "; no about.json says why"))
    except (OSError, ValueError) as e:
        return None, None, against, f"its results.json does not parse ({type(e).__name__}: {e})"[:400]
    if not isinstance(prev, list):
        return None, None, against, f"its results.json is a JSON {type(prev).__name__}, not a list of unit results"
    if not prev:
        return None, None, against, "its results.json holds no unit result, so there is nothing to compare with"
    shape = {"row": str, "unit": str, "who": str, "status": str, "failures": list, "tests": list}
    reports = {}
    for i, r in enumerate(prev):
        lacks = [k for k, t in shape.items() if not isinstance(r, dict) or not isinstance(r.get(k), t)]
        if lacks or not all(isinstance(t, list) and t and isinstance(t[0], str) for t in r["tests"]) \
                or not all(isinstance(f, str) for f in r["failures"]) or not isinstance(r.get("self_skipped", []), list):
            return None, None, against, (f"its results.json is not a list of unit results: entry {i} has no "
                                         + (", ".join(lacks) if lacks else "list of test names, failures and self-skips"))
        # A unit whose job did not run at that cut (a Rust row's cold control, which runs every
        # fifth cut) is left out of the index: it held no finding and it looked for none, so it must
        # neither let a finding of this cut read standing nor make its row read UNKNOWN there.
        fails = {}
        for f in r["failures"]:
            for k, n in finding_keys(r["row"], f).items():
                fails[k] = fails.get(k, 0) + n
        bad = set(r["failures"]) | set(r.get("self_skipped", []))
        reports.setdefault((r["row"], r["who"], r["unit"]), []).append(
            (fails, {t[0] for t in r["tests"] if t[0] not in bad}, r["status"]))
    index = {}
    for (row, who, unit), got in reports.items():
        if len(got) == 1:
            fails, passed, statuses = got[0][0], got[0][1], {got[0][2]}
        else:
            fails = {k: min(f.get(k, 0) for f, _, _ in got) for k in set().union(*(f for f, _, _ in got))}
            passed = set.intersection(*(p for _, p, _ in got))
            statuses = {s for _, _, s in got} | {"UNKNOWN"}
        into = index.setdefault((row, who, compared_unit(row, unit)), ({}, set(), set()))
        for k, n in fails.items():
            into[0][k] = into[0].get(k, 0) + n
        into[1].update(passed)
        into[2].update(statuses)
    rows = None
    try:
        rows = json.load(open(os.path.join(path, "verdict.json"), encoding="utf-8")).get("rows")
    except (OSError, ValueError, AttributeError):
        pass
    return index, rows if isinstance(rows, dict) else None, against, None


def row_first_seen(row, rs, index, reading, keep=None):
    """The failures of one row's units (RS) that the previous cut's report (read_previous's INDEX)
    does not hold, as entries of verdict.json's first_seen: each failure naming a finding
    (finding_keys) its compared unit there lacks, or counts fewer times than this cut (each failure
    naming it here is then listed), with the evidence in `previous`; and one entry for each unit with
    failures that has no result there at all, whose failures none could be compared: it counts them
    (`failed`) and names the first FIRST_SEEN_NAMED and each that KEEP(f) holds (`failures`: a planted
    run's plant). READING(r, f): the summary's word for a failure, NEW or KNOWN. On a Rust row one
    finding is one fault, which two jobs of the row report when both ran (the cold control is the
    seeded job again), so there a finding is compared by whether the previous cut had it, not by how
    many places have it, and one entry names it."""
    groups = {}
    for r in rs:
        for f in r["failures"]:
            groups.setdefault((r["who"], compared_unit(row, r["unit"])), []).append((r, f))
    out = []
    for (who, unit), items in groups.items():
        where = "its row (any unit)" if unit == "*" else "its unit"
        prev = index.get((row, who, unit))
        if prev is None:
            for r in {id(r): r for r, _ in items}.values():
                mine = [f for s, f in items if s is r]
                named = mine[:FIRST_SEEN_NAMED] + [f for f in mine[FIRST_SEEN_NAMED:] if keep is not None and keep(f)]
                out.append({"kind": "unit", "row": row, "who": who, "unit": r["unit"], "finding": f"{len(mine)} failure(s)",
                            "reading": None, "previous": f"the previous cut's report has no result for {where}",
                            "failed": len(mine), "failures": named})
            continue
        fails, passed, statuses = prev
        counts, naming = {}, {}
        for r, f in items:
            for k, n in finding_keys(row, f).items():
                counts[k] = counts.get(k, 0) + n
                naming.setdefault(k, []).append((r, f))
        if row in RUST_ROW_KEYS:
            counts = {k: 1 for k in counts}
            naming = {k: v[:1] for k, v in naming.items()}
        marks = {}
        for k, n in counts.items():
            m = fails.get(k, 0)
            if n <= m:
                continue
            if m:
                said = (f"the previous cut counted {m} {k.partition(': ')[2] or k} in it, this cut {n}" if row == "changelog"
                        else f"the previous cut had it at {m} place(s) of {where}, this cut at {n}")
            elif k in passed:
                said = "it passed at the previous cut"
            elif "UNKNOWN" in statuses:
                said = f"{where} did not have it at the previous cut, and read UNKNOWN there, so it may have been missed"
            else:
                said = f"{where} did not have it at the previous cut"
            for r, f in naming[k]:
                marks.setdefault((id(r), f), []).append(said)
        listed = set()
        for r, f in items:
            said = marks.get((id(r), f))
            if said and (id(r), f) not in listed:
                listed.add((id(r), f))
                out.append({"kind": "failure", "row": row, "who": who, "unit": r["unit"], "finding": f, "reading": reading(r, f),
                            "previous": "; ".join(said)})
    return out


def read_findings(path):
    """One findings file (.github/sami/findings.sh, SAMI_FINDINGS): ([(kind, title, message)], why).
    A line is `finding<TAB><title><TAB><message>`, `stop<TAB><title><TAB><message>` (the step
    stopped there) or the last line, `end<TAB><how many findings>`. why is None when the file is
    whole: every line is a record, the end line is its last, and it counts the findings the file
    holds. Else why says what is wrong with it: the findings it does hold are returned all the same,
    and its unit reads UNKNOWN, since what the step would have found after is not known."""
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError as e:
        return [], f"it could not be read ({type(e).__name__}: {e})"[:300]
    out = []
    for i, line in enumerate(lines):
        parts = line.split("\t")
        if parts[0] in ("finding", "stop") and len(parts) == 3:
            out.append((parts[0], parts[1], parts[2]))
        elif parts[0] == "end" and len(parts) == 2 and parts[1].isascii() and parts[1].isdigit():
            held = sum(1 for k, _, _ in out if k == "finding")
            if i != len(lines) - 1:
                return out, f"its end line is line {i + 1} of {len(lines)}, and it must be its last"
            if any(k == "stop" for k, _, _ in out):
                return out, "it holds both a record of a step that stopped and an end line"
            if int(parts[1]) != held:
                return out, f"its end line counts {parts[1]} finding(s), and it holds {held}"
            return out, None
        else:
            return out, f"its line {i + 1} is no record of a findings file: {line[:120]!r}"
    if out and out[-1][0] == "stop":
        return out, (f"the step stopped at its last finding ({out[-1][1]}), so what it would have found after it is "
                     "not known")
    return out, ("it is empty, so the step wrote no record at all" if not lines else
                 "it has no end line, so the step was cut short before it had looked at everything")


def rust_findings_results(findings_dir, conclusions):
    """One unit result per step of the Rust rows that writes findings (RUST_FINDING_STEPS), read from
    FINDINGS_DIR, which holds the artifact sc-findings-<job> of each of their jobs as a directory of
    that name. CONCLUSIONS is {job: its result} (SC_RUST_JOBS). A step's unit is `<job>/<step>`, and
    its status is FAIL when it found something, PASS when it looked and found nothing, UNKNOWN when
    its file is missing, cannot be read whole or holds a step that stopped, and NOT RUN when its job
    did not run (`skipped`, or no result at all), which is no gap: its findings would be its row's
    other jobs' too. Only a unit that ran may let a finding of the next cut read standing, so a NOT
    RUN unit is left out of the next cut's index (read_previous)."""
    out = []
    for row, jobs in RUST_FINDING_STEPS.items():
        for job, steps in jobs:
            conclusion = conclusions.get(job, "")
            for step in steps:
                unit, path = f"{job}/{step}", os.path.join(findings_dir, f"sc-findings-{job}", f"{step}.tsv")
                if not os.path.exists(path):
                    if conclusion in ("", "skipped"):
                        out.append(result(row, unit, "runner", "NOT RUN", "-", 0,
                                          note=f"the {job} job did not run (its result is [{conclusion or 'none'}])"))
                    else:
                        out.append(result(row, unit, "runner", "UNKNOWN", "-", 0,
                                          note=f"the {job} job ended [{conclusion}] and this step wrote no findings file "
                                               f"({path}), so what it found is not known"))
                    continue
                found, why = read_findings(path)
                fails = [f"{t}: {m}" for _, t, m in found]
                out.append(result(row, unit, "runner", "UNKNOWN" if why else ("FAIL" if fails else "PASS"), "-", 0,
                                  failed=len(fails), failures=fails,
                                  note=(f"its findings file could not be read whole: {why}; it holds {len(fails)} finding(s)"
                                        if why else f"the step found {len(fails)} thing(s) and reached its end")))
    return out


def cmd_rust_findings(findings_dir, out_dir):
    """sami-checks.yml's step before the summary: the Rust rows' findings as unit results, which the
    summary reads with every other result, so that each of them is compared with the previous cut's
    (row_first_seen). The row's verdict is still its job's conclusion (SC_RUST_TESTS)."""
    os.makedirs(out_dir, exist_ok=True)
    conclusions = dict(p.split("=", 1) for p in os.environ.get("SC_RUST_JOBS", "").split() if "=" in p)
    for r in rust_findings_results(findings_dir, conclusions):
        with open(os.path.join(out_dir, r["unit"].replace("/", "_") + ".json"), "w", encoding="utf-8") as f:
            json.dump(r, f)
        print(f"RUST FINDINGS {r['row']} {r['unit']}: {r['status']}, {len(r['failures'])} finding(s): {r['note']}")


def rust_first_seen(row_verdicts, prev_rows, read):
    """The Rust rows (RUST_JOBS) beside their findings (row_first_seen reads those): READ is
    {row: ([the units that looked], [(unit, why it could not be read)])}. A row no unit of which
    could be read is compared by its verdict alone, as it was before its jobs wrote their findings:
    a FAIL the previous cut's verdict.json does not give the row is first seen, and a FAIL at both
    cuts is named as not compared. A unit that could not be read is named as not compared whatever
    the row's verdict, since a finding of it is in no list. Returns (entries, not compared)."""
    out, blind = [], []
    for title, job in RUST_JOBS:
        if row_verdicts.get(job) in (None, "NOT RUN"):
            continue
        looked, unread = read.get(job, ([], []))
        for unit, why in unread:
            blind.append(f"{title}: `{unit}` could not be read, so its findings are in no list: {why}")
        if looked or row_verdicts.get(job) != "FAIL":
            continue
        before = prev_rows.get(job) if prev_rows is not None else None
        if prev_rows is None:
            blind.append(f"{title}: FAIL, no unit of it could be read, and the previous cut's verdict.json gives no row "
                         "verdicts to compare its verdict with")
        elif before == "FAIL":
            blind.append(f"{title}: FAIL at this cut and at the previous one, and no unit of it could be read, so a finding "
                         "first made here is not seen (that job's annotations and log name them)")
        else:
            out.append({"kind": "row", "row": job, "who": None, "unit": None, "finding": "the row reads FAIL", "reading": None,
                        "previous": f"it read {before or 'nothing: the row was not in its report'} at the previous cut, and no "
                                    "unit of it could be read here, so its findings were not compared"})
    return out, blind


def gh_api(path):
    """`gh api PATH`'s output, as bytes (GH_TOKEN: the job's token, which holds actions: read)."""
    try:
        p = subprocess.run(["gh", "api", path], capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError(f"gh api {path} did not run ({e})") from e
    if p.returncode != 0:
        said = " / ".join((p.stderr or p.stdout).decode("utf-8", "replace").split("\n")).strip(" /")
        raise RuntimeError(f"gh api {path} exited {p.returncode}: {said[:300] or 'no message'}")
    return p.stdout


# How many of the newest completed release-candidate pushes' runs previous-report reads to find the
# one before this run (two cuts are seldom more than a few pushes apart).
PREVIOUS_RUNS = 30


def previous_report(out_dir, api=gh_api):
    """sami-checks.yml's step before the summary: the previous cut's report, for "First seen at this
    cut". The run is the one the dispatch input `previous` names (SC_INPUT_PREVIOUS), else the newest
    completed sami-checks run on a push of release-candidate before this one (GITHUB_RUN_ID) whose
    commit is not this run's (SC_COMMIT). The results.json and verdict.json of its sc-report go to
    OUT_DIR, beside about.json: {"run", "commit", "url", "from" (the words the summary names it by),
    "why"}. why is null when results.json was written, else why it could not be, and the summary then
    reads first seen UNKNOWN. When that run has no report (its sc-report expired, or its summary
    uploaded none), no older run is tried: against an older cut, a failure first seen at the cut
    between would read first seen here. API: `gh api`. Returns about."""
    import io
    import zipfile
    os.makedirs(out_dir, exist_ok=True)
    about = {"run": None, "commit": None, "url": None, "from": None, "why": None}

    def done(why=None):
        about["why"] = why
        with open(os.path.join(out_dir, "about.json"), "w", encoding="utf-8") as f:
            json.dump(about, f)
        print(f"PREVIOUS {about['from'] or 'no run'}: " + (f"UNKNOWN: {why}" if why else "its results.json is read"))
        return about

    repo, this_run = os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_RUN_ID", "")
    commit, named = os.environ.get("SC_COMMIT", ""), os.environ.get("SC_INPUT_PREVIOUS", "").strip()
    if not repo or not this_run.isdigit():
        return done("this run has no GITHUB_REPOSITORY or GITHUB_RUN_ID, so no earlier run could be looked for")
    try:
        if named:
            if not named.isdigit():
                return done(f"the dispatch input previous ({named!r}) is no run id")
            run, how = json.loads(api(f"repos/{repo}/actions/runs/{named}")), "the run the dispatch input previous names"
        else:
            runs = json.loads(api(f"repos/{repo}/actions/workflows/sami-checks.yml/runs?branch=release-candidate&event=push"
                                  f"&status=completed&per_page={PREVIOUS_RUNS}"))["workflow_runs"]
            run = next((r for r in runs if r["id"] < int(this_run) and r["head_sha"] != commit), None)
            if run is None:
                return done(f"none of the newest {len(runs)} completed sami-checks runs on a push of release-candidate is "
                            "a run before this one, of another commit")
            how = "the newest completed push of release-candidate before this run"
        about.update(run=run["id"], commit=run["head_sha"], url=run.get("html_url"),
                     **{"from": f"run {run['id']} ({how}), of {run['head_sha'][:12]}"})
    except (RuntimeError, ValueError, KeyError, TypeError) as e:
        return done(f"the previous run could not be found: {e}"[:500])
    try:
        arts = json.loads(api(f"repos/{repo}/actions/runs/{run['id']}/artifacts?name=sc-report&per_page=10"))["artifacts"]
        live = [a for a in arts if a.get("name") == "sc-report" and not a.get("expired")]
        if not live:
            gone = [a for a in arts if a.get("name") == "sc-report"]
            return done(f"run {run['id']}'s sc-report expired at {gone[0].get('expires_at')} (an sc-report is kept 30 days)" if gone
                        else f"run {run['id']} has no sc-report artifact (its summary job uploaded none)")
        data = api(f"repos/{repo}/actions/artifacts/{live[0]['id']}/zip")
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = set(z.namelist())
            if "results.json" not in names:
                return done(f"run {run['id']}'s sc-report holds no results.json (it holds {', '.join(sorted(names)) or 'nothing'})")
            for name in ("verdict.json", "results.json"):
                if name in names:
                    with open(os.path.join(out_dir, name), "wb") as f:
                        f.write(z.read(name))
    except (RuntimeError, ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile) as e:
        return done(f"run {run['id']}'s sc-report could not be read: {e}"[:500])
    return done()


# A unit that counts its findings (its result's `breakdown`) lists this many of each kind (FAILED,
# KNOWN, UNSORTED) among the summary's details, and its section lists this many lints and files.
LISTED_PER_KIND = 25
BREAKDOWN_LISTED = 40


def summary_rows():
    """The rows this run planned: SC_ROWS (the plan's output `rows`, a comma list), or every row when
    it is unset. A row it does not name reads NOT RUN."""
    text = os.environ.get("SC_ROWS")
    if text is None:
        return list(ROW_KEYS)
    rows = [r for r in text.split(",") if r]
    bad = [r for r in rows if r not in ROW_KEYS]
    if bad or not rows:
        sys.exit(f"::error::SC_ROWS names no row of the summary: {', '.join(bad) or '(nothing)'}")
    return rows


def cmd_summary(results_dir, build_dir, known_path=None):
    # A known-failure list the caller names and that is not there is a list the summary could not
    # read: without it every known failure would read NEW, and no stale entry could be listed.
    if known_path is not None and not os.path.isfile(known_path):
        sys.exit(f"::error::the known-failure list {known_path} is not a file, so no failure could be read as known")
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

    run_rows = summary_rows()
    # Only the rows this run planned are read: a row it did not plan reads NOT RUN, and no unit of it is expected.
    results = [r for r in load_results(results_dir) if r["row"] in run_rows]
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
    exp = [e for e in exp if e[0] in run_rows]
    # The previous cut's report, for "First seen at this cut" (read_previous): an index of its failures,
    # or None and the reason it could not be read, which then reads UNKNOWN, never as nothing first seen.
    # A report-only comparison never stops the summary: a fault in reading the report is that reason.
    try:
        prev_index, prev_rows, prev_from, prev_why = read_previous(os.environ.get("SC_PREVIOUS"))
    except Exception as e:
        prev_index, prev_rows = None, None
        prev_from, prev_why = os.environ.get("SC_PREVIOUS") or "nothing", f"reading it failed ({type(e).__name__}: {e})"[:400]
    first_seen = []
    lines = []
    commit = os.environ.get("SC_COMMIT", "?")
    lines.append(f"## sami checks of `{commit}`")
    lines.append("")
    lines.append("Report only: nothing here gates a release. A row passes when every unit in it was read and passed, "
                 "and reads KNOWN when its only failures are on the known-failure list. A unit is UNKNOWN when its "
                 "runner did not end normally (libtest 0/101, nextest 0/100, bun 0/1 with its summary line, clippy "
                 "0/101), when a passing test printed a skip marker and passed as no other user (even when every "
                 "failure of the unit is known), when a clean clippy crate's planted control was not caught, when "
                 "clippy did not lint a unit of its crate (each one named: a finding it read still fails it), when the "
                 "platform checks gave its platform no verdict, when cargo fmt listed no target root or rustfmt could "
                 "not read a file, when rustfmt's places could not be sorted by its run at the upstream base, or when "
                 "no job (or more than one) reported it; its "
                 "row is then UNKNOWN too, unless another of its units failed: a failure outranks a unit that could not "
                 "be read. A test whose only skip lines are sub-cases the partial-skip list names for "
                 "it, with that entry's witness line in its output, passes and is listed as partial. A self-skip the "
                 "known-failure list names (`skips: `, for that row and user) reads KNOWN; a failure with a `flaky: ` "
                 "entry reads KNOWN only when a retry of the test in the same job passed. The summary exits 0 when "
                 "every row that ran passed, 1 when it found a fault (a row failed, a known-failure entry is to be "
                 "removed, or the run is planted), and 2 when a row is UNKNOWN and it found no fault: 2 says that "
                 "the run could not look, not that it found something.")
    lines.append("")
    lines.append("| Row | Verdict | Units: pass / known / fail / UNKNOWN | Tests: passed / failed / ignored / skipped themselves | Longest unit |")
    lines.append("|---|---|---|---|---|")
    details = []
    verdicts = {}
    row_verdicts = {}
    for title, key in ROWS:
        if key not in run_rows:
            lines.append(f"| {title} | **NOT RUN** | - | - | - |")
            row_verdicts[key] = "NOT RUN"
            continue
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
                elif r.get("not_linted"):
                    r = dict(r, status="UNKNOWN", note=f"every failure is known, but {len(r['not_linted'])} unit(s) of the crate "
                                                       "were not linted, each named below")
                else:
                    r = dict(r, status="KNOWN")
            rs.append(r)
        if key in notes and not units:
            verdict, counts = "UNKNOWN", "-"
            details.append(f"- **{title}**: UNKNOWN: {notes[key]}")
        else:
            n = {s: sum(1 for r in rs if r["status"] == s) for s in ("PASS", "KNOWN", "FAIL", "UNKNOWN")}
            verdict = ("FAIL" if n["FAIL"] else "UNKNOWN" if n["UNKNOWN"] or not rs else "KNOWN" if n["KNOWN"] else "PASS")
            counts = f"{n['PASS']} / {n['KNOWN']} / {n['FAIL']} / {n['UNKNOWN']}"
        tp = sum(r["passed"] for r in rs)
        tf = sum(r["failed"] for r in rs)
        ti = sum(r["ignored"] for r in rs)
        ts = sum(len(r.get("self_skipped", [])) for r in rs)
        longest = max(rs, key=lambda r: r["seconds"], default=None)
        lu = f"{longest['unit']} ({longest['who']}), {fmt_secs(longest['seconds'])}" if longest else "-"
        lines.append(f"| {title} | **{verdict}** | {counts} | {tp} / {tf} / {ti} / {ts} | {lu} |")
        verdicts[key] = (verdict, rs)
        row_verdicts[key] = verdict
        # This row's failures that the previous cut's report does not hold (row_first_seen); on a
        # planted run, a unit entry of the planted row names the plant among its failures.
        planted_here = os.environ.get("SC_PLANT", "") == key and key in PLANTS
        seen_here = [] if prev_index is None else row_first_seen(
            key, rs, prev_index, lambda r, f: "NEW" if failure_reason(r, key, f)[0] is None else "KNOWN",
            keep=(lambda f: PLANTS[key][2] in f) if planted_here else None)
        first_seen += seen_here
        seen_said = {(e["unit"], e["who"], e["finding"]): e["previous"] for e in seen_here if e["kind"] == "failure"}
        for r in rs:
            if r["status"] == "UNKNOWN":
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNKNOWN: {r['note']}")
            # A unit that counts its findings (breakdown: the builtins-lint row, thousands of them)
            # lists the first of each kind here; its section below counts them all by lint and file.
            cap = LISTED_PER_KIND if "breakdown" in r else None

            def more(kind, items):
                if cap is not None and len(items) > cap:
                    details.append(f"- **{title}** `{r['unit']}` ({r['who']}): and {len(items) - cap} more {kind} (the section "
                                   "below counts them by lint and file; the sc-report artifact's results.json lists each)")

            for f in r["failures"][:cap]:
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): FAILED `{f}`: {failure_reason(r, key, f)[1]}"
                               + (f"; **first seen at this cut** ({seen_said[(r['unit'], r['who'], f)]})"
                                  if (r["unit"], r["who"], f) in seen_said else ""))
            more("FAILED", r["failures"])
            for f in r.get("baseline_fell", []):
                details.append(f"- **{title}** `{r['unit']}`: fewer here than in the clippy baseline (a change of the baseline, not a failure): {f}")
            not_linted = {}
            for u, why in r.get("not_linted", []):
                not_linted.setdefault(why, []).append(u)
            for why, us in not_linted.items():
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNKNOWN: {len(us)} unit(s) not linted, so their findings "
                               f"are not known: {why}: " + ", ".join(f"`{u}`" for u in us))
            for f in r.get("upstream_places", [])[:cap]:
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): KNOWN `{f}`: upstream's own: the same run fails at "
                               f"the upstream base `{r.get('upstream_base', '')[:12]}` on lines the fork left as they are")
            more("KNOWN", r.get("upstream_places", []))
            for f in r.get("unsorted_places", [])[:cap]:
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): UNSORTED `{f}`")
            more("UNSORTED", r.get("unsorted_places", []))
            for f in r.get("self_skipped", []):
                why = r.get("known_skips", {}).get(f)
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): SKIPPED ITSELF `{f}`" + (f": KNOWN ({why})" if why else ""))
            for f, n, why in r.get("partial", []):
                details.append(f"- **{title}** `{r['unit']}` ({r['who']}): `{f}`: partial: {n} sub-cases skipped ({why})")
    # SC_RUST_TESTS is "rust_test=<result> rust_test_macos=<result>". success passes and failure fails;
    # a job with no result (SC_RUST_TESTS absent too), or with any other (cancelled, skipped), is
    # UNKNOWN. A Rust row this run did not plan reads NOT RUN. The row's verdict is that one word
    # over every finding of its jobs, so the findings themselves are units of the row (sc.py
    # rust-findings, from each job's sc-findings artifact), read here as any other row's are: each
    # one compared with the previous cut's, each unit that could not be read named, and each unit
    # whose job did not run named as that and not as a gap.
    conclusions = dict(p.split("=", 1) for p in os.environ.get("SC_RUST_TESTS", "").split() if "=" in p)
    rust_read = {}
    for title, job in RUST_JOBS:
        if job not in run_rows:
            lines.append(f"| {title} | **NOT RUN** | - | - | - |")
            row_verdicts[job] = "NOT RUN"
            continue
        conclusion = conclusions.get(job, "")
        verdict = {"success": "PASS", "failure": "FAIL"}.get(conclusion, "UNKNOWN")
        # Every step of the row that writes findings is expected, as expected_units expects every
        # unit of the other rows: a step sc.py rust-findings wrote no result for (it failed partway,
        # or its job's artifact never landed) reads UNKNOWN here by name, never as a row that found
        # less. A result of a step this table does not name is kept as it is.
        want_rust = [f"{j}/{step}" for j, steps in RUST_FINDING_STEPS[job] for step in steps]
        got_rust = {r["unit"]: r for r in results if r["row"] == job}
        rs = [got_rust.get(u) or result(job, u, "runner", "UNKNOWN", "-", 0,
                                        note="no result: sc.py rust-findings wrote none for this step, so what it found "
                                             "is not known (that step failed, or the summary job could not read its artifact)")
              for u in want_rust]
        rs += [r for u, r in got_rust.items() if u not in set(want_rust)]
        n = {s: sum(1 for r in rs if r["status"] == s) for s in ("PASS", "FAIL", "UNKNOWN", "NOT RUN")}
        units = (f"{n['PASS']} / - / {n['FAIL']} / {n['UNKNOWN']}" + (f" ({n['NOT RUN']} did not run)" if n["NOT RUN"] else "")
                 if rs else "-")
        lines.append(f"| {title} | **{verdict}** | {units} | {sum(len(r['failures']) for r in rs)} finding(s) | - |")
        row_verdicts[job] = verdict
        rust_read[job] = ([r["unit"] for r in rs if r["status"] in ("PASS", "FAIL")],
                          [(r["unit"], r["note"]) for r in rs if r["status"] == "UNKNOWN"])
        if verdict != "PASS":
            details.append(f"- **{title}**: {verdict}: the job's conclusion is [{conclusion or 'none'}]; "
                           "its failing tests are in that job's annotations and log")
        seen_here = [] if prev_index is None else row_first_seen(
            job, rs, prev_index, lambda r, f: "NEW" if failure_reason(r, job, f)[0] is None else "KNOWN")
        first_seen += seen_here
        seen_said = {(e["unit"], e["who"], e["finding"]): e["previous"] for e in seen_here if e["kind"] == "failure"}
        for r in rs:
            if r["status"] in ("UNKNOWN", "NOT RUN"):
                details.append(f"- **{title}** `{r['unit']}`: {r['status']}: {r['note']}")
            for f in r["failures"]:
                details.append(f"- **{title}** `{r['unit']}`: FOUND `{f}`"
                               + (f": **first seen at this cut** ({seen_said[(r['unit'], r['who'], f)]})"
                                  if (r["unit"], r["who"], f) in seen_said else ""))
    # A planted run (the dispatch input `plant`) says so first, and whether the control caught its plant.
    plant = os.environ.get("SC_PLANT", "")
    top, caught = [], None
    if plant:
        path, text, needle = PLANTS[plant]
        v, rs = verdicts.get(plant, ("absent", []))
        # Each unit of the row must name the plant (docs: the public and the private build).
        missed = [r["unit"] for r in rs if r["status"] != "FAIL" or not any(needle in f for f in r["failures"])]
        each = ", ".join(f"`{r['unit']}`" for r in rs)
        caught = bool(rs) and not missed
        # A plant in more than one file names its place in words (rustfmt: one file per workspace).
        where = f"`{path}`" if " " not in path else path
        top += [f"**Planted run (`plant={plant}`)**: the {plant} job added `` {text} `` to {where} before it ran. "
                + (f"The control caught it: the row reads FAIL, and each of its units ({each}) names `{needle}`."
                   if caught else
                   f"**THE CONTROL FAILED**: the row reads {v}, and these units do not read FAIL naming `{needle}`: "
                   + (", ".join(f"`{u}`" for u in missed) or "the row has no unit") + "."), ""]
    # First seen at this cut: each failure the previous cut's report does not hold, at the top of the
    # summary, before the table and the standing failures below it. A report that could not be read
    # reads UNKNOWN, and says why, never as nothing first seen. On a planted run the plant must be in
    # the list (plant_first_seen): the comparison's own control.
    row_title = {k: t for t, k in ROWS + RUST_JOBS}
    plant_seen = None
    if prev_index is None:
        seen_record, blind = "UNKNOWN", []
        seen_top = ["### First seen at this cut: UNKNOWN", "",
                    f"The previous cut's report ({prev_from}) could not be read: {prev_why}. No failure below can be told "
                    "first seen or standing, so any of them may be new at this cut.", ""]
        if plant:
            plant_seen = "UNKNOWN"
    else:
        rust_seen, blind = rust_first_seen(row_verdicts, prev_rows, rust_read)
        first_seen += rust_seen
        seen_record = first_seen
        seen_top = [f"### First seen at this cut: {len(first_seen) or 'none'}, against {prev_from}", "",
                    "Each failure here was not in the previous cut's report; one that was is standing, and is listed "
                    "only below. A finding's line and column are not compared, so a finding that only moved is standing, "
                    "and one more of a finding is first seen." if first_seen else
                    "No failure the comparison could read is new at this cut; it could not compare what is under \"Not "
                    "compared\" below, and a new failure may be there." if blind else
                    "Every failure of this run was in the previous cut's report too: none is new at this cut.", ""]
        for e in first_seen[:200]:
            name = row_title[e["row"]]
            if e["kind"] == "failure":
                said = "**NEW**" if e["reading"] == "NEW" else "KNOWN (on the known-failure list)"
                seen_top.append(f"- **{name}** `{e['unit']}` ({e['who']}): FAILED `{e['finding']}`: {said}; {e['previous']}")
            elif e["kind"] == "unit":
                seen_top.append(f"- **{name}** `{e['unit']}` ({e['who']}): {e['finding']}, none compared: {e['previous']}: "
                                + ", ".join(f"`{f}`" for f in e["failures"])
                                + (f", and {e['failed'] - len(e['failures'])} more (the list below, and sc-report's results.json)"
                                   if e["failed"] > len(e["failures"]) else ""))
            else:
                seen_top.append(f"- **{name}**: {e['finding']}; {e['previous']} (its failing tests are in that job's "
                                "annotations and log)")
        if len(first_seen) > 200:
            seen_top.append(f"- ... and {len(first_seen) - 200} more (sc-report's verdict.json, first_seen)")
        if blind:
            seen_top += ["", "Not compared with the previous cut:", ""] + [f"- {b}" for b in blind]
        seen_top.append("")
        if plant:
            # The control reads only what first_seen holds: a failure entry naming the plant, or the
            # entry of a unit with no result at the previous cut whose named failures hold it.
            plant_rs = verdicts.get(plant, ("", []))[1]
            unseen = [r["unit"] for r in plant_rs if not any(
                e["row"] == plant and e["unit"] == r["unit"] and any(needle in f for f in (
                    [e["finding"]] if e["kind"] == "failure" else e.get("failures", []))) for e in first_seen)]
            plant_seen = bool(plant_rs) and not unseen
            seen_top += [("The plant reads first seen at this cut in each unit of its row: the comparison's control caught it."
                          if plant_seen else
                          f"**THE FIRST-SEEN CONTROL FAILED**: the plant `{needle}` does not read first seen at this cut in "
                          + (", ".join(f"`{u}`" for u in unseen) or "any unit: its row has none") + "."), ""]
    top[:0] = seen_top
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
    # The units that count their findings (the builtins-lint row): its note, then the count of the
    # fork's, upstream's own and unsorted findings by lint and by file, the most of the fork's first.
    for title, key in ROWS:
        for r in verdicts.get(key, ("", []))[1]:
            b = r.get("breakdown")
            if not b:
                continue
            lines.append(f"### {title}: `{r['unit']}` read {r['status']}")
            lines.append("")
            lines.append(r["note"] or "-")
            lines.append("")
            for what, counts in (("Lint", b.get("by_lint", {})), ("File", b.get("by_file", {}))):
                if not counts:
                    continue
                ordered = sorted(counts.items(), key=lambda kv: (-kv[1][0], -kv[1][1], -kv[1][2], kv[0]))
                lines.append(f"| {what} | FAIL (the fork's) | KNOWN (upstream's own) | UNSORTED |")
                lines.append("|---|---|---|---|")
                lines.extend(f"| `{k}` | {v[0]} | {v[1]} | {v[2]} |" for k, v in ordered[:BREAKDOWN_LISTED])
                if len(ordered) > BREAKDOWN_LISTED:
                    rest = [sum(v[i] for _, v in ordered[BREAKDOWN_LISTED:]) for i in range(3)]
                    lines.append(f"| {len(ordered) - BREAKDOWN_LISTED} more | {rest[0]} | {rest[1]} | {rest[2]} |")
                lines.append("")
    # The memory bench: its exit and every line it printed (each number, each PASS and MISS), as read.
    for title, key in ROWS:
        for r in verdicts.get(key, ("", []))[1]:
            if "bench_lines" in r:
                lines.append(f"### {title}: `{r['unit']}` read {r['status']}, exit {r['exit']}")
                lines.append("")
                lines.append(r["note"] or "-")
                lines.append("")
                lines.extend(f"- `{line}`" for line in r["bench_lines"])
                if r.get("bench_stderr"):
                    lines.append("")
                    lines.append("Its stderr:")
                    lines.append("")
                    lines.extend(f"- `{line}`" for line in r["bench_stderr"])
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
    # The verdict over the rows that ran (KNOWN counts as a pass, as the run's colour does), in one JSON
    # line that a reader can parse: the step summary's line here, and the file SC_VERDICT names, which
    # sami-checks.yml gives as the summary job's output `verdict`, a notice and sc-report's verdict.json.
    # A planted run is a control, so it fails whether or not its control caught the plant (plant_caught
    # says which). A subset run says so: only a run of every row is a pass of the cut checks. A fault
    # outranks a row that could not be read: FAIL, then UNKNOWN, then PASS, and the exit says which
    # (SUMMARY_EXIT), so that a run that could not look never exits as one that found a fault.
    not_run = [k for k in ROW_KEYS if k not in run_rows]
    shown = [v for v in row_verdicts.values() if v != "NOT RUN"]
    verdict = "FAIL" if "FAIL" in shown or stale or plant else "UNKNOWN" if "UNKNOWN" in shown else "PASS"
    record = {"commit": commit, "verdict": verdict, "subset": bool(not_run),
              "rows_run": [k for k in ROW_KEYS if k in run_rows], "rows_not_run": not_run,
              "rows": {k: row_verdicts[k] for k in ROW_KEYS if k in row_verdicts},
              "plant": plant or None, "plant_caught": caught,
              # First seen at this cut: the list of entries, or the string UNKNOWN (never an empty list)
              # when the previous cut's report could not be read, first_seen_why saying why.
              "first_seen": seen_record, "first_seen_against": prev_from, "first_seen_why": prev_why,
              "first_seen_not_compared": blind, "plant_first_seen": plant_seen}
    line = json.dumps(record, separators=(",", ":"))
    title_of = {k: t for t, k in ROWS + RUST_JOBS}

    def named(v):
        return ", ".join(f"{title_of[k]} (`{k}`)" for k in ROW_KEYS if row_verdicts.get(k) == v)

    # The verdict is reached here. A verdict file or a summary that cannot be written does not undo a
    # fault the summary found (still FAIL, 1), and a pass that nobody can read is no pass (UNKNOWN, 2).
    unwritten = ""
    if os.environ.get("SC_VERDICT"):
        try:
            with open(os.environ["SC_VERDICT"], "w", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            unwritten = f"the verdict file {os.environ['SC_VERDICT']} could not be written ({e})"
            if verdict == "PASS":
                verdict = record["verdict"] = "UNKNOWN"
                line = json.dumps(record, separators=(",", ":"))
            print(f"::error title=sami-checks summary::{'UNKNOWN: ' if verdict == 'UNKNOWN' else ''}{unwritten}; "
                  f"the summary exits {SUMMARY_EXIT[verdict]}", file=sys.stderr)
    code = SUMMARY_EXIT[verdict]
    if verdict == "PASS":
        said = "every row that ran passed (a KNOWN row, whose only failures are on the known-failure list, passes)."
    elif verdict == "FAIL":
        found = ([f"these rows read FAIL: {named('FAIL')}"] if "FAIL" in shown else []) \
            + ([f"{len(stale)} known-failure entr{'y is' if len(stale) == 1 else 'ies are'} to be removed"] if stale else []) \
            + (["the run is planted, and a planted run is a control, which always fails"] if plant else [])
        said = "it found a fault: " + "; ".join(found) + "." + (
            f" These rows could not be read either and read UNKNOWN: {named('UNKNOWN')}. A fault outranks a row that "
            "could not be read, so the exit is 1, not 2." if "UNKNOWN" in shown else "")
    elif "UNKNOWN" in shown:
        said = (f"it found no fault, but these rows could not be read and read UNKNOWN: {named('UNKNOWN')}. This run did "
                "not look at everything it was to check; each reason is in the list below. 2 is not the failure code.")
    else:
        said = f"every row that ran passed, but {unwritten}, so no reader can see this pass. 2 is not the failure code."
    top[:0] = [f"**Exit {code} ({verdict})**: {said}", ""]
    if not_run:
        top += [f"**A subset of the rows**: {len(run_rows)} of {len(ROW_KEYS)} rows ran ({', '.join(record['rows_run'])}); "
                f"the other {len(not_run)} read NOT RUN. The verdict covers only the rows that ran: this run is no pass "
                "of the cut checks, which only a run of every row gives (the push of release-candidate, or a dispatch "
                "with rows=all).", ""]
    lines[2:2] = [f"sami-checks verdict: `{line}`", ""] + top
    try:
        print("\n".join(lines))
        sys.stdout.flush()
    except OSError as e:
        if verdict == "PASS":
            verdict = record["verdict"] = "UNKNOWN"
            if os.environ.get("SC_VERDICT") and not unwritten:
                try:
                    with open(os.environ["SC_VERDICT"], "w", encoding="utf-8") as f:
                        f.write(json.dumps(record, separators=(",", ":")) + "\n")
                except OSError:
                    pass
        code = SUMMARY_EXIT[verdict]
        print(f"::error title=sami-checks summary::{'UNKNOWN: ' if verdict == 'UNKNOWN' else ''}the summary could not be "
              f"written ({e}), so the verdict reads {verdict}; the summary exits {code}", file=sys.stderr)
    return code


def summary_main(args):
    """`sc.py summary`: cmd_summary's exit. A summary that stops before its verdict (an input it
    cannot read, a result that does not parse, a fault of its own) judged no row: it says so on
    stderr and exits 2, so that 1 always means a fault it found."""
    try:
        return cmd_summary(*args)
    except SystemExit as e:
        if isinstance(e.code, str):
            print(e.code, file=sys.stderr)
        why = e.code if isinstance(e.code, str) else f"it exited {e.code}"
    except Exception as e:
        import traceback
        traceback.print_exc()
        why = f"{type(e).__name__}: {e}"
    print(f"::error title=sami-checks summary::UNKNOWN: the summary stopped before its verdict ({why}), so it judged no row",
          file=sys.stderr)
    return SUMMARY_EXIT["UNKNOWN"]


def cmd_unreadable_pass(summary_md, verdict_path, why):
    """A summary that passed, but part of whose report could not be written after it (sami-checks.yml's
    Summary step: the step summary, the job's output, results.json): no reader can rely on that pass,
    so, as cmd_summary does for its own outputs, the verdict file and summary.md read UNKNOWN. Prints
    the new exit line. A file it cannot rewrite is left as it is; the step still ends 2."""
    said = f"**Exit 2 (UNKNOWN)**: every row that ran passed, but {why}, so no reader can see this pass. 2 is not the failure code."
    line = None
    try:
        record = json.load(open(verdict_path, encoding="utf-8"))
        if record.get("verdict") == "PASS":
            record["verdict"] = "UNKNOWN"
        line = json.dumps(record, separators=(",", ":"))
        with open(verdict_path, "w", encoding="utf-8") as f:
            f.write(line + "\n")
    except (OSError, ValueError, AttributeError) as e:
        print(f"::error title=sami-checks summary::the verdict file {verdict_path} could not be made UNKNOWN ({e})", file=sys.stderr)
    try:
        lines = open(summary_md, encoding="utf-8").read().split("\n")
        lines = [said if ln.startswith("**Exit 0 (PASS)**") else
                 f"sami-checks verdict: `{line}`" if line and ln.startswith("sami-checks verdict: ") else ln for ln in lines]
        with open(summary_md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except OSError as e:
        print(f"::error title=sami-checks summary::{summary_md} could not be made UNKNOWN ({e})", file=sys.stderr)
    print(said)


def selftest():
    import contextlib
    import io
    import shutil
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

    # The crate's targets, as `cargo metadata --no-deps` gives them: a lib, a bin and two tests that
    # cargo tests, a bench it does not (`test` false), and a build script. An artifact or a "could
    # not compile" line of a log names one of its units; the forms below are the ones the tree's
    # pinned nightly-2026-11-08 printed for a scratch crate of these targets.
    vfs_manifest = "/t/crates/pi-vfs/Cargo.toml"

    def tgt(kind, name, test):
        return {"kind": [kind], "name": name, "src_path": f"/t/crates/pi-vfs/{name}.rs", "test": test}

    cmeta = write("clippy-metadata.json", json.dumps({"workspace_root": "/t", "packages": [{
        "name": "pi-vfs", "manifest_path": vfs_manifest, "targets": [
            tgt("lib", "pi_vfs", True), tgt("bin", "vb", True), tgt("test", "ta", True), tgt("test", "tb", True),
            tgt("bench", "bb", False), tgt("custom-build", "build-script-build", False)]}]}))

    def art(kind, name, test, manifest=vfs_manifest):
        return json.dumps({"reason": "compiler-artifact", "manifest_path": manifest, "target": {"kind": [kind], "name": name},
                           "profile": {"test": test}, "fresh": False}) + "\n"

    build_script = art("custom-build", "build-script-build", False)
    whole = (build_script + art("lib", "pi_vfs", False) + art("lib", "pi_vfs", True) + art("bin", "vb", True)
             + art("test", "ta", True) + art("test", "tb", True))

    def cl(text, ex, c=ctl, base=bl, arts=whole):
        return parse_clippy(write("c.log", arts + text), str(ex), 1, "pi-vfs", "crates/pi-vfs", c, "crates/pi-vfs/src/lib.rs", cmeta, base)

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
    check("clippy: a finding at exit 0 (every lint a warning) is read", cl(own_a, 0)["status"], "KNOWN")
    r = cl(diag("crates/pi-vfs/tests/ta.rs", 4, "clippy::len_zero", "length comparison to zero", "warning"), 0)
    check("clippy: a test target's finding at warn, at exit 0: FAIL, the place named",
          (r["status"], r["failures"]), ("FAIL", ["crates/pi-vfs/tests/ta.rs:4: clippy::len_zero: length comparison to zero"]))
    # A missing log is UNKNOWN by itself, at exit 0 as at 101 (at 101 another branch also gives UNKNOWN).
    for ex in ("0", "101"):
        r = parse_clippy(os.path.join(d, "absent"), ex, 1, "pi-vfs", "crates/pi-vfs", ctl, "crates/pi-vfs/src/lib.rs", cmeta, bl)
        check(f"clippy: no log, exit {ex}", (r["status"], r["note"]), ("UNKNOWN", "no log"))
    check("clippy: a crate the tree lacks", parse_clippy(ctl, "0", 1, "pi-x", "-", ctl, "-", cmeta, bl)["status"], "UNKNOWN")
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
          ("UNKNOWN", "log line(s) 11 look like cargo messages and do not parse, so their findings are unread"))
    # A fallen count names the line that replaces it.
    r = cl(own_a, 101, base=write("baseline-3.txt", f"pi-vfs\tcrates/pi-vfs/src/a.rs\tclippy::needless_raw_string_hashes\t3\t{hashes}\n"))
    check("clippy: a fallen count names its replacement line", (r["status"], r["baseline_fell"]),
          ("KNOWN", [f"crates/pi-vfs/src/a.rs: clippy::needless_raw_string_hashes: {hashes} (1 here, 3 in the baseline): its line becomes "
                     f"`pi-vfs\tcrates/pi-vfs/src/a.rs\tclippy::needless_raw_string_hashes\t1\t{hashes}` (tab-separated)"]))
    # The baseline lines a log gives (the regeneration step), read back as the same baseline.
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        clippy_baseline_lines(write("c.log", whole + noise + dep_f + own_a + own_b + again + cast + broken), "pi-vfs", "crates/pi-vfs", cmeta, bl)
    check("clippy: a regenerated baseline names a compile error in a comment, not a line",
          "# pi-vfs: a compile error, not a baseline line: crates/pi-vfs/tests/broken.rs:3: expected expression, found `;`" in buf.getvalue(), True)
    regen = write("regen.txt", buf.getvalue())
    check("clippy: regenerated baseline lines", read_clippy_baseline(regen),
          {("pi-vfs", "crates/pi-vfs/src/a.rs", "clippy::needless_raw_string_hashes", hashes): 2,
           ("pi-vfs", "crates/pi-vfs/src/b.rs", "function_casts_as_integer", "direct cast of function item into an integer"): 1})
    check("clippy: against its own regenerated baseline, a log reads KNOWN",
          cl(noise + own_a + own_b + cast, 101, base=regen)["status"], "KNOWN")
    # The units a crate's log shows linted (clippy_not_linted). cargo builds no unit whose dependency
    # did not compile: at Cut17 (run 45948734940) pi-shell's lib stopped on one lint under -D
    # warnings, cargo built none of its 71 tests nor obash, and the crate read FAIL on that one
    # finding while it listed 16 baseline lines of those tests for deletion.
    check("clippy units: the build script, the lib its tests and bin need, each target cargo tests, in cargo's words",
          clippy_units(cmeta, "pi-vfs"), (vfs_manifest, ["lib", "lib test", 'bin "vb" test', 'test "ta"', 'test "tb"', "build script"]))
    natives = write("clippy-metadata-natives.json", json.dumps({"packages": [{
        "name": "pi-natives", "manifest_path": "/t/crates/pi-natives/Cargo.toml",
        "targets": [dict(tgt("lib", "pi_natives", True), kind=["cdylib"]), tgt("example", "ex", False)]}]}))
    check("clippy units: a cdylib-only crate is its lib test; an example cargo does not test is none",
          clippy_units(natives, "pi-natives"), ("/t/crates/pi-natives/Cargo.toml", ["lib test"]))
    no_units = write("clippy-metadata-none.json", json.dumps({"packages": [
        {"name": "pi-vfs", "manifest_path": vfs_manifest, "targets": []},
        {"name": "pi-walker", "manifest_path": "/t/crates/pi-walker/Cargo.toml", "targets": [tgt("lib", "pi_walker", False)]}]}))
    check("clippy units: a package the metadata lacks, no metadata, and a package with no unit `--tests` builds",
          (clippy_units(cmeta, "pi-x"), clippy_units(os.path.join(d, "absent.json"), "pi-vfs"), clippy_units(no_units, "pi-vfs"),
           clippy_units(no_units, "pi-walker")), (None, None, None, None))
    r = parse_clippy(write("c.log", ""), "0", 1, "pi-vfs", "crates/pi-vfs", ctl, "crates/pi-vfs/src/lib.rs", no_units, bl)
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        clippy_baseline_lines(write("c.log", ""), "pi-vfs", "crates/pi-vfs", no_units, bl)
    check("clippy: a crate whose metadata names no unit reads UNKNOWN, lists no line for removal, and keeps its baseline lines",
          (r["status"], r["baseline_fell"], read_clippy_baseline(write("regen-none.txt", buf.getvalue()))),
          ("UNKNOWN", [], {k: v for k, v in read_clippy_baseline(bl).items() if k[0] == "pi-vfs"}))

    def cmsg(f, line, code, msg, kind="lib", name="pi_vfs"):
        """An error of a unit of pi-vfs as cargo gives it, with its manifest and target."""
        m = json.loads(diag(f, line, code, msg))
        m["message"]["code"] = {"code": code} if code else None
        return json.dumps(dict(m, manifest_path=vfs_manifest, target={"kind": [kind], "name": name})) + "\n"

    def stopped(unit):
        return f"error: could not compile `pi-vfs` ({unit}) due to 1 previous error\n"

    long_doc = "first doc comment paragraph is too long"
    lib_lint = cmsg("crates/pi-vfs/src/lib.rs", 12, "clippy::too_long_first_doc_paragraph", long_doc)
    skipped = "cargo did not build it: `lib` did not compile"
    bl_t = write("baseline-tests.txt", open(bl).read()
                 + "pi-vfs\tcrates/pi-vfs/tests/ta.rs\tclippy::doc_markdown\t9\titem in documentation is missing backticks\n")
    # Cut17's shape: the lib and its test stop on a lint (-D warnings); cargo builds the build script only.
    cut17 = lib_lint + stopped("lib") + "warning: build failed, waiting for other jobs to finish...\n" + lib_lint + stopped("lib test")
    lib_stopped = cl(cut17, 101, base=bl_t, arts=build_script)
    check("clippy: a lib that stops on a lint: each unit cargo skipped is named UNKNOWN, its finding still fails, no line is listed for removal",
          (lib_stopped["status"], lib_stopped["failures"], lib_stopped["not_linted"], lib_stopped["baseline_fell"],
           lib_stopped["note"].split("; ")[-2:]),
          ("FAIL", [f"crates/pi-vfs/src/lib.rs:12: clippy::too_long_first_doc_paragraph: {long_doc}"],
           [['bin "vb" test', skipped], ['test "ta"', skipped], ['test "tb"', skipped]], [],
           ["3 of 6 unit(s) of pi-vfs were not linted, each named UNKNOWN",
            "3 baseline line(s) with fewer places here are not listed for removal, as a unit not linted may hold them"]))
    mismatched = cmsg("crates/pi-vfs/src/lib.rs", 7, "E0308", "mismatched types")
    no_lints = "it did not compile (error: mismatched types), so rustc did not run all its lints"
    r = cl(mismatched + stopped("lib") + mismatched + stopped("lib test"), 101, arts=build_script)
    check("clippy: a lib that does not compile: it and each unit cargo skipped are named UNKNOWN, its error fails, no line is listed for removal",
          (r["status"], r["failures"], r["not_linted"], r["baseline_fell"]),
          ("FAIL", ["crates/pi-vfs/src/lib.rs:7: E0308: mismatched types"],
           [["lib", no_lints], ["lib test", no_lints], ['bin "vb" test', skipped], ['test "ta"', skipped], ['test "tb"', skipped]], []))
    # Another crate's artifacts (a dependency's, or a crate with the same target names) count for none of its units.
    foreign = "".join(art(k, n, t, "/t/crates/pi-walker/Cargo.toml") for k, n, t in (
        ("lib", "pi_vfs", False), ("lib", "pi_vfs", True), ("bin", "vb", True), ("test", "ta", True), ("test", "tb", True)))
    r = cl(foreign + mismatched + stopped("lib") + mismatched + stopped("lib test"), 101, arts=build_script)
    check("clippy: another crate's artifacts of the same names count for none of the crate's units",
          [u for u, _ in r["not_linted"]], ["lib", "lib test", 'bin "vb" test', 'test "ta"', 'test "tb"'])
    a_lint = cmsg("crates/pi-vfs/src/a.rs", 3, "clippy::needless_raw_string_hashes", hashes)
    r = cl(a_lint + stopped("lib") + a_lint + stopped("lib test"), 101, arts=build_script)
    check("clippy: findings within the baseline beside units not linted read UNKNOWN, not KNOWN, and list no line for removal",
          (r["status"], r["failed"], len(r["not_linted"]), r["baseline_fell"], r["note"].startswith("3 of 6 unit(s) of pi-vfs were not linted")),
          ("UNKNOWN", 0, 3, [], True))
    r = cl("error: could not compile `pi-walker` (lib) due to 2 previous errors\n", 101, arts="")
    check("clippy: a dependency that does not compile leaves every unit not linted, each named",
          (r["status"], [u for u, _ in r["not_linted"]], {w for _, w in r["not_linted"]}),
          ("UNKNOWN", ["lib", "lib test", 'bin "vb" test', 'test "ta"', 'test "tb"', "build script"],
           {"cargo did not build it: `pi-walker` (lib) did not compile"}))
    ta_lint = cmsg("crates/pi-vfs/tests/ta.rs", 4, "clippy::len_zero", "length comparison to zero", "test", "ta")
    r = cl(ta_lint + stopped('test "ta"'), 101, arts=whole.replace(art("test", "ta", True), ""))
    check("clippy: a lib that compiles with a finding in a test target: FAIL, the place named; that test, stopped on a lint, was linted",
          (r["status"], r["failures"], r["not_linted"], len(r["baseline_fell"])),
          ("FAIL", ["crates/pi-vfs/tests/ta.rs:4: clippy::len_zero: length comparison to zero"], [], 2))
    r = cl(dep_f, 0)
    check("clippy: a clean crate whose every unit was linted reads PASS and names no unit UNKNOWN", (r["status"], r["not_linted"]), ("PASS", []))
    r = cl(dep_f, 0, arts=whole.replace(art("test", "tb", True), ""))
    check("clippy: a unit the metadata names that cargo neither built nor reported is named UNKNOWN",
          (r["status"], r["not_linted"]), ("UNKNOWN", [['test "tb"', "cargo neither built it nor said that it failed"]]))
    r = cl(stopped('test "tb"'), 101, arts=whole.replace(art("test", "tb", True), ""))
    check("clippy: a unit that stopped with no error message was not linted",
          (r["status"], r["not_linted"]), ("UNKNOWN", [['test "tb"', "it did not compile (no error message), so rustc did not run all its lints"]]))
    r = parse_clippy(write("c.log", whole + dep_f), "0", 1, "pi-vfs", "crates/pi-vfs", ctl, "crates/pi-vfs/src/lib.rs", os.path.join(d, "absent.json"), bl)
    check("clippy: no metadata of the crate", (r["status"], r["note"].endswith("so what clippy linted is not known")), ("UNKNOWN", True))
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        clippy_baseline_lines(write("c.log", build_script + cut17), "pi-vfs", "crates/pi-vfs", cmeta, bl_t)
    check("clippy: a regenerated baseline of a crate not linted whole keeps its baseline lines, after a comment naming its units",
          (buf.getvalue().splitlines()[0], read_clippy_baseline(write("regen-partial.txt", buf.getvalue()))),
          ('# pi-vfs: not linted whole (3 unit(s) were not linted: bin "vb" test, test "ta", test "tb"), so its lines are the baseline\'s, unchanged',
           {k: v for k, v in read_clippy_baseline(bl_t).items() if k[0] == "pi-vfs"}))

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

    # The rustfmt row: one workspace's `cargo fmt --all --check -v`, in the shape cargo prints it (the
    # target roots, the rustfmt command, then `Diff in` and the lines of each place).
    ftree = os.path.join(d, "ftree")
    os.makedirs(os.path.join(ftree, "sdk", "w"))
    for m in ("Cargo.toml", "sdk/w/Cargo.toml"):
        open(os.path.join(ftree, m), "w").write("[workspace]\n")
    roots = f'[lib (2024)] "{ftree}/sdk/w/src/lib.rs"\n[test (2024)] "{ftree}/sdk/w/tests/t.rs"\n'
    roots += f"rustfmt --edition 2024 --check {ftree}/sdk/w/src/lib.rs {ftree}/sdk/w/tests/t.rs\n"
    wrap = (f"Diff in {ftree}/sdk/w/src/a.rs:476:\n \t\t}},\n-\t\t// A comment past eighty columns, which `rustfmt` wraps.\n"
            "+\t\t// A comment past eighty columns, which `rustfmt`\n+\t\t// wraps.\n \t\tx();\n")
    added = f"Diff in {ftree}/sdk/w/tests/t.rs:9:\n fn a() {{}}\n+\n fn b() {{}}\n"
    blank = f"Diff in {ftree}/sdk/w/tests/t.rs:20:\n fn c() {{}}\n-\n-\n fn d() {{}}\n"
    unclosed = "error: this file contains an unclosed delimiter\n --> sdk/w/src/b.rs:1:12\n"
    unresolved = f"Error writing files: failed to resolve mod `gone`: {ftree}/sdk/w/src/gone.rs does not exist\n"
    # Two changes with fewer than three unchanged lines between them: one block, two places, each at
    # its own line of the file as it is (the block's number is that of its first line).
    two = (f"Diff in {ftree}/sdk/w/src/lib.rs:1:\n-// a comment past eighty columns\n+// a comment past\n+// eighty columns\n"
           " fn x() {}\n-fn sc_rustfmt_plant(){}\n+fn sc_rustfmt_plant() {}\n")
    crlf = f"Incorrect newline style in {ftree}/sdk/w/src/c.rs\n"

    # The same check at the upstream base runs under a tree of its own and names each file it checked
    # (rustfmt's own -v); the fork's diff from the base maps the tree's lines to the base's. By default
    # the base checked only lib.rs, which it has, and is formatted, and the fork changed nothing: a
    # place in a file the base lacks is then a fork change's.
    fbase = os.path.join(d, "fbase")
    os.makedirs(os.path.join(fbase, "sdk", "w", "src"))
    for m in ("Cargo.toml", "sdk/w/Cargo.toml", "sdk/w/src/lib.rs"):
        open(os.path.join(fbase, m), "w").write("[workspace]\n")
    bsha = "e" * 40
    at_b = "the upstream base `eeeeeeeeeeee`"

    def checked(*paths, config=None):
        """rustfmt's -v for the files it checked, after the config it took for their target root."""
        used = f"Using rustfmt config file {ftree}/{config} for {ftree}/sdk/w/src/lib.rs\n" if config else ""
        return used + "".join(f"Formatting {ftree}/{p}\n" for p in paths)

    def diff(*files, only=False):
        """rustfmt.sh's record of the fork's changes: a `### <path>` line and its hunk headers per file.
        Every file the tests use is in it, with no hunk (the fork left it) unless given here; ONLY
        names just the files given."""
        given = dict(files)
        every = list(given) if only else ["sdk/w/src/a.rs", "sdk/w/src/lib.rs", "sdk/w/src/c.rs", "sdk/w/tests/t.rs"]
        return "".join(f"### {p}\n" + "".join(f"{h}\n" for h in given.get(p, [])) for p in every)

    def fr(text, ex, unit="sdk/w/Cargo.toml", base=roots + checked("sdk/w/src/lib.rs"), bex="0", sha=bsha, fork=None, nofork=False):
        fork_path = os.path.join(d, "absent.diff") if nofork else write("fork.diff", diff() if fork is None else fork)
        return parse_rustfmt(unit, write("fmt.log", text), str(ex), 2, ftree, write("fmt-base.log", base.replace(ftree, fbase)),
                             str(bex), fbase, sha, fork_path)

    def fm(text, ex, unit="sdk/w/Cargo.toml", **kw):
        r = fr(text, ex, unit, **kw)
        return r["status"], r["failures"], r["note"]

    def told(fork, upstream, unsorted=0):
        return (f"{fork} a fork change's, {upstream} upstream's own (the same run fails at {at_b} on the lines the fork left as "
                "they are)" + (f", {unsorted} unsorted" if unsorted else ""))

    wrapped = "sdk/w/src/a.rs:477: // A comment past eighty columns, which 'rustfmt' wraps."
    check("rustfmt: formatted", fm(roots, 0), ("PASS", [], "2 target root(s), formatted"))
    check("rustfmt: formatted needs no read of the upstream base",
          parse_rustfmt("sdk/w/Cargo.toml", write("fmt.log", roots), "0", 2, ftree)["status"], "PASS")
    check("rustfmt: each place named by path, line and the first line it rewrites, once",
          fm(roots + wrap + added + blank + wrap, 1),
          ("FAIL", [wrapped, "sdk/w/tests/t.rs:10: adds a blank line", "sdk/w/tests/t.rs:21: removes a blank line"],
           f"3 place(s) in 2 file(s) rustfmt would change, from 2 target root(s): {told(3, 0)}"))
    # The line mapping: a hunk that adds lines shifts the lines after it; one that only removes
    # lines sits after its line; a changed or added line maps to none.
    check("rustfmt: the fork's lines mapped to the base's",
          [base_line([(10, 0, 11, 176), (300, 3, 475, 0), (500, 1, 673, 2)], n) for n in (10, 11, 186, 187, 475, 476, 672, 673, 675)],
          [10, None, None, 11, 299, 303, 499, None, 501])
    open(os.path.join(fbase, "sdk", "w", "src", "a.rs"), "w").write("x\n")
    shifted = diff(("sdk/w/src/a.rs", ["@@ -10,0 +11,176 @@"]))
    moved = wrap.replace("a.rs:476:", "a.rs:300:")
    at_base = roots + checked("sdk/w/src/a.rs", "sdk/w/src/lib.rs") + moved
    r = fr(roots + wrap, 1, base=at_base, bex="1", fork=shifted)
    check("rustfmt: a run on lines the fork left as they are, failing at their line in the base, is upstream's own (KNOWN)",
          (r["status"], r["failures"], r["upstream_places"], r["upstream_base"], r["note"]),
          ("KNOWN", [], [wrapped], bsha, f"1 place(s) in 1 file(s) rustfmt would change, from 2 target root(s), each upstream's "
                                         f"own: the same run fails at {at_b} on the lines the fork left as they are"))
    r = fr(roots + wrap + two, 1, base=at_base, bex="1", fork=shifted)
    check("rustfmt: a run the base does not fail on lines the fork left is a fork change's (its config or context), beside upstream's own",
          (r["status"], r["failures"], r["upstream_places"]),
          ("FAIL", ["sdk/w/src/lib.rs:1: // a comment past eighty columns", "sdk/w/src/lib.rs:3: fn sc_rustfmt_plant(){}"], [wrapped]))
    copy = wrap.replace("a.rs:476:", "a.rs:899:")
    r = fr(roots + wrap + copy, 1, base=at_base, bex="1", fork=diff(("sdk/w/src/a.rs", ["@@ -10,0 +11,176 @@", "@@ -700,0 +877,30 @@"])))
    check("rustfmt: a copy of upstream's run on lines the fork added is a fork change's",
          (r["status"], r["failures"], r["upstream_places"]),
          ("FAIL", ["sdk/w/src/a.rs:900: // A comment past eighty columns, which 'rustfmt' wraps."], [wrapped]))
    # The fork fixed upstream's run (base line 477) and wrote the same run on a line it added: no
    # count may let the second hide behind the first.
    r = fr(roots + wrap.replace("a.rs:476:", "a.rs:599:"), 1, base=roots + checked("sdk/w/src/a.rs") + wrap, bex="1",
           fork=diff(("sdk/w/src/a.rs", ["@@ -477 +477,2 @@", "@@ -598,0 +600 @@"])))
    check("rustfmt: upstream's run fixed and the same run written on a fork line is a fork change's",
          (r["status"], r["failures"], r["upstream_places"]),
          ("FAIL", ["sdk/w/src/a.rs:600: // A comment past eighty columns, which 'rustfmt' wraps."], []))
    r = fr(roots + wrap, 1, base=roots + checked("sdk/w/src/a.rs") + wrap.replace("eighty columns", "eighty-one columns"), bex="1")
    check("rustfmt: another run at the base's line is no match", (r["status"], r["upstream_places"]), ("FAIL", []))
    r = fr(roots + wrap, 1, base=roots + checked("sdk/w/src/lib.rs"), bex="0")
    check("rustfmt: a place in a file the base has but did not check is unsorted (UNKNOWN)",
          (r["status"], r["failures"], r["unsorted_places"], r["note"]),
          ("UNKNOWN", [], [wrapped + " (the upstream base's run did not check sdk/w/src/a.rs)"],
           f"1 place(s) in 1 file(s) rustfmt would change, from 2 target root(s): {told(0, 0, 1)}"))
    r = fr(roots + wrap + two, 1, base=roots + checked("sdk/w/src/lib.rs"), bex="0")
    check("rustfmt: a fork change's place fails beside an unsorted one, each listed",
          (r["status"], len(r["failures"]), len(r["unsorted_places"])), ("FAIL", 2, 1))
    # Forbidden line endings: upstream's own only when each line that has them maps to a base line
    # that has them, each side's lines read by the newline_style of the config its run reported for
    # the file's target root (none here: rustfmt's default, Auto).
    def crlf_run(config=None):
        return roots + checked("sdk/w/src/c.rs", config=config) + crlf

    for root, body in ((ftree, b"a\nb\r\nc\n"), (fbase, b"a\nb\r\nc\n")):
        os.makedirs(os.path.join(root, "sdk", "w", "src"), exist_ok=True)
        open(os.path.join(root, "sdk", "w", "src", "c.rs"), "wb").write(body)
    at_base_crlf = crlf_run()
    r = fr(crlf_run(), 1, base=at_base_crlf, bex="1")
    check("rustfmt: forbidden line endings on lines the fork left, as at the base", (r["status"], r["upstream_places"]),
          ("KNOWN", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    open(os.path.join(fbase, "sdk", "w", "src", "c.rs"), "wb").write(b"a\r\nb\nc\n")
    r = fr(crlf_run(), 1, base=at_base_crlf, bex="1", fork=diff(("sdk/w/src/c.rs", ["@@ -1 +1 @@", "@@ -2 +2 @@"])))
    check("rustfmt: upstream's forbidden line ending fixed and another written: a fork change's", (r["status"], r["failures"]),
          ("FAIL", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    r = fr(roots + crlf, 1, base=at_base_crlf, bex="1")
    check("rustfmt: line endings in a file the tree's run named no config for are unsorted", (r["status"], r["unsorted_places"]),
          ("UNKNOWN", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style) (the tree's run named no config for "
                       "sdk/w/src/c.rs)"]))
    # The fork's newline_style differs from the base's: the tree's forbidden endings are read by the
    # tree's style (Windows: a bare LF), the base's by its own (Auto: the first line's).
    open(os.path.join(ftree, "sdk", "w", "rustfmt.toml"), "w").write('newline_style = "Windows"\n')
    open(os.path.join(ftree, "sdk", "w", "src", "c.rs"), "wb").write(b"a\nb\n")
    open(os.path.join(fbase, "sdk", "w", "src", "c.rs"), "wb").write(b"a\r\nb\n")
    r = fr(crlf_run("sdk/w/rustfmt.toml"), 1, base=at_base_crlf, bex="1", fork=diff(("sdk/w/src/c.rs", ["@@ -1 +1 @@"])))
    check("rustfmt: line endings the fork's newline_style forbids on a line it changed: a fork change's", (r["status"], r["failures"]),
          ("FAIL", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    os.remove(os.path.join(ftree, "sdk", "w", "rustfmt.toml"))
    # The source is unchanged and mixed; the base's config says Unix, so its forbidden line is the
    # CR LF one (2). A fork config read as TOML (single-quoted) saying Windows forbids the bare LF one
    # (1), which the base allows: a fork change's. A config nearer the file than the one rustfmt
    # reported for its target root is not rustfmt's, so the root's Unix reads as the base's: KNOWN.
    open(os.path.join(fbase, "sdk", "w", "rustfmt.toml"), "w").write('newline_style = "Unix"\n')
    for root in (ftree, fbase):
        open(os.path.join(root, "sdk", "w", "src", "c.rs"), "wb").write(b"a\nb\r\n")
    unix_base = crlf_run("sdk/w/rustfmt.toml")
    open(os.path.join(ftree, "sdk", "w", "rustfmt.toml"), "w").write("newline_style = 'Windows'\n")
    r = fr(crlf_run("sdk/w/rustfmt.toml"), 1, base=unix_base, bex="1")
    check("rustfmt: the fork's newline_style read as TOML (single-quoted): a fork change's", (r["status"], r["failures"]),
          ("FAIL", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    open(os.path.join(ftree, "sdk", "w", "rustfmt.toml"), "w").write('newline_style = "Unix"\n')
    open(os.path.join(ftree, "sdk", "w", "src", "rustfmt.toml"), "w").write('newline_style = "Windows"\n')
    r = fr(crlf_run("sdk/w/rustfmt.toml"), 1, base=unix_base, bex="1")
    check("rustfmt: the config rustfmt reported for the target root, not one nearer the file", (r["status"], r["upstream_places"]),
          ("KNOWN", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    os.remove(os.path.join(ftree, "sdk", "w", "src", "rustfmt.toml"))
    open(os.path.join(ftree, "sdk", "w", "rustfmt.toml"), "w").write("newline_style = Windows\n")
    r = fr(crlf_run("sdk/w/rustfmt.toml"), 1, base=unix_base, bex="1")
    check("rustfmt: a config that is no TOML leaves line endings unsorted",
          (r["status"], len(r["unsorted_places"]), "rustfmt.toml could not be read as TOML" in "".join(r["unsorted_places"])),
          ("UNKNOWN", 1, True))
    os.remove(os.path.join(ftree, "sdk", "w", "rustfmt.toml"))
    os.remove(os.path.join(fbase, "sdk", "w", "rustfmt.toml"))
    open(os.path.join(ftree, "sdk", "w", "src", "c.rs"), "wb").write(b"a\nb\n")
    r = fr(crlf_run(), 1, base=at_base_crlf, bex="1")
    check("rustfmt: a line-ending report with no line of the file it can place is unsorted",
          (r["status"], r["unsorted_places"]),
          ("UNKNOWN", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style) (no line of sdk/w/src/c.rs has an ending its "
                       "newline_style (Auto) forbids)"]))
    two_runs = (f"rustfmt --edition 2024 -v --check {ftree}/sdk/w/src/lib.rs\nUsing rustfmt config file {ftree}/x.toml for "
                f"{ftree}/sdk/w/src/lib.rs\nFormatting {ftree}/sdk/w/src/a.rs\nrustfmt --edition 2021 -v --check {ftree}/sdk/w/src/b.rs\n"
                f"Formatting {ftree}/sdk/w/src/b.rs\n")
    check("rustfmt: each file's config is its own invocation's, none when that one named none",
          read_rustfmt(write("fmt-two.log", two_runs), ftree)[3], {"sdk/w/src/a.rs": f"{ftree}/x.toml", "sdk/w/src/b.rs": None})
    open(os.path.join(ftree, "sdk", "w", "src", "c.rs"), "wb").write(b"a\nb\r\nc\n")
    r = fr(roots + wrap, 1, base=at_base, bex="1", fork=diff(("sdk/w/src/lib.rs", []), only=True))
    check("rustfmt: a place in a file the fork's diff does not name is unsorted",
          (r["status"], r["unsorted_places"]), ("UNKNOWN", [wrapped + " (no diff of sdk/w/src/a.rs from the upstream base)"]))
    # A run the base passes on lines the fork left, in a file with items rustfmt skips there: the
    # base's check did not read those items, so the run is unsorted, not the fork's.
    open(os.path.join(fbase, "sdk", "w", "src", "a.rs"), "w").write("#[rustfmt::skip]\nfn x() {}\n")
    r = fr(roots + wrap, 1, base=roots + checked("sdk/w/src/a.rs"), bex="0")
    check("rustfmt: a run on unchanged lines in a base file with skipped items is unsorted",
          (r["status"], r["unsorted_places"]),
          ("UNKNOWN", [wrapped + " (the upstream base's sdk/w/src/a.rs has items rustfmt skips, which its check did not read)"]))
    open(os.path.join(fbase, "sdk", "w", "src", "a.rs"), "w").write("x\n")
    open(os.path.join(fbase, "sdk", "w", "src", "a.rs"), "w").write("#[rustfmt :: skip]\nfn x() {}\n")
    r = fr(roots + wrap, 1, base=roots + checked("sdk/w/src/a.rs"), bex="0")
    check("rustfmt: a skip attribute spelled with spaces is a skip", r["status"], "UNKNOWN")
    open(os.path.join(fbase, "sdk", "w", "src", "a.rs"), "w").write("x\n")
    marked = "".join(line + ("⏎" if line[:1] in " -+" else "") + "\n" for line in wrap.splitlines())
    check("rustfmt: the ⏎ rustfmt's -v ends each diff line with is read away",
          fm(roots + marked, 1, base=roots + checked("sdk/w/src/a.rs"))[1], [wrapped])
    check("rustfmt: a workspace the upstream base lacks", fm(roots + wrap, 1, bex="absent"),
          ("FAIL", [wrapped], f"1 place(s) in 1 file(s) rustfmt would change, from 2 target root(s), each a fork change's: "
                              f"{at_b} has no sdk/w/Cargo.toml"))
    unsorted = f"1 place(s) in 1 file(s) rustfmt would change, from 2 target root(s), none sorted into upstream's own or the fork's: "
    r = parse_rustfmt("sdk/w/Cargo.toml", write("fmt.log", roots + wrap), "1", 2, ftree,
                      write("setup.log", "Cloning\nfatal: unable to access 'https://github.com/can1357/oh-my-pi.git/'\n"), "-", "-", "-")
    check("rustfmt: places with no upstream base set up", (r["status"], r["failures"], len(r["unsorted_places"]), r["note"]),
          ("UNKNOWN", [], 1, unsorted + "the upstream base could not be read (it was not set up: fatal: unable to access "
                                       "'https://github.com/can1357/oh-my-pi.git/')"))
    for label, base, bex, nofork, why in (
            ("killed", at_base, "137", False, "exit 137: the time bound or a signal ended it"),
            ("an error line", roots + checked("sdk/w/src/a.rs") + unclosed, "1", False,
             "rustfmt could not read every file there: error: this file contains an unclosed delimiter"),
            ("no target root", "", "0", False, "cargo fmt listed no target root there"),
            ("no file named as checked", roots, "0", False, "its run named no file it checked (rustfmt's own -v)"),
            ("exit 1 with no place", roots + checked("sdk/w/src/a.rs"), "1", False, "exit 1 with 0 place(s) there"),
            ("exit 0 with a place", at_base, "0", False, "exit 0 with 1 place(s) there"),
            ("no diff of the fork's changes", at_base, "1", True, "no diff of the fork's changes from it")):
        check(f"rustfmt: the upstream base's run, {label}", fm(roots + wrap, 1, base=base, bex=bex, nofork=nofork),
              ("UNKNOWN", [], unsorted + f"{at_b} could not be read ({why})"))
    r = parse_rustfmt("sdk/w/Cargo.toml", write("fmt.log", roots + wrap), "1", 2, ftree, os.path.join(d, "absent-base.log"), "1", fbase, bsha,
                      write("fork.diff", ""))
    check("rustfmt: no log of the upstream base's run", r["note"], unsorted + f"{at_b} could not be read (no log)")
    check("rustfmt: each run of changed lines in one block is a place, at its own line", fm(roots + two, 1)[:2],
          ("FAIL", ["sdk/w/src/lib.rs:1: // a comment past eighty columns", "sdk/w/src/lib.rs:3: fn sc_rustfmt_plant(){}"]))
    check("rustfmt: a file with forbidden line endings",
          fm(roots + checked("sdk/w/src/c.rs") + crlf, 1, base=roots + checked("sdk/w/src/c.rs"))[:2],
          ("FAIL", ["sdk/w/src/c.rs: newline style (rustfmt.toml's newline_style)"]))
    check("rustfmt: a module rustfmt could not resolve, beside places it read", fm(roots + wrap + unresolved, 1),
          ("UNKNOWN", [wrapped], f"rustfmt could not read every file: {unresolved.strip()}; 1 place(s) in 1 file(s) rustfmt would change"))
    check("rustfmt: a file rustfmt could not read", fm(roots + unclosed, 1),
          ("UNKNOWN", [], "rustfmt could not read every file: error: this file contains an unclosed delimiter"))
    check("rustfmt: a file rustfmt could not read, beside places it read", fm(roots + wrap + unclosed, 1),
          ("UNKNOWN", [wrapped], "rustfmt could not read every file: error: this file contains an unclosed delimiter; "
                                 "1 place(s) in 1 file(s) rustfmt would change"))
    # rustfmt's error[internal] with a `-->` line is one line it read and could not format cleanly (run
    # 45915095510: pi-builtins tail.rs, `left behind trailing whitespace`, at the tree and the base
    # alike): a place sorted like any other, not a file it could not read. One with no `-->` line
    # stays an error.
    internal = (f"error[internal]: left behind trailing whitespace\n    --> {ftree}/sdk/w/src/lib.rs:5:5:1\n     |\n"
                "5 |         \n     | ^^^^^^^^\n     |\n\nwarning: rustfmt has failed to format. See previous 1 errors.\n")
    trailing = "sdk/w/src/lib.rs:5: left behind trailing whitespace (rustfmt's error[internal], output line 5)"
    check("rustfmt: a placed error[internal] the base does not have is a fork change's", fm(roots + internal, 1)[:2], ("FAIL", [trailing]))
    r = fr(roots + internal, 1, base=roots + checked("sdk/w/src/lib.rs") + internal, bex="1")
    check("rustfmt: a placed error[internal] the base has at the same line is upstream's own",
          (r["status"], r["upstream_places"]), ("KNOWN", [trailing]))
    check("rustfmt: an error[internal] with no place is a file rustfmt could not read",
          fm(roots + "error[internal]: something went wrong\n", 1)[0::2],
          ("UNKNOWN", "rustfmt could not read every file: error[internal]: something went wrong"))
    # A diff run and a placed error on one line, at the tree and at the base: both upstream's own (a
    # map from line to one run kept only one of them, and the other read as a fork change's).
    run5 = f"Diff in {ftree}/sdk/w/src/lib.rs:5:\n-fn x() {{ }}\n+fn x() {{}}\n"
    r = fr(roots + run5 + internal, 1, base=roots + checked("sdk/w/src/lib.rs") + run5 + internal, bex="1")
    check("rustfmt: a diff run and a placed error on one line, both at the base", (r["status"], len(r["upstream_places"])), ("KNOWN", 2))
    # An error[internal]'s line is a line of rustfmt's output (CiReview at b792893c: one source line the
    # fork adds, which rustfmt writes as four, moves tail.rs's four errors by four). The fork added a
    # line at its line 3, which rustfmt writes as four: the base's error at its output line 10 is the
    # tree's at output line 14, source line 11, the base's 10: upstream's own. One inside the run is
    # that run's (its first removed line), on the fork's line: a fork change's.
    grow = (f"Diff in {ftree}/sdk/w/src/lib.rs:3:\n-fn before() {{ let _x = 1; let _y = 2; }}\n+fn before() {{\n"
            "+\tlet _x = 1;\n+\tlet _y = 2;\n+}\n")
    at_out = {n: internal.replace("lib.rs:5:5:1", f"lib.rs:{n}:{n}:1") for n in (4, 10, 14)}
    r = fr(roots + grow + at_out[14] + at_out[4], 1, base=roots + checked("sdk/w/src/lib.rs") + at_out[10], bex="1",
           fork=diff(("sdk/w/src/lib.rs", ["@@ -2,0 +3 @@"])))
    check("rustfmt: an error[internal] mapped from rustfmt's output to the file, past a run and inside one",
          (r["status"], r["failures"], r["upstream_places"]),
          ("FAIL", ["sdk/w/src/lib.rs:3: fn before() { let _x = 1; let _y = 2; }",
                    "sdk/w/src/lib.rs:3: left behind trailing whitespace (rustfmt's error[internal], output line 4)"],
           ["sdk/w/src/lib.rs:11: left behind trailing whitespace (rustfmt's error[internal], output line 14)"]))
    # Two errors inside one run stay two, by their lines in it: the base has only the first.
    run3 = f"Diff in {ftree}/sdk/w/src/lib.rs:5:\n-fn x() {{ a(); }}\n+fn x() {{\n+\ta();\n+}}\n"
    r = fr(roots + run3 + at_out[10].replace(":10:10:", ":5:5:") + at_out[10].replace(":10:10:", ":6:6:"), 1,
           base=roots + checked("sdk/w/src/lib.rs") + run3 + at_out[10].replace(":10:10:", ":5:5:"), bex="1")
    check("rustfmt: two errors inside one run, the base with one of them", (r["status"], r["upstream_places"], r["failures"]),
          ("FAIL", ["sdk/w/src/lib.rs:5: fn x() { a(); }", "sdk/w/src/lib.rs:5: left behind trailing whitespace (rustfmt's error[internal], output line 5)"],
           ["sdk/w/src/lib.rs:5: left behind trailing whitespace (rustfmt's error[internal], output line 6)"]))
    check("rustfmt: no target root listed", fm("rustfmt --edition 2024 --check\n", 0)[0::2],
          ("UNKNOWN", "exit 0, and cargo fmt listed no target root, so it checked nothing: rustfmt --edition 2024 --check"))
    check("rustfmt: exit 0 with a place", fm(roots + wrap, 0), ("UNKNOWN", [wrapped], "exit 0 with 1 place(s) in 1 file(s) rustfmt would change"))
    check("rustfmt: exit 1 with no place", fm(roots, 1)[0], "UNKNOWN")
    check("rustfmt: killed", fm(roots + wrap, 137)[0::2], ("UNKNOWN", "exit 137: the time bound or a signal ended it"))
    check("rustfmt: no log", parse_rustfmt("sdk/w/Cargo.toml", os.path.join(d, "absent.log"), "0", 1, ftree)["note"], "no log")
    check("rustfmt: a workspace the tree lacks", fm(roots, 0, "sdk/gone/Cargo.toml")[0::2], ("UNKNOWN", "the tree has no sdk/gone/Cargo.toml"))
    check("rustfmt: the workspaces, the root's first, from the list's entry lines",
          rustfmt_workspaces(write("ws.txt", "# a comment\nsdk/a/Cargo.toml  why\n\nsdk/b/Cargo.toml  why\nsdk/a/Cargo.toml  again\n")),
          ["Cargo.toml", "sdk/a/Cargo.toml", "sdk/b/Cargo.toml"])
    check("rustfmt: no list", rustfmt_workspaces(os.path.join(d, "absent.txt")), None)
    check("rustfmt: the gate's list names a workspace beside the root's", len(rustfmt_workspaces() or []) > 1, True)
    # The plant's place: the first library (else binary) root by manifest path.
    def pkg(manifest, *targets):
        return {"manifest_path": f"{ftree}/{manifest}", "targets": [{"kind": k, "src_path": f"{ftree}/{s}"} for k, s in targets]}
    check("rustfmt plant: a library first, by manifest path",
          rustfmt_plant_target({"packages": [pkg("crates/pi-vcs/Cargo.toml", (["lib"], "crates/pi-vcs/src/lib.rs")),
                                             pkg("crates/pi-ast/Cargo.toml", (["bin"], "crates/pi-ast/src/main.rs"),
                                                 (["test"], "crates/pi-ast/tests/a.rs"), (["cdylib", "rlib"], "crates/pi-ast/src/lib.rs"))]}, ftree),
          "crates/pi-ast/src/lib.rs")
    check("rustfmt plant: a binary when there is no library",
          rustfmt_plant_target({"packages": [pkg("Cargo.toml", (["bin"], "src/main.rs"), (["test"], "tests/a.rs"))]}, ftree), "src/main.rs")
    check("rustfmt plant: no library or binary", rustfmt_plant_target({"packages": [pkg("Cargo.toml", (["test"], "tests/a.rs"))]}, ftree), None)

    # The builtins-lint row's lift: the crate's own [lints] becomes the workspace's, every other key
    # kept; a manifest whose result would not read so stops the job (None).
    own_lints = ('[package]\nname = "b"\n\n[dependencies]\nx = "1"\n\n# Deliberately NOT the workspace\'s.\n[lints.clippy]\n'
                 'all = { level = "allow", priority = -1 }\npedantic = { level = "allow", priority = -1 }\n\n[lints.rust]\n'
                 'unfulfilled_lint_expectations = { level = "allow", priority = -1 }\n\n[[bin]]\nname = "b"\npath = "src/main.rs"\n')
    lifted = builtins_lint_lift_manifest(own_lints)
    check("builtins-lint lift: the crate's [lints] become the workspace's, every other key kept",
          (lifted is not None and tomllib.loads(lifted).get("lints"), lifted is not None and tomllib.loads(lifted).get("bin"),
           lifted is not None and tomllib.loads(lifted).get("dependencies")),
          ({"workspace": True}, [{"name": "b", "path": "src/main.rs"}], {"x": "1"}))
    check("builtins-lint lift: lints as a dotted key it cannot leave out stops it",
          builtins_lint_lift_manifest('lints.clippy.all = "allow"\n[package]\nname = "b"\n'), None)
    # A table header the filter cannot read (a quoted key with a bracket) would be left out with the
    # lints before it: the comparison of every other key stops the lift.
    check("builtins-lint lift: a table it would drop beside the lints stops it",
          builtins_lint_lift_manifest('[package]\nname = "b"\n\n[lints.clippy]\nall = "allow"\n\n[target."cfg[x]".dependencies]\ny = "1"\n'),
          None)
    fmt_cfg = 'max_width = 100\nignore = [\n\t"crates/b/**",\n\t"vendor/**",\n]\nhard_tabs = true\n'
    check("builtins-lint lift: rustfmt.toml's ignore loses the patterns that hold the crate, keeps the others",
          builtins_lint_lift_rustfmt(fmt_cfg, ["crates/b/src/lib.rs"]),
          ('max_width = 100\nignore = ["vendor/**"]\nhard_tabs = true\n', ["crates/b/**"]))
    check("builtins-lint lift: a pattern naming the crate's directory holds it; the key goes when none is left",
          builtins_lint_lift_rustfmt('ignore = ["crates/b"]\nmax_width = 100\n', ["crates/b/src/x/y.rs"]),
          ("max_width = 100\n", ["crates/b"]))
    check("builtins-lint lift: no pattern holds the crate", builtins_lint_lift_rustfmt(fmt_cfg, ["crates/c/src/lib.rs"]), (fmt_cfg, []))

    # The builtins-lint row's clippy unit: cargo's own JSON lines, cut to the fields lint_read reads,
    # with the dep-info file rustc writes beside each .rmeta (its prerequisites: the files it read).
    # The fork added five lines after the base's line 10 of lib.rs (the tree's 11 to 15), and two at
    # its end (a blank line and the plant), and a file new.rs; other.rs is the base's, unlinted there.
    btree, bbase, btgt = os.path.join(d, "btree"), os.path.join(d, "bbase"), os.path.join(d, "btarget")
    base_src = [f"base {i}" for i in range(1, 26)]
    tree_src = base_src[:10] + [f"fork {i}" for i in range(1, 6)] + base_src[10:] + ["", BUILTINS_LINT_PLANT_LINES[0]]
    for root, src in ((btree, tree_src), (bbase, base_src)):
        os.makedirs(os.path.join(root, "crates", "b", "src"))
        open(os.path.join(root, "crates", "b", "Cargo.toml"), "w").write('[package]\nname = "b"\n')
        open(os.path.join(root, "crates", "b", "src", "lib.rs"), "w").write("\n".join(src) + "\n")
        open(os.path.join(root, "crates", "b", "src", "other.rs"), "w").write("o 1\no 2\n")
    open(os.path.join(btree, "crates", "b", "src", "new.rs"), "w").write("n 1\n")
    bfork = write("b-fork.diff", "### crates/b/src/lib.rs\n@@ -10,0 +11,5 @@\n@@ -25,0 +31,2 @@\n### crates/b/src/other.rs\n"
                                 "### crates/b/src/new.rs\n@@ -0,0 +1 @@\n")

    def bmsg(path, line, code, msg, col=1, end=None, level="warning"):
        span = {"file_name": path, "line_start": line, "line_end": end or line, "column_start": col, "is_primary": True}
        return json.dumps({"reason": "compiler-message", "message": {"level": level, "code": {"code": code} if code else None,
                                                                     "message": msg, "spans": [span], "rendered": f"{level}: {msg}"}})

    def bart(root, side, files, test=False):
        """A compiler-artifact of crate b under ROOT, and its dep-info naming FILES."""
        out = os.path.join(btgt, side + ("-test" if test else ""))
        os.makedirs(out, exist_ok=True)
        rmeta = os.path.join(out, "libb-1.rmeta")
        open(os.path.join(out, "b-1.d"), "w").write(f"{out}/b-1.d: {' '.join(files)}\n\n{rmeta}: {' '.join(files)} Cargo.toml\n\n"
                                                    + "".join(f"{f}:\n" for f in files) + "\n# env-dep:CLIPPY_CONF_DIR\n")
        return json.dumps({"reason": "compiler-artifact", "manifest_path": f"{root}/crates/b/Cargo.toml",
                           "target": {"kind": ["lib"], "name": "b"}, "profile": {"test": test}, "filenames": [rmeta], "fresh": False})

    every = ["crates/b/src/lib.rs", "crates/b/src/other.rs", "crates/b/src/new.rs"]
    f_up = bmsg("crates/b/src/lib.rs", 20, "clippy::doc_markdown", "item in documentation is missing backticks", 3)
    f_added = bmsg("crates/b/src/lib.rs", 12, "clippy::needless_return", "unneeded `return` statement")
    f_new_here = bmsg("crates/b/src/lib.rs", 5, "clippy::eq_op", "equal expressions as operands to `==`")
    f_across = bmsg("crates/b/src/lib.rs", 9, "clippy::too_many_lines", "this function has too many lines", end=12)
    f_moved_col = bmsg("crates/b/src/lib.rs", 21, "clippy::x", "m2", 5)
    f_newfile = bmsg("crates/b/src/new.rs", 1, "clippy::x", "m3")
    f_other = bmsg("crates/b/src/other.rs", 2, "clippy::x", "m4")
    f_plant = bmsg("crates/b/src/lib.rs", 32, "clippy::redundant_static_lifetimes", "constants have by default a `'static` lifetime", 43)
    noise_b = [bmsg("crates/c/src/lib.rs", 1, "clippy::x", "another crate's"),
               bmsg("crates/b/src/lib.rs", 2, "clippy::x", "a message at another level is no finding", level="note"),
               json.dumps({"reason": "compiler-message", "message": {"level": "warning", "code": None, "message": "8 warnings emitted", "spans": []}}),
               json.dumps({"reason": "compiler-message", "message": {"level": "warning", "code": {"code": "E0602"},
                                                                     "message": "unknown lint: `clippy::assert_is_empty`", "spans": []}}),
               "    Checking b v0.1.0", json.dumps({"reason": "build-finished", "success": True})]
    tree_log = [bart(btree, "tree", every), bart(btree, "tree", every, True), f_up, f_added, f_new_here, f_across, f_moved_col,
                f_newfile, f_other, f_plant, f_up] + noise_b
    base_ok = [bart(bbase, "base", ["crates/b/src/lib.rs"]), bmsg("crates/b/src/lib.rs", 15, "clippy::doc_markdown",
               "item in documentation is missing backticks", 3), bmsg("crates/b/src/lib.rs", 9, "clippy::too_many_lines",
               "this function has too many lines", end=10), bmsg("crates/b/src/lib.rs", 16, "clippy::x", "m2", 9)]
    bsha = "9058ab9d229663e229e2867824ba6df6f21e9e59"

    def bc(tree_lines, ex="0", base_lines=None, bex="0", fork=bfork, crate="crates/b"):
        """parse_builtins_clippy of these log lines, the base's (None: base_ok) under bbase."""
        blog = write("bc-base.log", "\n".join(base_ok if base_lines is None else base_lines) + "\n")
        return parse_builtins_clippy(write("bc.log", "\n".join(tree_lines) + "\n"), ex, 7, btree, crate, blog, bex, bbase, bsha, fork)

    def bn(line, code, msg, col=1, text=None):
        src = tree_src[line - 1] if text is None else text
        return f"crates/b/src/lib.rs:{line}:{col}: {code}: {msg} ({src})".replace("`", "'")

    r = bc(tree_log)
    check("builtins-lint clippy: each finding sorted by the same run at the upstream base",
          (r["row"], r["unit"], r["status"], r["failures"], r["upstream_places"], r["unsorted_places"], r["upstream_base"]),
          ("builtins-lint", "clippy", "FAIL",
           [bn(12, "clippy::needless_return", "unneeded `return` statement"),
            bn(5, "clippy::eq_op", "equal expressions as operands to `==`"),
            bn(9, "clippy::too_many_lines", "this function has too many lines"),
            bn(21, "clippy::x", "m2", 5),
            "crates/b/src/new.rs:1:1: clippy::x: m3 (n 1)",
            bn(32, "clippy::redundant_static_lifetimes", "constants have by default a `'static` lifetime", 43)],
           [bn(20, "clippy::doc_markdown", "item in documentation is missing backticks", 3)],
           ["crates/b/src/other.rs:2:1: clippy::x: m4 (o 2) (the upstream base's run did not lint crates/b/src/other.rs)"], bsha))
    check("builtins-lint clippy: the note counts each kind",
          r["note"], "8 finding(s) in 3 file(s), 3 file(s) linted: 6 a fork change's, 1 upstream's own (the same finding at the "
                     "upstream base `9058ab9d2296` on the lines the fork left as they are), 1 unsorted")
    check("builtins-lint clippy: the findings counted by lint and by file",
          (r["breakdown"]["by_lint"]["clippy::x"], r["breakdown"]["by_lint"]["clippy::doc_markdown"],
           r["breakdown"]["by_file"]["crates/b/src/lib.rs"], r["breakdown"]["by_file"]["crates/b/src/other.rs"]),
          ([2, 0, 1], [0, 1, 0], [5, 1, 0], [0, 0, 1]))
    check("builtins-lint clippy: the plant's finding names the plant", any(BUILTINS_LINT_PLANT in f for f in r["failures"]), True)
    check("builtins-lint clippy: every finding upstream's own reads KNOWN", bc(tree_log[:3] + noise_b)["status"], "KNOWN")
    check("builtins-lint clippy: upstream's own beside an unsorted one reads UNKNOWN", bc(tree_log[:3] + [f_other])["status"], "UNKNOWN")
    r = bc(tree_log[:2] + noise_b, base_lines=[])
    check("builtins-lint clippy: no finding needs no base", (r["status"], r["note"]),
          ("PASS", "3 file(s) linted at the workspace's lint levels, no finding"))
    r = bc(tree_log[:3] + [f_added], bex="absent")
    check("builtins-lint clippy: a base without the crate makes each finding the fork's", (r["status"], len(r["failures"])), ("FAIL", 2))
    r = parse_builtins_clippy(write("bc.log", "\n".join(tree_log) + "\n"), "0", 7, btree, "crates/b",
                              write("setup.log", "Cloning\nfatal: unable to access 'https://github.com/can1357/oh-my-pi.git/'\n"), "-", "-", "-")
    check("builtins-lint clippy: no upstream base set up", (r["status"], r["failures"], len(r["unsorted_places"]), r["note"].split(" (")[-1]),
          ("UNKNOWN", [], 8, "it was not set up: fatal: unable to access 'https://github.com/can1357/oh-my-pi.git/')"))
    for label, base_lines, bex, fork, why in (
            ("an error there", base_ok + [bmsg("crates/b/src/lib.rs", 3, "E0425", "cannot find value `y`", level="error")], "101", bfork,
             "exit 101 with 1 error(s) there: error: cannot find value `y`"),
            ("no compiled target there", base_ok[1:], "0", bfork, "no compiled target of the crate there has a dep-info file that can be read"),
            ("no diff of the fork's", base_ok, "0", os.path.join(d, "absent.diff"), "no diff of the fork's changes from it"),
            ("the time bound there", base_ok, "124", bfork, "exit 124: the time bound or a signal ended it")):
        r = bc(tree_log, base_lines=base_lines, bex=bex, fork=fork)
        check(f"builtins-lint clippy: {label}", (r["status"], r["failures"], r["note"].endswith(f"could not be read ({why})")),
              ("UNKNOWN", [], True))
    r = bc(tree_log + [bmsg("crates/b/src/lib.rs", 3, None, "expected expression, found `;`", level="error")], "101")
    check("builtins-lint clippy: a compile error leaves the crate not linted whole",
          (r["status"], r["failures"], r["note"].startswith("exit 101 with 1 error(s), so the crate's targets were not all linted")),
          ("UNKNOWN", [], True))
    check("builtins-lint clippy: exit 101 with no error message", bc(tree_log, "101")["status"], "UNKNOWN")
    check("builtins-lint clippy: no dep-info of a compiled target", bc(tree_log[2:])["note"].startswith("exit 0, but no compiled target"), True)
    os.rename(os.path.join(btgt, "tree-test", "b-1.d"), os.path.join(btgt, "tree-test", "b-1.d.gone"))
    check("builtins-lint clippy: a compiled target whose dep-info is gone", bc(tree_log)["status"], "UNKNOWN")
    os.rename(os.path.join(btgt, "tree-test", "b-1.d.gone"), os.path.join(btgt, "tree-test", "b-1.d"))
    check("builtins-lint clippy: a log line that does not parse", bc(tree_log + [f_up[:40]])["note"].startswith("log line(s) 18 look like"), True)
    check("builtins-lint clippy: the time bound", bc(tree_log, "124")["note"], "exit 124: the time bound or a signal ended it")
    check("builtins-lint clippy: no log", parse_builtins_clippy(os.path.join(d, "absent.log"), "0", 1, btree, "crates/b")["note"], "no log")
    check("builtins-lint clippy: no package", bc(tree_log, crate="-")["note"], f"the tree has no package {BUILTINS_LINT_CRATE}")
    # The control of the line mapping: with the fork's hunks read as none, the fork-added line maps to
    # upstream's line 12, which has no finding: still the fork's; and upstream's own at 20 maps to
    # base 20, where the base has none: the fork's too, so the mapping is what makes it KNOWN.
    r = bc(tree_log[:4], fork=write("b-fork-none.diff", "### crates/b/src/lib.rs\n"))
    check("builtins-lint clippy: without the fork's hunks upstream's own is not found", (r["status"], r["upstream_places"]), ("FAIL", []))
    # A lint can mark more than one place (CiReview at b792893c: twenty such in Cut15's run, among them
    # clippy::set_contains_or_insert at hostname.rs:208 and :216). Every primary span is read: one on a
    # fork-added line makes the finding the fork's, though its first is upstream's.
    def bmulti(*lines, code="clippy::set_contains_or_insert", msg="usage of 'HashSet::insert' after 'HashSet::contains'"):
        spans = [{"file_name": "crates/b/src/lib.rs", "line_start": n, "line_end": n, "column_start": 5, "is_primary": True} for n in lines]
        return json.dumps({"reason": "compiler-message", "message": {"level": "warning", "code": {"code": code}, "message": msg, "spans": spans}})

    base_multi = base_ok + [bmulti(15, 18)]
    r = bc(tree_log[:2] + [bmulti(20, 23)], base_lines=base_multi)
    check("builtins-lint clippy: a finding with two primary spans, both upstream's", (r["status"], len(r["upstream_places"])), ("KNOWN", 1))
    r = bc(tree_log[:2] + [bmulti(20, 12)], base_lines=base_multi)
    check("builtins-lint clippy: a finding whose second primary span is on a fork line", (r["status"], len(r["failures"])), ("FAIL", 1))
    r = bc(tree_log[:2] + [bmulti(20, 24)], base_lines=base_multi)
    check("builtins-lint clippy: a finding whose second primary span the base has elsewhere", r["status"], "FAIL")
    # A compiled target whose dep-info names no file of the crate: nothing is known to be linted.
    empty = [bart(btree, "empty", ["src/other/lib.rs"])]
    r = bc(empty)
    check("builtins-lint clippy: dep-info that names no file of the crate", (r["status"], r["note"].startswith("exit 0, but no compiled")),
          ("UNKNOWN", True))
    # The lift reaches each rustfmt config rustfmt could take for the crate: `.rustfmt.toml` beside
    # `rustfmt.toml` (rustfmt reads it first; CiReview at b792893c: lifting rustfmt.toml alone left the
    # crate ignored, and the unit read PASS), and one above the crate, its patterns relative to it.
    ltree = os.path.join(d, "ltree")
    os.makedirs(os.path.join(ltree, "crates", "b", "src"))
    open(os.path.join(ltree, "crates", "b", "Cargo.toml"), "w").write(own_lints)
    open(os.path.join(ltree, "crates", "b", "src", "lib.rs"), "w").write("pub fn b() {}\n")
    for cfg, body in (("rustfmt.toml", 'ignore = ["crates/b/**"]\n'), (".rustfmt.toml", 'max_width = 90\nignore = ["crates/b/**", "x/**"]\n'),
                      ("crates/.rustfmt.toml", 'ignore = ["b/src"]\n')):
        open(os.path.join(ltree, cfg), "w").write(body)
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cmd_builtins_lint_lift(ltree, "crates/b")
    check("builtins-lint lift: every config at or above the crate, each read from its own directory",
          [open(os.path.join(ltree, c)).read() for c in ("rustfmt.toml", ".rustfmt.toml", "crates/.rustfmt.toml")],
          ["", 'max_width = 90\nignore = ["x/**"]\n', ""])
    # The rustfmt unit's own check that the lift worked: cargo listed the target root, rustfmt never
    # named it as checked (an ignore still holds it) and exited 0: UNKNOWN, not PASS.
    r = parse_builtins_rustfmt(write("bf.log", f'[lib (2024)] "{btree}/crates/b/src/lib.rs"\nrustfmt --check {btree}/crates/b/src/lib.rs\n'),
                               "0", 3, btree, "crates/b")
    check("builtins-lint rustfmt: a target root rustfmt did not check", (r["status"], r["note"].startswith("rustfmt did not check the target")),
          ("UNKNOWN", True))
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cmd_builtins_lint_files(btree, "crates/b", write("bc.log", "\n".join(tree_log) + "\n"),
                                write("bf.log", f'[lib (2024)] "{btree}/crates/b/src/lib.rs"\nDiff in {btree}/crates/b/src/lib.rs:32:\n-x\n+y\n'))
    check("builtins-lint files: each file with a finding, by tool", buf.getvalue().splitlines(),
          ["clippy\tcrates/b/src/lib.rs", "clippy\tcrates/b/src/new.rs", "clippy\tcrates/b/src/other.rs", "rustfmt\tcrates/b/src/lib.rs"])
    # A finding whose second primary span is in another file of the crate (CiReview at e3119a58): that
    # file is selected too, so its diff is recorded and the finding is sorted, not left without one.
    cross = json.dumps({"reason": "compiler-message", "message": {"level": "warning", "code": {"code": "clippy::x"}, "message": "m6", "spans": [
        {"file_name": "crates/b/src/lib.rs", "line_start": 1, "line_end": 1, "column_start": 1, "is_primary": True},
        {"file_name": "crates/b/src/other.rs", "line_start": 2, "line_end": 2, "column_start": 1, "is_primary": True}]}})
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cmd_builtins_lint_files(btree, "crates/b", write("bc.log", "\n".join(tree_log[:2] + [cross]) + "\n"), os.path.join(d, "absent.log"))
    check("builtins-lint files: each file a finding's primary spans name", buf.getvalue().splitlines(),
          ["clippy\tcrates/b/src/lib.rs", "clippy\tcrates/b/src/other.rs"])
    # The rustfmt unit is the rustfmt row's reading under the row's own names, counted by file.
    fmt_plant = BUILTINS_LINT_PLANT_LINES[1]
    r = parse_builtins_rustfmt(write("bf.log", f'[lib (2024)] "{btree}/crates/b/src/lib.rs"\nFormatting {btree}/crates/b/src/lib.rs\n'
                                               f"Diff in {btree}/crates/b/src/lib.rs:32:\n-{fmt_plant}\n+{fmt_plant.replace(':u8=0', ': u8 = 0')}\n"),
                               "1", 3, btree, "crates/b", write("bf-base.log", ""), "absent", bbase, bsha, bfork)
    check("builtins-lint rustfmt: the rustfmt row's reading under the row's names",
          (r["row"], r["unit"], r["status"], r["failures"], r["breakdown"]), ("builtins-lint", "rustfmt", "FAIL",
           [f"crates/b/src/lib.rs:32: {fmt_plant}"], {"by_lint": {}, "by_file": {"crates/b/src/lib.rs": [1, 0, 0]}}))
    r = parse_builtins_rustfmt(write("bf.log", f'[lib (2024)] "{btree}/crates/b/src/lib.rs"\nDiff in {btree}/crates/b/src/lib.rs:32:\n-x\n+y\n'
                                               f"Error writing files: failed to resolve mod `gone`: {btree}/crates/b/src/gone.rs does not exist\n"),
                               "1", 3, btree, "crates/b")
    check("builtins-lint rustfmt: an unread file's places count as unsorted",
          (r["status"], r["breakdown"]["by_file"]), ("UNKNOWN", {"crates/b/src/lib.rs": [0, 0, 1]}))
    check("builtins-lint rustfmt: no package", parse_builtins_rustfmt(os.path.join(d, "absent.log"), "-", 0, btree, "-")["status"], "UNKNOWN")

    # The memory bench row: one run of benches/memory.rs, read from what it printed and its exit, in
    # the shape Cut14's bench prints (two targets; exit 0 on a MISS) and in one with more targets that
    # exits 1 on a MISS.
    shell_ok = ("memory shell: 41234 bytes after create + `:` (target ≤ 65536) PASS; store +812 bytes; create + `:` "
                "310 allocs, 12 reallocs, 52011 bytes")
    shell_miss = shell_ok.replace("41234", "1090002").replace("PASS", "MISS")
    vproc_ok = "memory idle vprocs: 16 → 9000 bytes, 272 → 300000 bytes; 1136 bytes per vproc (target ≤ 2048) PASS"
    back_ok = "memory idle vprocs back to back: 16 → 9000 bytes, 272 → 300000 bytes; 1136 bytes per vproc (target ≤ 2048) PASS"
    loop_line = "memory idle vprocs: 16 → 9100 bytes, 272 → 560000 bytes; 2152 bytes per vproc in a loop writing `i` (this process's class)"
    retention_miss = ("memory idle vproc retention: 900 bytes per vproc (loop 2036 B, reached by at least 5 of 128 processes × 16 "
                      "names, less 1136 B back to back; largest 2100 B; 812 ms) (target ≤ 682) MISS")
    others = ["memory idle vproc allocations by size: 24-31 B ×1.00, 96-103 B ×1.00", "memory sizes: Vproc 512 B, Frame 128 B",
              "allocs loop NONE: 0.00 allocs/iter, 0.00 reallocs/iter, 0.0 bytes/iter; per run 12 allocs"]
    panic = ("thread 'main' panicked at crates/pi-shell/benches/memory.rs:249:2:\nassertion `left == right` failed: every idle vproc "
             "holds its task\n  left: 271\n right: 272\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n")
    panic_said = "thread 'main' panicked at crates/pi-shell/benches/memory.rs:249:2: assertion 'left == right' failed: every idle vproc holds its task"

    def mb(printed, ex, err="", bex="0", build="", built=True):
        out = write("mb.out", "".join(f"{line}\n" for line in printed)) if printed is not None else os.path.join(d, "absent-mb.out")
        r = parse_membench(MEMBENCH_UNIT, out, write("mb.err", err), str(ex) if built else "-", 61, bex, write("mb-build.log", build))
        return r["status"], r["failures"], r["note"], r["passed"], len(r["bench_lines"])

    check("membench: every target PASS, exit 0", mb([shell_ok, vproc_ok] + others, 0),
          ("PASS", [], "2 of 2 target(s) PASS, 0 MISS; exit 0", 2, 5))
    check("membench: a MISS with exit 0 (the bench prints its verdicts only): FAIL, the line named up to its verdict",
          mb([shell_miss, vproc_ok] + others, 0),
          ("FAIL", ["memory shell: 1090002 bytes after create + ':' (target ≤ 65536) MISS"], "1 of 2 target(s) PASS, 1 MISS; exit 0", 1, 5))
    check("membench: a MISS with exit 1 (a bench that exits non-zero on a MISS), among more targets",
          mb([shell_ok, back_ok, loop_line, retention_miss] + others, 1)[:3],
          ("FAIL", [retention_miss[:retention_miss.index("MISS") + 4]], "2 of 3 target(s) PASS, 1 MISS; exit 1"))
    check("membench: every line printed is kept, the line with no verdict too", mb([shell_ok, back_ok, loop_line] + others, 0)[4], 6)
    check("membench: exit 0 and no target line", mb(others, 0)[:3],
          ("UNKNOWN", [], "exit 0, and the bench printed no target ('(target …) PASS' or MISS)"))
    check("membench: a panic before any target line", mb([], 101, panic)[:3],
          ("UNKNOWN", [], f"exit 101, and the bench printed no target ('(target …) PASS' or MISS): {panic_said}"))
    # A PASS or MISS outside a `(target …)` is no target: it neither passes nor fails the row, nor
    # hides a target's MISS on the same line; two targets on one line are two.
    check("membench: PASS or MISS outside a target is no target",
          [mb(["diagnostic: the verdict word is PASS"], 0)[0], mb(["diagnostic: the verdict word is MISS"], 0)[0]], ["UNKNOWN", "UNKNOWN"])
    check("membench: a target's MISS after a PASS outside any target",
          mb(["memory note: PASS (target ≤ 10) MISS"], 0)[:2], ("FAIL", ["memory note: PASS (target ≤ 10) MISS"]))
    check("membench: two targets on one line", mb(["memory two: 5 (target ≤ 10) PASS, 20 (target ≤ 10) MISS; 3 more"], 0)[:3],
          ("FAIL", ["memory two: 5 (target ≤ 10) PASS, 20 (target ≤ 10) MISS"], "1 of 2 target(s) PASS, 1 MISS; exit 0"))
    pr = parse_membench(MEMBENCH_UNIT, write("mb.out", f"{shell_ok}\n"), write("mb.err", panic), "101", 61, "0", write("mb-build.log", ""))
    check("membench: the bench's stderr is kept whole, an assertion's values too",
          pr["bench_stderr"], ["thread 'main' panicked at crates/pi-shell/benches/memory.rs:249:2:",
                               "assertion 'left == right' failed: every idle vproc holds its task", "  left: 271", " right: 272",
                               "note: run with 'RUST_BACKTRACE=1' environment variable to display a backtrace"])
    long_err = "".join(f"line {i}\n" for i in range(300)) + "measured allocation: 987654321 bytes\n"
    check("membench: a long stderr is kept whole, to its last number",
          parse_membench(MEMBENCH_UNIT, write("mb.out", f"{shell_ok}\n"), write("mb.err", long_err), "0", 61, "0",
                         write("mb-build.log", ""))["bench_stderr"][-2:],
          ["line 299", "measured allocation: 987654321 bytes"])
    check("membench: a panic after its targets passed: FAIL, the panic named", mb([shell_ok, vproc_ok], 101, panic)[:3],
          ("FAIL", [f"exit 101: {panic_said}"], f"2 of 2 target(s) PASS, 0 MISS; exit 101 ({panic_said})"))
    check("membench: killed", mb([shell_ok], 137)[:3], ("UNKNOWN", [], "exit 137: the time bound or a signal ended the bench"))
    check("membench: the bench did not build",
          mb(None, "-", bex="101", build="   Compiling pi-shell\nerror[E0425]: cannot find value `y`\nerror: could not compile\n", built=False)[:3],
          ("UNKNOWN", [], "the bench did not build (cargo bench --no-run, exit 101): error[E0425]: cannot find value `y`"))
    check("membench: the build's time bound", mb(None, "-", bex="124", built=False)[2],
          "the bench did not build (cargo bench --no-run, exit 124): the time bound or a signal ended it")
    check("membench: no executable, nothing ran", mb(None, "-", built=False)[:3],
          ("UNKNOWN", [], "cargo named no executable of the memory bench, so nothing ran"))
    check("membench: no log of the run", mb(None, 0)[:3], ("UNKNOWN", [], "no log of the bench's run"))

    def art(name, kind, exe):
        return json.dumps({"reason": "compiler-artifact", "target": {"name": name, "kind": [kind]}, "executable": exe})

    check("membench: the bench's executable from cargo's messages",
          bench_executable(write("mb.json", "\n".join([art("memory", "lib", "/t/lib"), art("fork", "bench", "/t/fork"),
                                                     "not json", art("memory", "bench", "/t/release/deps/memory-1")]))),
          "/t/release/deps/memory-1")
    check("membench: no executable of that bench", bench_executable(write("mb.json", art("fork", "bench", "/t/fork"))), None)

    # The bazel-lock row: parse_bazel_lock on what gen-bazel-lock.ts --check prints, against a tree whose
    # MODULE.bazel.lock records three Cargo files, an environment variable and a repository mapping. The
    # stale line's words are Bazel 9.2.0's (SingleExtensionEvalFunction, RepoRecordedInput), as Job
    # infra-5336-bazel-lock-regenerate-f95t5 printed them at Cut17 d4db2228; several reasons are joined
    # by commas, and only the first recorded input that differs is named.
    ltree = os.path.join(d, "bazel-lock-tree")
    os.makedirs(os.path.join(ltree, "crates", "a"))
    lfiles = {"Cargo.lock": "# lock\n", "Cargo.toml": "[workspace]\n", "crates/a/Cargo.toml": "[package]\n"}
    for p, body in lfiles.items():
        open(os.path.join(ltree, p), "w").write(body)
    lsha = {p: hashlib.sha256(body.encode()).hexdigest() for p, body in lfiles.items()}
    lext = "@@rules_rust+//crate_universe:extensions.bzl%crate"

    def lock(recorded=None):
        """The tree's lock, recording each file as it is, or by the sha256 RECORDED gives for its path."""
        rec = dict(lsha, **(recorded or {}))
        inputs = ["ENV:CARGO_BAZEL_REPIN \\0"] + [f"FILE:@@//{p} {h}" for p, h in rec.items()] + ["REPO_MAPPING:,x y"]
        json.dump({"lockFileVersion": 28, "moduleExtensions": {lext: {"general": {"recordedInputs": inputs}}}},
                  open(os.path.join(ltree, "MODULE.bazel.lock"), "w"))

    up = ("Starting local Bazel server (9.2.0) and connecting to it...\nINFO: All requested repos fetched successfully.\n"
          "MODULE.bazel.lock is up to date.\n")
    hint = ("gen-bazel-lock: check failed. If bazel reported `MODULE.bazel.lock is no longer up-to-date`, run `bun run "
            "gen:bazel-lock` and commit the result.\n")

    def gone(reason):
        return (f"ERROR: MODULE.bazel.lock is no longer up-to-date because {reason}. Please run `bazel mod deps "
                f"--lockfile_mode=update` to update your lockfile.\n{hint}")

    def changed(what):
        return f"an input to the extension '{lext}' changed: {what}"

    def bl(text, ex="8"):
        r = parse_bazel_lock(write("bl.log", text) if text is not None else os.path.join(d, "absent-bl.log"), ex, 9, ltree)
        return r["status"], r["failures"], r["note"], r["passed"], r["failed"]

    def sn(t):
        """A reading's status and note."""
        return t[0], t[2]

    a64, b64, c64 = "a" * 64, "b" * 64, "c" * 64
    lock()
    check("bazel-lock: current, each recorded file as it is", bl(up, "0"),
          ("PASS", [], "current: Bazel reads each recorded input as it is, and each of the 3 files the lock records is as "
           "recorded", 3, 0))
    lock({"Cargo.lock": a64, "Cargo.toml": b64})
    file_lock = changed("file info or contents of @@//Cargo.lock changed")
    stale_two = ("FAIL", [f"@@//Cargo.lock: the lock records sha256 {a64[:12]}, the file is {lsha['Cargo.lock'][:12]}; Bazel names it",
                          f"@@//Cargo.toml: the lock records sha256 {b64[:12]}, the file is {lsha['Cargo.toml'][:12]}"],
                 f"stale: Bazel says {file_lock}; the lock's record differs from the file for 2 of the 3 files it records", 1, 2)
    check("bazel-lock: Bazel names a file, and each file whose record differs is named", bl(gone(file_lock)), stale_two)
    check("bazel-lock: the same in Bazel's colours", bl("\x1b[31m\x1b[1mERROR: \x1b[0m" + gone(file_lock)[len("ERROR: "):]), stale_two)
    env_only = changed("environment variable CARGO_BAZEL_DEBUG changed: <unset> -> '1'")
    lock()
    r = bl(gone(env_only))
    check("bazel-lock: an environment variable alone reads UNKNOWN with Bazel's words",
          (r[0], r[1], "names no file of the tree: " + env_only + ". That is an environment variable" in r[2]), ("UNKNOWN", [], True))
    lock({"Cargo.toml": b64})
    check("bazel-lock: an environment variable named first, a file differing too: UNKNOWN, the file noted",
          (bl(gone(env_only))[0], bl(gone(env_only))[2].endswith("; the lock's record also differs from the file for Cargo.toml")),
          ("UNKNOWN", True))
    usages = f"the usages of the extension '{lext}' have changed"
    check("bazel-lock: a file among several reasons fails",
          bl(gone(usages + "," + changed("file info or contents of @@//Cargo.toml changed")))[:2],
          ("FAIL", [f"@@//Cargo.toml: the lock records sha256 {b64[:12]}, the file is {lsha['Cargo.toml'][:12]}; Bazel names it"]))
    check("bazel-lock: the usages alone read UNKNOWN", bl(gone(usages))[0], "UNKNOWN")
    check("bazel-lock: current to Bazel while a record differs: the readings disagree",
          sn(bl(up, "0")), ("UNKNOWN", "Bazel reads the lock current, and its record of Cargo.toml differs from the file: the two "
                                         "readings disagree"))
    lock({"crates/b/Cargo.toml": c64})
    check("bazel-lock: a recorded file the tree lacks",
          bl(gone(changed("file info or contents of @@//crates/b/Cargo.toml changed")))[:2],
          ("FAIL", [f"@@//crates/b/Cargo.toml: the lock records sha256 {c64[:12]}, the file is missing; Bazel names it"]))
    lock()
    check("bazel-lock: Bazel names a file whose record is as the file is", bl(gone(file_lock))[:2],
          ("FAIL", ["@@//Cargo.lock: Bazel names it, and the lock's record of it is as the file is"]))
    check("bazel-lock: gen-bazel-lock's hint alone is no stale lock", sn(bl("FATAL: Bazel could not start\n" + hint, "1")),
          ("UNKNOWN", "exit 1, and Bazel neither read the lock current nor said why it is stale: FATAL: Bazel could not start"))
    check("bazel-lock: exit 0 with no up-to-date line", bl("INFO: All requested repos fetched successfully.\n", "0")[0], "UNKNOWN")
    check("bazel-lock: the time bound", sn(bl(up, "124")), ("UNKNOWN", "exit 124: the time bound or a signal ended the check"))
    check("bazel-lock: no log", sn(bl(None)), ("UNKNOWN", "no log of the check"))
    json.dump({"lockFileVersion": 28, "moduleExtensions": {lext: {"general": {"recordedInputs": ["ENV:REPIN \\0"]}}}},
              open(os.path.join(ltree, "MODULE.bazel.lock"), "w"))
    check("bazel-lock: a lock that records no file compared nothing", sn(bl(up, "0")),
          ("UNKNOWN", "Bazel reads the lock current, and it records no file of the tree, so no file was compared"))
    open(os.path.join(ltree, "MODULE.bazel.lock"), "w").write("{ not json")
    check("bazel-lock: a lock that does not read", bl(up, "0")[0], "UNKNOWN")
    # The plant on a current tree: Cargo.toml no longer as recorded, and Bazel names it.
    lock()
    with contextlib.redirect_stdout(io.StringIO()):
        cmd_plant("bazel-lock", ltree)
    r = bl(gone(changed("file info or contents of @@//Cargo.toml changed")))
    check("bazel-lock: the plant fails the row, its one failure naming the planted file",
          (r[0], [f.startswith(PLANTS["bazel-lock"][2]) for f in r[1]]), ("FAIL", [True]))

    # The summary: a unit no job reported is UNKNOWN, and so is its row (the silent-shard control):
    # a pi-shell binary, a clippy crate, a platform, a cargo workspace of the rustfmt row and the memory bench.
    fmt_ws = rustfmt_workspaces() or ["Cargo.toml"]
    silent = {("set-root", "pi-shell::zle_pty", "root"), ("clippy", "pi-vfs", "runner"), ("windows", PLATFORM_CRATES, "runner"),
              ("rustfmt", fmt_ws[-1], "runner"), ("membench", MEMBENCH_UNIT, "runner")}
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

    def summary(rust="rust_test=success rust_test_macos=success", cli=False):
        """cmd_summary on res, with rust as SC_RUST_TESTS (as sami-checks.yml always passes it), or without it for None;
        with cli, as `sc.py summary` runs it (summary_main)."""
        kept = os.environ.pop("SC_RUST_TESTS", None)
        if rust is not None:
            os.environ["SC_RUST_TESTS"] = rust
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc = summary_main([res, build, known_file]) if cli else cmd_summary(res, build, known_file)
        finally:
            os.environ.pop("SC_RUST_TESTS", None)
            if kept is not None:
                os.environ["SC_RUST_TESTS"] = kept
        return rc, buf.getvalue()

    rc, out = summary()
    check("summary exit with a silent unit", rc, 2)
    check("summary names the silent unit UNKNOWN", "`pi-shell::zle_pty` (root): UNKNOWN: no result" in out, True)
    check("summary row of the silent unit", "| pi-shell set (root) | **UNKNOWN** | 1 / 0 / 0 / 1 |" in out, True)
    check("summary other rows pass", "| pi-shell set (runner) | **PASS** | 2 / 0 / 0 / 0 |" in out, True)
    check("summary names the silent clippy crate UNKNOWN", "`pi-vfs` (runner): UNKNOWN: no result" in out, True)
    check("summary row of the silent clippy crate",
          "| clippy --tests, every lint a warning, per crate (failed: findings beyond clippy-baseline.txt) | **UNKNOWN** | 5 / 0 / 0 / 1 |" in out, True)
    check("summary row of the silent platform", "| Windows: pi-shell, platform checks | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out, True)
    check("summary row of a platform that reported", "| macOS: pi-shell, platform checks | **PASS** | 1 / 0 / 0 / 0 |" in out, True)
    check("summary names the silent rustfmt workspace UNKNOWN", f"`{fmt_ws[-1]}` (runner): UNKNOWN: no result" in out, True)
    check("summary row of the silent rustfmt workspace",
          f"| rustfmt: cargo fmt --check, per cargo workspace | **UNKNOWN** | {len(fmt_ws) - 1} / 0 / 0 / 1 |" in out, True)
    check("summary row of the silent memory bench",
          (f"`{MEMBENCH_UNIT}` (runner): UNKNOWN: no result" in out,
           "| pi-shell memory bench, release (benches/memory.rs: its PASS/MISS targets) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out),
          (True, True))
    # And the same with every unit present passes.
    for row, unit, who in sorted(silent):
        # The root unit's file is silent.json: a later case replaces it under that name.
        name = "silent.json" if row == "set-root" else f"silent-{row}.json"
        json.dump(result(row, unit, who, "PASS", 0, 1, passed=1), open(os.path.join(res, name), "w"))
    rc, _ = summary()
    check("summary exit when every unit passed", rc, 0)
    # The summary's exit (SUMMARY_EXIT), each case planted on the passing results above: a row that
    # failed exits 1; a row that could not be read, with no fault, exits 2, never 1; both together exit
    # 1, also as two units of one row, which then reads FAIL; every row passing exits 0. Its first
    # line under the verdict says which, and why, naming the rows.
    set_a, set_b = sorted(k for k in paths if k[0] == "set-runner")
    ck = next(k for k in paths if k[0] == "checkts")
    passing = {k: open(paths[k]).read() for k in (set_a, set_b, ck)}
    set_title, ck_title = (next(t for t, k in ROWS if k == key) for key in ("set-runner", "checkts"))

    def planted_unit(k, s):
        return result(*k, s, 101 if s == "FAIL" else 124, 1, failed=int(s == "FAIL"), failures=["planted::fault"] if s == "FAIL" else [],
                      note="" if s == "FAIL" else "planted: it could not be read")

    def planted_exit(planted, cli=False):
        """(the exit, the summary's exit line, the summary) with planted {unit: FAIL or UNKNOWN}."""
        for k, text in passing.items():
            open(paths[k], "w").write(text)
        for k, s in planted.items():
            json.dump(planted_unit(k, s), open(paths[k], "w"))
        rc, out = summary(cli=cli)
        return rc, next((ln for ln in out.splitlines() if ln.startswith("**Exit ")), None), out

    rc, ln, out = planted_exit({set_a: "FAIL"})
    check("summary exit: a row that failed exits 1", (rc, ln),
          (1, f"**Exit 1 (FAIL)**: it found a fault: these rows read FAIL: {set_title} (`set-runner`)."))
    rc, ln, out = planted_exit({ck: "UNKNOWN"})
    check("summary exit: a row that could not be read, and no fault, exits 2", (rc, ln),
          (2, f"**Exit 2 (UNKNOWN)**: it found no fault, but these rows could not be read and read UNKNOWN: {ck_title} "
              "(`checkts`). This run did not look at everything it was to check; each reason is in the list below. "
              "2 is not the failure code."))
    rc, ln, out = planted_exit({set_a: "FAIL", ck: "UNKNOWN"})
    check("summary exit: a row that failed and a row that could not be read exit 1", (rc, ln),
          (1, f"**Exit 1 (FAIL)**: it found a fault: these rows read FAIL: {set_title} (`set-runner`). These rows could "
              f"not be read either and read UNKNOWN: {ck_title} (`checkts`). A fault outranks a row that could not be "
              "read, so the exit is 1, not 2."))
    rc, ln, out = planted_exit({set_a: "FAIL", set_b: "UNKNOWN"})
    check("summary exit: a unit that failed beside one that could not be read: the row reads FAIL, exit 1",
          (rc, f"| {set_title} | **FAIL** | 0 / 0 / 1 / 1 |" in out,
           f"`{set_b[1]}` (runner): UNKNOWN: planted: it could not be read" in out),
          (1, True, True))
    rc, ln, out = planted_exit({})
    check("summary exit: every row passed exits 0", (rc, ln),
          (0, "**Exit 0 (PASS)**: every row that ran passed (a KNOWN row, whose only failures are on the known-failure "
              "list, passes)."))
    # A summary that stops before its verdict judged no row: `sc.py summary` (summary_main) exits 2,
    # and says so, for a known-failure list it cannot read and for a result with no row.

    def stopped(results, known):
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = summary_main([results, build, known])
        return rc, "UNKNOWN: the summary stopped before its verdict" in err.getvalue(), err.getvalue()

    bad_known = os.path.join(d, "bad-known.txt")
    open(bad_known, "w").write("set-runner\trunner\tpi-shell\n")
    rc, said, err = stopped(res, bad_known)
    check("summary exit: a known-failure list it cannot read exits 2", (rc, said, "not five tab-separated fields" in err),
          (2, True, True))
    no_row = os.path.join(d, "res-no-row")
    os.makedirs(no_row)
    json.dump({"reason": "compiler-message"}, open(os.path.join(no_row, "cargo.json"), "w"))
    rc, said, err = stopped(no_row, known_file)
    check("summary exit: a result with no row exits 2", (rc, said, "KeyError: 'row'" in err), (2, True, True))
    rc, said, err = stopped(res, os.path.join(d, "no-such-known.txt"))
    check("summary exit: a known-failure list that is not there exits 2", (rc, said, "is not a file" in err), (2, True, True))
    # A summary that cannot write its verdict file, or its summary, keeps a fault it found at FAIL (1)
    # and turns a pass into UNKNOWN (2): a pass that nobody can read is no pass.
    @contextlib.contextmanager
    def environ(**kv):
        kept = {k: os.environ.get(k) for k in kv}
        os.environ.update(kv)
        try:
            yield
        finally:
            for k, v in kept.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    unwritable = os.path.join(d, "verdict-is-a-directory")
    os.makedirs(unwritable)
    with environ(SC_VERDICT=unwritable), contextlib.redirect_stderr(io.StringIO()) as err:
        rc_fail, ln_fail, _ = planted_exit({set_a: "FAIL"}, cli=True)
        rc_pass, ln_pass, out_pass = planted_exit({}, cli=True)
    check("summary exit: a fault whose verdict file cannot be written still exits 1",
          (rc_fail, (ln_fail or "").startswith("**Exit 1 (FAIL)**")), (1, True))
    check("summary exit: a pass whose verdict file cannot be written reads UNKNOWN and exits 2",
          (rc_pass, (ln_pass or "").startswith("**Exit 2 (UNKNOWN)**: every row that ran passed, but the verdict file"),
           '"verdict":"UNKNOWN"' in out_pass, "UNKNOWN: the verdict file" in err.getvalue()), (2, True, True, True))

    class Full(io.StringIO):
        """A stdout that cannot be written (as /dev/full)."""
        def write(self, s):
            raise OSError(28, "No space left on device")

    full_verdict = os.path.join(d, "verdict-of-a-full-stdout.json")
    full = {}
    for name, planted in (("fail", {set_a: "FAIL"}), ("pass", {})):
        planted_exit(planted)
        with environ(SC_VERDICT=full_verdict, SC_RUST_TESTS="rust_test=success rust_test_macos=success"), \
                contextlib.redirect_stdout(Full()), contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                rc = cmd_summary(res, build, known_file)
            except OSError as e:
                rc = f"raised {e}"
        full[name] = (rc, json.load(open(full_verdict))["verdict"], "the summary could not be written" in err.getvalue())
    check("summary exit: a summary that cannot be written keeps a fault at 1 and turns a pass into UNKNOWN, 2",
          full, {"fail": (1, "FAIL", True), "pass": (2, "UNKNOWN", True)})
    planted_exit({})
    # The workflow's own Summary step (sami-checks.yml), run as the summary job runs it: `bash -e -o
    # pipefail` (its defaults.run.shell), through `sc.py summary`. The step ends with the summary's
    # exit, also when a command after the summary fails: a result that cannot be opened stops the
    # summary (2) and the results.json export after it, which must not end the step 1.
    step_run = subprocess.run(["yq", "-r", '.jobs.summary.steps[] | select(.name == "Summary") | .run', WORKFLOW],
                              capture_output=True, text=True).stdout
    check("summary step: the workflow's Summary step is read", ("sc.py summary" in step_run, 'exit "$rc"' in step_run), (True, True))
    tool_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    def run_step(planted, dangling=False, unwritable=None):
        """(the step's exit, its output, the verdict file's verdict, summary.md, the step summary, the
        notice's verdict) of the Summary step on a private copy of the passing results, with planted
        {unit: FAIL or UNKNOWN}. unwritable names one report the step cannot write: output (the job's
        output), step-summary, or results-json."""
        w = tempfile.mkdtemp(prefix="step-run-", dir=d)
        os.symlink(tool_root, os.path.join(w, "tool"))
        sc_dir = os.path.join(w, "sc")
        shutil.copytree(res, os.path.join(sc_dir, "results"))
        shutil.copytree(build, os.path.join(sc_dir, "build"))
        for k, s in planted.items():
            json.dump(planted_unit(k, s), open(os.path.join(sc_dir, "results", os.path.basename(paths[k])), "w"))
        if dangling:
            os.symlink(os.path.join(w, "gone.json"), os.path.join(sc_dir, "results", "unreadable.json"))
        if unwritable == "results-json":
            os.makedirs(os.path.join(sc_dir, "report", "results.json"))
        step_summary = "/dev/full" if unwritable == "step-summary" else os.path.join(w, "step-summary.md")
        env = dict(os.environ, SC=sc_dir, SC_VERDICT=os.path.join(sc_dir, "report", "verdict.json"),
                   GITHUB_STEP_SUMMARY=step_summary,
                   GITHUB_OUTPUT="/dev/full" if unwritable == "output" else os.path.join(w, "output"),
                   SC_PLATFORMS="", SC_SILENT="", SC_PLANT="", SC_COMMIT="selftest", SC_ROWS="set-runner,checkts",
                   SC_RUST_TESTS="rust_test=success rust_test_macos=success")
        p = subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step_run], cwd=w, env=env,
                           capture_output=True, text=True)

        def text(path):
            try:
                return open(path, encoding="utf-8").read()
            except OSError:
                return ""

        out = p.stdout + p.stderr
        verdict_file = text(env["SC_VERDICT"])
        notice = next((ln.split("::", 2)[2] for ln in out.splitlines() if ln.startswith("::notice title=sami-checks verdict::")), "")
        return (p.returncode, out, json.loads(verdict_file)["verdict"] if verdict_file else None,
                text(os.path.join(sc_dir, "report", "summary.md")), "" if step_summary == "/dev/full" else text(step_summary),
                json.loads(notice)["verdict"] if notice else None)

    # Each case is a step of its own on its own copy, so they run side by side (4 at a time, the
    # runner's cores): one after another they would add about 20 s to the plan job.
    planted_exit({})
    step_cases = {"pass": ({},), "fail": ({set_a: "FAIL"},), "unknown": ({ck: "UNKNOWN"},),
                  "fail and unknown": ({set_a: "FAIL", ck: "UNKNOWN"},), "dangling": ({}, True)}
    for what in ("results-json", "step-summary", "output"):
        step_cases[what] = ({}, False, what)
        step_cases[what + ", a fault"] = ({set_a: "FAIL"}, False, what)
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        ran = dict(zip(step_cases, pool.map(lambda a: run_step(*a), step_cases.values())))
    check("summary step: the step ends with the summary's exit", {k: ran[k][0] for k in ("pass", "fail", "unknown", "fail and unknown")},
          {"pass": 0, "fail": 1, "unknown": 2, "fail and unknown": 1})
    rc, out = ran["dangling"][:2]
    check("summary step: a result that cannot be opened ends the step 2, also after the results.json export fails",
          (rc, "UNKNOWN: the summary stopped before its verdict" in out, "results.json" in out), (2, True, True))
    # A report the step cannot write after the summary: a pass then reads UNKNOWN everywhere it can
    # still be read (the verdict file, summary.md, the notice, the step summary when it was written)
    # and ends 2, with an UNKNOWN annotation; a fault stays FAIL and 1.
    got_unwritten = {}
    for what in ("results-json", "step-summary", "output"):
        rc, out, vf, md, ss, notice = ran[what]
        got_unwritten[what] = (rc, vf, notice, "**Exit 2 (UNKNOWN)**: every row that ran passed, but" in md, "**Exit 0 (PASS)**" in md,
                               "::error title=sami-checks summary::UNKNOWN: " in out)
        got_unwritten[what + ", a fault"] = tuple(ran[what + ", a fault"][i] for i in (0, 2, 5))
    want_pass = (2, "UNKNOWN", "UNKNOWN", True, False, True)
    check("summary step: a report the step cannot write turns a pass into UNKNOWN, 2, and keeps a fault at 1", got_unwritten,
          {"results-json": want_pass, "step-summary": want_pass, "output": want_pass,
           "results-json, a fault": (1, "FAIL", "FAIL"), "step-summary, a fault": (1, "FAIL", "FAIL"), "output, a fault": (1, "FAIL", "FAIL")})
    ss = ran["output"][4]
    check("summary step: a job output it cannot write is named in the step summary written before it",
          ("**Exit 0 (PASS)**" in ss, ss.rstrip().endswith("so no reader can see this pass. 2 is not the failure code.")), (True, True))
    # A unit two jobs reported is UNKNOWN.
    json.dump(result("checkts", "check:ts", "runner", "PASS", 0, 1, passed=1), open(os.path.join(res, "dup.json"), "w"))
    rc, out = summary()
    check("summary with a unit reported twice", (rc, "two jobs reported this unit" in out), (2, True))
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
    check("a self-skip as both users", ("| pi-builtins, nextest default profile | **UNKNOWN** |" in out, rc), (True, 2))
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
          "every failure is known, but 1 test(s) skipped themselves here" in out, rc), (True, True, 2))
    json.dump(result("set-root", "pi-shell::zle_pty", "root", "PASS", 0, 1, passed=1, tests=[("s", 1.0)]),
              open(os.path.join(res, "silent.json"), "w"))
    rc, out = summary()
    check("known failures and a self-skip root covered", ("| pi-shell set (runner) | **KNOWN** |" in out, rc), (True, 0))
    json.dump(zle_runner, open(os.path.join(res, "zle-runner.json"), "w"))
    open(known_file, "a").write("set-runner\trunner\tpi-shell::zle_pty\tp\tfixed since\n")
    rc, out = summary()
    check("a listed test that passed is to be removed", ("`p`: passed (listed for: fixed since)" in out, rc), (True, 1))
    # The Rust tests' rows, from their two jobs' conclusions: success passes, failure fails, and a
    # missing, cancelled or skipped result is UNKNOWN; so is each Rust row when SC_RUST_TESTS is absent.
    open(known_file, "w").write("set-runner\trunner\tpi-shell::zle_pty\tk\tthe host's zsh\n")
    rc, out = summary(rust=None)
    check("Rust rows UNKNOWN without SC_RUST_TESTS", (f"| {RUST_JOBS[0][0]} | **UNKNOWN** |" in out,
          f"| {RUST_JOBS[1][0]} | **UNKNOWN** |" in out, "conclusion is [none]" in out, rc), (True, True, True, 2))
    rc, out = summary()
    check("both Rust jobs passed", (f"| {RUST_JOBS[0][0]} | **PASS** |" in out, f"| {RUST_JOBS[1][0]} | **PASS** |" in out, rc), (True, True, 0))
    rc, out = summary(rust="rust_test=failure rust_test_macos=cancelled")
    check("a failed and a cancelled Rust job", (f"| {RUST_JOBS[0][0]} | **FAIL** |" in out, f"| {RUST_JOBS[1][0]} | **UNKNOWN** |" in out, rc), (True, True, 1))
    rc, out = summary(rust="rust_test= rust_test_macos=skipped")
    check("a Rust job with no result", (f"| {RUST_JOBS[0][0]} | **UNKNOWN** |" in out, "conclusion is [none]" in out, rc), (True, True, 2))
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
          "| pi-builtins, nextest default profile | **UNKNOWN** |" in out, rc), (True, True, 2))
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
          (True, 2))
    open(known_file, "w").write(zle_k + need_root + no_clone)
    json.dump(bx("runner", ["c"], ["c -p a b: skipped, it needs root", "c -p a b: skipped, no FIFO"]),
              open(os.path.join(res, "b-runner.json"), "w"))
    rc, out = summary()
    check("a self-skip with one line no entry starts", ("`pi-builtins` (runner): UNKNOWN" in out, rc), (True, 2))
    # Every skip line counts: twenty lines an entry names and a twenty-first it does not is UNKNOWN
    # (CiReview at 15d6f1a9: only the first 20 lines were kept, so the 21st was never matched).
    json.dump(bx("runner", ["c"], [f"c -p a b: skipped, it needs root ({i})" for i in range(20)] + ["c -p a b: skipped, no FIFO"]),
              open(os.path.join(res, "b-runner.json"), "w"))
    rc, out = summary()
    check("a self-skip whose 21st line no entry starts", ("`pi-builtins` (runner): UNKNOWN" in out, rc), (True, 2))
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
    # The plan: cmd_plan's outputs for a dispatch with these inputs, or the message it stopped with.
    def plan_out(rows="all", silent="", plant="", event="workflow_dispatch", ref="refs/heads/x", seed="", cut=""):
        env = dict(GITHUB_EVENT_NAME=event, GITHUB_REF=ref, GITHUB_SHA="b" * 40, SC_INPUT_COMMIT="a" * 40,
                   SC_INPUT_ROWS=rows, SC_INPUT_SILENT=silent, SC_INPUT_PLANT=plant, SC_INPUT_SEED=seed,
                   SC_CUT=cut)
        kept_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                cmd_plan()
            return dict(line.split("=", 1) for line in buf.getvalue().splitlines())
        except SystemExit as e:
            return str(e.code)
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    # The docs, changelog, rustfmt, membench and builtins-lint rows. The plan takes `plant` as one of them or nothing.
    for plant_in, ok in (("", True), ("docs", True), ("changelog", True), ("rustfmt", True), ("membench", True), ("builtins-lint", True),
                         ("bazel-lock", True),
                         ("both", False)):
        r = plan_out(plant=plant_in)
        check(f"plan with plant={plant_in!r}", isinstance(r, dict) and r.get("plant") == plant_in, ok)
    # The Rust gate's build seed. A dispatch takes auto (the newest cut's), build (this run's own)
    # or off, and a build is the seed's own proof: it runs the cold control beside the seeded jobs.
    for seed_in, want in (("", "auto"), ("auto", "auto"), ("build", "build"), ("off", "off")):
        r = plan_out(seed=seed_in)
        check(f"plan with seed={seed_in!r}", (r.get("seed"), r.get("seed_control")) if isinstance(r, dict) else r,
              (want, "true" if want == "build" else "false"))
    r = plan_out(seed="warm")
    check("plan: a seed input that is no mode fails, naming it and listing the modes",
          (isinstance(r, str), "'warm'" in r, all(s in r for s in SEEDS)), (True, True, True))
    # The cut builds its own seed, and runs the cold control on every fifth cut (SC_CUT, the cut
    # number of the newest `sami release CutN` commit). No number is no control, and says so.
    for cut_in, control in (("15", "true"), ("14", "false"), ("20", "true"), ("", "false"), ("none", "false")):
        r = plan_out(event="push", ref="refs/heads/release-candidate", cut=cut_in)
        check(f"plan: the cut {cut_in!r} builds its own seed, and runs the cold control on every fifth",
              (r.get("seed"), r.get("seed_control")) if isinstance(r, dict) else r, ("build", control))
    # The row selection (the dispatch input `rows`). Each job of sami-checks.yml but the plan and the
    # summary runs only when the plan names it in `jobs`, and some row's work reaches it.
    wf = workflow_jobs()
    gated = [j for j in wf if j not in ALWAYS_JOBS]
    check("plan: each row has its work", sorted(row_work()), sorted(ROW_KEYS))
    check("plan: each job's if: holds its gate", [j for j in gated if gate(j) not in wf[j]["if"]], [])
    check("plan: each job needs the plan", [j for j in gated if "plan" not in wf[j]["needs"]], [])
    check("plan: the summary needs each job", [j for j in gated if j not in wf["summary"]["needs"]], [])
    check("plan: every row reaches every job", plan_rows(ROW_KEYS, wf)[2], gated)
    r = plan_out(rows="docs,nosuch")
    check("plan: a row name that is no row fails, naming it and listing the rows",
          (isinstance(r, str), "'nosuch'" in r, all(k in r for k in ROW_KEYS)), (True, True, True))
    r = plan_out(rows="all,docs")
    check("plan: all stands alone", (isinstance(r, str), "'all'" in r), (True, True))
    full = dict(commit="a" * 40, rows=",".join(ROW_KEYS), jobs=json.dumps(gated), silent="", plant="",
                seed="auto", seed_control="false",
                set=json.dumps(set_matrix()), builtins=json.dumps(builtins_matrix()), workspace=json.dumps(workspace_matrix()),
                ts=json.dumps(ts_matrix()), gvisor=json.dumps(gvisor_matrix()), platforms=",".join(PLATFORMS))

    def picked(r):
        return {k: r.get(k) for k in full} if isinstance(r, dict) else r

    check("plan: a dispatch with rows=all runs every row and every job", picked(plan_out()), full)
    check("plan: the cut tests the pushed commit with every row and no control, whatever the inputs say",
          picked(plan_out(rows="docs", silent="docs", plant="docs", seed="off", event="push", ref="refs/heads/release-candidate")),
          dict(full, commit="b" * 40, seed="build"))
    r = plan_out(event="push", ref="refs/heads/feat/sami-checks")
    check("plan: a push of another branch plans nothing", (isinstance(r, str), "not on push of refs/heads/feat/sami-checks" in r), (True, True))
    # A prerequisite build runs only for a row whose job needs it (its needs: in sami-checks.yml).
    for rows, want_rows, want_jobs in (
            ("docs,changelog", "docs,changelog", ["docs", "changelog"]),
            ("ts-ca", "ts-ca", ["natives", "ts-ca"]),
            ("set-root", "set-runner,set-root,lib4", ["tools", "build", "set"]),
            ("lib4", "set-runner,set-root,lib4", ["tools", "build", "set"]),
            ("rust_test", "rust_test", ["build", "natives", "seed-linux", "rust-test", "rust-test-drift",
                                        "rust-test-cold", "rust-test-compare"]),
            ("rust_test_macos", "rust_test_macos", ["build", "seed-macos", "rust-test-macos"]),
            ("gv-orphan-root", "gv-set-uid1000,gv-set-root,gv-lib4-uid1000,gv-lib4-root,gv-orphan-uid1000,gv-orphan-root",
             ["tools", "build", "gvisor"]),
            ("skipforms", "set-runner,set-root,lib4,builtins,workspace,ts-small,ts-ca,skipforms," + ",".join(
                k for k in ROW_KEYS if k.startswith("gv-")),
             ["tools", "build", "natives", "set", "builtins", "workspace", "ts-small", "ts-ca", "gvisor", "skip-forms"]),
            ("windows", "windows", ["platforms"]),
            ("rustfmt", "rustfmt", ["rustfmt"]),
            ("membench", "membench", ["membench"]),
            ("bazel-lock", "bazel-lock", ["bazel-lock"])):
        r = plan_out(rows=rows)
        check(f"plan: rows={rows} runs its rows and the jobs they need, and no other",
              (r.get("rows"), json.loads(r.get("jobs", "null"))) if isinstance(r, dict) else r, (want_rows, want_jobs))
    r = plan_out(rows="set-root,gv-builtins-uid1000,windows")
    check("plan: the matrices hold only the selected rows' entries",
          (r.get("set"), r.get("gvisor"), r.get("platforms"), r.get("builtins")) if isinstance(r, dict) else r,
          (json.dumps(set_matrix()), json.dumps([m for m in gvisor_matrix() if m["part"] == "builtins"]), "windows", "[]"))
    # The control: the same rows under a workflow whose docs job needs a build that needs the tools.
    fake = os.path.join(d, "fake-workflow.yml")
    open(fake, "w").write("jobs:\n  plan: {}\n  tools:\n    needs: plan\n  build:\n    needs: [plan, tools]\n"
                          "  docs:\n    needs: [plan, build]\n  summary:\n    needs: [plan, tools, build, docs]\n")
    check("plan: the jobs come from the workflow's needs (a docs job that needs a build)",
          plan_rows(["docs"], workflow_jobs(fake))[1:], (["docs"], ["tools", "build", "docs"]))
    # A control must be in the run: a plant or a silent job of a row it does not run fails the plan.
    for rows, silent, plant, ok in (("changelog", "", "docs", False), ("docs", "", "docs", True),
                                    ("docs", "set-root-2", "", False), ("set-root", "set-root-2", "", True),
                                    ("windows", "macos-bash", "", False), ("macos", "macos-bash", "", True),
                                    ("docs", "platforms", "", False), ("windows", "platforms", "", True)):
        r = plan_out(rows=rows, silent=silent, plant=plant)
        check(f"plan: rows={rows} with silent={silent!r} plant={plant!r}",
              (r.get("silent"), r.get("plant")) if isinstance(r, dict) else "does not run" in r and repr(silent or plant) in r,
              (silent, plant) if ok else True)
    check("docs, changelog, rustfmt, membench, builtins-lint and bazel-lock are job names silent takes",
          {"docs", "changelog", "rustfmt", "membench", "builtins-lint", "bazel-lock"} <= set(all_job_names()), True)
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
    # The membench plant goes just after the line that makes the shell's kernel, at its indent; a file
    # with no such line stops the job (so the control cannot pass quietly).
    p = os.path.join(ptree, PLANTS["membench"][0])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write("impl Shell {\n\tpub fn create() {\n\t\tlet root = 1;\n\t\tlet mut k = Kernel::new(engine, root);\n\t\tk.rand = 2;\n\t}\n}\n")
    with contextlib.redirect_stdout(io.StringIO()):
        cmd_plant("membench", ptree)
    check("the membench plant", open(p).read().split("\n")[3:6],
          ["\t\tlet mut k = Kernel::new(engine, root);", "\t\t" + PLANTS["membench"][1], "\t\tk.rand = 2;"])
    open(p, "w").write("impl Shell {}\n")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            cmd_plant("membench", ptree)
        stopped_plant = None
    except SystemExit as e:
        stopped_plant = str(e.code)
    check("the membench plant with no place for it", stopped_plant,
          f"::error::{PLANTS['membench'][0]} has no place for the membench plant")
    # The builtins-lint plant: two consts at the end of pi-builtins' library root, after a blank line
    # and a blank line apart, so that rustfmt reads each as a place of its own.
    p = os.path.join(ptree, PLANTS["builtins-lint"][0])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write("//! pi-builtins\npub use a::b;")
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cmd_plant("builtins-lint", ptree)
    check("the builtins-lint plant", (open(p).read().split("\n"), buf.getvalue().splitlines()),
          (["//! pi-builtins", "pub use a::b;", "", BUILTINS_LINT_PLANT_LINES[0], "", BUILTINS_LINT_PLANT_LINES[1], ""],
           [f"PLANT builtins-lint: {PLANTS['builtins-lint'][0]}:4: {BUILTINS_LINT_PLANT_LINES[0]}",
            f"PLANT builtins-lint: {PLANTS['builtins-lint'][0]}:6: {BUILTINS_LINT_PLANT_LINES[1]}"]))
    # The bazel-lock plant: one line at the end of the root Cargo.toml, after a last line with no newline too.
    p = os.path.join(ptree, PLANTS["bazel-lock"][0])
    open(p, "w").write("[workspace]\nmembers = []")
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cmd_plant("bazel-lock", ptree)
    check("the bazel-lock plant", (open(p).read(), buf.getvalue()),
          (f"[workspace]\nmembers = []\n{PLANTS['bazel-lock'][1]}\n", f"PLANT bazel-lock: Cargo.toml:3: {PLANTS['bazel-lock'][1]}\n"))
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

    def summary2(drop=(), plant_env="", rows_env=None, known_path=None, rust_env="rust_test=success rust_test_macos=success"):
        """cmd_summary on res2; with rows_env, rust_env as SC_ROWS, SC_RUST_TESTS (None: unset). Its verdict line is in vfile."""
        for k in drop:
            os.remove(os.path.join(res2, k))
        if os.path.exists(vfile):
            os.remove(vfile)
        env = dict(SC_PLANT=plant_env, SC_VERDICT=vfile, SC_ROWS=rows_env, SC_RUST_TESTS=rust_env)
        kept_env = {k: os.environ.get(k) for k in env}
        for k, v in env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                rc2 = cmd_summary(res2, build2, known_path or known2)
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return rc2, buf.getvalue()

    vfile = os.path.join(d, "verdict.json")

    def verdict_record():
        return json.load(open(vfile)) if os.path.exists(vfile) else {}

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
    # A subset run: each row it did not run reads NOT RUN (never PASS, never absent), its top says it
    # covered a subset, and its verdict line names the rows that ran, those that did not, and the
    # verdict over the first.
    all_titles = ROWS + RUST_JOBS
    ran = ("docs", "changelog")
    rc, out = summary2(rows_env="docs,changelog", rust_env="rust_test=skipped rust_test_macos=skipped")
    check("summary: each row a subset run did not run reads NOT RUN",
          [k for t, k in all_titles if (f"| {t} | **NOT RUN** | - | - | - |" in out) == (k in ran)], [])
    check("summary: only the rows a subset run ran read PASS",
          [k for t, k in all_titles if f"| {t} | **PASS** |" in out], list(ran))
    check("summary: a subset run says so at its top, and passes over the rows it ran",
          (f"**A subset of the rows**: 2 of {len(ROW_KEYS)} rows ran (docs, changelog); the other {len(ROW_KEYS) - 2} read NOT RUN." in out, rc),
          (True, 0))
    rec = verdict_record()
    check("summary: a subset run's verdict line",
          (out.splitlines()[2:3] == [f"sami-checks verdict: `{json.dumps(rec, separators=(',', ':'))}`"],
           {k: rec.get(k) for k in ("verdict", "subset", "rows_run", "rows_not_run", "plant", "plant_caught")},
           rec.get("rows", {}).get("docs"), rec.get("rows", {}).get("set-runner"), rec.get("rows", {}).get("rust_test_macos")),
          (True, {"verdict": "PASS", "subset": True, "rows_run": list(ran), "rows_not_run": [k for k in ROW_KEYS if k not in ran],
                  "plant": None, "plant_caught": None}, "PASS", "NOT RUN", "NOT RUN"))
    rc, out = summary2(rust_env="rust_test=success rust_test_macos=success")
    rec = verdict_record()
    check("summary: a run of every row has no NOT RUN row and is no subset",
          ("NOT RUN" in out, "A subset of the rows" in out, rec.get("verdict"), rec.get("subset"), rec.get("rows_not_run"),
           rec.get("rows_run") == list(ROW_KEYS), list(rec.get("rows", {})) == list(ROW_KEYS), rc),
          (False, False, "PASS", False, [], True, True, 0))
    # The Rust rows without their jobs' conclusions: each selected one reads UNKNOWN, never absent.
    rc, out = summary2(rows_env="rust_test,rust_test_macos", rust_env=None)
    rec = verdict_record()
    check("summary: a selected Rust row with no conclusion reads UNKNOWN",
          (rec.get("verdict"), rec.get("rows_run"), {k: rec.get("rows", {}).get(k) for k in ("rust_test", "rust_test_macos")}, rc),
          ("UNKNOWN", ["rust_test", "rust_test_macos"], {"rust_test": "UNKNOWN", "rust_test_macos": "UNKNOWN"}, 2))
    rc, out = summary2(rust_env=None)
    rec = verdict_record()
    check("summary: a run of every row with no Rust conclusion is UNKNOWN, each row named",
          (rec.get("verdict"), list(rec.get("rows", {})) == list(ROW_KEYS), rc), ("UNKNOWN", True, 2))
    rc, out = summary2(rows_env="docs", plant_env="docs")
    rec = verdict_record()
    check("summary: a planted subset run fails, and its verdict line says whether the control caught the plant",
          tuple(rec.get(k) for k in ("verdict", "subset", "rows_run", "plant", "plant_caught")) + (rc,),
          ("FAIL", True, ["docs"], "docs", False, 1))
    # A known-failure entry of a row the run did not run is not listed for removal: its unit did not report.
    set_unit = next(e for e in expected_units(build2)[0] if e[0] == "set-runner")
    known3 = os.path.join(d, "known3.txt")
    open(known3, "w").write(f"set-runner\trunner\t{set_unit[1]}\tno::such_test\tgone from the tree\n")
    rc, out = summary2(known_path=known3)
    check("summary: a known entry whose test is gone is listed (the control)", ("`no::such_test`: no longer in its unit" in out, rc), (True, 1))
    rc, out = summary2(known_path=known3, rows_env="docs,changelog")
    check("summary: a known entry of a row the run did not run is not listed", ("no::such_test" in out, rc), (False, 0))
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
    # The rustfmt plant: each workspace's unit must name it, and the summary names its place in words.
    fmt_files = {json.load(open(os.path.join(res2, f)))["unit"]: f for f in os.listdir(res2)
                 if json.load(open(os.path.join(res2, f)))["row"] == "rustfmt"}
    check("the rustfmt row's units", sorted(fmt_files), sorted(fmt_ws))
    planted_fmt = "crates/pi-ast/src/lib.rs:90: fn sc_rustfmt_plant(){}"
    for u, f in fmt_files.items():
        json.dump(result("rustfmt", u, "runner", "FAIL", "1", 1, 0, 1, failures=[planted_fmt]), open(os.path.join(res2, f), "w"))
    rc, out = summary2(rows_env="rustfmt", plant_env="rustfmt")
    check("summary: a planted rustfmt run that each workspace names",
          ("added `` fn sc_rustfmt_plant(){} `` to the first target root of each cargo workspace the row checks before it ran. "
           "The control caught it" in out, rc), (True, 1))
    json.dump(result("rustfmt", fmt_ws[-1], "runner", "PASS", "0", 1, 2), open(os.path.join(res2, fmt_files[fmt_ws[-1]]), "w"))
    rc, out = summary2(rows_env="rustfmt", plant_env="rustfmt")
    check("summary: a planted rustfmt run that one workspace does not name",
          (f"**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `sc_rustfmt_plant`: `{fmt_ws[-1]}`." in out,
           rc), (True, 1))
    for u, f in fmt_files.items():
        json.dump(result("rustfmt", u, "runner", "PASS", "0", 1, 2), open(os.path.join(res2, f), "w"))
    # A workspace whose every place is upstream's own reads KNOWN, the row too, and each place is listed.
    upstream_place = "sdk/rust/omp-rpc/src/client.rs:479: // Host tool and URI frames were consumed above; only malformed ones get here."
    json.dump(dict(result("rustfmt", fmt_ws[-1], "runner", "KNOWN", "1", 1, 0, 0), upstream_places=[upstream_place],
                   upstream_base="9058ab9d229663e229e2867824ba6df6f21e9e59"), open(os.path.join(res2, fmt_files[fmt_ws[-1]]), "w"))
    rc, out = summary2(rows_env="rustfmt")
    check("summary: upstream's own rustfmt places read KNOWN, each listed with the base",
          (f"| rustfmt: cargo fmt --check, per cargo workspace | **KNOWN** | {len(fmt_ws) - 1} / 1 / 0 / 0 |" in out,
           f"`{fmt_ws[-1]}` (runner): KNOWN `{upstream_place}`: upstream's own: the same run fails at the upstream base `9058ab9d2296` "
           "on lines the fork left as they are"
           in out, rc), (True, True, 0))
    json.dump(result("rustfmt", fmt_ws[-1], "runner", "PASS", "0", 1, 2), open(os.path.join(res2, fmt_files[fmt_ws[-1]]), "w"))
    # The builtins-lint row: a planted run must find each unit FAIL naming its own plant; a unit that
    # counts its findings lists the first of each kind among the details, and counts them all by lint
    # and by file in a section of its own.
    bl_files = {json.load(open(os.path.join(res2, f)))["unit"]: f for f in os.listdir(res2)
                if json.load(open(os.path.join(res2, f)))["row"] == "builtins-lint"}
    check("the builtins-lint row's units", sorted(bl_files), sorted(BUILTINS_LINT_UNITS))
    bl_title = next(t for t, k in ROWS if k == "builtins-lint")
    rsync_a, lib_rs = "crates/pi-builtins/src/rsync/a.rs", "crates/pi-builtins/src/lib.rs"
    many = [f"{rsync_a}:{i}:1: clippy::doc_markdown: item in documentation is missing backticks" for i in range(1, 31)]
    clip_planted = f"{lib_rs}:256:43: clippy::redundant_static_lifetimes: constants have by default a 'static lifetime ({BUILTINS_LINT_PLANT_LINES[0]})"
    fmt_planted = f"{lib_rs}:258: {BUILTINS_LINT_PLANT_LINES[1]}"

    def bl_result(unit, failures, known=(), mine_keys=(), known_keys=()):
        return dict(result("builtins-lint", unit, "runner", "FAIL" if failures else "KNOWN", "0", 1, 0, len(failures), failures=failures,
                           note=f"{len(failures)} a fork change's, {len(known)} upstream's own"),
                    upstream_places=list(known), unsorted_places=[], upstream_base=bsha, breakdown=lint_breakdown(list(mine_keys), list(known_keys), []))

    json.dump(bl_result("clippy", many + [clip_planted], ["k1", "k2"], [(rsync_a, "clippy::doc_markdown")] * 30
                        + [(lib_rs, "clippy::redundant_static_lifetimes")], [("crates/pi-builtins/src/cp.rs", "clippy::x")] * 2),
              open(os.path.join(res2, bl_files["clippy"]), "w"))
    json.dump(bl_result("rustfmt", [fmt_planted], (), [(lib_rs, None)]), open(os.path.join(res2, bl_files["rustfmt"]), "w"))
    rc, out = summary2(rows_env="builtins-lint", plant_env="builtins-lint")
    check("summary: a planted builtins-lint run that each unit names (the clippy unit past its listed failures)",
          (f"The control caught it: the row reads FAIL, and each of its units (`clippy`, `rustfmt`) names `{BUILTINS_LINT_PLANT}`." in out,
           out.count(f"(runner): FAILED `{rsync_a}:"), "`clippy` (runner): and 6 more FAILED (the section below" in out,
           f"### {bl_title}: `clippy` read FAIL" in out, "| `clippy::doc_markdown` | 30 | 0 | 0 |" in out,
           "| `crates/pi-builtins/src/cp.rs` | 0 | 2 | 0 |" in out, f"| `{lib_rs}` | 1 | 0 | 0 |" in out, rc),
          (True, LISTED_PER_KIND, True, True, True, True, True, 1))
    json.dump(bl_result("rustfmt", [f"{lib_rs}:12: fn x(){{}}"], (), [(lib_rs, None)]), open(os.path.join(res2, bl_files["rustfmt"]), "w"))
    rc, out = summary2(rows_env="builtins-lint", plant_env="builtins-lint")
    check("summary: a planted builtins-lint run whose rustfmt unit does not name the plant",
          (f"**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `{BUILTINS_LINT_PLANT}`: `rustfmt`." in out, rc),
          (True, 1))
    json.dump(bl_result("clippy", [], ["k1"], (), [("crates/pi-builtins/src/cp.rs", "clippy::x")]), open(os.path.join(res2, bl_files["clippy"]), "w"))
    json.dump(dict(result("builtins-lint", "rustfmt", "runner", "PASS", "0", 1, 1), upstream_places=[], unsorted_places=[], upstream_base=""),
              open(os.path.join(res2, bl_files["rustfmt"]), "w"))
    rc, out = summary2(rows_env="builtins-lint")
    check("summary: a builtins-lint row whose findings are each upstream's own reads KNOWN",
          (f"| {bl_title} | **KNOWN** | 1 / 1 / 0 / 0 |" in out, rc), (True, 0))
    for u, f in bl_files.items():
        json.dump(result("builtins-lint", u, "runner", "PASS", "0", 1, 1), open(os.path.join(res2, f), "w"))
    # The clippy row: a crate that did not lint every unit names each one UNKNOWN beside the finding
    # it read; one whose every failure is known reads UNKNOWN, not KNOWN, beside a unit not linted.
    clippy_title = next(t for t, k in ROWS if k == "clippy")
    vfs_file = next(f for f in os.listdir(res2) if f.endswith(".json")
                    and (json.load(open(os.path.join(res2, f)))["row"], json.load(open(os.path.join(res2, f)))["unit"]) == ("clippy", "pi-vfs"))
    json.dump(lib_stopped, open(os.path.join(res2, vfs_file), "w"))
    rc, out = summary2(rows_env="clippy")
    check("summary: a clippy crate whose lib stopped names its finding FAILED and each unit it did not lint UNKNOWN",
          (f"| {clippy_title} | **FAIL** | 5 / 0 / 1 / 0 |" in out,
           f"`pi-vfs` (runner): FAILED `crates/pi-vfs/src/lib.rs:12: clippy::too_long_first_doc_paragraph: {long_doc}`" in out,
           f'`pi-vfs` (runner): UNKNOWN: 3 unit(s) not linted, so their findings are not known: {skipped}: `bin "vb" test`, '
           '`test "ta"`, `test "tb"`' in out, "fewer here than in the clippy baseline" in out, rc), (True, True, True, False, 1))
    known_c = write("known-clippy.txt", f"clippy\trunner\tpi-vfs\tcrates/pi-vfs/src/lib.rs:12: clippy::too_long_first_doc_paragraph: "
                                        f"{long_doc}\tbeing fixed\n")
    rc, out = summary2(rows_env="clippy", known_path=known_c)
    check("summary: a clippy crate whose every failure is known reads UNKNOWN beside units it did not lint",
          (f"| {clippy_title} | **UNKNOWN** | 5 / 0 / 0 / 1 |" in out,
           "`pi-vfs` (runner): UNKNOWN: every failure is known, but 3 unit(s) of the crate were not linted, each named below" in out),
          (True, True))
    json.dump(result("clippy", "pi-vfs", "runner", "PASS", "0", 1, 1), open(os.path.join(res2, vfs_file), "w"))
    # The memory bench: a planted run names the shell line, and the summary lists every line it printed.
    mb_file = next(f for f in os.listdir(res2) if json.load(open(os.path.join(res2, f)))["row"] == "membench")
    planted_mb = mb([shell_miss, vproc_ok] + others, 0)
    json.dump(dict(result("membench", MEMBENCH_UNIT, "runner", "FAIL", "0", 61, 1, 1, failures=planted_mb[1], note=planted_mb[2]),
                   bench_lines=[line.replace("`", "'") for line in [shell_miss, vproc_ok] + others]),
              open(os.path.join(res2, mb_file), "w"))
    rc, out = summary2(rows_env="membench", plant_env="membench")
    check("summary: a planted membench run whose shell line reads MISS",
          (f"added `` {PLANTS['membench'][1]} `` to `{PLANTS['membench'][0]}` before it ran. The control caught it: the row reads "
           f"FAIL, and each of its units (`{MEMBENCH_UNIT}`) names `memory shell:`." in out,
           f"### pi-shell memory bench, release (benches/memory.rs: its PASS/MISS targets): `{MEMBENCH_UNIT}` read FAIL, exit 0" in out,
           "1 of 2 target(s) PASS, 1 MISS; exit 0" in out,
           "- `memory sizes: Vproc 512 B, Frame 128 B`" in out, rc), (True, True, True, True, 1))
    vproc_miss = vproc_ok.replace("PASS", "MISS")
    json.dump(dict(result("membench", MEMBENCH_UNIT, "runner", "FAIL", "0", 61, 1, 1, failures=[vproc_miss]), bench_lines=[]),
              open(os.path.join(res2, mb_file), "w"))
    rc, out = summary2(rows_env="membench", plant_env="membench")
    check("summary: a planted membench run whose MISS is not the shell line",
          (f"**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `memory shell:`: `{MEMBENCH_UNIT}`." in out,
           rc), (True, 1))
    # The job uploads cargo's message stream beside the result: as .jsonl the summary does not read it
    # as a unit's result (as .json, one message is a dict with no row, and the summary stops).
    mb_logs = os.path.join(res2, "logs")
    os.makedirs(mb_logs, exist_ok=True)
    cargo_msg = json.dumps({"reason": "build-finished", "success": False}) + "\n"
    json.dump(dict(pr, bench_lines=pr["bench_lines"]), open(os.path.join(res2, mb_file), "w"))
    open(os.path.join(mb_logs, "membench-build.jsonl"), "w").write(cargo_msg)
    rc, out = summary2(rows_env="membench")
    check("summary: cargo's stream uploaded as .jsonl, and the bench's stderr listed",
          ("| pi-shell memory bench, release (benches/memory.rs: its PASS/MISS targets) | **FAIL** |" in out,
           "Its stderr:" in out, "- `  left: 271`" in out, "- `assertion 'left == right' failed: every idle vproc holds its task`" in out),
          (True, True, True, True))
    os.rename(os.path.join(mb_logs, "membench-build.jsonl"), os.path.join(mb_logs, "membench-build.json"))
    try:
        summary2(rows_env="membench")
        as_json = "read"
    except (KeyError, TypeError) as e:
        as_json = type(e).__name__
    check("summary: the same stream as .json is read as a result (why the job names it .jsonl)", as_json, "KeyError")
    shutil.rmtree(mb_logs)
    json.dump(result("membench", MEMBENCH_UNIT, "runner", "PASS", "0", 1, 2), open(os.path.join(res2, mb_file), "w"))
    # The bazel-lock row: a planted run must find its one unit FAIL naming the planted Cargo.toml; a FAIL
    # that names only other files (a tree already stale elsewhere) is a control that failed.
    blk = next(f for f in os.listdir(res2) if json.load(open(os.path.join(res2, f)))["row"] == "bazel-lock")
    blk_title = next(t for t, k in ROWS if k == "bazel-lock")
    planted_lock = f"@@//Cargo.toml: the lock records sha256 {a64[:12]}, the file is {b64[:12]}; Bazel names it"
    json.dump(result("bazel-lock", BAZEL_LOCK_UNIT, "runner", "FAIL", "8", 9, 18, 1, failures=[planted_lock]),
              open(os.path.join(res2, blk), "w"))
    rc, out = summary2(rows_env="bazel-lock", plant_env="bazel-lock")
    check("summary: a planted bazel-lock run whose unit names the planted Cargo.toml",
          (f"added `` {PLANTS['bazel-lock'][1]} `` to `Cargo.toml` before it ran. The control caught it: the row reads FAIL, and "
           f"each of its units (`{BAZEL_LOCK_UNIT}`) names `@@//Cargo.toml:`." in out,
           f"| {blk_title} | **FAIL** | 0 / 0 / 1 / 0 |" in out, f"`{BAZEL_LOCK_UNIT}` (runner): FAILED `{planted_lock}`" in out, rc),
          (True, True, True, 1))
    json.dump(result("bazel-lock", BAZEL_LOCK_UNIT, "runner", "FAIL", "8", 9, 17, 2,
                     failures=[f"@@//Cargo.lock: the lock records sha256 {a64[:12]}, the file is {b64[:12]}; Bazel names it",
                               f"@@//crates/pi-shell/Cargo.toml: the lock records sha256 {a64[:12]}, the file is {c64[:12]}"]),
              open(os.path.join(res2, blk), "w"))
    rc, out = summary2(rows_env="bazel-lock", plant_env="bazel-lock")
    check("summary: a planted bazel-lock run whose failures name other Cargo files only",
          (f"**THE CONTROL FAILED**: the row reads FAIL, and these units do not read FAIL naming `@@//Cargo.toml:`: "
           f"`{BAZEL_LOCK_UNIT}`." in out, rc), (True, 1))
    json.dump(result("bazel-lock", BAZEL_LOCK_UNIT, "runner", "PASS", "0", 1, 19), open(os.path.join(res2, blk), "w"))
    rc, out = summary2(drop=[f for f in docs_i.values() if os.path.exists(os.path.join(res2, f))] + log_i)
    check("summary: no docs or changelog result", ("| rustdoc intra-doc links (pi-shell) | **UNKNOWN** | 0 / 0 / 0 / 2 |" in out,
          "| CHANGELOG format (fix-changelogs --check) | **UNKNOWN** | 0 / 0 / 0 / 1 |" in out,
          "`public` (runner): UNKNOWN: no result" in out, "`private` (runner): UNKNOWN: no result" in out,
          "`changelogs` (runner): UNKNOWN: no result" in out, rc), (True, True, True, True, True, 2))
    # A row reads the same in a run of that row alone as in a run of every row of the same commit. The
    # summary step is run as the workflow runs it, on the results the planned rows' jobs upload: each
    # row's unit results, the passing tests' output of each row that has some (TEST_OUTPUT_ROWS), and
    # the skip prints row's run-time unit (sc.py skip-lines) computed on what is there. Among the rows:
    # a failed set unit, an UNKNOWN workspace unit, the docs and changelog rows with no result, and a
    # failed Rust job, beside passing rows. Each row's subset is what the plan runs for it.
    for i, f in enumerate(sorted(os.listdir(res2))):
        r = json.load(open(os.path.join(res2, f)))
        if r["row"] == "set-runner" and i % 2 == 0:
            json.dump(dict(r, status="FAIL", failed=1, failures=["x::y"]), open(os.path.join(res2, f), "w"))
        elif r["row"] == "workspace":
            json.dump(dict(r, status="UNKNOWN", note="the time bound ended it"), open(os.path.join(res2, f), "w"))
        elif (r["row"], r["unit"]) == ("skipforms", "runtime"):
            os.remove(os.path.join(res2, f))
    # A test that skipped itself as one user and passed as the other, on the same runtime: covered, so
    # its unit passes, but only where the other user's row ran too.
    for skipper, passer in (("set-runner", "set-root"), ("lib4", "set-root"), ("gv-set-uid1000", "gv-set-root"),
                            ("gv-lib4-root", "gv-set-uid1000"), ("gv-builtins-uid1000", "gv-builtins-root")):
        rs = {f: json.load(open(os.path.join(res2, f))) for f in sorted(os.listdir(res2))}
        f, r = next((f, r) for f, r in rs.items() if r["row"] == skipper and r["status"] == "PASS")
        name = f"cover::{skipper}"
        json.dump(dict(r, status="UNKNOWN", skip_only=True, self_skipped=[name], tests=[[name, 1.0]]),
                  open(os.path.join(res2, f), "w"))
        g, s = next((g, s) for g, s in rs.items() if s["row"] == passer and s["unit"] == r["unit"])
        json.dump(dict(s, tests=s["tests"] + [[name, 1.0]]), open(os.path.join(res2, g), "w"))
    outputs = os.path.join(d, "outputs")
    for k in TEST_OUTPUT_ROWS:
        os.makedirs(os.path.join(outputs, k))
        open(os.path.join(outputs, k, "t.junit.xml"), "w").write(
            f'<testsuites><testsuite name="{k}"><testcase classname="{k}" name="t" time="1"/></testsuite></testsuites>')
    no_exceptions = os.path.join(d, "no-exceptions.txt")
    open(no_exceptions, "w").write("# none\n")
    title_of = {k: t for t, k in ROWS + RUST_JOBS}

    def step(rows):
        """(each row's verdict, each row's table line) in the summary step of a run of these rows."""
        sub = os.path.join(d, "step")
        shutil.rmtree(sub, ignore_errors=True)
        os.makedirs(os.path.join(sub, "sc-skip-lines"))
        for f in os.listdir(res2):
            if json.load(open(os.path.join(res2, f)))["row"] in rows:
                shutil.copy(os.path.join(res2, f), sub)
        for k in TEST_OUTPUT_ROWS:
            if k in rows:
                shutil.copytree(os.path.join(outputs, k), os.path.join(sub, "out-" + k))
        json.dump(cmd_skip_lines(sub, no_exceptions), open(os.path.join(sub, "sc-skip-lines", "skip-lines.json"), "w"))
        env = dict(SC_PLANT="", SC_VERDICT=vfile, SC_ROWS=",".join(rows), SC_RUST_TESTS="rust_test=failure rust_test_macos=success")
        kept_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        if os.path.exists(vfile):
            os.remove(vfile)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                cmd_summary(sub, build2, known2)
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        got = verdict_record().get("rows", {})
        lines = {k: ln for ln in buf.getvalue().splitlines() for k, t in title_of.items() if ln.startswith(f"| {t} | **")}
        return {r: got.get(r) for r in rows}, {r: lines.get(r) for r in rows}

    full_v, full_l = step(list(ROW_KEYS))
    differ = []
    for k in ROW_KEYS:
        sub_rows = plan_rows([k], wf)[1]
        v, ln = step(sub_rows)
        differ += [f"rows={k}: {r} reads {v[r]} alone, {full_v[r]} in the full run" for r in sub_rows
                   if v[r] != full_v[r] or ln[r] != full_l[r]]
    check("summary: each row reads the same alone as in a run of every row", (differ, sorted(set(full_v.values()))),
          ([], ["FAIL", "PASS", "UNKNOWN"]))
    check("summary: the skip prints row's run-time unit read every test row's output in the full run",
          full_v.get("skipforms"), "PASS")
    # First seen at this cut: the summary against the previous cut's report (SC_PREVIOUS, the
    # directory sc.py previous-report fills). res3 holds every unit the plan expects; this cut fails
    # on a new finding (the docs plant's link), on a test that passed at the previous cut, on a kind of
    # CHANGELOG rewrite new to a file that needed another there, on one more of a rewrite a file needed
    # there, on a memory bench panic with another assertion, and on findings the previous cut had too:
    # a set test that failed there, a docs link and a clippy finding at another line, a coding-agent
    # test that failed in another shard there, and a platform test that failed there and timed out
    # here. The pi-builtins lint row has no result at the previous cut (a row new at this cut), and
    # rust_test failed here and passed there. Only the plant, the test that passed, the two CHANGELOG
    # findings, the other panic, the lint unit and the Rust row are first seen.
    res3, prev3, known3 = os.path.join(d, "res3"), os.path.join(d, "prev3"), os.path.join(d, "known3.txt")
    os.makedirs(res3)
    open(known3, "w").write("# none\n")
    units3 = expected_units(build2)[0]
    at3 = {u: os.path.join(res3, f"{i}.json") for i, u in enumerate(units3)}
    set3 = next(u for u in units3 if u[0] == "set-runner")
    ca3 = [u for u in units3 if u[0] == "ts-ca"]
    docs3, docs3p = ("docs", "public", "runner"), ("docs", "private", "runner")
    link = "crates/pi-shell/src/{}.rs:{}:{}: unresolved link to '{}' (no item named '{}' in scope)"
    planted3 = link.format("lib", 36, 1, "NoSuchItemPlanted", "NoSuchItemPlanted")
    log3 = "packages/x/CHANGELOG.md: 0 promoted item(s), {} collapsed release(s); from line {}: -## [1.0.0]"
    clog3 = ("packages/y/CHANGELOG.md: 0 promoted item(s), 0 merged duplicate heading(s), 0 dropped released duplicate(s), "
             "{} removed empty heading(s), 3 collapsed release(s); from line 7: -### Planted empty heading")
    panic3 = "exit 101: thread 'main' panicked at crates/pi-shell/benches/memory.rs:{}:2: assertion failed: {}"
    bench3 = ("membench", MEMBENCH_UNIT, "runner")
    lint3 = "crates/pi-vfs/src/lib.rs:{}:{}: clippy::needless_return: unneeded 'return' statement"
    here3 = {set3: ["standing::t", "newly::t"], docs3: [planted3, link.format("a", 3372, 8, "Job::facts", "Job")],
             ca3[0]: ["moved::t"], ("changelog", "changelogs", "runner"): [log3.format(29, 1713), clog3.format(1)],
             bench3: [panic3.format(251, "every idle vproc frees its frame")],
             ("macos", PLATFORM_CRATES, "runner"): ["pi-shell::slow::t (TIMEOUT)"], ("clippy", "pi-vfs", "runner"): [lint3.format(12, 5)],
             ("builtins-lint", "clippy", "runner"): ["crates/pi-builtins/src/a.rs:1:1: clippy::x: y", "crates/pi-builtins/src/a.rs:2:1: clippy::x: y"]}
    there3 = {set3: ["standing::t"], docs3: [link.format("a", 3370, 8, "Job::facts", "Job")], ca3[1]: ["moved::t"],
              ("changelog", "changelogs", "runner"): [log3.format(28, 1719), clog3.format(0)], ("macos", PLATFORM_CRATES, "runner"): ["pi-shell::slow::t"],
              ("clippy", "pi-vfs", "runner"): [lint3.format(10, 9)], bench3: [panic3.format(249, "the shell stays under its bound")]}

    def unit3(u, failures, passed=("t",)):
        return result(*u, "FAIL" if failures else "PASS", 1 if failures else 0, 1, passed=len(passed), failed=len(failures),
                      failures=failures, tests=[(t, 1.0) for t in list(passed) + list(failures)])

    for u in units3:
        json.dump(unit3(u, here3.get(u, [])), open(at3[u], "w"))
    prev_units3 = [unit3(u, there3.get(u, []), ("t", "newly::t") if u == set3 else ("t",)) for u in units3 if u[0] != "builtins-lint"]
    prev_rows3 = {"rust_test": "PASS", "rust_test_macos": "PASS"}
    from3 = "run 1 (a hand-made previous cut), of aaaaaaaaaaaa"

    def previous3(results=None, raw=None, rows=prev_rows3, about=None):
        """A previous cut's report in prev3: results.json (RESULTS, or the text RAW), verdict.json's rows, about.json."""
        shutil.rmtree(prev3, ignore_errors=True)
        os.makedirs(prev3)
        if raw is not None:
            open(os.path.join(prev3, "results.json"), "w").write(raw)
        elif results is not None:
            json.dump(results, open(os.path.join(prev3, "results.json"), "w"))
        if rows is not None:
            json.dump({"rows": rows}, open(os.path.join(prev3, "verdict.json"), "w"))
        if about is not None:
            json.dump(about, open(os.path.join(prev3, "about.json"), "w"))
        return prev3

    def summary3(previous, plant_env="", rows_env=None, rust_env="rust_test=failure rust_test_macos=success"):
        """cmd_summary on res3 against PREVIOUS (SC_PREVIOUS; None: unset): (its summary, its verdict record)."""
        env = dict(SC_PLANT=plant_env, SC_VERDICT=vfile, SC_ROWS=rows_env, SC_RUST_TESTS=rust_env, SC_PREVIOUS=previous)
        kept_env = {k: os.environ.get(k) for k in env}
        for k, v in env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if os.path.exists(vfile):
            os.remove(vfile)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                cmd_summary(res3, build2, known3)
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return buf.getvalue(), verdict_record()

    def seen3(rec):
        s = rec.get("first_seen")
        return [(e["kind"], e["row"], e["unit"], e["finding"], e["reading"], e["previous"]) for e in s] if isinstance(s, list) else s

    plant_entry = ("failure", "docs", "public", planted3, "NEW", "its unit did not have it at the previous cut")
    want3 = [("failure", "set-runner", set3[1], "newly::t", "NEW", "it passed at the previous cut"), plant_entry,
             ("failure", "changelog", "changelogs", log3.format(29, 1713), "NEW",
              "the previous cut counted 28 collapsed release(s) in it, this cut 29"),
             ("failure", "changelog", "changelogs", clog3.format(1), "NEW", "its unit did not have it at the previous cut"),
             ("failure", "membench", MEMBENCH_UNIT, panic3.format(251, "every idle vproc frees its frame"), "NEW",
              "its unit did not have it at the previous cut"),
             ("unit", "builtins-lint", "clippy", "2 failure(s)", None, "the previous cut's report has no result for its unit"),
             ("row", "rust_test", None, "the row reads FAIL", None, "it read PASS at the previous cut, and no unit of it "
              "could be read here, so its findings were not compared")]
    out, rec = summary3(previous3(prev_units3, about={"from": from3, "why": None}))
    check("first seen: a new finding (the plant's link) is in first_seen",
          (isinstance(seen3(rec), list), plant_entry in (seen3(rec) if isinstance(seen3(rec), list) else [])), (True, True))
    check("first seen: a finding at both cuts is not (a set test that failed at both, a docs link and a clippy finding at "
          "another line, a coding-agent test in another shard, a platform test that timed out here): first_seen is the new "
          "finding, the test that passed there, the new kind and the one more of a CHANGELOG rewrite, the other panic, the "
          "unit with no result there and the Rust row that passed there",
          (seen3(rec), rec.get("first_seen_why"), rec.get("first_seen_against")),
          (want3, None, from3))
    head = out.find(f"### First seen at this cut: 7, against {from3}")
    check("first seen: the summary lists them first, before the table and the standing failures",
          (head > 0, head < out.find("| Row | Verdict |"), head < out.find("### Each failing test"),
           f"FAILED `{planted3}`: **NEW**; its unit did not have it at the previous cut" in out[head:out.find("| Row | Verdict |")],
           f"FAILED `{planted3}`: **NEW**; **first seen at this cut** (its unit did not have it at the previous cut)" in out,
           "FAILED `standing::t`: **NEW**\n" in out),
          (True, True, True, True, True, True))
    check("first seen: a unit with no result at the previous cut names its failures",
          [(e["failed"], e["failures"]) for e in rec.get("first_seen", []) if e["kind"] == "unit"] if isinstance(rec.get("first_seen"), list) else None,
          [(2, here3[("builtins-lint", "clippy", "runner")])])
    # What a finding is across cuts (finding_keys): what moves is taken out, what tells two apart is kept.
    check("finding_keys: the same finding at two cuts",
          [set(finding_keys(row, a)) == set(finding_keys(row, b)) for row, a, b in (
              ("clippy", "crates/x/src/a.rs:12: clippy::m: n (3 here, 1 in the baseline)", "crates/x/src/a.rs:40: clippy::m: n (2 here, 1 in the baseline)"),
              ("docs", "crates/x/src/a.rs:12:5: unresolved link to 'A'", "crates/x/src/a.rs:19:9: unresolved link to 'A'"),
              ("changelog", log3.format(28, 1719), log3.format(29, 1713)),
              ("membench", "memory shell: 4194 bytes after create + ':' (target ≤ 4096) MISS",
               "memory shell: 5000 bytes after create + ':' (target ≤ 4096) MISS"),
              ("membench", panic3.format(249, "state_bytes <= 256"), panic3.format(251, "state_bytes <= 256")),
              ("checkts", "check:ts: exit 2: a.ts(3,5): error TS2322: Type 'x' / Found 1 error.",
               "check:ts: exit 2: a.ts(9,5): error TS2322: Type 'x' / Found 1 error."),
              ("skipforms", "a skip print the summary does not read: crates/a.rs:3: 'skipped x'", "a skip print the summary does not read: crates/a.rs:9: 'skipped x'"),
              ("skipforms", "a skip line the summary does not read: 'skipped x', printed 2 time(s), first by r t",
               "a skip line the summary does not read: 'skipped x', printed 5 time(s), first by r u"),
              ("macos", "pi-shell::a::b (TIMEOUT)", "pi-shell::a::b"),
              ("rust_test", "Rust tests: //crates/a:a_test b passed 7 tests, and .github/sami/rust-test-root-targets.txt names 8",
               "Rust tests: //crates/a:a_test b passed 9 tests, and .github/sami/rust-test-root-targets.txt names 10"),
              ("rust_test", "Rust test printed: crates/a/src/lib.rs:3: a doctest rustdoc runs prints (println!)",
               "Rust test printed: crates/a/src/lib.rs:90: a doctest rustdoc runs prints (println!)"),
              ("rust_test", "Rust tests: //crates/a:a_test wrote 3 lines outside libtest's record that x does not name "
               "(a skip in other words?), the first: hello",
               "Rust tests: //crates/a:a_test wrote 5 lines outside libtest's record that x does not name "
               "(a skip in other words?), the first: goodbye"))],
          [True] * 12)
    check("finding_keys: two findings stay two",
          [set(finding_keys(row, a)) == set(finding_keys(row, b)) for row, a, b in (
              ("docs", "crates/x/src/a.rs:12:5: unresolved link to 'A'", "crates/x/src/b.rs:12:5: unresolved link to 'A'"),
              ("builtins-lint", "crates/b/src/a.rs:1:1: clippy::x: y (fn a() {)", "crates/b/src/a.rs:1:1: clippy::x: y (fn b() {)"),
              ("changelog", clog3.format(0), clog3.format(1)),
              ("membench", panic3.format(249, "the shell stays under its bound"), panic3.format(249, "every idle vproc frees its frame")),
              ("membench", panic3.format(249, "state_bytes <= 256"), panic3.format(251, "state_bytes <= 128")),
              ("membench", "exit 101: x", "exit 134: x"),
              ("checkts", "check:ts: exit 2: a.ts(3,5): error TS2322: Type 'x'", "check:ts: exit 2: a.ts(3,5): error TS2345: Type 'x'"),
              ("set-runner", "a::b_1", "a::b_2"),
              ("rust_test", "Rust tests: //crates/a:a_test b_1 failed and is not in x", "Rust tests: //crates/a:a_test b_2 failed and is not in x"),
              ("rust_test", "Rust tests: //crates/a:a_test b failed and is not in x", "Rust test skips: //crates/a:a_test b failed and is not in x"),
              ("rust_test", "Rust tests: //crates/a:a_test b failed and is not in x", "Rust tests: //crates/b:b_test b failed and is not in x"))],
          [False] * 11)
    # check:ts's one failure holds every type error of its last lines: another error among them is
    # first seen, and the same errors at other places are standing.
    check("finding_keys: check:ts names each type error of its last lines",
          (finding_keys("checkts", "check:ts: exit 2: a.ts(3,5): error TS2322: Type 'x' / b.ts(9,1): error TS2345: Type 'y' / Found 2 errors."),
           set(finding_keys("checkts", "check:ts: exit 2: a.ts(3,5): error TS2322: Type 'x' / Found 1 error."))
           < set(finding_keys("checkts", "check:ts: exit 2: a.ts(4,5): error TS2322: Type 'x' / c.ts(1,1): error TS2300: Type 'z' / Found 2 errors."))),
          ({"a.ts: error TS2322: Type 'x'": 1, "b.ts: error TS2345: Type 'y'": 1}, True))
    check("finding_keys: a CHANGELOG counts each kind of rewrite it needs",
          finding_keys("changelog", clog3.format(2)), {"packages/y/CHANGELOG.md: removed empty heading(s)": 2,
                                                       "packages/y/CHANGELOG.md: collapsed release(s)": 3})
    # A previous report that could not be read is UNKNOWN, naming why, never an empty first_seen: none
    # named, its results.json missing, one that does not parse, one that holds no result or no unit
    # results, and the fetch step's own reason (about.json).
    for label, prev, why in (
            ("no previous report named", lambda: None, "no previous report was given to the summary (SC_PREVIOUS is not set)"),
            ("a missing previous report", previous3, f"its results.json is not there ({prev3}/results.json); no about.json says why"),
            ("a previous report that does not parse", lambda: previous3(raw='[{"row": "set-runner", '),
             "its results.json does not parse (JSONDecodeError: "),
            ("a previous report that holds no result", lambda: previous3(raw="[]"),
             "its results.json holds no unit result, so there is nothing to compare with"),
            ("a previous report that holds no unit results", lambda: previous3(raw='[{"row": "set-runner"}]'),
             "its results.json is not a list of unit results: entry 0 has no unit, who, status, failures, tests"),
            ("a previous report the fetch step could not get",
             lambda: previous3(prev_units3, about={"from": "run 7", "why": "run 7's sc-report expired"}), "run 7's sc-report expired")):
        out, rec = summary3(prev())
        check(f"first seen: {label} reads UNKNOWN, naming why",
              (rec.get("first_seen"), (rec.get("first_seen_why") or "").startswith(why), rec.get("first_seen_why"),
               "### First seen at this cut: UNKNOWN\n" in out, "**first seen at this cut**" in out),
              ("UNKNOWN", True, rec.get("first_seen_why"), True, False))
    # A planted run's plant must read first seen (plant_first_seen): the comparison's own control,
    # which fails when the previous cut had the plant too.
    json.dump(unit3(docs3p, [planted3]), open(at3[docs3p], "w"))
    out, rec = summary3(previous3(prev_units3), plant_env="docs", rows_env="docs")
    check("first seen: a planted run's plant reads first seen in each unit of its row",
          (rec.get("plant_caught"), rec.get("plant_first_seen"), "the comparison's control caught it" in out), (True, True, True))
    out, rec = summary3(previous3([dict(r, failures=[planted3]) if r["row"] == "docs" else r for r in prev_units3]),
                        plant_env="docs", rows_env="docs")
    check("first seen: a plant the previous cut had too fails the control",
          (rec.get("plant_first_seen"), "**THE FIRST-SEEN CONTROL FAILED**: the plant `NoSuchItemPlanted` does not read "
           "first seen at this cut in `public`, `private`." in out), (False, True))
    out, rec = summary3(previous3(), plant_env="docs", rows_env="docs")
    check("first seen: a planted run with no previous report", rec.get("plant_first_seen"), "UNKNOWN")
    out, rec = summary3(previous3([r for r in prev_units3 if r["row"] != "docs"]), plant_env="docs", rows_env="docs")
    check("first seen: a plant in a row the previous cut has no result for reads first seen, named in its unit's entry",
          (rec.get("plant_first_seen"), [(e["kind"], e["unit"], planted3 in e.get("failures", [])) for e in rec.get("first_seen", [])]
           if isinstance(rec.get("first_seen"), list) else None),
          (True, [("unit", "public", True), ("unit", "private", True)]))
    json.dump(unit3(docs3p, []), open(at3[docs3p], "w"))
    # A planted empty heading in a CHANGELOG that already had an empty heading to remove: one more of
    # that rewrite, so first seen.
    cl3 = ("changelog", "changelogs", "runner")
    relay = ("packages/browser-relay/CHANGELOG.md: 0 promoted item(s), 0 merged duplicate heading(s), 0 dropped released "
             "duplicate(s), {} removed empty heading(s), 0 collapsed release(s); from line 5: -### {}")
    json.dump(unit3(cl3, [relay.format(2, "Planted empty heading")]), open(at3[cl3], "w"))
    out, rec = summary3(previous3([dict(r, failures=[relay.format(1, "Old")]) if r["row"] == "changelog" else r for r in prev_units3]),
                        plant_env="changelog", rows_env="changelog")
    check("first seen: a planted empty heading in a CHANGELOG that had one to remove reads first seen",
          (rec.get("plant_caught"), rec.get("plant_first_seen"), seen3(rec)),
          (True, True, [("failure", "changelog", "changelogs", relay.format(2, "Planted empty heading"), "NEW",
                         "the previous cut counted 1 removed empty heading(s) in it, this cut 2")]))
    json.dump(unit3(cl3, here3[cl3]), open(at3[cl3], "w"))
    # A plant past the first FIRST_SEEN_NAMED failures of a unit with no result at the previous cut is
    # named in that unit's entry, and the control reads only the entries.
    blc, blf = ("builtins-lint", "clippy", "runner"), ("builtins-lint", "rustfmt", "runner")
    plant_c = f"crates/pi-builtins/src/lib.rs:90:1: clippy::redundant_static_lifetimes: constants have by default a 'static lifetime ({BUILTINS_LINT_PLANT_LINES[0]})"
    plant_f = f"crates/pi-builtins/src/lib.rs:92: {BUILTINS_LINT_PLANT_LINES[1]}"
    many = [f"crates/pi-builtins/src/a.rs:{i}:1: clippy::x: y (fn f{i}() {{)" for i in range(1, FIRST_SEEN_NAMED + 2)]
    json.dump(unit3(blc, many + [plant_c]), open(at3[blc], "w"))
    json.dump(unit3(blf, [plant_f]), open(at3[blf], "w"))
    out, rec = summary3(previous3(prev_units3), plant_env="builtins-lint", rows_env="builtins-lint")
    check("first seen: a plant past the tenth failure of a unit with no previous result is named in its entry",
          (rec.get("plant_caught"), rec.get("plant_first_seen"),
           [(e["unit"], e["failed"], e["failures"]) for e in rec.get("first_seen", [])] if isinstance(rec.get("first_seen"), list) else None),
          (True, True, [("clippy", FIRST_SEEN_NAMED + 2, many[:FIRST_SEEN_NAMED] + [plant_c]), ("rustfmt", 1, [plant_f])]))
    json.dump(unit3(blc, here3[blc]), open(at3[blc], "w"))
    json.dump(unit3(blf, []), open(at3[blf], "w"))
    # A unit two jobs reported at the previous cut counts a finding at the fewer places, so a second
    # place of a standing link here is first seen; a test that skipped itself there did not pass.
    moved = link.format("a", 3372, 8, "Job::facts", "Job")
    again = link.format("a", 3400, 8, "Job::facts", "Job")
    json.dump(unit3(docs3, [planted3, moved, again]), open(at3[docs3], "w"))
    doubled = prev_units3 + [r for r in prev_units3 if (r["row"], r["unit"]) == ("docs", "public")]
    out, rec = summary3(previous3(doubled), rows_env="docs")
    check("first seen: a previous unit two jobs reported counts a finding at the fewer places",
          [e[3:] for e in seen3(rec) if e[1] == "docs"] if isinstance(seen3(rec), list) else seen3(rec),
          [(planted3, "NEW", "its unit did not have it at the previous cut, and read UNKNOWN there, so it may have been missed")]
          + [(f, "NEW", "the previous cut had it at 1 place(s) of its unit, this cut at 2") for f in (moved, again)])
    json.dump(unit3(docs3, here3[docs3]), open(at3[docs3], "w"))
    skipped = [dict(r, status="UNKNOWN", self_skipped=["newly::t"]) if r["unit"] == set3[1] and r["row"] == "set-runner" else r
               for r in prev_units3]
    out, rec = summary3(previous3(skipped), rows_env="set-runner,set-root,lib4")
    check("first seen: a test that skipped itself at the previous cut did not pass there",
          [e[3:] for e in seen3(rec) if e[3] == "newly::t"] if isinstance(seen3(rec), list) else seen3(rec),
          [("newly::t", "NEW", "its unit did not have it at the previous cut, and read UNKNOWN there, so it may have been missed")])
    # Nothing first seen, and a Rust row not compared: the summary says so, never that nothing is new.
    out, rec = summary3(previous3(load_results(res3), rows=dict(prev_rows3, rust_test="FAIL")))
    check("first seen: none among what was compared, beside what was not",
          (rec.get("first_seen"), "### First seen at this cut: none, against" in out,
           "No failure the comparison could read is new at this cut" in out, "none is new at this cut" in out),
          ([], True, True, False))
    # A Rust row that failed at both cuts is not compared: the summary reads none of its tests.
    out, rec = summary3(previous3(prev_units3, rows=dict(prev_rows3, rust_test="FAIL")))
    check("first seen: a Rust row that failed at both cuts is named as not compared, with each of its steps",
          ([e for e in seen3(rec) if e[0] == "row"] if isinstance(seen3(rec), list) else seen3(rec),
           sorted({b.split(":")[0] for b in rec.get("first_seen_not_compared", [])}),
           [b for b in rec.get("first_seen_not_compared", []) if "FAIL at this cut and at the previous one" in b][:1],
           "Not compared with the previous cut:" in out),
          ([], sorted({RUST_JOBS[0][0], RUST_JOBS[1][0]}),
           [f"{RUST_JOBS[0][0]}: FAIL at this cut and at the previous one, and no unit of it could be read, so a finding "
            "first made here is not seen (that job's annotations and log name them)"], True))
    # previous-report: which run it reads, and why it reads none, with gh api's answers stood in for.
    def fake_api(routes):
        def api(path):
            if path not in routes:
                raise RuntimeError(f"gh api {path} exited 1: gh: Not Found (HTTP 404)")
            v = routes[path]
            return v if isinstance(v, bytes) else json.dumps(v).encode()
        return api

    def zipped(files):
        import zipfile
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            for n, t in files.items():
                z.writestr(n, t)
        return b.getvalue()

    def gh_run(i, sha):
        return {"id": i, "head_sha": sha * 40, "html_url": f"https://github.com/o/r/actions/runs/{i}"}

    def gh_arts(i, expired=False):
        return {"artifacts": [{"id": 50 + i, "name": "sc-report", "expired": expired, "expires_at": "2026-12-01T00:00:00Z"}]}

    runs_at = f"repos/o/r/actions/workflows/sami-checks.yml/runs?branch=release-candidate&event=push&status=completed&per_page={PREVIOUS_RUNS}"
    arts_at = "repos/o/r/actions/runs/{}/artifacts?name=sc-report&per_page=10"
    good = {runs_at: {"workflow_runs": [gh_run(100, "c"), gh_run(99, "c"), gh_run(98, "b"), gh_run(97, "a")]},
            arts_at.format(98): gh_arts(98), arts_at.format(97): gh_arts(97),
            "repos/o/r/actions/artifacts/148/zip": zipped({"results.json": json.dumps(prev_units3),
                                                            "verdict.json": json.dumps({"rows": prev_rows3})}),
            "repos/o/r/actions/artifacts/147/zip": zipped({"results.json": "[]"})}
    fetched = os.path.join(d, "fetched")

    def fetch(routes, named=""):
        shutil.rmtree(fetched, ignore_errors=True)
        env = dict(GITHUB_REPOSITORY="o/r", GITHUB_RUN_ID="100", SC_COMMIT="c" * 40, SC_INPUT_PREVIOUS=named)
        kept_env = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                about = previous_report(fetched, fake_api(routes))
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return about["run"], about["why"], sorted(os.listdir(fetched))

    check("previous-report: the newest completed push before this run, of another commit",
          fetch(good), (98, None, ["about.json", "results.json", "verdict.json"]))
    out, rec = summary3(fetched)
    check("previous-report: the summary reads what it fetched", (seen3(rec), rec.get("first_seen_against")),
          (want3, "run 98 (the newest completed push of release-candidate before this run), of bbbbbbbbbbbb"))
    expired = dict(good, **{arts_at.format(98): gh_arts(98, expired=True)})
    check("previous-report: an sc-report that expired, and no older run tried", fetch(expired),
          (98, "run 98's sc-report expired at 2026-12-01T00:00:00Z (an sc-report is kept 30 days)", ["about.json"]))
    out, rec = summary3(fetched)
    check("previous-report: the summary reads an expired report UNKNOWN, naming why",
          (rec.get("first_seen"), rec.get("first_seen_why")), ("UNKNOWN", "run 98's sc-report expired at 2026-12-01T00:00:00Z (an sc-report is kept 30 days)"))
    check("previous-report: a run with no sc-report", fetch(dict(good, **{arts_at.format(98): {"artifacts": []}}))[:2],
          (98, "run 98 has no sc-report artifact (its summary job uploaded none)"))
    check("previous-report: an sc-report with no results.json",
          fetch(dict(good, **{"repos/o/r/actions/artifacts/148/zip": zipped({"summary.md": "x"})}))[:2],
          (98, "run 98's sc-report holds no results.json (it holds summary.md)"))
    check("previous-report: no run before this one, of another commit",
          fetch(dict(good, **{runs_at: {"workflow_runs": [gh_run(100, "c"), gh_run(99, "c")]}}))[:2],
          (None, "none of the newest 2 completed sami-checks runs on a push of release-candidate is a run before this one, of another commit"))
    check("previous-report: the list of runs could not be read", fetch({})[:2],
          (None, f"the previous run could not be found: gh api {runs_at} exited 1: gh: Not Found (HTTP 404)"))
    check("previous-report: the run the dispatch input names", fetch(dict(good, **{"repos/o/r/actions/runs/97": gh_run(97, "a")}), "97"),
          (97, None, ["about.json", "results.json"]))
    check("previous-report: a named run that is not there", fetch(good, "7")[:2],
          (None, "the previous run could not be found: gh api repos/o/r/actions/runs/7 exited 1: gh: Not Found (HTTP 404)"))
    check("previous-report: a named run that is no run id", fetch(good, "latest")[:2], (None, "the dispatch input previous ('latest') is no run id"))

    # The Rust rows, finding by finding (.github/sami/findings.sh, RUST_FINDING_STEPS). The measured
    # case: crates/pi-shell/BUILD.bazel named a test file upstream had deleted, so from Cut15 the row
    # read `a target failed to build` and `zle_vi_pty_test is a test target, but bazel test has no
    # result for it`; the row read FAIL at Cut14 for other findings, so the row's verdict did not
    # change and three cuts were published over it. Here each finding of the row is compared.
    rt_dir = os.path.join(d, "rust-findings")

    def findings_text(*records, end=True):
        """A findings file: ("finding"|"stop", title, message) records, with the end line unless END."""
        lines = ["\t".join(r) for r in records]
        if end:
            lines.append("end\t%d" % sum(1 for r in records if r[0] == "finding"))
        return "".join(line + "\n" for line in lines)

    def findings_at(files):
        """FILES is {(job, step): its text}; a (job, step) it does not name has no file."""
        shutil.rmtree(rt_dir, ignore_errors=True)
        for (job, step), text in files.items():
            os.makedirs(os.path.join(rt_dir, f"sc-findings-{job}"), exist_ok=True)
            open(os.path.join(rt_dir, f"sc-findings-{job}", f"{step}.tsv"), "w", encoding="utf-8").write(text)
        return rt_dir

    build_fail = ("finding", "Rust tests", "a target failed to build (Bazel's FAILED TO BUILD lines above name it); no list "
                  "line can account for that")
    no_result = ("finding", "Rust tests", "//crates/pi-shell:pi-shell_integration_tests_tests/zle_vi_pty_test is a test target, "
                 "but bazel test has no result for it: skipped as incompatible with the runner, left out by a test filter, or "
                 "not built")
    standing = ("finding", "Rust tests", "//crates/pi-shell:pi-shell_test bash::vm::ended_subshell_output::"
                "a_cancel_runs_no_trap_in_an_ended_subshell failed and is not in .github/sami/rust-test-known-failures.txt")
    listed = ("finding", "Rust test skips", "//crates/pi-shell:pi-shell_test (main) reported 4310 tests and filtered out 2, "
              "but its binary lists 4313")
    listed_moved = ("finding", "Rust test skips", "//crates/pi-shell:pi-shell_test (main) reported 4330 tests and filtered out "
                    "3, but its binary lists 4334")
    printed = ("finding", "Rust test printed", "crates/pi-shell/src/sys/fs.rs:12: a doctest rustdoc runs prints (println!)")
    printed_moved = ("finding", "Rust test printed", "crates/pi-shell/src/sys/fs.rs:40: a doctest rustdoc runs prints (println!)")
    check("rust findings: a whole file reads its records",
          read_findings(findings_at({("rust-test", "rust-test"): findings_text(build_fail, standing)})
                        + "/sc-findings-rust-test/rust-test.tsv"),
          ([build_fail, standing], None))
    for label, text, why in (
            ("a file with no end line", findings_text(build_fail, end=False),
             "it has no end line, so the step was cut short before it had looked at everything"),
            ("an empty file", "", "it is empty, so the step wrote no record at all"),
            ("a file whose end line counts another number", "finding\tRust tests\tx\nend\t2\n",
             "its end line counts 2 finding(s), and it holds 1"),
            ("a file with a line after its end line", "end\t0\nfinding\tRust tests\tx\n",
             "its end line is line 1 of 2, and it must be its last"),
            ("a file whose step stopped", findings_text(("stop", "Rust tests", "bazel test exited 8"), end=False),
             "the step stopped at its last finding (Rust tests), so what it would have found after it is not known"),
            ("a file with a line that is no record", "what\n", "its line 1 is no record of a findings file: 'what'")):
        got = read_findings(findings_at({("rust-test", "rust-test"): text}) + "/sc-findings-rust-test/rust-test.tsv")
        check(f"rust findings: {label} reads UNKNOWN, naming why", got[1], why)
    check("rust findings: a file that is not there reads UNKNOWN",
          read_findings(os.path.join(rt_dir, "nothing.tsv"))[1].startswith("it could not be read (FileNotFoundError"), True)
    # The jobs RUST_FINDING_STEPS names are the jobs row_work gives the row: a job of a Rust row that
    # writes no findings file would otherwise be a gap nothing names.
    check("rust findings: its jobs are the row's jobs",
          {row: sorted(j for j, _ in jobs) for row, jobs in RUST_FINDING_STEPS.items()},
          {row: sorted(j for j, _ in row_work()[row]) for row in RUST_FINDING_STEPS})
    # A job that did not run reads NOT RUN, and one that ran and wrote no file reads UNKNOWN: the two
    # are told apart, and only the second is a gap.
    ran = {("rust-test", "rust-test"): findings_text(build_fail, no_result, standing),
           ("rust-test", "parity"): findings_text(),
           ("rust-test-drift", "drift"): findings_text(("finding", "Listing drift", "//crates/a:a_test has an early listing "
                                                        "(3 tests) and no listing of rust_test's: the macOS inventory read a "
                                                        "target Bazel did not list here"))}
    jobs_ran = {"rust-test": "failure", "rust-test-drift": "failure", "rust-test-cold": "skipped",
                "rust-test-compare": "skipped", "rust-test-macos": "skipped"}
    got = {r["unit"]: (r["status"], len(r["failures"])) for r in rust_findings_results(findings_at(ran), jobs_ran)}
    check("rust findings: a step that found things, one that found none, one whose job did not run, and one whose job ran "
          "and wrote no file",
          (got["rust-test/rust-test"], got["rust-test/parity"], got["rust-test-cold/rust-test"], got["rust-test-macos/rust-test"],
           got["rust-test-compare/verdict"]),
          (("FAIL", 3), ("PASS", 0), ("NOT RUN", 0), ("NOT RUN", 0), ("NOT RUN", 0)))
    got = {r["unit"]: (r["status"], r["note"]) for r in rust_findings_results(
        findings_at(ran), dict(jobs_ran, **{"rust-test-compare": "failure"}))}
    check("rust findings: a job that ran and wrote no findings file reads UNKNOWN, naming the job's result",
          (got["rust-test-compare/verdict"][0], "the rust-test-compare job ended [failure] and this step wrote no findings file"
           in got["rust-test-compare/verdict"][1], got["rust-test-cold/parity"][0],
           "did not run (its result is [skipped])" in got["rust-test-cold/parity"][1]),
          ("UNKNOWN", True, "NOT RUN", True))
    # The summary over those results: a run whose Rust rows are its only rows (SC_ROWS), against a
    # previous cut that had the row's standing finding and read FAIL too.
    res4, prev4, vfile4 = os.path.join(d, "res4"), os.path.join(d, "prev4"), os.path.join(d, "verdict4.json")

    def summary4(here, there, jobs=None, rust="rust_test=failure rust_test_macos=skipped", rows="rust_test", convert=True):
        """cmd_summary on the Rust rows alone: HERE and THERE are {(job, step): findings text} for this
        cut and the previous one (None: no previous report). With CONVERT false, the results already in
        res4 are read as they are (a conversion that wrote only some of them). Returns (the summary,
        its verdict record)."""
        if convert:
            shutil.rmtree(res4, ignore_errors=True)
            os.makedirs(os.path.join(res4, "sc-res-rust-findings"))
        cmd_rust_findings_env = dict(SC_RUST_JOBS=" ".join(f"{j}={v}" for j, v in (jobs or jobs_ran).items()))
        kept_env = {k: os.environ.get(k) for k in cmd_rust_findings_env}
        os.environ.update(cmd_rust_findings_env)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                if convert:
                    cmd_rust_findings(findings_at(here), os.path.join(res4, "sc-res-rust-findings"))
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        shutil.rmtree(prev4, ignore_errors=True)
        os.makedirs(prev4)
        if there is not None:
            with contextlib.redirect_stdout(io.StringIO()):
                there_dir = os.path.join(d, "prev4-findings")
                shutil.rmtree(there_dir, ignore_errors=True)
                os.makedirs(there_dir)
                kept_env = {"SC_RUST_JOBS": os.environ.get("SC_RUST_JOBS")}
                os.environ["SC_RUST_JOBS"] = " ".join(f"{j}={v}" for j, v in (jobs or jobs_ran).items())
                try:
                    cmd_rust_findings(findings_at(there), there_dir)
                finally:
                    if kept_env["SC_RUST_JOBS"] is None:
                        os.environ.pop("SC_RUST_JOBS", None)
                    else:
                        os.environ["SC_RUST_JOBS"] = kept_env["SC_RUST_JOBS"]
            json.dump(load_results(there_dir), open(os.path.join(prev4, "results.json"), "w"))
            json.dump({"rows": {"rust_test": "FAIL", "rust_test_macos": "UNKNOWN"}},
                      open(os.path.join(prev4, "verdict.json"), "w"))
        env = dict(SC_PLANT="", SC_VERDICT=vfile4, SC_ROWS=rows, SC_RUST_TESTS=rust,
                   SC_PREVIOUS=prev4 if there is not None else None)
        kept_env = {k: os.environ.get(k) for k in env}
        for k, v in env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        if os.path.exists(vfile4):
            os.remove(vfile4)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                cmd_summary(res4, build2, known3)
        finally:
            for k, v in kept_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        return buf.getvalue(), json.load(open(vfile4, encoding="utf-8"))

    def seen4(rec):
        s = rec.get("first_seen")
        return [(e["kind"], e["row"], e["unit"], e["finding"]) for e in s] if isinstance(s, list) else s

    there4 = {("rust-test", "rust-test"): findings_text(standing, listed, printed), ("rust-test", "parity"): findings_text(),
              ("rust-test-drift", "drift"): findings_text()}
    here4 = {("rust-test", "rust-test"): findings_text(build_fail, no_result, standing, listed_moved, printed_moved),
             ("rust-test", "parity"): findings_text(), ("rust-test-drift", "drift"): findings_text()}
    out, rec = summary4(here4, there4)
    check("rust findings: a finding first made at this cut is named, though the row read FAIL at both cuts",
          (seen4(rec), rec.get("first_seen_not_compared"),
           f"- **{RUST_JOBS[0][0]}** `rust-test/rust-test`: FOUND `{build_fail[1]}: {build_fail[2]}`: **first seen at this cut**"
           in out),
          ([("failure", "rust_test", "rust-test/rust-test", f"{build_fail[1]}: {build_fail[2]}"),
            ("failure", "rust_test", "rust-test/rust-test", f"{no_result[1]}: {no_result[2]}")], [], True))
    # The identity key: a finding whose counts or whose place moved is the same finding, and one
    # whose test is another test is not. Without this the list would name every cut's counts.
    check("rust findings: a finding whose counts and place moved is not first seen, and another test is",
          (sorted(e[3] for e in seen4(summary4({**here4, ("rust-test", "rust-test"): findings_text(
              standing, listed_moved, printed_moved)}, there4)[1])),
           sorted(e[3] for e in seen4(summary4({**here4, ("rust-test", "rust-test"): findings_text(
               standing, listed, printed,
               ("finding", "Rust tests", "//crates/pi-shell:pi-shell_test bash::vm::another::test failed and is not in "
                ".github/sami/rust-test-known-failures.txt"))}, there4)[1]))),
          ([], ["Rust tests: //crates/pi-shell:pi-shell_test bash::vm::another::test failed and is not in "
                ".github/sami/rust-test-known-failures.txt"]))
    # A finding of a job the previous cut did not run is read against the row's other units, which
    # did look: the cold control runs every fifth cut, and its findings are the seeded job's too.
    out, rec = summary4({**here4, ("rust-test-cold", "rust-test"): findings_text(standing, listed),
                         ("rust-test-cold", "parity"): findings_text(),
                         ("rust-test-compare", "verdict"): findings_text(),
                         ("rust-test-compare", "compare"): findings_text()},
                        there4, jobs=dict(jobs_ran, **{"rust-test-cold": "failure", "rust-test-compare": "success"}))
    check("rust findings: the cold control's own copy of a standing finding is not first seen",
          sorted(e[3] for e in seen4(rec)),
          sorted([f"{build_fail[1]}: {build_fail[2]}", f"{no_result[1]}: {no_result[2]}"]))
    # A step whose file was cut short is named under "Not compared", with the row still read finding
    # by finding; a row no step of which could be read falls back to its verdict, as before.
    out, rec = summary4({**here4, ("rust-test-drift", "drift"): findings_text(
        ("finding", "Listing drift", "//crates/a:a_test x"), end=False)}, there4)
    check("rust findings: a step whose findings file was cut short is named as not compared",
          ([b for b in rec.get("first_seen_not_compared", []) if "rust-test-drift/drift" in b][:1],
           "Not compared with the previous cut:" in out),
          ([f"{RUST_JOBS[0][0]}: `rust-test-drift/drift` could not be read, so its findings are in no list: its findings file "
            "could not be read whole: it has no end line, so the step was cut short before it had looked at everything; it "
            "holds 1 finding(s)"], True))
    out, rec = summary4({}, there4, jobs=dict(jobs_ran, **{"rust-test": "failure", "rust-test-drift": "failure"}))
    check("rust findings: a row no step of which could be read is compared by its verdict, and says so",
          (seen4(rec), [b for b in rec.get("first_seen_not_compared", []) if "FAIL at this cut and at the previous one" in b][:1]),
          ([], [f"{RUST_JOBS[0][0]}: FAIL at this cut and at the previous one, and no unit of it could be read, so a finding "
                "first made here is not seen (that job's annotations and log name them)"]))
    # A unit the previous cut did not run is no evidence: a finding here that the row's other units
    # also did not have at that cut reads first seen, and the row's report says UNKNOWN nowhere.
    out, rec = summary4(here4, {("rust-test", "parity"): findings_text()},
                        jobs=dict(jobs_ran, **{"rust-test-drift": "skipped"}))
    check("rust findings: a unit that did not run at the previous cut lets no finding read standing",
          sorted(e[3] for e in seen4(rec)),
          sorted([f"{build_fail[1]}: {build_fail[2]}", f"{no_result[1]}: {no_result[2]}",
                  f"{standing[1]}: {standing[2]}", f"{listed_moved[1]}: {listed_moved[2]}",
                  f"{printed_moved[1]}: {printed_moved[2]}"]))
    # The sol review of 8b299ece, reproduced as cases. (1) The identity key must keep an
    # invocation's name: rust-test.sh gives each own-process test an invocation of its own
    # (`own-0`, `own-1`), and a stop message names the invocation and not the test, so a digit rule
    # that took the index out made two tests' findings one.
    stop_own = "Rust tests: bazel test exited {} ({}), which is neither a test nor a build failure"
    check("rust findings: an invocation's own number and a command's exit code tell two findings apart",
          (set(finding_keys("rust_test", stop_own.format(8, "own-0"))) == set(finding_keys("rust_test", stop_own.format(8, "own-1"))),
           set(finding_keys("rust_test", stop_own.format(8, "own-0"))) == set(finding_keys("rust_test", stop_own.format(36, "own-0"))),
           set(finding_keys("rust_test", "Rust tests: //a:a_test b reported 3 tests")) ==
           set(finding_keys("rust_test", "Rust tests: //a:a_test b reported 4 tests"))),
          (False, False, True))
    out, rec = summary4({**here4, ("rust-test", "parity"): findings_text(
        ("finding", "Rust test parity", "//crates/a:a_test has no Bazel rust_test"))}, there4)
    first_seen_whole = sorted(e[3] for e in seen4(rec))
    os.remove(os.path.join(res4, "sc-res-rust-findings", "rust-test_parity.json"))
    out, rec = summary4(None, there4, convert=False)
    check("rust findings: a step sc.py rust-findings wrote no result for reads UNKNOWN, named, and the finding it "
          "would hold is not read as nothing new",
          ("Rust test parity: //crates/a:a_test has no Bazel rust_test" in first_seen_whole,
           "Rust test parity: //crates/a:a_test has no Bazel rust_test" in [e[3] for e in seen4(rec)],
           [b for b in rec.get("first_seen_not_compared", []) if "rust-test/parity" in b][:1],
           f"- **{RUST_JOBS[0][0]}** `rust-test/parity`: UNKNOWN: no result: sc.py rust-findings wrote none for this step"
           in out),
          (True, False,
           [f"{RUST_JOBS[0][0]}: `rust-test/parity` could not be read, so its findings are in no list: no result: sc.py "
            "rust-findings wrote none for this step, so what it found is not known (that step failed, or the summary job "
            "could not read its artifact)"], True))
    check("rust findings: an end line whose count is no ASCII number reads UNKNOWN, not a fault of the reader",
          read_findings(findings_at({("rust-test", "rust-test"): "finding\tt\tm\nend\t\u00b2\n"})
                        + "/sc-findings-rust-test/rust-test.tsv")[1],
          "its line 2 is no record of a findings file: 'end\\t\u00b2'")

    if fails:
        for f in fails:
            print(f"SELFTEST FAIL {f}")
        sys.exit(1)
    print("SELFTEST OK: libtest (60 s warning, hang, kill, self-skip), nextest, bun and clippy counters, the "
          "platform report reader, the tree's real skip lines and partial passes, the shard assignment and "
          "per-user weights, the summary's UNKNOWN for a unit no job or two jobs reported, its exit (0 PASS, 1 FAIL, "
          "2 UNKNOWN, a fault outranking a row that could not be read, 2 for a summary that stopped), the known and flaky "
          "entries, skip-forms and skip-lines with their controls, the gVisor rows and their known skips, the "
          "docs and changelog rows with their planted controls, the builtins-lint row's lift, readers, sorting "
          "and plant, the bazel-lock row's reading of Bazel and its plant, the Rust tests' rows from their jobs' "
          "conclusions, the row selection (its jobs from the workflow's needs, the cut's every row, a control "
          "on a row that does not run), the summary's NOT RUN rows and verdict line, its first-seen comparison "
          "with the previous cut's report (a new finding listed, one at both cuts not, UNKNOWN for a report that "
          "is missing or does not parse, the plant's control, and the run previous-report fetches), and that "
          "comparison over the Rust rows' own findings (a findings file read whole, or UNKNOWN with the reason; a "
          "step that did not run told from one that wrote no file; a finding first made at a cut named though the "
          "row read FAIL at the cut before; one whose counts or place moved not named; and a row no step of which "
          "could be read compared by its verdict and named as not compared)")


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
# its first `## [` heading ([Unreleased] in this tree), which fix-changelogs removes; each cargo
# workspace the rustfmt row checks gets a function rustfmt would space out at the end of its first
# target root (rustfmt_plant_target), so each unit of the row must name it; the memory bench's shell
# gets a 1 MiB reserve in a list its kernel keeps (Shell::create, just after the kernel is made),
# which the shell's drop frees, so the bench's shell line must read MISS; pi-builtins' library root
# gets two consts (BUILTINS_LINT_PLANT_LINES), one for each unit of the builtins-lint row.
# The builtins-lint row (builtins-lint.sh): the crate the clippy row lints only under its own
# opt-outs and the rustfmt row never reads (rustfmt.toml ignores it), under both tools with those
# opt-outs lifted for the check (builtins_lint_lift). Two units, clippy and rustfmt.
BUILTINS_LINT_CRATE = "pi-builtins"
BUILTINS_LINT_UNITS = ("clippy", "rustfmt")
# Its control, appended to the crate's library root after a blank line: a const whose `'static`
# clippy::redundant_static_lifetimes names (a style lint: the clippy::all group, which the crate's own
# [lints] allows), then one rustfmt would space out. Each names BUILTINS_LINT_PLANT in its line.
BUILTINS_LINT_PLANT = "SC_BUILTINS_LINT_PLANT"
BUILTINS_LINT_PLANT_LINES = (f"pub const {BUILTINS_LINT_PLANT}_CLIPPY: &'static str = \"planted\";",
                             f"pub const {BUILTINS_LINT_PLANT}_FMT:u8=0;")
PLANTS = {
    "docs": ("crates/pi-shell/src/lib.rs", "/// See [`NoSuchItemPlanted`].", "NoSuchItemPlanted"),
    "changelog": ("packages/browser-relay/CHANGELOG.md", "### Planted empty heading", "Planted empty heading"),
    "rustfmt": ("the first target root of each cargo workspace the row checks", "fn sc_rustfmt_plant(){}", "sc_rustfmt_plant"),
    "membench": ("crates/pi-shell/src/bash/vm/mod.rs", "k.callout_labels.reserve_exact(1 << 17);", "memory shell:"),
    "builtins-lint": ("crates/pi-builtins/src/lib.rs", " and ".join(BUILTINS_LINT_PLANT_LINES), BUILTINS_LINT_PLANT),
    # One comment line at the end of the root Cargo.toml, a file the lock records by its sha256: Bazel
    # must then name it, and the row's failure for it starts `@@//Cargo.toml:`.
    "bazel-lock": ("Cargo.toml", "# sami-checks plant: bazel-lock", "@@//Cargo.toml:"),
}
# The line of Shell::create the membench plant goes after: the kernel the shell owns is made there.
MEMBENCH_PLANT_AT = "let mut k = Kernel::new("
# The memory bench row (membench.sh): pi-shell's benches/memory.rs, built by `cargo bench --no-run`
# (cargo's bench profile, which inherits release) and run once, as `cargo bench` runs it. A target
# line holds `(target …) PASS` or `(target …) MISS` (benches/common's verdict after the target's
# bound); the bench's other lines hold numbers too, and the summary lists every line it printed,
# its stderr too (a panic, an assertion's values).
MEMBENCH_UNIT = "crates/pi-shell/benches/memory.rs"
MEMBENCH_TARGET = re.compile(r"\(target\b[^()]*\) (PASS|MISS)\b")


def stopped(exit_code):
    """Whether the time bound, a signal or a missing command ended a run (parse_plain's rule)."""
    return exit_code in ("124", "125", "126", "127", "137") or (exit_code.isdigit() and int(exit_code) > 128)


def first_line(text):
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def bench_executable(stream, name="memory"):
    """The executable of the bench target NAME in `cargo bench --no-run --message-format=json` output
    (STREAM), or None."""
    for line in read_lines(stream) or ():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        t = m.get("target") if isinstance(m, dict) and m.get("reason") == "compiler-artifact" else None
        if isinstance(t, dict) and t.get("name") == name and "bench" in t.get("kind", []) and m.get("executable"):
            return m["executable"]
    return None


def parse_membench(unit, out, err, exit_code, secs, build_exit, build_log, row="membench"):
    """One run of pi-shell's memory bench: OUT its stdout, ERR its stderr, EXIT and SECS the run's;
    BUILD_EXIT and BUILD_LOG `cargo bench --no-run`'s (EXIT `-` when the build named no executable, so
    nothing ran). Every line the bench printed is kept, its stdout (bench_lines) and its stderr
    (bench_stderr), backticks as '. A target is a `(target …) PASS` or
    `(target …) MISS` (MEMBENCH_TARGET); a PASS or MISS anywhere else is no target. FAIL names each
    target that reads MISS (its line cut after the word) and, when no target missed, an exit other
    than 0 with the bench's panic line: so it reads the same whether the bench exits 0 on a MISS or
    not. PASS needs exit 0 and every target PASS. UNKNOWN: the bench did not build, nothing ran, no
    log, the time bound or a signal ended it, or it printed no target (its exit and panic line named)."""
    shown, errs = [], []

    def r(status, passed=0, failures=(), note=""):
        res = result(row, unit, "runner", status, exit_code, secs, passed, len(failures), failures=failures, note=note)
        res["bench_lines"] = list(shown)
        res["bench_stderr"] = list(errs)
        return res

    if build_exit != "0":
        said = [line.strip() for line in read_lines(build_log) or () if line.strip()]
        why = ("the time bound or a signal ended it" if stopped(build_exit)
               else next((line for line in said if line.startswith("error")), said[-1] if said else "no log"))
        return r("UNKNOWN", note=f"the bench did not build (cargo bench --no-run, exit {build_exit}): {why[:300]}")
    if exit_code == "-":
        return r("UNKNOWN", note="cargo named no executable of the memory bench, so nothing ran")
    printed = read_lines(out)
    if printed is None:
        return r("UNKNOWN", note="no log of the bench's run")
    shown = [line.replace("`", "'") for line in printed if line.strip()]
    said = [line.replace("`", "'") for line in read_lines(err) or () if line.strip()]
    errs = said
    # A panic prints `thread '…' panicked at <place>:` and then its message on the next line.
    at = next((i for i, line in enumerate(said) if " panicked at " in line), None)
    why = (" ".join(s.strip() for s in said[at:at + 2]) if at is not None else said[-1].strip() if said else "")[:300]
    if stopped(exit_code):
        return r("UNKNOWN", note=f"exit {exit_code}: the time bound or a signal ended the bench")
    targets = [(line[:m.end()], m.group(1)) for line in shown for m in MEMBENCH_TARGET.finditer(line)]
    if not targets:
        return r("UNKNOWN", note=f"exit {exit_code}, and the bench printed no target ('(target …) PASS' or MISS)"
                 + (f": {why}" if why else ""))
    passes = [n for n, v in targets if v == "PASS"]
    misses = [n for n, v in targets if v == "MISS"]
    counted = f"{len(passes)} of {len(targets)} target(s) PASS, {len(misses)} MISS; exit {exit_code}"
    if misses or exit_code != "0":
        failures = misses or [f"exit {exit_code}: {why or 'no error line'}"]
        return r("FAIL", len(passes), failures, note=counted + (f" ({why})" if exit_code != "0" and why else ""))
    return r("PASS", len(passes), note=counted)


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


# The rustfmt row (rustfmt.sh): `cargo fmt --all --check -v` in each cargo workspace the gate builds,
# the root one and each one .github/sami/rust-test-cargo-workspaces.txt lists (rust-test-parity.sh
# fails while a tracked Cargo.toml outside the root workspace is missing there; the Rust tests run
# each one listed). rustfmt reads the rustfmt.toml nearest each file, so a workspace with none of its
# own takes the root's, as a developer's `cargo fmt` there does.
RUSTFMT_WORKSPACES_LIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sami", "rust-test-cargo-workspaces.txt")
# `cargo fmt -v` lists each target root it gives rustfmt (`[lib (2024)] "<path>"`); `--check` prints
# `Diff in <path>:<line>:` before each block of changes, then its lines (` `, `-`, `+`), and
# `Incorrect newline style in <path>` for a file whose line endings rustfmt.toml's newline_style
# forbids. rustfmt's own errors start `error` or `Error` (`Error writing files: failed to resolve
# mod ...` skips a whole crate root). An `error[internal]: ...` whose next line places it
# (`--> <path>:<line>:<line>:<column>`) is one line of a file rustfmt read and formatted, but could
# not format cleanly (`left behind trailing whitespace`; `line formatted, but exceeded maximum
# width` when the config asks): a place of that line, not a file it could not read.
RUSTFMT_TARGET = re.compile(r'^\[[^\]]+\] "(.+)"$')
RUSTFMT_DIFF = re.compile(r"^Diff in (.+):(\d+):$")
RUSTFMT_NEWLINE = re.compile(r"^Incorrect newline style in (.+)$")
RUSTFMT_INTERNAL = re.compile(r"^error\[internal\]: (.+)$")
RUSTFMT_AT = re.compile(r"^\s*--> (.+):(\d+):\d+:\d+$")
# rustfmt's own -v (`cargo fmt ... -- -v`) names each file it formats or checks: a file its
# rustfmt.toml ignores, or a module under #[rustfmt::skip], is never named.
RUSTFMT_FORMATTING = re.compile(r"^Formatting (.+)$")
# rustfmt's -v names the config it takes for each target root before it checks that root and its
# modules, which take the root's config, whatever config files lie nearer them.
RUSTFMT_CONFIG = re.compile(r"^Using rustfmt config file (.+) for (.+)$")
DIFF_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def rustfmt_workspaces(path=RUSTFMT_WORKSPACES_LIST):
    """The manifests of the cargo workspaces the rustfmt row checks, relative to the tree: Cargo.toml,
    then the first word of each entry line of the list (as rust-test-lists.sh's list_entries reads
    it), in its order. None when the list cannot be read."""
    lines = read_lines(path)
    if lines is None:
        return None
    out = ["Cargo.toml"]
    for line in lines:
        if line.strip() and not line.startswith("#") and line.split()[0] not in out:
            out.append(line.split()[0])
    return out


def read_rustfmt(log, tree):
    """What one `cargo fmt --all --check -v -- -v` log, run under TREE, says: (target roots, places,
    error lines, the files rustfmt checked, the log's lines), or None when there is no log. A place is
    a dict: `name`, `path:line: the first line it rewrites` (each run of changed lines in a block is a
    place, at its line in the file as it is) or `path: newline style`, with the path from TREE's root
    and backticks as ' so that it reads as one code span; `path`; and, for a run, `line` (its first
    line in the file as it is), `removed` (how many of the file's lines it rewrites) and `run` (its
    `-` and `+` lines). An `error[internal]` with a `-->` line is a place too. Its line is a line of
    rustfmt's output, not of the file (one source line rustfmt writes as four moves the errors after
    it by four), so it is mapped back through the file's runs: a line between runs is the source
    line as far from them; a line inside a run is that run's (its first removed line, its count of
    removed lines). Its `run` is the error's words and its line in that run, so two errors in one run
    stay two: `path:line: <the error> (rustfmt's error[internal], output line N)`."""
    try:
        # rustfmt's -v marks the end of each line of a diff with ⏎; a line is read without it.
        lines = [x[:-1] if x.endswith("⏎") else x for x in open(log, encoding="utf-8", errors="replace").read().splitlines()]
    except OSError:
        return None
    prefix = tree.rstrip("/") + "/"

    def rel(p):
        return p[len(prefix):] if p.startswith(prefix) else p

    def what(run):
        """The words for one run of changed lines: its first removed line, else what it adds."""
        gone = next((b[1:].strip() for b in run if b.startswith("-") and b[1:].strip()), None)
        if gone:
            return gone
        if any(b.startswith("-") for b in run):
            return "removes a blank line"
        new = next((b[1:].strip() for b in run if b.startswith("+") and b[1:].strip()), None)
        return f"adds {new}" if new else "adds a blank line"

    # checked: {each file rustfmt checked: the config file it took for that file's target root, or
    # None when it named none (rustfmt's defaults)}. A new rustfmt invocation starts with none.
    targets, places, errors, checked, config = [], [], [], {}, None
    # runs: {path: [(the run's first original line, lines it removes, lines it adds)]}, in order;
    # internal: [(path, output line, the error's words)], placed once every run is read.
    runs, internal = {}, []

    def add(place):
        place["name"] = place["name"].replace("`", "'")
        if all(place["name"] != p["name"] for p in places):
            places.append(place)

    for i, line in enumerate(lines):
        t, d, nl, f = RUSTFMT_TARGET.match(line), RUSTFMT_DIFF.match(line), RUSTFMT_NEWLINE.match(line), RUSTFMT_FORMATTING.match(line)
        c = RUSTFMT_CONFIG.match(line)
        if line.startswith("rustfmt "):
            config = None
        if c:
            config = c.group(1)
        elif t:
            targets.append(rel(t.group(1)))
        elif f:
            checked[rel(f.group(1))] = config
        elif d:
            # A block holds every change with fewer than three unchanged lines between them, and its
            # number is the original file's line of its first line: each run of changed lines is a
            # place, at the original line its first removed line had (an added run: the line it
            # goes before). Unchanged and removed lines move the original line on; added ones do not.
            at, run, start, path = int(d.group(2)), [], None, rel(d.group(1))
            for b in lines[i + 1:] + [""]:
                if b[:1] in ("-", "+") and not RUSTFMT_DIFF.match(b):
                    start = at if start is None else start
                    run.append(b)
                    at += b[:1] == "-"
                    continue
                if run:
                    add({"name": f"{path}:{start}: {what(run)[:160]}", "path": path, "line": start,
                         "removed": sum(b[:1] == "-" for b in run), "run": tuple(run)})
                    runs.setdefault(path, []).append((start, sum(b[:1] == "-" for b in run), sum(b[:1] == "+" for b in run)))
                    run, start = [], None
                if b[:1] != " " or RUSTFMT_DIFF.match(b):
                    break
                at += 1
        elif nl:
            add({"name": f"{rel(nl.group(1))}: newline style (rustfmt.toml's newline_style)", "path": rel(nl.group(1))})
        elif line.startswith(("error", "Error")):
            e, at = RUSTFMT_INTERNAL.match(line), RUSTFMT_AT.match(lines[i + 1]) if i + 1 < len(lines) else None
            if e and at:
                internal.append((rel(at.group(1)), int(at.group(2)), e.group(1)))
            else:
                errors.append(line.strip())
    for path, n, words in internal:
        # Output line n back to the file's line, through the file's runs in order: before a run it
        # is as far from the run's start as in the output; inside one it is that run's.
        shift, src, removed, offset = 0, None, 1, 0
        for start, minus, plus in sorted(runs.get(path, [])):
            if n < start + shift:
                break
            if n < start + shift + plus:
                src, removed, offset = start, minus, n - (start + shift)
                break
            shift += plus - minus
        if src is None:
            src = n - shift
        add({"name": f"{path}:{src}: {words[:160]} (rustfmt's error[internal], output line {n})", "path": path, "line": src,
             "removed": removed, "run": ("error[internal]", words, offset)})
    return targets, places, errors, checked, lines


def read_fork_diff(path):
    """rustfmt.sh's record of the fork's changes from the upstream base: for each file with places, a
    `### <path>` line (the path as rustfmt printed it, relative to the tree) and then the hunk headers
    of `git diff -U0 <base> -- <that file>`. {file: [(base start, base count, tree start, tree
    count), ...]}, or None when it cannot be read. A file with no hunk is the base's, unchanged; a
    file it does not name was not read."""
    lines = read_lines(path)
    if lines is None:
        return None
    out, cur = {}, None
    for line in lines:
        h = DIFF_HUNK.match(line)
        if line.startswith("### "):
            cur = line[4:]
            out.setdefault(cur, [])
        elif h and cur is not None:
            a, b, c, d = (int(x) if x is not None else 1 for x in h.groups())
            out[cur].append((a, b, c, d))
    return out


def base_line(hunks, n):
    """The base's line for line N of the file in the tree, through the fork's hunks of that file;
    None when the fork changed or added line N."""
    shift = 0
    for a, b, c, d in hunks:
        if d and c <= n < c + d:
            return None
        # A hunk ends before line N: one that adds lines ends at its last; one that only removes
        # lines (count 0) sits after line c, so it is before N when c < N.
        if (d and c + d <= n) or (not d and c < n):
            shift += b - d
    return n + shift


# What rustfmt skips in a file its check still names: an item under #[rustfmt::skip] (a path, so
# `rustfmt :: skip` is the same), or the older cfg_attr spelling, whose lines the check never read.
RUSTFMT_SKIP = re.compile(rb"rustfmt\s*::\s*skip|rustfmt_skip")


def newline_violations(root, path, config):
    """The lines of ROOT/PATH whose ending its newline_style forbids, with the style. The style is the
    one in CONFIG, the config file rustfmt reported for the file's target root, read as TOML; Auto
    when CONFIG is None or does not set it. Unix and Native (this runner is Linux) forbid CR LF,
    Windows forbids a bare LF, and Auto forbids an ending other than the file's first. (None, why)
    when the file or its config cannot be read."""
    try:
        lines = open(os.path.join(root, path), "rb").read().split(b"\n")[:-1]
    except OSError:
        return None, f"{path} could not be read"
    style = "Auto"
    if config is not None:
        try:
            style = tomllib.loads(open(config, encoding="utf-8").read()).get("newline_style", "Auto")
        except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
            return None, f"{config} could not be read as TOML: {e}"
    crlf = [line.endswith(b"\r") for line in lines]
    if style in ("Unix", "Native"):
        bad = [i for i, c in enumerate(crlf, 1) if c]
    elif style == "Windows":
        bad = [i for i, c in enumerate(crlf, 1) if not c]
    elif style == "Auto":
        bad = [i for i, c in enumerate(crlf, 1) if crlf and c != crlf[0]]
    else:
        return None, f"newline_style {style!r} is no style the row reads"
    return set(bad), style


def sort_rustfmt_places(places, base_places, checked, fork, tree, base_tree, tree_checked):
    """Each place of the tree as upstream's own, the fork's, or unsorted, with the reason for an
    unsorted one: ([upstream's], [the fork's], [(place, why)]). A place in a file the base lacks is
    the fork's. Elsewhere its file must be one the base's run checked (CHECKED) and one the fork's
    diff names (FORK), or it is unsorted. A run is upstream's own when every line it rewrites is a
    line of the base the fork left as it is, and the base has the same run at the line they map to;
    a run on a line the fork changed or added is the fork's, and so is one on unchanged lines the
    base does not fail (a fork change elsewhere, as in rustfmt.toml, brought it), unless the base's
    file has items rustfmt skips, which its check did not read: that run is unsorted. Forbidden line
    endings are upstream's own when the base fails them in that file and each line of the tree whose
    ending the tree's newline_style forbids maps to a line of the base whose ending the base's
    forbids, each side's style from the config its run reported for the file (CHECKED and
    TREE_CHECKED); a report with no such line in the tree is unsorted."""
    # Keyed by line and run together: a diff run and a placed error[internal] can share a line.
    at_base = {(p["path"], p["line"], p["run"]) for p in base_places if "run" in p}
    newline_at_base = {p["path"] for p in base_places if "run" not in p}
    upstream, mine, unsorted = [], [], []
    for p in places:
        path = p["path"]
        if not os.path.exists(os.path.join(base_tree, path)):
            mine.append(p["name"])
            continue
        if path not in checked:
            unsorted.append((p["name"], f"the upstream base's run did not check {path}"))
            continue
        if path not in fork:
            unsorted.append((p["name"], f"no diff of {path} from the upstream base"))
            continue
        hunks = fork[path]
        if "run" not in p:
            if path not in tree_checked:
                unsorted.append((p["name"], f"the tree's run named no config for {path}"))
                continue
            (here, style), (there, base_why) = newline_violations(tree, path, tree_checked[path]), newline_violations(base_tree, path, checked[path])
            if here is None or there is None:
                unsorted.append((p["name"], style if here is None else f"at the upstream base: {base_why}"))
            elif not here:
                unsorted.append((p["name"], f"no line of {path} has an ending its newline_style ({style}) forbids"))
            elif path in newline_at_base and all(base_line(hunks, n) in there for n in here):
                upstream.append(p["name"])
            else:
                mine.append(p["name"])
            continue
        rewritten = [p["line"] + k for k in range(max(p["removed"], 1))]
        mapped = [base_line(hunks, n) for n in rewritten]
        if None in mapped or mapped != list(range(mapped[0], mapped[0] + len(mapped))):
            mine.append(p["name"])
        elif (path, mapped[0], p["run"]) in at_base:
            upstream.append(p["name"])
        elif RUSTFMT_SKIP.search(open(os.path.join(base_tree, path), "rb").read()):
            unsorted.append((p["name"], f"the upstream base's {path} has items rustfmt skips, which its check did not read"))
        else:
            mine.append(p["name"])
    return upstream, mine, unsorted


def parse_rustfmt(unit, log, exit_code, secs, tree, base_log="-", base_exit="-", base_tree="-", base_sha="-", fork_diff="-",
                  row="rustfmt"):
    """One workspace's `cargo fmt --all --check -v -- -v` (LOG: its stdout and stderr), run in the
    directory of the manifest UNIT under TREE, against the same run at the tree's upstream base
    (BASE_LOG and BASE_EXIT, run under BASE_TREE, the merge base BASE_SHA of the tree and upstream's
    main; BASE_EXIT `absent` when the base has no UNIT, `-` when the base could not be set up,
    BASE_LOG then the setup's log) and the fork's changes from the base (FORK_DIFF, `git diff -U0`
    of the files with places). Each place rustfmt would change (read_rustfmt) is upstream's own,
    the fork's or unsorted (sort_rustfmt_places). FAIL names each place of the fork's, and lists the
    others; KNOWN is a unit whose every place is upstream's own, each listed (upstream_places). PASS
    needs exit 0, a target root listed and no place; it reads no base. Anything else is UNKNOWN: a
    manifest the tree lacks, no log, the time bound or a signal, no target root listed (nothing was
    checked), an error line (a file or crate rustfmt could not read, so its places are unread; those
    it read are still named), an exit that disagrees with the places (0 with some, 1 with none),
    places with no clean read of the base or of the fork's diff to sort them by, or a place the base
    did not check."""
    def r(status, passed=0, failures=(), note="", upstream=(), unsorted=()):
        res = result(row, unit, "runner", status, exit_code, secs, passed, len(failures), failures=failures, note=note)
        res["upstream_places"] = list(upstream)
        res["unsorted_places"] = [f"{n} ({why})".replace("`", "'") for n, why in unsorted]
        res["upstream_base"] = "" if base_sha == "-" else base_sha
        return res

    if not os.path.isfile(os.path.join(tree, unit)):
        return r("UNKNOWN", note=f"the tree has no {unit}")
    got = read_rustfmt(log, tree)
    if got is None:
        return r("UNKNOWN", note="no log")
    if stopped(exit_code):
        return r("UNKNOWN", note=f"exit {exit_code}: the time bound or a signal ended it")
    targets, places, errors, tree_checked, lines = got
    names = [p["name"] for p in places]
    found = f"{len(places)} place(s) in {len({p['path'] for p in places})} file(s) rustfmt would change"
    if errors:
        return r("UNKNOWN", failures=names, note=f"rustfmt could not read every file: {errors[0][:300]}" + (f"; {found}" if places else ""))
    if not targets:
        said = next((line.strip() for line in lines if line.strip()), "no output")
        return r("UNKNOWN", note=f"exit {exit_code}, and cargo fmt listed no target root, so it checked nothing: {said[:300]}")
    if exit_code == "0" and not places:
        return r("PASS", len(targets), note=f"{len(targets)} target root(s), formatted")
    if exit_code != "1" or not places:
        return r("UNKNOWN", failures=names, note=f"exit {exit_code} with {found}")
    # Each place is upstream's own or a fork change's, by the same run at the upstream base.
    at = "the upstream base" + ("" if base_sha == "-" else f" `{base_sha[:12]}`")
    found += f", from {len(targets)} target root(s)"
    if base_exit == "absent":
        return r("FAIL", failures=names, note=f"{found}, each a fork change's: {at} has no {unit}")
    why, bgot, fork = None, None, None
    if base_exit == "-":
        said = [line.strip() for line in read_lines(base_log) or () if line.strip()]
        why = "it was not set up: " + (said[-1][:200] if said else "no log")
    else:
        bgot = read_rustfmt(base_log, base_tree)
        fork = read_fork_diff(fork_diff)
        if bgot is None:
            why = "no log"
        elif stopped(base_exit):
            why = f"exit {base_exit}: the time bound or a signal ended it"
        elif bgot[2]:
            why = f"rustfmt could not read every file there: {bgot[2][0][:200]}"
        elif not bgot[0]:
            why = "cargo fmt listed no target root there"
        elif not bgot[3]:
            why = "its run named no file it checked (rustfmt's own -v)"
        elif (base_exit, bool(bgot[1])) not in (("0", False), ("1", True)):
            why = f"exit {base_exit} with {len(bgot[1])} place(s) there"
        elif fork is None:
            why = "no diff of the fork's changes from it"
    if why:
        return r("UNKNOWN", unsorted=[(n, f"{at} could not be read: {why}") for n in names],
                 note=f"{found}, none sorted into upstream's own or the fork's: {at} could not be read ({why})")
    upstream, mine, unsorted = sort_rustfmt_places(places, bgot[1], bgot[3], fork, tree, base_tree, tree_checked)
    told = f"{len(mine)} a fork change's, {len(upstream)} upstream's own (the same run fails at {at} on the lines the fork left as they are)"
    if unsorted:
        told += f", {len(unsorted)} unsorted"
    if mine:
        return r("FAIL", failures=mine, upstream=upstream, unsorted=unsorted, note=f"{found}: {told}")
    if unsorted:
        return r("UNKNOWN", upstream=upstream, unsorted=unsorted, note=f"{found}: {told}")
    return r("KNOWN", upstream=upstream, note=f"{found}, each upstream's own: the same run fails at {at} on the lines the fork left as they are")


def rustfmt_plant_target(meta, tree):
    """Where the rustfmt plant goes in one workspace (META: its `cargo metadata --no-deps`): the root
    source file of its first library or binary target, by manifest path, a library first (in this
    tree, pi-ast's lib.rs for the root workspace, outside rustfmt.toml's ignore), relative to TREE.
    None when it has neither."""
    prefix = tree.rstrip("/") + "/"
    best = None
    for p in meta.get("packages", []):
        for t in p.get("targets", []):
            kinds = set(t.get("kind", []))
            rank = 0 if kinds & {"lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"} else 1 if "bin" in kinds else None
            if rank is not None:
                key = (p.get("manifest_path", ""), rank, t.get("src_path", ""))
                best = key if best is None or key < best else best
    if best is None:
        return None
    return best[2][len(prefix):] if best[2].startswith(prefix) else best[2]


def plant_rustfmt(tree):
    """The rustfmt row's plant: PLANTS' function line appended to each listed workspace's first
    target root."""
    _, text, _ = PLANTS["rustfmt"]
    workspaces = rustfmt_workspaces()
    if workspaces is None:
        sys.exit(f"::error::no list of cargo workspaces at {RUSTFMT_WORKSPACES_LIST} for the rustfmt plant")
    for m in workspaces:
        try:
            meta = json.loads(subprocess.run(["cargo", "metadata", "--no-deps", "--format-version", "1", "--manifest-path",
                                              os.path.join(tree, m)], capture_output=True, text=True, check=True).stdout)
        except (OSError, subprocess.CalledProcessError, ValueError) as e:
            sys.exit(f"::error::cargo metadata of {m} failed, so the rustfmt plant has no place there: {e}")
        path = rustfmt_plant_target(meta, tree)
        if path is None:
            sys.exit(f"::error::{m} has no library or binary target for the rustfmt plant")
        p = os.path.join(tree, path)
        body = open(p, encoding="utf-8").read()
        # A blank line first, so that a last line rustfmt would change too stays a place of its own.
        body += ("" if body.endswith("\n") else "\n") + "\n" + text + "\n"
        open(p, "w", encoding="utf-8").write(body)
        print(f"PLANT rustfmt: {m}: {path}:{body.count(chr(10))}: {text}")


# A TOML table header (`[a.b]` or `[[a]]`), its name stripped.
TOML_HEADER = re.compile(r"^\s*\[{1,2}\s*([^\[\]]+?)\s*\]{1,2}\s*(?:#.*)?$")


def builtins_lint_lift_manifest(text):
    """A crate manifest's TEXT with its own lint levels replaced by the workspace's, the levels every
    other crate of the workspace takes: each [lints] table (`[lints]`, `[lints.<tool>]`) left out, and
    `[lints] workspace = true` added. None unless the result reads as TOML, sets lints to
    {workspace = true} and keeps every other key of TEXT as it was."""
    out, skip = [], False
    for line in text.splitlines():
        h = TOML_HEADER.match(line)
        if h:
            name = h.group(1).replace(" ", "")
            skip = name == "lints" or name.startswith("lints.")
        if not skip:
            out.append(line)
    new = "\n".join(out).rstrip("\n") + "\n\n[lints]\nworkspace = true\n"
    try:
        before, after = tomllib.loads(text), tomllib.loads(new)
    except tomllib.TOMLDecodeError:
        return None
    before.pop("lints", None)
    lints = after.pop("lints", None)
    return new if lints == {"workspace": True} and after == before else None


def builtins_lint_lift_rustfmt(text, files):
    """rustfmt.toml's TEXT with each `ignore` pattern that holds one of FILES (paths relative to the
    file's directory) left out, the key too when none is left: (the new text, the patterns left out),
    or (TEXT, []) when no pattern holds one. A pattern holds a file when it matches it as a glob, or
    as a directory the file is under. None unless the result reads as TOML and keeps every other key
    and pattern of TEXT as it was."""
    try:
        before = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None
    pats = before.get("ignore", [])
    if not isinstance(pats, list) or not all(isinstance(p, str) for p in pats):
        return None

    def holds(p):
        return any(fnmatch.fnmatchcase(f, p) or fnmatch.fnmatchcase(f, p.rstrip("/") + "/*") for f in files)

    gone = [p for p in pats if holds(p)]
    if not gone:
        return text, []
    kept = [p for p in pats if p not in gone]
    lines = text.split("\n")
    start = next((i for i, line in enumerate(lines) if re.match(r"^\s*ignore\s*=", line)), None)
    end, depth = None, 0
    for i in range(start if start is not None else len(lines), len(lines)):
        depth += lines[i].count("[") - lines[i].count("]")
        if depth <= 0:
            end = i
            break
    if end is None:
        return None
    new = "\n".join(lines[:start] + ([f"ignore = {json.dumps(kept)}"] if kept else []) + lines[end + 1:])
    try:
        after = tomllib.loads(new)
    except tomllib.TOMLDecodeError:
        return None
    want = {k: v for k, v in before.items() if k != "ignore"}
    if kept:
        want["ignore"] = kept
    return (new, gone) if after == want else None


def cmd_builtins_lint_lift(tree, crate_dir):
    """Lifts the crate at TREE/CRATE_DIR out of its own opt-outs for the builtins-lint row: its
    Cargo.toml's [lints] (builtins_lint_lift_manifest), and each `ignore` pattern that holds one of
    its .rs files in every rustfmt config rustfmt could take for them (builtins_lint_lift_rustfmt):
    `.rustfmt.toml` and `rustfmt.toml` (rustfmt reads the first of the two) in each directory that
    holds a .rs file of the crate or lies above one, up to TREE, each pattern read relative to its
    file's directory. Prints what it changed; stops the job when it cannot, so that the row reads
    UNKNOWN rather than a check of the crate as it opts out. Whether rustfmt then read the crate is
    the rustfmt unit's own check (parse_builtins_rustfmt: each target root named as checked)."""
    if crate_dir == "-":
        sys.exit(f"::error::the tree has no package {BUILTINS_LINT_CRATE} to lift")
    manifest = os.path.join(tree, crate_dir, "Cargo.toml")
    new = builtins_lint_lift_manifest(open(manifest, encoding="utf-8").read())
    if new is None:
        sys.exit(f"::error::{crate_dir}/Cargo.toml: its [lints] could not be replaced by `[lints] workspace = true`")
    open(manifest, "w", encoding="utf-8").write(new)
    print(f"LIFT {crate_dir}/Cargo.toml: [lints] workspace = true, the workspace's lint levels")
    files = sorted(os.path.relpath(os.path.join(dp, f), tree) for dp, _, fs in os.walk(os.path.join(tree, crate_dir))
                   for f in fs if f.endswith(".rs"))
    dirs = set()
    for f in files:
        d = os.path.dirname(f)
        while d not in dirs:
            dirs.add(d)
            if not d:
                break
            d = os.path.dirname(d)
    configs = [os.path.join(d, n) for d in sorted(dirs) for n in (".rustfmt.toml", "rustfmt.toml") if os.path.isfile(os.path.join(tree, d, n))]
    if not configs:
        print(f"LIFT rustfmt: no rustfmt config at or above {crate_dir}")
    for config in configs:
        here = os.path.dirname(config)
        got = builtins_lint_lift_rustfmt(open(os.path.join(tree, config), encoding="utf-8").read(),
                                         [os.path.relpath(f, here or ".") for f in files])
        if got is None:
            sys.exit(f"::error::{config}: the ignore patterns that hold {crate_dir} could not be left out")
        new, gone = got
        if gone:
            open(os.path.join(tree, config), "w", encoding="utf-8").write(new)
            print(f"LIFT {config}: ignore no longer holds {', '.join(gone)}")
        else:
            print(f"LIFT {config}: no ignore pattern holds {crate_dir}")


def read_dep_info(path, target):
    """The files a rustc dep-info file (PATH) names as TARGET's prerequisites, from its rule for a
    file of TARGET's name; None when it cannot be read or has no such rule."""
    lines = read_lines(path)
    if lines is None:
        return None
    name = os.path.basename(target)
    for line in lines:
        head, sep, rest = line.partition(": ")
        if sep and os.path.basename(head) == name:
            return [p.replace("\\ ", " ") for p in re.split(r"(?<!\\) ", rest.strip()) if p]
    return None


def lint_read(log, tree, crate_dir):
    """What one `cargo clippy --message-format=json` of the crate in CRATE_DIR says, run under TREE
    with every lint capped at warn: (findings, errors, the files rustc read, unread line numbers), or
    None when there is no log. A finding is a warning with a code and a primary span in a file under
    CRATE_DIR, a dict: path, line and end (its first primary span's first and last lines), col, code,
    message, and spans (each primary span as [path, first line, last line, column]: a lint can mark
    more than one place); the same finding in two of the crate's targets (the library and its tests)
    is one. An error is any message at an error level: with every lint a warning, the compiler's own.
    The files
    rustc read are those under CRATE_DIR that the dep-info of each compiled target of the crate names
    (cargo's compiler-artifact names its .rmeta; rustc writes the .d beside it), relative to TREE: the
    files it linted. None when no target of the crate was compiled, or one's dep-info cannot be read."""
    got = cargo_messages(log)
    if got is None:
        return None
    events, unread = got
    prefix = os.path.realpath(tree).rstrip("/") + "/"
    crate = crate_dir.rstrip("/") + "/"
    manifest = os.path.realpath(os.path.join(tree, crate_dir, "Cargo.toml"))

    def rel(p):
        if os.path.isabs(p):
            p = os.path.realpath(p)
            return p[len(prefix):] if p.startswith(prefix) else p
        return os.path.normpath(p)

    findings, seen, errors, read, targets, unreadable = [], set(), [], set(), 0, False
    for ev in events:
        if ev.get("reason") == "compiler-artifact" and os.path.realpath(ev.get("manifest_path") or "/") == manifest:
            targets += 1
            rmeta = next((f for f in ev.get("filenames") or () if os.path.basename(f).startswith("lib") and f.endswith(".rmeta")), None)
            dep = None if rmeta is None else read_dep_info(os.path.join(os.path.dirname(rmeta), os.path.basename(rmeta)[3:-6] + ".d"), rmeta)
            if dep is None:
                unreadable = True
            else:
                read.update(rel(p) for p in dep)
        if ev.get("reason") != "compiler-message":
            continue
        m = ev.get("message") or {}
        level = m.get("level") or ""
        if level.startswith("error"):
            said = (m.get("rendered") or m.get("message") or level).strip()
            errors.append(said.splitlines()[0] if said else level)
            continue
        code = (m.get("code") or {}).get("code")
        primary = [s for s in m.get("spans") or () if s.get("is_primary")]
        if level != "warning" or not code or not primary:
            continue
        spans = tuple((rel(s["file_name"]), s["line_start"], s["line_end"], s["column_start"]) for s in primary)
        key = (spans, code, m.get("message", ""))
        if spans[0][0].startswith(crate) and key not in seen:
            seen.add(key)
            findings.append(dict(zip(("path", "line", "end", "col"), spans[0]), code=code, message=key[2], spans=[list(s) for s in spans]))
    linted = None if unreadable or not targets else {p for p in read if p.startswith(crate) and p.endswith(".rs")}
    return findings, errors, linted, unread


def sort_lint_findings(findings, base_findings, base_linted, fork, base_tree):
    """Each clippy finding of the tree as upstream's own, the fork's, or unsorted with the reason, as
    sort_rustfmt_places sorts rustfmt's places: ([upstream's], [the fork's], [(finding, why)]). A
    finding in a file the base lacks is the fork's. Elsewhere its file must be one the base's run
    linted (BASE_LINTED, from its dep-info) and one the fork's diff names (FORK), or it is unsorted.
    It is upstream's own when every line of each of its primary spans is a line of the base the fork
    left as it is, and the base has the same finding (lint, message, each span's column) at the lines
    they map to; one on a line the fork changed or added is the fork's, and so is one on unchanged
    lines the base lacks (a fork change elsewhere, as in a type or a lint level, brought it). A
    primary span outside the crate is unsorted: the base's run is not read there."""
    at_base = {(tuple((p, line, col) for p, line, _, col in f["spans"]), f["code"], f["message"]) for f in base_findings}
    upstream, mine, unsorted = [], [], []
    for f in findings:
        mapped, fork_own, why = [], False, None
        for path, first, last, col in f["spans"]:
            if not os.path.exists(os.path.join(base_tree, path)):
                fork_own = True
            elif path not in base_linted:
                why = why or f"the upstream base's run did not lint {path}"
            elif path not in fork:
                why = why or f"no diff of {path} from the upstream base"
            else:
                lines = [base_line(fork[path], n) for n in range(first, last + 1)]
                if None in lines or lines != list(range(lines[0], lines[0] + len(lines))):
                    fork_own = True
                else:
                    mapped.append((path, lines[0], col))
        if fork_own:
            mine.append(f)
        elif why:
            unsorted.append((f, why))
        elif (tuple(mapped), f["code"], f["message"]) in at_base:
            upstream.append(f)
        else:
            mine.append(f)
    return upstream, mine, unsorted


def lint_breakdown(mine, upstream, unsorted):
    """The count of findings by lint and by file, each [the fork's, upstream's own, unsorted]:
    {"by_lint": {lint: counts}, "by_file": {path: counts}}. Each argument is a list of (path, lint);
    a lint of None is counted by its file only."""
    out = {"by_lint": {}, "by_file": {}}
    for i, group in enumerate((mine, upstream, unsorted)):
        for path, lint in group:
            out["by_file"].setdefault(path, [0, 0, 0])[i] += 1
            if lint is not None:
                out["by_lint"].setdefault(lint, [0, 0, 0])[i] += 1
    return out


def parse_builtins_clippy(log, exit_code, secs, tree, crate_dir, base_log="-", base_exit="-", base_tree="-", base_sha="-",
                          fork_diff="-", row="builtins-lint"):
    """The builtins-lint row's clippy unit: `cargo clippy --all-targets --no-deps --keep-going
    --message-format=json -- --cap-lints warn` of the crate in CRATE_DIR (LOG, its stdout and stderr),
    run under TREE with the crate's [lints] lifted to the workspace's, against the same run at the
    tree's upstream base (BASE_LOG and BASE_EXIT, run under BASE_TREE, the merge base BASE_SHA;
    BASE_EXIT `absent` when the base has no CRATE_DIR, `-` when the base could not be set up and
    BASE_LOG is then the setup's log) and the fork's changes from the base (FORK_DIFF), as
    parse_rustfmt reads its places. Each finding (lint_read) is upstream's own, the fork's or unsorted
    (sort_lint_findings), each named `path:line:col: lint: message (the line's text)`. FAIL names
    each of the fork's and lists the others; KNOWN is a crate whose every finding is upstream's own;
    PASS needs exit 0, a compiled target and no finding, and reads no base. Anything else is UNKNOWN:
    no package, no log, the time bound or a signal, a log line that does not parse, a compile error or
    an exit other than 0 (its targets were not all linted), no dep-info of a compiled target, or
    findings with no clean read of the base or of the fork's diff to sort them by, or in a file the
    base did not lint. The result also counts the findings by lint and by file (breakdown)."""
    lines_of = {}

    def name(f):
        if f["path"] not in lines_of:
            lines_of[f["path"]] = (read_lines(os.path.join(tree, f["path"])) or [])
        src = lines_of[f["path"]]
        text = src[f["line"] - 1].strip() if 0 < f["line"] <= len(src) else ""
        return (f"{f['path']}:{f['line']}:{f['col']}: {f['code']}: {f['message'][:200]}" + (f" ({text[:120]})" if text else "")).replace("`", "'")

    def r(status, mine=(), upstream=(), unsorted=(), note=""):
        res = result(row, "clippy", "runner", status, exit_code, secs, failed=len(mine), failures=[name(f) for f in mine], note=note)
        res["upstream_places"] = [name(f) for f in upstream]
        res["unsorted_places"] = [f"{name(f)} ({why})".replace("`", "'") for f, why in unsorted]
        res["upstream_base"] = "" if base_sha == "-" else base_sha
        if mine or upstream or unsorted:
            res["breakdown"] = lint_breakdown(*[[(f["path"], f["code"]) for f in g] for g in (mine, upstream, [f for f, _ in unsorted])])
        return res

    if crate_dir == "-":
        return r("UNKNOWN", note=f"the tree has no package {BUILTINS_LINT_CRATE}")
    got = lint_read(log, tree, crate_dir)
    if got is None:
        return r("UNKNOWN", note="no log")
    if stopped(exit_code):
        return r("UNKNOWN", note=f"exit {exit_code}: the time bound or a signal ended it")
    findings, errors, linted, unread = got
    found = f"{len(findings)} finding(s) in {len({f['path'] for f in findings})} file(s)"
    if unread:
        return r("UNKNOWN", unsorted=[(f, "its log is unread in part") for f in findings],
                 note=f"log line(s) {', '.join(map(str, unread[:12]))} look like cargo messages and do not parse, so their findings are unread; {found}")
    if errors or exit_code != "0":
        return r("UNKNOWN", unsorted=[(f, "the crate's targets did not all compile") for f in findings],
                 note=f"exit {exit_code} with {len(errors)} error(s), so the crate's targets were not all linted (every lint is "
                      f"capped at warn, so an error is the compiler's own): {(errors or ['no error message'])[0][:300]}; {found}")
    if not linted:
        return r("UNKNOWN", unsorted=[(f, "what clippy read is unknown") for f in findings],
                 note=f"exit 0, but no compiled target of {crate_dir} has a dep-info file that can be read, or one that names a "
                      f"file of the crate, so what clippy read is unknown; {found}")
    if not findings:
        return r("PASS", note=f"{len(linted)} file(s) linted at the workspace's lint levels, no finding")
    at = "the upstream base" + ("" if base_sha == "-" else f" `{base_sha[:12]}`")
    found += f", {len(linted)} file(s) linted"
    if base_exit == "absent":
        return r("FAIL", mine=findings, note=f"{found}, each a fork change's: {at} has no {crate_dir}")
    why, bgot, fork = None, None, None
    if base_exit == "-":
        said = [line.strip() for line in read_lines(base_log) or () if line.strip()]
        why = "it was not set up: " + (said[-1][:200] if said else "no log")
    else:
        bgot = lint_read(base_log, base_tree, crate_dir)
        fork = read_fork_diff(fork_diff)
        if bgot is None:
            why = "no log"
        elif stopped(base_exit):
            why = f"exit {base_exit}: the time bound or a signal ended it"
        elif bgot[3]:
            why = f"log line(s) {', '.join(map(str, bgot[3][:12]))} there do not parse"
        elif bgot[1] or base_exit != "0":
            why = f"exit {base_exit} with {len(bgot[1])} error(s) there: {(bgot[1] or ['no error message'])[0][:200]}"
        elif bgot[2] is None:
            why = "no compiled target of the crate there has a dep-info file that can be read"
        elif fork is None:
            why = "no diff of the fork's changes from it"
    if why:
        return r("UNKNOWN", unsorted=[(f, f"{at} could not be read") for f in findings],
                 note=f"{found}, none sorted into upstream's own or the fork's: {at} could not be read ({why})")
    upstream, mine, unsorted = sort_lint_findings(findings, bgot[0], bgot[2], fork, base_tree)
    told = f"{len(mine)} a fork change's, {len(upstream)} upstream's own (the same finding at {at} on the lines the fork left as they are)"
    if unsorted:
        told += f", {len(unsorted)} unsorted"
    return r("FAIL" if mine else "UNKNOWN" if unsorted else "KNOWN", mine, upstream, unsorted, f"{found}: {told}")


def parse_builtins_rustfmt(log, exit_code, secs, tree, crate_dir, base_log="-", base_exit="-", base_tree="-", base_sha="-",
                           fork_diff="-", row="builtins-lint"):
    """The builtins-lint row's rustfmt unit: `cargo fmt --manifest-path CRATE_DIR/Cargo.toml --check -v
    -- -v` (LOG), run under TREE with rustfmt.toml's ignore of the crate lifted, read and sorted by the
    rustfmt row's own reading (parse_rustfmt, the same arguments), and counted by file (breakdown).
    It is UNKNOWN too when rustfmt's -v does not name each target root cargo listed as a file it
    checked: an ignore of a config the lift did not reach still holds the crate, and rustfmt then
    passes a file it never read. The places of an UNKNOWN unit are listed unsorted, never failed."""
    if crate_dir == "-":
        res = result(row, "rustfmt", "runner", "UNKNOWN", exit_code, secs, note=f"the tree has no package {BUILTINS_LINT_CRATE}")
        res.update(upstream_places=[], unsorted_places=[], upstream_base="")
        return res
    res = parse_rustfmt(f"{crate_dir}/Cargo.toml", log, exit_code, secs, tree, base_log, base_exit, base_tree, base_sha, fork_diff, row=row)
    res["unit"] = "rustfmt"
    got = read_rustfmt(log, tree)
    unread = [t for t in got[0] if t not in got[3]] if got else []
    if res["status"] != "UNKNOWN" and unread:
        res.update(status="UNKNOWN", note=f"rustfmt did not check the target root(s) {', '.join(unread)} (an ignore the lift did not "
                                          f"reach still holds them), so the crate was not checked: {res['note']}")
    if res["status"] == "UNKNOWN" and res["failures"]:
        res["unsorted_places"] = res["unsorted_places"] + [f"{n} (the unit is UNKNOWN)" for n in res["failures"]]
        res.update(failures=[], failed=0)
    if res["failures"] or res["upstream_places"] or res["unsorted_places"]:
        res["breakdown"] = lint_breakdown(*[[(n.split(":", 1)[0], None) for n in res[k]] for k in ("failures", "upstream_places", "unsorted_places")])
    return res


def cmd_builtins_lint_files(tree, crate_dir, clippy_log, fmt_log):
    """`clippy<TAB>file` for each file under CRATE_DIR with a clippy finding, then `rustfmt<TAB>file`
    for each with a place rustfmt would change: the files whose diff from the upstream base the row
    records (builtins-lint.sh)."""
    got = lint_read(clippy_log, tree, crate_dir) if crate_dir != "-" else None
    # Each file a primary span of a finding names, in the crate (a lint can mark places in two files).
    for f in sorted({s[0] for x in got[0] for s in x["spans"] if s[0].startswith(crate_dir.rstrip("/") + "/")} if got else ()):
        print(f"clippy\t{f}")
    fgot = read_rustfmt(fmt_log, tree) if crate_dir != "-" else None
    for f in sorted({p["path"] for p in fgot[1]} if fgot else ()):
        print(f"rustfmt\t{f}")


def plant_builtins_lint(tree):
    """The builtins-lint row's plant: BUILTINS_LINT_PLANT_LINES appended to pi-builtins' library root,
    after a blank line and a blank line apart, so that each is a place of its own."""
    path = PLANTS["builtins-lint"][0]
    p = os.path.join(tree, path)
    body = open(p, encoding="utf-8").read()
    body += ("" if body.endswith("\n") else "\n") + "\n" + "\n\n".join(BUILTINS_LINT_PLANT_LINES) + "\n"
    open(p, "w", encoding="utf-8").write(body)
    n = body.count("\n")
    print(f"PLANT builtins-lint: {path}:{n - 2}: {BUILTINS_LINT_PLANT_LINES[0]}")
    print(f"PLANT builtins-lint: {path}:{n}: {BUILTINS_LINT_PLANT_LINES[1]}")


# The bazel-lock row (bazel-lock.sh): the tree's own `bun scripts/gen-bazel-lock.ts --check`, which
# runs `bazelisk fetch --repo=@crates --lockfile_mode=error`, in the fixed environment of
# .github/sami/bazel-lock.sh (the one sami-build.yml's bazel_lock regenerates the lock in). The lock
# stores the result of rules_rust's crate extension with each input it read: every Cargo file by its
# sha256 (`FILE:@@//<path> <sha256>`), the environment variables it read (`ENV:`) and repository
# mappings. In error mode Bazel names why the lock is stale: the extension's own .bzl files, its
# usages in MODULE.bazel, and the first recorded input that differs, joined by commas. The row fails
# only when Bazel names a file of the tree (`file info or contents of @@//<path> changed`): a lock
# the cut did not regenerate. Any other reason (an environment variable above all: the lock records
# eight, CARGO_BAZEL_* and REPIN, and .bazelrc imports an optional .bazelrc.user) is no fault the row
# can call, so it reads UNKNOWN with Bazel's words. A failure names every file whose sha256 differs
# from the lock's record of it, read from the tree, not only the first one Bazel names.
BAZEL_LOCK_UNIT = "MODULE.bazel.lock"
BAZEL_LOCK_STALE = re.compile(r"^ERROR: MODULE\.bazel\.lock is no longer up-to-date because (.*)\. Please run "
                              r"`bazel mod deps --lockfile_mode=update` to update your lockfile\.$", re.M)
BAZEL_LOCK_FILE = re.compile(r"file info or contents of @@//(\S+) changed")
BAZEL_LOCK_CURRENT = re.compile(r"^MODULE\.bazel\.lock is up to date\.$", re.M)
ANSI_SGR = re.compile(r"\x1b\[[0-9;]*m")


def bazel_lock_inputs(tree):
    """[(path, the sha256 the lock records, the file's sha256 or None when it is missing)] for each file
    of the tree an extension's entry in TREE/MODULE.bazel.lock records, in the lock's order; None when
    the lock does not read as JSON."""
    try:
        lock = json.load(open(os.path.join(tree, "MODULE.bazel.lock"), encoding="utf-8"))
    except (OSError, ValueError):
        return None
    out = []
    for ext in (lock.get("moduleExtensions") or {}).values() if isinstance(lock, dict) else ():
        for entry in (ext or {}).values():
            for item in (entry or {}).get("recordedInputs") or []:
                if not (isinstance(item, str) and item.startswith("FILE:@@//")):
                    continue
                path, _, recorded = item[len("FILE:@@//"):].partition(" ")
                try:
                    with open(os.path.join(tree, path), "rb") as f:
                        actual = hashlib.sha256(f.read()).hexdigest()
                except OSError:
                    actual = None
                out.append((path, recorded, actual))
    return out


def parse_bazel_lock(log, exit_code, secs, tree, row="bazel-lock", unit=BAZEL_LOCK_UNIT):
    """`bun scripts/gen-bazel-lock.ts --check` in TREE (LOG, its stdout and stderr, exit EXIT_CODE).
    PASS when Bazel reads the lock current and each file the lock records is as recorded (at least one).
    FAIL when Bazel reads it stale and names a file of the tree: each file whose sha256 differs from the
    lock's record of it, the one Bazel names marked. UNKNOWN for anything else, Bazel's words named:
    stale for no file (an environment variable, the extension's definition or usages), current while
    a recorded file differs, no file recorded, no log, the time bound, or an end with neither answer."""
    def r(status, note, passed=0, failures=()):
        return result(row, unit, "runner", status, exit_code, secs, passed, len(failures), failures=failures, note=note)

    try:
        text = ANSI_SGR.sub("", open(log, encoding="utf-8", errors="replace").read())
    except OSError:
        return r("UNKNOWN", "no log of the check")
    if stopped(exit_code):
        return r("UNKNOWN", f"exit {exit_code}: the time bound or a signal ended the check")
    inputs = bazel_lock_inputs(tree)
    if inputs is None:
        return r("UNKNOWN", "the tree's MODULE.bazel.lock does not read as JSON, so its record could not be compared")
    differ = [(p, rec, act) for p, rec, act in inputs if act != rec]
    stale = BAZEL_LOCK_STALE.search(text)
    if exit_code == "0" and not stale and BAZEL_LOCK_CURRENT.search(text):
        if not inputs:
            return r("UNKNOWN", "Bazel reads the lock current, and it records no file of the tree, so no file was compared")
        if differ:
            return r("UNKNOWN", "Bazel reads the lock current, and its record of " + ", ".join(p for p, _, _ in differ)
                     + " differs from the file: the two readings disagree")
        return r("PASS", f"current: Bazel reads each recorded input as it is, and each of the {len(inputs)} files the lock "
                 "records is as recorded", passed=len(inputs))
    if stale:
        reason = stale.group(1)
        named = BAZEL_LOCK_FILE.findall(reason)
        if named:
            fails = [f"@@//{p}: the lock records sha256 {rec[:12]}, the file " + (f"is {act[:12]}" if act else "is missing")
                     + ("; Bazel names it" if p in named else "") for p, rec, act in differ]
            fails += [f"@@//{p}: Bazel names it, and the lock's record of it is as the file is" for p in named
                      if p not in {q for q, _, _ in differ}]
            return r("FAIL", f"stale: Bazel says {reason}; the lock's record differs from the file for {len(differ)} of the "
                     f"{len(inputs)} files it records", passed=len(inputs) - len(differ), failures=fails)
        also = ("; the lock's record also differs from the file for " + ", ".join(p for p, _, _ in differ)) if differ else ""
        return r("UNKNOWN", f"Bazel reads the lock stale and names no file of the tree: {reason}. That is an environment "
                 f"variable, a repository mapping, or the extension's definition or usages, none of which this row calls a fault{also}")
    said = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("gen-bazel-lock:")]
    err = next((ln for ln in said if ln.startswith(("ERROR:", "FATAL:"))), said[-1] if said else "no output")
    return r("UNKNOWN", f"exit {exit_code}, and Bazel neither read the lock current nor said why it is stale: {err[:300]}")


def plant_bazel_lock(tree):
    """The bazel-lock row's plant: its line appended to the root Cargo.toml, which the lock records."""
    path, text, _ = PLANTS["bazel-lock"]
    p = os.path.join(tree, path)
    body = open(p, encoding="utf-8").read()
    body += ("" if body.endswith("\n") else "\n") + text + "\n"
    open(p, "w", encoding="utf-8").write(body)
    print(f"PLANT bazel-lock: {path}:{body.count(chr(10))}: {text}")


def cmd_plant(what, tree):
    """Puts a row's planted fault (PLANTS) in TREE and prints where."""
    if what == "rustfmt":
        return plant_rustfmt(tree)
    if what == "builtins-lint":
        return plant_builtins_lint(tree)
    if what == "bazel-lock":
        return plant_bazel_lock(tree)
    path, text, _ = PLANTS[what]
    p = os.path.join(tree, path)
    lines = open(p, encoding="utf-8").read().split("\n")
    if what == "docs":
        at, new = next((i for i, line in enumerate(lines) if line.startswith("pub mod ")), None), [text]
    elif what == "membench":
        # After the line that makes the shell's kernel, at that line's indent.
        at = next((i + 1 for i, line in enumerate(lines) if MEMBENCH_PLANT_AT in line), None)
        new = [] if at is None else [lines[at - 1][:len(lines[at - 1]) - len(lines[at - 1].lstrip())] + text]
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
        sys.exit(summary_main(a))
    elif c == "unreadable-pass":
        cmd_unreadable_pass(*a)
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
    elif c == "rustfmt-workspaces":
        ws = rustfmt_workspaces()
        if ws is None:
            sys.exit(f"::error::no list of cargo workspaces at {RUSTFMT_WORKSPACES_LIST}")
        print("\n".join(ws))
    elif c == "rustfmt":
        print(json.dumps(parse_rustfmt(*a)))
    elif c == "membench-bin":
        exe = bench_executable(a[0])
        if exe is None:
            sys.exit(f"cargo named no executable of the memory bench in {a[0]}")
        print(exe)
    elif c == "membench":
        print(json.dumps(parse_membench(*a)))
    elif c == "builtins-lint-lift":
        cmd_builtins_lint_lift(*a)
    elif c == "builtins-lint-files":
        cmd_builtins_lint_files(*a)
    elif c == "builtins-clippy":
        print(json.dumps(parse_builtins_clippy(*a)))
    elif c == "builtins-rustfmt":
        print(json.dumps(parse_builtins_rustfmt(*a)))
    elif c == "plant":
        cmd_plant(*a)
    elif c == "bazel-lock":
        print(json.dumps(parse_bazel_lock(*a)))
    elif c == "previous-report":
        previous_report(*a)
    elif c == "rust-findings":
        cmd_rust_findings(*a)
    elif c == "selftest":
        selftest()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
