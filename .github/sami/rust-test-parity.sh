#!/usr/bin/env bash
# Fail when a test target of the repository's own Rust suite has no Bazel test
# target, so `bazel test //crates/...` (the rust_test job in sami-rust-test.yml)
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
# 44712319794); upstream's ci.yml runs its queries without it too. With
# SAMI_FINDINGS set, each error is also a line of that file
# (.github/sami/findings.sh), for sami-checks.yml's first-seen comparison.
set -euo pipefail
# finding, finding_stop and findings_end (SAMI_FINDINGS).
# shellcheck source=.github/sami/findings.sh
. "$(dirname "${BASH_SOURCE[0]}")/findings.sh"

fail() {
	finding_stop "Rust test parity" "$*"
	exit 1
}

root="$(pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
# The lists' one reader, list_entries, shared with rust-test.sh.
# shellcheck source=.github/sami/rust-test-lists.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-lists.sh"
# The test targets' one reader (suite_excludes, bazel_test_query,
# bazel_test_roots), shared with rust-test-early-listings.sh, which maps the
# cargo test binaries to Bazel's rust_test targets by the same crate roots.
# shellcheck source=.github/sami/rust-test-targets.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-targets.sh"

# The packages test:rs leaves out: the strings of the VENDORED_FORK_EXCLUDES
# array other than "--exclude".
[ -f scripts/run-rs-task.ts ] || fail "scripts/run-rs-task.ts is missing, so the suite's excluded packages cannot be read"
suite_excludes >"$tmp/excludes" || true
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

# A Cargo.toml outside the root workspace is a workspace Bazel does not
# build, whose tests the test step runs under cargo only when
# .github/sami/rust-test-cargo-workspaces.txt lists it. One whose tests no job
# runs, on purpose, is in .github/sami/rust-test-untested-manifests.txt with
# its reason. Every tracked Cargo.toml must be the root's, a root member's, or
# in one of the two lists; a line of the second must name a tracked Cargo.toml
# outside the root workspace, and no manifest may be in both.
jq -r --arg root "$root/" '.packages[].manifest_path | ltrimstr($root)' "$tmp/metadata.json" >"$tmp/members" ||
	fail "could not read the root workspace's manifests from cargo metadata"
echo Cargo.toml >>"$tmp/members"
LC_ALL=C sort -u -o "$tmp/root-members" "$tmp/members"
[ -f .github/sami/rust-test-cargo-workspaces.txt ] || fail ".github/sami/rust-test-cargo-workspaces.txt is missing"
list_entries .github/sami/rust-test-cargo-workspaces.txt 1 >"$tmp/cargo-workspaces" || fail ".github/sami/rust-test-cargo-workspaces.txt has a malformed line (above)"
[ -f .github/sami/rust-test-untested-manifests.txt ] || fail ".github/sami/rust-test-untested-manifests.txt is missing"
list_entries .github/sami/rust-test-untested-manifests.txt 1 >"$tmp/untested" || fail ".github/sami/rust-test-untested-manifests.txt has a malformed line (above)"
LC_ALL=C sort -u -o "$tmp/cargo-workspaces" "$tmp/cargo-workspaces"
LC_ALL=C sort -u -o "$tmp/untested" "$tmp/untested"
cat "$tmp/cargo-workspaces" "$tmp/untested" >>"$tmp/members"
LC_ALL=C sort -u -o "$tmp/members" "$tmp/members"
git ls-files -- 'Cargo.toml' '*/Cargo.toml' >"$tmp/manifests" || fail "git ls-files failed"
[ -s "$tmp/manifests" ] || fail "git ls-files names no Cargo.toml"
LC_ALL=C sort -u -o "$tmp/manifests" "$tmp/manifests"
unlisted=0
while read -r manifest; do
	finding "Rust test parity" "$manifest is outside the root workspace and in neither .github/sami/rust-test-cargo-workspaces.txt nor .github/sami/rust-test-untested-manifests.txt, so no job runs its tests and no line says why"
	unlisted=$((unlisted + 1))
done < <(LC_ALL=C comm -23 "$tmp/manifests" "$tmp/members")
while read -r manifest; do
	if ! grep -qxF -- "$manifest" "$tmp/manifests"; then
		finding "Rust test parity" "$manifest is in .github/sami/rust-test-untested-manifests.txt, but the tree under test tracks no such Cargo.toml: that line is for another tree"
	elif grep -qxF -- "$manifest" "$tmp/root-members"; then
		finding "Rust test parity" "$manifest is in .github/sami/rust-test-untested-manifests.txt, but it is the root workspace's, whose tests Bazel runs: remove its line"
	else
		echo "Untested on purpose, as .github/sami/rust-test-untested-manifests.txt says: $manifest"
		continue
	fi
	unlisted=$((unlisted + 1))
done <"$tmp/untested"
while read -r manifest; do
	finding "Rust test parity" "$manifest is in both .github/sami/rust-test-cargo-workspaces.txt (the job runs its tests) and .github/sami/rust-test-untested-manifests.txt (no job does): keep one line"
	unlisted=$((unlisted + 1))
done < <(LC_ALL=C comm -12 "$tmp/cargo-workspaces" "$tmp/untested")
echo "Cargo manifests: $(awk 'END { print NR }' "$tmp/manifests") tracked, $unlisted outside the root workspace and unlisted"

# The crate roots the Bazel tests build, as repository paths, from each test
# rule and each crate a test names. One JSON object per rule, with its
# attributes as written and globs expanded.
# The query and the reading of each root are bazel_test_query and
# bazel_test_roots (rust-test-targets.sh).
bazelisk query --output=streamed_jsonproto "$bazel_test_query" >"$tmp/rules.json" || fail "bazel query failed: $bazel_test_query"
bazel_test_roots "$tmp/rules.json" | cut -f 1,3 | LC_ALL=C sort -u >"$tmp/roots" || fail "could not read the crate roots from bazel query"
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
		finding "Rust test parity" "$package's $kind target $name ($src) has no Bazel $rule, so bazel test //crates/... never runs it"
		missing=$((missing + 1))
	fi
done <"$tmp/required"
echo "Rust test parity: $total test targets in the suite, $missing without a Bazel test target"

# A test target's `args` can drop tests from its binary (`--skip X`), as
# pi-builtins_test drops ::foreign_owner::, which a native_test runs as root.
# Each such skip must be run by another test target of the same binary (a
# native_test whose src is that target, with X as its filter), or be named in
# .github/sami/rust-test-sanctioned-skips.txt; otherwise those tests run
# nowhere.
[ -f .github/sami/rust-test-sanctioned-skips.txt ] || fail ".github/sami/rust-test-sanctioned-skips.txt is missing"
list_entries .github/sami/rust-test-sanctioned-skips.txt 2 >"$tmp/sanctioned" || fail ".github/sami/rust-test-sanctioned-skips.txt has a malformed line (above)"
LC_ALL=C sort -u -o "$tmp/sanctioned" "$tmp/sanctioned"
jq -r -s '
	def attrs($r): ($r.attribute // []);
	def str($r; $n): [attrs($r)[] | select(.name == $n) | .stringValue // empty] | .[0] // "";
	def list($r; $n): [attrs($r)[] | select(.name == $n) | (.stringListValue // [])[]];
	.[] | select(.type == "RULE") | .rule
	| select(.ruleClass == "rust_test" or .ruleClass == "native_test")
	| . as $r
	| (if .ruleClass == "native_test" then str($r; "src") else .name end) as $binary
	| list($r; "args") as $a
	| (reduce range(0; $a | length) as $i ({skip: [], filter: [], take: false};
		if .take then .skip += [$a[$i]] | .take = false
		elif $a[$i] == "--skip" then .take = true
		elif ($a[$i] | startswith("--skip=")) then .skip += [$a[$i][7:]]
		elif ($a[$i] | startswith("-")) then .
		else .filter += [$a[$i]] end)) as $parsed
	| ($parsed.skip[] | ["skip", $binary, $r.name, .]), ($parsed.filter[] | ["filter", $binary, $r.name, .])
	| @tsv' "$tmp/rules.json" >"$tmp/args" || fail "could not read the test targets' args from bazel query"
awk -F'\t' '$1 == "filter" { print $2 "\t" $4 }' "$tmp/args" | LC_ALL=C sort -u >"$tmp/filters"
dropped=0
while IFS=$'\t' read -r _ binary rule value; do
	if grep -qxF -- "$binary"$'\t'"$value" "$tmp/filters"; then
		continue
	fi
	if grep -qxF -- "$rule"$'\t'"$value" "$tmp/sanctioned"; then
		echo "Sanctioned skip in $rule's args: $value"
		continue
	fi
	finding "Rust test parity" "$rule's args skip $value, and no other test target of that binary runs it, so those tests run nowhere"
	dropped=$((dropped + 1))
done < <(awk -F'\t' '$1 == "skip"' "$tmp/args")
echo "Skips in test targets' args: $(awk -F'\t' '$1 == "skip" { n++ } END { print n + 0 }' "$tmp/args"), $dropped run nowhere"
findings_end
[ "$missing" = 0 ] && [ "$unlisted" = 0 ] && [ "$dropped" = 0 ]
