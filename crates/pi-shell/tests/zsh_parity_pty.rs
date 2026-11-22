//! zsh core behaviour of an interactive `obash` invoked as `zsh -f -i`,
//! against the real `/bin/zsh -f -i` on the same pty session (same keys,
//! same files): a line ending in `||`/`&&` continues on a `PS2` line, and
//! an autoloaded function file is read with comments even though the
//! interactive shell's own input is not (`interactivecomments` unset).
//! A screen is read once the line editor has handled the keys and waits
//! for the next one ([`Pty::zle_sync`]).

#![cfg(unix)]

mod pty_support;
mod zsh_oracle;

use std::io;

use pty_support::{Pty, Spawn, TIMEOUT, ZLE_SYNC_SCRIPT, differential, have_real_zsh};

/// `zsh -f -i` with a plain prompt and `~/tf`, an autoloadable function
/// file that starts with a comment.
fn spawn(real: bool) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	s.args(["-f", "-i"])
		.env("PS1", "P> ")
		.env("PS2", "%_> ")
		.rc_file("tf", "# a comment\necho tf ran\n")
		.rc_file(".zshrc", format!(". ~/{ZLE_SYNC_SCRIPT}\nprint -r -- RCDONE\n"))
		.zle_sync()
		.size(24, 80)
}

/// Type `text` in one write and wait until the line editor has handled it.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	pty.write(text)?;
	pty.zle_sync(TIMEOUT)
}

/// Run `drive` against both shells; assert the final screens match.
fn same(drive: impl Fn(&mut Pty) -> io::Result<()>) {
	let run = |pty: &mut Pty| -> io::Result<()> {
		pty.wait_raw(TIMEOUT)?;
		pty.write(". ~/.zshrc\r")?;
		pty.read_until("RCDONE", TIMEOUT)?;
		pty.zle_sync(TIMEOUT)?;
		// A clean screen for the case itself.
		keys(pty, "\x0c")?;
		drive(pty)
	};
	if !have_real_zsh() {
		let mut ours = spawn(false).spawn().expect("spawn obash");
		run(&mut ours).expect("pty session");
		return;
	}
	let (ours, real) = differential(spawn(false), spawn(true), run).expect("pty session");
	assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
}

#[test]
fn and_or_at_line_end_continues_on_ps2() {
	same(|pty| keys(pty, "echo x y ||\recho z\rfalse &&\recho no\recho done\r"));
}

#[test]
fn autoloaded_file_reads_comments_in_an_interactive_shell() {
	same(|pty| keys(pty, "fpath=(~ $fpath); autoload -Uz tf; tf; echo $?\r"));
}
