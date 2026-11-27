//! A `bad substitution` names what bash was expanding when the bad part
//! failed (bash's `expand_word_internal` string): the word as written, the
//! inside of `"…"` (in arithmetic too), an operator's word, the text of a
//! here-document or of arithmetic, a keyed array element whole (of an
//! associative array, its value). A `${x@…}` with no valid operator is
//! bash's `parameter_brace_transform`: nothing for a null value (unless
//! the operator starts with `a` or `A`), a fatal error for a set one.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job (bash 5.2.21 agrees but
//! for `export v=…`, where it names `environment`). Each row runs as `-c`
//! and as a script file, in a directory of its own: in the expected stderr
//! `PFX` is the messages' prefix (the shell's name under `-c`, which is the
//! path obash was started by, `D/s.sh` from the script); a row gives its
//! status under `-c` and from a script.
#![cfg(unix)]

mod obash_support;

use std::fs;

use crate::obash_support::{obash, obash_path, output};

/// A row: the script, its stdout, its stderr (`PFX` as above), its status
/// under `-c` and from a script.
type Row = (&'static str, &'static str, &'static str, i32, i32);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = obash_path();
	let mut out = Vec::new();
	for &(code, want_out, want_err, status_c, status_script) in rows {
		for script in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let dir = fs::canonicalize(tmp.path()).unwrap();
			let d = dir.to_str().unwrap().to_owned();
			let mut cmd = obash();
			cmd.current_dir(&dir)
				.env("PATH", "/usr/bin:/bin")
				.env("LC_ALL", "C");
			let (prefix, status) = if script {
				let file = dir.join("s.sh");
				fs::write(&file, code).unwrap();
				cmd.arg(&file);
				("D/s.sh", status_script)
			} else {
				cmd.args(["-c", code]);
				("SH", status_c)
			};
			let o = output(&mut cmd);
			let norm = |b: &[u8]| {
				String::from_utf8_lossy(b)
					.replace(sh, "SH")
					.replace(&d, "D")
			};
			let got = (norm(&o.stdout), norm(&o.stderr), o.status.code());
			let want = (want_out.to_owned(), want_err.replace("PFX", prefix), Some(status));
			if got != want {
				let how = if script { "script" } else { "-c" };
				out.push(format!("{code:?} ({how}): got {got:?}, want {want:?}"));
			}
		}
	}
	out
}

fn check(rows: &[Row]) {
	let wrong = mismatches(rows);
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The word as bash stores it: a command's word, a redirection's, an
/// assignment's value, a declaration's whole argument, an array element, a
/// brace-expanded word's alternative.
#[test]
fn names_the_word() {
	check(&[
		(
			r#"echo /dev/null${x!}; echo "after $?""#,
			"",
			"PFX: line 1: /dev/null${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#": > /dev/null${x!}; echo "after $?""#,
			"",
			"PFX: line 1: /dev/null${x!}: bad substitution\n",
			1,
			1,
		),
		(r#"y=a${x!}b; echo "after $?""#, "", "PFX: line 1: a${x!}b: bad substitution\n", 1, 1),
		(r#"a=(p q${x!}r s); echo "after $?""#, "", "PFX: line 1: q${x!}r: bad substitution\n", 1, 1),
		(
			r#"declare v=a${x!}b; echo "after $?""#,
			"",
			"PFX: line 1: v=a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"echo ~/a\ b${x!}; echo "after $?""#,
			"",
			"PFX: line 1: ~/a\\ b${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"echo a${x!}b${y!}; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}b${y!}: bad substitution\n",
			1,
			1,
		),
		(r#"echo q${a b}r; echo "after $?""#, "", "PFX: line 1: q${a b}r: bad substitution\n", 1, 1),
		(r#"echo {a,b}${x!}; echo "after $?""#, "", "PFX: line 1: a${x!}: bad substitution\n", 1, 1),
		(
			r#"printf '%s\n' a${x!}b c; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}b: bad substitution\n",
			1,
			1,
		),
		(r#"v=~/${x!}; echo "after $?""#, "", "PFX: line 1: ~/${x!}: bad substitution\n", 1, 1),
		(r#"echo \$a${x!}; echo "after $?""#, "", "PFX: line 1: \\$a${x!}: bad substitution\n", 1, 1),
		(r#"echo $'a'${x!}; echo "after $?""#, "", "PFX: line 1: 'a'${x!}: bad substitution\n", 1, 1),
		(
			r#"echo x{a,b}y${x!}; echo "after $?""#,
			"",
			"PFX: line 1: xay${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"export v=a${x!}b; echo "after $?""#,
			"",
			"PFX: line 1: v=a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"v=a${x!}b /bin/true; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"f() { local v=a${x!}b; echo "in $?"; }; f; echo "after $?""#,
			"",
			"PFX: line 1: v=a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"[[ a${x!} == b ]]; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"case a${x!} in *) echo in;; esac; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"for i in a b${x!}; do echo $i; done; echo "after $?""#,
			"",
			"PFX: line 1: b${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"case x in a${x!}) ;; esac; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"echo "$(echo a${x!}b)"; echo "after $?""#,
			"\nafter 0\n",
			"PFX: line 1: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			r#"eval "echo q\${x!}"; echo "after $?""#,
			"after 1\n",
			"PFX: line 1: q${x!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// Inside `"…"`, the quoted text: bash expands it as a string of its own.
#[test]
fn names_the_quoted_text() {
	check(&[
		(r#"echo "a${x!}b"; echo "after $?""#, "", "PFX: line 1: a${x!}b: bad substitution\n", 1, 1),
		(
			r#"echo pre"a${x!}b"post'q'; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"echo ${x:-"a${y!}b"}; echo "after $?""#,
			"",
			"PFX: line 1: a${y!}b: bad substitution\n",
			1,
			1,
		),
		(r#"echo 'a'"b${x!}"; echo "after $?""#, "", "PFX: line 1: b${x!}: bad substitution\n", 1, 1),
		(r#"echo "${x!}"; echo "after $?""#, "", "PFX: line 1: ${x!}: bad substitution\n", 1, 1),
		(
			r#"echo "$(echo "q${x!}")"; echo "after $?""#,
			"\nafter 0\n",
			"PFX: line 1: q${x!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// In an operator's word (`${y:-…}`, a pattern), that word.
#[test]
fn names_the_operator_word() {
	check(&[
		(
			r#"echo ${y:-a${x!}b}c; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			r#"x=abc; echo ${x#a${y!}}; echo "after $?""#,
			"",
			"PFX: line 1: a${y!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"echo ${u:?a${x!}}; echo "after $?""#,
			"",
			"PFX: line 1: a${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"x=abc; echo ${x/a${y!}/z}; echo "after $?""#,
			"",
			"PFX: line 1: a${y!}: bad substitution\n",
			1,
			1,
		),
		// An escaped `"` in the quotes loses its backslash, and the quote
		// stays (bash's `string_extract_double_quoted`; Rev273r2's row).
		(
			"echo ${y:-\"\\\"${x!}\"}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		// The `-`, `=` or `+` word of a `${…}` that is itself inside `"…"`
		// keeps the backslash (row e12).
		(
			"echo \"${y:-\"\\\"${x!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// A here-document body, arithmetic text, a substring offset: the whole
/// text, as bash parses it when it runs. In arithmetic, the inside of a
/// pair of double quotes: bash expands it as a string of its own.
#[test]
fn names_the_text_parsed_when_it_runs() {
	check(&[
		(
			r#"cat <<E
line1
pre ${x!} post
E
echo "after $?""#,
			"after 1\n",
			"PFX: line 1: line1\npre ${x!} post\n: bad substitution\n",
			0,
			0,
		),
		(
			r#"echo $(( ${x!} + 1 )); echo "after $?""#,
			"",
			"PFX: line 1:  ${x!} + 1 : bad substitution\n",
			1,
			1,
		),
		(
			r#"cat <<E
"q${x!}"
E
echo "after $?""#,
			"after 1\n",
			"PFX: line 1: \"q${x!}\"\n: bad substitution\n",
			0,
			0,
		),
		(
			r#"echo a$((1+${x!}))b; echo "after $?""#,
			"",
			"PFX: line 1: 1+${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"cat <<-E
	z${x!}
	E
echo "after $?""#,
			"after 1\n",
			"PFX: line 1: z${x!}\n: bad substitution\n",
			0,
			0,
		),
		(
			r#"echo $(( 1 + $(( ${x!} )) )); echo "after $?""#,
			"",
			"PFX: line 1:  ${x!} : bad substitution\n",
			1,
			1,
		),
		(
			r#"for ((i=${x!}; i<1; i++)); do :; done; echo "after $?""#,
			"",
			"PFX: line 1: i=${x!}: bad substitution\n",
			1,
			1,
		),
		(
			r#"cat <<E
${x!}
second
E
echo "after $?""#,
			"after 1\n",
			"PFX: line 1: ${x!}\nsecond\n: bad substitution\n",
			0,
			0,
		),
		(
			r#"read l <<E
pre${x!}
E
echo "after $?""#,
			"after 1\n",
			"PFX: line 1: pre${x!}\n: bad substitution\n",
			0,
			0,
		),
		(
			r#"x=abc; echo ${x:${y!}}; echo "after $?""#,
			"",
			"PFX: line 1: ${y!}: bad substitution\n",
			1,
			1,
		),
		(
			"echo $(( \"${x!}\" + 1 ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( 1 + \"a${x!}b\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"(( \"${x!}\" + 1 ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"for (( i=\"${x!}\"; i<1; i++ )); do :; done\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc; echo ${x:\"${y!}\"}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${y!}: bad substitution\n",
			0,
			0,
		),
		// Each pair of quotes on its own; outside them, the whole text.
		(
			"echo $(( \"1\" + \"b${x!}\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: b${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( \"1\" + ${x!} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1:  \"1\" + ${x!} : bad substitution\n",
			0,
			0,
		),
		(
			"x=1; echo $(( \"${x@Z}\" ))\necho \"after $?\"",
			"",
			"PFX: line 1: ${x@Z}: bad substitution\n",
			127,
			1,
		),
		// An escaped `"` in the quotes: bash drops its backslash, and in
		// arithmetic the quote it leaves opens a string of its own, which
		// is what a part failing after it names (Rev273r2's rows; q10).
		(
			"echo $(( \"\\\"${x!}\" + 1 ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( \"a\\\"b${x!}\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: b${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=1\necho $(( \"\\\"${x@Z}\" ))\necho \"after $?\"",
			"",
			"PFX: line 2: ${x@Z}: bad substitution\n",
			127,
			1,
		),
		// A part failing outside such a quote names the whole string, the
		// quotes kept and their backslashes gone (row e8).
		(
			"echo $(( \"\\\"a\\\"${x!}\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"a\"${x!}: bad substitution\n",
			0,
			0,
		),
		// The string such a quote opens ends at the next one (row e13); a
		// part failing before any names the whole string (row e6).
		(
			"echo $(( \"\\\"${x!}\\\"\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( \"${x!}\\\"\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}\": bad substitution\n",
			0,
			0,
		),
	]);
}

/// The `-`, `=` and `+` words of a `${…}` that bash expands as if
/// double-quoted: inside `"…"`, in a here-document body, in arithmetic
/// text, in a prompt, and in such a word itself. bash expands such a word
/// as one double-quoted string (`parameter_brace_expand_rhs`), so a `\"` in
/// its quotes keeps its backslash.
#[test]
fn keeps_the_backslash_where_bash_expands_as_if_double_quoted() {
	check(&[
		// A here-document body, a nested `${…}`, arithmetic text.
		(
			"cat <<E\n${y:-\"\\\"${x!}\"}\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo \"${y:-${z:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( \"${y:-\"\\\"${x!}\"}\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( ${y:-\"\\\"${x!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		// Arithmetic in a here-document has the here-document's
		// double-quoted context.
		(
			"cat <<E\n$(( ${y:-\"\\\"${x!}\"} ))\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"a=(1 2)\ncat <<E\n$(( a[${y:-\"\\\"${x!}\"}] ))\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\ncat <<E\n$(( ${x/a/\"\\\"${y!}\"} ))\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"y=1\ncat <<E\n${y:+\"\\\"${x!}\"}\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<-E\n\t${y:-\"\\\"${x!}\"}\n\tE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"(( ${y:-\"\\\"${x!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"for (( i = ${y:-\"\\\"${x!}\"}; i < 1; i++ )); do :; done\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		// A substring offset and an indexed subscript are arithmetic text.
		(
			"z=abc\necho ${z:${y:-\"\\\"${x!}\"}}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"a=(1 2)\necho ${a[${y:-\"\\\"${x!}\"}]}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"a=(1 2)\necho \"${a[${y:-\"\\\"${x!}\"}]}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"z=abc\necho \"${z:${y:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		// A prompt (`@P`).
		(
			"p='${y:-\"\\\"${x!}\"}'\necho \"${p@P}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		// `=` and `+` words, and a here-document's nested `${…}`.
		(
			"echo \"${y:=${z:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"y=1\necho \"${y:+${z:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<E\n${y:-${z:-\"\\\"${x!}\"}}\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		// The context comes back after a `${…}` in the word, and after an
		// array subscript in arithmetic text; a here-document has none.
		(
			"echo \"${y:-${z}${w:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<E\n${y:-${z}${w:-\"\\\"${x!}\"}}\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( b[1] + ${y:-\"\\\"${x!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( a[b[1]] + ${y:-\"\\\"${x!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<E\na[${y:-\"\\\"${x!}\"}]\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \\\"${x!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// bash expands a `${…}`'s other words unquoted, inside `"…"`, a
/// here-document or arithmetic too: a pattern (`getpattern`), a
/// replacement, a `?` word, an associative subscript, an array subscript in
/// arithmetic text, and a command substitution's body. A `\"` in their
/// quotes loses its backslash.
#[test]
fn drops_the_backslash_where_bash_expands_unquoted() {
	check(&[
		// Patterns and a replacement.
		(
			"x=abc\necho \"${x#\"\\\"${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x/\"\\\"${y!}\"/z}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x%\"\\\"${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x/a/\"\\\"${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x^\"\\\"${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x,,\"\\\"${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x#${z:-\"\\\"${y!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x/a/${z:-\"\\\"${y!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x#\"\\\"${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		// A `?` word.
		(
			"echo \"${u?\"\\\"${x!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo \"${u?${z:-\"\\\"${x!}\"}}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		// An associative subscript.
		(
			"declare -A h=([k]=v)\necho \"${h[\"\\\"${x!}\"]}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h=([k]=v)\necho ${h[${y:-\"\\\"${x!}\"}]}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h=([k]=v)\necho \"${h[${y:-\"\\\"${x!}\"}]}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		// An array subscript in arithmetic text (`expand_array_subscript`).
		(
			"echo $(( a[${y:-\"\\\"${x!}\"}] ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( a[ ${y:-\"\\\"${x!}\"} ] ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"(( a[${y:-\"\\\"${x!}\"}] ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"z=abc\necho ${z:a[${y:-\"\\\"${x!}\"}]}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"a=(1 2)\necho $(( a[${y:-\"\\\"${x!}\"}] ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( \"a[${y:-\"\\\"${x!}\"}]\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		// In a here-document and in arithmetic too.
		(
			"cat <<E\n${u?\"\\\"${x!}\"}\nE\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x%\"\\\"${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( ${u?\"\\\"${x!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x/\"\\\"${y!}\"/z} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		// An associative subscript of a `${…}` with a `-` word.
		(
			"declare -A h=([k]=v)\necho \"${h[\"\\\"${x!}\"]:-d}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${x!}: bad substitution\n",
			0,
			0,
		),
		// A command substitution's body.
		(
			"echo \"${y:-$(echo \"\\\"${x!}\")}\"\necho \"after $?\"",
			"\nafter 0\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo \"${y:-$(echo ${z:-\"\\\"${x!}\"})}\"\necho \"after $?\"",
			"\nafter 0\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<E\n${y:-$(echo \"\\\"${x!}\")}\nE\necho \"after $?\"",
			"\nafter 0\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"cat <<E\n$(echo ${y:-\"\\\"${x!}\"})\nE\necho \"after $?\"",
			"\nafter 0\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"echo $(( $(echo ${y:-\"\\\"${x!}\"}) ))\necho \"after $?\"",
			"0\nafter 0\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// A `/` replacement word keeps `Q_ARITH` (bash takes away only the
/// double-quoted context), and so does a `[[ ]]` arithmetic operand: in
/// arithmetic text, the quote a `\"` leaves in their quotes opens a string
/// of its own, which is what a part failing after it names.
#[test]
fn names_a_replacement_in_arithmetic_as_arithmetic() {
	check(&[
		(
			"x=abc\necho $(( ${x/a/\"\\\"${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x/a/\"a\\\"b${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: b${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x/a/${z:-\"\\\"${y!}\"}} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( \"${x/a/\"\\\"${y!}\"}\" ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\nz=abc\necho ${z:${x/a/\"\\\"${y!}\"}}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 3: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\n(( ${x/a/\"\\\"${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${q:-${x/a/\"\\\"${y!}\"}} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( ${x//a/\"\\\"${y!}\"} ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		// A `[[ ]]` arithmetic operand and `-v`'s (`cond_expand_word`'s
		// `Q_ARITH`); `==`'s operand is no arithmetic.
		(
			"[[ \"\\\"${x!}\" -eq 1 ]]\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: ${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\n[[ -v ${x/a/\"\\\"${y!}\"} ]]\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"[[ \"\\\"${x!}\" == 1 ]]\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: \"${x!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\n[[ ${x/a/\"\\\"${y!}\"} -eq 1 ]]\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: ${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\n[[ ${x/a/\"a\\\"b${y!}\"} -ne 1 ]]\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: b${y!}: bad substitution\n",
			0,
			0,
		),
		// Outside arithmetic, and in an array subscript (which takes
		// `Q_ARITH` away), the quote stays.
		(
			"x=abc\necho ${x/a/\"\\\"${y!}\"}\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho \"${x/a/\"a\\\"b${y!}\"}\"\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: a\"b${y!}: bad substitution\n",
			0,
			0,
		),
		(
			"x=abc\necho $(( a[${x/a/\"\\\"${y!}\"}] ))\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \"${y!}: bad substitution\n",
			0,
			0,
		),
	]);
}

/// A keyed array element: bash names `[key]=value` with the brackets
/// quoted. An associative array's element names only the value, which bash
/// expands as a string of its own; whether the array is associative is
/// known when the element expands (`declare -A h` before `h=(…)`).
#[test]
fn names_a_keyed_element_whole() {
	check(&[
		(
			r#"a=([0]=a${x!}b); echo "after $?""#,
			"",
			"PFX: line 1: \\[0\\]=a${x!}b: bad substitution\n",
			1,
			1,
		),
		(
			"declare -A h=([k]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h\nh=([k]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h\nh+=([k]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h=([k]+=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h\ndeclare -n r=h\nr=([k]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 3: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -A h='([k]=a${x!}b)'\necho \"after $?\"",
			"after 1\n",
			"PFX: line 1: a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"x=1; declare -A h=([k]=a${x@Z}b)\necho \"after $?\"",
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		// `declare` without `-A` expands the list as indexed first.
		(
			"declare -A h\ndeclare h=([k]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\[k\\]=a${x!}b: bad substitution\n",
			0,
			0,
		),
		(
			"declare -a a\na=([1]=a${x!}b)\necho \"after $?\"",
			"after 1\n",
			"PFX: line 2: \\[1\\]=a${x!}b: bad substitution\n",
			0,
			0,
		),
	]);
}

/// `${u@…}` with no valid operator and a null value (`u` unset, or an
/// empty `$@`, `$*` or `${a[@]}`): nothing, status 0. `set -u` comes first
/// for an unset `u` (`$@`, `$*` and `${a[@]}` are exempt).
#[test]
fn an_invalid_transform_of_an_unset_value_is_nothing() {
	check(&[
		(r#"echo a${u@Z}b; echo "after $?""#, "ab\nafter 0\n", "", 0, 0),
		(r#"echo a${u@}b; echo "after $?""#, "ab\nafter 0\n", "", 0, 0),
		(
			r#"set -u; echo a${u@Z}b; echo "after $?""#,
			"",
			"PFX: line 1: u: unbound variable\n",
			127,
			1,
		),
		("set --\necho x${@@Z}y\necho \"after $?\"", "xy\nafter 0\n", "", 0, 0),
		("set --\necho x${*@Z}y\necho \"after $?\"", "xy\nafter 0\n", "", 0, 0),
		("set --\necho \"q${@@Z}r\"\necho \"after $?\"", "qr\nafter 0\n", "", 0, 0),
		("a=()\necho x${a[@]@Z}y\necho \"after $?\"", "xy\nafter 0\n", "", 0, 0),
		("declare -A h=()\necho x${h[@]@Z}y\necho \"after $?\"", "xy\nafter 0\n", "", 0, 0),
		("set -u\na=()\necho q${a[@]@Z}r\necho \"after $?\"", "qr\nafter 0\n", "", 0, 0),
		("set -u\nset --\necho q${@@Z}r\necho \"after $?\"", "qr\nafter 0\n", "", 0, 0),
	]);
}

/// An operator that starts with `a` or `A` reads the attributes of an
/// unset or null value too: a fatal `bad substitution`, after `set -u`'s
/// check.
#[test]
fn an_invalid_attribute_transform_of_an_unset_value_is_fatal() {
	check(&[
		(
			"echo a${u@aZ}b\necho \"after $?\"",
			"",
			"PFX: line 1: a${u@aZ}b: bad substitution\n",
			127,
			1,
		),
		(
			"set --\necho x${@@aZ}y\necho \"after $?\"",
			"",
			"PFX: line 2: x${@@aZ}y: bad substitution\n",
			127,
			1,
		),
		(
			"set -u\necho a${u@aZ}b\necho \"after $?\"",
			"",
			"PFX: line 2: u: unbound variable\n",
			127,
			1,
		),
		(
			"set -u\necho a${u@AZ}b\necho \"after $?\"",
			"",
			"PFX: line 2: u: unbound variable\n",
			127,
			1,
		),
		(
			"set -u\ndeclare -a a=([1]=x)\necho ${a@aZ}\necho \"after $?\"",
			"",
			"PFX: line 3: a: unbound variable\n",
			127,
			1,
		),
	]);
}

/// `${x@…}` with no valid operator and `x` set (also empty): a fatal
/// `bad substitution`; a subshell ends, the shell goes on.
#[test]
fn an_invalid_transform_of_a_set_value_is_fatal() {
	check(&[
		(
			r#"x=1; echo a${x@Z}b; echo "after $?""#,
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"u=1; echo a${u@}b; echo "after $?""#,
			"",
			"PFX: line 1: a${u@}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; echo a${x@}b; echo "after $?""#,
			"",
			"PFX: line 1: a${x@}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; echo a${x@QQ}b; echo "after $?""#,
			"",
			"PFX: line 1: a${x@QQ}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; f() { echo a${x@Z}b; }; f; echo "after $?""#,
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; (echo a${x@Z}b); echo "after $?""#,
			"after 1\n",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			0,
			0,
		),
		(
			r#"a=(1 2); echo ${a[@]@Z}; echo "after $?""#,
			"",
			"PFX: line 1: ${a[@]@Z}: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; echo "a${x@Z}b"; echo "after $?""#,
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; : ${y:-a${x@Z}b}; echo "after $?""#,
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; eval 'echo ${x@Z}'; echo "after $?""#,
			"",
			"PFX: line 1: ${x@Z}: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=; echo a${x@Z}b; echo "after $?""#,
			"",
			"PFX: line 1: a${x@Z}b: bad substitution\n",
			127,
			1,
		),
		(
			r#"x=1; read l <<E
${x@Z}
E
echo "after $?""#,
			"",
			"PFX: line 1: ${x@Z}\n: bad substitution\n",
			127,
			1,
		),
		// A list of one empty word is set.
		(
			"set -- \"\"\necho x${@@Z}y\necho \"after $?\"",
			"",
			"PFX: line 2: x${@@Z}y: bad substitution\n",
			127,
			1,
		),
		(
			"a=(\"\")\necho x${a[@]@Z}y\necho \"after $?\"",
			"",
			"PFX: line 2: x${a[@]@Z}y: bad substitution\n",
			127,
			1,
		),
	]);
}

/// Posix mode: any expansion error ends a non-interactive shell.
#[test]
fn posix_mode_exits() {
	check(&[(
		r#"set -o posix; echo a${x!}b; echo "after $?""#,
		"",
		"PFX: line 1: a${x!}b: bad substitution\n",
		127,
		1,
	)]);
}
