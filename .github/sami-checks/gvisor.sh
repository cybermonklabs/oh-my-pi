#!/usr/bin/env bash
# One gVisor job, on its host: a runsc container of the image sc-gv (gvisor-host.sh) with the
# build's archive (unpacked at $GITHUB_WORKSPACE, where it was built), the tree and this tool
# mounted at their host paths, so every path compiled into the test binaries holds; the archive and
# the tool read-only. gvisor-run.sh runs inside as root and starts the tests as WHO. Results land in
# $SC/res as sc.py writes them; a unit this job never wrote reads UNKNOWN in the summary.
#   gvisor.sh WHO PART SHARD     WHO: uid1000 or root; PART: set (shard SHARD) or builtins
# Nothing is built here.
set -uo pipefail
who=$1 part=$2 shard=$3
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
mkdir -p "$SC/res/logs" "$SC/meta" "$SC_TREE/target"
# The tree belongs to the user the tests run as, as on a host row (set.sh, nextest.sh): tests write
# their scratch directories into their crate's directory. Given back after the run.
[ "$who" = uid1000 ] && sudo chown -R 1000:1000 "$SC_TREE"
for f in binaries-metadata.json cargo-metadata.json; do
	cp "$CARGO_TARGET_DIR/nextest/$f" "$SC/meta/$f" || { echo "::error::the archive has no target/nextest/$f: it did not unpack"; exit 1; }
done
# The archive's own target/nextest (its metadata copied to $SC/meta above) and the tree's target/
# (nextest's store under --workspace-remap) are each a writable tmpfs, so nextest finds its store
# where it looks while the rest of the archive stays read-only.
args=(--rm --runtime=runsc --init --ulimit nofile=65536:65536
	-v "$CARGO_TARGET_DIR:$CARGO_TARGET_DIR:ro" --tmpfs "$CARGO_TARGET_DIR/nextest:mode=1777"
	-v "$SC_TREE:$SC_TREE" --tmpfs "$SC_TREE/target:mode=1777"
	-v "$GITHUB_WORKSPACE/tool:$GITHUB_WORKSPACE/tool:ro" -v "$SC/meta:/sc/meta:ro" -v "$SC/res:/sc/res"
	-e GITHUB_WORKSPACE -e CARGO_TARGET_DIR -e SC_TREE -e SC_TEST_PATH -e SC_BIN_BOUND -e SC_GV_SET_SHARDS)
if [ "$part" = builtins ]; then
	nx=$(command -v cargo-nextest) || { echo "::error::cargo-nextest is not installed"; exit 1; }
	args+=(-v "$nx:/usr/local/bin/cargo-nextest:ro")
fi
s=$(date +%s)
docker run "${args[@]}" sc-gv bash "$tool/gvisor-run.sh" "$who" "$part" "$shard"
rc=$?
sudo chown -R "$(id -u):$(id -g)" "$SC/res" "$SC_TREE"
echo "CONTAINER $who $part $shard: exit $rc in $(($(date +%s) - s)) s; $(find "$SC/res" -maxdepth 1 -name '*.json' | wc -l) results"
exit "$rc"
