#!/usr/bin/env bash
# The test step of the rust_test jobs in .github/workflows/sami-build.yml: a
# red Rust test stops a sami release.
#
# On Linux (the rust_test job) it runs every Bazel test target under
# //crates, every test target of the cargo workspaces Bazel does not build,
# and, under cargo too, the doctests of every crate that has a Bazel doctest
# target (whose runner shows no passing doctest's output), reads each test
# log, and fails when:
#   - a test fails that .github/sami/rust-test-known-failures.txt does not
#     name, or a test it names does not fail;
#   - a target fails to build or has no result, or its test binary ends
#     before its tests do;
#   - a test or doctest skips itself or prints (see "Skips" below), unless a
#     list names it;
#   - a test of a test binary runs in no invocation (a filter in its target's
#     args, or a skip this script passes, took it out), unless
#     .github/sami/rust-test-sanctioned-skips.txt names it;
#   - an #[ignore]d test runs nowhere: each one is run alone with --ignored
#     (.github/sami/rust-test-ignored.txt, a Bazel target or a cargo one, or
#     as root .github/sami/rust-test-ignored-root.txt), or is a child
#     process's entry point that another test starts
#     (.github/sami/rust-test-child-entries.txt), or runs in the macOS job
#     (.github/sami/rust-test-macos.txt);
#   (An ```ignore doc block is not a test: upstream marks it so that rustdoc
#   never runs it. It counts neither as run nor against the job; the step
#   prints how many there are and where.)
#   - a test named in .github/sami/rust-test-own-process.txt does not run
#     alone in an invocation of its own, or also runs in the main one;
#   - a target in .github/sami/rust-test-root-targets.txt prints `not run:`,
#     or passes another number of tests than its line names.
# It leaves each test binary's listing in $RUNNER_TEMP/rust-test/listings
# (index.tsv names the binary of each), for the macOS job's inventory
# (.github/sami/rust-test-macos-inventory.sh).
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
# Usage: rust-test.sh, from the repository root, with these set:
#   RUNNER_TEMP         a scratch directory for the event logs and log copies
#   OMP_BAZEL_RC        the bazelrc fragment .github/actions/bazel-cache wrote
#   RUST_TEST_PATH      the tests' PATH (the reference rsync first)
#   RUST_TEST_TMPDIR    a directory on the reflink filesystem; each test action
#                       gets a directory of its own under it, as its TMPDIR
#   PI_TEST_REAL_BASH   the bash 5.2.21 the bash-oracle tests compare with
#   PI_AST_REPO_CORPUS  the checkout pi-ast's corpus test walks
# and, for the macOS job, RUST_TEST_ONLY and RUST_TEST_CANARY (above).
# .github/sami/tests/run.sh runs this script against stubs of bazelisk and
# rustup.
set -euo pipefail

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
	echo "::error title=Rust tests::bash ${BASH_VERSION} is too old: this script needs bash 4 or later"
	exit 1
fi
for v in RUNNER_TEMP OMP_BAZEL_RC RUST_TEST_PATH RUST_TEST_TMPDIR PI_TEST_REAL_BASH PI_AST_REPO_CORPUS; do
	if [ -z "${!v:-}" ]; then
		echo "::error title=Rust tests::$v is not set"
		exit 1
	fi
done
only="${RUST_TEST_ONLY:-}"
if [ -n "$only" ] && [ -z "${RUST_TEST_CANARY:-}" ]; then
	echo "::error title=Rust tests::RUST_TEST_ONLY is set and RUST_TEST_CANARY is not"
	exit 1
fi
if [ "$(ulimit -Sn)" != unlimited ] && [ "$(ulimit -Sn)" -lt 65536 ]; then ulimit -Sn 65536 || true; fi

sami=.github/sami
tmp="$RUNNER_TEMP/rust-test"
mkdir -p "$tmp/logs"
bad=0

# error <title> <message>: an error annotation; the step fails at its end.
error() {
	echo "::error title=$1::$2"
	bad=1
}

# stop <message>: an error annotation, and the step stops here.
stop() {
	echo "::error title=Rust tests::$1"
	exit 1
}

# count <file>: its lines (wc -l pads its count on macOS).
count() {
	awk 'END { print NR }' "$1"
}

# list_entries <list file> <fields>: each entry of a list, as tab-separated
# fields. An entry line is `<first> <second>  <why>` (fields 2) or
# `<first>  <why>` (fields 1): the first field is the first word, and the
# second is everything after it up to two spaces, so a second field with
# single spaces in it, such as a doctest's `src/lib.rs - f (line 3)`, is read
# whole. Lines that are blank or start with `#` are comments. A line without
# its fields fails.
list_entries() {
	awk -v fields="$2" '
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/[[:space:]]+$/, "", line)
			i = index(line, " ")
			first = (i ? substr(line, 1, i - 1) : line)
			if (fields == 1) { print first; next }
			rest = (i ? substr(line, i + 1) : "")
			j = index(rest, "  ")
			second = (j ? substr(rest, 1, j - 1) : rest)
			if (second == "" || second ~ /^ /) {
				printf "%s:%d: no second field: %s\n", FILENAME, FNR, $0 > "/dev/stderr"
				bad = 1
				next
			}
			print first "\t" second
		}
		END { exit bad }' "$1"
}

# entries <list> <fields> <tsv>: list_entries of .github/sami/<list>.
entries() {
	list_entries "$sami/$1" "$2" >"$tmp/$3" || stop "$sami/$1 has a line without its fields (above)"
}
entries rust-test-known-failures.txt 2 known-failures.tsv
entries rust-test-known-skips.txt 2 known-skips.tsv
entries rust-test-known-output.txt 2 known-output.tsv
entries rust-test-sanctioned-skips.txt 2 sanctioned.tsv
entries rust-test-own-process.txt 2 own.tsv
entries rust-test-root-targets.txt 2 roots.tsv
entries rust-test-cargo-workspaces.txt 1 cargo-workspaces.txt
entries rust-test-ignored.txt 2 ignored-run.tsv
entries rust-test-ignored-root.txt 2 ignored-root.tsv
entries rust-test-child-entries.txt 2 child-entries.tsv
entries rust-test-macos.txt 2 macos.tsv
if [ -n "$only" ]; then
	list_entries "$only" 2 >"$tmp/only.tsv" || stop "$only has a line without its fields (above)"
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
# .github/sami/rust-test-ignored.txt names Bazel targets (`//…`) and cargo
# ones (`<directory>:<kind>:<name>`, as the cargo branch below labels them).
ignored_run=()
ignored_cargo=()
while IFS=$'\t' read -r target name; do
	case "$target" in
		//*) ignored_run+=("$target"$'\t'"$name") ;;
		*) ignored_cargo+=("$target"$'\t'"$name") ;;
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
# ignored-<n>, ignored-root-<n>, only-<n> or cargo). An empty field is `-`:
# bash's read joins adjacent tabs.
rows="$tmp/rows.tsv"
: >"$rows"
nlog=0
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
	while IFS=$'\t' read -r label rule status kind log; do
		copy="$log"
		bin=-
		if [ -f "$log" ]; then
			nlog=$((nlog + 1))
			copy="$tmp/logs/$nlog.log"
			cp "$log" "$copy"
			# testlogs/<package>/<target>/test.log, or a retried attempt's
			# log in test_attempts/ below it: the binary is bin/<package>/<target>.
			bin="$(dirname "$log")"
			bin="${bin%/test_attempts}"
			bin="${bin/\/testlogs\//\/bin\/}"
		fi
		printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$rule" "$status" "$kind" "$copy" "$bin" "$inv" >>"$rows"
	done <"$tmp/bep-rows.tsv"
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
			echo "::error title=Rust tests::bazel test exited $code ($inv), which is neither a test nor a build failure"
			exit "$code"
			;;
	esac
	collect "$inv" "$bep"
}

# check_alone <title> <invocation> <target> <name>: an invocation that ran one
# test alone must report exactly that test, and run it: a filter that
# matches nothing (a renamed test), or an #[ignore] the invocation did not
# lift, cannot pass as the test.
check_alone() {
	local title="$1" inv="$2" target="$3" name="$4" log event
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
	bazel_test main "$tmpdir_under" "${skip_flags[@]}" -- //crates/... "${not_roots[@]}"
	if [ "${#roots[@]}" -gt 0 ]; then
		bazel_test root "$root_under" -- "${roots[@]}"
	fi
	# Each own-process test alone: its target with libtest's --exact filter,
	# one invocation per test.
	for i in "${!own[@]}"; do
		IFS=$'\t' read -r target name <<<"${own[$i]}"
		bazel_test "own-$i" "$tmpdir_under" --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# Each #[ignore]d test the job runs anyway, alone, with --ignored. One
	# run alone can take longer than Bazel's 300 s default for a medium test
	# (pi-ast's whole-repository sweep), so these get 1200 s.
	for i in "${!ignored_run[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_run[$i]}"
		bazel_test "ignored-$i" "$tmpdir_under" --test_timeout=1200 --test_arg=--ignored --test_arg=--exact --test_arg="$name" -- "$target"
	done
	# The same as root, out of the sandbox (linux-sandbox maps one uid), as
	# the root targets run; last, since root's runs leave root's files in
	# the target's test outputs.
	for i in "${!ignored_root[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_root[$i]}"
		bazel_test "ignored-root-$i" "$root_under" --strategy=TestRunner=local --test_timeout=1200 --test_arg=--ignored --test_arg=--exact --test_arg="$name" -- "$target"
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
		bazel_test "only-$n" "$tmpdir_under" --test_arg=--exact "${filters[@]}" -- "$target"
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
	for i in "${!ignored_run[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_run[$i]}"
		check_alone "Ignored test" "ignored-$i" "$target" "$name"
	done
	for i in "${!ignored_root[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_root[$i]}"
		check_alone "Ignored root test" "ignored-root-$i" "$target" "$name"
	done
fi

# Cargo workspaces Bazel does not build (sdk/ is in .bazelignore), listed in
# .github/sami/rust-test-cargo-workspaces.txt: every test target of each runs
# under cargo with the root's pinned nightly, one log per target, read below
# as a rust_test log, with the stderr cargo kept beside it. The target is
# `<directory>:<kind>:<name>` (kind lib, bin, test, example, bench or doc). A
# failed cargo metadata stops the step.
# Then the doctests of each crate with a Bazel doctest target run again under
# cargo, as `<directory>:doc`: rules_rust's doctest runner takes no test
# arguments, so its log shows neither a passing doctest's output nor one in
# JSON. Even under cargo, rustdoc keeps a passing doctest's output out of the
# record (`--show-output` reaches only libtest), so these run with rustdoc's
# `--no-capture` and one thread, and doc_attribute gives each doctest the
# lines printed between its start and its result (run 44889772803: a planted
# doctest's `skipped:` line reached no record without them).
# Then each #[ignore]d cargo test that .github/sami/rust-test-ignored.txt
# names runs alone, with --ignored and --exact.
channel=""
ncargo=0
# doc_attribute: a doctest record whose output rustdoc's --no-capture printed
# raw (stdout and stderr, one thread) between each test's `started` event and
# its result, as libtest's record with that output as the result's stdout. A
# line outside every test stays as it is.
doc_attribute() {
	jq -R -r -n '
		reduce inputs as $l ({cur: null, buf: "", out: []};
			(try ($l | fromjson) catch null) as $o
			| if ($o | type) == "object" and ($o.type == "test" or $o.type == "suite") then
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
	local label="$1" manifest="$2" inv="$3" log err code=0 doc=0 a
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
	if [ "$doc" = 1 ]; then
		err="$log.raw"
		RUSTDOCFLAGS="${RUSTDOCFLAGS:+$RUSTDOCFLAGS }-Zunstable-options --no-capture" rustup run "$channel" cargo test --locked --manifest-path "$manifest" "$@" -Zunstable-options --format=json --show-output --test-threads=1 >"$err" 2>&1 || code=$?
		doc_attribute <"$err" >"$log"
		: >"$log.err"
	else
		${under[@]+"${under[@]}"} rustup run "$channel" cargo test --locked ${offline[@]+"${offline[@]}"} --manifest-path "$manifest" "$@" -Zunstable-options --format=json --show-output >"$log" 2>"$err" || code=$?
	fi
	if [ "$code" = 0 ]; then
		printf '%s\tcargo test\tPASSED\tpassed\t%s\t-\t%s\n' "$label" "$log" "$inv" >>"$rows"
	else
		echo "::group::$label: cargo test exited $code"
		tail -n 50 "$err"
		echo "::endgroup::"
		printf '%s\tcargo test\tFAILED\tfailed\t%s\t-\t%s\n' "$label" "$log" "$inv" >>"$rows"
	fi
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
	# The crates whose doctests run again under cargo: those with a Bazel
	# doctest target, from this run's rows (Linux) or, when this run ran no
	# doctest target (RUST_TEST_ONLY, the macOS job), from bazel query.
	if [ -z "$only" ]; then
		awk -F'\t' '$2 == "rust_doc_test rule" { d = $1; sub(/^\/\//, "", d); sub(/:.*/, "", d); print d }' "$rows" | LC_ALL=C sort -u >"$tmp/doc-dirs.txt"
	else
		bazelisk query --output=label 'kind("rust_doc_test rule", //crates/...) - attr(tags, "manual", //crates/...)' >"$tmp/doc-targets.txt" || stop "bazel query for the doctest targets failed"
		sed -e 's|^//||' -e 's|:.*||' "$tmp/doc-targets.txt" | LC_ALL=C sort -u >"$tmp/doc-dirs.txt"
	fi
	while read -r dir; do
		cargo_test "$dir:doc" "$dir/Cargo.toml" cargo --doc --
	done <"$tmp/doc-dirs.txt"
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

# The cargo workspaces and the cargo doctests run in both jobs: on macOS,
# that is how a cargo test or a doctest compiled only there runs.
run_cargo
if [ -z "$only" ]; then
	for i in "${!ignored_cargo[@]}"; do
		IFS=$'\t' read -r target name <<<"${ignored_cargo[$i]}"
		check_alone "Ignored cargo test" "ignored-cargo-$i" "$target" "$name"
	done
	check_results_exist
fi

# The skip scan (see "Skips" above). skip_line matches a skip line in a
# passing test's output; raw_skip_line matches one outside the record.
skip_line='^([A-Za-z0-9_:]+: )?(skipped|skipping|SKIP|not run|UNCOMPARED)[ :]'
raw_skip_line='(^|: )(skipped|skipping|SKIP|not run|UNCOMPARED)[ :]'
failed="$tmp/failed.tsv"
skips="$tmp/skips.tsv"
outputs="$tmp/outputs.tsv"
incomplete="$tmp/incomplete.txt"
: >"$failed"
: >"$skips"
: >"$outputs"
: >"$incomplete"

# scan_output <target> <log>...: the skips and the passing tests' output in
# a libtest log, and in the stderr cargo kept beside it. Only a passing test
# is read: a failed test fails the job anyway, and its report can quote a
# tool's own `skipping` line (rsync's `skipping non-regular file`, run
# 44807499064), which is no skip.
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
	while IFS= read -r line; do
		if [[ "$line" =~ ^([A-Za-z0-9_:]+):\ (skipped|skipping|SKIP|not\ run|UNCOMPARED)[\ :] ]]; then
			printf '%s\t%s\n' "$label" "${BASH_REMATCH[1]}" >>"$skips"
		else
			error "Rust tests" "$label printed a skip line outside libtest's record that names no test: $line"
		fi
	done < <(cat -- "$@" | grep -v '^{' | grep -E "$raw_skip_line" || true)
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
	# grep -c, not -q: under pipefail a grep -q that stops early can kill the
	# grep before it with SIGPIPE and read as clean.
	if [ "$(grep -v '^{' "$log" | grep -c 'not run:' || true)" != 0 ]; then
		error "Rust tests" "$label printed 'not run:' outside libtest's record, though it runs as root: $(grep -v '^{' "$log" | grep 'not run:' | sed -n 1p)"
	fi
	passed="$(jq -R -s -r '[split("\n")[] | fromjson? | select(type == "object" and .type == "test" and .event == "ok")] | length' "$log")"
	if [ "$passed" != "${root_tests[$label]}" ]; then
		error "Rust tests" "$label passed $passed tests, and $sami/rust-test-root-targets.txt names ${root_tests[$label]}"
	fi
}

# add_failed <target> <status> <names>: a failed log's failed tests, one per
# line. A failed log that names none (a crash, a timeout) fails the job,
# since the list cannot account for it.
add_failed() {
	if [ -z "$3" ]; then
		error "Rust tests" "$1 is $2 and its log names no failed test"
		return 0
	fi
	printf '%s\n' "$3" | awk -v label="$1" 'NF { print label "\t" $0 }' >>"$failed"
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
# once here; the accounting below leaves its binary out.
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
		error "Rust tests" "$label is $status, but libtest planned $planned tests and reported $reported, suite end $ended: the test binary ended before its tests did"
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
			# A crate's cargo doctests that ran, against its Bazel doctests
			# (below).
			case "$label" in
				*:doc)
					jq -R -r --arg dir "$(doc_dir "$label")" 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed")) | "\($dir)\t\(.name)"' "$log" >>"$tmp/doc-names-cargo.tsv"
					;;
			esac
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
	add_failed "$label" "$status" "$names"
}

# check_doctest <target> <status> <kind> <log>: a rust_doc_test log is the
# doctest runner's text. Its first `running N tests` header must equal its
# last summary's passed + failed + ignored + measured, so a summary a child
# process printed does not stand for the runner's; a passed log's last
# summary must be `test result: ok.`. A failed one ends with `failures:`,
# each failed doctest indented four spaces, a blank line and `test result:
# FAILED.`. No doctest may be filtered out: no list names one. An ```ignore
# block is no test: each `test <name> ... ignored` line is counted apart (an
# ignored count whose names the log does not give fails). The doctests that
# ran are compared with cargo's re-run of the same crate (below).
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
	add_failed "$label" "$status" "$names"
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

# The cargo re-run reads each doctest's output, so it must have run the same
# doctests as Bazel's doctest target of the crate (whose crate features can
# differ from cargo's defaults): each crate's names, both ways, without the
# crate's directory.
if [ -z "$only" ]; then
	touch "$tmp/doc-names-bazel.tsv" "$tmp/doc-names-cargo.tsv"
	awk -F'\t' '{ d = $1; n = $2; if (index(n, d "/") == 1) n = substr(n, length(d) + 2); print d "\t" n }' "$tmp/doc-names-cargo.tsv" | LC_ALL=C sort -u >"$tmp/doc-cargo.tsv"
	LC_ALL=C sort -u "$tmp/doc-names-bazel.tsv" >"$tmp/doc-bazel.tsv"
	while IFS=$'\t' read -r dir name; do
		error "Rust tests" "$dir $name ran in Bazel's doctest target and not in cargo's doctest run of $dir, whose output the skip scan reads: give cargo the same features"
	done < <(LC_ALL=C comm -23 "$tmp/doc-bazel.tsv" "$tmp/doc-cargo.tsv")
	while IFS=$'\t' read -r dir name; do
		error "Rust tests" "$dir $name ran in cargo's doctest run and not in Bazel's doctest target of $dir"
	done < <(LC_ALL=C comm -13 "$tmp/doc-bazel.tsv" "$tmp/doc-cargo.tsv")
	echo "Doctests that ran in Bazel and in cargo's readable re-run: $(LC_ALL=C comm -12 "$tmp/doc-bazel.tsv" "$tmp/doc-cargo.tsv" | awk 'END { print NR }')"
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
	for list in known-failures known-skips known-output; do
		{ LC_ALL=C sort -u "$tmp/$list.tsv" | LC_ALL=C comm -12 - "$tmp/only-names.tsv"; awk -F'\t' '$1 !~ /^\/\//' "$tmp/$list.tsv"; } | LC_ALL=C sort -u >"$tmp/$list.here"
		mv "$tmp/$list.here" "$tmp/$list.tsv"
	done
fi
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
		sed -n -e 's/: test$//p' -e 's/: benchmark$//p' "$listings/$k.raw" | LC_ALL=C sort -u >"$listings/$k.txt"
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
		error "Rust test skips" "$binary $name is in $sami/rust-test-$list.txt but is no #[ignore]d test this job leaves unrun: remove its line"
	done < <(LC_ALL=C comm -13 "$tmp/ignored.tsv" "$tmp/$list.tsv")
done
echo "Test binaries listed: ${#listing_of[@]}; #[ignore]d tests no invocation ran: $(count "$tmp/ignored.tsv")"
# The macOS job's inventory reads each binary's listing: index.tsv names the
# listing file of each (a native_test's binary is its src's).
for binary in "${!listing_of[@]}"; do
	printf '%s\t%s\n' "$binary" "$(basename "${listing_of[$binary]}")"
done | LC_ALL=C sort >"$listings/index.tsv"
echo "Listings for the macOS inventory: $(count "$listings/index.tsv") binaries in $listings"
exit "$bad"
