//! A prompt's command substitution leaves `$?` as it was: the next command,
//! and the shell's status when its input ends, see the status of the last
//! command the user ran. Goldens: bash 5.2.21 and 5.3.20 (`bash --norc -i`)
//! and zsh 5.9 (`zsh -f -i`, `promptsubst`), each reading the lines from a
//! pipe as here, and the same on a pty.

use crate::{
	bash::{ModeId, Origin, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// An interactive shell in `mode` reading `input`: its stdout and its
/// status when the input ends.
fn interactive(mode: ModeId, input: &str) -> (String, i32) {
	let mut init = ShellInit { interactive: true, ..skeleton_init(&[]) };
	if mode == ModeId::Zsh {
		init.mode = ModeId::Zsh;
		init.argv0 = "zsh".into();
	}
	init.env.push(("PS1".into(), "$ ".into()));
	let mut rig = Rig::new(FakeHost::new().with_stdin(input.as_bytes()), init);
	let status =
		rig.run(Script { origin: Origin::Stdin, ..Script::command(Vec::new()) }, Fault::None);
	(String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(), status)
}

/// Each row: the input, then the stdout and status bash or zsh gives.
fn check(mode: ModeId, rows: &[(&str, &str, i32)]) {
	let mut mismatches = Vec::new();
	for &(input, out, status) in rows {
		let got = interactive(mode, input);
		if got != (out.to_owned(), status) {
			mismatches.push(format!("{input:?}: want {:?}, got {got:?}", (out, status)));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

#[test]
fn a_bash_prompt_substitution_leaves_the_status_alone() {
	check(ModeId::Bash, &[
		("PS1='$(exit 3)> '; false\necho \"st=$?\"\n", "st=1\n", 0),
		("PS1='$(true)> '; false\necho \"st=$?\"\n", "st=1\n", 0),
		("PS2='$(exit 4)> '; false\necho \"st=$?\nx\"\n", "st=1\nx\n", 0),
		("PS1='$(exit 3)$(exit 7)> '; false\necho \"st=$?\"\necho \"st=$?\"\n", "st=1\nst=0\n", 0),
		("PS1='$(exit 3)> '; false\n", "", 1),
		// A prompt hook already leaves it alone.
		("PROMPT_COMMAND='(exit 5)'; false\necho \"st=$?\"\n", "st=1\n", 0),
	]);
}

#[test]
fn a_zsh_prompt_substitution_leaves_the_status_alone() {
	check(ModeId::Zsh, &[
		("setopt promptsubst; PS1='$(exit 3)> '; false\nprint \"st=$?\"\n", "st=1\n", 0),
		("setopt promptsubst; RPS1='$(exit 3)'; false\nprint \"st=$?\"\n", "st=1\n", 0),
		("setopt promptsubst; PS2='$(exit 4)> '; false\nprint \"st=$?\nx\"\n", "st=1\nx\n", 0),
		(
			"setopt promptsubst; PS1='$(exit 3)$(exit 7)> '; false\nprint \"st=$?\"\nprint \
			 \"st=$?\"\n",
			"st=1\nst=0\n",
			0,
		),
		("setopt promptsubst; PS1='$(exit 3)> '; false\n", "", 1),
		// A prompt hook already leaves it alone.
		("precmd() { return 5 }; false\nprint \"st=$?\"\n", "st=1\n", 0),
	]);
}
