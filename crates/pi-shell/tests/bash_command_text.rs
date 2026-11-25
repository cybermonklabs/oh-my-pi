//! `$BASH_COMMAND` and `set -x`'s compound command heads as bash 5.3.20
//! prints them.
//!
//! bash sets `$BASH_COMMAND` from its printer (`make_command_string`): a
//! simple command, `[[ ]]` and `(( ))` as it re-prints them, and at the
//! DEBUG trap point of a `for` iteration, a `select`, a `case` and each
//! arith-for expression the head (`for i in 1 2`, `select s in q`, `case $x
//! in ` with a blank, `((i=0))` as expanded, `((1))` for an empty one).
//! `set -x` shows the same words for those heads. Most rows run after a
//! DEBUG trap that prints `$BASH_COMMAND` ([`TRAP`]); the others carry
//! their own traps, `set -x`, `extdebug` or `set -e`. Each row runs with
//! `-c` (`c/<name>`) and from a script file (`s/<name>`); a few also under
//! obash's fault injector, which snapshots and restores the shell at many
//! ops, so the command a trap names must survive the frames image.
//!
//! The expected rows are bash 5.3.20's output, recorded in
//! `tests/fixtures/bash_command_text/bash.jsonl` (stdout, status, and
//! stderr with the program name before `: line` as `SH`).
//! `PI_LOOP_BASH=<bash>` runs that shell instead of obash against the
//! records; with `PI_LOOP_BLESS=1` it rewrites them (one test at a time:
//! `--test-threads=1`).
#![cfg(unix)]

mod obash_support;

use std::{
	collections::BTreeMap,
	env,
	fmt::Write as _,
	fs,
	path::PathBuf,
	sync::atomic::{AtomicUsize, Ordering},
	thread,
};

use serde_json::{Value, json};

use crate::obash_support::{command, obash, output};

/// The DEBUG trap [`DEBUG_ROWS`] run after.
const TRAP: &str = r#"trap 'echo "D:[$BASH_COMMAND]"' DEBUG; "#;

/// Shapes run after [`TRAP`]: each DEBUG trap point and the text it names.
const DEBUG_ROWS: &[(&str, &str)] = &[
	("for-words", r#"x=a; for j in "$x" b; do :; done"#),
	("for-canonical-words", r#"for i in $(  echo  a   b) "c  d" e\ f 'g h'; do break; done"#),
	("for-positional", "set -- p q; for i; do :; done"),
	("for-lines", "for i in 1 2\ndo :\ndone"),
	("for-empty-list", "for i in; do :; done; echo end"),
	("for-nested", "for i in 1 2; do for j in a; do :; done; done"),
	("for-continue", "for i in 1 2 3; do [ $i = 2 ] && continue; :; done"),
	("for-break", "for i in 1 2; do break; done; :"),
	("for-functrace", "set -T; f() { for i in a b; do :; done; }; f"),
	(
		"select",
		r#"select s in q r; do echo got$s; [ "$s" = r ] && break; done 2>/dev/null <<< $'1\n2'"#,
	),
	("select-canonical", r#"select s in $(  echo  q  ) "a  b"; do break; done 2>/dev/null <<< 1"#),
	("select-positional", "set -- p; select s; do break; done 2>/dev/null <<< 1"),
	("select-functrace", "set -T; f() { select s in q; do break; done 2>/dev/null <<< 1; }; f"),
	("case", "x=a; case $x in a) :;; esac"),
	("case-canonical", r#"x=a; case  "$x"  in *) :;; esac"#),
	("case-cmdsub-word", "case $(  echo  a  ) in a) :;; esac"),
	("case-nested", "for i in 1; do case $i in 1) case x in x) :;; esac;; esac; done"),
	("case-no-match", "case b in a) echo no;; esac; echo after"),
	("case-escaped-blank", r"case a\  in 'a ') :;; esac"),
	("case-functrace", "set -T; f() { case x in x) :;; esac; }; f"),
	("arith-for", "for ((i=0;i<1;i++)); do :; done"),
	("arith-for-blanks", "for (( i = 0 ; i < 1 ; i++ )); do :; done"),
	("arith-for-empty", "for ((;;)); do break; done"),
	("arith-for-empty-blanks", "for (( ; ; )); do break; done"),
	("arith-for-empty-test", "for ((i=0;;i++)); do [ $i = 1 ] && break; done"),
	("arith-for-expanded", "n=5; for ((i=$n; i<6; i++)); do :; done"),
	("arith-for-cmdsub", "x=1; for ((i=$(echo 0); i<$x; i++)); do :; done"),
	("arith-for-leading-expansion", r#"x="  "; for ((${x}i=0; i<1; i++)); do :; done"#),
	(
		"arith-for-nested-functrace",
		"set -T; f() { for ((i=0; i<1; i++)); do for ((j=$i; j<1; j++)); do :; done; done; }; f",
	),
	("simple-blanks", "echo   a    b  >/dev/null"),
	("assign-cmdsub", "x=$(  echo  a  )"),
	("assigns-redirs", r#"x=1  y=2   echo  "$x"   2>&1 >/dev/null"#),
	("heredoc", "cat <<EOF\nhi\nEOF"),
	("cond", r#"x=1; [[  -n  $x  ]]; [[ $x == 1 && ( -z "" || $x ) ]]"#),
	("arith-command", "((  x  =  1  ))"),
	(
		"compound-redirs",
		"[[ -n a ]] 2>/dev/null; (( 1 )) 2>/dev/null; for i in 1; do :; done 2>/dev/null",
	),
	("substitutions", "echo $(  echo  a  ;  echo  b  ) `echo  c`"),
	("arrays", r#"a=( 1   2  "x  y" ); declare  -a  b=(  3  4 )"#),
	("parameters", r#"echo ${x:-  a  b} $((  1  +  2 )) "$(  echo   q )""#),
	("alias", "shopt -s expand_aliases; alias e='echo  hi'\ne   x"),
	("lists", "! true; TIMEFORMAT=; time true; true && false || :"),
	("function-call", "f() { :; }; f   1    2"),
	("quoting", r#"echo $'a\tb' "q  r" 'x\y' a\ b >/dev/null"#),
];

/// Shapes run as written: their own traps (one that reads the head, the
/// order of a substitution and the trap, `extdebug`'s skips, `set -e` in
/// the trap, the ERR and EXIT traps) and `set -x`'s heads.
const OWN_ROWS: &[(&str, &str)] = &[
	(
		"for-own-trap-in-function",
		r#"f() { trap 'echo "F:[$BASH_COMMAND]"' DEBUG; for i in a; do :; done; }; f; for j in b; do :; done"#,
	),
	(
		"for-head-after-body",
		r#"trap '[[ $BASH_COMMAND == ": hit" ]] && echo seen' DEBUG; for i in 1 2; do : hit; done; echo e"#,
	),
	(
		"arith-for-cmdsub-order",
		r#"trap 'echo "D:[$BASH_COMMAND]" >&2' DEBUG; for ((i=$(echo X >&2; echo 0); i<1; i++)); do :; done"#,
	),
	(
		"arith-for-trap-sets-var",
		r#"n=0; trap '[[ $BASH_COMMAND == "((i=0))" ]] && n=9; echo "D:[$BASH_COMMAND]"' DEBUG; for ((i=$n; i<1; i++)); do echo i=$i; done"#,
	),
	(
		"arith-for-extdebug",
		r#"shopt -s extdebug; n=0; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "((i<3))" || n -gt 0 ]] || { n=1; false; }' DEBUG; for ((i=0;i<3;i++)); do echo b$i; done; echo end"#,
	),
	(
		"arith-for-extdebug-expanded",
		r#"shopt -s extdebug; n=0; m=3; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "((i<3))" || n -gt 0 ]] || { n=1; false; }' DEBUG; for ((i=0;i<$m;i++)); do echo b$i; done; echo end"#,
	),
	// The same with a true init (`$?` 0 before the skipped test): a skipped
	// test is 0 whatever came before it.
	(
		"arith-for-extdebug-true-init",
		r#"shopt -s extdebug; n=0; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "((i<3))" || n -gt 0 ]] || { n=1; false; }' DEBUG; for ((i=1;i<3;i++)); do echo b$i; done; echo "end:$?""#,
	),
	(
		"arith-for-extdebug-true-init-expanded",
		r#"shopt -s extdebug; n=0; one=1; m=3; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "((i<3))" || n -gt 0 ]] || { n=1; false; }' DEBUG; for ((i=$one;i<$m;i++)); do echo b$i; done; echo "end:$?""#,
	),
	(
		"arith-for-errexit-trap",
		r#"set -e; trap '[[ $BASH_COMMAND != "((i=0))" ]] || false' DEBUG; for ((i=0;i<1;i++)); do echo in; done; echo after"#,
	),
	(
		"arith-for-errexit-trap-expanded",
		r#"set -e; n=0; trap '[[ $BASH_COMMAND != "((i=0))" ]] || false' DEBUG; for ((i=$n;i<1;i++)); do echo in; done; echo after"#,
	),
	(
		"for-extdebug-head",
		r#"shopt -s extdebug; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "for i in a b" ]]' DEBUG; for i in a b; do echo in$i; done; echo end"#,
	),
	(
		"case-extdebug-head",
		r#"shopt -s extdebug; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "case a in " ]]' DEBUG; case a in a) echo in;; esac; echo end"#,
	),
	// A skipped `case` or `select` leaves status 0 whatever `$?` was.
	(
		"case-extdebug-status",
		r#"shopt -s extdebug; trap '[[ $BASH_COMMAND != "case a in " ]]' DEBUG; false; case a in a) echo in;; esac; echo "st:$?""#,
	),
	(
		"select-extdebug-status",
		r#"shopt -s extdebug; trap '[[ $BASH_COMMAND != "select s in q" ]]' DEBUG; false; select s in q; do echo in; break; done <<< 1; echo "st:$?""#,
	),
	(
		"select-extdebug-head",
		r#"shopt -s extdebug; trap 'echo "X:[$BASH_COMMAND]"; [[ $BASH_COMMAND != "select s in q" ]]' DEBUG; select s in q; do echo in; break; done <<< 1; echo "end:$?""#,
	),
	(
		"for-extdebug-status",
		r#"shopt -s extdebug; trap '[[ $BASH_COMMAND != "for i in a" ]]' DEBUG; for i in a; do echo in; done; echo "st:$? i:${i-unset}""#,
	),
	("err-trap", r#"trap 'echo "R:[$BASH_COMMAND]"' ERR; false   ;  [[  -z  x  ]]"#),
	("exit-trap", r#"trap 'echo "E:[$BASH_COMMAND]"' EXIT; echo   a    b >/dev/null"#),
	(
		"exit-trap-case-head",
		r#"trap 'echo "E:[$BASH_COMMAND]"' EXIT; case $((1/0)) in x) ;; esac; echo after"#,
	),
	// With no DEBUG trap, an expanded arith-for expression is still named.
	(
		"exit-trap-arith-for-expanded",
		r#"trap 'echo "E:[$BASH_COMMAND]"' EXIT; n=1; for ((i=0; i<$n; i++)); do :; done"#,
	),
	// In a child a trap action forks (`$( )`, `( … )`, a pipeline element, a
	// background command): the trapped command, as the action reads it.
	(
		"trap-cmdsub-debug",
		r#"trap 'x=$(echo "$BASH_COMMAND"); echo "D:[$x]"' DEBUG; for i in a; do :; done; case a in a) :;; esac; echo  hi >/dev/null"#,
	),
	(
		"trap-cmdsub-exit",
		r#"trap 'x=$(echo "$BASH_COMMAND"); echo "E:[$x]"' EXIT; echo   a >/dev/null"#,
	),
	("trap-cmdsub-err", r#"trap 'x=$(echo "$BASH_COMMAND"); echo "R:[$x]"' ERR; false   ;  :"#),
	(
		"trap-cmdsub-nested",
		r#"trap 'x=$(y=$(echo "$BASH_COMMAND"); echo "$y"); echo "D:[$x]"' DEBUG; echo  a >/dev/null"#,
	),
	(
		"trap-cmdsub-arith-for",
		r#"trap 'x=$(echo "$BASH_COMMAND"); echo "D:[$x]"' DEBUG; n=0; for ((i=$n; i<1; i++)); do :; done"#,
	),
	("trap-subshell", r#"trap '( echo "S:[$BASH_COMMAND]" )' DEBUG; echo  a >/dev/null"#),
	("trap-pipeline", r#"trap 'echo "P:[$BASH_COMMAND]" | cat' DEBUG; echo  a >/dev/null"#),
	("trap-background", r#"trap '{ echo "B:[$BASH_COMMAND]"; } & wait' DEBUG; echo  a >/dev/null"#),
	(
		"trap-function-cmdsub",
		r#"f() { x=$(echo "$BASH_COMMAND"); echo "F:[$x]"; }; trap f DEBUG; echo  a >/dev/null"#,
	),
	(
		"trap-background-simple",
		r#"trap 'echo "B:[$BASH_COMMAND]" & wait' DEBUG; echo  a >/dev/null"#,
	),
	(
		"trap-pipeline-compound",
		r#"trap '{ echo "P:[$BASH_COMMAND]"; } | cat' DEBUG; echo  a >/dev/null"#,
	),
	("trap-procsub", r#"trap 'cat <(echo "Q:[$BASH_COMMAND]")' DEBUG; echo  a >/dev/null"#),
	(
		"trap-cmdsub-subshell",
		r#"trap 'x=$( ( echo "$BASH_COMMAND" ) ); echo "D:[$x]"' DEBUG; echo  a >/dev/null"#,
	),
	// A coprocess, which bash forks through `execute_in_subshell` too: its
	// own command.
	(
		"trap-coproc",
		r#"trap 'coproc { echo "C:[$BASH_COMMAND]"; read -r; }; read -r l <&"${COPROC[0]}"; echo "$l"; echo >&"${COPROC[1]}"; wait' EXIT; echo  a >/dev/null"#,
	),
	// A `$( )` outside a trap names its own command.
	("cmdsub-own-command", r#"x=$(echo  "[$BASH_COMMAND]"); echo "$x""#),
	("read-in-body", r#"for i in 1; do echo "[$BASH_COMMAND]"; done"#),
	// In a pipeline element or an async command: its own text, as the child
	// that runs it reads it.
	("read-pipe-stderr", r#"echo "[$BASH_COMMAND]"   |&   cat"#),
	("read-heredoc-pipeline", "cat <<EOF | cat\n[$BASH_COMMAND]\nEOF"),
	("read-background", r#"echo   "[$BASH_COMMAND]"   & wait"#),
	// `$BASH_SUBSHELL` in a lone `( … )` job with its own redirection: the
	// level counting of #147 this member builds on (ForkReview5's row).
	("lone-subshell-job-level", "( echo $BASH_SUBSHELL ) 2>/dev/null & wait"),
	("xtrace-case", "set -x; case $(  echo  a  ) in a) :;; esac"),
	("xtrace-for", r#"set -x; for i in $(  echo  a  ) "b  c"; do :; done"#),
	("xtrace-select", "set -x; select s in $(  echo  q  ); do break; done <<< 1"),
	("xtrace-arith-for", "set -x; n=1; for ((i=$(  echo  0  ); i<$n; i++)); do :; done"),
	("xtrace-arith-for-empty", "set -x; for ((;;)); do break; done"),
	// A `PS4` that reads `$BASH_COMMAND`: an expanded arith-for expression
	// is named before its trace line.
	(
		"ps4-arith-for-expanded",
		r"PS4='+[$BASH_COMMAND] '; set -x; n=0; for ((i=$n; i<1; i++)); do :; done; for ((i=0; i<$((n+1)); i+=1)); do :; done",
	),
	(
		"ps4-arith-for-cmdsub",
		r"PS4='+[$BASH_COMMAND] '; set -x; for ((i=$(echo 0); i<1; i++)); do :; done",
	),
	(
		"ps4-arith-for-in-function",
		r"PS4='+[$BASH_COMMAND] '; f() { n=0; for ((i=$n; i<1; i++)); do :; done; }; set -x; f",
	),
	(
		"ps4-heads",
		r"PS4='+[$BASH_COMMAND] '; set -x; for i in a; do :; done; case a in a) :;; esac; for ((i=0; i<1; i++)); do :; done; [[ -n a ]]",
	),
	("xtrace-simple", "set -x; echo   a    b  >/dev/null; x=$(  echo  a  )"),
	(
		"xtrace-debug-order",
		r#"set -x; trap 'echo "D:[$BASH_COMMAND]" >&2' DEBUG; for ((i=0;i<1;i++)); do :; done; for j in 1; do :; done; case a in a) :;; esac"#,
	),
	(
		"xtrace-debug-order-expanded",
		r#"set -x; trap 'echo "D:[$BASH_COMMAND]" >&2' DEBUG; n=0; for ((i=$n;i<1;i++)); do :; done"#,
	),
	(
		"xtrace-debug-case-cmdsub",
		r#"set -x; trap 'echo "D:[$BASH_COMMAND]" >&2' DEBUG; case $(echo a) in a) :;; esac"#,
	),
];

/// Rows run under snapshots ([`Runner::ObashSnapshots`]); none runs a
/// program (an external in flight skips a snapshot).
const SNAPSHOT_ROWS: &[&str] = &[
	"c/for-words",
	"c/for-head-after-body",
	"c/select",
	"c/case-cmdsub-word",
	"c/arith-for-empty",
	"c/arith-for-expanded",
	"c/arith-for-cmdsub",
	"c/simple-blanks",
	"c/trap-cmdsub-debug",
	"c/trap-cmdsub-err",
];

/// One row: its id and script.
type Row = (String, String);

/// Every row: each shape with `-c` (`c/`) and from a script (`s/`).
fn rows() -> Vec<Row> {
	DEBUG_ROWS
		.iter()
		.map(|&(name, x)| (name, format!("{TRAP}{x}")))
		.chain(OWN_ROWS.iter().map(|&(name, x)| (name, x.to_owned())))
		.flat_map(|(name, script)| {
			[(format!("c/{name}"), script.clone()), (format!("s/{name}"), script)]
		})
		.collect()
}

/// stderr with the program's name before `: ` written `SH` (bash names
/// itself by its path).
fn normalized_stderr(stderr: &[u8]) -> String {
	String::from_utf8_lossy(stderr)
		.split_inclusive('\n')
		.map(|line| match line.find(": ") {
			Some(i)
				if !line[..i].contains(':')
					&& (line[..i].contains("bash") || &line[..i] == "environment") =>
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

/// Run row `id`'s `script` with `runner`: with `-c`, or for an `s/` row
/// from the script file `s.sh` in a directory of its own.
fn run_row(runner: Runner<'_>, id: &str, script: &str) -> Outcome {
	let mut cmd = match runner {
		Runner::Oracle(program) => command(program),
		Runner::Obash | Runner::ObashSnapshots => obash(),
	};
	if matches!(runner, Runner::ObashSnapshots) {
		cmd.env("PI_SHELL_FAULT", "1:1");
	}
	let out = if id.starts_with("s/") {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let dir = env::temp_dir().join(format!(
			"pi-bash-command-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, Ordering::Relaxed)
		));
		fs::create_dir(&dir).unwrap();
		fs::write(dir.join("s.sh"), format!("{script}\n")).unwrap();
		let out = output(cmd.current_dir(&dir).arg("s.sh"));
		// Only this row used the directory.
		fs::remove_dir_all(&dir).unwrap();
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

fn fixture() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bash_command_text/bash.jsonl")
}

/// The recorded rows, by id: script and outcome.
fn recorded() -> BTreeMap<String, (String, Outcome)> {
	let text = fs::read_to_string(fixture()).unwrap();
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
fn run_all(runner: Runner<'_>, rows: &[Row]) -> Vec<Outcome> {
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
						mine.push((i, run_row(runner, id, script)));
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
fn assert_recorded(rows: &[Row], got: &[Outcome], record: &BTreeMap<String, (String, Outcome)>) {
	let mut differ = Vec::new();
	for ((id, script), outcome) in rows.iter().zip(got) {
		let (want_script, want) = record
			.get(id)
			.unwrap_or_else(|| panic!("no record of {id}"));
		assert_eq!(want_script, script, "the record of {id} has another script");
		if outcome != want {
			differ.push(format!("{id}: `{script}`\n  bash: {want:?}\n  got: {outcome:?}"));
		}
	}
	assert!(
		differ.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		differ.len(),
		rows.len(),
		differ.join("\n")
	);
}

/// The oracle `PI_LOOP_BASH` names, if any.
fn oracle() -> Option<String> {
	env::var("PI_LOOP_BASH").ok()
}

/// Every row in obash (or the oracle) against the record; with
/// `PI_LOOP_BLESS` and an oracle, the record rewritten from the oracle.
#[test]
fn bash_command_rows_match_bash() {
	let rows = rows();
	let oracle = oracle();
	let runner = oracle.as_deref().map_or(Runner::Obash, Runner::Oracle);
	let got = run_all(runner, &rows);
	if oracle.is_some() && env::var_os("PI_LOOP_BLESS").is_some() {
		let mut text = String::new();
		let record: BTreeMap<&String, (&String, Outcome)> = rows
			.iter()
			.zip(got)
			.map(|((id, script), outcome)| (id, (script, outcome)))
			.collect();
		for (id, (script, (stdout, stderr, status))) in record {
			let row = json!({"id": id, "script": script, "stdout": stdout, "stderr": stderr, "status": status});
			let _ = writeln!(text, "{row}");
		}
		fs::create_dir_all(fixture().parent().unwrap()).unwrap();
		fs::write(fixture(), text).unwrap();
		return;
	}
	let record = recorded();
	assert_eq!(record.len(), rows.len(), "the record's rows are not these rows");
	assert_recorded(&rows, &got, &record);
}

/// [`SNAPSHOT_ROWS`] across snapshots: the command `BASH_COMMAND` names,
/// an arith-for expression's expanded text too, survives the frames image.
/// With an oracle, the oracle runs them.
#[test]
fn bash_command_survives_a_snapshot() {
	let rows: Vec<Row> = rows()
		.into_iter()
		.filter(|(id, _)| SNAPSHOT_ROWS.contains(&id.as_str()))
		.collect();
	assert_eq!(rows.len(), SNAPSHOT_ROWS.len(), "a snapshot row id names no row");
	let oracle = oracle();
	let runner = oracle
		.as_deref()
		.map_or(Runner::ObashSnapshots, Runner::Oracle);
	let got = run_all(runner, &rows);
	assert_recorded(&rows, &got, &recorded());
}
