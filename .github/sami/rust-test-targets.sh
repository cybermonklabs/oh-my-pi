# shellcheck shell=bash
# The one reader of the Rust suite's test targets and of a test binary's
# listing, sourced by rust-test-parity.sh, rust-test-early-listings.sh,
# rust-test.sh and rust-test-macos-inventory.sh, so the parity check, the
# early listings and the Bazel jobs map a target and read a listing the same
# way.
#
# suite_excludes: the packages `bun run test:rs` leaves out, one a line: the
# strings of scripts/run-rs-task.ts's VENDORED_FORK_EXCLUDES array other than
# "--exclude". Run from the repository root. Returns 1, printing nothing,
# when the file or the array is missing.
suite_excludes() {
	[ -f scripts/run-rs-task.ts ] || return 1
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
		END { exit !found }
	' scripts/run-rs-task.ts
}

# bazel_test_query: the bazel query expression whose streamed_jsonproto
# output bazel_test_roots reads: every rust_test, rust_doc_test and
# native_test under //crates not tagged manual (`bazel test //crates/...`
# skips those), and each crate they name.
# `$t` is a Bazel query variable (`let t = ... in`), not a shell one.
# The scripts that source this file read it.
# shellcheck disable=SC2016,SC2034
bazel_test_query='let t = kind("^(rust_(doc_)?test|native_test) rule$", //crates/...) - attr(tags, "manual", //crates/...) in $t + labels(crate, $t)'

# bazel_test_roots <rules.json>: one line per rust_test and rust_doc_test of
# a bazel_test_query result, `<kind>\t<label>\t<root>`: kind test or doctest;
# root, the repository path of its crate root. That is the test's own
# crate_root, or, for a test that names a `crate`, that crate's root; where no
# crate_root is set, the root is the one rules_rust picks (crate_root_src in
# rust/private/utils.bzl: the only src, else the shortest src named lib.rs,
# main.rs for a binary, then <name>.rs or <crate_name>.rs). A root that cannot
# be found reads `NO ROOT FOR <label>`, `NO RULE FOR <crate>` or `NO CRATE FOR
# <label>`.
bazel_test_roots() {
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
		| [(if .ruleClass == "rust_test" then "test" else "doctest" end), .name, $root]
		| @tsv' "$1"
}

# listing_names <raw listing>: the test names in a test binary's `--list`
# output, sorted, one a line (libtest's `<name>: test` and `<name>: benchmark`
# lines; the summary line and anything else is not a name).
listing_names() {
	sed -n -e 's/: test$//p' -e 's/: benchmark$//p' "$1" | LC_ALL=C sort -u
}
