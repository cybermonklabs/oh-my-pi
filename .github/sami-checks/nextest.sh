#!/usr/bin/env bash
# One nextest row from the build's archive, as the runner's user or as root: the tree's own
# .config/nextest.toml and its default profile (its time bound per test, 4 periods of 60 s, and
# its tests that run alone), with a JUnit report added by a tool config. The report keeps each
# passing test's output, so sc.py nextest can see a test that skipped itself (a test that needs
# root skips itself as the runner's user; the summary counts it covered when it passed as root).
# Nothing is built here.
#   nextest.sh ROW UNIT WHO FILTERSET [PARTITION]
# Writes $SC/res/<row>-<unit>-<who>.json (sc.py nextest) and the run's log and JUnit report.
set -uo pipefail
row=$1 unit=$2 who=$3 filter=$4 part=${5:-}
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
mkdir -p "$SC/res/logs"
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
	--workspace-remap "$SC_TREE" --tool-config-file "sami-checks:$cfg" -E "$filter" --no-fail-fast)
[ -n "$part" ] && args+=(--partition "$part")
# nextest writes its store under the workspace root (--workspace-remap: the tree), as
# platform-checks found; the extracted target directory is the other place it could be.
junits=("$SC_TREE/target/nextest/default/junit.xml" "$CARGO_TARGET_DIR/nextest/default/junit.xml")
sudo rm -f "${junits[@]}"
safe=$(printf '%s' "$row-$unit-$who" | tr -c 'A-Za-z0-9_.-' '_')
log=$SC/res/logs/$safe.log
if [ "$who" = root ]; then
	envv=(HOME=/root USER=root LOGNAME=root TMPDIR=/mnt/sc/tmp-root)
	run=(sudo env -i)
else
	envv=(HOME="$HOME" USER="${USER:-runner}" LOGNAME="${USER:-runner}" TMPDIR=/mnt/sc/tmp-runner)
	run=(env -i)
fi
s=$(date +%s)
"${run[@]}" "${envv[@]}" PATH="$SC_TEST_PATH:$(dirname "$nx")" RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1 \
	PI_TEST_STICKY_FIFO="$SC_STICKY_FIFO" CARGO_TERM_COLOR=never \
	"$nx" nextest run "${args[@]}" > "$log" 2>&1 < /dev/null
rc=$?
secs=$(($(date +%s) - s))
for j in "${junits[@]}"; do
	if sudo test -f "$j"; then
		sudo cat "$j" > "$SC/res/logs/$safe.junit.xml"
		break
	fi
done
python3 "$tool/sc.py" nextest "$SC/res/logs/$safe.junit.xml" "$rc" "$secs" "$row" "$unit" "$who" > "$SC/res/$safe.json"
echo "ROW $row $unit $who: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tail -n 1)"
tail -n 40 "$log"
