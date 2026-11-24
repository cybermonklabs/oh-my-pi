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
//! through `eval`, and the message's redirections and order. The fatal
//! rows (bash): where a fatal error in a forked simple command ends, run
//! with `-c` and from a script file. The nofork rows (bash): a `break` or
//! `continue` in `${| }` or `${ }`, which waits for its command, where a
//! forked child keeps its parent's loops; the redirection rows (bash): one
//! in a `( … )`'s or a loop's own redirection, in a forked child's
//! here-document, and the traps it meets (the nofork `review-trap` row is
//! one of those); both run with `-c` and from a script file. Each row
//! prints where it is (`a<n>` per iteration, `b<n>:$?` after the element,
//! `e:$?` after the loop), so its output says whether the body and the
//! loop went on. A few rows also run under obash's fault injector, which
//! snapshots and restores the shell at many ops, so that a forked child's
//! loop count must survive the frames image.
//!
//! The expected rows are the oracles' output, recorded in
//! `tests/fixtures/break_in_a_pipeline_element/{bash,zsh}.jsonl` (stdout,
//! status, and stderr with the program name before `: line` as `SH`).
//! bash 5.2.21 agrees on every bash row but the three `${ ;}` ones and the
//! nofork and redirection rows with a `${| }` or `${ }` (5.2 has neither).
//! `PI_LOOP_BASH=<bash>` / `PI_LOOP_ZSH=<zsh>` run that
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
	path::{Path, PathBuf},
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
	// Two substitution bodies before the command's op: each is skipped.
	("element-two-blocks-word", ": | v=$(:) w=`:` break $(:) | :"),
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
	// A lone `break` as a forked element with an external reader, as a
	// `( … )` and as a substitution: bash prints the message only for the
	// `( … )`.
	("element-break-cat", "break | cat"),
	("subshell-break-alone", "( break )"),
	("cmdsub-break-alone", "x=$( break )"),
	// `$BASH_SUBSHELL`: a builtin or external element's words expand at its
	// parent's level; a builtin or function element then runs one level
	// down (a function, `eval`, `.`, a builtin's callback), however its
	// words hold substitutions. A `( … )` element, a background job and a
	// command substitution count once.
	("element-subshell-level-cmdsub-word", "echo $BASH_SUBSHELL $(:) | cat"),
	("builtin-element-level", "echo $BASH_SUBSHELL | cat"),
	("function-element-level", "f() { echo $BASH_SUBSHELL; }; f | cat"),
	("function-element-level-cmdsub-word", "f() { echo $BASH_SUBSHELL; }; f $(:) | cat"),
	("function-element-level-backtick-word", "f() { echo $BASH_SUBSHELL; }; f `:` | cat"),
	("function-element-level-assign-cmdsub-word", "f() { echo $BASH_SUBSHELL; }; v=$(:) f | cat"),
	(
		"function-element-level-redir-cmdsub-word",
		"f() { echo $BASH_SUBSHELL; }; f 2>$(echo /dev/null) | cat",
	),
	("function-middle-element-level-cmdsub-word", "f() { echo $BASH_SUBSHELL; }; : | f $(:) | cat"),
	("function-last-element-level-cmdsub-word", "f() { echo $BASH_SUBSHELL; }; : | f $(:)"),
	(
		"function-element-level-in-cmdsub",
		"f() { echo $BASH_SUBSHELL; }; x=$(f $(:) | cat); echo \"x=$x\"",
	),
	("function-element-level-words", "f() { echo $1 $BASH_SUBSHELL; }; f $BASH_SUBSHELL | cat"),
	("function-element-level-nested", "g() { echo $BASH_SUBSHELL; }; f() { g | cat; }; f | cat"),
	("eval-element-level", "eval 'echo $BASH_SUBSHELL' | cat"),
	("eval-element-level-cmdsub-word", "eval 'echo $BASH_SUBSHELL' $(:) | cat"),
	("eval-element-level-assign-cmdsub-word", "v=$(:) eval 'echo $BASH_SUBSHELL' | cat"),
	("eval-element-level-function", "f() { echo $BASH_SUBSHELL; }; eval f | cat"),
	("command-eval-element-level-cmdsub-word", "command eval 'echo $BASH_SUBSHELL' $(:) | cat"),
	("builtin-eval-element-level", "builtin eval 'echo $BASH_SUBSHELL' | cat"),
	("source-element-level", ". /dev/stdin <<< 'echo $BASH_SUBSHELL' | cat"),
	("source-element-level-cmdsub-word", ". /dev/stdin $(:) <<< 'echo $BASH_SUBSHELL' | cat"),
	(
		"mapfile-callback-element-level",
		"printf 'a\\n' | mapfile -C 'echo $BASH_SUBSHELL >&2; :' -c 1 x 2>&1 | cat",
	),
	("subshell-element-function-level", "f() { echo $BASH_SUBSHELL; }; ( f ) | cat"),
	("bg-function-level", "f() { echo $BASH_SUBSHELL; }; f & wait"),
	("bg-builtin-level-cmdsub-word", "echo $BASH_SUBSHELL $(:) & wait"),
	// A builtin of plain words runs before the stages (its fast path): it
	// is raised there, once however often its callback runs.
	(
		"mapfile-callbacks-element-level",
		"printf 'a\\nb\\n' | mapfile -C 'echo cb $BASH_SUBSHELL; :' -c 1 x",
	),
	(
		"source-file-element-level",
		"d=$(mktemp -d); printf 'echo $BASH_SUBSHELL\\n' > \"$d/s\"; . \"$d/s\" | cat; rm -r \"$d\"",
	),
	// A substitution in an element's words is one level down from the
	// element, not two: the element's raise is for its own command only.
	("cmdsub-in-element-level", "f() { echo $BASH_SUBSHELL; }; echo \"[$(f)]\" | cat"),
	("cmdsub-in-last-element-level", "f() { echo $BASH_SUBSHELL; }; : | echo \"[$(f)]\""),
	("cmdsub-eval-in-element-level", "echo \"[$(eval 'echo $BASH_SUBSHELL')]\" | cat"),
	("procsub-in-element-level", "f() { echo $BASH_SUBSHELL; }; cat <(f) | cat"),
	(
		"cmdsub-in-function-element-level",
		"f() { echo $BASH_SUBSHELL; }; g() { echo \"$1\"; }; g \"[$(f)]\" | cat",
	),
	// An async pipeline (a job of one pipeline) forks each element as an
	// async command: every element, compound or `( … )` too, is one level
	// down, with no raise.
	("bg-pipeline-function-level", "f() { echo $BASH_SUBSHELL; }; f | cat & wait"),
	("bg-pipeline-eval-level", "eval 'echo $BASH_SUBSHELL' | cat & wait"),
	("bg-pipeline-builtin-level", "echo $BASH_SUBSHELL | cat & wait"),
	("bg-not-pipeline-function-level", "f() { echo $BASH_SUBSHELL; }; ! f | cat & wait"),
	("bg-pipeline-function-cmdsub-word-level", "f() { echo $BASH_SUBSHELL; }; f $(:) | cat & wait"),
	("bg-pipeline-group-element-level", "{ echo $BASH_SUBSHELL; } | cat & wait"),
	("bg-pipeline-subshell-element-level", "( echo $BASH_SUBSHELL ) | cat & wait"),
	("bg-pipeline-while-element-level", "while :; do echo $BASH_SUBSHELL; break; done | cat & wait"),
	("bg-pipeline-last-subshell-level", ": | ( echo $BASH_SUBSHELL ) & wait"),
	("bg-pipeline-last-group-level", ": | { echo $BASH_SUBSHELL; } & wait"),
	(
		"bg-pipeline-subshell-redir-cmdsub-level",
		"( echo $BASH_SUBSHELL ) 2>$(echo /dev/null) | cat & wait",
	),
	("bg-pipeline-not-group-element-level", "! { echo $BASH_SUBSHELL; } | cat & wait"),
	("bg-pipeline-cmdsub-in-element-level", "echo \"[$(echo $BASH_SUBSHELL)]\" | cat & wait"),
	// Not an async pipeline: a timed one, a group or an and-or job.
	(
		"bg-timed-pipeline-function-level",
		"TIMEFORMAT=; f() { echo $BASH_SUBSHELL; }; time f | cat & wait",
	),
	("bg-group-pipeline-function-level", "f() { echo $BASH_SUBSHELL; }; { f | cat; } & wait"),
	("bg-and-pipeline-function-level", "f() { echo $BASH_SUBSHELL; }; true && f | cat & wait"),
	("group-element-function-level", "f() { echo $BASH_SUBSHELL; }; { f; } | cat"),
	// A `( … )` job counts once (a `time` or `!` around it too); an and-or
	// job that starts with one is forked whole, and the `( … )` again.
	("bg-subshell-level", "( echo $BASH_SUBSHELL ) & wait"),
	("bg-negated-subshell-level", "! ( echo $BASH_SUBSHELL ) & wait"),
	("bg-timed-subshell-level", "TIMEFORMAT=; time ( echo $BASH_SUBSHELL ) & wait"),
	("bg-subshell-and-list-level", "( echo $BASH_SUBSHELL ) && : & wait"),
	("bg-subshell-or-list-level", "( echo $BASH_SUBSHELL; false ) || : & wait"),
	("bg-subshell-redir-and-list-level", "( echo $BASH_SUBSHELL ) 2>/dev/null && : & wait"),
	("bg-timed-subshell-and-list-level", "TIMEFORMAT=; time ( echo $BASH_SUBSHELL ) && : & wait"),
	// A fatal error (`${x?}`, `set -u`) in a forked element or async command
	// of a `-c` string: its own words and a function it runs reach the
	// shell's command loop (127); a builtin it runs (`eval`), a subshell, a
	// compound element and a substitution have their own `top_level` (1).
	("function-element-fatal", "f() { echo ${x?boom}; }; f | cat; echo ps=${PIPESTATUS[*]}"),
	("function-last-element-fatal", "f() { echo ${x?boom}; }; : | f; echo st=$?"),
	(
		"function-element-fatal-cmdsub-word",
		"f() { echo ${x?boom}; }; f $(:) | cat; echo ps=${PIPESTATUS[*]}",
	),
	(
		"function-element-fatal-set-u",
		"set -u; f() { echo $nosuch_q; }; f | cat; echo ps=${PIPESTATUS[*]}",
	),
	(
		"function-element-fatal-pipefail",
		"set -o pipefail; f() { echo ${x?boom}; }; f | cat; echo st=$?",
	),
	(
		"function-element-fatal-nested",
		"g() { echo ${x?boom}; }; f() { g; }; f | cat; echo ps=${PIPESTATUS[*]}",
	),
	(
		"function-element-fatal-eval-in-function",
		"f() { eval 'echo ${x?boom}'; }; f | cat; echo ps=${PIPESTATUS[*]}",
	),
	(
		"function-element-fatal-inner-pipeline",
		"g() { echo ${x?b}; }; f() { g | cat; echo f:${PIPESTATUS[*]}; }; f | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	("eval-element-fatal", ": | eval 'echo ${x?boom}'; echo st=$?"),
	("builtin-element-fatal-word", ": | echo ${x?boom}; echo st=$?"),
	("subshell-element-fatal", "f() { echo ${x?boom}; }; ( f ) | cat; echo ps=${PIPESTATUS[*]}"),
	("group-element-fatal", "f() { echo ${x?boom}; }; { f; } | cat; echo ps=${PIPESTATUS[*]}"),
	("cmdsub-fatal", "f() { echo ${x?boom}; }; x=$(f); echo st=$?"),
	("bg-function-fatal", "f() { echo ${x?boom}; }; f & wait $!; echo st=$?"),
	("bg-word-fatal", "echo ${x?boom} & wait $!; echo st=$?"),
	("bg-eval-fatal", "eval 'echo ${x?boom}' & wait $!; echo st=$?"),
	(
		"bg-pipeline-function-fatal",
		"set -o pipefail; f() { echo ${x?boom}; }; f | cat & wait $!; echo st=$?",
	),
];

/// The fatal-error shapes (bash only), each run with `-c` (`fatal/c/<name>`)
/// and from a script file (`fatal/s/<name>`). A fatal error (`${x?}`,
/// `set -u`) in a forked simple element or async command ends where its
/// forking shell's would (bash's fork copies `top_level`): at the `-c`
/// command loop (127) only when that shell's error reaches it, so not in
/// an element forked inside `( … )`, `$( )` or `<( )`, nor inside a builtin
/// element (each has its own `top_level`: 1). From a script it is 1.
const FATALS: &[(&str, &str)] = &[
	(
		"cmdsub-element",
		"f() { echo ${x?boom}; }; x=$(f | cat; echo in:${PIPESTATUS[*]}); echo \"x=$x st=$?\"",
	),
	(
		"subshell-element",
		"f() { echo ${x?boom}; }; ( f | cat; echo in:${PIPESTATUS[*]} ); echo st=$?",
	),
	(
		"procsub-element",
		"f() { echo ${x?boom}; }; cat <(f | cat; echo in:${PIPESTATUS[*]}); echo st=$?",
	),
	("subshell-async", "f() { echo ${x?boom}; }; ( f & wait $!; echo in:$? ); echo st=$?"),
	(
		"bg-subshell-element",
		"f() { echo ${x?boom}; }; ( f | cat; echo in:${PIPESTATUS[*]} ) & wait $!; echo st=$?",
	),
	(
		"function-cmdsub-element",
		"f() { echo ${x?boom}; }; g() { x=$(f | cat; echo in:${PIPESTATUS[*]}); echo \"x=$x\"; }; \
		 g; echo st=$?",
	),
	(
		"cmdsub-group-element",
		"f() { echo ${x?boom}; }; x=$({ f | cat; echo in:${PIPESTATUS[*]}; }); echo \"x=$x st=$?\"",
	),
	("cmdsub-async", "f() { echo ${x?boom}; }; x=$(f & wait $!; echo in:$?); echo \"x=$x st=$?\""),
	// The control: at top level the error reaches the `-c` command loop.
	("top-element", "f() { echo ${x?boom}; }; f | cat; echo ps=${PIPESTATUS[*]}"),
	(
		"subshell-in-element",
		"f() { echo ${x?boom}; }; ( f | cat; echo in:${PIPESTATUS[*]} ) | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	("cmdsub-last-element", "f() { echo ${x?boom}; }; x=$(: | f; echo in:$?); echo \"x=$x st=$?\""),
	(
		"cmdsub-element-cmdsub-word",
		"f() { echo ${x?boom}; }; x=$(f $(:) | cat; echo in:${PIPESTATUS[*]}); echo \"x=$x st=$?\"",
	),
	("subshell-last-element", "f() { echo ${x?boom}; }; ( : | f; echo in:$? ); echo st=$?"),
	(
		"group-in-element",
		"f() { echo ${x?boom}; }; { f | cat; echo in:${PIPESTATUS[*]}; } | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	(
		"cmdsub-in-cmdsub-element",
		"f() { echo ${x?boom}; }; x=$(y=$(f | cat; echo in:${PIPESTATUS[*]}); echo \"y=$y\"); echo \
		 \"x=$x st=$?\"",
	),
	(
		"cmdsub-element-set-u",
		"set -u; f() { echo $nosuch_q; }; x=$(f | cat; echo in:${PIPESTATUS[*]}); echo \"x=$x \
		 st=$?\"",
	),
	(
		"cmdsub-element-pipefail",
		"set -o pipefail; f() { echo ${x?boom}; }; x=$(f | cat; echo in:$?); echo \"x=$x st=$?\"",
	),
	(
		"subshell-element-set-u",
		"set -u; f() { echo $nosuch_q; }; ( f | cat; echo in:${PIPESTATUS[*]} ); echo st=$?",
	),
	// A builtin element has its own `top_level`; a function element (also
	// one running `eval`) has its forking shell's, and passes it on.
	(
		"eval-element-inner",
		"f() { echo ${x?boom}; }; : | eval 'f | cat; echo in:${PIPESTATUS[*]}'; echo st=$?",
	),
	(
		"eval-in-function-element-inner",
		"f() { echo ${x?boom}; }; g() { eval 'f | cat; echo in:${PIPESTATUS[*]}'; }; g | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	(
		"function-element-inner",
		"f() { echo ${x?boom}; }; g() { f | cat; echo in:${PIPESTATUS[*]}; }; g | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	(
		"async-in-async",
		"f() { echo ${x?boom}; }; g() { f & wait $!; echo in:$?; }; g & wait $!; echo st=$?",
	),
	(
		"async-in-element",
		"f() { echo ${x?boom}; }; g() { f & wait $!; echo in:$?; }; g | cat; echo \
		 ps=${PIPESTATUS[*]}",
	),
	// An async pipeline's elements are forked from the shell that runs it
	// (obash's job vproc for the pipeline passes that shell's answer on).
	("top-bg-pipeline", "set -o pipefail; f() { echo ${x?boom}; }; f | cat & wait $!; echo st=$?"),
	(
		"cmdsub-bg-pipeline",
		"set -o pipefail; f() { echo ${x?boom}; }; x=$(f | cat & wait $!; echo in:$?); echo \"x=$x \
		 st=$?\"",
	),
	(
		"subshell-bg-pipeline",
		"set -o pipefail; f() { echo ${x?boom}; }; ( f | cat & wait $!; echo in:$? ); echo st=$?",
	),
	// A compound element's or job's own redirection, a negated simple job,
	// and the forms bash ends with 1 (a list inside the compound, a
	// subshell, a substitution).
	("bg-group-redir-word", "{ :; } 2>\"${zz?u}\" & wait $!; echo st=$?"),
	("bg-pipeline-group-redir-word", "true | { :; } 2>\"${zz?u}\" & wait $!; echo st=$?"),
	("bg-simple-word", ": \"${zz?u}\" & wait $!; echo st=$?"),
	("bg-group-inner-word", "{ : \"${zz?u}\"; } & wait $!; echo st=$?"),
	("bg-subshell-inner-word", "( : \"${zz?u}\" ) & wait $!; echo st=$?"),
	("bg-pipeline-group-inner-word", "true | { : \"${zz?u}\"; } & wait $!; echo st=$?"),
	("subshell-group-redir-word", "( { :; } 2>\"${zz?u}\" ); echo st=$?"),
	("cmdsub-group-redir-word", "x=$( { :; } 2>\"${zz?u}\" ); echo st=$?"),
	("bg-negated-function", "f() { echo ${x?boom}; }; ! f & wait $!; echo st=$?"),
	("bg-negated-simple-word", "! : \"${zz?u}\" & wait $!; echo st=$?"),
	("bg-subshell-redir-word", "( : ) 2>\"${zz?u}\" & wait $!; echo st=$?"),
	("element-group-redir-word", "{ :; } 2>\"${zz?u}\" | cat; echo ps=${PIPESTATUS[*]}"),
	// A job running a function reaches the command loop. A timed job is
	// forked through `execute_in_subshell`, its own `top_level`, so what it
	// runs ends there (1); but the own redirection of a timed compound that
	// is the whole job is expanded before that, at the fork's (127 with
	// `-c`).
	("bg-function-colon", "f() { echo ${x:?u}; }; f & wait $!; echo st=$?"),
	("bg-timed-function", "TIMEFORMAT=; f() { echo ${x:?u}; }; time f & wait $!; echo st=$?"),
	("bg-timed-simple-word", "TIMEFORMAT=; time : \"${zz?u}\" & wait $!; echo st=$?"),
	(
		"bg-timed-negated-function",
		"TIMEFORMAT=; f() { echo ${x:?u}; }; time ! f & wait $!; echo st=$?",
	),
	(
		"element-timed-function",
		"TIMEFORMAT=; f() { echo ${x:?u}; }; time f | cat; echo ps=${PIPESTATUS[*]}",
	),
	// `time` inside the function the job runs: the status only (stderr
	// closed), the timing report being another member's.
	(
		"bg-function-timed-inside",
		"exec 2>/dev/null; f() { time echo ${x:?u}; }; f & wait $!; echo st=$?",
	),
	("bg-timed-group-redir-word", "TIMEFORMAT=; time { :; } 2>\"${zz?u}\" & wait $!; echo st=$?"),
	("bg-timed-subshell-redir-word", "TIMEFORMAT=; time ( : ) 2>\"${zz?u}\" & wait $!; echo st=$?"),
	(
		"bg-timed-if-redir-word",
		"TIMEFORMAT=; time if :; then :; fi 2>\"${zz?u}\" & wait $!; echo st=$?",
	),
	(
		"bg-timed-while-redir-word",
		"TIMEFORMAT=; time while false; do :; done 2>\"${zz?u}\" & wait $!; echo st=$?",
	),
	(
		"bg-timed-for-redir-word",
		"TIMEFORMAT=; time for x in 1; do :; done 2>\"${zz?u}\" & wait $!; echo st=$?",
	),
	(
		"bg-timed-case-redir-word",
		"TIMEFORMAT=; time case a in a) :;; esac 2>\"${zz?u}\" & wait $!; echo st=$?",
	),
	("bg-timed-cond-redir-word", "TIMEFORMAT=; time [[ -n x ]] 2>\"${zz?u}\" & wait $!; echo st=$?"),
	("bg-timed-arith-redir-word", "TIMEFORMAT=; time (( 1 )) 2>\"${zz?u}\" & wait $!; echo st=$?"),
	(
		"bg-timed-negated-group-redir-word",
		"TIMEFORMAT=; time ! { :; } 2>\"${zz?u}\" & wait $!; echo st=$?",
	),
	// Controls: piped (the job is a pipeline: `cat`'s status), and a word
	// inside the timed compound (1).
	(
		"bg-timed-group-redir-word-piped",
		"TIMEFORMAT=; time { :; } 2>\"${zz?u}\" | cat & wait $!; echo st=$?",
	),
	("bg-timed-group-inner-word", "TIMEFORMAT=; time { : \"${zz?u}\"; } & wait $!; echo st=$?"),
	(
		"element-timed-group-redir-word",
		"TIMEFORMAT=; time { :; } 2>\"${zz?u}\" | cat; echo ps=${PIPESTATUS[*]}",
	),
	// A compound with its own redirection that is only the first command
	// of a job's and-or list, timed or not: bash forks the whole list
	// (`execute_connection`), whose child sets its own `top_level` before
	// the list runs the compound, so the redirection's error ends there
	// (1); so too a group or subshell job holding the timed compound. The
	// controls: a lone compound job, negated or timed, ends at the fork's
	// (127 with `-c`).
	("bg-group-redir-and-list", "{ :; } 2>\"${zz?u}\" && echo and & wait $!; echo w=$?"),
	(
		"bg-timed-group-redir-and-list",
		"TIMEFORMAT=; time { :; } 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	("bg-subshell-redir-and-list", "( : ) 2>\"${zz?u}\" && echo and & wait $!; echo w=$?"),
	(
		"bg-timed-subshell-redir-and-list",
		"TIMEFORMAT=; time ( : ) 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	("bg-group-redir-or-list", "{ :; } 2>\"${zz?u}\" || echo or & wait $!; echo w=$?"),
	(
		"bg-timed-group-redir-or-list",
		"TIMEFORMAT=; time { :; } 2>\"${zz?u}\" || echo or & wait $!; echo w=$?",
	),
	(
		"bg-and-then-timed-group-redir",
		"TIMEFORMAT=; true && time { :; } 2>\"${zz?u}\" & wait $!; echo w=$?",
	),
	("bg-and-then-group-redir", "true && { :; } 2>\"${zz?u}\" & wait $!; echo w=$?"),
	(
		"bg-timed-pipe-and-list",
		"TIMEFORMAT=; time { :; } 2>\"${zz?u}\" | cat && echo and & wait $!; echo w=$?",
	),
	("bg-group-holding-timed", "TIMEFORMAT=; { time { :; } 2>\"${zz?u}\"; } & wait $!; echo w=$?"),
	(
		"bg-negated-timed-and-list",
		"TIMEFORMAT=; ! time { :; } 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	(
		"bg-timed-if-redir-and-list",
		"TIMEFORMAT=; time if :; then :; fi 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	(
		"bg-timed-if-redir-or-list",
		"TIMEFORMAT=; time if :; then :; fi 2>\"${zz?u}\" || echo or & wait $!; echo w=$?",
	),
	(
		"bg-negated-timed-or-list",
		"TIMEFORMAT=; ! time { :; } 2>\"${zz?u}\" || echo or & wait $!; echo w=$?",
	),
	(
		"bg-timed-negated-group-redir-and-list",
		"TIMEFORMAT=; time ! { :; } 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	(
		"bg-timed-while-redir-and-list",
		"TIMEFORMAT=; time while false; do :; done 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	(
		"bg-timed-cond-redir-and-list",
		"TIMEFORMAT=; time [[ -n x ]] 2>\"${zz?u}\" && echo and & wait $!; echo w=$?",
	),
	("bg-if-redir-and-list", "if :; then :; fi 2>\"${zz?u}\" && echo and & wait $!; echo w=$?"),
	(
		"bg-group-list-holding-timed",
		"TIMEFORMAT=; { time { :; } 2>\"${zz?u}\"; echo after; } & wait $!; echo w=$?",
	),
	(
		"bg-subshell-holding-timed",
		"TIMEFORMAT=; ( time { :; } 2>\"${zz?u}\"; echo after ) & wait $!; echo w=$?",
	),
	(
		"bg-negated-timed-group-redir-word",
		"TIMEFORMAT=; ! time { :; } 2>\"${zz?u}\" & wait $!; echo w=$?",
	),
	("bg-negated-group-redir-word", "! { :; } 2>\"${zz?u}\" & wait $!; echo w=$?"),
	("bg-if-redir-word", "if :; then :; fi 2>\"${zz?u}\" & wait $!; echo w=$?"),
	// A lone simple job's fatal word (127 with `-c`).
	("bg-echo-word", "echo ${u?m} & wait $!; echo $?"),
	// No program runs (an external in flight skips a snapshot): these two
	// also run under snapshots.
	("top-element-builtin-reader", "f() { echo ${x?boom}; }; f | :; echo ps=${PIPESTATUS[*]}"),
	(
		"subshell-element-builtin-reader",
		"f() { echo ${x?boom}; }; ( f | :; echo in:${PIPESTATUS[*]} ); echo st=$?",
	),
];

/// The fatal rows: each [`FATALS`] shape with `-c` and from a script.
fn fatals() -> Vec<Row> {
	FATALS
		.iter()
		.flat_map(|&(name, x)| {
			[(format!("fatal/c/{name}"), x.to_owned()), (format!("fatal/s/{name}"), x.to_owned())]
		})
		.collect()
}

/// A `break` or `continue` in `${| }` or `${ }` (bash 5.3), where the forks
/// above meet the wait such a break makes: bash's `break` there only sets
/// `breaking`, so the substitution's body ends, its command runs, and then a
/// loop takes the break. In a forked simple command, `$( )` or `<( )` that
/// loop is the forking shell's (bash keeps `loop_level` there): the child
/// ends after its command, with no message, and the loop goes on. In the
/// shell the loop ends after the command.
const NOFORK_BREAKS: &[(&str, &str)] = &[
	("funsub-element", "for i in 1 2; do echo a ${| break; } | cat; echo b$i; done; echo end:$?"),
	(
		"funsub-in-cmdsub",
		"for i in 1 2; do echo $(echo c ${| break; }) d; echo b$i; done; echo end:$?",
	),
	(
		"funsub-element-continue",
		"for i in 1 2; do echo a$i ${| continue; } | cat; echo b$i; done; echo end:$?",
	),
	(
		"funsub-in-cmdsub-continue",
		"for i in 1 2; do echo $(echo c$i ${| continue; }) d; echo b$i; done; echo end:$?",
	),
	("funsub-top", "for i in 1 2; do echo a$i ${| break; }; echo b$i; done; echo end:$?"),
	("valsub-element", "for i in 1 2; do echo a ${ break; } | cat; echo b$i; done; echo end:$?"),
	("funsub-no-loop-element", "echo a ${| break; } | cat; echo end:$?"),
	// The child's commands after the waiting one do not run.
	(
		"funsub-in-cmdsub-more",
		"for i in 1 2; do echo $(echo c ${| break; }; echo more) d; echo b$i; done; echo end:$?",
	),
	(
		"funsub-in-procsub-more",
		"for i in 1 2; do cat <(echo p ${| break; }; echo more); echo b$i; done; echo end:$?",
	),
	(
		"valsub-in-cmdsub-more",
		"for i in 1 2; do echo $(echo c ${ break; }; echo more) d; echo b$i; done; echo end:$?",
	),
	// A program's redirections are expanded in its own fork, where the break
	// is lost; a builtin's in the child that runs it, which then ends.
	(
		"herestring-element",
		"for i in 1 2; do cat <<< \"h ${| break; } t\" | cat; echo b$i; done; echo end:$?",
	),
	(
		"herestring-in-cmdsub",
		"for i in 1 2; do echo \"$(cat <<< \"h ${| break; } t\"; echo more)\"; echo b$i; done; echo \
		 end:$?",
	),
	(
		"builtin-herestring-in-cmdsub",
		"for i in 1 2; do echo \"$(read v <<< \"${| break; }x\"; echo \"[$v]\"; echo more)\"; echo \
		 b$i; done; echo end:$?",
	),
	// A review's rows, `${| }` in each kind of command (`review-redirected`
	// writes its file in a directory of its own).
	("review-element", "for i in 1 2; do echo a ${| break; } | cat; echo in; done; echo out"),
	("review-select", "select x in a; do echo ${| break; } s; done <<< 1 2>/dev/null; echo out"),
	("review-until", "until false; do echo u ${| break; }; echo in; done; echo out"),
	(
		"review-function-local",
		"f() { local x=${| break; }; echo \"f[$x]\"; }; for i in 1 2; do f; echo in; done; echo out",
	),
	(
		"review-arith",
		"for i in 1 2; do (( ${| REPLY=1; break; } + 1 )); echo \"in $?\"; done; echo \"out $?\"",
	),
	("review-cond", "for i in 1 2; do [[ ${| break; } ]]; echo \"in $?\"; done; echo \"out $?\""),
	(
		"review-redirected",
		"d=$(mktemp -d); for i in 1 2; do echo a ${| break; } > \"$d/o\"; echo in; done; cat \
		 \"$d/o\"; rm -r \"$d\"; echo out",
	),
	(
		"review-trap",
		"trap \"echo trapped\" USR1; for i in 1; do echo ${| kill -USR1 $$; break; } x; echo in; \
		 done; echo out",
	),
	(
		"review-continue2",
		"for i in 1 2; do for j in 1 2; do echo \"$i$j\" ${| continue 2; }; echo inner; done; echo \
		 outer; done; echo out",
	),
	(
		"review-declare",
		"for i in 1 2; do declare x=${| break; }; echo \"in [$x]\"; done; echo \"out [$x]\"",
	),
	("review-errexit", "set -e; for i in 1 2; do false ${| break; }; done; echo \"out $?\""),
	("review-heredoc", "for i in 1 2; do cat <<E\nh ${| break; } t\nE\necho in; done; echo out"),
	("review-function-break", "f() { break; }; for i in 1 2; do f; echo in; done; echo out"),
	(
		"review-function-funsub",
		"f() { echo f ${| break; }; echo fin; }; for i in 1 2; do f; echo in; done; echo out",
	),
	("review-cmdsub", "for i in 1 2; do echo $(echo c ${| break; }) d; echo in; done; echo out"),
	(
		"review-break-on-2",
		"for i in 1 2 3; do echo \"$i\" ${| [ $i = 2 ] && break; REPLY=r; }; done; echo out",
	),
	("review-break2", "for i in 1 2; do echo ${| break 2; } x; echo in; done; echo \"out $?\""),
];

/// The nofork rows: each [`NOFORK_BREAKS`] shape with `-c` and from a
/// script.
fn nofork_breaks() -> Vec<Row> {
	NOFORK_BREAKS
		.iter()
		.flat_map(|&(name, x)| {
			[(format!("nofork/c/{name}"), x.to_owned()), (format!("nofork/s/{name}"), x.to_owned())]
		})
		.collect()
}

/// A `break` or `continue` in `${| }` or `${ }` where bash expands it
/// decides which loop takes it (bash 5.3), and a trap it meets.
///
/// - A `( … )`'s own redirection: bash expands it in the forked child, where
///   `loop_level` is 0, so the `break` complains, does nothing, and the rest of
///   the substitution runs; so do a `$( )` or `<( )` started there.
/// - A loop's own redirection: bash expands it before the loop counts itself,
///   and the loop then takes one level, its first test or body skipped (a `for`
///   binds its first word and a `select` reads its first line first; an
///   arithmetic `for` evaluates its first two expressions; a count is capped at
///   the loops outside it). So does a `for`'s break in its own words.
/// - A here-document of a forked simple command keeps the loop level: no
///   message.
/// - A trap the substitution's commands set off runs before its next command,
///   before a `break` there can leave the trap nothing to run; in a program's
///   or a `( … )`'s own redirection it waits for that command.
const REDIR_BREAKS: &[(&str, &str)] = &[
	(
		"subshell",
		"for i in 1 2; do ( true ) > ${| REPLY=/dev/null; break; }; echo b$i; done; echo end:$?",
	),
	(
		"subshell-continue",
		"for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; continue; }; echo b$i; done; echo \
		 end:$?",
	),
	(
		"subshell-rest",
		"for i in 1 2; do ( echo a$i ) 2> ${| break; echo more; REPLY=/dev/null; }; echo b$i; done; \
		 echo end:$?",
	),
	(
		"subshell-own-loop",
		"for i in 1 2; do ( for j in a; do echo j$j; done ) 2> ${| REPLY=/dev/null; break; }; echo \
		 b$i; done; echo end:$?",
	),
	(
		"subshell-posix",
		"set -o posix; for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo b$i; \
		 done; echo end:$?",
	),
	(
		"subshell-timed",
		"TIMEFORMAT=; for i in 1 2; do time ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo \
		 b$i; done; echo end:$?",
	),
	(
		"subshell-valsub",
		"for i in 1 2; do ( echo a$i ) 2> ${ echo /dev/null; break; }; echo b$i; done; echo end:$?",
	),
	(
		"subshell-heredoc",
		"for i in 1 2; do ( cat ) <<E\nh ${| break; } t\nE\necho b$i; done; echo end:$?",
	),
	(
		"subshell-break2",
		"for o in A; do for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break 2; }; echo b$i; \
		 done; echo o$o; done; echo end:$?",
	),
	(
		"subshell-status",
		"for i in 1; do ( exit 3 ) 2> ${| REPLY=/dev/null; break; }; echo b:$?; done; echo end:$?",
	),
	(
		"subshell-nested-funsub",
		"for i in 1 2; do ( echo a$i ) 2> ${| x=${| break; }; REPLY=/dev/null; }; echo b$i; done; \
		 echo end:$?",
	),
	(
		"subshell-negated",
		"for i in 1 2; do ! ( echo a$i ) 2> ${| REPLY=/dev/null; break; }; echo b$i:$?; done; echo \
		 end:$?",
	),
	(
		"subshell-cmdsub-word",
		"for i in 1 2; do ( echo a$i ) 2> \"$(break; echo /dev/null)\"; echo b$i; done; echo end:$?",
	),
	(
		"subshell-procsub-word",
		"for i in 1 2; do ( cat ) < <(break; echo p$i); echo b$i; done; echo end:$?",
	),
	(
		"subshell-cmdsub-in-funsub",
		"for i in 1 2; do ( echo a$i ) 2> ${| x=$(break; echo y); REPLY=/dev/null; echo \"[$x]\"; \
		 }; echo b$i; done; echo end:$?",
	),
	(
		"subshell-element",
		"for i in 1 2; do ( echo a$i ) 2> ${| REPLY=/dev/null; break; } | cat; echo b$i; done; echo \
		 end:$?",
	),
	(
		"group",
		"for i in 1 2; do { echo g$i; } 2> ${| REPLY=/dev/null; break; }; echo b$i; done; echo \
		 end:$?",
	),
	(
		"while",
		"for i in 1 2; do while true; do true; break; done > ${| REPLY=/dev/null; break; }; echo \
		 b$i; done; echo end:$?",
	),
	(
		"while-test",
		"for i in 1 2; do while echo t$i; do echo w$i; break; done 2> ${| REPLY=/dev/null; break; \
		 }; echo b$i:$?; done; echo end:$?",
	),
	(
		"until",
		"for i in 1 2; do until echo t; false; do echo u; break; done 2> ${| REPLY=/dev/null; \
		 break; }; echo b$i:$?; done; echo end:$?",
	),
	(
		"for",
		"for i in 1 2; do for x in a b; do echo x$x; done 2> ${| REPLY=/dev/null; break; }; echo \
		 \"b$i:$? [$x]\"; done; echo end:$?",
	),
	(
		"for-empty",
		"for i in 1 2; do for x in; do echo x$x; done 2> ${| REPLY=/dev/null; break; }; echo b$i; \
		 done; echo end:$?",
	),
	(
		"arith",
		"for i in 1 2; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; break; \
		 }; echo \"b$i:$? $j\"; done; echo end:$?",
	),
	(
		"arith-test-effect",
		"for i in 1 2; do for ((j=0; j++<2; )); do echo j$j; done 2> ${| REPLY=/dev/null; break; }; \
		 echo \"b$i:$? $j\"; done; echo end:$?",
	),
	(
		"arith-false",
		"for i in 1 2; do for ((j=5; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; break; \
		 }; echo \"b$i:$? $j\"; done; echo end:$?",
	),
	(
		"select",
		"for i in 1 2; do select x in a b; do echo s$x; done 2> ${| REPLY=/dev/null; break; } <<< \
		 1; echo \"b$i:$? [$x]\"; done; echo end:$?",
	),
	(
		"select-eof",
		"for i in 1 2; do select x in a b; do echo s$x; done 2> ${| REPLY=/dev/null; break; } < \
		 /dev/null; echo \"b$i:$? [$x]\"; done; echo end:$?",
	),
	(
		"while-continue",
		"for i in 1 2; do n=0; while (( n++ < 2 )); do echo w$i$n; done 2> ${| REPLY=/dev/null; \
		 continue; }; echo b$i; done; echo end:$?",
	),
	(
		"until-continue",
		"for i in 1 2; do n=0; until (( n++ >= 2 )); do echo u$i$n; done 2> ${| REPLY=/dev/null; \
		 continue; }; echo \"b$i $n\"; done; echo end:$?",
	),
	(
		"for-continue",
		"for i in 1 2; do for x in a b c; do echo x$x; done 2> ${| REPLY=/dev/null; continue; }; \
		 echo b$i; done; echo end:$?",
	),
	(
		"arith-continue",
		"for i in 1 2; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; \
		 continue; }; echo \"b$i $j\"; done; echo end:$?",
	),
	(
		"select-continue",
		"for i in 1 2; do select x in a b; do echo s$x; break; done 2> ${| REPLY=/dev/null; \
		 continue; } <<< $'1\\n2'; echo \"b$i [$x]\"; done; echo end:$?",
	),
	(
		"break2-nested",
		"for o in A; do for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; break \
		 2; }; echo b$i; done; echo o$o; done; echo end:$?",
	),
	(
		"break2-capped",
		"for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; break 2; }; echo b$i; \
		 done; echo end:$?",
	),
	(
		"continue2-nested",
		"for o in A B; do for i in 1 2; do while true; do break; done 2> ${| REPLY=/dev/null; \
		 continue 2; }; echo b$i; done; echo o$o; done; echo end:$?",
	),
	(
		"arith-continue2-capped",
		"for o in A B; do for ((j=0; j<2; j++)); do echo j$j; done 2> ${| REPLY=/dev/null; continue \
		 2; }; echo b$o; done; echo end:$?",
	),
	(
		"while-no-loop",
		"while true; do echo w; break; done 2> ${| REPLY=/dev/null; break; }; echo end:$?",
	),
	(
		"for-own-words",
		"for i in 1 2; do for x in a ${| break; } b; do echo x$x; done; echo \"b$i [$x]\"; done; \
		 echo end:$?",
	),
	(
		"select-own-words",
		"for i in 1 2; do select x in a ${| break; } b; do echo s$x; done 2>/dev/null <<< 1; echo \
		 \"b$i [$x]\"; done; echo end:$?",
	),
	(
		"while-heredoc",
		"for i in 1 2; do while read v; do echo r$v; done <<E\nh ${| break; } t\nE\necho b$i; done; \
		 echo end:$?",
	),
	(
		"while-valsub",
		"for i in 1 2; do while true; do echo w; break; done 2> ${ echo /dev/null; break; }; echo \
		 b$i; done; echo end:$?",
	),
	(
		"for-status",
		"for i in 1; do for x in a; do (exit 4); done 2> ${| REPLY=/dev/null; (exit 3); break; }; \
		 echo b:$?; done; echo end:$?",
	),
	(
		"until-status",
		"for i in 1; do until false; do :; done 2> ${| REPLY=/dev/null; (exit 3); break; }; echo \
		 b:$?; done; echo end:$?",
	),
	(
		"eval-while",
		"for i in 1 2; do eval 'while true; do break; done 2> ${| REPLY=/dev/null; break; }'; echo \
		 b$i; done; echo end:$?",
	),
	(
		"while-debug-trap",
		"trap 'echo dbg' DEBUG; for i in 1; do while true; do break; done 2> ${| REPLY=/dev/null; \
		 break; }; echo b$i; done; trap - DEBUG; echo end:$?",
	),
	(
		"while-in-function",
		"f() { while true; do echo w; break; done 2> ${| REPLY=/dev/null; break; }; echo f; }; for \
		 i in 1 2; do f; echo b$i; done; echo end:$?",
	),
	(
		"async-heredoc",
		"for i in 1 2; do cat <<E &\nh ${| break; } t\nE\nwait; echo b$i; done; echo end:$?",
	),
	(
		"element-heredoc",
		"for i in 1 2; do cat <<E | cat\nh ${| break; } t\nE\necho b$i; done; echo end:$?",
	),
	(
		"cmdsub-heredoc",
		"for i in 1 2; do x=$(cat <<E\nh ${| break; } t\nE\n); echo \"b$i [$x]\"; done; echo end:$?",
	),
	(
		"builtin-element-heredoc",
		"for i in 1 2; do read v <<E | cat\nh ${| break; } t\nE\necho b$i; done; echo end:$?",
	),
	(
		"procsub-heredoc",
		"for i in 1 2; do cat <(cat <<E\nh ${| break; } t\nE\n); echo b$i; done; echo end:$?",
	),
	(
		"async-heredoc-continue",
		"for i in 1 2; do cat <<E &\nh ${| continue; } t\nE\nwait; echo b$i; done; echo end:$?",
	),
	(
		"async-builtin",
		"for i in 1 2; do echo e$i 2> ${| REPLY=/dev/null; break; } & wait; echo b$i; done; echo \
		 end:$?",
	),
	(
		"function-async-heredoc",
		"f() { cat; }; for i in 1 2; do f <<E &\nh ${| break; } t\nE\nwait; echo b$i; done; echo \
		 end:$?",
	),
	(
		"compound-element-heredoc",
		"for i in 1 2; do { cat; } <<E | cat\nh ${| break; } t\nE\necho b$i; done; echo end:$?",
	),
	(
		"trap-no-break",
		"trap \"echo trapped\" USR1; for i in 1; do echo ${| kill -USR1 $$; echo after; } x; echo \
		 in; done; echo out",
	),
	("trap-top", "trap \"echo trapped\" USR1; echo ${| kill -USR1 $$; echo after; } x; echo out"),
	("trap-assign", "trap \"echo trapped\" USR1; x=${| kill -USR1 $$; echo after; }; echo out"),
	(
		"trap-continue",
		"trap \"echo trapped\" USR1; for i in 1 2; do echo ${| kill -USR1 $$; continue; } x$i; echo \
		 in; done; echo out",
	),
	(
		"trap-valsub",
		"trap \"echo trapped\" USR1; for i in 1; do echo ${ kill -USR1 $$; break; } x; echo in; \
		 done; echo out",
	),
	(
		"trap-heredoc",
		"trap \"echo trapped\" USR1; for i in 1; do cat <<E\nh ${| kill -USR1 $$; break; } \
		 t\nE\necho in; done; echo out",
	),
	(
		"trap-program-redirection",
		"trap \"echo trapped\" USR1; for i in 1; do /bin/echo e 2> ${| kill -USR1 $$; \
		 REPLY=/dev/null; break; }; echo in; done; echo out",
	),
	(
		"trap-subshell-redirection",
		"trap \"echo trapped\" USR1; ( echo s ) 2> ${| kill -USR1 $$; REPLY=/dev/null; }; echo out",
	),
	(
		"trap-group-redirection",
		"trap \"echo trapped\" USR1; { echo g; } 2> ${| kill -USR1 $$; REPLY=/dev/null; }; echo out",
	),
	(
		"trap-two-signals",
		"trap \"echo t1\" USR1; trap \"echo t2\" USR2; for i in 1; do echo ${| kill -USR1 $$; kill \
		 -USR2 $$; break; } x; echo in; done; echo out",
	),
	(
		"trap-status",
		"trap \"echo trapped \\$?\" USR1; for i in 1; do echo ${| (exit 3); kill -USR1 $$; break; } \
		 x; echo \"in $?\"; done; echo out",
	),
	(
		"trap-function",
		"trap \"echo trapped\" USR1; f() { echo f ${| kill -USR1 $$; break; } x; echo fin; }; for i \
		 in 1; do f; echo in; done; echo out",
	),
];

/// The redirection rows: each [`REDIR_BREAKS`] shape with `-c` and from a
/// script.
fn redir_breaks() -> Vec<Row> {
	REDIR_BREAKS
		.iter()
		.flat_map(|&(name, x)| {
			[(format!("redir/c/{name}"), x.to_owned()), (format!("redir/s/{name}"), x.to_owned())]
		})
		.collect()
}

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
	// zsh counts every element it forks, a simple command too
	// (`entersubsh`); the last element runs in the shell; an async
	// pipeline's elements, compound or `( … )` too, sit at the job's level.
	("function-element-level", "f() { echo $ZSH_SUBSHELL; }; f | cat"),
	("builtin-element-level", "echo $ZSH_SUBSHELL | cat"),
	("eval-element-level", "eval 'echo $ZSH_SUBSHELL' | cat"),
	("function-middle-element-level", "f() { echo $ZSH_SUBSHELL; }; : | f | cat"),
	("function-element-level-cmdsub-word", "f() { echo $ZSH_SUBSHELL; }; f $(:) | cat"),
	("function-last-element-level", "f() { echo $ZSH_SUBSHELL; }; : | f"),
	("three-elements-level", "echo $ZSH_SUBSHELL | cat | cat"),
	("cmdsub-in-element-level", "echo \"[$(echo $ZSH_SUBSHELL)]\" | cat"),
	("element-in-subshell-level", "( echo $ZSH_SUBSHELL | cat )"),
	("element-in-cmdsub-level", "echo $(echo $ZSH_SUBSHELL | cat)"),
	("subshell-element-level", "(echo $ZSH_SUBSHELL) | cat"),
	("group-element-level", "{ echo $ZSH_SUBSHELL; } | cat"),
	("bg-pipeline-function-level", "f() { echo $ZSH_SUBSHELL; }; f | cat & wait"),
	("bg-pipeline-last-function-level", "f() { echo $ZSH_SUBSHELL; }; : | f & wait"),
	("bg-group-pipeline-level", "{ echo $ZSH_SUBSHELL | cat; } & wait"),
	("bg-pipeline-group-element-level", "{ echo $ZSH_SUBSHELL; } | cat & wait"),
	("bg-pipeline-subshell-element-level", "( echo $ZSH_SUBSHELL ) | cat & wait"),
	("bg-pipeline-last-subshell-level", ": | ( echo $ZSH_SUBSHELL ) & wait"),
	("bg-pipeline-not-group-element-level", "! { echo $ZSH_SUBSHELL; } | cat & wait"),
	// Not bash's rule: a `( … )` that starts a job counts once however the
	// job goes on (`!`, `&& :`), and a timed `( … )` job counts twice.
	("bg-subshell-level", "( echo $ZSH_SUBSHELL ) & wait"),
	("bg-negated-subshell-level", "! ( echo $ZSH_SUBSHELL ) & wait"),
	("bg-timed-subshell-level", "exec 2>/dev/null; time ( echo $ZSH_SUBSHELL ) & wait"),
	("bg-subshell-and-list-level", "( echo $ZSH_SUBSHELL ) && : & wait"),
	("bg-subshell-redir-and-list-level", "( echo $ZSH_SUBSHELL ) 2>/dev/null && : & wait"),
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

/// Run row `id`'s `script` as `dialect` with `runner`: with `-c`, or for a
/// `fatal/s/` or `nofork/s/` row from the script file `s.sh` in a directory
/// of its own.
fn run_row(dialect: Dialect, runner: Runner<'_>, id: &str, script: &str) -> Outcome {
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
	let out = if ["fatal/s/", "nofork/s/", "redir/s/"]
		.iter()
		.any(|prefix| id.starts_with(prefix))
	{
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let dir = env::temp_dir().join(format!(
			"pi-loop-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		fs::create_dir(&dir).unwrap();
		fs::write(dir.join("s.sh"), format!("{script}\n")).unwrap();
		let out = output(cmd.current_dir(&dir).arg("s.sh"));
		remove_dir(&dir);
		out
	} else {
		output(cmd.args(["-c", script]))
	};
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		normalized_stderr(&out.stderr),
		out.status.code().unwrap_or(-1),
	)
}

/// Remove a row's directory, which only it used.
fn remove_dir(dir: &Path) {
	fs::remove_dir_all(dir).unwrap();
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
						let Some((id, script)) = rows.get(i) else {
							break;
						};
						mine.push((i, run_row(dialect, runner, id, script)));
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

/// Rows run under snapshots: each forks its child inside a loop and runs
/// no program (an external in flight skips a snapshot).
const BASH_SNAPSHOT_ROWS: &[&str] = &[
	"grid/for/break/none/last/none",
	"grid/while/continue/2/first/pipefail",
	"grid/until/break/2/middle/none",
	"grid/cmdsub/break/none/alone/none",
	"grid/cmdsub/continue/2/last/lastpipe",
	"fork/x1/cmdsub-own-loop-break2",
	"fork/x1/bg-simple",
	"fork/lines/cmdsub",
	"fatal/c/top-element-builtin-reader",
	"fatal/c/subshell-element-builtin-reader",
	"nofork/c/funsub-in-cmdsub-more",
	"redir/c/subshell-continue",
	"redir/c/while-continue",
	"redir/c/for-continue",
];

/// [`BASH_SNAPSHOT_ROWS`] for zsh.
const ZSH_SNAPSHOT_ROWS: &[&str] = &[
	"grid/subshell/break/2/alone/none",
	"grid/for/continue/none/middle/pipefail",
	"grid/cmdsub/break/2/last/none",
	"grid/function/break/none/first/none",
	"fork/x1/cmdsub-exit-trap",
	"fork/x1/bg-subshell",
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

/// The fatal errors of forked simple commands in bash ([`FATALS`]).
#[test]
fn bash_fatal_errors_match_bash() {
	assert_rows(Dialect::Bash, "fatal/", &fatals());
}

/// `break` and `continue` in `${| }` and `${ }` in bash ([`NOFORK_BREAKS`]).
#[test]
fn bash_nofork_breaks_match_bash() {
	assert_rows(Dialect::Bash, "nofork/", &nofork_breaks());
}

/// `break` and `continue` in `${| }` and `${ }` where bash expands a
/// redirection, and the traps they meet, in bash ([`REDIR_BREAKS`]).
#[test]
fn bash_redirection_breaks_match_bash() {
	assert_rows(Dialect::Bash, "redir/", &redir_breaks());
}

/// Run the rows `ids` names under [`Runner::ObashSnapshots`] and assert
/// the recorded outcome of each: a forked child's loops
/// (`Vproc::outer_loops`), where its fatal error ends
/// (`Frame::command_loop`) and a `break` waiting in it
/// (`Vproc::pending_break`) survive the frames image.
fn assert_rows_under_snapshots(dialect: Dialect, ids: &[&str]) {
	let bash_only: Vec<Row> = if dialect == Dialect::Bash {
		fatals()
			.into_iter()
			.chain(nofork_breaks())
			.chain(redir_breaks())
			.collect()
	} else {
		Vec::new()
	};
	let rows: Vec<Row> = grid(dialect)
		.into_iter()
		.chain(forks(dialect))
		.chain(bash_only)
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
