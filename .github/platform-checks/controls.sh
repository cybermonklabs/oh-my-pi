#!/usr/bin/env bash
# The tool's own controls on real nextest output: builds the fixture crate at the paths a build
# job uses, runs leg.sh on its archive as a test leg does (as the runner's user and as root),
# and checks the verdict pc.py gives each row. Prints OK or MISMATCH per row; exit 1 on any
# mismatch. Needs PC, PY and CARGO_TARGET_DIR (tree.sh setup) and cargo-nextest.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
rm -rf "$PC/tree" "$PC/archive"
cp -R "$here/fixture" "$PC/tree"
mkdir -p "$PC/archive"
if ! (cd "$PC/tree" && cargo nextest archive --archive-file "$PC/archive/head.tar.zst") > "$PC/logs/fixture-build.log" 2>&1; then
	tail -n 40 "$PC/logs/fixture-build.log"
	echo "::error::the fixture did not build"
	exit 1
fi
export PC_FIXTURE_MARK=$PC/flaky-mark
bad=0
n=0
row() { # NAME WANT-PREFIX WHO COUNT RETRIES FILTER [LEG-DEADLINE-SECONDS [TIME-BOUND-PERIODS]]: one leg, its verdict
	n=$((n + 1))
	rm -rf "$PC/results"
	mkdir -p "$PC/results"
	PC_PLATFORM=ubuntu PC_TREE=head PC_WHO=$3 PC_LEG=1 PC_OFFSET=0 PC_COUNT=$4 PC_RETRIES=$5 \
		PC_FILTER=$6 PC_TIMEOUT_MINUTES=${8:-2} PC_SLOW_PERIOD=1s PC_GRACE=1s PC_LEG_DEADLINE=${7:-600} \
		bash "$here/leg.sh" > "$PC/logs/control-$n.console" 2>&1
	got=$("$PY" "$here/pc.py" verdict "$PC/results")
	cp -R "$PC/results" "$PC/logs/control-$n"
	case "$(echo "$got" | head -n 1)" in
	"$2"*) echo "OK       $1: $(echo "$got" | head -n 1)" ;;
	*)
		echo "MISMATCH $1: want $2, got: $got"
		bad=1
		;;
	esac
	echo "$got" | sed -n '2,$p' | sed 's/^/         /'
	last=$got
}
has() { # NAME LINE: the last row's per-test lines hold LINE
	if echo "$last" | grep -qxF "  $2"; then echo "OK       $1"; else
		echo "MISMATCH $1: no line '$2'"
		bad=1
	fi
}

rm -f "$PC_FIXTURE_MARK"
row "a pass, a failure, a hang, a flake and an ignored test, two repeats" \
	"TIMEOUT (1 past the time bound: pc-fixture tests::hangs) run=5 ignored=1" user 2 0 'all()'
has "  the passing test passed 2 of 2" "pc-fixture tests::passes PASS 2/2"
has "  the failing test named for a timeout reads FAIL" "pc-fixture tests::fails_with_timeout_in_its_name FAIL 0/2"
has "  the flake fails 1 of 2 with no retries" "pc-fixture tests::flaky_once FAIL 1/2"
has "  the second binary counts" "pc-fixture::it integration_passes PASS 2/2"
row "passing tests only, as root" "PASS (2 passed in 1 of 1 repeats) run=2 ignored=0" root 1 0 \
	'test(=tests::passes) | test(=integration_passes)'
row "a filter that selects only an ignored test" \
	"UNKNOWN (ran nothing: the filter selects no test that runs here) run=0 ignored=1" user 1 0 'test(=tests::ignored_one)'
row "a filter that selects nothing" \
	"UNKNOWN (ran nothing: the filter selects no test that runs here) run=0 ignored=0" user 1 0 'test(=no_such_test)'
rm -f "$PC_FIXTURE_MARK"
row "a test that passes only on the retry" "FLAKY (1 passed only on a retry: pc-fixture tests::flaky_once)" user 1 1 \
	'test(=tests::flaky_once)'
# Each repeat of the hang takes about 6 s (1 s period x 5, 1 s grace): a 9 s deadline lands
# inside the second repeat.
cut="TIMEOUT (1 past the time bound: pc-fixture tests::hangs) run=1 ignored=0 (cut short by the leg's deadline after 1 of 3"
row "a leg cut short by its deadline inside the second repeat" "$cut" user 3 0 'test(=tests::hangs)' 9 5
has "  the first repeat's TIMEOUT stays; the stopped repeat is not a failure" "pc-fixture tests::hangs TIMEOUT 0/3"
row "the same, as root (sudo passes the deadline's SIGTERM on)" "$cut" root 3 0 'test(=tests::hangs)' 9 5
has "  as root too" "pc-fixture tests::hangs TIMEOUT 0/3"
exit $bad
