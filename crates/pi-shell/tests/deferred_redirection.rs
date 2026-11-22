//! A background job's lone command whose redirection open would wait (a
//! FIFO without its other end) leaves that open, and the redirections after
//! it, to the process it spawns, as bash's forked child makes them: the job
//! has its pid at once. Two faults of that path, each row measured against
//! bash 5.2.21 and 5.3.20 (`bash -c`; the two agree on every row) and zsh
//! 5.9 (`zsh -f -c`):
//!
//! - A command that another runs on the job's vproc (a function's body,
//!   `eval`'s code, a sourced file's) took the job's deferral for its own: it
//!   skipped its name's lookup, so a name with a slash, or one with an
//!   assignment or a redirection of its own, was "command not found".
//! - A close-on-exec fd of the shell (`sysopen -o cloexec`) that a redirection
//!   left to the process reads (`> fifo <&$fd`) was not handed to it, so it
//!   copied whatever its own fd of that number was.
//!
//! Each row runs in a fresh directory ([`files`]) and reads the FIFO with a
//! `cat` of the shell's into a file, so its output has one order.
#![cfg(unix)]

mod obash_support;

use std::{
	fs,
	os::unix::{
		fs::{PermissionsExt, symlink},
		process::CommandExt as _,
	},
	path::Path,
};

use obash_support::{obash, output};
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// The command words a row runs, by name: each reads its stdin to its
/// stdout (`prog` is `exec /bin/cat`), or fails as it would anywhere.
const NAMES: [(&str, &str); 9] = [
	("abs", "/bin/cat"),
	("abslocal", "\"$PWD/prog\""),
	("dot", "./prog"),
	("sub", "sub/prog"),
	("link", "./lnk"),
	("linkdir", "lnkdir/prog"),
	("missing", "/nonexistent/prog"),
	("noexec", "./noexec"),
	("path", "cat"),
];

/// `job` in the background, its output the FIFO: the shell reads the FIFO
/// into `got`, then prints the job's status and what it wrote.
macro_rules! bg {
	($job:literal) => {
		concat!($job, " & cat fifo > got; wait $!; echo \"s=$?\"; cat got")
	};
}

/// Where the command runs (`N`), and the FIFO's open that waits.
const FORMS: [(&str, &str); 16] = [
	// A background function whose call's redirection waits; the same in
	// the foreground.
	("fn-call-bg", bg!("f() { N; }; f < in > fifo")),
	("fn-call-fg", "f() { N; }; cat fifo > got & f < in > fifo; echo \"s=$?\"; wait; cat got"),
	// The redirection inside the body.
	("fn-body-bg", bg!("f() { N < in > fifo; }; f")),
	("fn-body-fg", "f() { N < in > fifo; }; cat fifo > got & f; echo \"s=$?\"; wait; cat got"),
	// One on the definition, one on the call.
	("fn-def-bg", bg!("f() { N; } < in; f > fifo")),
	// The body's second command; one with an assignment.
	("fn-second-bg", bg!("f() { /bin/echo first; N; }; f < in > fifo")),
	("fn-assign-bg", bg!("f() { x=1 N; }; f < in > fifo")),
	// `eval`'s code, a sourced file's.
	("eval-bg", bg!("eval 'N' < in > fifo")),
	("source-bg", bg!("printf '%s\\n' 'N' > src; . ./src < in > fifo")),
	// The command itself, in the background and the foreground.
	("plain-bg", bg!("N < in > fifo")),
	("plain-fg", "cat fifo > got & N < in > fifo; echo \"s=$?\"; wait; cat got"),
	// A plain file in place of the FIFO.
	("fn-file-bg", "f() { N; }; f < in > plain & wait $!; echo \"s=$?\"; cat plain"),
	// A function the function calls; an `if` in the body; `builtin eval`.
	("fn-nested-bg", bg!("g() { N; }; f() { g; }; f < in > fifo")),
	("fn-if-bg", bg!("f() { if true; then N; fi; }; f < in > fifo")),
	("builtin-eval-bg", bg!("builtin eval 'N' < in > fifo")),
	// The FIFO as the function's input, which the shell writes.
	(
		"fn-in-fifo-bg",
		"f() { N; }; f < fifo > got & echo hello > fifo; wait $!; echo \"s=$?\"; cat got",
	),
];

/// Rows left out: a failed command closes the FIFO's read end whenever it
/// ends, so the shell's write races it (in bash too).
const SKIP: [(&str, &str); 2] = [("fn-in-fifo-bg", "missing"), ("fn-in-fifo-bg", "noexec")];

/// A builtin of the body with a redirection or an assignment of its own.
const BUILTINS: [(&str, &str); 2] = [
	("builtin-redir-bg", bg!("f() { echo hi 2>/dev/null; }; f > fifo")),
	("builtin-assign-bg", bg!("f() { x=1 echo hi; }; f > fifo")),
];

/// What bash (`zsh`: zsh) prints for row `form`/`name`: stdout, stderr.
fn wanted(zsh: bool, form: &str, name: &str) -> (String, String) {
	let first = if form == "fn-second-bg" {
		"first\n"
	} else {
		""
	};
	// zsh names the function in a message from its body.
	let func = match form {
		_ if !zsh => "",
		"fn-nested-bg" => "g: ",
		_ if form.starts_with("fn-") => "f: ",
		_ => "",
	};
	match name {
		"missing" => (
			format!("s=127\n{first}"),
			if zsh {
				format!("{func}no such file or directory: /nonexistent/prog\n")
			} else {
				"/nonexistent/prog: No such file or directory\n".to_owned()
			},
		),
		"noexec" => (
			format!("s=126\n{first}"),
			if zsh {
				format!("{func}permission denied: ./noexec\n")
			} else {
				"./noexec: Permission denied\n".to_owned()
			},
		),
		_ => (format!("s=0\n{first}hello\n"), String::new()),
	}
}

/// The directory a row runs in: `in`, `in2`, the FIFO `fifo`, `prog` and
/// `sub/prog` (`exec /bin/cat`), `lnk` (a link to `sub/prog`), `lnkdir` (a
/// link to `sub`) and `noexec` (a script without its execute bits).
fn files(dir: &Path) {
	fs::write(dir.join("in"), "hello\n").unwrap();
	fs::write(dir.join("in2"), "other\n").unwrap();
	let fifo =
		std::ffi::CString::new(dir.join("fifo").into_os_string().into_encoded_bytes()).unwrap();
	// SAFETY: `fifo` is a NUL-terminated path that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
	fs::create_dir(dir.join("sub")).unwrap();
	for (path, mode) in [("prog", 0o755), ("sub/prog", 0o755), ("noexec", 0o644)] {
		fs::write(dir.join(path), "#!/bin/sh\nexec /bin/cat\n").unwrap();
		fs::set_permissions(dir.join(path), fs::Permissions::from_mode(mode)).unwrap();
	}
	symlink("sub/prog", dir.join("lnk")).unwrap();
	symlink("sub", dir.join("lnkdir")).unwrap();
}

/// `text` without the `NAME: line N: ` (bash) and `NAME:N: ` (zsh)
/// prefixes, whose names differ between the shells, and with the row's
/// directory written `DIR`.
fn clean(text: &[u8], dir: &Path) -> String {
	let real = dir.canonicalize().unwrap();
	let text = String::from_utf8_lossy(text)
		.replace(&*real.to_string_lossy(), "DIR")
		.replace(&*dir.to_string_lossy(), "DIR");
	text
		.split_inclusive('\n')
		.map(|line| {
			let Some(colon) = line.find(':') else {
				return line;
			};
			let rest = &line[colon + 1..];
			let rest = rest.strip_prefix(" line ").unwrap_or(rest);
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			match rest[digits..].strip_prefix(": ") {
				Some(body) if digits > 0 && !line[..colon].contains(' ') => body,
				_ => line,
			}
		})
		.collect()
}

/// Runs each row (`id`, script, wanted stdout, wanted stderr) with obash,
/// in zsh mode for `zsh`, and asserts status 0 and the wanted outputs,
/// reporting every row that differs. The rows are independent (a directory
/// each), so a few run at once.
fn check(zsh: bool, rows: &[(String, String, String, String)]) {
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		// Every worker starts before the first is joined.
		let mut workers = Vec::with_capacity(threads);
		for chunk in rows.chunks(rows.len().div_ceil(threads).max(1)) {
			workers.push(scope.spawn(move || {
				chunk
					.iter()
					.filter_map(|row| differs(zsh, row))
					.collect::<Vec<_>>()
			}));
		}
		let mut failures = Vec::new();
		for worker in workers {
			failures.extend(worker.join().unwrap());
		}
		failures
	});
	assert!(
		failures.is_empty(),
		"{} of {} rows differ:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// How one row of [`check`] differs from what it wants, if it does.
fn differs(zsh: bool, (id, script, out, err): &(String, String, String, String)) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let mut cmd = obash();
	if zsh {
		cmd.arg0("zsh");
		cmd.arg("-f");
	}
	// `output` panics on a process past the obash tests' bound: the row hung,
	// and is reported with the others.
	let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		output(cmd.current_dir(dir.path()).arg("-c").arg(script))
	}));
	let Ok(got) = run else {
		return Some(format!(
			"{id}: `{script}`\n  want: Some(0) {out:?} {err:?}\n  got:  no end within the bound"
		));
	};
	let got = (got.status.code(), clean(&got.stdout, dir.path()), clean(&got.stderr, dir.path()));
	(got != (Some(0), out.clone(), err.clone())).then(|| {
		format!(
			"{id}: `{script}`\n  want: Some(0) {out:?} {err:?}\n  got:  {:?} {:?} {:?}",
			got.0, got.1, got.2
		)
	})
}

/// The grid of [`FORMS`] and [`NAMES`] (but [`SKIP`]) and the
/// [`BUILTINS`] rows, wanted as bash (`zsh`: zsh) runs them.
fn grid(zsh: bool) -> Vec<(String, String, String, String)> {
	let mut rows = Vec::new();
	for (form, text) in FORMS {
		for (name, word) in NAMES {
			if !SKIP.contains(&(form, name)) {
				let (out, err) = wanted(zsh, form, name);
				rows.push((format!("{form}/{name}"), text.replace('N', word), out, err));
			}
		}
	}
	for (form, text) in BUILTINS {
		rows.push((form.to_owned(), text.to_owned(), "s=0\nhi\n".to_owned(), String::new()));
	}
	rows
}

/// A command a background function runs (or `eval`, or a sourced file)
/// resolves its own name, whatever the job's redirection is waiting on: a
/// path is run, a missing one is not found (127), one without its execute
/// bits cannot run (126), as bash says.
#[test]
fn a_command_run_by_a_deferred_job_resolves_its_own_name() {
	check(false, &grid(false));
}

/// zsh mode makes a job's redirections itself (no deferral); the same grid
/// is zsh 5.9's there.
#[test]
fn a_command_run_by_a_zsh_job_resolves_its_own_name() {
	check(true, &grid(true));
}

/// The redirections after the open that waits, each with a close-on-exec
/// fd as its source, and what zsh 5.9 prints for each.
const CLOEXEC: [(&str, &str, &str); 9] = [
	("dup-bg", bg!("/bin/cat > fifo <&$fd"), "s=0\nhello\n"),
	// The dup first: the shell makes it before the open waits.
	("dup-first-bg", bg!("/bin/cat <&$fd > fifo"), "s=0\nhello\n"),
	(
		"dup-fg",
		"cat fifo > got & /bin/cat > fifo <&$fd; echo \"s=$?\"; wait; cat got",
		"s=0\nhello\n",
	),
	("dup-file-bg", "/bin/cat > plain <&$fd & wait $!; echo \"s=$?\"; cat plain", "s=0\nhello\n"),
	("devfd-bg", bg!("/bin/cat > fifo < /dev/fd/$fd"), "s=0\nhello\n"),
	// The program does not keep the fd (it is close-on-exec).
	(
		"kept-bg",
		bg!(
			"/bin/sh -c \"cat; if [ -e /dev/fd/$fd ]; then echo kept; else echo gone; fi\" > fifo \
			 <&$fd"
		),
		"s=0\nhello\ngone\n",
	),
	// Moved onto stdin (bash's `<&N-`; zsh has none: what bash prints for a
	// fd that is not close-on-exec).
	("move-bg", bg!("/bin/cat > fifo <&$fd-"), "s=0\nhello\n"),
	// A later redirection sets the fd (9): the program keeps that one.
	("reset-bg", bg!("/bin/sh -c \"cat; cat <&9\" > fifo <&9 9<in2"), "s=0\nhello\nother\n"),
	// An earlier one sets it: the dup reads that, and the program keeps it.
	("set-first-bg", bg!("/bin/sh -c \"cat; cat <&9\" > fifo 9<in2 <&9"), "s=0\nother\n"),
];

/// `CLOEXEC`'s rows, each after `open` makes the fd (`$fd`, or 9 for
/// the rows that name it), wrapped by `wrap`.
fn cloexec_rows(
	open: impl Fn(&str) -> String,
	wrap: impl Fn(&str) -> String,
	skip: &[&str],
) -> Vec<(String, String, String, String)> {
	CLOEXEC
		.iter()
		.filter(|(id, ..)| !skip.contains(id))
		.map(|&(id, text, out)| {
			let fd = if text.contains("&9") { "9" } else { "fd" };
			(id.to_owned(), format!("{}{}", open(fd), wrap(text)), out.to_owned(), String::new())
		})
		.collect()
}

/// A close-on-exec fd (`sysopen -o cloexec`, opened through `emulate zsh`)
/// that a redirection left to the process reads is the process's to read,
/// and the program does not keep it, as zsh's child dups it before its exec.
#[test]
fn a_deferred_redirection_reads_a_close_on_exec_fd_of_the_shell() {
	let open = |fd: &str| {
		format!("emulate zsh -c 'zmodload zsh/system; sysopen -r -o cloexec -u {fd} in'; ")
	};
	check(false, &cloexec_rows(open, str::to_owned, &[]));
}

/// zsh mode: zsh code makes its redirections itself (as zsh 5.9 does, but
/// `<&$fd-`, which zsh does not take); bash code (`emulate bash`) leaves
/// them to the process, and reads the fd as zsh's code does.
#[test]
fn a_zsh_shell_reads_its_close_on_exec_fd_in_bash_and_zsh_code() {
	let open = |fd: &str| format!("zmodload zsh/system; sysopen -r -o cloexec -u {fd} in; ");
	check(true, &cloexec_rows(open, str::to_owned, &["move-bg"]));
	check(true, &cloexec_rows(open, |text| format!("emulate bash -c '{text}'"), &[]));
}

/// A fd that is not close-on-exec (`exec {fd}<in`, the same in bash and
/// zsh) is the program's too.
#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "`exec {fd}<in` is the shell's fd-variable redirection, not Rust formatting."
)]
fn a_deferred_redirection_reads_an_inherited_fd_and_the_program_keeps_it() {
	let open = |fd: &str| {
		if fd == "9" {
			"exec 9<in; ".to_owned()
		} else {
			"exec {fd}<in; ".to_owned()
		}
	};
	let mut rows = cloexec_rows(open, str::to_owned, &[]);
	for row in &mut rows {
		row.2 = row.2.replace("gone", "kept");
	}
	check(false, &rows);
}

/// The bash tool's own shell: a background function's absolute command
/// whose call's redirection waits on a FIFO runs, and so does one reading a
/// fd its function's definition opens.
#[tokio::test(flavor = "multi_thread")]
async fn the_tools_shell_runs_a_deferred_functions_absolute_command() {
	for (script, want) in [
		("f() { /bin/cat; }; f < in > fifo & cat fifo; wait $!; echo \"s=$?\"", "hello\ns=0\n"),
		(
			"g() { /bin/sh -c 'cat <&3'; } 3< in; g > fifo & cat fifo; wait $!; echo \"s=$?\"",
			"hello\ns=0\n",
		),
	] {
		let dir = tempfile::tempdir().unwrap();
		files(dir.path());
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions {
					command: script.to_owned(),
					cwd: Some(dir.path().to_string_lossy().into_owned()),
					..Default::default()
				},
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		assert_eq!((result.exit_code, output.as_str()), (Some(0), want), "`{script}`");
	}
}

/// zsh mode: a `<&` word that is not a file number (`<&$fd-`, which zsh
/// does not take, among them) fails with zsh 5.9's message, which names no
/// word.
#[test]
fn a_zsh_dup_of_no_file_number_says_so_as_zsh_does() {
	let rows: Vec<_> = ["cat <&abc", "cat <&10-", "cat <&3x", "cat <&\"\""]
		.into_iter()
		.map(|text| {
			let script = format!("{text}; echo \"s=$?\"");
			(text.to_owned(), script, "s=1\n".to_owned(), "file number expected\n".to_owned())
		})
		.collect();
	check(true, &rows);
}
