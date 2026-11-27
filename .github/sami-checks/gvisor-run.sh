#!/usr/bin/env bash
# Inside a gVisor job's runsc container (gvisor.sh starts it), as root: one gVisor job's tests as
# WHO, run the way set.sh and nextest.sh run them on a host, with the same environment. As uid 1000
# the run starts with setpriv, so timeout, the bound runner, nextest and the test binary are all
# uid 1000's processes (the gate kit's launcher: under root's timeout, a uid 1000 test's
# `kill -0 $PPID` gets EPERM).
#   gvisor-run.sh WHO PART SHARD
#   - set: shard SHARD (1..SC_GV_SET_SHARDS) of the pi-shell test binaries (sc.py shard, set.sh's
#     weights), each in a libtest process of its own at --test-threads=4 under the hang bound
#     SC_BIN_BOUND, each test under the bound the tree's .config/nextest.toml gives it
#     (.github/sami/libtest-bound.py, set.sh's rule), with each passing test's output
#     (--show-output) so sc.py sees a test that skipped itself; the lib binary's run is also the
#     row gv-lib4-WHO.
#   - builtins: pi-builtins under nextest's default profile and the tree's .config/nextest.toml,
#     from the archive's metadata (no extraction: the archive is mounted read-only); the tests
#     SC_FOLDED names run in a second pass where names fold (nextest.sh's rule), when they do here.
# When a test that known-failures.txt lists `flaky: ` fails, the whole unit runs again in the same
# shape (the same binary or filter and passes, the same threads, the same user, gVisor), at most
# twice, while such a test has not passed: set.sh's and nextest.sh's rule.
# Writes /sc/res/<unit>.json (sc.py's result) and /sc/res/logs/.
set -uo pipefail
who=$1 part=$2 shard=$3
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
per_test=$GITHUB_WORKSPACE/tool/.github/sami/libtest-bound.py
res=/sc/res
mkdir -p "$res/logs"
b=$(dmesg 2>&1)
case "${b%%$'\n'*}" in
	*"Starting gVisor"*) ;;
	*) echo "::error title=gVisor job::not in gVisor: '${b%%$'\n'*}'"; exit 1 ;;
esac
case $who in
	uid1000) as=(setpriv --reuid=1000 --regid=1000 --clear-groups) user=runner ;;
	root) as=() user=root ;;
	*) echo "::error::WHO is uid1000 or root, not '$who'"; exit 1 ;;
esac
home=/scratch/home-$who tmp=/scratch/tmp-$who fold=/scratch/fold/tmp-$who
mkdir -p "$home" "$tmp"
[ "$who" = uid1000 ] && chown 1000:1000 "$home" "$tmp"
# The sticky-directory FIFO (host.sh's): mode 0666, uid 65534, in a 1777 directory of root's. The
# test that opens it reads fs.protected_fifos first, which gVisor does not have, so it checks nothing
# here (known-failures.txt lists its skip for the gVisor rows).
fifo=/scratch/sticky/report.txt
if ! { install -d -o root -g root -m 1777 "$(dirname "$fifo")" && mkfifo -m 0666 "$fifo" && chown 65534:65534 "$fifo"; }; then
	echo "::error::the sticky FIFO $fifo was not made"
	exit 1
fi
# The tests' environment: set.sh's and nextest.sh's, with this user's home and temporary directory,
# and gvisor for PI_VFS_TEST_KERNEL, the kernel the tests run on: this script has read gVisor's own
# banner in dmesg above, so runsc runs them, whatever uname says.
envv=(HOME="$home" USER="$user" LOGNAME="$user" PATH="$SC_TEST_PATH" RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1
	PI_TEST_STICKY_FIFO="$fifo" PI_VFS_TEST_KERNEL=gvisor)
pf=$(cat /proc/sys/fs/protected_fifos 2>&1) || true
echo "GVISOR $who $part $shard: uid=$("${as[@]}" id -u) kernel=$(uname -r) cpus=$(nproc) fs.protected_fifos=[$pf] [${b%%$'\n'*}]"

if [ "$part" = set ]; then
	# run_bin LOG TIMEOUT ARGS...: $bin as WHO in the tests' environment.
	run_bin() {
		local out=$1 bound=$2
		shift 2
		(cd "$SC_TREE/crates/pi-shell" && "${as[@]}" env -i "${envv[@]}" TMPDIR="$tmp" CARGO_PKG_NAME=pi-shell \
			CARGO_MANIFEST_DIR="$SC_TREE/crates/pi-shell" \
			timeout --verbose -k 10 "$bound" python3 "$per_test" --nextest-config "$SC_TREE/.config/nextest.toml" \
			--package pi-shell -- "$bin" -Z unstable-options --format json --report-time --show-output "$@") > "$out" 2>&1 < /dev/null
	}
	threads=(--test-threads=4)
	python3 "$tool/sc.py" shard "$who" "$shard" "$SC_GV_SET_SHARDS" /sc/meta/binaries-metadata.json "$tool/pi-shell-seconds.txt" > /scratch/shard.tsv ||
		{ echo "::error::sc.py shard failed"; exit 1; }
	echo "SHARD $who $shard: $(wc -l < /scratch/shard.tsv) binaries: $(cut -f1 /scratch/shard.tsv | tr '\n' ' ')"
	n=0
	while IFS=$'\t' read -r ident bin; do
		n=$((n + 1))
		safe=$(printf '%s' "$ident" | tr -c 'A-Za-z0-9_.-' '_')
		log=$res/logs/$safe.log
		if [ ! -x "$bin" ]; then
			echo "{\"row\": \"gv-set-$who\", \"unit\": \"$ident\", \"who\": \"$who\", \"status\": \"UNKNOWN\", \"exit\": \"-\", \"seconds\": 0, \"passed\": 0, \"failed\": 0, \"ignored\": 0, \"self_skipped\": [], \"failures\": [], \"tests\": [], \"note\": \"the archive has no executable at $bin\"}" > "$res/$safe.json"
			continue
		fi
		s=$(date +%s.%N)
		run_bin "$log" "$SC_BIN_BOUND" "${threads[@]}"
		rc=$?
		secs=$(python3 -c "import time; print(f'{time.time() - $s:.1f}')")
		python3 "$tool/sc.py" libtest "$log" "$rc" "$secs" "gv-set-$who" "$ident" "$who" > "$res/$safe.json"
		echo "BIN $ident $who exit=$rc ${secs}s $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], "passed", r["passed"], "failed", r["failed"], r["note"])' "$res/$safe.json")"
		mapfile -t flaky < <(python3 "$tool/sc.py" flaky-failed "$res/$safe.json" "$tool/known-failures.txt")
		for try in 1 2; do
			[ "${#flaky[@]}" -gt 0 ] || break
			rlog=$res/logs/$safe.retry$try.log
			run_bin "$rlog" "$SC_BIN_BOUND" "${threads[@]}"
			left=()
			for t in "${flaky[@]}"; do
				got=$(python3 "$tool/sc.py" retried "$res/$safe.json" "$t" "$rlog" "the binary again, ${threads[*]}, as $who, gVisor runsc")
				echo "RETRY $ident $who $t: try $try of 2 (the whole binary): $got"
				[ "$got" = pass ] || left+=("$t")
			done
			flaky=(${left[@]+"${left[@]}"})
		done
		if [ "$ident" = pi-shell ]; then
			python3 "$tool/sc.py" libtest "$log" "$rc" "$secs" "gv-lib4-$who" "$ident" "$who" > "$res/gv-lib4.json"
			# The control of the host's map limit (gvisor-host.sh): the orphan_jobs module at 4 threads
			# died of SIGSEGV under the runner's default vm.max_map_count, and must pass here, with each
			# of its tests by name (sc.py ORPHAN_CONTROL_TESTS; a filter that selects nothing is UNKNOWN).
			olog=$res/logs/gv-orphan.log
			s=$(date +%s.%N)
			run_bin "$olog" 600 --test-threads=4 testkit::suites::orphan_jobs
			orc=$?
			osecs=$(python3 -c "import time; print(f'{time.time() - $s:.1f}')")
			python3 "$tool/sc.py" gv-control "$olog" "$orc" "$osecs" "gv-orphan-$who" testkit::suites::orphan_jobs "$who" > "$res/gv-orphan.json"
			echo "CONTROL orphan_jobs $who exit=$orc ${osecs}s $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], "passed", r["passed"], "failed", r["failed"], r["note"])' "$res/gv-orphan.json")"
		fi
	done < /scratch/shard.tsv
	echo "SHARD $who $shard done: $n binaries"
	exit 0
fi

[ "$part" = builtins ] || { echo "::error::PART is set or builtins, not '$part'"; exit 1; }
cfg=/scratch/nextest-tool.toml
cat > "$cfg" << 'EOF'
# sami-checks adds only a JUnit report to the tree's default profile; it keeps each passing
# test's output, so sc.py nextest can see a test that skipped itself.
[profile.default.junit]
path = "junit.xml"
store-success-output = true
store-failure-output = true
EOF
junits=("$SC_TREE/target/nextest/default/junit.xml" "$CARGO_TARGET_DIR/nextest/default/junit.xml")
log=$res/logs/gv-builtins-$who.log
junit=$res/logs/gv-builtins-$who.junit.xml
: > "$log"
# pass TMPDIR FILTERSET JUNIT: one nextest run as WHO; returns its exit code.
pass() {
	rm -f "${junits[@]}"
	(cd "$SC_TREE" && "${as[@]}" env -i "${envv[@]}" TMPDIR="$1" CARGO_TERM_COLOR=never \
		cargo-nextest nextest run --binaries-metadata /sc/meta/binaries-metadata.json --cargo-metadata /sc/meta/cargo-metadata.json \
		--workspace-remap "$SC_TREE" --target-dir-remap "$CARGO_TARGET_DIR" --tool-config-file "sami-checks:$cfg" \
		-E "$2" --no-fail-fast) >> "$log" 2>&1 < /dev/null
	local rc=$? j
	for j in "${junits[@]}"; do [ -f "$j" ] && cp "$j" "$3" && break; done
	return "$rc"
}
# Where names fold: the host's casefold ext4 (gvisor-host.sh), bind-mounted at /scratch/fold. Whether
# a casefold directory folds names inside the sandbox is gVisor's behaviour, so it is probed here as
# WHO; when it does not, the SC_FOLDED tests run in the plain pass and their skips are reported.
folds=no
# shellcheck disable=SC2016 # the inner sh expands $1
if [ -n "${SC_FOLDED:-}" ] && [ -d "$fold" ] &&
	"${as[@]}" sh -c ': > "$1/fold-probe" && [ -e "$1/FOLD-PROBE" ]; r=$?; rm -f "$1/fold-probe"; exit $r' sh "$fold"; then
	folds=yes
fi
echo "FOLD $who: names fold in $fold under gVisor: $folds (SC_FOLDED: ${SC_FOLDED:-none})"
# unit JUNIT: the unit's run, one pass or two where names fold; returns its exit.
unit() {
	local out=$1 rc rc1 rc2 c
	if [ "$folds" = no ]; then
		pass "$tmp" 'package(pi-builtins)' "$out"
		return
	fi
	pass "$tmp" "package(pi-builtins) - ($SC_FOLDED)" "${out%.xml}.pass1.xml"
	rc1=$?
	pass "$fold" "package(pi-builtins) & ($SC_FOLDED)" "${out%.xml}.pass2.xml"
	rc2=$?
	# nextest.sh's rule: a pass that did not end normally (0 or 100) gives the unit its exit; else
	# 100 if either pass had a failure.
	rc=0
	for c in "$rc1" "$rc2"; do
		case $c in
			0) ;;
			100) [ "$rc" = 0 ] && rc=100 ;;
			*) rc=$c && break ;;
		esac
	done
	echo "PASSES gv-builtins-$who: exit $rc1 in $tmp, exit $rc2 in $fold"
	python3 "$tool/sc.py" junit-merge "$out" "${out%.xml}.pass1.xml" "${out%.xml}.pass2.xml" ||
		echo "::error::the two passes' JUnit reports do not merge; the unit reads UNKNOWN"
	return "$rc"
}
s=$(date +%s)
unit "$junit"
rc=$?
secs=$(($(date +%s) - s))
python3 "$tool/sc.py" nextest "$junit" "$rc" "$secs" "gv-builtins-$who" pi-builtins "$who" > "$res/gv-builtins.json"
mapfile -t flaky < <(python3 "$tool/sc.py" flaky-failed "$res/gv-builtins.json" "$tool/known-failures.txt")
for try in 1 2; do
	[ "${#flaky[@]}" -gt 0 ] || break
	rj=$res/logs/gv-builtins-$who.retry$try.xml
	unit "$rj"
	left=()
	for t in "${flaky[@]}"; do
		got=$(python3 "$tool/sc.py" retried "$res/gv-builtins.json" "$t" "$rj" "the unit again: nextest, nextest's threads ($(nproc) CPUs), as $who, gVisor runsc")
		echo "RETRY gv-builtins-$who $t: try $try of 2 (the whole unit): $got"
		[ "$got" = pass ] || left+=("$t")
	done
	flaky=(${left[@]+"${left[@]}"})
done
echo "ROW gv-builtins-$who: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tr -s ' \n' ' ')"
tail -n 40 "$log"
