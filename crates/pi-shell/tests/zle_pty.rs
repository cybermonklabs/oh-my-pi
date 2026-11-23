//! The interactive reader and the line editor of `obash` invoked as
//! `zsh -f -i`, against the real `/bin/zsh -f -i` on the same pty session
//! (same keys, same rc file): the final screens must match.
//!
//! Each case types its keys a line at a time, a `^C` in a write of its own,
//! waits until the line editor has handled them and waits for the next key
//! ([`Pty::zle_sync`]), and compares what the terminal shows.

#![cfg(unix)]

mod pty_support;
mod zsh_oracle;

use std::io::{self, Write as _};

use pty_support::{
	Pty, Spawn, TIMEOUT, ZLE_SYNC_SCRIPT, differential, have_real_zsh, wait_shell_blocked,
};

/// `zsh -f -i` with `PS1`/`RPS1` and the rc file `rc` (sourced with `.`
/// as the first command, since `-f` skips `.zshrc`), in its own home
/// directory: the prompt (`%~`) reads `~` wherever the tests run.
fn spawn(real: bool, rc: &str) -> Spawn {
	let s = if real {
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	};
	let home = s.home().to_owned();
	s.args(["-f", "-i"])
		.env("PS1", "%~ %# ")
		.env("RPS1", "[%?]")
		.rc_file(".zshrc", format!("{rc}\n. ~/{ZLE_SYNC_SCRIPT}\nprint -r -- RCDONE\n"))
		.zle_sync()
		.cwd(home)
		.size(24, 80)
}

/// Type `text` and wait until the line editor has handled it. The keys go
/// a line at a time ([`Pty::type_lines`]), and a `^C` goes in a write of
/// its own once the editor has handled the keys before it: the terminal
/// turns `^C` into `SIGINT` as it receives it and drops the keys still
/// waiting to be read. The `^C` goes once the shell blocks waiting for the
/// next key ([`wait_shell_blocked`], on Linux and macOS): a shell that has
/// just answered a sync is still returning from that handler, and a `^C`
/// sent then went unanswered (under gVisor the shell drew nothing after it
/// for the whole [`TIMEOUT`]). The editor never reads that key, so the wait
/// after it is first for the shell's answer to the interrupt (it leaves the
/// line and draws the next one), then for the editor.
fn keys(pty: &mut Pty, text: &str) -> io::Result<()> {
	for (i, part) in text.split('\x03').enumerate() {
		if i > 0 {
			wait_shell_blocked(pty.pid());
			pty.write("\x03")?;
			pty.read_some(TIMEOUT)?;
			pty.zle_sync(TIMEOUT)?;
		}
		if !part.is_empty() {
			pty.type_lines(part, TIMEOUT)?;
		}
	}
	Ok(())
}

/// Run `drive` against both shells after sourcing the rc file; the final
/// screens (`None` for zsh when it is not installed).
fn screens(
	rc: &str,
	drive: impl Fn(&mut Pty) -> io::Result<()>,
) -> io::Result<(String, Option<String>)> {
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
	// editor waits for a key, once (it removes itself), so it has run when
	// the editor first answers [`Pty::zle_sync`] (handlers run in the order
	// they were added). The listing leaves out the harness's own handler.
	let rc = "exec {pfd}</dev/null\nh() { zle -I; print -r -- \"fired $# $(( $1 == pfd ))\"; zle \
	          -F $1; }\nzle -F $pfd h\n";
	same(rc, |pty| keys(pty, "zle -F | grep -v _zle_sync; echo after\r"));
}

/// The keys after `^C` wait for the next line editor: between the `INT`
/// and the next `zleread` both shells give the terminal its shell modes,
/// which echo, so a key typed then is echoed by the kernel and `PROMPT_SP`
/// marks the partial line (`e%` on macOS, under load).
#[test]
fn ctrl_c_abandons_the_line() {
	same("", |pty| {
		keys(pty, "echo abc\x03")?;
		keys(pty, "echo $?\r")
	});
}

#[test]
fn ctrl_c_abandons_a_continued_command() {
	same("PS2='%_> '", |pty| {
		keys(pty, "if true\recho x\x03")?;
		keys(pty, "echo $?\r")
	});
}

/// A widget whose autoloaded function has no definition file: zsh runs a
/// widget in a parameter scope of its own (`execzlefunc`'s
/// `startparamscope`), so even at the prompt its message names the shell
/// and the line being edited (`zsh:3:`), as a function's would, where a
/// command typed at the prompt reports neither.
#[test]
fn a_widget_whose_function_file_is_missing_names_the_line() {
	let rc =
		"mkdir -p ~/empty\nfpath=(~/empty)\nautoload -Uz nowhere\nzle -N w nowhere\nbindkey '^T' w\n";
	let (ours, real) = match screens(rc, |pty| {
		keys(pty, "print one\r")?;
		keys(pty, "echo x\x14")
	}) {
		Ok(s) => s,
		Err(e) => panic!("pty session failed: {e}"),
	};
	assert!(ours.contains("zsh:3: nowhere: function definition file not found"), "{ours}");
	if let Some(real) = real {
		assert_eq!(ours, real, "obash screen:\n{ours}\n--- zsh screen:\n{real}");
	}
}

/// The shell redraws the line at the new width before it handles the next
/// key, so the screen is read once the editor waits for one.
#[test]
fn resize_redraws() {
	same("", |pty| {
		keys(pty, "echo a long line of text")?;
		pty.resize(24, 40)?;
		pty.zle_sync(TIMEOUT)?;
		keys(pty, "\rprint $COLUMNS\r")
	});
}

/// A prompt two lines long at 80 columns wraps to three at 40: the
/// resized screen shows it once, as zsh redraws it.
#[test]
fn resize_redraws_a_prompt_wrapped_to_three_lines() {
	let prompt = format!("PS1='{} %# '", "p".repeat(86));
	same(&prompt, |pty| {
		keys(pty, "echo a long line of text")?;
		pty.resize(24, 40)?;
		pty.zle_sync(TIMEOUT)?;
		keys(pty, "\rprint $COLUMNS\r")
	});
}

/// A resize while shell code runs for the line editor (here a `zle -F`
/// handler) is redrawn once that code has returned, before the editor
/// reads anything else, as zsh does (it holds the signal while the handler
/// runs): the handler waits until the terminal has been resized and
/// `~/go` exists, then prints a marker; nothing is drawn while it runs,
/// and the line is redrawn after the marker.
#[test]
fn a_resize_while_a_handler_runs_is_redrawn_after_it() {
	const LOOPING: &str = "\x1b]9999;looping\x07";
	const DONE: &str = "\x1b]9999;done\x07";
	let rc = "mkfifo ~/gate\nexec {gate}<>~/gate\n_g() { local n; read -r -u $1 n; print -rn -- \
	          $'\\e]9999;looping\\a'; while [[ ! -e ~/go ]]; do :; done; print -rn -- \
	          $'\\e]9999;done\\a'; zle -F $1 }\nzle -F $gate _g\n";
	let spawns = [spawn(false, rc), spawn(true, rc)];
	let homes: Vec<std::path::PathBuf> = spawns.iter().map(|s| s.home().to_owned()).collect();
	// Per shell: what it wrote while the handler ran, and after it.
	let mut seen: Vec<(String, String)> = Vec::new();
	let mut run = |pty: &mut Pty| -> io::Result<()> {
		let home = &homes[seen.len()];
		pty.wait_raw(TIMEOUT)?;
		pty.write(". ~/.zshrc\r")?;
		pty.read_until("RCDONE", TIMEOUT)?;
		pty.zle_sync(TIMEOUT)?;
		keys(pty, "\x0c")?;
		keys(pty, "echo a long line of text")?;
		std::fs::OpenOptions::new()
			.write(true)
			.open(home.join("gate"))?
			.write_all(b"1\n")?;
		pty.read_until(LOOPING, TIMEOUT)?;
		pty.resize(24, 40)?;
		std::fs::write(home.join("go"), "")?;
		let during = pty.read_until(DONE, TIMEOUT)?;
		pty.zle_sync(TIMEOUT)?;
		let all = pty.output();
		let after = all[all.rfind(DONE).map_or(0, |at| at + DONE.len())..].to_owned();
		seen.push((during[..during.len() - DONE.len()].to_owned(), after));
		Ok(())
	};
	let [ours, real] = spawns;
	if have_real_zsh() {
		let (o, r) = differential(ours, real, &mut run).expect("pty session");
		assert_eq!(o, r, "obash screen:\n{o}\n--- zsh screen:\n{r}");
	} else {
		let mut ours = ours.spawn().expect("spawn obash");
		run(&mut ours).expect("pty session");
	}
	for (shell, (during, after)) in ["obash", "zsh"].iter().zip(&seen) {
		assert_eq!(during, "", "{shell} drew while the handler ran");
		assert!(after.contains("echo a long line of text"), "{shell} did not redraw: {after:?}");
	}
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
		.and_then(|()| pty.write("\x04"))
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
