#!/usr/bin/env bash
# One test leg: runs the archive of one tree, as the runner's user or as root, PC_COUNT
# repeats as one nextest stress run. Nothing is built here. Writes $PC/results: meta.env,
# list.json (the tests the filter selects, ignored ones included), junit.xml, list.log and
# run.log. Exits 0 when nextest ran; the verdict is the report job's.
set -uo pipefail
res=$PC/results
meta=$res/meta.env
mkdir -p "$res"
# The kernel the tests run on, named from the platform this leg runs on, never from uname: each
# platform is a GitHub-hosted VM (pc.py RUNNERS), whose own kernel runs the tests, never gVisor.
# pi-shell's FIFO read-open test compares pi-vfs's gVisor probe with it, and without it checks
# nothing. The root runs below pass it on by name, as sudo drops it.
case "$PC_PLATFORM" in
	ubuntu) kernel=linux ;;
	macos) kernel=darwin ;;
	windows) kernel=windows ;;
	*) kernel="" ;;
esac
export PI_VFS_TEST_KERNEL=$kernel
{
	echo "platform=$PC_PLATFORM"
	echo "tree=$PC_TREE"
	echo "who=$PC_WHO"
	echo "leg=$PC_LEG"
	echo "offset=$PC_OFFSET"
	echo "count=$PC_COUNT"
	echo "partition=${PC_PARTITION:-1}/${PC_PARTITIONS:-1}"
	echo "image=${ImageOS:-?}/${ImageVersion:-?}"
	# The bash the tests compare with when they read PI_TEST_REAL_BASH (the host step sets it on macOS).
	echo "pi_test_real_bash=${PI_TEST_REAL_BASH:-unset}"
	if [ -n "${PI_TEST_REAL_BASH:-}" ]; then echo "pi_test_real_bash_version=$("$PI_TEST_REAL_BASH" --version | head -n 1)"; fi
	echo "pi_vfs_test_kernel=${kernel:-unset}"
} > "$meta"
fail() {
	echo "note=$*" >> "$meta"
	echo "::error::$*"
	exit 1
}
[ -n "$kernel" ] || fail "no kernel name for platform $PC_PLATFORM, so pi-shell's FIFO read-open test would check nothing"

archive=$PC/archive/$PC_TREE.tar.zst
[ -s "$archive" ] || fail "no archive of $PC_TREE: its build failed or did not run"
nx=$(command -v cargo-nextest) || fail "cargo-nextest is not installed"
echo "nextest=$("$nx" nextest --version | head -n 1)" >> "$meta"

# PC_SLOW_PERIOD, PC_GRACE and PC_LEG_DEADLINE are for the tool's own controls (controls.sh).
cfg=$PC/platform-checks.toml
cat > "$cfg" << EOF
# The leg's own profile. The tree's .config/nextest.toml still applies, and its per-test
# overrides (threads-required, a longer slow-timeout) come before these settings.
[profile.platform-checks]
fail-fast = false
failure-output = "final"
success-output = "$([ "${PC_KEEP_SUCCESS_OUTPUT:-}" = true ] && echo final || echo never)"
retries = $PC_RETRIES
slow-timeout = { period = "${PC_SLOW_PERIOD:-60s}", terminate-after = $PC_TIMEOUT_MINUTES, grace-period = "${PC_GRACE:-10s}" }

[profile.platform-checks.junit]
path = "junit.xml"
store-success-output = $([ "${PC_KEEP_SUCCESS_OUTPUT:-}" = true ] && echo true || echo false)
store-failure-output = true
EOF

as_who() {
	if [ "$PC_WHO" = root ]; then
		sudo env "PATH=$PATH" HOME=/root USER=root LOGNAME=root RUST_BACKTRACE=1 PI_VFS_TEST_KERNEL="$PI_VFS_TEST_KERNEL" "$@"
	else
		"$@"
	fi
}
if [ "$PC_WHO" = root ]; then
	echo "uid=$(sudo id -u)" >> "$meta"
else
	echo "uid=$(id -u 2> /dev/null || echo "$USERNAME")" >> "$meta"
fi

# The archive goes back where it was built ($PC/out/target), and the source at $PC/tree: the
# paths compiled into the test binaries hold.
common=(--archive-file "$archive" --extract-to "$PC/out" --extract-overwrite
	--workspace-remap "$PC/tree" --tool-config-file "platform-checks:$cfg" --profile platform-checks
	-E "$PC_FILTER")
# A partition leg runs its share of the selected tests (nextest's count partitioner); the report
# joins the partitions' lists and reports.
if [ "${PC_PARTITIONS:-1}" -gt 1 ]; then
	common+=(--partition "count:$PC_PARTITION/$PC_PARTITIONS")
fi
as_who "$nx" nextest list "${common[@]}" --run-ignored all --message-format json > "$res/list.json" 2> "$res/list.log"
rc=$?
echo "list_exit=$rc" >> "$meta"
[ "$rc" = 0 ] || fail "nextest list failed (exit $rc): a bad filter, or an archive this runner cannot run"
[ -d "$CARGO_TARGET_DIR/debug" ] || fail "the archive did not extract to $CARGO_TARGET_DIR"

stress=()
[ "$PC_COUNT" -gt 1 ] && stress=(--stress-count "$PC_COUNT")
# nextest writes its store under the workspace root, which --workspace-remap made $PC/tree.
junit=$PC/tree/target/nextest/platform-checks/junit.xml
as_who rm -f "$junit"
# The leg's deadline. nextest's global-timeout restarts with each stress repeat, so it cannot
# bound a leg: a watchdog sends nextest SIGTERM 325 minutes in, and nextest stops its tests and
# still writes its JUnit report before the job's limit (345 minutes) would kill it. (On
# Windows the signal ends nextest at once, with no report; the leg then reads UNKNOWN.)
fired=$PC/deadline-fired
rm -f "$fired"
s=$(date +%s)
(
	if [ "$PC_WHO" = root ]; then
		exec sudo env "PATH=$PATH" HOME=/root USER=root LOGNAME=root RUST_BACKTRACE=1 PI_VFS_TEST_KERNEL="$PI_VFS_TEST_KERNEL" \
			"$nx" nextest run "${common[@]}" ${stress[@]+"${stress[@]}"} --no-fail-fast --no-tests=pass
	fi
	exec "$nx" nextest run "${common[@]}" ${stress[@]+"${stress[@]}"} --no-fail-fast --no-tests=pass
) > "$res/run.log" 2>&1 &
pid=$!
(
	sleep "${PC_LEG_DEADLINE:-19500}" &
	nap=$!
	# Called off when nextest ends first: stop the sleep too.
	trap 'kill "$nap"; exit 0' TERM
	wait "$nap"
	touch "$fired"
	if [ "$PC_WHO" = root ]; then sudo kill -TERM "$pid"; else kill -TERM "$pid"; fi
) > /dev/null 2>&1 &
dog=$!
wait "$pid"
rc=$?
kill "$dog" 2> /dev/null
{
	echo "run_exit=$rc"
	echo "run_seconds=$(($(date +%s) - s))"
} >> "$meta"
if [ -f "$junit" ]; then
	as_who cat "$junit" > "$res/junit.xml"
else
	echo "note=nextest wrote no JUnit report (exit $rc)" >> "$meta"
fi
# A run the deadline ended: the tests it stopped read as failed in the report.
if [ -f "$fired" ]; then
	echo "cancelled=deadline" >> "$meta"
fi
echo "RUN $PC_TREE $PC_WHO leg $PC_LEG: nextest exit $rc in $(($(date +%s) - s)) s; $("$PY" "$GITHUB_WORKSPACE/.github/platform-checks/pc.py" brief "$res/junit.xml")"
exit 0
