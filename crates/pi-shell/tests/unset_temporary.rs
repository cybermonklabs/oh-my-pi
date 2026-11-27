//! `unset` of a variable whose binding is a prefix assignment's temporary
//! (`x=3 eval …`, `x=3 . file`, `x=3 f`) removes the temporary, so the
//! variable it hid shows through, as in bash: `x=1; x=3 eval 'unset x;
//! echo $x'` prints 1, and a second `unset` removes the global too. bash's
//! `makunbound` (variables.c) keeps a variable declared but unset only
//! when it has the `local` attribute; a temporary never has it, on a
//! builtin or on a function call, until `local` names it.
//!
//! Each row runs twice, as `-c` text and from a script file, with stderr
//! on stdout; a line that starts with the shell's name starts with `SH`
//! instead. Every row was measured against bash 5.3.20 and 5.2.21 both
//! ways, and the two agree on every row here except those of
//! [`bash_trapsig_stays_unset_until_the_trap_ends`] (bash 5.2.21 has no
//! `BASH_TRAPSIG`).

#![cfg(unix)]

mod obash_support;

/// How a row runs: as the text of `-c`, or from the script file `s.sh`.
#[derive(Clone, Copy, Debug)]
enum Mode {
	C,
	Script,
}

/// Runs `script` with stderr on stdout in a private directory (a row may
/// write files there). Returns the output, each line that starts with the
/// shell's name (`$0` under `-c`: the path obash was started by,
/// [`obash_support::obash_path`]; `s.sh` for the script) starting with
/// `SH` instead, and the exit status.
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

/// Every row (its name, its script, and the output and status bash gives
/// in both modes) whose output or status differs, in either mode, is
/// listed.
fn assert_rows(rows: &[(&str, &str, &str, i32)]) {
	let mut mismatches = Vec::new();
	for &(name, script, want, status) in rows {
		for mode in [Mode::C, Mode::Script] {
			let got = run(script, mode);
			if got != (want.to_owned(), Some(status)) {
				mismatches.push(format!("{name} ({mode:?}): {got:?}, want ({want:?}, {status})"));
			}
		}
	}
	assert!(mismatches.is_empty(), "{} rows differ:\n{}", mismatches.len(), mismatches.join("\n"));
}

/// The temporary environment of a builtin (`eval`, `command eval`,
/// `builtin eval`, `.`, `source`, `mapfile`'s callback): `unset` removes
/// the temporary and the variable below shows through, a global, an
/// outer temporary, a function's local, or nothing; a second `unset`
/// removes that one too; an assignment after the `unset` lands where the
/// temporary's name now resolves.
#[test]
fn unset_removes_a_builtins_temporary() {
	let f = "printf '%s\\n' 'unset x; declare -p x; echo \"[$x]\"' > f; x=1; ";
	let dot = format!("{f}x=3 . ./f");
	let source = format!("{f}x=3 source ./f; declare -p x");
	assert_rows(&[
		(
			"eval",
			"x=1; x=3 eval 'unset x; declare -p x; echo \"[$x]\"'",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		("eval unset -v", "x=1; x=3 eval 'unset -v x; echo \"[$x]\"'", "[1]\n", 0),
		(
			"no global",
			"unset y; y=3 eval 'unset y; declare -p y 2>/dev/null || echo none'",
			"none\n",
			0,
		),
		(
			"twice",
			"x=1; x=3 eval 'unset x; unset x; declare -p x 2>/dev/null || echo none'",
			"none\n",
			0,
		),
		("then assigned", "x=1; x=3 eval 'unset x; x=5'; declare -p x", "declare -- x=\"5\"\n", 0),
		(
			"assigned, no global",
			"unset y; y=3 eval 'unset y; y=5; declare -p y'; declare -p y",
			"declare -- y=\"5\"\ndeclare -- y=\"5\"\n",
			0,
		),
		(
			"an array below",
			"a=(1 2); a=3 eval 'unset a; declare -p a'",
			"declare -a a=([0]=\"1\" [1]=\"2\")\n",
			0,
		),
		(
			"an outer temporary",
			"x=1; x=2 eval 'x=3 eval \"unset x; declare -p x\"; declare -p x'",
			"declare -x x=\"2\"\ndeclare -x x=\"2\"\n",
			0,
		),
		("two names", "x=1; x=3 y=4 eval 'unset x y; echo \"[$x][$y]\"'", "[1][]\n", 0),
		("not listed", "x=1; x=3 eval 'unset x; declare -p | grep -c \"^declare -x x$\"'", "0\n", 1),
		(
			"command eval",
			"x=1; x=3 command eval 'unset x; declare -p x; echo \"[$x]\"'",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		(
			"builtin eval",
			"x=1; x=3 builtin eval 'unset x; declare -p x; echo \"[$x]\"'",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		(".", &dot, "declare -- x=\"1\"\n[1]\n", 0),
		("source", &source, "declare -- x=\"1\"\n[1]\ndeclare -- x=\"1\"\n", 0),
		(
			"mapfile callback",
			"cb() { unset x; declare -p x; echo \"[$x]\"; }; x=1; x=3 mapfile -t -C cb -c 1 a <<< q",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		(
			"a function in eval",
			"x=1; x=3 eval 'f() { unset x; declare -p x; echo \"[$x]\"; }; f'",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		(
			"over a local",
			"f() { local x=2; x=3 eval 'unset x; declare -p x; echo \"[$x]\"'; declare -p x; }; f",
			"declare -- x=\"2\"\n[2]\ndeclare -- x=\"2\"\n",
			0,
		),
		(
			"in a function",
			"x=1; f() { x=3 eval 'unset x; declare -p x; echo \"[$x]\"'; }; f",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		("PATH", "PATH=/nowhere eval 'unset PATH; ls / > /dev/null && echo found'", "found\n", 0),
		("IFS", "IFS=,; IFS=: eval 'unset IFS; v=\"a,b c\"; set -- $v; echo \"$1\"'", "a\n", 0),
	]);
}

/// A function call's prefix assignment (`x=3 f`) is no local of the
/// function: `unset` in the function, or in a function it calls, removes
/// it and the global shows through, in posix mode too. Once `local`
/// names it, it is a local ([`a_local_stays_declared_but_unset`]).
#[test]
fn unset_removes_a_function_calls_temporary() {
	let shown = "declare -- x=\"1\"\n[1]\n";
	assert_rows(&[
		("the function", "x=1; f() { unset x; declare -p x; echo \"[$x]\"; }; x=3 f", shown, 0),
		(
			"no global",
			"unset y; f() { unset y; declare -p y 2>/dev/null || echo none; }; y=3 f",
			"none\n",
			0,
		),
		(
			"twice",
			"x=1; f() { unset x; unset x; declare -p x 2>/dev/null || echo none; }; x=3 f; declare \
			 -p x 2>/dev/null || echo none",
			"none\nnone\n",
			0,
		),
		(
			"a callee",
			"x=1; g() { unset x; declare -p x; echo \"[$x]\"; }; f() { g; }; x=3 f",
			shown,
			0,
		),
		(
			"assigned first",
			"x=1; f() { x=5; unset x; declare -p x; echo \"[$x]\"; }; x=3 f",
			shown,
			0,
		),
		("eval", "x=1; f() { eval 'unset x'; declare -p x; echo \"[$x]\"; }; x=3 f", shown, 0),
		(
			"then assigned",
			"x=1; f() { unset x; x=5; }; x=3 f; declare -p x",
			"declare -- x=\"5\"\n",
			0,
		),
		(
			"over a caller's local",
			"x=1; f() { local x=2; g; declare -p x; }; g() { x=3 h; }; h() { unset x; declare -p x; \
			 echo \"[$x]\"; }; f",
			"declare -- x=\"2\"\n[2]\ndeclare -- x=\"2\"\n",
			0,
		),
		(
			"seen first",
			"x=1; f() { declare -p x; unset x; declare -p x; echo \"[$x]\"; }; x=3 f",
			"declare -x x=\"3\"\ndeclare -- x=\"1\"\n[1]\n",
			0,
		),
		(
			"posix mode",
			"set -o posix; x=1; f() { unset x; echo \"[$x]\"; }; x=3 f; declare -p x",
			"[1]\ndeclare -- x=\"1\"\n",
			0,
		),
	]);
}

/// `shopt -s localvar_unset` keeps a calling function's local declared
/// but unset, never a temporary.
#[test]
fn localvar_unset_keeps_no_temporary() {
	let shown = "declare -- x=\"1\"\n[1]\n";
	assert_rows(&[
		(
			"eval",
			"shopt -s localvar_unset; x=1; x=3 eval 'unset x; declare -p x; echo \"[$x]\"'",
			shown,
			0,
		),
		(
			"a function call",
			"shopt -s localvar_unset; x=1; f() { unset x; declare -p x; echo \"[$x]\"; }; x=3 f",
			shown,
			0,
		),
		(
			"a callee",
			"shopt -s localvar_unset; x=1; g() { unset x; declare -p x; echo \"[$x]\"; }; f() { g; \
			 }; x=3 f",
			shown,
			0,
		),
		(
			"over a local",
			"shopt -s localvar_unset; f() { local x=2; x=3 eval 'unset x; declare -p x; echo \
			 \"[$x]\"'; declare -p x; }; f",
			"declare -- x=\"2\"\n[2]\ndeclare -- x=\"2\"\n",
			0,
		),
	]);
}

/// A subshell's scopes are its own copies: the same in a `( )`, an
/// `eval`'s `( )` and a pipeline's element.
#[test]
fn unset_removes_a_temporary_in_a_subshell() {
	let shown = "declare -- x=\"1\"\n[1]\n";
	assert_rows(&[
		("eval", "( x=1; x=3 eval 'unset x; declare -p x; echo \"[$x]\"' )", shown, 0),
		("eval's subshell", "x=1; x=3 eval '( unset x; declare -p x; echo \"[$x]\" )'", shown, 0),
		(
			"a function call",
			"( x=1; f() { unset x; declare -p x; echo \"[$x]\"; }; x=3 f )",
			shown,
			0,
		),
		("a pipeline", "x=1; x=3 eval 'unset x; echo \"[$x]\"' | cat", "[1]\n", 0),
		(
			"twice",
			"( x=1; x=3 eval 'unset x; unset x; declare -p x 2>/dev/null || echo none' )",
			"none\n",
			0,
		),
	]);
}

/// Controls, the same before and after: a local of the running function
/// stays declared but unset (also one `local` made of a call's
/// temporary, which keeps its export), and so does a calling function's
/// under `localvar_unset`; without it, that local is removed. A
/// temporary unset by its own builtin, or seen after the builtin, is gone
/// with it.
#[test]
fn a_local_stays_declared_but_unset() {
	assert_rows(&[
		(
			"own local",
			"x=1; f() { local x=2; unset x; declare -p x; echo \"[$x]\"; }; f",
			"declare -- x\n[]\n",
			0,
		),
		(
			"in a subshell",
			"( x=1; f() { local x=2; unset x; declare -p x; echo \"[$x]\"; }; f )",
			"declare -- x\n[]\n",
			0,
		),
		(
			"a caller's local",
			"x=1; g() { unset x; declare -p x; echo \"[$x]\"; }; f() { local x=2; g; }; f",
			"declare -- x=\"1\"\n[1]\n",
			0,
		),
		(
			"a caller's local, localvar_unset",
			"shopt -s localvar_unset; x=1; g() { unset x; declare -p x; echo \"[$x]\"; }; f() { \
			 local x=2; g; }; f",
			"declare -- x\n[]\n",
			0,
		),
		(
			"a temporary made local",
			"x=1; f() { local x; unset x; declare -p x; echo \"[$x]\"; }; x=3 f",
			"declare -x x\n[]\n",
			0,
		),
		(
			"a temporary given a local value",
			"x=1; f() { local x=7; unset x; declare -p x; echo \"[$x]\"; }; x=3 f",
			"declare -x x\n[]\n",
			0,
		),
		(
			"made local, localvar_unset",
			"shopt -s localvar_unset; x=1; f() { local x; unset x; declare -p x; echo \"[$x]\"; }; \
			 x=3 f",
			"declare -x x\n[]\n",
			0,
		),
		("after eval", "x=1; x=3 eval 'unset x'; declare -p x", "declare -- x=\"1\"\n", 0),
		("after a function", "x=1; f() { unset x; }; x=3 f; declare -p x", "declare -- x=\"1\"\n", 0),
		("unset's own", "x=1; x=3 unset x; declare -p x", "declare -- x=\"1\"\n", 0),
		("declare's own", "x=1; x=3 declare -p x", "declare -x x=\"3\"\n", 0),
		("exported global", "export x=1; x=3 eval 'unset x; printenv x'", "1\n", 0),
	]);
}

/// A trap's `BASH_TRAPSIG` is bash's variable set for the trap, its old
/// value put back after it (trap.c): `unset` in the trap leaves it unset
/// until the trap ends, in a nested trap too, and the value from before
/// comes back. bash 5.2.21 has no `BASH_TRAPSIG`.
#[test]
fn bash_trapsig_stays_unset_until_the_trap_ends() {
	assert_rows(&[
		(
			"a global",
			"BASH_TRAPSIG=7; trap 'unset BASH_TRAPSIG; echo \"[$BASH_TRAPSIG]\"' USR1; kill -USR1 \
			 $$; echo \"after[$BASH_TRAPSIG]\"",
			"[]\nafter[7]\n",
			0,
		),
		(
			"nested",
			"trap 'unset BASH_TRAPSIG; echo \"in[$BASH_TRAPSIG]\"' USR1; trap 'kill -USR1 $$; echo \
			 \"out[$BASH_TRAPSIG]\"' USR2; kill -USR2 $$",
			"in[]\nout[12]\n",
			0,
		),
	]);
}
