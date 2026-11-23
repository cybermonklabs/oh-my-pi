#!/usr/bin/env bash
# One nextest row from the build's archive, as the runner's user: the tree's own
# .config/nextest.toml and its default profile (its time bound per test, 4 periods of 60 s, and
# its tests that run alone), with a JUnit report added by a tool config. The report keeps each
# passing test's output, so sc.py nextest can see a test that skipped itself. Nothing is built here.
#   nextest.sh ROW UNIT FILTERSET [PARTITION]
# Writes $SC/res/<row>-<unit>.json (sc.py nextest) and the run's log and JUnit report.
set -uo pipefail
row=$1 unit=$2 filter=$3 part=${4:-}
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
rm -f "${junits[@]}"
safe=$(printf '%s' "$row-$unit" | tr -c 'A-Za-z0-9_.-' '_')
log=$SC/res/logs/$safe.log
s=$(date +%s)
env -i HOME="$HOME" USER="${USER:-runner}" LOGNAME="${USER:-runner}" TMPDIR=/mnt/sc/tmp-runner PATH="$SC_TEST_PATH:$(dirname "$nx")" \
	RUST_BACKTRACE=1 RSYNC_REFERENCE_REQUIRED=1 PI_TEST_STICKY_FIFO="$SC_STICKY_FIFO" CARGO_TERM_COLOR=never \
	"$nx" nextest run "${args[@]}" > "$log" 2>&1 < /dev/null
rc=$?
secs=$(($(date +%s) - s))
for j in "${junits[@]}"; do [ -f "$j" ] && cp "$j" "$SC/res/logs/$safe.junit.xml" && break; done
python3 "$tool/sc.py" nextest "$SC/res/logs/$safe.junit.xml" "$rc" "$secs" "$row" "$unit" runner > "$SC/res/$safe.json"
echo "ROW $row $unit: nextest exit $rc in ${secs}s; $(grep -E '^ *Summary ' "$log" | tail -n 1)"
tail -n 40 "$log"
