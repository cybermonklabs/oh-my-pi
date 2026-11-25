//! `$(< file)` reads the file in the shell itself, as bash and zsh do: no
//! subshell runs the `< file`. Each row runs `obash -c` (as `bash`, or as
//! `zsh -f`) in a directory holding `f` (`hello` and two blank lines), `e`
//! (empty), `n` (`x`, no newline) and the directory `dd`, and checks stdout,
//! stderr and the status against what bash 5.3.20 or zsh 5.9 print for the
//! same script there. bash 5.2.21 agrees with 5.3.20 on every bash row but
//! those the rows mark: two name a function's line `environment: line 1:`,
//! six use 5.3's `${| }`, and two end the shell under `set -e`. Nor does it
//! on the rows of the four `break` tests, which use `${| }` or `${ }` (5.2
//! has neither), but for the two that use neither.

mod obash_support;

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

use crate::obash_support::{obash, output};

/// `(script, stdout, stderr, status)`.
type Row = (&'static str, &'static str, &'static str, i32);

/// bash's message for the file `missing`.
const MISSING: &str = "bash: line 1: missing: No such file or directory\n";

/// Run `script` as `name` (`bash` or `zsh`) in a fresh directory holding the
/// rows' files: stdout, stderr, status.
fn run(name: &str, script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("f"), "hello\n\n\n").unwrap();
	std::fs::write(dir.path().join("e"), "").unwrap();
	std::fs::write(dir.path().join("n"), "x").unwrap();
	std::fs::create_dir(dir.path().join("dd")).unwrap();
	let mut cmd = obash();
	#[cfg(unix)]
	cmd.arg0(name);
	if name == "zsh" {
		cmd.arg("-f");
	}
	let out = output(cmd.current_dir(dir.path()).args(["-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// Every row of `rows` run as `name`; the mismatches listed together.
fn check(name: &str, rows: &[Row]) {
	let mut mismatches = Vec::new();
	for &(script, out, err, status) in rows {
		let got = run(name, script);
		if got != (out.to_owned(), err.to_owned(), status) {
			mismatches.push(format!("{script:?}\n  want {:?}\n  got  {got:?}", (out, err, status)));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

#[cfg(unix)]
#[test]
fn bash_reads_a_file_substitution_in_the_shell() {
	let missing = MISSING;
	check("bash", &[
		("false; echo \"[$(< f)]\" $?", "[hello] 0\n", "", 0),
		("false; echo \"[$(< missing)]\" $?", "[] 1\n", missing, 0),
		("x=$(< missing); echo \"st=$?\"", "st=1\n", missing, 0),
		("x=$(< e); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("x=$(< n); echo \"st=$? [$x]\"", "st=0 [x]\n", "", 0),
		// A read error is no failure: bash's `read_comsub` ends the value.
		("x=$(< dd); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("g=f; x=$(< $g); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		// A substitution in the name: the body is the `< word` after its block.
		("x=$(< $(echo f)); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(< \"$(echo f)\"); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(0< f); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		// The `< file` is no command: no DEBUG trap or `BASH_COMMAND` for it.
		(
			"set -T; trap 'echo \"D:$BASH_COMMAND\"' DEBUG; x=$(< f); trap - DEBUG; echo \"[$x]\"",
			"D:x=$(< f)\nD:trap - DEBUG\n[hello]\n",
			"",
			0,
		),
		(
			"trap 'echo \"ERR:$BASH_COMMAND\"' ERR; x=$(< missing); echo \"st=$?\"",
			"ERR:x=$(< missing)\nst=1\n",
			missing,
			0,
		),
		("set -x; x=$(< f); set +x", "", "+ x=hello\n+ set +x\n", 0),
		// The word expands in the shell: `set -u` ends it.
		(
			"set -u; x=$(< $undef); echo \"st=$? [$x]\"",
			"",
			"bash: line 1: undef: unbound variable\n",
			127,
		),
		("set -e; x=$(< missing); echo after", "", missing, 1),
		("false; x=$(< f); echo \"st=$?\"", "st=0\n", "", 0),
		("x=$(< f)$(< missing); echo \"st=$? [$x]\"", "st=1 [hello]\n", missing, 0),
		("x=$(< f) y=$(false); echo \"st=$?\"", "st=1\n", "", 0),
		("x=$(< /dev/null); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		// bash 5.3.20's prefix; 5.2.21 prints `environment: line 1:` here.
		(
			"f() { echo \"[$(< \"$1\")]\"; }; f f; f missing; echo \"st=$?\"",
			"[hello]\n[]\nst=0\n",
			missing,
			0,
		),
		// The shell's fds are left alone while the word expands: an EXIT trap
		// that a fatal error in it runs inside a function writes to stdout
		// (bash 5.2.21 prints `environment: line 1:` here).
		(
			"set -u; trap 'echo bye' EXIT; f() { x=$(< $undef); }; f",
			"bye\n",
			"bash: line 1: undef: unbound variable\n",
			127,
		),
		// …and what the word's own `${| cmd; }` writes is no part of the
		// value (bash 5.3 syntax; 5.2.21 has no `${| }`).
		("x=$(< ${| echo hi; REPLY=f; }); echo \"[$x]\"", "hi\n[hello]\n", "", 0),
		("f() { x=$(< ${| echo hi; REPLY=f; }); echo \"[$x]\"; }; f", "hi\n[hello]\n", "", 0),
		// A `break` or `continue` in the word waits until the command that
		// holds the `$(< …)` is over (bash 5.3's `breaking`): the word
		// expands to nothing, the redirection fails with the word as bash
		// stores it, then the loop ends. One that sets `REPLY` first reads
		// the file. A `return` there leaves only the `${| }`.
		(
			"for i in 1 2; do x=$(< ${| break; }); echo in; done; echo \"out $?\"",
			"out 1\n",
			"bash: line 1: ${|break; }: ambiguous redirect\n",
			0,
		),
		(
			"for i in 1 2; do x=$(< ${| continue; }); echo in; done; echo out",
			"out\n",
			"bash: line 1: ${|continue; }: ambiguous redirect\nbash: line 1: ${|continue; }: \
			 ambiguous redirect\n",
			0,
		),
		(
			"for i in 1 2; do x=$(< ${| REPLY=f; break; }); echo \"in [$x]\"; done; echo \"out [$x]\"",
			"out [hello]\n",
			"",
			0,
		),
		(
			"f() { x=$(< ${| return 3; }); echo no; }; f; echo \"st=$?\"",
			"no\nst=0\n",
			"bash: line 1: ${|return 3; }: ambiguous redirect\n",
			0,
		),
		// The `< file` runs no command: `PIPESTATUS` stays the pipeline's.
		("false | true; echo \"$(< f)\" \"${PIPESTATUS[@]}\"", "hello 1 0\n", "", 0),
		("false | true; x=$(< f); echo \"${PIPESTATUS[@]}\"", "0\n", "", 0),
		// A failed read inside a command whose own status is 0 does not end
		// the shell under `set -e` (bash 5.3.20; 5.2.21 exits there).
		("set -e; echo \"[$(< missing)] done\"; echo after", "[] done\nafter\n", missing, 0),
		("set -e; f() { echo \"[$(< missing)]\"; }; f; echo after", "[]\nafter\n", missing, 0),
	]);
}

/// bash expands the redirections of a program it runs (an external, a name
/// it cannot find) after the fork, in the child: a `break` or `continue` in
/// a `${ }` there (a here-document, a here-string, a file word) ends with
/// that child, and the loop goes on. The redirections of a builtin, a
/// function or a compound command are expanded in the shell, and the break
/// waits for the command there, as does one in a program's arguments.
#[cfg(unix)]
#[test]
fn a_break_in_a_programs_redirection_stays_in_its_child() {
	let twice = "bash: line 1: nosuch: command not found\nbash: line 1: nosuch: command not found\n";
	check("bash", &[
		(
			"for i in 1 2; do cat <<E\nh ${| break; } t\nE\necho in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do cat <<E\nh ${| continue; } t\nE\necho in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do cat <<E\nh ${ break; } t\nE\necho in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do cat <<< \"h ${| break; } t\"; echo in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do cat < ${| REPLY=f; break; }; echo in; done; echo out",
			"hello\n\n\nin\nhello\n\n\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do nosuch < ${| REPLY=f; break; }; echo in; done; echo out",
			"in\nin\nout\n",
			twice,
			0,
		),
		(
			"for i in 1 2; do A=1 cat <<E\nh ${| break; } t\nE\necho in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do command cat <<E\nh ${| break; } t\nE\necho in; done; echo out",
			"h  t\nin\nh  t\nin\nout\n",
			"",
			0,
		),
		(
			"for j in 1; do for i in 1 2; do cat <<E\nh ${| break 2; } t\nE\necho in; done; echo \
			 mid; done; echo out",
			"h  t\nin\nh  t\nin\nmid\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do cat /dev/null 2> ${| REPLY=/dev/null; break; }; echo in; done; echo out",
			"in\nin\nout\n",
			"",
			0,
		),
		// The child keeps the loop level, so the break ends its `${| }` and
		// waits there as bash's `breaking` does: a later `${| }` of the same
		// command runs nothing, and the program runs. So it does in a `$( )`
		// in the loop, whose child keeps the level for the program's own.
		(
			"for i in 1 2; do cat 3>e${| break; } 4>e${| echo 2nd >&2; } <<< p$i; echo in; done",
			"p1\nin\np2\nin\n",
			"",
			0,
		),
		(
			"for i in 1 2; do x=$(cat 3>e${| break; } <<< p$i; echo more); echo \"[$x]\"; done",
			"[p1\nmore]\n[p2\nmore]\n",
			"",
			0,
		),
		// In the shell: the break waits for the command, then the loop ends.
		(
			"for i in 1 2; do read v <<E\n${| break; }x\nE\necho \"in [$v]\"; done; echo \"out [$v]\"",
			"out [x]\n",
			"",
			0,
		),
		(
			"f() { cat; }; for i in 1 2; do f <<E\nh ${| break; } t\nE\necho in; done; echo out",
			"out\n",
			"",
			0,
		),
		(
			"for i in 1 2; do { cat; } <<E\nh ${| break; } t\nE\necho in; done; echo out",
			"out\n",
			"",
			0,
		),
		(
			"for i in 1 2; do echo e > ${| REPLY=/dev/null; break; }; echo in; done; echo out",
			"out\n",
			"",
			0,
		),
		("for i in 1 2; do cat /dev/null ${| break; }; echo in; done; echo out", "out\n", "", 0),
	]);
}

/// `exec` makes its redirections in the shell and looks its name up after
/// them (`exec_builtin` goes back to `Stage::Lookup`): a `break` or
/// `continue` in a `${ }` there waits, and when the program is not found
/// (`execfail` keeps the shell) the loop takes it, as in bash. Each failed
/// `exec` reports on one line; the words are not checked, because the
/// release's differ from bash's (`exec: nosuch: not found` for `nosuch: not
/// found`, `./nosuch` for the absolute path) and are another change's.
#[cfg(unix)]
#[test]
fn a_break_in_a_failed_execs_redirection_leaves_the_loop() {
	const FORMS: &[(&str, &str, usize)] = &[
		("exec nosuch 3>e${| break; }", "out\n", 1),
		("exec ./nosuch 3>e${| break; }", "out\n", 1),
		("exec nosuch 3>e${| continue; }", "out\n", 2),
		("command exec nosuch 3>e${| break; }", "out\n", 1),
		("exec -a x nosuch 3>e${| break; }", "out\n", 1),
	];
	let wrong: Vec<String> = FORMS
		.iter()
		.filter_map(|&(cmd, want, reports)| {
			let src =
				format!("shopt -s execfail; for i in 1 2; do {cmd}; echo \"in $?\"; done; echo out");
			let (out, err, status) = run("bash", &src);
			(out != want || status != 0 || err.lines().count() != reports)
				.then(|| format!("`{src}`: stdout {out:?}, stderr {err:?}, status {status}"))
		})
		.collect();
	assert!(
		wrong.is_empty(),
		"{} of {} forms differ:\n{}",
		wrong.len(),
		FORMS.len(),
		wrong.join("\n")
	);
}

/// A `break` or `continue` in a `${ }` of a `( … )`'s own redirection sees
/// no loop: bash expands those redirections in the subshell, where
/// `loop_level` is 0, so the builtin complains (outside posix mode), does
/// nothing, and the rest of the substitution runs; a `$( )` or `<( )` there
/// has no loop either. Before, the loop around the `( … )` took it.
#[cfg(unix)]
#[test]
fn a_break_in_a_subshells_redirection_sees_no_loop() {
	check("bash", &[
		(
			"for i in 1 2; do ( true ) > ${| REPLY=/dev/null; break; }; echo b$i; done; echo end:$?",
			"b1\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; continue; }; echo b$i; done; echo \
			 end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: continue: only meaningful in a `for', `while', or `until' loop\nbash: \
			 line 1: continue: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${| break; echo more; REPLY=/dev/null; }; echo b$i; \
			 done; echo end:$?",
			"more\na1\nb1\nmore\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( for j in a; do echo j$j; done ) 2> ${| REPLY=/dev/null; break; }; \
			 echo b$i; done; echo end:$?",
			"ja\nb1\nja\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"set -o posix; for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo b$i; \
			 done; echo end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"",
			0,
		),
		(
			"TIMEFORMAT=; for i in 1 2; do time ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo \
			 b$i; done; echo end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${ echo /dev/null; break; }; echo b$i; done; echo \
			 end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( cat ) <<E\nh ${| break; } t\nE\necho b$i; done; echo end:$?",
			"h  t\nb1\nh  t\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for o in A; do for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break 2; }; echo \
			 b$i; done; echo o$o; done; echo end:$?",
			"a1\nb1\na2\nb2\noA\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1; do ( exit 3 ) 2> ${| REPLY=/dev/null; break; }; echo b:$?; done; echo end:$?",
			"b:3\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${| x=${| break; }; REPLY=/dev/null; }; echo b$i; \
			 done; echo end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ! ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo b$i:$?; done; \
			 echo end:$?",
			"a1\nb1:1\na2\nb2:1\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> \"$(break; echo /dev/null)\"; echo b$i; done; echo \
			 end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( cat ) < <(break; echo p$i); echo b$i; done; echo end:$?",
			"p1\nb1\np2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${| x=$(break; echo y); REPLY=/dev/null; echo \
			 \"[$x]\"; }; echo b$i; done; echo end:$?",
			"[y]\na1\nb1\n[y]\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break; } | cat; echo b$i; done; \
			 echo end:$?",
			"a1\nb1\na2\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do { echo g$i; } 2> ${| REPLY=/dev/null; break; }; echo b$i; done; echo \
			 end:$?",
			"end:0\n",
			"",
			0,
		),
	]);
}

/// A `break` or `continue` in a `${ }` of a loop's own redirection is taken
/// by that loop: bash expands the redirections before the loop counts
/// itself, and the loop then runs no pass for it. A `while` or `until`
/// skips its first test (with the status `$?` has, which a `continue` goes
/// by) and its body; a `for` binds its first word and a `select` reads its
/// first line first, or ends without one and passes the break on; an
/// arithmetic `for` evaluates its first two expressions. The count is
/// capped at the loops around it when the break runs. A `break` in a
/// `for`'s own words waits for its first word too. While the break waits,
/// a substitution in the loop's header runs nothing and gives nothing, as
/// bash runs no command while `breaking`: an arithmetic `for` whose header
/// is then wrong ends with status 1 (its message to the redirection), and
/// the break goes on out, unless its test failed, which takes one level.
#[cfg(unix)]
#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "Bash parameter expansion is intentional fixture syntax, not Rust formatting."
)]
fn a_loop_takes_a_break_from_its_own_redirection() {
	check("bash", &[
		(
			"for i in 1 2; do while true; do true; break; done > ${| REPLY=/dev/null; break; }; echo \
			 b$i; done; echo end:$?",
			"b1\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do while echo t$i; do echo w$i; break; done 2> ${| REPLY=/dev/null; \
			 break; }; echo b$i:$?; done; echo end:$?",
			"b1:0\nb2:0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do until echo t; false; do echo u; break; done 2> ${| REPLY=/dev/null; \
			 break; }; echo b$i:$?; done; echo end:$?",
			"b1:0\nb2:0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in a b; do echo x$x; done 2> ${| REPLY=/dev/null; break; }; echo \
			 \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [a]\nb2:0 [a]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in; do echo x$x; done 2> ${| REPLY=/dev/null; break; }; echo \
			 b$i; done; echo end:$?",
			"end:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; \
			 break; }; echo \"b$i:$? $j\"; done; echo end:$?",
			"b1:0 0\nb2:0 0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for ((j=0; j++<2; )); do echo j$j; done 2> ${| REPLY=/dev/null; break; \
			 }; echo \"b$i:$? $j\"; done; echo end:$?",
			"b1:0 1\nb2:0 1\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for ((j=5; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; \
			 break; }; echo \"b$i:$? $j\"; done; echo end:$?",
			"b1:0 5\nb2:0 5\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in a b; do echo s$x; done 2> ${| REPLY=/dev/null; break; } \
			 <<< 1; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [a]\nb2:0 [a]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in a b; do echo s$x; done 2> ${| REPLY=/dev/null; break; } < \
			 /dev/null; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"\nend:1\n",
			"",
			0,
		),
		(
			"for i in 1 2; do n=0; while (( n++ < 2 )); do echo w$i$n; done 2> ${| REPLY=/dev/null; \
			 continue; }; echo b$i; done; echo end:$?",
			"w11\nw12\nb1\nw21\nw22\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do n=0; until (( n++ >= 2 )); do echo u$i$n; done 2> ${| REPLY=/dev/null; \
			 continue; }; echo \"b$i $n\"; done; echo end:$?",
			"b1 0\nb2 0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in a b c; do echo x$x; done 2> ${| REPLY=/dev/null; continue; }; \
			 echo b$i; done; echo end:$?",
			"xb\nxc\nb1\nxb\nxc\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; \
			 continue; }; echo \"b$i $j\"; done; echo end:$?",
			"j0\nj1\nb1 2\nj0\nj1\nb2 2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in a b; do echo s$x; break; done 2> ${| REPLY=/dev/null; \
			 continue; } <<< $'1\\n2'; echo \"b$i [$x]\"; done; echo end:$?",
			"sb\nb1 [b]\nsb\nb2 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for o in A; do for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; \
			 break 2; }; echo b$i; done; echo o$o; done; echo end:$?",
			"oA\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; break 2; }; echo \
			 b$i; done; echo end:$?",
			"b1\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for o in A B; do for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; \
			 continue 2; }; echo b$i; done; echo o$o; done; echo end:$?",
			"oA\noB\nend:0\n",
			"",
			0,
		),
		(
			"for o in A B; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; \
			 continue 2; }; echo b$o; done; echo end:$?",
			"j0\nj1\nbA\nj0\nj1\nbB\nend:0\n",
			"",
			0,
		),
		(
			"while true; do echo w; break; done 2> ${| REPLY=/dev/null; break; }; echo end:$?",
			"w\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		(
			"for i in 1 2; do for x in a ${| break; } b; do echo x$x; done; echo \"b$i [$x]\"; done; \
			 echo end:$?",
			"b1 [a]\nb2 [a]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in a ${| break; } b; do echo s$x; done 2>/dev/null <<< 1; \
			 echo \"b$i [$x]\"; done; echo end:$?",
			"b1 [a]\nb2 [a]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do while read v; do echo r$v; done <<E\nh ${| break; } t\nE\necho b$i; \
			 done; echo end:$?",
			"b1\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do while true; do echo w; break; done 2> ${ echo /dev/null; break; }; \
			 echo b$i; done; echo end:$?",
			"b1\nb2\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1; do for x in a; do (exit 4); done 2> ${| REPLY=/dev/null; (exit 3); break; \
			 }; echo b:$?; done; echo end:$?",
			"b:0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1; do until false; do :; done 2> ${| REPLY=/dev/null; (exit 3); break; }; echo \
			 b:$?; done; echo end:$?",
			"b:0\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do eval 'while true; do break; done 2> ${| REPLY=/dev/null; break; }'; \
			 echo b$i; done; echo end:$?",
			"b1\nb2\nend:0\n",
			"",
			0,
		),
		(
			"trap 'echo dbg' DEBUG; for i in 1; do while true; do break; done 2> ${| \
			 REPLY=/dev/null; break; }; echo b$i; done; trap - DEBUG; echo end:$?",
			"dbg\ndbg\ndbg\ndbg\nb1\ndbg\nend:0\n",
			"",
			0,
		),
		(
			"f() { while true; do echo w; break; done 2> ${| REPLY=/dev/null; break; }; echo f; }; \
			 for i in 1 2; do f; echo b$i; done; echo end:$?",
			"w\nf\nb1\nw\nf\nb2\nend:0\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\nbash: line \
			 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		// A substitution in the header's words or expressions runs nothing
		// while the break waits.
		(
			"for i in 1 2; do for x in ${| echo side$i; REPLY=q; } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in ${| echo side$i; REPLY=q; } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in $(echo side$i; echo q) b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do n=0; for x in ${| REPLY=$((n+=5)); } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"n=$n\"; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"n=0\nb1:0 [b]\nn=0\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in a ${| break; } b; do echo x$x; done 2> ${| REPLY=/dev/null; \
			 continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"xb\nb1:0 [b]\nxb\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in a ${| continue; } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [a]\nb2:0 [a]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in ${ echo a$i; } ${| REPLY=c; } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in <(echo p) b; do echo x${x:+set}; done 2> ${| REPLY=/dev/null; \
			 continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"xset\nb1:0 [b]\nxset\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in \"${| REPLY=q; }\" b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"xb\nb1:0 [b]\nxb\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for x in ${| x=$(echo q); REPLY=$x; } b; do echo x$x; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in ${| echo side$i; REPLY=a; } b; do echo s$x; break; done 2> \
			 ${| REPLY=/dev/null; break; } <<< 1; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"b1:0 [b]\nb2:0 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do select x in $(echo a) b; do echo s$x; break; done 2> ${| \
			 REPLY=/dev/null; continue; } <<< 1; echo \"b$i:$? [$x]\"; done; echo end:$?",
			"\nb1:1 [b]\n\nb2:1 [b]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=${| echo side$i; REPLY=0; }; j<2; j++ )); do echo j$j; done \
			 2> ${| REPLY=/dev/null; break; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"end:1\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=$(echo 0); j<2; j++ )); do echo j$j; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"end:1\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<${| REPLY=2; }; j++ )); do echo j$j; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"b1:1 [0]\nb2:1 [0]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<${| REPLY=2; }; j++ )); do echo j$j; done 2> ${| \
			 REPLY=/dev/null; continue; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"b1:1 [0]\nb2:1 [0]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=1/0; j<2; j++ )); do echo j$j; done 2> ${| REPLY=/dev/null; \
			 break; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"end:1\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for o in A; do for (( j=0; j<${| REPLY=2; }; j++ )); do echo j$j; done \
			 2> ${| REPLY=/dev/null; continue 2; }; echo o$o; done; echo \"b$i:$? [$j]\"; done; echo \
			 end:$?",
			"b1:1 [0]\nb2:1 [0]\nend:0\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<2; j+=${| REPLY=1; } )); do echo j$j; done 2> ${| \
			 REPLY=/dev/null; break; }; echo \"b$i:$? [$j]\"; done; echo end:$?",
			"b1:0 [0]\nb2:0 [0]\nend:0\n",
			"",
			0,
		),
	]);
}

/// A trap that a command in a `${ }` sets off runs before the next command
/// there, as bash runs a pending trap as each command ends, so a `break`
/// after it does not leave the trap with nothing to run: in a command's
/// words, and in a group's, `if`'s, `case`'s or loop's own redirection. In
/// a program's or a `( … )`'s own redirection, which bash expands in the
/// forked child, the trap waits for that child.
#[cfg(unix)]
#[test]
fn a_trap_runs_before_a_break_in_a_substitution() {
	check("bash", &[
		(
			"trap \"echo trapped\" USR1; for i in 1; do echo ${| kill -USR1 $$; break; } x; echo in; \
			 done; echo out",
			"trapped\nx\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1; do echo ${| kill -USR1 $$; echo after; } x; \
			 echo in; done; echo out",
			"trapped\nafter\nx\nin\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; echo ${| kill -USR1 $$; echo after; } x; echo out",
			"trapped\nafter\nx\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; x=${| kill -USR1 $$; echo after; }; echo out",
			"trapped\nafter\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do echo ${| kill -USR1 $$; continue; } x$i; \
			 echo in; done; echo out",
			"trapped\nx1\ntrapped\nx2\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1; do echo ${ kill -USR1 $$; break; } x; echo in; \
			 done; echo out",
			"trapped x\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1; do cat <<E\nh ${| kill -USR1 $$; break; } \
			 t\nE\necho in; done; echo out",
			"h  t\ntrapped\nin\nout\n",
			"",
			0,
		),
		// A program's redirection: bash expands it in the child, and the trap
		// waits for the child (a builtin's, expanded in the shell, runs it at
		// once: not yet here, as the shell holds a trap back while any simple
		// command's redirections are made).
		(
			"trap \"echo trapped\" USR1; for i in 1; do /bin/echo e 2> ${| kill -USR1 $$; \
			 REPLY=/dev/null; break; }; echo in; done; echo out",
			"e\ntrapped\nin\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; ( echo s ) 2> ${| kill -USR1 $$; REPLY=/dev/null; }; echo \
			 out",
			"s\ntrapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; { echo g; } 2> ${| kill -USR1 $$; REPLY=/dev/null; }; echo \
			 out",
			"trapped\ng\nout\n",
			"",
			0,
		),
		(
			"trap \"echo t1\" USR1; trap \"echo t2\" USR2; for i in 1; do echo ${| kill -USR1 $$; \
			 kill -USR2 $$; break; } x; echo in; done; echo out",
			"t1\nt2\nx\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped \\$?\" USR1; for i in 1; do echo ${| (exit 3); kill -USR1 $$; \
			 break; } x; echo \"in $?\"; done; echo out",
			"trapped 0\nx\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; f() { echo f ${| kill -USR1 $$; break; } x; echo fin; }; \
			 for i in 1; do f; echo in; done; echo out",
			"trapped\nf x\nfin\nin\nout\n",
			"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\n",
			0,
		),
		// A compound command's own redirection, which bash expands in the
		// shell: the trap runs before the `break` or `continue` is taken.
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do while true; do echo w; break; done 2> ${| \
			 kill -USR1 $$; REPLY=/dev/null; break; }; echo \"in$i\"; done; echo out",
			"trapped\nin1\ntrapped\nin2\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do while true; do echo w; break; done 2> ${| \
			 kill -USR1 $$; REPLY=/dev/null; continue; }; echo \"in$i\"; done; echo out",
			"trapped\nw\nin1\ntrapped\nw\nin2\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do for x in a b; do echo x$x; done 2> ${| \
			 kill -USR1 $$; REPLY=/dev/null; continue; }; echo \"in$i\"; done; echo out",
			"trapped\nxb\nin1\ntrapped\nxb\nin2\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do { echo g; } 2> ${| kill -USR1 $$; \
			 REPLY=/dev/null; break; }; echo \"in$i\"; done; echo out",
			"trapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do { echo g; } 2> ${| kill -USR1 $$; \
			 REPLY=/dev/null; continue; }; echo \"in$i\"; done; echo out",
			"trapped\ntrapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do if true; then echo t; fi 2> ${| kill -USR1 \
			 $$; REPLY=/dev/null; break; }; echo \"in$i\"; done; echo out",
			"trapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do if true; then echo t; fi 2> ${| kill -USR1 \
			 $$; REPLY=/dev/null; continue; }; echo \"in$i\"; done; echo out",
			"trapped\ntrapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do case x in x) echo c;; esac 2> ${| kill \
			 -USR1 $$; REPLY=/dev/null; break; }; echo \"in$i\"; done; echo out",
			"trapped\nout\n",
			"",
			0,
		),
		(
			"trap \"echo trapped\" USR1; for i in 1 2; do case x in x) echo c;; esac 2> ${| kill \
			 -USR1 $$; REPLY=/dev/null; continue; }; echo \"in$i\"; done; echo out",
			"trapped\ntrapped\nout\n",
			"",
			0,
		),
	]);
}

#[cfg(unix)]
#[test]
fn zsh_reads_a_file_substitution_in_the_shell() {
	check("zsh", &[
		// `$?` is left alone on success (zsh sets it only on failure).
		("false; print \"[$(< f)]\" $?", "[hello] 1\n", "", 0),
		(
			"false; print \"[$(< missing)]\" $?",
			"[] 1\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		("x=$(< e); print \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("x=$(< n); print \"st=$? [$x]\"", "st=0 [x]\n", "", 0),
		(
			"x=$(< dd); print \"st=$? [$x]\"",
			"st=1 []\n",
			"zsh:1: error when reading dd: is a directory\n",
			0,
		),
		("g=f; x=$(< $g); print \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(< $(print f)); print \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(<f); print \"[$x]\"", "[hello]\n", "", 0),
		// The name is not globbed.
		("x=$(< f*); print \"st=$? [$x]\"", "st=1 []\n", "zsh:1: no such file or directory: f*\n", 0),
		(
			"TRAPZERR() { print \"ERR:$?\" }; x=$(< missing); print \"st=$?\"",
			"ERR:1\nst=1\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		// No command runs for the `< f`: no DEBUG trap, no trace line.
		(
			"TRAPDEBUG() { print \"D:$ZSH_DEBUG_CMD\" }; x=$(< f); unfunction TRAPDEBUG; print \
			 \"[$x]\"",
			"D:x=$(< f) \nD:unfunction TRAPDEBUG\n[hello]\n",
			"",
			0,
		),
		(
			"setopt xtrace; x=$(< f); unsetopt xtrace",
			"",
			"+zsh:1> x=hello \n+zsh:1> unsetopt xtrace\n",
			0,
		),
		(
			"setopt errexit; x=$(< missing); print after",
			"",
			"zsh:1: no such file or directory: missing\n",
			1,
		),
		(
			"x=$(< f)$(< missing); print \"st=$? [$x]\"",
			"st=1 [hello]\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		// The failed read's message once, though the word expands again for
		// the second file; its status stays.
		(
			"x=$(< missing)$(< f); print \"st=$? [$x]\"",
			"st=1 [hello]\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		("x=$(< /dev/null); print \"st=$? [$x]\"", "st=0 []\n", "", 0),
	]);
}
