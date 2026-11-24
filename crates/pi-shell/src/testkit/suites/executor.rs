//! Executor behaviour: `set -k`, prefix-assignment errors, `case` status,
//! the EXIT trap of an `exit` in a function, discarded commands, `${ ;}`
//! re-parsing, a `break` inside `${ ;}`, the word an ambiguous redirection
//! names, `set -x` headers of compound commands and the status of
//! `command -v`/`-V`. Goldens: bash 5.3.20 (`/opt/homebrew/bin/bash -c
//! '…'`).

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

#[test]
fn keyword_words_are_assignments_after_the_prefix_ones() {
	let (out, err, _) =
		run("set -k; f=1 g=2 echo x h=3; echo $f $g $h; HOME=/a/b/c a=$HOME c=9; echo $HOME $c $a");
	assert_eq!(err, "");
	assert_eq!(out, "x\n\n/a/b/c 9 /a/b/c\n");
}

#[test]
fn keyword_words_are_traced_as_assignments() {
	let (_, err, _) = run("set -k; set -x; true a=1 b=2");
	assert_eq!(err, "+ a=1\n+ b=2\n+ true\n");
}

#[test]
fn subscripted_prefix_assignment_is_reported_and_the_command_runs() {
	let (out, err, _) = run("var[0]=$(echo side >&2) true; echo $? ${var[0]-unset}");
	assert_eq!(err, "bash: line 1: `var[0]': not a valid identifier\n");
	assert_eq!(out, "0 unset\n");
}

#[test]
fn case_keeps_status_until_an_arm_decides() {
	let (out, ..) = run(
		"false; case x in x) echo $?;; esac; false; case x in x) ;; esac; echo $?; false; case x in \
		 y) ;; esac; echo $?; case x in x) false;;& y) ;; esac; echo $?",
	);
	assert_eq!(out, "1\n0\n0\n1\n");
}

#[test]
fn exit_in_a_function_runs_the_exit_trap_in_its_scope() {
	let (out, _, status) =
		run("trap 'echo trap:$FUNCNAME $x' EXIT; f() { local x=1; exit 3; }; f; echo no");
	assert_eq!(out, "trap:f 1\n");
	assert_eq!(status, 3);
}

#[test]
fn bad_substitution_discards_the_command_of_the_innermost_script() {
	let (out, err, _) = run(
		"echo ${x!y}; echo same\necho next $?\neval \"echo \\${x!y}; echo in1\necho in2\"; echo \
		 after $?",
	);
	assert_eq!(out, "next 1\nin2\nafter 0\n");
	assert_eq!(
		err,
		"bash: line 1: ${x!y}: bad substitution\nbash: line 3: ${x!y}: bad substitution\n"
	);
}

#[test]
fn nofork_comsub_is_reparsed_with_current_aliases() {
	let (out, err, _) = run("shopt -s expand_aliases; alias e='echo al'; echo ${ e; }");
	assert_eq!(err, "");
	assert_eq!(out, "al\n");
}

/// The re-parsed body is reused only while no alias is defined: an alias
/// defined (or removed) between two runs of the same `${ ;}` applies.
#[test]
fn nofork_comsub_reuse_follows_alias_changes() {
	let (out, err, _) = run(
		"shopt -s expand_aliases; e() { echo fn; }; for i in 1 2; do echo ${ e; }; alias e='echo \
		 al'; done; unalias e; echo ${ e; }",
	);
	assert_eq!(err, "");
	assert_eq!(out, "fn\nal\nfn\n");
}

/// The same `${ ;}` text at another line re-parses with that line.
#[test]
fn nofork_comsub_reuse_keeps_each_line() {
	let (out, err, _) = run(
		"for i in 1 2; do\necho ${ echo $LINENO; }\ndone\necho ${ echo $LINENO; }\necho ${ echo \
		 $LINENO; }",
	);
	assert_eq!(err, "");
	assert_eq!(out, "2\n2\n4\n5\n");
}

/// `$( )` turns `-e` off (and out of `SHELLOPTS`) only when it was on.
#[test]
fn comsub_resets_errexit_only_when_set() {
	let (out, err, _) = run(
		"o() { [[ :$SHELLOPTS: == *:errexit:* ]] && echo on || echo off; }; echo $(o); set -e; o; \
		 echo $(o); x=$(false; echo after); echo $x; set +e; echo $(o); shopt -s inherit_errexit; \
		 set -e; echo $(o)",
	);
	assert_eq!(err, "");
	assert_eq!(out, "off\non\noff\nafter\noff\non\n");
}

#[test]
fn xtrace_shows_for_case_select_headers_and_negated_primaries() {
	let (_, err, _) = run(
		"set -x; a=1; for i in $a \"b c\"; do :; done; case $a in 1) ;; esac; set -- q; for i; do \
		 :; done; [[ ! x ]]; [[ ! ! x ]]",
	);
	assert_eq!(
		err,
		"+ a=1\n+ for i in $a \"b c\"\n+ :\n+ for i in $a \"b c\"\n+ :\n+ case $a in\n+ set -- q\n+ \
		 for i in \"$@\"\n+ :\n+ [[ ! -n x ]]\n+ [[ -n x ]]\n"
	);
}

#[test]
fn posix_shell_exits_on_an_expansion_error() {
	let (out, err, status) = run("set -o posix; echo ${x!y}\necho after");
	assert_eq!(out, "");
	assert_eq!(err, "bash: line 1: ${x!y}: bad substitution\n");
	assert_ne!(status, 0);
}

#[test]
fn unset_runs_a_command_substitution_in_an_index() {
	let (out, err, _) = run("b=(0 1 2); unset 'b[$(echo 1)]'; declare -p b");
	assert_eq!(err, "");
	assert_eq!(out, "declare -a b=([0]=\"0\" [2]=\"2\")\n");
}

/// `command -v`/`-V` describe every name and succeed when any one is
/// found (bash's `any_found`); `-v` skips misses silently.
#[test]
fn command_v_succeeds_when_any_name_is_found() {
	let (out, err, _) = run(
		"command -v true false pwd nope-xyz; echo st=$?; command -v nope1 nope2; echo st=$?; \
		 command -V true nope; echo st=$?; command -v; echo st=$?",
	);
	assert_eq!(out, "true\nfalse\npwd\nst=0\nst=1\ntrue is a shell builtin\nst=0\nst=0\n");
	assert_eq!(err, "bash: line 1: command: nope: not found\n");
}

/// A command `PATH` lacks runs the host's stand-in (`Host::fallback`, as
/// `omp zsh` offers pi's utilities where Windows has no `ls`); `exec` of
/// it is still not found (a process image cannot be a native), `type`
/// still answers from `PATH`, and a defined not-found handler (Ubuntu's
/// `command-not-found`) handles the name instead.
#[test]
fn path_misses_run_the_hosts_fallback() {
	let mut host = FakeHost::new().natives_as_fallback();
	host.countdown("mytool", 1, 7);
	let out = run_script(
		host,
		b"mytool; echo $?; type mytool || echo untyped; exec mytool",
		&[],
		Fault::None,
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "7\nuntyped\n");
	assert_eq!(out.status, 127);
	let mut host = FakeHost::new().natives_as_fallback();
	host.countdown("mytool", 1, 7);
	let out = run_script(
		host,
		b"command_not_found_handle() { echo \"install $1\"; return 3; }; mytool; echo $?",
		&[],
		Fault::None,
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "install mytool\n3\n");
}

/// bash's complaint about a `break` outside a loop.
const ONLY_IN_A_LOOP: &str =
	"bash: line 1: break: only meaningful in a `for', `while', or `until' loop\n";

/// Every `(script, stdout, stderr, status)` row run plainly and with the
/// shell externalized and restored after every op and after every third;
/// the mismatches together.
fn check_rows(rows: &[(&str, &str, &str, i32)]) {
	let mut bad = Vec::new();
	for &(src, out, err, status) in rows {
		for (every, fault) in
			[(0, Fault::None), (1, Fault::Snapshot { every: 1 }), (3, Fault::Snapshot { every: 3 })]
		{
			let got = run_script(FakeHost::new(), src.as_bytes(), &[], fault);
			let got = (
				String::from_utf8_lossy(&got.stdout).into_owned(),
				String::from_utf8_lossy(&got.stderr).into_owned(),
				got.status,
			);
			if got != (out.to_owned(), err.to_owned(), status) {
				bad.push(format!(
					"{src:?} (restored every {every} ops)\n  want {:?}\n  got  {got:?}",
					(out, err, status)
				));
			}
		}
	}
	assert!(bad.is_empty(), "{} of {} runs differ:\n{}", bad.len(), rows.len() * 3, bad.join("\n"));
}

/// bash 5.3's `break` (or `continue`) inside `${| }` or `${ }` only sets
/// `breaking`: the substitution's body ends there, later substitutions of
/// the command give nothing, the command itself runs, and the next loop out
/// takes the levels left (in the caller after a `return`); a function, an
/// `eval` or a trap the waiting command reaches runs none of its commands.
/// With no loop: the complaint, and the command runs. The runs restored
/// between the `break` and its loop check the waiting break is in the image.
#[test]
fn a_break_in_a_value_substitution_waits_for_its_command() {
	let only = ONLY_IN_A_LOOP;
	let twice = format!("{only}{only}");
	check_rows(&[
		("for i in 1 2; do echo a ${| break; } b; echo in; done; echo out", "a b\nout\n", "", 0),
		(
			"for i in 1; do echo \"[${| break; }][$(echo x)][${ echo y; }][${| REPLY=z; }]\"; echo \
			 in; done; echo out",
			"[][][][]\nout\n",
			"",
			0,
		),
		("echo a ${| break; } b; echo \"after $?\"", "a b\nafter 0\n", only, 0),
		(
			"for i in 1 2; do if echo c ${| break; }; then echo yes; fi; echo in; done; echo out",
			"c\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do echo ${| ${| break; }; echo inner; REPLY=v; }; echo in; done; echo out",
			"\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do x=${| break; } y=$(echo q); echo \"in $y\"; done; echo \"out [$x] \
			 [$y]\"",
			"out [] []\n",
			"",
			0,
		),
		(
			"n=0; while echo w ${| break; }; do echo body; n=$((n+1)); [ $n -gt 2 ] && break; done; \
			 echo out",
			"w\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do case ${| break; } in *) echo arm;; esac; echo in; done; echo out",
			"out\n",
			"",
			0,
		),
		(
			"for i in 1 2; do for j in a ${| break; } b; do echo \"j=$j\"; done; echo in; done; echo \
			 out",
			"in\nin\nout\n",
			"",
			0,
		),
		("for i in 1 2; do echo ${| continue; } c; echo in; done; echo out", "c\nc\nout\n", "", 0),
		(
			"for i in 1 2; do eval \"echo \\${| break; } e; echo after\"; echo in; done; echo out",
			"e\nout\n",
			"",
			0,
		),
		("for i in 1 2; do echo a ${ break; } b; echo in; done; echo out", "a b\nout\n", "", 0),
		("for i in 1 2; do false ${| break; }; done; echo \"out $?\"", "out 1\n", "", 0),
		(
			"for i in 1 2; do echo x > ${| break; }; done; echo \"out $?\"",
			"out 1\n",
			"bash: line 1: ${|break; }: ambiguous redirect\n",
			0,
		),
		(
			"for i in 1 2; do printf \"%s\\n\" p ${| break; } q; echo in; done; echo out",
			"p\nq\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do echo a ${| break 0; } b; echo in; done; echo \"out $?\"",
			"a b\nout 0\n",
			"bash: line 1: break: 0: loop count out of range\n",
			0,
		),
		("f() { echo a ${| break; } b; echo after; }; f; echo out", "a b\nafter\nout\n", only, 0),
		(
			"for i in 1 2; do echo a ${| break; } && echo and; echo in; done; echo out",
			"a\nout\n",
			"",
			0,
		),
		(
			"f() { echo a ${| break; } b; echo after; }; for i in 1 2; do f; echo in; done; echo out",
			"a b\nafter\nin\na b\nafter\nin\nout\n",
			&twice,
			0,
		),
		(
			"f() { echo \"f $*\"; }; for i in 1 2; do f a ${| break; } b; echo \"in $?\"; done; echo \
			 \"out $?\"",
			"out 0\n",
			"",
			0,
		),
		(
			"g() { for i in 1; do return ${| break; }; done; }; for j in 1 2; do for k in a b; do g; \
			 echo \"k $k\"; done; echo \"j $j\"; done; echo out",
			"j 1\nj 2\nout\n",
			"",
			0,
		),
		(
			"for i in 1 2; do eval \"for j in 1; do break 2; done; echo e\"; echo in; done; echo out",
			"out\n",
			"",
			0,
		),
		(
			"for i in 1 2; do eval \"for j in 1; do continue 2; done; echo e\"; echo in; done; echo \
			 out",
			"out\n",
			"",
			0,
		),
		(
			"for i in 1 2; do echo ${| for j in 1; do break 2; done; REPLY=v; }; echo in; done; echo \
			 out",
			"\nout\n",
			"",
			0,
		),
		(
			"set -e; trap \"echo ERR\" ERR; for i in 1 2; do false ${| break; }; echo in; done; echo \
			 out",
			"",
			"",
			1,
		),
		(
			"trap \"echo RET\" RETURN; set -T; f() { :; }; for i in 1 2; do f ${| break; }; echo in; \
			 done; echo out",
			"out\n",
			"",
			0,
		),
		("for i in 1 2; do eval \"echo e\" ${| break; }; echo in; done; echo out", "out\n", "", 0),
		("trap \"echo EXIT\" EXIT; for i in 1; do exit ${| break; }; done", "", "", 0),
	]);
}

/// An error in an arithmetic `for`'s header ends that loop with status 1,
/// and the commands after it run (bash's `execute_arith_for_command`); its
/// message goes where the loop's own redirections send it. It runs no ERR
/// trap and does not end a `set -e` shell. A `break` or `continue` waiting
/// in the test's substitution takes the loop at a failed test; one in the
/// first or step expression goes on to the loop around it. bash 5.2.21
/// agrees on the rows with no `${| }`, but for its wording of the syntax
/// error. The runs restored between the error and the loop's end check the
/// loop record's state in the image.
#[test]
fn an_arith_for_header_error_ends_only_its_loop() {
	let syntax = |word: &str, token: &str| {
		format!(
			"bash: line 1: ((: {word}: arithmetic syntax error: operand expected (error token is \
			 \"{token}\")\n"
		)
	};
	let by0 = |word: &str, token: &str| {
		format!("bash: line 1: ((: {word}: division by 0 (error token is \"{token}\")\n")
	};
	let twice = |s: String| format!("{s}{s}");
	check_rows(&[
		("for (( j=; j<2; j++ )); do echo j$j; done; echo st=$?", "st=1\n", &syntax("j=", "="), 0),
		("for (( j=; j<2; j++ )); do echo j$j; done 2>/dev/null; echo st=$?", "st=1\n", "", 0),
		(
			"x=; for (( j=$x; j<2; j++ )); do echo j$j; done; echo st=$?",
			"st=1\n",
			&syntax("j=", "="),
			0,
		),
		(
			"for i in 1 2; do for (( j=1/0; j<2; j++ )); do echo j$j; done; echo \"b$i:$?\"; done; \
			 echo end:$?",
			"b1:1\nb2:1\nend:0\n",
			&twice(by0("j=1/0", "0")),
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<1/0; j++ )); do echo j$j; done; echo \"b$i:$?\"; done; \
			 echo end:$?",
			"b1:1\nb2:1\nend:0\n",
			&twice(by0("j<1/0", "0")),
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<2; j+=1/0 )); do echo j$j; done; echo \"b$i:$?\"; done; \
			 echo end:$?",
			"j0\nb1:1\nj0\nb2:1\nend:0\n",
			&twice(by0("j+=1/0 ", "0 ")),
			0,
		),
		(
			"for (( j=; j<2; j++ )); do echo j$j; done && echo ok || echo no; echo next",
			"no\nnext\n",
			&syntax("j=", "="),
			0,
		),
		(
			"for (( j=0; j<2; j++ )); do for (( k=; k<1; k++ )); do echo k; done; echo \"j$j:$?\"; \
			 done; echo end:$?",
			"j0:1\nj1:1\nend:0\n",
			&twice(syntax("k=", "=")),
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<${| break; }; j++ )); do echo j$j; done; echo \
			 \"b$i:$?\"; done; echo end:$?",
			"b1:1\nb2:1\nend:0\n",
			&twice(syntax("j<", "<")),
			0,
		),
		(
			"for i in 1 2; do for (( j=0; j<2; j+=${| break; } )); do echo j$j; done; echo \
			 \"b$i:$?\"; done; echo end:$?",
			"j0\nend:1\n",
			&syntax("j+= ", "+= "),
			0,
		),
		(
			"for i in 1 2; do for (( j=${| break; }; j<2; j++ )); do echo j$j; done; echo \
			 \"b$i:$?\"; done; echo end:$?",
			"end:1\n",
			&syntax("j=", "="),
			0,
		),
		(
			"trap \"echo E\" ERR; for (( j=; j<2; j++ )); do :; done; echo st=$?",
			"st=1\n",
			&syntax("j=", "="),
			0,
		),
		(
			"trap \"echo E\" ERR; for (( j=0; j<1/0; j++ )); do :; done; echo st=$?",
			"st=1\n",
			&by0("j<1/0", "0"),
			0,
		),
		("set -e; for (( j=; j<2; j++ )); do :; done; echo after", "after\n", &syntax("j=", "="), 0),
		(
			"set -e; for (( j=0; j<2; j+=1/0 )); do :; done; echo after",
			"after\n",
			&by0("j+=1/0 ", "0 "),
			0,
		),
		(
			"f() { for (( j=; ; )); do :; done; echo \"in f $?\"; }; f; echo \"out $?\"",
			"in f 1\nout 0\n",
			&syntax("j=", "="),
			0,
		),
	]);
}

/// `ambiguous redirect` names the word as bash stores it: each command
/// substitution re-printed by the parser (also in a function body and in
/// an operator's word), `$'…'` decoded in single quotes, `$"…"` as `"…"`;
/// backquotes and the rest as written.
#[test]
fn an_ambiguous_redirect_names_the_word_as_bash_stores_it() {
	let at = |word: &str| format!("bash: line 1: {word}: ambiguous redirect\n");
	let rows = [
		(": > ${|   return   3 ;   }", "", at("${|return 3; }"), 1),
		("x=\"1 2\"; : > $'a\\tb'$x", "", at("'a\tb'$x"), 1),
		("x=\"1 2\"; : > $\"a\"$x", "", at("\"a\"$x"), 1),
		("x=\"1 2\"; : > \"a\"\\b$x", "", at("\"a\"\\b$x"), 1),
		(": > $(  true;false  )", "", at("$(true; false)"), 1),
		("x=\"1 2\"; : > ${x:-$(  echo  a  )}", "", at("${x:-$(echo a)}"), 1),
		("x=\"1 2\"; : > \"$(  echo  a  )\"$x", "", at("\"$(echo a)\"$x"), 1),
		(": > ${  true;false ; }", "", at("${ true; false; }"), 1),
		("x=\"1 2\"; : > $x${| REPLY=f;}", "", at("$x${|REPLY=f; }"), 1),
		(": > ${| echo  a   b; }", "a b\n", at("${|echo a b; }"), 1),
		(": > ${| true\n false; }", "", at("${|true\nfalse; }"), 1),
		("f() { : > $(  true;false  ); }; f; echo \"st=$?\"", "st=1\n", at("$(true; false)"), 0),
		("x=\"1 2\"; : > `echo   1    2`", "", at("`echo   1    2`"), 1),
	];
	let rows: Vec<(&str, &str, &str, i32)> = rows
		.iter()
		.map(|(src, out, err, status)| (*src, *out, err.as_str(), *status))
		.collect();
	check_rows(&rows);
}
