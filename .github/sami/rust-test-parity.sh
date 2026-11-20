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
#   a tested target is covered when its root source file is a src of a
#   rust_test, or a src of the crate a rust_test names in `crate`;
#   a doctested library is covered when its root source file is a src of the
#   crate a rust_doc_test names in `crate`.
#
# A rust_test or rust_doc_test tagged manual does not count: `bazel test
# //crates/...` skips it. Each target that is not covered is an error, named.
# A missing or empty cargo metadata, test list or rust_test set is an error,
# never a pass.
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

# Root source files of the crates the Bazel tests cover, as repository paths.
query() { # output file, query expression
	bazelisk query --output=label "$2" >"$tmp/labels" || fail "bazel query failed: $2"
	sed -n -e 's#^//:##p' -e 's#^//\([^:]*\):#\1/#p' "$tmp/labels" | LC_ALL=C sort -u >"$1" ||
		fail "could not read the labels of bazel query: $2"
}
# `$t` is a Bazel query variable (`let t = ... in`), not a shell one.
# shellcheck disable=SC2016
query "$tmp/tested" 'let t = kind("^rust_test rule$", //crates/...) - attr(tags, "manual", //crates/...) in labels(srcs, $t) + labels(srcs, labels(crate, $t))'
[ -s "$tmp/tested" ] || fail "bazel query names no source file of any rust_test"
# shellcheck disable=SC2016
query "$tmp/doctested" 'let t = kind("^rust_doc_test rule$", //crates/...) - attr(tags, "manual", //crates/...) in labels(srcs, labels(crate, $t))'

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
