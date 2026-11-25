//! Shared pieces of the completion PTY tests (`zsh_comp_*`): which shell
//! runs (obash as `zsh`, or `/bin/zsh` as the oracle), where zsh 5.9's
//! completion functions live, the colour transcript of terminal output, and
//! the port of zsh's `Test/comptest` harness ([`comptest`]).
//!
//! Environment switches (both crates read them):
//! - `PI_COMP_ORACLE=1` runs the real zsh ([`crate::zsh_oracle::path`]) instead
//!   of obash, checking the stored expectations against zsh itself.
//! - `PI_COMP_BLESS=1` (with `PI_COMP_ORACLE=1`) rewrites the stored screen
//!   snapshots of `zsh_comp_pty` from the real zsh.

#![allow(dead_code, reason = "each test crate uses a subset")]

pub mod comptest;

use std::{env, path::PathBuf};

use crate::pty_support::{Spawn, have_real_zsh};

/// Whether the real zsh runs instead of obash (`PI_COMP_ORACLE`).
#[must_use]
pub fn oracle() -> bool {
	flag("PI_COMP_ORACLE")
}

/// Whether stored snapshots are rewritten from the run (`PI_COMP_BLESS`).
#[must_use]
pub fn bless() -> bool {
	flag("PI_COMP_BLESS")
}

fn flag(name: &str) -> bool {
	env::var_os(name).is_some_and(|v| !v.is_empty() && v != "0")
}

/// The shell under test: obash as `zsh`, or the real zsh in oracle mode.
///
/// # Panics
///
/// In oracle mode without the real zsh ([`crate::zsh_oracle::path`]).
#[must_use]
pub fn shell() -> Spawn {
	if oracle() {
		assert!(have_real_zsh(), "PI_COMP_ORACLE needs {}", crate::zsh_oracle::path().display());
		Spawn::real_zsh()
	} else {
		Spawn::zsh()
	}
}

/// The directories of zsh 5.9's shell-code completion functions
/// (`_main_complete`, `compinit`, ...) as the real zsh installed them
/// ([`crate::zsh_oracle::own_function_dirs`]): one flat directory (macOS,
/// `/usr/share/zsh/5.9/functions`) or the source-tree layout (Debian,
/// `/usr/share/zsh/functions/Completion/Base`, ...). `None` without them:
/// the tests then compare nothing, and the calling test is reported
/// [`crate::zsh_oracle::uncompared`].
#[must_use]
pub fn compsys_fpath() -> Option<Vec<PathBuf>> {
	let (root, dirs) = crate::zsh_oracle::own_function_dirs()?;
	if dirs.iter().any(|d| d.join("_main_complete").is_file()) {
		return Some(dirs);
	}
	crate::zsh_oracle::uncompared(&format!(
		"zsh 5.9's completion functions are not installed (no _main_complete under {})",
		root.display()
	));
	None
}

/// `fpath=( ... )` words for [`compsys_fpath`] (the paths need no quoting).
#[must_use]
pub fn fpath_words(dirs: &[PathBuf]) -> String {
	let words: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
	words.join(" ")
}

/// The text and colours of terminal output: printable text as is, `\n`
/// for line feeds, `^G` for bells, `{params}` for each SGR sequence
/// (`ESC [ params m`); every other control sequence (cursor motion, erase,
/// OSC strings, charset selection) and control character is dropped.
#[must_use]
pub fn sgr_transcript(out: &str) -> String {
	let mut text = String::new();
	let mut chars = out.chars().peekable();
	while let Some(c) = chars.next() {
		match c {
			'\x1b' => match chars.next() {
				Some('[') => {
					let mut params = String::new();
					while let Some(&p) = chars.peek() {
						if ('\x20'..='\x3f').contains(&p) {
							params.push(p);
							chars.next();
						} else {
							break;
						}
					}
					if chars.next() == Some('m') {
						text.push('{');
						text.push_str(&params);
						text.push('}');
					}
				},
				Some(']' | 'P' | '_' | '^' | 'X') => {
					// A string up to BEL or ST (`ESC \`).
					while let Some(s) = chars.next() {
						if s == '\x07' || (s == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
							break;
						}
					}
				},
				Some('(' | ')' | '*' | '+' | '#' | '%') => {
					chars.next();
				},
				_ => {},
			},
			'\n' => text.push('\n'),
			'\x07' => text.push_str("^G"),
			c if c < ' ' || c == '\x7f' => {},
			c => text.push(c),
		}
	}
	text
}
