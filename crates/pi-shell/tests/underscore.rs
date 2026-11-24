//! bash's `$_`: after each simple command, its last word (the name when it
//! has no argument, empty after an assignment-only command), bound in the
//! shell itself as `_=word` would be (through `_`'s attributes, then not
//! exported); `exit` and `return` bind nothing; `( )` and command
//! substitutions bind their own copy, and the whole of a forked pipeline
//! stage or background job binds none. An external is given `_=` its own
//! path, and a script with no `#!` line its name; with no `_` in its
//! environment the shell starts with its argv[0]. Each row runs `obash -c`
//! with `_=/sentinel` (what the shell imported) and `PATH=/usr/bin:/bin`,
//! and checks stdout against what bash 5.2.21 and 5.3.20 print for the same
//! script there (they agree on every row).

mod obash_support;

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

use crate::obash_support::{obash, output};

/// `(script, stdout)`.
type Row = (&'static str, &'static str);

/// Run `script` as bash (its messages say `bash:`) with `_` and `PATH`
/// pinned, in `dir` when given: stdout and status.
fn run_in(script: &str, dir: Option<&std::path::Path>) -> (String, i32) {
	let mut cmd = obash();
	#[cfg(unix)]
	cmd.arg0("bash");
	cmd.env("_", "/sentinel")
		.env("PATH", "/usr/bin:/bin")
		.args(["-c", script]);
	if let Some(dir) = dir {
		cmd.current_dir(dir);
	}
	let out = output(&mut cmd);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status.code().unwrap_or(-1))
}

fn run(script: &str) -> (String, i32) {
	run_in(script, None)
}

/// Run `script` as [`run_in`] does: stdout and stderr.
fn out_err(script: &str, dir: Option<&std::path::Path>) -> (String, String) {
	let mut cmd = obash();
	#[cfg(unix)]
	cmd.arg0("bash");
	cmd.env("_", "/sentinel")
		.env("PATH", "/usr/bin:/bin")
		.args(["-c", script]);
	if let Some(dir) = dir {
		cmd.current_dir(dir);
	}
	let out = output(&mut cmd);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

/// bash's message on line 1 for an arithmetic error `msg` in `word` bound
/// to an integer `_` after the command named `name` (empty: none).
fn arith(name: &str, word: &str, msg: &str, token: &str) -> String {
	let name = if name.is_empty() {
		String::new()
	} else {
		format!("{name}: ")
	};
	format!("bash: line 1: {name}{word}: {msg} (error token is \"{token}\")\n")
}

/// [`arith`] for a division by 0 in `word` (`A/B`).
fn div0(name: &str, word: &str) -> String {
	arith(name, word, "division by 0", word.rsplit('/').next().unwrap_or_default())
}

/// [`arith`] for `word`, which is no expression.
fn bad_expr(word: &str, token: &str) -> String {
	arith("", word, "arithmetic syntax error in expression", token)
}

/// Run each `(script, stdout, stderr)` row in `dir` and assert that every
/// one prints what bash 5.3.20 prints.
fn check_rows(rows: &[(&str, &str, String)], dir: Option<&std::path::Path>) {
	let mut bad = Vec::new();
	for (script, out, err) in rows {
		let got = out_err(script, dir);
		if got != ((*out).to_owned(), err.clone()) {
			bad.push(format!("{script:?}\n  bash {:?}\n  got  {got:?}", (out, err)));
		}
	}
	assert!(bad.is_empty(), "{} of {} rows differ:\n{}", bad.len(), rows.len(), bad.join("\n"));
}

/// With no `_` in its environment the shell starts with `$_` its argv[0],
/// as bash does (`set_if_not ("_", dollar_vars[0])`), in `-c` and in a
/// script.
#[cfg(unix)]
#[test]
fn the_first_underscore_is_argv0_when_the_environment_has_none() {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("s.sh"), "echo \"[$_]\"\n").unwrap();
	for args in [&["-c", "echo \"[$_]\""][..], &["s.sh"][..]] {
		let mut cmd = obash();
		cmd.arg0("bash")
			.env_remove("_")
			.env("PATH", "/usr/bin:/bin")
			.args(args)
			.current_dir(dir.path());
		let out = output(&mut cmd);
		assert_eq!(String::from_utf8_lossy(&out.stdout), "[bash]\n", "{args:?}");
	}
}

/// A script with no `#!` line runs in a new shell whose `_` is the name it
/// was run by, as a program's is its path; the program it runs gets its own.
#[cfg(unix)]
#[test]
fn a_script_without_a_shebang_starts_with_its_name() {
	use std::os::unix::fs::PermissionsExt as _;
	let dir = tempfile::tempdir().unwrap();
	let script = dir.path().join("ns.sh");
	std::fs::write(&script, "echo \"in=[$_]\"\nprintenv _\n").unwrap();
	std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
	let (out, status) = run_in("./ns.sh", Some(dir.path()));
	assert_eq!((out.as_str(), status), ("in=[./ns.sh]\n/usr/bin/printenv\n", 0));
}

/// An arithmetic error in the bind of an integer `_` names the command
/// whose last word it binds, as bash's `this_command_name` does then: a
/// program by the name it was run by; `command` and `builtin` by the
/// command they run; no name once a simple command that the command ran (a
/// function body, `eval`, `.`) has finished; the outer command after one
/// that only returned (a `.` file's RETURN trap, which runs after that,
/// names last); `((` or `[[` after those; none once a `select` started.
/// `select`, `((` and `[[` name once, when they start, so a `${ cmd; }` in
/// their words names last. A readonly `_`'s error is bare. Stdout and
/// stderr only: bash 5.3.20 also abandons the rest of the line after such
/// an error (status 1 in `-c`), which this shell does not do for any
/// assignment error yet. Each script ends with the failing command, so that
/// does not show here. The `.` and `< in` rows read files of a temporary
/// directory.
#[test]
fn an_integer_underscore_bind_error_names_its_command() {
	let literal: &[(&str, &str, &str)] = &[
		(
			"declare -i _",
			"",
			"bash: line 1: declare: /sentinel: arithmetic syntax error: operand expected (error \
			 token is \"/sentinel\")\n",
		),
		(
			"declare -i _=5; echo a/b >/dev/null",
			"",
			"bash: line 1: echo: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; /bin/echo a/b >/dev/null",
			"",
			"bash: line 1: /bin/echo: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; printf '%s\\n' a/b >/dev/null",
			"",
			"bash: line 1: printf: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; true a/b",
			"",
			"bash: line 1: true: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; command echo a/b >/dev/null",
			"",
			"bash: line 1: echo: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; builtin echo a/b >/dev/null",
			"",
			"bash: line 1: echo: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; nosuch a/b 2>/dev/null",
			"",
			"bash: line 1: nosuch: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; x=1 echo a/b >/dev/null",
			"",
			"bash: line 1: echo: a/b: division by 0 (error token is \"b\")\n",
		),
		(
			"declare -i _=5; : 1+2; echo \"[$_]\"",
			"[3]\n",
			"bash: line 1: echo: [3]: arithmetic syntax error: operand expected (error token is \
			 \"[3]\")\n",
		),
		(
			"declare -i _=5; x=a/b; echo \"[$_]\"",
			"[0]\n",
			"bash: line 1: echo: [0]: arithmetic syntax error: operand expected (error token is \
			 \"[0]\")\n",
		),
		(
			"declare -r _=ro 2>/dev/null; echo a >/dev/null",
			"",
			"bash: line 1: _: readonly variable\nbash: line 1: _: readonly variable\n",
		),
	];
	let mut rows: Vec<(&str, &str, String)> = literal
		.iter()
		.map(|&(script, out, err)| (script, out, err.to_owned()))
		.collect();
	rows.extend([
		// A simple command that the command ran has finished: no name.
		("declare -i _=5; eval 'echo 1' >/dev/null", "", bad_expr("echo 1", "1")),
		("declare -i _=5; command eval 'echo 1' >/dev/null", "", bad_expr("echo 1", "1")),
		("declare -i _=5; _=2 eval \"echo 3+4\"", "3+4\n", bad_expr("echo 3+4", "3+4")),
		("declare -i _=5; f() { true; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { echo in >/dev/null; }; f x/y", "", div0("", "x/y")),
		("declare -i _=5; . ./s a/b", "", div0("", "a/b")),
		("declare -i _=5; . ./r a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { true; return 0; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; g() { true; }; f() { g; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { x=1; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { for i in 1; do true; done; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { [[ a && b ]]; true; }; f a/b", "", div0("", "a/b")),
		// Nothing finished in it, or a return put the name back.
		("declare -i _=5; f() { return 0; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; f() { eval 'true; return 0'; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; f() { eval 'return 0'; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; set -T; trap true RETURN; f() { return 0; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; . /dev/null a/b", "", div0(".", "a/b")),
		("declare -i _=5; . ./q a/b", "", div0(".", "a/b")),
		("declare -i _=5; f() { for i in; do true; done; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; f() { true | true; }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; f() { ( true ); }; f a/b", "", div0("f", "a/b")),
		("declare -i _=5; trap true DEBUG; echo a/b >/dev/null", "", div0("echo", "a/b")),
		("declare -i _=5; echo ${ true; } a/b >/dev/null", "", div0("echo", "a/b")),
		// `((` and `[[` name themselves.
		("declare -i _=5; f() { (( 1 )); }; f a/b", "", div0("((", "a/b")),
		("declare -i _=5; f() { [[ -n x ]]; }; f a/b", "", div0("[[", "a/b")),
		(
			"declare -i _=5; f() { for ((i = 0; i < 1; i++)); do true; done; }; f a/b",
			"",
			div0("((", "a/b"),
		),
		// A `.` file's `return` puts the name back before its RETURN trap,
		// whose commands then name last; a function's after it (above).
		("declare -i _=5; trap true RETURN; . ./q a/b", "", div0("", "a/b")),
		("declare -i _=5; trap '(( 1 ))' RETURN; . ./q a/b", "", div0("((", "a/b")),
		("declare -i _=5; trap true RETURN; . ./q2 a/b", "", div0("", "a/b")),
		("declare -i _=5; trap true RETURN; . ./v a/b", "", div0("", "a/b")),
		("declare -i _=5; trap true RETURN; . ./s a/b", "", div0("", "a/b")),
		("declare -i _=5; trap '(( 1 ))' RETURN; . /dev/null a/b", "", div0("((", "a/b")),
		// `select` clears the name when it starts, once: not at each
		// selection (a `for` does, above). Stdin is /dev/null or `in`.
		("declare -i _=5; f() { select x in; do :; done; }; f a/b", "", div0("", "a/b")),
		(
			"declare -i _=5; f() { select x in a; do :; done; }; f a/b",
			"\n",
			format!("1) a\n#? {}", div0("", "a/b")),
		),
		(
			"declare -i _=5; f() { select x in a b; do (( 1 )); done 2>/dev/null; }; f a/b",
			"\n",
			div0("", "a/b"),
		),
		("declare -i _=5; f() { (( 1 )); select x in; do :; done; }; f a/b", "", div0("", "a/b")),
		(
			"declare -i _=5; f() { select x in a; do case $x in a) (( 1 )) ;; esac; done \
			 2>/dev/null; }; f a/b < in",
			"\n",
			div0("((", "a/b"),
		),
		(
			"declare -i _=5; f() { select x in a; do ( true ); break; done 2>/dev/null; }; f a/b < in",
			"",
			div0("", "a/b"),
		),
		// `eval`'s bind after a `break` in it names no command.
		("declare -i _=5; for i in 1; do eval 'break;' a/b; done", "", div0("", "a/b")),
		// `select`, `((` and `[[` name the command once, when they start: a
		// `${ cmd; }` in their words runs after that and names last.
		(
			"declare -i _=5; f() { select x in ${ echo a; (( 1 )); }; do :; done 2>/dev/null; }; f \
			 a/b",
			"\n",
			div0("((", "a/b"),
		),
		(
			"declare -i _=5; f() { select x in ${ echo a; (( 1 )); } $(echo b); do :; done \
			 2>/dev/null; }; f a/b",
			"\n",
			div0("((", "a/b"),
		),
		(
			"declare -i _=5; f() { select x in ${ echo a; [[ x ]]; }; do :; done 2>/dev/null; }; f \
			 a/b",
			"\n",
			div0("[[", "a/b"),
		),
		(
			"declare -i _=5; f() { select x in a ${ echo b; (( 1 )); }; do :; done 2>/dev/null; }; f \
			 a/b",
			"\n",
			div0("((", "a/b"),
		),
		(
			"declare -i _=5; f() { select x in ${ echo a; true; }; do :; done 2>/dev/null; }; f a/b",
			"\n",
			div0("", "a/b"),
		),
		("declare -i _=5; f() { (( ${ true; echo 1; } )); }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { (( ${ (( 1 )); echo 1; } )); }; f a/b", "", div0("", "a/b")),
		(
			"declare -i _=5; f() { while (( ${ true; echo 0; } )); do :; done; }; f a/b",
			"",
			div0("", "a/b"),
		),
		("declare -i _=5; f() { [[ -n ${ true; echo x; } ]]; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { [[ -n ${ true; echo x; } && -n y ]]; }; f a/b", "", div0("", "a/b")),
		("declare -i _=5; f() { (( $(echo 1) )); }; f a/b", "", div0("((", "a/b")),
		("declare -i _=5; f() { [[ -n $(echo x) ]]; }; f a/b", "", div0("[[", "a/b")),
		(
			"declare -i _=5; f() { for (( i = ${ true; echo 0; }; i < 1; i++ )); do true; done; }; f \
			 a/b",
			"",
			div0("((", "a/b"),
		),
	]);
	let dir = tempfile::tempdir().unwrap();
	for (name, text) in [
		("s", "true\n"),
		("r", "true\nreturn 0\n"),
		("q", "return 0\n"),
		("q2", "(( 1 )); return\n"),
		("v", "eval 'return 0'\n"),
		("in", "1\n2\n"),
	] {
		std::fs::write(dir.path().join(name), text).unwrap();
	}
	check_rows(&rows, Some(dir.path()));
}

/// bash binds no `_` after a simple command that is the whole of a forked
/// pipeline stage (`lastpipe`'s last runs in the shell and does) or of a
/// background job, so an integer or readonly `_` gives no message there; a
/// function's own commands still bind in the child. `( )`, a group, a
/// command substitution and a coprocess run the command unforked in the
/// child, which binds.
#[test]
fn a_forked_stage_or_job_binds_no_underscore() {
	let ro = |n| "bash: line 1: _: readonly variable\n".repeat(n);
	let none = String::new;
	let echo = || div0("echo", "a/b");
	let rows = [
		("declare -i _=5; echo a/b | cat >/dev/null; echo end", "end\n", none()),
		("declare -i _=5; /bin/echo a/b | cat >/dev/null; echo end", "end\n", none()),
		("declare -i _=5; cat /dev/null | echo a/b >/dev/null; echo end", "end\n", none()),
		("declare -i _=5; true | echo a/b | cat >/dev/null; echo end", "end\n", none()),
		("declare -i _=5; ! echo a/b | cat >/dev/null; echo end", "end\n", none()),
		("declare -i _=5; echo a/b 2>&1 | cat; echo end", "a/b\nend\n", none()),
		("declare -i _=5; echo a/b |& cat; echo end", "a/b\nend\n", none()),
		("declare -i _=5; echo a/b & wait; echo end", "a/b\nend\n", none()),
		("declare -i _=5; echo a/b >/dev/null & wait; echo end", "end\n", none()),
		(
			"declare -i _=5; f() { echo c/d >/dev/null; }; f a/b | cat; echo end",
			"end\n",
			div0("echo", "c/d"),
		),
		(
			"declare -i _=5; f() { echo c/d >/dev/null; }; f a/b & wait; echo end",
			"end\n",
			div0("echo", "c/d"),
		),
		("declare -r _=ro 2>/dev/null; echo a | cat >/dev/null; echo end", "end\n", ro(2)),
		("declare -r _=ro 2>/dev/null; x=1 | cat; echo end", "end\n", ro(2)),
		("declare -r _=ro 2>/dev/null; >/dev/null | cat; echo end", "end\n", ro(2)),
		("declare -r _=ro 2>/dev/null; true x & wait; echo end", "end\n", ro(3)),
		("shopt -s lastpipe; declare -i _=5; cat /dev/null | echo a/b >/dev/null", "", echo()),
		("declare -i _=5; (echo a/b >/dev/null); echo end", "end\n", echo()),
		("declare -i _=5; { echo a/b >/dev/null; } | cat; echo end", "end\n", echo()),
		("declare -i _=5; { echo a/b >/dev/null; } & wait; echo end", "end\n", echo()),
		("declare -i _=5; (echo a/b >/dev/null) & wait; echo end", "end\n", echo()),
		("declare -i _=5; x=$(echo a/b); echo end", "end\n", echo()),
		("declare -i _=5; coproc echo a/b >/dev/null; wait; echo end", "end\n", echo()),
	];
	check_rows(&rows, None);
}

#[test]
fn bash_binds_the_last_word_after_each_command() {
	let rows: &[Row] = &[
		("echo a b; echo \"_=$_\"", "a b\n_=b\n"),
		(":; echo \"_=$_\"", "_=:\n"),
		("echo a b; :; echo \"_=$_\"", "a b\n_=:\n"),
		("x=1; echo \"_=$_\"", "_=\n"),
		("echo a b; x=1; echo \"_=$_\"", "a b\n_=\n"),
		// After the function returns, not before it runs.
		("f() { :; }; f x y; echo \"_=$_\"", "_=y\n"),
		("f() { echo \"in=$_\"; }; f x y", "in=/sentinel\n"),
		("echo a b; f() { echo \"in=$_\"; }; f", "a b\nin=b\n"),
		// A pipeline, a subshell and `[[ ]]`/`(( ))` leave it alone.
		("echo a | cat; echo \"_=$_\"", "a\n_=/sentinel\n"),
		("(echo a b); echo \"_=$_\"", "a b\n_=/sentinel\n"),
		("echo \"_=$_\"", "_=/sentinel\n"),
		("[[ -n x ]]; echo \"_=$_\"", "_=/sentinel\n"),
		("(( 1 )); echo \"_=$_\"", "_=/sentinel\n"),
		("/bin/echo a b > /dev/null; echo \"_=$_\"", "_=b\n"),
		("cd /tmp; echo \"_=$_\"", "_=/tmp\n"),
		("for i in 1 2; do :; done; echo \"_=$_\"", "_=:\n"),
		("declare x=5; echo \"_=$_\"", "_=x=5\n"),
		("set -- p q; echo \"_=$_\"", "_=q\n"),
		("echo a b; echo \"$_\" \"$_\"", "a b\nb b\n"),
		("echo a \"b c\"; echo \"_=$_\"", "a b c\n_=b c\n"),
		("echo; echo \"_=[$_]\"", "\n_=[echo]\n"),
		("echo a b & wait; echo \"_=$_\"", "a b\n_=wait\n"),
		("x=$(echo a b; echo \"in=$_\"); echo \"$x\"; echo \"_=$_\"", "a b\nin=b\n_=a b\nin=b\n"),
		("if true; then echo a b; fi; echo \"_=$_\"", "a b\n_=b\n"),
		("echo a b; _=z; echo \"_=$_\"", "a b\n_=\n"),
		("echo a b; unset _; echo \"_=[${_-unset}]\"", "a b\n_=[_]\n"),
		("echo a b; eval \"echo e f\"; echo \"_=$_\"", "a b\ne f\n_=echo e f\n"),
		("echo a b; readonly r=1; echo \"_=$_\"", "a b\n_=r=1\n"),
		// A command that is not found binds too; so do a trap's commands.
		("nosuchcmd y z 2>/dev/null; echo \"_=$_\"", "_=z\n"),
		("trap ': t1 t2' DEBUG; echo a b; echo \"_=$_\"", "a b\n_=t2\n"),
		("trap ': e1 e2' ERR; false; echo \"_=$_\"", "_=e2\n"),
		// `local _` is bound in the function and goes with it.
		("f() { local _; echo a b; echo \"in=$_\"; }; f x; echo \"_=$_\"", "a b\nin=b\n_=x\n"),
		// An external gets `_` as its own path, even when `_` is exported,
		// and only that one `_`.
		("/usr/bin/env | grep '^_='", "_=/usr/bin/env\n"),
		("export _; echo a; /usr/bin/env | grep '^_='", "a\n_=/usr/bin/env\n"),
		("export _=x; /usr/bin/env | grep -c '^_='", "1\n"),
		// This shell's `exec` passes no path: only an exported `_`, which is
		// the imported one until a command binds `_` (unexported). bash
		// passes the environment it built last, with the last external's
		// path: the rows pin no such external.
		("exec /usr/bin/env | grep '^_='", "_=/sentinel\n"),
		("echo hi; exec /usr/bin/env | grep '^_='", "hi\n"),
		("echo a b; (exec /usr/bin/env) | grep '^_='", "a b\n"),
		// `exit` and `return` leave before the bind: the EXIT or RETURN trap
		// sees the command before them.
		("trap 'echo \"[$_]\"' EXIT; echo a b; exit 3", "a b\n[b]\n"),
		("set -T; trap 'echo \"ret[$_]\"' RETURN; f() { echo a b; return 3; }; f x", "a b\nret[b]\n"),
		// `_`'s attributes apply; the export goes; a readonly `_` stays.
		("declare -u _; echo a b; echo \"[$_]\"", "a b\n[B]\n"),
		("declare -l _; echo A B; echo \"[$_]\"", "A B\n[b]\n"),
		("declare -i _=0; echo 1+2; echo \"[$_]\" 2>/dev/null", "1+2\n[3]\n"),
		("foo=; declare -n _=foo; echo a b; echo \"[$_] [$foo]\"", "a b\n[b] [b]\n"),
		("declare -a _=(p q); echo a b; declare -p _", "a b\ndeclare -a _=([0]=\"b\" [1]=\"q\")\n"),
		("declare -x _; echo a b; declare -p _", "a b\ndeclare -- _=\"b\"\n"),
		("declare -r _=ro 2>/dev/null; echo a >/dev/null; echo \"_=$_\"", "_=ro\n"),
		(
			"{ declare -r _=ro; echo a >/dev/null; echo \"_=$_\"; } 2>&1",
			"bash: line 1: _: readonly variable\nbash: line 1: _: readonly variable\n_=ro\nbash: \
			 line 1: _: readonly variable\n",
		),
		("exec 3>/dev/null; echo \"[$_]\"", "[exec]\n"),
		("echo a b > /dev/null; ls /nonexist 2>/dev/null; echo \"_=$_\"", "_=/nonexist\n"),
		// The bind comes after the command's temporary `_=VALUE` is gone.
		("_=x echo a b; echo \"[$_]\"", "a b\n[b]\n"),
		("f() { :; }; _=x f a b; echo \"[$_]\"", "[b]\n"),
		("_=x /bin/echo a b >/dev/null; echo \"[$_]\"", "[b]\n"),
		// `eval` returns after a `break` or `continue` in it, and binds.
		("for i in 1; do eval \"break;\" x; done; echo \"[$_]\"", "[x]\n"),
		("for i in 1 2; do eval \"continue;\" x$i; done; echo \"[$_]\"", "[x2]\n"),
		// `lastpipe`'s last stage runs in the shell, and binds there.
		("shopt -s lastpipe; echo a | cat x y 2>/dev/null; echo \"[$_]\"", "[y]\n"),
		("/bin/echo a b > ${f:=/dev/null}; echo \"[$_]\"", "[b]\n"),
	];
	let mut mismatches = Vec::new();
	for &(script, want) in rows {
		let (out, _) = run(script);
		if out != want {
			mismatches.push(format!("{script:?}\n  bash {want:?}\n  got  {out:?}"));
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
