//! A declaration builtin given a compound array value as a string
//! (`declare -a a='(1 "2)'`) parses the string as words (bash's
//! `parse_string_to_word_list`, whose input is named `array assign`). When
//! the parser refuses it, bash reports the error as `NAME: array assign:
//! line N: …` and then (parse.y:7086) drops the command by a plain
//! `DISCARD`: `top_level_cleanup` only at a script's own level, the
//! innermost `eval` or `.` goes on with its next command, a function's,
//! script's or `-c` string's line is dropped, a subshell exits 1. A
//! non-interactive posix shell exits instead (`FORCE_EOF`: 127 from a `-c`
//! string, else 1). Under `set -e`, `parser_error` exits with status 2 after
//! its first line. An end-of-input error names the string's own line; a
//! token error the command's line plus the string's, less one, and the
//! string's line that holds the token follows.
//!
//! Each row runs twice, as `-c` text and from a script file. Every row was
//! measured against bash 5.3.20 and 5.2.21 both ways; the test follows
//! 5.3.20. bash 5.2.21 names the error of a function in a `-c` string
//! `environment: array assign:`, and in a script it keeps the function a
//! discarded command leaves for a subshell's EXIT trap (`T f main l=1`) and
//! reports a `time` the discard leaves into the timed command's
//! redirection. The rows print the shell's name as `SH`.

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Runs `script` with stderr on stdout in a private directory (a row may
/// write files there); each line that starts with the shell's name (`$0`
/// under `-c`: the path obash was started by,
/// [`obash_support::obash_path`]; `s.sh` for the script) starts with `SH`
/// instead. Returns the output and the exit status.
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

/// A row: its name, its script, and the output and status bash gives under
/// `-c`, then from the script file.
type Row = (String, String, (String, i32), (String, i32));

/// Every row whose output or status differs, in either mode, is listed.
fn assert_rows(rows: &[Row]) {
	let mut mismatches = Vec::new();
	for (name, script, c, s) in rows {
		for (mode, (want, status)) in [(Mode::C, c), (Mode::Script, s)] {
			let got = run(script, mode);
			if got != (want.clone(), Some(*status)) {
				mismatches.push(format!("{name} ({mode:?}): {got:?}, want ({want:?}, {status})"));
			}
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// A row whose script prints the same and exits with `status` in both
/// modes.
fn both(name: &str, script: &str, out: &str, status: i32) -> Row {
	(name.into(), script.into(), (out.into(), status), (out.into(), status))
}

/// A row whose script prints and exits differently under `-c` and from the
/// script file.
fn by_mode(name: &str, script: &str, c: (&str, i32), s: (&str, i32)) -> Row {
	(name.into(), script.into(), (c.0.into(), c.1), (s.0.into(), s.1))
}

/// The end-of-input error of `'(1 "2)'`, on the string's line 1.
const EOF: &str = "SH: array assign: line 1: unexpected EOF while looking for matching `\"'\n";

/// The two lines of a token error: `token` on line `line`, and the string's
/// line `text` that holds it.
fn token(line: u32, token: &str, text: &str) -> String {
	format!(
		"SH: array assign: line {line}: syntax error near unexpected token `{token}'\nSH: array \
		 assign: line {line}: `{text}'\n"
	)
}

/// The command is dropped wherever it runs: the rest of its line at the
/// top level and in a function, the rest of an `eval` string or of a `.`
/// file's line, a command substitution (status 1); the next line sees 1.
/// The builtin's own redirection hides the message, and the arguments
/// before the string are assigned. Every declaration builtin does it.
#[test]
fn a_string_that_does_not_parse_drops_the_command() {
	let next = format!("{EOF}next s=1\n");
	let rows = [
		both("the line", "declare -a a='(1 \"2)'; echo after; echo s=$?", EOF, 1),
		both(
			"the next line",
			"declare -a a='(1 \"2)'; echo after; echo s=$?\necho next s=$?",
			&next,
			0,
		),
		both(
			"eval",
			"s='(1 \"2)'; eval 'declare -a a=$s; echo in'; echo after s=$?",
			&format!("{EOF}after s=1\n"),
			0,
		),
		both(
			"a function",
			"s='(1 \"2)'; f() { local l=1; declare -a a=$s; echo in; }; f; echo after s=$?\necho \
			 next s=$?",
			&next,
			0,
		),
		both(
			"the arguments before it",
			"s='(1 \"2)'; declare -a x=1 a=$s; echo s=$?\ndeclare -p x",
			&format!("{EOF}declare -a x=([0]=\"1\")\n"),
			0,
		),
		both(
			"the builtin's own redirection",
			"s='(1 \"2)'; declare -a a=$s 2>/dev/null; echo s=$?\necho next s=$?",
			"next s=1\n",
			0,
		),
		both(
			"local",
			"f() { local -a a='(1 \"2)'; echo in; }; f; echo after\necho next s=$?",
			&next,
			0,
		),
		both("readonly", "readonly -a a='(1 \"2)'; echo s=$?\necho next s=$?", &next, 0),
		both("export", "export -a a='(1 \"2)'; echo s=$?\necho next s=$?", &next, 0),
		both("typeset", "typeset -a a='(1 \"2)'; echo s=$?\necho next s=$?", &next, 0),
		both("associative", "declare -A A='([k]=\"v)'; echo s=$?\necho next s=$?", &next, 0),
		both(
			"an existing array",
			"declare -a a; declare a='(1 \"2)'; echo s=$?\necho next s=$?",
			&next,
			0,
		),
		both(
			"an append",
			"declare -a a=(x); declare -a a+='(1 \"2)'; echo s=$?; declare -p a\necho next s=$?; \
			 declare -p a",
			&format!("{EOF}next s=1\ndeclare -a a=([0]=\"x\")\n"),
			0,
		),
		both(
			"a command substitution",
			"x=$(declare -a a='(1 \"2)'; echo in); echo \"x=$x s=$?\"\necho next",
			&format!("{EOF}x= s=1\nnext\n"),
			0,
		),
		both(
			"a . file",
			"printf '%s\\n' \"declare -a a='(1 \\\"2)'; echo in\" 'echo l2' > f.sh; . ./f.sh \
			 2>/dev/null; echo after s=$?\necho next",
			"l2\nafter s=0\nnext\n",
			0,
		),
	];
	assert_rows(&rows);
}

/// The message names the input `array assign` and a line of its own: an
/// end-of-input error the string's line its quote opened on (also a quote
/// that opens that line), or for a `$(` the string leaves open the line
/// after the string's last; a token error the command's line plus the
/// string's, less one (also in a function's body), with the string's line
/// that holds the token after it.
#[test]
fn the_message_names_array_assign_and_the_string_s_line() {
	let rows = [
		both(
			"a token error",
			"declare -a a='(a;b)'; echo s=$?; declare -p a",
			&token(1, ";", "a;b"),
			1,
		),
		both(
			"a pipe",
			"declare -a a='(a|b)'; echo s=$?\necho next s=$?",
			&format!("{}next s=1\n", token(1, "|", "a|b")),
			0,
		),
		both(
			"an associative array's token error",
			"declare -A A='([k]=v;b)'; echo s=$?\necho next s=$?",
			&format!("{}next s=1\n", token(1, ";", "[k]=v;b")),
			0,
		),
		both(
			"an end-of-input error on the script's line 2",
			"echo l1\ndeclare -a a='(1 \"2)'; echo s=$?\necho next s=$?",
			&format!("l1\n{EOF}next s=1\n"),
			0,
		),
		both(
			"an end-of-input error on the string's line 2",
			"declare -a a='(1\n\"2)'; echo s=$?\necho next s=$?",
			"SH: array assign: line 2: unexpected EOF while looking for matching `\"'\nnext s=1\n",
			0,
		),
		both(
			"a quote that opens on the string's line 1",
			"declare -a a='(\"1\n2)'; echo s=$?\necho next s=$?",
			&format!("{EOF}next s=1\n"),
			0,
		),
		both(
			"a single quote that opens the string's line 2",
			"declare -a a=\"(1\n'2)\"; echo s=$?\necho next s=$?",
			"SH: array assign: line 2: unexpected EOF while looking for matching `''\nnext s=1\n",
			0,
		),
		both(
			"a backquote that opens the string's line 2",
			"declare -a a='(1\n`2)'; echo s=$?\necho next s=$?",
			"SH: array assign: line 2: unexpected EOF while looking for matching ``'\nnext s=1\n",
			0,
		),
		both(
			"a $( the string leaves open",
			"declare -a a='(a $(echo b)'; echo s=$?\necho next s=$?",
			"SH: array assign: line 2: unexpected EOF while looking for matching `)'\nnext s=1\n",
			0,
		),
		both(
			"a $( on the string's line 2",
			"declare -a a='(a\n$(echo b)'; echo s=$?\necho next s=$?",
			"SH: array assign: line 3: unexpected EOF while looking for matching `)'\nnext s=1\n",
			0,
		),
		both(
			"a $( that opens the string's line 2",
			"declare -a a='(1\n$(2)'; echo s=$?\necho next s=$?",
			"SH: array assign: line 3: unexpected EOF while looking for matching `)'\nnext s=1\n",
			0,
		),
		both(
			"a token error on the script's line 2",
			"echo l1\ndeclare -a a='(a;b)'; echo s=$?\necho next s=$?",
			&format!("l1\n{}next s=1\n", token(2, ";", "a;b")),
			0,
		),
		both(
			"a token error on the string's line 2",
			"declare -a a='(1\na;b)'; echo s=$?\necho next s=$?",
			&format!("{}next s=1\n", token(2, ";", "a;b")),
			0,
		),
		both(
			"a token error on both lines 2",
			"echo l1\ndeclare -a a='(1\na;b)'; echo s=$?\necho next s=$?",
			&format!("l1\n{}next s=1\n", token(3, ";", "a;b")),
			0,
		),
		both(
			"a token error in a function's body",
			"f() {\ndeclare -a a='(a;b)'; echo in\n}; f; echo after s=$?\necho next s=$?",
			&format!("{}next s=1\n", token(2, ";", "a;b")),
			0,
		),
	];
	assert_rows(&rows);
}

/// Under `set -e` bash's `parser_error` exits the shell with status 2 as
/// soon as it prints its first line, also where `set -e` is ignored for
/// the command itself (`||`, `if`); an `eval` a condition runs turns it off
/// (`execute_cmd.c`, line 5000), and the `eval` returns 1.
#[test]
fn under_set_e_the_shell_exits_2_at_the_first_line() {
	let rows = [
		both(
			"a subshell",
			"s='(1 \"2)'; ( set -e; declare -a a=$s; echo in ); echo w=$?",
			&format!("{EOF}w=2\n"),
			0,
		),
		both(
			"the EXIT trap sees 2",
			"trap 'echo \"T s=$?\"' EXIT; set -e; declare -a a='(1 \"2)'; echo s=$?\necho next",
			&format!("{EOF}T s=2\n"),
			2,
		),
		both(
			"a token error's first line",
			"set -e; declare -a a='(a;b)'; echo s=$?\necho next",
			"SH: array assign: line 1: syntax error near unexpected token `;'\n",
			2,
		),
		both(
			"a subshell's token error",
			"( set -e; declare -a a='(a;b)'; echo in ); echo w=$?\necho next",
			"SH: array assign: line 1: syntax error near unexpected token `;'\nw=2\nnext\n",
			0,
		),
		both("||", "set -e; declare -a a='(1 \"2)' || echo or; echo after\necho next", EOF, 2),
		both(
			"if",
			"set -e; if declare -a a='(1 \"2)'; then echo t; else echo f; fi; echo after\necho next",
			EOF,
			2,
		),
		both(
			"an eval a condition runs",
			"set -e; s='(1 \"2)'; eval 'declare -a a=$s; echo in' || echo or; echo after s=$?\necho \
			 next",
			&format!("{EOF}or\nafter s=0\nnext\n"),
			0,
		),
	];
	assert_rows(&rows);
}

/// A non-interactive posix shell exits (bash's `FORCE_EOF`): a `-c` string
/// with 127 (`run_one_command`), a script and a subshell with 1, also from
/// an `eval`. bash runs no `top_level_cleanup` first: in a script the EXIT
/// trap still sees the function; the `-c` string's `parse_and_execute`
/// pops it.
#[test]
fn a_posix_shell_exits() {
	let rows = [
		by_mode(
			"the top level",
			"set -o posix; declare -a a='(1 \"2)'; echo s=$?\necho next s=$?",
			(EOF, 127),
			(EOF, 1),
		),
		by_mode(
			"a function and the EXIT trap",
			"set -o posix; trap 'echo \"T ${FUNCNAME[*]-none} s=$?\"' EXIT; f() { declare -a a='(1 \
			 \"2)'; echo in; }; f; echo after\necho next",
			(&format!("{EOF}T none s=127\n"), 127),
			(&format!("{EOF}T f main s=1\n"), 1),
		),
		both(
			"a subshell",
			"set -o posix; ( declare -a a='(1 \"2)'; echo in ); echo w=$?\necho next",
			&format!("{EOF}w=1\nnext\n"),
			0,
		),
		by_mode(
			"eval",
			"set -o posix; s='(1 \"2)'; eval 'declare -a a=$s; echo in'; echo after\necho next",
			(EOF, 127),
			(EOF, 1),
		),
	];
	assert_rows(&rows);
}

/// The discard's kind: at a script's own level bash runs `top_level_cleanup`
/// first (a subshell's EXIT trap runs outside every function; the
/// redirections the jump leaves are undone, so `time` reports on the
/// shell's stderr), under `-c` and inside `eval` it does not.
#[test]
fn the_discard_cleans_up_only_at_a_script_s_level() {
	let rows = [
		by_mode(
			"a subshell's function",
			"( trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset}\"' EXIT; f() { local l=1; declare -a \
			 a='(1 \"2)'; echo in; }; f; echo after ); echo w=$?",
			(&format!("{EOF}T f l=1\nw=1\n"), 0),
			(&format!("{EOF}T none l=unset\nw=1\n"), 0),
		),
		both(
			"time in eval",
			"TIMEFORMAT='[R]'; s='(1 \"2)'; eval 'time { declare -a a=$s; } 2>e1; echo in'; echo \
			 after; echo e1:; cat e1",
			&format!("after\ne1:\n{EOF}[R]\n"),
			0,
		),
		by_mode(
			"time in a subshell",
			"TIMEFORMAT='[R]'; s='(1 \"2)'; ( time { declare -a a=$s; } 2>e1; echo after ); echo \
			 w=$?; echo e1:; cat e1",
			(&format!("w=1\ne1:\n{EOF}[R]\n"), 0),
			(&format!("[R]\nw=1\ne1:\n{EOF}"), 0),
		),
	];
	assert_rows(&rows);
}

/// The control: a string that parses is assigned, and one that does not
/// end in `)` (or has a word after it) is no compound value at all, so
/// nothing is parsed and nothing fails.
#[test]
fn a_string_that_parses_or_is_no_compound_value_is_assigned() {
	let rows = [
		both(
			"a string that parses",
			"declare -a a='(1 \"2\")'; echo s=$?; declare -p a",
			"s=0\ndeclare -a a=([0]=\"1\" [1]=\"2\")\n",
			0,
		),
		both(
			"no closing parenthesis",
			"declare -a a='(1 2'; echo s=$?; declare -p a",
			"s=0\ndeclare -a a=([0]=\"(1 2\")\n",
			0,
		),
		both(
			"a word after the parenthesis",
			"declare -a a='(1 \"2) x'; echo s=$?; declare -p a",
			"s=0\ndeclare -a a=([0]=\"(1 \\\"2) x\")\n",
			0,
		),
	];
	assert_rows(&rows);
}
