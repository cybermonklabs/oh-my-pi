//! A background job's lone command whose redirection open would wait (a
//! FIFO without its other end) leaves that open, and the redirections after
//! it, to the process it spawns, as bash's forked child makes them. When one
//! of those later redirections fails (a fd not open, an ambiguous word, an
//! expansion error), bash's child has already made the open that waits, so
//! the FIFO's other end sees it, and then reports the failure itself. The
//! shell failed it before any process existed: nothing opened the FIFO, and
//! its reader waited for ever. Each row's output is the one bash 5.2.21 and
//! 5.3.20 agree on, the row run as a script file (`bash ./s.sh`; under
//! `bash -c` both exit 127 for the `${x:?}` row, a difference of `-c` that
//! is not this one).
//!
//! The FIFO's reader is the shell's own `cat`: a row that hangs is reported
//! as hung once the obash tests' bound kills it.
#![cfg(unix)]

mod obash_support;

use std::{fs, path::Path};

use obash_support::{obash, output};
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// `job` in the background, its output the FIFO: the shell reads the FIFO,
/// then prints the job's status.
macro_rules! bg {
	($job:literal) => {
		concat!($job, " & cat fifo; wait $!; echo \"s=$?\"")
	};
}

/// Each row: id, script, bash's stdout, bash's stderr (prefixes removed).
const ROWS: [(&str, &str, &str, &str); 16] = [
	// A fd that is not open.
	("badfd-in", bg!("/bin/cat > fifo <&7"), "s=1\n", "7: Bad file descriptor\n"),
	("badfd-out", bg!("/bin/cat < in > fifo 2>&7"), "s=1\n", "7: Bad file descriptor\n"),
	(
		"closed-fd",
		bg!("exec 6<in; exec 6<&-; /bin/cat > fifo <&6"),
		"s=1\n",
		"6: Bad file descriptor\n",
	),
	// A word with no field or several.
	("ambiguous-in", bg!("v=\"a b\"; /bin/cat > fifo < $v"), "s=1\n", "$v: ambiguous redirect\n"),
	(
		"ambiguous-out",
		bg!("v=\"a b\"; /bin/cat < in > fifo 2> $v"),
		"s=1\n",
		"$v: ambiguous redirect\n",
	),
	("ambiguous-empty", bg!("e=; /bin/cat > fifo < $e"), "s=1\n", "$e: ambiguous redirect\n"),
	("ambiguous-glob", bg!("/bin/cat > fifo < *.txt"), "s=1\n", "*.txt: ambiguous redirect\n"),
	(
		"ambiguous-dup",
		bg!("v=\"1 2\"; /bin/cat < in > fifo 2>&$v"),
		"s=1\n",
		"$v: ambiguous redirect\n",
	),
	// An expansion error.
	("unset-error", bg!("/bin/cat > fifo < ${x:?unset}"), "s=1\n", "x: unset\n"),
	(
		"arith-error",
		bg!("/bin/cat > fifo < $((1/0))"),
		"s=1\n",
		"1/0: division by 0 (error token is \"0\")\n",
	),
	// The message goes to the stderr the redirections before it made.
	(
		"stderr-before",
		"/bin/cat 2> err > fifo <&7 & cat fifo; wait $!; echo \"s=$?\"; cat err",
		"s=1\n7: Bad file descriptor\n",
		"",
	),
	(
		"stderr-after",
		"/bin/cat > fifo <&7 2> err & cat fifo; wait $!; echo \"s=$?\"; cat err 2>/dev/null || echo \
		 no-err",
		"s=1\nno-err\n",
		"7: Bad file descriptor\n",
	),
	// The FIFO as input. Its writer is a program of its own: the process
	// ends right after it opens the FIFO, so the writer may die of
	// `SIGPIPE`, which must not take the shell (in bash as here).
	(
		"input-fifo",
		"/bin/cat < fifo > got <&7 & /bin/sh -c 'echo hello > fifo' 2>/dev/null; wait $!; echo \
		 \"s=$?\"; cat got 2>/dev/null || echo no-got",
		"s=1\n",
		"7: Bad file descriptor\n",
	),
	// Two FIFOs, the message through the second.
	(
		"two-fifos",
		"/bin/cat > fifo 2> fifo2 <&7 & cat fifo2 & cat fifo; wait; echo done",
		"7: Bad file descriptor\ndone\n",
		"",
	),
	// Controls: no failure; an open the process fails itself.
	("ok", "/bin/cat < in > fifo & cat fifo; wait $!; echo \"s=$?\"", "hello\ns=0\n", ""),
	(
		"open-fails",
		bg!("/bin/cat > fifo < nosuchfile"),
		"s=1\n",
		"nosuchfile: No such file or directory\n",
	),
];

/// The directory a row runs in: `in`, empty `a.txt` and `b.txt`, the FIFOs
/// `fifo` and `fifo2`.
fn files(dir: &Path) {
	fs::write(dir.join("in"), "hello\n").unwrap();
	fs::write(dir.join("a.txt"), "").unwrap();
	fs::write(dir.join("b.txt"), "").unwrap();
	for name in ["fifo", "fifo2"] {
		let fifo =
			std::ffi::CString::new(dir.join(name).into_os_string().into_encoded_bytes()).unwrap();
		// SAFETY: `fifo` is a NUL-terminated path that outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo {name}");
	}
}

/// `text` without the `NAME: line N: ` prefixes, whose names differ between
/// bash and obash.
fn clean(text: &[u8]) -> String {
	String::from_utf8_lossy(text)
		.split_inclusive('\n')
		.map(|line| {
			let Some(at) = line.find(": line ") else {
				return line;
			};
			let rest = &line[at + ": line ".len()..];
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			match rest[digits..].strip_prefix(": ") {
				Some(body) if digits > 0 && !line[..at].contains(' ') => body,
				_ => line,
			}
		})
		.collect()
}

/// How row `(id, script, out, err)` differs from bash, if it does: the
/// script run as a file.
fn differs(&(id, script, out, err): &(&str, &str, &str, &str)) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	fs::write(dir.path().join("s.sh"), format!("{script}\n")).unwrap();
	// `output` panics on a process past the obash tests' bound: the row hung,
	// and is reported with the others.
	let run = std::panic::catch_unwind(|| output(obash().current_dir(dir.path()).arg("./s.sh")));
	let Ok(got) = run else {
		return Some(format!(
			"{id}: `{script}`\n  bash: Some(0) {out:?} {err:?}\n  got:  no end within the bound"
		));
	};
	let got = (got.status.code(), clean(&got.stdout), clean(&got.stderr));
	(got != (Some(0), out.to_owned(), err.to_owned())).then(|| {
		format!(
			"{id}: `{script}`\n  bash: Some(0) {out:?} {err:?}\n  got:  {:?} {:?} {:?}",
			got.0, got.1, got.2
		)
	})
}

/// A redirection that fails after the open the job's process makes itself
/// is the process's failure, as in bash: the FIFO is opened, its reader
/// sees end of file, and the message and status are bash's.
#[test]
fn a_failing_redirection_after_a_deferred_open_still_opens_the_fifo() {
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		// Every worker starts before the first is joined.
		let mut workers = Vec::with_capacity(threads);
		for chunk in ROWS.chunks(ROWS.len().div_ceil(threads)) {
			workers.push(scope.spawn(move || chunk.iter().filter_map(differs).collect::<Vec<_>>()));
		}
		let mut failures = Vec::new();
		for worker in workers {
			failures.extend(worker.join().unwrap());
		}
		failures
	});
	assert!(
		failures.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		failures.len(),
		ROWS.len(),
		failures.join("\n")
	);
}

/// The bash tool's own shell, the row whose message goes to a file (the
/// tool reads the job's stderr and the shell's stdout as one stream).
#[tokio::test(flavor = "multi_thread")]
async fn the_tools_shell_opens_the_fifo_of_a_job_whose_redirection_fails() {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let (tx, rx) = flume::unbounded::<String>();
	let result = Shell::new(None)
		.run(
			ShellRunOptions {
				command: ROWS
					.iter()
					.find(|r| r.0 == "stderr-before")
					.unwrap()
					.1
					.to_owned(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run");
	let output = clean(rx.drain().collect::<String>().as_bytes());
	assert_eq!((result.exit_code, output.as_str()), (Some(0), "s=1\n7: Bad file descriptor\n"));
}
