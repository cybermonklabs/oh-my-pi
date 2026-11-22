//! zsh's job builtins (ports of zsh 5.9 `jobs.c` `bin_fg`, `getjob`,
//! `bin_kill`'s job specs, `bin_suspend`) and zsh/parameter's
//! `jobstates`, `jobtexts` and `jobdirs`, in a shell without job control
//! (`zsh -c`). Expected output comes from `/bin/zsh -f -c` 5.9; where zsh
//! learns of a stop asynchronously its run had a short `sleep` after the
//! `kill -STOP`, which the engine does not need.

use crate::{
	bash::{ModeId, Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` as `zsh -c src`: stdout, stderr, status.
fn zsh(src: &str) -> (String, String, i32) {
	let init = ShellInit { mode: ModeId::Zsh, argv0: "zsh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let status = rig.run(Script::command(src.as_bytes().to_vec()), Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		status,
	)
}

/// A job that runs until it is killed, and zsh's text of it.
const LOOP: &str = "while :; do :; done";
const LOOP_TEXT: &str = "while :; do; :; done";

#[test]
fn jobs_lists_a_running_job_in_zsh_format() {
	let (out, err, _) = zsh(&format!("{LOOP} & jobs; kill -9 %1"));
	assert_eq!(out, format!("[1]  + running    {LOOP_TEXT}\n"));
	assert_eq!(err, "");
}

#[test]
fn job_specs_select_current_previous_numbered_and_named_jobs() {
	let (out, err, _) = zsh(&format!(
		"{LOOP} & until false; do :; done & jobs; jobs %1 %- %+ %% %wh %?until; kill -9 %1 %2"
	));
	let one = format!("[1]  - running    {LOOP_TEXT}\n");
	let two = "[2]  + running    until false; do; :; done\n".to_string();
	assert_eq!(
		out,
		[&one, &two, &one, &one, &two, &two, &one, &two]
			.map(String::as_str)
			.concat()
	);
	assert_eq!(err, "");
}

#[test]
fn three_jobs_mark_only_current_and_previous() {
	let (out, ..) = zsh(&format!("{LOOP} & {LOOP} & {LOOP} & jobs; kill -9 %1 %2 %3"));
	assert_eq!(
		out,
		format!(
			"[1]    running    {LOOP_TEXT}\n[2]  - running    {LOOP_TEXT}\n[3]  + running    \
			 {LOOP_TEXT}\n"
		)
	);
}

#[test]
fn bad_job_specs_are_reported_with_status_127() {
	let (out, err, _) = zsh(
		"jobs %3; echo $?; jobs %; echo $?; jobs %-; echo $?; jobs %foo; echo $?; jobs %?foo; echo \
		 $?; jobs foo; echo $?",
	);
	assert_eq!(out, "127\n127\n127\n127\n127\n127\n");
	assert_eq!(
		err,
		"zsh:jobs:1: %3: no such job\nzsh:jobs:1: no current job\nzsh:jobs:1: no previous \
		 job\nzsh:jobs:1: job not found: foo\nzsh:jobs:1: job not found: ?foo\nzsh:jobs:1: job not \
		 found: foo\n"
	);
}

#[test]
fn a_bad_spec_ends_the_job_arguments() {
	let (out, err, _) =
		zsh(&format!("{LOOP} & jobs 1; echo $?; jobs %1 %4 %1; echo $?; kill -9 %1"));
	assert_eq!(out, format!("127\n[1]  + running    {LOOP_TEXT}\n127\n"));
	assert_eq!(err, "zsh:jobs:1: job not found: 1\nzsh:jobs:1: %4: no such job\n");
}

#[test]
fn posixbuiltins_silences_job_spec_errors() {
	let (out, err, _) =
		zsh("setopt posixbuiltins; jobs %3; echo $?; jobs %; echo $?; jobs %foo; echo $?");
	assert_eq!(out, "127\n127\n127\n");
	assert_eq!(err, "");
}

#[test]
fn fg_and_bg_need_job_control() {
	let (out, err, _) = zsh("fg; echo $?; bg %1; echo $?; fg %1; echo $?");
	assert_eq!(out, "1\n1\n1\n");
	assert_eq!(
		err,
		"zsh:fg:1: no job control in this shell.\nzsh:bg:1: no job control in this \
		 shell.\nzsh:fg:1: no job control in this shell.\n"
	);
}

#[test]
fn disown_drops_jobs_from_the_table() {
	let (out, err, _) = zsh("disown; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("1\n", "zsh:disown:1: no current job\n"));
	let (out, err, _) = zsh(&format!("{LOOP} & p=$!; disown; jobs; echo $?; kill -9 $p"));
	assert_eq!((out.as_str(), err.as_str()), ("0\n", ""));
	let (out, err, _) = zsh(&format!("{LOOP} & disown %1 %1; echo $?; kill -9 $!"));
	assert_eq!((out.as_str(), err.as_str()), ("127\n", "zsh:disown:1: %1: no such job\n"));
}

#[test]
fn disown_of_a_stopped_job_warns_unless_autocontinue() {
	let (out, err, _) = zsh(&format!("{LOOP} & kill -STOP %1; disown; echo $?; jobs; kill -9 $!"));
	assert_eq!(out, "0\n");
	assert!(
		err.starts_with("zsh:disown:1: warning: job is suspended, use `kill -CONT -")
			&& err.ends_with("' to resume\n"),
		"{err}"
	);
	let (out, err, _) = zsh(&format!(
		"setopt autocontinue; {LOOP} & kill -STOP %1; disown; echo $?; jobs; kill -9 $!"
	));
	assert_eq!((out.as_str(), err.as_str()), ("0\n", ""));
}

#[test]
fn stopped_jobs_and_the_running_and_stopped_filters() {
	let (out, err, _) = zsh(&format!(
		"{LOOP} & kill -STOP %1; jobs; print -r -- ${{jobstates[1]/:<->=/:PID=}}; jobs -s; jobs -r; \
		 echo x; kill -9 %1"
	));
	let stopped = format!("[1]  + suspended (signal)  {LOOP_TEXT}\n");
	assert_eq!(out, format!("{stopped}suspended:+:PID=suspended (signal)\n{stopped}x\n"));
	assert_eq!(err, "");
	let (out, ..) =
		zsh(&format!("{LOOP} & {LOOP} & kill -STOP %1; jobs; jobs -r; jobs -s; kill -9 %1 %2"));
	let one = format!("[1]  + suspended (signal)  {LOOP_TEXT}\n");
	let two = format!("[2]  - running    {LOOP_TEXT}\n");
	assert_eq!(out, format!("{one}{two}{two}{one}"));
}

#[test]
fn jobs_d_shows_the_job_directory() {
	let (out, ..) = zsh(&format!("cd /; {LOOP} & jobs -d; kill -9 %1"));
	assert_eq!(out, format!("[1]  + running    {LOOP_TEXT}\n(pwd : /)\n"));
}

#[test]
fn jobs_options_and_suspend_arguments() {
	let (out, err, _) = zsh("jobs -Z foo; echo $?; jobs -Z; echo $?; jobs -q; echo $?");
	assert_eq!(out, "0\n1\n1\n");
	assert_eq!(err, "zsh:jobs:1: -Z requires one argument\nzsh:jobs:1: bad option: -q\n");
	let (out, err, _) = zsh("suspend x; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("1\n", "zsh:suspend:1: too many arguments\n"));
}

#[test]
fn job_parameters_are_readonly_hashes() {
	let (out, err, _) =
		zsh("echo ${(t)jobstates} ${(t)jobtexts} ${(t)jobdirs}; jobstates[1]=x; echo $?");
	let t = "association-readonly-hide-hideval-special";
	assert_eq!(out, format!("{t} {t} {t}\n"));
	assert_eq!(err, "zsh:1: read-only variable: jobstates\n");
	let (out, ..) =
		zsh(&format!("cd /; {LOOP} & print -r -- ${{(kv)jobtexts}} ${{(kv)jobdirs}}; kill -9 %1"));
	assert_eq!(out, format!("1 {LOOP_TEXT} 1 /\n"));
}

#[test]
fn job_texts_are_zsh_getjobtext() {
	for (src, text) in [
		(format!("{{ {LOOP}; echo }}"), format!("{{ {LOOP_TEXT}; echo; }}")),
		(format!("( {LOOP} )"), format!("( {LOOP_TEXT}; )")),
		(format!("{LOOP} > /dev/null"), format!("{LOOP_TEXT} > /dev/null")),
	] {
		let (out, ..) = zsh(&format!("{src} & jobs; kill -9 %1"));
		assert_eq!(out, format!("[1]  + running    {text}\n"), "{src}");
	}
	let (out, ..) = zsh(&format!("f() {{ {LOOP} }}; f & jobs; kill -9 %1"));
	assert_eq!(out, "[1]  + running    f\n");
}

/// zsh's text of a job shows no group where the parser made one around a
/// timed pipeline, and `time ! P` keeps its order (`$jobtexts`: `jobs`
/// lists each process of a pipeline on a line of its own in zsh).
#[test]
fn job_texts_show_no_group_around_time() {
	for (src, text) in [
		(format!("time ! {LOOP}"), format!("time ! {LOOP_TEXT}")),
		(format!(">/dev/null time {LOOP}"), format!("time {LOOP_TEXT} > /dev/null")),
		(format!("true | time {LOOP}"), format!("true | time {LOOP_TEXT}")),
		(
			format!("true | >/dev/null time ! {LOOP}"),
			format!("true | time ! {LOOP_TEXT} > /dev/null"),
		),
		(format!("time ! {LOOP} | {LOOP}"), format!("time ! {LOOP_TEXT} | {LOOP_TEXT}")),
		(format!("{{ time {LOOP} }} > /dev/null"), format!("{{ time {LOOP_TEXT}; }} > /dev/null")),
	] {
		let (out, ..) = zsh(&format!("{src} & print -r -- \"${{jobtexts[1]}}\"; kill -9 %1"));
		assert_eq!(out, format!("{text}\n"), "{src}");
	}
}

/// zsh names a background job by its processes' texts, without the
/// sublist's `!` or `coproc` (a `!` inside `time` is the timed pipeline's
/// own and stays), and shows a here-document as a here-string of its body
/// (`$jobtexts`; zsh 5.9 `addproc` and `getredirs`).
#[test]
fn job_texts_name_the_processes_without_bang_or_coproc() {
	let rows = [
		(format!("! {LOOP} &"), LOOP_TEXT.to_string()),
		(format!("! {{ {LOOP} }} &"), format!("{{ {LOOP_TEXT}; }}")),
		(format!("! time {LOOP} &"), format!("time {LOOP_TEXT}")),
		(format!("time ! {LOOP} &"), format!("time ! {LOOP_TEXT}")),
		(format!("! {LOOP} | {LOOP} &"), format!("{LOOP_TEXT} | {LOOP_TEXT}")),
		(format!("coproc {LOOP}"), LOOP_TEXT.to_string()),
		(format!("coproc {LOOP} | {LOOP}"), format!("{LOOP_TEXT} | {LOOP_TEXT}")),
		(format!("coproc time {LOOP}"), format!("time {LOOP_TEXT}")),
		(format!("{{ {LOOP}; true }} &"), format!("{{ {LOOP_TEXT}; true; }}")),
	];
	for (src, text) in rows {
		let (out, ..) = zsh(&format!("{src}\nprint -r -- \"${{jobtexts[1]}}\"; kill -9 %1"));
		assert_eq!(out, format!("{text}\n"), "{src}");
	}
}

/// A here-document in a job's text is a here-string of its body, its
/// last newline left out and its other newlines spaces: in single quotes,
/// or in double quotes when the body holds an expansion (zsh `getredirs`,
/// `quotestring`); a body that does not fit is dropped, its quotes stay.
#[test]
fn job_texts_show_here_documents_as_zsh_does() {
	let long = "word ".repeat(20);
	let rows = [
		(format!("{LOOP} <<EOF &\nhello world\nEOF"), format!("{LOOP_TEXT} <<<'hello world'")),
		(format!("{LOOP} <<-EOF &\n\thello\n\tEOF"), format!("{LOOP_TEXT} <<<'hello'")),
		(format!("{LOOP} <<A 3<<B &\none\nA\ntwo\nB"), format!("{LOOP_TEXT} <<<'one' 3<<<'two'")),
		(format!("{LOOP} <<'EOF' &\nit's $x\nEOF"), format!("{LOOP_TEXT} <<<'it'\\''s $x'")),
		(format!("x=1\n{LOOP} <<EOF &\nit's $x\nEOF"), format!("{LOOP_TEXT} <<<\"it's $x\"")),
		(
			format!("x=1\n{LOOP} <<EOF &\nsay \"hi\" \\\\ $x\nEOF"),
			format!("{LOOP_TEXT} <<<\"say \\\"hi\\\" \\\\\\ $x\""),
		),
		(format!("{LOOP} <<EOF &\none\ntwo\n\nEOF"), format!("{LOOP_TEXT} <<<'one two '")),
		(format!("{LOOP} <<EOF &\n{long}\nEOF"), format!("{LOOP_TEXT} <<<''")),
		(format!("{LOOP} <<EOF &\nEOF"), format!("{LOOP_TEXT} <<<''")),
		(format!("{LOOP} <<< 'hello world' &"), format!("{LOOP_TEXT} <<< 'hello world'")),
	];
	for (src, text) in rows {
		let (out, ..) = zsh(&format!("{src}\nprint -r -- \"${{jobtexts[1]}}\"; kill -9 %1"));
		assert_eq!(out, format!("{text}\n"), "{src}");
	}
}

/// A job text that is not printed at the job's start (here an `&&` list's
/// whole text, which stands until zsh's foreground run of the list's head is
/// done) keeps a here-document's body too: it is printed from the tree.
/// zsh 5.9 itself shows only `while …` here, as it runs `true` in the
/// foreground first; the body is the same.
#[test]
fn job_texts_of_a_list_keep_here_document_bodies() {
	let (out, ..) = zsh(&format!(
		"true && {LOOP} <<EOF &\nhello world\nEOF\nprint -r -- \"${{jobtexts[1]}}\"; kill -9 %1"
	));
	assert_eq!(out, format!("true && {LOOP_TEXT} <<<'hello world'\n"));
}

/// Each process's text has its own 80-byte buffer, and a full buffer
/// loses the last byte `taddlist` takes back (`B= C`, not `B= C=`).
#[test]
fn job_texts_fill_each_process_buffer_as_zsh_does() {
	let (a70, b20, a72) = ("a".repeat(70), "b".repeat(20), "a".repeat(72));
	let rows = [
		(format!("A={a70} B={b20} C=1 f &"), format!("A={a70} B= C")),
		(format!("f | X={a72} f &"), format!("f | X={a72} f")),
		(format!("coproc f | X={a72} f"), format!("f | X={a72} f")),
	];
	for (src, text) in rows {
		let (out, ..) =
			zsh(&format!("f() {{ {LOOP} }}\n{src}\nprint -r -- \"${{jobtexts[1]}}\"; kill -9 %1"));
		assert_eq!(out, format!("{text}\n"), "{src}");
	}
}

/// `%name` matches the start of a job's text: `! P &` is found by P's
/// name, as in zsh.
#[test]
fn a_negated_job_is_found_by_its_command_name() {
	let (out, ..) = zsh(&format!("! {LOOP} &\nkill -9 %while; print -r -- st=$?"));
	assert_eq!(out, "st=0\n");
}

#[test]
fn kill_resolves_job_specs_with_getjob() {
	let (out, err, _) =
		zsh("kill %3; echo $?; kill %; echo $?; kill %3 %4; echo $?; kill %foo; echo $?");
	assert_eq!(out, "1\n1\n2\n1\n");
	assert_eq!(
		err,
		"zsh:kill:1: %3: no such job\nzsh:kill:1: no current job\nzsh:kill:1: %3: no such \
		 job\nzsh:kill:1: %4: no such job\nzsh:kill:1: job not found: foo\n"
	);
}

#[test]
fn wait_for_a_missing_job() {
	let (out, err, _) = zsh("wait %2; echo $?");
	assert_eq!((out.as_str(), err.as_str()), ("127\n", "zsh:wait:1: %2: no such job\n"));
}
