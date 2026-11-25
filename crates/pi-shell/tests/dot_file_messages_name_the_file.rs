//! A message a non-interactive shell prints while it reads a `.` file
//! names that file, as bash's `get_name_for_error` does: `BASH_SOURCE[0]`
//! (the file the `.` command is reading, or the file the running function
//! was defined in) while it is not empty, else `$0`. `BASH_SOURCE[0]` is
//! the name as given (`./s2`, `s2`, `/dir/s2`), or the file a `$PATH`
//! search found (`$PATH_DIR/s2` for `PATH=$PWD/d`, `./s2` for `PATH=.`),
//! as bash's `_evalfile` names it. Back at the top level, in a trap and in
//! a function defined there, the shell names itself again.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job (bash 5.2.21 agrees on
//! every row here but the syntax error's text, which it ends at `end of
//! file`, the prefix the same). Each row runs as `-c` and as a script file, in
//! a directory of its own: in the expected stderr `PFX` is the shell's own
//! prefix (its name under `-c`, `D/s.sh` from the script).
#![cfg(unix)]

mod obash_support;

use std::fs;

use crate::obash_support::{obash, output};

/// A row: the script, its stdout, its stderr (`PFX` as above) and status.
type Row = (&'static str, &'static str, &'static str, i32);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = env!("CARGO_BIN_EXE_obash");
	let mut out = Vec::new();
	for &(code, want_out, want_err, want_status) in rows {
		for script in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let dir = fs::canonicalize(tmp.path()).unwrap();
			let d = dir.to_str().unwrap().to_owned();
			let mut cmd = obash();
			cmd.current_dir(&dir)
				.env("PATH", "/usr/bin:/bin")
				.env("LC_ALL", "C");
			let prefix = if script {
				let file = dir.join("s.sh");
				fs::write(&file, code).unwrap();
				cmd.arg(&file);
				"D/s.sh"
			} else {
				cmd.args(["-c", code]);
				"SH"
			};
			let o = output(&mut cmd);
			let norm = |b: &[u8]| {
				String::from_utf8_lossy(b)
					.replace(sh, "SH")
					.replace(&d, "D")
			};
			let got = (norm(&o.stdout), norm(&o.stderr), o.status.code());
			let want =
				(want_out.replace("PFX", prefix), want_err.replace("PFX", prefix), Some(want_status));
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

#[test]
fn a_message_from_a_dot_file_names_the_file() {
	check(&[
		(
			"printf 'echo ${x!}\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 1\n",
			"./s2: line 1: ${x!}: bad substitution\n",
			0,
		),
		(
			"printf 'true\\ntrue\\nnosuch\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 127\n",
			"./s2: line 3: nosuch: command not found\n",
			0,
		),
		(
			"printf 'cd /nonexistent\\n' > s2\nsource ./s2\necho \"after $?\"",
			"after 1\n",
			"./s2: line 1: cd: /nonexistent: No such file or directory\n",
			0,
		),
		(
			"printf 'echo x > /nonexistent/y\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 1\n",
			"./s2: line 1: /nonexistent/y: No such file or directory\n",
			0,
		),
		(
			"printf 'eval \"nosuch\"\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 127\n",
			"./s2: line 1: nosuch: command not found\n",
			0,
		),
		(
			"printf '( nosuch )\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 127\n",
			"./s2: line 1: nosuch: command not found\n",
			0,
		),
		(
			"printf 'nosuch | cat\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 0\n",
			"./s2: line 1: nosuch: command not found\n",
			0,
		),
		// A syntax error names the file once: bash's `parser_error` prints
		// the input name (`-c` under `-c`) only when it is not the error
		// name, and while a `.` file is read the file is both.
		(
			"printf 'if\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 2\n",
			"./s2: line 2: syntax error: unexpected end of file from `if' command on line 1\n",
			0,
		),
	]);
}

#[test]
fn the_innermost_dot_file_names_it() {
	check(&[
		// The file being read, not the one that read it.
		(
			"printf 'true\\n. ./s3\\n' > s2\nprintf 'true\\ncd /nonexistent\\n' > s3\n. ./s2\necho \
			 \"after $?\"",
			"after 1\n",
			"./s3: line 2: cd: /nonexistent: No such file or directory\n",
			0,
		),
		// A `.` inside a function, and a function the file defined: both
		// name the file.
		(
			"printf 'nosuch\\n' > s2\nf() { . ./s2; }\nf\necho \"after $?\"",
			"after 127\n",
			"./s2: line 1: nosuch: command not found\n",
			0,
		),
		(
			"printf 'g() {\\n  nosuch\\n}\\n' > s2\n. ./s2\ng\necho \"after $?\"",
			"after 127\n",
			"./s2: line 2: nosuch: command not found\n",
			0,
		),
		// A function defined at the top level keeps the shell's name, even
		// when a `.` file calls it.
		(
			"f() { nosuch; }\nprintf 'f\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 127\n",
			"PFX: line 1: nosuch: command not found\n",
			0,
		),
	]);
}

#[test]
fn the_name_is_the_one_bash_source_holds() {
	check(&[
		// As given: a bare name, and an absolute path.
		(
			"printf 'nosuch\\n' > s2\n. s2\necho \"after $?\"",
			"after 127\n",
			"s2: line 1: nosuch: command not found\n",
			0,
		),
		(
			"printf 'nosuch\\n' > s2\n. $PWD/s2\necho \"after $?\"",
			"after 127\n",
			"D/s2: line 1: nosuch: command not found\n",
			0,
		),
		// Found through `$PATH`: the file the search found.
		(
			"mkdir d; printf 'nosuch\\n' > d/s2\nPATH=$PWD/d:$PATH\n. s2\necho \"after $?\"",
			"after 127\n",
			"D/d/s2: line 1: nosuch: command not found\n",
			0,
		),
		(
			"mkdir d; printf 'echo \"${BASH_SOURCE[0]}\"\\n' > d/s2\nPATH=$PWD/d:$PATH\n. s2\necho \
			 \"after $?\"",
			"D/d/s2\nafter 0\n",
			"",
			0,
		),
		(
			"printf 'echo \"${BASH_SOURCE[0]}\"\\nnosuch\\n' > s2\nPATH=.:$PATH\n. s2\necho \"after \
			 $?\"",
			"./s2\nafter 127\n",
			"./s2: line 2: nosuch: command not found\n",
			0,
		),
		(
			"mkdir d; printf 'g() {\\n  nosuch\\n}\\n' > d/s2\nPATH=$PWD/d:$PATH\n. s2\ng\necho \
			 \"after $?\"",
			"after 127\n",
			"D/d/s2: line 2: nosuch: command not found\n",
			0,
		),
		// `$0` is the shell's own name while `BASH_SOURCE[0]` is the file.
		(
			"printf 'echo \"[$0] [${BASH_SOURCE[0]}]\"\\nnosuch\\n' > s2\n. ./s2\necho \"after $?\"",
			"[PFX] [./s2]\nafter 127\n",
			"./s2: line 2: nosuch: command not found\n",
			0,
		),
	]);
}

#[test]
fn outside_a_dot_file_the_shell_names_itself() {
	check(&[
		(
			"printf 'true\\n' > s2\n. ./s2\nnosuch\necho \"after $?\"",
			"after 127\n",
			"PFX: line 3: nosuch: command not found\n",
			0,
		),
		(
			"f() { nosuch; }\nf\necho \"after $?\"",
			"after 127\n",
			"PFX: line 1: nosuch: command not found\n",
			0,
		),
		// A trap a `.` file set runs after it returns.
		(
			"printf 'trap \"nosuch\" EXIT\\n' > s2\n. ./s2\necho \"after $?\"",
			"after 0\n",
			"PFX: line 1: nosuch: command not found\n",
			0,
		),
	]);
}
