#!/usr/bin/env bash
# The Linux listing of every Bazel rust_test target under //crates, for
# rust_test_macos's inventory (.github/sami/rust-test-macos-inventory.sh), in
# the format rust-test.sh leaves its own in: index.tsv, `<label>\t<file>` a
# line, and each file the target's test names, one a line, sorted (the
# listing_names reading of `<binary> --list`). The cut checks' "build the
# tests" job (sami-checks.yml) writes them from the test binaries of its
# nextest archive as soon as its cargo build ends, so the macOS job starts
# then, and does not wait for rust_test's Bazel build (71 minutes in run
# 45516812533). sami-checks.yml's rust-test-drift job compares rust_test's own
# listings with these as soon as rust_test ends (rust-test-listings-drift.sh).
#
# Which binary is which target. A test binary of the archive is the cargo
# target of its package whose name and kind it carries (cargo metadata); that
# target's root source file is a Bazel rust_test's when it is the test's crate
# root, read as rust-test-parity.sh reads it (bazel_test_roots in
# rust-test-targets.sh): the test's crate_root, the root of the crate it
# names, or the src rules_rust picks. Nothing else counts, and no name is
# matched loosely. A binary whose root is the crate root of no rust_test fails,
# unless its package is one `bun run test:rs` leaves out (scripts/run-rs-task.ts,
# as rust-test-parity.sh reads it: such a package has no Bazel test target); a
# binary whose root is two rust_tests' crate root fails, and so do two binaries
# for one target. Each fails by the binary's name.
#
# A rust_test whose crate root is no cargo test target's (Bazel-only, as
# //crates/pi-natives:oauth_callback_relay_test's src/oauth_callback/relay.rs,
# which cargo builds through build.rs as a plain binary) is built by Bazel for
# Linux and its binary listed, so a target added later is listed too; one that
# does not build, or has no binary, fails by its label, and only it: when the
# one build of them all fails, each is built again alone, so a target that
# built is still listed. Every rust_test the query names gets exactly one
# listing, or this fails: a cargo test target with no binary in the archive
# leaves its rust_test with none, and a binary of a target Bazel built too
# lists it twice.
#
# Two halves. The Bazel half (`bazel`) reads cargo metadata and the query, and
# builds and lists the Bazel-only targets; it needs no cargo build, so the
# build job runs it in the background while cargo builds (its analysis fetched
# for 10 minutes in run 45559853019). The archive half (`archive`) maps and
# lists the archive's binaries, and adds the Bazel half's listings. With the
# three arguments of the archive half and no state directory, it runs both in
# turn.
#
# Usage, from the root of the tree under test:
#   rust-test-early-listings.sh bazel <state dir>
#   rust-test-early-listings.sh archive <state dir> <binaries-metadata.json> <target dir> <out dir>
#   rust-test-early-listings.sh <binaries-metadata.json> <target dir> <out dir>
#     <state dir>               the Bazel half's results; it must not exist yet. The Bazel half
#                               writes its exit status to <state dir>/bazel.rc last.
#     <binaries-metadata.json>  the archive's binary list (target/nextest/binaries-metadata.json)
#     <target dir>              where the archive's target directory is: each binary is at its
#                               binary-path, under this directory in place of the recorded one
#     <out dir>                 gets index.tsv and the listings; it must not exist yet
set -uo pipefail
usage() {
	echo "usage: rust-test-early-listings.sh bazel <state dir>" >&2
	echo "       rust-test-early-listings.sh archive <state dir> <binaries-metadata.json> <target dir> <out dir>" >&2
	echo "       rust-test-early-listings.sh <binaries-metadata.json> <target dir> <out dir>" >&2
	exit 2
}
if [ "${1:-}" = bazel ] && [ "$#" = 2 ]; then
	mode=bazel state="$2"
elif [ "${1:-}" = archive ] && [ "$#" = 5 ]; then
	mode=archive state="$2" meta="$3" target_dir="$4" out="$5"
elif [ "$#" = 3 ] && [ "$1" != bazel ] && [ "$1" != archive ]; then
	mode=both meta="$1" target_dir="$2" out="$3"
else
	usage
fi
stop() {
	echo "::error title=Early listings::$1"
	exit 1
}
bad=0
error() {
	echo "::error title=Early listings::$1"
	bad=1
}
count() { awk 'END { print NR }' "$1"; }
# shellcheck source=.github/sami/rust-test-targets.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-targets.sh"
root="$(pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# list <binary> <listing file>: the binary's test names, or 1 with the
# binary's own error on stderr.
list() {
	if [ ! -x "$1" ] || ! "$1" --list >"$tmp/list.raw" 2>"$tmp/list.err"; then
		cat "$tmp/list.err" >&2
		return 1
	fi
	listing_names "$tmp/list.raw" >"$2"
}

# The Bazel half, into <state dir>: excludes, targets, roots, bazel/ (each
# Bazel-only target's listing and its index.tsv), and bazel.rc last.
bazel_half() {
	local label path k=0 code=0 s bin_root
	[ ! -e "$state" ] || stop "$state exists already: the Bazel half writes a new directory"
	mkdir -p "$state/bazel" || stop "cannot make $state"
	: >"$state/bazel/index.tsv"
	# The packages test:rs leaves out.
	suite_excludes >"$state/excludes" || true
	[ -s "$state/excludes" ] || stop "found no VENDORED_FORK_EXCLUDES array in scripts/run-rs-task.ts, so the packages test:rs leaves out cannot be read"
	# Each cargo target of the root workspace: package id, package name, kind
	# (lib for every library crate type, as nextest names it), target name,
	# root source file relative to the repository, and whether cargo tests it.
	cargo metadata --no-deps --offline --format-version 1 >"$tmp/metadata.json" || stop "cargo metadata failed"
	jq -r --arg root "$root/" '
		.packages[] | .id as $id | .name as $package
		| .targets[]
		| (if any(.kind[]; . == "lib" or . == "rlib" or . == "dylib" or . == "cdylib" or . == "staticlib") then "lib" else .kind[0] end) as $kind
		| [$id, $package, $kind, .name, (.src_path | ltrimstr($root)), (.test | tostring)]
		| @tsv' "$tmp/metadata.json" >"$state/targets" || stop "could not read the cargo targets from cargo metadata"
	[ -s "$state/targets" ] || stop "cargo metadata names no target"
	# Each rust_test the Bazel jobs run, with its crate root.
	bazelisk query --output=streamed_jsonproto "$bazel_test_query" >"$tmp/rules.json" || stop "bazel query failed: $bazel_test_query"
	bazel_test_roots "$tmp/rules.json" | awk -F'\t' '$1 == "test" { print $2 "\t" $3 }' | LC_ALL=C sort -u >"$state/roots" || stop "could not read the crate roots from bazel query"
	if grep -E $'\t''NO (ROOT|RULE|CRATE) FOR ' "$state/roots"; then
		stop "the crate root of a Bazel rust_test above could not be found"
	fi
	[ -s "$state/roots" ] || stop "UNKNOWN: bazel query names no rust_test under //crates"
	# The Bazel-only rust_tests: those whose crate root no cargo test target has.
	awk -F'\t' 'NR == FNR { if ($6 == "true") tested[$5] = 1; next } !($2 in tested) { print $1 }' "$state/targets" "$state/roots" >"$state/bazel-only"
	[ -s "$state/bazel-only" ] || return 0
	echo "Bazel-only rust_tests (no cargo test target has their crate root), built here for Linux: $(tr '\n' ' ' <"$state/bazel-only")"
	s=$(date +%s)
	# shellcheck disable=SC2046 # one label a word
	bazelisk build -- $(cat "$state/bazel-only") || code=$?
	echo "Bazel build of the Bazel-only rust_tests: exit $code, $(($(date +%s) - s)) s"
	# That one build stops at the first target that fails and its exit names
	# no target, so after a failure each is built again alone: a target fails
	# by its own build's exit, and the others are still listed. In run
	# 46036206702 (Cut18 95097f22) zle_vi_pty_test's missing source failed the
	# one build, and oauth_callback_relay_test, which had built, read failed too.
	if [ "$code" = 0 ]; then
		cp "$state/bazel-only" "$tmp/built" || stop "cannot copy $state/bazel-only"
	else
		: >"$tmp/built"
		while read -r label; do
			code=0
			bazelisk build -- "$label" </dev/null || code=$?
			echo "Bazel build of $label alone: exit $code"
			if [ "$code" = 0 ]; then
				printf '%s\n' "$label" >>"$tmp/built"
			else
				error "$label: Bazel-only (no test binary of the archive is it), and the bazel build of it alone for Linux exited $code (above), so it has no Linux listing"
			fi
		done <"$state/bazel-only"
		[ -s "$tmp/built" ] || return 0
	fi
	bin_root="$(bazelisk info bazel-bin)" || stop "bazel info names no bazel-bin directory"
	while read -r label; do
		path="${label#//}"
		k=$((k + 1))
		if list "$bin_root/${path%%:*}/${path#*:}" "$state/bazel/$k.txt"; then
			printf '%s\t%s\n' "$label" "$k.txt" >>"$state/bazel/index.tsv"
		else
			error "$label: its binary $bin_root/${path%%:*}/${path#*:} cannot list its tests"
		fi
	done <"$tmp/built"
}

# The archive half, into <out dir>: each binary's listing as its target's,
# then the Bazel half's.
archive_half() {
	local id package_id kind name path package src labels n matches label file k=0 from_archive=0 rc
	local -A listed_from=()
	local left_out=()
	[ -e "$state/bazel.rc" ] || stop "UNKNOWN: the Bazel half has not finished ($state/bazel.rc is missing), so its listings and the crate roots cannot be read"
	rc="$(cat "$state/bazel.rc")"
	[ "$rc" = 0 ] || error "the Bazel half exited [$rc] (its errors above): a Bazel-only target it did not list has no listing"
	[ -s "$state/roots" ] && [ -s "$state/targets" ] && [ -s "$state/excludes" ] || stop "UNKNOWN: the Bazel half left no crate roots, cargo targets or excludes in $state"
	[ ! -e "$out" ] || stop "$out exists already: the listings go in a new directory"
	mkdir -p "$out" || stop "cannot make $out"
	: >"$tmp/index"
	# The archive's test binaries: id, package id, kind, name, path here.
	[ -s "$meta" ] || stop "UNKNOWN: $meta is missing or empty, so no test binary can be listed"
	jq -r --arg here "$target_dir" '
		.["rust-build-meta"]["target-directory"] as $there
		| .["rust-binaries"][]
		| [.["binary-id"], .["package-id"], .kind, .["binary-name"],
		   (.["binary-path"] | if startswith($there + "/") then $here + "/" + ltrimstr($there + "/") else "NOT UNDER " + $there end)]
		| @tsv' "$meta" | LC_ALL=C sort >"$tmp/binaries" || stop "could not read the test binaries from $meta"
	[ -s "$tmp/binaries" ] || stop "UNKNOWN: $meta names no test binary"
	while IFS=$'\t' read -r id package_id kind name path; do
		matches="$(awk -F'\t' -v p="$package_id" -v k="$kind" -v n="$name" '$1 == p && $3 == k && $4 == n' "$state/targets")"
		if [ -z "$matches" ] || [ "$(printf '%s\n' "$matches" | awk 'END { print NR }')" != 1 ]; then
			error "test binary $id ($kind $name of $package_id) is $(printf '%s' "$matches" | grep -c . || true) cargo targets in cargo metadata, not one, so its source cannot be told"
			continue
		fi
		IFS=$'\t' read -r _ package _ _ src _ <<<"$matches"
		labels="$(awk -F'\t' -v s="$src" '$2 == s { print $1 }' "$state/roots")"
		n="$(printf '%s' "$labels" | grep -c . || true)"
		if [ "$n" = 0 ]; then
			if grep -qxF -- "$package" "$state/excludes"; then
				left_out+=("$id")
				echo "Not listed: test binary $id ($src), of $package, a package test:rs leaves out (scripts/run-rs-task.ts), which has no Bazel rust_test"
			else
				error "test binary $id ($src) maps to no Bazel rust_test: no rust_test under //crates has $src as its crate root"
			fi
			continue
		fi
		if [ "$n" != 1 ]; then
			error "test binary $id ($src) maps to $n Bazel rust_tests, which all have $src as their crate root: $(printf '%s' "$labels" | tr '\n' ' ')"
			continue
		fi
		case "$path" in "NOT UNDER "*)
			error "test binary $id: its binary-path in $meta is not under the archive's target-directory (${path#NOT UNDER })"
			continue
			;;
		esac
		if [ -n "${listed_from[$labels]:-}" ]; then
			error "test binary $id ($src) maps to $labels, which test binary ${listed_from[$labels]} maps to too"
			continue
		fi
		listed_from["$labels"]="$id"
		k=$((k + 1))
		if list "$path" "$out/$k.txt"; then
			printf '%s\t%s\n' "$labels" "$k.txt" >>"$tmp/index"
			from_archive=$((from_archive + 1))
		else
			error "$labels: its binary $path (test binary $id) cannot list its tests"
		fi
	done <"$tmp/binaries"
	# The Bazel half's listings.
	while IFS=$'\t' read -r label file; do
		if [ -n "${listed_from[$label]:-}" ]; then
			error "$label is listed twice: test binary ${listed_from[$label]} of the archive is it, and the Bazel half built it as Bazel-only"
			continue
		fi
		k=$((k + 1))
		cp "$state/bazel/$file" "$out/$k.txt" || stop "cannot copy $state/bazel/$file"
		printf '%s\t%s\n' "$label" "$k.txt" >>"$tmp/index"
	done <"$state/bazel/index.tsv"
	LC_ALL=C sort -o "$out/index.tsv" "$tmp/index"
	# Each rust_test has exactly one listing.
	cut -f 1 "$out/index.tsv" | LC_ALL=C sort | uniq -d >"$tmp/twice"
	[ ! -s "$tmp/twice" ] || error "listed twice: $(tr '\n' ' ' <"$tmp/twice")"
	while read -r label; do
		error "$label: a rust_test bazel query names, with no listing (above, or a cargo test target with that crate root has no binary in the archive)"
	done < <(LC_ALL=C comm -23 <(cut -f 1 "$state/roots") <(cut -f 1 "$out/index.tsv" | LC_ALL=C sort -u))
	echo "Early listings: $(count "$out/index.tsv") of $(count "$state/roots") rust_test targets, $from_archive from the archive's $(count "$tmp/binaries") test binaries, $(count "$state/bazel/index.tsv") Bazel-only built by Bazel ($(cut -f 1 "$state/bazel/index.tsv" | tr '\n' ' ' | sed 's/ $//')); ${#left_out[@]} binaries of packages test:rs leaves out not listed (${left_out[*]:-none})"
}

case "$mode" in
bazel)
	# bazel.rc is written last, on every exit, so the archive half can tell a
	# Bazel half that ended from one still running. It is written whole and then
	# renamed, so a reader never sees it before its status is in it.
	trap 'rc=$?; rm -rf -- "$tmp"; [ -d "$state" ] && echo "$rc" >"$state/bazel.rc.new" && mv -f "$state/bazel.rc.new" "$state/bazel.rc"' EXIT
	bazel_half
	exit "$bad"
	;;
archive)
	archive_half
	exit "$bad"
	;;
both)
	state="$tmp/state"
	(
		trap 'rc=$?; [ -d "$state" ] && echo "$rc" >"$state/bazel.rc.new" && mv -f "$state/bazel.rc.new" "$state/bazel.rc"' EXIT
		bazel_half
		exit "$bad"
	)
	bad=0
	archive_half
	exit "$bad"
	;;
esac
