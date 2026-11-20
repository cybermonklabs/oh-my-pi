#!/usr/bin/env bash
# Fail when a test target of the repository's own Rust suite has no Bazel test
# target, so `bazel test //crates/...` (the rust_test job in sami-build.yml)
# never builds or runs it.
#
# The suite is what `bun run test:rs` runs (scripts/run-rs-task.ts):
# `cargo nextest run --workspace` and `cargo test --doc --workspace`, both
# without the packages in its VENDORED_FORK_EXCLUDES. This script reads that
# list from scripts/run-rs-task.ts, so the two cannot drift apart. From
# `cargo metadata` it takes every target of the other workspace packages
# that cargo tests (`test: true`: a library's or a binary's unit tests, a
# tests/*.rs file) and every library whose examples rustdoc runs
# (`doctest: true`, for a lib, rlib or proc-macro crate type: rustdoc refuses
# a cdylib). Then:
#
#   a tested target is covered when its root source file is the crate root
#   of a rust_test: the test's own crate_root, or, for a test that names a
#   `crate`, that crate's root; where no crate_root is set, the root is the
#   one rules_rust picks (crate_root_src in rust/private/utils.bzl: the only
#   src, else the shortest src named lib.rs, main.rs for a binary, then
#   <name>.rs or <crate_name>.rs);
#   a doctested library is covered when its root source file is the root of
#   the crate a rust_doc_test names in `crate`.
#
# Any other src does not count: a tests/x.rs that only rides along in a
# rust_test_suite's shared_srcs is compiled as a module of another test, and
# its own tests never run as cargo runs them. A rust_test or rust_doc_test
# tagged manual does not count either: `bazel test //crates/...` skips it.
# A test Bazel skips as incompatible with the runner still counts here, since
# query does not evaluate target_compatible_with; the test step fails for it
# instead. Each target that is not covered is an error, named. A missing or
# empty cargo metadata, test list or rust_test set is an error, never a pass.
#
# Usage: rust-test-parity.sh, from the repository root. The query takes no
# --bazelrc: .github/actions/bazel-cache's fragment says `common --config=ci`,
# and ci is defined for build only, so a query that reads it fails (run
# 44712319794); upstream's ci.yml runs its queries without it too.
set -euo pipefail

fail() {
	echo "::error title=Rust test parity::$*"
	exit 1
}

root="$(pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# The packages test:rs leaves out: the strings of the VENDORED_FORK_EXCLUDES
# array other than "--exclude".
[ -f scripts/run-rs-task.ts ] || fail "scripts/run-rs-task.ts is missing, so the suite's excluded packages cannot be read"
awk '
	/^const VENDORED_FORK_EXCLUDES = \[/ { inlist = 1; found = 1; next }
	inlist && /^\]/ { exit }
	inlist {
		line = $0
		while (match(line, /"[^"]+"/)) {
			word = substr(line, RSTART + 1, RLENGTH - 2)
			if (word != "--exclude") print word
			line = substr(line, RSTART + RLENGTH)
		}
	}
' scripts/run-rs-task.ts >"$tmp/excludes"
[ -s "$tmp/excludes" ] || fail "found no VENDORED_FORK_EXCLUDES array in scripts/run-rs-task.ts"
echo "Packages test:rs excludes: $(tr '\n' ' ' <"$tmp/excludes")"

# Only the manifests are read, so any toolchain does: the stable one the
# runner ships, rather than downloading the pinned nightly.
RUSTUP_TOOLCHAIN=stable cargo metadata --no-deps --offline --format-version 1 >"$tmp/metadata.json" ||
	fail "cargo metadata failed"
# One line per test target the suite runs: kind (test or doctest), package,
# target name, root source file relative to the repository.
jq -r --arg root "$root/" --rawfile excludes "$tmp/excludes" '
	($excludes | split("\n") | map(select(. != ""))) as $skip
	| .packages[]
	| select(.name as $name | $skip | index($name) | not)
	| .name as $package
	| .targets[]
	| (.src_path | ltrimstr($root)) as $src
	| (if .test then ["test", $package, .name, $src] else empty end),
	  (if .doctest and ([.crate_types[] | select(. == "lib" or . == "rlib" or . == "proc-macro")] | length > 0)
	   then ["doctest", $package, .name, $src] else empty end)
	| @tsv' "$tmp/metadata.json" | LC_ALL=C sort -u >"$tmp/required" || fail "could not read the test targets from cargo metadata"
[ -s "$tmp/required" ] || fail "cargo metadata names no test target"

# The crate roots the Bazel tests build, as repository paths, from each test
# rule and each crate a test names. One JSON object per rule, with its
# attributes as written and globs expanded.
# `$t` is a Bazel query variable (`let t = ... in`), not a shell one.
# shellcheck disable=SC2016
expr='let t = kind("^rust_(doc_)?test rule$", //crates/...) - attr(tags, "manual", //crates/...) in $t + labels(crate, $t)'
bazelisk query --output=streamed_jsonproto "$expr" >"$tmp/rules.json" || fail "bazel query failed: $expr"
jq -r -s '
	def attrs($r): ($r.attribute // []);
	def str($r; $n): [attrs($r)[] | select(.name == $n) | .stringValue // empty] | .[0] // "";
	def list($r; $n): [attrs($r)[] | select(.name == $n) | (.stringListValue // [])[]];
	def flag($r; $n): [attrs($r)[] | select(.name == $n) | .booleanValue] | .[0];
	def path: sub("^@@?"; "") | sub("^//:"; "") | sub("^//"; "") | sub(":"; "/");
	def base: split("/") | .[-1];
	def shortest($srcs; $b): [$srcs[] | select(path | base == $b)] | sort_by(path | length) | .[0];
	def root($r; $type):
		str($r; "crate_root") as $explicit
		| if $explicit != "" then $explicit
		  else list($r; "srcs") as $srcs
		  | ($r.name | split(":") | .[-1]) as $name
		  | (str($r; "crate_name") | if . == "" then $name else . end) as $crate_name
		  | (if ($srcs | length) == 1 then $srcs[0] else null end)
		    // shortest($srcs; if $type == "bin" then "main.rs" else "lib.rs" end)
		    // shortest($srcs; $name + ".rs")
		    // shortest($srcs; $crate_name + ".rs")
		    // ("NO ROOT FOR " + $r.name)
		  end
		| path;
	def type($r): if $r.ruleClass == "rust_binary" then "bin" else "lib" end;
	[.[] | select(.type == "RULE") | .rule] as $rules
	| ($rules | map({key: .name, value: .}) | from_entries) as $by_name
	| $rules[]
	| select(.ruleClass == "rust_test" or .ruleClass == "rust_doc_test")
	| . as $t
	| str($t; "crate") as $crate
	| (if $crate != "" then
	     ($by_name[$crate] // null) as $c
	     | if $c == null then "NO RULE FOR " + $crate else root($c; type($c)) end
	   elif .ruleClass == "rust_doc_test" then "NO CRATE FOR " + .name
	   else root($t; if flag($t; "use_libtest_harness") == false then "bin" else "lib" end) end) as $root
	| [(if .ruleClass == "rust_test" then "test" else "doctest" end), $root]
	| @tsv' "$tmp/rules.json" | LC_ALL=C sort -u >"$tmp/roots" || fail "could not read the crate roots from bazel query"
if grep -E $'\t''NO (ROOT|RULE|CRATE) FOR ' "$tmp/roots"; then
	fail "the crate root of a Bazel test above could not be found"
fi
awk -F'\t' '$1 == "test" { print $2 }' "$tmp/roots" >"$tmp/tested"
awk -F'\t' '$1 == "doctest" { print $2 }' "$tmp/roots" >"$tmp/doctested"
[ -s "$tmp/tested" ] || fail "bazel query names no crate root of any rust_test"

total=0
missing=0
while IFS=$'\t' read -r kind package name src; do
	total=$((total + 1))
	if [ "$kind" = test ]; then
		covers="$tmp/tested"
		rule=rust_test
	else
		covers="$tmp/doctested"
		rule=rust_doc_test
	fi
	if ! grep -qxF -- "$src" "$covers"; then
		echo "::error title=Rust test parity::$package's $kind target $name ($src) has no Bazel $rule, so bazel test //crates/... never runs it"
		missing=$((missing + 1))
	fi
done <"$tmp/required"
echo "Rust test parity: $total test targets in the suite, $missing without a Bazel test target"
[ "$missing" = 0 ]
