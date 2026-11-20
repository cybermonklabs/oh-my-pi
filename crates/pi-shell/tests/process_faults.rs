//! A real fault in the process of a shell with an EXIT trap ends the
//! process. bash's EXIT trap catches the fault signals (`SEGV`, `BUS`, …),
//! and a real fault runs again when its handler returns: standalone, the
//! handler gives the signal its default action back on its second delivery
//! (bash's `termsig_sighandler`); embedded in a runtime, the shell catches
//! none of them, and the runtime's own handler takes the fault.
//!
//! Each case runs in a child process: this test binary again, running the
//! one test with [`CASE`] set. The child starts the shell
//! ([`pi_shell::process::main`]) on a `-c` string that sets an EXIT trap,
//! makes the file [`MARK`] names, then waits; a thread of the child writes
//! to an unmapped address once the file exists.

#![cfg(unix)]

use std::{
	io::Read as _,
	os::unix::process::ExitStatusExt,
	path::PathBuf,
	process::{Command, ExitStatus, Stdio},
	thread,
	time::{Duration, Instant},
};

/// The child's case: `standalone` or `embedded`.
const CASE: &str = "PI_SHELL_FAULT_CASE";
/// The file the script makes once its EXIT trap is set.
const MARK: &str = "PI_SHELL_FAULT_MARK";
/// The status the embedding runtime's fault handler exits with.
const RUNTIME_HANDLED: i32 = 42;
/// The script: an EXIT trap that would print `x`, the file, then a wait
/// the fault cuts short (the `sleep` left over holds no pipe of the test).
const SCRIPT: &str =
	"trap 'echo x' EXIT; : > \"$PI_SHELL_FAULT_MARK\"; /bin/sleep 5 >/dev/null 2>&1";

/// The embedding runtime's fault handler.
extern "C" fn runtime_handler(_: libc::c_int) {
	// SAFETY: `_exit` is async-signal-safe.
	unsafe { libc::_exit(RUNTIME_HANDLED) }
}

/// The child: the fault thread, then the shell; `embedded` says how it runs.
fn child(embedded: bool) -> ! {
	if embedded {
		// SAFETY: a zeroed sigaction with a handler and an emptied mask is a
		// valid disposition.
		unsafe {
			let mut action: libc::sigaction = std::mem::zeroed();
			action.sa_sigaction = runtime_handler as extern "C" fn(libc::c_int) as libc::sighandler_t;
			libc::sigemptyset(&raw mut action.sa_mask);
			libc::sigaction(libc::SIGSEGV, &raw const action, std::ptr::null_mut());
		}
	}
	let mark = PathBuf::from(std::env::var_os(MARK).expect("the mark's path"));
	thread::spawn(move || {
		while !mark.exists() {
			thread::sleep(Duration::from_millis(5));
		}
		// SAFETY: none: a deliberate fault, a write to an unmapped address.
		unsafe { std::ptr::write_volatile(std::hint::black_box(8usize) as *mut u8, 1) };
	});
	let code = pi_shell::process::main(["bash", "-c", SCRIPT], pi_shell::process::ProcessOptions {
		embedded,
	});
	std::process::exit(code)
}

/// Run test `test` again as the child of `case`: how it ended and what it
/// printed. The fault comes as soon as the mark exists; a handler that
/// returns repeats it forever, so a child still running `AFTER_MARK` after
/// the mark appeared fails the test (nextest's own timeout bounds a child
/// that never gets that far).
fn run_child(test: &str, case: &str) -> (ExitStatus, String) {
	const AFTER_MARK: Duration = Duration::from_secs(30);
	let dir = tempfile::tempdir().expect("a directory for the mark");
	let mark = dir.path().join("set");
	let mut child = Command::new(std::env::current_exe().expect("this test binary"))
		.args(["--exact", test, "--nocapture"])
		.env(CASE, case)
		.env(MARK, &mark)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::inherit())
		.spawn()
		.expect("start the child");
	let mut stdout = child.stdout.take().expect("the child's stdout");
	let reader = thread::spawn(move || {
		let mut out = String::new();
		let _ = stdout.read_to_string(&mut out);
		out
	});
	let mut marked: Option<Instant> = None;
	let status = loop {
		if let Some(status) = child.try_wait().expect("look at the child") {
			break status;
		}
		if marked.is_none() && mark.exists() {
			marked = Some(Instant::now());
		}
		if marked.is_some_and(|at| at.elapsed() > AFTER_MARK) {
			let _ = child.kill();
			let _ = child.wait();
			panic!("the child still ran {AFTER_MARK:?} after the fault: it repeats");
		}
		thread::sleep(Duration::from_millis(10));
	};
	(status, reader.join().expect("the child's output"))
}

/// The case this process runs as a child, if it is one.
fn as_child() {
	if let Some(case) = std::env::var_os(CASE) {
		child(case == "embedded");
	}
}

/// Whether the EXIT trap ran (it prints `x`).
fn trap_ran(out: &str) -> bool {
	out.lines().any(|line| line == "x")
}

#[test]
fn a_real_fault_ends_a_standalone_shell_with_an_exit_trap() {
	as_child();
	let (status, out) =
		run_child("a_real_fault_ends_a_standalone_shell_with_an_exit_trap", "standalone");
	assert_eq!(status.signal(), Some(libc::SIGSEGV), "{status}: {out}");
	assert!(!trap_ran(&out), "the process ran on after the fault: {out}");
}

#[test]
fn a_real_fault_in_an_embedded_shell_reaches_the_runtimes_handler() {
	as_child();
	let (status, out) =
		run_child("a_real_fault_in_an_embedded_shell_reaches_the_runtimes_handler", "embedded");
	assert_eq!(status.code(), Some(RUNTIME_HANDLED), "{status}: {out}");
	assert!(!trap_ran(&out), "the shell's handler took the fault first: {out}");
}
