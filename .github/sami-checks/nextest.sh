#!/usr/bin/env bash
# One nextest row from the build's archive, as the runner's user or as root: the tree's own
# .config/nextest.toml and its default profile (its time bound per test, 4 periods of 60 s, and
# its tests that run alone), with a JUnit report added by a tool config. The report keeps each
# passing test's output, so sc.py nextest can see a test that skipped itself (a test that needs
# root skips itself as the runner's user; the summary counts it covered when it passed as root).
# Nothing is built here.
#   nextest.sh ROW UNIT WHO FILTERSET [PARTITION]
# SC_FOLDED, when set, is a filterset of tests that need a temporary directory where names fold:
# they run in a second pass with TMPDIR in host.sh's /mnt/sc-fold, the first pass leaves them out,
# and the two passes' JUnit reports and exit codes make the unit's one result (no PARTITION then).
# Writes $SC/res/<row>-<unit>-<who>.json (sc.py nextest) and the run's log and JUnit report.
set -uo pipefail
row=$1 unit=$2 who=$3 filter=$4 part=${5:-}
folded=${SC_FOLDED:-}
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
mkdir -p "$SC/res/logs"
if [ -n "$folded" ] && [ -n "$part" ]; then
	echo "::error::nextest.sh: SC_FOLDED with a partition is not supported"
	exit 1
fi
cfg=$SC/nextest-tool.toml
cat > "$cfg" << 'EOF'
# sami-checks adds only a JUnit report to the tree's default profile.
[profile.default.junit]
path = "junit.xml"
store-success-output = true
store-failure-output = true
EOF
nx=$(command -v cargo-nextest) || { echo "::error::cargo-nextest is not installed"; exit 1; }
base=(--archive-file "$SC/archive/tests.tar.zst" --extract-to "$GITHUB_WORKSPACE" --extract-overwrite
	--workspace-remap "$SC_TREE" --tool-config-file "sami-checks:$cfg" --no-fail-fast)
args=("${base[@]}")
[ -n "$part" ] && args+=(--partition "$part")
# nextest writes its store under the workspace root (--workspace-remap: the tree), as
# platform-checks found; the extracted target directory is the other place it could be.
junits=("$SC_TREE/target/nextest/default/junit.xml" "$CARGO_TARGET_DIR/nextest/default/junit.xml")
safe=$(printf '%s' "$row-$unit-$who" | tr -c 'A-Za-z0-9_.-' '_')
log=$SC/res/logs/$safe.log
: > "$log"
if [ "$who" = root ]; then
	envv=(HOME=/root USER=root LOGNAME=root)
	run=(sudo env -i)
	tmp=/mnt/sc/tmp-root fold=/mnt/sc-fold/tmp-root
else
	envv=(HOME="$HOME" USER="${USER:-runner}" LOGNAME="${USER:-runner}")
	run=(env -i)
	tmp=/mnt/sc/tmp-runner fold=/mnt/sc-fold/tmp-runner
fi
pass() { # <TMPDIR> <filterset> <JUnit copy>: one nextest run; returns its exit code
	sudo rm -f "${junits[@]}"
	"${run[@]}" "${envv[@]}" TMPDIR="$1" PATH="$SC_TEST_PATH:$(dirname "$nx")" RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1 \
		PI_TEST_STICKY_FIFO="$SC_STICKY_FIFO" CARGO_TERM_COLOR=never \
		"$nx" nextest run "${args[@]}" -E "$2" >> "$log" 2>&1 < /dev/null
	local rc=$? j
	for j in "${junits[@]}"; do
		if sudo test -f "$j"; then
			sudo cat "$j" > "$3"
			break
		fi
	done
	return "$rc"
}
s=$(date +%s)
if [ -z "$folded" ]; then
	pass "$tmp" "$filter" "$SC/res/logs/$safe.junit.xml"
	rc=$?
else
	p1=$SC/res/logs/$safe.pass1.xml p2=$SC/res/logs/$safe.pass2.xml
	pass "$tmp" "($filter) - ($folded)" "$p1"
	rc1=$?
	pass "$fold" "($filter) & ($folded)" "$p2"
	rc2=$?
	# A pass that did not end normally (nextest 0 or 100) gives the unit its exit; else 100 if
	# either pass had a failure.
	rc=0
	for c in "$rc1" "$rc2"; do
		case $c in
		0) ;;
		100) [ "$rc" = 0 ] && rc=100 ;;
		*) rc=$c && break ;;
		esac
	done
	echo "PASSES $row $unit $who: exit $rc1 in $tmp, exit $rc2 in $fold (SC_FOLDED: $folded)"
	python3 "$tool/sc.py" junit-merge "$SC/res/logs/$safe.junit.xml" "$p1" "$p2" ||
		echo "::error::the two passes' JUnit reports do not merge; the unit reads UNKNOWN"
fi
secs=$(($(date +%s) - s))
python3 "$tool/sc.py" nextest "$SC/res/logs/$safe.junit.xml" "$rc" "$secs" "$row" "$unit" "$who" > "$SC/res/$safe.json"
# A failed test that known-failures.txt names `flaky: ` runs again alone, by binary and name, at most
# twice, until it passes (no partition; where names fold when it ran there); the summary reads its
# failure KNOWN only when a retry passed.
args=("${base[@]}")
while IFS= read -r t; do
	[ -n "$t" ] || continue
	IFS=$'\t' read -r cls name _ < <(python3 "$tool/sc.py" junit-test "$SC/res/logs/$safe.junit.xml" "$t") || continue
	dir=$tmp
	[ -n "$folded" ] && python3 "$tool/sc.py" junit-test "$p2" "$t" > /dev/null 2>&1 && dir=$fold
	for try in 1 2; do
		rj=$SC/res/logs/$safe.retry$try.$(printf '%s' "$t" | tr -c 'A-Za-z0-9_.-' '_' | cut -c1-80).xml
		pass "$dir" "binary_id($cls) & test(=$name)" "$rj"
		got=$(python3 "$tool/sc.py" retried "$SC/res/$safe.json" "$t" "$rj")
		echo "RETRY $row $unit $who $t: try $try of 2: $got"
		[ "$got" = pass ] && break
	done
done < <(python3 "$tool/sc.py" flaky-failed "$SC/res/$safe.json" "$tool/known-failures.txt")
echo "ROW $row $unit $who: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tr -s ' \n' ' ')"
tail -n 40 "$log"
