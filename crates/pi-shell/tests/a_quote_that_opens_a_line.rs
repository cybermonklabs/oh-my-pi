//! A quote (`'`, `"` or a backquote) that the input ends inside is reported
//! on the line it opened on: bash's `parse_matched_pair` takes
//! `line_number` once it has read the quote, and reading a quote that opens
//! a line reads that line. A quote at a line's start was reported on the
//! line before.
//!
//! Each row runs twice, as `-c` text and from a script file, and was
//! measured against bash 5.3.20 and 5.2.21 both ways (they agree). The rows
//! print the shell's name as `SH`.

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Runs `script` with stderr on stdout in a private directory; each line
/// that starts with the shell's name (`$0` under `-c`: the path obash was
/// started by, [`obash_support::obash_path`]; `s.sh` for the script) starts
/// with `SH` instead. Returns the output and the exit status.
fn run(script: &str, mode: Mode) -> (String, Option<i32>) {
	let dir = tempfile::tempdir().expect("a row directory");
	let script = format!("exec 2>&1; {script}");
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path());
	let name = match mode {
		Mode::C => {
			cmd.args(["-c", &script]);
			obash_support::obash_path()
		},
		Mode::Script => {
			std::fs::write(dir.path().join("s.sh"), format!("{script}\n")).expect("the script file");
			cmd.arg("s.sh");
			"s.sh"
		},
	};
	let out = obash_support::output(&mut cmd);
	let prefix = format!("{name}: ");
	let text = String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| match l.strip_prefix(&prefix) {
			Some(rest) => format!("SH: {rest}\n"),
			None => format!("{l}\n"),
		})
		.collect();
	(text, out.status.code())
}

/// Each `(name, script, closing quote)` row ends inside a quote opened on
/// line 2: bash prints `l1`, then the error on line 2 (`-c: ` before the
/// line under `-c`), and exits with status 2. Every row whose output or
/// status differs, in either mode, is listed.
fn assert_line_2(rows: &[(&str, &str, &str)]) {
	let mut mismatches = Vec::new();
	for (name, script, quote) in rows {
		for (mode, c) in [(Mode::C, "-c: "), (Mode::Script, "")] {
			let want =
				format!("l1\nSH: {c}line 2: unexpected EOF while looking for matching `{quote}'\n");
			let got = run(script, mode);
			if got != (want.clone(), Some(2)) {
				mismatches.push(format!("{name} ({mode:?}): {got:?}, want ({want:?}, 2)"));
			}
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A quote that opens line 2.
#[test]
fn a_quote_that_opens_a_line_is_reported_on_it() {
	assert_line_2(&[
		("a double quote", "echo l1\n\"abc", "\""),
		("a single quote", "echo l1\n'abc", "'"),
		("a backquote", "echo l1\n`abc", "`"),
	]);
}

/// The control: a quote inside line 2 was reported on it already.
#[test]
fn a_quote_inside_a_line_is_reported_on_it() {
	assert_line_2(&[
		("after a word", "echo l1\necho \"abc", "\""),
		("in a subshell", "echo l1\n( \"abc )", "\""),
	]);
}
