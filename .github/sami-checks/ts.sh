#!/usr/bin/env bash
# The TypeScript rows, in the tree after `bun install` with the natives job's addon in
# packages/natives/native (the only addon a workspace load reads). Each `bun test` runs as the gate
# kit ran it (kit-tsx driver.sh): env -i with bun on PATH and a fresh HOME, stdin /dev/null, a JUnit
# report; sc.py bun reads it with bun's own summary line. When a test that known-failures.txt names
# `flaky: ` fails, the unit's whole `bun test` runs again (the same files, flags and order), at most
# twice, while such a test has not passed; the summary reads its failure KNOWN only when it passed in
# such a retry.
#   ts.sh small           the suites sc.py's TS_SMALL lists, one after another
#   ts.sh ca SHARD        coding-agent --isolate, the files whose index (sorted) mod N is SHARD - 1
#   ts.sh checkts         bun run check:ts
# The verdicts are the summary's: this script ends 0 once every unit wrote its result.
set -uo pipefail
mode=$1
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
bun=$(command -v bun)
mkdir -p "$SC/res/logs"
# The Chrome the browser tests launch: the pinned Chrome for Testing (bun.sh chrome), when set.
chrome_env=()
[ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ] && chrome_env=(PUPPETEER_EXECUTABLE_PATH="$PUPPETEER_EXECUTABLE_PATH")

one() { # <row> <unit> <dir> <bound seconds> <bun test args...>
	local row=$1 unit=$2 dir=$3 bound=$4 safe log junit s rc secs try rj t got
	shift 4
	safe=$(printf '%s' "$row-$unit" | tr -c 'A-Za-z0-9_.-' '_')
	log=$SC/res/logs/$safe.log
	junit=$SC/res/logs/$safe.junit.xml
	s=$(date +%s)
	bunrun "$dir" "$bound" "$junit" "$log" "$@"
	rc=$?
	secs=$(($(date +%s) - s))
	python3 "$tool/sc.py" bun "$junit" "$log" "$rc" "$secs" "$row" "$unit" > "$SC/res/$safe.json"
	echo "BUN $row $unit exit=$rc ${secs}s $(grep -E '^Ran [0-9]+ tests? across' "$log" | tail -n 1)"
	grep -E '^\(fail\)' "$log" | head -n 40 || true
	local flaky left
	mapfile -t flaky < <(python3 "$tool/sc.py" flaky-failed "$SC/res/$safe.json" "$tool/known-failures.txt")
	for try in 1 2; do
		[ "${#flaky[@]}" -gt 0 ] || break
		rj=$SC/res/logs/$safe.retry$try.xml
		bunrun "$dir" "$bound" "$rj" "$SC/res/logs/$safe.retry$try.log" "$@"
		left=()
		for t in "${flaky[@]}"; do
			got=$(python3 "$tool/sc.py" retried "$SC/res/$safe.json" "$t" "$rj" "the unit again: bun test, its $# arguments")
			echo "RETRY $row $unit $t: try $try of 2 (the whole unit): $got"
			[ "$got" = pass ] || left+=("$t")
		done
		flaky=(${left[@]+"${left[@]}"})
	done
}

bunrun() { # <dir> <bound seconds> <JUnit report> <log> <bun test args...>: one `bun test`; returns its exit
	local dir=$1 bound=$2 junit=$3 log=$4 home rc
	shift 4
	home=$(mktemp -d)
	(cd "$SC_TREE/$dir" && timeout -k 10 "$bound" env -i PATH="$(dirname "$bun"):/usr/bin:/bin" HOME="$home" \
		${chrome_env[@]+"${chrome_env[@]}"} "$bun" test --reporter=junit --reporter-outfile="$junit" "$@" < /dev/null) > "$log" 2>&1
	rc=$?
	rm -rf "${home:?}"
	return "$rc"
}

case $mode in
webmcp-probe)
	# A diagnostic, not a unit: test/tools/browser-webmcp.test.ts against the runner's own
	# google-chrome and against the pinned Chrome for Testing, each in a fresh HOME.
	for exe in "$(command -v google-chrome || true)" "${PUPPETEER_EXECUTABLE_PATH:-}"; do
		[ -n "$exe" ] || continue
		home=$(mktemp -d)
		out=$( (cd "$SC_TREE/packages/coding-agent" && timeout -k 10 600 env -i PATH="$(dirname "$bun"):/usr/bin:/bin" HOME="$home" \
			PUPPETEER_EXECUTABLE_PATH="$exe" "$bun" test ./test/tools/browser-webmcp.test.ts < /dev/null) 2>&1)
		rm -rf "${home:?}"
		echo "WEBMCP $("$exe" --version) ($exe): $(printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail)$' | tr -s ' \n' ' ')"
		printf '%s\n' "$out" | grep -m 3 -E 'does not expose WebMCP|no native WebMCP|cannot invoke' || true
	done
	;;
small)
	while IFS=$'\t' read -r -a f; do
		one ts-small "${f[0]}" "${f[1]}" "${f[2]}" "${f[@]:3}"
	done < <(python3 "$tool/sc.py" ts-small)
	;;
ca)
	shard=$2
	mapfile -t files < <(cd "$SC_TREE/packages/coding-agent" && find test -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | LC_ALL=C sort)
	mine=()
	for i in "${!files[@]}"; do
		[ $((i % SC_CA_SHARDS + 1)) = "$shard" ] && mine+=("./${files[$i]}")
	done
	echo "SHARD coding-agent $shard/$SC_CA_SHARDS: ${#mine[@]} of ${#files[@]} files"
	[ "${#mine[@]}" -gt 0 ] || { echo "::error::no coding-agent test file in this shard"; exit 1; }
	one ts-ca "shard $shard/$SC_CA_SHARDS" packages/coding-agent 3000 --isolate "${mine[@]}"
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
exit 0
