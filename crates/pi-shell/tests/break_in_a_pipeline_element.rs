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

/// Run the rows `ids` names under [`Runner::ObashSnapshots`] and assert
/// the recorded outcome of each: a forked child's loops
/// (`Vproc::outer_loops`) survive the frames image.
fn assert_rows_under_snapshots(dialect: Dialect, ids: &[&str]) {
	let rows: Vec<Row> = grid(dialect)
		.into_iter()
		.chain(forks(dialect))
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
