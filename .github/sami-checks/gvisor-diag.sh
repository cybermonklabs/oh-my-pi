#!/usr/bin/env bash
# The diagnostic of the pi-shell lib's SIGSEGV under runsc (sami-checks-gvisor-diag.yml): one case
# of the lib test binary in a runsc container of the image sc-gv (gvisor-host.sh), with libtest's
# JSON events read by sc.py, so a run that dies names the tests it left unfinished.
#   gvisor-diag.sh host RUNTIME MODE   on the runner: register RUNTIME, start the container
#   gvisor-diag.sh inside MODE         in the container, as root: the runs of MODE
# RUNTIME: runsc (20261116.0, systrap), runsc-ptrace (20261116.0, ptrace), runsc-dbg (20261116.0,
# systrap, runsc's debug log kept), runsc-old (20260810.0, systrap).
# MODE: lib4 (the whole lib at --test-threads=4, as the rows run it), lib1 (--test-threads=1),
# orphan (the two orphan_jobs tests the rows left unfinished, each alone with --exact, 10 times
# as root and 10 as uid 1000; then their module at 4 threads, 3 times).
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
A=testkit::suites::orphan_jobs::a_detached_tree_outlives_its_subshell
B=testkit::suites::orphan_jobs::without_the_knob_orphaned_jobs_run_on
OLD_RELEASE=20260810.0
OLD_SHA256=670bcd3cbc103f00d8bb5098edc370f32397ee4c134231436bafa659bb3c068e

if [ "$1" = host ]; then
	rt=$2 mode=$3
	out=$SC/diag
	mkdir -p "$out"
	inst=(--download-sidecars=NEVER --require-sidecars=ALWAYS)
	case $rt in
		runsc) ;;
		runsc-ptrace) sudo /usr/local/bin/runsc install --runtime=runsc-ptrace "${inst[@]}" -- --platform=ptrace ;;
		runsc-dbg)
			sudo mkdir -p /tmp/runsc-dbg
			sudo /usr/local/bin/runsc install --runtime=runsc-dbg "${inst[@]}" -- --platform=systrap --debug --debug-log=/tmp/runsc-dbg/
			;;
		runsc-old)
			curl -fsSL --retry 3 -o "$RUNNER_TEMP/runsc-old" "https://storage.googleapis.com/gvisor/releases/release/$OLD_RELEASE/x86_64/runsc"
			echo "$OLD_SHA256  $RUNNER_TEMP/runsc-old" | sha256sum -c - || { echo "::error::runsc $OLD_RELEASE: sha256 differs"; exit 1; }
			sudo install -D -m 0755 "$RUNNER_TEMP/runsc-old" /opt/runsc-old/runsc
			/opt/runsc-old/runsc --version | head -n 1
			sudo /opt/runsc-old/runsc install --runtime=runsc-old -- --platform=systrap
			;;
		*) echo "::error::no runtime $rt"; exit 1 ;;
	esac
	[ "$rt" = runsc ] || sudo systemctl restart docker
	echo "DAEMON.JSON $(sudo cat /etc/docker/daemon.json | tr -d ' \n')"
	chmod 0755 "$SC/lib/pi-shell-lib"
	docker run --rm --runtime="$rt" --init --ulimit nofile=65536:65536 \
		-v "$SC/lib:$SC/lib:ro" -v "$SC_TREE:$SC_TREE" -v "$GITHUB_WORKSPACE/tool:$GITHUB_WORKSPACE/tool:ro" -v "$out:/out" \
		-e GITHUB_WORKSPACE -e SC_TREE -e SC_TEST_PATH -e LIB="$SC/lib/pi-shell-lib" \
		sc-gv bash "$tool/gvisor-diag.sh" inside "$mode"
	rc=$?
	if [ "$rt" = runsc-dbg ]; then
		sudo tar -C /tmp -czf "$out/runsc-dbg.tgz" runsc-dbg
		echo "RUNSC-DEBUG lines that name a fault or signal 11:"
		sudo grep -r -h -a -i -E 'signal 11|SIGSEGV|segfault|fault at|unhandled|panic' /tmp/runsc-dbg | head -n 60
	fi
	sudo chown -R "$(id -u):$(id -g)" "$out"
	exit "$rc"
fi

[ "$1" = inside ] || { echo "::error::host or inside, not '$1'"; exit 1; }
mode=$2
b=$(dmesg 2>&1) || true
echo "IN ${b%%$'\n'*} kernel=$(uname -r) cpus=$(nproc)"
case "${b%%$'\n'*}" in *"Starting gVisor"*) ;; *) echo "::error::not in gVisor"; exit 1 ;; esac
fifo=/scratch/sticky/report.txt
install -d -o root -g root -m 1777 /scratch/sticky && mkfifo -m 0666 "$fifo" && chown 65534:65534 "$fifo"
# run LABEL WHO ARGS...: one process of the lib binary, its result read by sc.py libtest.
run() {
	local label=$1 who=$2 s rc log home tmp
	shift 2
	local as=()
	[ "$who" = uid1000 ] && as=(setpriv --reuid=1000 --regid=1000 --clear-groups)
	home=/scratch/home-$who tmp=/scratch/tmp-$who
	mkdir -p "$home" "$tmp"
	[ "$who" = uid1000 ] && chown 1000:1000 "$home" "$tmp"
	log=/out/$label.log
	s=$(date +%s)
	(cd "$SC_TREE/crates/pi-shell" && "${as[@]}" env -i HOME="$home" USER="$who" LOGNAME="$who" TMPDIR="$tmp" PATH="$SC_TEST_PATH" \
		RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1 PI_TEST_STICKY_FIFO="$fifo" CARGO_PKG_NAME=pi-shell \
		CARGO_MANIFEST_DIR="$SC_TREE/crates/pi-shell" timeout -k 10 1800 "$LIB" -Z unstable-options --format json --report-time "$@") \
		> "$log" 2>&1 < /dev/null
	rc=$?
	python3 "$tool/sc.py" libtest "$log" "$rc" "$(($(date +%s) - s))" diag "$label" "$who" > "/out/$label.json"
	echo "RUN $label $who rc=$rc $(($(date +%s) - s))s $(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], "passed", r["passed"], "failed", r["failed"], r["note"][:400])' "/out/$label.json")"
	if [ "$rc" != 0 ] && [ "$rc" != 101 ]; then
		echo "  last lines that are not libtest events:"
		python3 -c 'import sys; l=[x for x in open(sys.argv[1], errors="replace").read().splitlines() if not x.startswith("{")]; print("\n".join("    " + x[:300] for x in l[-12:]))' "$log"
	fi
}
case $mode in
	lib4) run lib4 root --test-threads=4 ;;
	lib1) run lib1 root --test-threads=1 ;;
	orphan)
		for i in $(seq 10); do
			for who in root uid1000; do
				run "alone-A-$who-$i" "$who" --exact "$A" --test-threads=1
				run "alone-B-$who-$i" "$who" --exact "$B" --test-threads=1
			done
		done
		for i in 1 2 3; do run "module-root-$i" root testkit::suites::orphan_jobs --test-threads=4; done
		;;
	*) echo "::error::no mode $mode"; exit 1 ;;
esac
