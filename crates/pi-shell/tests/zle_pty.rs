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
	let r = keys(&mut pty, "\x04").and_then(|()| pty.wait(TIMEOUT));
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
// out twice. Each trap writes with a key of its own: its bytes come in the
// middle of the command's, and each of the command's bytes comes once.
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
	// WINCH to the shell; its trap starts, and its write waits on the full
	// FIFO. The trap runs inside `printf`'s redirection (`>&3`), so it
	// prints its marker to stderr, the terminal.
	pty.resize(30, 100).unwrap();
	pty.wait_screen_contains("trap-42", TIMEOUT).unwrap();
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
	let at = got.windows(MARK.len()).position(|w| w == MARK);
	let zeros = got.iter().filter(|&&b| b == b'0').count();
	assert_eq!(
		(zeros, got.len(), at.is_some_and(|at| at > 0 && at < ZEROS)),
		(ZEROS, ZEROS + MARK.len(), true),
		"('0's, bytes, the trap's bytes inside the command's); trap's bytes at {at:?}"
	);
}
