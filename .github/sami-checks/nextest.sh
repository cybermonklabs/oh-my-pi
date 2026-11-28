#!/usr/bin/env bash
# One nextest row from the build's archive, as the runner's user or as root: the tree's own
# .config/nextest.toml and its default profile (its time bound per test, 4 periods of 60 s, and
# its tests that run alone), with a JUnit report added by a tool config. The report keeps each
# passing test's output, so sc.py nextest can see a test that skipped itself (a test that needs
# root skips itself as the runner's user; the summary counts it covered when it passed as root).
# A test with a `flaky: ` entry that failed reads KNOWN only when it passed in a run of the whole
# unit again (below). Nothing is built here.
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
args=(--archive-file "$SC/archive/tests.tar.zst" --extract-to "$GITHUB_WORKSPACE" --extract-overwrite
	--workspace-remap "$SC_TREE" --tool-config-file "sami-checks:$cfg" --no-fail-fast)
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
# PI_VFS_TEST_KERNEL: the kernel the tests run on, as set.sh names it, and for the same reason (a
# GitHub-hosted ubuntu VM runs this script in no container); pi-vfs's FIFO read-open tests read it.
pass() { # <TMPDIR> <filterset> <JUnit copy> <log>: one nextest run; returns its exit code
	sudo rm -f "${junits[@]}"
	"${run[@]}" "${envv[@]}" TMPDIR="$1" PATH="$SC_TEST_PATH:$(dirname "$nx")" RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1 \
		PI_TEST_STICKY_FIFO="$SC_STICKY_FIFO" PI_VFS_TEST_KERNEL=linux CARGO_TERM_COLOR=never \
		"$nx" nextest run "${args[@]}" -E "$2" >> "$4" 2>&1 < /dev/null
	local rc=$? j
	for j in "${junits[@]}"; do
		if sudo test -f "$j"; then
			sudo cat "$j" > "$3"
			break
		fi
	done
	return "$rc"
}
unit() { # <JUnit report> <log>: the unit's run, one pass or two with SC_FOLDED; returns its exit
	local out=$1 lg=$2 rc rc1 rc2 c
	if [ -z "$folded" ]; then
		pass "$tmp" "$filter" "$out" "$lg"
		return
	fi
	pass "$tmp" "($filter) - ($folded)" "${out%.xml}.pass1.xml" "$lg"
	rc1=$?
	pass "$fold" "($filter) & ($folded)" "${out%.xml}.pass2.xml" "$lg"
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
	python3 "$tool/sc.py" junit-merge "$out" "${out%.xml}.pass1.xml" "${out%.xml}.pass2.xml" ||
		echo "::error::the two passes' JUnit reports do not merge; the unit reads UNKNOWN"
	return "$rc"
}
s=$(date +%s)
unit "$SC/res/logs/$safe.junit.xml" "$log"
rc=$?
secs=$(($(date +%s) - s))
python3 "$tool/sc.py" nextest "$SC/res/logs/$safe.junit.xml" "$rc" "$secs" "$row" "$unit" "$who" > "$SC/res/$safe.json"
# When a test that known-failures.txt names `flaky: ` fails, the whole unit runs again (the same
# filter, partition, passes, threads and user), at most twice, while such a test has not passed;
# the summary reads its failure KNOWN only when it passed in such a retry.
mapfile -t flaky < <(python3 "$tool/sc.py" flaky-failed "$SC/res/$safe.json" "$tool/known-failures.txt")
for try in 1 2; do
	[ "${#flaky[@]}" -gt 0 ] || break
	rj=$SC/res/logs/$safe.retry$try.xml
	unit "$rj" "$SC/res/logs/$safe.retry$try.log"
	left=()
	for t in "${flaky[@]}"; do
		got=$(python3 "$tool/sc.py" retried "$SC/res/$safe.json" "$t" "$rj" \
			"the unit again: nextest, ${part:+partition $part, }nextest's threads ($(nproc) CPUs), as $who")
		echo "RETRY $row $unit $who $t: try $try of 2 (the whole unit): $got"
		[ "$got" = pass ] || left+=("$t")
	done
	flaky=(${left[@]+"${left[@]}"})
done
echo "ROW $row $unit $who: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tr -s ' \n' ' ')"
tail -n 40 "$log"
