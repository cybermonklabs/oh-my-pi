//! bash's `$_`: after each simple command, its last word (the name when it
//! has no argument, empty after an assignment-only command), bound in the
//! shell itself; pipelines, `( )` and background jobs bind their own copy.
//! An external is given `_=` its own path. Each row runs `obash -c` with
//! `_=/sentinel` (what the shell imported) and `PATH=/usr/bin:/bin`, and
//! checks stdout against what bash 5.2.21 and 5.3.20 print for the same
//! script there (they agree on every row).

mod obash_support;

use crate::obash_support::{obash, output};

/// `(script, stdout)`.
type Row = (&'static str, &'static str);

/// Run `script` as bash with `_` and `PATH` pinned: stdout and status.
fn run(script: &str) -> (String, i32) {
	let mut cmd = obash();
	cmd.env("_", "/sentinel")
		.env("PATH", "/usr/bin:/bin")
		.args(["-c", script]);
	let out = output(&mut cmd);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status.code().unwrap_or(-1))
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
		// An external gets `_` as its own path, even when `_` is exported.
		("/usr/bin/env | grep '^_='", "_=/usr/bin/env\n"),
		("export _; echo a; /usr/bin/env | grep '^_='", "a\n_=/usr/bin/env\n"),
		// `exec` passes no path: only an exported `_`, which is the imported
		// one until a command binds `_` (unexported).
		("exec /usr/bin/env | grep '^_='", "_=/sentinel\n"),
		("echo hi; exec /usr/bin/env | grep '^_='", "hi\n"),
		("echo a b; (exec /usr/bin/env) | grep '^_='", "a b\n"),
		("echo a b > /dev/null; ls /nonexist 2>/dev/null; echo \"_=$_\"", "_=/nonexist\n"),
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
