#!/usr/bin/env bash
# The docs row: rustdoc's broken intra-doc links in pi-shell, on the tree's own toolchain (the
# workflow's Toolchain step), built cold. Two units, one after the other in the same target dir:
# `public`, `cargo doc --no-deps -p pi-shell` as docs.rs would build it, and `private`, the same with
# --document-private-items, so a broken link in a private item's docs is read too. Each runs with
# -D rustdoc::broken_intra_doc_links and cargo's JSON messages; sc.py docs reads each error of that
# lint as a failure named by path, line, column and message. SC_PLANT=docs first adds sc.py's
# planted broken link to the tree (the row's control: both units must name it). The verdicts are
# the summary's: this script ends 0 once it wrote both results.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
mkdir -p "$logs"
if [ "${SC_PLANT:-}" = docs ]; then
	python3 "$tool/sc.py" plant docs "$SC_TREE" || exit 1
fi
for unit in public private; do
	extra=()
	[ "$unit" = private ] && extra=(--document-private-items)
	s=$(date +%s)
	(cd "$SC_TREE" && RUSTDOCFLAGS='-D rustdoc::broken_intra_doc_links' timeout -k 10 3600 \
		cargo doc --no-deps --locked -p pi-shell --message-format=json ${extra[@]+"${extra[@]}"}) \
		> "$logs/docs-$unit.jsonl" 2> "$logs/docs-$unit.log" < /dev/null
	rc=$?
	secs=$(($(date +%s) - s))
	python3 "$tool/sc.py" docs "$unit" "$logs/docs-$unit.jsonl" "$logs/docs-$unit.log" "$rc" "$secs" > "$SC/res/docs-$unit.json"
	echo "DOCS $unit exit=$rc ${secs}s, $(grep -c -E '^ *(Compiling|Checking) ' "$logs/docs-$unit.log") crates built"
	python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print(" ", f) for f in r["failures"]]' "$SC/res/docs-$unit.json"
	# Each error as rustdoc rendered it, for the reader of the job log.
	jq -r 'select(.reason == "compiler-message" and .message.level == "error") | .message.rendered' "$logs/docs-$unit.jsonl" | head -n 800
	tail -n 20 "$logs/docs-$unit.log"
done
exit 0
