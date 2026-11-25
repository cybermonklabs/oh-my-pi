//! An interactive shell on a pty with no vpid left (obash started with its
//! next vpid past `Vpid::CEILING`), in bash and zsh mode: a prompt whose
//! command substitution needs a vproc fails as an expansion. The fork
//! message is printed once per prompt that has one, the prompt is empty, and
//! the line is read and run with `$?` as it was. zsh 5.9 does the same on a
//! pty under `ulimit -u 1` (as a user `RLIMIT_NPROC` holds: `zsh: fork
//! failed: …`, `PS1` and `RPS1` a message each); bash 5.2.21 and 5.3.20
//! retry the fork for 15 s, print `bash: fork: …` and expand the prompt
//! again, and never read a line.
//!
//! A reader that expands its prompt again without end prints the message
//! without end: each wait fails once more than [`BOUND`] came, by that count.

#![cfg(unix)]

mod pty_support;
mod zsh_oracle;

use std::io;

use pty_support::{Spawn, TIMEOUT};

/// obash's option: the shell's next vpid is past the last one.
const PAST_THE_CEILING: &str = "--next-vpid=2147483648";

/// The most fork messages a wait may see before its line's output.
const BOUND: usize = 64;

#[test]
fn a_bash_prompt_substitution_with_no_vpid_is_an_empty_prompt() -> io::Result<()> {
	let mut sh = Spawn::obash_as("bash")
		.args([PAST_THE_CEILING, "--norc", "-i"])
		.env("PS1", "$ ")
		.spawn()?;
	sh.read_until("$ ", TIMEOUT)?;
	sh.write("PS1='$(echo p)> '; false\r")?;
	sh.write("echo \"st=$?\"\r")?;
	sh.read_until_bounded("st=1", "fork", BOUND, TIMEOUT)?;
	sh.write("echo hi\r")?;
	sh.read_until_bounded("\nhi\r\n", "fork", BOUND, TIMEOUT)?;
	sh.write("exit\r")?;
	let status = sh.wait(TIMEOUT)?;
	let out = sh.output();
	assert!(status.success(), "{status:?}\n{out}");
	assert_eq!(
		out.matches("bash: fork: Resource temporarily unavailable")
			.count(),
		3,
		"{out}"
	);
	assert!(!out.contains("p> "), "the failed prompt is empty:\n{out}");
	Ok(())
}

#[test]
fn a_zsh_prompt_substitution_with_no_vpid_is_an_empty_prompt() -> io::Result<()> {
	let mut sh = Spawn::zsh().args([PAST_THE_CEILING, "-f", "-i"]).spawn()?;
	sh.write("setopt promptsubst; PS1='$(print p)> '; RPS1='$(print r)'; false\r")?;
	sh.write("print \"st=$?\"\r")?;
	sh.read_until_bounded("st=1", "fork", BOUND, TIMEOUT)?;
	sh.write("print hi\r")?;
	sh.read_until_bounded("\nhi\r\n", "fork", BOUND, TIMEOUT)?;
	sh.write("exit\r")?;
	let status = sh.wait(TIMEOUT)?;
	let out = sh.output();
	assert!(status.success(), "{status:?}\n{out}");
	assert_eq!(
		out.matches("zsh: fork failed: resource temporarily unavailable")
			.count(),
		6,
		"{out}"
	);
	assert!(!out.contains("p> "), "the failed prompt is empty:\n{out}");
	Ok(())
}
