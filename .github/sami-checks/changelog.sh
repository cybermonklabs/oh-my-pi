#!/usr/bin/env bash
# The changelog row: `bun scripts/fix-changelogs.ts --check` in the tree after `bun install`, with the
# tree's full history and tags (the workflow's checkout), since the tool reads its baseline from the
# latest v* tag and the archive links from `git rev-list`. It runs as ts.sh runs bun: env -i with bun
# on PATH and a fresh HOME, so an archive link names the tree's default repository as on the release
# owner's box, not this runner's GITHUB_REPOSITORY. When the check says it would rewrite a CHANGELOG,
# the tool's write mode runs once in the same tree, and a `diff -u` of each CHANGELOG against its
# state before gives the first lines the rewrite changes. sc.py changelog reads both. SC_PLANT=changelog
# first adds sc.py's planted empty heading (the row's control). The verdict is the summary's: this
# script ends 0 once it wrote its result.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
bun=$(command -v bun)
mkdir -p "$logs"
if [ "${SC_PLANT:-}" = changelog ]; then
	python3 "$tool/sc.py" plant changelog "$SC_TREE" || exit 1
fi
mapfile -t files < <(cd "$SC_TREE" && printf '%s\n' packages/*/CHANGELOG.md)
before=$(mktemp -d)
for f in "${files[@]}"; do
	mkdir -p "$before/$(dirname "$f")" && cp "$SC_TREE/$f" "$before/$f"
done
fix() { # <log> <fix-changelogs args...>: one run of the tool; returns its exit
	local log=$1 home rc
	shift
	home=$(mktemp -d)
	(cd "$SC_TREE" && timeout -k 10 600 env -i PATH="$(dirname "$bun"):/usr/bin:/bin" HOME="$home" \
		"$bun" scripts/fix-changelogs.ts "$@" < /dev/null) > "$log" 2>&1
	rc=$?
	rm -rf "${home:?}"
	return "$rc"
}
s=$(date +%s)
fix "$logs/changelog.log" --check
rc=$?
secs=$(($(date +%s) - s))
: > "$logs/changelog.diff"
if [ "$rc" = 1 ]; then
	fix "$logs/changelog-write.log"
	echo "the write run: exit $? / $(tr '\n' '/' < "$logs/changelog-write.log")"
	for f in "${files[@]}"; do
		diff -u --label "a/$f" --label "b/$f" "$before/$f" "$SC_TREE/$f" >> "$logs/changelog.diff"
	done
fi
rm -rf "${before:?}"
python3 "$tool/sc.py" changelog "$logs/changelog.log" "$rc" "$secs" "${#files[@]}" "$logs/changelog.diff" > "$SC/res/changelog.json"
echo "CHANGELOG --check exit=$rc ${secs}s over ${#files[@]} files"
cat "$logs/changelog.log"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print(" ", f) for f in r["failures"]]' "$SC/res/changelog.json"
head -n 200 "$logs/changelog.diff"
exit 0
