//! A `bad substitution` names what bash was expanding when the bad part
//! failed (bash's `expand_word_internal` string): the word as written, the
//! inside of `"…"`, an operator's word, the text of a here-document or of
//! arithmetic, a keyed array element whole. A `${x@…}` with no valid
//! operator is bash's `parameter_brace_transform`: nothing for an unset
//! value, a fatal error for a set one.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job (bash 5.2.21 agrees but
//! for `export v=…`, where it names `environment`). Each row runs as `-c`
//! and as a script file, in a directory of its own: in the expected stderr
//! `PFX` is the messages' prefix (the shell's name under `-c`, `D/s.sh`
//! from the script); a row gives its status under `-c` and from a script.
#![cfg(unix)]

mod obash_support;

use std::fs;

use crate::obash_support::{obash, output};

/// A row: the script, its stdout, its stderr (`PFX` as above), its status
/// under `-c` and from a script.
type Row = (&'static str, &'static str, &'static str, i32, i32);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = env!("CARGO_BIN_EXE_obash");
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
	]);
}

/// A here-document body, arithmetic text, a substring offset: the whole
/// text, as bash parses it when it runs.
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
	]);
}

/// A keyed array element: bash names `[key]=value` with the brackets
/// quoted.
#[test]
fn names_a_keyed_element_whole() {
	check(&[(
		r#"a=([0]=a${x!}b); echo "after $?""#,
		"",
		"PFX: line 1: \\[0\\]=a${x!}b: bad substitution\n",
		1,
		1,
	)]);
}

/// `${u@…}` with no valid operator and `u` unset: nothing, status 0
/// (`set -u`: unbound).
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
