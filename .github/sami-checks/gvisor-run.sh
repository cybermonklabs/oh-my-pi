#!/usr/bin/env bash
# Inside a gVisor job's runsc container (gvisor.sh starts it), as root: one gVisor job's tests as
# WHO, run the way set.sh and nextest.sh run them on a host, with the same environment. As uid 1000
# the run starts with setpriv, so timeout, nextest and the test binary are all uid 1000's processes
# (the gate kit's launcher: under root's timeout, a uid 1000 test's `kill -0 $PPID` gets EPERM).
#   gvisor-run.sh WHO PART SHARD
#   - set: shard SHARD (1..SC_GV_SET_SHARDS) of the pi-shell test binaries (sc.py shard, set.sh's
#     weights), each in a libtest process of its own at --test-threads=4 under the hang bound
#     SC_BIN_BOUND, with each passing test's output (--show-output) so sc.py sees a test that
#     skipped itself; the lib binary's run is also the row gv-lib4-WHO.
#   - builtins: pi-builtins under nextest's default profile and the tree's .config/nextest.toml,
#     from the archive's metadata (no extraction: the archive is mounted read-only).
# Writes /sc/res/<unit>.json (sc.py's result) and /sc/res/logs/.
set -uo pipefail
who=$1 part=$2 shard=$3
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
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
home=/scratch/home-$who tmp=/scratch/tmp-$who
mkdir -p "$home" "$tmp"
[ "$who" = uid1000 ] && chown 1000:1000 "$home" "$tmp"
# The sticky-directory FIFO (host.sh's): mode 0666, uid 65534, in a 1777 directory of root's. The
# test that opens it reads fs.protected_fifos first, which gVisor does not have, so it checks nothing
# here (sc.py GV_ENVIRONMENT lists it apart).
fifo=/scratch/sticky/report.txt
if ! { install -d -o root -g root -m 1777 "$(dirname "$fifo")" && mkfifo -m 0666 "$fifo" && chown 65534:65534 "$fifo"; }; then
	echo "::error::the sticky FIFO $fifo was not made"
	exit 1
fi
# The tests' environment: set.sh's and nextest.sh's, with this user's home and temporary directory.
envv=(HOME="$home" USER="$user" LOGNAME="$user" TMPDIR="$tmp" PATH="$SC_TEST_PATH" RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1
	PI_TEST_STICKY_FIFO="$fifo")
pf=$(cat /proc/sys/fs/protected_fifos 2>&1) || true
echo "GVISOR $who $part $shard: uid=$("${as[@]}" id -u) kernel=$(uname -r) cpus=$(nproc) fs.protected_fifos=[$pf] [${b%%$'\n'*}]"

if [ "$part" = set ]; then
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
		(cd "$SC_TREE/crates/pi-shell" && "${as[@]}" env -i "${envv[@]}" CARGO_PKG_NAME=pi-shell CARGO_MANIFEST_DIR="$SC_TREE/crates/pi-shell" \
			timeout --verbose -k 10 "$SC_BIN_BOUND" "$bin" -Z unstable-options --format json --report-time --show-output --test-threads=4) > "$log" 2>&1 < /dev/null
		rc=$?
		secs=$(python3 -c "import time; print(f'{time.time() - $s:.1f}')")
		python3 "$tool/sc.py" gv-libtest "$log" "$rc" "$secs" "gv-set-$who" "$ident" "$who" > "$res/$safe.json"
		echo "BIN $ident $who exit=$rc ${secs}s $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], "passed", r["passed"], "failed", r["failed"], "gVisor-environment", len(r["environment"]), r["note"])' "$res/$safe.json")"
		if [ "$ident" = pi-shell ]; then
			python3 "$tool/sc.py" gv-libtest "$log" "$rc" "$secs" "gv-lib4-$who" "$ident" "$who" > "$res/gv-lib4.json"
			# The control of the host's map limit (gvisor-host.sh): the orphan_jobs module at 4 threads
			# died of SIGSEGV under the runner's default vm.max_map_count, and must pass here.
			olog=$res/logs/gv-orphan.log
			s=$(date +%s.%N)
			(cd "$SC_TREE/crates/pi-shell" && "${as[@]}" env -i "${envv[@]}" CARGO_PKG_NAME=pi-shell CARGO_MANIFEST_DIR="$SC_TREE/crates/pi-shell" \
				timeout --verbose -k 10 600 "$bin" -Z unstable-options --format json --report-time --show-output --test-threads=4 testkit::suites::orphan_jobs) > "$olog" 2>&1 < /dev/null
			orc=$?
			osecs=$(python3 -c "import time; print(f'{time.time() - $s:.1f}')")
			python3 "$tool/sc.py" gv-libtest "$olog" "$orc" "$osecs" "gv-orphan-$who" testkit::suites::orphan_jobs "$who" > "$res/gv-orphan.json"
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
rm -f "${junits[@]}"
log=$res/logs/gv-builtins-$who.log
junit=$res/logs/gv-builtins-$who.junit.xml
s=$(date +%s)
(cd "$SC_TREE" && "${as[@]}" env -i "${envv[@]}" CARGO_TERM_COLOR=never \
	cargo-nextest nextest run --binaries-metadata /sc/meta/binaries-metadata.json --cargo-metadata /sc/meta/cargo-metadata.json \
	--workspace-remap "$SC_TREE" --target-dir-remap "$CARGO_TARGET_DIR" --tool-config-file "sami-checks:$cfg" \
	-E 'package(pi-builtins)' --no-fail-fast) > "$log" 2>&1 < /dev/null
rc=$?
secs=$(($(date +%s) - s))
for j in "${junits[@]}"; do [ -f "$j" ] && cp "$j" "$junit" && break; done
python3 "$tool/sc.py" gv-nextest "$junit" "$rc" "$secs" "gv-builtins-$who" pi-builtins "$who" > "$res/gv-builtins.json"
echo "ROW gv-builtins-$who: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tail -n 1)"
tail -n 40 "$log"
