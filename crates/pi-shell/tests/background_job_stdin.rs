//! What a background job reads on its standard input, as bash 5.3 and zsh
//! 5.9 give it.
//!
//! bash (`execute_connection`'s `&`, `async_redirect_stdin`): without job
//! control, or in a subshell, a job reads `/dev/null` unless its own
//! command's redirections change fd 0, it is a pipeline (not under `time`),
//! or `stdin_redir` is set: since the command reader last cleared it, a
//! compound command run in the shell redirected stdin, or the job runs in a
//! `( … )`, coprocess or pipeline stage fed by its own input. A script
//! file's reader clears it before each command; a `-c` string never does.
//! A lone simple command's `/dev/null` comes after its words are expanded,
//! so their substitutions read the shell's stdin.
//! zsh (`entersubsh`): without MONITOR, only a terminal on fd 0 becomes
//! `/dev/null` for a job. zsh does the same for a `<( … )`; pi-shell does
//! not (zsh mode on a terminal is outside this change): a stated
//! difference, [`a_zsh_process_substitution_keeps_a_terminal`].
//!
//! Rows that read `/proc/self/fd/0` or name `/dev/pts` run on Linux only.
//!
//! Each row runs in a fresh directory holding `in` ("file"): as `-c`
//! (`c`), from a script file (`s`), on a terminal that is not the
//! session's (`t`), or on the session's own terminal (`j`, rows that turn
//! job control on with `set -m`). Stdin carries "hi": a pipe, or the
//! terminal's typed line and end of file. Each row's status and stdout are
//! bash 5.3.20's or zsh 5.9's (bash 5.2.21 gives the same on every row);
//! pipe and terminal numbers are written `N`, and job notices (`[1] 123`,
//! which zsh prints on stdout under `set -m`) are left out.
#![cfg(unix)]

mod obash_support;
mod pty_support;

use std::{
	fs,
	io::{self, Write as _},
	os::unix::process::CommandExt as _,
	path::Path,
	process::{Command, Stdio},
};

use obash_support::{LIMIT, finish, obash};
#[cfg(target_os = "linux")]
use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Id, mode, script, status, stdout.
type Row = (&'static str, char, &'static str, i32, &'static str);

const BASH: &[Row] = &[
	("ext", 'c', "readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("ext", 's', "readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("ext", 't', "readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("ext-cat", 'c', "cat & wait", 0, ""),
	("ext-cat", 's', "cat & wait", 0, ""),
	("fn", 'c', "f() { cat; }; f & wait", 0, ""),
	("fn", 's', "f() { cat; }; f & wait", 0, ""),
	("group", 'c', "{ cat; } & wait", 0, ""),
	("group", 's', "{ cat; } & wait", 0, ""),
	("subshell", 'c', "( cat ) & wait", 0, ""),
	("subshell", 's', "( cat ) & wait", 0, ""),
	("eval", 'c', "eval cat & wait", 0, ""),
	("eval", 's', "eval cat & wait", 0, ""),
	("builtin-read", 'c', "(read x; echo \"[$x]\") & wait", 0, "[]\n"),
	("builtin-read", 's', "(read x; echo \"[$x]\") & wait", 0, "[]\n"),
	("own-dup0", 'c', "cat <&0 & wait", 0, "hi\n"),
	("own-dup0", 's', "cat <&0 & wait", 0, "hi\n"),
	("own-devstdin", 'c', "cat < /dev/stdin & wait", 0, "hi\n"),
	("own-devstdin", 's', "cat < /dev/stdin & wait", 0, "hi\n"),
	("own-file", 'c', "cat < in & wait", 0, "file\n"),
	("own-file", 's', "cat < in & wait", 0, "file\n"),
	("own-fd3-in", 'c', "cat 3< in & wait", 0, "hi\n"),
	("own-fd3-in", 's', "cat 3< in & wait", 0, "hi\n"),
	("own-fd3-rw", 'c', "cat 3<> in & wait", 0, "hi\n"),
	("own-fd3-rw", 's', "cat 3<> in & wait", 0, "hi\n"),
	("own-heredoc", 'c', "cat <<E &\nx\nE\nwait", 0, "x\n"),
	("own-heredoc", 's', "cat <<E &\nx\nE\nwait", 0, "x\n"),
	("own-herestring-3", 'c', "cat 3<<< x & wait", 0, "hi\n"),
	("own-herestring-3", 's', "cat 3<<< x & wait", 0, "hi\n"),
	("own-dup3-to-0", 'c', "cat 3<&0 & wait", 0, ""),
	("own-dup3-to-0", 's', "cat 3<&0 & wait", 0, ""),
	("own-close0", 'c', "cat <&- & wait", 0, ""),
	("own-close0", 's', "cat <&- & wait", 0, ""),
	("own-out", 'c', "cat > out & wait; cat out", 0, ""),
	("own-out", 's', "cat > out & wait; cat out", 0, ""),
	("own-var", 'c', "cat {v}< in & wait", 0, ""),
	("own-var", 's', "cat {v}< in & wait", 0, ""),
	("group-own-in", 'c', "{ cat; } < /dev/stdin & wait", 0, "hi\n"),
	("group-own-in", 's', "{ cat; } < /dev/stdin & wait", 0, "hi\n"),
	("group-own-fd3", 'c', "{ cat; } 3< in & wait", 0, "hi\n"),
	("group-own-fd3", 's', "{ cat; } 3< in & wait", 0, "hi\n"),
	("fn-def-in", 'c', "f() { cat; } < /dev/stdin; f & wait", 0, ""),
	("fn-def-in", 's', "f() { cat; } < /dev/stdin; f & wait", 0, ""),
	("pipeline", 'c', "cat | cat & wait", 0, "hi\n"),
	("pipeline", 's', "cat | cat & wait", 0, "hi\n"),
	("pipeline-3", 'c', "cat | cat | cat & wait", 0, "hi\n"),
	("pipeline-3", 's', "cat | cat | cat & wait", 0, "hi\n"),
	("group-pipeline", 'c', "{ cat | cat; } & wait", 0, ""),
	("group-pipeline", 's', "{ cat | cat; } & wait", 0, ""),
	("enclosing-group", 'c', "{ cat & wait; } < /dev/stdin", 0, "hi\n"),
	("enclosing-group", 's', "{ cat & wait; } < /dev/stdin", 0, "hi\n"),
	("enclosing-while", 'c', "while :; do cat & wait; break; done < /dev/stdin", 0, "hi\n"),
	("enclosing-while", 's', "while :; do cat & wait; break; done < /dev/stdin", 0, "hi\n"),
	("enclosing-fn", 'c', "f() { cat & wait; }; f < /dev/stdin", 0, ""),
	("enclosing-fn", 's', "f() { cat & wait; }; f < /dev/stdin", 0, ""),
	("monitor", 'c', "set -m; cat & wait", 0, "hi\n"),
	("monitor", 's', "set -m; cat & wait", 0, "hi\n"),
	("in-pipeline", 'c', "echo piped | { cat & wait; }", 0, "piped\n"),
	("in-pipeline", 's', "echo piped | { cat & wait; }", 0, "piped\n"),
	("nested", 'c', "( cat & wait ) & wait", 0, ""),
	("nested", 's', "( cat & wait ) & wait", 0, ""),
	("sticky-group", 'c', "{ :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-group", 's', "{ :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-group-nl", 'c', "{ :; } </dev/null\ncat & wait", 0, "hi\n"),
	("sticky-group-nl", 's', "{ :; } </dev/null\ncat & wait", 0, ""),
	("sticky-out", 'c', "{ :; } >/dev/null; cat & wait", 0, ""),
	("sticky-out", 's', "{ :; } >/dev/null; cat & wait", 0, ""),
	("sticky-while", 'c', "while false; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-while", 's', "while false; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-until", 'c', "until :; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-until", 's', "until :; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-if", 'c', "if :; then :; fi </dev/null; cat & wait", 0, "hi\n"),
	("sticky-if", 's', "if :; then :; fi </dev/null; cat & wait", 0, "hi\n"),
	("sticky-for", 'c', "for i in 1; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-for", 's', "for i in 1; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-case", 'c', "case x in x) :;; esac </dev/null; cat & wait", 0, "hi\n"),
	("sticky-case", 's', "case x in x) :;; esac </dev/null; cat & wait", 0, "hi\n"),
	("sticky-cond", 'c', "[[ x ]] </dev/null; cat & wait", 0, "hi\n"),
	("sticky-cond", 's', "[[ x ]] </dev/null; cat & wait", 0, "hi\n"),
	("sticky-arith", 'c', "(( 1 )) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-arith", 's', "(( 1 )) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-subshell", 'c', "( : ) </dev/null; cat & wait", 0, ""),
	("sticky-subshell", 's', "( : ) </dev/null; cat & wait", 0, ""),
	("sticky-fn", 'c', "f() { :; } </dev/null; f; cat & wait", 0, "hi\n"),
	("sticky-fn", 's', "f() { :; } </dev/null; f; cat & wait", 0, "hi\n"),
	("sticky-fn-def", 'c', "f() { :; } </dev/null; cat & wait", 0, ""),
	("sticky-fn-def", 's', "f() { :; } </dev/null; cat & wait", 0, ""),
	("sticky-eval", 'c', "eval '{ :; } </dev/null'; cat & wait", 0, "hi\n"),
	("sticky-eval", 's', "eval '{ :; } </dev/null'; cat & wait", 0, "hi\n"),
	("sticky-reset", 'c', "{ :; } </dev/null; { :; } >/dev/null; cat & wait", 0, ""),
	("sticky-reset", 's', "{ :; } </dev/null; { :; } >/dev/null; cat & wait", 0, ""),
	("sticky-and", 'c', "{ :; } </dev/null && cat & wait", 0, ""),
	("sticky-and", 's', "{ :; } </dev/null && cat & wait", 0, ""),
	("sticky-in-fn", 'c', "f() { { :; } </dev/null; }; f; cat & wait", 0, "hi\n"),
	("sticky-in-fn", 's', "f() { { :; } </dev/null; }; f; cat & wait", 0, "hi\n"),
	("sticky-subshell-in", 'c', "( { :; } </dev/null; cat & wait )", 0, "hi\n"),
	("sticky-subshell-in", 's', "( { :; } </dev/null; cat & wait )", 0, "hi\n"),
	("sticky-subshell-out", 'c', "( { :; } </dev/null ); cat & wait", 0, ""),
	("sticky-subshell-out", 's', "( { :; } </dev/null ); cat & wait", 0, ""),
	("sticky-bg-out", 'c', "{ :; } </dev/null & wait; cat & wait", 0, ""),
	("sticky-bg-out", 's', "{ :; } </dev/null & wait; cat & wait", 0, ""),
	("sticky-fn-nl", 'c', "f() { { :; } </dev/null; }\nf\ncat & wait", 0, "hi\n"),
	("sticky-fn-nl", 's', "f() { { :; } </dev/null; }\nf\ncat & wait", 0, ""),
	("sticky-loop-nl", 'c', "for i in 1 2; do\n{ :; } </dev/null\ncat & wait\ndone", 0, "hi\n"),
	("sticky-loop-nl", 's', "for i in 1 2; do\n{ :; } </dev/null\ncat & wait\ndone", 0, "hi\n"),
	("inner-reset", 'c', "{ { :; } >/dev/null; cat & wait; } </dev/stdin", 0, ""),
	("inner-reset", 's', "{ { :; } >/dev/null; cat & wait; } </dev/stdin", 0, ""),
	("inner-subshell", 'c', "{ ( cat & wait ); } </dev/stdin", 0, ""),
	("inner-subshell", 's', "{ ( cat & wait ); } </dev/stdin", 0, ""),
	("subshell-own", 'c', "( cat & wait ) </dev/stdin", 0, "hi\n"),
	("subshell-own", 's', "( cat & wait ) </dev/stdin", 0, "hi\n"),
	("subshell-own-fd3", 'c', "( cat & wait ) 3<in", 0, "hi\n"),
	("subshell-own-fd3", 's', "( cat & wait ) 3<in", 0, "hi\n"),
	("subshell-own-async", 'c', "( cat & wait ) </dev/stdin & wait", 0, "hi\n"),
	("subshell-own-async", 's', "( cat & wait ) </dev/stdin & wait", 0, "hi\n"),
	("group-own-async", 'c', "{ cat & wait; } </dev/stdin & wait", 0, ""),
	("group-own-async", 's', "{ cat & wait; } </dev/stdin & wait", 0, ""),
	("group-own-pipe", 'c', "{ cat & wait; } </dev/stdin | cat", 0, ""),
	("group-own-pipe", 's', "{ cat & wait; } </dev/stdin | cat", 0, ""),
	("fn-body-redir", 'c', "f() { cat & wait; } </dev/stdin; f", 0, "hi\n"),
	("fn-body-redir", 's', "f() { cat & wait; } </dev/stdin; f", 0, "hi\n"),
	("fn-body-redir-bg", 'c', "f() { cat & wait; } </dev/stdin; f & wait", 0, ""),
	("fn-body-redir-bg", 's', "f() { cat & wait; } </dev/stdin; f & wait", 0, ""),
	("stage2-fn", 'c', "f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("stage2-fn", 's', "f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("stage2-subshell", 'c', "echo piped | ( cat & wait )", 0, "piped\n"),
	("stage2-subshell", 's', "echo piped | ( cat & wait )", 0, "piped\n"),
	("stage2-eval", 'c', "echo piped | eval 'cat & wait'", 0, "piped\n"),
	("stage2-eval", 's', "echo piped | eval 'cat & wait'", 0, "piped\n"),
	("stage2-while", 'c', "printf 'a\\nb\\n' | while read -r x; do cat & wait; done", 0, "b\n"),
	("stage2-while", 's', "printf 'a\\nb\\n' | while read -r x; do cat & wait; done", 0, "b\n"),
	("stage2-nested", 'c', "echo piped | { ( cat & wait ); }", 0, ""),
	("stage2-nested", 's', "echo piped | { ( cat & wait ); }", 0, ""),
	("stage2-sub-group", 'c', "echo piped | ( { cat & wait; } )", 0, "piped\n"),
	("stage2-sub-group", 's', "echo piped | ( { cat & wait; } )", 0, "piped\n"),
	("stage2-group-out", 'c', "echo piped | { { :; } >/dev/null; cat & wait; }", 0, ""),
	("stage2-group-out", 's', "echo piped | { { :; } >/dev/null; cat & wait; }", 0, ""),
	("stage1-group", 'c', "{ cat & wait; } | cat", 0, ""),
	("stage1-group", 's', "{ cat & wait; } | cat", 0, ""),
	("stage1-subshell", 'c', "( cat & wait ) | cat", 0, ""),
	("stage1-subshell", 's', "( cat & wait ) | cat", 0, ""),
	("stage1-subshell-sticky", 'c', "{ :; } </dev/stdin; ( cat & wait ) | cat", 0, ""),
	("stage1-subshell-sticky", 's', "{ :; } </dev/stdin; ( cat & wait ) | cat", 0, ""),
	("stage1-fn", 'c', "f() { cat & wait; }; f | cat", 0, ""),
	("stage1-fn", 's', "f() { cat & wait; }; f | cat", 0, ""),
	("lastpipe", 'c', "shopt -s lastpipe; echo piped | { cat & wait; }", 0, ""),
	("lastpipe", 's', "shopt -s lastpipe; echo piped | { cat & wait; }", 0, ""),
	("lastpipe-fn", 'c', "shopt -s lastpipe; f() { cat & wait; }; echo piped | f", 0, ""),
	("lastpipe-fn", 's', "shopt -s lastpipe; f() { cat & wait; }; echo piped | f", 0, ""),
	("lastpipe-sub", 'c', "shopt -s lastpipe; echo piped | ( cat & wait )", 0, ""),
	("lastpipe-sub", 's', "shopt -s lastpipe; echo piped | ( cat & wait )", 0, ""),
	("time-pipeline", 'c', "TIMEFORMAT=; time cat | cat & wait", 0, ""),
	("time-pipeline", 's', "TIMEFORMAT=; time cat | cat & wait", 0, ""),
	("not-pipeline", 'c', "! cat | cat & wait", 0, "hi\n"),
	("not-pipeline", 's', "! cat | cat & wait", 0, "hi\n"),
	("time-simple", 'c', "TIMEFORMAT=; time cat & wait", 0, ""),
	("time-simple", 's', "TIMEFORMAT=; time cat & wait", 0, ""),
	("not-simple", 'c', "! cat & wait", 0, ""),
	("not-simple", 's', "! cat & wait", 0, ""),
	("time-group", 'c', "TIMEFORMAT=; time { cat; } & wait", 0, ""),
	("time-group", 's', "TIMEFORMAT=; time { cat; } & wait", 0, ""),
	("not-time-pipeline", 'c', "TIMEFORMAT=; ! time cat | cat & wait", 0, ""),
	("not-time-pipeline", 's', "TIMEFORMAT=; ! time cat | cat & wait", 0, ""),
	("comsub", 'c', "echo \"[$(cat & wait)]\"", 0, "[]\n"),
	("comsub", 's', "echo \"[$(cat & wait)]\"", 0, "[]\n"),
	("comsub-in", 'c', "echo \"[$(cat <&0 & wait)]\"", 0, "[hi]\n"),
	("comsub-in", 's', "echo \"[$(cat <&0 & wait)]\"", 0, "[hi]\n"),
	("procsub", 'c', "cat <(cat & wait)", 0, ""),
	("procsub", 's', "cat <(cat & wait)", 0, ""),
	("dup-0-0", 'c', "cat 0<&0 & wait", 0, "hi\n"),
	("dup-0-0", 's', "cat 0<&0 & wait", 0, "hi\n"),
	("close-out-0", 'c', "cat 0>&- & wait", 0, ""),
	("close-out-0", 's', "cat 0>&- & wait", 0, ""),
	("out-to-0", 'c', "cat 0>out & wait", 0, ""),
	("out-to-0", 's', "cat 0>out & wait", 0, ""),
	("move-0-to-3", 'c', "cat 3<&0- & wait", 0, ""),
	("move-0-to-3", 's', "cat 3<&0- & wait", 0, ""),
	("heredoc-3", 'c', "cat 3<<E &\nx\nE\nwait", 0, "hi\n"),
	("heredoc-3", 's', "cat 3<<E &\nx\nE\nwait", 0, "hi\n"),
	("exec-redir", 'c', "exec 0</dev/stdin; cat & wait", 0, ""),
	("exec-redir", 's', "exec 0</dev/stdin; cat & wait", 0, ""),
	("eval-redir", 'c', "eval 'cat & wait' </dev/stdin", 0, ""),
	("eval-redir", 's', "eval 'cat & wait' </dev/stdin", 0, ""),
	("source-redir", 'c', "echo 'cat & wait' > s; . ./s </dev/stdin", 0, ""),
	("source-redir", 's', "echo 'cat & wait' > s; . ./s </dev/stdin", 0, ""),
	("assign-only", 'c', "x=1 cat & wait", 0, ""),
	("assign-only", 's', "x=1 cat & wait", 0, ""),
	("bg-in-bg-group", 'c', "{ cat & wait; } & wait", 0, ""),
	("bg-in-bg-group", 's', "{ cat & wait; } & wait", 0, ""),
	(
		"disown-bg",
		'c',
		"{ cat; echo end > d.tmp; mv d.tmp done; } & disown; n=0; while [ ! -e done ] && [ $n -lt \
		 500 ]; do n=$((n+1)); sleep 0.01; done; cat done",
		0,
		"end\n",
	),
	(
		"disown-bg",
		's',
		"{ cat; echo end > d.tmp; mv d.tmp done; } & disown; n=0; while [ ! -e done ] && [ $n -lt \
		 500 ]; do n=$((n+1)); sleep 0.01; done; cat done",
		0,
		"end\n",
	),
	("read-builtin-bg", 'c', "read x & wait; echo \"[$x]\"", 0, "[]\n"),
	("read-builtin-bg", 's', "read x & wait; echo \"[$x]\"", 0, "[]\n"),
	("m-subshell", 'c', "set -m; ( cat & wait )", 0, ""),
	("m-subshell", 's', "set -m; ( cat & wait )", 0, ""),
	("m-comsub", 'c', "set -m; echo \"[$(cat & wait)]\"", 0, "[]\n"),
	("m-comsub", 's', "set -m; echo \"[$(cat & wait)]\"", 0, "[]\n"),
	("m-stage", 'c', "set -m; { cat & wait; } | cat", 0, ""),
	("m-stage", 's', "set -m; { cat & wait; } | cat", 0, ""),
	("m-group", 'c', "set -m; { cat & wait; }", 0, "hi\n"),
	("m-group", 's', "set -m; { cat & wait; }", 0, "hi\n"),
	("m-own-dup", 'c', "set -m; cat <&0 & wait", 0, "hi\n"),
	("m-own-dup", 's', "set -m; cat <&0 & wait", 0, "hi\n"),
	("m-off", 'c', "set -m; set +m; cat & wait", 0, ""),
	("m-off", 's', "set -m; set +m; cat & wait", 0, ""),
	("m-set-in-sub", 'c', "( set -m; cat & wait )", 0, ""),
	("m-set-in-sub", 's', "( set -m; cat & wait )", 0, ""),
	("m-fn", 'c', "set -m; f() { cat & wait; }; f", 0, "hi\n"),
	("m-fn", 's', "set -m; f() { cat & wait; }; f", 0, "hi\n"),
	("m-bg-group", 'c', "set -m; { cat & wait; } & wait", 0, ""),
	("m-bg-group", 's', "set -m; { cat & wait; } & wait", 0, ""),
	("m-pipeline", 'c', "set -m; cat | cat & wait", 0, "hi\n"),
	("m-pipeline", 's', "set -m; cat | cat & wait", 0, "hi\n"),
	("m-time", 'c', "set -m; TIMEFORMAT=; time cat | cat & wait", 0, "hi\n"),
	("m-time", 's', "set -m; TIMEFORMAT=; time cat | cat & wait", 0, "hi\n"),
	("m-sticky", 'c', "set -m; { :; } </dev/null; set +m; cat & wait", 0, "hi\n"),
	("m-sticky", 's', "set -m; { :; } </dev/null; set +m; cat & wait", 0, "hi\n"),
	("t-own-dup", 't', "readlink /proc/self/fd/0 <&0 & wait", 0, "/dev/pts/N\n"),
	("t-pipeline", 't', "readlink /proc/self/fd/0 | cat & wait", 0, "/dev/pts/N\n"),
	("t-group", 't', "{ readlink /proc/self/fd/0; } & wait", 0, "/dev/null\n"),
	("t-subshell", 't', "( readlink /proc/self/fd/0 ) & wait", 0, "/dev/null\n"),
	("t-fn", 't', "f() { readlink /proc/self/fd/0; }; f & wait", 0, "/dev/null\n"),
	("t-nested", 't', "( readlink /proc/self/fd/0 & wait ) & wait", 0, "/dev/null\n"),
	("t-enclosing", 't', "{ readlink /proc/self/fd/0 & wait; } < /dev/stdin", 0, "/dev/pts/N\n"),
	("t-enclosing-null", 't', "{ readlink /proc/self/fd/0 & wait; } < /dev/null", 0, "/dev/null\n"),
	("t-comsub", 't', "echo \"[$(readlink /proc/self/fd/0 & wait)]\"", 0, "[/dev/null]\n"),
	("t-subshell-in", 't', "( readlink /proc/self/fd/0 & wait )", 0, "/dev/null\n"),
	("t-stage2", 't', "echo x | { readlink /proc/self/fd/0 & wait; }", 0, "pipe:[N]\n"),
	("t-pipe-last", 't', "echo x | readlink /proc/self/fd/0 & wait", 0, "pipe:[N]\n"),
	("t-monitor-off", 't', "set +m; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("t-monitor-on", 't', "set -m; readlink /proc/self/fd/0 & wait", 0, "/dev/pts/N\n"),
	("t-nomonitor-zsh", 't', "setopt nomonitor; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("t-disown-zsh", 't', "readlink /proc/self/fd/0 &! sleep 0.3", 1, "/dev/null\n"),
	("t-write-0", 't', "echo x >&0 & wait $!; echo s=$?", 0, "s=1\n"),
	("t-write-0-ext", 't', "sh -c 'echo x >&0 2>/dev/null; echo s=$?' & wait", 0, "s=1\n"),
	(
		"t-group-write-0-ext",
		't',
		"{ sh -c 'echo x >&0 2>/dev/null; echo s=$?'; } & wait",
		0,
		"s=1\n",
	),
	("t-procsub", 't', "cat <(readlink /proc/self/fd/0)", 0, "/dev/pts/N\n"),
	("t-procsub-bg", 't', "cat <(readlink /proc/self/fd/0) & wait", 0, "/dev/pts/N\n"),
	("t-procsub-bg-group", 't', "{ cat <(readlink /proc/self/fd/0); } & wait", 0, "/dev/null\n"),
	("t-comsub-plain", 't', "echo \"[$(readlink /proc/self/fd/0)]\"", 0, "[/dev/pts/N]\n"),
	(
		"t-time-pipeline",
		't',
		"TIMEFORMAT=; time readlink /proc/self/fd/0 | cat & wait",
		0,
		"/dev/null\n",
	),
	("time-own-dup", 'c', "TIMEFORMAT=; time cat <&0 & wait", 0, ""),
	("time-own-dup", 's', "TIMEFORMAT=; time cat <&0 & wait", 0, ""),
	("not-own-dup", 'c', "! cat <&0 & wait", 0, "hi\n"),
	("not-own-dup", 's', "! cat <&0 & wait", 0, "hi\n"),
	("time-group-own", 'c', "TIMEFORMAT=; time { cat; } </dev/stdin & wait", 0, "hi\n"),
	("time-group-own", 's', "TIMEFORMAT=; time { cat; } </dev/stdin & wait", 0, "hi\n"),
	("and-own-dup", 'c', "cat <&0 && true & wait", 0, ""),
	("and-own-dup", 's', "cat <&0 && true & wait", 0, ""),
	("move-in-0", 'c', "exec 4<in; { cat <&5; } 5<&0 0<&4- & wait", 0, ""),
	("move-in-0", 's', "exec 4<in; { cat <&5; } 5<&0 0<&4- & wait", 0, ""),
	("copy-in-0", 'c', "exec 4<in; { cat <&5; } 5<&0 0<&4 & wait", 0, "hi\n"),
	("copy-in-0", 's', "exec 4<in; { cat <&5; } 5<&0 0<&4 & wait", 0, "hi\n"),
	("quoted-dash", 'c', "cat <&\"-\" & wait", 0, ""),
	("quoted-dash", 's', "cat <&\"-\" & wait", 0, ""),
	("close-3", 'c', "cat 3<&- & wait", 0, ""),
	("close-3", 's', "cat 3<&- & wait", 0, ""),
	("heredoc-dash-3", 'c', "cat 3<<-E &\n\tx\n\tE\nwait", 0, "hi\n"),
	("heredoc-dash-3", 's', "cat 3<<-E &\n\tx\n\tE\nwait", 0, "hi\n"),
	("write-0", 'c', "echo x >&0 & wait $!; echo s=$?", 0, "s=1\n"),
	("write-0", 's', "echo x >&0 & wait $!; echo s=$?", 0, "s=1\n"),
	("group-write-0", 'c', "{ echo x >&0; } & wait $!; echo s=$?", 0, "s=1\n"),
	("group-write-0", 's', "{ echo x >&0; } & wait $!; echo s=$?", 0, "s=1\n"),
	("group-write-0-ext", 'c', "{ sh -c 'echo x >&0 2>/dev/null; echo s=$?'; } & wait", 0, "s=1\n"),
	("group-write-0-ext", 's', "{ sh -c 'echo x >&0 2>/dev/null; echo s=$?'; } & wait", 0, "s=1\n"),
	("procsub-word-bg", 'c', "cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-bg", 's', "cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-bg-group", 'c', "{ cat <(cat); } & wait", 0, ""),
	("procsub-word-bg-group", 's', "{ cat <(cat); } & wait", 0, ""),
	("procsub-word-andor", 'c', "cat <(cat) && true & wait", 0, ""),
	("procsub-word-andor", 's', "cat <(cat) && true & wait", 0, ""),
	("procsub-word-time", 'c', "TIMEFORMAT=; time cat <(cat) & wait", 0, ""),
	("procsub-word-time", 's', "TIMEFORMAT=; time cat <(cat) & wait", 0, ""),
	("procsub-word-not", 'c', "! cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-not", 's', "! cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-func", 'c', "f() { cat \"$1\"; }; f <(cat) & wait", 0, "hi\n"),
	("procsub-word-func", 's', "f() { cat \"$1\"; }; f <(cat) & wait", 0, "hi\n"),
	(
		"procsub-word-builtin",
		'c',
		"read x < <(echo y); mapfile -t a < <(echo z); cat <(cat) 3>/dev/null & wait",
		0,
		"hi\n",
	),
	(
		"procsub-word-builtin",
		's',
		"read x < <(echo y); mapfile -t a < <(echo z); cat <(cat) 3>/dev/null & wait",
		0,
		"hi\n",
	),
	("two-procsubs", 'c', "cat <(cat) <(echo y) & wait", 0, "hi\ny\n"),
	("two-procsubs", 's', "cat <(cat) <(echo y) & wait", 0, "hi\ny\n"),
	("comsub-word-bg", 'c', "echo \"[$(cat)]\" & wait", 0, "[hi]\n"),
	("comsub-word-bg", 's', "echo \"[$(cat)]\" & wait", 0, "[hi]\n"),
	("comsub-assign-bg", 'c', "x=$(cat) sh -c 'echo \"[$x]\"' & wait", 0, "[hi]\n"),
	("comsub-assign-bg", 's', "x=$(cat) sh -c 'echo \"[$x]\"' & wait", 0, "[hi]\n"),
	("assign-only-comsub", 'c', "x=$(cat >o) & wait; cat o", 0, "hi\n"),
	("assign-only-comsub", 's', "x=$(cat >o) & wait; cat o", 0, "hi\n"),
	("comsub-redir-word-bg", 'c', "cat >\"$(cat)\" & wait; ls", 0, "in\n"),
	("comsub-redir-word-bg", 's', "cat >\"$(cat)\" & wait; ls", 0, "in\ns.sh\n"),
	("procsub-then-null", 'c', "cat <(cat) - & wait", 0, "hi\n"),
	("procsub-then-null", 's', "cat <(cat) - & wait", 0, "hi\n"),
	("procsub-own-in", 'c', "cat <(:) - <&0 & wait", 0, "hi\n"),
	("procsub-own-in", 's', "cat <(:) - <&0 & wait", 0, "hi\n"),
	("group-own-procsub-in", 'c', "{ cat; } < <(cat) & wait", 0, "hi\n"),
	("group-own-procsub-in", 's', "{ cat; } < <(cat) & wait", 0, "hi\n"),
	("group-procsub-in-job", 'c', "{ cat & wait; } < <(echo x) & wait", 0, ""),
	("group-procsub-in-job", 's', "{ cat & wait; } < <(echo x) & wait", 0, ""),
	("stage-subshell-procsub", 'c', "echo x | ( cat & wait ) 3< <(:)", 0, "x\n"),
	("stage-subshell-procsub", 's', "echo x | ( cat & wait ) 3< <(:)", 0, "x\n"),
	("stage-subshell-procsub-out", 'c', "echo x | ( cat & wait ) 2> >(:)", 0, "x\n"),
	("stage-subshell-procsub-out", 's', "echo x | ( cat & wait ) 2> >(:)", 0, "x\n"),
	("write-null-ro", 'c', "exec 4</dev/null; echo y >&4; echo t=$?", 0, "t=1\n"),
	("write-null-ro", 's', "exec 4</dev/null; echo y >&4; echo t=$?", 0, "t=1\n"),
	(
		"coproc-job",
		'c',
		"coproc { cat & wait; echo done; }; echo x >&\"${COPROC[1]}\"; eval \"exec \
		 ${COPROC[1]}>&-\"; cat <&\"${COPROC[0]}\"",
		0,
		"x\ndone\n",
	),
	(
		"coproc-job",
		's',
		"coproc { cat & wait; echo done; }; echo x >&\"${COPROC[1]}\"; eval \"exec \
		 ${COPROC[1]}>&-\"; cat <&\"${COPROC[0]}\"",
		0,
		"x\ndone\n",
	),
	("procsub-in", 'c', "cat <(cat)", 0, "hi\n"),
	("procsub-in", 's', "cat <(cat)", 0, "hi\n"),
	("sticky-comsub", 'c', "{ :; } </dev/null; echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("sticky-comsub", 's', "{ :; } </dev/null; echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("sticky-source-nl", 'c', "echo '{ :; } </dev/null' > r; . ./r\ncat & wait", 0, "hi\n"),
	("sticky-source-nl", 's', "echo '{ :; } </dev/null' > r; . ./r\ncat & wait", 0, ""),
	("sticky-eval-nl", 'c', "eval '{ :; } </dev/null'\ncat & wait", 0, "hi\n"),
	("sticky-eval-nl", 's', "eval '{ :; } </dev/null'\ncat & wait", 0, ""),
	("redir-fail-sticky", 'c', "{ :; } </nonexistent; cat & wait", 0, "hi\n"),
	("redir-fail-sticky", 's', "{ :; } </nonexistent; cat & wait", 0, "hi\n"),
	("nested-bash", 'c', "bash -c 'cat & wait' </dev/stdin", 0, ""),
	("nested-bash", 's', "bash -c 'cat & wait' </dev/stdin", 0, ""),
	(
		"andor-group-sets",
		'c',
		"exec 3<&0; { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-group-sets",
		's',
		"exec 3<&0; { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-if-sets",
		'c',
		"exec 3<&0; if :; then :; fi <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-if-sets",
		's',
		"exec 3<&0; if :; then :; fi <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-or-sets",
		'c',
		"exec 3<&0; { false; } <&3 || { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-or-sets",
		's',
		"exec 3<&0; { false; } <&3 || { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	("andor-second-sets", 'c', "exec 3<&0; true && { exec <&3; cat & wait; } <&3 & wait", 0, "hi\n"),
	("andor-second-sets", 's', "exec 3<&0; true && { exec <&3; cat & wait; } <&3 & wait", 0, "hi\n"),
	("oror-second-sets", 'c', "exec 3<&0; false || { exec <&3; cat & wait; } <&3 & wait", 0, "hi\n"),
	("oror-second-sets", 's', "exec 3<&0; false || { exec <&3; cat & wait; } <&3 & wait", 0, "hi\n"),
	(
		"andor-out-clears",
		'c',
		"exec 3<&0; { :; } >/dev/null && { exec <&3; cat & wait; } & wait",
		0,
		"",
	),
	(
		"andor-out-clears",
		's',
		"exec 3<&0; { :; } >/dev/null && { exec <&3; cat & wait; } & wait",
		0,
		"",
	),
	("andor-simple-first", 'c', "exec 3<&0; : <&3 && { exec <&3; cat & wait; } & wait", 0, ""),
	("andor-simple-first", 's', "exec 3<&0; : <&3 && { exec <&3; cat & wait; } & wait", 0, ""),
	(
		"andor-not-first",
		'c',
		"exec 3<&0; ! { false; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-not-first",
		's',
		"exec 3<&0; ! { false; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-time-first",
		'c',
		"exec 3<&0; TIMEFORMAT=; time { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-time-first",
		's',
		"exec 3<&0; TIMEFORMAT=; time { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-stage-first",
		'c',
		"exec 3<&0; { :; } <&3 | cat && { exec <&3; cat & wait; } & wait",
		0,
		"",
	),
	(
		"andor-stage-first",
		's',
		"exec 3<&0; { :; } <&3 | cat && { exec <&3; cat & wait; } & wait",
		0,
		"",
	),
	("j-ext", 'j', "set -m; readlink /proc/self/fd/0 & wait", 0, "/dev/pts/N\n"),
	("j-subshell-in", 'j', "set -m; ( readlink /proc/self/fd/0 & wait )", 0, "/dev/null\n"),
	("j-comsub", 'j', "set -m; echo \"[$(readlink /proc/self/fd/0 & wait)]\"", 0, "[/dev/null]\n"),
	("j-own", 'j', "set -m; readlink /proc/self/fd/0 <&0 & wait", 0, "/dev/pts/N\n"),
	("j-pipeline", 'j', "set -m; readlink /proc/self/fd/0 | cat & wait", 0, "/dev/pts/N\n"),
	("j-off", 'j', "set -m; set +m; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("j-group", 'j', "set -m; { readlink /proc/self/fd/0 & wait; }", 0, "/dev/pts/N\n"),
	("j-stage", 'j', "set -m; { readlink /proc/self/fd/0 & wait; } | cat", 0, "/dev/null\n"),
	("j-bg-group", 'j', "set -m; { readlink /proc/self/fd/0 & wait; } & wait", 0, "/dev/null\n"),
	("j-fn", 'j', "set -m; f() { readlink /proc/self/fd/0 & wait; }; f", 0, "/dev/pts/N\n"),
	(
		"j-sticky-off",
		'j',
		"set -m; { :; } </dev/null; set +m; readlink /proc/self/fd/0 & wait",
		0,
		"/dev/pts/N\n",
	),
];

const ZSH: &[Row] = &[
	("ext", 'c', "readlink /proc/self/fd/0 & wait", 0, "pipe:[N]\n"),
	("ext", 's', "readlink /proc/self/fd/0 & wait", 0, "pipe:[N]\n"),
	("ext", 't', "readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("ext-cat", 'c', "cat & wait", 0, "hi\n"),
	("ext-cat", 's', "cat & wait", 0, "hi\n"),
	("fn", 'c', "f() { cat; }; f & wait", 0, "hi\n"),
	("fn", 's', "f() { cat; }; f & wait", 0, "hi\n"),
	("group", 'c', "{ cat; } & wait", 0, "hi\n"),
	("group", 's', "{ cat; } & wait", 0, "hi\n"),
	("subshell", 'c', "( cat ) & wait", 0, "hi\n"),
	("subshell", 's', "( cat ) & wait", 0, "hi\n"),
	("eval", 'c', "eval cat & wait", 0, "hi\n"),
	("eval", 's', "eval cat & wait", 0, "hi\n"),
	("builtin-read", 'c', "(read x; echo \"[$x]\") & wait", 0, "[hi]\n"),
	("builtin-read", 's', "(read x; echo \"[$x]\") & wait", 0, "[hi]\n"),
	("own-dup0", 'c', "cat <&0 & wait", 0, "hi\n"),
	("own-dup0", 's', "cat <&0 & wait", 0, "hi\n"),
	("own-devstdin", 'c', "cat < /dev/stdin & wait", 0, "hi\n"),
	("own-devstdin", 's', "cat < /dev/stdin & wait", 0, "hi\n"),
	("own-file", 'c', "cat < in & wait", 0, "file\n"),
	("own-file", 's', "cat < in & wait", 0, "file\n"),
	("own-fd3-in", 'c', "cat 3< in & wait", 0, "hi\n"),
	("own-fd3-in", 's', "cat 3< in & wait", 0, "hi\n"),
	("own-fd3-rw", 'c', "cat 3<> in & wait", 0, "hi\n"),
	("own-fd3-rw", 's', "cat 3<> in & wait", 0, "hi\n"),
	("own-heredoc", 'c', "cat <<E &\nx\nE\nwait", 0, "x\n"),
	("own-heredoc", 's', "cat <<E &\nx\nE\nwait", 0, "x\n"),
	("own-herestring-3", 'c', "cat 3<<< x & wait", 0, "hi\n"),
	("own-herestring-3", 's', "cat 3<<< x & wait", 0, "hi\n"),
	("own-dup3-to-0", 'c', "cat 3<&0 & wait", 0, "hi\n"),
	("own-dup3-to-0", 's', "cat 3<&0 & wait", 0, "hi\n"),
	("own-close0", 'c', "cat <&- & wait", 0, ""),
	("own-close0", 's', "cat <&- & wait", 0, ""),
	("own-out", 'c', "cat > out & wait; cat out", 0, "hi\n"),
	("own-out", 's', "cat > out & wait; cat out", 0, "hi\n"),
	("own-var", 'c', "cat {v}< in & wait", 0, "hi\n"),
	("own-var", 's', "cat {v}< in & wait", 0, "hi\n"),
	("group-own-in", 'c', "{ cat; } < /dev/stdin & wait", 0, "hi\n"),
	("group-own-in", 's', "{ cat; } < /dev/stdin & wait", 0, "hi\n"),
	("group-own-fd3", 'c', "{ cat; } 3< in & wait", 0, "hi\n"),
	("group-own-fd3", 's', "{ cat; } 3< in & wait", 0, "hi\n"),
	("fn-def-in", 'c', "f() { cat; } < /dev/stdin; f & wait", 0, "hi\n"),
	("fn-def-in", 's', "f() { cat; } < /dev/stdin; f & wait", 0, "hi\n"),
	("pipeline", 'c', "cat | cat & wait", 0, "hi\n"),
	("pipeline", 's', "cat | cat & wait", 0, "hi\n"),
	("pipeline-3", 'c', "cat | cat | cat & wait", 0, "hi\n"),
	("pipeline-3", 's', "cat | cat | cat & wait", 0, "hi\n"),
	("group-pipeline", 'c', "{ cat | cat; } & wait", 0, "hi\n"),
	("group-pipeline", 's', "{ cat | cat; } & wait", 0, "hi\n"),
	("enclosing-group", 'c', "{ cat & wait; } < /dev/stdin", 0, "hi\n"),
	("enclosing-group", 's', "{ cat & wait; } < /dev/stdin", 0, "hi\n"),
	("enclosing-while", 'c', "while :; do cat & wait; break; done < /dev/stdin", 0, "hi\n"),
	("enclosing-while", 's', "while :; do cat & wait; break; done < /dev/stdin", 0, "hi\n"),
	("enclosing-fn", 'c', "f() { cat & wait; }; f < /dev/stdin", 0, "hi\n"),
	("enclosing-fn", 's', "f() { cat & wait; }; f < /dev/stdin", 0, "hi\n"),
	("monitor", 'c', "set -m; cat & wait", 1, ""),
	("monitor", 's', "set -m; cat & wait", 1, ""),
	("in-pipeline", 'c', "echo piped | { cat & wait; }", 0, "piped\n"),
	("in-pipeline", 's', "echo piped | { cat & wait; }", 0, "piped\n"),
	("nested", 'c', "( cat & wait ) & wait", 0, "hi\n"),
	("nested", 's', "( cat & wait ) & wait", 0, "hi\n"),
	("sticky-group", 'c', "{ :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-group", 's', "{ :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-group-nl", 'c', "{ :; } </dev/null\ncat & wait", 0, "hi\n"),
	("sticky-group-nl", 's', "{ :; } </dev/null\ncat & wait", 0, "hi\n"),
	("sticky-out", 'c', "{ :; } >/dev/null; cat & wait", 0, "hi\n"),
	("sticky-out", 's', "{ :; } >/dev/null; cat & wait", 0, "hi\n"),
	("sticky-while", 'c', "while false; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-while", 's', "while false; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-until", 'c', "until :; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-until", 's', "until :; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-if", 'c', "if :; then :; fi </dev/null; cat & wait", 0, "hi\n"),
	("sticky-if", 's', "if :; then :; fi </dev/null; cat & wait", 0, "hi\n"),
	("sticky-for", 'c', "for i in 1; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-for", 's', "for i in 1; do :; done </dev/null; cat & wait", 0, "hi\n"),
	("sticky-case", 'c', "case x in x) :;; esac </dev/null; cat & wait", 0, "hi\n"),
	("sticky-case", 's', "case x in x) :;; esac </dev/null; cat & wait", 0, "hi\n"),
	("sticky-cond", 'c', "[[ x ]] </dev/null; cat & wait", 0, "hi\n"),
	("sticky-cond", 's', "[[ x ]] </dev/null; cat & wait", 0, "hi\n"),
	("sticky-arith", 'c', "(( 1 )) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-arith", 's', "(( 1 )) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-subshell", 'c', "( : ) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-subshell", 's', "( : ) </dev/null; cat & wait", 0, "hi\n"),
	("sticky-fn", 'c', "f() { :; } </dev/null; f; cat & wait", 0, "hi\n"),
	("sticky-fn", 's', "f() { :; } </dev/null; f; cat & wait", 0, "hi\n"),
	("sticky-fn-def", 'c', "f() { :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-fn-def", 's', "f() { :; } </dev/null; cat & wait", 0, "hi\n"),
	("sticky-eval", 'c', "eval '{ :; } </dev/null'; cat & wait", 0, "hi\n"),
	("sticky-eval", 's', "eval '{ :; } </dev/null'; cat & wait", 0, "hi\n"),
	("sticky-reset", 'c', "{ :; } </dev/null; { :; } >/dev/null; cat & wait", 0, "hi\n"),
	("sticky-reset", 's', "{ :; } </dev/null; { :; } >/dev/null; cat & wait", 0, "hi\n"),
	("sticky-and", 'c', "{ :; } </dev/null && cat & wait", 0, "hi\n"),
	("sticky-and", 's', "{ :; } </dev/null && cat & wait", 0, "hi\n"),
	("sticky-in-fn", 'c', "f() { { :; } </dev/null; }; f; cat & wait", 0, "hi\n"),
	("sticky-in-fn", 's', "f() { { :; } </dev/null; }; f; cat & wait", 0, "hi\n"),
	("sticky-subshell-in", 'c', "( { :; } </dev/null; cat & wait )", 0, "hi\n"),
	("sticky-subshell-in", 's', "( { :; } </dev/null; cat & wait )", 0, "hi\n"),
	("sticky-subshell-out", 'c', "( { :; } </dev/null ); cat & wait", 0, "hi\n"),
	("sticky-subshell-out", 's', "( { :; } </dev/null ); cat & wait", 0, "hi\n"),
	("sticky-bg-out", 'c', "{ :; } </dev/null & wait; cat & wait", 0, "hi\n"),
	("sticky-bg-out", 's', "{ :; } </dev/null & wait; cat & wait", 0, "hi\n"),
	("sticky-fn-nl", 'c', "f() { { :; } </dev/null; }\nf\ncat & wait", 0, "hi\n"),
	("sticky-fn-nl", 's', "f() { { :; } </dev/null; }\nf\ncat & wait", 0, "hi\n"),
	("sticky-loop-nl", 'c', "for i in 1 2; do\n{ :; } </dev/null\ncat & wait\ndone", 0, "hi\n"),
	("sticky-loop-nl", 's', "for i in 1 2; do\n{ :; } </dev/null\ncat & wait\ndone", 0, "hi\n"),
	("inner-reset", 'c', "{ { :; } >/dev/null; cat & wait; } </dev/stdin", 0, "hi\n"),
	("inner-reset", 's', "{ { :; } >/dev/null; cat & wait; } </dev/stdin", 0, "hi\n"),
	("inner-subshell", 'c', "{ ( cat & wait ); } </dev/stdin", 0, "hi\n"),
	("inner-subshell", 's', "{ ( cat & wait ); } </dev/stdin", 0, "hi\n"),
	("subshell-own", 'c', "( cat & wait ) </dev/stdin", 0, "hi\n"),
	("subshell-own", 's', "( cat & wait ) </dev/stdin", 0, "hi\n"),
	("subshell-own-fd3", 'c', "( cat & wait ) 3<in", 0, "hi\n"),
	("subshell-own-fd3", 's', "( cat & wait ) 3<in", 0, "hi\n"),
	("subshell-own-async", 'c', "( cat & wait ) </dev/stdin & wait", 0, "hi\n"),
	("subshell-own-async", 's', "( cat & wait ) </dev/stdin & wait", 0, "hi\n"),
	("group-own-async", 'c', "{ cat & wait; } </dev/stdin & wait", 0, "hi\n"),
	("group-own-async", 's', "{ cat & wait; } </dev/stdin & wait", 0, "hi\n"),
	("group-own-pipe", 'c', "{ cat & wait; } </dev/stdin | cat", 0, "hi\n"),
	("group-own-pipe", 's', "{ cat & wait; } </dev/stdin | cat", 0, "hi\n"),
	("fn-body-redir", 'c', "f() { cat & wait; } </dev/stdin; f", 0, "hi\n"),
	("fn-body-redir", 's', "f() { cat & wait; } </dev/stdin; f", 0, "hi\n"),
	("fn-body-redir-bg", 'c', "f() { cat & wait; } </dev/stdin; f & wait", 0, "hi\n"),
	("fn-body-redir-bg", 's', "f() { cat & wait; } </dev/stdin; f & wait", 0, "hi\n"),
	("stage2-fn", 'c', "f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("stage2-fn", 's', "f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("stage2-subshell", 'c', "echo piped | ( cat & wait )", 0, "piped\n"),
	("stage2-subshell", 's', "echo piped | ( cat & wait )", 0, "piped\n"),
	("stage2-eval", 'c', "echo piped | eval 'cat & wait'", 0, "piped\n"),
	("stage2-eval", 's', "echo piped | eval 'cat & wait'", 0, "piped\n"),
	("stage2-while", 'c', "printf 'a\\nb\\n' | while read -r x; do cat & wait; done", 0, "b\n"),
	("stage2-while", 's', "printf 'a\\nb\\n' | while read -r x; do cat & wait; done", 0, "b\n"),
	("stage2-nested", 'c', "echo piped | { ( cat & wait ); }", 0, "piped\n"),
	("stage2-nested", 's', "echo piped | { ( cat & wait ); }", 0, "piped\n"),
	("stage2-sub-group", 'c', "echo piped | ( { cat & wait; } )", 0, "piped\n"),
	("stage2-sub-group", 's', "echo piped | ( { cat & wait; } )", 0, "piped\n"),
	("stage2-group-out", 'c', "echo piped | { { :; } >/dev/null; cat & wait; }", 0, "piped\n"),
	("stage2-group-out", 's', "echo piped | { { :; } >/dev/null; cat & wait; }", 0, "piped\n"),
	("stage1-group", 'c', "{ cat & wait; } | cat", 0, "hi\n"),
	("stage1-group", 's', "{ cat & wait; } | cat", 0, "hi\n"),
	("stage1-subshell", 'c', "( cat & wait ) | cat", 0, "hi\n"),
	("stage1-subshell", 's', "( cat & wait ) | cat", 0, "hi\n"),
	("stage1-subshell-sticky", 'c', "{ :; } </dev/stdin; ( cat & wait ) | cat", 0, "hi\n"),
	("stage1-subshell-sticky", 's', "{ :; } </dev/stdin; ( cat & wait ) | cat", 0, "hi\n"),
	("stage1-fn", 'c', "f() { cat & wait; }; f | cat", 0, "hi\n"),
	("stage1-fn", 's', "f() { cat & wait; }; f | cat", 0, "hi\n"),
	("lastpipe", 'c', "shopt -s lastpipe; echo piped | { cat & wait; }", 0, "piped\n"),
	("lastpipe", 's', "shopt -s lastpipe; echo piped | { cat & wait; }", 0, "piped\n"),
	("lastpipe-fn", 'c', "shopt -s lastpipe; f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("lastpipe-fn", 's', "shopt -s lastpipe; f() { cat & wait; }; echo piped | f", 0, "piped\n"),
	("lastpipe-sub", 'c', "shopt -s lastpipe; echo piped | ( cat & wait )", 0, "piped\n"),
	("lastpipe-sub", 's', "shopt -s lastpipe; echo piped | ( cat & wait )", 0, "piped\n"),
	("time-pipeline", 'c', "TIMEFORMAT=; time cat | cat & wait", 0, "hi\n"),
	("time-pipeline", 's', "TIMEFORMAT=; time cat | cat & wait", 0, "hi\n"),
	("not-pipeline", 'c', "! cat | cat & wait", 0, "hi\n"),
	("not-pipeline", 's', "! cat | cat & wait", 0, "hi\n"),
	("time-simple", 'c', "TIMEFORMAT=; time cat & wait", 0, "hi\n"),
	("time-simple", 's', "TIMEFORMAT=; time cat & wait", 0, "hi\n"),
	("not-simple", 'c', "! cat & wait", 0, "hi\n"),
	("not-simple", 's', "! cat & wait", 0, "hi\n"),
	("time-group", 'c', "TIMEFORMAT=; time { cat; } & wait", 0, "hi\n"),
	("time-group", 's', "TIMEFORMAT=; time { cat; } & wait", 0, "hi\n"),
	("not-time-pipeline", 'c', "TIMEFORMAT=; ! time cat | cat & wait", 0, "hi\n"),
	("not-time-pipeline", 's', "TIMEFORMAT=; ! time cat | cat & wait", 0, "hi\n"),
	("comsub", 'c', "echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("comsub", 's', "echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("comsub-in", 'c', "echo \"[$(cat <&0 & wait)]\"", 0, "[hi]\n"),
	("comsub-in", 's', "echo \"[$(cat <&0 & wait)]\"", 0, "[hi]\n"),
	("procsub", 'c', "cat <(cat & wait)", 0, "hi\n"),
	("procsub", 's', "cat <(cat & wait)", 0, "hi\n"),
	("dup-0-0", 'c', "cat 0<&0 & wait", 0, "hi\n"),
	("dup-0-0", 's', "cat 0<&0 & wait", 0, "hi\n"),
	("close-out-0", 'c', "cat 0>&- & wait", 0, ""),
	("close-out-0", 's', "cat 0>&- & wait", 0, ""),
	("out-to-0", 'c', "cat 0>out & wait", 0, ""),
	("out-to-0", 's', "cat 0>out & wait", 0, ""),
	("move-0-to-3", 'c', "cat 3<&0- & wait", 0, ""),
	("move-0-to-3", 's', "cat 3<&0- & wait", 0, ""),
	("heredoc-3", 'c', "cat 3<<E &\nx\nE\nwait", 0, "hi\n"),
	("heredoc-3", 's', "cat 3<<E &\nx\nE\nwait", 0, "hi\n"),
	("exec-redir", 'c', "exec 0</dev/stdin; cat & wait", 0, "hi\n"),
	("exec-redir", 's', "exec 0</dev/stdin; cat & wait", 0, "hi\n"),
	("eval-redir", 'c', "eval 'cat & wait' </dev/stdin", 0, "hi\n"),
	("eval-redir", 's', "eval 'cat & wait' </dev/stdin", 0, "hi\n"),
	("source-redir", 'c', "echo 'cat & wait' > s; . ./s </dev/stdin", 0, "hi\n"),
	("source-redir", 's', "echo 'cat & wait' > s; . ./s </dev/stdin", 0, "hi\n"),
	("assign-only", 'c', "x=1 cat & wait", 0, "hi\n"),
	("assign-only", 's', "x=1 cat & wait", 0, "hi\n"),
	("bg-in-bg-group", 'c', "{ cat & wait; } & wait", 0, "hi\n"),
	("bg-in-bg-group", 's', "{ cat & wait; } & wait", 0, "hi\n"),
	(
		"disown-bg",
		'c',
		"{ cat; echo end > d.tmp; mv d.tmp done; } & disown; n=0; while [ ! -e done ] && [ $n -lt \
		 500 ]; do n=$((n+1)); sleep 0.01; done; cat done",
		0,
		"hi\nend\n",
	),
	(
		"disown-bg",
		's',
		"{ cat; echo end > d.tmp; mv d.tmp done; } & disown; n=0; while [ ! -e done ] && [ $n -lt \
		 500 ]; do n=$((n+1)); sleep 0.01; done; cat done",
		0,
		"hi\nend\n",
	),
	("read-builtin-bg", 'c', "read x & wait; echo \"[$x]\"", 0, "[]\n"),
	("read-builtin-bg", 's', "read x & wait; echo \"[$x]\"", 0, "[]\n"),
	("m-subshell", 'c', "set -m; ( cat & wait )", 1, ""),
	("m-subshell", 's', "set -m; ( cat & wait )", 1, ""),
	("m-comsub", 'c', "set -m; echo \"[$(cat & wait)]\"", 1, ""),
	("m-comsub", 's', "set -m; echo \"[$(cat & wait)]\"", 1, ""),
	("m-stage", 'c', "set -m; { cat & wait; } | cat", 1, ""),
	("m-stage", 's', "set -m; { cat & wait; } | cat", 1, ""),
	("m-group", 'c', "set -m; { cat & wait; }", 1, ""),
	("m-group", 's', "set -m; { cat & wait; }", 1, ""),
	("m-own-dup", 'c', "set -m; cat <&0 & wait", 1, ""),
	("m-own-dup", 's', "set -m; cat <&0 & wait", 1, ""),
	("m-off", 'c', "set -m; set +m; cat & wait", 1, ""),
	("m-off", 's', "set -m; set +m; cat & wait", 1, ""),
	("m-set-in-sub", 'c', "( set -m; cat & wait )", 1, ""),
	("m-set-in-sub", 's', "( set -m; cat & wait )", 1, ""),
	("m-fn", 'c', "set -m; f() { cat & wait; }; f", 1, ""),
	("m-fn", 's', "set -m; f() { cat & wait; }; f", 1, ""),
	("m-bg-group", 'c', "set -m; { cat & wait; } & wait", 1, ""),
	("m-bg-group", 's', "set -m; { cat & wait; } & wait", 1, ""),
	("m-pipeline", 'c', "set -m; cat | cat & wait", 1, ""),
	("m-pipeline", 's', "set -m; cat | cat & wait", 1, ""),
	("m-time", 'c', "set -m; TIMEFORMAT=; time cat | cat & wait", 1, ""),
	("m-time", 's', "set -m; TIMEFORMAT=; time cat | cat & wait", 1, ""),
	("m-sticky", 'c', "set -m; { :; } </dev/null; set +m; cat & wait", 1, ""),
	("m-sticky", 's', "set -m; { :; } </dev/null; set +m; cat & wait", 1, ""),
	("t-own-dup", 't', "readlink /proc/self/fd/0 <&0 & wait", 0, "/dev/null\n"),
	("t-pipeline", 't', "readlink /proc/self/fd/0 | cat & wait", 0, "/dev/null\n"),
	("t-group", 't', "{ readlink /proc/self/fd/0; } & wait", 0, "/dev/null\n"),
	("t-subshell", 't', "( readlink /proc/self/fd/0 ) & wait", 0, "/dev/null\n"),
	("t-fn", 't', "f() { readlink /proc/self/fd/0; }; f & wait", 0, "/dev/null\n"),
	("t-nested", 't', "( readlink /proc/self/fd/0 & wait ) & wait", 0, "/dev/null\n"),
	("t-enclosing", 't', "{ readlink /proc/self/fd/0 & wait; } < /dev/stdin", 0, "/dev/null\n"),
	("t-enclosing-null", 't', "{ readlink /proc/self/fd/0 & wait; } < /dev/null", 0, "/dev/null\n"),
	("t-comsub", 't', "echo \"[$(readlink /proc/self/fd/0 & wait)]\"", 0, "[/dev/null]\n"),
	("t-subshell-in", 't', "( readlink /proc/self/fd/0 & wait )", 0, "/dev/null\n"),
	("t-stage2", 't', "echo x | { readlink /proc/self/fd/0 & wait; }", 0, "pipe:[N]\n"),
	("t-pipe-last", 't', "echo x | readlink /proc/self/fd/0 & wait", 0, "pipe:[N]\n"),
	("t-monitor-off", 't', "set +m; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("t-monitor-on", 't', "set -m; readlink /proc/self/fd/0 & wait", 0, "/dev/pts/N\n"),
	("t-nomonitor-zsh", 't', "setopt nomonitor; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("t-disown-zsh", 't', "readlink /proc/self/fd/0 &! sleep 0.3", 0, "/dev/null\n"),
	("t-write-0", 't', "echo x >&0 & wait $!; echo s=$?", 0, "s=0\n"),
	("t-write-0-ext", 't', "sh -c 'echo x >&0 2>/dev/null; echo s=$?' & wait", 0, "s=0\n"),
	(
		"t-group-write-0-ext",
		't',
		"{ sh -c 'echo x >&0 2>/dev/null; echo s=$?'; } & wait",
		0,
		"s=0\n",
	),
	("t-procsub-bg", 't', "cat <(readlink /proc/self/fd/0) & wait", 0, "/dev/null\n"),
	("t-procsub-bg-group", 't', "{ cat <(readlink /proc/self/fd/0); } & wait", 0, "/dev/null\n"),
	("t-comsub-plain", 't', "echo \"[$(readlink /proc/self/fd/0)]\"", 0, "[/dev/pts/N]\n"),
	(
		"t-time-pipeline",
		't',
		"TIMEFORMAT=; time readlink /proc/self/fd/0 | cat & wait",
		0,
		"/dev/null\n",
	),
	("time-own-dup", 'c', "TIMEFORMAT=; time cat <&0 & wait", 0, "hi\n"),
	("time-own-dup", 's', "TIMEFORMAT=; time cat <&0 & wait", 0, "hi\n"),
	("not-own-dup", 'c', "! cat <&0 & wait", 0, "hi\n"),
	("not-own-dup", 's', "! cat <&0 & wait", 0, "hi\n"),
	("time-group-own", 'c', "TIMEFORMAT=; time { cat; } </dev/stdin & wait", 0, "hi\n"),
	("time-group-own", 's', "TIMEFORMAT=; time { cat; } </dev/stdin & wait", 0, "hi\n"),
	("and-own-dup", 'c', "cat <&0 && true & wait", 0, "hi\n"),
	("and-own-dup", 's', "cat <&0 && true & wait", 0, "hi\n"),
	("move-in-0", 'c', "exec 4<in; { cat <&5; } 5<&0 0<&4- & wait", 0, ""),
	("move-in-0", 's', "exec 4<in; { cat <&5; } 5<&0 0<&4- & wait", 0, ""),
	("copy-in-0", 'c', "exec 4<in; { cat <&5; } 5<&0 0<&4 & wait", 0, "hi\n"),
	("copy-in-0", 's', "exec 4<in; { cat <&5; } 5<&0 0<&4 & wait", 0, "hi\n"),
	("quoted-dash", 'c', "cat <&\"-\" & wait", 0, ""),
	("quoted-dash", 's', "cat <&\"-\" & wait", 0, ""),
	("close-3", 'c', "cat 3<&- & wait", 0, "hi\n"),
	("close-3", 's', "cat 3<&- & wait", 0, "hi\n"),
	("heredoc-dash-3", 'c', "cat 3<<-E &\n\tx\n\tE\nwait", 0, "hi\n"),
	("heredoc-dash-3", 's', "cat 3<<-E &\n\tx\n\tE\nwait", 0, "hi\n"),
	("write-0", 'c', "echo x >&0 & wait $!; echo s=$?", 0, "s=0\n"),
	("write-0", 's', "echo x >&0 & wait $!; echo s=$?", 0, "s=0\n"),
	("procsub-word-bg", 'c', "cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-bg", 's', "cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-bg-group", 'c', "{ cat <(cat); } & wait", 0, "hi\n"),
	("procsub-word-bg-group", 's', "{ cat <(cat); } & wait", 0, "hi\n"),
	("procsub-word-andor", 'c', "cat <(cat) && true & wait", 0, "hi\n"),
	("procsub-word-andor", 's', "cat <(cat) && true & wait", 0, "hi\n"),
	("procsub-word-time", 'c', "TIMEFORMAT=; time cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-time", 's', "TIMEFORMAT=; time cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-not", 'c', "! cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-not", 's', "! cat <(cat) & wait", 0, "hi\n"),
	("procsub-word-func", 'c', "f() { cat \"$1\"; }; f <(cat) & wait", 0, "hi\n"),
	("procsub-word-func", 's', "f() { cat \"$1\"; }; f <(cat) & wait", 0, "hi\n"),
	(
		"procsub-word-builtin",
		'c',
		"read x < <(echo y); mapfile -t a < <(echo z); cat <(cat) 3>/dev/null & wait",
		0,
		"hi\n",
	),
	(
		"procsub-word-builtin",
		's',
		"read x < <(echo y); mapfile -t a < <(echo z); cat <(cat) 3>/dev/null & wait",
		0,
		"hi\n",
	),
	("two-procsubs", 'c', "cat <(cat) <(echo y) & wait", 0, "hi\ny\n"),
	("two-procsubs", 's', "cat <(cat) <(echo y) & wait", 0, "hi\ny\n"),
	("comsub-word-bg", 'c', "echo \"[$(cat)]\" & wait", 0, "[hi]\n"),
	("comsub-word-bg", 's', "echo \"[$(cat)]\" & wait", 0, "[hi]\n"),
	("comsub-assign-bg", 'c', "x=$(cat) sh -c 'echo \"[$x]\"' & wait", 0, "[hi]\n"),
	("comsub-assign-bg", 's', "x=$(cat) sh -c 'echo \"[$x]\"' & wait", 0, "[hi]\n"),
	("comsub-redir-word-bg", 'c', "cat >\"$(cat)\" & wait; ls", 0, "hi\nin\n"),
	("comsub-redir-word-bg", 's', "cat >\"$(cat)\" & wait; ls", 0, "hi\nin\ns.sh\n"),
	("procsub-then-null", 'c', "cat <(cat) - & wait", 0, "hi\n"),
	("procsub-then-null", 's', "cat <(cat) - & wait", 0, "hi\n"),
	("write-null-ro", 'c', "exec 4</dev/null; echo y >&4; echo t=$?", 0, "t=0\n"),
	("write-null-ro", 's', "exec 4</dev/null; echo y >&4; echo t=$?", 0, "t=0\n"),
	("procsub-in", 'c', "cat <(cat)", 0, "hi\n"),
	("procsub-in", 's', "cat <(cat)", 0, "hi\n"),
	("sticky-comsub", 'c', "{ :; } </dev/null; echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("sticky-comsub", 's', "{ :; } </dev/null; echo \"[$(cat & wait)]\"", 0, "[hi]\n"),
	("sticky-source-nl", 'c', "echo '{ :; } </dev/null' > r; . ./r\ncat & wait", 0, "hi\n"),
	("sticky-source-nl", 's', "echo '{ :; } </dev/null' > r; . ./r\ncat & wait", 0, "hi\n"),
	("sticky-eval-nl", 'c', "eval '{ :; } </dev/null'\ncat & wait", 0, "hi\n"),
	("sticky-eval-nl", 's', "eval '{ :; } </dev/null'\ncat & wait", 0, "hi\n"),
	("redir-fail-sticky", 'c', "{ :; } </nonexistent; cat & wait", 0, "hi\n"),
	("redir-fail-sticky", 's', "{ :; } </nonexistent; cat & wait", 0, "hi\n"),
	("nested-bash", 'c', "bash -c 'cat & wait' </dev/stdin", 0, ""),
	("nested-bash", 's', "bash -c 'cat & wait' </dev/stdin", 0, ""),
	(
		"andor-group-sets",
		'c',
		"exec 3<&0; { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-group-sets",
		's',
		"exec 3<&0; { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-if-sets",
		'c',
		"exec 3<&0; if :; then :; fi <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-if-sets",
		's',
		"exec 3<&0; if :; then :; fi <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-or-sets",
		'c',
		"exec 3<&0; { false; } <&3 || { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-or-sets",
		's',
		"exec 3<&0; { false; } <&3 || { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-out-clears",
		'c',
		"exec 3<&0; { :; } >/dev/null && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-out-clears",
		's',
		"exec 3<&0; { :; } >/dev/null && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	("andor-simple-first", 'c', "exec 3<&0; : <&3 && { exec <&3; cat & wait; } & wait", 0, "hi\n"),
	("andor-simple-first", 's', "exec 3<&0; : <&3 && { exec <&3; cat & wait; } & wait", 0, "hi\n"),
	(
		"andor-not-first",
		'c',
		"exec 3<&0; ! { false; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-not-first",
		's',
		"exec 3<&0; ! { false; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-time-first",
		'c',
		"exec 3<&0; TIMEFORMAT=; time { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-time-first",
		's',
		"exec 3<&0; TIMEFORMAT=; time { :; } <&3 && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-stage-first",
		'c',
		"exec 3<&0; { :; } <&3 | cat && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	(
		"andor-stage-first",
		's',
		"exec 3<&0; { :; } <&3 | cat && { exec <&3; cat & wait; } & wait",
		0,
		"hi\n",
	),
	("j-ext", 'j', "set -m; readlink /proc/self/fd/0 & wait", 0, "/dev/pts/N\n"),
	("j-subshell-in", 'j', "set -m; ( readlink /proc/self/fd/0 & wait )", 0, "/dev/null\n"),
	("j-comsub", 'j', "set -m; echo \"[$(readlink /proc/self/fd/0 & wait)]\"", 0, "[/dev/null]\n"),
	("j-own", 'j', "set -m; readlink /proc/self/fd/0 <&0 & wait", 0, "/dev/pts/N\n"),
	("j-pipeline", 'j', "set -m; readlink /proc/self/fd/0 | cat & wait", 0, "/dev/pts/N\n"),
	("j-off", 'j', "set -m; set +m; readlink /proc/self/fd/0 & wait", 0, "/dev/null\n"),
	("j-group", 'j', "set -m; { readlink /proc/self/fd/0 & wait; }", 0, "/dev/pts/N\n"),
	("j-stage", 'j', "set -m; { readlink /proc/self/fd/0 & wait; } | cat", 0, "/dev/null\n"),
	("j-bg-group", 'j', "set -m; { readlink /proc/self/fd/0 & wait; } & wait", 0, "/dev/null\n"),
	("j-fn", 'j', "set -m; f() { readlink /proc/self/fd/0 & wait; }; f", 0, "/dev/pts/N\n"),
	(
		"j-sticky-off",
		'j',
		"set -m; { :; } </dev/null; set +m; readlink /proc/self/fd/0 & wait",
		0,
		"/dev/null\n",
	),
];

/// `[1] 123` or `[1] 123 124` and its newline: a job notice.
fn is_notice(line: &str) -> bool {
	let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
	line
		.strip_prefix('[')
		.and_then(|rest| rest.split_once("] "))
		.is_some_and(|(number, pids)| {
			digits(number)
				&& pids
					.strip_suffix('\n')
					.is_some_and(|p| p.split(' ').all(digits))
		})
}

/// `line` with the digits after each `prefix` written `N`.
fn number(line: &str, prefix: &str) -> String {
	let mut out = String::with_capacity(line.len());
	let mut rest = line;
	while let Some(at) = rest.find(prefix) {
		let (head, tail) = rest.split_at(at + prefix.len());
		out.push_str(head);
		let end = tail
			.find(|c: char| !c.is_ascii_digit())
			.unwrap_or(tail.len());
		if end > 0 {
			out.push('N');
		}
		rest = &tail[end..];
	}
	out.push_str(rest);
	out
}

fn clean(bytes: &[u8]) -> String {
	String::from_utf8_lossy(bytes)
		.split_inclusive('\n')
		.filter(|line| !is_notice(line))
		.map(|line| number(&number(line, "pipe:["), "/dev/pts/"))
		.collect()
}

/// The row's command: `dialect`'s obash in `dir`, running `script` as
/// `mode` says. A terminal row's process is hermetic as [`obash`]'s, but
/// starts its own session (in [`run`]) instead of a process group.
fn command(dialect: &str, mode: char, script: &str, dir: &Path) -> io::Result<Command> {
	let mut cmd = if matches!(mode, 'c' | 's') {
		obash()
	} else {
		let mut cmd = Command::new(env!("CARGO_BIN_EXE_obash"));
		cmd.env_clear()
			.env("PATH", std::env::var_os("PATH").unwrap_or_default())
			.env("HOME", dir)
			.env("LC_ALL", "C")
			.env("TERM", "dumb")
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		cmd
	};
	cmd.arg0(dialect).current_dir(dir);
	if dialect == "zsh" {
		cmd.arg("-f");
	}
	if mode == 's' {
		fs::write(dir.join("s.sh"), format!("{script}\n"))?;
		cmd.arg("s.sh");
	} else {
		cmd.arg("-c").arg(script);
	}
	Ok(cmd)
}

/// Run a row of `dialect`: its status and cleaned stdout.
fn run(dialect: &str, mode: char, script: &str) -> io::Result<(Option<i32>, String)> {
	let dir = tempfile::tempdir()?;
	fs::write(dir.path().join("in"), "file\n")?;
	let mut cmd = command(dialect, mode, script, dir.path())?;
	let out = if matches!(mode, 'c' | 's') {
		let mut child = cmd.stdin(Stdio::piped()).spawn()?;
		// The shell may be done before it reads: a closed pipe is no failure.
		let _ = child.stdin.take().expect("piped stdin").write_all(b"hi\n");
		finish(child, LIMIT)
	} else {
		let (master, slave) = pty_support::open_pty(24, 80)?;
		let ctty = mode == 'j';
		cmd.stdin(Stdio::from(slave));
		// SAFETY: `setsid` and `ioctl` are async-signal-safe.
		unsafe {
			cmd.pre_exec(move || {
				if libc::setsid() == -1 || (ctty && libc::ioctl(0, libc::TIOCSCTTY, 0) == -1) {
					return Err(io::Error::last_os_error());
				}
				Ok(())
			});
		}
		let child = cmd.spawn()?;
		// A typed line, then end of file. The terminal stays open until the
		// shell is done: closing it would hang its session up.
		let mut master = fs::File::from(master);
		master.write_all(b"hi\n\x04")?;
		let out = finish(child, LIMIT);
		drop(master);
		out
	};
	Ok((out.status.code(), clean(&out.stdout)))
}

/// A row that reads Linux's `/proc` or names its terminals (`/dev/pts`).
fn linux_only(&(_, _, script, _, stdout): &Row) -> bool {
	script.contains("/proc/") || stdout.contains("/dev/pts/")
}

/// The row's failure, if it has one.
fn differs(dialect: &str, &(id, mode, script, status, stdout): &Row) -> Option<String> {
	// `finish` panics on a process past the obash tests' bound: the row
	// hung, and is reported with the others.
	let got = std::panic::catch_unwind(|| run(dialect, mode, script));
	let got = match got {
		Ok(Ok(got)) => got,
		Ok(Err(err)) => return Some(format!("{id} ({mode}): `{script}`: {err}")),
		Err(_) => return Some(format!("{id} ({mode}): `{script}`: no end within the bound")),
	};
	(got != (Some(status), stdout.to_owned())).then(|| {
		format!(
			"{id} ({mode}): `{script}`\n  want: {status} {stdout:?}\n  got:  {:?} {:?}",
			got.0, got.1
		)
	})
}

/// Runs `rows` of `dialect` a few at once and asserts each is the real
/// shell's, reporting every row that is not. Off Linux, the Linux-only rows
/// are left out ([`linux_only`]).
fn check(dialect: &str, rows: &[Row]) {
	let rows: Vec<&Row> = rows
		.iter()
		.filter(|r| cfg!(target_os = "linux") || !linux_only(r))
		.collect();
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		// Every worker starts before the first is joined.
		let mut workers = Vec::with_capacity(threads);
		for chunk in rows.chunks(rows.len().div_ceil(threads).max(1)) {
			workers.push(scope.spawn(move || {
				chunk
					.iter()
					.filter_map(|r| differs(dialect, r))
					.collect::<Vec<_>>()
			}));
		}
		let mut failures = Vec::new();
		for worker in workers {
			failures.extend(worker.join().unwrap());
		}
		failures
	});
	assert!(
		failures.is_empty(),
		"{} of {} rows differ:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// A bash job reads what bash gives it: `/dev/null`, its own redirection,
/// its pipeline's input, or the stdin a compound command, subshell, stage
/// or coprocess around it redirected.
#[test]
fn a_bash_job_reads_the_stdin_bash_gives_it() {
	check("bash", BASH);
}

/// A zsh job keeps the shell's stdin unless it is a terminal and job
/// control is off.
#[test]
fn a_zsh_job_reads_the_stdin_zsh_gives_it() {
	check("zsh", ZSH);
}

/// A stated difference from zsh 5.9: zsh's `<( … )` without MONITOR reads
/// `/dev/null` in place of a terminal on fd 0 (`entersubsh` with
/// `ESUB_ASYNC`); pi-shell's keeps the terminal, as at 9058ab9d. zsh mode on
/// a terminal is outside this change.
#[cfg(target_os = "linux")]
#[test]
fn a_zsh_process_substitution_keeps_a_terminal() {
	let script = "cat <(readlink /proc/self/fd/0)";
	assert_eq!(
		run("zsh", 't', script).unwrap(),
		(Some(0), "/dev/pts/N\n".to_owned()),
		"zsh 5.9: /dev/null"
	);
}

/// The omp bash tool's session (bash, stdin `/dev/null`, no job control):
/// a job's program gets `/dev/null` as bash gives it, not an empty pipe,
/// and a job reading the shell's stdin gets its end of file.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_tool_commands_job_reads_dev_null() {
	let (tx, rx) = flume::unbounded::<String>();
	let script = "readlink /proc/self/fd/0 & wait; cat <&0 & wait; echo end";
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command: script.to_owned(), ..Default::default() },
			Some(tx),
			CancelToken::new(Some(20_000)),
		)
		.await
		.expect("run");
	let output: String = rx.drain().collect();
	assert_eq!((result.exit_code, output.as_str()), (Some(0), "/dev/null\nend\n"));
}
