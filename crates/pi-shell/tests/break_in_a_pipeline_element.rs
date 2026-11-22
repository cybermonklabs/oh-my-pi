//! `break` and `continue` inside a pipeline element, a subshell or a
//! command substitution, as bash 5.3.20 and zsh 5.9 run them.
//!
//! The grid: word (`break`, `continue`) × count (none, `2` with an outer
//! loop) × position in the pipeline (first, middle, last, and the word
//! alone as the control) × option (none, `pipefail`, bash's `lastpipe`) ×
//! context (`for`, `while`, `until`, `select`, a function called from the
//! loop, `( … )` and `$( … )` in the loop, a `{ …; }` group as the
//! element). The forks: the other children that carry the loop level or
//! not (jobs, process substitutions, backticks, coprocesses, the
//! not-found hook), a child's own loops beside its parent's, counts
//! through `eval`, and the message's redirections and order. Each row
//! prints where it is (`a<n>` per iteration, `b<n>:$?` after the element,
//! `e:$?` after the loop), so its output says whether the body and the
//! loop went on. A few rows also run under obash's fault injector, which
//! snapshots and restores the shell at many ops, so that a forked child's
//! loop count must survive the frames image.
//!
//! The traps: `break` and `continue`, with and without a count, in a
//! signal, ERR, DEBUG and (bash) RETURN trap action that fires in a loop
//! body or in a function called from the loop, and the shapes around them
//! (the rest of the action, its status, `set -e`, top level). The ERR
//! rows count how often the ERR (zsh: ZERR) trap runs, and with what
//! status, for loops, conditions, lists, `!`, compounds and functions.
//!
//! The expected rows are the oracles' output, recorded in
//! `tests/fixtures/break_in_a_pipeline_element/{bash,zsh}.jsonl` (stdout,
//! status, and stderr with the program name before `: line` as `SH`).
//! bash 5.2.21 agrees on every bash row but the three `${ ;}` ones (5.2
//! has no `${ ;}`). `PI_LOOP_BASH=<bash>` / `PI_LOOP_ZSH=<zsh>` run that
//! shell instead of obash against the records; with `PI_LOOP_BLESS=1`
//! they rewrite them (one test at a time: `--test-threads=1`). zsh has no
//! `fork/x0/redirected-element` row: zsh 5.9 itself sometimes dies of
//! SIGSEGV on it (2 of 30 runs).
#![cfg(unix)]

mod obash_support;

use std::{
	collections::BTreeMap,
	env,
	fmt::Write as _,
	fs,
	os::unix::process::CommandExt,
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
type Row = (String, String);

/// `word` with the row's count.
fn element(word: &str, count: &str) -> String {
	if count == "none" {
		word.to_owned()
	} else {
		format!("{word} 2")
	}
}

/// The pipeline holding the element at `position`.
fn pipeline(word: &str, count: &str, position: &str) -> String {
	let e = element(word, count);
	match position {
		"first" => format!("{e} | :"),
		"middle" => format!(": | {e} | :"),
		"last" => format!(": | {e}"),
		_ => e,
	}
}

/// The loop of `context` running the element.
fn inner(word: &str, count: &str, position: &str, context: &str) -> String {
	let p = pipeline(word, count, position);
	match context {
		"for" => format!("for i in 1 2; do echo a$i; {p}; echo b$i:$?; done; echo e:$?"),
		"while" => format!(
			"i=0; while [ $i -lt 2 ]; do i=$((i+1)); echo a$i; {p}; echo b$i:$?; done; echo e:$?"
		),
		"until" => format!(
			"i=0; until [ $i -ge 2 ]; do i=$((i+1)); echo a$i; {p}; echo b$i:$?; done; echo e:$?"
		),
		"select" => format!(
			"select i in 1 2; do echo a$REPLY; {p}; echo b$REPLY:$?; done <<< $'1\\n2'; echo e:$?"
		),
		// The function is defined before the loops (see `grid_script`).
		"function" => "for i in 1 2; do echo a$i; f; echo b$i:$?; done; echo e:$?".to_owned(),
		"subshell" => {
			format!("for i in 1 2; do echo a$i; ( {p}; echo s:$? ); echo b$i:$?; done; echo e:$?")
		},
		"cmdsub" => format!(
			"for i in 1 2; do echo a$i; x=$( {p}; echo s:$? ); echo \"b$i:$?:$x\"; done; echo e:$?"
		),
		"group" => {
			let e = element(word, count);
			let g = match position {
				"first" => format!("{{ {e}; echo g; }} | cat"),
				"middle" => format!(": | {{ {e}; echo g; }} | cat"),
				"last" => format!(": | {{ {e}; echo g; }}"),
				_ => format!("{{ {e}; echo g; }}"),
			};
			format!("for i in 1 2; do echo a$i; {g}; echo b$i:$?; done; echo e:$?")
		},
		_ => unreachable!("{context}"),
	}
}

fn grid_script(
	dialect: Dialect,
	word: &str,
	count: &str,
	position: &str,
	option: &str,
	context: &str,
) -> String {
	let mut pre = match option {
		"pipefail" if dialect == Dialect::Bash => "set -o pipefail; ".to_owned(),
		"pipefail" => "setopt pipefail; ".to_owned(),
		"lastpipe" => "shopt -s lastpipe; ".to_owned(),
		_ => String::new(),
	};
	if context == "function" {
		let _ = write!(pre, "f() {{ {}; echo f:$?; }}; ", pipeline(word, count, position));
	}
	let mut body = inner(word, count, position, context);
	if count == "2" {
		body = format!("for o in X Y; do echo o$o; {body}; echo c$o:$?; done; echo E:$?");
	}
	pre + &body
}

/// The grid's rows, `grid/<context>/<word>/<count>/<position>/<option>`.
fn grid(dialect: Dialect) -> Vec<Row> {
	let mut rows = Vec::new();
	for context in ["for", "while", "until", "select", "function", "subshell", "cmdsub", "group"] {
		for word in ["break", "continue"] {
			for count in ["none", "2"] {
				for position in ["first", "middle", "last", "alone"] {
					for option in ["none", "pipefail", "lastpipe"] {
						if option == "lastpipe" && dialect == Dialect::Zsh {
							continue;
						}
						rows.push((
							format!("grid/{context}/{word}/{count}/{position}/{option}"),
							grid_script(dialect, word, count, position, option, context),
						));
					}
				}
			}
		}
	}
	rows
}

/// The fork shapes both shells run.
const COMMON_FORKS: &[(&str, &str)] = &[
	("bg-simple", "break & wait"),
	("bg-continue", "continue & wait"),
	("bg-pipeline", ": | break & wait"),
	("bg-not", "! break & wait"),
	("bg-eval", "eval break & wait"),
	("bg-group", "{ break; echo g; } & wait"),
	("bg-andor", ": && break & wait"),
	("bg-subshell", "(break; echo s) & wait"),
	("bg-function", "f() { break; echo h; }; f & wait"),
	("backtick", "x=`break; echo s`; echo \"x=$x\""),
	(
		"cmdsub-own-loop-break2",
		"x=$(for j in 1 2; do echo j$j; break 2; echo in; done; echo s); echo \"x=$x\"",
	),
	(
		"cmdsub-own-loop-continue2",
		"x=$(for j in 1 2; do echo j$j; continue 2; echo in; done; echo s); echo \"x=$x\"",
	),
	(
		"cmdsub-own-loop-break3",
		"x=$(for j in 1 2; do echo j$j; break 3; echo in; done; echo s); echo \"x=$x\"",
	),
	("cmdsub-exit-trap", "x=$(trap 'echo T' EXIT; break; echo s); echo \"x=$x\""),
	("cmdsub-status", "x=$(false; break); echo \"st=$?\""),
	("cmdsub-nested", "x=$(y=$(break; echo in); echo \"s$y\"); echo \"x=$x\""),
	("cmdsub-subshell", "x=$( (break; echo in); echo s); echo \"x=$x\""),
	// Defined outside: bash numbers the lines of a function defined inside
	// `$( … )` from 3, obash from 1 (older than this test, any message).
	("cmdsub-function", "f() { break; echo h; }; x=$(f); echo \"x=$x\""),
	("cmdsub-pipeline", "x=$(: | break; echo s); echo \"x=$x\""),
	("eval-element", "eval break | :"),
	("eval-cmdsub", "x=$(eval break; echo s); echo \"x=$x\""),
	("eval-count-break", "eval 'for j in 1 2; do break 3; done; echo in'; echo out"),
	("eval-count-continue", "eval 'for j in 1 2; do continue 2; done; echo in'; echo out"),
	("function-element", "g() { break; echo gg; }; g | cat"),
	("subshell-element", "( break; echo s ) | cat"),
	("redirected-element", ": | break 2>/dev/null"),
	("redirected-alone", "break 2>/dev/null"),
	("if-element", "if :; then break; fi | :"),
	("loop-element", "while :; do break 2; done | :"),
	("not-element", "! break | :"),
	("pipeline-in-a-job", "{ : | break; echo g; } & wait"),
	("count0-element", "break 0 | :"),
	("count0-alone", "break 0"),
	("countx-element", "break x | :"),
	("procsub", "cat <(break; echo s)"),
	// A word's substitution body is lowered ahead of the command's own op:
	// the forked simple command still keeps the level, for a `$( )`,
	// backtick or `<( )` word or assignment (`$(( ))` has no body: the
	// control), and a `break` inside the substitution ends only it.
	("element-cmdsub-word", ": | break $(echo 1)"),
	("element-arith-word", ": | break $((1))"),
	("first-element-cmdsub-word", "break $(echo 1) | :"),
	("middle-element-cmdsub-word", ": | break $(:) | :"),
	("element-backtick-word", ": | break `echo 1`"),
	("element-assign-cmdsub-word", ": | v=$(:) break"),
	("element-cmdsub-break-inside", ": | echo \"[$(break; echo s)]\" | cat"),
	("element-backtick-break-inside", ": | echo \"[`break; echo s`]\" | cat"),
	("element-procsub-break-inside", ": | cat <(break; echo s)"),
	("bg-cmdsub-word", "break $(echo 1) & wait"),
	("bg-arith-word", "break $((1)) & wait"),
	("bg-backtick-word", "break `echo 1` & wait"),
	("bg-assign-cmdsub-word", "v=$(:) break & wait"),
	("bg-cmdsub-break-inside", "echo \"[$(break; echo s)]\" & wait"),
];

/// The fork shapes only bash runs.
const BASH_FORKS: &[(&str, &str)] = &[
	("bg-timed", "TIMEFORMAT=; time break & wait"),
	("coproc-group", "coproc { break; echo g; }; wait"),
	("coproc-pipeline", "coproc : | break; wait"),
	("not-found-hook", "command_not_found_handle() { break; echo h; }; nosuch_cmd_x"),
	("nofork-cmdsub", "x=${ break; echo s; }; echo \"x=$x\""),
	("lastpipe-cmdsub", "shopt -s lastpipe; x=$(: | break; echo s); echo \"x=$x\""),
	("lastpipe-element", "shopt -s lastpipe; : | break"),
	("posix-element", "set -o posix; : | break"),
	("posix-alone", "set -o posix; break"),
	("element-procsub-word", ": | x=<(:) break"),
	("bg-procsub-word", "x=<(:) break & wait"),
	// The element's `$BASH_SUBSHELL` is its parent's (a simple command).
	("element-subshell-level-cmdsub-word", "echo $BASH_SUBSHELL $(:) | cat"),
];

/// The fork shapes only zsh runs.
const ZSH_FORKS: &[(&str, &str)] = &[
	("procsub-file", "cat =(break; echo s)"),
	("repeat-element", "repeat 1 do : | break; echo r; done"),
	// Its message is silenced: zsh names `emulate -c` code `zsh`, obash
	// `(eval)`.
	("sh-emulation-element", "emulate sh -c ': | break 2>/dev/null; echo z'"),
	("coproc-group", "coproc { break; echo g; }; cat <&p"),
	("not-found-hook", "command_not_found_handler() { break; echo h; }; nosuch_cmd_x"),
	// What the pty shows is tested by its words: zsh names a zpty
	// command's code `zsh`, obash `(zpty)`; and `zpty -r`'s status for a
	// command that has ended depends on when zsh reaps it.
	(
		"zpty",
		"zmodload zsh/zpty; zpty z 'break; echo in'; zpty -r z l; [[ $l == *'not in while'* ]] && \
		 echo msg; [[ $l == in* ]] && echo in; zpty -d z",
	),
];

/// The fork rows, `fork/x<loops>/<name>`: each shape at top level, in a
/// loop and in two loops; bash's `jobs` element at top level; then two
/// whole scripts whose substitution bash re-parses (a line before the end
/// of the top-level command).
fn forks(dialect: Dialect) -> Vec<Row> {
	let own = if dialect == Dialect::Bash {
		BASH_FORKS
	} else {
		ZSH_FORKS
	};
	let mut rows = Vec::new();
	for &(name, x) in COMMON_FORKS.iter().chain(own) {
		// zsh 5.9 itself dies of SIGSEGV on `: | break 2>/dev/null` at top
		// level now and then (2 of 30 runs), so it records no outcome for it.
		if !(dialect == Dialect::Zsh && name == "redirected-element") {
			rows.push((format!("fork/x0/{name}"), format!("{x}; echo top:$?")));
		}
		rows.push((
			format!("fork/x1/{name}"),
			format!("for i in 1 2; do echo a$i; {x}; echo b$i:$?; done; echo e:$?"),
		));
		rows.push((
			format!("fork/x2/{name}"),
			format!(
				"for o in X Y; do echo o$o; for i in 1 2; do echo a$i; {x}; echo b$i:$?; done; echo \
				 e:$?; echo c$o:$?; done; echo E:$?"
			),
		));
	}
	// A `jobs` element with a substitution word keeps the job list (one
	// level only: bash 5.3.20 also lists the job the first iteration
	// killed).
	if dialect == Dialect::Bash {
		rows.push((
			"fork/x0/element-jobs-cmdsub-word".to_owned(),
			"sleep 5 & jobs -p $(:) | wc -l; kill $!; echo top:$?".to_owned(),
		));
	}
	rows.push((
		"fork/lines/cmdsub".to_owned(),
		"for i in 1 2\ndo x=$(break; echo s)\necho \"x=$x\"\ndone\necho e:$?".to_owned(),
	));
	rows.push((
		"fork/lines/cmdsub-own-loop".to_owned(),
		"for i in 1 2\ndo x=$(for j in 1 2; do echo j$j; break 2; done; echo s)\necho \
		 \"x=$x\"\ndone\necho e:$?"
			.to_owned(),
	));
	rows
}

/// The trap action and the command that runs it, for trap kind `trap`
/// holding `w` (`break`, `continue 2`, …).
fn trap_setup(dialect: Dialect, trap: &str, w: &str) -> (String, &'static str) {
	match trap {
		"sig" => (format!("trap '{w}' USR1; "), "kill -USR1 $$"),
		"err" => {
			let key = if dialect == Dialect::Bash {
				"ERR"
			} else {
				"ZERR"
			};
			(format!("trap '{w}' {key}; "), "false")
		},
		"debug" => {
			let var = if dialect == Dialect::Bash {
				"BASH_COMMAND"
			} else {
				"ZSH_DEBUG_CMD"
			};
			(format!("trap '[[ ${var} == \": hit\" ]] && {w}' DEBUG; "), ": hit")
		},
		_ => (format!("g() {{ :; }}; trap '{w}' RETURN; "), "g"),
	}
}

/// The trap rows, `trap/<trap>/<context>/<word>/<count>`: a `break` or
/// `continue` in a signal, ERR, DEBUG or (bash) RETURN trap that fires in a
/// loop body or in a function called from the loop.
fn traps(dialect: Dialect) -> Vec<Row> {
	let kinds: &[&str] = if dialect == Dialect::Bash {
		&["sig", "err", "debug", "return"]
	} else {
		&["sig", "err", "debug"]
	};
	let mut rows = Vec::new();
	for &trap in kinds {
		for context in ["for", "while", "until", "select", "function"] {
			for word in ["break", "continue"] {
				for count in ["none", "2"] {
					let (mut pre, el) = trap_setup(dialect, trap, &element(word, count));
					if context == "function" {
						let _ = write!(pre, "f() {{ {el}; echo f:$?; }}; ");
					}
					// The grid's loops, with the trap's command as the element.
					let mut body = inner("break", "none", "alone", context).replace("break", el);
					if count == "2" {
						body = format!("for o in X Y; do echo o$o; {body}; echo c$o:$?; done; echo E:$?");
					}
					rows.push((format!("trap/{trap}/{context}/{word}/{count}"), pre + &body));
				}
			}
		}
	}
	rows
}

/// The trap shapes around the trap rows, each in one and in two loops.
const TRAP_SHAPES: &[(&str, &str, &str)] = &[
	("rest-skipped", "trap 'break; echo after' USR1; ", "kill -USR1 $$"),
	("status", "trap 'false; break' USR1; ", "kill -USR1 $$"),
	("count3", "trap 'break 3' USR1; ", "kill -USR1 $$"),
	(
		"nested-function",
		"trap 'break' USR1; h() { kill -USR1 $$; echo h; }; g() { h; echo g; }; ",
		"g",
	),
	("err-in-condition", "trap 'break' ERR; ", "if false; then :; fi; false"),
	("eval", "trap 'eval break' USR1; ", "kill -USR1 $$"),
	("errexit", "set -e; trap 'break' ERR; ", "(exit 3)"),
	("errexit-continue", "set -e; trap 'continue' ERR; ", "(exit 3)"),
	// An EXIT trap run by `exit` inside the loop: bash starts it with no
	// loop level (the message); zsh counts the loops, and `break` ends the
	// trap while the exit goes on.
	("exit", "trap 'echo t1; break; echo t2' EXIT; ", "exit 3"),
	("exit-continue", "trap 'echo t1; continue; echo t2' EXIT; ", "exit 3"),
	("exit-in-function", "trap 'echo t1; break; echo t2' EXIT; h() { exit 3; }; ", "h"),
	("exit-in-subshell", "", "( trap 'echo t1; break; echo t2' EXIT; exit 3 ); echo s:$?"),
];

/// The trap shapes only bash has, `trap/own/<name>`. A RETURN trap fires
/// for a function under `set -T` or one that set it, at the function's
/// own loop level: no loop of its own, the message; a `return` from
/// inside its own loop leaves that loop's level counted, and bash's
/// `breaking` outlives the return, skipping the callers' commands up to
/// their next loop. A DEBUG trap's `break` leaves `set -e` on.
const BASH_TRAP_SHAPES: &[(&str, &str)] = &[
	(
		"return-functrace",
		"set -T; g() { :; }; trap 'echo r; break' RETURN; for i in 1 2; do echo a$i; g; echo \
		 b$i:$?; done; echo e:$?",
	),
	(
		"return-set-in-function",
		"g() { trap 'echo r; break' RETURN; }; for i in 1 2; do echo a$i; g; echo b$i:$?; done; \
		 echo e:$?",
	),
	(
		"return-in-own-loop",
		"set -T; trap 'echo r; break' RETURN; g() { for i in 1 2; do echo g$i; return 5; done; echo \
		 after; }; g; echo s:$?",
	),
	(
		"return-in-own-loop-caller-loop",
		"set -T; trap 'echo r; break' RETURN; g() { for i in 1 2; do echo g$i; return 5; done; echo \
		 after; }; for o in X Y; do echo o$o; g; echo s:$?; done; echo E:$?",
	),
	(
		"return-in-own-loop-continue",
		"set -T; trap 'echo r; continue' RETURN; g() { for i in 1 2; do echo g$i; return 5; done; \
		 echo after; }; for o in X Y; do echo o$o; g; echo s:$?; done; echo E:$?",
	),
	(
		"return-in-own-loop-through-function",
		"g() { trap 'echo r; break' RETURN; for i in 1 2; do echo g$i; return 5; done; echo after; \
		 }; h() { g; echo h:$?; }; for o in X Y; do echo o$o; h; echo s:$?; done; echo E:$?",
	),
	(
		"debug-errexit",
		"set -e; trap '[[ $BASH_COMMAND == \": hit\" ]] && { echo t; break; }; true' DEBUG; for i \
		 in 1 2; do echo a$i; : hit; echo b$i; done; echo e; false; echo after",
	),
];

/// The trap shapes only zsh has, `trap/own/<name>`: a DEBUG trap's `break`
/// puts `ERR_EXIT` back (zsh turns it off while the trap runs), a
/// `TRAPZERR` function's `break` leaves the loop, and the `break` of the
/// ZERR trap a `return N` runs is dropped by the return.
const ZSH_TRAP_SHAPES: &[(&str, &str)] = &[
	(
		"debug-errexit-break",
		"setopt errexit; trap '[[ $ZSH_DEBUG_CMD == \": hit\" ]] && break' DEBUG; for i in 1 2; do \
		 echo a$i; : hit; echo b$i; done; echo e; false; echo after",
	),
	(
		"debug-errexit-continue",
		"setopt errexit; trap '[[ $ZSH_DEBUG_CMD == \": hit\" ]] && continue' DEBUG; for i in 1 2; \
		 do echo a$i; : hit; echo b$i; done; echo e; false; echo after",
	),
	(
		"trapzerr-break",
		"TRAPZERR() { echo t; break; echo x; }; for i in 1 2; do echo a$i; false; echo b$i; done; \
		 echo e:$?",
	),
	(
		"trapzerr-continue",
		"TRAPZERR() { echo t; continue; echo x; }; for i in 1 2; do echo a$i; false; echo b$i; \
		 done; echo e:$?",
	),
	(
		"trapzerr-break-errexit",
		"setopt errexit; TRAPZERR() { echo t; break; }; for i in 1 2; do echo a$i; false; echo b$i; \
		 done; echo e:$?",
	),
	// The ZERR trap a `return N` runs: the return drops the `break`.
	(
		"zerr-break-on-return",
		"trap 'echo t; break' ZERR; f() { return 2; }; for i in 1 2; do echo a$i; f; echo b$i; \
		 done; echo e:$?",
	),
	// `ERR_RETURN` in a trap action ends the action's list, not the function
	// it interrupted (zsh `dotrapargs` puts `retflag` back), and every loop
	// in reach of that code ends (`breaks = loops` outlives the trap); in a
	// DEBUG trap (`noerrexit`) it does nothing; at top level it exits, as
	// `ERR_EXIT` does (the controls).
	(
		"errreturn-trap-in-function",
		"setopt err_return; trap 'false' USR1; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		"errreturn-trap-rest",
		"setopt err_return; trap 'false; echo t2' USR1; f() { kill -USR1 $$; echo f:$?; }; f; echo \
		 top:$?",
	),
	(
		"errreturn-trap-calls-function",
		"setopt err_return; g() { false; echo g; }; trap 'g; echo t' USR1; f() { kill -USR1 $$; \
		 echo f:$?; }; f; echo top:$?",
	),
	(
		"errreturn-trap-in-source",
		"setopt err_return; trap 'false' USR1; . =(print 'kill -USR1 $$; echo s:$?'); echo top:$?",
	),
	(
		"errreturn-trap-in-loop",
		"setopt err_return; trap 'false' USR1; f() { for i in 1 2; do kill -USR1 $$; echo f$i:$?; \
		 done; echo after:$?; }; f; echo top:$?",
	),
	(
		"errreturn-trap-in-loop-caller-loop",
		"setopt err_return; trap 'false' USR1; f() { for i in 1 2; do kill -USR1 $$; echo f$i; \
		 done; echo after; }; for o in X Y; do echo o$o; f; echo s$o:$?; done; echo E:$?",
	),
	(
		"errreturn-trap-caller-loop",
		"setopt err_return; trap 'false' USR1; f() { kill -USR1 $$; echo f:$?; }; for o in X Y; do \
		 echo o$o; f; echo s$o:$?; done; echo E:$?",
	),
	(
		"errreturn-trap-own-loop",
		"setopt err_return; trap 'for j in 1 2; do false; echo t$j; done; echo tend' USR1; f() { \
		 kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		"errreturn-trap-localloops",
		"setopt err_return localloops; trap 'false' USR1; f() { for i in 1 2; do kill -USR1 $$; \
		 echo f$i; done; echo after; }; for o in X Y; do echo o$o; f; echo s$o:$?; done; echo E:$?",
	),
	(
		"errreturn-zerr-in-function",
		"setopt err_return; trap 'false' ZERR; f() { false; echo f:$?; }; f; echo top:$?",
	),
	(
		"errreturn-debug-in-function",
		"setopt err_return; trap 'false' DEBUG; f() { echo f; }; f; echo top:$?",
	),
	("errreturn-debug-top", "setopt err_return; trap 'false' DEBUG; echo x; echo top:$?"),
	("errreturn-trap-top", "setopt err_return; trap 'false' USR1; kill -USR1 $$; echo top:$?"),
	("errexit-trap-top", "setopt err_exit; trap 'false' USR1; kill -USR1 $$; echo top:$?"),
	(
		"errexit-trap-in-function",
		"setopt err_exit; trap 'false' USR1; f() { kill -USR1 $$; echo f:$?; }; f; echo top:$?",
	),
	(
		"errreturn-in-function-then-top",
		"setopt err_return; trap 'false' USR1; f() { (exit 3); kill -USR1 $$; echo f:$?; }; f; echo \
		 top:$?",
	),
	// No ZERR trap runs while any trap does (zsh `dotrap`'s `intrap`): a
	// signal, DEBUG or EXIT trap, a function one calls; `ERR_EXIT` still
	// applies there.
	(
		"zerr-in-signal-trap",
		"trap 'echo Z$?' ZERR; trap 'false; echo t2' USR1; kill -USR1 $$; echo top:$?",
	),
	(
		"zerr-in-signal-trap-function",
		"trap 'echo Z$?' ZERR; g() { false; echo g; }; trap 'g; echo t2' USR1; kill -USR1 $$; echo \
		 top:$?",
	),
	(
		"zerr-in-signal-trap-in-function",
		"trap 'echo Z$?' ZERR; trap 'false; echo t2' USR2; f() { kill -USR2 $$; echo f; }; f; echo \
		 top:$?",
	),
	(
		"zerr-in-debug-trap",
		"trap 'echo Z$?' ZERR; trap '[[ $ZSH_DEBUG_CMD == \": hit\" ]] && { false; echo d; }; :' \
		 DEBUG; : hit; echo top:$?",
	),
	("zerr-in-exit-trap", "trap 'echo Z$?' ZERR; trap 'false; echo x' EXIT; echo top"),
	("zerr-in-exit-trap-from-exit", "trap 'echo Z$?' ZERR; trap 'false; echo x' EXIT; exit 0"),
	(
		"zerr-after-signal-trap",
		"trap 'echo Z$?' ZERR; trap 'false' USR1; kill -USR1 $$; false; echo top:$?",
	),
	(
		"zerr-in-signal-trap-errexit",
		"setopt errexit; trap 'echo Z$?' ZERR; trap 'false; echo t2' USR1; kill -USR1 $$; echo \
		 top:$?",
	),
	(
		"zerr-in-subshell-in-signal-trap",
		"trap 'echo Z$?' ZERR; trap '(false; echo s); echo t2' USR1; kill -USR1 $$; echo top:$?",
	),
	("zerr-in-zerr-trap", "trap 'false; echo Z$?' ZERR; false; echo top:$?"),
	(
		"errreturn-trap-runs-no-zerr",
		"setopt err_return; trap 'echo Z' ZERR; trap 'false; echo t2' USR1; f() { kill -USR1 $$; \
		 echo f:$?; }; f; echo top:$?",
	),
	// A fork made inside a trap keeps `intrap`: no ZERR or DEBUG trap there,
	// even after the trap ends; a fork made after it runs them.
	(
		"zerr-in-cmdsub-in-signal-trap",
		"trap 'echo Z$?' ZERR; trap 'x=$(false; echo s); echo t2:$x' USR1; kill -USR1 $$; echo \
		 top:$?",
	),
	(
		"zerr-in-job-from-signal-trap",
		"trap 'echo Z$?' ZERR; trap '{ false; echo s; } &' USR1; kill -USR1 $$; wait; echo top:$?",
	),
	(
		"zerr-in-subshell-after-signal-trap",
		"trap 'echo Z$?' ZERR; trap ':' USR1; kill -USR1 $$; ( false; echo s ); echo top:$?",
	),
	(
		"debug-in-subshell-in-signal-trap",
		"trap '[[ $ZSH_DEBUG_CMD == \": in\" ]] && echo D' DEBUG; trap '( : in; echo s ); echo t2' \
		 USR1; kill -USR1 $$; echo top:$?",
	),
	(
		"debug-in-cmdsub-in-signal-trap",
		"trap '[[ $ZSH_DEBUG_CMD == \": in\" ]] && echo D >&2' DEBUG; trap 'x=$(: in; echo s); echo \
		 t2:$x' USR1; kill -USR1 $$; echo top:$?",
	),
	(
		"debug-in-subshell-after-signal-trap",
		"trap '[[ $ZSH_DEBUG_CMD == \": in\" ]] && echo D' DEBUG; trap ':' USR1; kill -USR1 $$; ( : \
		 in; echo s ); echo top:$?",
	),
];

/// The trap shape rows, `trap/x<loops>/<name>`, three at top level, and
/// the dialect's own (`trap/own/<name>`).
fn trap_shapes(dialect: Dialect) -> Vec<Row> {
	let zsh = |s: &str| {
		if dialect == Dialect::Bash {
			s.to_owned()
		} else {
			s.replace(" ERR;", " ZERR;")
				.replace("set -e;", "setopt errexit;")
		}
	};
	let mut rows = Vec::new();
	for &(name, pre, x) in TRAP_SHAPES {
		rows.push((
			format!("trap/x1/{name}"),
			zsh(&format!("{pre}for i in 1 2; do echo a$i; {x}; echo b$i:$?; done; echo e:$?")),
		));
		rows.push((
			format!("trap/x2/{name}"),
			zsh(&format!(
				"{pre}for o in X Y; do echo o$o; for i in 1 2; do echo a$i; {x}; echo b$i:$?; done; \
				 echo e:$?; echo c$o:$?; done; echo E:$?"
			)),
		));
	}
	rows.push((
		"trap/x0/sig".to_owned(),
		"trap 'break' USR1; kill -USR1 $$; echo after; echo top:$?".to_owned(),
	));
	rows.push(("trap/x0/err".to_owned(), zsh("trap 'break' ERR; false; echo after; echo top:$?")));
	rows.push((
		"trap/x0/exit-after-loop".to_owned(),
		"trap 'echo t1; break; echo t2' EXIT; for i in 1 2; do echo a$i; done; echo after".to_owned(),
	));
	let own = if dialect == Dialect::Bash {
		BASH_TRAP_SHAPES
	} else {
		ZSH_TRAP_SHAPES
	};
	for &(name, script) in own {
		rows.push((format!("trap/own/{name}"), script.to_owned()));
	}
	rows
}

/// The ERR trap rows' shapes: how often the ERR (zsh: ZERR) trap runs, and
/// with what status, for loops, conditions, lists, `!`, compounds and
/// functions.
const ERR_SHAPES: &[(&str, &str)] = &[
	("while-body-false", "i=0; while [ $i -lt 1 ]; do i=$((i+1)); false; done"),
	("while-body-status3", "i=0; while [ $i -lt 1 ]; do i=$((i+1)); (exit 3); done"),
	("until-body-false", "i=0; until [ $i -ge 1 ]; do i=$((i+1)); false; done"),
	("for-body-false", "for i in 1; do false; done"),
	("while-two-iterations", "i=0; while [ $i -lt 2 ]; do i=$((i+1)); false; done"),
	("while-false-then-true", "i=0; while [ $i -lt 1 ]; do i=$((i+1)); false; :; done"),
	("while-cond-false", "while false; do :; done"),
	("until-cond-true", "until true; do :; done"),
	("if-cond-false", "if false; then :; fi"),
	("elif-cond-false", "if false; then :; elif false; then :; fi"),
	("if-body-false", "if true; then false; fi"),
	("else-body-false", "if false; then :; else false; fi"),
	("group-body-false", "{ false; }"),
	("group-false-in-cond", "if { false; }; then :; fi"),
	("and-list-first-false", "false && true"),
	("and-list-last-false", "true && false"),
	("or-list-false", "false || false"),
	("not-true", "! true"),
	("not-false", "! false"),
	("case-body-false", "case x in x) false;; esac"),
	("function-return-1", "f() { return 1; }; f"),
	("function-body-false", "f() { false; }; f"),
	("subshell-false", "( false )"),
	("while-in-function", "f() { i=0; while [ $i -lt 1 ]; do i=$((i+1)); false; done; }; f"),
	(
		"nested-while",
		"i=0; while [ $i -lt 1 ]; do i=$((i+1)); j=0; while [ $j -lt 1 ]; do j=$((j+1)); false; \
		 done; done",
	),
	("select-body-false", "select x in a; do false; break; done <<< 1"),
	("arith-false", "(( 0 ))"),
	("cond-false", "[[ -z x ]]"),
	("group-and-first-false", "{ false && true; }"),
	("group-not-true", "{ ! true; }"),
	("while-not-true", "i=0; while [ $i -lt 1 ]; do i=$((i+1)); ! true; done"),
	("if-body-not-true", "if true; then ! true; fi"),
	("while-and-first-false", "i=0; while [ $i -lt 1 ]; do i=$((i+1)); false && true; done"),
	("for-and-first-false", "for i in 1; do false && true; done"),
	("case-and-first-false", "case x in x) false && true;; esac"),
	("function-and-first-false", "f() { false && true; }; f"),
	("function-false-then-return", "f() { false; return 2; }; f"),
	("pipeline-last-false", "true | false"),
];

/// The ERR shapes only bash runs here: under `set -E` a forked pipeline
/// element or background job inherits the trap, and bash's child judges
/// only the lists nested in the element, not a simple command it runs
/// with its pipes, a `( … )` element's status or a job of one pipeline;
/// `lastpipe`'s last element runs in the shell and is judged there too.
const BASH_ERR_SHAPES: &[(&str, &str)] = &[
	("errtrace-first-false-cat", "set -E; false | cat"),
	("errtrace-middle-false-cat", "set -E; true | false | cat"),
	("errtrace-first-cmdsub-word-cat", "set -E; false $(:) | cat"),
	("errtrace-first-group-cat", "set -E; { false; } | cat"),
	("errtrace-first-subshell-cat", "set -E; ( false ) | cat"),
	("errtrace-first-function-cat", "set -E; f() { false; }; f | cat"),
	("errtrace-first-cond-cat", "set -E; [[ -z x ]] | cat"),
	("errtrace-background-false", "set -E; false & wait $!"),
	("errtrace-background-group-false", "set -E; { false; } & wait $!"),
	("errtrace-background-and-list", "set -E; true && false & wait $!"),
	("errtrace-background-pipeline", "set -E; true | false & wait $!"),
	("errtrace-background-subshell", "set -E; ( false ) & wait $!"),
	("lastpipe-last-false", "shopt -s lastpipe; true | false"),
];

/// The ERR shapes only zsh has. `{ } always { }` is judged at its end like
/// a command, unless a command since ran the trap (the always-list's own
/// failure). `return N` (N ≠ 0) is a failed command: the ZERR trap runs
/// inside the function, then the call is not judged again; a `!` around
/// the return inverts its status.
const ZSH_ERR_SHAPES: &[(&str, &str)] = &[
	("always-false-true", "{ false } always { true }"),
	("always-false-false", "{ false } always { false }"),
	("always-true-false", "{ true } always { false }"),
	("always-and-first-false", "{ false && true } always { true }"),
	("always-in-function", "f() { { false } always { echo al } }; f"),
	("false-then-return-noarg", "f() { false; return; }; f"),
	("or-return", "f() { false || return 2; }; f"),
	("return-in-condition", "f() { return 2; }; if f; then :; fi"),
	("return-in-or-list", "f() { return 2; }; f || echo or"),
	("return-in-loop", "f() { for i in 1; do return 3; done; }; f"),
	("false-then-return-0", "f() { false; return 0; }; f"),
	("always-return", "f() { { return 2 } always { echo al } }; f"),
	("always-return-false", "f() { { return 2 } always { false } }; f"),
	("return-sees-local", "trap 'echo T$?:$v' ZERR; f() { local v=in; return 2; }; f"),
	("not-return", "f() { ! return 2; }; f"),
	("not-return-0", "f() { ! return 0; }; f"),
	("not-group-return", "f() { ! { return 2; }; }; f"),
	("not-if-return", "f() { ! if true; then return 2; fi; }; f"),
	("and-not-return", "f() { true && ! return 2; }; f"),
	("return-in-pipeline", "f() { true | return 2; echo no; }; f"),
	("return-top-level", "return 2"),
	("function-trap-false-then-return", "TRAPZERR() { echo F$?; }; f() { false; return 2; }; f"),
	("source-false-then-return", ". =(print 'false; return 4')"),
	// zsh judges a pipeline element (forked, or the last one in the shell)
	// and a job's list nowhere but in the lists nested in them; the
	// pipeline's or the job's status once.
	("pipeline-last-group-false", "true | { false; }"),
	("pipeline-last-group-false-true", "true | { false; true; }"),
	("pipeline-last-function", "f() { false; }; true | f"),
	("pipeline-last-subshell", "true | (exit 3)"),
	("pipeline-last-cond", "true | [[ -z x ]]"),
	("pipeline-in-loop", "for i in 1; do true | false; done"),
	("pipeline-pipefail", "setopt pipefail; false | true"),
	("pipeline-first-false-cat", "false | cat"),
	("pipeline-middle-false-cat", "true | false | cat"),
	("pipeline-first-group-cat", "{ false; } | cat"),
	("pipeline-first-subshell-cat", "( false ) | cat"),
	("pipeline-first-function-cat", "f() { false; }; f | cat"),
	("pipeline-first-cond-cat", "[[ -z x ]] | cat"),
	("background-false", "false & wait $!"),
	("background-group-false", "{ false; } & wait $!"),
	("background-and-list", "true && false & wait $!"),
	("background-pipeline", "true | false & wait $!"),
	("background-subshell", "( false ) & wait $!"),
];

/// The ERR rows, `err/<n|e>/<name>`: each shape after `trap 'echo T$?'
/// ERR`, then `echo end:$?`; `e` rows also set `-e`.
fn errs(dialect: Dialect) -> Vec<Row> {
	let (key, errexit) = if dialect == Dialect::Bash {
		("ERR", "set -e; ")
	} else {
		("ZERR", "setopt errexit; ")
	};
	let own = if dialect == Dialect::Bash {
		BASH_ERR_SHAPES
	} else {
		ZSH_ERR_SHAPES
	};
	let mut rows = Vec::new();
	for &(name, shape) in ERR_SHAPES.iter().chain(own) {
		for (tag, e) in [("n", ""), ("e", errexit)] {
			rows.push((
				format!("err/{tag}/{name}"),
				format!("{e}trap 'echo T$?' {key}; {shape}; echo end:$?"),
			));
		}
	}
	rows
}

/// The `.` file shapes of both dialects, `source/<name>`: (name, the
/// file's text, the code that sources it as `./s.sh` or a procsub). The
/// file is made in a fresh directory, sourced by a relative name (a
/// message names it), and removed after.
const SOURCE_SHAPES: &[(&str, &str, &str)] = &[(
	"file-own-loop-break2",
	"for j in 1 2; do echo j$j; break 2; done; echo in",
	"for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
)];

/// [`SOURCE_SHAPES`] only bash has: its `source` keeps `loop_level`, so a
/// `break` or `continue` in a `.` file (a file or a procsub) leaves the
/// caller's loop; a `.` file's RETURN trap runs inside the caller's loops
/// too (its `break` leaves them, after the file returned, with the file's
/// status), and a `break` that leaves the file runs no RETURN trap.
const BASH_SOURCE_SHAPES: &[(&str, &str, &str)] = &[
	(
		"file-break",
		"echo s; break; echo x",
		"for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
	(
		"file-continue",
		"echo s; continue; echo x",
		"for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
	(
		"file-source-break",
		"echo s; break; echo x",
		"for i in 1 2; do echo a$i; source ./s.sh; echo b$i:$?; done",
	),
	(
		"file-break2",
		"echo s; break 2; echo x",
		"for o in X Y; do echo o$o; for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done; echo \
		 c$o:$?; done",
	),
	(
		"procsub-break",
		"",
		"for i in 1 2; do echo a$i; . <(echo 'echo s; break; echo x'); echo b$i:$?; done",
	),
	(
		"procsub-continue",
		"",
		"for i in 1 2; do echo a$i; . <(echo 'echo s; continue; echo x'); echo b$i:$?; done",
	),
	(
		"return-trap-break",
		"echo s",
		"trap 'echo r; break' RETURN; for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
	(
		"return-trap-continue",
		"echo s",
		"trap 'echo r; continue' RETURN; for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
	(
		"return-trap-status",
		"echo s; return 3",
		"trap 'false; break' RETURN; for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
	(
		"file-break-runs-no-return-trap",
		"echo s; break; echo x",
		"trap 'echo r' RETURN; for i in 1 2; do echo a$i; . ./s.sh; echo b$i:$?; done",
	),
];

/// [`SOURCE_SHAPES`] only zsh has.
const ZSH_SOURCE_SHAPES: &[(&str, &str, &str)] = &[];

/// The `.` file rows, `source/<name>`.
fn sources(dialect: Dialect) -> Vec<Row> {
	let own = if dialect == Dialect::Bash {
		BASH_SOURCE_SHAPES
	} else {
		ZSH_SOURCE_SHAPES
	};
	SOURCE_SHAPES
		.iter()
		.chain(own)
		.map(|&(name, file, code)| {
			(
				format!("source/{name}"),
				format!(
					"d=$(mktemp -d); cd \"$d\"; printf '%s\\n' '{file}' > s.sh; {code}; echo e:$?; cd \
					 /; rm -r \"$d\""
				),
			)
		})
		.collect()
}

/// stderr with the program's name before `: ` written `SH` (bash names
/// itself by its path, and bash 5.2.21 a function's error `environment`).
fn normalized_stderr(stderr: &[u8]) -> String {
	String::from_utf8_lossy(stderr)
		.split_inclusive('\n')
		.map(|line| match line.find(": ") {
			Some(i)
				if !line[..i].contains(':')
					&& (line[..i].contains("bash")
						|| line[..i].contains("zsh")
						|| &line[..i] == "environment") =>
			{
				format!("SH{}", &line[i..])
			},
			_ => line.to_owned(),
		})
		.collect()
}

/// What a row did: stdout, normalised stderr, exit status.
type Outcome = (String, String, i32);

/// What runs a row.
#[derive(Clone, Copy)]
enum Runner<'a> {
	/// The obash under test.
	Obash,
	/// The obash under test with its fault injector at every op
	/// (`PI_SHELL_FAULT=1:1`): a seeded choice of a pause or a snapshot
	/// restored in this process (externalize, drop the shell, restore).
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
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		normalized_stderr(&out.stderr),
		out.status.code().unwrap_or(-1),
	)
}

fn fixture(dialect: Dialect) -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests/fixtures/break_in_a_pipeline_element")
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
			.get(id)
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

/// Run `rows` (ids starting `prefix` in the record) in obash, or in the
/// oracle `PI_LOOP_BASH`/`PI_LOOP_ZSH` names, and assert the recorded
/// outcome of each. With `PI_LOOP_BLESS` and an oracle, rewrite the
/// record's `prefix` rows from it instead.
fn assert_rows(dialect: Dialect, prefix: &str, rows: &[Row]) {
	let oracle = env::var(match dialect {
		Dialect::Bash => "PI_LOOP_BASH",
		Dialect::Zsh => "PI_LOOP_ZSH",
	})
	.ok();
	let runner = oracle.as_deref().map_or(Runner::Obash, Runner::Oracle);
	let got = run_all(dialect, runner, rows);
	let mut record = recorded(dialect);
	if oracle.is_some() && env::var_os("PI_LOOP_BLESS").is_some() {
		record.retain(|id, _| !id.starts_with(prefix));
		for ((id, script), outcome) in rows.iter().zip(got) {
			record.insert(id.clone(), (script.clone(), outcome));
		}
		let mut text = String::new();
		for (id, (script, (stdout, stderr, status))) in record {
			let row = json!({"id": id, "script": script, "stdout": stdout, "stderr": stderr, "status": status});
			let _ = writeln!(text, "{row}");
		}
		fs::write(fixture(dialect), text).unwrap();
		return;
	}
	let recorded_ids = record.keys().filter(|id| id.starts_with(prefix)).count();
	assert_eq!(recorded_ids, rows.len(), "the record's {prefix} rows are not these rows");
	assert_recorded(dialect, rows, &got, &record);
}

/// Rows run under snapshots: each forks its child inside a loop (or, in
/// zsh, inside a trap action: `VprocZsh::in_trap`) and runs no program (an
/// external in flight skips a snapshot).
const BASH_SNAPSHOT_ROWS: &[&str] = &[
	"grid/for/break/none/last/none",
	"grid/while/continue/2/first/pipefail",
	"grid/until/break/2/middle/none",
	"grid/cmdsub/break/none/alone/none",
	"grid/cmdsub/continue/2/last/lastpipe",
	"fork/x1/cmdsub-own-loop-break2",
	"fork/x1/bg-simple",
	"fork/x2/cmdsub-nested",
	"fork/lines/cmdsub",
];

/// [`BASH_SNAPSHOT_ROWS`] for zsh.
const ZSH_SNAPSHOT_ROWS: &[&str] = &[
	"grid/subshell/break/2/alone/none",
	"grid/for/continue/none/middle/pipefail",
	"grid/cmdsub/break/2/last/none",
	"grid/function/break/none/first/none",
	"fork/x1/cmdsub-exit-trap",
	"fork/x1/bg-subshell",
	"trap/own/zerr-in-subshell-in-signal-trap",
	"trap/own/zerr-in-job-from-signal-trap",
];

/// The grid in bash: a simple command forked as an element keeps the loop
/// level (no message; `break` ends only it); `lastpipe`'s last element
/// leaves the loop; `$( … )` keeps the level and ends; `( … )`, a group
/// and a function start with none.
#[test]
fn bash_grid_matches_bash() {
	assert_rows(Dialect::Bash, "grid/", &grid(Dialect::Bash));
}

/// The grid in zsh: every fork keeps the loop count (the child ends
/// without a message); the last element runs in the shell; a function's
/// `break` reaches its caller's loop.
#[test]
fn zsh_grid_matches_zsh() {
	assert_rows(Dialect::Zsh, "grid/", &grid(Dialect::Zsh));
}

/// The forks around the grid in bash.
#[test]
fn bash_forks_match_bash() {
	assert_rows(Dialect::Bash, "fork/", &forks(Dialect::Bash));
}

/// The forks around the grid in zsh.
#[test]
fn zsh_forks_match_zsh() {
	assert_rows(Dialect::Zsh, "fork/", &forks(Dialect::Zsh));
}

/// `break` and `continue` in a trap action, in bash: a signal, ERR, DEBUG
/// or RETURN trap runs inside the loops of the code it interrupted
/// (`parse_and_execute` keeps `loop_level`), so its `break` leaves the
/// trap and then the loop; the rest of the action is skipped.
#[test]
fn bash_traps_match_bash() {
	let rows: Vec<Row> = traps(Dialect::Bash)
		.into_iter()
		.chain(trap_shapes(Dialect::Bash))
		.collect();
	assert_rows(Dialect::Bash, "trap/", &rows);
}

/// The same in zsh (signal, ZERR and DEBUG traps): `loops` reaches into a
/// trap action.
#[test]
fn zsh_traps_match_zsh() {
	let rows: Vec<Row> = traps(Dialect::Zsh)
		.into_iter()
		.chain(trap_shapes(Dialect::Zsh))
		.collect();
	assert_rows(Dialect::Zsh, "trap/", &rows);
}

/// The ERR trap runs once per failed command in bash: a loop, group, `if`
/// or `case` that takes its status from a command already judged runs it
/// no second time.
#[test]
fn bash_err_trap_runs_once() {
	assert_rows(Dialect::Bash, "err/", &errs(Dialect::Bash));
}

/// The same for zsh's ZERR trap.
#[test]
fn zsh_err_trap_runs_once() {
	assert_rows(Dialect::Zsh, "err/", &errs(Dialect::Zsh));
}

/// bash: a `break` or `continue` in a `.` file (a file or a procsub) and
/// in its RETURN trap leaves the caller's loop.
#[test]
fn bash_source_matches_bash() {
	assert_rows(Dialect::Bash, "source/", &sources(Dialect::Bash));
}

/// zsh: a `.` file does not see the caller's loops.
#[test]
fn zsh_source_matches_zsh() {
	assert_rows(Dialect::Zsh, "source/", &sources(Dialect::Zsh));
}

/// Run the rows `ids` names under [`Runner::ObashSnapshots`] and assert
/// the recorded outcome of each: a forked child's loops
/// (`Vproc::outer_loops`) and zsh's `intrap` survive the frames image.
fn assert_rows_under_snapshots(dialect: Dialect, ids: &[&str]) {
	let rows: Vec<Row> = grid(dialect)
		.into_iter()
		.chain(forks(dialect))
		.chain(trap_shapes(dialect))
		.filter(|(id, _)| ids.contains(&id.as_str()))
		.collect();
	assert_eq!(rows.len(), ids.len(), "a snapshot row id names no row");
	let got = run_all(dialect, Runner::ObashSnapshots, &rows);
	assert_recorded(dialect, &rows, &got, &recorded(dialect));
}

/// [`BASH_SNAPSHOT_ROWS`] across snapshots.
#[test]
fn bash_childs_loops_survive_a_snapshot() {
	assert_rows_under_snapshots(Dialect::Bash, BASH_SNAPSHOT_ROWS);
}

/// [`ZSH_SNAPSHOT_ROWS`] across snapshots.
#[test]
fn zsh_childs_loops_survive_a_snapshot() {
	assert_rows_under_snapshots(Dialect::Zsh, ZSH_SNAPSHOT_ROWS);
}
