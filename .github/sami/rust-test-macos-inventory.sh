#!/usr/bin/env bash
# The macOS job's inventory, for .github/sami/rust-test.sh's RUST_TEST_ONLY:
# the tests only macOS can run. They are
#   - each test a macOS test binary lists that the Linux binary of the same
#     target does not (a test compiled only on macOS, `#[cfg(target_os =
#     "macos")]`), and every test of a target Linux did not list at all;
#   - the tests .github/sami/rust-test-macos.txt names, which are #[ignore]d
#     on other targets.
# It builds every Bazel test target under //crates for macOS, lists each
# rust_test binary, and compares it with the Linux job's listing of the same
# target (rust-test.sh leaves them, with index.tsv, in its listings
# directory). It fails when the Linux listings are missing or name nothing,
# when a test rust-test-macos.txt names is in no macOS binary's listing, and
# when no macOS binary could be listed.
# Usage: rust-test-macos-inventory.sh <Linux listings directory> <output list>
#   OMP_BAZEL_RC   the bazelrc fragment .github/actions/bazel-cache wrote
set -euo pipefail
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
	echo "::error title=macOS inventory::bash ${BASH_VERSION} is too old: this script needs bash 4 or later"
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
	echo "::error title=macOS inventory::$1"
	exit 1
}
count() { awk 'END { print NR }' "$1"; }

[ -s "$linux/index.tsv" ] || stop "UNKNOWN: $linux/index.tsv is missing or empty, so no Linux listing can be compared"
declare -A linux_listing=()
while IFS=$'\t' read -r label file; do
	[ -s "$linux/$file" ] || stop "UNKNOWN: the Linux listing $linux/$file of $label is missing or empty"
	linux_listing["$label"]="$linux/$file"
done <"$linux/index.tsv"
echo "Linux listings read: ${#linux_listing[@]}"

# The rust_test targets, and a build of every test target for this host
# (Bazel leaves out a target incompatible with it).
bazelisk query --output=label 'kind("rust_test rule", //crates/...) - attr(tags, "manual", //crates/...)' | LC_ALL=C sort -u >"$tmp/targets.txt"
[ -s "$tmp/targets.txt" ] || stop "bazel query names no rust_test target under //crates"
code=0
bazelisk --bazelrc="$OMP_BAZEL_RC" build --keep_going --build_tests_only -- //crates/... || code=$?
case "$code" in
	0) ;;
	1) echo "::warning title=macOS inventory::some targets did not build for macOS (above); their tests are compared as unlisted" ;;
	*) stop "bazel build exited $code" ;;
esac
bin_root="$(bazelisk --bazelrc="$OMP_BAZEL_RC" info bazel-bin)"
[ -d "$bin_root" ] || stop "bazel info names no bazel-bin directory"

: >"$out"
listed=0
declare -A mac_listed=()
while read -r label; do
	path="${label#//}"
	bin="$bin_root/${path%%:*}/${path#*:}"
	if [ ! -x "$bin" ]; then
		echo "No macOS binary of $label (not built for macOS)"
		continue
	fi
	"$bin" --list >"$tmp/raw" || stop "$label's macOS binary $bin cannot list its tests"
	sed -n -e 's/: test$//p' -e 's/: benchmark$//p' "$tmp/raw" | LC_ALL=C sort -u >"$tmp/mac.txt"
	listed=$((listed + 1))
	while read -r name; do mac_listed["$label"$'\t'"$name"]=1; done <"$tmp/mac.txt"
	if [ -n "${linux_listing[$label]:-}" ]; then
		LC_ALL=C comm -23 "$tmp/mac.txt" "${linux_listing[$label]}" >"$tmp/only.txt"
	else
		cp "$tmp/mac.txt" "$tmp/only.txt"
	fi
	while read -r name; do
		printf '%s %s  compiled only on macOS\n' "$label" "$name" >>"$out"
	done <"$tmp/only.txt"
	echo "$label: $(count "$tmp/mac.txt") tests on macOS, $(count "$tmp/only.txt") not on Linux"
done <"$tmp/targets.txt"
[ "$listed" != 0 ] || stop "UNKNOWN: no macOS test binary could be listed"

# The tests #[ignore]d off macOS that rust-test-macos.txt names.
# The line format is list_entries' in rust-test.sh: the name runs from the
# first space to the first two spaces.
awk '/^[[:space:]]*(#|$)/ { next } { i = index($0, " "); t = substr($0, 1, i - 1); rest = substr($0, i + 1); j = index(rest, "  "); print t "\t" (j ? substr(rest, 1, j - 1) : rest) }' "$sami/rust-test-macos.txt" >"$tmp/named.tsv"
while IFS=$'\t' read -r label name; do
	[ -n "${mac_listed[$label$'\t'$name]:-}" ] || stop "$label $name is in $sami/rust-test-macos.txt but in no macOS binary's listing (renamed or removed: fix its line)"
	printf '%s %s  named in rust-test-macos.txt\n' "$label" "$name" >>"$out"
done <"$tmp/named.tsv"
LC_ALL=C sort -u -o "$out" "$out"
echo "macOS inventory: $(count "$out") tests ($(awk '/compiled only on macOS$/ { n++ } END { print n + 0 }' "$out") compiled only on macOS, $(awk '/named in rust-test-macos.txt$/ { n++ } END { print n + 0 }' "$out") named in rust-test-macos.txt)"
[ -s "$out" ] || stop "the macOS inventory is empty"
