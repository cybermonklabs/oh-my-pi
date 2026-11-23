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
#   - rust-test-tmpdir.sh.
#   - release-candidate.sh, publish's checks, by release-candidate-harness.sh
#     with a stub in place of gh (cases RC-*).
#   - sami-build.yml and .github/actions/bun-install: only release_binary
#     may use the GitHub Actions cache, only release_cache_prune may hold
#     actions: write and only attest id-token: write, and neither runs
#     member code (cache_lint); and sami-rust-test.yml, whose jobs run the
#     tests: none of them may use the cache or hold either permission.
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
# Environment of a case: KNOWN_SKIPS, KNOWN_OUTPUT, SANCTIONED, OWN,
# IGNORED_RUN, IGNORED_ROOT, CHILD_ENTRIES, MACOS, ONLY (lines of `<target>
# <name>`; ONLY sets RUST_TEST_ONLY, with CANARY as RUST_TEST_CANARY), ROOTS
# and ROOT_COUNT, ROOT_BODY, OWN_BODY, IGN_BODY, IGN_ROOT_BODY, STICKY_BODY
# and STICKY_ROOT_BODY (the stub's answer to those invocations), OWN_TESTS and
# OWN_PRINTS (for own_default), MAIN_MUST_SKIP, CARGO_MODE, CARGO_WS,
# STICKY_FIFO (`none`: RUST_TEST_STICKY_FIFO names no FIFO), JQ_FAIL (jq exits
# 5 after any run whose arguments hold this text), RAW_LIST (a
# rust-test-known-raw-output.txt to use in place of KNOWN_RAW's),
# SANCTIONED_LINE (a line written as it is after SANCTIONED's), NOT_MSG (a
# regex the output must not match).
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
	if [ -n "${SANCTIONED_LINE:-}" ]; then printf '%s\n' "$SANCTIONED_LINE" >>"$w/repo/.github/sami/rust-test-sanctioned-skips.txt"; fi
	list rust-test-own-process.txt "${OWN:-}" "why"
	list rust-test-ignored.txt "${IGNORED_RUN:-}" "why"
	list rust-test-ignored-root.txt "${IGNORED_ROOT:-}" "why"
	list rust-test-child-entries.txt "${CHILD_ENTRIES:-}" "the parent test"
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
	printf '[toolchain]\nchannel = "nightly-2026-11-08"\n' >"$w/repo/rust-toolchain.toml"
	printf '# list\n%s\n' "${CARGO_WS:-sdk/rust/demo/Cargo.toml  standalone}" >"$w/repo/.github/sami/rust-test-cargo-workspaces.txt"
	# DOCQ: the doctest targets bazel query names (the macOS job asks it).
	if [ -n "${DOCQ:-}" ]; then printf '%s\n' "$DOCQ" >"$w/docquery.txt"; fi
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
[ "\${args[0]}" = test ] || { echo "stub: bazelisk \${args[*]}" >&2; exit 2; }
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
printf '%s\n' "\$bep" >>"\$W/bep.paths"
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
	[ "\$inv" = root ] || [ "\$inv" = ignored-root ] || [ "\$inv" = sticky-root ] && want_under="sudo -E env PATH=\$RUST_TEST_PATH \$want_under"
	[ "\$under" = "\$want_under" ] || { echo "stub: bazel test (\$inv) runs under [\$under], not [\$want_under]" >&2; exit 2; }
	[ "\$inv" != main ] || has "--test_arg=--skip --test_arg=refused_in_a_sticky_directory"
	[ "\$inv" != sticky-user ] || [ "\$fifo" = "\$RUST_TEST_STICKY_FIFO" ] || { echo "stub: bazel test (\$inv) gives PI_TEST_STICKY_FIFO=[\$fifo], not [\$RUST_TEST_STICKY_FIFO]" >&2; exit 2; }
	[ "\$inv" = sticky-user ] || [ -z "\$fifo" ] || { echo "stub: bazel test (\$inv) gives PI_TEST_STICKY_FIFO" >&2; exit 2; }
fi
case "\$inv" in ignored | ignored-root) has --test_timeout=1200 ;; esac
case "\$inv" in ignored-root | sticky-user | sticky-root) has --strategy=TestRunner=local ;; esac
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
	# #[ignore]d test a::slow alone.
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
# cargo names each test binary it runs; what follows on stderr is the binary's.
[ "\$sel" = --doc ] || echo "     Running tests/wire.rs (target/debug/deps/wire-0)" >&2
if [ "\$sel" = --doc ]; then
	case " \${RUSTDOCFLAGS:-} " in *" -Zunstable-options --no-capture "*) ;; *) echo "stub: cargo test --doc without RUSTDOCFLAGS --no-capture (\${RUSTDOCFLAGS:-})" >&2; exit 2 ;; esac
	[ "\$threads" = 1 ] || { echo "stub: cargo test --doc without --test-threads=1" >&2; exit 2; }
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
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null \
		RUST_TEST_PATH=/stub/rsync-ref/bin:/usr/bin:/bin RUST_TEST_TMPDIR="$w/reflink" PI_TEST_REAL_BASH=/stub/bash-ref/bin/bash PI_AST_REPO_CORPUS="$w/repo" RUST_TEST_OFFLINE_UNDER="$w/bin/offline" \
		RUST_TEST_STICKY_FIFO="$fifo" \
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
# B3: a doctest's output is read: the crate's doctests run again under cargo,
# with rustdoc's --no-capture and one thread, and the lines printed between a
# doctest's start and its result are its output (stdout and stderr).
CARGO_MODE=doc-skip run J107-crate-doctest-skips-itself 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) skipped itself and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=doc-raw-skip run J110-doctest-raw-skip-line 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) skipped itself and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=doc-raw-print run J111-doctest-raw-output 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in .github/sami/rust-test-known-output.txt" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
run J107b-crate-doctests-run-under-cargo 0 '' '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
# B4: the listings the macOS job's inventory reads.
run J108-listings-for-macos 0 'Listings for the macOS inventory: 2 binaries' '' "{ $P; rt $D PASSED lt_pass a::one; } >\"\$bep\"; exit 0"
# R3: cargo's readable doctest run must have run the same doctests as Bazel's
# doctest target of the crate, both ways.
CARGO_MODE=doc-empty run J113b-bazel-doctest-without-cargo-counterpart 1 "crates/pi-diff src/lib.rs - f \\(line 3\\) ran in Bazel's doctest target and not in cargo's doctest run" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=doc-extra run J114-cargo-doctest-without-bazel-counterpart 1 "crates/pi-diff src/lib.rs - h \\(line 20\\) ran in cargo's doctest run and not in Bazel's doctest target" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
run J115-doctests-match 0 "Doctests that ran in Bazel and in cargo's readable re-run: 1" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
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
CARGO_MODE=doc-raw-nonl NOT_MSG='ended before' run J129-doctest-output-without-newline-fails 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in .github/sami/rust-test-known-output.txt" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
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
# From the Claude-family review of 6b0eca04: doc_attribute uses the same event
# test, so a doctest that prints an object that only names its type printed;
# a bench-typed object with no result's fields, an array and a number are
# output too.
CARGO_MODE=doc-typed run J135-doctest-prints-typed-test-object 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
CARGO_MODE=doc-typed-suite run J136-doctest-prints-typed-suite-object 1 "crates/pi-diff:doc src/lib.rs - f \\(line 3\\) printed and is not in" '' "{ $P; rt $D PASSED lt_pass a::one; dt $DOC PASSED doc_pass; } >\"\$bep\"; exit 0"
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

# --- rust-test-macos-inventory.sh ------------------------------------------------
# irun <name> <want> <message regex> <targets> <mac binaries> <linux listings>
# <named>: the inventory against stubs of bazelisk query, build and info.
# <targets>: the rust_test labels the query names, one per line. <mac
# binaries> and <linux listings>: lines of `<label> <test>...` (a label with
# no test has a binary that lists none; a label absent has no binary, or no
# Linux listing). <named>: rust-test-macos.txt's lines `<label> <test>`.
# LINUX_INDEX=none leaves the Linux listings out. NAMED_LINE, a line written
# as it is after <named>'s. The output names the inventory file's lines.
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
	out="$(cd "$w/repo" && PATH="$w/bin:${TOOLBIN:+$TOOLBIN:}$PATH" RUNNER_TEMP="$w/tmp" OMP_BAZEL_RC=/dev/null bash "$repo/.github/sami/rust-test-macos-inventory.sh" "$w/linux" "$w/inventory.txt" 2>&1; echo "--- inventory"; cat "$w/inventory.txt" 2>/dev/null)"
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
irun I4-target-linux-did-not-list 0 "$T2 b::mac  compiled only on macOS" "$T1
$T2" "$T1 a::one
$T2 b::mac" "$T1 a::one" "$T1 a::one"
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
# sami-candidate); such code could save an entry for that ref (one no run
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
# saves only on a push to sami-candidate, the ref the release is built on:
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
# sami-candidate test; its one block-style artifact-ids line names exactly
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
	local push_guard='\\n        if: \$\{\{ github\.event_name == '"'"'push'"'"' && github\.ref == '"'"'refs/heads/sami-candidate'"'"' && [^|\\$}]*\}\}\\n(        [^ \\].*)?$'
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
				echo "release_binary saves a cache on an event other than a push to sami-candidate"
				ok=0
			fi
			if [ "$ok" = 1 ]; then
				echo "release_binary: save steps: $ns, each only on a push to sami-candidate; bun-install steps: $n, each with cache: \"false\""
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
				# The job's if: is exactly the push-to-sami-candidate test, and
				# no step has an if: of its own or continue-on-error: either
				# could leave a file unattested in a green run.
				want_if="    if: \${{ github.event_name == 'push' && github.ref == 'refs/heads/sami-candidate' }}"
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
				echo "attest: only actions/download-artifact and actions/attest-build-provenance, pinned by commit; no run step; no other run, repository or token; downloads by artifact id; if: a push to sami-candidate; artifact-ids: the upload steps' three ids; one attest step per release file"
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
wlint W1-release-binary-cache-rule 0 'release_binary: save steps: 1, each only on a push to sami-candidate; bun-install steps: 1, each with cache: "false"' '' ''
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
# release_binary saves only on a push to sami-candidate; a dispatch, a pull
# request, a push to another ref or any other event only restores.
wlint W14-release-binary-save-unguarded 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/github.event_name == 'push' && github.ref == 'refs\/heads\/sami-candidate' && //" ''
wlint W15-release-binary-save-on-dispatch 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/github.event_name == 'push'/github.event_name == 'workflow_dispatch'/" ''
wlint W16-release-binary-save-on-pull-request 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/github.event_name == 'push'/github.event_name == 'pull_request'/" ''
wlint W17-release-binary-save-or 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s#github.ref == 'refs/heads/sami-candidate' &&#github.ref == 'refs/heads/sami-candidate' ||#" ''
wlint W18-release-binary-post-save-step 1 'release_binary has an actions/cache step that saves in its post step' 's|uses: actions/cache/restore@|uses: actions/cache@|' ''
wlint W19-release-binary-save-or-after-guard 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}/steps.release-cache-bound.outputs.save == 'true' || github.event_name == 'workflow_dispatch' }}/" ''
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
wlint W26-release-binary-save-text-after-the-expression 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}\$/& \\&\\& \${{ !cancelled() }}/" ''
wlint W27-release-binary-save-text-on-a-folded-line 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/steps.release-cache-bound.outputs.save == 'true' }}\$/&\\n          \\&\\& \${{ !cancelled() }}/" ''
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
# sami-candidate (W38).
wlint W38-release-binary-save-on-sami 1 'release_binary saves a cache on an event other than a push to sami-candidate$' "s/github.ref == 'refs\/heads\/sami-candidate' \&\& !cancelled() \&\& steps.release-cache-bound/github.ref == 'refs\/heads\/sami' \&\& !cancelled() \&\& steps.release-cache-bound/" ''
# attest holds id-token: write, so it runs no member code: no action but
# download-artifact and attest-build-provenance (W40), each pinned by commit
# (W51), no run step (W41, W48 in flow style), no download of another run's
# artifacts (W42, W49 in flow style), and no download by name or pattern
# (W50; W52 with artifact-ids only in a comment, W53 with an empty one). No
# other job (W43, W45 by write-all, W47; in sami-rust-test.yml, W46 with
# the value on the next line) and not the workflow (W44) names an id-token
# permission other than read or none. attest runs only on a push to
# sami-candidate (W54 without the event test, W55 with ||), downloads
# exactly the upload steps'
# three ids by their needs outputs (W56 another output, W57 a literal id),
# which are the upload steps' artifact ids (W60), and attests each release
# file in a step of its own with one path (W58 two paths in one step, W59 the
# notes' step gone), with no step skipped by an if: (W61) or let fail by
# continue-on-error (W62), no line that YAML would fold into the if: (W63),
# the artifact-ids (W64) or a subject-path (W65), and no quote or # on the
# artifact-ids line (W66 " #,<id>" inside quotes, W67 the quoted value
# continued on a line that starts with #).
wlint W39-attest-rule 0 "attest: only actions/download-artifact and actions/attest-build-provenance, pinned by commit; no run step; no other run, repository or token; downloads by artifact id; if: a push to sami-candidate; artifact-ids: the upload steps' three ids; one attest step per release file" '' ''
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
wlint W54-attest-if-without-the-event 1 "so it could attest on another event or ref: \\[    if: .\\{\\{ github\\.ref == 'refs/heads/sami-candidate' \\}\\}\\]\$" "/^  attest:\$/,/^  release_cache_prune:\$/s/^    if: \${{ github.event_name == 'push' && /    if: \${{ /" ''
wlint W55-attest-if-or 1 "so it could attest on another event or ref: \\[    if: .\\{\\{ github\\.event_name == 'push' \\|\\| github\\.ref == 'refs/heads/sami-candidate' \\}\\}\\]\$" "/^  attest:\$/,/^  release_cache_prune:\$/s/ && github.ref == 'refs\\/heads\\/sami-candidate' }}\$/ || github.ref == 'refs\\/heads\\/sami-candidate' }}/" ''
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
PARITY_WS='# none' prun P4-cargo-toml-unlisted 1 'sdk/rust/x/Cargo.toml is outside the root workspace and not in' "$(covered)"
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
prun P11-query-names-no-rust-test 1 'bazel query names no crate root of any rust_test' "$LIB"

echo "rust_test job scripts: $pass passed, $fail failed, $skip skipped"
[ "$fail" = 0 ] && [ "$pass" -gt 0 ]
