#!/usr/bin/env bash
# sami-checks.yml's rust-test-drift check of the early listings
# (rust-test-early-listings.sh, from the cut checks' cargo test binaries)
# that rust_test_macos's inventory read,
# against rust_test's own listings of its Bazel test binaries (rust-test.sh's
# listings directory). Both are index.tsv (`<label>\t<file>`) and one sorted
# test name a line per file. Each difference is an error naming the target and
# each test: a test in one listing of a target and not the other, and a target
# with a listing on one side only. Any difference fails, since the macOS
# inventory of the run was then made from a wrong Linux listing. Two
# directories that list no target at all fail too: a comparison of nothing has
# not passed. With SAMI_FINDINGS set, each error is also a line of that file
# (.github/sami/findings.sh), for sami-checks.yml's first-seen comparison.
# Usage: rust-test-listings-drift.sh <early listings> <Bazel listings>
set -uo pipefail
if [ "$#" != 2 ]; then
	echo "usage: rust-test-listings-drift.sh <early listings> <Bazel listings>" >&2
	exit 2
fi
early="$1" bazel="$2"
# finding, finding_stop and findings_end (SAMI_FINDINGS).
# shellcheck source=.github/sami/findings.sh
. "$(dirname "${BASH_SOURCE[0]}")/findings.sh"
stop() {
	finding_stop "Listing drift" "$1"
	exit 1
}
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
# read_index <dir> <side> <out>: `<label>\t<path>` per target, each listing
# file present. The loop runs in this shell, not in a pipeline's subshell, so
# that a missing listing stops the script.
read_index() {
	[ -s "$1/index.tsv" ] || stop "UNKNOWN: $1/index.tsv ($2) is missing or empty, so nothing can be compared"
	: >"$3.read"
	while IFS=$'\t' read -r label file; do
		[ -f "$1/$file" ] || stop "UNKNOWN: the $2 listing $1/$file of $label is missing"
		printf '%s\t%s\n' "$label" "$1/$file" >>"$3.read"
	done <"$1/index.tsv"
	LC_ALL=C sort -t $'\t' -k 1,1 "$3.read" >"$3"
	if [ -n "$(cut -f 1 "$3" | uniq -d)" ]; then
		stop "UNKNOWN: $1/index.tsv ($2) lists a target twice: $(cut -f 1 "$3" | uniq -d | tr '\n' ' ')"
	fi
}
read_index "$early" "early" "$tmp/early"
read_index "$bazel" "Bazel" "$tmp/bazel"

differences=0
targets=0
while IFS=$'\t' read -r label e b; do
	targets=$((targets + 1))
	if [ "$b" = - ]; then
		finding "Listing drift" "$label has an early listing ($(awk 'END { print NR }' "$e") tests) and no listing of rust_test's: the macOS inventory read a target Bazel did not list here"
		differences=$((differences + 1))
		continue
	fi
	if [ "$e" = - ]; then
		finding "Listing drift" "$label has a listing of rust_test's ($(awk 'END { print NR }' "$b") tests) and no early listing: the macOS inventory read it as UNKNOWN, or not at all"
		differences=$((differences + 1))
		continue
	fi
	while IFS= read -r line; do
		case "$line" in
		$'\t'*) finding "Listing drift" "$label ${line#$'\t'}: in rust_test's listing, not in the early one the macOS inventory read" ;;
		*) finding "Listing drift" "$label $line: in the early listing the macOS inventory read, not in rust_test's" ;;
		esac
		differences=$((differences + 1))
	done < <(LC_ALL=C comm -3 "$e" "$b")
done < <(LC_ALL=C join -t $'\t' -a 1 -a 2 -e - -o 0,1.2,2.2 "$tmp/early" "$tmp/bazel")
[ "$targets" != 0 ] || stop "UNKNOWN: no target to compare"
echo "Listing drift: $differences differences in $targets targets (early $(awk 'END { print NR }' "$tmp/early"), rust_test's $(awk 'END { print NR }' "$tmp/bazel"))"
findings_end
[ "$differences" = 0 ]
