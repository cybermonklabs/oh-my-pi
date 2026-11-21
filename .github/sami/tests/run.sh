#!/usr/bin/env bash
# Regression tests for the rust_test job's scripts in .github/sami, with no
# network, Bazel or cargo: the job runs this before its build.
#   - rust-test.sh, the test step, against stubs of bazelisk and rustup. The
#     bazelisk stub checks each invocation's arguments, then writes the build
#     event log and the test logs a case describes, laid out as Bazel lays
#     them out, with a test binary beside each log that lists its tests.
#   - fetch-verified.sh, with a stub in place of curl.
#   - rust-test-parity.sh, against stubs of cargo and bazelisk query.
#   - rust-test-tmpdir.sh.
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
summary() { # label status [failed log] [passed log]
	jq -cn --arg l "$1" --arg s "$2" --arg f "${3:-}" --arg p "${4:-}" '{id:{testSummary:{label:$l,configuration:{id:"c"}}},testSummary:({overallStatus:$s,totalRunCount:1}
		+ (if $p != "" then {passed:[{name:"test.log",uri:("file://" + $p)}]} else {} end)
		+ (if $f != "" then {failed:[{name:"test.log",uri:("file://" + $f)}]} else {} end))}'
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
# record_names <log>: the tests a libtest record reports.
record_names() { jq -R -r 'fromjson? | select(type == "object" and .type == "test" and (.event == "ok" or .event == "failed" or .event == "ignored")) | .name' "$1"; }
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
# Environment of a case: KNOWN_SKIPS, KNOWN_OUTPUT, SANCTIONED, OWN,
# IGNORED_RUN, IGNORED_ROOT, CHILD_ENTRIES, MACOS, ONLY (lines of `<target>
# <name>`; ONLY sets RUST_TEST_ONLY, with CANARY as RUST_TEST_CANARY), ROOTS
# and ROOT_COUNT, ROOT_BODY, OWN_BODY, IGN_BODY and IGN_ROOT_BODY (the stub's
# answer to those invocations), OWN_TESTS and OWN_PRINTS (for own_default),
# MAIN_MUST_SKIP, CARGO_MODE, CARGO_WS, NOT_MSG (a regex the output must not
# match).
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
	list rust-test-root-targets.txt "${ROOTS:+$ROOTS ${ROOT_COUNT:-2}}" "why"
	list rust-test-known-skips.txt "${KNOWN_SKIPS:-}" "reason"
	list rust-test-known-output.txt "${KNOWN_OUTPUT:-}" "prints a summary; no skip"
	list rust-test-sanctioned-skips.txt "${SANCTIONED:-}" "ruling"
	list rust-test-own-process.txt "${OWN:-}" "why"
	list rust-test-ignored.txt "${IGNORED_RUN:-}" "why"
	list rust-test-ignored-root.txt "${IGNORED_ROOT:-}" "why"
	list rust-test-child-entries.txt "${CHILD_ENTRIES:-}" "the parent test"
	list rust-test-macos.txt "${MACOS:-}" "macOS only"
	local only_env=()
	if [ -n "${ONLY:-}" ]; then
		list only.txt "$ONLY" "macOS only"
		only_env=(RUST_TEST_ONLY=.github/sami/only.txt RUST_TEST_CANARY="${CANARY:-}")
	fi
	printf '[toolchain]\nchannel = "nightly-2026-11-08"\n' >"$w/repo/rust-toolchain.toml"
	printf '# list\n%s\n' "${CARGO_WS:-sdk/rust/demo/Cargo.toml  standalone}" >"$w/repo/.github/sami/rust-test-cargo-workspaces.txt"
	cat >"$w/bin/bazelisk" <<EOF
#!/usr/bin/env bash
set -u
W="$w"
logs="$w/logs"
OWN_TESTS="${OWN_TESTS:-}"
OWN_PRINTS="${OWN_PRINTS:-}"
$(declare -f lt_pass lt_fail lt_out lt_ignored lt_partial lt_child_summary doc_pass doc_fail cfg summary tpath bpath fakebin record_names target rt dt nt listed sanct query_names own_default)
args=("\$@")
if [ "\${args[0]#--bazelrc=}" != "\${args[0]}" ]; then args=("\${args[@]:1}"); fi
if [ "\${args[0]}" = query ]; then
	out=""
	for a in "\${args[@]}"; do case "\$a" in --output=*) out="\${a#*=}" ;; esac; done
	rc="\$(cat "\$W/query.rc" 2>/dev/null || echo 0)"
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
[ "\${args[0]}" = test ] || { echo "stub: bazelisk \${args[*]}" >&2; exit 2; }
bep="" under="" names=() targets=() ignored=0
for ((i = 0; i < \${#args[@]}; i++)); do
	case "\${args[i]}" in
		--build_event_json_file=*) bep="\${args[i]#*=}" ;;
		--run_under=*) under="\${args[i]#*=}" ;;
		--test_arg=--ignored) ignored=1 ;;
		--test_arg=--exact)
			for ((j = i + 1; j < \${#args[@]}; j++)); do
				case "\${args[j]}" in --test_arg=-*) break ;; --test_arg=*) names+=("\${args[j]#--test_arg=}") ;; *) break ;; esac
			done
			;;
		--) targets=("\${args[@]:i + 1}"); break ;;
	esac
done
printf '%s\n' "\$bep" >>"\$W/bep.paths"
inv=main
case "\$under" in sudo*) inv=root ;; esac
if [ "\${#names[@]}" -gt 0 ]; then
	if [ "\$ignored" = 1 ]; then
		[ "\$inv" = root ] && inv=ignored-root || inv=ignored
	else
		inv=own
	fi
fi
has() { case " \${args[*]} " in *" \$1 "*) return 0 ;; esac; echo "stub: bazel test (\$inv) lacks \$1" >&2; exit 2; }
has --keep_going
has "--test_arg=-Zunstable-options --test_arg=--format=json --test_arg=--show-output"
if [ "${LEGACY:-0}" != 1 ]; then
	has --test_env=PATH=\$RUST_TEST_PATH
	has --test_env=RSYNC_REFERENCE_REQUIRED=1
	has --test_env=PI_TEST_REAL_BASH=\$PI_TEST_REAL_BASH
	has --test_env=PI_AST_REPO_CORPUS=\$PI_AST_REPO_CORPUS
	has --sandbox_writable_path=\$RUST_TEST_TMPDIR
	want_under="/bin/sh $w/repo/.github/sami/rust-test-tmpdir.sh \$RUST_TEST_TMPDIR"
	[ "\$inv" = root ] || [ "\$inv" = ignored-root ] && want_under="sudo -E env PATH=\$RUST_TEST_PATH \$want_under"
	[ "\$under" = "\$want_under" ] || { echo "stub: bazel test (\$inv) runs under [\$under], not [\$want_under]" >&2; exit 2; }
fi
case "\$inv" in ignored | ignored-root) has --test_timeout=1200 ;; esac
[ "\$inv" = ignored-root ] && has --strategy=TestRunner=local
if [ "\$inv" = main ]; then
	[ "\${targets[0]:-}" = //crates/... ] || { echo "stub: main run's targets are [\${targets[*]}]" >&2; exit 2; }
	for r in ${ROOTS:-}; do has "-\$r"; done
	for s in ${MAIN_MUST_SKIP:-}; do has "--test_arg=--skip --test_arg=\$s"; done
elif [ "\$inv" = root ]; then
	$(printf '%s' "${ROOT_BODY:-exit 9}")
else
	[ "\${#targets[@]}" = 1 ] || { echo "stub: \$inv run's targets are [\${targets[*]}]" >&2; exit 2; }
	OWN_NAMES=("\${names[@]}") OWN_NAME="\${names[0]}" OWN_TARGET="\${targets[0]}"
	case "\$inv" in
		own) $(printf '%s' "${OWN_BODY:-own_default}") ;;
		ignored) $(printf '%s' "${IGN_BODY:-own_default}") ;;
		ignored-root) $(printf '%s' "${IGN_ROOT_BODY:-own_default}") ;;
	esac
fi
FMT=text
for a in "\${args[@]}"; do [ "\$a" = --test_arg=--format=json ] && FMT=json; done
$body
EOF
	chmod +x "$w/bin/bazelisk"
	# The cargo workspaces: a rustup stub whose `run <channel> cargo` answers
	# metadata and test from CARGO_MODE (pass, fail-lib, partial-test,
	# meta-fail, empty, stderr-skip, stderr-skip-named, filtered).
	cat >"$w/bin/rustup" <<EOF
#!/usr/bin/env bash
set -u
case "\$1" in toolchain) exit 0 ;; run) shift 2 ;; *) exit 1 ;; esac
mode="${CARGO_MODE:-pass}"
FMT=json
$(declare -f lt_pass lt_fail lt_partial)
if [ "\$2" = metadata ]; then
	[ "\$mode" = meta-fail ] && { echo "error: boom" >&2; exit 101; }
	if [ "\$mode" = empty ]; then echo '{"packages":[]}'; exit 0; fi
	echo '{"packages":[{"name":"demo","targets":[{"name":"demo","kind":["lib"],"crate_types":["lib"],"test":true,"doctest":true},{"name":"wire","kind":["test"],"crate_types":["bin"],"test":true,"doctest":false}]}]}'
	exit 0
fi
sel=""; for a in "\$@"; do case "\$a" in --lib|--doc|--test) sel="\$a" ;; esac; done
echo "   Compiling demo v0.1.0" >&2
case "\$mode:\$sel" in
	fail-lib:--lib) lt_fail demo::broken; exit 101 ;;
	partial-test:--test) lt_partial; exit 0 ;;
	stderr-skip:--test) echo "skipped: no bun on PATH" >&2; lt_pass a::one a::two; exit 0 ;;
	stderr-skip-named:--test) echo "a::two: skipped: no bun on PATH" >&2; lt_pass a::one a::two; exit 0 ;;
	filtered:--test) FILTERED=1 lt_pass a::one; exit 0 ;;
	*:--doc) printf '{ "type": "suite", "event": "started", "test_count": 0 }\n{ "type": "suite", "event": "ok", "passed": 0, "failed": 0, "ignored": 0, "measured": 0, "filtered_out": 0, "exec_time": 0.0 }\n'; exit 0 ;;
	*) lt_pass a::one a::two; exit 0 ;;
esac
EOF
	chmod +x "$w/bin/rustup"
	local out rc
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null \
		RUST_TEST_PATH=/stub/rsync-ref/bin:/usr/bin:/bin RUST_TEST_TMPDIR="$w/reflink" PI_TEST_REAL_BASH=/stub/bash-ref/bin/bash PI_AST_REPO_CORPUS="$w/repo" \
		env ${only_env[@]+"${only_env[@]}"} bash --noprofile --norc -eo pipefail "$step" 2>&1)"
	rc=$?
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
CHILD_ENTRIES="$D t::c_ignored" run J30-real-libtest-fail-listed 0 'Known failure, failed as expected: //crates/pi-diff:pi-diff_test t::b_fails' "$D t::b_fails" "{ $P; rt $D FAILED cat $fixtures/fail.json; } >\"\$bep\"; exit 3"
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
run J39-doctest-one-test-header 0 '' '' "{ $P; dt $DOC PASSED printf 'running 1 test\ntest a ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'; } >\"\$bep\"; exit 0"

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

# The root-only targets: run in a second invocation under sudo.
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-root.json >\"\$bep\"; exit 0" run J48-root-target-runs-as-root 0 '' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-nonroot.json >\"\$bep\"; exit 0" run J49-root-target-not-run 1 "$RT t::needs_root printed 'not run:', though it runs as root" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="exit 9" run J50-root-run-tool-error 1 'bazel test exited 9' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT FAILED lt_fail r::broken >\"\$bep\"; exit 3" run J51-root-target-fails 1 "$RT r::broken failed and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY=": >\"\$bep\"; exit 0" run J52-root-run-no-result 1 "$RT is a test target, but bazel test has no result" '' "query_names $PR $D $RT; { $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
run J53-not-run-outside-root-targets-is-a-skip 1 "$D t::needs_root skipped itself and is not in" '' "{ $P; rt $D PASSED cat $fixtures/root-nonroot.json; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_COUNT=3 ROOT_BODY="FMT=json; rt $RT PASSED cat $fixtures/root-root.json >\"\$bep\"; exit 0" run J54-root-count-mismatch 1 "$RT passed 2 tests, and .github/sami/rust-test-root-targets.txt names 3" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
ROOTS=$RT ROOT_BODY="FMT=json; rt $RT PASSED sh -c 'cat $fixtures/root-root.json; echo \"t::needs_root: not run: written to fd 2\"' >\"\$bep\"; exit 0" run J55-root-raw-not-run 1 "printed 'not run:' outside libtest's record" '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
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
run J89-list-line-without-name 1 'rust-test-known-failures.txt has a line without its fields' "$B" "{ $P; rt $B PASSED lt_pass x::a; } >\"\$bep\"; exit 0"

# The accounting: a filter in a target's args, or a skip, that takes a test
# out of every invocation.
run J90-positional-filter-drops-tests 1 "$D d::two ran in no invocation" '' "{ $P; listed $D d::one d::two -- d::one; } >\"\$bep\"; exit 0"
run J91-filtered-out-disagrees-with-listing 1 "$D \\(main\\) reported 1 tests and filtered out 0, but its binary lists 2" '' "{ $P; fakebin $D d::one d::two; rt $D PASSED lt_pass d::one; } >\"\$bep\"; exit 0"
run J92-unlistable-binary 1 "binary .* cannot list its tests" '' "{ $P; f=\"\$(tpath $D)\"; mkdir -p \"\$(dirname \"\$f\")\"; FMT=json lt_pass d::one >\"\$f\"; cfg $D 'rust_test rule'; summary $D PASSED '' \"\$f\"; } >\"\$bep\"; exit 0"
# A log that ended early (a timeout) is named once; the accounting leaves its
# binary out rather than blame a filter.
NOT_MSG='ran in no invocation|but its binary lists' run J94-timeout-named-once 1 "$D is TIMEOUT, but libtest planned 2 tests and reported 0" '' "{ $P; fakebin $D d::one d::two d::three; rt $D TIMEOUT lt_partial; } >\"\$bep\"; exit 3"

# #[ignore]d tests: each runs alone (--ignored), as root where it needs root,
# or is a child entry point, or runs in the macOS job; any other fails.
IGN="rt $D PASSED lt_ignored d::one d::needs_network"
run J93-ignored-test-runs-nowhere 1 "$D d::needs_network is #\\[ignore\\]d and runs in no invocation" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network" run J95-ignored-child-entry 0 "a child process's entry point another test starts: $D d::needs_network" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
MACOS="$D d::needs_network" run J96-ignored-runs-on-macos 0 "run by the macOS job: $D d::needs_network" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
CHILD_ENTRIES="$D d::needs_network
$D d::one" run J97-child-entry-that-ran 1 "$D d::one is in .github/sami/rust-test-child-entries.txt but is no #\\[ignore\\]d test" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_RUN="$D d::needs_network" OWN_TESTS="d::one d::needs_network" run J98-ignored-test-run-alone 0 "Ignored test ran alone: $D d::needs_network \\(ok\\)" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_RUN="$D d::renamed" OWN_TESTS="d::one d::needs_network" run J99-ignored-run-matches-nothing 1 "own invocation for d::renamed reported \\[\\]" '' "{ $P; $IGN; } >\"\$bep\"; exit 0"
IGNORED_ROOT="$B r::cycle" OWN_TESTS="a::one r::cycle" run J100-ignored-root-run-alone 0 "Ignored root test ran alone: $B r::cycle \\(ok\\)" '' "{ $P; rt $B PASSED lt_ignored a::one r::cycle; } >\"\$bep\"; exit 0"
IGNORED_ROOT="$B r::cycle" IGN_ROOT_BODY="FMT=json; rt $B FAILED printf '{ \"type\": \"suite\", \"event\": \"started\", \"test_count\": 1 }\n{ \"type\": \"test\", \"name\": \"r::cycle\", \"event\": \"failed\", \"stdout\": \"mount --bind failed\" }\n{ \"type\": \"suite\", \"event\": \"failed\", \"passed\": 0, \"failed\": 1, \"ignored\": 0, \"measured\": 0, \"filtered_out\": 1, \"exec_time\": 0.0 }\n' >\"\$bep\"; exit 3" run J101-ignored-root-failing-body 1 "$B r::cycle failed and is not in" '' "{ $P; rt $B PASSED lt_ignored a::one r::cycle; } >\"\$bep\"; exit 0"

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
fetch F3-checksum-mismatch-then-good 0 '::warning title=Tarball::https://a/t gave no tarball' https://a/t=bad https://b/t=ok
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

# --- rust-test-parity.sh ---------------------------------------------------------
# prun <name> <want> <message regex> <rules: JSON lines>: the parity script in
# a repository with one package, demo (a library with tests and doctests),
# against stubs of cargo metadata and bazel query.
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
		{ echo '# sanctioned'; [ -n "${PARITY_SANCTIONED:-}" ] && printf '%s  ruling\n' "$PARITY_SANCTIONED"; } >.github/sami/rust-test-sanctioned-skips.txt
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
PARITY_WS='# none' prun P4-cargo-toml-unlisted 1 'sdk/rust/x/Cargo.toml is outside the root workspace and not in' "$(covered)"
prun P5-skip-covered-by-another-target 0 "Skips in test targets' args: 1, 0 run nowhere" "$(covered "$(strs args --skip ::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args ::slow::)")"
prun P6-skip-uncovered 1 "//crates/demo:demo_test's args skip ::slow::, and no other test target of that binary runs it" "$(covered "$(strs args --skip ::slow::)")"
prun P7-skip-equals-spelling-uncovered 1 "//crates/demo:demo_test's args skip ::slow::, and no other test target" "$(covered "$(strs args --skip=::slow::)")"
prun P8-skip-equals-spelling-covered 0 "Skips in test targets' args: 1, 0 run nowhere" "$(covered "$(strs args --skip=::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/demo:demo_test)" "$(strs args ::slow::)")"
PARITY_SANCTIONED='//crates/demo:demo_test x::flaky' prun P9-sanctioned-skip-in-args 0 'Sanctioned skip in //crates/demo:demo_test.s args: x::flaky' "$(covered "$(strs args --skip x::flaky)")"
prun P10-filter-of-another-binary-does-not-cover 1 "//crates/demo:demo_test's args skip ::slow::" "$(covered "$(strs args --skip ::slow::)")
$(rule native_test //crates/demo:slow_test "$(str src //crates/other:other_test)" "$(strs args ::slow::)")"
prun P11-query-names-no-rust-test 1 'bazel query names no crate root of any rust_test' "$LIB"

echo "rust_test job scripts: $pass passed, $fail failed"
[ "$fail" = 0 ] && [ "$pass" -gt 0 ]
