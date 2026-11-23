# shellcheck shell=bash
# The one reader of the rust_test jobs' lists (.github/sami/rust-test-*.txt),
# sourced by rust-test.sh, rust-test-parity.sh and
# rust-test-macos-inventory.sh, so each script reads a line the same way, and
# a malformed line fails each of them with the same message.
#
# list_entries <list file> <fields>: each entry of a list, as tab-separated
# fields. An entry line is `<first> <second>  <why>` (fields 2) or
# `<first>  <why>` (fields 1): the first field is the first word; the second
# is everything after it up to the first two spaces, so a second field with
# single spaces in it, such as a doctest's `src/lib.rs - f (line 3)`, is read
# whole; two spaces come before the why. Lines that are blank or start with
# `#` are comments. A line without its fields, or without two spaces before a
# why, is named on stderr (`<file>:<line>: <what is wrong>: <line>`), and the
# function then returns 1.
list_entries() {
	awk -v fields="$2" '
		function malformed(what) {
			printf "%s:%d: %s: %s\n", FILENAME, FNR, what, $0 > "/dev/stderr"
			bad = 1
		}
		/^[[:space:]]*(#|$)/ { next }
		{
			line = $0
			sub(/[[:space:]]+$/, "", line)
			i = index(line, " ")
			first = (i ? substr(line, 1, i - 1) : line)
			rest = (i ? substr(line, i + 1) : "")
			if (first == "") { malformed("no first field"); next }
			if (fields == 1) {
				if (substr(rest, 1, 1) != " " || rest ~ /^ *$/) { malformed("no two spaces before its why"); next }
				print first
				next
			}
			j = index(rest, "  ")
			second = (j ? substr(rest, 1, j - 1) : rest)
			if (second == "" || second ~ /^ /) { malformed("no second field"); next }
			if (!j || substr(rest, j) ~ /^ *$/) { malformed("no two spaces before its why"); next }
			print first "\t" second
		}
		END { exit bad }' "$1"
}
