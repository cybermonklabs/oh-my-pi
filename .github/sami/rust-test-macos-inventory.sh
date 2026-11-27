#!/usr/bin/env bash
# The macOS job's inventory, for .github/sami/rust-test.sh's RUST_TEST_ONLY:
# the tests only macOS can run. They are
#   - each test a macOS test binary lists that the Linux binary of the same
#     target does not (a test compiled only on macOS, `#[cfg(target_os =
#     "macos")]`);
#   - the tests .github/sami/rust-test-macos.txt names, which are #[ignore]d
#     on other targets.
# The Linux listings are the early ones the cut checks' build job writes
# from its cargo test binaries and, for a Bazel-only target, a Linux Bazel
# build (.github/sami/rust-test-early-listings.sh): every rust_test target or
# that step fails, and this job does not run. sami-checks.yml's
# rust-test-drift job compares them with rust_test's own Bazel listings
# (rust-test-listings-drift.sh) and fails rust_test's row for any difference,
# since this inventory was then made from a wrong one.
# A target with no Linux listing (listings from another tree) is UNKNOWN
# here: which of its tests only macOS compiles cannot be told, so none of them
# is taken (running them all would run its Linux tests on macOS and read their
# failures as macOS ones). The inventory then still lists every other target,
# writes complete=true to GITHUB_OUTPUT so the job runs the tests it lists,
# and exits 1, naming each UNKNOWN target.
# It builds every Bazel test target under //crates for macOS, lists each
# rust_test binary (listing_names, as the Linux listings are read), and
# compares it with the Linux listing of the same target. It fails when the
# Linux listings are missing, when a target fails to build for macOS or has
# no macOS binary (a compile error only macOS sees would otherwise drop its
# tests unseen), when a test rust-test-macos.txt names is in no macOS
# binary's listing, and when no macOS binary could be listed; those leave no
# complete=true.
# Usage: rust-test-macos-inventory.sh <Linux listings directory> <output list>
#   OMP_BAZEL_RC   the bazelrc fragment .github/actions/bazel-cache wrote
#   SAMI_FINDINGS  (optional) each error is also a line of this file
#                  (.github/sami/findings.sh), for the first-seen comparison
set -euo pipefail
# finding, finding_stop and findings_end (SAMI_FINDINGS).
# shellcheck source=.github/sami/findings.sh
. "$(dirname "${BASH_SOURCE[0]}")/findings.sh"
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
	finding_stop "macOS inventory" "bash ${BASH_VERSION} is too old: this script needs bash 4 or later"
	exit 1
fi
if [ "$#" != 2 ] || [ -z "${OMP_BAZEL_RC:-}" ]; then
	echo "usage: OMP_BAZEL_RC=<rc> rust-test-macos-inventory.sh <Linux listings directory> <output list>" >&2
	exit 2
fi
linux="$1" out="$2"
sami=.github/sami
tmp="$(mktemp -d "${RUNNER_TEMP:-/tmp}/macos-inventory.XXXXXX")"
stop() {
	finding_stop "macOS inventory" "$1"
	exit 1
}
# shellcheck source=.github/sami/rust-test-targets.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-targets.sh"
count() { awk 'END { print NR }' "$1"; }

[ -s "$linux/index.tsv" ] || stop "UNKNOWN: $linux/index.tsv is missing or empty, so no Linux listing can be compared"
declare -A linux_listing=()
while IFS=$'\t' read -r label file; do
	# A binary with no tests leaves an empty listing, which is no gap.
	[ -f "$linux/$file" ] || stop "UNKNOWN: the Linux listing $linux/$file of $label is missing"
	linux_listing["$label"]="$linux/$file"
done <"$linux/index.tsv"
echo "Linux listings read: ${#linux_listing[@]}"

# The rust_test targets, and a build of every test target for this host.
bazelisk query --output=label 'kind("rust_test rule", //crates/...) - attr(tags, "manual", //crates/...)' | LC_ALL=C sort -u >"$tmp/targets.txt"
[ -s "$tmp/targets.txt" ] || stop "bazel query names no rust_test target under //crates"
code=0
bazelisk --bazelrc="$OMP_BAZEL_RC" build --keep_going --build_tests_only -- //crates/... || code=$?
[ "$code" = 0 ] || stop "bazel build of the test targets for macOS exited $code: a target that does not build for macOS (above) would drop its tests unseen"
bin_root="$(bazelisk --bazelrc="$OMP_BAZEL_RC" info bazel-bin)"
[ -d "$bin_root" ] || stop "bazel info names no bazel-bin directory"

: >"$out"
listed=0
declare -A mac_listed=()
unknown=()
while read -r label; do
	path="${label#//}"
	bin="$bin_root/${path%%:*}/${path#*:}"
	if [ ! -x "$bin" ]; then
		stop "$label has no macOS binary at $bin, though bazel build passed: its tests cannot be listed"
	fi
	"$bin" --list >"$tmp/raw" || stop "$label's macOS binary $bin cannot list its tests"
	listing_names "$tmp/raw" >"$tmp/mac.txt"
	listed=$((listed + 1))
	while read -r name; do mac_listed["$label"$'\t'"$name"]=1; done <"$tmp/mac.txt"
	if [ -n "${linux_listing[$label]:-}" ]; then
		LC_ALL=C comm -23 "$tmp/mac.txt" "${linux_listing[$label]}" >"$tmp/only.txt"
	else
		: >"$tmp/only.txt"
		unknown+=("$label")
		finding "macOS inventory" "UNKNOWN: $label has no Linux listing: the target did not build on Linux, so which of its $(count "$tmp/mac.txt") macOS tests only macOS compiles cannot be told; none of them runs here"
	fi
	while read -r name; do
		printf '%s %s  compiled only on macOS\n' "$label" "$name" >>"$out"
	done <"$tmp/only.txt"
	echo "$label: $(count "$tmp/mac.txt") tests on macOS, $(count "$tmp/only.txt") not on Linux"
done <"$tmp/targets.txt"
[ "$listed" != 0 ] || stop "UNKNOWN: no macOS test binary could be listed"

# The tests #[ignore]d off macOS that rust-test-macos.txt names, read with the
# lists' one reader, list_entries, shared with rust-test.sh.
# shellcheck source=.github/sami/rust-test-lists.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-test-lists.sh"
list_entries "$sami/rust-test-macos.txt" 2 >"$tmp/named.tsv" || stop "$sami/rust-test-macos.txt has a malformed line (above)"
while IFS=$'\t' read -r label name; do
	[ -n "${mac_listed[$label$'\t'$name]:-}" ] || stop "$label $name is in $sami/rust-test-macos.txt but in no macOS binary's listing (renamed or removed: fix its line)"
	printf '%s %s  named in rust-test-macos.txt\n' "$label" "$name" >>"$out"
done <"$tmp/named.tsv"
LC_ALL=C sort -u -o "$out" "$out"
echo "macOS inventory: $(count "$out") tests ($(awk '/compiled only on macOS$/ { n++ } END { print n + 0 }' "$out") compiled only on macOS, $(awk '/named in rust-test-macos.txt$/ { n++ } END { print n + 0 }' "$out") named in rust-test-macos.txt)"
[ -s "$out" ] || stop "the macOS inventory is empty"
echo "complete=true" >>"${GITHUB_OUTPUT:-/dev/null}"
if [ "${#unknown[@]}" != 0 ]; then
	finding "macOS inventory" "UNKNOWN: ${#unknown[@]} target(s) with no Linux listing, whose macOS-only tests this job does not run: ${unknown[*]}"
	findings_end
	exit 1
fi
findings_end
