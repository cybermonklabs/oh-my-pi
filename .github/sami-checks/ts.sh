#!/usr/bin/env bash
# The TypeScript rows, in the tree after `bun install` with the natives job's addon in
# packages/natives/native (the only addon a workspace load reads). Each `bun test` runs as the gate
# kit ran it (kit-tsx driver.sh): env -i with bun on PATH and a fresh HOME, stdin /dev/null, a JUnit
# report; sc.py bun reads it with bun's own summary line.
#   ts.sh small           natives, utils, scripts/ci-release-publish.test.ts, mnemopi --isolate
#   ts.sh ca SHARD        coding-agent --isolate, the files whose index (sorted) is SHARD mod N
#   ts.sh checkts         bun run check:ts
set -uo pipefail
mode=$1
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
bun=$(command -v bun)
mkdir -p "$SC/res/logs"

one() { # <row> <unit> <dir> <bound seconds> <bun test args...>
	local row=$1 unit=$2 dir=$3 bound=$4 safe home log junit s rc secs
	shift 4
	safe=$(printf '%s' "$row-$unit" | tr -c 'A-Za-z0-9_.-' '_')
	log=$SC/res/logs/$safe.log
	junit=$SC/res/logs/$safe.junit.xml
	home=$(mktemp -d)
	s=$(date +%s)
	(cd "$SC_TREE/$dir" && timeout -k 10 "$bound" env -i PATH="$(dirname "$bun"):/usr/bin:/bin" HOME="$home" \
		"$bun" test --reporter=junit --reporter-outfile="$junit" "$@" < /dev/null) > "$log" 2>&1
	rc=$?
	secs=$(($(date +%s) - s))
	rm -rf "${home:?}"
	python3 "$tool/sc.py" bun "$junit" "$log" "$rc" "$secs" "$row" "$unit" > "$SC/res/$safe.json"
	echo "BUN $row $unit exit=$rc ${secs}s $(grep -E '^Ran [0-9]+ tests? across' "$log" | tail -n 1)"
	grep -E '^\(fail\)' "$log" | head -n 40
}

case $mode in
small)
	one ts-small natives packages/natives 1800 test
	one ts-small utils packages/utils 1800 test
	one ts-small ci-release-publish . 900 ./scripts/ci-release-publish.test.ts
	one ts-small mnemopi packages/mnemopi 2700 --isolate test
	;;
ca)
	shard=$2
	mapfile -t files < <(cd "$SC_TREE/packages/coding-agent" && find test -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | LC_ALL=C sort)
	mine=()
	for i in "${!files[@]}"; do
		[ $((i % SC_CA_SHARDS)) = "$shard" ] && mine+=("./${files[$i]}")
	done
	echo "SHARD coding-agent $((shard + 1))/$SC_CA_SHARDS: ${#mine[@]} of ${#files[@]} files"
	[ "${#mine[@]}" -gt 0 ] || { echo "::error::no coding-agent test file in this shard"; exit 1; }
	one ts-ca "shard $((shard + 1))/$SC_CA_SHARDS" packages/coding-agent 3600 --isolate "${mine[@]}"
	;;
checkts)
	s=$(date +%s)
	(cd "$SC_TREE" && timeout -k 10 2400 "$bun" run check:ts) > "$SC/res/logs/checkts.log" 2>&1 < /dev/null
	rc=$?
	python3 "$tool/sc.py" plain "$rc" "$(($(date +%s) - s))" checkts check:ts "$SC/res/logs/checkts.log" > "$SC/res/checkts.json"
	echo "CHECKTS exit=$rc"
	tail -n 40 "$SC/res/logs/checkts.log"
	;;
*)
	echo "usage: ts.sh small | ca SHARD | checkts" >&2
	exit 2
	;;
esac
