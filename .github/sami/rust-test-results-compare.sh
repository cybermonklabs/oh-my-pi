#!/usr/bin/env bash
# The seed's control: the per-test results of two runs
# of the same commit, one built cold and one built from a seed, must name the
# same tests with the same status. A seed that changes a verdict is a seed
# nothing may trust, so sami-checks.yml's rust-test-compare job fails the
# rust_test row on any difference.
#
# Usage: rust-test-results-compare.sh <cold directory> <seeded directory> <known-failure list>
# Each directory holds the results.tsv .github/sami/rust-test.sh wrote:
#   <target> <test name> <final status> <status per invocation>
# with the final status `ok` when the test passed in any invocation or attempt,
# else `failed` when it failed in one, else `ignored`.
#
# Every test is compared by its final status. The column of each invocation's
# own statuses is compared too, except for the tests of a target some line of
# the known-failure list marks `flaky: `: Bazel runs such a target again after
# a failed attempt (--flaky_test_attempts), so the attempts of every test in it
# can differ between two runs of the same commit without anything being wrong.
#
# A missing file, an empty one, or a directory holding neither is UNKNOWN and
# fails: a comparison that read nothing has not passed. With SAMI_FINDINGS set,
# each error is also a line of that file (.github/sami/findings.sh), for
# sami-checks.yml's first-seen comparison; every finding is recorded in this
# shell, never in a pipeline's subshell, so that the file's end line counts
# each one.
set -uo pipefail

if [ "$#" != 3 ]; then
	echo "usage: rust-test-results-compare.sh <cold directory> <seeded directory> <known-failure list>" >&2
	exit 2
fi
cold="$1/results.tsv"
seeded="$2/results.tsv"
list="$3"
rc=0
# finding, finding_stop and findings_end (SAMI_FINDINGS).
# shellcheck source=.github/sami/findings.sh
. "$(dirname "${BASH_SOURCE[0]}")/findings.sh"
unknown() {
	finding_stop "Rust test results" "UNKNOWN: $1"
	exit 1
}
for f in "$cold" "$seeded"; do
	[ -f "$f" ] || unknown "$f is not there, so the seeded run's results were compared with nothing (the job that writes it failed, or its artifact is missing)"
	[ -s "$f" ] || unknown "$f is empty, so the seeded run's results were compared with nothing"
done
[ -f "$list" ] || unknown "$list is not there, so the tests whose attempts may differ are not known"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# lines <file>: its line count.
lines() { awk 'END { print NR }' "$1"; }
# step <what> <output> <expected lines> <command...>: one transformation, whose
# exit code and line count both decide. A tool that writes a part of its answer
# and fails, and one that writes a short answer and does not, leave a file this
# script would otherwise compare as if it were the results; both are UNKNOWN.
step() {
	local what="$1" out="$2" want="$3" got code=0
	shift 3
	"$@" >"$out" || code=$?
	[ "$code" = 0 ] || unknown "$what exited $code, so what it left is not the results"
	got="$(lines "$out")"
	[ "$got" = "$want" ] || unknown "$what wrote $got lines of $want: it read a part of the results"
}

# The targets a `flaky: ` line names: every test of such a target is compared by
# its final status alone.
if ! awk '/^[[:space:]]*(#|$)/ { next }
	{ i = index($0, " "); rest = substr($0, i + 1); j = index(rest, "  ")
	  if (j > 0 && substr(rest, j + 2) ~ /^[[:space:]]*flaky: /) print substr($0, 1, i - 1) }' "$list" |
	LC_ALL=C sort -u >"$tmp/flaky-targets.txt"; then
	unknown "the flaky entries of $list could not be read, so which tests are compared by their final status is not known"
fi

for side in cold seeded; do
	f="$cold"
	[ "$side" = cold ] || f="$seeded"
	# A line is a target, a test name, a final status of the three the writer
	# gives, and a non-empty list of invocations; and no test is named twice.
	bad="$(awk -F'\t' 'NF != 4 || $1 == "" || $2 == "" || $4 == "" || ($3 != "ok" && $3 != "failed" && $3 != "ignored") { print FILENAME ":" FNR ": " $0 }' "$f")"
	[ -z "$bad" ] || unknown "$f has a line that is not <target> <test> <ok|failed|ignored> <per invocation>: $bad"
	n="$(lines "$f")"
	[ "$n" -gt 0 ] || unknown "$f holds no result"
	step "sorting the $side run's results" "$tmp/$side.tsv" "$n" env LC_ALL=C sort "$f"
	step "reading the $side run's test names" "$tmp/$side.names" "$n" cut -f1,2 "$tmp/$side.tsv"
	bad="$(LC_ALL=C uniq -d "$tmp/$side.names")"
	[ -z "$bad" ] || unknown "$f names a test twice, so which result is its own is not known: $(printf '%s' "$bad" | tr '\t\n' ': ')"
	# One key a line, for the join below: the target and the test name, which no
	# name of this repository holds a \x01 in.
	step "keying the $side run's results" "$tmp/$side.keyed" "$n" awk -F'\t' '{ print $1 "\x01" $2 "\t" $3 "\t" $4 }' "$tmp/$side.tsv"
	step "sorting the $side run's keys" "$tmp/$side.sorted" "$n" env LC_ALL=C sort "$tmp/$side.keyed"
done

n_cold="$(lines "$tmp/cold.names")"
n_seeded="$(lines "$tmp/seeded.names")"
only_cold="$(LC_ALL=C comm -23 "$tmp/cold.names" "$tmp/seeded.names")" ||
	unknown "the two runs' test names could not be compared (comm failed)"
only_seeded="$(LC_ALL=C comm -13 "$tmp/cold.names" "$tmp/seeded.names")" ||
	unknown "the two runs' test names could not be compared (comm failed)"
if [ -n "$only_cold" ]; then
	while IFS=$'\t' read -r target name; do
		finding "Rust test results" "$target $name ran in the cold run and in no invocation of the seeded run"
	done < <(printf '%s\n' "$only_cold")
	rc=1
fi
if [ -n "$only_seeded" ]; then
	while IFS=$'\t' read -r target name; do
		finding "Rust test results" "$target $name ran in the seeded run and in no invocation of the cold run"
	done < <(printf '%s\n' "$only_seeded")
	rc=1
fi

# The tests both sides ran: the final status always, the invocations' own
# statuses for a test of a target no `flaky: ` line names. A join that fails is
# a comparison of what it managed to write, which can be one line of thousands.
if ! LC_ALL=C join -t $'\t' -j 1 "$tmp/cold.sorted" "$tmp/seeded.sorted" >"$tmp/both.tsv"; then
	unknown "the two runs' results could not be read together (join failed), so what it compared is not known"
fi
# awk writes each difference to a file, which this shell reads: a finding
# recorded in a pipeline's subshell would be lost from the count.
awk -F'\t' -v flaky="$tmp/flaky-targets.txt" '
	BEGIN { while ((getline t < flaky) > 0) is_flaky[t] = 1 }
	{ split($1, k, "\x01"); target = k[1]; name = k[2]
	  if ($2 != $4) {
		printf "%s %s is %s in the cold run and %s in the seeded run\n", target, name, $2, $4
		bad = 1
		next
	  }
	  if (!(target in is_flaky) && $3 != $5) {
		printf "%s %s is %s in both runs, and ran [%s] cold and [%s] seeded: the invocations or attempts differ\n", target, name, $2, $3, $5
		bad = 1
	  }
	}
	END { exit bad ? 1 : 0 }' "$tmp/both.tsv" >"$tmp/differences.txt" || rc=1
while IFS= read -r said; do
	finding "Rust test results" "$said"
done <"$tmp/differences.txt"

both="$(awk 'END { print NR }' "$tmp/both.tsv")"
# A comparison of no test has not passed, and neither has one of some of them.
# The two files name the same tests by here (a name on one side only is an
# error above), so the join must hold every one of them: a join that wrote a
# part of its answer compared the rest with nothing.
if [ "$both" = 0 ]; then
	unknown "no test of the cold run is a test of the seeded run ($n_cold cold, $n_seeded seeded), so nothing was compared"
fi
if [ "$rc" = 0 ] && { [ "$both" != "$n_cold" ] || [ "$both" != "$n_seeded" ]; }; then
	unknown "the two files name the same tests ($n_cold cold, $n_seeded seeded) and only $both were read together, so the rest were compared with nothing"
fi
echo "Per-test results: $n_cold tests cold, $n_seeded seeded, $both in both; targets listed flaky: $(awk 'END { print NR }' "$tmp/flaky-targets.txt")"
if [ "$rc" = 0 ]; then
	echo "The seeded run's results are the cold run's, test by test."
else
	finding "Rust test results" "the seeded run and the cold run of this commit do not agree test by test (above): the seed changed what the gate reports"
fi
findings_end
exit "$rc"
