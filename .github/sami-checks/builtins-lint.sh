#!/usr/bin/env bash
# The builtins-lint row: pi-builtins (the crate of cp, rsync and the other builtins) under clippy and
# rustfmt, which no other row reads: the crate's Cargo.toml allows every clippy lint group, so the
# clippy row's run of it reads rustc's warnings only, and the root rustfmt.toml ignores it. Both
# opt-outs are lifted for the check, in this job's checkout only (sc.py builtins-lint-lift): the
# crate's [lints] becomes `[lints] workspace = true`, the levels every other crate of the workspace
# takes, and rustfmt.toml's `ignore` drops the patterns that hold the crate. Two units:
#   - clippy: `cargo clippy --all-targets --no-deps --keep-going --message-format=json -- --cap-lints
#     warn` of the crate. Capped at warn, a deny-level finding does not stop the build of pi-shell,
#     which depends on the crate and which the crate's tests need, so its tests are linted too;
#     rustc's dep-info of each compiled target names the files clippy read.
#   - rustfmt: `cargo fmt --check -v -- -v` of the crate, which the rustfmt row's reader reads.
# Both run from the workspace's root with --manifest-path, on the tree's toolchain, cold (the
# workflow's cache-mode none).
#
# Upstream's own findings are no failure of the fork's. When the tree has findings, the same checks
# run at the tree's upstream base, lifted the same way (upstream-base.sh, the rustfmt row's base),
# and sc.py builtins-clippy and builtins-rustfmt sort each finding as the rustfmt row sorts its
# places: upstream's own (KNOWN) when the lines it spans are lines the fork left as they are and the
# base has the same finding at the lines they map to; the fork's (FAIL) when it spans a line the fork
# changed or added, or its file is new, or the base lacks it; unsorted (UNKNOWN) when the base's
# check did not read its file.
#
# SC_PLANT=builtins-lint first appends sc.py's two planted consts to the crate's library root, one
# that clippy reports (under a lint the crate's own [lints] allows) and one rustfmt would space out
# (in the files rustfmt.toml ignores); each unit must then read FAIL naming its own. The verdicts are
# the summary's: this script ends 0 once it wrote both results. A step it cannot take (sc.py, the
# tree's metadata, the plant, the lift) writes both units UNKNOWN naming what it could not do, and
# ends 2: a row that checked nothing reads UNKNOWN, never PASS or FAIL, and its job's exit is never
# 1, the code a finding would have.
set -uo pipefail
tool=$GITHUB_WORKSPACE/tool/.github/sami-checks
res=$SC/res
logs=$res/logs
mkdir -p "$logs"
# shellcheck source=.github/sami-checks/upstream-base.sh
. "$tool/upstream-base.sh"

unknown() { # <what the job could not do>: both units UNKNOWN, naming it; ends the job with 2
	echo "::error title=builtins-lint::UNKNOWN: $1"
	# sc.py result()'s fields, written without sc.py, which may be what could not be read.
	for u in clippy rustfmt; do
		python3 -c 'import json, sys
r = {"row": "builtins-lint", "unit": sys.argv[1], "who": "runner", "status": "UNKNOWN", "exit": "-", "seconds": 0.0,
     "passed": 0, "failed": 0, "ignored": 0, "self_skipped": [], "skip_lines": {}, "partial": [], "retries": {},
     "failures": [], "tests": [], "note": sys.argv[2], "upstream_places": [], "unsorted_places": [], "upstream_base": ""}
print(json.dumps(r))' "$u" "$1" > "$res/builtins-lint-$u.json"
	done
	exit 2
}

crate=$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import sc; print(sc.BUILTINS_LINT_CRATE)' "$tool") ||
	unknown "sc.py could not be read, so the crate to check is not known"
echo "TOOLCHAIN $(cd "$SC_TREE" && rustc -V) | $(cd "$SC_TREE" && cargo clippy -V) | $(cd "$SC_TREE" && cargo fmt --version)"

# The crate's directory in the tree, from `cargo metadata --no-deps`; - when the tree has no such package.
(cd "$SC_TREE" && cargo metadata --no-deps --format-version 1) > "$SC/builtins-metadata.json" ||
	unknown "cargo metadata of the tree failed, so the crate could not be found"
# `-` where the tree has the metadata but no such package; a lookup that failed is no answer at all.
python3 "$tool/sc.py" clippy-crates "$SC/builtins-metadata.json" "$crate" > "$SC/builtins-crate.tsv" ||
	unknown "sc.py clippy-crates failed, so where the crate lies in the tree could not be read"
dir=$(cut -f2 "$SC/builtins-crate.tsv") ||
	unknown "the crate's directory could not be read from sc.py's answer, so where it lies is not known"
echo "CRATE $crate: ${dir:--}"
dir=${dir:--}

clippy() { # <tree> <log>: prints "<exit> <seconds>"
	local s r
	s=$(date +%s)
	(cd "$1" && timeout -k 30 2700 cargo clippy --manifest-path "$dir/Cargo.toml" --all-targets --no-deps --keep-going \
		--message-format=json -- --cap-lints warn) > "$2" 2>&1 < /dev/null
	r=$?
	echo "$r $(($(date +%s) - s))"
}

# `-- -v` makes rustfmt name each file it checks (`Formatting <path>`): at the base, that is the
# evidence that it read a file whose places the tree's run reports.
fmt() { # <tree> <log>: prints "<exit> <seconds>"
	local s r
	s=$(date +%s)
	(cd "$1" && timeout -k 10 600 cargo fmt --manifest-path "$dir/Cargo.toml" --check -v -- -v) > "$2" 2>&1 < /dev/null
	r=$?
	echo "$r $(($(date +%s) - s))"
}

clog=$logs/builtins-lint-clippy.log flog=$logs/builtins-lint-rustfmt.log
crc=- csecs=0 frc=- fsecs=0
: > "$clog"
: > "$flog"
if [ "$dir" != - ]; then
	if [ "${SC_PLANT:-}" = builtins-lint ]; then
		python3 "$tool/sc.py" plant builtins-lint "$SC_TREE" ||
			unknown "the plant could not be put in the tree, so the control could not run"
	fi
	python3 "$tool/sc.py" builtins-lint-lift "$SC_TREE" "$dir" ||
		unknown "the crate's lint opt-outs could not be lifted, so it could not be checked at the row's levels"
	read -r crc csecs < <(clippy "$SC_TREE" "$clog")
	echo "CLIPPY exit=$crc ${csecs}s; compiler messages: $(grep -c '"reason":"compiler-message"' "$clog")"
	read -r frc fsecs < <(fmt "$SC_TREE" "$flog")
	echo "RUSTFMT exit=$frc ${fsecs}s, $(grep -c '^\[' "$flog") target root(s)"
fi

# The upstream base, only when the tree has findings to sort, and the fork's changes from it in each
# file with a finding: a finding on lines the fork left as they are maps to its lines at the base.
base=- base_tree=$SC/upstream-base setup=$logs/builtins-lint-upstream-base.log fork=$logs/builtins-lint-fork.diff
cblog=$setup cbrc=- fblog=$setup fbrc=-
mapfile -t found < <(python3 "$tool/sc.py" builtins-lint-files "$SC_TREE" "$dir" "$clog" "$flog")
if [ "${#found[@]}" -gt 0 ]; then
	if b=$(upstream_base "$SC_TREE" "$base_tree" "$setup"); then
		base=$b
		mapfile -t files < <(printf '%s\n' "${found[@]}" | cut -f2 | sort -u)
		fork_diff "$SC_TREE" "$base" "$fork" "$setup" "${files[@]}"
		if [ ! -f "$base_tree/$dir/Cargo.toml" ]; then
			cbrc=absent fbrc=absent
		elif python3 "$tool/sc.py" builtins-lint-lift "$base_tree" "$dir" >> "$setup" 2>&1; then
			if printf '%s\n' "${found[@]}" | grep -q '^clippy'; then
				cblog=$logs/builtins-lint-clippy.upstream-base.log
				read -r cbrc cbsecs < <(clippy "$base_tree" "$cblog")
				echo "CLIPPY at the upstream base: exit=$cbrc ${cbsecs}s"
			fi
			if printf '%s\n' "${found[@]}" | grep -q '^rustfmt'; then
				fblog=$logs/builtins-lint-rustfmt.upstream-base.log
				read -r fbrc fbsecs < <(fmt "$base_tree" "$fblog")
				echo "RUSTFMT at the upstream base: exit=$fbrc ${fbsecs}s"
			fi
		else
			echo "::warning::the crate's opt-outs could not be lifted at the upstream base, so its findings stay unsorted (UNKNOWN):"
			tail -n 5 "$setup"
		fi
	else
		echo "::warning::the upstream base could not be set up, so the crate's findings stay unsorted (UNKNOWN):"
		tail -n 20 "$setup"
	fi
fi

# A reader that fails leaves its unit's file empty, which the summary reads as no result at all: so
# each writes to a temporary file first, and a failure makes both units UNKNOWN naming that reader.
for u in clippy rustfmt; do
	if [ "$u" = clippy ]; then
		set -- "$clog" "$crc" "$csecs" "$SC_TREE" "$dir" "$cblog" "$cbrc"
	else
		set -- "$flog" "$frc" "$fsecs" "$SC_TREE" "$dir" "$fblog" "$fbrc"
	fi
	if ! python3 "$tool/sc.py" "builtins-$u" "$@" "$base_tree" "$base" "$fork" > "$res/builtins-lint-$u.json.new"; then
		rm -f "$res/builtins-lint-$u.json.new"
		unknown "sc.py builtins-$u failed, so the $u unit's run could not be read"
	fi
	mv "$res/builtins-lint-$u.json.new" "$res/builtins-lint-$u.json" || {
		rm -f "$res/builtins-lint-$u.json.new"
		unknown "the $u unit's result could not be put in place, so what its run said is lost"
	}
done
# Each unit's verdict and note, and its findings by lint and by file (the fork's, upstream's own,
# unsorted), for the reader of the job log; the result files hold each finding by name.
for u in clippy rustfmt; do
	python3 - "$res/builtins-lint-$u.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"UNIT {r['unit']} {r['status']}: {r['note']}")
b = r.get("breakdown") or {}
for what in ("by_lint", "by_file"):
    rows = sorted(b.get(what, {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1], -kv[1][2], kv[0]))
    if rows:
        print(f"  {what}: FAIL KNOWN UNSORTED name")
    for k, (f, kn, un) in rows:
        print(f"  {f:6d} {kn:6d} {un:6d} {k}")
for f in r["failures"][:200]:
    print(f"  FAIL {f}")
EOF
done
df -h "$CARGO_TARGET_DIR" | tail -n 1
exit 0
