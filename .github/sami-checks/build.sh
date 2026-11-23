#!/usr/bin/env bash
# The one cargo build of the run: every test target of the root workspace, archived by
# `cargo nextest archive` for the test jobs, which build nothing. Writes the archive to $SC/up and
# the build record, the binary list (the archive's binaries-metadata.json) and the build log to
# $SC/build, which the summary reads.
set -uo pipefail
mkdir -p "$SC/up" "$SC/build"
rec=$SC/build/build.env
cd "$SC_TREE" || exit 1
restored=$(find "$CARGO_TARGET_DIR/debug/deps" -maxdepth 1 -type f 2> /dev/null | wc -l | tr -d ' ')
{
	echo "sha=$(git rev-parse HEAD)"
	echo "image=${ImageOS:-?}/${ImageVersion:-?}"
	echo "rustc=$(rustc -V)"
	echo "nextest=$(cargo nextest --version | head -n 1)"
	echo "cache_hit=${SC_CACHE_HIT:-}"
	echo "restored_deps=$restored"
} > "$rec"
s=$(date +%s)
cargo nextest archive --workspace --archive-file "$SC/up/tests.tar.zst" > "$SC/build/build.log" 2>&1
rc=$?
secs=$(($(date +%s) - s))
{
	echo "exit=$rc"
	echo "seconds=$secs"
	echo "compiled=$(grep -c '^ *Compiling ' "$SC/build/build.log")"
} >> "$rec"
cat "$rec"
if [ "$rc" != 0 ]; then
	grep -h -A 12 -E '^error(\[|:)' "$SC/build/build.log" | head -n 150
	exit "$rc"
fi
tar --zstd -xOf "$SC/up/tests.tar.zst" target/nextest/binaries-metadata.json > "$SC/build/binaries-metadata.json" ||
	{ echo "::error::the archive holds no target/nextest/binaries-metadata.json"; exit 1; }
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print("BINARIES", len(m["rust-binaries"]))' "$SC/build/binaries-metadata.json"
du -k "$SC/up/tests.tar.zst" | sed 's/^/ARCHIVE KiB /'
