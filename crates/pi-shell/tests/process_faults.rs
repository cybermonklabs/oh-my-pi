//! A real fault in the process of a shell with an EXIT trap. bash's EXIT
//! trap catches the fault signals (`SEGV`, `BUS`, `SYS`, …). One an
//! instruction raises before it completes runs again when its handler
//! returns: standalone, the handler gives the signal its default action back
//! at once and raises it again, not handing it to the shell, so the process
//! ends by it whichever thread runs first, and the trap does not run;
//! embedded in a runtime, the shell catches none of them, and the runtime's
//! own handler takes the fault. (bash 5.2.21, with the same fault in a
//! thread of its process, runs the trap first in most runs but not all: its
//! fault thread races the repeat itself; a known difference.) One raised
//! once its instruction has run does not repeat (a system call a seccomp
//! filter traps, `SIGSYS`): the shell takes it as bash does, runs its EXIT
//! trap, then dies of it. A general-protection fault (x86-64: an address
//! that is not canonical) repeats too, though Linux gives its `SEGV` no
//! fault's code (`SI_KERNEL`).
//!
//! Each case runs in a child process: this test binary again, running the
//! one test with [`CASE`] set. The child starts the shell
//! ([`pi_shell::process::main`]) on a `-c` string that sends its output to
//! a file of the test's, sets an EXIT trap, makes the file [`MARK`] names,
//! then waits; a thread of the child faults once the file exists: a write
//! to an unmapped address, (`noncanonical`) a write to an address that is
//! not canonical, or (`syscall`) a system call its seccomp filter traps.

#![cfg(unix)]

use std::{
	fs,
	io::Read as _,
	os::unix::process::ExitStatusExt,
	path::PathBuf,
	process::{Command, ExitStatus, Stdio},
	thread,
	time::{Duration, Instant},
};

/// The child's case: `standalone`, `embedded`, `noncanonical` or `syscall`.
const CASE: &str = "PI_SHELL_FAULT_CASE";
/// The file the script makes once its EXIT trap is set.
const MARK: &str = "PI_SHELL_FAULT_MARK";
/// The status the embedding runtime's fault handler exits with.
const RUNTIME_HANDLED: i32 = 42;
/// The script: its output to the mark's `.out` file, an EXIT trap that
/// would print `x` there, the mark, then a wait the fault cuts short (the
/// `sleep` left over holds no pipe of the test). Not to the child's stdout:
/// libtest running one test thread prints `test NAME ... ` with no newline
/// before the test runs, and the trap's `x` would end that line.
const SCRIPT: &str = "exec >\"$PI_SHELL_FAULT_MARK.out\"; trap 'echo x' EXIT; : > \
                      \"$PI_SHELL_FAULT_MARK\"; /bin/sleep 5 >/dev/null 2>&1";

/// The embedding runtime's fault handler.
extern "C" fn runtime_handler(_: libc::c_int) {
	// SAFETY: `_exit` is async-signal-safe.
	unsafe { libc::_exit(RUNTIME_HANDLED) }
}

/// The child: the fault thread, then the shell; `case` says how it runs
/// and faults.
fn child(case: &str) -> ! {
	let embedded = case == "embedded";
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
	let fault: fn() = match case {
		"standalone" | "embedded" => unmapped_write,
		"noncanonical" => non_canonical_write,
		"syscall" => trapped_syscall,
		other => panic!("no case {other}"),
	};
	let mark = PathBuf::from(std::env::var_os(MARK).expect("the mark's path"));
	thread::spawn(move || {
		while !mark.exists() {
			thread::sleep(Duration::from_millis(5));
		}
		fault();
	});
	let exit = pi_shell::process::main(["bash", "-c", SCRIPT], pi_shell::process::ProcessOptions {
		embedded,
	});
	std::process::exit(exit.end())
}

/// A fault an instruction raises before it completes: a write to an
/// unmapped address (`SEGV_MAPERR`).
fn unmapped_write() {
	// SAFETY: none: a deliberate fault, a write to an unmapped address.
	unsafe { std::ptr::write_volatile(std::hint::black_box(8usize) as *mut u8, 1) };
}

/// A general-protection fault, which an instruction raises before it
/// completes: a write to an address that is not canonical (bit 63 set, the
/// bits below it clear: with 4- or 5-level paging alike), which x86-64
/// Linux raises as `SEGV` with `SI_KERNEL`, not a fault's code.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn non_canonical_write() {
	// SAFETY: none: a deliberate fault, a write to an address that is not
	// canonical.
	unsafe {
		std::ptr::write_volatile(std::hint::black_box(0x8000_0000_0000_0000usize) as *mut u8, 1);
	}
}

/// Other targets: the `noncanonical` case runs on x86-64 Linux only.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
fn non_canonical_write() {
	unreachable!("the noncanonical case runs on x86-64 Linux only");
}

/// A fault raised once its instruction has run: a seccomp filter on this
/// thread alone traps its `getppid` (`SECCOMP_RET_TRAP`), which raises
/// `SIGSYS` (`SYS_SECCOMP`) in place of the call; the thread then goes on.
#[cfg(target_os = "linux")]
fn trapped_syscall() {
	#[expect(clippy::cast_possible_truncation, reason = "BPF codes and a syscall number")]
	let filter = [
		libc::sock_filter {
			code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
			jt:   0,
			jf:   0,
			k:    0,
		},
		libc::sock_filter {
			code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
			jt:   0,
			jf:   1,
			k:    libc::SYS_getppid as u32,
		},
		libc::sock_filter {
			code: (libc::BPF_RET | libc::BPF_K) as u16,
			jt:   0,
			jf:   0,
			k:    libc::SECCOMP_RET_TRAP,
		},
		libc::sock_filter {
			code: (libc::BPF_RET | libc::BPF_K) as u16,
			jt:   0,
			jf:   0,
			k:    libc::SECCOMP_RET_ALLOW,
		},
	];
	let program = libc::sock_fprog { len: 4, filter: filter.as_ptr().cast_mut() };
	// SAFETY: prctl takes the documented arguments; the filter outlives the
	// call that installs it; getppid takes none.
	unsafe {
		assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0, "no new privileges");
		assert_eq!(
			libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &raw const program),
			0,
			"the seccomp filter: {}",
			std::io::Error::last_os_error()
		);
		libc::syscall(libc::SYS_getppid);
	}
}

/// Other systems have no seccomp: the `syscall` case runs on Linux only.
#[cfg(not(target_os = "linux"))]
fn trapped_syscall() {
	unreachable!("the syscall case runs on Linux only");
}

/// Run test `test` again as the child of `case`: how it ended, what its
/// script wrote (the mark's `.out` file: the trap's `x`, if it ran) and
/// what it printed. The fault comes as soon as the mark exists; a handler
/// that returns repeats it forever, so a child still running `AFTER_MARK`
/// after the mark appeared fails the test (nextest's own timeout bounds a
/// child that never gets that far).
fn run_child(test: &str, case: &str) -> (ExitStatus, String, String) {
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
	let printed = reader.join().expect("the child's output");
	let out = mark.with_extension("out");
	let out = fs::read_to_string(&out).unwrap_or_else(|err| {
		panic!("{status}: the script's output {}: {err}: {printed}", out.display())
	});
	(status, out, printed)
}

/// The case this process runs as a child, if it is one.
fn as_child() {
	if let Some(case) = std::env::var_os(CASE) {
		child(case.to_str().expect("a case name"));
	}
}

#[test]
fn a_real_fault_ends_a_standalone_shell_with_an_exit_trap() {
	as_child();
	let (status, out, printed) =
		run_child("a_real_fault_ends_a_standalone_shell_with_an_exit_trap", "standalone");
	assert_eq!(status.signal(), Some(libc::SIGSEGV), "{status}: {printed}");
	assert_eq!(out, "", "the process ran on after the fault: {printed}");
}

/// A general-protection fault (a write to an address that is not
/// canonical) repeats as any other fault, though Linux gives its `SEGV` no
/// fault's code (`SI_KERNEL`): the process ends by it at once, and the EXIT
/// trap does not run. Handed to the shell, the fault would let the trap run
/// first in some runs and not others: this test fails only in those.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[test]
fn a_general_protection_fault_ends_a_standalone_shell_with_an_exit_trap() {
	as_child();
	let (status, out, printed) = run_child(
		"a_general_protection_fault_ends_a_standalone_shell_with_an_exit_trap",
		"noncanonical",
	);
	assert_eq!(status.signal(), Some(libc::SIGSEGV), "{status}: {printed}");
	assert_eq!(out, "", "the process ran on after the fault: {printed}");
}

#[test]
fn a_real_fault_in_an_embedded_shell_reaches_the_runtimes_handler() {
	as_child();
	let (status, out, printed) =
		run_child("a_real_fault_in_an_embedded_shell_reaches_the_runtimes_handler", "embedded");
	assert_eq!(status.code(), Some(RUNTIME_HANDLED), "{status}: {printed}");
	assert_eq!(out, "", "the shell's handler took the fault first: {printed}");
}

/// A fault that does not repeat (`SIGSYS` from a trapped system call) is
/// the shell's, as bash takes it: the EXIT trap runs, then the shell dies
/// of the signal (bash `termsig_handler`).
#[cfg(target_os = "linux")]
#[test]
fn a_trapped_system_call_runs_the_exit_trap_then_ends_the_shell() {
	as_child();
	let (status, out, printed) =
		run_child("a_trapped_system_call_runs_the_exit_trap_then_ends_the_shell", "syscall");
	assert_eq!(status.signal(), Some(libc::SIGSYS), "{status}: {printed}");
	assert_eq!(out, "x\n", "the EXIT trap's output: {printed}");
}
