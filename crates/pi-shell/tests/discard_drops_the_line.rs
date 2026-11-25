//! bash drops the rest of the line, through every function, `eval` and
//! `.`, after two errors: a builtin given more arguments than it takes
//! (`no_args`: `suspend`, `shift`, `return`, `exit`, `break`, `continue`)
//! and an arithmetic subscript error (`array_expand_index`: `a[1/0]=v`,
//! `${a[1/0]}`, `read 'a[1/0]'`, `[[ a[1/0] -eq 1 ]]`, `unset 'a[1/0]'`,
//! …), in posix mode too. Each runs `top_level_cleanup`, then
//! `jump_to_top_level (DISCARD)`: a `-c` string ends with status 1, a script
//! goes on with its next line, a subshell exits, and a command or process
//! substitution exits 1. Other expansion errors (`x=$((1/0))`, a readonly
//! variable) drop only the innermost `eval` or `.` string, as before. So
//! does a declaration's compound word that bash cannot declare or assign
//! (`declare -A A=([]=x)`, `declare a[0]=(1)`, a readonly variable): bash
//! drops the command while it still expands the words, a plain
//! `exp_jump_to_top_level (DISCARD)`.
//!
//! Each row runs twice, as `-c` text and from a script file. Every row was
//! measured against bash 5.3.20 and 5.2.21 both ways; the test follows
//! 5.3.20. They differ in these ways. After a `no_args` discard, a script's
//! next line and a subshell's exit see 2 in 5.3.20 and 1 in 5.2.21. In a
//! script, the EXIT trap of a subshell such a discard ends sees `FUNCNAME`
//! empty in 5.3.20 and `main` in 5.2.21. A function past `FUNCNEST` in
//! 5.2.21 neither pops the functions nor leaves its `eval`. bash 5.2.21
//! goes on after an associative array's empty key or a bad element in a
//! compound value, and assigns the elements after the bad one; it drops
//! the command after a readonly variable's `-a` in a function too, names a
//! message made while it expands a declaration's words by no command,
//! keeps an EXIT trap's saved status in a subshell under `-c` too, and
//! crashes where a function's `time` meets a list for an element in a
//! script. bash 5.2.21 names the error of a function in a `-c` string
//! `environment: line 1:`, and bash names an error in a `.` file by the
//! file where pi-shell names the shell; the rows print every error as
//! `SH: …`.

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Runs `script` with stderr on stdout in a private directory (a row may
/// write files there); each error line's `NAME: line N: ` prefix becomes
/// `SH: `. Returns the output and the exit status.
fn run(script: &str, mode: Mode) -> (String, Option<i32>) {
	let dir = tempfile::tempdir().expect("a row directory");
	let script = format!("exec 2>&1; {script}");
	let mut cmd = obash_support::obash();
	cmd.current_dir(dir.path());
	match mode {
		Mode::C => cmd.args(["-c", &script]),
		Mode::Script => {
			std::fs::write(dir.path().join("s.sh"), format!("{script}\n")).expect("the script file");
			cmd.arg("s.sh")
		},
	};
	let out = obash_support::output(&mut cmd);
	let text = String::from_utf8_lossy(&out.stdout)
		.lines()
		.map(|l| match l.find(": line ") {
			Some(i) => l[i + 7..]
				.find(": ")
				.map_or_else(|| format!("{l}\n"), |j| format!("SH: {}\n", &l[i + 7 + j + 2..])),
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

/// The error a subscript `1/0` prints.
const DIV: &str = "SH: 1/0: division by 0 (error token is \"0\")\n";

/// The error a call past `FUNCNEST=2` prints, for `g() { g; }`.
const NEST: &str = "SH: g: maximum function nesting level exceeded (2)\n";

/// The rows of a command `cmd` that drops the line with the error `msg`: at
/// the top level, in a function, in `eval`, in a `.` file and in a
/// subshell, each with a command after it on its line and a next line.
/// `status` is what a script's next line and a subshell of a script see (2
/// after `no_args`, 1 after a subscript error); under `-c` the string ends
/// with 1 and a subshell exits 1.
fn dropped(name: &str, cmd: &str, msg: &str, status: i32) -> Vec<Row> {
	let quoted = cmd.replace('\'', r"'\''");
	let after = "; echo st=$? same\necho next st=$?";
	let line = (msg.to_owned(), 1);
	let next = (format!("{msg}next st={status}\n"), 0);
	vec![
		(name.to_owned(), format!("{cmd}{after}"), line.clone(), next.clone()),
		(
			format!("{name}, function"),
			format!("f() {{ {cmd}; echo in-f; }}; f{after}"),
			line.clone(),
			next.clone(),
		),
		(
			format!("{name}, eval"),
			format!("eval '{quoted}; echo in-eval'{after}"),
			line.clone(),
			next.clone(),
		),
		(
			format!("{name}, ."),
			format!("cat > f.sh <<'EOF'\n{cmd}; echo in-src\necho src2\nEOF\n. ./f.sh{after}"),
			line,
			next,
		),
		(
			format!("{name}, subshell"),
			format!("( {cmd}; echo in-sub ); echo w=$? same\necho next st=$?"),
			(format!("{msg}w=1 same\nnext st=0\n"), 0),
			(format!("{msg}w={status} same\nnext st=0\n"), 0),
		),
	]
}

/// The same five rows for an error that drops only the innermost `eval` or
/// `.` string: `eval` returns 1 and the `.` file goes on with its next line,
/// in both modes; a subshell exits 1.
fn stays(name: &str, cmd: &str, msg: &str) -> Vec<Row> {
	let quoted = cmd.replace('\'', r"'\''");
	let after = "; echo st=$? same\necho next st=$?";
	let both = |out: String| ((out.clone(), 0), (out, 0));
	let next = both(format!("{msg}next st=1\n"));
	let eval = both(format!("{msg}st=1 same\nnext st=0\n"));
	let source = both(format!("{msg}src2\nst=0 same\nnext st=0\n"));
	let sub = both(format!("{msg}w=1 same\nnext st=0\n"));
	vec![
		(name.to_owned(), format!("{cmd}{after}"), next.0.clone(), next.1.clone()),
		(
			format!("{name}, function"),
			format!("f() {{ {cmd}; echo in-f; }}; f{after}"),
			next.0,
			next.1,
		),
		(format!("{name}, eval"), format!("eval '{quoted}; echo in-eval'{after}"), eval.0, eval.1),
		(
			format!("{name}, ."),
			format!("cat > f.sh <<'EOF'\n{cmd}; echo in-src\necho src2\nEOF\n. ./f.sh{after}"),
			source.0,
			source.1,
		),
		(
			format!("{name}, subshell"),
			format!("( {cmd}; echo in-sub ); echo w=$? same\necho next st=$?"),
			sub.0,
			sub.1,
		),
	]
}

/// A builtin given more arguments than it takes reports "too many
/// arguments" and drops the line (bash's `no_args`): `return` and `exit`
/// read no status from it, and `break` and `continue` in a loop leave the
/// loop's line too.
#[test]
fn too_many_arguments_drop_the_line() {
	let mut rows = Vec::new();
	for (name, cmd) in [
		("suspend", "suspend x"),
		("shift", "set -- a b; shift 1 2"),
		("return", "return 1 2"),
		("exit", "exit 1 2"),
		("break", "for i in 1 2; do break 1 2; echo loop; done"),
		("continue", "for i in 1 2; do continue 1 2; echo loop; done"),
		("break in eval", "for i in 1 2; do eval 'break 1 2'; echo loop; done"),
		("continue in eval", "for i in 1 2; do eval 'continue 1 2'; echo loop; done"),
	] {
		let builtin = name.split(' ').next().expect("a name");
		rows.extend(dropped(name, cmd, &format!("SH: {builtin}: too many arguments\n"), 2));
	}
	assert_rows(&rows);
}

/// The drop ends a `-c` string before its EXIT trap runs and past an
/// `||` list and `set -e`; a subshell's `exit 3 4` exits with the drop's
/// status, not its argument.
#[test]
fn too_many_arguments_end_the_command_string() {
	const SUSPEND: &str = "SH: suspend: too many arguments\n";
	const RETURN: &str = "SH: return: too many arguments\n";
	const SHIFT: &str = "SH: shift: too many arguments\n";
	const EXIT: &str = "SH: exit: too many arguments\n";
	let rows: Vec<Row> = vec![
		(
			"EXIT trap".into(),
			"trap 'echo T' EXIT; suspend x; echo after\necho next st=$?".into(),
			(format!("{SUSPEND}T\n"), 1),
			(format!("{SUSPEND}next st=2\nT\n"), 0),
		),
		(
			"or list".into(),
			"f() { return 1 2; }; f || echo or; echo after\necho next st=$?".into(),
			(RETURN.into(), 1),
			(format!("{RETURN}next st=2\n"), 0),
		),
		(
			"set -e".into(),
			"set -e; shift 1 2; echo after\necho next st=$?".into(),
			(SHIFT.into(), 1),
			(format!("{SHIFT}next st=2\n"), 0),
		),
		(
			"exit 3 4".into(),
			"( exit 3 4 ); echo w=$?".into(),
			(format!("{EXIT}w=1\n"), 0),
			(format!("{EXIT}w=2\n"), 0),
		),
	];
	assert_rows(&rows);
}

/// An arithmetic subscript error drops the line wherever it comes from (an
/// assignment, a builtin that assigns or evaluates a name, an expansion, an
/// arithmetic command, `[[ ]]`, a `{var}` redirection), with status 1: no
/// `cannot assign fd to variable` follows it. `local` drops it inside a
/// function.
#[test]
fn an_arithmetic_subscript_error_drops_the_line() {
	let mut rows = Vec::new();
	for (name, cmd) in [
		("assignment", "a[1/0]=v"),
		("read", "read 'a[1/0]' <<< x"),
		("read, several names", "read x 'a[1/0]' y <<< '1 2 3'"),
		("printf -v", "printf -v 'a[1/0]' x"),
		("let", "let 'a[1/0]=1'"),
		("declare", "declare 'a[1/0]=x'"),
		("expansion", "echo ${a[1/0]}"),
		("arithmetic command", "(( a[1/0] ))"),
		("arithmetic expansion", "echo $(( a[1/0] ))"),
		("[[ -eq ]]", "[[ a[1/0] -eq 1 ]]"),
		("[[ -v ]]", "[[ -v a[1/0] ]]"),
		("test -v", "test -v 'a[1/0]'"),
		("fd variable", ": {a[1/0]}>/dev/null"),
		("unset", "a=(1 2); unset 'a[1/0]'"),
	] {
		rows.extend(dropped(name, cmd, DIV, 1));
	}
	rows.push((
		"local".into(),
		"f() { local 'a[1/0]=x'; echo in-f; }; f; echo st=$? same\necho next st=$?".into(),
		(DIV.into(), 1),
		(format!("{DIV}next st=1\n"), 0),
	));
	assert_rows(&rows);
}

/// In posix mode the subscript error drops the line too, where another
/// expansion error or a failed assignment exits a posix shell: an
/// assignment, an arithmetic expansion and an arithmetic assignment.
#[test]
fn in_posix_mode_a_subscript_error_drops_the_line() {
	let mut rows = Vec::new();
	for (name, cmd) in [
		("posix assignment", "set -o posix; a[1/0]=v"),
		("posix arithmetic expansion", "set -o posix; echo $(( a[1/0] ))"),
		("posix arithmetic assignment", "set -o posix; x=$(( a[1/0] ))"),
	] {
		rows.extend(dropped(name, cmd, DIV, 1));
	}
	assert_rows(&rows);
}

/// A command or process substitution that drops its line exits with status
/// 1, also in a script (bash's `command_substitute` and `process_substitute`
/// turn the jump into `EXECUTION_FAILURE`); so does a subshell inside it
/// (bash's `top_level_cleanup` restores the substitution's jump target).
#[test]
fn a_substitution_exits_with_status_1() {
	const SHIFT: &str = "SH: shift: too many arguments\n";
	let both = |name: &str, script: &str, out: String| -> Row {
		(name.into(), script.into(), (out.clone(), 0), (out, 0))
	};
	let rows: Vec<Row> = vec![
		both("$( )", "x=$(shift 1 2; echo in); echo \"x=[$x] st=$?\"", format!("{SHIFT}x=[] st=1\n")),
		both(
			"backquotes",
			"x=`shift 1 2; echo in`; echo \"x=[$x] st=$?\"",
			format!("{SHIFT}x=[] st=1\n"),
		),
		both(
			"exit",
			"x=$(exit 1 2; echo in); echo \"x=[$x] st=$?\"",
			"SH: exit: too many arguments\nx=[] st=1\n".into(),
		),
		both(
			"suspend",
			"x=$(suspend x); echo \"st=$?\"",
			"SH: suspend: too many arguments\nst=1\n".into(),
		),
		both(
			"eval",
			"x=$(eval 'shift 1 2'; echo in); echo \"x=[$x] st=$?\"",
			format!("{SHIFT}x=[] st=1\n"),
		),
		both(
			"break in a loop",
			"x=$(for i in 1; do break 1 2; done; echo in); echo \"x=[$x] st=$?\"",
			"SH: break: too many arguments\nx=[] st=1\n".into(),
		),
		both(
			"return in a function",
			"x=$(f() { return 1 2; }; f; echo in); echo \"x=[$x] st=$?\"",
			"SH: return: too many arguments\nx=[] st=1\n".into(),
		),
		both("an argument", "echo $(shift 1 2; echo in) st=$?", format!("{SHIFT}st=1\n")),
		both(
			"in a subshell",
			"( x=$(shift 1 2; echo in); echo \"x=[$x] st=$?\" ); echo w=$?",
			format!("{SHIFT}x=[] st=1\nw=0\n"),
		),
		both(
			"process substitution",
			"cat <(shift 1 2; echo in-ps); wait $!; echo w=$?",
			format!("{SHIFT}w=1\n"),
		),
		both(
			"subscript error",
			"x=$(a[1/0]=v; echo in); echo \"x=[$x] st=$?\"",
			format!("{DIV}x=[] st=1\n"),
		),
		(
			"a subshell inside".into(),
			"x=$( ( shift 1 2; echo in ); echo \"w=$?\" ); echo \"x=[$x]\"".into(),
			(format!("{SHIFT}x=[w=1]\n"), 0),
			(format!("{SHIFT}x=[w=1]\n"), 0),
		),
	];
	assert_rows(&rows);
}

/// `read` stops at the first name it cannot assign: the names before it
/// keep their values, those after it keep theirs.
#[test]
fn read_assigns_up_to_the_failing_name() {
	let rows: Vec<Row> = vec![(
		"read".into(),
		"y=old; read x 'a[1/0]' y <<< '1 2'\necho \"x=[$x] y=[$y]\"".into(),
		(DIV.into(), 1),
		(format!("{DIV}x=[1] y=[old]\n"), 0),
	)];
	assert_rows(&rows);
}

/// `break` and `continue` outside every loop read no arguments (bash's
/// `check_loop_level` comes first): they complain and the line goes on. A
/// forked pipeline element in a loop keeps the loop level in bash, so there
/// the extra argument is reported and only that element ends.
#[test]
fn break_outside_a_loop_reads_no_arguments() {
	let mut rows: Vec<Row> = ["break", "continue"]
		.into_iter()
		.map(|builtin| {
			let out =
				format!("SH: {builtin}: only meaningful in a `for', `while', or `until' loop\nst=0\n");
			(
				format!("{builtin} outside a loop"),
				format!("{builtin} 1 2; echo st=$?"),
				(out.clone(), 0),
				(out, 0),
			)
		})
		.collect();
	let element = format!("{0}in\n{0}in\nafter st=0\n", "SH: break: too many arguments\n");
	rows.push((
		"a pipeline element in a loop".into(),
		"for i in 1 2; do echo $i | break 1 2; echo in; done; echo after st=$?".into(),
		(element.clone(), 0),
		(element, 0),
	));
	assert_rows(&rows);
}

/// The control: an expansion error that is not a subscript's, or a readonly
/// variable, drops only the innermost `eval` or `.` string, as bash's plain
/// `DISCARD` does.
#[test]
fn other_errors_drop_only_the_innermost_string() {
	let mut rows = Vec::new();
	rows.extend(stays("arithmetic assignment", "x=$((1/0))", DIV));
	rows.extend(stays("arithmetic word", "echo $((1/0))", DIV));
	rows.extend(stays("readonly", "readonly r=1; r=2", "SH: r: readonly variable\n"));
	assert_rows(&rows);
}

/// A row whose script prints the same in both modes.
fn same(name: &str, script: &str, out: &str) -> Row {
	(name.into(), script.into(), (out.into(), 0), (out.into(), 0))
}

/// A row of `cmd` at the top level that drops the line with `msg`: a `-c`
/// string ends with status 1, a script's next line sees 1.
fn top(name: &str, cmd: &str, msg: &str) -> Row {
	(
		name.into(),
		format!("{cmd}; echo st=$? same\necho next st=$?"),
		(msg.into(), 1),
		(format!("{msg}next st=1\n"), 0),
	)
}

/// An arithmetic error in a value assigned to an integer variable drops the
/// line as a subscript error does (bash's `make_variable_value`:
/// `top_level_cleanup`, then `jump_to_top_level (DISCARD)`), from every
/// assignment and builtin, in posix mode too; a builtin keeps its name in
/// the message. A compound value keeps the indexed elements before the
/// error and leaves an associative array as it was.
#[test]
fn an_integer_variables_arithmetic_error_drops_the_line() {
	let by = |b: &str| format!("SH: {b}: 1/0: division by 0 (error token is \"0\")\n");
	let mut rows = Vec::new();
	rows.extend(dropped("integer assignment", "declare -i x; x=1/0", DIV, 1));
	for (name, cmd, msg) in [
		("integer +=", "declare -i x; x+=1/0", DIV.to_owned()),
		("integer element", "declare -ai a; a[0]=1/0", DIV.to_owned()),
		("integer compound value", "declare -ai a; a=(1/0)", DIV.to_owned()),
		("integer value of a substitution", "declare -i x; x=$(echo 1/0)", DIV.to_owned()),
		("posix integer assignment", "set -o posix; declare -i x; x=1/0", DIV.to_owned()),
		("set -e", "set -e; declare -i x; x=1/0", DIV.to_owned()),
		("declare -i", "declare -i x=1/0", by("declare")),
		("declare of an integer", "declare -i x; declare x=1/0", by("declare")),
		("local -i", "f() { local -i x=1/0; echo in-f; }; f", by("local")),
		("read", "declare -i x; read x <<< 1/0", by("read")),
		("printf -v", "declare -i x; printf -v x 1/0", by("printf")),
		("mapfile", "declare -ai a; mapfile -t a <<< 1/0", by("mapfile")),
		("export", "declare -i x; export x=1/0", by("export")),
		("readonly", "declare -i x; readonly x=1/0", by("readonly")),
		(
			"posix function",
			"set -o posix; declare -i x; f() { x=1/0; echo in-f; }; f",
			DIV.to_owned(),
		),
	] {
		rows.push(top(name, cmd, &msg));
	}
	let decl = by("declare");
	let read = by("read");
	rows.extend([
		(
			"declare stops at the name".into(),
			"declare -i x y; declare x=1/0 y=2; echo st=$? same\necho next y=$y st=$?".into(),
			(decl.clone(), 1),
			(format!("{decl}next y= st=1\n"), 0),
		),
		(
			"for".into(),
			"declare -i x; for x in 1 1/0 3; do echo x=$x; done; echo st=$? same\necho next st=$?"
				.into(),
			(format!("x=1\n{DIV}"), 1),
			(format!("x=1\n{DIV}next st=1\n"), 0),
		),
		(
			"${x:=}".into(),
			"declare -i x; : ${x:=1/0}; echo st=$? same\necho next x=$x st=$?".into(),
			(DIV.into(), 1),
			(format!("{DIV}next x= st=1\n"), 0),
		),
		(
			"read -a".into(),
			"declare -ai a=(5); read -a a <<< '1 1/0 3'; echo st=$? same\necho next st=$? a=${a[*]}"
				.into(),
			(read.clone(), 1),
			(format!("{read}next st=1 a=1\n"), 0),
		),
		(
			"compound, indexed".into(),
			"declare -ai a=(5); a=(1 1/0 3); echo st=$? same\necho next st=$? a=${a[*]}".into(),
			(DIV.into(), 1),
			(format!("{DIV}next st=1 a=1\n"), 0),
		),
		(
			"compound, associative".into(),
			"declare -Ai A=([k]=5); A=([a]=1 [b]=1/0 [c]=3); echo st=$? same\necho next st=$? \
			 n=${#A[@]} a=${A[a]}"
				.into(),
			(DIV.into(), 1),
			(format!("{DIV}next st=1 n=1 a=\n"), 0),
		),
		(
			"prefix +=".into(),
			"declare -i x=1; x+=1/0 true; echo st=$? same\necho next st=$? x=$x".into(),
			(DIV.into(), 1),
			(format!("{DIV}next st=1 x=1\n"), 0),
		),
		(
			"EXIT trap".into(),
			"trap 'echo T st=$?' EXIT; declare -i x; x=1/0; echo same\necho next st=$?".into(),
			(format!("{DIV}T st=1\n"), 1),
			(format!("{DIV}next st=1\nT st=0\n"), 0),
		),
		(
			"time".into(),
			"TIMEFORMAT=[R]; declare -i x; time { x=1/0; }; echo after\necho next st=$?".into(),
			(DIV.into(), 1),
			(format!("{DIV}[R]\nnext st=1\n"), 0),
		),
		same(
			"in a substitution",
			"declare -i x; y=$(x=1/0; echo in); echo st=$? y=$y same\necho next st=$?",
			&format!("{DIV}st=1 y= same\nnext st=0\n"),
		),
	]);
	assert_rows(&rows);
}

/// A prefix assignment puts its value in the command's environment as
/// written (bash's `assign_in_env` makes a new variable without the visible
/// one's attributes): `-i` evaluates nothing and reports no error, case
/// attributes convert nothing. Only `+=` goes through the attributes.
#[test]
fn a_prefix_assignment_takes_its_value_as_written() {
	let rows: Vec<Row> = vec![
		same(
			"integer, builtin",
			"declare -i x; x=1/0 true; echo st=$? same\necho next st=$?",
			"st=0 same\nnext st=0\n",
		),
		same(
			"integer, external",
			"declare -i x; x=1/0 /bin/true; echo st=$? same\necho next st=$?",
			"st=0 same\nnext st=0\n",
		),
		same(
			"integer, the value",
			"declare -i x; x=1/0 eval 'echo x=$x'; echo st=$?; declare -p x",
			"x=1/0\nst=0\ndeclare -i x\n",
		),
		same("integer, expression", "declare -i x; x=5+5 eval 'echo x=$x'", "x=5+5\n"),
		same(
			"integer, function",
			"f() { echo x=$x; }; declare -i x; x=2*3 f; echo st=$? x=$x",
			"x=2*3\nst=0 x=\n",
		),
		same(
			"case attributes",
			"declare -u u; u=abc eval 'echo u=$u'; declare -l l=X; l+=YZ eval 'echo l=$l'",
			"u=abc\nl=xyz\n",
		),
		same("integer +=", "declare -i x=1; x+=2 eval 'echo x=$x'; echo x=$x", "x=3\nx=1\n"),
	];
	assert_rows(&rows);
}

/// A subshell or command substitution that such a discard ends runs its
/// EXIT trap outside every function: bash's `top_level_cleanup` comes
/// first, its `run_unwind_protects` pops them, also those of the shell the
/// subshell forked from, and `variable_context` is 0 (sig.c:401). So the
/// trap sees no `FUNCNAME` and no locals, `local` fails there, and `set -e`
/// in the trap's `eval` acts as outside a function (the report goes out of
/// the `eval`'s redirection). A function past `FUNCNEST` runs
/// `run_unwind_protects` too (`execute_cmd.c:5203`).
#[test]
fn a_subshell_it_ends_runs_its_exit_trap_outside_its_functions() {
	const SHIFT: &str = "SH: shift: too many arguments\n";
	let by_mode = |name: &str, script: &str, c: String, s: String| -> Row {
		(name.into(), script.into(), (c, 0), (s, 0))
	};
	let rows: Vec<Row> = vec![
		by_mode(
			"FUNCNAME, too many arguments",
			"( trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; f() { shift 1 2; echo in-f; }; f; echo in ); \
			 echo w=$?",
			format!("{SHIFT}T[]\nw=1\n"),
			format!("{SHIFT}T[]\nw=2\n"),
		),
		same(
			"FUNCNAME, a subscript error",
			"( trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; f() { a[1/0]=v; echo in-f; }; f; echo in ); \
			 echo w=$?",
			&format!("{DIV}T[]\nw=1\n"),
		),
		by_mode(
			"local in the trap",
			"( trap 'local z=1 && echo \"local z=$z\"' EXIT; f() { shift 1 2; }; f ); echo w=$?",
			format!("{SHIFT}SH: local: can only be used in a function\nw=1\n"),
			format!("{SHIFT}SH: local: can only be used in a function\nw=2\n"),
		),
		by_mode(
			"a local's value",
			"v=g; ( trap 'echo \"T v=[$v]\"' EXIT; f() { local v=l; shift 1 2; }; f ); echo w=$?",
			format!("{SHIFT}T v=[g]\nw=1\n"),
			format!("{SHIFT}T v=[g]\nw=2\n"),
		),
		same(
			"a command substitution",
			"v=g; x=$( trap 'echo \"T[${FUNCNAME[*]}] v=[$v]\" >&2' EXIT; f() { local v=l; a[1/0]=v; \
			 }; f; echo in ); echo \"x=[$x] s=$?\"",
			&format!("{DIV}T[] v=[g]\nx=[] s=1\n"),
		),
		same(
			"set -e in the trap",
			"TIMEFORMAT=report; ( trap 'set -e; time eval \"{ false; } 2>/dev/null\"' EXIT; f() { \
			 shift 1 2; }; f ); echo w=$?",
			&format!("{SHIFT}report\nw=1\n"),
		),
		by_mode(
			"a subshell forked in a function, too many arguments",
			"f() { ( trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; shift 1 2; echo in ); echo w=$?; }; f",
			format!("{SHIFT}T[]\nw=1\n"),
			format!("{SHIFT}T[]\nw=2\n"),
		),
		same(
			"a subshell forked in a function, a subscript error",
			"f() { ( trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; a[1/0]=v; echo in ); echo w=$?; }; f",
			&format!("{DIV}T[]\nw=1\n"),
		),
		same(
			"FUNCNEST",
			"( trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; FUNCNEST=2; g() { g; }; f() { g; }; f ); echo \
			 w=$?",
			&format!("{NEST}T[]\nw=1\n"),
		),
	];
	assert_rows(&rows);
}

/// After every unwind-protect ran, the jump passes every `eval` and `.` to
/// the run's own top (each `parse_and_execute`'s saved jump target is
/// restored): a `-c` string ends, a script goes on with its next line. A
/// plain discard on that next line keeps its own kind: at a script's own
/// level after `top_level_cleanup` (no function in the trap), inside an
/// `eval` without it (the functions stay).
#[test]
fn a_cleanup_discard_lands_at_the_run_s_top() {
	const SHIFT: &str = "SH: shift: too many arguments\n";
	const NEST3: &str = "SH: f: maximum function nesting level exceeded (3)\n";
	const RO: &str = "SH: r: readonly variable\n";
	const FN: &str = "trap 'echo \"T[${FUNCNAME[*]}]\"' EXIT; ";
	let rows: Vec<Row> = vec![
		(
			"FUNCNEST in eval".into(),
			"FUNCNEST=3; f() { f; }; eval 'f; echo in'; echo after".into(),
			(NEST3.into(), 1),
			(NEST3.into(), 1),
		),
		(
			"FUNCNEST after a discarded line".into(),
			format!("shift 1 2\n( {FN}FUNCNEST=2; g() {{ g; }}; f() {{ g; }}; f ); echo w=$?"),
			(SHIFT.into(), 1),
			(format!("{SHIFT}{NEST}T[]\nw=1\n"), 0),
		),
		(
			"a plain discard after a discarded line".into(),
			format!("shift 1 2\nreadonly r=1; ( {FN}f() {{ r=2; }}; f ); echo w=$?"),
			(SHIFT.into(), 1),
			(format!("{SHIFT}{RO}T[]\nw=1\n"), 0),
		),
		(
			"a plain discard in eval after a discarded eval".into(),
			format!("eval 'shift 1 2'\nreadonly r=1; ( {FN}f() {{ eval 'r=2'; }}; f ); echo w=$?"),
			(SHIFT.into(), 1),
			(format!("{SHIFT}{RO}T[f main]\nw=1\n"), 0),
		),
	];
	assert_rows(&rows);
}

/// A row whose script prints the same and exits with `status` in both
/// modes.
fn both(name: &str, script: &str, out: &str, status: i32) -> Row {
	(name.into(), script.into(), (out.into(), status), (out.into(), status))
}

/// bash 5.3 drops a command while it still expands a declaration's compound
/// word (`name=(…)` given to `declare`, `typeset`, `local`, `export` or
/// `readonly`), before the builtin runs (`expand_declaration_argument`):
/// when the word's assignment fails (`do_word_assignment`, then
/// `bash_variable_assignment_error`, subst.c:13046). That is a plain
/// `exp_jump_to_top_level (DISCARD)`: the innermost `eval` or `.` catches
/// it, a function's line and a script's or `-c` string's line are dropped,
/// a subshell exits 1, in posix mode too.
#[test]
fn a_compound_word_bash_cannot_assign_drops_the_command() {
	let mut rows = Vec::new();
	let key = "SH: ['']='x': bad array subscript\n";
	rows.extend(stays("an empty key", "declare -A A=([k]=v []=x [j]=w)", key));
	rows.extend(stays("typeset", "typeset -A A=([]=x)", key));
	rows.extend(stays(
		"a list for an element",
		"declare a[0]=(1)",
		"SH: a[0]: cannot assign list to array member\n",
	));
	rows.extend(stays(
		"a bad element",
		"declare -a a=(1 [-9]=x 3)",
		"SH: [-9]=x: bad array subscript\n",
	));
	rows.extend(stays(
		"a non-numeric index",
		"declare -a a=([@]=x)",
		"SH: [@]=x: cannot assign to non-numeric index\n",
	));
	rows.extend(stays(
		"an element without a key",
		"declare -A A=([k]=v x)",
		"SH: A: 'x': must use subscript when assigning associative array\n",
	));
	rows.push(same(
		"posix mode",
		"set -o posix; declare -A A=([]=x); echo s=$?\necho next s=$?",
		&format!("{key}next s=1\n"),
	));
	rows.push(same(
		"the array a list for an element leaves",
		"declare a[0]=(1); echo s=$?\necho next s=$?; declare -p a",
		"SH: a[0]: cannot assign list to array member\nnext s=1\ndeclare -a a\n",
	));
	rows.push(same(
		"a key-value list goes on past an empty key",
		"declare -A A=(k v '' x j w); echo s=$?\necho next s=$?; declare -p A",
		"SH: '': bad array subscript\ns=0\nnext s=0\ndeclare -A A=([k]=\"v\" [j]=\"w\" )\n",
	));
	// `set -e` exits first, at bash's `report_error`.
	rows.push(same(
		"set -e",
		"( set -e; declare -A A=([]=x); echo in ); echo w=$?",
		&format!("{key}w=1\n"),
	));
	assert_rows(&rows);
}

/// A compound word whose `make_internal_declare` fails (a readonly variable
/// given `-a` or `-A`, an array of the other kind) drops the command too
/// (subst.c:13037), except for `declare`, `typeset` and `local` inside a
/// function (`W_FORCELOCAL`, `execute_cmd.c:4338`): those go on and fail again
/// under their own name. A readonly variable without `-a` or `-A` fails the
/// assignment, which drops the command in a function as well.
#[test]
fn a_compound_word_bash_cannot_declare_drops_the_command_outside_a_function() {
	const RO: &str = "SH: r: readonly variable\n";
	const CONV: &str = "i: cannot convert indexed to associative array\n";
	let after = "; echo in s=$?; }; f; echo after s=$?";
	let rows: Vec<Row> = vec![
		same(
			"readonly, -a",
			"readonly r=1; declare -a r=(1); echo in s=$?\necho next s=$?",
			&format!("{RO}next s=1\n"),
		),
		same(
			"readonly",
			"readonly r=1; declare r=(1); echo in s=$?\necho next s=$?",
			&format!("{RO}next s=1\n"),
		),
		same(
			"readonly, the readonly builtin",
			"readonly r=1; readonly r=(1); echo in s=$?\necho next s=$?",
			&format!("{RO}next s=1\n"),
		),
		same(
			"a readonly associative array",
			"declare -A A=([k]=v); readonly A; declare -A A=([j]=w); echo s=$?\necho next s=$?",
			"SH: A: readonly variable\nnext s=1\n",
		),
		same(
			"an indexed array made associative",
			"declare -a i=(1); declare -A i=([k]=v); echo in s=$?\necho next s=$?; declare -p i",
			&format!("SH: {CONV}next s=1\ndeclare -a i=([0]=\"1\")\n"),
		),
		same(
			"local, a readonly global",
			&format!("readonly r=1; f() {{ local -a r=(1){after}"),
			"SH: f: r: readonly variable\nSH: local: r: readonly variable\nin s=1\nafter s=0\n",
		),
		same(
			"declare, a readonly local",
			&format!("f() {{ local -r r=1; declare -a r=(1){after}"),
			&format!("{RO}SH: declare: r: readonly variable\nin s=1\nafter s=0\n"),
		),
		same(
			"declare -g, a readonly global",
			&format!("readonly r=1; f() {{ declare -g -a r=(1){after}"),
			"SH: f: r: readonly variable\nSH: declare: r: readonly variable\nin s=1\nafter s=0\n",
		),
		both(
			"declare without -a in a function",
			&format!("f() {{ local -r r=1; declare r=(1){after}"),
			RO,
			1,
		),
		both(
			"local without -a in a function",
			&format!("f() {{ local -r r=1; local r=(1){after}"),
			RO,
			1,
		),
		both(
			"the readonly builtin in a function",
			&format!("readonly r=1; f() {{ readonly -a r=(1){after}"),
			&format!("SH: f: {}", &RO[4..]),
			1,
		),
		both("export in a function", &format!("readonly r=1; f() {{ export r=(1){after}"), RO, 1),
		same(
			"declare -g, an array of the other kind",
			&format!("declare -a i=(1); f() {{ declare -gA i=([k]=v){after}"),
			&format!("SH: f: {CONV}SH: declare: {CONV}in s=1\nafter s=0\n"),
		),
		both(
			"readonly, an array of the other kind",
			&format!("declare -a i=(1); f() {{ readonly -A i=([k]=v){after}"),
			&format!("SH: f: {CONV}"),
			1,
		),
		same(
			"set -e",
			"( set -e; readonly r=1; declare -a r=(1); echo in ); echo w=$?",
			&format!("{RO}w=1\n"),
		),
	];
	assert_rows(&rows);
}

/// bash names a message made while it expands a declaration's words by its
/// `this_command_name` (the command's own name is not set yet): the
/// function call, `eval` or `.` around it until a simple command inside it
/// ends, then none (an assignment alone, a `for` item and `select` starting
/// clear it too); `((` and `[[` set it. A subshell keeps its parent's.
#[test]
fn a_declaration_s_expansion_message_names_this_command_name() {
	const AGAIN: &str = "SH: declare: r: readonly variable\nin s=1\nafter s=0\n";
	let row = |name: &str, before: &str, by: &str| {
		same(
			name,
			&format!(
				"readonly r=1; f() {{ {before}declare -a r=(1); echo in s=$?; }}; f; echo after s=$?"
			),
			&format!("SH: {by}r: readonly variable\n{AGAIN}"),
		)
	};
	let rows: Vec<Row> = vec![
		row("the function", "", "f: "),
		row("after a simple command", "[[ 1 ]]; local x=1; ", ""),
		row("after an assignment", "x=1; ", ""),
		row("after a function call", "h() { (( 1 )); }; h; ", ""),
		row("after ((", "(( 1 )); ", "((: "),
		row("after [[", "[[ 1 ]]; ", "[[: "),
		row("after an arithmetic for", "for ((i=0; i<1; i++)); do :; done; ", "((: "),
		row("after a for loop of ((", "for x in 1; do (( 1 )); done; ", "((: "),
		row("after a for loop of no item", "for x in; do :; done; ", "f: "),
		row("after select", "select x in; do :; done; ", ""),
		same(
			"in a for item",
			"readonly r=1; f() { for x in 1; do declare -a r=(1); done; echo in s=$?; }; f; echo \
			 after s=$?",
			&format!("SH: r: readonly variable\n{AGAIN}"),
		),
		same(
			"the innermost function",
			"readonly r=1; g() { declare -a r=(1); echo in s=$?; }; f() { g; }; f; echo after s=$?",
			&format!("SH: g: r: readonly variable\n{AGAIN}"),
		),
		same(
			"a subshell",
			"readonly r=1; f() { ( declare -a r=(1); echo in ); echo w=$?; }; f; echo after s=$?",
			"SH: f: r: readonly variable\nSH: declare: r: readonly variable\nin\nw=0\nafter s=0\n",
		),
		same(
			"eval in a function",
			"readonly r=1; f() { :; eval 'declare -a r=(1)'; echo f s=$?; }; f; echo after s=$?",
			"SH: eval: r: readonly variable\nSH: declare: r: readonly variable\nf s=1\nafter s=0\n",
		),
		same(
			"eval",
			"readonly r=1; eval 'declare -a r=(1); echo in'; echo after s=$?",
			"SH: eval: r: readonly variable\nafter s=1\n",
		),
		same(
			".",
			"readonly r=1; printf 'declare -a r=(1); echo in\\necho src2\\n' > g; . ./g; echo after \
			 s=$?",
			"SH: .: r: readonly variable\nsrc2\nafter s=0\n",
		),
	];
	assert_rows(&rows);
}

/// bash assigns a declaration's compound words while it expands the words,
/// before the builtin runs, so they come before its other arguments: one
/// that fails leaves those unassigned, and the values see the variables as
/// they were.
#[test]
fn a_declaration_assigns_its_compound_words_first() {
	let rows: Vec<Row> = vec![
		same(
			"a plain argument before",
			"declare x=1 A=([]=v); echo s=$?\necho x=${x-unset} s=$?",
			"SH: []=v: bad array subscript\nx=unset s=1\n",
		),
		same(
			"a list for an element",
			"declare x=1 a[0]=(1); echo s=$?\necho x=${x-unset}",
			"SH: a[0]: cannot assign list to array member\nx=unset\n",
		),
		same(
			"a compound word before",
			"declare -A B=([a]=1) x=2 A=([]=v); echo s=$?\ndeclare -p B; echo x=${x-unset}",
			"SH: ['']='v': bad array subscript\ndeclare -A B=([a]=\"1\" )\nx=unset\n",
		),
		both(
			"a compound word after",
			"declare -A A=([]=x) B=([k]=v); echo s=$?\ndeclare -p B",
			"SH: ['']='x': bad array subscript\nSH: declare: B: not found\n",
			1,
		),
		same(
			"a readonly variable",
			"readonly r=1; declare x=1 r=(1); echo s=$?\necho x=${x-unset}",
			"SH: r: readonly variable\nx=unset\n",
		),
		same(
			"an integer's value",
			"declare -i n=5 a=(n); declare -p a",
			"declare -ai a=([0]=\"0\")\n",
		),
		both("a bad name", "declare 1x=2 A=([]=v); echo s=$?", "SH: []=v: bad array subscript\n", 1),
	];
	assert_rows(&rows);
}

/// A compound assignment stops at its first bad element (bash 5.3's
/// `assign_compound_array_list`: `any_failed++; break`): the elements before
/// it are assigned, those after it are not, for a declaration and a plain
/// assignment alike.
#[test]
fn a_compound_assignment_stops_at_its_first_bad_element() {
	let rows: Vec<Row> = vec![
		same(
			"declare, a bad index",
			"declare -a a=(1 [-9]=x 3); echo s=$?\necho next s=$?; declare -p a",
			"SH: [-9]=x: bad array subscript\nnext s=1\ndeclare -a a=([0]=\"1\")\n",
		),
		same(
			"an assignment, a bad index",
			"a=(1 [-9]=x 3); echo s=$?\necho next s=$?; declare -p a",
			"SH: [-9]=x: bad array subscript\nnext s=1\ndeclare -a a=([0]=\"1\")\n",
		),
		same(
			"declare, a non-numeric index",
			"declare -a a=(1 [@]=x 3); echo s=$?\necho next s=$?; declare -p a",
			"SH: [@]=x: cannot assign to non-numeric index\nnext s=1\ndeclare -a a=([0]=\"1\")\n",
		),
		same(
			"an assignment, a non-numeric index",
			"a=(1 [@]=x 3); echo s=$?\necho next s=$?; declare -p a",
			"SH: [@]=x: cannot assign to non-numeric index\nnext s=1\ndeclare -a a=([0]=\"1\")\n",
		),
		same(
			"declare, an element without a key",
			"declare -A A=([k]=v x [j]=w); echo s=$?\necho next s=$?; declare -p A",
			"SH: A: 'x': must use subscript when assigning associative array\nnext s=1\ndeclare -A \
			 A=([k]=\"v\" )\n",
		),
		same(
			"an assignment, an element without a key",
			"declare -A A; A=([k]=v x [j]=w); echo s=$?\necho next s=$?; declare -p A",
			"SH: A: x: must use subscript when assigning associative array\nnext s=1\ndeclare -A \
			 A=([k]=\"v\" )\n",
		),
		same(
			"declare, an empty key",
			"declare -A A=([k]=v []=x [j]=w); echo s=$?\necho next s=$?; declare -p A",
			"SH: ['']='x': bad array subscript\nnext s=1\ndeclare -A A=([k]=\"v\" )\n",
		),
	];
	assert_rows(&rows);
}

/// The plain discard's kind: at a script's own level bash runs
/// `top_level_cleanup` first (a subshell's EXIT trap runs outside every
/// function; the redirections the jump leaves are undone, so `time`
/// reports on the shell's stderr), under `-c` and inside `eval` it does not.
#[test]
fn a_compound_word_s_discard_cleans_up_only_at_a_script_s_level() {
	const TRAP: &str = "( trap 'echo \"T ${FUNCNAME[*]-none} l=${l-unset}\"' EXIT; ";
	const KEY: &str = "SH: ['']='x': bad array subscript\n";
	const LIST: &str = "SH: a[0]: cannot assign list to array member\n";
	let by_mode = |name: &str, script: String, c: String, s: String| -> Row {
		(name.into(), script, (c, 0), (s, 0))
	};
	let rows: Vec<Row> = vec![
		by_mode(
			"an empty key in a subshell's function",
			format!(
				"{TRAP}f() {{ local l=1; declare -A A=([]=x); echo in; }}; f; echo after ); echo w=$?"
			),
			format!("{KEY}T f l=1\nw=1\n"),
			format!("{KEY}T none l=unset\nw=1\n"),
		),
		by_mode(
			"a list for an element in a subshell's function",
			format!("{TRAP}f() {{ local l=1; local a[0]=(1); echo in; }}; f; echo after ); echo w=$?"),
			format!("{LIST}T f l=1\nw=1\n"),
			format!("{LIST}T none l=unset\nw=1\n"),
		),
		by_mode(
			"readonly in a subshell's function",
			format!(
				"readonly r=1; {TRAP}f() {{ local l=1; readonly -a r=(1); echo in; }}; f; echo after \
				 ); echo w=$?"
			),
			"SH: r: readonly variable\nT f l=1\nw=1\n".into(),
			"SH: r: readonly variable\nT none l=unset\nw=1\n".into(),
		),
		by_mode(
			"time in a subshell",
			"TIMEFORMAT='[R]'; ( time { declare -A A=([]=x); } 2>e1; echo after ); echo w=$?; echo \
			 e1:; cat e1"
				.into(),
			format!("w=1\ne1:\n{KEY}[R]\n"),
			format!("[R]\nw=1\ne1:\n{KEY}"),
		),
		same(
			"time in eval",
			"TIMEFORMAT='[R]'; eval 'time { declare a[0]=(1); } 2>e1; echo in'; echo after; echo \
			 e1:; cat e1",
			&format!("after\ne1:\n{LIST}[R]\n"),
		),
		by_mode(
			"time in a function",
			"TIMEFORMAT='[R]'; f() { time { declare a[0]=(1); } 2>e1; echo in; }; f; echo \
			 after\necho next; echo e1:; cat e1"
				.into(),
			format!("next\ne1:\n{LIST}[R]\n"),
			format!("[R]\nnext\ne1:\n{LIST}"),
		),
	];
	assert_rows(&rows);
}

/// A discard inside a running EXIT trap ends the trap action, and the shell
/// exits with the status the trap saved (bash's `run_exit_trap`:
/// `trap_saved_exit_value`), after `top_level_cleanup` too (too many
/// arguments, `FUNCNEST`, a subscript error). A subshell forked inside a
/// `-c` string is the exception: `top_level_cleanup` restores the string's
/// jump target, and the subshell exits with status 1.
#[test]
fn a_discard_in_an_exit_trap_keeps_the_trap_s_status() {
	const NEST: &str = "SH: g: maximum function nesting level exceeded (2)\n";
	const SHIFT: &str = "SH: shift: too many arguments\n";
	const KEY: &str = "SH: ['']='x': bad array subscript\n";
	let nest = "FUNCNEST=2; g() { g; }; g; echo in-trap";
	let by_mode = |name: &str, script: String, c: String, s: String| -> Row {
		(name.into(), script, (c, 0), (s, 0))
	};
	let rows: Vec<Row> = vec![
		by_mode(
			"FUNCNEST in a subshell's trap",
			format!("( trap '{nest}' EXIT; echo body ); echo w=$?"),
			format!("body\n{NEST}w=1\n"),
			format!("body\n{NEST}w=0\n"),
		),
		by_mode(
			"FUNCNEST in a function in a subshell's trap",
			"( trap 'FUNCNEST=2; g() { g; }; f() { g; }; f; echo in-trap' EXIT; echo body ); echo \
			 w=$?"
				.into(),
			format!("body\n{NEST}w=1\n"),
			format!("body\n{NEST}w=0\n"),
		),
		by_mode(
			"FUNCNEST, a saved status",
			format!("( trap '{nest}' EXIT; (exit 3) ); echo w=$?"),
			format!("{NEST}w=1\n"),
			format!("{NEST}w=3\n"),
		),
		by_mode(
			"FUNCNEST, exit 3",
			format!("( trap '{nest}' EXIT; echo body; exit 3 ); echo w=$?"),
			format!("body\n{NEST}w=1\n"),
			format!("body\n{NEST}w=3\n"),
		),
		by_mode(
			"FUNCNEST in a command substitution's trap",
			format!("x=$( trap '{nest}' EXIT; echo body ); echo \"x=$x s=$?\""),
			format!("{NEST}x=body s=1\n"),
			format!("{NEST}x=body s=0\n"),
		),
		by_mode(
			"FUNCNEST in a subshell forked in a function",
			format!("f() {{ ( trap '{nest}' EXIT; echo body ); echo w=$?; }}; f"),
			format!("body\n{NEST}w=1\n"),
			format!("body\n{NEST}w=0\n"),
		),
		by_mode(
			"FUNCNEST in eval in a subshell's trap",
			format!("( trap 'eval \"{nest}\"' EXIT; echo body ); echo w=$?"),
			format!("body\n{NEST}w=1\n"),
			format!("body\n{NEST}w=0\n"),
		),
		by_mode(
			"too many arguments in a subshell's trap",
			"( trap 'shift 1 2; echo in-trap' EXIT; echo body ); echo w=$?".into(),
			format!("body\n{SHIFT}w=1\n"),
			format!("body\n{SHIFT}w=0\n"),
		),
		by_mode(
			"too many arguments, a saved status",
			"( trap 'shift 1 2; echo in-trap' EXIT; exit 4 ); echo w=$?".into(),
			format!("{SHIFT}w=1\n"),
			format!("{SHIFT}w=4\n"),
		),
		same(
			"too many arguments, a saved failure",
			"( trap 'shift 1 2; echo in-trap' EXIT; false ); echo w=$?",
			&format!("{SHIFT}w=1\n"),
		),
		by_mode(
			"too many arguments in eval in a subshell's trap",
			"( trap 'eval \"shift 1 2\"; echo in-trap' EXIT; echo body ); echo w=$?".into(),
			format!("body\n{SHIFT}w=1\n"),
			format!("body\n{SHIFT}w=0\n"),
		),
		by_mode(
			"a subscript error in a subshell's trap",
			"( trap 'a[1/0]=v; echo in-trap' EXIT; echo body ); echo w=$?".into(),
			format!("body\n{DIV}w=1\n"),
			format!("body\n{DIV}w=0\n"),
		),
		by_mode(
			"a command substitution's trap",
			"x=$( trap 'shift 1 2; echo in-trap >&2' EXIT; echo body ); echo \"x=$x w=$?\"".into(),
			format!("{SHIFT}x=body w=1\n"),
			format!("{SHIFT}x=body w=0\n"),
		),
		same(
			"FUNCNEST in the shell's trap",
			&format!("trap '{nest}' EXIT; echo body"),
			&format!("body\n{NEST}"),
		),
		same(
			"too many arguments in the shell's trap",
			"trap 'shift 1 2; echo in-trap' EXIT; echo body",
			&format!("body\n{SHIFT}"),
		),
		both(
			"too many arguments in the shell's trap, a saved status",
			"trap 'shift 1 2; echo in-trap' EXIT; (exit 5)",
			SHIFT,
			5,
		),
		both("FUNCNEST in the shell's trap, exit 3", &format!("trap '{nest}' EXIT; exit 3"), NEST, 3),
		both(
			"too many arguments in the shell's trap, exit 3",
			"trap 'shift 1 2; echo in-trap' EXIT; exit 3",
			SHIFT,
			3,
		),
		same(
			"a compound word in a subshell's trap",
			"( trap 'declare -A A=([]=x); echo in-trap' EXIT; echo body ); echo w=$?",
			&format!("body\n{KEY}w=0\n"),
		),
		same(
			"a compound word, a saved status",
			"( trap 'declare -A A=([]=x); echo in-trap' EXIT; exit 6 ); echo w=$?",
			&format!("{KEY}w=6\n"),
		),
		// Another trap's action is no catch: the jump passes it.
		(
			"too many arguments in a signal trap".into(),
			"trap 'shift 1 2; echo in-trap' USR1; kill -USR1 $$; echo after s=$?".into(),
			(SHIFT.into(), 1),
			(SHIFT.into(), 2),
		),
		(
			"too many arguments in the ERR trap".into(),
			"trap 'shift 1 2; echo in-trap' ERR; false; echo after s=$?".into(),
			(SHIFT.into(), 1),
			(SHIFT.into(), 2),
		),
	];
	assert_rows(&rows);
}
