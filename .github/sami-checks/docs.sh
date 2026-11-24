#!/usr/bin/env bash
# The docs row: rustdoc's broken intra-doc links in pi-shell, on the tree's own toolchain (the
# workflow's Toolchain step), built cold. `cargo doc --no-deps -p pi-shell` with
# -D rustdoc::broken_intra_doc_links and cargo's JSON messages; sc.py docs reads each error of that
# lint as a failure named by path, line, column and message. SC_PLANT=docs first adds sc.py's
# planted broken link to the tree (the row's control). The verdict is the summary's: this script
# ends 0 once it wrote its result.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
mkdir -p "$logs"
if [ "${SC_PLANT:-}" = docs ]; then
	python3 "$tool/sc.py" plant docs "$SC_TREE" || exit 1
fi
s=$(date +%s)
(cd "$SC_TREE" && RUSTDOCFLAGS='-D rustdoc::broken_intra_doc_links' timeout -k 10 3600 \
	cargo doc --no-deps --locked -p pi-shell --message-format=json) > "$logs/docs.jsonl" 2> "$logs/docs.log" < /dev/null
rc=$?
secs=$(($(date +%s) - s))
python3 "$tool/sc.py" docs "$logs/docs.jsonl" "$logs/docs.log" "$rc" "$secs" > "$SC/res/docs.json"
echo "DOCS exit=$rc ${secs}s, $(grep -c '^ *Compiling ' "$logs/docs.log") crates compiled"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print(" ", f) for f in r["failures"]]' "$SC/res/docs.json"
# Each error as rustdoc rendered it, for the reader of the job log.
jq -r 'select(.reason == "compiler-message" and .message.level == "error") | .message.rendered' "$logs/docs.jsonl" | head -n 600
tail -n 20 "$logs/docs.log"
exit 0
