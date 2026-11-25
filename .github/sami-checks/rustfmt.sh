#!/usr/bin/env bash
# The rustfmt row: `cargo fmt --all --check -v` in each cargo workspace the gate builds (sc.py
# rustfmt-workspaces: the root one, and each one .github/sami/rust-test-cargo-workspaces.txt lists),
# from the workspace's own directory, on the tree's own toolchain (the workflow's Toolchain step).
# rustfmt reads the rustfmt.toml nearest each file, so a workspace with none of its own takes the
# root's, as a developer's `cargo fmt` there does. One unit per workspace, named by its Cargo.toml;
# sc.py rustfmt reads each log: FAIL names each place rustfmt would change. A formatter only: it
# compiles nothing and runs no code of the tree. SC_PLANT=rustfmt first appends sc.py's planted
# function to the first target root of each workspace (the row's control: each unit must name it).
# The verdicts are the summary's: this script ends 0 once it wrote every result.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
mkdir -p "$logs"
echo "TOOLCHAIN $(cd "$SC_TREE" && rustc -V) | $(cd "$SC_TREE" && cargo fmt --version)"
mapfile -t manifests < <(python3 "$tool/sc.py" rustfmt-workspaces)
if [ "${#manifests[@]}" = 0 ]; then
	echo "::error::sc.py named no cargo workspace to check"
	exit 1
fi
if [ "${SC_PLANT:-}" = rustfmt ]; then
	python3 "$tool/sc.py" plant rustfmt "$SC_TREE" || exit 1
fi
for m in "${manifests[@]}"; do
	name=$(printf '%s' "$m" | tr -c 'A-Za-z0-9_-' '_')
	log=$logs/rustfmt-$name.log
	s=$(date +%s)
	if [ -f "$SC_TREE/$m" ]; then
		(cd "$(dirname "$SC_TREE/$m")" && timeout -k 10 600 cargo fmt --all --check -v) > "$log" 2>&1 < /dev/null
		rc=$?
	else
		: > "$log"
		rc=-
	fi
	secs=$(($(date +%s) - s))
	python3 "$tool/sc.py" rustfmt "$m" "$log" "$rc" "$secs" "$SC_TREE" > "$SC/res/rustfmt-$name.json"
	echo "RUSTFMT $m exit=$rc ${secs}s, $(grep -c '^\[' "$log") target root(s)"
	python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print(" ", f) for f in r["failures"]]' "$SC/res/rustfmt-$name.json"
	# Each place as rustfmt printed it, for the reader of the job log.
	grep -v '^\[' "$log" | head -n 400
done
exit 0
