//! zsh runs a `WINCH` trap only while its line editor reads a line: it
//! keeps the signal blocked otherwise (`init.c` `init_signals`, unblocked
//! by `zleread`). So an interactive zsh runs `TRAPWINCH` at its prompt,
//! and a resize while a command runs is trapped once the next prompt
//! reads; a non-interactive one never runs it (`tests/zsh_function_traps`
//! has those rows). Both are checked on obash as `zsh` and on the real zsh.

#![cfg(unix)]

mod pty_support;
mod zsh_oracle;

use std::io;

use pty_support::{Pty, Spawn, TIMEOUT, have_real_zsh};

/// An interactive shell with the prompt `P> ` and a `TRAPWINCH` that
/// prints the new size, at its second prompt.
fn trapping(spawn: Spawn) -> io::Result<Pty> {
	let mut sh = spawn.args(["-f", "-i"]).env("PS1", "P> ").spawn()?;
	sh.wait_screen_contains("P>", TIMEOUT)?;
	sh.write("TRAPWINCH() { print -r -- winch:$LINES:$COLUMNS }\r")?;
	sh.wait_screen(TIMEOUT, |s| s.contents().matches("P>").count() >= 2)?;
	Ok(sh)
}

/// A resize at the prompt runs the trap there.
fn at_the_prompt(spawn: Spawn) -> io::Result<()> {
	let mut sh = trapping(spawn)?;
	sh.resize(30, 100)?;
	sh.wait_screen_contains("winch:30:100", TIMEOUT)?;
	sh.write("exit 3\r")?;
	assert_eq!(sh.wait(TIMEOUT)?.code(), Some(3));
	Ok(())
}

/// A resize while a command runs: the trap runs once the next prompt
/// reads, after the command's own output.
fn while_a_command_runs(spawn: Spawn) -> io::Result<()> {
	let mut sh = trapping(spawn)?;
	sh.write("print -r -- read$((6*7)); read -r line; print -r -- got:$line\r")?;
	// `read42` is printed, so the line editor is done: `read` runs.
	sh.wait_screen_contains("read42", TIMEOUT)?;
	sh.resize(30, 100)?;
	sh.write("x\r")?;
	sh.wait_screen_contains("winch:30:100", TIMEOUT)?;
	let output = sh.output();
	let got = output.find("got:x").expect("the command's output");
	let winch = output.find("winch:30:100").expect("the trap's output");
	assert!(got < winch, "the trap ran before the command ended:\n{output}");
	sh.write("exit 3\r")?;
	assert_eq!(sh.wait(TIMEOUT)?.code(), Some(3));
	Ok(())
}

#[test]
fn obash_as_zsh_runs_a_winch_trap_at_its_prompt() -> io::Result<()> {
	at_the_prompt(Spawn::zsh())
}

#[test]
fn zsh_runs_a_winch_trap_at_its_prompt() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	at_the_prompt(Spawn::real_zsh())
}

#[test]
fn obash_as_zsh_runs_a_winch_trap_from_a_command_at_the_next_prompt() -> io::Result<()> {
	while_a_command_runs(Spawn::zsh())
}

#[test]
fn zsh_runs_a_winch_trap_from_a_command_at_the_next_prompt() -> io::Result<()> {
	if !have_real_zsh() {
		return Ok(());
	}
	while_a_command_runs(Spawn::real_zsh())
}
