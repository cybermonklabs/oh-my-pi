#!/usr/bin/env bash
# Regression tests for the rust_test job's scripts in .github/sami, with no
# network, Bazel or cargo: the job (.github/workflows/sami-rust-test.yml)
# runs this before its build.
#   - rust-test.sh, the test step, against stubs of bazelisk and rustup. The
#     bazelisk stub checks each invocation's arguments, then writes the build
#     event log and the test logs a case describes, laid out as Bazel lays
#     them out, with a test binary beside each log that lists its tests.
#   - fetch-verified.sh, with a stub in place of curl.
#   - rust-test-parity.sh, against stubs of cargo and bazelisk query.
#   - rust-test-early-listings.sh, against stubs of cargo metadata and
#     bazelisk query, build and info, and test binaries that list their tests
#     (cases E*); rust-test-listings-drift.sh (cases D*).
#   - rust-test-tmpdir.sh, and libtest-bound.py (its own selftest) under it.
#   - release-candidate.sh, publish's checks, by release-candidate-harness.sh
#     with a stub in place of gh (cases RC-*).
#   - sami-build.yml and .github/actions/bun-install: only release_binary
#     may use the GitHub Actions cache, only release_cache_prune may hold
#     actions: write and only attest id-token: write, and neither runs
#     member code (cache_lint); and sami-rust-test.yml, whose jobs run the
#     tests: none of them may use the cache or hold either permission.
#   - the candidate branch: every file that names the branch a candidate is
#     pushed to names the same one (candidate_lint, cases C*).
#   - the build seed: gate-seed.sh, against stubs of bazelisk and gh (its
#     writer, cases G14 to G16; its reader's every path, cases G1 to G13, with
#     the planted sha256 mismatch G2), and rust-test-results-compare.sh, which
#     holds a seeded run's per-test results against a cold one's (cases Z*).
#   - the seed is the gate's and it is no cache: no job of sami-build.yml names
#     it, no job of sami-checks.yml holds a cache token, and no two calls of
#     sami-rust-test.yml share an artifact name (seed_lint, cases Y*).
# Each case checks an exit code and a message. RUST_TEST_SH runs the cases
# against another copy of the test step, and LEGACY=1 drops the argument
# checks that copy predates (to show which cases an older step fails).
# TOOLBIN, a directory, goes first on PATH (to run with the runner's jq 1.6
# and mawk).
# Usage: run.sh [<case name regex>]
# The log and event-log writers below run inside the bazelisk stub, which
# sets logs, W and bep, and the stub bodies are single-quoted on purpose.
# shellcheck disable=SC2016,SC2154
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
fixtures="$here/fixtures"
# Real libtest records; a case whose fixture is gone would test nothing.
for f in diff-failed.json diff-ok.json early.json fail.json fine.json root-nonroot.json root-root.json root-stderr-nonroot.json skip-raw-named.txt skip-raw-unnamed.txt; do
	if [ ! -s "$fixtures/$f" ]; then
		echo "fixture $fixtures/$f is missing or empty"
		exit 1
	fi
done
step="${RUST_TEST_SH:-$repo/.github/sami/rust-test.sh}"
only="${1:-}"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
pass=0
fail=0
skip=0

# --- log writers; FMT is json or text ----------------------------------------
# lt_pass <names...>: a libtest run whose tests all pass; FILTERED sets its
# filtered_out.
lt_pass() {
	if [ "$FMT" = json ]; then
		printf '{ "type": "suite", "event": "started", "test_count": %d }\n' "$#"
		for n in "$@"; do printf '{ "type": "test", "event": "started", "name": "%s" }\n{ "type": "test", "name": "%s", "event": "ok" }\n' "$n" "$n"; done
		printf '{ "type": "suite", "event": "ok", "passed": %d, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": %d, "exec_time": 0.01 }\n' "$#" "${FILTERED:-0}"
	else
		printf '\nrunning %d tests\n' "$#"
		for n in "$@"; do printf 'test %s ... ok\n' "$n"; done
		printf '\ntest result: ok. %d passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\n' "$#"
	fi
}
# lt_fail <failed names...>: a run with one passing test and these failing.
lt_fail() {
	if [ "$FMT" = json ]; then
		printf '{ "type": "suite", "event": "started", "test_count": %d }\n' "$(($# + 1))"
		printf '{ "type": "test", "name": "x::passes", "event": "ok" }\n'
		for n in "$@"; do printf '{ "type": "test", "name": "%s", "event": "failed", "stdout": "thread panicked at src/x.rs:1:1\\nfailures:\\n    x::decoy\\n" }\n' "$n"; done
		printf '{ "type": "suite", "event": "failed", "passed": 1, "failed": %d, "ignored": 0, "measured": 0, "filtered_out": %d, "exec_time": 0.01 }\n' "$#" "${FILTERED:-0}"
	else
		printf '\nrunning %d tests\n' "$(($# + 1))"
		for n in "$@"; do printf 'test %s ... FAILED\n' "$n"; done
		printf 'test x::passes ... ok\n\nfailures:\n\n'
		for n in "$@"; do printf -- '---- %s stdout ----\nthread panicked\nfailures:\n    x::decoy\n\n' "$n"; done
		printf '\nfailures:\n'
		for n in "$@"; do printf '    %s\n' "$n"; done
		printf '\ntest result: FAILED. 1 passed; %d failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n\n' "$#"
	fi
}
# lt_out <name> <stdout> [<name> <stdout>]...: passing tests with this
# output (a JSON string's body).
lt_out() {
	printf '{ "type": "suite", "event": "started", "test_count": %d }\n' "$(($# / 2))"
	while [ "$#" -ge 2 ]; do
		if [ -n "$2" ]; then
			printf '{ "type": "test", "name": "%s", "event": "ok", "stdout": "%s" }\n' "$1" "$2"
		else
			printf '{ "type": "test", "name": "%s", "event": "ok" }\n' "$1"
		fi
		shift 2
	done
	printf '{ "type": "suite", "event": "ok", "passed": 0, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": %d, "exec_time": 0.1 }\n' "${FILTERED:-0}"
}
# lt_ignored <ran> <ignored>: one passing test, one #[ignore]d.
lt_ignored() {
	printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "name": "%s", "event": "ok" }\n{ "type": "test", "name": "%s", "event": "ignored" }\n' "$1" "$2"
	printf '{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 1, "measured": 0, "filtered_out": %d, "exec_time": 0.1 }\n' "${FILTERED:-0}"
}
# lt_partial: a run of 2 tests that ends (crash, timeout, exit 0) after 1 started.
lt_partial() {
	if [ "$FMT" = json ]; then
		printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "event": "started", "name": "a::first" }\n'
	else
		printf '\nrunning 2 tests\ntest a::first ... '
	fi
}
# lt_child_summary: the binary starts 2 tests, a child process prints a whole
# libtest text summary, then the binary exits 0 before its own.
lt_child_summary() {
	lt_partial
	printf '\nrunning 1 test\ntest c::x ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n'
}
# doc_pass / doc_fail <names...>: rules_rust's doctest runner, always text.
doc_pass() { printf '\nrunning 1 test\ntest src/lib.rs - f (line 3) ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n'; }
doc_fail() {
	printf '\nrunning %d tests\n' "$#"
	for n in "$@"; do printf 'test %s ... FAILED\n' "$n"; done
	printf '\nfailures:\n\n'
	for n in "$@"; do printf -- '---- %s stdout ----\nboom\n\n' "$n"; done
	printf '\nfailures:\n'
	for n in "$@"; do printf '    %s\n' "$n"; done
	printf '\ntest result: FAILED. 0 passed; %d failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s\n' "$#"
}

# --- build event log writers ---------------------------------------------------
cfg() { jq -cn --arg l "$1" --arg k "$2" '{id:{targetConfigured:{label:$l}},configured:{targetKind:$k}}'; }
# unbuilt <label>: the event Bazel writes for a target that did not build,
# which then has no test summary at all.
unbuilt() { jq -cn --arg l "$1" '{id: {targetCompleted: {label: $l}}, completed: {success: false}}'; }
summary() { # label status [failed logs] [passed logs], each list split on spaces; RUN_S: its totalRunDuration
	jq -cn --arg l "$1" --arg s "$2" --arg f "${3:-}" --arg p "${4:-}" --arg d "${RUN_S:-}" 'def logs($x): $x | split(" ") | map(select(. != "") | {name:"test.log",uri:("file://" + .)});
		{id:{testSummary:{label:$l,configuration:{id:"c"}}},testSummary:({overallStatus:$s,totalRunCount:1}
		+ (if $d != "" then {totalRunDuration:($d + "s")} else {} end)
		+ (if $p != "" then {passed:logs($p)} else {} end)
		+ (if $f != "" then {failed:logs($f)} else {} end))}'
}
# metrics <milliseconds>: the event that gives the invocation's wall time.
metrics() { jq -cn --arg w "$1" '{id: {buildMetrics: {}}, buildMetrics: {timingMetrics: {wallTimeInMs: $w}}}'; }
# attempt <label> <status> <attempt> <seconds>: the testResult event of one
# test attempt, its run time as testAttemptDuration (MILLIS=1: as the older
# testAttemptDurationMillis, <seconds> then in milliseconds; CACHED=1: a
# result Bazel reused from an earlier run; SHARD: its shard, 1 by default).
attempt() {
	jq -cn --arg l "$1" --arg s "$2" --argjson a "$3" --arg d "$4" --arg m "${MILLIS:-}" --arg c "${CACHED:-}" --argjson sh "${SHARD:-1}" '{id:{testResult:{label:$l,run:1,shard:$sh,attempt:$a,configuration:{id:"c"}}},testResult:({status:$s}
		+ (if $m != "" then {testAttemptDurationMillis:$d} else {testAttemptDuration:($d + "s")} end)
		+ (if $c != "" then {cachedLocally:true} else {} end))}'
}
# tpath / bpath <label>: a target's test.log and test binary, as Bazel lays
# them out under bazel-out.
tpath() { local l="${1#//}"; printf '%s/out/testlogs/%s/%s/test.log' "$logs" "${l%%:*}" "${l#*:}"; }
bpath() { local l="${1#//}"; printf '%s/out/bin/%s/%s' "$logs" "${l%%:*}" "${l#*:}"; }
# fakebin <label> <names...>: the target's test binary, which lists these
# tests; written once, as Bazel builds a binary once for every invocation.
fakebin() {
	local b n
	b="$(bpath "$1")"
	shift
	[ -e "$b" ] && return 0
	mkdir -p "$(dirname "$b")"
	{
		printf '#!/bin/sh\n[ "$1" = --list ] || exit 2\n'
		for n in "$@"; do printf "echo '%s: test'\n" "$n"; done
		printf 'echo\necho "%s tests, 0 benchmarks"\n' "$#"
	} >"$b"
	chmod +x "$b"
}
# record_names <log>: the tests a libtest record reports, an event that shares
# a line with raw output included (the binary lists every test it ran).
record_names() { sed 's/^.*{ "type": /{ "type": /' "$1" | jq -R -r 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored")) | .name'; }
# target <rule> <label> <status> <writer...>: a target and its one log; its
# binary lists the tests its record reports, plus EXTRA_LISTED.
target() {
	local rule="$1" label="$2" status="$3" f
	shift 3
	f="$(tpath "$label")"
	mkdir -p "$(dirname "$f")"
	"$@" >"$f"
	# shellcheck disable=SC2046,SC2086 # one word per test name
	fakebin "$label" $(record_names "$f") ${EXTRA_LISTED:-}
	cfg "$label" "$rule"
	if [ "$status" = PASSED ]; then summary "$label" "$status" "" "$f"; else summary "$label" "$status" "$f"; fi
}
rt() { target "rust_test rule" "$@"; }
dt() { target "rust_doc_test rule" "$@"; }
# nt <label> <src> <status> <writer...>: a native_test of <src>'s binary.
nt() {
	local label="$1" src="$2"
	shift 2
	printf '%s\t%s\n' "$label" "$src" >>"$W/native.tsv"
	target "native_test rule" "$label" "$@"
}
# listed <label> <listed tests...> -- <tests in the record...>: a rust_test
# whose binary lists more tests than its record reports; the record's
# filtered_out is the difference.
listed() {
	local label="$1" side=list n f
	shift
	local list=() ran=()
	for n in "$@"; do if [ "$n" = -- ]; then side=ran; continue; fi; if [ "$side" = list ]; then list+=("$n"); else ran+=("$n"); fi; done
	fakebin "$label" "${list[@]}"
	f="$(tpath "$label")"
	mkdir -p "$(dirname "$f")"
	FILTERED=$((${#list[@]} - ${#ran[@]})) FMT=json lt_pass "${ran[@]}" >"$f"
	cfg "$label" "rust_test rule"
	summary "$label" PASSED "" "$f"
}
# sanct <listed tests...> -- <tests in the record...>: pi-builtins_test.
sanct() { listed //crates/pi-builtins:pi-builtins_test "$@"; }
# query_names <labels...>: the test targets bazel query names (by default,
# the targets of the build event logs).
query_names() {
	printf '%s\n' "$@" >"$W/query.txt"
	for l in "$@"; do jq -cn --arg l "$l" '{type: "RULE", rule: {name: $l, ruleClass: "rust_test"}}'; done >"$W/query.json"
}
# own_default: the stub's answer to an invocation with --exact: the tests of
# OWN_TESTS (one list for every target) that a requested --exact name
# matches, the rest filtered out, as libtest does; a test named in
# OWN_PRINTS prints a line.
own_default() {
	local t n ran=()
	for t in $OWN_TESTS; do
		for n in "${OWN_NAMES[@]}"; do
			if [ "$t" = "$n" ]; then
				ran+=("$t")
				case " ${OWN_PRINTS:-} " in *" $t "*) ran+=("ran\\n") ;; *) ran+=("") ;; esac
			fi
		done
	done
	FILTERED=$(($(wc -w <<<"$OWN_TESTS") - ${#ran[@]} / 2)) rt "$OWN_TARGET" PASSED lt_out "${ran[@]}" >"$bep"
	exit 0
}

# --- the test step's cases -------------------------------------------------------
# run <name> <want: 0 or 1> <message regex or ''> <known failures> <stub body>
# Environment of a case: KNOWN_SKIPS, KNOWN_OUTPUT, SANCTIONED, OWN, ROOT_ALONE,
# IGNORED_RUN, IGNORED_ROOT, MACOS, ONLY (lines of `<target> <name>`; ONLY sets
# RUST_TEST_ONLY, with CANARY as RUST_TEST_CANARY), CHILD_ENTRIES (lines of
# `<target> <name> <why>`, the why written as it is: `<parent>[ and
# <parent>...]: <reason>`), ROOTS
# and ROOT_COUNT, ROOT_BODY, OWN_BODY, IGN_BODY, IGN_ROOT_BODY, STICKY_BODY
# and STICKY_ROOT_BODY (the stub's answer to those invocations), OWN_TESTS and
# OWN_PRINTS (for own_default), MAIN_MUST_SKIP, CARGO_MODE, CARGO_WS,
# STICKY_FIFO (`none`: RUST_TEST_STICKY_FIFO names no FIFO), JQ_FAIL (jq exits
# 5 after any run whose arguments hold this text), RAW_LIST (a
# rust-test-known-raw-output.txt to use in place of KNOWN_RAW's),
# SANCTIONED_LINE (a line written as it is after SANCTIONED's), NOT_MSG (a
# regex the output must not match), FLAKY (known-failure lines whose reason
# is `flaky: a race`), MAIN_MUST_FLAKY (targets the main invocation must
# give --flaky_test_attempts=^<target>$@3), IGNORED_OPT (rust-test-ignored.txt
# lines whose reason is `opt: a sweep`), IGN_OPT_BODY (the stub's answer to
# such a test's -c opt bazel test, which must come after a -c opt bazel build
# of its target), OPT_BUILD_BODY (its answer to that build: by default an
# event log with a wall time of 98765 ms, and exit 0) and NO_KERNEL (`1`: the
# step runs with no PI_VFS_TEST_KERNEL, which every other case sets to linux).
run() {
	local name="$1" want="$2" msg="$3" entries="$4" body="$5"
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	local w
	w="$(mktemp -d "$scratch/case.XXXXXX")"
	mkdir -p "$w/bin" "$w/repo/.github/sami" "$w/tmp" "$w/logs" "$w/reflink"
	: >"$w/native.tsv"
	list() { # <file> <lines of `<a> <b>`> <why>
		{ echo '# header'; echo; [ -n "$2" ] && printf '%s\n' "$2" | while read -r a b; do [ -n "$a" ] && printf '%s %s  %s\n' "$a" "$b" "$3"; done; } >"$w/repo/.github/sami/$1"
	}
	if [ "$entries" != MISSING ]; then list rust-test-known-failures.txt "$entries" "owner fix: reason"; fi
	if [ -n "${FLAKY:-}" ]; then printf '%s\n' "$FLAKY" | while read -r a b; do printf '%s %s  flaky: a race\n' "$a" "$b"; done >>"$w/repo/.github/sami/rust-test-known-failures.txt"; fi
	list rust-test-root-targets.txt "${ROOTS:+$ROOTS ${ROOT_COUNT:-2}}" "why"
	list rust-test-known-skips.txt "${KNOWN_SKIPS:-}" "reason"
	list rust-test-known-output.txt "${KNOWN_OUTPUT:-}" "prints a summary; no skip"
	list rust-test-sanctioned-skips.txt "${SANCTIONED:-}" "ruling"
	if [ -n "${SANCTIONED_LINE:-}" ]; then printf '%s\n' "$SANCTIONED_LINE" >>"$w/repo/.github/sami/rust-test-sanctioned-skips.txt"; fi
	list rust-test-own-process.txt "${OWN:-}" "why"
	list rust-test-root-alone.txt "${ROOT_ALONE:-}" "why"
	list rust-test-ignored.txt "${IGNORED_RUN:-}" "why"
	if [ -n "${IGNORED_OPT:-}" ]; then printf '%s\n' "$IGNORED_OPT" | while read -r a b; do printf '%s %s  opt: a sweep\n' "$a" "$b"; done >>"$w/repo/.github/sami/rust-test-ignored.txt"; fi
	list rust-test-ignored-root.txt "${IGNORED_ROOT:-}" "why"
	{ echo '# header'; echo; [ -n "${CHILD_ENTRIES:-}" ] && printf '%s\n' "$CHILD_ENTRIES" | while read -r a b c; do [ -n "$a" ] && printf '%s %s  %s\n' "$a" "$b" "$c"; done; } >"$w/repo/.github/sami/rust-test-child-entries.txt"
	list rust-test-macos.txt "${MACOS:-}" "macOS only"
	if [ -n "${RAW_LIST:-}" ]; then
		cp -- "$RAW_LIST" "$w/repo/.github/sami/rust-test-known-raw-output.txt"
	else
		{ echo '# raw'; [ -n "${KNOWN_RAW:-}" ] && printf '%s\n' "$KNOWN_RAW" | while IFS= read -r l; do printf '%s  prints it; no skip\n' "$l"; done; } >"$w/repo/.github/sami/rust-test-known-raw-output.txt"
	fi
	local only_env=()
	if [ -n "${ONLY:-}" ]; then
		list only.txt "$ONLY" "macOS only"
		only_env=(RUST_TEST_ONLY=.github/sami/only.txt RUST_TEST_CANARY="${CANARY:-}")
	fi
	if [ "${NO_KERNEL:-}" = 1 ]; then only_env=(-u PI_VFS_TEST_KERNEL ${only_env[@]+"${only_env[@]}"}); fi
	printf '[toolchain]\nchannel = "nightly-2026-11-08"\n' >"$w/repo/rust-toolchain.toml"
	printf '# list\n%s\n' "${CARGO_WS:-sdk/rust/demo/Cargo.toml  standalone}" >"$w/repo/.github/sami/rust-test-cargo-workspaces.txt"
	# DOCQ: the doctest targets bazel query names (the macOS job asks it).
	if [ -n "${DOCQ:-}" ]; then printf '%s\n' "$DOCQ" >"$w/docquery.txt"; fi
	local opt_build_body="${OPT_BUILD_BODY:-metrics 98765 >\"\$bep\"; exit 0}"
	# The source of $DOC's crate, which the Linux job's doctest reader reads:
	# one plain doctest, its fence at line 3 (doc_pass's name). DOC_SRC
	# replaces it; DOC_SRC=none leaves the crate with no .rs file.
	mkdir -p "$w/repo/crates/pi-diff/src"
	[ "${DOC_SRC:-}" = none ] || printf '%s\n' "${DOC_SRC:-$doc_src_plain}" >"$w/repo/crates/pi-diff/src/lib.rs"
	cat >"$w/bin/bazelisk" <<EOF
#!/usr/bin/env bash
set -u
W="$w"
logs="$w/logs"
OWN_TESTS="${OWN_TESTS:-}"
OWN_PRINTS="${OWN_PRINTS:-}"
$(declare -f lt_pass lt_fail lt_out lt_ignored lt_partial lt_child_summary doc_pass doc_fail cfg summary metrics attempt unbuilt tpath bpath fakebin record_names target rt dt nt listed sanct query_names own_default)
args=("\$@")
if [ "\${args[0]#--bazelrc=}" != "\${args[0]}" ]; then args=("\${args[@]:1}"); fi
if [ "\${args[0]}" = query ]; then
	out=""
	for a in "\${args[@]}"; do case "\$a" in --output=*) out="\${a#*=}" ;; esac; done
	rc="\$(cat "\$W/query.rc" 2>/dev/null || echo 0)"
	case "\${args[*]}" in
		*rust_doc_test*) cat "\$W/docquery.txt" 2>/dev/null; exit "\$rc" ;;
	esac
	if [ "\$out" = label ]; then
		if [ -f "\$W/query.txt" ]; then cat "\$W/query.txt"; else cat "\$W/bep.paths" | xargs cat | jq -r 'select(.id.testSummary) | .id.testSummary.label' | sort -u; fi
	elif [ "\$out" = streamed_jsonproto ]; then
		if [ -f "\$W/query.json" ]; then cat "\$W/query.json"; else
			cat "\$W/bep.paths" | xargs cat | jq -s -c --rawfile native "\$W/native.tsv" '
				(\$native | split("\n") | map(select(. != "") | split("\t") | {key: .[0], value: .[1]}) | from_entries) as \$src
				| .[] | select(.id.targetConfigured)
				| (.configured.targetKind | sub(" rule\$"; "")) as \$class
				| {type: "RULE", rule: ({name: .id.targetConfigured.label, ruleClass: \$class}
					+ (if \$src[.id.targetConfigured.label] then {attribute: [{name: "src", type: "LABEL", stringValue: \$src[.id.targetConfigured.label]}]} else {} end))}'
		fi
	else
		echo "stub: query --output=\$out" >&2; exit 2
	fi
	exit "\$rc"
fi
case "\${args[0]}" in test | build) ;; *) echo "stub: bazelisk \${args[*]}" >&2; exit 2 ;; esac
bep="" under="" names=() targets=() ignored=0 fifo=""
for ((i = 0; i < \${#args[@]}; i++)); do
	case "\${args[i]}" in
		--build_event_json_file=*) bep="\${args[i]#*=}" ;;
		--run_under=*) under="\${args[i]#*=}" ;;
		--test_arg=--ignored) ignored=1 ;;
		--test_env=PI_TEST_STICKY_FIFO=*) fifo="\${args[i]#*=*=}" ;;
		--test_arg=--exact)
			for ((j = i + 1; j < \${#args[@]}; j++)); do
				case "\${args[j]}" in --test_arg=-*) break ;; --test_arg=*) names+=("\${args[j]#--test_arg=}") ;; *) break ;; esac
			done
			;;
		--) targets=("\${args[@]:i + 1}"); break ;;
	esac
done
[ "\${args[0]}" = build ] || printf '%s\n' "\$bep" >>"\$W/bep.paths"
inv=main
case "\$under" in sudo*) inv=root ;; esac
if [ "\${#names[@]}" -gt 0 ]; then
	if [ "\$ignored" = 1 ]; then
		[ "\$inv" = root ] && inv=ignored-root || inv=ignored
	elif [ "\$inv" = root ]; then
		inv=sticky-root
	elif [ -n "\$fifo" ]; then
		inv=sticky-user
	else
		inv=own
	fi
fi
# A -c opt build is only an #[ignore]d test's, before its -c opt bazel test;
# no other invocation changes the compilation mode, and none comes after the
# -c opt ones (Bazel would analyze again in fastbuild).
opt=0
case " \${args[*]} " in *" --compilation_mode=opt "*) opt=1 ;; esac
if [ "\${args[0]}" = build ]; then
	[ "\$opt" = 1 ] && [ "\$inv" = ignored ] || { echo "stub: bazel build is only an #[ignore]d test's -c opt build: \${args[*]}" >&2; exit 2; }
	inv=opt-build
elif [ "\$opt" = 1 ]; then
	[ "\$inv" = ignored ] || { echo "stub: bazel test (\$inv) has --compilation_mode=opt" >&2; exit 2; }
	inv=ignored-opt
	: >"\$W/opt-ran"
elif [ -e "\$W/opt-ran" ]; then
	echo "stub: bazel test (\$inv) after a -c opt one" >&2
	exit 2
fi
has() { case " \${args[*]} " in *" \$1 "*) return 0 ;; esac; echo "stub: bazel \${args[0]} (\$inv) lacks \$1" >&2; exit 2; }
has --keep_going
has "--test_arg=-Zunstable-options --test_arg=--format=json --test_arg=--show-output"
if [ "${LEGACY:-0}" != 1 ]; then
	has --test_env=PATH=\$RUST_TEST_PATH
	has --test_env=RSYNC_REFERENCE_REQUIRED=1
	has --test_env=PI_TEST_REAL_BASH=\$PI_TEST_REAL_BASH
	has --test_env=PI_AST_REPO_CORPUS=\$PI_AST_REPO_CORPUS
	has --test_env=PI_VFS_TEST_KERNEL=\$PI_VFS_TEST_KERNEL
	has --sandbox_writable_path=\$RUST_TEST_TMPDIR
	want_under="/bin/sh $w/repo/.github/sami/rust-test-tmpdir.sh \$RUST_TEST_TMPDIR"
	[ "\$inv" = root ] || [ "\$inv" = ignored-root ] || [ "\$inv" = sticky-root ] && want_under="sudo -E env PATH=\$RUST_TEST_PATH \$want_under"
	[ "\$under" = "\$want_under" ] || { echo "stub: bazel test (\$inv) runs under [\$under], not [\$want_under]" >&2; exit 2; }
	[ "\$inv" != main ] || has "--test_arg=--skip --test_arg=refused_in_a_sticky_directory"
	[ "\$inv" != sticky-user ] || [ "\$fifo" = "\$RUST_TEST_STICKY_FIFO" ] || { echo "stub: bazel test (\$inv) gives PI_TEST_STICKY_FIFO=[\$fifo], not [\$RUST_TEST_STICKY_FIFO]" >&2; exit 2; }
	[ "\$inv" = sticky-user ] || [ -z "\$fifo" ] || { echo "stub: bazel test (\$inv) gives PI_TEST_STICKY_FIFO" >&2; exit 2; }
fi
case "\$inv" in ignored | ignored-root | ignored-opt | opt-build) has --test_timeout=1200 ;; esac
case "\$inv" in ignored-root | sticky-user | sticky-root | ignored-opt | opt-build) has --strategy=TestRunner=local ;; esac
if [ "\$inv" = main ]; then
	[ "\${targets[0]:-}" = //crates/... ] || { echo "stub: main run's targets are [\${targets[*]}]" >&2; exit 2; }
	for r in ${ROOTS:-}; do has "-\$r"; done
	for s in ${MAIN_MUST_SKIP:-}; do has "--test_arg=--skip --test_arg=\$s"; done
	for t in ${MAIN_MUST_FLAKY:-}; do has "--flaky_test_attempts=^\${t}\\\$@3"; done
elif [ "\$inv" = opt-build ]; then
	[ "\${#targets[@]}" = 1 ] || { echo "stub: \$inv run's targets are [\${targets[*]}]" >&2; exit 2; }
	printf '%s\n' "\${targets[0]}" >>"\$W/opt-built.txt"
	$(printf '%s' "$opt_build_body")
elif [ "\$inv" = root ]; then
	$(printf '%s' "${ROOT_BODY:-exit 9}")
else
	[ "\${#targets[@]}" = 1 ] || { echo "stub: \$inv run's targets are [\${targets[*]}]" >&2; exit 2; }
	OWN_NAMES=("\${names[@]}") OWN_NAME="\${names[0]}" OWN_TARGET="\${targets[0]}"
	case "\$inv" in
		own) $(printf '%s' "${OWN_BODY:-own_default}") ;;
		ignored) $(printf '%s' "${IGN_BODY:-own_default}") ;;
		ignored-opt)
			grep -qxF -- "\$OWN_TARGET" "\$W/opt-built.txt" 2>/dev/null || { echo "stub: bazel test (ignored-opt) of \$OWN_TARGET, with no -c opt bazel build of it before" >&2; exit 2; }
			$(printf '%s' "${IGN_OPT_BODY:-own_default}")
			;;
		ignored-root) $(printf '%s' "${IGN_ROOT_BODY:-own_default}") ;;
		sticky-user) $(printf '%s' "${STICKY_BODY:-own_default}") ;;
		sticky-root) $(printf '%s' "${STICKY_ROOT_BODY:-own_default}") ;;
	esac
fi
FMT=text
for a in "\${args[@]}"; do [ "\$a" = --test_arg=--format=json ] && FMT=json; done
$body
EOF
	chmod +x "$w/bin/bazelisk"
	# The cargo workspaces: a rustup stub whose `run <channel> cargo` answers
	# metadata and test from CARGO_MODE (pass, fail-lib, partial-test,
	# meta-fail, empty, stderr-skip, stderr-skip-named, filtered, ignored,
	# ignored-fails, doc-ignored, doc-skip). With --ignored it runs the
	# #[ignore]d test a::slow alone. Its build ends as cargo's does: with
	# --timings, a report that names the run's arguments, unless
	# CARGO_NO_REPORT=1; then the Finished line, whose time CARGO_FINISHED
	# gives (empty: no such line, as after a failed build).
	cat >"$w/bin/rustup" <<EOF
#!/usr/bin/env bash
set -u
case "\$1" in toolchain) exit 0 ;; run) shift 2 ;; *) exit 1 ;; esac
mode="${CARGO_MODE:-pass}"
FMT=json
$(declare -f lt_pass lt_fail lt_partial lt_ignored lt_out)
if [ "\$2" = metadata ]; then
	[ "\$mode" = meta-fail ] && { echo "error: boom" >&2; exit 101; }
	if [ "\$mode" = empty ]; then echo '{"packages":[]}'; exit 0; fi
	echo '{"packages":[{"name":"demo","targets":[{"name":"demo","kind":["lib"],"crate_types":["lib"],"test":true,"doctest":true},{"name":"wire","kind":["test"],"crate_types":["bin"],"test":true,"doctest":false}]}]}'
	exit 0
fi
sel="" ign=0 threads=""
for a in "\$@"; do case "\$a" in --lib|--doc|--test) sel="\$a" ;; --ignored) ign=1 ;; --test-threads=1) threads=1 ;; esac; done
echo "   Compiling demo v0.1.0" >&2
if [ "${CARGO_NO_REPORT:-0}" != 1 ]; then
	case " \$* " in *" --timings "*)
		report="\$PWD/target/cargo-timings/cargo-timing-\$\$.html"
		mkdir -p "\${report%/*}"
		printf '<html>timing report of %s</html>\n' "\$*" >"\$report"
		echo "      Timing report saved to \$report" >&2
		;;
	esac
fi
finished='${CARGO_FINISHED-0.00s}'
[ -z "\$finished" ] || echo '    Finished \`test\` profile [unoptimized + debuginfo] target(s) in '"\$finished" >&2
# cargo names each test binary it runs; what follows on stderr is the binary's.
[ "\$sel" = --doc ] || echo "     Running tests/wire.rs (target/debug/deps/wire-0)" >&2
if [ "\$sel" = --doc ]; then
	case " \${RUSTDOCFLAGS:-} " in *" -Zunstable-options --no-capture "*) ;; *) echo "stub: cargo test --doc without RUSTDOCFLAGS --no-capture (\${RUSTDOCFLAGS:-})" >&2; exit 2 ;; esac
	[ "\$threads" = 1 ] || { echo "stub: cargo test --doc without --test-threads=1" >&2; exit 2; }
	# A crate's doctests under //crates run under cargo only in the macOS job
	# (RUST_TEST_ONLY), and build their dependencies with the features of the
	# whole workspace, so every crate's run reuses them.
	case " \$* " in *" --manifest-path crates/"*)
		[ -n "\${RUST_TEST_ONLY:-}" ] || { echo "stub: cargo test --doc of a crate under crates/ in the Linux job, where Bazel's doctest targets run the doctests" >&2; exit 2; }
		case " \$* " in *' -Zfeature-unification --config resolver.feature-unification="workspace" '*) ;; *) echo "stub: cargo test --doc of a crate under crates/ without workspace feature unification (\$*)" >&2; exit 2 ;; esac ;;
	esac
fi
if [ "\$ign" = 1 ]; then
	# An #[ignore]d test's run goes --offline, under RUST_TEST_OFFLINE_UNDER.
	[ "\${OFFLINE_WRAPPED:-}" = 1 ] || { echo "stub: an --ignored cargo run not under RUST_TEST_OFFLINE_UNDER" >&2; exit 2; }
	case " \$* " in *" --offline "*) ;; *) echo "stub: an --ignored cargo run without --offline" >&2; exit 2 ;; esac
	case "\$mode" in
		ignored-fails) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "name": "a::slow", "event": "failed", "stdout": "left: 1" }\n{ "type": "suite", "event": "failed", "passed": 0, "failed": 1, "ignored": 0, "measured": 0, "filtered_out": 2, "exec_time": 0.1 }\n'; exit 101 ;;
		*) FILTERED=2 lt_pass a::slow; exit 0 ;;
	esac
fi
case "\$mode:\$sel" in
	fail-lib:--lib) lt_fail demo::broken; exit 101 ;;
	partial-test:--test) lt_partial; exit 0 ;;
	stderr-skip:--test) echo "skipped: no bun on PATH" >&2; lt_pass a::one a::two; exit 0 ;;
	stderr-skip-named:--test) echo "a::two: skipped: no bun on PATH" >&2; lt_pass a::one a::two; exit 0 ;;
	stderr-raw:--test) echo "no free port: nothing to test" >&2; lt_pass a::one a::two; exit 0 ;;
	tangled:--test) printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "event": "started", "name": "a::one" }\nno free port: noth{ "type": "test", "name": "a::one", "event": "ok" }\n{ "type": "test", "event": "started", "name": "a::two" }\ning to test\n{ "type": "test", "name": "a::two", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 2, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	filtered:--test) FILTERED=1 lt_pass a::one; exit 0 ;;
	ignored:--test | ignored-fails:--test | ignored-and-doc-ignored:--test) lt_ignored a::one a::slow; exit 0 ;;
	doc-ignored:--doc | ignored-and-doc-ignored:--doc) printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "test", "name": "src/lib.rs - g (line 9)", "event": "ignored" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 1, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-skip:--doc) lt_out 'src/lib.rs - f (line 3)' 'skipped: no reference rsync\\n'; exit 0 ;;
	doc-raw-skip:--doc) printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "event": "started", "name": "src/lib.rs - f (line 3)" }\nskipped: no reference rsync\n'; echo "a line on stderr" >&2; printf '{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "test", "event": "started", "name": "src/lib.rs - g (line 9)" }\n{ "type": "test", "name": "src/lib.rs - g (line 9)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 2, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-raw-print:--doc) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "src/lib.rs - f (line 3)" }\nno free port: nothing to test\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-raw-nonl:--doc) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "src/lib.rs - f (line 3)" }\nno free port: nothing to test{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-typed:--doc) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "src/lib.rs - f (line 3)" }\n{"type": "test", "note": "no free port: nothing to test"}\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-typed-suite:--doc) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "src/lib.rs - f (line 3)" }\n{"type": "suite", "note": "no free port: nothing to test"}\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	doc-empty:--doc) printf '{ "type": "suite", "event": "started", "test_count": 0 }\n{ "type": "suite", "event": "ok", "passed": 0, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.0 }\n'; exit 0 ;;
	doc-extra:--doc) printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "test", "name": "src/lib.rs - h (line 20)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 2, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; exit 0 ;;
	*:--doc) printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "name": "src/lib.rs - f (line 3)", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.0 }\n'; exit 0 ;;
	*) lt_pass a::one a::two; exit 0 ;;
esac
EOF
	chmod +x "$w/bin/rustup"
	printf '#!/bin/sh\nOFFLINE_WRAPPED=1 exec "$@"\n' >"$w/bin/offline"
	chmod +x "$w/bin/offline"
	local out rc fifo="$w/sticky/report.txt"
	mkdir -p "$w/sticky"
	mkfifo "$fifo"
	[ "${STICKY_FIFO:-}" != none ] || fifo=""
	if [ -n "${JQ_FAIL:-}" ]; then
		local real_jq
		real_jq="$(PATH="${TOOLBIN:+$TOOLBIN:}$PATH" command -v jq)"
		printf '%s' "$JQ_FAIL" >"$w/jq-fail"
		printf '#!/bin/sh\n"%s" "$@"; rc=$?\ncase "$*" in *"$(cat "%s")"*) exit 5 ;; esac\nexit $rc\n' "$real_jq" "$w/jq-fail" >"$w/bin/jq"
		chmod +x "$w/bin/jq"
	fi
	# SUMMARY_UNWRITABLE=1: the step summary's path is a directory.
	[ "${SUMMARY_UNWRITABLE:-}" != 1 ] || mkdir "$w/summary.md"
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null \
		PI_VFS_TEST_KERNEL=linux \
		RUST_TEST_PATH=/stub/rsync-ref/bin:/usr/bin:/bin RUST_TEST_TMPDIR="$w/reflink" PI_TEST_REAL_BASH=/stub/bash-ref/bin/bash PI_AST_REPO_CORPUS="$w/repo" RUST_TEST_OFFLINE_UNDER="$w/bin/offline" \
		RUST_TEST_STICKY_FIFO="$fifo" GITHUB_STEP_SUMMARY="$w/summary.md" \
		env ${only_env[@]+"${only_env[@]}"} bash --noprofile --norc -eo pipefail "$step" 2>&1)"
	rc=$?
	# What the step leaves for the job beside its log: the step summary, and
	# the cargo timing reports it copied for upload, each on lines of its own.
	if [ -f "$w/summary.md" ]; then
		out+=$'\n'"$(sed 's/^/summary: /' "$w/summary.md")"$'\n'"summary rows: $(grep -c '^| `' "$w/summary.md")"
	fi
	local report
	for report in "$w"/tmp/rust-test/cargo-timings/*; do
		[ -f "$report" ] && out+=$'\n'"artifact: ${report##*/}: $(cat -- "$report")"
	done
	# The per-test results the compare job reads, one `results: ` line each.
	if [ -f "$w/tmp/rust-test/results/results.tsv" ]; then
		out+=$'\n'"$(sed 's/^/results: /' "$w/tmp/rust-test/results/results.tsv")"
	fi
	verdict "$name" "$want" "$rc" "$msg" "$out"
}

# verdict <name> <want> <rc> <message regex> <output>
verdict() {
	local name="$1" want="$2" rc="$3" msg="$4" out="$5" ok=1
	if [ "$want" = 0 ] && [ "$rc" != 0 ]; then ok=0; fi
	if [ "$want" != 0 ] && [ "$rc" = 0 ]; then ok=0; fi
	if [ -n "$msg" ] && ! printf '%s\n' "$out" | grep -Eq -- "$msg"; then ok=0; fi
	if [ -n "${NOT_MSG:-}" ] && printf '%s\n' "$out" | grep -Eq -- "$NOT_MSG"; then ok=0; fi
	if [ "$ok" = 1 ]; then
		pass=$((pass + 1))
		printf 'PASS %-44s exit=%s\n' "$name" "$rc"
	else
		fail=$((fail + 1))
		printf 'FAIL %-44s exit=%s (want %s, msg /%s/%s)\n' "$name" "$rc" "$want" "$msg" "${NOT_MSG:+, not /$NOT_MSG/}"
		printf '%s\n' "$out" | grep -E '::error|::notice|stub:|Known|printed' | sed 's/^/    | /'
	fi
}

B=//crates/pi-builtins:pi-builtins_test
D=//crates/pi-diff:pi-diff_test
V=//crates/pi-vcs:pi-vcs_test
DOC=//crates/pi-diff:pi-diff_doc_test
# $DOC's crate source by default: one plain doctest, its fence at line 3.
doc_src_plain=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\npub fn f() {}'
RT=//crates/pi-builtins:rsync_root_test
# A passing test with output the known-output list names: the skip scan's
# liveness check sees output in every case that expects a pass.
PR=//crates/pi-diff:printer_test
P="rt $PR PASSED lt_out p::summary 'compared 3 of 3\\n'"
export KNOWN_OUTPUT="$PR p::summary"

run J01-all-pass 0 '' '' "{ $P; rt $D PASSED lt_pass a::one a::two; } >\"\$bep\"; exit 0"
run J02-known-fail-exactly 0 'Known failure, failed as expected: //crates/pi-builtins:pi-builtins_test x::k2' "$B x::k1
$B x::k2" "{ $P; rt $D PASSED lt_pass a::one; rt $B FAILED lt_fail x::k1 x::k2; } >\"\$bep\"; exit 3"
run J03-unlisted-failure 1 'x::new failed and is not in' "$B x::k1" "{ $P; rt $B FAILED lt_fail x::k1 x::new; } >\"\$bep\"; exit 3"
run J04-listed-passes 1 'x::k2 is in .* but has not failed: remove its line' "$B x::k1
$B x::k2" "{ $P; rt $B FAILED lt_fail x::k1; } >\"\$bep\"; exit 3"
run J05-all-pass-list-nonempty 1 'Known failure did not happen::.*x::k1' "$B x::k1" "{ $P; rt $B PASSED lt_pass x::a; } >\"\$bep\"; exit 0"
run J06-crash 1 'pi-builtins_test is FAILED' "$B a::first" "{ $P; rt $B FAILED lt_partial; } >\"\$bep\"; exit 3"
run J07-build-failure-no-bep 1 'wrote no build event log' '' 'exit 1'
run J07b-build-failure-plus-known 1 'a target failed to build' "$D x::k1" "{ $P; cfg $B 'rust_test rule'; summary $B FAILED_TO_BUILD; rt $D FAILED lt_fail x::k1; } >\"\$bep\"; exit 1"
run J07d-bazel-tool-error 1 'bazel test exited 2' '' 'exit 2'
run J08-bep-missing 1 'wrote no build event log' "$B x::k1" 'exit 3'
run J09-rc3-no-failed-target 1 'logs name no target that did not pass' "$B x::k1" "{ $P; rt $B PASSED lt_pass x::a; } >\"\$bep\"; exit 3"
run J10-timeout 1 'pi-builtins_test is TIMEOUT' '' "{ $P; rt $B TIMEOUT lt_partial; } >\"\$bep\"; exit 3"
run J11-list-missing 1 '' MISSING "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J12-same-name-other-target 1 'pi-diff:pi-diff_test x::k1 failed and is not in' "$B x::k1" "{ $P; rt $B FAILED lt_fail x::k1; rt $D FAILED lt_fail x::k1; } >\"\$bep\"; exit 3"
run J13-failed-to-build-no-log 1 'FAILED_TO_BUILD and Bazel names no test log' '' "{ $P; cfg $B 'rust_test rule'; summary $B FAILED_TO_BUILD; } >\"\$bep\"; exit 3"
run J14-passed-binary-exited-early 1 'pi-diff_test is PASSED' '' "{ $P; rt $D PASSED lt_partial; } >\"\$bep\"; exit 0"
run J15-passed-no-log 1 'PASSED and Bazel names no test log' '' "{ $P; cfg $D 'rust_test rule'; summary $D PASSED; } >\"\$bep\"; exit 0"
run J16-bep-names-no-target 1 'logs name no test target' '' ': >"$bep"; exit 0'
run J17-flaky-unlisted 1 'x::f failed and is not in' '' "f=\"\$(tpath $B)\"; mkdir -p \"\$(dirname \"\$f\")/test_attempts\"; lt_fail x::f >\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; lt_pass x::passes x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B FLAKY \"\$(dirname \"\$f\")/test_attempts/attempt_1.log\" \"\$f\"; } >\"\$bep\"; exit 0"
run J17b-flaky-attempt-binary-listed 0 'Known failure, failed as expected: //crates/pi-builtins:pi-builtins_test x::f' "$B x::f" "f=\"\$(tpath $B)\"; mkdir -p \"\$(dirname \"\$f\")/test_attempts\"; lt_fail x::f >\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; lt_pass x::passes x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B FLAKY \"\$(dirname \"\$f\")/test_attempts/attempt_1.log\" \"\$f\"; } >\"\$bep\"; exit 0"
run J18-passed-log-missing 1 'PASSED and Bazel names no test log' '' "{ $P; cfg $D 'rust_test rule'; summary $D PASSED '' \"\$logs/absent.log\"; } >\"\$bep\"; exit 0"
run J19-known-and-others-pass 0 'Known failure, failed as expected' "$B x::k1" "{ $P; rt $D PASSED lt_pass a::one; rt $V PASSED lt_pass v::one; rt $B FAILED lt_fail x::k1; } >\"\$bep\"; exit 3"
run J23-child-summary-then-early-exit 1 'pi-diff_test is PASSED' '' "{ $P; rt $D PASSED lt_child_summary; } >\"\$bep\"; exit 0"
run J24a-doctest-pass 0 '' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
run J24b-doctest-fail-listed 0 'Known failure, failed as expected: //crates/pi-diff:pi-diff_doc_test src/lib.rs - f \(line 3\)' "$DOC src/lib.rs - f (line 3)" "{ $P; dt $DOC FAILED doc_fail 'src/lib.rs - f (line 3)'; } >\"\$bep\"; exit 3"
run J24c-doctest-pass-without-summary 1 'pi-diff_doc_test is PASSED' '' "{ $P; dt $DOC PASSED printf 'running 1 test\n'; } >\"\$bep\"; exit 0"
run J24d-doctest-fail-unlisted 1 "pi-diff_doc_test src/lib.rs - f \\(line 3\\) failed and is not in" '' "{ $P; dt $DOC FAILED doc_fail 'src/lib.rs - f (line 3)'; } >\"\$bep\"; exit 3"
run J25-unknown-rule-kind 1 'whose log this step cannot read' '' "{ $P; target 'sh_test rule' //x:sh_test PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J26-rust-test-text-log 1 'holds no libtest record' '' "lt_pass_text() { FMT=text lt_pass \"\$@\"; }; { $P; rt $D PASSED lt_pass_text a::one; } >\"\$bep\"; exit 0"
run J27-planned-more-than-reported 1 'planned 3 tests and reported 1' '' "{ $P; rt $D PASSED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 3 }\n{ \"type\": \"test\", \"name\": \"a\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 1, \"failed\": 0, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'; } >\"\$bep\"; exit 0"
run J28-real-libtest-exit-zero 1 'pi-diff_test is PASSED' '' "{ $P; rt $D PASSED cat $fixtures/early.json; } >\"\$bep\"; exit 0"
run J29-real-libtest-pass 0 '' '' "{ $P; rt $D PASSED cat $fixtures/fine.json; } >\"\$bep\"; exit 0"
# fail.json holds an #[ignore]d test, t::c_ignored: named a child entry here.
CHILD_ENTRIES="$D t::c_ignored t::a_passes: the parent test" run J30-real-libtest-fail-listed 0 'Known failure, failed as expected: //crates/pi-diff:pi-diff_test t::b_fails' "$D t::b_fails" "{ $P; rt $D FAILED cat $fixtures/fail.json; } >\"\$bep\"; exit 3"
run J31-real-libtest-fail-unlisted 1 't::b_fails failed and is not in' '' "{ $P; rt $D FAILED cat $fixtures/fail.json; } >\"\$bep\"; exit 3"

# A test target the query names but bazel test left without a result.
run J32-incompatible-test-skipped 1 '//crates/pi-natives:mac_only_test is a test target, but bazel test has no result' '' "query_names $PR $D //crates/pi-natives:mac_only_test; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J33-tag-filtered-test 1 '//crates/pi-diff:slow_test is a test target, but bazel test has no result' '' "query_names $PR $D //crates/pi-diff:slow_test; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J34-query-fails 1 'bazel query for the test targets failed' '' "echo 2 >\"\$W/query.rc\"; query_names; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J35-query-empty 1 'bazel query names no test target' '' ": >\"\$W/query.txt\"; : >\"\$W/query.json\"; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# The doctest runner's header plans 128, the last summary is a child's "1 passed".
run J36-doctest-child-summary 1 'header plans 128 doctests and its last summary counts 1' '' "{ $P; dt $DOC PASSED printf 'running 128 tests\ntest a ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'; } >\"\$bep\"; exit 0"
run J37-doctest-no-header 1 'header plans -1 doctests' '' "{ $P; dt $DOC PASSED printf 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'; } >\"\$bep\"; exit 0"
run J38-rust-test-text-child-summary 1 'holds no libtest record' '' "lt_cs_text() { FMT=text lt_child_summary; }; { $P; rt $D PASSED lt_cs_text; } >\"\$bep\"; exit 0"
run J39-doctest-one-test-header 0 '' '' "{ $P; dt $DOC PASSED printf 'running 1 test\ntest src/lib.rs - f (line 3) ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'; } >\"\$bep\"; exit 0"

# The standalone cargo workspaces.
run J40-cargo-ws-pass 0 '' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=fail-lib run J41-cargo-lib-fails-unlisted 1 'sdk/rust/demo:lib:demo demo::broken failed and is not in' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=fail-lib run J42-cargo-lib-fails-listed 0 'Known failure, failed as expected: sdk/rust/demo:lib:demo demo::broken' 'sdk/rust/demo:lib:demo demo::broken' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=partial-test run J43-cargo-test-exits-early 1 'sdk/rust/demo:test:wire is PASSED, but libtest planned 2 tests and reported 0' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=meta-fail run J44-cargo-metadata-fails 1 '' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=empty run J45-cargo-no-targets 1 'sdk/rust/demo/Cargo.toml names no test target' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_WS='# none' run J46-cargo-list-empty 1 'names no workspace with a test target' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# Hardening: the cargo branch's stderr is scanned, and nothing may be filtered.
CARGO_MODE=stderr-skip run J47-cargo-stderr-unnamed-skip 1 "sdk/rust/demo:test:wire printed a skip line outside libtest's record that names no test: skipped: no bun" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=stderr-skip-named run J47b-cargo-stderr-named-skip 1 'sdk/rust/demo:test:wire a::two skipped itself and is not in' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=filtered run J47c-cargo-filtered 1 'sdk/rust/demo:test:wire filtered out 1 tests, though cargo test is given no filter' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# Each cargo test's timings: a line in the job log and a row in the step
# summary (build: cargo's own Finished time; test: the rest of the run), and
# its --timings report copied for the job's artifact. They change no verdict.
run J159-cargo-timing-line 0 '^Cargo test timing: sdk/rust/demo:lib:demo \(cargo\): build 0\.0 s, test [0-9]+\.[0-9] s, total [0-9]+\.[0-9] s, exit 0, report cargo-timing-1-sdk-rust-demo-lib-demo\.html$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J160-cargo-timing-row-per-run 0 '^summary rows: 3$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J161-cargo-timing-report-is-the-runs-own 0 '^artifact: cargo-timing-3-sdk-rust-demo-test-wire\.html: <html>timing report of cargo test --locked --timings --manifest-path sdk/rust/demo/Cargo.toml --test wire -- ' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_FINISHED='1m 05s' run J162-cargo-timing-minutes 0 '^Cargo test timing: sdk/rust/demo:lib:demo \(cargo\): build 65\.0 s, test -?[0-9]+\.[0-9] s' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_FINISHED='' run J163-cargo-timing-no-finished-line 0 '^summary: \| `sdk/rust/demo:lib:demo` \| cargo \| UNKNOWN \| UNKNOWN \| [0-9]+\.[0-9] \| 0 \| cargo-timing-1-sdk-rust-demo-lib-demo\.html \|$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_NO_REPORT=1 NOT_MSG='::error|^artifact: ' run J164-cargo-timing-no-report-warns 0 '^::warning title=Cargo timings::sdk/rust/demo:lib:demo \(cargo\): cargo named no timing report' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=fail-lib run J165-cargo-timing-of-a-failed-run 1 '^summary: \| `sdk/rust/demo:lib:demo` \| cargo \| 0\.0 \| [0-9]+\.[0-9] \| [0-9]+\.[0-9] \| 101 \| cargo-timing-1-' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored IGNORED_RUN="sdk/rust/demo:test:wire a::slow" NOT_MSG='::warning' run J166-cargo-timing-of-doctest-and-ignored-runs 0 '^summary rows: 4$' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored IGNORED_RUN="sdk/rust/demo:test:wire a::slow" run J167-cargo-timing-of-an-ignored-run 0 '^summary: \| `sdk/rust/demo:test:wire` \| ignored-cargo-0 \| 0\.0 \| [0-9]+\.[0-9] \| [0-9]+\.[0-9] \| 0 \| cargo-timing-[0-9]+-sdk-rust-demo-test-wire\.html \|$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
NOT_MSG='::warning' run J168-cargo-timing-of-a-doctest-run 0 '^summary: \| `sdk/rust/demo:doc:demo` \| cargo \| 0\.0 \| [0-9]+\.[0-9] \| [0-9]+\.[0-9] \| 0 \| cargo-timing-2-sdk-rust-demo-doc-demo\.html \|$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
SUMMARY_UNWRITABLE=1 NOT_MSG='::error' run J169-cargo-timing-summary-unwritable-warns 0 '^::warning title=Cargo timings::could not write the step summary$' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"

# The root-only targets: run in a second invocation under sudo.
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-root.json >\"\$bep\"; exit 0" run J48-root-target-runs-as-root 0 '' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-nonroot.json >\"\$bep\"; exit 0" run J49-root-target-not-run 1 "$RT t::needs_root printed 'not run:', though it runs as root" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="exit 9" run J50-root-run-tool-error 1 'bazel test exited 9' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT FAILED lt_fail r::broken >\"\$bep\"; exit 3" run J51-root-target-fails 1 "$RT r::broken failed and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY=": >\"\$bep\"; exit 0" run J52-root-run-no-result 1 "$RT is a test target, but bazel test has no result" '' "query_names $PR $D $RT; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J53-not-run-outside-root-targets-is-a-skip 1 "$D t::needs_root skipped itself and is not in" '' "{ $P; rt $D PASSED cat $fixtures/root-nonroot.json; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_COUNT=3 ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-root.json >\"\$bep\"; exit 0" run J54-root-count-mismatch 1 "$RT passed 2 tests, and .github/sami/rust-test-root-targets.txt names 3" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED sh -c 'cat $fixtures/root-root.json; echo \"t::needs_root: not run: written to fd 2\"' >\"\$bep\"; exit 0" run J55-root-raw-not-run 1 "printed 'not run:' outside libtest's record" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED sh -c 'cat $fixtures/root-root.json; echo \"{ t::needs_root: not run: on a line that starts with a brace }\"' >\"\$bep\"; exit 0" run J55b-root-raw-not-run-brace-line 1 "printed 'not run:' outside libtest's record, though it runs as root: \\{ t::needs_root" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_COUNT=1 ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-stderr-nonroot.json >\"\$bep\"; exit 0" run J56-real-stderr-not-run 1 "$RT t::foreign_owner_refused printed 'not run:'" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# The foreign-owner target is a skylib native_test of pi-builtins_test's
# binary: its tests are the ones the main invocation's BUILD skip takes out.
FO="sanct a::one t::foreign_owner::refused -- a::one"
ROOTS=$RT ROOT_COUNT=1 ROOT_BODY="FMT=json; FILTERED=1 nt $RT $B PASSED lt_pass t::foreign_owner::refused >\"\$bep\"; exit 0" run J57-root-native-test-runs-the-build-skip 0 '' '' "{ $P; $FO; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_COUNT=1 ROOT_BODY="FMT=json; nt $RT $B PASSED cat $fixtures/root-stderr-nonroot.json >\"\$bep\"; exit 0" run J58-root-native-test-not-run 1 "$RT t::foreign_owner_refused printed 'not run:'" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J59-native-test-without-record 1 'holds no libtest record' '' "{ $P; nt //x:tool_test //x:tool PASSED printf 'all good\n'; } >\"\$bep\"; exit 0"

# A test that skips itself: prints a skip line, returns, passes.
SKIPREC="printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 2 }\n{ \"type\": \"test\", \"name\": \"z::completes\", \"event\": \"ok\", \"stdout\": \"skipped: zsh 5.9 completion functions are not installed\\\\n\" }\n{ \"type\": \"test\", \"name\": \"z::other\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 2, \"failed\": 0, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'"
run J60-skip-unlisted 1 "$D z::completes skipped itself and is not in .github/sami/rust-test-known-skips.txt" '' "{ $P; rt $D PASSED $SKIPREC; } >\"\$bep\"; exit 0"
KNOWN_SKIPS="$D z::completes" run J61-skip-listed 0 "Known skip, skipped itself as expected: $D z::completes" '' "{ $P; rt $D PASSED $SKIPREC; } >\"\$bep\"; exit 0"
KNOWN_SKIPS="$D z::other" run J62-listed-skip-ran 1 "$D z::other is in .github/sami/rust-test-known-skips.txt but has not skipped itself" '' "{ $P; rt $D PASSED $SKIPREC; } >\"\$bep\"; exit 0"
run J63-raw-named-skip 1 "$D wt_carry skipped itself and is not in" '' "{ $P; rt $D PASSED cat $fixtures/skip-raw-named.txt; } >\"\$bep\"; exit 0"
run J64-raw-unnamed-skip 1 "printed a skip line outside libtest's record that names no test" '' "{ $P; rt $D PASSED cat $fixtures/skip-raw-unnamed.txt; } >\"\$bep\"; exit 0"
run J65-real-skip-binary 1 "t::foreign_owner_refused skipped itself and is not in" '' "{ $P; rt $D PASSED cat $fixtures/root-stderr-nonroot.json; } >\"\$bep\"; exit 0"
# `UNKNOWN:` is what a test prints when it checked nothing (pi-vfs's and
# pi-shell's FIFO read-open tests, with no PI_VFS_TEST_KERNEL): a skip, which
# rust-test-known-output.txt cannot let through (J173), and which outside the
# record must name its test (J174). A step with no PI_VFS_TEST_KERNEL does not
# start (J175).
UNKREC="printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 2 }\n{ \"type\": \"test\", \"name\": \"f::probe\", \"event\": \"ok\", \"stdout\": \"UNKNOWN: PI_VFS_TEST_KERNEL is not set; nothing was checked\\\\n\" }\n{ \"type\": \"test\", \"name\": \"f::other\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 2, \"failed\": 0, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'"
KNOWN_OUTPUT="$D f::probe" run J173-unknown-is-a-skip-though-listed-as-output 1 "$D f::probe skipped itself and is not in .github/sami/rust-test-known-skips.txt" '' "{ $P; rt $D PASSED $UNKREC; } >\"\$bep\"; exit 0"
UNKRAW="printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\nUNKNOWN: no /proc/self/fd reaches the pin; nothing was checked\n{ \"type\": \"test\", \"name\": \"f::other\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 1, \"failed\": 0, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'"
run J174-raw-unknown-names-no-test 1 "printed a skip line outside libtest's record that names no test: UNKNOWN: no /proc/self/fd" '' "{ $P; rt $D PASSED $UNKRAW; } >\"\$bep\"; exit 0"
NO_KERNEL=1 NOT_MSG='stub:' run J175-no-kernel-name-does-not-start 1 '::error title=Rust tests::PI_VFS_TEST_KERNEL is not set' '' "rt $D PASSED lt_pass a::one >\"\$bep\"; exit 0"

# Sanctioned skips (the fork owner's ruling on one rsync test).
SANCTIONED="$B s::x::byte_totals" MAIN_MUST_SKIP=s::x::byte_totals run J66-sanctioned-took-out-one 0 "Sanctioned skip, taken out of the main invocation: $B s::x::byte_totals" '' "{ $P; sanct a::one s::x::byte_totals -- a::one; } >\"\$bep\"; exit 0"
SANCTIONED="$B s::x::byte_totals" run J67-sanctioned-matches-two 1 'takes out 2 tests of the main invocation' '' "{ $P; sanct a::one s::x::byte_totals s::x::byte_totals_more -- a::one; } >\"\$bep\"; exit 0"
SANCTIONED="$B s::x::byte_totals" run J68-sanctioned-renamed 1 'takes out 0 tests of the main invocation' '' "{ $P; sanct a::one s::x::differ -- a::one s::x::differ; } >\"\$bep\"; exit 0"
SANCTIONED="$B s::x::byte_totals" run J69-sanctioned-ran 1 "$B s::x::byte_totals ran in the main invocation" '' "{ $P; sanct a::one b::build_skipped s::x::byte_totals -- a::one s::x::byte_totals; } >\"\$bep\"; exit 0"
SANCTIONED="$B s::x::byte_totals" run J70-sanctioned-matches-another-binary 1 'takes out 2 tests of the main invocation' '' "{ $P; sanct a::one s::x::byte_totals -- a::one; listed $D d::one d::s::x::byte_totals -- d::one; } >\"\$bep\"; exit 0"
run J71-doctest-taken-out 1 'took a doctest out' '' "{ $P; dt $DOC PASSED printf 'running 1 test\ntest a ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n'; } >\"\$bep\"; exit 0"

# Own-process tests: skipped in the main run, then run alone with --exact.
# The stub's own-process answer runs the target's tests (OWN_TESTS) that the
# requested --exact name matches.
OWN="$B r::conformance_local" OWN_TESTS="a::one r::conformance_local" MAIN_MUST_SKIP=r::conformance_local run J72-own-process-alone 0 "Own-process test ran alone: $B r::conformance_local \\(ok\\)" '' "{ $P; sanct a::one r::conformance_local -- a::one; } >\"\$bep\"; exit 0"
OWN="$B r::conformance_local" OWN_TESTS="a::one r::conformance_local_renamed" run J73-own-process-runs-nothing 1 "own invocation for r::conformance_local reported \\[\\], not exactly that one test" '' "{ $P; sanct a::one r::conformance_local_renamed -- a::one r::conformance_local_renamed; } >\"\$bep\"; exit 0"
OWN="$B r::conformance_local" OWN_BODY="FMT=json; FILTERED=1 rt $B FAILED lt_fail r::conformance_local >\"\$bep\"; exit 3" run J74-own-process-fails 1 "$B r::conformance_local failed and is not in" '' "{ $P; sanct a::one x::passes r::conformance_local -- a::one x::passes; } >\"\$bep\"; exit 0"
OWN="$B r::conformance_local" OWN_BODY="exit 2" run J75-own-process-tool-error 1 'bazel test exited 2' '' "{ $P; sanct a::one r::conformance_local -- a::one; } >\"\$bep\"; exit 0"
OWN="$B r::conformance_local" OWN_TESTS="a::one b::build_skipped r::conformance_local" run J76-own-process-ran-in-main 1 "$B r::conformance_local ran in the main invocation" '' "{ $P; sanct a::one b::build_skipped r::conformance_local -- a::one r::conformance_local; } >\"\$bep\"; exit 0"
OWN="$B r::conformance_local" OWN_BODY="FMT=json; rt $B FAILED lt_fail r::conformance_local >\"\$bep\"; exit 3" run J77-own-process-reports-another-test 1 "reported \\[x::passes r::conformance_local \\]" "$B r::conformance_local" "{ $P; sanct a::one x::passes r::conformance_local -- a::one x::passes; } >\"\$bep\"; exit 0"
# Run 44831606057: the own-process bazel test of the same target writes its
# test.log to the main invocation's path before the step reads the logs.
OWN="$B r::conformance_local" OWN_TESTS="a::one r::conformance_local" MAIN_MUST_SKIP=r::conformance_local run J80-own-process-log-overwrites-main 0 "Own-process test, taken out of the main invocation: $B r::conformance_local" '' "{ $P; sanct a::one r::conformance_local -- a::one; } >\"\$bep\"; exit 0"
# m1: two own-process tests of one target: each log is read before the next
# invocation overwrites it.
OWN="$B r::conformance_local
$B r::conformance_daemon" OWN_TESTS="a::one r::conformance_local r::conformance_daemon" MAIN_MUST_SKIP="r::conformance_local r::conformance_daemon" run J81-two-own-process-tests-one-target 0 "Own-process test ran alone: $B r::conformance_daemon \\(ok\\)" '' "{ $P; sanct a::one r::conformance_local r::conformance_daemon -- a::one; } >\"\$bep\"; exit 0"
# m1: an #[ignore]d own-process test is reported but ran nothing.
OWN="$B r::conformance_local" OWN_BODY="FMT=json; FILTERED=2 rt $B PASSED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\n{ \"type\": \"test\", \"name\": \"r::conformance_local\", \"event\": \"ignored\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 0, \"failed\": 0, \"ignored\": 1, \"measured\": 0, \"filtered_out\": 2, \"exec_time\": 0.0 }\n' >\"\$bep\"; exit 0" run J82-own-process-ignored 1 "$B r::conformance_local is #\\[ignore\\]d, so its own invocation ran nothing" '' "{ $P; sanct a::one x::unused r::conformance_local -- a::one x::unused; } >\"\$bep\"; exit 0"

# A failed test's report that quotes rsync's own `skipping` line is a failure,
# not a skip; the same line in a passing test's output is a skip (fails closed).
run J78-failed-report-quotes-skipping 0 "Known failure, failed as expected: $D r::diff" "$D r::diff" "{ $P; rt $D FAILED cat $fixtures/diff-failed.json; } >\"\$bep\"; exit 3"
run J79-passing-output-says-skipping 1 "$D r::diff skipped itself and is not in" '' "{ $P; rt $D PASSED cat $fixtures/diff-ok.json; } >\"\$bep\"; exit 0"

# M1: a skip in other words, and the known-output list.
run J83-skip-in-other-words 1 "$D z::zftp printed and is not in .github/sami/rust-test-known-output.txt" '' "{ $P; rt $D PASSED lt_out z::zftp 'no free /etc/services port: nothing to test\\n' z::other ''; } >\"\$bep\"; exit 0"
KNOWN_OUTPUT="$PR p::summary
$D z::zftp" run J84-listed-output 0 "Known output, printed as expected: $D z::zftp" '' "{ $P; rt $D PASSED lt_out z::zftp 'compared 5 sessions\\n'; } >\"\$bep\"; exit 0"
KNOWN_OUTPUT="$PR p::summary
$D z::zftp" run J85-listed-output-that-skips 1 "$D z::zftp skipped itself and is not in" '' "{ $P; rt $D PASSED lt_out z::zftp 'skipped: no free /etc/services port\\n'; } >\"\$bep\"; exit 0"
KNOWN_OUTPUT="$PR p::summary
$D z::quiet" NOT_MSG='::error' run J86-listed-output-silent-is-a-notice 0 "::notice title=Known output did not happen::$D z::quiet" '' "{ $P; rt $D PASSED lt_pass z::quiet; } >\"\$bep\"; exit 0"
# The documented limit: a test that returns early and prints nothing passes.
run J87-silent-return-passes 0 'Passing tests whose output the skip scan read: 1' '' "{ $P; rt $D PASSED lt_pass z::returns_early; } >\"\$bep\"; exit 0"
# The scan's liveness check: no passing test's output at all.
KNOWN_OUTPUT="" run J88-no-output-anywhere 1 'UNKNOWN: no passing test.s output reached the skip scan' '' "rt $D PASSED lt_pass a::one >\"\$bep\"; exit 0"

# m2: the lists read whole lines.
run J89-list-line-without-name 1 'rust-test-known-failures.txt:[0-9]+: no second field: //crates/pi-builtins:pi-builtins_test' "$B" "{ $P; rt $B PASSED lt_pass x::a; } >\"\$bep\"; exit 0"

# The accounting: a filter in a target's args, or a skip, that takes a test
# out of every invocation.
run J90-positional-filter-drops-tests 1 "$D d::two ran in no invocation" '' "{ $P; listed $D d::one d::two -- d::one; } >\"\$bep\"; exit 0"
run J91-filtered-out-disagrees-with-listing 1 "$D \\(main\\) reported 1 tests and filtered out 0, but its binary lists 2" '' "{ $P; fakebin $D d::one d::two; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 0"
run J92-unlistable-binary 1 "binary .* cannot list its tests" '' "{ $P; f=\"\$(tpath $D)\"; mkdir -p \"\$(dirname \"\$f\")\"; FMT=json lt_pass d::one >\"\$f\"; cfg $D 'rust_test rule'; summary $D PASSED '' \"\$f\"; } >\"\$bep\"; exit 0"
# A native_test's own bin/<package>/<target> is no test binary (Bazel names
# its executable by its `out`), so the accounting lists its src's binary, also
# when the native_test's result comes first in the event log (run
# 45842279451, pi_natives_scanner_test): no fake binary at its own path here.
NTF="f=\"\$(tpath //crates/pi-diff:slow_test)\"; mkdir -p \"\$(dirname \"\$f\")\"; FILTERED=1 FMT=json lt_pass d::slow >\"\$f\"; printf '%s\t%s\n' //crates/pi-diff:slow_test $D >>\"\$W/native.tsv\"; cfg //crates/pi-diff:slow_test 'native_test rule'; summary //crates/pi-diff:slow_test PASSED '' \"\$f\""
NOT_MSG='cannot list its tests|ran in no invocation|but its binary lists' run J173-native-test-first-lists-its-src-binary 0 '' '' "{ $P; $NTF; listed $D d::one d::slow -- d::one; } >\"\$bep\"; exit 0"
# A native_test of a binary in another repository: its own path is listed
# when its `out` is its name (J174: nt writes a binary there); otherwise
# nothing here knows where the binary is, and the accounting names it (J175).
NTX="f=\"\$(tpath //crates/pi-diff:ext_test)\"; mkdir -p \"\$(dirname \"\$f\")\"; FMT=json lt_pass e::one >\"\$f\"; printf '%s\t%s\n' //crates/pi-diff:ext_test @dep//pkg:tests >>\"\$W/native.tsv\"; cfg //crates/pi-diff:ext_test 'native_test rule'; summary //crates/pi-diff:ext_test PASSED '' \"\$f\""
NOT_MSG='cannot list its tests|ran in no invocation|but its binary lists' run J174-external-native-test-at-its-own-path 0 '' '' "{ $P; nt //crates/pi-diff:ext_test @dep//pkg:tests PASSED lt_pass e::one; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 0"
run J175-external-native-test-elsewhere 1 "//crates/pi-diff:ext_test's binary .*/bin/crates/pi-diff/ext_test cannot list its tests" '' "{ $P; $NTX; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 0"
# A log that ended early (a timeout) is named once; the accounting leaves its
# binary out rather than blame a filter.
NOT_MSG='ran in no invocation|but its binary lists' run J94-timeout-named-once 1 "$D is TIMEOUT, but libtest planned 2 tests and reported 0" '' "{ $P; fakebin $D d::one d::two d::three; rt $D TIMEOUT lt_partial; } >\"\$bep\"; exit 3"

# #[ignore]d tests: each runs alone (--ignored), as root where it needs root,
# or is a child entry point, or runs in the macOS job; any other fails.
IGN="rt $D PASSED lt_ignored d::one d::needs_network"
run J93-ignored-test-runs-nowhere 1 "$D d::needs_network is #\\[ignore\\]d and runs in no invocation" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network d::one: the parent test" run J95-ignored-child-entry 0 "a child process's entry point another test starts: $D d::needs_network" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
MACOS="$D d::needs_network" run J96-ignored-runs-on-macos 0 "run by the macOS job: $D d::needs_network" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network d::one: the parent test
$D d::one d::needs_network: the parent test" run J97-child-entry-that-ran 1 "$D d::one is in .github/sami/rust-test-child-entries.txt but is no #\\[ignore\\]d test" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_RUN="$D d::needs_network" OWN_TESTS="d::one d::needs_network" run J98-ignored-test-run-alone 0 "Ignored test ran alone: $D d::needs_network \\(ok\\)" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_RUN="$D d::renamed" OWN_TESTS="d::one d::needs_network" run J99-ignored-run-matches-nothing 1 "own invocation for d::renamed reported \\[\\]" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_ROOT="$B r::cycle" OWN_TESTS="a::one r::cycle" run J100-ignored-root-run-alone 0 "Ignored root test ran alone: $B r::cycle \\(ok\\)" '' "{ $P; rt $B PASSED lt_ignored a::one r::cycle; } >\"\$bep\"; exit 0"
IGNORED_ROOT="$B r::cycle" IGN_ROOT_BODY="FMT=json; rt $B FAILED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\n{ \"type\": \"test\", \"name\": \"r::cycle\", \"event\": \"failed\", \"stdout\": \"mount --bind failed\" }\n{ \"type\": \"suite\", \"event\": \"failed\", \"passed\": 0, \"failed\": 1, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 1, \"exec_time\": 0.0 }\n' >\"\$bep\"; exit 3" run J101-ignored-root-failing-body 1 "$B r::cycle failed and is not in" '' "{ $P; rt $B PASSED lt_ignored a::one r::cycle; } >\"\$bep\"; exit 0"

# The #[ignore]d test whose reason starts `opt: ` (pi-ast's whole-repository
# sweep) runs alone in a -c opt build of its target: a -c opt bazel build,
# then its -c opt bazel test, after every other invocation. Its log is read as
# any ignored test's: a failure fails (O3), a crash is a binary that ended
# before its tests did and no pass (O4), a run that did not report it (O5) or
# left it ignored (O6) fails; a build failure fails (O7), and a build that
# Bazel itself failed stops the step (O8). The job log names the compilation
# mode and gives the build and test seconds (O1). Each O case fails against
# Cut11's step (66f6b470), which runs the sweep in the fastbuild ignored pass:
# there the stub's fastbuild run of it passes.
A=//crates/pi-ast:pi-ast_test
SW=block::tests::pruned_walk_matches_unpruned_on_full_repo_corpus
OMAIN="{ $P; rt $A PASSED lt_ignored a::one $SW; } >\"\$bep\"; exit 0"
OKNOWN="$PR p::summary
$A $SW"
OPASS="FMT=json; { RUN_S=212.3 FILTERED=1 rt $A PASSED lt_out $SW 'full corpus: 8661 files, 69288 comparisons\\n'; metrics 214500; } >\"\$bep\"; exit 0"
OSTART="printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\n"
OEND="{ \"type\": \"suite\", \"event\": \"failed\", \"passed\": 0, \"failed\": 1, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 1, \"exec_time\": 0.0 }\n'"
OFAIL="FMT=json; rt $A FAILED $OSTART{ \"type\": \"test\", \"name\": \"$SW\", \"event\": \"failed\", \"stdout\": \"assertion left == right failed: x.ts ranges=[(1, 40)]\" }\n$OEND >\"\$bep\"; exit 3"
OCRASH="FMT=json; rt $A FAILED $OSTART{ \"type\": \"test\", \"event\": \"started\", \"name\": \"$SW\" }\n' >\"\$bep\"; exit 3"
OMISS="FMT=json; FILTERED=2 rt $A PASSED lt_out >\"\$bep\"; exit 0"
OSTILL="FMT=json; rt $A PASSED $OSTART{ \"type\": \"test\", \"name\": \"$SW\", \"event\": \"ignored\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 0, \"failed\": 0, \"ignored\": 1, \"measured\": 0, \"filtered_out\": 1, \"exec_time\": 0.0 }\n' >\"\$bep\"; exit 0"
o_run() { KNOWN_OUTPUT="$OKNOWN" IGNORED_OPT="$A $SW" OWN_TESTS="a::one $SW" OWN_PRINTS="$SW" run "$@"; }
IGN_OPT_BODY="$OPASS" NOT_MSG='::error' o_run O1-opt-sweep-names-its-mode-and-seconds 0 "^Ignored test in a -c opt build: $A $SW: compilation mode opt; build 98\\.8 s \\(bazel build, exit 0\\), test 214\\.5 s \\(bazel test; the test binary's run 212\\.3 s\\)\$" '' "$OMAIN"
IGN_OPT_BODY="$OPASS" NOT_MSG='::error' o_run O2-opt-sweep-reads-ok 0 "^Ignored test in a -c opt build ran alone: $A $SW \\(ok\\)\$" '' "$OMAIN"
IGN_OPT_BODY="$OFAIL" o_run O3-opt-sweep-failure-fails 1 "$A $SW failed and is not in" '' "$OMAIN"
IGN_OPT_BODY="$OCRASH" NOT_MSG="ran alone: $A" o_run O4-opt-sweep-crash-is-no-pass 1 "$A is FAILED, but libtest planned 1 tests and reported 0, suite end none: the test binary ended before its tests did" '' "$OMAIN"
IGN_OPT_BODY="$OMISS" NOT_MSG="ran alone: $A" o_run O5-opt-run-without-the-sweep-fails 1 "::error title=Ignored test in a -c opt build::$A's own invocation for $SW reported \\[\\], not exactly that one test" '' "$OMAIN"
IGN_OPT_BODY="$OSTILL" NOT_MSG="ran alone: $A" o_run O6-opt-run-leaving-it-ignored-fails 1 "::error title=Ignored test in a -c opt build::$A $SW is #\\[ignore\\]d, so its own invocation ran nothing" '' "$OMAIN"
OPT_BUILD_BODY="metrics 30000 >\"\$bep\"; exit 1" IGN_OPT_BODY="FMT=json; { unbuilt $A; metrics 1000; } >\"\$bep\"; exit 1" o_run O7-opt-build-failure-fails 1 "compilation mode opt; build 30\\.0 s \\(bazel build, exit 1\\)" '' "$OMAIN"
OPT_BUILD_BODY="exit 37" o_run O8-opt-build-tool-error-stops 1 'bazel build exited 37 \(ignored-opt-0\)' '' "$OMAIN"
CARGO_MODE=ignored IGNORED_OPT="sdk/rust/demo:test:wire a::slow" run O9-opt-on-a-cargo-target-stops 1 "sdk/rust/demo:test:wire a::slow is a cargo target, and .opt: . \\(a -c opt build\\) is for a Bazel one" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# After every other invocation: an #[ignore]d root test of the same target
# runs before it (the stub fails any invocation after a -c opt one).
OMAIN3="{ $P; rt $A PASSED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 3 }\n{ \"type\": \"test\", \"name\": \"a::one\", \"event\": \"ok\" }\n{ \"type\": \"test\", \"name\": \"$SW\", \"event\": \"ignored\" }\n{ \"type\": \"test\", \"name\": \"a::cycle\", \"event\": \"ignored\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 1, \"failed\": 0, \"ignored\": 2, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'; } >\"\$bep\"; exit 0"
IGNORED_ROOT="$A a::cycle" NOT_MSG='stub:|::error' KNOWN_OUTPUT="$OKNOWN" IGNORED_OPT="$A $SW" OWN_TESTS="a::one $SW a::cycle" OWN_PRINTS="$SW" run O10-opt-run-comes-last 0 "^Ignored test in a -c opt build ran alone: $A $SW \\(ok\\)\$" '' "$OMAIN3"
# From the cross-family review of 2df3883c: a timing that is no finite number
# of 0 or more (jq 1.6 reads "NaN" as a number) reads UNKNOWN, not 0.0, and
# the verdict stays the test's.
OPT_BUILD_BODY="metrics NaN >\"\$bep\"; exit 0" IGN_OPT_BODY="FMT=json; { RUN_S=-1 FILTERED=1 rt $A PASSED lt_out $SW 'full corpus: 8661 files, 69288 comparisons\\n'; metrics 1e999; } >\"\$bep\"; exit 0" NOT_MSG='::error' o_run O11-opt-malformed-timings-read-unknown 0 "compilation mode opt; build UNKNOWN s \\(bazel build, exit 0\\), test UNKNOWN s \\(bazel test; the test binary's run UNKNOWN s\\)\$" '' "$OMAIN"

# TT: each test attempt's run time, from the build event log's testResult
# events (Bazel's own summary names only the targets that did not pass): the
# measure a target's timeout is set from. It changes no verdict.
NOT_MSG='::error' run TT1-each-attempt-prints-its-run-time 0 "^Test time \\(main\\): $D attempt 1: PASSED in 412\\.3 s\$" '' "{ $P; rt $D PASSED lt_pass a::one; attempt $D PASSED 1 412.345; } >\"\$bep\"; exit 0"
TT2="{ $P; rt $D PASSED lt_pass a::one; attempt $D FAILED 1 61.5; attempt $D PASSED 2 50.9; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run TT2a-a-retried-target-prints-its-first-attempt 0 "^Test time \\(main\\): $D attempt 1: FAILED in 61\\.5 s\$" '' "$TT2"
NOT_MSG='::error' run TT2b-a-retried-target-prints-its-second-attempt 0 "^Test time \\(main\\): $D attempt 2: PASSED in 50\\.9 s\$" '' "$TT2"
NOT_MSG='::error' run TT3-the-older-millisecond-field-is-read 0 "^Test time \\(main\\): $D attempt 1: PASSED in 212\\.3 s\$" '' "{ $P; rt $D PASSED lt_pass a::one; MILLIS=1 attempt $D PASSED 1 212345; } >\"\$bep\"; exit 0"
NOT_MSG='::error|in 0\.0 s' run TT4-a-time-that-is-no-finite-number-is-unknown 0 "^Test time \\(main\\): $D attempt 1: PASSED in UNKNOWN s\$" '' "{ $P; rt $D PASSED lt_pass a::one; attempt $D PASSED 1 NaN; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run TT5-a-reused-result-says-so 0 "^Test time \\(main\\): $D attempt 1: PASSED in 3\\.0 s \\(cached: an earlier run's result\\)\$" '' "{ $P; rt $D PASSED lt_pass a::one; CACHED=1 attempt $D PASSED 1 3; } >\"\$bep\"; exit 0"
NOT_MSG='::error|^Test time ' run TT6-a-log-without-attempts-says-so 0 "^Test times \\(main\\): the build event log names no test attempt\$" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run TT7-a-shard-is-named 0 "^Test time \\(main\\): $D attempt 1, shard 2: TIMEOUT in 300\\.0 s\$" '' "{ $P; rt $D PASSED lt_pass a::one; SHARD=2 attempt $D TIMEOUT 1 300; } >\"\$bep\"; exit 0"

# B1: an #[ignore]d cargo test runs alone (rust-test-ignored.txt), or fails
# the job.
CARGO_MODE=ignored run J102-cargo-ignored-unlisted 1 "sdk/rust/demo:test:wire a::slow is #\\[ignore\\]d and runs in no invocation" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored IGNORED_RUN="sdk/rust/demo:test:wire a::slow" run J103-cargo-ignored-run-alone 0 "Ignored cargo test ran alone: sdk/rust/demo:test:wire a::slow \\(ok\\)" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored-fails IGNORED_RUN="sdk/rust/demo:test:wire a::slow" run J104-cargo-ignored-failing-body 1 "sdk/rust/demo:test:wire a::slow failed and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored IGNORED_RUN="sdk/rust/demo:test:wire a::gone" run J104b-cargo-ignored-listed-renamed 1 "own invocation for a::gone reported \\[" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# B2: an \`\`\`ignore doc block is no test (upstream marks it so that rustdoc
# never runs it): it is counted and named, in Bazel's doctest log and in
# cargo's, and fails nothing; an #[ignore]d cargo test beside it still fails.
DOCIGN="dt $DOC PASSED printf 'running 2 tests\ntest src/lib.rs - f (line 3) ... ok\ntest src/lib.rs - g (line 9) ... ignored\n\ntest result: ok. 1 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'"
NOT_MSG='::error' run J105-bazel-ignore-doc-block-is-no-test 0 '```ignore doc blocks, not tests, marked ignore by upstream: 1' '' "{ $P; rt $D PASSED lt_pass a::one; $DOCIGN; } >\"\$bep\"; exit 0"
CARGO_MODE=doc-ignored NOT_MSG='::error' run J106-cargo-ignore-doc-block-is-no-test 0 'sdk/rust/demo src/lib.rs - g \(line 9\) \(cargo.s log\)' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J109-no-ignore-doc-blocks 0 '```ignore doc blocks, not tests, marked ignore by upstream: 0' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=ignored-and-doc-ignored NOT_MSG='ignore doctest|src/lib.rs - g.*(fail|runs in no invocation)' run J112-ignore-doc-block-passes-ignored-cargo-test-fails 1 "sdk/rust/demo:test:wire a::slow is #\\[ignore\\]d and runs in no invocation" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# B3: on Linux the crates' doctests run only in Bazel: the stub refuses a
# cargo test --doc of a crate under crates/ there (D1 shows none ran), and
# the job reads the doctests from the source instead (D1-D34 below).
# D1-D34: on Linux each crate with a Bazel doctest target has its doctests
# read from its source (.github/sami/rust-test-doctest-forms.awk, no build):
# a line of a doctest rustdoc runs that prints or holds a skip word fails the
# job, named by file and line; a doc attribute the reader does not read
# fails as UNKNOWN; and every doctest Bazel ran must be one the reader found
# at its file and line, or the job fails as UNKNOWN. D1 is the plain
# doctest, D2 the planted one that prints.
NOT_MSG='stub:|::error' run D1-plain-doctest-passes 0 'Doctests read from the source of 1 crates: 1; Bazel ran 1; lines that print or skip: 0' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! println!("planted");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D2-doctest-that-prints-fails 1 '::error title=Rust test printed::crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints \(println!\("planted"\);\)' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let why = "skipped: no reference rsync";\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D3-doctest-with-a-skip-word-fails 1 '::error title=Rust test skips::crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs holds a skip word' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! eprintln!("x");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D4-doctest-eprintln-fails 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! dbg!(1);\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D5-doctest-dbg-fails 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! use std::io::Write; writeln!(std::io::stdout(), "x").unwrap();\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D6-doctest-stdout-write-fails 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! # println!("hidden");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D7-hidden-line-that-prints-fails 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n//!\n//! ```ignore\n//! println!("never run");\n//! ```\n//!\n//! ```text\n//! skipped: words, not code\n//! ```\npub fn f() {}' NOT_MSG='stub:|::error' run D8-ignore-and-text-blocks-pass 0 'Doctests read from the source of 1 crates: 1; Bazel ran 1; lines that print or skip: 0' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n//!\n//! Example:\n//!\n//!     println!("indented");\npub fn f() {}' NOT_MSG='stub:' run D9-indented-doctest-that-prints-fails 1 'crates/pi-diff/src/lib.rs:9: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n/**\n * ```\n * let _ = 1;\n * println!("x");\n * ```\n */\npub fn f() {}' NOT_MSG='stub:' run D10-block-doc-doctest-that-prints-fails 1 'crates/pi-diff/src/lib.rs:9: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n//!\n//! - an item:\n//!   ```\n//!   println!("x");\n//!   ```\npub fn f() {}' NOT_MSG='stub:' run D11-doctest-in-a-list-item-that-prints-fails 1 'crates/pi-diff/src/lib.rs:9: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc = "```\\nprintln!(\\"x\\");\\n```"]\npub fn f() {}' NOT_MSG='stub:' run D12-literal-doc-attribute-doctest-that-prints-fails 1 'crates/pi-diff/src/lib.rs:6: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#![doc = include_str!("../README.md")]\npub fn f() {}' NOT_MSG='stub:' run D13-include-str-doc-attribute-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute whose value is not a one-line string literal' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! Words.\n//!\n//! ```\n//! assert!(true);\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D14-bazel-doctest-the-reader-did-not-find-fails 1 'UNKNOWN: crates/pi-diff src/lib.rs - f \(line 3\) ran in Bazel.s doctest target, and the doctest reader found no doctest at crates/pi-diff/src/lib.rs line 3' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=none NOT_MSG='stub:' run D15-crate-without-source-fails 1 'UNKNOWN: crates/pi-diff src/lib.rs - f \(line 3\) ran in Bazel.s doctest target, and the doctest reader found no doctest' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let s = "UNCOMPARED: x";\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D16-skip-words-are-the-scans 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs holds a skip word' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let s = "UNKNOWN: x";\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D16b-unknown-is-a-skip-word 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs holds a skip word' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D17-D21, from the GPT-6.1 Sol review of 4379925a: a doctest's text across a
# blank source line, a nested comment in a block doc, a doc attribute escape,
# a print split from its `!`, and a doctest still open at its text's end.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n\n//! println!("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D17-doctest-body-after-a-blank-source-line-fails 1 'crates/pi-diff/src/lib.rs:6: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n/**\n * ```\n * /* a nested comment */\n * println!("missed");\n * ```\n */\npub fn f() {}' NOT_MSG='stub:' run D18-nested-comment-in-a-block-doc-doctest-fails 1 'crates/pi-diff/src/lib.rs:9: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc = "```\\nprint\\x6cn!(\\"x\\");\\n```"]\npub fn f() {}' NOT_MSG='stub:' run D19-doc-attribute-escape-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute whose value is not a one-line string literal' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! println\n//! !("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D20-println-split-from-its-bang-fails 1 'crates/pi-diff/src/lib.rs:4: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n/// ```\n/// let _ = 1;\npub fn f() {}' NOT_MSG='stub:' run D21-doctest-open-at-the-end-of-its-text-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doctest still open where the doc text the reader joined ends' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D22, D23, from the second round of that review: a no_run block whose info
# string rustdoc reads otherwise is read, and a quoted fence-like line inside
# a doctest does not end it.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n//! ```rust (reason no_run here)\n//! println!("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D22-no-run-block-that-prints-fails 1 'crates/pi-diff/src/lib.rs:7: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let _ = r#"\n//! > ```\n//! > ```text\n//! "#;\n//! println!("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D23-quoted-fence-inside-a-doctest-fails 1 'crates/pi-diff/src/lib.rs:8: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D24, D25, from its third round: a fence-like line 4 spaces in, or after a
# list marker, inside a doctest does not end it either.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let _ = r#"\n//!     ```\n//!     ```text\n//! "#;\n//! println!("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D24-indented-fence-like-lines-inside-a-doctest-fail 1 'crates/pi-diff/src/lib.rs:8: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! let _ = r#"\n//! - ```\n//! - ```text\n//! "#;\n//! println!("missed");\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D25-list-marked-fence-like-lines-inside-a-doctest-fail 1 'crates/pi-diff/src/lib.rs:8: a doctest rustdoc runs prints' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D26, from its fourth round: two doc attributes on one line.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc = "```\\nprintln!(\\"missed\\");\\n```"] #[doc = "<!--\\n```\\nassert!(true);\\n```\\n-->"]\npub fn f() {}' NOT_MSG='stub:' run D26-two-doc-attributes-on-a-line-are-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute this reader does not read' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D27-D29, from its fifth and sixth rounds: a comment between doc and its
# `=`, alone or beside another attribute, and comment markers in a string;
# a doc attribute line with /* or */ on it is unread.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc /* gap */ = "```\\nprintln!(\\"missed\\");\\n```"] #[doc = "<!--\\n```\\nassert!(true);\\n```\\n-->"]\npub fn f() {}' NOT_MSG='stub:' run D27-doc-attribute-with-a-comment-before-its-equals-is-read 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute this reader does not read' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc /* gap */ = "```\\nprintln!(\\"x\\");\\n```"]\npub fn f() {}' NOT_MSG='stub:' run D28-doc-attribute-with-a-comment-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute this reader does not read' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc = "```\\nlet _ = \\"/*\\"; println!(\\"missed\\"); let _ = \\"*/\\";\\n```"]\npub fn f() {}' NOT_MSG='stub:' run D29-comment-markers-in-a-doc-attribute-string-are-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute this reader does not read' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D30, from its seventh round: an attribute split over lines beside another.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[doc = "```"] #[doc\n= "println!(\\"missed\\");"] #[doc = "```"]\npub fn f() {}' NOT_MSG='stub:' run D30-split-doc-attribute-beside-another-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:6: a doc attribute over more than one line' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D31, from its eighth round: a raw identifier, r#doc.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n/// ```\n#[r#doc = "println!(\\"missed\\");"]\n/// ```\npub fn f() {}' NOT_MSG='stub:' run D31-raw-identifier-doc-attribute-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:7: a doc attribute this reader does not read' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D32, from its ninth round: a doc attribute over lines (its `#[` alone on a
# line) is unread; D33: an attribute over lines whose doc is doc(cfg(...))
# carries no doc text, and passes.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n/// Example:\n///\n///     assert!(true);\n#[\ndoc = "     println!(\\"missed\\");"\n]\npub fn f() {}' NOT_MSG='stub:' run D32-doc-attribute-over-lines-is-unread 1 'UNKNOWN: crates/pi-diff/src/lib.rs:9: a doc attribute over more than one line' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n#[cfg_attr(\n    docsrs,\n    doc(cfg(feature = \"x\"))\n)]\npub fn f() {}' NOT_MSG='stub:|::error' run D33-attribute-over-lines-with-doc-cfg-passes 0 'Doctests read from the source of 1 crates: 1; Bazel ran 1; lines that print or skip: 0' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# D34, from the fork peer's review of 353156e9 (its case X1): a doctest the
# reader finds that Bazel's doctest target did not run is UNKNOWN, as the
# cargo re-run's comparison was, both ways.
DOC_SRC=$'//! The crate.\n//!\n//! ```\n//! assert!(true);\n//! ```\n//!\n//! ```\n//! assert_eq!(1, 1);\n//! ```\npub fn f() {}' NOT_MSG='stub:' run D34-doctest-bazel-did-not-run-is-unknown 1 'UNKNOWN: crates/pi-diff/src/lib.rs:7: the doctest reader found a doctest here that no Bazel doctest target ran' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# B4: the listings the drift check compares with the early ones.
run J108-listings-for-the-drift-check 0 'Listings for the drift check: 2 binaries' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# R3-1: a line a test binary writes outside libtest's record (a child's or a
# thread's write to the inherited stream) is a skip if it has a skip word,
# and must match rust-test-known-raw-output.txt otherwise, or the job fails.
RAWREC="printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\n{ \"type\": \"test\", \"event\": \"started\", \"name\": \"wt::carry\" }\nno free port: nothing to test\n{ \"type\": \"test\", \"name\": \"wt::carry\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"ok\", \"passed\": 1, \"failed\": 0, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 0, \"exec_time\": 0.1 }\n'"
run J116-raw-other-wording-fails 1 "$D wrote 1 lines outside libtest's record that .github/sami/rust-test-known-raw-output.txt does not name .*: no free port: nothing to test" '' "{ $P; rt $D PASSED $RAWREC; } >\"\$bep\"; exit 0"
KNOWN_RAW="$D no free port: nothing to test" NOT_MSG='::error' run J117-raw-line-named 0 "Lines outside libtest's record: 1 distinct, 0 named by no entry" '' "{ $P; rt $D PASSED $RAWREC; } >\"\$bep\"; exit 0"
KNOWN_RAW="$D (running 1 test|test result: .*)" NOT_MSG='::error' run J118-raw-entry-unused-is-a-notice 0 "::notice title=Known raw output did not happen::$D \\(running 1 test" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
KNOWN_RAW="$PR no free port: nothing to test" run J119-raw-entry-of-another-target 1 "$D wrote 1 lines outside libtest's record" '' "{ $P; rt $D PASSED $RAWREC; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run J120-bazel-banner-is-no-output 0 "Lines outside libtest's record: 0 distinct" '' "banner_pass() { printf '%s\n' 'exec \${PAGER:-/usr/bin/less} \"\$0\" || exit 1' 'Executing tests from $D' '-----------------------------------------------------------------------------'; FMT=json lt_pass a::one; }; { $P; rt $D PASSED banner_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=stderr-raw run J121-cargo-stderr-other-wording-fails 1 "sdk/rust/demo:test:wire wrote 1 lines outside libtest's record .*: no free port: nothing to test" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
NOT_MSG='Compiling demo' run J122-cargo-build-output-is-no-output 0 "Lines outside libtest's record: 0 distinct" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# A raw line written in pieces, with libtest's event between two of them on
# the same line (run 44936196181): the event is moved to a line of its own and
# counts, and the raw line's pieces are joined again.
tangled_rec() { printf '{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "event": "started", "name": "b::len" }\n%s{ "type": "test", "name": "b::len", "event": "ok" }\n{ "type": "test", "event": "started", "name": "b::next" }\n%s\n{ "type": "test", "name": "b::next", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 2, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n' "$1" "$2"; }
TANGLE="$(declare -f tangled_rec)"
KNOWN_RAW="$D b2sum: bad length 7" NOT_MSG='::error|ended before' run J123-tangled-event-counts 0 "$D: 1 libtest events shared a line with output written outside the record" '' "$TANGLE; { $P; rt $D PASSED tangled_rec 'b2sum: bad len' 'gth 7'; } >\"\$bep\"; exit 0"
NOT_MSG='ended before' run J124-tangled-raw-other-wording-fails 1 "$D wrote 1 lines outside libtest's record .*: no free port: nothing to test" '' "$TANGLE; { $P; rt $D PASSED tangled_rec 'no free port: noth' 'ing to test'; } >\"\$bep\"; exit 0"
NOT_MSG='ended before' run J125-tangled-raw-skip-marker-fails 1 "$D b::next skipped itself and is not in" '' "$TANGLE; { $P; rt $D PASSED tangled_rec 'b::next: skip' 'ped: no port'; } >\"\$bep\"; exit 0"
CARGO_MODE=tangled NOT_MSG='ended before|planned 2 tests and reported 1' run J126-cargo-tangled-raw-other-wording-fails 1 "sdk/rust/demo:test:wire wrote 1 lines outside libtest's record .*: no free port: nothing to test" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# The sticky-directory FIFO tests: taken out of the main invocation, then run
# alone twice out of the sandbox, as the runner's user given the job's FIFO
# and as root; each must run, pass and print nothing there.
SN=d::x::an_open_is_refused_in_a_sticky_directory
SMAIN="{ $P; listed $D d::one $SN -- d::one; } >\"\$bep\"; exit 0"
OWN_TESTS="d::one $SN" NOT_MSG='::error' run S1-sticky-test-runs-as-user-and-root 0 "Sticky-directory FIFO tests, each run as the runner's user and as root: 1" '' "$SMAIN"
OWN_TESTS="d::one $SN" run S1b-sticky-test-names-its-runs 0 "Sticky-directory FIFO test, as root ran alone: $D $SN \\(ok\\)" '' "$SMAIN"
OWN_TESTS="d::one $SN" OWN_PRINTS="$SN" run S2-sticky-test-prints-there 1 "$D $SN printed and is not in .github/sami/rust-test-known-output.txt" '' "$SMAIN"
OWN_TESTS="d::one $SN" STICKY_ROOT_BODY="FMT=json; FILTERED=1 rt $D FAILED lt_fail $SN >\"\$bep\"; exit 3" run S3-sticky-test-fails-as-root 1 "$D $SN failed and is not in" '' "$SMAIN"
OWN_TESTS="d::one $SN" STICKY_FIFO=none run S4-sticky-test-without-fifo 1 "the tree has 1 sticky-directory FIFO tests, and RUST_TEST_STICKY_FIFO names no FIFO" '' "$SMAIN"
OWN_TESTS="d::one $SN" STICKY_BODY=": >\"\$bep\"; exit 0" run S5-sticky-user-run-missing 1 "Sticky-directory FIFO test, as the runner's user::$D has no one test log for $SN in its own invocation" '' "$SMAIN"
STICKY_FIFO=none NOT_MSG='::error' run S6-no-sticky-test-needs-no-fifo 0 "Sticky-directory FIFO tests, each run as the runner's user and as root: 0" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
KNOWN_OUTPUT="$PR p::summary
$D $SN" OWN_TESTS="d::one $SN" STICKY_ROOT_BODY="FMT=json; FILTERED=1 rt $D PASSED lt_out $SN 'UNKNOWN: no FIFO; nothing was checked\\n' >\"\$bep\"; exit 0" run S7-sticky-unknown-fails-though-listed 1 "$D $SN printed UNKNOWN: in its own invocation, so it checked nothing" '' "$SMAIN"
# From the Claude-family review of fa27bafb: a line outside the record is
# judged by parsing it, not by its first character (F1); a doctest's output
# with no newline before its result stays that doctest's (F2); two children
# whose writes split each other's lines fail closed (F3), and whole lines pass.
cl4_raw() { printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "wt::carry" }\n%s\n{ "type": "test", "name": "wt::carry", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n' "$1"; }
CL4RAW="$(declare -f cl4_raw)"
run J127-brace-raw-line-fails 1 "$D wrote 1 lines outside libtest's record .*: \\{ no free port: nothing to test \\}" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '{ no free port: nothing to test }'; } >\"\$bep\"; exit 0"
run J128-json-raw-line-fails 1 "$D wrote 1 lines outside libtest's record .*status" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '{\"status\": \"no free port: nothing to test\"}'; } >\"\$bep\"; exit 0"
cl4_two_children() { printf '{ "type": "suite", "event": "started", "test_count": 1 }\n\nrunning 1 test\ntest a::x ... \nrunning 1 test\nok\n{ "type": "test", "name": "wt::carry", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; }
cl4_two_whole() { printf '{ "type": "suite", "event": "started", "test_count": 1 }\n\nrunning 1 test\n\nrunning 1 test\ntest a::x ... ok\n{ "type": "test", "name": "wt::carry", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; }
CL4TWO="$(declare -f cl4_two_children cl4_two_whole)"
KNOWN_RAW="$D (running 1 test|test a::x \\.\\.\\. ok)" run J130-split-child-lines-fail-closed 1 "$D wrote 2 lines outside libtest's record" '' "$CL4TWO; { $P; rt $D PASSED cl4_two_children; } >\"\$bep\"; exit 0"
KNOWN_RAW="$D (running 1 test|test a::x \\.\\.\\. ok)" NOT_MSG='::error' run J131-whole-child-lines-pass 0 "Lines outside libtest's record: 2 distinct, 0 named by no entry" '' "$CL4TWO; { $P; rt $D PASSED cl4_two_whole; } >\"\$bep\"; exit 0"
# From the Claude-family review of ef77cbbf (N1): a JSON object that only says
# its type is test or suite, without an event's shape, is output too.
run J132-typed-test-object-is-output 1 "$D wrote 1 lines outside libtest's record" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '{\"type\": \"test\", \"status\": \"no free port: nothing to test\"}'; } >\"\$bep\"; exit 0"
run J133-typed-suite-object-is-output 1 "$D wrote 1 lines outside libtest's record" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '{\"type\": \"suite\", \"note\": \"no free port: nothing to test\"}'; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED sh -c 'cat $fixtures/root-root.json; echo \"{\\\"type\\\": \\\"test\\\", \\\"note\\\": \\\"t::needs_root: not run: no root\\\"}\"' >\"\$bep\"; exit 0" run J55c-root-not-run-in-typed-object 1 "printed 'not run:' outside libtest's record" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
KNOWN_OUTPUT="$PR p::summary
$D $SN" OWN_TESTS="d::one $SN" STICKY_BODY="FMT=json; FILTERED=1 rt $D PASSED lt_out $SN 'UNKNOWN: not root and no PI_TEST_STICKY_FIFO; nothing was checked\\n' >\"\$bep\"; exit 0" run S8-sticky-user-unknown-fails-though-listed 1 "$D $SN printed UNKNOWN: in its own invocation" '' "$SMAIN"
x_tail() { printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "wt::carry" }\nno free port: nothing to test{ "type": "test", "name": "wt::carry", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; }
XTAIL="$(declare -f x_tail)"
NOT_MSG='ended before' run J134-piece-before-the-last-event-is-read 1 "$D wrote 1 lines outside libtest's record .*: no free port: nothing to test" '' "$XTAIL; { $P; rt $D PASSED x_tail; } >\"\$bep\"; exit 0"
# From the Claude-family review of 6b0eca04: a bench-typed object with no
# result's fields, an array and a number are output (a doctest's typed
# objects: K15, K16).
run J137-bench-typed-object-is-output 1 "$D wrote 1 lines outside libtest's record" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '{\"type\": \"bench\", \"name\": \"x\", \"note\": \"no free port: nothing to test\"}'; } >\"\$bep\"; exit 0"
run J138-array-line-is-output 1 "$D wrote 1 lines outside libtest's record .*: \\[\"no free port: nothing to test\"\\]" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '[\"no free port: nothing to test\"]'; } >\"\$bep\"; exit 0"
run J139-number-line-is-output 1 "$D wrote 1 lines outside libtest's record .*: 42" '' "$CL4RAW; { $P; rt $D PASSED cl4_raw '42'; } >\"\$bep\"; exit 0"
# A log jq cannot read to its end (jq fails on outside_record's filter): the
# step fails, and says so in the job log, for a Bazel log and for a cargo log
# (the cargo workspaces' and the doctest run's), not inside a raw-output error.
JQ_FAIL='else $l end' NOT_MSG="lines outside libtest's record that" run J140-jq-error-on-a-bazel-log-fails-in-the-job-log 1 "^::error title=Rust tests::jq could not read .*/logs/[0-9]+\\.log to its end" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
JQ_FAIL='else $l end' NOT_MSG="lines outside libtest's record that" run J141-jq-error-on-a-cargo-log-fails-in-the-job-log 1 "^::error title=Rust tests::jq could not read .*/logs/cargo-[0-9]+\\.log to its end" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# pi-natives' crash report, read with the committed raw-output list (or the
# one RUST_TEST_RAW_LIST names): its lines count only in a log that holds the
# report's first line, and a frame must look like one.
NAT=//crates/pi-natives:pi_natives_test
RAWLIST="${RUST_TEST_RAW_LIST:-$repo/.github/sami/rust-test-known-raw-output.txt}"
crash_rec() { printf '{ "type": "suite", "event": "started", "test_count": 1 }\n{ "type": "test", "event": "started", "name": "vcs::tests::catch" }\n'; printf '%s\n' "$@"; printf '{ "type": "test", "name": "vcs::tests::catch", "event": "ok" }\n{ "type": "suite", "event": "ok", "passed": 1, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.1 }\n'; }
CRASH="$(declare -f crash_rec)"
REPORT="'pi-natives panic crash' 'pi-natives crash report written to /tmp/t/pi-natives-test-logs-7/native-panic-1-2.log' 'timestamp: 1763700000000 (unix ms)' 'pid:       4242' 'thread:    vcs::tests::catch_panic_converts_native_panics_into_backend_errors' 'message:   valid name: Os { code: 2 }' 'location:  bazel-out/k8-fastbuild/bin/crates/pi-natives/src/vcs.rs:40:9' 'backtrace:' '   0: <std::backtrace::Backtrace>::create' '             at /rustc/f5cedb83a788ea9581097abc36a2a8503a7f541c/library/std/src/backtrace.rs:331:13' '   1: pi_natives::crash_handler::format_panic_report' '  13: __rust_try' '  39: <unknown>'"
RAW_LIST=$RAWLIST NOT_MSG='::error' run J143-crash-report-passes 0 "Lines outside libtest's record: 13 distinct, 0 named by no entry" '' "$CRASH; { $P; rt $NAT PASSED crash_rec $REPORT; } >\"\$bep\"; exit 0"
RAW_LIST=$RAWLIST run J144-crash-frames-without-the-report-fail 1 "$NAT wrote 2 lines outside libtest's record that" '' "$CRASH; { $P; rt $NAT PASSED crash_rec '   4: std::panicking::begin_panic' '             at /rustc/f5cedb83a788ea9581097abc36a2a8503a7f541c/library/std/src/panicking.rs:1:2'; } >\"\$bep\"; exit 0"
RAW_LIST=$RAWLIST run J145-word-frame-in-a-report-fails 1 "$NAT wrote 1 lines outside libtest's record that .*, the first:   3: unavailable" '' "$CRASH; { $P; rt $NAT PASSED crash_rec $REPORT '  3: unavailable'; } >\"\$bep\"; exit 0"
RAW_LIST=$RAWLIST run J146-source-line-with-words-in-a-report-fails 1 "$NAT wrote 1 lines outside libtest's record that .*, the first: +at no port: nothing to test x.rs:1:1" '' "$CRASH; { $P; rt $NAT PASSED crash_rec $REPORT '             at no port: nothing to test x.rs:1:1'; } >\"\$bep\"; exit 0"
# Every list is read by one reader: a line without two spaces before its why
# stops the step, with the reader's message (rust-test-parity.sh and
# rust-test-macos-inventory.sh give the same one: P13, I9).
SANCTIONED_LINE="$D a::two ruling" run J147-list-line-without-its-why-stops 1 "rust-test-sanctioned-skips.txt:[0-9]+: no two spaces before its why: $D a::two ruling" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# A target that did not build: its list lines cannot be checked, so they read
# UNKNOWN in a notice, and the build failure alone fails the job. Bazel gives
# such a target no test summary, only a failed targetCompleted event: a
# child-entries line (J148), a sanctioned skip (J149), an #[ignore]d root test
# run alone (J150); and a summary that says FAILED_TO_BUILD (J151).
UB="unbuilt $B"
NOT_MSG='rust-test-child-entries.txt but is no|is no test of' CHILD_ENTRIES="$B b::child b::parent: the parent test" run J148-child-entry-of-a-target-that-did-not-build 1 "UNKNOWN: $B did not build, so whether b::child" '' "{ $P; cfg $B 'rust_test rule'; $UB; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 1"
NOT_MSG='takes out 0 tests' SANCTIONED="$B s::x::byte_totals" run J149-sanctioned-skip-of-a-target-that-did-not-build 1 "UNKNOWN: $B did not build, so what its skip s::x::byte_totals" '' "{ $P; cfg $B 'rust_test rule'; $UB; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 1"
NOT_MSG='has no one test log' IGNORED_ROOT="$B r::cycle" IGN_ROOT_BODY="{ cfg $B 'rust_test rule'; $UB; } >\"\$bep\"; exit 1" run J150-ignored-root-test-of-a-target-that-did-not-build 1 "UNKNOWN: $B did not build, so its own invocation for r::cycle" '' "{ $P; cfg $B 'rust_test rule'; $UB; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 1"
NOT_MSG='rust-test-child-entries.txt but is no|is no test of' CHILD_ENTRIES="$B b::child b::parent: the parent test" run J151-child-entry-of-a-target-summarized-failed-to-build 1 "UNKNOWN: $B did not build, so whether b::child" '' "{ $P; cfg $B 'rust_test rule'; summary $B FAILED_TO_BUILD; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 1"
# A test of rust-test-root-alone.txt is taken out of the main invocation and
# runs alone as root (J152); one that prints UNKNOWN: there checked nothing
# (J153); one the main invocation still runs fails (J154).
ROOT_ALONE="$B r::as_root" OWN_TESTS="a::one r::as_root" MAIN_MUST_SKIP=r::as_root run J152-root-test-alone 0 "Root test ran alone: $B r::as_root \\(ok\\)" '' "{ $P; sanct a::one r::as_root -- a::one; } >\"\$bep\"; exit 0"
ROOT_ALONE="$B r::as_root" KNOWN_OUTPUT="$B r::as_root" STICKY_ROOT_BODY="FMT=json; FILTERED=1 rt $B PASSED lt_out r::as_root 'UNKNOWN: not root\\n' >\"\$bep\"; exit 0" run J153-root-test-prints-unknown 1 "$B r::as_root printed UNKNOWN: in its own invocation as root" '' "{ $P; sanct a::one r::as_root -- a::one; } >\"\$bep\"; exit 0"
ROOT_ALONE="$B r::as_root" OWN_TESTS="a::one b::build_skipped r::as_root" run J154-root-test-ran-in-main 1 "$B r::as_root ran in the main invocation" '' "{ $P; sanct a::one b::build_skipped r::as_root -- a::one r::as_root; } >\"\$bep\"; exit 0"
# A list line for a target the tree lacks (one a member not in this tree
# adds) is named and nothing is run for it: bazel test of a target that does
# not exist is no test (J155).
NOT_MSG='bazel test exited|reported \[' IGNORED_RUN="//crates/pi-vcs:gone_test x::y" run J155-ignored-test-of-a-target-the-tree-lacks 1 "//crates/pi-vcs:gone_test x::y is in .github/sami/rust-test-ignored.txt, but the tree under test has no target //crates/pi-vcs:gone_test" '' "{ $P; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 0"
# A test listed flaky: its target gets Bazel's retries in the main invocation;
# failed on one attempt and passed on the next, it is known (J156); failed on
# every attempt, it is new (J157); passed on the first, it passes with a
# notice (J158). A plain known failure on a retried attempt stays as J17b.
FLAKY="$B x::f" MAIN_MUST_FLAKY="$B" run J156-flaky-listed-failed-then-passed 0 "Known flaky test, failed on 1 of 2 attempts and passed on another: $B x::f" '' "f=\"\$(tpath $B)\"; a=\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; mkdir -p \"\$(dirname \"\$a\")\"; lt_fail x::f >\"\$a\"; lt_pass x::passes x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B FLAKY \"\$a\" \"\$f\"; } >\"\$bep\"; exit 0"
NOT_MSG='Known flaky test, failed on' FLAKY="$B x::f" run J157-flaky-listed-failed-every-attempt 1 "$B x::f is listed flaky in .github/sami/rust-test-known-failures.txt, but failed on every attempt \\(2 of 2\\): NEW" '' "f=\"\$(tpath $B)\"; a=\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; mkdir -p \"\$(dirname \"\$a\")\"; lt_fail x::f >\"\$a\"; lt_fail x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B FAILED \"\$a \$f\"; } >\"\$bep\"; exit 3"
NOT_MSG='Known failure did not happen|failed and is not in' FLAKY="$B x::f" run J158-flaky-listed-passed-first 0 "$B x::f is listed flaky in .github/sami/rust-test-known-failures.txt and did not fail" '' "f=\"\$(tpath $B)\"; mkdir -p \"\$(dirname \"\$f\")\"; lt_pass x::passes x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B PASSED '' \"\$f\"; } >\"\$bep\"; exit 0"

# A child entry names the tests that start it (`<parent>[ and <parent>...]:
# <reason>`), and each must be a test of the binary: a valid pair passes
# (J159); a parent renamed since the line was written (d::starts_the_child,
# now d::starts_the_child_now) fails (J160), also as the second of two
# (J161); a line with no `<parent>: <reason>` stops the job (J162), and so
# does a parent in prose, which is no test name (J163).
IGN_RENAMED="rt $D PASSED lt_ignored d::starts_the_child_now d::needs_network"
NOT_MSG='is no test of' CHILD_ENTRIES="$D d::needs_network d::one: the parent test" run J159-child-entry-parent-is-a-test 0 "Child entry's parent is a test of its binary: $D d::one starts d::needs_network" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network d::starts_the_child: the parent test" run J160-child-entry-parent-renamed 1 "d::starts_the_child, which .github/sami/rust-test-child-entries.txt names as the test that starts $D d::needs_network, is no test of $D \\(renamed or deleted\\)" '' "{ $P; $IGN_RENAMED; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network d::needs_network and d::starts_the_child: the parent tests" run J161-child-entry-second-parent-renamed 1 "d::starts_the_child, which .github/sami/rust-test-child-entries.txt names as the test that starts $D d::needs_network, is no test of $D" '' "{ $P; $IGN_RENAMED; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network d::one" run J162-child-entry-without-a-reason 1 "rust-test-child-entries.txt:3: no \"<parent test>: <reason>\"" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network the parent test: it starts the binary again" run J163-child-entry-parent-in-prose 1 "rust-test-child-entries.txt:3: \"the parent test\" is no full libtest test name" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"

# RUST_TEST_ONLY (the macOS job): only the listed tests and the canary run,
# and each listed test must run.
ONLYT="$D m::langinfo
$D m::strftime"
export CAN="$PR p::canary"
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" run K1-only-listed-tests-ran 0 "Ran here, as .github/sami/only.txt names: $D m::strftime" '' 'exit 9'
ONLY="$ONLYT
$D m::gone" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" run K2-only-listed-test-absent 1 "$D m::gone is in .github/sami/only.txt but did not run here" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="" run K3-only-nothing-printed 1 'UNKNOWN: no passing test.s output' '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$D m::langinfo" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="m::langinfo" run K4-only-canary-silent 1 "UNKNOWN: the canary $PR p::canary printed nothing" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" OWN_BODY="if [ \"\$OWN_TARGET\" = $D ]; then FMT=json rt $D FAILED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 2 }\n{ \"type\": \"test\", \"name\": \"m::langinfo\", \"event\": \"failed\", \"stdout\": \"left: 1\" }\n{ \"type\": \"test\", \"name\": \"m::strftime\", \"event\": \"ok\" }\n{ \"type\": \"suite\", \"event\": \"failed\", \"passed\": 1, \"failed\": 1, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 1, \"exec_time\": 0.0 }\n' >\"\$bep\"; exit 3; fi; own_default" run K5-only-listed-test-fails 1 "$D m::langinfo failed and is not in" '' 'exit 9'
ONLY="$ONLYT" OWN_TESTS="m::langinfo m::strftime" run K6-only-without-canary 1 'RUST_TEST_ONLY is set and RUST_TEST_CANARY is not' '' 'exit 9'
# R2: the macOS job runs the cargo workspaces and the cargo doctests too, with
# the same rules; the #[ignore]d cargo tests are left to the Linux job.
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" CARGO_MODE=fail-lib run K7-only-cargo-test-fails 1 "sdk/rust/demo:lib:demo demo::broken failed and is not in" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-raw-skip run K8-only-cargo-doctest-skips 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) skipped itself and is not in" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=ignored IGNORED_RUN="sdk/rust/demo:test:wire a::slow" NOT_MSG='::error' run K9-only-cargo-ignored-left-to-linux 0 "Ignored cargo test, run alone with --ignored by the Linux job: sdk/rust/demo:test:wire a::slow" '' 'exit 9'
# K10: with RUST_TEST_ONLY, a flaky line of a test this run does not run
# says nothing (sami-checks run 45351216411: the macOS job read each
# Linux-only flaky line as a target with no result).
FLAKY="$B x::f" ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" NOT_MSG='listed flaky' run K10-only-flaky-line-of-a-test-not-run-here 0 "Ran here, as .github/sami/only.txt names: $D m::strftime" '' 'exit 9'
# K12-K17: the macOS job (RUST_TEST_ONLY) still runs the crates' doctests
# under cargo and reads their output (doc_attribute, one thread), as the
# Linux job did until its doctests ran only in Bazel: a doctest that skips
# itself, prints, prints with no newline, or prints an object that only
# names its type fails; the run builds with workspace feature unification.
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-skip run K12-only-crate-doctest-skips-itself 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) skipped itself and is not in" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-raw-print run K13-only-doctest-raw-output 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in .github/sami/rust-test-known-output.txt" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-raw-nonl NOT_MSG='ended before' run K14-only-doctest-output-without-newline-fails 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in .github/sami/rust-test-known-output.txt" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-typed run K15-only-doctest-prints-typed-test-object 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-typed-suite run K16-only-doctest-prints-typed-suite-object 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in" '' 'exit 9'
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" CARGO_MODE=doc-ignored NOT_MSG='stub:|::error' run K17-only-crate-doctests-unify-features-over-the-workspace 0 'crates/pi-diff src/lib.rs - g \(line 9\) \(cargo.s log\)' '' 'exit 9'
# X1-X3 (CiReview2 at 32e3af7a): a flaky test the RUST_TEST_ONLY run does run.
# X1 failed, then passed: KNOWN, and the stub refuses an only-* invocation
# without the retry flag. X2 failed on every attempt: NEW, exit 1. X3
# passed: a notice.
FJ='{ "type": "suite", "event": "started", "test_count": 2 }\n{ "type": "test", "name": "m::langinfo", "event": "failed", "stdout": "left: 1" }\n{ "type": "test", "name": "m::strftime", "event": "ok" }\n{ "type": "suite", "event": "failed", "passed": 1, "failed": 1, "ignored": 0, "measured": 0, "filtered_out": 1, "exec_time": 0.0 }\n'
XPRE="if [ \"\$OWN_TARGET\" = $D ]; then has \"--flaky_test_attempts=^$D\\\$@3\"; f=\"\$(tpath $D)\"; a=\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; mkdir -p \"\$(dirname \"\$a\")\"; printf '$FJ' >\"\$a\"; fakebin $D m::langinfo m::strftime p::canary;"
FLAKY="$D m::langinfo" ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" NOT_MSG='no result|Known failure, failed as expected' OWN_BODY="$XPRE FILTERED=1 FMT=json lt_out m::langinfo '' m::strftime '' >\"\$f\"; { cfg $D 'rust_test rule'; summary $D FLAKY \"\$a\" \"\$f\"; } >\"\$bep\"; exit 0; fi; own_default" run X1-only-flaky-ran-here-failed-then-passed 0 "Known flaky test, failed on 1 of 2 attempts and passed on another: $D m::langinfo" '' 'exit 9'
FLAKY="$D m::langinfo" ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" NOT_MSG='no result|Known failure, failed as expected|Known flaky test, failed on' OWN_BODY="$XPRE printf '$FJ' >\"\$f\"; { cfg $D 'rust_test rule'; summary $D FAILED \"\$a \$f\"; } >\"\$bep\"; exit 3; fi; own_default" run X2-only-flaky-ran-here-failed-every-attempt 1 "$D m::langinfo is listed flaky in .github/sami/rust-test-known-failures.txt, but failed on every attempt \\(2 of 2\\): NEW" '' 'exit 9'
FLAKY="$D m::langinfo" ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" NOT_MSG='no result|::error' run X3-only-flaky-ran-here-passed 0 "$D m::langinfo is listed flaky in .github/sami/rust-test-known-failures.txt and did not fail" '' 'exit 9'
# K11: with RUST_TEST_ONLY too, each cargo run (the cargo workspace's targets
# and the doctests) has its row in the step summary.
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" DOCQ="$DOC" NOT_MSG='::error|::warning' run K11-only-cargo-timing-rows 0 '^summary rows: 4$' '' 'exit 9'

# --- rust-test-macos-inventory.sh ------------------------------------------------
# irun <name> <want> <message regex> <targets> <mac binaries> <linux listings>
# <named>: the inventory against stubs of bazelisk query, build and info.
# <targets>: the rust_test labels the query names, one per line. <mac
# binaries> and <linux listings>: lines of `<label> <test>...` (a label with
# no test has a binary that lists none; a label absent has no binary, or no
# Linux listing). <named>: rust-test-macos.txt's lines `<label> <test>`.
# LINUX_INDEX=none leaves the Linux listings out. NAMED_LINE, a line written
# as it is after <named>'s. The output names the inventory file's lines, then
# what the script wrote to GITHUB_OUTPUT.
irun() {
	local name="$1" want="$2" msg="$3" targets="$4" mac="$5" linux="$6" named="$7" w out rc label tests t i=0
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/inventory.XXXXXX")"
	mkdir -p "$w/bin" "$w/repo/.github/sami" "$w/binroot" "$w/linux" "$w/tmp"
	printf '%s\n' "$targets" >"$w/targets.txt"
	{ echo '# named'; [ -n "$named" ] && printf '%s\n' "$named" | while read -r a b; do printf '%s %s  macOS libc\n' "$a" "$b"; done; [ -n "${NAMED_LINE:-}" ] && printf '%s\n' "$NAMED_LINE"; } >"$w/repo/.github/sami/rust-test-macos.txt"
	while read -r label tests; do
		[ -n "$label" ] || continue
		t="${label#//}"
		mkdir -p "$w/binroot/${t%%:*}"
		{ printf '#!/bin/sh\n[ "$1" = --list ] || exit 2\n'; for x in $tests; do printf "echo '%s: test'\n" "$x"; done; } >"$w/binroot/${t%%:*}/${t#*:}"
		chmod +x "$w/binroot/${t%%:*}/${t#*:}"
	done <<<"$mac"
	if [ "${LINUX_INDEX:-}" != none ]; then
		: >"$w/linux/index.tsv"
		while read -r label tests; do
			[ -n "$label" ] || continue
			i=$((i + 1))
			# shellcheck disable=SC2086 # one line per test name
			if [ -n "$tests" ]; then printf '%s\n' $tests | LC_ALL=C sort -u >"$w/linux/$i.txt"; else : >"$w/linux/$i.txt"; fi
			printf '%s\t%s.txt\n' "$label" "$i" >>"$w/linux/index.tsv"
		done <<<"$linux"
	fi
	cat >"$w/bin/bazelisk" <<EOF
#!/usr/bin/env bash
args=("\$@")
[ "\${args[0]#--bazelrc=}" != "\${args[0]}" ] && args=("\${args[@]:1}")
case "\${args[0]}" in
	query) cat "$w/targets.txt" ;;
	build) exit "\${BUILD_RC:-0}" ;;
	info) echo "$w/binroot" ;;
	*) echo "stub: bazelisk \${args[*]}" >&2; exit 2 ;;
esac
EOF
	chmod +x "$w/bin/bazelisk"
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null GITHUB_OUTPUT="$w/github-output" bash "$repo/.github/sami/rust-test-macos-inventory.sh" "$w/linux" "$w/inventory.txt" 2>&1; echo "--- inventory"; cat "$w/inventory.txt" 2>/dev/null; echo "--- outputs"; cat "$w/github-output" 2>/dev/null)"
	rc="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null bash "$repo/.github/sami/rust-test-macos-inventory.sh" "$w/linux" "$w/inventory2.txt" >/dev/null 2>&1; echo $?)"
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
T1=//crates/pi-shell:pi-shell_test
T2=//crates/pi-builtins:pi-builtins_test
irun I1-compiled-only-on-macos 0 "$T1 a::mac_only  compiled only on macOS" "$T1
$T2" "$T1 a::one a::mac_only a::named
$T2 b::one" "$T1 a::one a::named
$T2 b::one" "$T1 a::named"
irun I1b-named-test-joins 0 "$T1 a::named  named in rust-test-macos.txt" "$T1" "$T1 a::one a::named" "$T1 a::one a::named" "$T1 a::named"
irun I2-no-linux-listings 1 'UNKNOWN: .*index.tsv is missing or empty' "$T1" "$T1 a::one" "" "" </dev/null
LINUX_INDEX=none irun I2b-no-linux-listings-dir 1 'UNKNOWN: .*index.tsv is missing or empty' "$T1" "$T1 a::one" "$T1 a::one" ""
irun I3-named-test-in-no-mac-binary 1 "$T1 a::gone is in .github/sami/rust-test-macos.txt but in no macOS binary's listing" "$T1" "$T1 a::one" "$T1 a::one" "$T1 a::gone"
NAMED_LINE="$T1 a::named macOS libc" irun I9-named-line-without-its-why 1 "rust-test-macos.txt:2: no two spaces before its why: $T1 a::named macOS libc" "$T1" "$T1 a::one a::named" "$T1 a::one" ""
# A target with no Linux listing did not build on Linux: it is UNKNOWN, and
# none of its tests is taken as macOS-only (I4); every other target is still
# listed (I4b) and the list is marked complete, so the job runs it (I4c). A
# list without UNKNOWN is complete too (I4d).
NOT_MSG="$T2 b::" irun I4-target-linux-did-not-list-is-unknown 1 "UNKNOWN: $T2 has no Linux listing: the target did not build on Linux" "$T1
$T2" "$T1 a::one a::mac
$T2 b::mac b::linux" "$T1 a::one" ""
irun I4b-other-targets-listed-beside-an-unknown-one 1 "$T1 a::mac  compiled only on macOS" "$T1
$T2" "$T1 a::one a::mac
$T2 b::mac b::linux" "$T1 a::one" ""
irun I4c-complete-beside-an-unknown-target 1 "^complete=true$" "$T1
$T2" "$T1 a::one a::mac
$T2 b::mac b::linux" "$T1 a::one" ""
irun I4d-complete-without-unknown 0 "^complete=true$" "$T1" "$T1 a::one a::mac" "$T1 a::one" ""
irun I5-no-mac-binary 1 "$T1 has no macOS binary at .*, though bazel build passed" "$T1" "" "$T1 a::one" ""
# R1: a macOS build failure, or one queried target without a binary, fails.
BUILD_RC=1 irun I6-macos-build-fails 1 'bazel build of the test targets for macOS exited 1' "$T1" "$T1 a::one" "$T1 a::one" ""
irun I7-one-target-without-mac-binary 1 "$T2 has no macOS binary at .*, though bazel build passed" "$T1
$T2" "$T1 a::one" "$T1 a::one
$T2 b::one" ""
# R4: a Linux listing of no tests (a zero-byte file) is no gap.
irun I8-zero-test-linux-listing 0 "$T2 b::mac_only  compiled only on macOS" "$T1
$T2" "$T1 a::one
$T2 b::mac_only" "$T1 a::one
$T2" ""

# --- fetch-verified.sh -----------------------------------------------------------
# fetch <name> <want exit> <message regex> <url=answer>...: answer is ok (the
# pinned bytes), bad (other bytes) or fail (curl fails).
fetch() {
	local name="$1" want="$2" msg="$3" w out rc ok=1
	shift 3
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/fetch.XXXXXX")"
	printf 'pinned bytes\n' >"$w/pinned"
	: >"$w/answers"
	local urls=()
	for pair in "$@"; do urls+=("${pair%%=*}"); printf '%s\t%s\n' "${pair%%=*}" "${pair#*=}" >>"$w/answers"; done
	cat >"$w/curl" <<EOF
#!/usr/bin/env bash
dest="" url=""
while [ "\$#" -gt 0 ]; do case "\$1" in -o) dest="\$2"; shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac; done
answer="\$(awk -F'\t' -v u="\$url" '\$1 == u { print \$2 }' "$w/answers")"
case "\$answer" in ok) cp "$w/pinned" "\$dest" ;; bad) echo other >"\$dest" ;; *) exit 22 ;; esac
EOF
	chmod +x "$w/curl"
	local sha
	if command -v sha256sum >/dev/null; then sha="$(sha256sum "$w/pinned" | cut -d' ' -f1)"; else sha="$(shasum -a 256 "$w/pinned" | cut -d' ' -f1)"; fi
	[ "${BAD_SHA:-}" = 1 ] && sha=not-a-sha
	out="$(FETCH_VERIFIED_CURL="$w/curl" bash "$repo/.github/sami/fetch-verified.sh" "Tarball" "$w/out.tar.gz" "$sha" "${urls[@]}" 2>&1)"
	rc=$?
	if [ "$rc" = 0 ] && ! cmp -s "$w/pinned" "$w/out.tar.gz"; then out="$out
(the destination does not hold the pinned bytes)"; rc=99; fi
	if [ "$rc" != 0 ] && [ -e "$w/out.tar.gz" ]; then out="$out
(a failed fetch left a file at the destination)"; rc=98; fi
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
fetch F1-first-mirror 0 'out.tar.gz from https://a/t' https://a/t=ok https://b/t=ok
fetch F2-fallback-after-a-failed-download 0 'out.tar.gz from https://b/t' https://a/t=fail https://b/t=ok
fetch F3-checksum-mismatch-then-good 0 '::warning title=Tarball::https://a/t gave no file with sha256' https://a/t=bad https://b/t=ok
fetch F4-exhausted 1 '::error title=Tarball::no source gave out.tar.gz with sha256' https://a/t=bad https://b/t=fail
BAD_SHA=1 fetch F5-not-a-sha256 1 'is not a sha256' https://a/t=ok

# --- rust-test-tmpdir.sh ---------------------------------------------------------
if [ -z "$only" ] || [[ T1-each-action-its-own-tmpdir =~ $only ]]; then
	t="$(mktemp -d "$scratch/tmpdir.XXXXXX")"
	a="$(sh "$repo/.github/sami/rust-test-tmpdir.sh" "$t" sh -c 'echo "$TMPDIR"' 2>&1)"
	b="$(sh "$repo/.github/sami/rust-test-tmpdir.sh" "$t" sh -c 'echo "$TMPDIR"' 2>&1)"
	rc=0
	{ [ "$a" != "$b" ] && [ -d "$a" ] && [ -d "$b" ] && [ "$(dirname "$a")" = "$t" ] && [ "$(dirname "$b")" = "$t" ]; } || rc=1
	verdict T1-each-action-its-own-tmpdir 0 "$rc" '' "$a $b"
fi

# T2: a test binary that asks for libtest's JSON runs under libtest-bound.py
# (shown by its --list, which this one fails); T3: a doctest target does not.
for c in T2-a-libtest-binary-runs-under-the-bound T3-a-doctest-target-runs-as-it-is; do
	if [ -n "$only" ] && ! [[ $c =~ $only ]]; then continue; fi
	t="$(mktemp -d "$scratch/tmpdir.XXXXXX")"
	target=//crates/demo:demo_test
	[ "$c" = T3-a-doctest-target-runs-as-it-is ] && target=//crates/demo:demo_doc_test
	out="$(TEST_TARGET=$target sh "$repo/.github/sami/rust-test-tmpdir.sh" "$t" sh -c 'case "$1" in --list) exit 3 ;; esac; echo ran' _ -Zunstable-options --format=json 2>&1)"
	rc=$?
	if [ "$c" = T2-a-libtest-binary-runs-under-the-bound ]; then
		verdict "$c" 0 "$rc" 'libtest-bound: .* runs without a bound per test: its --list failed' "$out"
	else
		NOT_MSG='libtest-bound' verdict "$c" 0 "$rc" '^ran$' "$out"
	fi
done

# --- libtest-bound.py ------------------------------------------------------------
# Its own controls (tests/libtest-bound-selftest.py, against tests/fake-libtest.py),
# with the tree's .config/nextest.toml for its config reader.
if [ -z "$only" ] || [[ L1-libtest-bound-selftest =~ $only ]]; then
	out="$(python3 "$here/libtest-bound-selftest.py" --config "$repo/.config/nextest.toml" 2>&1)"
	rc=$?
	verdict L1-libtest-bound-selftest 0 "$rc" '^SELFTEST [0-9]+ of [0-9]+ cases as expected$' "$out"
	printf '%s\n' "$out" | grep -E '^FAIL ' | sed 's/^/    | /'
fi

# --- release-candidate.sh ------------------------------------------------------
# release-candidate-harness.sh checks publish's find and verify against a stub
# gh. Each case it declares (case_, fcase, or a check that prints PASS or FAIL
# itself) on a line that is not a comment is a case here, named RC-<its
# name>, and fails unless the harness reports it exactly once, as PASS, and
# reaches its summary line. RC-harness-summary fails unless that line counts
# at least one passed and 0 failed, so a case this list misses cannot fail
# unseen. verify needs GNU find (-printf) and sha256sum; a runner that lacks
# either (macOS's find has no -printf) skips the cases, counts them, and
# names what it lacks.
rc_harness="$here/release-candidate-harness.sh"
rc_names="$(grep -vE '^[[:space:]]*#' "$rc_harness" | grep -oE '(case_|fcase) [A-Za-z0-9-]+|echo "PASS [A-Za-z0-9-]+"' | sed -E 's/^(case_|fcase) //; s/^echo "PASS //; s/"$//' | sort -u)
harness-summary"
rc_want=()
for n in $rc_names; do
	if [ -z "$only" ] || [[ "RC-$n" =~ $only ]]; then rc_want+=("$n"); fi
done
if [ "${#rc_want[@]}" -gt 0 ]; then
	rc_lacks=""
	find "$scratch" -maxdepth 0 -printf '' >/dev/null 2>&1 || rc_lacks="GNU find (-printf)"
	command -v sha256sum >/dev/null || rc_lacks="${rc_lacks:+$rc_lacks and }sha256sum"
	if [ -n "$rc_lacks" ]; then
		skip=$((skip + ${#rc_want[@]}))
		echo "SKIP RC-* (${#rc_want[@]} cases): release-candidate.sh needs $rc_lacks, which this runner lacks; publish runs it on ubuntu-22.04"
	else
		t="$(mktemp -d "$scratch/release-candidate.XXXXXX")"
		out="$(cd "$t" && TMPDIR="$t" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bash "$rc_harness" "$repo/.github/sami/release-candidate.sh" 2>&1)"
		printf '%s\n' "$out" | grep -E '^INFO ' || true
		ended=0
		printf '%s\n' "$out" | grep -qE '^release-candidate\.sh harness: [0-9]+ passed, [0-9]+ failed$' && ended=1
		for n in "${rc_want[@]}"; do
			got="$(printf '%s\n' "$out" | awk -v n="$n" '$1 == "PASS" || $1 == "FAIL" { on = ($2 == n); if (on) print; next } /^    \| / { if (on) print; next } { on = 0 }')"
			rc=1
			if [ "$ended" = 0 ]; then
				got="UNKNOWN: the harness did not reach its summary line
$got"
			elif [ "$n" = harness-summary ]; then
				got="$(printf '%s\n' "$out" | grep -E '^release-candidate\.sh harness: ')"
				if printf '%s\n' "$got" | grep -qE ': [1-9][0-9]* passed, 0 failed$'; then rc=0; fi
			elif [ "$(printf '%s\n' "$got" | grep -cE '^(PASS|FAIL) ')" != 1 ]; then
				got="UNKNOWN: the harness reported $n $(printf '%s\n' "$got" | grep -cE '^(PASS|FAIL) ') times, not once
$got"
			elif printf '%s\n' "$got" | grep -qE '^PASS '; then
				rc=0
			fi
			verdict "RC-$n" 0 "$rc" '' ''
			[ "$rc" = 0 ] || printf '%s\n' "$got" | sed 's/^/    | /'
		done
	fi
fi

# --- the jobs' caches -------------------------------------------------------------
# cache_lint <workflow> <bun-install action> <bazel-cache action> <jobs>:
# only release_binary may use the GitHub Actions cache. <jobs> names the
# jobs the workflow must have: sami-build.yml's release_binary, attest and
# release_cache_prune, or sami-rust-test.yml's rust_test and rust_test_macos.
# Those two run test code on runners whose user has passwordless sudo, on
# the release's ref (sami-checks.yml calls them on the push of
# release-candidate); such code could save an entry for that ref (one no run
# has written yet, or one a ref's own lookup takes before main's) that
# release_binary would restore.
# The workflow sets cache-mode: none, so a job's cache token can neither
# restore nor save unless the job sets a mode of its own. So: the workflow
# has cache-mode: none; every job but release_binary has no line that names
# cache-mode other than `    cache-mode: none` (GitHub also reads the value
# on the next line, a quoted key, and a job whose keys are indented deeper),
# has no actions/cache step, and passes `cache: "false"` to every
# bun-install step, which then sets cache=none and runs neither of its cache
# steps. release_binary passes `cache: "false"` to its bun-install step too,
# since bun-install's own save runs on main. release_binary may restore, and
# saves only on a push to release-candidate, the ref the release is built on:
# cache-mode takes no expression, so each of its actions/cache/save steps
# starts its `if:` with that condition, has no `||` and nothing after the
# expression's `}}`, on its line or on a deeper line that YAML folds into the
# value (GitHub reads an `if:` with text outside `${{ }}` as a string, and a
# string that is not empty is true): the line after it starts at the step's
# key indent (its next key, or a comment there), or there is none: a blank
# line, or a line indented less or more, after the guard fails the lint. And
# it has no actions/cache step (which saves in its post step, under no
# condition of the job's). Its steps use only the actions it uses today, and
# .github/actions/bazel-cache calls no action, so no other caching action can
# save under release_binary's token. release_cache_prune holds
# actions: write (it deletes cache entries; the token can also delete runs
# and artifacts, re-run and dispatch workflows), so it must not run member
# code. It has no checkout, so member code would have to be fetched or
# named. None of its lines (comments aside) names an action (`uses:`), an
# interpreter or downloader from a fixed list (bash, sh, bun, node, python,
# curl, wget, pwsh and the like), git, a `./`, `../` or `.github/` path or
# GITHUB_WORKSPACE, and each line that calls gh names actions/caches (or
# `gh cache`) before any ` #`. Other tools that fetch code (cargo, go,
# docker) are not on the list. No other job, and not the workflow, has a
# line with write-all or with an actions key that does not read read or
# none on that line (GitHub also reads a value on the next line); and the
# workflow has a permissions key, so no job takes the repository's default
# token permissions. attest holds id-token: write, with which it signs the
# release's attestations, so it must not run member code either: its only
# actions are actions/download-artifact and actions/attest-build-provenance,
# each pinned by a 40-hex commit; it has no run step (in block or flow
# style); it names no run-id, repository or github-token, so it downloads
# this run's artifacts only; and each download step gives artifact-ids, so it
# takes the artifacts its upload steps made, not whatever a job of this run
# uploaded under their names later. Its if: is exactly the push to
# release-candidate test; its one block-style artifact-ids line names exactly
# carry's notes-artifact-id and release_binary's two mise-*-artifact-id
# outputs, which are those jobs' upload steps' artifact ids; and each of the
# five release files (two archives, two sidecars, the notes) has an
# attest-build-provenance step of its own whose one subject-path names it,
# with no step if: and no continue-on-error, so a missing file fails the
# job; and it has no line that is not a key, which YAML would fold into the
# value above it, past these line checks; and its artifact-ids line has no
# quote and no #, since inside quotes " #" is part of the value. No other
# job, and not the workflow, has a line with write-all or with an id-token
# key that does not read read or none on that line. A line under jobs: that
# is not a plain `  <id>:` stops the lint, because its steps would be read as
# the job above's.
cache_lint() {
	local wf="$1" action="$2" bazel_action="$3" need="$4" rc=0 job jobs bad steps bun n ok modes saves ns others acts scripts fetches aw perms idt runs foreign byname want_if ifs coe idl subj d dj dl ds cont
	local push_guard='\\n        if: \$\{\{ github\.event_name == '"'"'push'"'"' && github\.ref == '"'"'refs/heads/release-candidate'"'"' && [^|\\$}]*\}\}\\n(        [^ \\].*)?$'
	# These four read each line with a space added at its end (and the first
	# two at its start too), so no pattern needs an anchor inside a group.
	local member_code='[^[:alnum:]_.-](bash|sh|zsh|dash|bun|bunx|node|npx|npm|python|python3|perl|ruby|deno|curl|wget|pwsh|powershell|source|git)[^[:alnum:]_.-]|[^[:alnum:]_.]\.\.?/|\.github/|GITHUB_WORKSPACE'
	local gh_call='[^[:alnum:]_.-]gh[^[:alnum:]_.-]'
	local actions_key=$'[^[:alnum:]_/-]["\']?actions["\']?[[:space:]]*:'
	local actions_safe=$'actions["\']?[[:space:]]*:[[:space:]]*["\']?(read|none)["\']?[[:space:]]*[,}#[:space:]]'
	local idtoken_key=$'[^[:alnum:]_/-]["\']?id-token["\']?[[:space:]]*:'
	local idtoken_safe=$'id-token["\']?[[:space:]]*:[[:space:]]*["\']?(read|none)["\']?[[:space:]]*[,}#[:space:]]'
	if ! grep -qxE 'cache-mode: *none' "$wf"; then
		echo "$wf has no workflow-level cache-mode: none"
		rc=1
	fi
	jobs="$(awk '/^jobs:$/ { on = 1; next } on && /^[^ #]/ { exit } on && /^  [A-Za-z_][A-Za-z0-9_-]*:$/ { sub(/^  /, ""); sub(/:$/, ""); print }' "$wf")"
	bad="$(awk '/^jobs:$/ { on = 1; next } on && /^[^ #]/ { exit } on && /^  [^ #]/ && !/^  [A-Za-z_][A-Za-z0-9_-]*:$/' "$wf")"
	if [ -n "$bad" ]; then
		echo "UNKNOWN: $wf has a job line cache_lint cannot read: $bad"
		return 1
	fi
	for job in $need; do
		printf '%s\n' "$jobs" | grep -qxF "$job" || { echo "UNKNOWN: $wf has no $job job"; return 1; }
	done
	for job in $jobs; do
		ok=1
		awk -v j="  $job:" '$0 == j { on = 1; next } on && (/^  [A-Za-z_][A-Za-z0-9_-]*:$/ || /^[^ #]/) { exit } on' "$wf" >"$scratch/job.yml"
		steps="$(awk '/^      - / { if (s != "") print s; s = "" } { s = s $0 "\\n" } END { if (s != "") print s }' "$scratch/job.yml")"
		bun="$(printf '%s\n' "$steps" | grep -E 'uses: *\./(tool/)?\.github/actions/bun-install' || true)"
		n="$(printf '%s' "$bun" | grep -c . || true)"
		if [ "$job" = release_binary ] && [ "$n" = 0 ]; then
			echo "UNKNOWN: release_binary has no bun-install step"
			return 1
		fi
		if printf '%s\n' "$bun" | grep -vF 'cache: "false"' | grep -q .; then
			echo "$job has a bun-install step without cache: \"false\""
			ok=0
		fi
		if [ "$job" = release_binary ]; then
			if printf '%s\n' "$steps" | grep -qE 'uses: *actions/cache@'; then
				echo "release_binary has an actions/cache step that saves in its post step"
				ok=0
			fi
			others="$(printf '%s\n' "$steps" | grep -oE 'uses: *[^ \\]+' | sed 's/^uses: *//' | grep -vE '^(actions/checkout@|actions/upload-artifact@|actions/cache/restore@|actions/cache/save@|\./\.github/actions/(bun-install|bazel-cache)$)' || true)"
			if [ -n "$others" ]; then
				echo "release_binary uses an action outside its list: $(printf '%s' "$others" | tr '\n' ' ')"
				ok=0
			fi
			saves="$(printf '%s\n' "$steps" | grep -E 'uses: *actions/cache/save@' || true)"
			ns="$(printf '%s' "$saves" | grep -c . || true)"
			if printf '%s\n' "$saves" | grep -vE -- "$push_guard" | grep -q .; then
				echo "release_binary saves a cache on an event other than a push to release-candidate"
				ok=0
			fi
			if [ "$ok" = 1 ]; then
				echo "release_binary: save steps: $ns, each only on a push to release-candidate; bun-install steps: $n, each with cache: \"false\""
			fi
		else
			modes="$(grep -vE '^ *#' "$scratch/job.yml" | grep -F 'cache-mode' | grep -vxF '    cache-mode: none' || true)"
			if [ -n "$modes" ]; then
				echo "$job has a cache-mode line other than [    cache-mode: none]: $(printf '%s\n' "$modes" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
				ok=0
			fi
			if printf '%s\n' "$steps" | grep -qE 'uses: *actions/cache'; then
				echo "$job has an actions/cache step"
				ok=0
			fi
			if [ "$job" = release_cache_prune ]; then
				acts="$(grep -vE '^ *#' "$scratch/job.yml" | grep -E 'uses.?[[:space:]]*:' || true)"
				if [ -n "$acts" ]; then
					echo "release_cache_prune uses an action, so it could run member code: $(printf '%s\n' "$acts" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				scripts="$(grep -vE '^ *#' "$scratch/job.yml" | sed 's/.*/ & /' | grep -E -- "$member_code" | sed 's/^ //; s/ $//' || true)"
				if [ -n "$scripts" ]; then
					echo "release_cache_prune names an interpreter, a downloader, git, a repository path or GITHUB_WORKSPACE, so it could run member code: $(printf '%s\n' "$scripts" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				fetches="$(grep -vE '^ *#' "$scratch/job.yml" | awk -v g="$gh_call" '{ l = " " $0 " "; if (l !~ g) next; t = l; sub(/[[:space:]]#.*/, " ", t); if (t ~ /actions\/caches/ || t ~ /[^[:alnum:]_.-]gh[[:space:]]+cache[[:space:]]/) next; print }' || true)"
				if [ -n "$fetches" ]; then
					echo "release_cache_prune calls gh for something other than actions/caches, so it could fetch member code: $(printf '%s\n' "$fetches" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
			fi
			if [ "$job" = attest ]; then
				acts="$(grep -vE '^ *#' "$scratch/job.yml" | grep -E 'uses.?[[:space:]]*:' | grep -vE '^ *(- )?uses: *(actions/download-artifact|actions/attest-build-provenance)@[0-9a-f]{40}( +#.*)?$' || true)"
				if [ -n "$acts" ]; then
					echo "attest uses an action other than actions/download-artifact and actions/attest-build-provenance pinned by commit, so it could run member code: $(printf '%s\n' "$acts" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				runs="$(grep -vE '^ *#' "$scratch/job.yml" | grep -E $'(^|[^[:alnum:]_-])["\']?(run|shell)["\']?[[:space:]]*:' || true)"
				if [ -n "$runs" ]; then
					echo "attest has a run step, so it could run member code: $(printf '%s\n' "$runs" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				foreign="$(grep -vE '^ *#' "$scratch/job.yml" | grep -E $'(^|[^[:alnum:]_-])["\']?(run-id|repository|github-token)["\']?[[:space:]]*:' || true)"
				if [ -n "$foreign" ]; then
					echo "attest names another run, repository or token, so it could attest files this run did not build: $(printf '%s\n' "$foreign" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				# Each download step, comments aside, as one line. artifact-ids
				# must name a needs output: an empty value downloads by pattern.
				byname="$(grep -vE '^ *#' "$scratch/job.yml" | sed -E 's/[[:space:]]+#.*$//' | awk '/^      - / { if (s != "") print s; s = "" } { s = s $0 " " } END { if (s != "") print s }' | grep -F 'actions/download-artifact@' | grep -vE $'(^|[^[:alnum:]_-])["\']?artifact-ids["\']?[[:space:]]*:[[:space:]]*["\']?\\$\\{\\{[[:space:]]*needs\\.' || true)"
				if [ -n "$byname" ]; then
					echo "attest downloads an artifact by name or pattern, not by the id its upload gave, so a job of this run could have replaced it: $(printf '%s\n' "$byname" | sed -E 's/ {2,}/ /g' | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				# A deeper line that is not a key continues the scalar above it,
				# and YAML folds it into that key's value (GitHub reads an if: so
				# folded as a string, which is true): the checks below read only
				# the key's own line.
				cont="$(grep -vE '^ *#' "$scratch/job.yml" | grep -vE '^[[:space:]]*$' | grep -vE $'^ *(- )?["\']?[A-Za-z_][A-Za-z0-9_-]*["\']?[[:space:]]*:([[:space:]]|$)' || true)"
				if [ -n "$cont" ]; then
					echo "attest has a line that is not a key, which YAML folds into the value of the key above it: $(printf '%s\n' "$cont" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				# The job's if: is exactly the push-to-release-candidate test, and
				# no step has an if: of its own or continue-on-error: either
				# could leave a file unattested in a green run.
				want_if="    if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/release-candidate' }}"
				ifs="$(grep -E $'^    ["\']?if["\']?[[:space:]]*:' "$scratch/job.yml" || true)"
				if [ "$ifs" != "$want_if" ]; then
					echo "attest's if: is not exactly [$want_if], so it could attest on another event or ref: $(printf '%s\n' "${ifs:-none}" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				ifs="$(grep -vE '^ *#' "$scratch/job.yml" | sed -E 's/[[:space:]]+#.*$//' | grep -vE $'^    ["\']?if["\']?[[:space:]]*:' | grep -E $'(^|[^[:alnum:]_-])["\']?if["\']?[[:space:]]*:' || true)"
				if [ -n "$ifs" ]; then
					echo "attest has an if: other than its job's, which could skip an attest step: $(printf '%s\n' "$ifs" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				coe="$(grep -vE '^ *#' "$scratch/job.yml" | sed -E 's/[[:space:]]+#.*$//' | grep -E $'(^|[^[:alnum:]_-])["\']?continue-on-error["\']?[[:space:]]*:' || true)"
				if [ -n "$coe" ]; then
					echo "attest has continue-on-error, so a failed attest step would not fail the job: $(printf '%s\n' "$coe" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
					ok=0
				fi
				# The download's artifact-ids name the three ids the upload steps
				# gave, each once and by its needs output, in one block-style line
				# with no quote and no #: inside quotes, " #" is part of the value
				# (download-artifact reads "<id> #" as <id>), not a comment.
				idl="$(grep -vE '^ *#' "$scratch/job.yml" | grep -E $'^ +["\']?artifact-ids["\']?[[:space:]]*:' || true)"
				if [ "$(printf '%s' "$idl" | grep -c .)" != 1 ]; then
					echo "attest has $(printf '%s' "$idl" | grep -c .) block-style artifact-ids lines, not 1, so this lint cannot read which ids it downloads"
					ok=0
				elif printf '%s\n' "$idl" | grep -qE $'["\'#]'; then
					echo "attest's artifact-ids line has a quote or a #, and inside quotes \" #\" is part of the value, so this lint cannot read which ids it downloads: [$idl]"
					ok=0
				else
					bad="$(printf '%s\n' "$idl" | sed -E 's/^ +artifact-ids[[:space:]]*:[[:space:]]*//' | tr ',' '\n' | awk '
						BEGIN { want["needs.carry.outputs.notes-artifact-id"]; want["needs.release_binary.outputs.mise-linux-x64-artifact-id"]; want["needs.release_binary.outputs.mise-darwin-arm64-artifact-id"] }
						{ sub(/^[ \t]+/, ""); sub(/[ \t]+$/, "") }
						/^\$\{\{[ \t]*needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+[ \t]*\}\}$/ { n = $0; sub(/^\$\{\{[ \t]*/, "", n); sub(/[ \t]*\}\}$/, "", n); if (n in want) seen[n]++; else print "OTHER\t" $0; next }
						{ print "LITERAL\t" $0 }
						END { for (w in want) if (seen[w] != 1) print "MISSING\t" w }')"
					printf '%s\n' "$bad" | awk -F'\t' '
						$1 == "OTHER" { printf "attest downloads by a needs output that is not an upload step'"'"'s artifact id: [%s]\n", $2 }
						$1 == "LITERAL" { printf "attest downloads an artifact id that is not a needs output (a literal or another expression), so it need not be what this run uploaded: [%s]\n", $2 }
						$1 == "MISSING" { printf "attest'"'"'s artifact-ids do not name [${{ %s }}] exactly once\n", $2 }'
					[ -z "$bad" ] || ok=0
				fi
				# Those outputs are the artifact ids of the upload steps.
				for d in "carry	      notes-artifact-id: \${{ steps.upload-notes.outputs.artifact-id }}	upload-notes" \
					"release_binary	      mise-linux-x64-artifact-id: \${{ matrix.target == 'linux-x64' && steps.upload-mise.outputs.artifact-id || '' }}	upload-mise" \
					"release_binary	      mise-darwin-arm64-artifact-id: \${{ matrix.target == 'darwin-arm64' && steps.upload-mise.outputs.artifact-id || '' }}	upload-mise"; do
					IFS=$'\t' read -r dj dl ds <<<"$d"
					awk -v j="  $dj:" '$0 == j { on = 1; next } on && (/^  [A-Za-z_][A-Za-z0-9_-]*:$/ || /^[^ #]/) { exit } on' "$wf" >"$scratch/out.yml"
					if ! grep -qxF "$dl" "$scratch/out.yml" || ! awk -v id="        id: $ds" 'function f() { if (hit && !done) { printf "%s", s; done = 1 } s = ""; hit = 0 } /^      - / { f() } { s = s $0 "\n"; if ($0 == id) hit = 1 } END { f() }' "$scratch/out.yml" | grep -qE '^        uses: actions/upload-artifact@[0-9a-f]{40}( +#.*)?$'; then
						echo "$dj does not give attest its upload step's artifact id: it lacks [$dl] or a step [id: $ds] that uses actions/upload-artifact pinned by commit"
						ok=0
					fi
				done
				# One attest-build-provenance step per release file, each with
				# one subject-path on its line: a path that matches no file
				# fails its step, so a missing file fails the job.
				subj="$(grep -vE '^ *#' "$scratch/job.yml" | sed -E 's/[[:space:]]+#.*$//' | awk '
					function flush() {
						if (s ~ /actions\/attest-build-provenance@/) {
							n = 0; p = ""
							for (i = 1; i <= k; i++) if (l[i] ~ /subject-(path|digest|checksums|name)/) { n++; p = l[i] }
							if (n == 1 && p ~ /^          subject-path: [^|> \t]/) { sub(/^          subject-path: /, "", p); sub(/[ \t]+$/, "", p); print "PATH\t" p }
							else print "MULTI\t" l[1]
						}
						s = ""; k = 0
					}
					/^      - / { flush() }
					{ s = s $0 "\n"; l[++k] = $0 }
					END { flush() }')"
				bad="$(printf '%s\n' "$subj" | awk -F'\t' '
					BEGIN { t = "${{ runner.temp }}/attest/"; want[t "mise-linux-x64/*.tar.gz"]; want[t "mise-linux-x64/*.tar.gz.sha256"]; want[t "mise-darwin-arm64/*.tar.gz"]; want[t "mise-darwin-arm64/*.tar.gz.sha256"]; want[t "release-notes/carry-notes.md"] }
					$1 == "MULTI" { print "MULTI\t" $2; next }
					$1 == "PATH" { if ($2 in want) seen[$2]++; else print "EXTRA\t" $2 }
					END { for (w in want) if (seen[w] != 1) print "MISSING\t" w "\t" (seen[w] + 0) }')"
				printf '%s\n' "$bad" | awk -F'\t' '
					$1 == "MULTI" { sub(/^ +/, "", $2); printf "attest has an attest-build-provenance step that does not give one subject-path on its line, so a missing file might not fail it: [%s]\n", $2 }
					$1 == "EXTRA" { printf "attest attests [%s], which is not one of the release'"'"'s five files\n", $2 }
					$1 == "MISSING" { printf "attest has %d attest steps of its own for [%s], not 1, so that file could be missing and the run still green\n", $3, $2 }'
				[ -z "$bad" ] || ok=0
			fi
			if [ "$ok" = 1 ]; then
				echo "$job: cache-mode none; no actions/cache step; bun-install steps: $n, each with cache: \"false\""
			fi
			if [ "$ok" = 1 ] && [ "$job" = release_cache_prune ]; then
				echo "release_cache_prune: no action; no listed interpreter or downloader, git, ./, ../ or .github/ path or GITHUB_WORKSPACE; each gh call names actions/caches or gh cache outside a comment"
			fi
			if [ "$ok" = 1 ] && [ "$job" = attest ]; then
				echo "attest: only actions/download-artifact and actions/attest-build-provenance, pinned by commit; no run step; no other run, repository or token; downloads by artifact id; if: a push to release-candidate; artifact-ids: the upload steps' three ids; one attest step per release file"
			fi
		fi
		[ "$ok" = 1 ] || rc=1
	done
	if ! grep -qE '^permissions:' "$wf"; then
		echo "$wf has no workflow-level permissions, so a job without its own takes the repository's default, which can grant actions: write"
		rc=1
	fi
	# Each line outside a comment, after the name of its job (or "the
	# workflow"), with a space added at its end.
	perms="$(awk '/^jobs:$/ { on = 1; next } on && /^[^ #]/ { on = 0; job = "" } on && /^  [A-Za-z_][A-Za-z0-9_-]*:$/ { job = substr($0, 3, length($0) - 3); next } !/^ *#/ { print (job == "" ? "the workflow" : job) "\t" $0 " " }' "$wf")"
	aw="$(printf '%s\n' "$perms" | awk -F'\t' -v k="$actions_key" -v s="$actions_safe" '$1 != "release_cache_prune" { t = $0; gsub(s, " ", t); if (t ~ k || t ~ /write-all/) print }' || true)"
	if [ -n "$aw" ]; then
		printf '%s\n' "$aw" | awk -F'\t' '{ sub(/ $/, "", $2); printf "%s names an actions permission other than read or none, which only release_cache_prune may hold: [%s]\n", $1, $2 }'
		rc=1
	fi
	idt="$(printf '%s\n' "$perms" | awk -F'\t' -v k="$idtoken_key" -v s="$idtoken_safe" '$1 != "attest" { t = $0; gsub(s, " ", t); if (t ~ k || t ~ /write-all/) print }' || true)"
	if [ -n "$idt" ]; then
		printf '%s\n' "$idt" | awk -F'\t' '{ sub(/ $/, "", $2); printf "%s names an id-token permission other than read or none, which only attest may hold: [%s]\n", $1, $2 }'
		rc=1
	fi
	if grep -qE '^ *(- )?uses:' "$bazel_action"; then
		echo "$bazel_action calls an action"
		rc=1
	fi
	if ! grep -qF 'CACHE_INPUT: ${{ inputs.cache }}' "$action" || ! awk '/elif \[ "\$CACHE_INPUT" = false \]; then/ { getline; if ($0 ~ /echo "cache=none"/) found = 1 } END { exit !found }' "$action"; then
		echo "$action does not set cache=none for cache: \"false\""
		rc=1
	fi
	if awk '/^      - / { if (s ~ /uses: actions\/cache/ && s !~ /steps\.env\.outputs\.cache == .gha./) bad = 1; s = "" } { s = s $0 "\n" } END { if (s ~ /uses: actions\/cache/ && s !~ /steps\.env\.outputs\.cache == .gha./) bad = 1; exit !bad }' "$action"; then
		echo "$action has a cache step that does not need cache=gha"
		rc=1
	fi
	return "$rc"
}
# wlint <name> <want> <message regex> <sed for the workflow> <sed for the
# bun-install action> [<sed for the bazel-cache action>]: cache_lint on the
# repository's files, each edited by its sed script (an empty one leaves it
# as it is). The workflow is sami-build.yml, or the one WF names
# (sami-rust-test.yml).
wlint() {
	local name="$1" want="$2" msg="$3" wf="${WF:-sami-build.yml}" need w out rc
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	case "$wf" in
	sami-build.yml) need="release_binary attest release_cache_prune" ;;
	sami-rust-test.yml) need="rust_test rust_test_macos" ;;
	*)
		verdict "$name" "$want" 97 "$msg" "wlint knows no workflow $wf"
		return 0
		;;
	esac
	w="$(mktemp -d "$scratch/wlint.XXXXXX")"
	sed -e "${4:-p;d}" "$repo/.github/workflows/$wf" >"$w/$wf"
	sed -e "${5:-p;d}" "$repo/.github/actions/bun-install/action.yml" >"$w/action.yml"
	sed -e "${6:-p;d}" "$repo/.github/actions/bazel-cache/action.yml" >"$w/bazel-cache.yml"
	out="$(cache_lint "$w/$wf" "$w/action.yml" "$w/bazel-cache.yml" "$need" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
wlint W1-release-binary-cache-rule 0 'release_binary: save steps: 1, each only on a push to release-candidate; bun-install steps: 1, each with cache: "false"' '' ''
wlint W2-release-binary-bun-install-with-cache 1 'release_binary has a bun-install step without cache: "false"' '/^          cache: "false"$/d' ''
wlint W3-carry-cache-step 1 'carry has an actions/cache step' 's|^        run: git fetch --no-tags https://github.com/can1357/oh-my-pi.git main:refs/remotes/upstream/main$|&\n      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0|' ''
wlint W4-action-ignores-the-input 1 'does not set cache=none' '' '/echo "cache=none"/d'
wlint W5-action-cache-step-ungated 1 'has a cache step that does not need cache=gha' '' 's/if: steps.env.outputs.cache == .gha. && github.ref/if: github.ref/'
# The gate's own jobs, in sami-rust-test.yml: their tools (the reference
# rsync, zsh and bash, the macOS step bash) and bun's packages come from the
# build, not a cache, and their tokens can neither restore nor save one: the
# workflow has cache-mode none (W68) and no job sets another (W12, W23 to
# W25). rust_test runs `bun install` itself, with no store, since
# bun-install reads package.json at the workspace root, where that job keeps
# no tree; a bun-install step without cache: "false" fails the lint in any
# job (W9 in sami-build.yml's carry, W69 spelled as these jobs spell their
# actions, under tool/).
WF=sami-rust-test.yml wlint W6-gate-jobs-no-cache-access 0 'rust_test_macos: cache-mode none; no actions/cache step; bun-install steps: 0, each with cache: "false"' '' ''
WF=sami-rust-test.yml wlint W7-rust-test-cache-step 1 'rust_test has an actions/cache step' 's|^      - name: Libraries of the reference rsync$|      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0|' ''
WF=sami-rust-test.yml wlint W8-rust-test-macos-cache-step 1 'rust_test_macos has an actions/cache step' 's|^      - name: The tests only macOS can run$|      - uses: actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0|' ''
wlint W9-carry-bun-install-with-cache 1 'carry has a bun-install step without cache: "false"' 's|^      - name: Fetch upstream trunk$|      - uses: ./.github/actions/bun-install\n&|' ''
WF=sami-rust-test.yml wlint W68-rust-test-workflow-cache-mode-not-none 1 'sami-rust-test.yml has no workflow-level cache-mode: none' 's/^cache-mode: none$/cache-mode: write/' ''
WF=sami-rust-test.yml wlint W69-rust-test-tool-bun-install-with-cache 1 'rust_test has a bun-install step without cache: "false"' 's|^      - name: bun install$|      - uses: ./tool/.github/actions/bun-install\n&|' ''
# Any cache access outside release_binary: the workflow's default, a job's own
# mode, a cache step in a job none of the cases above names.
wlint W10-workflow-cache-mode-not-none 1 'has no workflow-level cache-mode: none' 's/^cache-mode: none$/cache-mode: read/' ''
wlint W11-carry-cache-mode-read 1 'carry has a cache-mode line other than \[    cache-mode: none\]: \[    cache-mode: read\]' 's/^  carry:$/&\n    cache-mode: read/' ''
WF=sami-rust-test.yml wlint W12-rust-test-cache-mode-write 1 'rust_test has a cache-mode line other than \[    cache-mode: none\]: \[    cache-mode: write\]' 's/^  rust_test:$/&\n    cache-mode: write/' ''
wlint W13-publish-cache-step 1 'publish has an actions/cache step' 's|^      - name: Find the candidate run$|      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4.3.0\n&|' ''
# release_binary saves only on a push to release-candidate; a dispatch, a pull
# request, a push to another ref or any other event only restores.
wlint W14-release-binary-save-unguarded 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/github.event_name == 'push' && github.ref == 'refs\/heads\/release-candidate' && //" ''
wlint W15-release-binary-save-on-dispatch 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/github.event_name == 'push'/github.event_name == 'workflow_dispatch'/" ''
wlint W16-release-binary-save-on-pull-request 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/github.event_name == 'push'/github.event_name == 'pull_request'/" ''
wlint W17-release-binary-save-or 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s#github.ref == 'refs/heads/release-candidate' &&#github.ref == 'refs/heads/release-candidate' ||#" ''
wlint W18-release-binary-post-save-step 1 'release_binary has an actions/cache step that saves in its post step' 's|uses: actions/cache/restore@|uses: actions/cache@|' ''
wlint W19-release-binary-save-or-after-guard 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}/steps.release-cache-bound.outputs.save == 'true' || github.event_name == 'workflow_dispatch' }}/" ''
# No other caching action can save under release_binary's token, and a job
# line the lint cannot read stops it.
wlint W20-release-binary-other-cache-action 1 'release_binary uses an action outside its list: Swatinem/rust-cache@v2' 's|^      - name: Point Bazel at the release build cache$|      - uses: Swatinem/rust-cache@v2\n&|' ''
wlint W21-bazel-cache-action-calls-an-action 1 'bazel-cache.yml calls an action' '' '' 's|^   steps:$|&\n      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830|'
wlint W22-job-line-with-a-comment 1 'job line cache_lint cannot read' 's/^  carry:$/  carry: # the carry check/' ''
# GitHub reads these spellings of a job's mode too: the value on the next
# line, a quoted key, and a job whose keys are indented 6 spaces.
WF=sami-rust-test.yml wlint W23-rust-test-cache-mode-on-the-next-line 1 'rust_test has a cache-mode line other than \[    cache-mode: none\]: \[    cache-mode:\]' 's/^  rust_test:$/&\n    cache-mode:\n      write/' ''
WF=sami-rust-test.yml wlint W24-rust-test-cache-mode-quoted-key 1 'rust_test has a cache-mode line other than \[    cache-mode: none\]: \[    "cache-mode": write\]' 's/^  rust_test:$/&\n    "cache-mode": write/' ''
WF=sami-rust-test.yml wlint W25-rust-test-keys-indented-six 1 'rust_test has a cache-mode line other than \[    cache-mode: none\]: \[      cache-mode: write\]' '/^  rust_test:$/,/^  rust_test_macos:$/s/^    /      /;s/^  rust_test:$/&\n      cache-mode: write/' ''
# GitHub reads an if: with text outside ${{ }} as a string, which is true,
# so nothing may follow the save guard's expression, on its line (W26) or
# on a deeper line that YAML folds into the value (W27).
wlint W26-release-binary-save-text-after-the-expression 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}\$/& \\&\\& \${{ !cancelled() }}/" ''
wlint W27-release-binary-save-text-on-a-folded-line 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}\$/&\\n          \\&\\& \${{ !cancelled() }}/" ''
# release_cache_prune holds actions: write, so it runs no member code: no
# action (W28), no interpreter, git or repository path (W29), and no gh
# call but on actions/caches (W35, and W37 with actions/caches only in a
# comment). No other job (W33 by write-all; in sami-rust-test.yml, W30,
# W34 with the value on the next line, W36 with read only in a comment)
# and not the workflow (W32) names an actions permission other than read or
# none, and the workflow has a permissions key (W31).
wlint W28-release-cache-prune-checkout 1 'release_cache_prune uses an action, so it could run member code: \[      - uses: actions/checkout@' 's|^      - name: Delete superseded release build caches of this ref$|      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n&|' ''
wlint W29-release-cache-prune-repository-script 1 'release_cache_prune names an interpreter, a downloader, git, a repository path or GITHUB_WORKSPACE, so it could run member code: \[          bash \.github/sami/rust-test\.sh\]' 's|^          list >caches.tsv$|          bash .github/sami/rust-test.sh\n&|' ''
WF=sami-rust-test.yml wlint W30-rust-test-actions-write 1 'rust_test names an actions permission other than read or none, which only release_cache_prune may hold: \[      actions: write\]' '/^  rust_test:$/,/^  rust_test_macos:$/s/^      contents: read$/&\n      actions: write/' ''
wlint W31-no-workflow-permissions 1 'has no workflow-level permissions' '/^permissions:$/,/^  contents: read$/d' ''
wlint W32-workflow-actions-write 1 'the workflow names an actions permission other than read or none, which only release_cache_prune may hold: \[  actions: write\]' 's/^  contents: read$/&\n  actions: write/' ''
wlint W33-version-write-all 1 'version names an actions permission other than read or none, which only release_cache_prune may hold: \[    permissions: write-all\]' 's/^  version:$/&\n    permissions: write-all/' ''
WF=sami-rust-test.yml wlint W34-rust-test-actions-write-on-the-next-line 1 'rust_test names an actions permission other than read or none, which only release_cache_prune may hold: \[      actions:\]' '/^  rust_test:$/,/^  rust_test_macos:$/s/^      contents: read$/&\n      actions:\n        write/' ''
wlint W35-release-cache-prune-gh-repo-clone 1 'release_cache_prune calls gh for something other than actions/caches, so it could fetch member code: \[          gh repo clone "\$GH_REPO" src -- --depth 1\]' 's|^          list >caches.tsv$|          gh repo clone "$GH_REPO" src -- --depth 1\n&|' ''
WF=sami-rust-test.yml wlint W36-rust-test-actions-write-read-in-a-comment 1 'rust_test names an actions permission other than read or none, which only release_cache_prune may hold: \[      actions: write # was actions: read\]' '/^  rust_test:$/,/^  rust_test_macos:$/s/^      contents: read$/&\n      actions: write # was actions: read/' ''
wlint W37-release-cache-prune-gh-caches-in-a-comment 1 'release_cache_prune calls gh for something other than actions/caches, so it could fetch member code: \[          gh api "repos/\$GH_REPO/contents/p\.sh" >p # not actions/caches\]' 's|^          list >caches.tsv$|          gh api "repos/$GH_REPO/contents/p.sh" >p # not actions/caches\n&|' ''
# A push to another ref only restores, sami included: the guard names
# release-candidate (W38).
wlint W38-release-binary-save-on-sami 1 'release_binary saves a cache on an event other than a push to release-candidate$' "s/github.ref == 'refs\/heads\/release-candidate' \&\& !cancelled() \&\& steps.release-cache-bound/github.ref == 'refs\/heads\/sami' \&\& !cancelled() \&\& steps.release-cache-bound/" ''
# attest holds id-token: write, so it runs no member code: no action but
# download-artifact and attest-build-provenance (W40), each pinned by commit
# (W51), no run step (W41, W48 in flow style), no download of another run's
# artifacts (W42, W49 in flow style), and no download by name or pattern
# (W50; W52 with artifact-ids only in a comment, W53 with an empty one). No
# other job (W43, W45 by write-all, W47; in sami-rust-test.yml, W46 with
# the value on the next line) and not the workflow (W44) names an id-token
# permission other than read or none. attest runs only on a push to
# release-candidate (W54 without the event test, W55 with ||), downloads
# exactly the upload steps'
# three ids by their needs outputs (W56 another output, W57 a literal id),
# which are the upload steps' artifact ids (W60), and attests each release
# file in a step of its own with one path (W58 two paths in one step, W59 the
# notes' step gone), with no step skipped by an if: (W61) or let fail by
# continue-on-error (W62), no line that YAML would fold into the if: (W63),
# the artifact-ids (W64) or a subject-path (W65), and no quote or # on the
# artifact-ids line (W66 " #,<id>" inside quotes, W67 the quoted value
# continued on a line that starts with #).
wlint W39-attest-rule 0 "attest: only actions/download-artifact and actions/attest-build-provenance, pinned by commit; no run step; no other run, repository or token; downloads by artifact id; if: a push to release-candidate; artifact-ids: the upload steps' three ids; one attest step per release file" '' ''
wlint W40-attest-checkout 1 'attest uses an action other than actions/download-artifact and actions/attest-build-provenance pinned by commit, so it could run member code: \[      - uses: actions/checkout@' 's|^      - name: Download the archives and the release notes$|      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n&|' ''
wlint W41-attest-run-step 1 'attest has a run step, so it could run member code: \[      - run: bash \.github/sami/carry-check\.sh\]' 's|^      - name: Download the archives and the release notes$|      - run: bash .github/sami/carry-check.sh\n&|' ''
wlint W42-attest-download-of-another-run 1 'attest names another run, repository or token, so it could attest files this run did not build: \[          run-id: 1\]' '/^  attest:$/,/^  release_cache_prune:$/s|^          path: \${{ runner.temp }}/attest$|&\n          run-id: 1|' ''
wlint W43-carry-id-token-write 1 'carry names an id-token permission other than read or none, which only attest may hold: \[      id-token: write\]' 's/^  carry:$/&\n    permissions:\n      id-token: write/' ''
wlint W44-workflow-id-token-write 1 'the workflow names an id-token permission other than read or none, which only attest may hold: \[  id-token: write\]' 's/^  contents: read$/&\n  id-token: write/' ''
wlint W45-release-binary-write-all 1 'release_binary names an id-token permission other than read or none, which only attest may hold: \[    permissions: write-all\]' 's/^  release_binary:$/&\n    permissions: write-all/' ''
WF=sami-rust-test.yml wlint W46-rust-test-id-token-on-the-next-line 1 'rust_test names an id-token permission other than read or none, which only attest may hold: \[      id-token:\]' '/^  rust_test:$/,/^  rust_test_macos:$/s/^      contents: read$/&\n      id-token:\n        write/' ''
wlint W47-release-cache-prune-id-token-write 1 'release_cache_prune names an id-token permission other than read or none, which only attest may hold: \[      id-token: write\]' '/^  release_cache_prune:$/,/^  publish:$/s/^      contents: read$/&\n      id-token: write/' ''
wlint W48-attest-run-step-in-flow-style 1 'attest has a run step, so it could run member code: \[      - \{ name: x, run: bash \.github/sami/carry-check\.sh \}\]' 's|^      - name: Download the archives and the release notes$|      - { name: x, run: bash .github/sami/carry-check.sh }\n&|' ''
wlint W49-attest-another-run-in-flow-style 1 'attest names another run, repository or token, so it could attest files this run did not build: \[        with: \{ artifact-ids: "1,2,3", path: x, run-id: 1 \}\]' '/^  attest:$/,/^  release_cache_prune:$/{/^        with:$/{N;s/^        with:\n          artifact-ids: .*$/        with: { artifact-ids: "1,2,3", path: x, run-id: 1 }/;};/^          path: \${{ runner.temp }}\/attest$/d;}' ''
wlint W50-attest-download-by-pattern 1 'attest downloads an artifact by name or pattern, not by the id its upload gave, so a job of this run could have replaced it: \[ - name: Download the archives and the release notes uses: actions/download-artifact@' '/^  attest:$/,/^  release_cache_prune:$/s/^          artifact-ids: .*$/          pattern: mise-*/' ''
wlint W51-attest-action-by-tag 1 'attest uses an action other than actions/download-artifact and actions/attest-build-provenance pinned by commit, so it could run member code: \[        uses: actions/download-artifact@v4\]' '/^  attest:$/,/^  release_cache_prune:$/s|actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0|actions/download-artifact@v4|' ''
wlint W52-attest-artifact-ids-only-in-a-comment 1 'attest downloads an artifact by name or pattern, not by the id its upload gave, so a job of this run could have replaced it: \[ - name: Download the archives and the release notes uses: actions/download-artifact@' '/^  attest:$/,/^  release_cache_prune:$/s/^          artifact-ids: .*$/          pattern: mise-*  # artifact-ids: later/' ''
wlint W53-attest-artifact-ids-empty 1 'attest downloads an artifact by name or pattern, not by the id its upload gave, so a job of this run could have replaced it: \[ - name: Download the archives and the release notes uses: actions/download-artifact@' '/^  attest:$/,/^  release_cache_prune:$/s/^          artifact-ids: .*$/          artifact-ids: ""\n          pattern: mise-*/' ''
wlint W54-attest-if-without-the-event 1 "so it could attest on another event or ref: \\[    if: .\\{\\{ github\\.ref == 'refs/heads/release-candidate' \\}\\}\\]\$" "/^  attest:\$/,/^  release_cache_prune:\$/s/^    if: \${{ github.event_name == 'push' && /    if: \${{ /" ''
wlint W55-attest-if-or 1 "so it could attest on another event or ref: \\[    if: .\\{\\{ github\\.event_name == 'push' \\|\\| github\\.ref == 'refs/heads/release-candidate' \\}\\}\\]\$" "/^  attest:\$/,/^  release_cache_prune:\$/s/ && github.ref == 'refs\\/heads\\/release-candidate' }}\$/ || github.ref == 'refs\\/heads\\/release-candidate' }}/" ''
wlint W56-attest-artifact-ids-another-output 1 "attest downloads by a needs output that is not an upload step's artifact id: \\[.\\{\\{ needs\\.version\\.outputs\\.tag \\}\\}\\]" 's/needs\.release_binary\.outputs\.mise-darwin-arm64-artifact-id/needs.version.outputs.tag/' ''
wlint W57-attest-artifact-ids-literal 1 'attest downloads an artifact id that is not a needs output \(a literal or another expression\), so it need not be what this run uploaded: \[12345\]' 's/,\${{ needs\.release_binary\.outputs\.mise-linux-x64-artifact-id }},/,12345,/' ''
wlint W58-attest-two-paths-in-one-step 1 'attest has an attest-build-provenance step that does not give one subject-path on its line, so a missing file might not fail it: \[- name: Attest the release notes\]' 's|^          subject-path: \${{ runner.temp }}/attest/release-notes/carry-notes.md$|          subject-path: \|\n            ${{ runner.temp }}/attest/release-notes/carry-notes.md\n            ${{ runner.temp }}/attest/mise-*/*.tar.gz|' ''
wlint W59-attest-notes-step-gone 1 'attest has 0 attest steps of its own for \[\$\{\{ runner\.temp \}\}/attest/release-notes/carry-notes\.md\], not 1, so that file could be missing and the run still green' '/^      - name: Attest the release notes$/,/^          subject-path: .*carry-notes\.md$/d' ''
wlint W60-carry-notes-output-not-the-upload-id 1 "carry does not give attest its upload step's artifact id: it lacks \\[      notes-artifact-id: " 's/^      notes-artifact-id: \${{ steps\.upload-notes\.outputs\.artifact-id }}$/      notes-artifact-id: "1"/' ''
wlint W61-attest-step-if 1 "attest has an if: other than its job's, which could skip an attest step: \\[        if: false\\]" 's|^      - name: Attest the release notes$|&\n        if: false|' ''
wlint W62-attest-continue-on-error 1 'attest has continue-on-error, so a failed attest step would not fail the job: \[        continue-on-error: true\]' 's|^      - name: Attest the release notes$|&\n        continue-on-error: true|' ''
wlint W63-attest-if-folded 1 'attest has a line that is not a key, which YAML folds into the value of the key above it: \[      && \$\{\{ true \}\}\]' "/^  attest:\$/,/^  release_cache_prune:\$/s/^    if: \${{ github\\.event_name == 'push' .* }}\$/&\\n      \\&\\& \${{ true }}/" ''
wlint W64-attest-artifact-ids-folded 1 'attest has a line that is not a key, which YAML folds into the value of the key above it: \[            ,12345\]' '/^  attest:$/,/^  release_cache_prune:$/s|^          artifact-ids: .*$|&\n            ,12345|' ''
wlint W65-attest-subject-path-folded 1 'attest has a line that is not a key, which YAML folds into the value of the key above it: \[            ,\$\{\{ runner\.temp \}\}/attest/mise-\*/\*\.tar\.gz\]' 's|^          subject-path: \${{ runner.temp }}/attest/release-notes/carry-notes.md$|&\n            ,${{ runner.temp }}/attest/mise-*/*.tar.gz|' ''
wlint W66-attest-artifact-ids-quoted-hash 1 "attest's artifact-ids line has a quote or a #, and inside quotes \" #\" is part of the value, so this lint cannot read which ids it downloads: \\[          artifact-ids: \"\\\$\\{\\{ needs\\.carry\\.outputs\\.notes-artifact-id \\}\\},.* #,12345\"\\]" '/^  attest:$/,/^  release_cache_prune:$/s/^          artifact-ids: \(.*\)$/          artifact-ids: "\1 #,12345"/' ''
wlint W67-attest-artifact-ids-quoted-hash-folded 1 "attest's artifact-ids line has a quote or a #, and inside quotes \" #\" is part of the value, so this lint cannot read which ids it downloads: \\[          artifact-ids: \"\\\$\\{\\{ needs\\.carry\\.outputs\\.notes-artifact-id \\}\\},.*artifact-id \\}\\}\\]" '/^  attest:$/,/^  release_cache_prune:$/s/^          artifact-ids: \(.*\)$/          artifact-ids: "\1\n            #,12345"/' ''

# --- the candidate branch's name -------------------------------------------------
# candidate_lint <dir>: every place that names the branch a release candidate
# is pushed to names one branch. The places: sami-build.yml's push trigger
# (beside sami), each github.ref test in its jobs and steps (beside sami:
# release_binary's cache bound and save steps, attest, release_cache_prune),
# publish's CANDIDATE_BRANCH, sami-checks.yml's push trigger and its run
# name's github.ref test, sc.py plan's push ref, and
# release-candidate-harness.sh's CANDIDATE_BRANCH. release-candidate.sh
# names the branch only as $CANDIDATE_BRANCH: once in its run search, once in
# its signer and once in its --source-ref, and no refs/heads/<name> literally.
# A place that names no branch, or a file it cannot read, is UNKNOWN, and
# fails: a check that read nothing has not passed.
push_branches() { # <workflow>: the branches of on.push.branches, one a line
	awk '
		/^on:[[:space:]]*$/ { on = 1; next }
		on && /^[^[:space:]#]/ { on = 0 }
		on && /^  push:[[:space:]]*$/ { push = 1; next }
		push && /^  [^[:space:]]/ { push = 0 }
		push && /^    branches:[[:space:]]*$/ { br = 1; next }
		br && /^      - / { b = $0; sub(/^      - */, "", b); gsub(/["'\'']/, "", b); sub(/[[:space:]]+$/, "", b); print b; next }
		br { br = 0 }
	' "$1"
}
refs_in() { # <file> <regex before the name> <character that ends it>: each name, on lines that are no comment
	awk -v pre="$2" -v end="$3" '
		/^[[:space:]]*#/ { next }
		{
			s = $0
			while (match(s, pre "[^" end "]+" end)) {
				m = substr(s, RSTART, RLENGTH)
				sub(pre, "", m)
				print substr(m, 1, length(m) - 1)
				s = substr(s, RSTART + RLENGTH)
			}
		}
	' "$1"
}
candidate_lint() {
	local d="$1" t place names n rc=0 q="'"
	local build="$d/.github/workflows/sami-build.yml" checks="$d/.github/workflows/sami-checks.yml"
	local rcsh="$d/.github/sami/release-candidate.sh"
	t="$(mktemp "$scratch/candidate.XXXXXX")"
	{
		push_branches "$build" | grep -vx sami | sed 's/^/sami-build.yml push trigger	/'
		refs_in "$build" "github[.]ref == ${q}refs/heads/" "$q" | grep -vx sami | sed 's/^/sami-build.yml github.ref tests	/'
		awk '/^[[:space:]]*#/ { next } /^[[:space:]]+CANDIDATE_BRANCH:[[:space:]]/ { v = $2; gsub(/["'\'']/, "", v); print v }' "$build" | sed 's/^/sami-build.yml CANDIDATE_BRANCH	/'
		push_branches "$checks" | sed 's/^/sami-checks.yml push trigger	/'
		refs_in "$checks" "github[.]ref == ${q}refs/heads/" "$q" | sed 's/^/sami-checks.yml github.ref tests	/'
		refs_in "$d/.github/sami-checks/sc.py" 'ref == "refs/heads/' '"' | sed 's/^/sc.py plan push ref	/'
		refs_in "$d/.github/sami/tests/release-candidate-harness.sh" 'CANDIDATE_BRANCH=' ' ' | sed 's/^/release-candidate-harness.sh CANDIDATE_BRANCH	/'
	} >"$t" 2>/dev/null
	for place in "sami-build.yml push trigger" "sami-build.yml github.ref tests" "sami-build.yml CANDIDATE_BRANCH" \
		"sami-checks.yml push trigger" "sami-checks.yml github.ref tests" "sc.py plan push ref" \
		"release-candidate-harness.sh CANDIDATE_BRANCH"; do
		names="$(awk -F'\t' -v p="$place" '$1 == p { print $2 }' "$t" | LC_ALL=C sort -u | tr '\n' ' ')"
		if [ -z "$names" ]; then
			echo "UNKNOWN: $place names no branch (or its file could not be read)"
			rc=1
		else
			echo "$place: ${names% }"
		fi
	done
	n="$(cut -f2 "$t" | LC_ALL=C sort -u | awk 'NF' | wc -l | tr -d ' ')"
	if [ "$n" -gt 1 ]; then
		echo "INCONSISTENT: the candidate branch has $n names: $(cut -f2 "$t" | LC_ALL=C sort -u | tr '\n' ' ')"
		rc=1
	fi
	if [ ! -r "$rcsh" ]; then
		echo "UNKNOWN: release-candidate.sh could not be read"
		rc=1
	else
		for place in 'run search|runs?branch=$CANDIDATE_BRANCH&' 'signer|@refs/heads/$CANDIDATE_BRANCH"' 'source ref|--source-ref "refs/heads/$CANDIDATE_BRANCH"'; do
			n="$(awk '!/^[[:space:]]*#/' "$rcsh" | grep -cF -- "${place#*|}" || true)"
			if [ "$n" != 1 ]; then
				echo "release-candidate.sh's ${place%%|*} names the branch otherwise than as \$CANDIDATE_BRANCH ($n lines read ${place#*|})"
				rc=1
			fi
		done
		names="$(awk '!/^[[:space:]]*#/' "$rcsh" | grep -oE 'refs/heads/[A-Za-z][A-Za-z0-9._/-]*' | LC_ALL=C sort -u | tr '\n' ' ' || true)"
		if [ -n "$names" ]; then
			echo "release-candidate.sh names ${names% } literally, not as \$CANDIDATE_BRANCH"
			rc=1
		fi
	fi
	if [ "$rc" = 0 ]; then
		echo "CONSISTENT: the candidate branch is $(cut -f2 "$t" | LC_ALL=C sort -u | awk 'NF'), in 7 places, and release-candidate.sh's 3 as \$CANDIDATE_BRANCH"
	fi
	return "$rc"
}

# clint <name> <want> <message regex> [<file> <sed>]: candidate_lint on a copy
# of the repository's files, <file> edited by <sed>. An edit that changes
# nothing fails the case: it would test the files as they are.
clint() {
	local name="$1" want="$2" msg="$3" file="${4:-}" edit="${5:-}" w f out rc
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/clint.XXXXXX")"
	for f in .github/workflows/sami-build.yml .github/workflows/sami-checks.yml .github/sami-checks/sc.py \
		.github/sami/release-candidate.sh .github/sami/tests/release-candidate-harness.sh; do
		mkdir -p "$w/$(dirname "$f")"
		cp "$repo/$f" "$w/$f"
	done
	if [ -n "$file" ]; then
		sed -e "$edit" "$repo/$file" >"$w/$file"
		if cmp -s "$repo/$file" "$w/$file"; then
			verdict "$name" "$want" 98 "$msg" "clint: the edit of $file changed nothing"
			return 0
		fi
	fi
	out="$(candidate_lint "$w" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}

cb_build=.github/workflows/sami-build.yml
cb_checks=.github/workflows/sami-checks.yml
cb_rc=.github/sami/release-candidate.sh
# C0: the files as they are name one branch. C1 to C13 each put the old name,
# sami-candidate, back in one place, and each fails (C1 and C3 are the only
# two that cache_lint also sees, as W1 and W39). C14 and C15: a place that
# names nothing is UNKNOWN.
NOT_MSG='INCONSISTENT|UNKNOWN|otherwise than|literally' clint C0-candidate-branch-one-name 0 '^CONSISTENT: the candidate branch is release-candidate, in 7 places'
clint C1-attest-if 1 'INCONSISTENT: the candidate branch has 2 names: release-candidate sami-candidate' "$cb_build" "/{{ github.event_name == 'push' && github.ref == 'refs\\/heads\\/release-candidate' }}/s/release-candidate/sami-candidate/"
clint C2-cache-bound-if 1 'INCONSISTENT' "$cb_build" '/steps.release-cache.outputs.cache-hit/s/refs\/heads\/release-candidate/refs\/heads\/sami-candidate/'
clint C3-cache-save-if 1 'INCONSISTENT' "$cb_build" '/steps.release-cache-bound.outputs.save/s/refs\/heads\/release-candidate/refs\/heads\/sami-candidate/'
clint C4-release-cache-prune-if 1 'INCONSISTENT' "$cb_build" "/!cancelled() && github.event_name == 'push' && github.ref/s/release-candidate/sami-candidate/"
clint C5-build-push-trigger 1 'INCONSISTENT' "$cb_build" 's/^      - release-candidate$/      - sami-candidate/'
clint C6-publish-candidate-branch 1 'INCONSISTENT' "$cb_build" 's/CANDIDATE_BRANCH: release-candidate/CANDIDATE_BRANCH: sami-candidate/'
clint C7-checks-push-trigger 1 'INCONSISTENT' "$cb_checks" 's/^      - release-candidate$/      - sami-candidate/'
clint C8-checks-run-name 1 'INCONSISTENT' "$cb_checks" '/&& format(/s/refs\/heads\/release-candidate/refs\/heads\/sami-candidate/'
clint C9-sc-plan-push-ref 1 'INCONSISTENT' .github/sami-checks/sc.py 's/ref == "refs\/heads\/release-candidate"/ref == "refs\/heads\/sami-candidate"/'
clint C10-verify-source-ref 1 "release-candidate.sh's source ref names the branch otherwise than as .CANDIDATE_BRANCH" "$cb_rc" 's/--source-ref "refs\/heads\/$CANDIDATE_BRANCH"/--source-ref "refs\/heads\/sami-candidate"/'
clint C11-verify-signer-ref 1 "release-candidate.sh's signer names the branch otherwise than as .CANDIDATE_BRANCH" "$cb_rc" 's/@refs\/heads\/$CANDIDATE_BRANCH"/@refs\/heads\/sami-candidate"/'
clint C12-find-run-search-branch 1 "release-candidate.sh's run search names the branch otherwise than as .CANDIDATE_BRANCH" "$cb_rc" 's/runs?branch=$CANDIDATE_BRANCH&/runs?branch=sami-candidate\&/'
clint C13-rc-harness-candidate-branch 1 'INCONSISTENT' .github/sami/tests/release-candidate-harness.sh 's/CANDIDATE_BRANCH=release-candidate/CANDIDATE_BRANCH=sami-candidate/'
clint C14-checks-trigger-names-none 1 'UNKNOWN: sami-checks.yml push trigger names no branch' "$cb_checks" '/^      - release-candidate$/d'
clint C15-sc-py-empty 1 'UNKNOWN: sc.py plan push ref names no branch' .github/sami-checks/sc.py 'd'

# --- rust-test-parity.sh ---------------------------------------------------------
# prun <name> <want> <message regex> <rules: JSON lines>: the parity script in
# a repository with one package, demo (a library with tests and doctests),
# against stubs of cargo metadata and bazel query. PARITY_SANCTIONED_LINE, a
# line written as it is after PARITY_SANCTIONED's.
prun() {
	local name="$1" want="$2" msg="$3" rules="$4" w out rc
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(cd "$(mktemp -d "$scratch/parity.XXXXXX")" && pwd -P)"
	mkdir -p "$w/bin" "$w/repo/scripts" "$w/repo/.github/sami" "$w/repo/crates/demo/src" "$w/repo/sdk/rust/x"
	(
		cd "$w/repo" || exit 1
		printf 'const VENDORED_FORK_EXCLUDES = [\n\t"--exclude",\n\t"vendored",\n];\n' >scripts/run-rs-task.ts
		printf '[workspace]\n' >Cargo.toml
		printf '[package]\nname = "demo"\n' >crates/demo/Cargo.toml
		printf '[package]\nname = "x"\n' >sdk/rust/x/Cargo.toml
		printf '# list\n%s\n' "${PARITY_WS:-sdk/rust/x/Cargo.toml  standalone}" >.github/sami/rust-test-cargo-workspaces.txt
		printf '# list\n%s\n' "${PARITY_UNTESTED:-# none}" >.github/sami/rust-test-untested-manifests.txt
		if [ -n "${PARITY_FIXTURE:-}" ]; then mkdir -p "$(dirname "$PARITY_FIXTURE")" && printf '[package]\nname = "fixture"\n\n[workspace]\n' >"$PARITY_FIXTURE"; fi
		{ echo '# sanctioned'; [ -n "${PARITY_SANCTIONED:-}" ] && printf '%s  ruling\n' "$PARITY_SANCTIONED"; [ -n "${PARITY_SANCTIONED_LINE:-}" ] && printf '%s\n' "$PARITY_SANCTIONED_LINE"; } >.github/sami/rust-test-sanctioned-skips.txt
		git init -q . && git add -A && git -c user.email=h@example.invalid -c user.name=harness commit -qm fixture
	) || { verdict "$name" "$want" 97 "$msg" "could not make the fixture repository"; return 0; }
	printf '%s\n' "$rules" >"$w/rules.json"
	cat >"$w/bin/cargo" <<EOF
#!/bin/sh
[ "\$1" = metadata ] || exit 2
r="$w/repo"
printf '{"packages":[{"name":"demo","manifest_path":"%s/crates/demo/Cargo.toml","targets":[{"name":"demo","kind":["lib"],"crate_types":["lib"],"src_path":"%s/crates/demo/src/lib.rs","test":true,"doctest":true}]}]}\n' "\$r" "\$r"
EOF
	cat >"$w/bin/bazelisk" <<EOF
#!/bin/sh
[ "\$1" = query ] || exit 2
cat "$w/rules.json"
EOF
	chmod +x "$w/bin/cargo" "$w/bin/bazelisk"
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" bash "$repo/.github/sami/rust-test-parity.sh" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
# rule <class> <name> [<attribute JSON>...]
rule() {
	local class="$1" name="$2" attrs
	shift 2
	attrs="$(printf '%s\n' "$@" | jq -s -c '.')"
	[ "$#" = 0 ] && attrs='[]'
	jq -cn --arg c "$class" --arg n "$name" --argjson a "$attrs" '{type: "RULE", rule: {name: $n, ruleClass: $c, attribute: $a}}'
}
strs() { printf '%s\n' "${@:2}" | jq -R . | jq -cs --arg n "$1" '{name: $n, stringListValue: .}'; }
str() { jq -cn --arg n "$1" --arg v "$2" '{name: $n, stringValue: $v}'; }
LIB="$(rule rust_library //crates/demo:demo "$(strs srcs //crates/demo:src/lib.rs)")"
DOCT="$(rule rust_doc_test //crates/demo:demo_doc_test "$(str crate //crates/demo:demo)")"
covered() { printf '%s\n%s\n%s\n' "$LIB" "$DOCT" "$(rule rust_test //crates/demo:demo_test "$(str crate //crates/demo:demo)" "$@")"; }
prun P1-covered 0 'Rust test parity: 2 test targets in the suite, 0 without a Bazel test target' "$(covered)"
prun P2-test-target-missing 1 "demo's test target demo \\(crates/demo/src/lib.rs\\) has no Bazel rust_test" "$LIB
$DOCT
$(rule rust_test //crates/demo:other_test "$(strs srcs //crates/demo:tests/other.rs)")"
prun P3-doctest-missing 1 "demo's doctest target demo \\(crates/demo/src/lib.rs\\) has no Bazel rust_doc_test" "$LIB
$(rule rust_test //crates/demo:demo_test "$(str crate //crates/demo:demo)")"
PARITY_WS='# none' prun P4-cargo-toml-unlisted 1 'sdk/rust/x/Cargo.toml is outside the root workspace and in neither' "$(covered)"
# A manifest outside the root workspace whose tests no job runs, on purpose,
# is in rust-test-untested-manifests.txt (P14; without its line it fails as
# P4 does, P15); a line naming no tracked Cargo.toml (P16), one naming the
# root workspace's (P17), and a manifest in both lists (P18) fail.
PARITY_FIXTURE=.github/platform-checks/fixture/Cargo.toml PARITY_UNTESTED='.github/platform-checks/fixture/Cargo.toml  the tool fixture' NOT_MSG='and in neither' prun P14-untested-manifest-listed 0 'Cargo manifests: 4 tracked, 0 outside the root workspace and unlisted' "$(covered)"
PARITY_FIXTURE=.github/platform-checks/fixture/Cargo.toml prun P15-untested-manifest-unlisted 1 '.github/platform-checks/fixture/Cargo.toml is outside the root workspace and in neither' "$(covered)"
PARITY_UNTESTED='.github/platform-checks/fixture/Cargo.toml  the tool fixture' prun P16-untested-line-names-no-manifest 1 '.github/platform-checks/fixture/Cargo.toml is in .github/sami/rust-test-untested-manifests.txt, but the tree under test tracks no such Cargo.toml' "$(covered)"
PARITY_UNTESTED='crates/demo/Cargo.toml  a root member' prun P17-untested-line-names-a-root-member 1 'crates/demo/Cargo.toml is in .github/sami/rust-test-untested-manifests.txt, but it is the root workspace.s' "$(covered)"
PARITY_UNTESTED='sdk/rust/x/Cargo.toml  both' prun P18-manifest-in-both-lists 1 'sdk/rust/x/Cargo.toml is in both' "$(covered)"
prun P5-skip-covered-by-another-target 0 "Skips in test targets' args: 1, 0 run nowhere" "$(covered "$(strs args --skip ::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args ::slow::)")"
prun P6-skip-uncovered 1 "//crates/demo:demo_test's args skip ::slow::, and no other test target of that binary runs it" "$(covered "$(strs args --skip ::slow::)")"
prun P7-skip-equals-spelling-uncovered 1 "//crates/demo:demo_test's args skip ::slow::, and no other test target" "$(covered "$(strs args --skip=::slow::)")"
prun P8-skip-equals-spelling-covered 0 "Skips in test targets' args: 1, 0 run nowhere" "$(covered "$(strs args --skip=::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args ::slow::)")"
PARITY_SANCTIONED='//crates/demo:demo_test x::flaky' prun P9-sanctioned-skip-in-args 0 'Sanctioned skip in //crates/demo:demo_test.s args: x::flaky' "$(covered "$(strs args --skip x::flaky)")"
PARITY_SANCTIONED='//crates/demo:demo_test x::a b' prun P12-sanctioned-name-with-a-space 0 'Sanctioned skip in //crates/demo:demo_test.s args: x::a b' "$(covered "$(strs args --skip 'x::a b')")"
PARITY_SANCTIONED_LINE='//crates/demo:demo_test x::flaky ruling' prun P13-sanctioned-line-without-its-why 1 'rust-test-sanctioned-skips.txt:2: no two spaces before its why: //crates/demo:demo_test x::flaky ruling' "$(covered "$(strs args --skip x::flaky)")"
prun P10-filter-of-another-binary-does-not-cover 1 "//crates/demo:demo_test's args skip ::slow::" "$(covered "$(strs args --skip ::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/other:other_test)" "$(strs args ::slow::)")"
# --skip matches test names by substring, --exact by whole name: a skip is
# covered by a filter of a target whose args have no --exact (P19), and not by
# the same filter in a target whose args hold --exact (P20), where a test whose
# name extends the skip would run nowhere. A skip in a target whose own args
# hold --exact drops that one test, which an --exact filter runs (P21). An
# empty skip (`--skip=`, every test) stays empty, and a filter that is the
# word for a mode covers nothing (P22).
prun P19-skips-covered-by-substring-filters 0 "Skips in test targets' args: 2, 0 run nowhere" "$(covered "$(strs args --skip x::a::slow --skip x::b::slow)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args x::a::slow x::b::slow)")"
prun P20-exact-filter-does-not-cover-a-substring-skip 1 "//crates/demo:demo_test's args skip x::a::slow, and each test target of that binary with it as a filter has --exact in its args; an --exact filter does not cover a substring skip" "$(covered "$(strs args --skip x::a::slow --skip x::b::slow)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args --exact x::a::slow x::b::slow)")"
prun P21-exact-skip-covered-by-an-exact-filter 0 "Skips in test targets' args: 1, 0 run nowhere" "$(covered "$(strs args --exact --skip x::a::slow)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args --exact x::a::slow)")"
prun P22-empty-skip-is-not-a-mode-word 1 "//crates/demo:demo_test's args skip , and no other test target of that binary runs it" "$(covered "$(strs args --skip=)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args substring)")"
prun P11-query-names-no-rust-test 1 'bazel query names no crate root of any rust_test' "$LIB"

# --- rust-test-early-listings.sh -------------------------------------------------
# erun <name> <want> <message regex> <rules: JSON lines> <binaries>: the early
# listings in a repository with two packages, demo (a library, and the test
# target tests/wire.rs) and vendored (a library test:rs leaves out), against
# stubs of cargo metadata and bazelisk query, build and info. <binaries>:
# lines of `<binary-id> <package> <kind> <name> <tests...>`, each a test
# binary of the archive, recorded under another target directory, whose
# --list names those tests. BAZEL_BIN: lines of `<label> <tests...>`, the
# binaries a bazel build leaves in bazel-bin; BUILD_RC, that build's exit;
# BUILD_FAILS, labels whose build fails (exit 1) when it names any of them. The
# output then names each index.tsv line with its listing (`<label>: <tests>`).
# EARLY_MODE: both (one call, the default), halves (the Bazel half, then the
# archive half, as the build job runs them) or unfinished (the archive half
# beside a Bazel half that has not ended). WIRE_TEST: false makes cargo
# metadata say cargo does not test tests/wire.rs. RUST_TEST_EARLY_SH runs
# another copy of the script.
early_sh="${RUST_TEST_EARLY_SH:-$repo/.github/sami/rust-test-early-listings.sh}"
erun() {
	local name="$1" want="$2" msg="$3" rules="$4" bins="$5" w out rc id package kind bname tests t label file
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(cd "$(mktemp -d "$scratch/early.XXXXXX")" && pwd -P)"
	mkdir -p "$w/bin" "$w/repo/scripts" "$w/target/debug/deps" "$w/binroot"
	printf 'const VENDORED_FORK_EXCLUDES = [\n\t"--exclude",\n\t"vendored",\n];\n' >"$w/repo/scripts/run-rs-task.ts"
	printf '%s\n' "$rules" >"$w/rules.json"
	# fake <path> <tests...>: a test binary that lists these tests, as libtest does.
	fake() {
		local f="$1"
		shift
		mkdir -p "$(dirname "$f")"
		{ printf '#!/bin/sh\n[ "$1" = --list ] || exit 2\n'; for t in "$@"; do printf "echo '%s: test'\n" "$t"; done; printf "echo; echo '%s tests, 0 benchmarks'\n" "$#"; } >"$f"
		chmod +x "$f"
	}
	: >"$w/bins.jsonl"
	while read -r id package kind bname tests; do
		[ -n "$id" ] || continue
		# shellcheck disable=SC2086 # one test name a word
		fake "$w/target/debug/deps/$bname-${id//[^a-z]/x}" $tests
		jq -cn --arg id "$id" --arg p "path+file://$w/repo/crates/$package#0.1.0" --arg k "$kind" --arg n "$bname" --arg path "/home/runner/target/debug/deps/$bname-${id//[^a-z]/x}" \
			'{key: $id, value: {"binary-id": $id, "binary-name": $n, "package-id": $p, kind: $k, "binary-path": $path, "build-platform": "target"}}' >>"$w/bins.jsonl"
	done <<<"$bins"
	jq -s '{"rust-build-meta": {"target-directory": "/home/runner/target"}, "rust-binaries": from_entries}' "$w/bins.jsonl" >"$w/binaries-metadata.json"
	while read -r label tests; do
		[ -n "$label" ] || continue
		t="${label#//}"
		# shellcheck disable=SC2086 # one test name a word
		fake "$w/binroot/${t%%:*}/${t#*:}" $tests
	done <<<"${BAZEL_BIN-//crates/demo:relay_test r::one tests::two}"
	cat >"$w/bin/cargo" <<EOF
#!/bin/sh
[ "\$1" = metadata ] || exit 2
r="$w/repo"
printf '{"packages":[{"id":"path+file://%s/crates/demo#0.1.0","name":"demo","targets":[{"name":"demo","kind":["lib"],"src_path":"%s/crates/demo/src/lib.rs","test":true},{"name":"wire","kind":["test"],"src_path":"%s/crates/demo/tests/wire.rs","test":${WIRE_TEST:-true}}]},{"id":"path+file://%s/crates/vendored#0.1.0","name":"vendored","targets":[{"name":"vendored","kind":["lib"],"src_path":"%s/crates/vendored/src/lib.rs","test":true}]}]}\n' "\$r" "\$r" "\$r" "\$r" "\$r"
EOF
	cat >"$w/bin/bazelisk" <<EOF
#!/bin/sh
case "\$1" in
	query) cat "$w/rules.json" ;;
	build) for a in "\$@"; do case " \${BUILD_FAILS:-} " in *" \$a "*) exit 1 ;; esac; done; exit "\${BUILD_RC:-0}" ;;
	info) echo "$w/binroot" ;;
	*) echo "stub: bazelisk \$*" >&2; exit 2 ;;
esac
EOF
	chmod +x "$w/bin/cargo" "$w/bin/bazelisk"
	case "${EARLY_MODE:-both}" in
	both)
		out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" bash "$early_sh" "$w/binaries-metadata.json" "$w/target" "$w/out" 2>&1)"
		rc=$?
		;;
	halves)
		out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" bash "$early_sh" bazel "$w/state" 2>&1; echo "--- bazel half: exit $?, bazel.rc [$(cat "$w/state/bazel.rc" 2>/dev/null)]")"
		out+=$'\n'"$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" bash "$early_sh" archive "$w/state" "$w/binaries-metadata.json" "$w/target" "$w/out" 2>&1)"
		rc=$?
		;;
	unfinished)
		mkdir -p "$w/state/bazel"
		out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" bash "$early_sh" archive "$w/state" "$w/binaries-metadata.json" "$w/target" "$w/out" 2>&1)"
		rc=$?
		;;
	esac
	if [ -f "$w/out/index.tsv" ]; then
		out+=$'\n'"--- index"
		while IFS=$'\t' read -r label file; do out+=$'\n'"$label: $(tr '\n' ' ' <"$w/out/$file" | sed 's/ $//')"; done <"$w/out/index.tsv"
	fi
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
ELIB="$(rule rust_library //crates/demo:demo "$(strs srcs //crates/demo:src/lib.rs)")"
EDEMO="$(rule rust_test //crates/demo:demo_test "$(str crate //crates/demo:demo)")"
EWIRE="$(rule rust_test //crates/demo:wire_test "$(strs srcs //crates/demo:tests/wire.rs)")"
# The Bazel-only target, as //crates/pi-natives:oauth_callback_relay_test:
# cargo builds its crate root through build.rs, as no test target.
ERELAY="$(rule rust_test //crates/demo:relay_test "$(str crate_root //crates/demo:src/relay.rs)" "$(strs srcs //crates/demo:src/relay.rs //crates/demo:src/publication.rs)")"
# A second Bazel-only target, whose source the tree lacks (as
# zle_vi_pty_test at Cut18 95097f22): its build fails (BUILD_FAILS).
EGONE="$(rule rust_test //crates/demo:gone_test "$(str crate_root //crates/demo:tests/gone.rs)" "$(strs srcs //crates/demo:tests/gone.rs)")"
ERULES="$ELIB
$EDEMO
$EWIRE
$ERELAY"
EBINS="demo demo lib demo a::one a::two
demo::wire demo test wire w::one
vendored vendored lib vendored v::one"
# A clean tree: each binary is the one rust_test whose crate root is its
# source, the Bazel-only target is built and listed, and vendored's binary,
# which no rust_test is, is left out by name (E1); each listing is the
# binary's test names, the summary line dropped (E2). A native_test that runs
# a rust_test's binary (the pi_natives_test scanner split) needs no listing of
# its own (E3).
NOT_MSG='::error' erun E1-early-listings-clean 0 "Early listings: 3 of 3 rust_test targets, 2 from the archive's 3 test binaries, 1 Bazel-only built by Bazel \\(//crates/demo:relay_test\\); 1 binaries of packages test:rs leaves out not listed \\(vendored\\)" "$ERULES" "$EBINS"
erun E2-early-listing-is-the-binarys-names 0 '^//crates/demo:demo_test: a::one a::two$' "$ERULES" "$EBINS"
NOT_MSG='::error' erun E3-native-test-of-a-listed-binary 0 'Early listings: 3 of 3 rust_test targets' "$ERULES
$(rule native_test //crates/demo:demo_slow_test "$(str src //crates/demo:demo_test)" "$(strs args --exact a::two)")" "$EBINS"
# A binary whose source is no rust_test's crate root fails by name (E4),
# and so does one whose source is two rust_tests' (E5).
erun E4-binary-maps-to-no-label 1 'test binary demo::wire \(crates/demo/tests/wire.rs\) maps to no Bazel rust_test' "$ELIB
$EDEMO
$ERELAY" "$EBINS"
erun E5-binary-maps-to-two-labels 1 'test binary demo \(crates/demo/src/lib.rs\) maps to 2 Bazel rust_tests, which all have crates/demo/src/lib.rs as their crate root: //crates/demo:demo_again_test //crates/demo:demo_test' "$ERULES
$(rule rust_test //crates/demo:demo_again_test "$(str crate //crates/demo:demo)")" "$EBINS"
# A binary that is no cargo target fails (E6). A Bazel-only target whose
# Linux build fails (E7), or that leaves no binary (E8), fails by its label.
# When one Bazel-only target of two does not build, only it fails, and the
# other, built alone, is still listed (E7b, E7c; run 46036206702 named both).
erun E6-binary-of-no-cargo-target 1 'test binary demo::ghost \(test ghost of .*\) is 0 cargo targets in cargo metadata' "$ERULES" "$EBINS
demo::ghost demo test ghost g::one"
BUILD_RC=1 erun E7-bazel-only-build-fails 1 '//crates/demo:relay_test: Bazel-only \(no test binary of the archive is it\), and the bazel build of it alone for Linux exited 1' "$ERULES" "$EBINS"
EARLY_MODE=halves BUILD_FAILS=//crates/demo:gone_test NOT_MSG='relay_test: (Bazel-only|a rust_test bazel query names)' erun E7b-a-bazel-only-build-failure-names-only-its-target 1 '//crates/demo:gone_test: Bazel-only \(no test binary of the archive is it\), and the bazel build of it alone for Linux exited 1' "$ERULES
$EGONE" "$EBINS"
EARLY_MODE=halves BUILD_FAILS=//crates/demo:gone_test erun E7c-the-bazel-only-target-that-built-is-listed 1 '^//crates/demo:relay_test: r::one tests::two$' "$ERULES
$EGONE" "$EBINS"
BAZEL_BIN='' erun E8-bazel-only-without-a-binary 1 '//crates/demo:relay_test: its binary .* cannot list its tests' "$ERULES" "$EBINS"
# Nothing to list is UNKNOWN, never a pass: no rust_test (E9), no binary (E10).
erun E9-query-names-no-rust-test 1 'UNKNOWN: bazel query names no rust_test under //crates' "$ELIB" "$EBINS"
erun E10-archive-names-no-binary 1 'UNKNOWN: .*binaries-metadata.json names no test binary' "$ERULES" ''
# The two halves the build job runs, the Bazel one in the background, give
# the same listings (E11, E11b). The archive half beside a Bazel half that has
# not ended is UNKNOWN (E12). A cargo test target with no binary in the
# archive leaves its rust_test without a listing (E13); a binary of a target
# cargo metadata says it does not test is the Bazel half's Bazel-only target
# too, and is listed twice (E14).
EARLY_MODE=halves NOT_MSG='::error' erun E11-early-listings-in-two-halves 0 "Early listings: 3 of 3 rust_test targets, 2 from the archive's 3 test binaries, 1 Bazel-only built by Bazel \\(//crates/demo:relay_test\\)" "$ERULES" "$EBINS"
EARLY_MODE=halves erun E11b-two-halves-list-the-bazel-only-target 0 '^//crates/demo:relay_test: r::one tests::two$' "$ERULES" "$EBINS"
EARLY_MODE=unfinished erun E12-archive-half-before-the-bazel-half-ends 1 'UNKNOWN: the Bazel half has not finished' "$ERULES" "$EBINS"
erun E13-cargo-test-target-without-a-binary 1 '//crates/demo:wire_test: a rust_test bazel query names, with no listing' "$ERULES" "demo demo lib demo a::one a::two
vendored vendored lib vendored v::one"
WIRE_TEST=false BAZEL_BIN='//crates/demo:relay_test r::one
//crates/demo:wire_test w::one' erun E14-binary-of-a-target-bazel-built-too 1 '//crates/demo:wire_test is listed twice: test binary demo::wire of the archive is it, and the Bazel half built it as Bazel-only' "$ERULES" "$EBINS"

# --- rust-test-listings-drift.sh -------------------------------------------------
# drun <name> <want> <message regex> <early> <Bazel's>: the drift check of two
# listings directories, each given as lines of `<label> <tests...>`.
# EARLY_INDEX=none leaves the early index out. RUST_TEST_DRIFT_SH runs
# another copy of the script.
drift_sh="${RUST_TEST_DRIFT_SH:-$repo/.github/sami/rust-test-listings-drift.sh}"
drun() {
	local name="$1" want="$2" msg="$3" w out rc side label tests i=0
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/drift.XXXXXX")"
	for side in early bazel; do
		mkdir -p "$w/$side"
		[ "$side" = early ] && [ "${EARLY_INDEX:-}" = none ] && continue
		: >"$w/$side/index.tsv"
		while read -r label tests; do
			[ -n "$label" ] || continue
			i=$((i + 1))
			# shellcheck disable=SC2086 # one test name a word
			if [ -n "$tests" ]; then printf '%s\n' $tests | LC_ALL=C sort -u >"$w/$side/$i.txt"; else : >"$w/$side/$i.txt"; fi
			printf '%s\t%s.txt\n' "$label" "$i" >>"$w/$side/index.tsv"
		done <<<"$([ "$side" = early ] && printf '%s' "$4" || printf '%s' "$5")"
	done
	out="$(PATH="${TOOLBIN:+$TOOLBIN:}$PATH" bash "$drift_sh" "$w/early" "$w/bazel" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
DT1=//crates/pi-shell:pi-shell_test
DT2=//crates/pi-natives:oauth_callback_relay_test
DT3=//crates/vendor/tree-sitter-go:tree-sitter-go_test
# The same listings pass, a target with no tests included (D1). A renamed
# test fails, named on each side (D2, D3); a target on one side only fails
# (D4, D5); the plant a dispatch makes, one renamed test and one missing
# target, fails with each named (D6). No early listings is UNKNOWN (D7).
NOT_MSG='::error' drun D1-drift-clean-pair 0 'Listing drift: 0 differences in 3 targets' "$DT1 a::one a::two
$DT2 p::one
$DT3" "$DT1 a::one a::two
$DT2 p::one
$DT3"
drun D2-drift-renamed-test-in-rust-tests 1 "$DT1 a::two: in rust_test's listing, not in the early one the macOS inventory read" "$DT1 a::one a::two_renamed" "$DT1 a::one a::two"
drun D3-drift-renamed-test-in-early 1 "$DT1 a::two_renamed: in the early listing the macOS inventory read, not in rust_test's" "$DT1 a::one a::two_renamed" "$DT1 a::one a::two"
drun D4-drift-target-missing-from-early 1 "$DT2 has a listing of rust_test's \\(1 tests\\) and no early listing" "$DT1 a::one" "$DT1 a::one
$DT2 p::one"
drun D5-drift-target-only-in-early 1 "$DT2 has an early listing \\(1 tests\\) and no listing of rust_test's" "$DT1 a::one
$DT2 p::one" "$DT1 a::one"
drun D6-drift-plant-rename-and-missing-target 1 'Listing drift: 3 differences in 2 targets \(early 1, rust_test.s 2\)' "$DT1 a::one a::two_renamed" "$DT1 a::one a::two
$DT2 p::one"
EARLY_INDEX=none drun D7-drift-no-early-listings 1 'UNKNOWN: .*/early/index.tsv \(early\) is missing or empty' '' "$DT1 a::one"

# The per-test results the seed's control reads (results.tsv, written whatever
# the verdict): the final status of each test and what each invocation said,
# with a flaky target's attempts kept apart, in the Linux job and in the macOS
# one (RUST_TEST_ONLY), and for a doctest, whose log is libtest's text.
NOT_MSG='::error' run J170-per-test-results 0 '^results: //crates/pi-diff:pi-diff_test.a::one.ok.main=ok$' '' "{ $P; rt $D PASSED lt_pass a::one a::two; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run J170b-per-test-results-of-a-cargo-test 0 '^results: sdk/rust/demo:lib:demo.a::one.ok.cargo=ok$' '' "{ $P; rt $D PASSED lt_pass a::one a::two; rt $V PASSED lt_pass v::one; } >\"\$bep\"; exit 0"
run J170c-per-test-results-of-a-failed-test 0 '^results: //crates/pi-builtins:pi-builtins_test.x::k1.failed.main=failed$' "$B x::k1" "{ $P; rt $B FAILED lt_fail x::k1; } >\"\$bep\"; exit 3"
run J170d-per-test-results-of-an-ignored-test 1 '^results: //crates/pi-diff:pi-diff_test.d::needs_network.ignored.main=ignored$' '' "{ $P; rt $D PASSED lt_ignored d::one d::needs_network; } >\"\$bep\"; exit 0"
NOT_MSG='::error' run J170e-per-test-results-of-a-doctest 0 '^results: //crates/pi-diff:pi-diff_doc_test.src/lib.rs - f \(line 3\).ok.main=ok$' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# A flaky target's test that failed on one attempt and passed on another is `ok`
# with both attempts named, so the control compares it by that final status.
FLAKY="$B x::f" MAIN_MUST_FLAKY="$B" run J171-per-test-results-of-a-flaky-test 0 '^results: //crates/pi-builtins:pi-builtins_test.x::f.ok.main=failed,main=ok$' "$B x::f" "f=\"\$(tpath $B)\"; mkdir -p \"\$(dirname \"\$f\")/test_attempts\"; lt_fail x::f >\"\$(dirname \"\$f\")/test_attempts/attempt_1.log\"; lt_pass x::passes x::f >\"\$f\"; fakebin $B x::passes x::f; { $P; cfg $B 'rust_test rule'; summary $B FLAKY \"\$(dirname \"\$f\")/test_attempts/attempt_1.log\" \"\$f\"; } >\"\$bep\"; exit 0"
ONLY="$ONLYT" CANARY="$CAN" KNOWN_OUTPUT="$CAN" OWN_TESTS="m::langinfo m::strftime p::canary" OWN_PRINTS="p::canary" NOT_MSG='::error' run J172-per-test-results-in-the-macos-job 0 '^results: //crates/pi-diff:pi-diff_test.m::strftime.ok.only-[0-9]+=ok$' '' 'exit 9'

# --- the build seed: .github/sami/gate-seed.sh ------------------------------------
# srun <name> <want> <message regex> <body>: the gate's two seed steps, as
# sami-rust-test.yml runs them, in a workspace of its own. The body runs first,
# with $w (the workspace), $archive (where the download lands), $gh (the
# directory the gh stub answers from) and $dir (the seed's cache directory)
# set; it writes the case's archive and the API's answers. Then the case runs
# `gate-seed.sh pick`, hands its outputs to `gate-seed.sh use` as the workflow
# does, and runs that. A case's output holds both steps' lines, the pick's
# outputs, the bazelrc fragment the build would use (`rc: `) and the files the
# seed left. Its environment: SEED_MODE, SEED_SHA256 (`archive` for the
# archive's own, as the seed job's output would give it), CASE_RUN_ID (the run
# the case runs in, 100 by default; the harness runs inside a run of its own,
# whose GITHUB_RUN_ID must reach no case), SEED_NAME, SEED_JOB and
# GH_STUB_FAIL.
seed_sh="${GATE_SEED_SH:-$repo/.github/sami/gate-seed.sh}"
sha_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}
# seed_archive <path>: a seed as the seed job packs it (a disk and a repository cache).
seed_archive() {
	local d
	d="$(mktemp -d "$scratch/seed-src.XXXXXX")"
	mkdir -p "$d/disk/ac" "$d/repo"
	echo "an action's output" >"$d/disk/ac/1"
	echo "a repository rule's download" >"$d/repo/2"
	mkdir -p "$(dirname "$1")"
	tar -cf - -C "$d" disk repo | zstd -T0 -3 -q -o "$1"
	rm -rf -- "$d"
}
srun() {
	local name="$1" want="$2" msg="$3" body="$4" w out rc pick_rc run sum reason given
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/seed.XXXXXX")"
	mkdir -p "$w/bin" "$w/gh" "$w/temp" "$w/download"
	local rcf="$w/bazel.rc" archive="$w/download/sc-seed.tar.zst" gh="$w/gh" dir="$w/cache"
	: >"$rcf"
	cat >"$w/bin/gh" <<'EOF'
#!/usr/bin/env bash
# The harness's gh: it answers `gh api` from this case's files, with the -q
# filter applied by jq, as gh does.
set -u
if [ "${GH_STUB_FAIL:-0}" = 1 ]; then
	echo "gh: HTTP 403: this token cannot read the repository's runs" >&2
	exit 1
fi
path="" q=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	api) ;;
	-X | -f | -F) shift ;;
	-q)
		q="$2"
		shift
		;;
	*) [ -n "$path" ] || path="$1" ;;
	esac
	shift
done
id="${path%/*}"
id="${id##*/}"
case "$path" in
*/runs) file="$GH_STUB/runs.json" ;;
*/jobs) file="$GH_STUB/jobs-$id.json" ;;
*/artifacts) file="$GH_STUB/artifacts-$id.json" ;;
*/logs)
	cat "$GH_STUB/log-$id.txt" 2>/dev/null
	exit 0
	;;
*)
	echo "gh stub: no answer for [$path]" >&2
	exit 4
	;;
esac
[ -f "$file" ] || { echo "gh stub: this case wrote no ${file##*/}" >&2; exit 4; }
if [ -n "$q" ]; then jq -r "$q" "$file"; else cat "$file"; fi
EOF
	chmod +x "$w/bin/gh"
	eval "$body"
	given="${SEED_SHA256:-}"
	[ "$given" != archive ] || given="$(sha_of "$archive")"
	out="$(cd "$w" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" \
		GH_STUB="$gh" GH_STUB_FAIL="${GH_STUB_FAIL:-0}" GITHUB_OUTPUT="$w/pick.out" \
		GITHUB_REPOSITORY=cybermonklabs/oh-my-pi GITHUB_RUN_ID="${CASE_RUN_ID:-100}" \
		RUNNER_TEMP="$w/temp" SEED_DIR="$dir" SEED_ARCHIVE="$archive" \
		SEED_MODE="${SEED_MODE:-off}" SEED_SHA256="$given" \
		SEED_NAME="${SEED_NAME:-sc-seed-linux}" SEED_JOB="${SEED_JOB:-build seed (Linux)}" \
		bash --noprofile --norc "$seed_sh" pick 2>&1)"
	pick_rc=$?
	run="$(awk -F= '$1 == "run-id" { print $2 }' "$w/pick.out" 2>/dev/null)"
	sum="$(awk -F= '$1 == "sha256" { print $2 }' "$w/pick.out" 2>/dev/null)"
	reason="$(awk -F= '$1 == "reason" { print $2 }' "$w/pick.out" 2>/dev/null)"
	out+=$'\n'"pick exit=$pick_rc outputs: run-id=[$run] sha256=[$sum] reason=[$reason]"
	# The workflow downloads only when the pick names a run to download from.
	[ -n "$run" ] || rm -f -- "$archive"
	out+=$'\n'"$(cd "$w" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" \
		RUNNER_TEMP="$w/temp" SEED_DIR="$dir" SEED_ARCHIVE="$archive" RC="$rcf" \
		SEED_SHA256="$sum" SEED_REASON="$reason" SEED_RUN_ID="$run" \
		bash --noprofile --norc "$seed_sh" use 2>&1)"
	rc=$?
	out+=$'\n'"$(sed 's/^/rc: /' "$rcf")"
	out+=$'\n'"seed files: $( (cd "$dir" 2>/dev/null && find . -type f | LC_ALL=C sort | tr '\n' ' ') || echo none)"
	[ "$pick_rc" = 0 ] || out+=$'\n'"the pick step failed with $pick_rc"
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
# The gh stub's answers for the auto search: `cut_runs <run>...` the runs of the
# candidate branch, newest first; `cut_job <run> <job id> <conclusion> [name]`
# that run's seed job; `cut_control <run> <seed job id> <conclusion>` that run
# beside its cold control's job; `cut_log <job id> <sha256>` what the seed job
# printed; `cut_artifact <run> <expired> [name]` its seed artifact.
cut_runs() { printf '{"workflow_runs":[%s]}\n' "$(for r in "$@"; do printf '{"id":%s},' "$r"; done | sed 's/,$//')" >"$gh/runs.json"; }
cut_job() { printf '{"jobs":[{"id":%s,"name":"%s","conclusion":"%s"}]}\n' "$2" "${4:-build seed (Linux)}" "$3" >"$gh/jobs-$1.json"; }
cut_control() { printf '{"jobs":[{"id":%s,"name":"build seed (Linux)","conclusion":"success"},{"id":99,"name":"rust test results, seeded against cold","conclusion":"%s"}]}\n' "$2" "$3" >"$gh/jobs-$1.json"; }
cut_log() { printf '2026-11-26T09:00:00.0000000Z GATESEED seed build exit=0 in 900 s\n2026-11-26T09:20:00.0000000Z GATESEED seed sha256=%s bytes=42 packed in 60 s, disk 10 KiB, repository 2 KiB\n' "$2" >"$gh/log-$1.txt"; }
cut_artifact() { printf '{"artifacts":[{"id":9,"name":"%s","expired":%s}]}\n' "${3:-sc-seed-linux}" "$2" >"$gh/artifacts-$1.json"; }
# G1, G2: the seed this run's own seed job built, taken and refused. G2 is the
# planted mismatch: the bytes are not what the seed job published, so the job
# builds cold, says so, and passes.
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error|::warning' srun G1-build-seeded 0 '^GATESEED path=seeded reason=this-run-100 run=100 disk=[0-9]+ KiB' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error' srun G1b-build-seeded-points-bazel-at-it 0 '^rc: common --disk_cache=.*/cache/disk$' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error' srun G1c-build-seeded-unpacks-it 0 '^seed files: \./disk/ac/1 \./repo/2 $' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error' srun G1d-build-scripts-outside-the-sandbox 0 '^rc: build --strategy=CargoBuildScriptRun=local$' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=0000000000000000000000000000000000000000000000000000000000000000 NOT_MSG='::error|disk_cache' srun G2-build-sha256-mismatch-is-cold 0 '^GATESEED path=cold reason=sha256-mismatch' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=0000000000000000000000000000000000000000000000000000000000000000 NOT_MSG='::error' srun G2b-mismatch-says-both-sums 0 '::warning title=Gate seed::the seed of run 100 has sha256 [0-9a-f]{64}, and its seed job gives 0{64}' 'seed_archive "$archive"'
# Every path still runs every test.
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error' srun G3-seeded-runs-every-test 0 '^rc: test --cache_test_results=no$' 'seed_archive "$archive"'
NOT_MSG='::error|disk_cache' srun G4-off-is-cold 0 '^GATESEED path=cold reason=off run=none' ':'
NOT_MSG='::error' srun G4b-cold-runs-every-test 0 '^rc: test --cache_test_results=no$' ':'
# The cold path runs build scripts where the seed ran them, so that a cold run
# and a seeded run of one commit differ in the cache and in nothing else.
NOT_MSG='::error' srun G4c-cold-runs-build-scripts-where-the-seed-did 0 '^rc: build --strategy=CargoBuildScriptRun=local$' ':'
# A seed job that gave no sha256 (it failed before packing), and a download
# that did not land: cold, by name.
SEED_MODE=build NOT_MSG='::error|disk_cache' srun G5-build-without-a-sha256-is-cold 0 '^GATESEED path=cold reason=no-seed-sha256' 'seed_archive "$archive"'
SEED_MODE=build SEED_SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef NOT_MSG='::error|disk_cache' srun G6-no-archive-is-cold 0 '^GATESEED path=cold reason=no-archive' ':'
# The auto search: the newest cut run whose seed job passed, printed a sha256
# and still has its artifact. G7's newest run has no seed job, so the one
# before it is taken.
SEED_MODE=auto SEED_SHA256='' NOT_MSG='::error|::warning' srun G7-auto-takes-the-newest-cut-seed 0 '^GATESEED path=seeded reason=cut-run-200 run=200' 'seed_archive "$archive"; cut_runs 300 200; cut_job 300 7 failure; cut_job 200 8 success; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 false; cut_artifact 300 false'
SEED_MODE=auto NOT_MSG='::error' srun G7b-auto-says-which-run-it-skipped 0 '^GATESEED auto run 300: no \[build seed \(Linux\)\] job that passed$' 'seed_archive "$archive"; cut_runs 300 200; cut_job 300 7 failure; cut_job 200 8 success; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 false'
SEED_MODE=auto NOT_MSG='::error|disk_cache' srun G8-auto-skips-an-expired-artifact 0 '^GATESEED path=cold reason=no-cut-seed' 'seed_archive "$archive"; cut_runs 200; cut_job 200 8 success; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 true'
SEED_MODE=auto NOT_MSG='::error|disk_cache' srun G9-auto-skips-a-job-that-printed-no-sha256 0 'GATESEED auto run 200: job 8 printed no seed sha256' 'cut_runs 200; cut_job 200 8 success; : >"$gh/log-8.txt"; cut_artifact 200 false'
# A seed whose bytes are what its job published, and that is not an archive:
# the job builds cold rather than build on what it could not read.
SEED_MODE=build SEED_SHA256=archive NOT_MSG='::error|disk_cache' srun G9b-an-archive-that-does-not-unpack-is-cold 0 '^GATESEED path=cold reason=unpack-failed' 'mkdir -p "$(dirname "$archive")"; printf "not an archive\n" >"$archive"'
# A cut whose own cold control failed is a cut whose seed says nothing.
SEED_MODE=auto NOT_MSG='::error|disk_cache' srun G9c-auto-skips-a-cut-whose-control-failed 0 'GATESEED auto run 200: its \[rust test results, seeded against cold\] job failed, so its seed is not read' 'seed_archive "$archive"; cut_runs 200; cut_job 200 8 success; cut_control 200 8 failure; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 false'
SEED_MODE=auto NOT_MSG='::error|::warning' srun G9d-auto-takes-a-cut-whose-control-passed 0 '^GATESEED path=seeded reason=cut-run-200 run=200' 'seed_archive "$archive"; cut_runs 200; cut_job 200 8 success; cut_control 200 8 success; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 false'
SEED_MODE=auto NOT_MSG='::error|disk_cache' srun G10-auto-with-no-cut-run-is-cold 0 '^GATESEED path=cold reason=no-cut-run' 'printf "{\"workflow_runs\":[]}\n" >"$gh/runs.json"'
SEED_MODE=auto GH_STUB_FAIL=1 NOT_MSG='::error|disk_cache' srun G11-auto-search-failure-is-cold 0 '^GATESEED path=cold reason=run-search-failed' ':'
SEED_MODE=auto GH_STUB_FAIL=1 NOT_MSG='::error|disk_cache' srun G11b-auto-search-failure-says-what-gh-said 0 '^GATESEED auto gh: gh: HTTP 403' ':'
# A seed job of another operating system is not this job's seed.
SEED_MODE=auto SEED_NAME=sc-seed-macos SEED_JOB='build seed (macOS)' NOT_MSG='::error|disk_cache' srun G12-auto-wants-its-own-seed-job 0 'GATESEED auto run 200: no \[build seed \(macOS\)\] job that passed' 'seed_archive "$archive"; cut_runs 200; cut_job 200 8 success "build seed (Linux)"; cut_log 8 "$(sha_of "$archive")"; cut_artifact 200 false sc-seed-linux'
SEED_MODE=warm NOT_MSG='::error|disk_cache' srun G13-a-mode-that-is-no-mode-is-cold 0 '^GATESEED path=cold reason=unknown-mode' ':'

# --- the seeded run against the cold one: rust-test-results-compare.sh ------------
# zrun <name> <want> <message regex> <cold results> <seeded results> [<flaky targets>]:
# the compare job's script on two results files, each line written as
# `<target>|<test>|<final>|<per invocation>`; `none` writes no file and `empty`
# an empty one. The flaky targets are written as `flaky: ` lines of a
# known-failure list.
compare_sh="${RUST_TEST_COMPARE_SH:-$repo/.github/sami/rust-test-results-compare.sh}"
zrun() {
	local name="$1" want="$2" msg="$3" w out rc side body
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/compare.XXXXXX")"
	mkdir -p "$w/cold" "$w/seeded"
	for side in cold seeded; do
		body="$4"
		[ "$side" = cold ] || body="$5"
		case "$body" in
		none) ;;
		empty) : >"$w/$side/results.tsv" ;;
		*) printf '%s\n' "$body" | tr '|' '\t' >"$w/$side/results.tsv" ;;
		esac
	done
	{
		echo '# known failures'
		echo
		[ -z "${6:-}" ] || printf '%s\n' "$6" | while read -r t n; do printf '%s %s  flaky: a race\n' "$t" "$n"; done
	} >"$w/known-failures.txt"
	out="$(bash --noprofile --norc "$compare_sh" "$w/cold" "$w/seeded" "$w/known-failures.txt" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
ZA="//crates/pi-diff:pi-diff_test|a::one|ok|main=ok
//crates/pi-diff:pi-diff_test|a::two|ignored|main=ignored
//crates/pi-builtins:pi-builtins_test|x::k1|failed|main=failed"
NOT_MSG='::error' zrun Z1-the-same-results-pass 0 '^The seeded run.s results are the cold run.s, test by test\.$' "$ZA" "$ZA"
NOT_MSG='::error' zrun Z1b-the-counts-are-named 0 '^Per-test results: 3 tests cold, 3 seeded, 3 in both; targets listed flaky: 0$' "$ZA" "$ZA"
zrun Z2-a-status-that-differs-fails 1 'pi-diff_test a::one is ok in the cold run and failed in the seeded run' "$ZA" "//crates/pi-diff:pi-diff_test|a::one|failed|main=failed
//crates/pi-diff:pi-diff_test|a::two|ignored|main=ignored
//crates/pi-builtins:pi-builtins_test|x::k1|failed|main=failed"
zrun Z3-a-test-only-the-seeded-run-ran-fails 1 'pi-diff_test a::three ran in the seeded run and in no invocation of the cold run' "$ZA" "$ZA
//crates/pi-diff:pi-diff_test|a::three|ok|main=ok"
zrun Z4-a-test-only-the-cold-run-ran-fails 1 'pi-diff_test a::three ran in the cold run and in no invocation of the seeded run' "$ZA
//crates/pi-diff:pi-diff_test|a::three|ok|main=ok" "$ZA"
# The attempts of a test whose target is listed flaky may differ; any other
# test's may not.
NOT_MSG='::error' zrun Z5-a-flaky-target-is-compared-by-its-final-status 0 'The seeded run.s results are the cold run.s' "//crates/pi-diff:pi-diff_test|a::one|ok|main=failed,main=ok" "//crates/pi-diff:pi-diff_test|a::one|ok|main=ok" "//crates/pi-diff:pi-diff_test a::one"
zrun Z6-attempts-that-differ-elsewhere-fail 1 'pi-diff_test a::one is ok in both runs, and ran \[main=failed,main=ok\] cold and \[main=ok\] seeded' "//crates/pi-diff:pi-diff_test|a::one|ok|main=failed,main=ok" "//crates/pi-diff:pi-diff_test|a::one|ok|main=ok"
zrun Z7-no-results-file-is-unknown 1 'UNKNOWN: .*/seeded/results.tsv is not there' "$ZA" none
zrun Z8-an-empty-results-file-is-unknown 1 'UNKNOWN: .*/cold/results.tsv is empty' empty "$ZA"
zrun Z9-a-line-that-is-no-result-is-unknown 1 'UNKNOWN: .*cold/results.tsv has a line that is not' "//crates/pi-diff:pi-diff_test|a::one|ok" "$ZA"
zrun Z10-a-final-status-that-is-no-status-is-unknown 1 'UNKNOWN: .*cold/results.tsv has a line that is not' "//crates/pi-diff:pi-diff_test|a::one|flaky|main=ok" "$ZA"
zrun Z11-a-test-named-twice-is-unknown 1 'UNKNOWN: .*seeded/results.tsv names a test twice' "$ZA" "$ZA
//crates/pi-diff:pi-diff_test|a::one|ok|main=ok"
zrun Z12-two-files-with-no-test-in-common-are-unknown 1 'UNKNOWN: no test of the cold run is a test of the seeded run' "//crates/pi-diff:pi-diff_test|a::one|ok|main=ok" "//crates/pi-diff:pi-diff_test|b::one|ok|main=ok"

# --- the build seed's writer: gate-seed.sh build ----------------------------------
# brun <name> <want> <message regex> <bazel exit code> [<body>]: the seed job's
# step, with a bazelisk stub that checks what the seed must pass it, writes one
# action into the disk cache and exits with that code. A case's output holds the
# step's lines, what it wrote to the step's outputs, and the archive it left.
brun() {
	local name="$1" want="$2" msg="$3" code="$4" body="${5:-}" w out rc
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/seedbuild.XXXXXX")"
	mkdir -p "$w/bin" "$w/temp"
	local rcf="$w/bazel.rc" archive="$w/out/sc-seed.tar.zst" dir="$w/cache"
	: >"$rcf"
	cat >"$w/bin/bazelisk" <<EOF
#!/usr/bin/env bash
# The harness's bazelisk for the seed's writer.
set -u
args=("\$@")
[ "\${args[0]#--bazelrc=}" != "\${args[0]}" ] || { echo "stub: bazelisk without --bazelrc" >&2; exit 2; }
[ "\${args[1]}" = build ] || { echo "stub: bazelisk \${args[1]}, not build" >&2; exit 2; }
case " \${args[*]} " in *" --keep_going "*) ;; *) echo "stub: the seed's build lacks --keep_going" >&2; exit 2 ;; esac
case " \${args[*]} " in *" //crates/... "*) ;; *) echo "stub: the seed's build takes no pattern (\${args[*]})" >&2; exit 2 ;; esac
rcf="\${args[0]#--bazelrc=}"
grep -qF -- "--disk_cache=$dir/disk" "\$rcf" || { echo "stub: the fragment points at no disk cache" >&2; exit 2; }
grep -qF -- "--repository_cache=$dir/repo" "\$rcf" || { echo "stub: the fragment points at no repository cache" >&2; exit 2; }
grep -qF -- "--strategy=CargoBuildScriptRun=local" "\$rcf" || { echo "stub: the seed runs build scripts in the sandbox" >&2; exit 2; }
mkdir -p "$dir/disk/ac" "$dir/repo"
echo "an action's output" >"$dir/disk/ac/1"
exit $code
EOF
	chmod +x "$w/bin/bazelisk"
	[ -z "$body" ] || eval "$body"
	out="$(cd "$w" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" GITHUB_OUTPUT="$w/build.out" RUNNER_TEMP="$w/temp" \
		SEED_DIR="$dir" SEED_ARCHIVE="$archive" OMP_BAZEL_RC="$rcf" \
		bash --noprofile --norc "$seed_sh" build //crates/... 2>&1)"
	rc=$?
	out+=$'\n'"step outputs: $(tr '\n' ' ' <"$w/build.out" 2>/dev/null)"
	if [ -f "$archive" ]; then
		# The number the step published must be the archive's own, in its log and
		# in its output, not a number of the right shape: every reader checks the
		# bytes it downloads against it.
		local real said logged
		real="$(sha_of "$archive")"
		said="$(awk -F= '$1 == "sha256" { print $2 }' "$w/build.out" 2>/dev/null)"
		logged="$(printf '%s\n' "$out" | sed -n 's/.*GATESEED seed sha256=\([0-9a-f]*\) .*/\1/p' | tail -n 1)"
		if [ "$real" = "$said" ] && [ "$real" = "$logged" ]; then
			out+=$'\n'"published-matches: yes (sha256 $real)"
		else
			out+=$'\n'"published-matches: no (the archive is $real, the step published [$said] and logged [$logged])"
		fi
		out+=$'\n'"archive: unpacks [$(zstd -d -q -c "$archive" | tar -tf - | LC_ALL=C sort | tr '\n' ' ')]"
	else
		out+=$'\n'"archive: none"
		out+=$'\n'"published-matches: no archive"
	fi
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
# The writer packs what the build left and publishes that archive's own sha256,
# which every reader checks the bytes it downloads against.
NOT_MSG='::error|::warning' brun G14-the-writer-publishes-the-archives-sha256 0 '^GATESEED seed sha256=([0-9a-f]{64}) bytes=[0-9]+ packed in [0-9]+ s, disk [0-9]+ KiB, repository [0-9]+ KiB$' 0
NOT_MSG='::error|::warning' brun G14b-the-sha256-it-publishes-is-the-archives 0 '^published-matches: yes \(sha256 [0-9a-f]{64}\)$' 0
NOT_MSG='::error|::warning' brun G14c-the-writer-packs-both-caches 0 '^archive: unpacks \[disk/ disk/ac/ disk/ac/1 repo/ \]$' 0
# A target that did not build leaves a seed of what did, with a warning; bazel
# itself failing leaves no seed at all.
brun G15-a-target-that-did-not-build-still-seeds 0 '::warning title=Gate seed::a target did not build \(bazel exited 1\)' 1
brun G16-bazel-failing-publishes-no-seed 37 '::error title=Gate seed::bazel build exited 37' 37
NOT_MSG='sha256=' brun G16b-no-archive-when-bazel-failed 37 '^archive: none$' 37

# --- the build seed is the gate's, and it is no cache -----------------------------
# seed_lint <sami-build.yml> <sami-checks.yml>: the seed belongs to the gate's
# jobs, and it is an artifact, never a GitHub Actions cache entry.
#   - No job of sami-build.yml names it: release_binary, attest, publish and
#     release_cache_prune build and publish the release, and none of them may
#     read bytes a gate run produced. A comment may say the word; a line that
#     is not a comment may not.
#   - sami-checks.yml keeps the workflow-level cache-mode: none, no job of it
#     sets another and no job has an actions/cache step, so neither a seed job
#     nor a gate job holds a cache token; and each call of sami-rust-test.yml
#     passes cache-mode: none on, since a called workflow takes the caller's.
#   - Each seed artifact is kept 3 days: a seed that outlived its cut is bytes
#     nobody would check against a live seed job's log.
seed_lint() {
	local build="$1" checks="$2" rc=0 names jobs bad job modes steps seeds n calls="" dup
	names="$(awk '!/^[[:space:]]*#/ && (/sc-seed/ || /gate-seed/ || /GATESEED/ || /seed-sha256/ || /SEED_/) { print FNR ": " $0 }' "$build")"
	if [ -n "$names" ]; then
		echo "sami-build.yml names the gate's build seed, which no job that builds or publishes the release may read: $(printf '%s\n' "$names" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
		rc=1
	else
		echo "sami-build.yml: no line outside a comment names the gate's build seed"
	fi
	if ! grep -qxE 'cache-mode: *none' "$checks"; then
		echo "$checks has no workflow-level cache-mode: none"
		rc=1
	fi
	jobs="$(awk '/^jobs:$/ { on = 1; next } on && /^[^ #]/ { exit } on && /^  [A-Za-z_][A-Za-z0-9_-]*:$/ { sub(/^  /, ""); sub(/:$/, ""); print }' "$checks")"
	bad="$(awk '/^jobs:$/ { on = 1; next } on && /^[^ #]/ { exit } on && /^  [^ #]/ && !/^  [A-Za-z_][A-Za-z0-9_-]*:$/' "$checks")"
	if [ -n "$bad" ]; then
		echo "UNKNOWN: $checks has a job line this lint cannot read: $bad"
		return 1
	fi
	for job in seed-linux seed-macos rust-test rust-test-macos rust-test-cold; do
		printf '%s\n' "$jobs" | grep -qxF "$job" || { echo "UNKNOWN: $checks has no $job job"; return 1; }
	done
	for job in $jobs; do
		awk -v j="  $job:" '$0 == j { on = 1; next } on && (/^  [A-Za-z_][A-Za-z0-9_-]*:$/ || /^[^ #]/) { exit } on' "$checks" >"$scratch/seed-job.yml"
		modes="$(grep -vE '^ *#' "$scratch/seed-job.yml" | grep -F 'cache-mode' | grep -vxF '    cache-mode: none' || true)"
		if [ -n "$modes" ]; then
			echo "$job has a cache-mode line other than [    cache-mode: none]: $(printf '%s\n' "$modes" | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
			rc=1
		fi
		if grep -vE '^ *#' "$scratch/seed-job.yml" | grep -qE 'uses: *actions/cache'; then
			echo "$job has an actions/cache step"
			rc=1
		fi
		if grep -qF 'uses: ./.github/workflows/sami-rust-test.yml' "$scratch/seed-job.yml"; then
			if ! grep -qxF '    cache-mode: none' "$scratch/seed-job.yml"; then
				echo "$job calls the Rust gate's workflow without cache-mode: none, so its jobs would take this run's mode"
				rc=1
			fi
			calls="$calls$(awk '/^      job: / { j = $2 } /^      control: / { c = $2 }
				END { printf "%s/control=%s", (j == "" ? "none" : j), (c == "" ? "false" : c) }' "$scratch/seed-job.yml")"$'\n'
		fi
	done
	steps="$(awk '/^      - / { if (s != "") print s; s = "" } { s = s $0 "\\n" } END { if (s != "") print s }' "$checks")"
	seeds="$(printf '%s\n' "$steps" | grep -F 'name: sc-seed-' || true)"
	n="$(printf '%s' "$seeds" | grep -c . || true)"
	if [ "$n" != 2 ]; then
		echo "UNKNOWN: $checks has $n steps naming a sc-seed- artifact, not the two seed uploads"
		return 1
	fi
	# Each step is one line with its own lines joined by a literal \n, so the
	# day count ends at that separator: `retention-days: 30` is not 3.
	if printf '%s\n' "$seeds" | grep -vE 'retention-days: 3\\n' | grep -q .; then
		echo "a seed artifact is not kept 3 days: $(printf '%s\n' "$seeds" | grep -vE 'retention-days: 3\\n' | sed 's/\\n/ /g' | awk '{ printf "%s[%s]", (NR > 1 ? " " : ""), $0 }')"
		rc=1
	fi
	# Two calls of the Rust gate's workflow in one run upload the artifacts of the job they ask
	# for, so each call's (job, control) pair must be its own: two calls with one pair make one
	# upload fail, and leave the drift check reading whichever listing landed first.
	dup="$(printf '%s' "$calls" | grep -v '^$' | LC_ALL=C sort | LC_ALL=C uniq -d || true)"
	if [ -n "$dup" ]; then
		echo "two jobs call the Rust gate's workflow with one job and control: $(printf '%s\n' "$dup" | tr '\n' ' '); their artifacts would share a name"
		rc=1
	fi
	if [ "$rc" = 0 ]; then
		echo "sami-checks.yml: cache-mode none, and no job sets another or has an actions/cache step; each call of the Rust gate passes none on; both seed artifacts are kept 3 days; its calls of the Rust gate are $(printf '%s' "$calls" | grep -v '^$' | tr '\n' ' ')"
	fi
	return "$rc"
}
# ylint <name> <want> <message regex> <sed for sami-build.yml> <sed for sami-checks.yml>
ylint() {
	local name="$1" want="$2" msg="$3" w out rc
	if [ -n "$only" ] && ! [[ "$name" =~ $only ]]; then return 0; fi
	w="$(mktemp -d "$scratch/ylint.XXXXXX")"
	sed -e "${4:-p;d}" "$repo/.github/workflows/sami-build.yml" >"$w/sami-build.yml"
	sed -e "${5:-p;d}" "$repo/.github/workflows/sami-checks.yml" >"$w/sami-checks.yml"
	out="$(seed_lint "$w/sami-build.yml" "$w/sami-checks.yml" 2>&1)"
	rc=$?
	verdict "$name" "$want" "$rc" "$msg" "$out"
}
NOT_MSG='UNKNOWN' ylint Y1-the-release-reads-no-seed 0 'sami-build.yml: no line outside a comment names the gate.s build seed'
ylint Y2-release-binary-downloads-a-seed 1 'sami-build.yml names the gate.s build seed.*name: sc-seed-linux' 's|^      - name: Restore the release build cache$|      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\n        with:\n          name: sc-seed-linux\n&|'
ylint Y3-publish-downloads-a-seed 1 'sami-build.yml names the gate.s build seed.*pattern: sc-seed' 's|^          pattern: mise-\*$|          pattern: sc-seed-*|'
NOT_MSG='UNKNOWN' ylint Y4-the-checks-run-holds-no-cache-token 0 'sami-checks.yml: cache-mode none, and no job sets another'
ylint Y5-a-seed-job-with-a-cache-mode 1 'seed-linux has a cache-mode line other than \[    cache-mode: none\]: \[    cache-mode: read\]' '' 's/^  seed-linux:$/&\n    cache-mode: read/'
ylint Y6-a-gate-call-without-cache-mode 1 'rust-test calls the Rust gate.s workflow without cache-mode: none' '' '/^  rust-test:$/,/^  rust-test-macos:$/{/^    cache-mode: none$/d;}'
ylint Y7-the-checks-workflow-cache-mode 1 'has no workflow-level cache-mode: none' '' 's/^cache-mode: none$/cache-mode: read/'
ylint Y8-a-seed-job-with-a-cache-step 1 'seed-macos has an actions/cache step' '' 's|^  seed-macos:$|&\n    steps:\n      - uses: actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830|'
ylint Y9-a-seed-artifact-kept-longer 1 'a seed artifact is not kept 3 days' '' '/^  seed-linux:$/,/^  seed-macos:$/s/^          retention-days: 3$/          retention-days: 30/'
ylint Y10-a-seed-upload-renamed 1 'UNKNOWN: .*has 1 steps naming a sc-seed- artifact, not the two seed uploads' '' 's/^          name: sc-seed-macos$/          name: seed-macos/'
# The harness runs on macOS too, whose sed reads `d}` as one word: the ; is for it.
ylint Y11-two-gate-calls-with-one-job-and-control 1 'two jobs call the Rust gate.s workflow with one job and control: linux/control=false' '' '/^  rust-test-cold:$/,/^  rust-test-compare:$/{/^      control: true$/d;}'
NOT_MSG='UNKNOWN' ylint Y12-the-calls-are-named 0 'its calls of the Rust gate are linux/control=false macos/control=false linux/control=true'

echo "rust_test job scripts: $pass passed, $fail failed, $skip skipped"
[ "$fail" = 0 ] && [ "$pass" -gt 0 ]
