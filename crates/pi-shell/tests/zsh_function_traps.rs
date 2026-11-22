//! zsh's signal function traps (`TRAPNAL() { … }`) and the traps around
//! them, as zsh 5.9 runs them: a `TRAPNAL` function catches its signal
//! (every signal zsh traps that a shell can send itself), with the signal's
//! number as `$1` (`ZERR` 32, `DEBUG` 33); it replaces a `trap` action and
//! is replaced by one; `trap -`, `trap SIG`, `unfunction`, `unset -f` and
//! `disable -f` remove it, `enable -f` sets it again; under `localtraps` a
//! function's change ends with it; a `TRAPNAL` function stays a subshell's
//! trap (a `trap` action does not); a `return N` (N ≠ 0) ends the code it
//! interrupted; called by name it is a plain function. Also the signals
//! zsh runs no trap for: a `CHLD` sent as a signal (its trap runs per child,
//! `TRAPCHLD` or `TRAPCLD`), and `WINCH` outside the line editor (zsh keeps
//! it blocked). And a signal the shell's `kill` sends itself, whose trap zsh
//! runs inside that `kill`: the trap sees `$?` from before the `kill`, the
//! `kill`'s status stands after a `return N` (but for `INT` and `QUIT`),
//! and each send runs the trap. `TRAPEXIT`'s `return N` as the shell exits
//! leaves the exit status alone. The bash rows: a `CHLD` sent as a signal
//! runs no trap in bash either.
//!
//! The expected rows are the oracles' output, recorded in
//! `tests/fixtures/zsh_function_traps/{zsh,bash}.jsonl` (stdout, stderr, and
//! the status, negative for a death by a signal); zsh 5.9 (`zsh -f -c`) and
//! bash 5.3.20 (5.2.21 gives the same bash rows). Each row runs in a process
//! group of its own ([`obash_support::command`]), so `kill 0` reaches only
//! the shell. `PI_FNTRAP_ZSH=<zsh>` / `PI_FNTRAP_BASH=<bash>` run that shell
//! instead of obash against the records; with `PI_FNTRAP_BLESS=1` they
//! rewrite them. Linux only: the records hold Linux's signal numbers and
//! signals (`STKFLT`, `PWR`).
//!
//! Rows left out, each with its reason:
//! - `TRAPABRT`: zsh 5.9 built on glibc names signal 6 `IOT` and takes no
//!   `ABRT`, so `TRAPABRT` is a plain function there; obash follows zsh after
//!   5.9, which names it `ABRT` (`Signal::zsh_name`).
//! - `TRAPSIGUSR1() {…}`, `TRAP10() {…}`: zsh 5.9 sets the trap but its
//!   `gettrapnode` finds no function by those names, so the signal is caught
//!   and nothing runs (its debug build reports "BUG: running function trap
//!   which has escaped"). obash takes them as plain functions: the signal does
//!   what it does untrapped.
//! - `TRAPEXIT` called by name: zsh 5.9's `starttrapscope` frees the function
//!   it is calling; what it then does is undefined.
//! - A trap function that ends non-zero without `return` (zsh ends the
//!   interrupted code only after a `return`): another change's.
//! - `ZERR` once per failed sublist (`f() { false; return 2; }; f` runs it
//!   twice in zsh, `true | false` once): another change's.
#![cfg(target_os = "linux")]

mod obash_support;

use std::{
	collections::BTreeMap,
	env,
	fmt::Write as _,
	fs,
	os::unix::process::{CommandExt, ExitStatusExt},
	path::PathBuf,
	sync::atomic::{AtomicUsize, Ordering},
	thread,
};

use serde_json::{Value, json};

use crate::obash_support::{command, obash, output};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Dialect {
	Bash,
	Zsh,
}

impl Dialect {
	const fn name(self) -> &'static str {
		match self {
			Self::Bash => "bash",
			Self::Zsh => "zsh",
		}
	}
}

/// One row: its id and script.
type Row = (&'static str, &'static str);

/// The zsh rows (`probe` order): definition per signal and the `trap`
/// action control, other names, replacement, removal, the self-sent
/// signal, return status and arguments, a direct call, subshells and
/// functions, nesting, a null function, `TRAPEXIT`, `TRAPZERR`,
/// `TRAPDEBUG`, `TRAPCHLD`, `TRAPALRM`.
const ZSH_ROWS: &[(&str, &str)] = &[
	(r"def/HUP", r"TRAPHUP() { echo got:$0:$1:$#; }; kill -HUP $$; echo after:$?"),
	(r"def/INT", r"TRAPINT() { echo got:$0:$1:$#; }; kill -INT $$; echo after:$?"),
	(r"def/QUIT", r"TRAPQUIT() { echo got:$0:$1:$#; }; kill -QUIT $$; echo after:$?"),
	(r"def/ILL", r"TRAPILL() { echo got:$0:$1:$#; }; kill -ILL $$; echo after:$?"),
	(r"def/TRAP", r"TRAPTRAP() { echo got:$0:$1:$#; }; kill -TRAP $$; echo after:$?"),
	(r"def/BUS", r"TRAPBUS() { echo got:$0:$1:$#; }; kill -BUS $$; echo after:$?"),
	(r"def/FPE", r"TRAPFPE() { echo got:$0:$1:$#; }; kill -FPE $$; echo after:$?"),
	(r"def/USR1", r"TRAPUSR1() { echo got:$0:$1:$#; }; kill -USR1 $$; echo after:$?"),
	(r"def/SEGV", r"TRAPSEGV() { echo got:$0:$1:$#; }; kill -SEGV $$; echo after:$?"),
	(r"def/USR2", r"TRAPUSR2() { echo got:$0:$1:$#; }; kill -USR2 $$; echo after:$?"),
	(r"def/PIPE", r"TRAPPIPE() { echo got:$0:$1:$#; }; kill -PIPE $$; echo after:$?"),
	(r"def/ALRM", r"TRAPALRM() { echo got:$0:$1:$#; }; kill -ALRM $$; echo after:$?"),
	(r"def/TERM", r"TRAPTERM() { echo got:$0:$1:$#; }; kill -TERM $$; echo after:$?"),
	(r"def/STKFLT", r"TRAPSTKFLT() { echo got:$0:$1:$#; }; kill -STKFLT $$; echo after:$?"),
	(r"def/CHLD", r"TRAPCHLD() { echo got:$0:$1:$#; }; kill -CHLD $$; echo after:$?"),
	(r"def/CONT", r"TRAPCONT() { echo got:$0:$1:$#; }; kill -CONT $$; echo after:$?"),
	(r"def/TSTP", r"TRAPTSTP() { echo got:$0:$1:$#; }; kill -TSTP $$; echo after:$?"),
	(r"def/TTIN", r"TRAPTTIN() { echo got:$0:$1:$#; }; kill -TTIN $$; echo after:$?"),
	(r"def/TTOU", r"TRAPTTOU() { echo got:$0:$1:$#; }; kill -TTOU $$; echo after:$?"),
	(r"def/URG", r"TRAPURG() { echo got:$0:$1:$#; }; kill -URG $$; echo after:$?"),
	(r"def/XCPU", r"TRAPXCPU() { echo got:$0:$1:$#; }; kill -XCPU $$; echo after:$?"),
	(r"def/XFSZ", r"TRAPXFSZ() { echo got:$0:$1:$#; }; kill -XFSZ $$; echo after:$?"),
	(r"def/VTALRM", r"TRAPVTALRM() { echo got:$0:$1:$#; }; kill -VTALRM $$; echo after:$?"),
	(r"def/PROF", r"TRAPPROF() { echo got:$0:$1:$#; }; kill -PROF $$; echo after:$?"),
	(r"def/WINCH", r"TRAPWINCH() { echo got:$0:$1:$#; }; kill -WINCH $$; echo after:$?"),
	(r"def/IO", r"TRAPIO() { echo got:$0:$1:$#; }; kill -IO $$; echo after:$?"),
	(r"def/PWR", r"TRAPPWR() { echo got:$0:$1:$#; }; kill -PWR $$; echo after:$?"),
	(r"def/SYS", r"TRAPSYS() { echo got:$0:$1:$#; }; kill -SYS $$; echo after:$?"),
	(r"list/HUP", r"trap 'echo got' HUP; kill -HUP $$; echo after:$?"),
	(r"list/INT", r"trap 'echo got' INT; kill -INT $$; echo after:$?"),
	(r"list/QUIT", r"trap 'echo got' QUIT; kill -QUIT $$; echo after:$?"),
	(r"list/ILL", r"trap 'echo got' ILL; kill -ILL $$; echo after:$?"),
	(r"list/TRAP", r"trap 'echo got' TRAP; kill -TRAP $$; echo after:$?"),
	(r"list/ABRT", r"trap 'echo got' 6; kill -6 $$; echo after:$?"),
	(r"list/BUS", r"trap 'echo got' BUS; kill -BUS $$; echo after:$?"),
	(r"list/FPE", r"trap 'echo got' FPE; kill -FPE $$; echo after:$?"),
	(r"list/USR1", r"trap 'echo got' USR1; kill -USR1 $$; echo after:$?"),
	(r"list/SEGV", r"trap 'echo got' SEGV; kill -SEGV $$; echo after:$?"),
	(r"list/USR2", r"trap 'echo got' USR2; kill -USR2 $$; echo after:$?"),
	(r"list/PIPE", r"trap 'echo got' PIPE; kill -PIPE $$; echo after:$?"),
	(r"list/ALRM", r"trap 'echo got' ALRM; kill -ALRM $$; echo after:$?"),
	(r"list/TERM", r"trap 'echo got' TERM; kill -TERM $$; echo after:$?"),
	(r"list/STKFLT", r"trap 'echo got' STKFLT; kill -STKFLT $$; echo after:$?"),
	(r"list/CHLD", r"trap 'echo got' CHLD; kill -CHLD $$; echo after:$?"),
	(r"list/CONT", r"trap 'echo got' CONT; kill -CONT $$; echo after:$?"),
	(r"list/TSTP", r"trap 'echo got' TSTP; kill -TSTP $$; echo after:$?"),
	(r"list/TTIN", r"trap 'echo got' TTIN; kill -TTIN $$; echo after:$?"),
	(r"list/TTOU", r"trap 'echo got' TTOU; kill -TTOU $$; echo after:$?"),
	(r"list/URG", r"trap 'echo got' URG; kill -URG $$; echo after:$?"),
	(r"list/XCPU", r"trap 'echo got' XCPU; kill -XCPU $$; echo after:$?"),
	(r"list/XFSZ", r"trap 'echo got' XFSZ; kill -XFSZ $$; echo after:$?"),
	(r"list/VTALRM", r"trap 'echo got' VTALRM; kill -VTALRM $$; echo after:$?"),
	(r"list/PROF", r"trap 'echo got' PROF; kill -PROF $$; echo after:$?"),
	(r"list/WINCH", r"trap 'echo got' WINCH; kill -WINCH $$; echo after:$?"),
	(r"list/IO", r"trap 'echo got' IO; kill -IO $$; echo after:$?"),
	(r"list/PWR", r"trap 'echo got' PWR; kill -PWR $$; echo after:$?"),
	(r"list/SYS", r"trap 'echo got' SYS; kill -SYS $$; echo after:$?"),
	(r"alias/IOT", r"TRAPIOT() { echo got:$1; }; kill -6 $$; echo after:$?"),
	(r"alias/POLL", r"TRAPPOLL() { echo got:$1; }; kill -IO $$; echo after:$?"),
	(r"alias/ERR", r"TRAPERR() { echo got:$1; }; false; echo after:$?"),
	(r"alias/CLD", r"TRAPCLD() { echo got:$1; }; sleep 0 & wait; echo after:$?"),
	(
		r"repl/list-then-fn",
		r"trap 'echo list' USR1; TRAPUSR1() { echo fn; }; trap; kill -USR1 $$; echo after:$?",
	),
	(
		r"repl/fn-then-list",
		r"TRAPUSR1() { echo fn; }; trap 'echo list' USR1; whence -w TRAPUSR1; trap; kill -USR1 $$; echo after:$?",
	),
	(
		r"repl/ignored-then-fn",
		r"trap '' USR1; TRAPUSR1() { echo fn; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"repl/fn-then-ignored",
		r"TRAPUSR1() { echo fn; }; trap '' USR1; whence -w TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"repl/fn-then-fn",
		r"TRAPUSR1() { echo one; }; TRAPUSR1() { echo two; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"repl/fn-list-fn",
		r"TRAPUSR1() { echo one; }; trap 'echo list' USR1; TRAPUSR1() { echo two; }; kill -USR1 $$; echo after:$?",
	),
	(r"repl/listing", r"TRAPUSR1() { echo F; }; TRAPZERR() { echo Z }; trap; echo st:$?"),
	(r"repl/functions", r"TRAPUSR1() { echo F; }; functions TRAPUSR1; echo st:$?"),
	(
		r"rm/trap-dash",
		r"TRAPUSR1() { echo fn; }; trap - USR1; whence -w TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/trap-sig",
		r"TRAPUSR1() { echo fn; }; trap USR1; whence -w TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/trap-all",
		r"TRAPUSR1() { echo fn; }; trap -; whence -w TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unfunction",
		r"TRAPUSR1() { echo fn; }; unfunction TRAPUSR1; trap; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unset-f",
		r"TRAPUSR1() { echo fn; }; unset -f TRAPUSR1; trap; kill -USR1 $$; echo after:$?",
	),
	(r"rm/disable-f", r"TRAPUSR1() { echo fn; }; disable -f TRAPUSR1; kill -USR1 $$; echo after:$?"),
	(
		r"rm/disable-enable",
		r"TRAPUSR1() { echo fn; }; disable -f TRAPUSR1; enable -f TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unfunction-then-list",
		r"TRAPUSR1() { echo fn; }; unfunction TRAPUSR1; trap 'echo list' USR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/ignore-kept-after-unfunction",
		r"trap '' USR1; TRAPUSR1() { echo fn; }; unfunction TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/inside-trap",
		r"TRAPUSR1() { echo fn; unfunction TRAPUSR1; }; kill -USR1 $$; echo mid:$?; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unfunction-localtraps",
		r"TRAPUSR1() { echo outer; }; f() { setopt localtraps; unfunction TRAPUSR1; }; f; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unfunction-outside",
		r"TRAPUSR1() { echo fn; }; unfunction TRAPUSR1; sh -c 'kill -USR1 $PPID'; echo after:$?",
	),
	(
		r"rm/unset-f-localtraps",
		r"TRAPUSR1() { echo outer; }; f() { setopt localtraps; unset -f TRAPUSR1; }; f; kill -USR1 $$; echo after:$?",
	),
	(
		r"rm/unset-f-outside",
		r"TRAPUSR1() { echo fn; }; unset -f TRAPUSR1; sh -c 'kill -USR1 $PPID'; echo after:$?",
	),
	(
		r"rm/disable-outside",
		r"TRAPUSR1() { echo fn; }; disable -f TRAPUSR1; sh -c 'kill -USR1 $PPID'; echo after:$?",
	),
	(
		r"rm/disable-enable-outside",
		r"TRAPUSR1() { echo fn; }; disable -f TRAPUSR1; enable -f TRAPUSR1; sh -c 'kill -USR1 $PPID'; echo after:$?",
	),
	(
		r"rm/disable-listing",
		r"TRAPUSR1() { echo fn; }; TRAPUSR2() { echo two; }; disable -f TRAPUSR1; trap; whence -w TRAPUSR1; enable -f TRAPUSR1; trap",
	),
	(
		r"rm/disable-list-trap",
		r"trap 'echo list' USR1; TRAPUSR1() { echo fn; }; disable -f TRAPUSR1; enable -f TRAPUSR1; kill -USR1 $$; echo after:$?",
	),
	(r"kill/list-status", r"trap 'echo in:$?' USR1; (exit 3); kill -USR1 $$; echo after:$?"),
	(r"kill/twice", r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -USR1 $$ $$; echo after:$?"),
	(r"kill/twice-list", r"trap 'echo in:$?' USR1; (exit 3); kill -USR1 $$ $$; echo after:$?"),
	(
		r"kill/no-such-pid",
		r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -USR1 $$ 999999 2>/dev/null; echo after:$?",
	),
	(r"kill/dash-s", r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -s USR1 $$; echo after:$?"),
	(
		r"kill/list-return-in-fn",
		r"trap 'return 3' USR1; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"kill/list-return-outside",
		r"trap 'return 3' USR1; f() { sh -c 'kill -USR1 $PPID'; echo f:$?; }; f; echo top:$?",
	),
	(
		r"kill/fn-return-outside",
		r"TRAPUSR1() { echo in:$?; return 3; }; (exit 5); sh -c 'kill -USR1 $PPID'; echo after:$?; echo more",
	),
	(
		r"kill/fn-return-in-fn",
		r"TRAPUSR1() { echo in:$?; return 3; }; f() { (exit 5); kill -USR1 $$; echo f:$?; return 6; }; f; echo top:$?",
	),
	(
		r"kill/subshell",
		r"zmodload zsh/system; TRAPUSR1() { echo in:$?; return 4; }; ( (exit 3); kill -USR1 $sysparams[pid]; echo sub:$? ); echo top:$?",
	),
	(
		r"kill/always",
		r"TRAPUSR1() { return 3; }; { kill -USR1 $$; echo in-group; } always { echo always:$?; }; echo after",
	),
	(r"kill/INT-return", r"TRAPINT() { return 5; }; kill -INT $$; echo after:$?"),
	(r"kill/INT-return-outside", r"TRAPINT() { return 5; }; sh -c 'kill -INT $PPID'; echo after:$?"),
	(
		r"kill/INT-return-in-fn",
		r"TRAPINT() { return 5; }; f() { kill -INT $$; echo f; }; f; echo top:$?",
	),
	(r"kill/QUIT-return", r"TRAPQUIT() { return 5; }; kill -QUIT $$; echo after:$?"),
	(
		r"kill/QUIT-return-outside",
		r"TRAPQUIT() { return 5; }; sh -c 'kill -QUIT $PPID'; echo after:$?",
	),
	(
		r"kill/QUIT-return-in-fn",
		r"TRAPQUIT() { return 5; }; f() { kill -QUIT $$; echo f; }; f; echo top:$?",
	),
	(r"kill/group", r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -USR1 0; echo after:$?"),
	(
		r"kill/again",
		r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -USR1 $$; (exit 4); kill -USR1 $$; echo after:$?",
	),
	(
		r"kill/then-outside",
		r"TRAPUSR1() { echo in:$?; }; (exit 3); kill -USR1 $$; (exit 4); sh -c 'kill -USR1 $PPID'; echo after:$?",
	),
	(
		r"ret/return_0",
		r"TRAPUSR1() { echo in:$?; return 0; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(
		r"ret-fn/return_0",
		r"TRAPUSR1() { return 0; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"ret-loop/return_0",
		r"TRAPUSR1() { return 0; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/return_1",
		r"TRAPUSR1() { echo in:$?; return 1; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(
		r"ret-fn/return_1",
		r"TRAPUSR1() { return 1; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"ret-loop/return_1",
		r"TRAPUSR1() { return 1; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/return_3",
		r"TRAPUSR1() { echo in:$?; return 3; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(
		r"ret-fn/return_3",
		r"TRAPUSR1() { return 3; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"ret-loop/return_3",
		r"TRAPUSR1() { return 3; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/return_128plus",
		r"TRAPUSR1() { echo in:$?; return $((128+$1)); }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(
		r"ret-fn/return_128plus",
		r"TRAPUSR1() { return $((128+$1)); }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"ret-loop/return_128plus",
		r"TRAPUSR1() { return $((128+$1)); }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/true",
		r"TRAPUSR1() { echo in:$?; true; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(r"ret-fn/true", r"TRAPUSR1() { true; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?"),
	(
		r"ret-loop/true",
		r"TRAPUSR1() { true; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/return",
		r"TRAPUSR1() { echo in:$?; return; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(r"ret-fn/return", r"TRAPUSR1() { return; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?"),
	(
		r"ret-loop/return",
		r"TRAPUSR1() { return; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/false;_return",
		r"TRAPUSR1() { echo in:$?; false; return; }; (exit 3); kill -USR1 $$; echo after:$?; echo more",
	),
	(
		r"ret-fn/false;_return",
		r"TRAPUSR1() { false; return; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"ret-loop/false;_return",
		r"TRAPUSR1() { false; return; }; for i in 1 2; do kill -USR1 $$; echo it$i:$?; done; echo end:$?",
	),
	(
		r"ret/nested-return",
		r"g() { return 5; }; TRAPUSR1() { g; echo g:$?; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"ret/int-128plus",
		r"TRAPINT() { echo int:$1; return $((128+$1)); }; kill -INT $$; echo after:$?",
	),
	(
		r"ret/term-128plus",
		r"TRAPTERM() { echo term:$1; return $((128+$1)); }; kill -TERM $$; echo after:$?",
	),
	(
		r"ret/errexit",
		r"setopt errexit; TRAPUSR1() { echo F; return 1; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"ret/errexit-false",
		r"setopt errexit; TRAPUSR1() { echo F; false; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"args/positional",
		r"set -- a b c; TRAPUSR1() { echo in:$#:$1:$0; }; kill -USR1 $$; echo out:$#:$1:${0:t}",
	),
	(r"args/local", r"x=out; TRAPUSR1() { local x=in; echo $x; y=set; }; kill -USR1 $$; echo $x:$y"),
	(r"args/funcstack", r"TRAPUSR1() { echo ${(j:,:)funcstack}; }; f() { kill -USR1 $$; }; f"),
	(r"direct/usr1", r"TRAPUSR1() { echo F:$1:$#; return 3; }; TRAPUSR1 x y; echo after:$?"),
	(r"direct/zerr", r"TRAPZERR() { echo Z:$#; }; TRAPZERR; echo after:$?"),
	(r"direct/then-signal", r"TRAPUSR1() { echo F:$1; }; TRAPUSR1 7; kill -USR1 $$; echo after:$?"),
	(
		r"sub/fn-kept",
		r"zmodload zsh/system; TRAPUSR1() { echo F:$1; }; ( kill -USR1 $sysparams[pid]; echo sub:$? ); echo top:$?",
	),
	(
		r"sub/list-reset",
		r"zmodload zsh/system; trap 'echo L' USR1; ( kill -USR1 $sysparams[pid]; echo sub:$? ); echo top:$?",
	),
	(
		r"sub/cmdsub",
		r#"zmodload zsh/system; TRAPUSR1() { echo F; }; x=$( kill -USR1 $sysparams[pid]; echo in ); echo "x=$x:$?""#,
	),
	(
		r"sub/background",
		r"zmodload zsh/system; TRAPUSR1() { echo F; }; { kill -USR1 $sysparams[pid]; echo bg; } & wait $!; echo st:$?",
	),
	(
		r"sub/pipeline",
		r"zmodload zsh/system; TRAPUSR1() { echo F; }; { kill -USR1 $sysparams[pid]; echo el; } | cat; echo st:$?",
	),
	(
		r"sub/parent-from-subshell",
		r"TRAPUSR1() { echo F; }; ( kill -USR1 $$; echo sub ); echo top:$?",
	),
	(r"sub/parent-from-external", r"TRAPUSR1() { echo F; }; sh -c 'kill -USR1 $PPID'; echo top:$?"),
	(
		r"sub/unfunction-in-subshell",
		r"zmodload zsh/system; TRAPUSR1() { echo F; }; ( unfunction TRAPUSR1; kill -USR1 $sysparams[pid]; echo sub ); echo top:$?; kill -USR1 $$; echo after:$?",
	),
	(
		r"sub/define-in-subshell",
		r"zmodload zsh/system; ( TRAPUSR1() { echo F; }; kill -USR1 $sysparams[pid]; echo sub:$? ); echo top:$?; kill -USR1 $$; echo after:$?",
	),
	(
		r"fn/fires-in-function",
		r"TRAPUSR1() { echo F; }; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		r"fn/defined-in-function",
		r"f() { TRAPUSR1() { echo inner; }; }; f; kill -USR1 $$; echo after:$?",
	),
	(
		r"fn/localtraps",
		r"TRAPUSR1() { echo outer; }; f() { setopt localtraps; TRAPUSR1() { echo inner; }; kill -USR1 $$; }; f; kill -USR1 $$; echo after:$?",
	),
	(
		r"fn/localtraps-new",
		r"f() { setopt localtraps; TRAPUSR1() { echo inner; }; kill -USR1 $$; echo f:$?; }; f; echo top; kill -USR1 $$; echo after:$?",
	),
	(
		r"fn/localtraps-unfunction",
		r"TRAPUSR1() { echo outer; }; f() { setopt localtraps; unfunction TRAPUSR1; trap 'echo list' USR1; kill -USR1 $$; }; f; kill -USR1 $$; echo after:$?",
	),
	(
		r"nest/same",
		r"n=0; TRAPUSR1() { echo F$((++n)); (( n < 3 )) && kill -USR1 $$; echo end$n; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"nest/other",
		r"TRAPUSR1() { echo U1; kill -USR2 $$; echo U1b; }; TRAPUSR2() { echo U2; }; kill -USR1 $$; echo after:$?",
	),
	(
		r"nest/list-same",
		r"n=0; trap 'echo L$((++n)); (( n < 3 )) && kill -USR1 $$; echo L2' USR1; kill -USR1 $$; echo after:$?",
	),
	(r"null/self", r"TRAPUSR1() {}; kill -USR1 $$; echo after:$?"),
	(r"null/child", r"TRAPUSR1() {}; sh -c 'kill -USR1 $$; echo child'; echo top:$?"),
	(r"fn/child-default", r"TRAPUSR1() { echo F; }; sh -c 'kill -USR1 $$; echo child'; echo top:$?"),
	(
		r"winch/wait-fn",
		r"TRAPWINCH() { echo got; }; sleep 0.3 & kill -WINCH $$; wait $!; echo st:$?",
	),
	(r"winch/wait-list", r"trap 'echo got' WINCH; sleep 0.3 & kill -WINCH $$; wait $!; echo st:$?"),
	(
		r"winch/after-program",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; echo a; /bin/sleep 0.1; echo after",
	),
	(
		r"winch/after-subshell",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; echo a; (sleep 0.1; echo sub); echo after",
	),
	(
		r"winch/after-pipeline",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; echo a; echo p | (sleep 0.1; cat); echo after",
	),
	(
		r"winch/after-builtin-only",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; echo a; echo b; read -r x < /dev/null; echo after",
	),
	(
		r"winch/after-function",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; echo a; f() { echo f; }; f; echo after",
	),
	(
		r"winch/during-program",
		r"TRAPWINCH() { echo got; }; sh -c 'kill -WINCH $PPID; sleep 0.2'; echo after",
	),
	(
		r"winch/after-program-list",
		r"trap 'echo got' WINCH; kill -WINCH $$; /bin/sleep 0.1; echo after",
	),
	(
		r"winch/once",
		r"TRAPWINCH() { echo got; }; kill -WINCH $$; /bin/sleep 0.1; echo a; /bin/sleep 0.1; echo after",
	),
	(r"exit/exit-n", r"TRAPEXIT() { echo bye:$1:$?; }; exit 3"),
	(r"exit/end", r"TRAPEXIT() { echo bye:$?; }; echo main; false"),
	(r"exit/return-status", r"TRAPEXIT() { echo bye; return 7; }; exit 3"),
	(r"exit/function", r"f() { TRAPEXIT() { echo fexit:$?; }; return 4; }; f; echo top:$?"),
	(r"exit/unfunction", r"TRAPEXIT() { echo bye; }; unfunction TRAPEXIT; echo main"),
	(r"exit/trap-dash", r"TRAPEXIT() { echo bye; }; trap - EXIT; echo main"),
	(r"exit/subshell", r"TRAPEXIT() { echo bye; }; ( echo sub ); echo top"),
	(r"exit/replaces-list", r"trap 'echo list' EXIT; TRAPEXIT() { echo fn; }; echo main"),
	(
		r"exit/signal",
		r"TRAPEXIT() { echo bye:$?; }; TRAPUSR1() { echo F; }; kill -USR1 $$; echo after",
	),
	(r"exit/killed", r"TRAPEXIT() { echo bye:$?; }; kill -USR2 $$; echo after"),
	(
		r"exit/function-return",
		r"f() { TRAPEXIT() { echo fx:$?; return 9; }; return 4; }; f; echo top:$?",
	),
	(r"exit/list-return", r"trap 'echo bye; return 7' EXIT; exit 3"),
	(r"zerr/basic", r"TRAPZERR() { echo zerr:$1:$?; }; false; echo after:$?"),
	(r"zerr/return-1", r"TRAPZERR() { echo Z; return 1; }; false; echo after:$?"),
	(r"zerr/andor", r"TRAPZERR() { echo Z; }; false && true; false || true; echo end:$?"),
	(r"zerr/unfunction", r"TRAPZERR() { echo Z; }; unfunction TRAPZERR; false; echo after:$?"),
	(r"zerr/subshell", r"TRAPZERR() { echo Z; }; ( false ); echo after:$?"),
	(r"zerr/in-function", r"TRAPZERR() { echo Z; }; f() { false; echo f; }; f; echo top:$?"),
	(r"zerr/return-0", r"TRAPZERR() { echo Z; return 0; }; false; echo after:$?"),
	(r"zerr-callret0/list/none", r"trap 'echo T$?' ZERR; f() { false; return 0; }; f; echo end:$?"),
	(
		r"zerr-call/list/errexit",
		r"setopt errexit; trap 'echo T$?' ZERR; f() { false; return 2; }; f; echo end:$?",
	),
	(r"zerr-pipe/list/errexit", r"setopt errexit; trap 'echo T$?' ZERR; true | false; echo end:$?"),
	(
		r"zerr-pipe3/list/errexit",
		r"setopt errexit; trap 'echo T$?' ZERR; false | true | false; echo end:$?",
	),
	(
		r"zerr-callret0/list/errexit",
		r"setopt errexit; trap 'echo T$?' ZERR; f() { false; return 0; }; f; echo end:$?",
	),
	(
		r"zerr-callret0/fn/none",
		r"TRAPZERR() { echo T$?; }; f() { false; return 0; }; f; echo end:$?",
	),
	(
		r"zerr-call/fn/errexit",
		r"setopt errexit; TRAPZERR() { echo T$?; }; f() { false; return 2; }; f; echo end:$?",
	),
	(
		r"zerr-pipe/fn/errexit",
		r"setopt errexit; TRAPZERR() { echo T$?; }; true | false; echo end:$?",
	),
	(
		r"zerr-pipe3/fn/errexit",
		r"setopt errexit; TRAPZERR() { echo T$?; }; false | true | false; echo end:$?",
	),
	(
		r"zerr-callret0/fn/errexit",
		r"setopt errexit; TRAPZERR() { echo T$?; }; f() { false; return 0; }; f; echo end:$?",
	),
	(r"debug/basic", r"TRAPDEBUG() { echo dbg:$1; }; echo a; echo b"),
	(r"debug/unfunction", r"TRAPDEBUG() { echo dbg; }; echo a; unfunction TRAPDEBUG; echo b"),
	(r"debug/return-1", r"TRAPDEBUG() { echo dbg; return 1; }; echo a; echo b"),
	(r"chld/basic", r"TRAPCHLD() { echo chld:$1; }; sleep 0 & wait; echo after:$?"),
	(
		r"chld/unfunction",
		r"TRAPCHLD() { echo chld; }; unfunction TRAPCHLD; sleep 0 & wait; echo after",
	),
	(r"alrm/tmout-script", r"TMOUT=1; TRAPALRM() { echo alrm; }; sleep 2; echo after:$?"),
];

/// The bash rows: a `CHLD` sent as a signal runs no trap (bash's handler
/// only reaps); one per reaped child still does.
const BASH_ROWS: &[Row] = &[
	("chld/kill-self", "trap 'echo got' CHLD; kill -CHLD $$; echo after:$?"),
	(
		"chld/kill-self-then-child",
		"trap 'echo got' CHLD; sleep 30 & p=$!; kill -CHLD $$; echo after:$?; kill $p; wait; echo w",
	),
	("chld/kill-subshell", "trap 'echo got' CHLD; (kill -CHLD $BASHPID; echo sub); echo top"),
	("winch/kill-self", "trap 'echo got' WINCH; kill -WINCH $$; echo after:$?"),
];

/// zsh rows also run under obash's fault injector, which snapshots and
/// restores the shell at many ops: a trap function's disposition, a
/// disabled function, a self-sent signal's record and a held `WINCH`
/// survive the frames image. None of them dies of a signal: under the
/// injector obash exits 128 + n where it would die of the signal.
const ZSH_SNAPSHOT_ROWS: &[&str] = &[
	"def/USR1",
	"def/WINCH",
	"rm/disable-listing",
	"rm/disable-enable",
	"kill/twice",
	"kill/list-return-in-fn",
	"kill/fn-return-in-fn",
	"exit/return-status",
	"alias/CLD",
	"zerr/basic",
	"sub/fn-kept",
	"winch/once",
	"kill/again",
];

/// The program's name before `: line` (bash) as `SH`.
fn normalized_stderr(stderr: &[u8]) -> String {
	String::from_utf8_lossy(stderr)
		.split_inclusive('\n')
		.map(|line| match line.find(": ") {
			Some(i)
				if !line[..i].contains(':')
					&& (line[..i].contains("bash") || line[..i].contains("zsh")) =>
			{
				format!("SH{}", &line[i..])
			},
			_ => line.to_owned(),
		})
		.collect()
}

/// What a row did: stdout, normalised stderr, exit status (negative: the
/// signal that killed the shell).
type Outcome = (String, String, i32);

/// What runs a row.
#[derive(Clone, Copy)]
enum Runner<'a> {
	/// The obash under test.
	Obash,
	/// The obash under test with its fault injector at every op
	/// (`PI_SHELL_FAULT=1:1`).
	ObashSnapshots,
	/// The oracle shell at this path.
	Oracle(&'a str),
}

/// Run `script` as `dialect` with `runner`.
fn run_row(dialect: Dialect, runner: Runner<'_>, script: &str) -> Outcome {
	let mut cmd = match runner {
		Runner::Oracle(program) => command(program),
		Runner::Obash | Runner::ObashSnapshots => obash(),
	};
	if matches!(runner, Runner::ObashSnapshots) {
		cmd.env("PI_SHELL_FAULT", "1:1");
	}
	if dialect == Dialect::Zsh {
		if !matches!(runner, Runner::Oracle(_)) {
			cmd.arg0("zsh");
		}
		cmd.arg("-f");
	}
	let out = output(cmd.args(["-c", script]));
	let status = out
		.status
		.code()
		.or_else(|| out.status.signal().map(|sig| -sig))
		.unwrap();
	(String::from_utf8_lossy(&out.stdout).into_owned(), normalized_stderr(&out.stderr), status)
}

fn fixture(dialect: Dialect) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests/fixtures/zsh_function_traps")
		.join(format!("{}.jsonl", dialect.name()))
}

/// The recorded rows of `dialect`, by id: script and outcome.
fn recorded(dialect: Dialect) -> BTreeMap<String, (String, Outcome)> {
	let text = fs::read_to_string(fixture(dialect)).unwrap();
	text
		.lines()
		.map(|line| {
			let v: Value = serde_json::from_str(line).unwrap();
			let s = |k: &str| v[k].as_str().unwrap().to_owned();
			let status = i32::try_from(v["status"].as_i64().unwrap()).unwrap();
			(s("id"), (s("script"), (s("stdout"), s("stderr"), status)))
		})
		.collect()
}

/// Run every row (on a few threads), in order.
fn run_all(dialect: Dialect, runner: Runner<'_>, rows: &[Row]) -> Vec<Outcome> {
	let next = AtomicUsize::new(0);
	let mut slots: Vec<Option<Outcome>> = vec![None; rows.len()];
	let results: Vec<Vec<(usize, Outcome)>> = thread::scope(|s| {
		let workers: Vec<_> = (0..8)
			.map(|_| {
				s.spawn(|| {
					let mut mine = Vec::new();
					loop {
						let i = next.fetch_add(1, Ordering::Relaxed);
						let Some((_, script)) = rows.get(i) else {
							break;
						};
						mine.push((i, run_row(dialect, runner, script)));
					}
					mine
				})
			})
			.collect();
		workers.into_iter().map(|w| w.join().unwrap()).collect()
	});
	for (i, outcome) in results.into_iter().flatten() {
		slots[i] = Some(outcome);
	}
	slots.into_iter().map(Option::unwrap).collect()
}

/// Assert that each row did what the record says, reporting every row that
/// differs.
fn assert_recorded(
	dialect: Dialect,
	rows: &[Row],
	got: &[Outcome],
	record: &BTreeMap<String, (String, Outcome)>,
) {
	let mut differ = Vec::new();
	for ((id, script), outcome) in rows.iter().zip(got) {
		let (want_script, want) = record
			.get(*id)
			.unwrap_or_else(|| panic!("no record of {id}"));
		assert_eq!(want_script, script, "the record of {id} has another script");
		if outcome != want {
			differ
				.push(format!("{id}: `{script}`\n  {}: {want:?}\n  got: {outcome:?}", dialect.name()));
		}
	}
	assert!(
		differ.is_empty(),
		"{} of {} rows differ from {}:\n{}",
		differ.len(),
		rows.len(),
		dialect.name(),
		differ.join("\n")
	);
}

/// Run `rows` in obash, or in the oracle `PI_FNTRAP_BASH`/`PI_FNTRAP_ZSH`
/// names, and assert the recorded outcome of each. With `PI_FNTRAP_BLESS`
/// and an oracle, rewrite the record from it instead.
fn assert_rows(dialect: Dialect, rows: &[Row]) {
	let oracle = env::var(match dialect {
		Dialect::Bash => "PI_FNTRAP_BASH",
		Dialect::Zsh => "PI_FNTRAP_ZSH",
	})
	.ok();
	let runner = oracle.as_deref().map_or(Runner::Obash, Runner::Oracle);
	let got = run_all(dialect, runner, rows);
	if oracle.is_some() && env::var_os("PI_FNTRAP_BLESS").is_some() {
		let mut text = String::new();
		let mut sorted: Vec<_> = rows.iter().zip(got).collect();
		sorted.sort_by_key(|((id, _), _)| *id);
		for ((id, script), (stdout, stderr, status)) in sorted {
			let row = json!({"id": id, "script": script, "stdout": stdout, "stderr": stderr, "status": status});
			let _ = writeln!(text, "{row}");
		}
		fs::write(fixture(dialect), text).unwrap();
		return;
	}
	let record = recorded(dialect);
	assert_eq!(record.len(), rows.len(), "the record's rows are not these rows");
	assert_recorded(dialect, rows, &got, &record);
}

/// Every zsh row as zsh 5.9 runs it.
#[test]
fn zsh_rows_match_zsh() {
	assert_rows(Dialect::Zsh, ZSH_ROWS);
}

/// Every bash row as bash runs it.
#[test]
fn bash_rows_match_bash() {
	assert_rows(Dialect::Bash, BASH_ROWS);
}

/// [`ZSH_SNAPSHOT_ROWS`] across snapshots.
#[test]
fn zsh_rows_survive_a_snapshot() {
	let rows: Vec<Row> = ZSH_ROWS
		.iter()
		.copied()
		.filter(|(id, _)| ZSH_SNAPSHOT_ROWS.contains(id))
		.collect();
	assert_eq!(rows.len(), ZSH_SNAPSHOT_ROWS.len(), "a snapshot row id names no row");
	let got = run_all(Dialect::Zsh, Runner::ObashSnapshots, &rows);
	assert_recorded(Dialect::Zsh, &rows, &got, &recorded(Dialect::Zsh));
}
