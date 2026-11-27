#!/usr/bin/env bash
# The test step of the rust_test jobs in .github/workflows/sami-rust-test.yml,
# which sami-checks.yml runs on each release candidate: a red Rust test is
# reported there, and holds no release.
#
# On Linux (the rust_test job) it runs every Bazel test target under
# //crates (doctests too) and every test target of the cargo workspaces
# Bazel does not build, reads each test log, and fails when:
#   - a test fails that .github/sami/rust-test-known-failures.txt does not
#     name, or a test it names does not fail;
#   - a target fails to build or has no result, or its test binary ends
#     before its tests do;
#   - a test skips itself or prints (see "Skips" below), unless a list names
#     it; a doctest prints or skips in its source (see "Skips");
#   - a test of a test binary runs in no invocation (a filter in its target's
#     args, or a skip this script passes, took it out), unless
#     .github/sami/rust-test-sanctioned-skips.txt names it;
#   - an #[ignore]d test runs nowhere: each one is run alone with --ignored
#     (.github/sami/rust-test-ignored.txt, a Bazel target or a cargo one; a
#     Bazel one whose reason starts `opt: ` in a -c opt build; or
#     as root .github/sami/rust-test-ignored-root.txt), or is a child
#     process's entry point that another test starts
#     (.github/sami/rust-test-child-entries.txt, whose line names each
#     starting test, and fails when one of them is no test of the binary),
#     or runs in the macOS job (.github/sami/rust-test-macos.txt);
#   (An ```ignore doc block is not a test: upstream marks it so that rustdoc
#   never runs it. It counts neither as run nor against the job; the step
#   prints how many there are and where.)
#   - a test named in .github/sami/rust-test-own-process.txt does not run
#     alone in an invocation of its own, or also runs in the main one;
#   - a test named in .github/sami/rust-test-root-alone.txt does not run alone
#     as root, or also runs in the main one, or prints `UNKNOWN:` as root;
#   - a target in .github/sami/rust-test-root-targets.txt prints `not run:`,
#     or passes another number of tests than its line names;
#   - a sticky-directory FIFO test (`refused_in_a_sticky_directory` in its
#     name) does not run alone twice, as the runner's user given the FIFO
#     RUST_TEST_STICKY_FIFO names and as root, or prints there (`UNKNOWN:`,
#     it checked nothing).
# It leaves each test binary's listing in $RUNNER_TEMP/rust-test/listings
# (index.tsv names the binary of each), which sami-checks.yml's
# rust-test-drift job compares with the early listings the macOS job's
# inventory read (.github/sami/rust-test-listings-drift.sh), and cargo's
# --timings report of each cargo test in $RUNNER_TEMP/rust-test/cargo-timings,
# with each one's build and test seconds in the job log and the step summary,
# and every test's result in $RUNNER_TEMP/rust-test/results/results.tsv, which
# sami-checks.yml's rust-test-compare job reads to check that a run from a
# build seed and a cold run of one commit agree test by test.
# With RUST_TEST_ONLY naming a list (the macOS job names that inventory), it
# runs only the tests that list names, each target once with --exact, and
# fails unless each of them ran here; the failure, skip and output rules are
# the same.
#
# Skips. libtest has no outcome for a test that skips itself: such a test
# returns early, and passes. So a test that cannot run here prints the marker
# `skipped: <reason>` and returns, and this script reads what passing tests
# print (every invocation passes --show-output, which puts it in libtest's
# record):
#   - a passing test whose output has a line that starts with the marker, or
#     with a word the tree's tests used before it (`skipping`, `SKIP`,
#     `not run`, `UNCOMPARED`), alone or after `<test name>: `, skipped
#     itself. It fails the job unless .github/sami/rust-test-known-skips.txt
#     names it; that list is empty. The same line outside libtest's record (a
#     write to the inherited stderr) must name its test, and counts the same.
#   - any other passing test that prints anything fails the job unless
#     .github/sami/rust-test-known-output.txt names it, since its output can be
#     a skip in other words ("nothing to test").
#   - with no passing test's output in any record, the scan could not have
#     seen a skip, and the job fails as UNKNOWN. With RUST_TEST_ONLY, the test
#     RUST_TEST_CANARY names (one that always prints) runs too, and must print.
# A test that returns early and prints nothing passes here: no reading of
# the logs can tell it from a test that ran. Every test that can skip prints
# the marker; one that returns silently is a defect of that test, fixed in it.
#
# Doctests. On Linux they run only in Bazel's doctest targets, whose runner
# shows no passing doctest's output, so the scan above cannot read it, and
# their source is read instead, with no build
# (.github/sami/rust-test-doctest-forms.awk): a line of a doctest rustdoc
# runs that holds the word print, println, eprint, eprintln, dbg, stdout or
# stderr, or one of the skip words, fails the job, named by file and line,
# and so does doc text the reader does not read. Every doctest Bazel ran
# must be one the reader found at its file and line, and every doctest the
# reader found must be one Bazel ran, or the job fails as UNKNOWN. A
# doctest that a macro of another crate generates is in
# no source file the reader reads; Bazel runs it, and the job fails as
# UNKNOWN for it. The macOS job runs the crates' doctests under cargo, whose
# output the scan reads.
#
# Usage: rust-test.sh, from the repository root, with these set:
#   RUNNER_TEMP         a scratch directory for the event logs and log copies
#   OMP_BAZEL_RC        the bazelrc fragment .github/actions/bazel-cache wrote
#   RUST_TEST_PATH      the tests' PATH (the reference rsync first)
#   RUST_TEST_TMPDIR    a directory on the reflink filesystem; each test action
#                       gets a directory of its own under it, as its TMPDIR
#   PI_TEST_REAL_BASH   the bash 5.2.21 the bash-oracle tests compare with
#   PI_AST_REPO_CORPUS  the checkout pi-ast's corpus test walks
#   RUST_TEST_STICKY_FIFO  (when a sticky-directory FIFO test is in the tree) a
#                       0666 FIFO of a third user in a world-writable sticky
#                       directory root owns, with fs.protected_fifos at 1
# and, for the macOS job, RUST_TEST_ONLY and RUST_TEST_CANARY (above). When
# GITHUB_STEP_SUMMARY is set, the cargo tests' timings go there too. When
# SAMI_FINDINGS is set, each error annotation is also a line of that file
# (.github/sami/findings.sh), and its last line says the script reached its
# end, for sami-checks.yml's first-seen comparison.
# .github/sami/tests/run.sh runs this script against stubs of bazelisk and
# rustup.
set -euo pipefail
# finding, finding_stop and findings_end (SAMI_FINDINGS).
# shellcheck source=.github/sami/findings.sh
. "$(dirname "${BASH_SOURCE[0]}")/findings.sh"

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
	finding_stop "Rust tests" "bash ${BASH_VERSION} is too old: this script needs bash 4 or later"
	exit 1
fi
for v in RUNNER_TEMP OMP_BAZEL_RC RUST_TEST_PATH RUST_TEST_TMPDIR PI_TEST_REAL_BASH PI_AST_REPO_CORPUS; do
	if [ -z "${!v:-}" ]; then
		finding_stop "Rust tests" "$v is not set"
		exit 1
	fi
done
only="${RUST_TEST_ONLY:-}"
if [ -n "$only" ] && [ -z "${RUST_TEST_CANARY:-}" ]; then
	finding_stop "Rust tests" "RUST_TEST_ONLY is set and RUST_TEST_CANARY is not"
	exit 1
fi
if [ "$(ulimit -Sn)" != unlimited ] && [ "$(ulimit -Sn)" -lt 65536 ]; then ulimit -Sn 65536 || true; fi

sami=.github/sami
tmp="$RUNNER_TEMP/rust-test"
mkdir -p "$tmp/logs"
bad=0

# error <title> <message>: an error annotation, recorded (SAMI_FINDINGS); the
# step fails at its end.
error() {
	finding "$1" "$2"
	bad=1
}

# stop <message>: an error annotation, recorded as where the step stopped, and
# the step stops here.
stop() {
	finding_stop "Rust tests" "$1"
	exit 1
}

# count <file>: its lines (wc -l pads its count on macOS).
count() {
	awk 'END { print NR }' "$1"
}

# The one test of a libtest event, for jq: a test event (started, ok,
# failed, ignored or timeout) with a name, a suite event (started, ok or
# failed), or a bench result with a name, a median and a deviation. A line in
# no such shape was written outside the record, whatever type it names.
libtest_event='def libtest_event:
	type == "object"
	and ((.type == "test" and (.name | type) == "string"
			and (.event == "started" or .event == "ok" or .event == "failed" or .event == "ignored" or .event == "timeout"))
		or (.type == "suite" and (.event == "started" or .event == "ok" or .event == "failed"))
		or (.type == "bench" and (.name | type) == "string" and (.median | type) == "number" and (.deviation | type) == "number"));'

# The lists' one reader, list_entries (`<first> <second>  <why>`), shared with
# rust-test-parity.sh and rust-test-macos-inventory.sh.
# shellcheck source=.github/sami/rust-test-lists.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-lists.sh"
# The doctest reader (Linux; see "Doctests" above).
doctest_forms="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/rust-test-doctest-forms.awk"
[ -f "$doctest_forms" ] || stop "$doctest_forms is missing"
# listing_names, the one reading of a binary's `--list`, shared with
# rust-test-early-listings.sh and rust-test-macos-inventory.sh.
# shellcheck source=.github/sami/rust-test-targets.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-targets.sh"

# entries <list> <fields> <tsv>: list_entries of .github/sami/<list>.
entries() {
	list_entries "$sami/$1" "$2" >"$tmp/$3" || stop "$sami/$1 has a malformed line (above)"
}
# marked <list> <marker>: `<first>\t<second>` of each line of .github/sami/<list>
# whose why starts with <marker> (`flaky: `, `opt: `), sorted.
marked() {
	awk -v m="$2" '/^[[:space:]]*(#|$)/ { next }
		{ i = index($0, " "); first = substr($0, 1, i - 1); rest = substr($0, i + 1)
		  j = index(rest, "  "); why = substr(rest, j); sub(/^ +/, "", why)
		  if (index(why, m) == 1) print first "\t" substr(rest, 1, j - 1) }' "$sami/$1" | LC_ALL=C sort -u
}
entries rust-test-known-failures.txt 2 known-failures.tsv
# Flaky entries: a known-failure line whose reason starts with `flaky: `.
# Bazel runs each such target up to 3 times (--flaky_test_attempts, on the
# main and root invocations: the whole target again after an attempt that
# failed) and keeps every attempt's log. The reckoning below the libtest
# logs reads, per flaky test: failed on some attempts and passed on another
# is KNOWN; failed on every attempt is NEW; passed on the first is a pass,
# with a notice. A test with a plain known-failure line, or none, is judged
# as before, on every attempt it failed.
marked rust-test-known-failures.txt 'flaky: ' >"$tmp/flaky.tsv"
# label_regex <label>: a regex that matches exactly the label. A comma
# would split Bazel's filter list; no label of this repository has one.
label_regex() {
	local re="$1" c
	for c in . + '*' '?' '(' ')' '[' ']' '{' '}' '^' '$' '|'; do
		re="${re//"$c"/\\$c}"
	done
	printf '^%s$' "$re"
}
flaky_flags=()
while read -r target; do
	case "$target" in *,*) stop "$target in $sami/rust-test-known-failures.txt has a comma, which --flaky_test_attempts cannot take" ;; esac
	flaky_flags+=(--flaky_test_attempts="$(label_regex "$target")@3")
done < <(cut -f1 "$tmp/flaky.tsv" | LC_ALL=C sort -u)
entries rust-test-known-skips.txt 2 known-skips.tsv
entries rust-test-known-output.txt 2 known-output.tsv
entries rust-test-known-raw-output.txt 2 known-raw-output.tsv
entries rust-test-sanctioned-skips.txt 2 sanctioned.tsv
entries rust-test-own-process.txt 2 own.tsv
entries rust-test-root-alone.txt 2 root-alone.tsv
entries rust-test-root-targets.txt 2 roots.tsv
entries rust-test-cargo-workspaces.txt 1 cargo-workspaces.txt
entries rust-test-ignored.txt 2 ignored-run.tsv
entries rust-test-ignored-root.txt 2 ignored-root.tsv
entries rust-test-child-entries.txt 2 child-entries.tsv
# A child entry's why is `<parent>[ and <parent>...]: <reason>`: each parent
# is the full libtest name of a test of the same binary that starts the child,
# and the accounting below fails when a parent is not in that binary's
# listing (renamed or deleted, it would leave the child running nowhere, with
# nothing to say so). child-parents.tsv holds one line per parent.
awk '
	function malformed(what) {
		printf "%s:%d: %s: %s\n", FILENAME, FNR, what, $0 > "/dev/stderr"
		bad = 1
	}
	/^[[:space:]]*(#|$)/ { next }
	{
		line = $0
		sub(/[[:space:]]+$/, "", line)
		i = index(line, " ")
		target = substr(line, 1, i - 1)
		rest = substr(line, i + 1)
		j = index(rest, "  ")
		child = substr(rest, 1, j - 1)
		why = substr(rest, j)
		sub(/^ +/, "", why)
		k = index(why, ": ")
		if (!k) { malformed("no \"<parent test>: <reason>\" (a child entry names the test that starts it, and why)"); next }
		reason = substr(why, k + 2)
		if (reason ~ /^ *$/) { malformed("no reason after its parent tests"); next }
		n = split(substr(why, 1, k - 1), parents, / and /)
		for (p = 1; p <= n; p++) {
			if (parents[p] !~ /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/) { malformed("\"" parents[p] "\" is no full libtest test name"); next }
		}
		for (p = 1; p <= n; p++) print target "\t" child "\t" parents[p]
	}
	END { exit bad }' "$sami/rust-test-child-entries.txt" >"$tmp/child-parents.tsv" ||
	stop "$sami/rust-test-child-entries.txt has a line without its parent tests or its reason (above)"
entries rust-test-macos.txt 2 macos.tsv
if [ -n "$only" ]; then
	list_entries "$only" 2 >"$tmp/only.tsv" || stop "$only has a malformed line (above)"
	[ -s "$tmp/only.tsv" ] || stop "$only names no test"
fi

# Tests that need root (to chown a file to another uid) are in root targets,
# each tagged no-sandbox, since linux-sandbox maps one uid. They run in a
# second invocation on the same server and cache, the test binary under
# `sudo -E` (GitHub's runner has passwordless sudo); every other target runs
# as the runner's user.
roots=()
declare -A root_tests=()
while IFS=$'\t' read -r target count; do
	case "$count" in *[!0-9]*) stop "$sami/rust-test-root-targets.txt: $target names no number of tests" ;; esac
	roots+=("$target")
	root_tests["$target"]="$count"
done <"$tmp/roots.tsv"
not_roots=()
for target in "${roots[@]}"; do not_roots+=("-$target"); done

# Sanctioned skips (tests the fork's owner ruled out of this gate) and the
# tests that run in a process of their own both reach the main invocation as
# `--skip <path>`. Bazel passes a --test_arg to every test binary, and
# libtest's --exact would also turn pi-builtins_test's own `--skip
# ::foreign_owner::` (its BUILD.bazel) into an exact match, so each skip is
# the test's whole path, and the accounting below checks that it took out
# exactly that one test.
sanctioned=()
own=()
skip_flags=()
while IFS=$'\t' read -r target name; do
	sanctioned+=("$target"$'\t'"$name")
	skip_flags+=(--test_arg=--skip --test_arg="$name")
done <"$tmp/sanctioned.tsv"
while IFS=$'\t' read -r target name; do
	own+=("$target"$'\t'"$name")
	skip_flags+=(--test_arg=--skip --test_arg="$name")
done <"$tmp/own.tsv"
# Tests that are not #[ignore]d but check part of what they test only as
# root (rust-test-root-alone.txt): the main invocation takes them out too,
# and each runs alone as root, out of the sandbox (linux-sandbox maps one
# uid), after the other root runs.
root_alone=()
while IFS=$'\t' read -r target name; do
	root_alone+=("$target"$'\t'"$name")
	skip_flags+=(--test_arg=--skip --test_arg="$name")
done <"$tmp/root-alone.tsv"
# The sticky-directory FIFO tests (pi-shell's and pi-vfs's, with
# `refused_in_a_sticky_directory` in their names) check that the kernel's
# fs.protected_fifos refuses an open that may create of a FIFO another user
# owns in a world-writable sticky directory that user does not own. They need
# such a FIFO, and cannot run in the sandbox: linux-sandbox maps one uid, so
# every other owner reads as the overflow uid there. So the main invocation
# takes them out (libtest's --skip matches a part of the name), and each runs
# alone out of the sandbox twice (below): as the runner's user, given the FIFO
# the job made (RUST_TEST_STICKY_FIFO), and as root, which makes its own.
# Another test with that word in its name is taken out and run the same way;
# one renamed away from it runs in the main invocation, where it prints
# `UNKNOWN:` and fails as any unlisted output does.
sticky_word=refused_in_a_sticky_directory
skip_flags+=(--test_arg=--skip --test_arg="$sticky_word")
# .github/sami/rust-test-ignored.txt names Bazel targets (`//…`) and cargo
# ones (`<directory>:<kind>:<name>`, as the cargo branch below labels them).
# A Bazel one whose reason starts `opt: ` runs in a -c opt build (below).
marked rust-test-ignored.txt 'opt: ' >"$tmp/ignored-opt.tsv"
ignored_run=()
ignored_opt=()
ignored_cargo=()
while IFS=$'\t' read -r target name; do
	case "$target" in
		//*)
			if grep -qxF -- "$target"$'\t'"$name" "$tmp/ignored-opt.tsv"; then
				ignored_opt+=("$target"$'\t'"$name")
			else
				ignored_run+=("$target"$'\t'"$name")
			fi
			;;
		*)
			if grep -qxF -- "$target"$'\t'"$name" "$tmp/ignored-opt.tsv"; then
				stop "$sami/rust-test-ignored.txt: $target $name is a cargo target, and \`opt: \` (a -c opt build) is for a Bazel one"
			fi
			ignored_cargo+=("$target"$'\t'"$name")
			;;
	esac
done <"$tmp/ignored-run.tsv"
ignored_root=()
while IFS=$'\t' read -r target name; do ignored_root+=("$target"$'\t'"$name"); done <"$tmp/ignored-root.tsv"

# PATH: the reference rsync first (the rest is the PATH Bazel's strict action
# env gives a test); RSYNC_REFERENCE_REQUIRED makes an rsync test without it
# fail rather than skip. The tests' temporary files go on the reflink
# filesystem, writable in the sandbox. Bazel drops a TMPDIR that --test_env
# sets (PosixLocalEnvProvider, run 44807499064), so rust-test-tmpdir.sh, as
# --run_under, sets one for each test action.
env_flags=(
	--test_env=PATH="$RUST_TEST_PATH"
	--test_env=RSYNC_REFERENCE_REQUIRED=1
	--test_env=PI_TEST_REAL_BASH="$PI_TEST_REAL_BASH"
	--test_env=PI_AST_REPO_CORPUS="$PI_AST_REPO_CORPUS"
	--sandbox_writable_path="$RUST_TEST_TMPDIR"
)
# The places pi-vcs's #[ignore]d mount and ownership tests need, which only
# root can make: the job makes them under RUST_TEST_TMPDIR and names them.
for var in PI_VCS_TEST_MOUNT_POINT PI_VCS_TEST_MOUNTED_FILE PI_VCS_TEST_FOREIGN_EMPTY_DIR; do
	if [ -n "${!var:-}" ]; then env_flags+=(--test_env="$var=${!var}"); fi
done
tmpdir_under="/bin/sh $PWD/$sami/rust-test-tmpdir.sh $RUST_TEST_TMPDIR"
# sudo resets PATH to its secure_path, so the test's PATH is given again
# after it.
root_under="sudo -E env PATH=$RUST_TEST_PATH $tmpdir_under"
# -Zunstable-options --format=json (the toolchain is nightly, .bazelrc): each
# libtest binary writes its own record to its log, the number of tests it
# plans and then each one's result, so a binary that exits 0 before its tests
# end shows, whatever a child process printed. rules_rust's doctest runner
# passes the arguments on to the doctest binaries and writes libtest's text
# summary itself. --show-output puts each passed test's output in its record.
json_flags=(--test_arg=-Zunstable-options --test_arg=--format=json --test_arg=--show-output)

# Bazel's build event log names every test target with its rule, its status
# and its test.log files: one row per log, with the target, its rule, its
# status, which list Bazel put the log in (passed or failed) and its path.
# The runner's jq is 1.6, which refuses a keyword such as `label` as a
# variable name (run 44696018007).
bep_rows() {
	jq -rs '
		(map(select(.id.targetConfigured))
		 | map({key: .id.targetConfigured.label, value: (.configured.targetKind // "unknown")})
		 | from_entries) as $kinds
		| .[]
		| select(.id.testSummary)
		| .id.testSummary.label as $target
		| ($kinds[$target] // "unknown") as $rule
		| .testSummary.overallStatus as $status
		| ([(.testSummary.passed // [])[] | ["passed", .uri]]
		   + [(.testSummary.failed // [])[] | ["failed", .uri]]) as $logs
		| if ($logs | length) == 0 then [$target, $rule, $status, "none", "-"]
		  else ($logs[] | [$target, $rule, $status, .[0], (.[1] | sub("^file://"; ""))]) end
		| @tsv' "$1"
}

# The rows of every log, one per line, tab-separated: target, rule, status,
# kind (passed, failed or none), the log's copy, the test binary beside the
# original log (bin/ for testlogs/), and the invocation (main, root, own-<n>,
# ignored-<n>, ignored-root-<n>, sticky-user-<n>, sticky-root-<n>,
# root-alone-<n>, ignored-opt-<n>, only-<n>, cargo or ignored-cargo-<n>). An
# empty field is `-`: bash's read joins adjacent tabs.
rows="$tmp/rows.tsv"
: >"$tmp/unbuilt.txt"
: >"$tmp/present.txt"
declare -A absent=()
: >"$rows"
nlog=0
# untangle <label> <log> [doc]: the log, in place, with each libtest event
# that shares a line with output written outside the record moved to a line
# of its own. A test's child process or thread can write a line to the stream
# it inherited in more than one write (Rust's stderr is unbuffered and writes
# a formatted line in pieces), and an event libtest writes between two of
# them starts on that line: in run 44936196181 `pi-builtins_test: invalid
# length: '7` and a test's `ok` event shared a line and the closing `'` came
# two lines later, so the event read as raw output and the binary as ended
# early. The pieces of the raw line are joined again at its next piece outside
# an event. In a doctest run (`doc`: one thread, and a doctest's output is the
# lines between its start and its result), the text before an event is
# that doctest's own, so it goes on a line of its own just before the event.
# When an event moved, the job log shows each line as written, and the log as
# written is kept as <log>.tangled.
untangle() {
	local moved
	moved="$(awk -v out="$2.untangled" -v orig="$2.tangled-lines" -v doc="${3:-}" '
		{
			if (match($0, /\{ "type": "(test|suite|bench)", /) && RSTART > 1 && substr($0, length($0)) == "}") {
				if (doc != "") {
					print held substr($0, 1, RSTART - 1) >out
					held = ""
				} else {
					held = held substr($0, 1, RSTART - 1)
				}
				print substr($0, RSTART) >out
				print >orig
				n++
			} else if ($0 ~ /^\{ "type": "(test|suite|bench)", .*\}$/) {
				print >out
			} else {
				print held $0 >out
				held = ""
			}
		}
		END {
			if (held != "") print held >out
			print n + 0
		}' "$2")"
	if [ "$moved" = 0 ]; then
		rm -f -- "$2.untangled"
		return 0
	fi
	mv -- "$2" "$2.tangled"
	mv -- "$2.untangled" "$2"
	echo "::notice title=Rust tests::$1: $moved libtest events shared a line with output written outside the record, and were moved to lines of their own (the lines as written are below)"
	echo "::group::$1: lines where an event followed other output"
	cat -- "$2.tangled-lines"
	echo "::endgroup::"
	rm -f -- "$2.tangled-lines"
}

# collect <invocation> <event log>: its rows, each log copied to a path of its
# own at once, since a later bazel test of the same target writes its
# test.log to the same path (run 44831606057).
collect() {
	local inv="$1" bep="$2" label rule status kind log copy bin
	if [ ! -f "$bep" ]; then
		error "Rust tests" "bazel test ($inv) wrote no build event log"
		return 0
	fi
	bep_rows "$bep" >"$tmp/bep-rows.tsv"
	jq -r 'select(.id.targetCompleted) | select((.completed.success // false) | not) | .id.targetCompleted.label' "$bep" >>"$tmp/unbuilt.txt"
	while IFS=$'\t' read -r label rule status kind log; do
		copy="$log"
		bin=-
		if [ -f "$log" ]; then
			nlog=$((nlog + 1))
			copy="$tmp/logs/$nlog.log"
			cp "$log" "$copy"
			untangle "$label" "$copy"
			# testlogs/<package>/<target>/test.log, or a retried attempt's
			# log in test_attempts/ below it: the binary is bin/<package>/<target>.
			bin="$(dirname "$log")"
			bin="${bin%/test_attempts}"
			bin="${bin/\/testlogs\//\/bin\/}"
		fi
		printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$rule" "$status" "$kind" "$copy" "$bin" "$inv" >>"$rows"
	done <"$tmp/bep-rows.tsv"
}

# bep_seconds <event log> [<test target>]: from a build event log, Bazel's
# wall time of the invocation (its `Elapsed time`) in seconds, or with a
# target the run of its test (the test summary's totalRunDuration); UNKNOWN
# where the log holds neither as a finite number of 0 or more (jq 1.6 reads
# "NaN" as a number, which awk would print as 0.0). A figure for the job
# log: it changes no verdict.
bep_seconds() {
	local s=""
	if [ "$#" = 1 ]; then
		s="$(jq -r 'select(.id.buildMetrics) | .buildMetrics.timingMetrics.wallTimeInMs // empty | tonumber / 1000 | select(. >= 0 and . < 1e9)' "$1" 2>/dev/null | sed -n 1p)" || s=""
	else
		s="$(jq -r --arg t "$2" 'select(.id.testSummary.label == $t) | .testSummary.totalRunDuration // empty | rtrimstr("s") | tonumber | select(. >= 0 and . < 1e9)' "$1" 2>/dev/null | sed -n 1p)" || s=""
	fi
	if [ -n "$s" ]; then LC_ALL=C awk -v s="$s" 'BEGIN { printf "%.1f", s }'; else printf 'UNKNOWN'; fi
}

# test_times <invocation> <event log>: a line for each test attempt Bazel
# ran in the invocation (its testResult events): the target, the attempt (and
# its shard and run, when not the first), the attempt's status, and how long
# it ran in seconds (testAttemptDuration, or the older
# testAttemptDurationMillis; UNKNOWN where the log holds neither as a finite
# number of 0 or more), marked when Bazel reused an earlier run's result.
# Bazel's own summary names only the targets that did not pass, and a
# target's timeout bounds each attempt, so these lines are what a target's
# timeout is measured from. A figure for the job log: it changes no verdict.
test_times() {
	local inv="$1" label attempt shard run status s cached where
	if ! jq -r '
		select(.id.testResult)
		| .id.testResult as $id
		| .testResult as $r
		| ([($r.testAttemptDuration // empty | tostring | rtrimstr("s") | tonumber?),
		    ($r.testAttemptDurationMillis // empty | tostring | tonumber? | . / 1000)]
		   | map(select(. >= 0 and . < 1e9)) | .[0]) as $s
		| [$id.label, ($id.attempt // 1), ($id.shard // 1), ($id.run // 1), ($r.status // "NO_STATUS"),
		   (if $s == null then "-" else $s end), (if $r.cachedLocally == true then "cached" else "-" end)]
		| @tsv' "$2" >"$tmp/test-times.tsv" 2>/dev/null; then
		echo "Test times ($inv): UNKNOWN, jq could not read the build event log"
		return 0
	fi
	if [ ! -s "$tmp/test-times.tsv" ]; then
		echo "Test times ($inv): the build event log names no test attempt"
		return 0
	fi
	while IFS=$'\t' read -r label attempt shard run status s cached; do
		where="attempt $attempt"
		[ "$shard" = 1 ] || where="$where, shard $shard"
		[ "$run" = 1 ] || where="$where, run $run"
		if [ "$s" = - ]; then s=UNKNOWN; else s="$(LC_ALL=C awk -v s="$s" 'BEGIN { printf "%.1f", s }')"; fi
		if [ "$cached" = cached ]; then cached=" (cached: an earlier run's result)"; else cached=""; fi
		echo "Test time ($inv): $label $where: $status in $s s$cached"
	done <"$tmp/test-times.tsv"
}

# bazel_test <invocation> <run_under> <arguments>...: one bazel test, its
# logs collected. Bazel exits 0 when every test passed, 3 when every target
# built and a test failed, and 1 when a target failed to build (the others
# still built and ran). Any other code is Bazel itself failing, and its event
# log cannot be trusted. --keep_going: the ci config stops at the first
# target that fails to build, and so skipped 7 of the 17 test targets in run
# 44694233578; a release gate names every failure in one run.
rc=0
bazel_test() {
	local inv="$1" under="$2" bep="$tmp/bep-$1.json" code=0
	shift 2
	bazelisk --bazelrc="$OMP_BAZEL_RC" test --keep_going "${env_flags[@]}" --run_under="$under" "${json_flags[@]}" --build_event_json_file="$bep" "$@" || code=$?
	case "$code" in
		0) ;;
		1) rc=1 ;;
		3) [ "$rc" = 1 ] || rc=3 ;;
		*)
			finding_stop "Rust tests" "bazel test exited $code ($inv), which is neither a test nor a build failure"
			exit "$code"
			;;
	esac
	collect "$inv" "$bep"
	if [ -f "$bep" ]; then test_times "$inv" "$bep"; fi
}

# did_not_build <target>: the target has no result but FAILED_TO_BUILD, and
# a build event log named it as failed to build (a targetCompleted event
# whose success is not true, or an aborted one: Bazel gives a test target
# that does not compile no test summary at all), or a summary gave it
# FAILED_TO_BUILD. A list line of such a target cannot be checked: its test
# ran nowhere, and the build failure already fails the job. The checks below
# then say UNKNOWN in a notice, and do not call the line wrong.
did_not_build() {
	awk -F'\t' -v t="$1" '$1 == t && $3 != "FAILED_TO_BUILD" { ran = 1 } END { exit ran }' "$rows" || return 1
	grep -qxF -- "$1" "$tmp/unbuilt.txt" || awk -F'\t' -v t="$1" '$1 == t { f = 1 } END { exit !f }' "$rows"
}

# in_tree <target>: the main or root invocation gave the target a result, or
# named it as failed to build. absent_entry <title> <list> <target> <name>:
# for a target not in the tree, an error naming the list line, and 0 (the
# caller runs nothing for it). The lists come with the gate and the tree
# under test is given: a line for a target this tree lacks (one a member not
# in it adds) is for another tree, and bazel test of a target that does not
# exist is no test.
in_tree() { grep -qxF -- "$1" "$tmp/present.txt"; }
absent_entry() {
	in_tree "$3" && return 1
	error "$1" "$3 $4 is in $2, but the tree under test has no target $3 (the main and root invocations gave it no result): that line is for another tree"
	absent["$3"]=1
	return 0
}

# check_alone <title> <invocation> <target> <name>: an invocation that ran one
# test alone must report exactly that test, and run it: a filter that
# matches nothing (a renamed test), or an #[ignore] the invocation did not
# lift, cannot pass as the test.
check_alone() {
	local title="$1" inv="$2" target="$3" name="$4" log event
	[ -z "${absent[$target]:-}" ] || return 0
	if did_not_build "$target"; then
		echo "::notice title=$title::UNKNOWN: $target did not build, so its own invocation for $name ran nothing (the build failure fails the job)"
		return 0
	fi
	awk -F'\t' -v t="$target" -v inv="$inv" '$7 == inv && $1 == t && $5 != "-" { print $5 }' "$rows" >"$tmp/alone-logs.txt"
	log="$(sed -n 1p "$tmp/alone-logs.txt")"
	if [ "$(count "$tmp/alone-logs.txt")" != 1 ] || [ ! -f "$log" ]; then
		error "$title" "$target has no one test log for $name in its own invocation"
		return 0
	fi
	jq -R -r 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored")) | "\(.name)\t\(.event)"' "$log" >"$tmp/alone-ran.tsv"
	if [ "$(cut -f1 "$tmp/alone-ran.tsv")" != "$name" ]; then
		error "$title" "$target's own invocation for $name reported [$(cut -f1 "$tmp/alone-ran.tsv" | tr '\n' ' ')], not exactly that one test"
		return 0
	fi
	event="$(cut -f2 "$tmp/alone-ran.tsv")"
	if [ "$event" = ignored ]; then
		error "$title" "$target $name is #[ignore]d, so its own invocation ran nothing"
		return 0
	fi
	echo "$title ran alone: $target $name ($event)"
}

if [ -z "$only" ]; then
	bazel_test main "$tmpdir_under" "${skip_flags[@]}" "${flaky_flags[@]}" -- //crates/... "${not_roots[@]}"
	if [ "${#roots[@]}" -gt 0 ]; then
		bazel_test root "$root_under" "${flaky_flags[@]}" -- "${roots[@]}"
	fi
	{ cut -f1 "$rows"; cat "$tmp/unbuilt.txt"; } | LC_ALL=C sort -u >"$tmp/present.txt"
	# Each own-process test alone: its target with libtest's --exact filter,
	# one invocation per test.
	for i in "${!own[@]}"; do
		IFS=$'\t' read -r target name <<<"${own[$i]}"
		absent_entry "Own-process test" "$sami/rust-test-own-process.txt" "$target" "$name" && continue
		bazel_test "own-$i" "$tmpdir_under" --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# The sticky-directory FIFO tests the main invocation's binaries list:
	# each alone, out of the sandbox, as the runner's user with the job's
	# FIFO (a user who owns neither the FIFO nor its directory).
	sticky=()
	while IFS=$'\t' read -r target bin; do
		[ -x "$bin" ] || continue
		while IFS= read -r name; do sticky+=("$target"$'\t'"$name"); done < <("$bin" --list 2>/dev/null | sed -n 's/: test$//p' | awk -v w="$sticky_word" 'index($0, w)')
	done < <(awk -F'\t' '$7 == "main" && $2 == "rust_test rule" && $6 != "-" { print $1 "\t" $6 }' "$rows" | LC_ALL=C sort -u)
	if [ "${#sticky[@]}" -gt 0 ] && [ ! -p "${RUST_TEST_STICKY_FIFO:-}" ]; then
		stop "the tree has ${#sticky[@]} sticky-directory FIFO tests, and RUST_TEST_STICKY_FIFO names no FIFO [${RUST_TEST_STICKY_FIFO:-}]"
	fi
	for i in "${!sticky[@]}"; do
		IFS=$'\t' read -r target name <<<"${sticky[$i]}"
		bazel_test "sticky-user-$i" "$tmpdir_under" --strategy=TestRunner=local --test_env=PI_TEST_STICKY_FIFO="$RUST_TEST_STICKY_FIFO" --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# Each #[ignore]d test the job runs anyway, alone, with --ignored. One
	# run alone can take longer than Bazel's 300 s default for a medium test
	# (pi-ast's whole-repository sweep), so these get 1200 s. They run out of
	# the sandbox: linux-sandbox gives a test a mount namespace of its own and
	# maps one uid, and pi-vcs's tests must see the mounts and the other
	# user's directory the job made as they are.
	for i in "${!ignored_run[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_run[$i]}"
		absent_entry "Ignored test" "$sami/rust-test-ignored.txt" "$target" "$name" && continue
		bazel_test "ignored-$i" "$tmpdir_under" --strategy=TestRunner=local --test_timeout=1200 --test_arg=--ignored --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# The same as root, out of the sandbox (linux-sandbox maps one uid), as
	# the root targets run; last, since root's runs leave root's files in
	# the target's test outputs.
	for i in "${!ignored_root[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_root[$i]}"
		absent_entry "Ignored root test" "$sami/rust-test-ignored-root.txt" "$target" "$name" && continue
		bazel_test "ignored-root-$i" "$root_under" --strategy=TestRunner=local --test_timeout=1200 --test_arg=--ignored --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# Each sticky-directory FIFO test again as root, which makes its own FIFO
	# of another user (it is given none).
	for i in "${!sticky[@]}"; do
		IFS=$'\t' read -r target name <<<"${sticky[$i]}"
		bazel_test "sticky-root-$i" "$root_under" --strategy=TestRunner=local --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# Each test of rust-test-root-alone.txt, alone, as root. Its TEST_TMPDIR
	# is on the reflink filesystem, which every user can reach: Bazel's own
	# is below the runner's home, which is closed to other users, and
	# pi-vfs's root tests hand their tree to another user (run 45325297653).
	for i in "${!root_alone[@]}"; do
		IFS=$'\t' read -r target name <<<"${root_alone[$i]}"
		absent_entry "Root test" "$sami/rust-test-root-alone.txt" "$target" "$name" && continue
		bazel_test "root-alone-$i" "$root_under" --strategy=TestRunner=local --test_tmpdir="$RUST_TEST_TMPDIR/bazel-root-alone" --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# Each #[ignore]d test whose reason in rust-test-ignored.txt starts
	# `opt: `, alone, as the ignored tests above, in a -c opt build of its
	# target. pi-ast's whole-repository sweep, which upstream runs by hand in
	# release builds, took 1,033.6 s of run 45516812533 in fastbuild; its
	# verdict is two assert!s, the same in either build. Last, since Bazel
	# discards its analysis cache when the compilation mode changes, so no
	# invocation after it analyzes again. bazel build first, with the test's
	# flags (bazel build takes test options too), so that the job log gives
	# the build and the test their own seconds (Bazel's wall time of each
	# invocation, from its event log); the bazel test after it builds
	# nothing. A build failure (exit 1) is the bazel test's to report, as for
	# any target.
	for i in "${!ignored_opt[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_opt[$i]}"
		absent_entry "Ignored test in a -c opt build" "$sami/rust-test-ignored.txt" "$target" "$name" && continue
		opt_flags=(--compilation_mode=opt --strategy=TestRunner=local --test_timeout=1200 --test_arg=--ignored --test_arg=--exact --test_arg="$name")
		build_bep="$tmp/bep-ignored-opt-$i-build.json"
		build_code=0
		bazelisk --bazelrc="$OMP_BAZEL_RC" build --keep_going "${env_flags[@]}" --run_under="$tmpdir_under" "${json_flags[@]}" --build_event_json_file="$build_bep" "${opt_flags[@]}" -- "$target" || build_code=$?
		case "$build_code" in
			0 | 1) ;;
			*)
				finding_stop "Rust tests" "bazel build exited $build_code (ignored-opt-$i), which is neither a success nor a build failure"
				exit "$build_code"
				;;
		esac
		bazel_test "ignored-opt-$i" "$tmpdir_under" "${opt_flags[@]}" -- "$target"
		echo "Ignored test in a -c opt build: $target $name: compilation mode opt; build $(bep_seconds "$build_bep") s (bazel build, exit $build_code), test $(bep_seconds "$tmp/bep-ignored-opt-$i.json") s (bazel test; the test binary's run $(bep_seconds "$tmp/bep-ignored-opt-$i.json" "$target") s)"
	done
else
	# Only the listed tests, and the canary: each target once, with libtest's
	# --exact filters for its names.
	{
		cat "$tmp/only.tsv"
		printf '%s\n' "$RUST_TEST_CANARY" | awk '{ t = $1; $1 = ""; sub(/^ +/, ""); print t "\t" $0 }'
	} >"$tmp/only-run.tsv"
	n=0
	while read -r target; do
		n=$((n + 1))
		filters=()
		while IFS=$'\t' read -r t name; do
			[ "$t" = "$target" ] && filters+=(--test_arg="$name")
		done <"$tmp/only-run.tsv"
		bazel_test "only-$n" "$tmpdir_under" "${flaky_flags[@]}" --test_arg=--exact "${filters[@]}" -- "$target"
	done < <(cut -f1 "$tmp/only-run.tsv" | LC_ALL=C sort -u)
fi
if [ ! -s "$rows" ]; then
	stop "the build event logs name no test target, so nothing shows that any test ran"
fi
if [ "$rc" = 3 ] && ! awk -F'\t' '$3 != "PASSED" { n++ } END { exit !n }' "$rows"; then
	stop "bazel test reported a failed test, but its build event logs name no target that did not pass"
fi
if [ "$rc" = 1 ]; then
	error "Rust tests" "a target failed to build (Bazel's FAILED TO BUILD lines above name it); no list line can account for that"
fi

if [ -z "$only" ]; then
	for i in "${!own[@]}"; do
		IFS=$'\t' read -r target name <<<"${own[$i]}"
		check_alone "Own-process test" "own-$i" "$target" "$name"
	done
	for i in "${!sticky[@]}"; do
		IFS=$'\t' read -r target name <<<"${sticky[$i]}"
		check_alone "Sticky-directory FIFO test, as the runner's user" "sticky-user-$i" "$target" "$name"
		check_alone "Sticky-directory FIFO test, as root" "sticky-root-$i" "$target" "$name"
		# The tests print `UNKNOWN:` when they checked nothing; that fails here
		# whatever rust-test-known-output.txt says.
		while IFS= read -r log; do
			if [ "$(grep -ac 'UNKNOWN:' "$log" || true)" != 0 ]; then
				error "Rust test skips" "$target $name printed UNKNOWN: in its own invocation, so it checked nothing: $(grep -a -m 1 'UNKNOWN:' "$log")"
			fi
		done < <(awk -F'\t' -v a="sticky-user-$i" -v b="sticky-root-$i" '($7 == a || $7 == b) && $5 != "-" { print $5 }' "$rows")
	done
	echo "Sticky-directory FIFO tests, each run as the runner's user and as root: ${#sticky[@]}"
	for i in "${!ignored_run[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_run[$i]}"
		check_alone "Ignored test" "ignored-$i" "$target" "$name"
	done
	for i in "${!ignored_opt[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_opt[$i]}"
		check_alone "Ignored test in a -c opt build" "ignored-opt-$i" "$target" "$name"
	done
	for i in "${!ignored_root[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_root[$i]}"
		check_alone "Ignored root test" "ignored-root-$i" "$target" "$name"
	done
	# A root test that prints `UNKNOWN:` checked nothing as root either.
	for i in "${!root_alone[@]}"; do
		IFS=$'\t' read -r target name <<<"${root_alone[$i]}"
		check_alone "Root test" "root-alone-$i" "$target" "$name"
		while IFS= read -r log; do
			if [ "$(grep -ac 'UNKNOWN:' "$log" || true)" != 0 ]; then
				error "Rust test skips" "$target $name printed UNKNOWN: in its own invocation as root, so it checked nothing: $(grep -a -m 1 'UNKNOWN:' "$log")"
			fi
		done < <(awk -F'\t' -v a="root-alone-$i" '$7 == a && $5 != "-" { print $5 }' "$rows")
	done
fi

# Cargo workspaces Bazel does not build (sdk/ is in .bazelignore), listed in
# .github/sami/rust-test-cargo-workspaces.txt: every test target of each runs
# under cargo with the root's pinned nightly, one log per target, read below
# as a rust_test log, with the stderr cargo kept beside it. The target is
# `<directory>:<kind>:<name>` (kind lib, bin, test, example, bench or doc). A
# failed cargo metadata stops the step.
# Then, in the macOS job (RUST_TEST_ONLY), the doctests of each crate with a
# Bazel doctest target run under cargo, as `<directory>:doc`: that job runs
# no Bazel doctest target, and rules_rust's doctest runner takes no test
# arguments anyway, so its log shows neither a passing doctest's output nor
# one in JSON. Even under cargo, rustdoc keeps a passing doctest's output out
# of the record (`--show-output` reaches only libtest), so these run with
# rustdoc's `--no-capture` and one thread, and doc_attribute gives each
# doctest the lines printed between its start and its result (run
# 44889772803: a planted doctest's `skipped:` line reached no record without
# them). On Linux the doctests' source is read instead (the doctest reader).
# Then each #[ignore]d cargo test that .github/sami/rust-test-ignored.txt
# names runs alone, with --ignored and --exact.
channel=""
ncargo=0
# Each cargo test runs with --timings: cargo writes an HTML report of its
# build (when each crate compiled, and for how long) and names it on stderr
# (`Timing report saved to <path>`). cargo_timing copies the report to
# $timings, which the job uploads, and gives the cargo test one line in the
# job log and one row in the step summary: its build seconds (cargo's own
# `Finished ... in` time, from cargo's start to the end of its build) and its
# test seconds (the rest of the run: the test binary, or for --doc rustdoc
# building and running the doctests). In run 45001615494 this phase took 17
# minutes with no line in the job log between the toolchain's install and its
# end. The figures change no verdict: a run whose `Finished` time cannot be
# read (a failed build prints none) has UNKNOWN in their place, and a missing
# report or a step summary that cannot be written is a warning.
timings="$tmp/cargo-timings"
mkdir -p "$timings"
timing_rows=0
# now: the wall clock in seconds, to the microsecond where bash gives it.
now() {
	local t="${EPOCHREALTIME:-}"
	[ -n "$t" ] || t="$(date +%s)"
	printf '%s\n' "${t/,/.}"
}
# cargo_timing <label> <invocation> <cargo's stderr> <start> <end> <exit code>:
# the cargo test's line and row (above), and its report copied.
cargo_timing() {
	local label="$1" inv="$2" err="$3" code="$6" total build="" spent=UNKNOWN built report copy=none
	total="$(LC_ALL=C awk -v a="$4" -v b="$5" 'BEGIN { printf "%.1f", b - a }')"
	# cargo's first `Finished` line: `... target(s) in 5.32s` or `in 1m 05s`.
	build="$(LC_ALL=C awk '/^ *Finished / {
		s = $0
		sub(/.* in /, "", s)
		n = split(s, t, " ")
		if (n == 0) exit
		secs = 0
		for (i = 1; i <= n; i++) {
			u = substr(t[i], length(t[i]))
			v = substr(t[i], 1, length(t[i]) - 1)
			if (v !~ /^[0-9]+(\.[0-9]+)?$/) exit
			if (u == "h") secs += v * 3600
			else if (u == "m") secs += v * 60
			else if (u == "s") secs += v
			else exit
		}
		printf "%.1f", secs
		exit
	}' "$err")" || build=""
	if [ -n "$build" ]; then
		spent="$(LC_ALL=C awk -v a="$total" -v b="$build" 'BEGIN { printf "%.1f", a - b }')"
		built="build $build s, test $spent s"
	else
		build=UNKNOWN
		built="build and test UNKNOWN (no Finished time this script could read)"
	fi
	report="$(awk '/^ *Timing report saved to / { sub(/^ *Timing report saved to /, ""); print; exit }' "$err")" || report=""
	if [ -n "$report" ] && [ -f "$report" ]; then
		copy="cargo-timing-$ncargo-$(printf '%s' "$label" | sed 's/[^A-Za-z0-9_.-]/-/g').html"
		cp -- "$report" "$timings/$copy" || copy=none
	fi
	if [ "$copy" = none ]; then
		echo "::warning title=Cargo timings::$label ($inv): cargo named no timing report that could be copied${report:+ (it named $report)}"
	fi
	echo "Cargo test timing: $label ($inv): $built, total $total s, exit $code, report $copy"
	[ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
	if [ "$timing_rows" = 0 ]; then
		{
			echo '### Cargo tests: build and test seconds'
			echo
			echo "Build: cargo's own \`Finished\` time, from its start to the end of its build. Test: the rest of the run (the test binary; for \`--doc\`, rustdoc building and running the doctests). Each build's \`--timings\` report is in the job's \`cargo-timings-*\` artifact."
			echo
			echo '| cargo test | invocation | build (s) | test (s) | total (s) | exit | timing report |'
			echo '| --- | --- | ---: | ---: | ---: | ---: | --- |'
		} >>"$GITHUB_STEP_SUMMARY" || echo "::warning title=Cargo timings::could not write the step summary"
	fi
	timing_rows=$((timing_rows + 1))
	# shellcheck disable=SC2016 # the backquotes are Markdown's code marks
	printf '| `%s` | %s | %s | %s | %s | %s | %s |\n' "$label" "$inv" "$build" "$spent" "$total" "$code" "$copy" >>"$GITHUB_STEP_SUMMARY" ||
		echo "::warning title=Cargo timings::could not write the step summary"
}
# doc_attribute: a doctest record whose output rustdoc's --no-capture printed
# raw (stdout and stderr, one thread) between each test's `started` event and
# its result, as libtest's record with that output as the result's stdout. A
# line outside every test stays as it is.
doc_attribute() {
	jq -R -r -n "$libtest_event"'
		reduce inputs as $l ({cur: null, buf: "", out: []};
			(try ($l | fromjson) catch null) as $o
			| if ($o | libtest_event) then
				if $o.type == "test" and $o.event == "started" then .cur = $o.name | .buf = "" | .out += [$l]
				elif $o.type == "test" and $o.name == .cur then
					. as $s | .out += [($o | .stdout = ((.stdout // "") + $s.buf) | tojson)] | .cur = null | .buf = ""
				else .out += [$l] end
			elif .cur != null then .buf += $l + "\n"
			else .out += [$l] end)
		| .out[]'
}
# cargo_test <label> <manifest> <invocation> <cargo arguments>...: one
# `cargo test`, whose arguments end with `--` and the test arguments; its
# JSON record is a row. A --doc run goes through doc_attribute. An #[ignore]d
# test's run (invocation ignored-cargo-<n>) runs --offline, under the
# command RUST_TEST_OFFLINE_UNDER names when it is set: the rust_test job
# names .github/sami/rust-test-offline.sh, which takes the network away.
cargo_test() {
	local label="$1" manifest="$2" inv="$3" log err code=0 doc=0 a t0 t1
	shift 3
	for a in "$@"; do [ "$a" = --doc ] && doc=1; done
	local under=() offline=()
	case "$inv" in
		ignored-cargo-*)
			offline=(--offline)
			[ -z "${RUST_TEST_OFFLINE_UNDER:-}" ] || under=("$RUST_TEST_OFFLINE_UNDER")
			;;
	esac
	ncargo=$((ncargo + 1))
	log="$tmp/logs/cargo-$ncargo.log"
	err="$log.err"
	t0="$(now)"
	if [ "$doc" = 1 ]; then
		err="$log.raw"
		RUSTDOCFLAGS="${RUSTDOCFLAGS:+$RUSTDOCFLAGS }-Zunstable-options --no-capture" rustup run "$channel" cargo test --locked --timings --manifest-path "$manifest" "$@" -Zunstable-options --format=json --show-output --test-threads=1 >"$err" 2>&1 || code=$?
		t1="$(now)"
		untangle "$label" "$err" doc
		doc_attribute <"$err" >"$log"
		: >"$log.err"
	else
		${under[@]+"${under[@]}"} rustup run "$channel" cargo test --locked --timings ${offline[@]+"${offline[@]}"} --manifest-path "$manifest" "$@" -Zunstable-options --format=json --show-output >"$log" 2>"$err" || code=$?
		t1="$(now)"
		untangle "$label" "$log"
	fi
	if [ "$code" = 0 ]; then
		printf '%s\tcargo test\tPASSED\tpassed\t%s\t-\t%s\n' "$label" "$log" "$inv" >>"$rows"
	else
		echo "::group::$label: cargo test exited $code"
		tail -n 50 "$err"
		echo "::endgroup::"
		printf '%s\tcargo test\tFAILED\tfailed\t%s\t-\t%s\n' "$label" "$log" "$inv" >>"$rows"
	fi
	cargo_timing "$label" "$inv" "$err" "$t0" "$t1" "$code"
}
run_cargo() {
	local n=0 manifest dir label selector name kind rest i target test
	channel="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
	[ -n "$channel" ] || stop "rust-toolchain.toml names no channel"
	rustup toolchain install "$channel" --profile minimal --no-self-update
	while read -r manifest; do
		dir="$(dirname "$manifest")"
		rustup run "$channel" cargo metadata --locked --no-deps --format-version 1 --manifest-path "$manifest" >"$tmp/cargo-metadata.json"
		jq -r --arg dir "$dir" '
			.packages[] | .targets[]
			| (.kind[0]) as $kind
			| (if .test then [($dir + ":" + $kind + ":" + .name), (if $kind == "lib" then "--lib" else "--" + $kind end), (if $kind == "lib" then "" else .name end)] else empty end),
			  (if .doctest and ([.crate_types[] | select(. == "lib" or . == "rlib" or . == "proc-macro")] | length > 0)
			   then [($dir + ":doc:" + .name), "--doc", ""] else empty end)
			| @tsv' "$tmp/cargo-metadata.json" >"$tmp/cargo-targets.tsv"
		[ -s "$tmp/cargo-targets.tsv" ] || stop "$manifest names no test target"
		while IFS=$'\t' read -r label selector name; do
			n=$((n + 1))
			# shellcheck disable=SC2086 # $name is empty for --lib and --doc
			cargo_test "$label" "$manifest" cargo "$selector" $name --
		done <"$tmp/cargo-targets.tsv"
	done <"$tmp/cargo-workspaces.txt"
	[ "$n" != 0 ] || stop "$sami/rust-test-cargo-workspaces.txt names no workspace with a test target"
	# The crates with a Bazel doctest target: from this run's rows (Linux),
	# or, when this run ran no doctest target (RUST_TEST_ONLY, the macOS
	# job), from bazel query.
	if [ -z "$only" ]; then
		awk -F'\t' '$2 == "rust_doc_test rule" { d = $1; sub(/^\/\//, "", d); sub(/:.*/, "", d); print d }' "$rows" | LC_ALL=C sort -u >"$tmp/doc-dirs.txt"
	else
		bazelisk query --output=label 'kind("rust_doc_test rule", //crates/...) - attr(tags, "manual", //crates/...)' >"$tmp/doc-targets.txt" || stop "bazel query for the doctest targets failed"
		sed -e 's|^//||' -e 's|:.*||' "$tmp/doc-targets.txt" | LC_ALL=C sort -u >"$tmp/doc-dirs.txt"
	fi
	# Each crate's doctests are a cargo invocation of their own, and cargo
	# picks the features of the crates they depend on per invocation: a
	# dependency another crate's run built is built again whenever its
	# features, or a dependency's, differ (pi-shell, jj-lib, syn and tokio,
	# among others). In run 45553300236 these 13 runs took 1148.5 s of the
	# cargo phase's 1181.9 s, all but 12 s of it building. With cargo's
	# feature unification over the workspace, every invocation resolves a
	# dependency's features the same way, so the later runs reuse almost
	# every unit an earlier run built (cold, on 15 CPUs: 495.8 s -> 234.0 s
	# for the 13 runs). The crates under test keep their own features; on
	# the tree this was measured on, the same doctests ran, by name, with
	# and without it.
	# On Linux the doctests run only in Bazel's doctest targets, and their
	# source is read for what Bazel's runner does not show (the doctest
	# reader, below). The macOS job runs no Bazel doctest target, so there
	# they run here, and the skip scan reads their output.
	if [ -n "$only" ]; then
		while read -r dir; do
			cargo_test "$dir:doc" "$dir/Cargo.toml" cargo --doc -Zfeature-unification --config 'resolver.feature-unification="workspace"' --
		done <"$tmp/doc-dirs.txt"
	fi
	# The #[ignore]d cargo tests run alone on Linux, where the network can be
	# taken away (rust-test-offline.sh).
	[ -z "$only" ] || return 0
	for i in "${!ignored_cargo[@]}"; do
		IFS=$'\t' read -r target test <<<"${ignored_cargo[$i]}"
		dir="${target%%:*}"
		rest="${target#*:}"
		kind="${rest%%:*}"
		name="${rest#*:}"
		case "$kind" in
			lib) cargo_test "$target" "$dir/Cargo.toml" "ignored-cargo-$i" --lib -- --ignored --exact "$test" ;;
			bin | test | example | bench) cargo_test "$target" "$dir/Cargo.toml" "ignored-cargo-$i" "--$kind" "$name" -- --ignored --exact "$test" ;;
			*) stop "$sami/rust-test-ignored.txt: $target is no cargo test target (<directory>:<lib|bin|test|example|bench>:<name>)" ;;
		esac
	done
}

# Bazel skips, without an error and without a result in the event log, a test
# it finds incompatible with the runner (its own target_compatible_with or a
# dependency's) or one a --test_*_filters option leaves out. Every test
# target under //crates, less those tagged manual, must have a result. The
# query also gives each native_test's binary (its src). It takes no
# --bazelrc: the bazel-cache fragment's `common --config=ci` is defined for
# build only, and query refuses it.
declare -A binary_of=()
check_results_exist() {
	local target src label
	if ! bazelisk query --output=streamed_jsonproto 'kind("_test rule$", //crates/...) - attr(tags, "manual", //crates/...)' >"$tmp/test-rules.json"; then
		stop "bazel query for the test targets failed"
	fi
	jq -r 'select(.type == "RULE") | .rule.name' "$tmp/test-rules.json" | LC_ALL=C sort -u >"$tmp/test-targets.txt"
	[ -s "$tmp/test-targets.txt" ] || stop "bazel query names no test target under //crates"
	jq -r 'select(.type == "RULE" and .rule.ruleClass == "native_test") | [.rule.name, ([(.rule.attribute // [])[] | select(.name == "src") | .stringValue // empty] | .[0] // "-")] | @tsv' "$tmp/test-rules.json" >"$tmp/native-src.tsv"
	while IFS=$'\t' read -r target src; do
		binary_of["$target"]="$src"
	done <"$tmp/native-src.tsv"
	awk -F'\t' '$1 ~ /^\/\// { print $1 }' "$rows" | LC_ALL=C sort -u >"$tmp/with-result.txt"
	while read -r label; do
		error "Rust tests" "$label is a test target, but bazel test has no result for it: skipped as incompatible with the runner, left out by a test filter, or not built"
	done < <(LC_ALL=C comm -23 "$tmp/test-targets.txt" "$tmp/with-result.txt")
}

# The cargo workspaces run in both jobs; the crates' cargo doctests run only
# in the macOS job (above): there, that is how a cargo test or a doctest
# compiled only on macOS runs.
run_cargo
if [ -z "$only" ]; then
	for i in "${!ignored_cargo[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_cargo[$i]}"
		check_alone "Ignored cargo test" "ignored-cargo-$i" "$target" "$name"
	done
	check_results_exist
fi

# The skip scan (see "Skips" above). skip_line matches a skip line in a
# passing test's output; raw_skip_line matches one outside the record. The
# doctest reader (below) looks for the same words in a doctest's code.
skip_words='skipped|skipping|SKIP|not run|UNCOMPARED'
skip_line="^([A-Za-z0-9_:]+: )?($skip_words)[ :]"
raw_skip_line="(^|: )($skip_words)[ :]"
failed="$tmp/failed.tsv"
: >"$tmp/failed-at.tsv"
skips="$tmp/skips.tsv"
outputs="$tmp/outputs.tsv"
incomplete="$tmp/incomplete.txt"
: >"$failed"
: >"$skips"
: >"$outputs"
: >"$incomplete"
raw_output="$tmp/raw-output.tsv"
: >"$raw_output"

# outside_record <log>: the log's lines that are no libtest event: what was
# written outside the record. A line is judged by parsing it, not by its first
# character, against libtest_event (above), which doc_attribute uses too. A
# child's own JSON line, `{ no free port: nothing to test }`, or an object
# that only says `"type": "test"`, is output. (untangle above knows an event
# by libtest's one text shape; in every trial log the two agree.)
outside_record() {
	jq -R -r "$libtest_event"' . as $l | (try fromjson catch null) as $o
		| if ($o | libtest_event) then empty else $l end' "$1"
}

# raw_lines <out> <log> [<cargo stderr>]: into <out>, what a test binary
# wrote outside libtest's record: the log's lines that are no libtest event,
# and, from cargo's stderr, the lines after its first `Running` line (before
# it, cargo's own build output). Bazel's own lines in a test.log (its banner,
# and its line for a test it timed out, which fails anyway), cargo's line
# after a failed test, and blank lines are left out, each matched whole. A log
# jq cannot read to its end is an error (in the job log): a shorter read
# could look clean.
# shellcheck disable=SC2016 # the patterns name a literal $0, ${PAGER...} and backquotes
raw_lines() {
	local out="$1"
	shift
	if ! outside_record "$1" >"$tmp/outside-record.txt"; then
		error "Rust tests" "jq could not read $1 to its end, so what its test binary wrote outside libtest's record is unknown"
	fi
	{
		cat -- "$tmp/outside-record.txt"
		if [ -n "${2:-}" ] && [ -f "$2" ]; then awk 'p; /^ +Running /{ p = 1 }' "$2"; fi
	} | grep -avE '^[[:space:]]*$|^exec \$\{PAGER:-/usr/bin/less\} "\$0" \|\| exit 1$|^Executing tests from //[^ ]+$|^-{20,}$|^-- Test timed out at .* --$|^error: test failed, to rerun pass `[^`]*`$' >"$out" || true
}

# scan_output <target> <log> [<cargo stderr>]: the skips and the passing
# tests' output in a libtest log, and what the test binary wrote outside its
# record. Only a passing test's record is read: a failed test fails the job
# anyway, and its report can quote a tool's own `skipping` line (rsync's
# `skipping non-regular file`, run 44807499064), which is no skip. A line
# outside the record is a skip when it has a skip word and names its test;
# any other is kept for rust-test-known-raw-output.txt (below), except in a
# cargo doctest run's log, where every line a doctest printed is in its
# record (doc_attribute, one thread) and the lines outside are cargo's build.
scan_output() {
	local label="$1" line
	shift
	jq -R -r --arg target "$label" --arg re "$skip_line" '
		fromjson? | select(type == "object" and .type == "test" and .event == "ok")
		| select((.stdout // "") | split("\n") | any(test($re)))
		| "\($target)\t\(.name)"' "$1" >>"$skips"
	jq -R -r --arg target "$label" --arg log "$1" '
		fromjson? | select(type == "object" and .type == "test" and .event == "ok" and (.stdout // "") != "")
		| "\($target)\t\(.name)\t\($log)"' "$1" >>"$outputs"
	raw_lines "$tmp/raw-here.txt" "$@"
	while IFS= read -r line; do
		if [[ "$line" =~ ^([A-Za-z0-9_:]+):\ (skipped|skipping|SKIP|not\ run|UNCOMPARED)[\ :] ]]; then
			printf '%s\t%s\n' "$label" "${BASH_REMATCH[1]}" >>"$skips"
		else
			error "Rust tests" "$label printed a skip line outside libtest's record that names no test: $line"
		fi
	done < <(grep -aE "$raw_skip_line" "$tmp/raw-here.txt" || true)
	case "$label" in
		*:doc | *:doc:*) ;;
		*) grep -avE "$raw_skip_line" "$tmp/raw-here.txt" | awk -v t="$label" -v lg="$1" '{ gsub(/\t/, " "); print t "\t" $0 "\t" lg }' >>"$raw_output" || true ;;
	esac
}

# check_root <target> <log>: a root target runs as root, so a test in it
# that printed `not run:` skipped itself on a broken precondition, and it must
# pass the number of tests its list line names. libtest captures the tests'
# stderr into the record; a raw `not run:` line outside it fails too.
check_root() {
	local label="$1" log="$2" name passed
	while read -r name; do
		error "Rust tests" "$label $name printed 'not run:', though it runs as root"
	done < <(jq -R -r 'fromjson? | select(type == "object" and .type == "test" and ((.stdout // "") | test("not run:"))) | .name' "$log")
	if ! outside_record "$log" >"$tmp/outside-record.txt"; then
		error "Rust tests" "jq could not read $log to its end, so its 'not run:' lines outside libtest's record are unknown"
	fi
	if [ "$(grep -c 'not run:' "$tmp/outside-record.txt" || true)" != 0 ]; then
		error "Rust tests" "$label printed 'not run:' outside libtest's record, though it runs as root: $(grep -m 1 'not run:' "$tmp/outside-record.txt")"
	fi
	passed="$(jq -R -s -r '[split("\n")[] | fromjson? | select(type == "object" and .type == "test" and .event == "ok")] | length' "$log")"
	if [ "$passed" != "${root_tests[$label]}" ]; then
		error "Rust tests" "$label passed $passed tests, and $sami/rust-test-root-targets.txt names ${root_tests[$label]}"
	fi
}

# add_failed <target> <status> <names> <log> <invocation>: a failed log's
# failed tests, one per line, and in failed-at.tsv each with its log and
# invocation (for the flaky reckoning). A failed log that names none (a
# crash, a timeout) fails the job, since the list cannot account for it.
add_failed() {
	if [ -z "$3" ]; then
		error "Rust tests" "$1 is $2 and its log names no failed test"
		return 0
	fi
	printf '%s\n' "$3" | awk -v label="$1" 'NF { print label "\t" $0 }' >>"$failed"
	printf '%s\n' "$3" | awk -v label="$1" -v at="$4" -v inv="$5" 'NF { print label "\t" $0 "\t" at "\t" inv }' >>"$tmp/failed-at.tsv"
}

# doc_dir <target>: a doctest target's crate directory: crates/x for the
# Bazel target //crates/x:x_doc_test and the cargo labels crates/x:doc and
# crates/x:doc:<name>.
doc_dir() {
	local d="${1#//}"
	printf '%s\n' "${d%%:*}"
}

# doc_ignored <origin> <target> <name>: an ```ignore doctest, by its crate's
# directory and its name relative to it (both name it with the crate's
# path, `crates/x/src/lib.rs - f (line 3)`).
doc_ignored() {
	local dir
	dir="$(doc_dir "$2")"
	printf '%s\t%s\t%s\n' "$1" "$dir" "${3#"$dir"/}" >>"$tmp/doc-ignored.tsv"
}

# check_libtest <target> <status> <kind> <log> <invocation>: a rust_test,
# native_test or cargo test log must hold libtest's JSON record whole: the
# planned test_count, a result for every planned test, and the suite's end,
# `ok` in a passed log. Bazel calls a target PASSED from its exit code alone,
# so a test binary that exits 0 before libtest finishes (a test that calls
# std::process::exit) passes there. A native_test (bazel-skylib) runs a
# prebuilt binary, here pi-builtins_test's, so its log is libtest's record
# too. A log can hold several suites (`cargo test --doc` runs one binary per
# doctest that cannot be merged): the planned count is the sum of every
# suite's test_count, and every started suite must end. The failed tests are
# its `failed` events. A log that ended early (a timeout, a crash) is named
# once here; the accounting below leaves its binary out. When
# libtest-bound.py (rust-test-tmpdir.sh) stopped a binary that had stopped
# making progress, the error names the tests it failed (their record's stdout
# starts `libtest-bound:`); its tests that never started have no result, so
# the log stays incomplete.
check_libtest() {
	local label="$1" status="$2" kind="$3" log="$4" inv="$5" record planned reported ended filtered names
	record="$(jq -R -s -r '
		[split("\n")[] | fromjson? | select(type == "object")] as $events
		| ($events | map(select(.type == "suite" and .event == "started"))) as $starts
		| ($events | map(select(.type == "suite" and (.event == "ok" or .event == "failed")))) as $ends
		| [(if ($starts | length) == 0 then -1 else ($starts | map(.test_count // 0) | add) end),
		   ($events | map(select(.type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored"))) | length),
		   (if ($ends | length) != ($starts | length) then "none"
		    elif ($ends | map(select(.event == "failed")) | length) > 0 then "failed"
		    else "ok" end),
		   ($ends | map(.filtered_out // 0) | add // 0)]
		| @tsv' "$log")"
	IFS=$'\t' read -r planned reported ended filtered <<<"$record"
	if [ "$planned" -lt 0 ]; then
		error "Rust tests" "$label is $status and its log holds no libtest record"
		printf '%s\n' "$log" >>"$incomplete"
		return 0
	fi
	if [ "$reported" != "$planned" ] || [ "$ended" = none ]; then
		names="$(jq -R -r 'fromjson? | select(type == "object" and .type == "test" and .event == "failed" and ((.stdout // "") | startswith("libtest-bound:"))) | .name' "$log" | paste -s -d, -)"
		error "Rust tests" "$label is $status, but libtest planned $planned tests and reported $reported, suite end $ended: the test binary ended before its tests did${names:+; libtest-bound.py stopped it and failed these, each saying why (its own bound or SIGTERM): $names}"
		printf '%s\n' "$log" >>"$incomplete"
		return 0
	fi
	case "$inv" in
		cargo)
			scan_output "$label" "$log" "$log.err"
			# The job gives cargo test no filter, so nothing may be taken out.
			if [ "$filtered" != 0 ]; then
				error "Rust test skips" "$label filtered out $filtered tests, though cargo test is given no filter"
			fi
			# Its #[ignore]d tests (and ```ignore doctests) ran nothing; they
			# are reconciled below.
			jq -R -r --arg target "$label" 'fromjson? | select(type == "object" and .type == "test" and .event == "ignored") | "\($target)\t\(.name)"' "$log" >>"$tmp/cargo-ignored.tsv"
			;;
		ignored-cargo-*) scan_output "$label" "$log" "$log.err" ;;
		*) scan_output "$label" "$log" ;;
	esac
	if [ "$inv" = root ] && [ -n "${root_tests[$label]:-}" ]; then
		check_root "$label" "$log"
	fi
	if [ "$kind" = passed ]; then
		if [ "$ended" != ok ]; then
			error "Rust tests" "$label is $status, but libtest's suite ended $ended"
		fi
		return 0
	fi
	names="$(jq -R -r 'fromjson? | select(type == "object" and .type == "test" and .event == "failed") | .name' "$log")"
	echo "::group::$label failures"
	jq -R -r 'fromjson? | select(type == "object" and .type == "test" and .event == "failed") | "---- \(.name) ----\n\(.stdout // "")"' "$log"
	echo "::endgroup::"
	add_failed "$label" "$status" "$names" "$log" "$inv"
}

# check_doctest <target> <status> <kind> <log>: a rust_doc_test log is the
# doctest runner's text. Its first `running N tests` header must equal its
# last summary's passed + failed + ignored + measured, so a summary a child
# process printed does not stand for the runner's; a passed log's last
# summary must be `test result: ok.`. A failed one ends with `failures:`,
# each failed doctest indented four spaces, a blank line and `test result:
# FAILED.`. No doctest may be filtered out: no list names one. An ```ignore
# block is no test: each `test <name> ... ignored` line is counted apart (an
# ignored count whose names the log does not give fails). On Linux, each
# doctest that ran must be one the doctest reader found in the source (below).
check_doctest() {
	local label="$1" status="$2" kind="$3" log="$4" counts header summed verdict filtered ignored names name
	counts="$(awk '
		!head && /^running [0-9]+ tests?$/ { head = $2 }
		/^test result: / {
			last = $0; sum = 0
			n = split($0, word, /[ ;]+/)
			for (i = 2; i <= n; i++) if (word[i] ~ /^(passed|failed|ignored|measured)$/) sum += word[i - 1]
		}
		/^test result: / { ign = 0; for (i = 2; i <= n; i++) if (word[i] ~ /^ignored$/) ign = word[i - 1] }
		END { printf "%s\t%s\t%s\t%s\t%s\n", (head == "" ? -1 : head), (last == "" ? -1 : sum), (last ~ /^test result: ok\./ ? "ok" : "not-ok"), (last ~ / [1-9][0-9]* filtered out/ ? "some" : "none"), ign + 0 }
	' "$log")"
	IFS=$'\t' read -r header summed verdict filtered ignored <<<"$counts"
	if [ "$header" -lt 0 ] || [ "$summed" != "$header" ]; then
		error "Rust tests" "$label is $status, but its log's header plans $header doctests and its last summary counts $summed"
		return 0
	fi
	if [ "$filtered" != none ]; then
		error "Rust test skips" "$label took a doctest out, which no list names"
	fi
	awk '/^test .* \.\.\. ignored$/ { sub(/^test /, ""); sub(/ \.\.\. ignored$/, ""); print }' "$log" >"$tmp/doctest-ignored.txt"
	while IFS= read -r name; do
		doc_ignored bazel "$label" "$name"
	done <"$tmp/doctest-ignored.txt"
	if [ "$ignored" != 0 ] && [ ! -s "$tmp/doctest-ignored.txt" ]; then
		error "Rust test skips" "$label's summary counts $ignored ignored doctests, and its log names none"
	fi
	awk -v dir="$(doc_dir "$label")" '/^test .* \.\.\. (ok|FAILED)$/ { sub(/^test /, ""); sub(/ \.\.\. (ok|FAILED)$/, ""); if (index($0, dir "/") == 1) $0 = substr($0, length(dir) + 2); print dir "\t" $0 }' "$log" >>"$tmp/doc-names-bazel.tsv"
	if [ "$kind" = passed ]; then
		if [ "$verdict" != ok ]; then
			error "Rust tests" "$label is $status, but its log's last summary is not 'test result: ok.'"
		fi
		return 0
	fi
	names="$(awk '
		/^failures:$/ { inlist = 1; names = ""; next }
		inlist && /^    [^ ]/ { names = names substr($0, 5) "\n"; next }
		inlist && /^$/ { next }
		/^test result: FAILED\./ { printf "%s", names }
		{ inlist = 0; names = "" }
	' "$log")"
	add_failed "$label" "$status" "$names" "$log" "$inv"
}

while IFS=$'\t' read -r label rule status kind log _ inv; do
	if [ "$kind" = none ] || [ ! -f "$log" ]; then
		error "Rust tests" "$label is $status and Bazel names no test log for it"
		continue
	fi
	case "$rule" in
		"rust_test rule" | "native_test rule" | "cargo test") check_libtest "$label" "$status" "$kind" "$log" "$inv" ;;
		"rust_doc_test rule") check_doctest "$label" "$status" "$kind" "$log" ;;
		*) error "Rust tests" "$label is a $rule, whose log this step cannot read" ;;
	esac
done <"$rows"

# The per-test results of this job, which sami-rust-test.yml uploads and
# sami-checks.yml's rust-test-compare job reads: one line per test, as
# `<target> <test name> <final status> <status per invocation>`. The final
# status is `ok` when the test passed in some invocation or attempt, else
# `failed` when it failed in one, else `ignored`; the last column names each
# invocation and what it reported there, sorted. Two runs of one commit, one
# cold and one from a build seed, must give the same file
# (.github/sami/rust-test-results-compare.sh): a build cache that changes a
# test's verdict is a build cache nothing may trust. It is written here, before
# the accounting below, so that the macOS job (RUST_TEST_ONLY, which returns
# before it) writes it too.
results="$tmp/results"
mkdir -p "$results"
: >"$tmp/results-raw.tsv"
while IFS=$'\t' read -r label rule _ _ log _ inv; do
	[ -f "$log" ] || continue
	case "$rule" in
		"rust_doc_test rule")
			# The doctest runner writes libtest's text, not its record.
			awk -v t="$label" -v i="$inv" '
				/^test .* \.\.\. (ok|FAILED|ignored)$/ {
					s = $NF
					line = $0
					sub(/^test /, "", line)
					sub(/ \.\.\. (ok|FAILED|ignored)$/, "", line)
					if (s == "FAILED") { s = "failed" }
					print t "\t" line "\t" i "\t" s
				}' "$log"
			;;
		*)
			jq -R -r --arg target "$label" --arg inv "$inv" 'fromjson?
				| select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored"))
				| [$target, .name, $inv, .event] | @tsv' "$log"
			;;
	esac >>"$tmp/results-raw.tsv"
done <"$rows"
LC_ALL=C sort -u -o "$tmp/results-raw.tsv" "$tmp/results-raw.tsv"
awk -F'\t' '
	{ key = $1 "\t" $2
	  if (!(key in seen)) { seen[key] = ""; order[++n] = key }
	  seen[key] = (seen[key] == "" ? "" : seen[key] ",") $3 "=" $4
	  if ($4 == "ok") { final[key] = "ok" }
	  else if ($4 == "failed" && final[key] != "ok") { final[key] = "failed" }
	  else if (!(key in final)) { final[key] = "ignored" }
	}
	END { for (i = 1; i <= n; i++) { print order[i] "\t" final[order[i]] "\t" seen[order[i]] } }
' "$tmp/results-raw.tsv" >"$results/results.tsv"
if [ ! -s "$results/results.tsv" ]; then
	error "Rust test results" "no test of any invocation reported a result, so this job's per-test results are empty and nothing can be compared with them"
else
	echo "Per-test results: $(count "$results/results.tsv") tests in $results"
fi

# The #[ignore]d cargo tests: each must be named in
# .github/sami/rust-test-ignored.txt, which ran it alone above; any other
# fails the job. An ```ignore doc block is not a test (upstream marks it so
# that rustdoc never runs it): it is counted and named, and fails nothing.
touch "$tmp/cargo-ignored.tsv" "$tmp/doc-ignored.tsv"
LC_ALL=C sort -u -o "$tmp/cargo-ignored.tsv" "$tmp/cargo-ignored.tsv"
printf '%s\n' ${ignored_cargo[@]+"${ignored_cargo[@]}"} | LC_ALL=C sort -u >"$tmp/ignored-cargo-listed.tsv"
while IFS=$'\t' read -r label name; do
	case "$label" in
		*:doc | *:doc:*) doc_ignored cargo "$label" "$name" ;;
		*)
			if grep -qxF -- "$label"$'\t'"$name" "$tmp/ignored-cargo-listed.tsv"; then
				if [ -n "$only" ]; then
					echo "Ignored cargo test, run alone with --ignored by the Linux job: $label $name"
				else
					echo "Ignored cargo test, run alone with --ignored: $label $name"
				fi
			else
				error "Rust test skips" "$label $name is #[ignore]d and runs in no invocation: run it (name it in $sami/rust-test-ignored.txt)"
			fi
			;;
	esac
done <"$tmp/cargo-ignored.tsv"
echo "::group::\`\`\`ignore doc blocks (not tests, marked ignore by upstream): $(count "$tmp/doc-ignored.tsv")"
while IFS=$'\t' read -r origin dir name; do
	echo "$dir $name ($origin's log)"
done <"$tmp/doc-ignored.tsv"
echo "::endgroup::"
echo "\`\`\`ignore doc blocks, not tests, marked ignore by upstream: $(count "$tmp/doc-ignored.tsv")"

# What test binaries wrote outside libtest's record (a child's or a thread's
# write to the inherited stdout or stderr), which no test's record holds: each
# distinct line must match an entry of .github/sami/rust-test-known-raw-output.txt
# for its target (`<target> <extended regular expression of the whole line>
# <why it is no skip>`); any other fails the job, since it can be a skip in
# other words. An entry whose target is written `<target>@<anchor>` (an
# extended regular expression without a space) counts only for a line of a
# log that also holds a line the anchor matches whole: a line of a crash
# report counts only beside the report's first line. raw_output has one row
# per target, line and log (scan_output). An entry that matched nothing gets a
# notice.
LC_ALL=C sort -u -o "$raw_output" "$raw_output"
cp -- "$raw_output" "$tmp/raw-output-anchors.tsv"
awk -F'\t' '
	FILENAME == ARGV[1] {
		t = $1
		a = ""
		k = index(t, "@")
		if (k) {
			a = substr(t, k + 1)
			t = substr(t, 1, k - 1)
		}
		n[t]++
		re[t, n[t]] = $2
		anchor[t, n[t]] = a
		entry[t, n[t]] = $1
		used[t, n[t]] = 0
		next
	}
	FILENAME == ARGV[2] {
		for (i = 1; i <= n[$1]; i++) if (anchor[$1, i] != "" && $2 ~ ("^(" anchor[$1, i] ")$")) held[$1, i, $3] = 1
		next
	}
	{
		hit = 0
		for (i = 1; i <= n[$1]; i++) if ((anchor[$1, i] == "" || held[$1, i, $3]) && $2 ~ ("^(" re[$1, i] ")$")) { hit = 1; used[$1, i] = 1 }
		if (!hit) print "unknown\t" $1 "\t" $2
	}
	END { for (k in used) if (!used[k]) { split(k, p, SUBSEP); print "unused\t" entry[p[1], p[2]] "\t" re[p[1], p[2]] } }
' "$tmp/known-raw-output.tsv" "$tmp/raw-output-anchors.tsv" "$raw_output" | LC_ALL=C sort -u >"$tmp/raw-verdict.tsv"
awk -F'\t' '$1 == "unknown" { print $2 }' "$tmp/raw-verdict.tsv" | LC_ALL=C sort -u >"$tmp/raw-targets.txt"
while read -r label; do
	awk -F'\t' -v t="$label" '$1 == "unknown" && $2 == t { print $3 }' "$tmp/raw-verdict.tsv" >"$tmp/raw-lines.txt"
	error "Rust test printed" "$label wrote $(count "$tmp/raw-lines.txt") lines outside libtest's record that $sami/rust-test-known-raw-output.txt does not name (a skip in other words?), the first: $(sed -n 1p "$tmp/raw-lines.txt")"
	echo "::group::$label: lines outside libtest's record that no entry names"
	sed -n 1,40p "$tmp/raw-lines.txt"
	echo "::endgroup::"
done <"$tmp/raw-targets.txt"
while IFS=$'\t' read -r _ label re; do
	echo "::notice title=Known raw output did not happen::$label $re is in $sami/rust-test-known-raw-output.txt but matched no line"
done < <(awk -F'\t' '$1 == "unused"' "$tmp/raw-verdict.tsv")
echo "Lines outside libtest's record: $(cut -f1,2 "$raw_output" | LC_ALL=C sort -u | awk 'END { print NR }') distinct, $(awk -F'\t' '$1 == "unknown"' "$tmp/raw-verdict.tsv" | awk 'END { print NR }') named by no entry"

# On Linux the doctests run only in Bazel's doctest targets, whose runner
# (rules_rust's) takes no test arguments and shows no passing doctest's
# output, so the skip scan above never reads what a doctest prints. In its
# place, with no build, each crate with a Bazel doctest target has its
# doctests read from its source ($doctest_forms): a line of a doctest
# rustdoc runs that holds the word print, println, eprint, eprintln, dbg,
# stdout or stderr (a word: a print split from its `!` counts), or one of the
# skip scan's words, fails the job, named by file and line, and so does doc
# text the reader does not read (a doc attribute it does not decode, a
# doctest still open where the text it joined ends). The read and Bazel's
# run must account for each other, both ways: each doctest Bazel's log names
# (`<file> - <item> (line <n>)`) must be one the reader found at that file
# and line, or the reader did not see it; and each doctest the reader found
# must be one Bazel ran, or nothing on Linux runs it (a doctest the cargo
# re-run used to run). Either fails the job as UNKNOWN. (Until 2026-11 the
# doctests ran a second time under
# cargo, about 576 s a job, to read their output: in the 57 gate jobs from
# 2026-11-21 to 11-25 where that re-run's comparison with Bazel ran, it saw
# no doctest, failure, skip or print that Bazel's run did not.)
if [ -z "$only" ]; then
	: >"$tmp/doc-read.tsv"
	while read -r dir; do
		find "$dir" -name '*.rs' -type f -exec env LC_ALL=C awk -v words="$skip_words" -f "$doctest_forms" {} + >>"$tmp/doc-read.tsv" || stop "the doctest reader could not read the source of $dir"
	done <"$tmp/doc-dirs.txt"
	awk -F'\t' '$1 == "test" { print $2 ":" $3 }' "$tmp/doc-read.tsv" | LC_ALL=C sort -u >"$tmp/doc-read-tests.txt"
	touch "$tmp/doc-names-bazel.tsv"
	LC_ALL=C sort -u "$tmp/doc-names-bazel.tsv" >"$tmp/doc-bazel.tsv"
	: >"$tmp/doc-bazel-at.txt"
	while IFS=$'\t' read -r dir name; do
		file="${name%% - *}"
		line="$(printf '%s\n' "$name" | sed -n 's/.*(line \([0-9][0-9]*\)).*/\1/p')"
		[ -z "$line" ] || printf '%s\n' "$dir/$file:$line" >>"$tmp/doc-bazel-at.txt"
		if [ -z "$line" ] || ! grep -qxF -- "$dir/$file:$line" "$tmp/doc-read-tests.txt"; then
			error "Rust test skips" "UNKNOWN: $dir $name ran in Bazel's doctest target, and the doctest reader found no doctest at $dir/$file line ${line:-?}, so it could not see whether it prints"
		fi
	done <"$tmp/doc-bazel.tsv"
	# And the other way: a doctest the reader found that no Bazel doctest
	# target ran is run by nothing on Linux (the cargo re-run did, until this
	# reader replaced it).
	LC_ALL=C sort -u -o "$tmp/doc-bazel-at.txt" "$tmp/doc-bazel-at.txt"
	while read -r at; do
		error "Rust test skips" "UNKNOWN: $at: the doctest reader found a doctest here that no Bazel doctest target ran, so nothing on Linux runs it"
	done < <(LC_ALL=C comm -23 "$tmp/doc-read-tests.txt" "$tmp/doc-bazel-at.txt")
	while IFS=$'\t' read -r what file line text; do
		case "$what" in
			print) error "Rust test printed" "$file:$line: a doctest rustdoc runs prints ($text); no record the skip scan reads holds a doctest's output on Linux, so a doctest must not print" ;;
			skip) error "Rust test skips" "$file:$line: a doctest rustdoc runs holds a skip word ($text); no record the skip scan reads holds a doctest's output on Linux, so a doctest must not skip" ;;
			unread) error "Rust test skips" "UNKNOWN: $file:$line: $text, so the doctest reader did not read the doctests in it" ;;
		esac
	done <"$tmp/doc-read.tsv"
	echo "Doctests read from the source of $(count "$tmp/doc-dirs.txt") crates: $(count "$tmp/doc-read-tests.txt"); Bazel ran $(count "$tmp/doc-bazel.tsv"); lines that print or skip: $(awk -F'\t' '$1 == "print" || $1 == "skip"' "$tmp/doc-read.tsv" | awk 'END { print NR }')"
fi

# reconcile <found> <list> <listed> <noun> <verb> <title> <stale>: the tests
# found (failed, skipped, printing) against a list, both ways. One found and
# not listed fails the job. One listed and not found is <stale>: an error
# (remove its line, so the list empties as the fixes land) or a notice.
reconcile() {
	local found="$1" list="$2" listed="$3" noun="$4" verb="$5" title="$6" stale="$7" label name
	LC_ALL=C sort -u -o "$found" "$found"
	LC_ALL=C sort -u -o "$listed" "$listed"
	while IFS=$'\t' read -r label name; do
		echo "Known $noun, $verb as expected: $label $name"
	done < <(LC_ALL=C comm -12 "$found" "$listed")
	while IFS=$'\t' read -r label name; do
		error "$title" "$label $name $verb and is not in $list"
	done < <(LC_ALL=C comm -23 "$found" "$listed")
	while IFS=$'\t' read -r label name; do
		if [ "$stale" = error ]; then
			error "Known $noun did not happen" "$label $name is in $list but has not $verb: remove its line from the list"
		else
			echo "::notice title=Known $noun did not happen::$label $name is in $list but has not $verb"
		fi
	done < <(LC_ALL=C comm -13 "$found" "$listed")
}
# With RUST_TEST_ONLY, a list line that names a test this run does not run
# says nothing about it.
if [ -n "$only" ]; then
	cut -f1,2 "$tmp/only-run.tsv" | LC_ALL=C sort -u >"$tmp/only-names.tsv"
	for list in known-failures known-skips known-output flaky; do
		{ LC_ALL=C sort -u "$tmp/$list.tsv" | LC_ALL=C comm -12 - "$tmp/only-names.tsv"; awk -F'\t' '$1 !~ /^\/\//' "$tmp/$list.tsv"; } | LC_ALL=C sort -u >"$tmp/$list.here"
		mv "$tmp/$list.here" "$tmp/$list.tsv"
	done
fi
# The flaky reckoning (see flaky.tsv above). The attempts of a target are its
# logs in the main and root invocations (with RUST_TEST_ONLY, its only-*
# invocation, and flaky.tsv holds only the lines of tests that run there); a
# test failed on one when that log names it failed. The tests it judges, and
# the flaky lines, then leave the known-failure reconciling.
: >"$tmp/flaky-judged.tsv"
while IFS=$'\t' read -r label name; do
	attempts="$(awk -F'\t' -v t="$label" '$1 == t && ($7 == "main" || $7 == "root" || $7 ~ /^only-/) && $5 != "-" { n++ } END { print n + 0 }' "$rows")"
	fails="$(awk -F'\t' -v t="$label" -v n="$name" '$1 == t && $2 == n && ($4 == "main" || $4 == "root" || $4 ~ /^only-/) { print $3 }' "$tmp/failed-at.tsv" | LC_ALL=C sort -u | awk 'END { print NR }')"
	if [ "$attempts" = 0 ]; then
		error "Rust test flaky" "$label $name is listed flaky in $sami/rust-test-known-failures.txt, but the tree under test gave $label no result"
	elif [ "$fails" = 0 ]; then
		echo "::notice title=Known flaky test::$label $name is listed flaky in $sami/rust-test-known-failures.txt and did not fail"
	elif [ "$fails" -lt "$attempts" ]; then
		echo "Known flaky test, failed on $fails of $attempts attempts and passed on another: $label $name"
	else
		error "Rust test flaky" "$label $name is listed flaky in $sami/rust-test-known-failures.txt, but failed on every attempt ($fails of $attempts): NEW"
	fi
	printf '%s\t%s\n' "$label" "$name" >>"$tmp/flaky-judged.tsv"
done <"$tmp/flaky.tsv"
LC_ALL=C sort -u "$failed" | LC_ALL=C comm -23 - "$tmp/flaky-judged.tsv" >"$tmp/failed-left.tsv"
mv "$tmp/failed-left.tsv" "$failed"
LC_ALL=C sort -u "$tmp/known-failures.tsv" | LC_ALL=C comm -23 - "$tmp/flaky.tsv" >"$tmp/known-left.tsv"
mv "$tmp/known-left.tsv" "$tmp/known-failures.tsv"
reconcile "$failed" "$sami/rust-test-known-failures.txt" "$tmp/known-failures.tsv" failure failed "Rust test failed" error
reconcile "$skips" "$sami/rust-test-known-skips.txt" "$tmp/known-skips.tsv" skip "skipped itself" "Rust test skipped" error
echo "Skipped tests: $(count "$skips")"
# A passing test that printed, and is no skip in the words above, against
# .github/sami/rust-test-known-output.txt. An unlisted one's output is shown.
cut -f1,2 "$outputs" | LC_ALL=C sort -u >"$tmp/printed.tsv"
LC_ALL=C comm -23 "$tmp/printed.tsv" "$skips" >"$tmp/printed-not-skips.tsv"
reconcile "$tmp/printed-not-skips.tsv" "$sami/rust-test-known-output.txt" "$tmp/known-output.tsv" output printed "Rust test printed" notice
while IFS=$'\t' read -r label name; do
	log="$(awk -F'\t' -v l="$label" -v n="$name" '$1 == l && $2 == n { print $3; exit }' "$outputs")"
	echo "::group::$label $name printed (a skip in other words? name it in $sami/rust-test-known-output.txt only if it is none)"
	jq -R -r --arg n "$name" 'fromjson? | select(type == "object" and .type == "test" and .event == "ok" and .name == $n) | .stdout' "$log" | sed -n 1,40p
	echo "::endgroup::"
done < <(LC_ALL=C comm -23 "$tmp/printed-not-skips.tsv" "$tmp/known-output.tsv")
# The scan's own check: with no passing test's output in any record it could
# not have seen a skip (--show-output no longer reaching the record after a
# toolchain bump, say), and "no skip" would mean nothing. With
# RUST_TEST_ONLY, the canary must be among the tests that printed.
echo "Passing tests whose output the skip scan read: $(count "$tmp/printed.tsv")"
if [ ! -s "$tmp/printed.tsv" ]; then
	error "Rust test skips" "UNKNOWN: no passing test's output reached the skip scan, so it could not have seen a skip"
elif [ -n "$only" ]; then
	canary="$(printf '%s\n' "$RUST_TEST_CANARY" | awk '{ t = $1; $1 = ""; sub(/^ +/, ""); print t "\t" $0 }')"
	if ! grep -qxF -- "$canary" "$tmp/printed.tsv"; then
		error "Rust test skips" "UNKNOWN: the canary $RUST_TEST_CANARY printed nothing the skip scan read, so it could not have seen a skip"
	fi
fi

# With RUST_TEST_ONLY: each listed test ran here (ok or failed, not ignored
# and not absent). The accounting below is the Linux job's.
if [ -n "$only" ]; then
	awk -F'\t' '$7 ~ /^only-/ && $5 != "-" { print $1 "\t" $5 }' "$rows" >"$tmp/only-logs.tsv"
	: >"$tmp/only-ran.tsv"
	while IFS=$'\t' read -r label log; do
		[ -f "$log" ] || continue
		jq -R -r --arg target "$label" 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed")) | "\($target)\t\(.name)"' "$log" >>"$tmp/only-ran.tsv"
	done <"$tmp/only-logs.tsv"
	LC_ALL=C sort -u -o "$tmp/only-ran.tsv" "$tmp/only-ran.tsv"
	while IFS=$'\t' read -r target name; do
		if grep -qxF -- "$target"$'\t'"$name" "$tmp/only-ran.tsv"; then
			echo "Ran here, as $only names: $target $name"
		else
			error "Rust tests" "$target $name is in $only but did not run here (absent, renamed or #[ignore]d)"
		fi
	done <"$tmp/only.tsv"
	findings_end
	exit "$bad"
fi

# The accounting: every test of every test binary runs in some invocation,
# or is a sanctioned skip. A filter in a target's args (pi-builtins_test's
# `--skip ::foreign_owner::`, whose tests the root target runs), a positional
# filter, or a skip this script passes takes tests out, and libtest counts
# them as filtered_out. So each binary lists its tests (`--list`, the binary
# beside the original log; a native_test's binary is its src's); each log's
# reported tests plus its filtered_out must be that listing; and each listed
# test must be in some log of that binary. A binary with a log that ended
# early is left out: that log's error already names it.
listings="$tmp/listings"
mkdir -p "$listings"
declare -A listing_of=()
declare -A cut_short=()
: >"$tmp/ran.tsv"
k=0
while IFS=$'\t' read -r label rule _ _ log bin inv; do
	case "$rule" in "rust_test rule" | "native_test rule") ;; *) continue ;; esac
	[ -f "$log" ] || continue
	binary="$label"
	if [ "$rule" = "native_test rule" ]; then
		binary="${binary_of[$label]:--}"
		if [ "$binary" = - ]; then
			error "Rust test skips" "$label is a native_test whose src bazel query does not name"
			continue
		fi
	fi
	if [ -z "${listing_of[$binary]:-}" ]; then
		k=$((k + 1))
		if [ ! -x "$bin" ] || ! "$bin" --list >"$listings/$k.raw"; then
			error "Rust test skips" "$label's binary $bin cannot list its tests"
			continue
		fi
		listing_names "$listings/$k.raw" >"$listings/$k.txt"
		listing_of["$binary"]="$listings/$k.txt"
	fi
	listing="${listing_of[$binary]}"
	jq -R -r --arg binary "$binary" --arg inv "$inv" 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored")) | [$binary, .name, $inv, .event] | @tsv' "$log" >"$tmp/log-ran.tsv"
	cat "$tmp/log-ran.tsv" >>"$tmp/ran.tsv"
	if grep -qxF -- "$log" "$incomplete"; then
		cut_short["$binary"]=1
		continue
	fi
	filtered="$(jq -R -s '[split("\n")[] | fromjson? | select(type == "object" and .type == "suite" and (.event == "ok" or .event == "failed")) | .filtered_out // 0] | add // 0' "$log")"
	reported="$(count "$tmp/log-ran.tsv")"
	if [ "$((reported + filtered))" != "$(count "$listing")" ]; then
		error "Rust test skips" "$label ($inv) reported $reported tests and filtered out $filtered, but its binary lists $(count "$listing")"
	fi
done <"$rows"
for binary in "${!listing_of[@]}"; do
	[ -z "${cut_short[$binary]:-}" ] || continue
	awk -F'\t' -v b="$binary" '$1 == b { print $2 }' "$tmp/ran.tsv" | LC_ALL=C sort -u >"$tmp/ran-here.txt"
	awk -F'\t' -v b="$binary" '$1 == b { print $2 }' "$tmp/sanctioned.tsv" >"$tmp/sanctioned-here.txt"
	while read -r name; do
		if ! grep -qxF -- "$name" "$tmp/sanctioned-here.txt"; then
			error "Rust test skips" "$binary $name ran in no invocation: a filter in a target's args or a skip of this job took it out, and no other target runs it"
		fi
	done < <(LC_ALL=C comm -23 "${listing_of[$binary]}" "$tmp/ran-here.txt")
done
# Each skip the main invocation passed must take out exactly one test, of
# its named target, which then did not run there: libtest's --skip takes out
# every test whose name contains it, in every binary.
check_skip() {
	local title="$1" from="$2" target="$3" name="$4" binary matches
	[ -z "${absent[$target]:-}" ] || return 0
	if ! in_tree "$target"; then
		error "$title" "the skip $name in $from is of $target, which the tree under test has no target of (the main and root invocations gave it no result): that line is for another tree"
		return 0
	fi
	if did_not_build "$target"; then
		echo "::notice title=$title::UNKNOWN: $target did not build, so what its skip $name in $from takes out cannot be checked (the build failure fails the job)"
		return 0
	fi
	: >"$tmp/matches.tsv"
	for binary in "${!listing_of[@]}"; do
		awk -v b="$binary" -v n="$name" 'index($0, n) { print b "\t" $0 }' "${listing_of[$binary]}" >>"$tmp/matches.tsv"
	done
	matches="$(LC_ALL=C sort -u "$tmp/matches.tsv")"
	if [ "$matches" != "$target"$'\t'"$name" ]; then
		error "$title" "the skip $name in $from takes out $(count "$tmp/matches.tsv") tests of the main invocation, not exactly that one of $target: $(tr '\t\n' ': ' <"$tmp/matches.tsv")"
		return 0
	fi
	if awk -F'\t' -v b="$target" -v n="$name" '$1 == b && $2 == n && $3 == "main" { found = 1 } END { exit !found }' "$tmp/ran.tsv"; then
		error "$title" "$target $name ran in the main invocation, though $from skips it there"
		return 0
	fi
	echo "$title, taken out of the main invocation: $target $name"
}
for entry in "${sanctioned[@]}"; do
	IFS=$'\t' read -r target name <<<"$entry"
	check_skip "Sanctioned skip" "$sami/rust-test-sanctioned-skips.txt" "$target" "$name"
done
for entry in "${own[@]}"; do
	IFS=$'\t' read -r target name <<<"$entry"
	check_skip "Own-process test" "$sami/rust-test-own-process.txt" "$target" "$name"
done
for entry in "${root_alone[@]}"; do
	IFS=$'\t' read -r target name <<<"$entry"
	check_skip "Root test" "$sami/rust-test-root-alone.txt" "$target" "$name"
done
# An #[ignore]d test that no invocation ran (one that ran with --ignored is
# not one): a child process's entry point another test starts, or a test the
# macOS job runs; any other fails the job. A line of either list that names
# no such test fails it too: remove the line.
awk -F'\t' '$4 == "ok" || $4 == "failed" { print $1 "\t" $2 }' "$tmp/ran.tsv" | LC_ALL=C sort -u >"$tmp/ran-somewhere.tsv"
awk -F'\t' '$4 == "ignored" { print $1 "\t" $2 }' "$tmp/ran.tsv" | LC_ALL=C sort -u | LC_ALL=C comm -23 - "$tmp/ran-somewhere.tsv" >"$tmp/ignored.tsv"
LC_ALL=C sort -u -o "$tmp/child-entries.tsv" "$tmp/child-entries.tsv"
LC_ALL=C sort -u -o "$tmp/macos.tsv" "$tmp/macos.tsv"
while IFS=$'\t' read -r binary name; do
	if grep -qxF -- "$binary"$'\t'"$name" "$tmp/child-entries.tsv"; then
		echo "Ignored here, a child process's entry point another test starts: $binary $name"
	elif grep -qxF -- "$binary"$'\t'"$name" "$tmp/macos.tsv"; then
		echo "Ignored here, run by the macOS job: $binary $name"
	else
		error "Rust test skips" "$binary $name is #[ignore]d and runs in no invocation: run it ($sami/rust-test-ignored.txt, or rust-test-ignored-root.txt as root), or name it in rust-test-child-entries.txt or rust-test-macos.txt"
	fi
done <"$tmp/ignored.tsv"
for list in child-entries macos; do
	while IFS=$'\t' read -r binary name; do
		if did_not_build "$binary"; then
			echo "::notice title=Rust test skips::UNKNOWN: $binary did not build, so whether $name, which $sami/rust-test-$list.txt names, is still an #[ignore]d test is not known (the build failure fails the job)"
		else
			error "Rust test skips" "$binary $name is in $sami/rust-test-$list.txt but is no #[ignore]d test this job leaves unrun: remove its line"
		fi
	done < <(LC_ALL=C comm -13 "$tmp/ignored.tsv" "$tmp/$list.tsv")
done
# Each parent a child entry names is a test of the child's binary: a parent
# renamed or deleted fails here, before the child silently runs nowhere. A
# binary that did not build, or whose listing could not be read, is not
# looked in: UNKNOWN, in a notice (the build or listing error fails the job).
while IFS=$'\t' read -r binary child parent; do
	if did_not_build "$binary"; then
		echo "::notice title=Rust test child entry::UNKNOWN: $binary did not build, so whether $parent, which starts $child, is a test of it is not known (the build failure fails the job)"
	elif ! in_tree "$binary"; then
		error "Rust test child entry" "$binary $child is in $sami/rust-test-child-entries.txt, but the tree under test has no target $binary: that line is for another tree"
	elif [ -z "${listing_of[$binary]:-}" ]; then
		echo "::notice title=Rust test child entry::UNKNOWN: $binary's tests could not be listed, so whether $parent, which starts $child, is a test of it is not known (the listing error fails the job)"
	elif grep -qxF -- "$parent" "${listing_of[$binary]}"; then
		echo "Child entry's parent is a test of its binary: $binary $parent starts $child"
	else
		error "Rust test child entry" "$parent, which $sami/rust-test-child-entries.txt names as the test that starts $binary $child, is no test of $binary (renamed or deleted), so nothing would show that $child runs nowhere: name the test that starts it now"
	fi
done <"$tmp/child-parents.tsv"
echo "Test binaries listed: ${#listing_of[@]}; #[ignore]d tests no invocation ran: $(count "$tmp/ignored.tsv")"
# The listings drift check reads each binary's listing: index.tsv names the
# listing file of each (a native_test's binary is its src's).
for binary in "${!listing_of[@]}"; do
	printf '%s\t%s\n' "$binary" "$(basename "${listing_of[$binary]}")"
done | LC_ALL=C sort >"$listings/index.tsv"
echo "Listings for the drift check: $(count "$listings/index.tsv") binaries in $listings"
findings_end
exit "$bad"
