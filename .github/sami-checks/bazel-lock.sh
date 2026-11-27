#!/usr/bin/env bash
# The bazel-lock row: whether the tree's MODULE.bazel.lock is current for the tree, read by the
# tree's own `bun scripts/gen-bazel-lock.ts --check` (bazelisk fetch --repo=@crates
# --lockfile_mode=error) in the fixed environment of .github/sami/bazel-lock.sh, the one
# sami-build.yml's bazel_lock regenerates the lock in. sc.py bazel-lock reads it: FAIL only when
# Bazel names a file of the tree that changed, each file whose sha256 differs from the lock's record
# of it named; PASS when Bazel reads the lock current; UNKNOWN for anything else, an environment
# variable above all. One unit, MODULE.bazel.lock.
#
# SC_PLANT=bazel-lock first appends sc.py's planted line to the root Cargo.toml, which the lock
# records; the row must then read FAIL naming @@//Cargo.toml. The verdict is the summary's: this
# script ends 0 once it wrote a PASS or FAIL. A check that could not look (the runner or sc.py
# unreadable, the plant not placed, or a reading of UNKNOWN) writes the unit UNKNOWN naming why and
# ends 2, never 1, the code a finding would have.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
runner=$GITHUB_WORKSPACE/tool/.github/sami/bazel-lock.sh
res=$SC/res
logs=$res/logs
mkdir -p "$logs"

unknown() { # <what the job could not do>: the unit UNKNOWN, naming it; ends the job with 2
	echo "::error title=bazel-lock::UNKNOWN: $1"
	# sc.py result()'s fields, written without sc.py, which may be what could not be read.
	python3 -c 'import json, sys
r = {"row": "bazel-lock", "unit": "MODULE.bazel.lock", "who": "runner", "status": "UNKNOWN", "exit": "-", "seconds": 0.0,
     "passed": 0, "failed": 0, "ignored": 0, "self_skipped": [], "skip_lines": {}, "partial": [], "retries": {},
     "failures": [], "tests": [], "note": sys.argv[1]}
print(json.dumps(r))' "$1" > "$res/bazel-lock.json"
	exit 2
}

[ -r "$runner" ] || unknown "the runner .github/sami/bazel-lock.sh is not in the tool's checkout"
python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import sc' "$tool" || unknown "sc.py could not be read"
if [ "${SC_PLANT:-}" = bazel-lock ]; then
	python3 "$tool/sc.py" plant bazel-lock "$SC_TREE" || unknown "the plant could not be put in the tree's Cargo.toml"
fi
echo "bun $(bun --version 2>/dev/null || echo absent), bazelisk $(command -v bazelisk || echo absent)"
read -r rc secs < <(bash "$runner" run "$SC_TREE" "$logs/bazel-lock.log" --check)
[ -n "${rc:-}" ] || unknown "the runner printed no exit, so the check did not run"
echo "gen-bazel-lock --check: exit $rc, ${secs}s"
cat "$logs/bazel-lock.log"
python3 "$tool/sc.py" bazel-lock "$logs/bazel-lock.log" "$rc" "$secs" "$SC_TREE" > "$SC/bazel-lock.json" ||
	unknown "sc.py could not read the check's log"
mv "$SC/bazel-lock.json" "$res/bazel-lock.json" || unknown "the result could not be moved into place"
status=$(python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); print(r["status"]); print(r["note"], file=sys.stderr); [print(" ", f, file=sys.stderr) for f in r["failures"]]' "$res/bazel-lock.json") ||
	unknown "the result could not be read back"
echo "bazel-lock: $status"
[ "$status" != UNKNOWN ] || exit 2
exit 0
