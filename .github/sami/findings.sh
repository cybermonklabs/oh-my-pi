# shellcheck shell=bash
# The findings of one run of a Rust gate script, for the cut checks'
# first-seen comparison: sami-checks.yml's summary reads the file
# (sc.py rust-findings) and compares each finding with the previous cut's,
# so that a finding new at a cut is named there even inside a row that
# already failed for other findings. Sourced by rust-test.sh,
# rust-test-parity.sh, rust-test-listings-drift.sh,
# rust-test-results-compare.sh and rust-test-macos-inventory.sh, and by the
# compare job's verdict step.
#
# SAMI_FINDINGS names the file. Unset or empty, the functions only print the
# annotation, as the scripts did before (the regression tests, a hand run).
# The file is tab-separated, one record a line, in the order the script
# found them:
#   finding <title> <message>  an error annotation the script printed
#   stop <title> <message>     the annotation the script printed as it
#                              stopped: it could not look on, so what it
#                              would have found after is not known
#   end <n>                    the script reached its end, having printed n
#                              findings
# A file with no end line was cut short (a timeout, a signal, or a command
# that failed under set -e), and the summary reads it UNKNOWN; so it does
# when a line could not be written: the end line is then left out. A tab or
# a line break in a title or a message is a space in the file; the
# annotation prints them as they are. Each function runs in the script's own
# shell, never in a pipeline's subshell, so that the count holds every
# finding.
findings_n=0
findings_lost=0

# finding <title> <message>: an error annotation, recorded.
finding() {
	echo "::error title=$1::$2"
	findings_n=$((findings_n + 1))
	findings_record finding "$1" "$2"
}

# finding_stop <title> <message>: an error annotation, recorded as where the
# script stopped; the caller exits.
finding_stop() {
	echo "::error title=$1::$2"
	findings_record stop "$1" "$2"
}

# findings_end: the last line, once the script has looked at everything.
findings_end() {
	[ -n "${SAMI_FINDINGS:-}" ] && [ "$findings_lost" = 0 ] || return 0
	printf 'end\t%s\n' "$findings_n" >>"$SAMI_FINDINGS" || findings_lost=1
	return 0
}

findings_record() {
	[ -n "${SAMI_FINDINGS:-}" ] || return 0
	local title="${2//[$'\t\r\n']/ }" message="${3//[$'\t\r\n']/ }"
	if ! printf '%s\t%s\t%s\n' "$1" "$title" "$message" >>"$SAMI_FINDINGS"; then
		[ "$findings_lost" = 1 ] || echo "::warning title=Findings::$SAMI_FINDINGS could not be written, so the summary reads this script's findings UNKNOWN"
		findings_lost=1
	fi
	return 0
}
