#!/usr/bin/env bash
# One shard of the pi-shell set: each of its test binaries (the lib's, obash's and every
# tests/*.rs one) in a libtest process of its own, straight from the build's archive, as the
# runner's user or as root, --test-threads=4, with the hang bound SC_BIN_BOUND (seconds) per
# binary, and each test under the bound the tree's .config/nextest.toml gives it
# (.github/sami/libtest-bound.py: when no test has started or ended for that long, it stops the
# binary and fails the tests it was running, by name). libtest reports in JSON (nightly's
# -Z unstable-options --format json --report-time),
# with each passing test's output (--show-output) so sc.py libtest can see a test that skipped
# itself. When a test that known-failures.txt names `flaky: ` for this row, user and binary fails,
# the whole binary runs again (the same command: --test-threads=4, the same user), at most twice,
# while such a test has not passed; the summary reads its failure KNOWN only when it passed in such
# a retry (a race that fails at 4 threads can pass alone). Writes $SC/res/<unit>.json and
# $SC/res/logs/.
#   set.sh WHO SHARD
# Nothing is built here; the archive was unpacked at $GITHUB_WORKSPACE, the path it was built at.
set -uo pipefail
who=$1 shard=$2
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
bound=$GITHUB_WORKSPACE/tool/.github/sami/libtest-bound.py
meta=$CARGO_TARGET_DIR/nextest/binaries-metadata.json
mkdir -p "$SC/res/logs"
[ -s "$meta" ] || { echo "::error::no $meta: the archive did not unpack"; exit 1; }
python3 "$tool/sc.py" shard "$who" "$shard" "$SC_SET_SHARDS" "$meta" "$tool/pi-shell-seconds.txt" > "$SC/shard.tsv" ||
	{ echo "::error::sc.py shard failed"; exit 1; }
echo "SHARD $who $shard: $(wc -l < "$SC/shard.tsv") binaries: $(cut -f1 "$SC/shard.tsv" | tr '\n' ' ')"
tmp=/mnt/sc/tmp-$who
home=$RUNNER_TEMP/home-$who
mkdir -p "$home"
[ "$who" = root ] && sudo chown root:root "$home"
# The tests' environment: nothing of the runner's but what is named here. PI_VFS_TEST_KERNEL is
# the kernel the tests run on, named from where they run, never from uname: sami-checks.yml runs
# this script on a GitHub-hosted ubuntu VM, in no container, so its own Linux kernel runs them
# (gvisor-run.sh, this script's twin under runsc, names gvisor). pi-shell's FIFO read-open test
# compares pi-vfs's gVisor probe with it, and without it checks nothing (sc.py: a self-skip).
envv=(HOME="$home" USER="$who" LOGNAME="$who" TMPDIR="$tmp" PATH="$SC_TEST_PATH" RUST_BACKTRACE=1
	RSYNC_REFERENCE_REQUIRED=1 PI_TEST_STICKY_FIFO="$SC_STICKY_FIFO" PI_VFS_TEST_KERNEL=linux
	CARGO_PKG_NAME=pi-shell CARGO_MANIFEST_DIR="$SC_TREE/crates/pi-shell")
run() { # <log> <libtest args...>: $bin as this shard's user, in the tests' environment
	local out=$1
	shift
	local cmd=(timeout --verbose -k 10 "$SC_BIN_BOUND" python3 "$bound" --nextest-config "$SC_TREE/.config/nextest.toml"
		--package pi-shell -- "$bin" -Z unstable-options --format json --report-time --show-output "$@")
	if [ "$who" = root ]; then
		(cd "$SC_TREE/crates/pi-shell" && sudo env -i "${envv[@]}" "${cmd[@]}") > "$out" 2>&1 < /dev/null
	else
		(cd "$SC_TREE/crates/pi-shell" && env -i "${envv[@]}" "${cmd[@]}") > "$out" 2>&1 < /dev/null
	fi
}
threads=(--test-threads=4)
n=0
while IFS=$'\t' read -r ident bin; do
	n=$((n + 1))
	safe=$(printf '%s' "$ident" | tr -c 'A-Za-z0-9_.-' '_')
	log=$SC/res/logs/$safe.log
	if [ ! -x "$bin" ]; then
		echo "{\"row\": \"set-$who\", \"unit\": \"$ident\", \"who\": \"$who\", \"status\": \"UNKNOWN\", \"exit\": \"-\", \"seconds\": 0, \"passed\": 0, \"failed\": 0, \"ignored\": 0, \"self_skipped\": [], \"failures\": [], \"tests\": [], \"note\": \"the archive has no executable at $bin\"}" > "$SC/res/$safe.json"
		continue
	fi
	s=$(date +%s.%N)
	run "$log" "${threads[@]}"
	rc=$?
	secs=$(python3 -c "import time; print(f'{time.time() - $s:.1f}')")
	python3 "$tool/sc.py" libtest "$log" "$rc" "$secs" "set-$who" "$ident" "$who" > "$SC/res/$safe.json"
	echo "BIN $ident $who exit=$rc ${secs}s $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], "passed", r["passed"], "failed", r["failed"], r["note"])' "$SC/res/$safe.json")"
	mapfile -t flaky < <(python3 "$tool/sc.py" flaky-failed "$SC/res/$safe.json" "$tool/known-failures.txt")
	for try in 1 2; do
		[ "${#flaky[@]}" -gt 0 ] || break
		rlog=$SC/res/logs/$safe.retry$try.log
		run "$rlog" "${threads[@]}"
		left=()
		for t in "${flaky[@]}"; do
			got=$(python3 "$tool/sc.py" retried "$SC/res/$safe.json" "$t" "$rlog" "the binary again, ${threads[*]}, as $who")
			echo "RETRY $ident $who $t: try $try of 2 (the whole binary): $got"
			[ "$got" = pass ] || left+=("$t")
		done
		flaky=(${left[@]+"${left[@]}"})
	done
	# The one-process lib row is the runner's run of the lib binary in this shard: the same command.
	if [ "$ident" = pi-shell ] && [ "$who" = runner ]; then
		python3 "$tool/sc.py" libtest "$log" "$rc" "$secs" lib4 "$ident" "$who" > "$SC/res/lib4.json"
	fi
done < "$SC/shard.tsv"
[ "$who" = root ] && sudo chown -R "$(id -u):$(id -g)" "$SC/res"
echo "SHARD $who $shard done: $n binaries"
