//! The interactive reader and the line editor of `obash` invoked as
//! `zsh -f -i`, against the real `/bin/zsh -f -i` on the same pty session
//! (same keys, same rc file): the final screens must match.
//!
//! Each case types keys with short pauses (zsh skips redisplays while keys
//! are queued), waits for the output to settle, and compares what the
//! terminal shows.

#![cfg(unix)]

mod pty_support;

use std::{io, thread, time::Duration};

use pty_support::{Pty, Spawn, TIMEOUT, differential, have_real_zsh};

/// The pause between keys.
const KEY: Duration = Duration::from_millis(60);
/// How long output must stay quiet before the screen is read.
const QUIET: Duration = Duration::from_millis(300);

/// `zsh -f -i` with `PS1`/`RPS1` and the rc file `rc` (sourced with `.`
/// as the first command, since `-f` skips `.zshrc`).
fn spawn(real: bool, rc: &str) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "%~ %# ")
		.env("RPS1", "[%?]")
		.rc_file(".zshrc", rc)
		.size(24, 80)
}

/// Type `text` key by key.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.type_keys(text, KEY)?;
	pty.settle(QUIET, TIMEOUT)
}

/// Run `drive` against both shells after sourcing the rc file; the final
/// screens (`None` for zsh when it is not installed).
fn screens(
	rc: &str,
	drive: impl Fn(&mut Pty) -> io::Result<()>,
) -> io::Result<(String, Option<String>)> {
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.settle(QUIET, TIMEOUT)?;
		if !rc.is_empty() {
			keys(pty, ". ~/.zshrc\r")?;
			// A clean screen for the case itself.
			keys(pty, "\x0c")?;
		}
		drive(pty)
	};
	if !have_real_zsh() {
		let mut ours = spawn(false, rc).spawn()?;
		run(&mut ours)?;
		return Ok((ours.screen().contents(), None));
	}
	let (ours, real) = differential(spawn(false, rc), spawn(true, rc), run)?;
	Ok((ours, Some(real)))
}

/// Assert both screens are the same.
fn same(rc: &str, drive: impl Fn(&mut Pty) -> io::Result<()>) {
	let (ours, real) = match screens(rc, drive) {
		Ok(s) => s,
		Err(e) => panic!("pty session failed: {e}"),
	};
	if let Some(real) = real {
		assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
	}
}

#[test]
fn prompt_and_rprompt_render() {
	same("", |pty| keys(pty, "echo hi\r"));
}

#[test]
fn zsh_prompt_substitutions_resume_both_sides() {
	// A parked right prompt must not discard the left prompt's replay
	// results, rerun its command, or prevent the editor accepting a line.
	let rc = "setopt promptsubst\nPS1='$(print -rn -- LEFT)> '\nRPS1='<$(print -rn -- RIGHT)>'\n";
	same(rc, |pty| keys(pty, "echo accepted\r"));
}

#[test]
fn typing_editing_and_accept() {
	// ^B back a char, ^A start, ^E end, ^H delete backwards, ^D delete
	// under the cursor, ^K kill to the end, ^Y yank it back.
	same("", |pty| keys(pty, "echo helo\x02l\x01x\x04\x05 there\x08\x08\x08\x08\x08\x0b\x19!\r"));
}

#[test]
fn continuation_prompt_shows_open_constructs() {
	same("PS2='%_> '", |pty| keys(pty, "if true\rthen echo \"a\rb\"\rfi\r"));
}

#[test]
fn precmd_and_preexec_order_and_arguments() {
	let rc = "precmd() { print -r -- \"precmd $?\" }\npreexec() { print -r -- \"preexec <$1> <$2> \
	          <$3>\" }\nprecmd_functions=(p2)\np2() { print -r -- p2 }\n";
	same(rc, |pty| keys(pty, "false; echo a\r"));
}

#[test]
fn user_widget_edits_buffer_and_cursor() {
	let rc = "w() { BUFFER=\"X$BUFFER\"; CURSOR=1 }\nzle -N w\nbindkey '^T' w\n";
	same(rc, |pty| keys(pty, "echo abc\x14Y\r"));
}

#[test]
fn widget_listing_and_keymap_parameters() {
	let rc = "zle -N foo bar\nzle -N baz\n";
	same(rc, |pty| keys(pty, "zle -l; zle -lL; print ${widgets[foo]} ${+keymaps[emacs]}\r"));
}

#[test]
fn zle_fd_handler_fires() {
	// `/dev/null` is always readable: the handler runs as soon as the
	// editor waits for a key, once (it removes itself).
	let rc = "exec {pfd}</dev/null\nh() { zle -I; print -r -- \"fired $# $(( $1 == pfd ))\"; zle \
	          -F $1; }\nzle -F $pfd h\n";
	same(rc, |pty| {
		thread::sleep(Duration::from_millis(300));
		pty.settle(QUIET, TIMEOUT)?;
		keys(pty, "zle -F; echo after\r")
	});
}

#[test]
fn ctrl_c_abandons_the_line() {
	same("", |pty| keys(pty, "echo abc\x03echo $?\r"));
}

#[test]
fn ctrl_c_abandons_a_continued_command() {
	same("PS2='%_> '", |pty| keys(pty, "if true\recho x\x03echo $?\r"));
}

#[test]
fn resize_redraws() {
	same("", |pty| {
		keys(pty, "echo a long line of text")?;
		pty.resize(24, 40)?;
		pty.settle(QUIET, TIMEOUT)?;
		keys(pty, "\rprint $COLUMNS\r")
	});
}

#[test]
fn vared_edits_a_parameter() {
	same("x=hello\n", |pty| {
		keys(pty, "vared x\r")?;
		keys(pty, " world\r")?;
		keys(pty, "print -r -- $x\r")
	});
}

/// A byte read past a key sequence (`^X` bound, `^Xe` not) is pushed back
/// and starts the next line (zsh's `kungetbuf` outlives the line).
#[test]
fn bytes_after_an_accepting_prefix_key_start_the_next_line() {
	same("bindkey '^X' accept-line\n", |pty| keys(pty, "echo one\x18echo two\r"));
}

/// `read -k` in a widget takes its key through the editor.
#[test]
fn read_k_in_a_widget_reads_a_key() {
	let rc = "w() { read -k 1 x; BUFFER+=\"<$x>\" }\nzle -N w\nbindkey '^T' w\n";
	same(rc, |pty| keys(pty, "echo ab\x14q\r"));
}

#[test]
fn print_z_stacks_the_next_line() {
	same("", |pty| keys(pty, "print -z echo stacked\r\r"));
}

#[test]
fn eof_on_an_empty_line_exits() {
	let s = Spawn::zsh()
		.args(["-f", "-i"])
		.env("PS1", "> ")
		.size(24, 80);
	let mut pty = match s.spawn() {
		Ok(p) => p,
		Err(e) => panic!("spawn failed: {e}"),
	};
	let r = pty
		.wait_raw(TIMEOUT)
		.and_then(|()| keys(&mut pty, "\x04"))
		.and_then(|()| pty.wait(TIMEOUT));
	match r {
		Ok(status) => assert_eq!(status.code(), Some(0)),
		Err(e) => panic!("shell did not exit on ^D: {e}"),
	}
}

#[test]
fn ignoreeof_warns() {
	same("setopt ignoreeof\n", |pty| keys(pty, "\x04"));
}

// Failure mode (review of #111 at 2fb85be7): the interactive shell hands
// WINCH to its line editor (`zle::signal`), which unparks the shell, and the
// WINCH trap then ran under the key of the command it interrupted. Through
// a tee (`exec 3>fifo 3>/dev/null`) the tee took the command's progress as
// the trap's: the trap's bytes were lost and the command's first bytes went
// out twice. Failure mode (review of #111 at 5cf0e434, from #157's review):
// the trap then ran at once and its bytes came at 65,536, inside the
// command's. zsh 5.9 (interactive, through a multios and to a FIFO) and
// bash 5.2.21 and 5.3.20 run a WINCH trap only once the command's write
// ends: its marker shows when the reader drains, and its bytes come after
// all of the command's. (zsh's multios is a process behind a pipe of its
// own: with 131,072 bytes, the FIFO and that pipe hold them all, so zsh's
// `printf` never waits there; with 262,144 it waits, and the trap waits.)
#[test]
#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
fn a_winch_trap_during_a_write_through_a_tee_writes_each_byte_once() {
	use std::{
		fs::File,
		io::Read,
		os::{fd::AsRawFd, unix::ffi::OsStrExt},
		time::Instant,
	};
	const ZEROS: usize = 131_072;
	const MARK: &[u8] = b"TTTTTTTTTT";
	let s = Spawn::zsh()
		.args(["-f", "-i"])
		.env("PS1", "P> ")
		.size(24, 80);
	let fifo = s.home().join("tee-fifo");
	let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
	// SAFETY: a valid C string.
	assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
	let mut pty = s.spawn().unwrap_or_else(|e| panic!("spawn failed: {e}"));
	pty.wait_screen_contains("P>", TIMEOUT).unwrap();
	// The reader's open waits for the shell's.
	let opening = {
		let fifo = fifo.clone();
		thread::spawn(move || File::open(fifo))
	};
	pty.write(format!(
		"exec 3>{} 3>/dev/null; trap 'print -n trap-$((40+2)) >&2; printf %s TTTTTTTTTT >&3' WINCH\r",
		fifo.display()
	))
	.unwrap();
	let mut reader = opening.join().unwrap().unwrap();
	// SAFETY: fcntl on a descriptor this test owns.
	unsafe {
		let flags = libc::fcntl(reader.as_raw_fd(), libc::F_GETFL);
		libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
	}
	pty.write(format!("printf %0{ZEROS}d 0 >&3; print -r -- printf-$((6*7))\r"))
		.unwrap();
	// `printf` filled the FIFO and waits for room.
	let queued = || {
		let mut n: libc::c_int = 0;
		// SAFETY: FIONREAD writes one int.
		unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut n) };
		usize::try_from(n).unwrap_or(0)
	};
	let start = Instant::now();
	while queued() < 4096 && start.elapsed() < TIMEOUT {
		thread::sleep(Duration::from_millis(5));
	}
	thread::sleep(QUIET);
	// WINCH to the shell. Its trap waits for `printf`'s write, so nothing
	// shows on the terminal while the FIFO stays full.
	pty.resize(30, 100).unwrap();
	thread::sleep(QUIET);
	assert!(
		!pty.screen().contents().contains("trap-42"),
		"the WINCH trap ran while `printf`'s write waited"
	);
	let mut got = Vec::new();
	let mut buf = vec![0u8; 4 << 10];
	let start = Instant::now();
	while got.len() < ZEROS + MARK.len() && start.elapsed() < TIMEOUT {
		match reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => got.extend_from_slice(&buf[..n]),
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => {},
			Err(e) => panic!("reading the FIFO: {e}"),
		}
		thread::sleep(Duration::from_micros(500));
	}
	pty.wait_screen_contains("printf-42", TIMEOUT).unwrap();
	pty.wait_screen_contains("trap-42", TIMEOUT).unwrap();
	let at = got.windows(MARK.len()).position(|w| w == MARK);
	let zeros = got.iter().filter(|&&b| b == b'0').count();
	assert_eq!(
		(zeros, got.len(), at),
		(ZEROS, ZEROS + MARK.len(), Some(ZEROS)),
		"('0's, bytes, the trap's bytes at): the trap writes after all of the command's"
	);
}

/// A `zsh -f -i` with fd 3 a tee (`exec 3>fifo 3>/dev/null`), and the
/// FIFO's reader (non-blocking); `command` is typed, and its write through
/// fd 3 waits for room in the full FIFO.
fn tee_fifo_writer(command: &str) -> (Pty, std::fs::File) {
	let (pty, reader, _) = tee_fifo_and_file_writer(command, false);
	(pty, reader)
}

/// [`tee_fifo_writer`], the tee's second target a file in the shell's home
/// (with `file`; else `/dev/null`): also the file's path. A tee writes to a
/// file at once, so the file shows a write made twice.
fn tee_fifo_and_file_writer(command: &str, file: bool) -> (Pty, std::fs::File, std::path::PathBuf) {
	use std::{
		fs::File,
		os::{fd::AsRawFd, unix::ffi::OsStrExt},
		time::Instant,
	};
	let s = Spawn::zsh()
		.args(["-f", "-i"])
		.env("PS1", "P> ")
		.size(24, 80);
	let second = if file {
		s.home().join("tee-file")
	} else {
		"/dev/null".into()
	};
	let fifo = s.home().join("tee-fifo");
	let path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
	// SAFETY: a valid C string.
	assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0, "mkfifo");
	let mut pty = s.spawn().unwrap_or_else(|e| panic!("spawn failed: {e}"));
	pty.wait_screen_contains("P>", TIMEOUT).unwrap();
	// The reader's open waits for the shell's.
	let opening = {
		let fifo = fifo.clone();
		thread::spawn(move || File::open(fifo))
	};
	pty.write(format!("exec 3>{} 3>{}\r", fifo.display(), second.display()))
		.unwrap();
	let reader = opening.join().unwrap().unwrap();
	// SAFETY: fcntl on a descriptor this test owns.
	unsafe {
		let flags = libc::fcntl(reader.as_raw_fd(), libc::F_GETFL);
		libc::fcntl(reader.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
	}
	pty.write(format!("{command}\r")).unwrap();
	let queued = || {
		let mut n: libc::c_int = 0;
		// SAFETY: FIONREAD writes one int.
		unsafe { libc::ioctl(reader.as_raw_fd(), libc::FIONREAD, &mut n) };
		usize::try_from(n).unwrap_or(0)
	};
	let start = Instant::now();
	while queued() < 4096 && start.elapsed() < TIMEOUT {
		thread::sleep(Duration::from_millis(5));
	}
	thread::sleep(QUIET);
	(pty, reader, second)
}

/// Drain `reader` 4 KiB at a time on a thread until it is empty after
/// `stop`; what it read.
fn drain_fifo(
	mut reader: std::fs::File,
	stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
	use std::{io::Read, sync::atomic::Ordering, time::Instant};
	thread::spawn(move || {
		let mut got = Vec::new();
		let mut buf = vec![0u8; 4 << 10];
		let start = Instant::now();
		loop {
			match reader.read(&mut buf) {
				Ok(0) => break,
				Ok(n) => got.extend_from_slice(&buf[..n]),
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
					if stop.load(Ordering::SeqCst) || start.elapsed() > TIMEOUT * 4 {
						break;
					}
				},
				Err(e) => panic!("reading the FIFO: {e}"),
			}
			thread::sleep(Duration::from_micros(500));
		}
		got
	})
}

// Failure mode (review of #111 at 5773e4ed): Ctrl-C dropped `printf`, whose
// write through a tee waited for room, and the tee kept that write's
// progress under the shell's write key: the next command's write through
// the tee started at those offsets and was lost (`AFTER-42` never reached
// the FIFO). It was so at 9058ab9d too. The dropped command takes the key
// with it: the FIFO gets the '0's written before Ctrl-C, then `AFTER-42`.
#[test]
#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
fn ctrl_c_during_a_write_through_a_tee_leaves_the_next_write_whole() {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};
	let (mut pty, reader) = tee_fifo_writer("printf %0131072d 0 >&3");
	pty.write("\x03").unwrap();
	pty.write("print -r -- int-$((40+2))\r").unwrap();
	pty.wait_screen_contains("int-42", TIMEOUT).unwrap();
	let stop = Arc::new(AtomicBool::new(false));
	let draining = drain_fifo(reader, Arc::clone(&stop));
	pty.write("print -rn -- AFTER-$((40+2)) >&3; print -r -- done-$((6*7))\r")
		.unwrap();
	pty.wait_screen_contains("done-42", TIMEOUT).unwrap();
	stop.store(true, Ordering::SeqCst);
	let got = draining.join().unwrap();
	let zeros = got.iter().filter(|&&b| b == b'0').count();
	assert!(
		got.ends_with(b"AFTER-42") && zeros + 8 == got.len() && zeros > 0 && zeros < 131_072,
		"{zeros} '0's of {} bytes, ending {:?}",
		got.len(),
		String::from_utf8_lossy(&got[got.len().saturating_sub(16)..])
	);
}

// Failure mode: Ctrl-Z stopped `cat` in `cat | printf … >&3`, whose last
// stage zsh runs in the shell itself, while `printf`'s write through a tee
// waited. The shell moved `printf` into the stopped job, which wrote on with
// a key of its own: the tee took it for a new writer and wrote its first
// bytes again, and the shell's next write through the tee, under the old
// key, started at the moved write's offsets and was lost. The job takes
// the keys its ops write with, and the shell goes on with a new one: each
// '0' once, and `AFTER-42` once.
#[test]
#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
fn ctrl_z_during_a_write_through_a_tee_keeps_each_byte_once() {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};
	let (mut pty, reader) = tee_fifo_writer("cat | printf %0131072d 0 >&3");
	pty.write("\x1a").unwrap();
	pty.wait_screen_contains("suspended", TIMEOUT).unwrap();
	let stop = Arc::new(AtomicBool::new(false));
	let draining = drain_fifo(reader, Arc::clone(&stop));
	pty.write("print -rn -- AFTER-$((40+2)) >&3; print -r -- done-$((6*7))\r")
		.unwrap();
	pty.wait_screen_contains("done-42", TIMEOUT).unwrap();
	pty.write("fg; print -r -- fg-$((6*7))\r").unwrap();
	// The job has the terminal: `cat` reads it until end of file.
	pty.wait_screen_contains("continued", TIMEOUT).unwrap();
	thread::sleep(QUIET);
	pty.write("\x04").unwrap();
	pty.wait_screen_contains("fg-42", TIMEOUT).unwrap();
	stop.store(true, Ordering::SeqCst);
	let got = draining.join().unwrap();
	let zeros = got.iter().filter(|&&b| b == b'0').count();
	let afters = got.windows(8).filter(|w| *w == b"AFTER-42").count();
	assert_eq!((zeros, afters, got.len()), (131_072, 1, 131_072 + 8), "('0's, AFTER-42s, bytes)");
}

// Failure mode (found in round 8): Ctrl-Z stopped `cat` in `cat | nosuch 2>&3`
// while the shell's "command not found" for `nosuch`, queued in its
// `Vproc::out`, waited for room in a tee. The shell undid the stopped
// command's redirections and went on writing its queue: the 64 KiB in the
// FIFO were never finished, and the whole message went to the terminal.
// zsh's stopped child finishes its write where it started, once continued.
// The job takes the part-way queued write with its key: the FIFO gets the
// message once, with `AFTER-42` (written while the job is stopped) inside
// it, and the terminal gets none of it.
#[test]
#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
fn ctrl_z_during_a_queued_diagnostic_through_a_tee_writes_it_once() {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};
	let (mut pty, reader) = tee_fifo_writer("cat | $(printf %0131072d 0) 2>&3");
	pty.write("\x1a").unwrap();
	// Lost to the terminal, the message scrolls `suspended` off the screen:
	// this wait times out on a screen of '0's (5773e4ed).
	pty.wait_screen_contains("suspended", TIMEOUT).unwrap();
	let stop = Arc::new(AtomicBool::new(false));
	let draining = drain_fifo(reader, Arc::clone(&stop));
	pty.write("print -rn -- AFTER-$((40+2)) >&3; print -r -- done-$((6*7))\r")
		.unwrap();
	pty.wait_screen_contains("done-42", TIMEOUT).unwrap();
	pty.write("fg; print -r -- fg-$((6*7))\r").unwrap();
	// The job has the terminal: `cat` reads it until end of file.
	pty.wait_screen_contains("continued", TIMEOUT).unwrap();
	thread::sleep(QUIET);
	pty.write("\x04").unwrap();
	pty.wait_screen_contains("fg-42", TIMEOUT).unwrap();
	stop.store(true, Ordering::SeqCst);
	let got = draining.join().unwrap();
	let zeros = got.iter().filter(|&&b| b == b'0').count();
	let count = |what: &[u8]| got.windows(what.len()).filter(|w| *w == what).count();
	let message = b"zsh: command not found: ".len() + 131_072 + 1;
	assert_eq!(
		(zeros, count(b"command not found"), count(b"AFTER-42"), got.len()),
		(131_072, 1, 1, message + 8),
		"('0's, messages, AFTER-42s, bytes)"
	);
}

// Failure mode (review of #111 at a25f15f0, a test gap): Ctrl-Z stopped
// `cat` in a USR1 trap's `cat | printf ... >&3` while the trap's write and
// the write it interrupted, `printf`'s, both waited on a tee. The stopped
// job takes the keys its ops write with: the trap's, and the one the trap
// interrupted ([`Vproc::trap_keys`]), which comes back when the trap ends
// after `fg`. A job without the interrupted key went on with the trap's,
// and the tee wrote `printf`'s rest to the file again. The file holds the
// '0's once, the trap's spaces once, then `AFTER-42`; the FIFO the same
// bytes.
#[test]
#[expect(clippy::naive_bytecount, reason = "a test's bytes; no bytecount dependency")]
fn ctrl_z_during_a_traps_write_through_a_tee_keeps_each_byte_once() {
	use std::sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	};
	let (mut pty, reader, file) = tee_fifo_and_file_writer(
		"trap 'cat | printf %131072s \"\" >&3' USR1; printf %0131072d 0 >&3",
		true,
	);
	// The trap runs while `printf` waits; its own write waits on the full
	// FIFO too, and `cat` reads the terminal.
	pty.signal(libc::SIGUSR1).unwrap();
	thread::sleep(QUIET);
	pty.write("\x1a").unwrap();
	pty.wait_screen_contains("suspended", TIMEOUT).unwrap();
	let stop = Arc::new(AtomicBool::new(false));
	let draining = drain_fifo(reader, Arc::clone(&stop));
	pty.write("print -rn -- AFTER-$((40+2)) >&3; print -r -- done-$((6*7))\r")
		.unwrap();
	pty.wait_screen_contains("done-42", TIMEOUT).unwrap();
	pty.write("fg; print -r -- fg-$((6*7))\r").unwrap();
	// The job has the terminal: `cat` reads it until end of file.
	pty.wait_screen_contains("continued", TIMEOUT).unwrap();
	thread::sleep(QUIET);
	pty.write("\x04").unwrap();
	pty.wait_screen_contains("fg-42", TIMEOUT).unwrap();
	stop.store(true, Ordering::SeqCst);
	let got = draining.join().unwrap();
	let written = std::fs::read(&file).unwrap();
	let counts = |b: &[u8]| {
		let afters = b.windows(8).filter(|w| *w == b"AFTER-42").count();
		(
			b.iter().filter(|&&c| c == b'0').count(),
			b.iter().filter(|&&c| c == b' ').count(),
			afters,
			b.len(),
		)
	};
	let want = (131_072, 131_072, 1, 262_144 + 8);
	assert_eq!(
		(counts(&written), counts(&got)),
		(want, want),
		"(the file's, the FIFO's) ('0's, spaces, AFTER-42s, bytes)"
	);
}
