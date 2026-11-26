#!/usr/bin/env bash
# The memory bench row: pi-shell's crates/pi-shell/benches/memory.rs, as `cargo bench -p pi-shell
# --bench memory` builds and runs it (cargo's bench profile, which inherits the tree's release
# profile), on the tree's toolchain, built cold. The build and the run are two steps, so that a bench
# that did not build reads apart from one that failed: `cargo bench --no-run --message-format=json`
# names the executable, which then runs once from pi-shell's directory with `--bench`, as cargo runs
# it. One unit; sc.py membench reads the bench's exit and every line it printed: FAIL when a target
# line reads MISS or the bench exits other than 0, whether or not the bench exits non-zero on a MISS.
# SC_PLANT=membench first plants a 1 MiB reserve in the kernel a Shell owns (sc.py PLANTS), which
# the bench's shell line must then read as a MISS. The verdicts are the summary's: this script ends
# 0 once it wrote the result.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
logs=$SC/res/logs
mkdir -p "$logs"
unit=crates/pi-shell/benches/memory.rs
echo "TOOLCHAIN $(cd "$SC_TREE" && rustc -V) | $(cd "$SC_TREE" && cargo -V)"
if [ "${SC_PLANT:-}" = membench ]; then
	python3 "$tool/sc.py" plant membench "$SC_TREE" || exit 1
fi
s=$(date +%s)
# .jsonl, not .json: the summary loads every .json under the results as a unit's result.
(cd "$SC_TREE" && timeout -k 10 3600 cargo bench -p pi-shell --bench memory --no-run --message-format=json-render-diagnostics) \
	> "$logs/membench-build.jsonl" 2> "$logs/membench-build.log" < /dev/null
brc=$?
bsecs=$(($(date +%s) - s))
echo "BUILD exit=$brc ${bsecs}s"
tail -n 30 "$logs/membench-build.log"
rc=- secs=0
: > "$logs/membench.out"
: > "$logs/membench.err"
if [ "$brc" = 0 ] && bin=$(python3 "$tool/sc.py" membench-bin "$logs/membench-build.jsonl"); then
	echo "BENCH $bin"
	s=$(date +%s)
	(cd "$SC_TREE/crates/pi-shell" && timeout -k 10 1200 "$bin" --bench) > "$logs/membench.out" 2> "$logs/membench.err" < /dev/null
	rc=$?
	secs=$(($(date +%s) - s))
fi
python3 "$tool/sc.py" membench "$unit" "$logs/membench.out" "$logs/membench.err" "$rc" "$secs" "$brc" "$logs/membench-build.log" \
	> "$SC/res/membench.json"
echo "MEMBENCH exit=$rc ${secs}s (its build ${bsecs}s)"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["status"], r["note"]); [print("  FAIL", f) for f in r["failures"]]' "$SC/res/membench.json"
echo "--- what the bench printed:"
cat "$logs/membench.out"
echo "--- its stderr (last 40 lines):"
tail -n 40 "$logs/membench.err"
exit 0
