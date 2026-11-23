#!/usr/bin/env bash
# The clippy row: `cargo clippy` of each crate in SC_CLIPPY_CRATES, one unit per crate, with the
# flags of the fork's hand-run clippy gate (kit-clippy driver.sh, its deny pass): --tests --no-deps
# --keep-going --message-format=short -- -D warnings, at the tree's pinned toolchain. One crate a
# run, so each crate has its own exit; with --no-deps a crate's run never fails on another
# workspace crate's findings. Before its run each crate's sources are touched, so cargo lints all
# its targets then and never takes them as fresh from a run that built the crate only as another
# crate's dependency (and so did not lint it).
#
# Then the control, as the kit's control tree: an unused import under #[cfg(test)] is planted in
# each crate's library root, and each crate is linted again. sc.py clippy passes a crate with no
# finding only when its control run read the plant as a finding. Writes $SC/res/clippy-<crate>.json
# and the logs in $SC/res/logs.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
res=$SC/res
mkdir -p "$res/logs"
cd "$SC_TREE" || exit 1
read -ra crates <<< "$SC_CLIPPY_CRATES"
echo "TOOLCHAIN $(rustc -V) | $(cargo clippy -V)"

cargo metadata --no-deps --format-version 1 > "$SC/metadata.json" || exit 1
declare -A dir lib rc secs
while IFS=$'\t' read -r c d l; do
	dir[$c]=$d
	lib[$c]=$l
done < <(python3 "$tool/sc.py" clippy-crates "$SC/metadata.json" "${crates[@]}")

lint() { # <crate> <log>: prints "<exit> <seconds>"
	local s r
	if [ "${dir[$1]}" != - ]; then find "${dir[$1]}" -type f -name '*.rs' -exec touch {} +; fi
	s=$(date +%s)
	timeout -k 30 2700 cargo clippy -p "$1" --tests --no-deps --keep-going --message-format=short -- -D warnings > "$2" 2>&1
	r=$?
	echo "$r $(($(date +%s) - s))"
}

for c in "${crates[@]}"; do
	read -r "rc[$c]" "secs[$c]" < <(lint "$c" "$res/logs/clippy-$c.log")
	echo "CLIPPY $c exit=${rc[$c]} ${secs[$c]}s; finding lines: $(grep -cE '^[^ ]+:[0-9]+:[0-9]+: (warning|error)' "$res/logs/clippy-$c.log")"
done

name=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import sc; print(sc.CLIPPY_CONTROL)' "$tool")
for c in "${crates[@]}"; do
	if [ "${lib[$c]}" != - ]; then printf '\n#[cfg(test)]\nuse std::collections::BTreeMap as %s;\n' "$name" >> "${lib[$c]}"; fi
done
echo "PLANTED $(git diff --stat | tail -n 1)"
for c in "${crates[@]}"; do
	read -r crc csecs < <(lint "$c" "$res/logs/clippy-$c.control.log")
	echo "CONTROL $c exit=$crc ${csecs}s; lines naming the plant: $(grep -cF "BTreeMap as $name" "$res/logs/clippy-$c.control.log")"
	python3 "$tool/sc.py" clippy "$res/logs/clippy-$c.log" "${rc[$c]}" "${secs[$c]}" "$c" "${dir[$c]}" \
		"$res/logs/clippy-$c.control.log" "${lib[$c]}" > "$res/clippy-$c.json"
	python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); print("UNIT", r["unit"], r["status"], r["failed"], "findings", r["note"])' "$res/clippy-$c.json"
done
df -h "$CARGO_TARGET_DIR" | tail -n 1
