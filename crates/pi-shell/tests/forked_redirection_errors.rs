//! Older differences from bash in a redirection's failure, each row as bash
//! 5.2.21 and 5.3.20 both run it (`bash -c` and `bash ./s.sh`), or as 5.3.20
//! runs it where 5.2.21 differs ([`ROWS53`]):
//!
//! - (h) A fatal expansion error (`${x:?}`, `set -u`, `$((1/0))`) in the
//!   redirections of a command bash runs in a fork of its own (an external, a
//!   name not found, `command X`, a null command that redirects fd 0 or a
//!   `{var}`) ends that fork, not the shell: the command fails with 127 under
//!   `-c` or 1 from a script, and the shell goes on. An asynchronous simple
//!   command's or a pipeline stage's fatal error, and one in the own
//!   redirections of an asynchronous compound command or a compound stage,
//!   lands where its parent's would: 127 under `-c`, and no `!` after it runs;
//!   an arithmetic error or a bad substitution in its redirections ends that
//!   fork with 1, also before a `!`. The fork's message goes where the
//!   command's redirections so far sent it (`2>/dev/null` hides it), also when
//!   that stream is full for a while. A subshell, a command substitution and
//!   the body of a compound job catch their own (status 1), and a `!` before
//!   such a job leaves that status as it is: bash does not invert a background
//!   job's status. A bash job that times a compound with redirections of its
//!   own (`time { :; } 2>/dev/null < ${x:?} &`) is that compound's fork too:
//!   bash makes them in the job's fork before it times the compound
//!   (`execute_in_subshell`), so a fatal error in them gives that status and
//!   message, and no time report; a timed simple command's is caught there
//!   (status 1). A fatal error in the redirections of a program or a `( … )`
//!   that a function run by an asynchronous command or a pipeline stage makes
//!   in a fork of its own lands where that function's would (`f() { /bin/cat <
//!   ${x:?u}; }; f &`).
//! - An asynchronous or piped null command bash forks for (fd 0 or a `{var}`)
//!   exits 0 whatever its redirections do: bash forks it again, and the job's
//!   fork exits at once.
//! - (g) A duplication whose source is not open names, as bash's
//!   `redirection_error` does, the number of a literal source (`<&07` is `7`),
//!   the word of an expanded one copied onto the operator's own fd (`<&$fd`),
//!   else the fd it sets (`3<&$fd` is `3`, a move `<&$fd-` is `0`); and a move
//!   the shell will undo, or a `{var}` copy, first prints `redirection error:
//!   cannot duplicate fd: Bad file descriptor`.
//! - A builtin run as the command of a fork (an async command, a pipeline
//!   stage) gets a catcher of its own once its redirections are made (bash's
//!   `execute_subshell_builtin_or_function`): a fatal error it meets exits 1
//!   (`eval 'echo ${x:?u}' &`); a function gets none (127 under `-c`).
//! - A `( … )`'s own redirections are made in its fork: a fatal error in them
//!   fails the subshell (127 under `-c`, else 1), and the shell goes on.
//! - A command bash forks for before its redirections, and a `( … )`, leave no
//!   `{var}` fd and no `{var}` value in the shell, whether those redirections
//!   fail (a temporary assignment to the variable included) or the command runs
//!   (it gets them itself); and the name of the command is still looked up (and
//!   hashed) in the shell. A builtin, a function, a `{ }` and `exec` keep
//!   theirs.
//! - An async `&&` or `||` list is bash's subshell (`CMD_FORCE_SUBSHELL`): a
//!   fatal error anywhere in it exits 1, under `-c` too; a lone async command
//!   is still the command's own fork (127 under `-c`).
//!
//! Each row runs in a fresh directory holding `in` ("hello") and a FIFO
//! `fifo`, its program named `bash` (as bash names itself in messages).
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _, path::Path};

use bstr::BStr;
use obash_support::{obash, output};
use pi_shell::{
	bash::{Budget, Script, store::Key},
	testkit::{
		FakeHost, Fault, MemFs, Outcome, Rig,
		fault::{comparable, skeleton_init},
		run::{Stop, advance, advance_or_blocked, wait_runnable},
		run_script,
	},
};

/// Each row: id, run from a script file (else `-c`), script, status,
/// stdout, stderr (the row's directory written `DIR`).
const ROWS: &[(&str, bool, &str, i32, &str, &str)] = &[
	// 484 rows; bash 5.2.21 and 5.3.20 differ on (left out): h-in-fn/c,
	// h-bg-fn/c, h-null/c, g-null-move/c, g-null-move/script, g-assign-move/c,
	// g-assign-move/script, x-fn/c, x-null-var/c, r2-bg-fn-eval/c,
	// r2-sub-redir-fn/c, r2-var-local/c, g-fn-group-move-bg/c,
	// g-fn-close-move-bg/c, l-not-bg-fn-fatal/c, o-bg-fn-ext/c,
	// o-pipe-fn-ext/c, o-bg-fn-subshell/c
	("h-ext", false, "/bin/cat < ${x:?u}; echo \"s=$?\"", 0, "s=127\n", "bash: line 1: x: u\n"),
	("h-ext", true, "/bin/cat < ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "./s.sh: line 1: x: u\n"),
	("h-notfound", false, "nosuch < ${x:?u}; echo \"s=$?\"", 0, "s=127\n", "bash: line 1: x: u\n"),
	("h-notfound", true, "nosuch < ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "./s.sh: line 1: x: u\n"),
	(
		"h-assign",
		false,
		"x=1 /bin/cat < ${y:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: y: u\n",
	),
	(
		"h-assign",
		true,
		"x=1 /bin/cat < ${y:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: y: u\n",
	),
	(
		"h-command",
		false,
		"command /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-command",
		true,
		"command /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-in-fn",
		true,
		"f() { /bin/cat < ${x:?u}; }; f; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-in-group",
		false,
		"{ /bin/cat < ${x:?u}; echo \"g=$?\"; }; echo \"s=$?\"",
		0,
		"g=127\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-in-group",
		true,
		"{ /bin/cat < ${x:?u}; echo \"g=$?\"; }; echo \"s=$?\"",
		0,
		"g=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-arith",
		false,
		"/bin/cat < $((1/0)); echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"h-arith",
		true,
		"/bin/cat < $((1/0)); echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"h-unbound",
		false,
		"set -u; /bin/cat < $nosuch; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: nosuch: unbound variable\n",
	),
	(
		"h-unbound",
		true,
		"set -u; /bin/cat < $nosuch; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: nosuch: unbound variable\n",
	),
	(
		"h-second",
		false,
		"/bin/cat < in > ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-second",
		true,
		"/bin/cat < in > ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	("h-stderr", false, "/bin/cat 2>/dev/null < ${x:?u}; echo \"s=$?\"", 0, "s=127\n", ""),
	("h-stderr", true, "/bin/cat 2>/dev/null < ${x:?u}; echo \"s=$?\"", 0, "s=1\n", ""),
	(
		"h-subshell",
		false,
		"( /bin/cat < ${x:?u} ); echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-subshell",
		true,
		"( /bin/cat < ${x:?u} ); echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-comsub",
		false,
		"y=$(/bin/cat < ${x:?u}); echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-comsub",
		true,
		"y=$(/bin/cat < ${x:?u}); echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-pipe",
		false,
		"true | /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-pipe",
		true,
		"true | /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-ext",
		false,
		"/bin/cat < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-ext",
		true,
		"/bin/cat < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-word",
		false,
		"echo ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-word",
		true,
		"echo ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-fn",
		true,
		"f() { echo ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-group",
		false,
		"{ echo ${x:?u}; } & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-group",
		true,
		"{ echo ${x:?u}; } & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-group-redir",
		false,
		"{ echo; } < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-group-redir",
		true,
		"{ echo; } < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-subshell",
		false,
		"( echo ${x:?u} ) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-subshell",
		true,
		"( echo ${x:?u} ) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h-bg-arith",
		false,
		"echo $((1/0)) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"h-bg-arith",
		true,
		"echo $((1/0)) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	("h-builtin", false, "echo < ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("h-builtin", true, "echo < ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("h-fn-call", false, "f() { :; }; f < ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("h-fn-call", true, "f() { :; }; f < ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("h-group", false, "{ :; } < ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("h-group", true, "{ :; } < ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("h-word", false, "/bin/cat ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("h-word", true, "/bin/cat ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("h-exec", false, "exec /bin/cat < ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("h-exec", true, "exec /bin/cat < ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("h-null", true, "< ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "./s.sh: line 1: x: u\n"),
	("g-lit", false, "cat <&7; echo \"s=$?\"", 0, "s=1\n", "bash: line 1: 7: Bad file descriptor\n"),
	(
		"g-lit",
		true,
		"cat <&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-lit0",
		false,
		"cat <&07; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-lit0",
		true,
		"cat <&07; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-move",
		false,
		"cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-move",
		true,
		"cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-move0",
		false,
		"cat <&07-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-move0",
		true,
		"cat <&07-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-quoted",
		false,
		"cat <&\"7\"; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: \"7\": Bad file descriptor\n",
	),
	(
		"g-quoted",
		true,
		"cat <&\"7\"; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: \"7\": Bad file descriptor\n",
	),
	(
		"g-quoted-move",
		false,
		"cat <&\"7\"-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 0: Bad file descriptor\n",
	),
	(
		"g-quoted-move",
		true,
		"cat <&\"7\"-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 0: Bad file descriptor\n",
	),
	(
		"g-word-in",
		false,
		"fd=7; cat <&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: $fd: Bad file descriptor\n",
	),
	(
		"g-word-in",
		true,
		"fd=7; cat <&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: $fd: Bad file descriptor\n",
	),
	(
		"g-word-in3",
		false,
		"fd=7; cat 3<&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 3: Bad file descriptor\n",
	),
	(
		"g-word-in3",
		true,
		"fd=7; cat 3<&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 3: Bad file descriptor\n",
	),
	(
		"g-word-out",
		false,
		"fd=7; echo x >&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: $fd: Bad file descriptor\n",
	),
	(
		"g-word-out",
		true,
		"fd=7; echo x >&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: $fd: Bad file descriptor\n",
	),
	(
		"g-word-out2",
		false,
		"fd=7; echo x 2>&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 2: Bad file descriptor\n",
	),
	(
		"g-word-out2",
		true,
		"fd=7; echo x 2>&$fd; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 2: Bad file descriptor\n",
	),
	(
		"g-word-move",
		false,
		"fd=7; cat <&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 0: Bad file descriptor\n",
	),
	(
		"g-word-move",
		true,
		"fd=7; cat <&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 0: Bad file descriptor\n",
	),
	(
		"g-word-move3",
		false,
		"fd=7; cat 3<&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 3: Bad file descriptor\n",
	),
	(
		"g-word-move3",
		true,
		"fd=7; cat 3<&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 3: Bad file descriptor\n",
	),
	(
		"g-out-lit",
		false,
		"echo x 2>&07; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-out-lit",
		true,
		"echo x 2>&07; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-bi-move",
		false,
		"echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-bi-move",
		true,
		"echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-bi-move-out",
		false,
		"echo x >&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-bi-move-out",
		true,
		"echo x >&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-bi-word-move",
		false,
		"fd=7; echo x <&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 0: Bad \
		 file descriptor\n",
	),
	(
		"g-bi-word-move",
		true,
		"fd=7; echo x <&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 0: \
		 Bad file descriptor\n",
	),
	(
		"g-bi-word-move-out",
		false,
		"fd=7; echo x >&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 1: Bad \
		 file descriptor\n",
	),
	(
		"g-bi-word-move-out",
		true,
		"fd=7; echo x >&$fd-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 1: \
		 Bad file descriptor\n",
	),
	(
		"g-group-move",
		false,
		"{ cat; } <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-group-move",
		true,
		"{ cat; } <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-fn-move",
		false,
		"f() { cat; }; f <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-fn-move",
		true,
		"f() { cat; }; f <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-eval-move",
		false,
		"eval cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-eval-move",
		true,
		"eval cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-cmd-bi-move",
		false,
		"command echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-cmd-bi-move",
		true,
		"command echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-while-move",
		false,
		"while false; do :; done <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-while-move",
		true,
		"while false; do :; done <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-pipe-group-move",
		false,
		"{ echo x <&7-; } | cat; echo \"s=$?\"",
		0,
		"s=0\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-pipe-group-move",
		true,
		"{ echo x <&7-; } | cat; echo \"s=$?\"",
		0,
		"s=0\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-var",
		false,
		"{v}<&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-var",
		true,
		"{v}<&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-var-ext",
		false,
		"cat {v}<&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-var-ext",
		true,
		"cat {v}<&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-var-move",
		false,
		"echo x {v}<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-var-move",
		true,
		"echo x {v}<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"g-ext-move",
		false,
		"cat <&7- < in; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-ext-move",
		true,
		"cat <&7- < in; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-cmd-ext-move",
		false,
		"command cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-cmd-ext-move",
		true,
		"command cat <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-notfound-move",
		false,
		"nosuch <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-notfound-move",
		true,
		"nosuch <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-subshell-move",
		false,
		"( cat ) <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-subshell-move",
		true,
		"( cat ) <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-pipe-move",
		false,
		"echo x <&7- | cat; echo \"s=$?\"",
		0,
		"s=0\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-pipe-move",
		true,
		"echo x <&7- | cat; echo \"s=$?\"",
		0,
		"s=0\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-bg-move",
		false,
		"echo x <&7- & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-bg-move",
		true,
		"echo x <&7- & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-closed-target",
		false,
		"echo x 3<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-closed-target",
		true,
		"echo x 3<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-closed-stdin",
		false,
		"exec 0<&-; echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-closed-stdin",
		true,
		"exec 0<&-; echo x <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-exec-move",
		false,
		"exec 3<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-exec-move",
		true,
		"exec 3<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-bi-dup",
		false,
		"echo x <&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-bi-dup",
		true,
		"echo x <&7; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"x-subshell-in",
		false,
		"( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-subshell-in",
		true,
		"( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-comsub-in",
		false,
		"y=$( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"y=$y s=$?\"",
		0,
		"y=in=1 s=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-comsub-in",
		true,
		"y=$( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"y=$y s=$?\"",
		0,
		"y=in=1 s=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-procsub",
		false,
		"cat <( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-procsub",
		true,
		"cat <( /bin/cat < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	("x-not", false, "! /bin/cat < ${x:?u}; echo \"s=$?\"", 0, "s=0\n", "bash: line 1: x: u\n"),
	("x-not", true, "! /bin/cat < ${x:?u}; echo \"s=$?\"", 0, "s=0\n", "./s.sh: line 1: x: u\n"),
	(
		"x-if",
		false,
		"if /bin/cat < ${x:?u}; then echo yes; else echo \"no=$?\"; fi; echo \"s=$?\"",
		0,
		"no=127\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-if",
		true,
		"if /bin/cat < ${x:?u}; then echo yes; else echo \"no=$?\"; fi; echo \"s=$?\"",
		0,
		"no=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-time",
		false,
		"TIMEFORMAT=; time /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-time",
		true,
		"TIMEFORMAT=; time /bin/cat < ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-eval",
		false,
		"eval \"/bin/cat < \\${x:?u}\"; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-eval",
		true,
		"eval \"/bin/cat < \\${x:?u}\"; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-fn",
		true,
		"f() { /bin/cat < ${x:?u}; echo \"in=$?\"; }; f; echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-exit-trap",
		false,
		"trap '/bin/cat < ${x:?u}; echo \"in=$?\"' EXIT; echo body",
		0,
		"body\nin=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-exit-trap",
		true,
		"trap '/bin/cat < ${x:?u}; echo \"in=$?\"' EXIT; echo body",
		0,
		"body\nin=0\n",
		"./s.sh: line 1: x: u\n",
	),
	("x-null-out", false, "> ${x:?u}; echo \"s=$?\"", 127, "", "bash: line 1: x: u\n"),
	("x-null-out", true, "> ${x:?u}; echo \"s=$?\"", 1, "", "./s.sh: line 1: x: u\n"),
	("x-null-var", true, "{v}< ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "./s.sh: line 1: x: u\n"),
	("x-errexit", false, "set -e; /bin/cat < ${x:?u}; echo \"s=$?\"", 1, "", "bash: line 1: x: u\n"),
	(
		"x-errexit",
		true,
		"set -e; /bin/cat < ${x:?u}; echo \"s=$?\"",
		1,
		"",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-errexit-w",
		false,
		"set -e; w=1; /bin/cat < ${x:?u} || w=2; echo \"w=$w\"",
		0,
		"w=2\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-errexit-w",
		true,
		"set -e; w=1; /bin/cat < ${x:?u} || w=2; echo \"w=$w\"",
		0,
		"w=2\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-errexit-or",
		false,
		"set -e; /bin/cat < ${x:?u} || echo \"or=$?\"; echo after",
		0,
		"or=1\nafter\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-errexit-or",
		true,
		"set -e; /bin/cat < ${x:?u} || echo \"or=$?\"; echo after",
		0,
		"or=1\nafter\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-errexit-bg",
		false,
		"set -e; /bin/cat < ${x:?u} & wait $!; echo \"s=$?\"",
		1,
		"",
		"bash: line 1: x: u\n",
	),
	(
		"x-errexit-bg",
		true,
		"set -e; /bin/cat < ${x:?u} & wait $!; echo \"s=$?\"",
		1,
		"",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-pipe-first",
		false,
		"/bin/cat < ${x:?u} | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-pipe-first",
		true,
		"/bin/cat < ${x:?u} | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-pipe-last",
		false,
		"echo a | /bin/cat < ${x:?u}; echo \"s=${PIPESTATUS[1]}\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-pipe-last",
		true,
		"echo a | /bin/cat < ${x:?u}; echo \"s=${PIPESTATUS[1]}\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-unbound-bg",
		false,
		"set -u; /bin/cat < $nosuch & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: nosuch: unbound variable\n",
	),
	(
		"x-unbound-bg",
		true,
		"set -u; /bin/cat < $nosuch & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: nosuch: unbound variable\n",
	),
	(
		"x-arith-bg",
		false,
		"/bin/cat < $((1/0)) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"x-arith-bg",
		true,
		"/bin/cat < $((1/0)) & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"x-bg-group-in",
		false,
		"{ echo ${x:?u}; } < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-bg-group-in",
		true,
		"{ echo ${x:?u}; } < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-pipe-group-in",
		false,
		"{ echo ${x:?u}; } < in | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-pipe-group-in",
		true,
		"{ echo ${x:?u}; } < in | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"x-bg-while-in",
		false,
		"while :; do echo ${x:?u}; done < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"x-bg-while-in",
		true,
		"while :; do echo ${x:?u}; done < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-eval",
		false,
		"eval 'echo ${x:?u}' & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-eval",
		true,
		"eval 'echo ${x:?u}' & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-command-eval",
		false,
		"command eval 'echo ${x:?u}' & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-command-eval",
		true,
		"command eval 'echo ${x:?u}' & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-dot",
		false,
		"echo 'echo ${x:?u}' > f; { . ./f & wait $!; echo \"s=$?\"; } 2>/dev/null",
		0,
		"s=1\n",
		"",
	),
	(
		"r2-bg-dot",
		true,
		"echo 'echo ${x:?u}' > f; { . ./f & wait $!; echo \"s=$?\"; } 2>/dev/null",
		0,
		"s=1\n",
		"",
	),
	(
		"r2-bg-mapfile",
		false,
		"mapfile -c 1 -C 'echo ${x:?u}' a < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-mapfile",
		true,
		"mapfile -c 1 -C 'echo ${x:?u}' a < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-eval-inner",
		false,
		"eval '/bin/cat < ${x:?u}; echo \"in=$?\"' & wait $!; echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-eval-inner",
		true,
		"eval '/bin/cat < ${x:?u}; echo \"in=$?\"' & wait $!; echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-pipe-eval",
		false,
		"eval 'echo ${x:?u}' | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-pipe-eval",
		true,
		"eval 'echo ${x:?u}' | cat; echo \"s=${PIPESTATUS[0]}\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-pipe-eval-last",
		false,
		"echo a | eval 'echo ${x:?u}'; echo \"s=${PIPESTATUS[1]}\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-pipe-eval-last",
		true,
		"echo a | eval 'echo ${x:?u}'; echo \"s=${PIPESTATUS[1]}\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-eval-word",
		false,
		"eval ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-eval-word",
		true,
		"eval ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-builtin-redir",
		false,
		"echo < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-builtin-redir",
		true,
		"echo < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-eval-redir",
		false,
		"eval 'echo b' < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-eval-redir",
		true,
		"eval 'echo b' < ${x:?u} & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-fn-eval",
		true,
		"f() { eval 'echo ${x:?u}'; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-bg-eval-in",
		false,
		"eval 'echo ${x:?u}' < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-bg-eval-in",
		true,
		"eval 'echo ${x:?u}' < in & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir",
		false,
		"( echo g ) < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-sub-redir",
		true,
		"( echo g ) < ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir-or",
		false,
		"( echo g ) < ${x:?u} || echo \"or=$?\"; echo \"s=$?\"",
		0,
		"or=127\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-sub-redir-or",
		true,
		"( echo g ) < ${x:?u} || echo \"or=$?\"; echo \"s=$?\"",
		0,
		"or=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir-fn",
		true,
		"f() { ( echo g ) < ${x:?u}; echo \"in=$?\"; }; f; echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir-quiet",
		false,
		"( echo g ) 2>/dev/null < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"",
	),
	("r2-sub-redir-quiet", true, "( echo g ) 2>/dev/null < ${x:?u}; echo \"s=$?\"", 0, "s=1\n", ""),
	(
		"r2-sub-redir-e",
		false,
		"set -e; ( echo g ) < ${x:?u}; echo \"s=$?\"",
		1,
		"",
		"bash: line 1: x: u\n",
	),
	(
		"r2-sub-redir-e",
		true,
		"set -e; ( echo g ) < ${x:?u}; echo \"s=$?\"",
		1,
		"",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir-nested",
		false,
		"( ( echo g ) < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-sub-redir-nested",
		true,
		"( ( echo g ) < ${x:?u}; echo \"in=$?\" ); echo \"s=$?\"",
		0,
		"in=1\ns=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-sub-redir-arith",
		false,
		"( echo g ) < $((1/0)); echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r2-sub-redir-arith",
		true,
		"( echo g ) < $((1/0)); echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r2-sub-redir-unset",
		false,
		"set -u; ( echo g ) < $nosuch; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: nosuch: unbound variable\n",
	),
	(
		"r2-sub-redir-unset",
		true,
		"set -u; ( echo g ) < $nosuch; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: nosuch: unbound variable\n",
	),
	(
		"r2-var-fatal",
		false,
		"/bin/cat {v}<in < ${x:?u}; echo \"v=$v\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=\ns=1\n",
		"bash: line 1: x: u\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r2-var-fatal",
		true,
		"/bin/cat {v}<in < ${x:?u}; echo \"v=$v\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=\ns=1\n",
		"./s.sh: line 1: x: u\n./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r2-var-fail",
		false,
		"/bin/cat {v}<in < nonexist; echo \"v=$v\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=\ns=1\n",
		"bash: line 1: nonexist: No such file or directory\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r2-var-fail",
		true,
		"/bin/cat {v}<in < nonexist; echo \"v=$v\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=\ns=1\n",
		"./s.sh: line 1: nonexist: No such file or directory\n./s.sh: line 1: 10: Bad file \
		 descriptor\n",
	),
	(
		"r2-var-kept",
		false,
		"v=x; /bin/cat {v}<in < ${x:?u}; echo \"v=$v\"",
		0,
		"v=x\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-var-kept",
		true,
		"v=x; /bin/cat {v}<in < ${x:?u}; echo \"v=$v\"",
		0,
		"v=x\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-var-local",
		true,
		"f() { local v=y; /bin/cat {v}<in < nonexist; echo \"v=$v\"; }; f; echo \"v=${v-unset}\"",
		0,
		"v=y\nv=unset\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-var-null-fail",
		false,
		"{v}<in < nonexist; echo \"v=${v-unset}\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=unset\ns=1\n",
		"bash: line 1: nonexist: No such file or directory\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r2-var-null-fail",
		true,
		"{v}<in < nonexist; echo \"v=${v-unset}\"; /bin/cat <&10; echo \"s=$?\"",
		0,
		"v=unset\ns=1\n",
		"./s.sh: line 1: nonexist: No such file or directory\n./s.sh: line 1: 10: Bad file \
		 descriptor\n",
	),
	(
		"r2-var-array",
		false,
		"a=(p q); /bin/cat {a[1]}<in < nonexist; echo \"a=${a[*]}\"",
		0,
		"a=p q\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-var-array",
		true,
		"a=(p q); /bin/cat {a[1]}<in < nonexist; echo \"a=${a[*]}\"",
		0,
		"a=p q\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-var-builtin",
		false,
		"echo {v}<in < nonexist; echo \"v=$v\"",
		0,
		"v=10\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-var-builtin",
		true,
		"echo {v}<in < nonexist; echo \"v=$v\"",
		0,
		"v=10\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-hash-fatal",
		false,
		"cat < ${x:?u}; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-hash-fatal",
		true,
		"cat < ${x:?u}; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r2-hash-fail",
		false,
		"cat < nonexist; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-hash-fail",
		true,
		"cat < nonexist; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-hash-notfound",
		false,
		"nosuch < nonexist; hash; echo \"s=$?\"",
		0,
		"hash: hash table empty\ns=0\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-hash-notfound",
		true,
		"nosuch < nonexist; hash; echo \"s=$?\"",
		0,
		"hash: hash table empty\ns=0\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r2-hash-twice",
		false,
		"cat < nonexist; cat < nonexist; hash",
		0,
		"hits	command\n   2	/usr/bin/cat\n",
		"bash: line 1: nonexist: No such file or directory\nbash: line 1: nonexist: No such file or \
		 directory\n",
	),
	(
		"r2-hash-twice",
		true,
		"cat < nonexist; cat < nonexist; hash",
		0,
		"hits	command\n   2	/usr/bin/cat\n",
		"./s.sh: line 1: nonexist: No such file or directory\n./s.sh: line 1: nonexist: No such \
		 file or directory\n",
	),
	(
		"g-fn-group-move-bg",
		true,
		"f() { { :; } <&7-; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"r2-subshell-depth",
		false,
		"( echo \"a=$BASH_SUBSHELL\" ); echo \"b=$BASH_SUBSHELL\" & wait; echo x | { echo \
		 \"c=$BASH_SUBSHELL\"; cat > /dev/null; }; ( ( echo \"d=$BASH_SUBSHELL\" ) )",
		0,
		"a=1\nb=1\nc=1\nd=2\n",
		"",
	),
	(
		"r2-subshell-depth",
		true,
		"( echo \"a=$BASH_SUBSHELL\" ); echo \"b=$BASH_SUBSHELL\" & wait; echo x | { echo \
		 \"c=$BASH_SUBSHELL\"; cat > /dev/null; }; ( ( echo \"d=$BASH_SUBSHELL\" ) )",
		0,
		"a=1\nb=1\nc=1\nd=2\n",
		"",
	),
	(
		"r3-and-first",
		false,
		"echo ${x:?u} && echo b & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-and-first",
		true,
		"echo ${x:?u} && echo b & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-and-second",
		false,
		"/bin/true && echo ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-and-second",
		true,
		"/bin/true && echo ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-or-first",
		false,
		"echo ${x:?u} || echo b & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-or-first",
		true,
		"echo ${x:?u} || echo b & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-or-ext-redir",
		false,
		"/bin/cat < ${x:?u} || echo \"rc=$?\" & wait $!; echo \"st=$?\"",
		0,
		"rc=1\nst=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-or-ext-redir",
		true,
		"/bin/cat < ${x:?u} || echo \"rc=$?\" & wait $!; echo \"st=$?\"",
		0,
		"rc=1\nst=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-or-sub-redir",
		false,
		"( echo g ) < ${x:?u} || echo b & wait $!; echo \"st=$?\"",
		0,
		"b\nst=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-or-sub-redir",
		true,
		"( echo g ) < ${x:?u} || echo b & wait $!; echo \"st=$?\"",
		0,
		"b\nst=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-and-group-move",
		false,
		"/bin/true && { :; } <&7- & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"r3-and-group-move",
		true,
		"/bin/true && { :; } <&7- & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"r3-lone-ext-redir",
		false,
		"/bin/cat < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-lone-ext-redir",
		true,
		"/bin/cat < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-and-ext-fail",
		false,
		"/bin/true && /bin/cat < nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r3-and-ext-fail",
		true,
		"/bin/true && /bin/cat < nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r3-sub-var-fatal",
		false,
		"( : ) {v}<in < ${x:?u}; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: x: u\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r3-sub-var-fatal",
		true,
		"( : ) {v}<in < ${x:?u}; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: x: u\n./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r3-sub-var-fail",
		false,
		"( : ) {v}<in < nonexist; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: nonexist: No such file or directory\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r3-sub-var-fail",
		true,
		"( : ) {v}<in < nonexist; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: nonexist: No such file or directory\n./s.sh: line 1: 10: Bad file \
		 descriptor\n",
	),
	(
		"r3-sub-var-kept",
		false,
		"v=1; ( : ) {v}<in < nonexist; echo \"v=[$v]\"",
		0,
		"v=[1]\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r3-sub-var-kept",
		true,
		"v=1; ( : ) {v}<in < nonexist; echo \"v=[$v]\"",
		0,
		"v=[1]\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r3-assign-var-fail",
		false,
		"v=1 /bin/cat {v}<in < nonexist; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: nonexist: No such file or directory\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r3-assign-var-fail",
		true,
		"v=1 /bin/cat {v}<in < nonexist; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: nonexist: No such file or directory\n./s.sh: line 1: 10: Bad file \
		 descriptor\n",
	),
	(
		"r3-assign-var-fatal",
		false,
		"v=1 /bin/cat {v}<in < ${x:?u}; echo \"v=[$v]\"",
		0,
		"v=[]\n",
		"bash: line 1: x: u\n",
	),
	(
		"r3-assign-var-fatal",
		true,
		"v=1 /bin/cat {v}<in < ${x:?u}; echo \"v=[$v]\"",
		0,
		"v=[]\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r3-assign-var-old",
		false,
		"v=old; v=1 /bin/cat {v}<in < nonexist; echo \"v=[$v]\"",
		0,
		"v=[old]\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r3-assign-var-old",
		true,
		"v=old; v=1 /bin/cat {v}<in < nonexist; echo \"v=[$v]\"",
		0,
		"v=[old]\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-not-ext-fatal",
		false,
		"! /bin/cat < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-not-ext-fatal",
		true,
		"! /bin/cat < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-not-echo-fatal",
		false,
		"! echo ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-not-echo-fatal",
		true,
		"! echo ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-not-sub-fatal",
		false,
		"! ( : ) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-not-sub-fatal",
		true,
		"! ( : ) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-not-ext-fatal-fg",
		false,
		"! /bin/cat < ${x:?u}; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-not-ext-fatal-fg",
		true,
		"! /bin/cat < ${x:?u}; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-ext-var",
		false,
		"/bin/true {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-ext-var",
		true,
		"/bin/true {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-sub-var",
		false,
		"( : ) {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-sub-var",
		true,
		"( : ) {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-sub-var-two",
		false,
		"( : ) {v}<in < ${x:?u}; ( : ) {w}<in; echo \"v=[$v] w=[$w]\"; read -r l <&10 && echo open",
		1,
		"v=[] w=[]\n",
		"bash: line 1: x: u\nbash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-sub-var-two",
		true,
		"( : ) {v}<in < ${x:?u}; ( : ) {w}<in; echo \"v=[$v] w=[$w]\"; read -r l <&10 && echo open",
		1,
		"v=[] w=[]\n",
		"./s.sh: line 1: x: u\n./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-sub-var-inside",
		false,
		"printf 'x\\n' > in; ( echo \"in=[$v]\"; read -r l <&$v; echo \"l=$l\" ) {v}<in; echo \
		 \"out=[$v]\"",
		0,
		"in=[10]\nl=x\nout=[]\n",
		"",
	),
	(
		"r4-sub-var-inside",
		true,
		"printf 'x\\n' > in; ( echo \"in=[$v]\"; read -r l <&$v; echo \"l=$l\" ) {v}<in; echo \
		 \"out=[$v]\"",
		0,
		"in=[10]\nl=x\nout=[]\n",
		"",
	),
	(
		"r4-ext-var-inside",
		false,
		"printf 'x\\n' > in; /bin/bash -c 'read -r l <&10; echo \"l=$l\"' {v}<in; echo \"out=[$v]\"",
		0,
		"l=x\nout=[]\n",
		"",
	),
	(
		"r4-ext-var-inside",
		true,
		"printf 'x\\n' > in; /bin/bash -c 'read -r l <&10; echo \"l=$l\"' {v}<in; echo \"out=[$v]\"",
		0,
		"l=x\nout=[]\n",
		"",
	),
	("r4-ext-var-used", false, "/bin/cat {v}<in <&$v; echo \"v=[$v]\"", 0, "hello\nv=[]\n", ""),
	("r4-ext-var-used", true, "/bin/cat {v}<in <&$v; echo \"v=[$v]\"", 0, "hello\nv=[]\n", ""),
	("r4-ext-var-kept", false, "v=old; /bin/true {v}<in; echo \"v=[$v]\"", 0, "v=[old]\n", ""),
	("r4-ext-var-kept", true, "v=old; /bin/true {v}<in; echo \"v=[$v]\"", 0, "v=[old]\n", ""),
	("r4-ext-var-assign", false, "v=1 /bin/true {v}<in; echo \"v=[$v]\"", 0, "v=[]\n", ""),
	("r4-ext-var-assign", true, "v=1 /bin/true {v}<in; echo \"v=[$v]\"", 0, "v=[]\n", ""),
	(
		"r4-ext-var-assign-old",
		false,
		"v=old; v=1 /bin/true {v}<in; echo \"v=[$v]\"",
		0,
		"v=[old]\n",
		"",
	),
	(
		"r4-ext-var-assign-old",
		true,
		"v=old; v=1 /bin/true {v}<in; echo \"v=[$v]\"",
		0,
		"v=[old]\n",
		"",
	),
	(
		"r4-notfound-var",
		false,
		"nosuch {v}<in 2>/dev/null; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-notfound-var",
		true,
		"nosuch {v}<in 2>/dev/null; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-command-ext-var",
		false,
		"command /bin/true {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"bash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-command-ext-var",
		true,
		"command /bin/true {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		1,
		"v=[]\n",
		"./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-null-var",
		false,
		"{v}<in; echo \"v=[${v-unset}]\"; read -r l <&10 && echo open",
		1,
		"v=[unset]\n",
		"bash: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-null-var",
		true,
		"{v}<in; echo \"v=[${v-unset}]\"; read -r l <&10 && echo open",
		1,
		"v=[unset]\n",
		"./s.sh: line 1: 10: Bad file descriptor\n",
	),
	(
		"r4-group-var",
		false,
		"{ :; } {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-group-var",
		true,
		"{ :; } {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-builtin-var",
		false,
		": {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-builtin-var",
		true,
		": {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-exec-var",
		false,
		"exec {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-exec-var",
		true,
		"exec {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-fn-var",
		false,
		"f() { :; }; f {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-fn-var",
		true,
		"f() { :; }; f {v}<in; echo \"v=[$v]\"; read -r l <&10 && echo open",
		0,
		"v=[10]\nopen\n",
		"",
	),
	(
		"r4-path-var-fail",
		false,
		"{PATH}</dev/null cat < nonexist; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-path-var-fail",
		true,
		"{PATH}</dev/null cat < nonexist; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-path-var-fatal",
		false,
		"{PATH}</dev/null cat < ${x:?u}; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-path-var-fatal",
		true,
		"{PATH}</dev/null cat < ${x:?u}; hash",
		0,
		"hits	command\n   1	/usr/bin/cat\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-var-errexit",
		false,
		"set -e; /bin/true {v}<in; echo \"v=[$v]\"; /bin/false {w}<in; echo not",
		1,
		"v=[]\n",
		"",
	),
	(
		"r4-var-errexit",
		true,
		"set -e; /bin/true {v}<in; echo \"v=[$v]\"; /bin/false {w}<in; echo not",
		1,
		"v=[]\n",
		"",
	),
	(
		"r4-var-err-trap",
		false,
		"trap 'echo \"err=$? v=[$v]\"' ERR; /bin/false {v}<in; echo \"st=$? v=[$v]\"",
		0,
		"err=1 v=[]\nst=1 v=[]\n",
		"",
	),
	(
		"r4-var-err-trap",
		true,
		"trap 'echo \"err=$? v=[$v]\"' ERR; /bin/false {v}<in; echo \"st=$? v=[$v]\"",
		0,
		"err=1 v=[]\nst=1 v=[]\n",
		"",
	),
	(
		"r4-var-err-trap-e",
		false,
		"set -e; trap 'echo \"err=$? v=[$v]\"' ERR; /bin/false {v}<in; echo not",
		1,
		"err=1 v=[]\n",
		"",
	),
	(
		"r4-var-err-trap-e",
		true,
		"set -e; trap 'echo \"err=$? v=[$v]\"' ERR; /bin/false {v}<in; echo not",
		1,
		"err=1 v=[]\n",
		"",
	),
	(
		"r4-null-async-fatal",
		false,
		"< ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-null-async-fatal",
		true,
		"< ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-null-async-fail",
		false,
		"< nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-async-fail",
		true,
		"< nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-var-async-fail",
		false,
		"{v}<nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-var-async-fail",
		true,
		"{v}<nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-pipe-fail",
		false,
		"< nonexist | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=0\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-pipe-fail",
		true,
		"< nonexist | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=0\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-null-pipe-fatal",
		false,
		"< ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-null-pipe-fatal",
		true,
		"< ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-not-null-fatal",
		false,
		"! < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-not-null-fatal",
		true,
		"! < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	("r4-not-null-ok", false, "! < in & wait $!; echo \"st=$?\"", 0, "st=0\n", ""),
	("r4-not-null-ok", true, "! < in & wait $!; echo \"st=$?\"", 0, "st=0\n", ""),
	("r4-not-null-var-ok", false, "! {v}<in & wait $!; echo \"st=$?\"", 0, "st=0\n", ""),
	("r4-not-null-var-ok", true, "! {v}<in & wait $!; echo \"st=$?\"", 0, "st=0\n", ""),
	(
		"r4-null-async-out-fatal",
		false,
		"> ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r4-null-async-out-fatal",
		true,
		"> ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r4-null-async-out-fail",
		false,
		"> /nonexist/x & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: /nonexist/x: No such file or directory\n",
	),
	(
		"r4-null-async-out-fail",
		true,
		"> /nonexist/x & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: /nonexist/x: No such file or directory\n",
	),
	(
		"r4-group-null-async",
		false,
		"{ < nonexist; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"r4-group-null-async",
		true,
		"{ < nonexist; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"g-fn-close-move-bg",
		true,
		"f() { echo x <&7-; }; f & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: redirection error: cannot duplicate fd: Bad file descriptor\n./s.sh: line 1: 7: \
		 Bad file descriptor\n",
	),
	(
		"r5-bg-stderr",
		false,
		"/bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r5-bg-stderr",
		true,
		"/bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-pipe-stderr",
		false,
		"/bin/cat 2>/dev/null < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r5-pipe-stderr",
		true,
		"/bin/cat 2>/dev/null < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-closed-stderr",
		false,
		"/bin/cat 2>&- < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r5-bg-closed-stderr",
		true,
		"/bin/cat 2>&- < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-err-file",
		false,
		"/bin/cat 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=127\nbash: line 1: x: u\n",
		"",
	),
	(
		"r5-bg-err-file",
		true,
		"/bin/cat 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=1\n./s.sh: line 1: x: u\n",
		"",
	),
	(
		"r5-not-bg-stderr",
		false,
		"! /bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r5-not-bg-stderr",
		true,
		"! /bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-builtin-dup",
		false,
		"echo 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"r5-bg-builtin-dup",
		true,
		"echo 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"r5-bg-arith-stderr",
		false,
		"/bin/cat 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-arith-stderr",
		true,
		"/bin/cat 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-arith-err-file",
		false,
		"/bin/cat 2>err < $((1/0)) & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=1\nbash: line 1: 1/0: division by 0 (error token is \"0\")\n",
		"",
	),
	(
		"r5-bg-arith-err-file",
		true,
		"/bin/cat 2>err < $((1/0)) & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=1\n./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
		"",
	),
	(
		"r5-not-bg-arith",
		false,
		"! /bin/cat < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-arith",
		true,
		"! /bin/cat < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-notfound-arith",
		false,
		"! nosuch < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-notfound-arith",
		true,
		"! nosuch < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-command-arith",
		false,
		"! command /bin/cat < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-command-arith",
		true,
		"! command /bin/cat < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-badsub",
		false,
		"! /bin/cat < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: ${x!y}: bad substitution\n",
	),
	(
		"r5-not-bg-badsub",
		true,
		"! /bin/cat < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: ${x!y}: bad substitution\n",
	),
	(
		"r5-bg-badsub",
		false,
		"/bin/cat < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: ${x!y}: bad substitution\n",
	),
	(
		"r5-bg-badsub",
		true,
		"/bin/cat < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: ${x!y}: bad substitution\n",
	),
	(
		"r5-not-bg-builtin-arith",
		false,
		"! echo < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-builtin-arith",
		true,
		"! echo < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-fn-arith",
		false,
		"f() { :; }; ! f < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-fn-arith",
		true,
		"f() { :; }; ! f < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-pipe-arith",
		false,
		"! /bin/cat < $((1/0)) | cat; echo \"st=$? ps=${PIPESTATUS[*]}\"",
		0,
		"st=1 ps=1 0\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-pipe-arith",
		true,
		"! /bin/cat < $((1/0)) | cat; echo \"st=$? ps=${PIPESTATUS[*]}\"",
		0,
		"st=1 ps=1 0\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-bg-sub-word",
		false,
		"/bin/cat \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-bg-sub-word",
		true,
		"/bin/cat \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r5-not-bg-sub-word",
		false,
		"! /bin/cat \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-not-bg-sub-word",
		true,
		"! /bin/cat \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r5-bg-sub-word-stderr",
		false,
		"/bin/cat \"$(true)\" 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r5-bg-sub-word-stderr",
		true,
		"/bin/cat \"$(true)\" 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r5-bg-sub-echo",
		false,
		"echo \"$(true)\" ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-bg-sub-echo",
		true,
		"echo \"$(true)\" ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r5-pipe-sub-word",
		false,
		"true | /bin/cat \"$(true)\" < ${x:?u}; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-pipe-sub-word",
		true,
		"true | /bin/cat \"$(true)\" < ${x:?u}; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r5-bg-procsub-word",
		false,
		"/bin/cat <(true) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-bg-procsub-word",
		true,
		"/bin/cat <(true) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r5-not-bg-sub-arith",
		false,
		"! /bin/cat \"`true`\" < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-not-bg-sub-arith",
		true,
		"! /bin/cat \"`true`\" < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"r5-bg-group-sub",
		false,
		"{ /bin/cat \"$(true)\" < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"r5-bg-group-sub",
		true,
		"{ /bin/cat \"$(true)\" < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r6-bg-two-sub-words",
		false,
		"/bin/cat \"$(true)\" \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r6-bg-two-sub-words",
		true,
		"/bin/cat \"$(true)\" \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r6-not-bg-two-sub-words",
		false,
		"! /bin/cat \"$(true)\" \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r6-not-bg-two-sub-words",
		true,
		"! /bin/cat \"$(true)\" \"$(true)\" < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r6-bg-sub-procsub-words",
		false,
		"/bin/cat \"$(true)\" <(true) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r6-bg-sub-procsub-words",
		true,
		"/bin/cat \"$(true)\" <(true) < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"r6-bg-group-stderr",
		false,
		"{ /bin/cat; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-group-stderr",
		true,
		"{ /bin/cat; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-subshell-stderr",
		false,
		"( /bin/cat ) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-subshell-stderr",
		true,
		"( /bin/cat ) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-dup",
		false,
		"{ :; } 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"r6-bg-group-dup",
		true,
		"{ :; } 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"r6-bg-group-err-file",
		false,
		"{ :; } 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=127\nbash: line 1: x: u\n",
		"",
	),
	(
		"r6-bg-group-err-file",
		true,
		"{ :; } 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=1\n./s.sh: line 1: x: u\n",
		"",
	),
	(
		"r6-bg-while-stderr",
		false,
		"while :; do break; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-while-stderr",
		true,
		"while :; do break; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-arith-stderr",
		false,
		"{ :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-arith-stderr",
		true,
		"{ :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-pipe-group-stderr",
		false,
		"{ /bin/cat; } 2>/dev/null < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-pipe-group-stderr",
		true,
		"{ /bin/cat; } 2>/dev/null < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-not-bg-group-stderr",
		false,
		"! { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-not-bg-group-stderr",
		true,
		"! { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-not-bg-group-arith",
		false,
		"! { :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-not-bg-group-arith",
		true,
		"! { :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-badsub-stderr",
		false,
		"{ :; } 2>/dev/null < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-badsub-stderr",
		true,
		"{ :; } 2>/dev/null < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-closed-stderr",
		false,
		"{ :; } 2>&- < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-group-closed-stderr",
		true,
		"{ :; } 2>&- < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-subshell-dup",
		false,
		"( : ) 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"r6-bg-subshell-dup",
		true,
		"( : ) 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"r6-bg-if-stderr",
		false,
		"if :; then :; fi 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-if-stderr",
		true,
		"if :; then :; fi 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-for-stderr",
		false,
		"for i in 1; do :; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-for-stderr",
		true,
		"for i in 1; do :; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-case-stderr",
		false,
		"case x in x) :;; esac 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-case-stderr",
		true,
		"case x in x) :;; esac 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-until-dup",
		false,
		"until :; do :; done 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"r6-bg-until-dup",
		true,
		"until :; do :; done 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"r6-bg-arith-cmd-stderr",
		false,
		"(( 1 )) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-arith-cmd-stderr",
		true,
		"(( 1 )) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-cond-stderr",
		false,
		"[[ -n x ]] 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-cond-stderr",
		true,
		"[[ -n x ]] 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-setu",
		false,
		"set -u; { :; } 2>/dev/null < $nosuch & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-group-setu",
		true,
		"set -u; { :; } 2>/dev/null < $nosuch & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-pipe-group-dup",
		false,
		"{ :; } 2>&1 < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"r6-pipe-group-dup",
		true,
		"{ :; } 2>&1 < ${x:?u} | cat; echo \"st=${PIPESTATUS[0]}\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"r6-pipe-last-group-stderr",
		false,
		"true | { /bin/cat; } 2>/dev/null < ${x:?u}; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-pipe-last-group-stderr",
		true,
		"true | { /bin/cat; } 2>/dev/null < ${x:?u}; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-sub-word-stderr",
		false,
		"{ :; } 2>/dev/null < \"$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"r6-bg-group-sub-word-stderr",
		true,
		"{ :; } 2>/dev/null < \"$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"r6-bg-group-then-after",
		false,
		"{ :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"; echo after",
		0,
		"st=127\nafter\n",
		"",
	),
	(
		"r6-bg-group-then-after",
		true,
		"{ :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"; echo after",
		0,
		"st=1\nafter\n",
		"",
	),
	(
		"r6-bg-group-body-stderr",
		false,
		"{ /bin/cat < ${x:?u}; echo after; } 2>/dev/null & wait $!; echo \"st=$?\"",
		0,
		"after\nst=0\n",
		"",
	),
	(
		"r6-bg-group-body-stderr",
		true,
		"{ /bin/cat < ${x:?u}; echo after; } 2>/dev/null & wait $!; echo \"st=$?\"",
		0,
		"after\nst=0\n",
		"",
	),
	(
		"l-not-bg-group-fatal",
		false,
		"! { /bin/cat < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-group-fatal",
		true,
		"! { /bin/cat < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-group-null-fatal",
		false,
		"! { < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-group-null-fatal",
		true,
		"! { < ${x:?u}; } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-group-arith",
		false,
		"! { /bin/cat < $((1/0)); } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"l-not-bg-group-arith",
		true,
		"! { /bin/cat < $((1/0)); } & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: 1/0: division by 0 (error token is \"0\")\n",
	),
	(
		"l-not-bg-fn-fatal",
		true,
		"f() { /bin/cat < ${x:?u}; }; ! f & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"o-bg-fn-ext",
		true,
		"f() { /bin/cat < ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"o-pipe-fn-ext",
		true,
		"f() { /bin/cat < ${x:?u}; }; : | f; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"o-bg-fn-subshell",
		true,
		"f() { ( : ) < ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-eval-fatal",
		false,
		"! eval '/bin/cat < ${x:?u}' & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-eval-fatal",
		true,
		"! eval '/bin/cat < ${x:?u}' & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-group-after",
		false,
		"! { /bin/cat < ${x:?u}; echo after; } & wait $!; echo \"st=$?\"",
		0,
		"after\nst=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-group-after",
		true,
		"! { /bin/cat < ${x:?u}; echo after; } & wait $!; echo \"st=$?\"",
		0,
		"after\nst=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-nonexist",
		false,
		"! /bin/cat < nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"l-not-bg-nonexist",
		true,
		"! /bin/cat < nonexist & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"./s.sh: line 1: nonexist: No such file or directory\n",
	),
	(
		"l-not-bg-while-fatal",
		false,
		"! while /bin/cat < ${x:?u}; do :; done & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-while-fatal",
		true,
		"! while /bin/cat < ${x:?u}; do :; done & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"l-not-bg-if-fatal",
		false,
		"! if /bin/cat < ${x:?u}; then :; fi & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"l-not-bg-if-fatal",
		true,
		"! if /bin/cat < ${x:?u}; then :; fi & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"./s.sh: line 1: x: u\n",
	),
	(
		"h19-bg-timed-group-stderr",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-group-stderr",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-dup",
		false,
		"TIMEFORMAT=T; time { :; } 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"bash: line 1: x: u\nst=127\n",
		"",
	),
	(
		"h19-bg-timed-group-dup",
		true,
		"TIMEFORMAT=T; time { :; } 2>&1 < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"./s.sh: line 1: x: u\nst=1\n",
		"",
	),
	(
		"h19-bg-timed-group-err-file",
		false,
		"TIMEFORMAT=T; time { :; } 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=127\nbash: line 1: x: u\n",
		"",
	),
	(
		"h19-bg-timed-group-err-file",
		true,
		"TIMEFORMAT=T; time { :; } 2>err < ${x:?u} & wait $!; echo \"st=$?\"; cat err",
		0,
		"st=1\n./s.sh: line 1: x: u\n",
		"",
	),
	(
		"h19-not-bg-timed-group-stderr",
		false,
		"TIMEFORMAT=T; time ! { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-not-bg-timed-group-stderr",
		true,
		"TIMEFORMAT=T; time ! { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-subshell-stderr",
		false,
		"TIMEFORMAT=T; time ( : ) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-subshell-stderr",
		true,
		"TIMEFORMAT=T; time ( : ) 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-while-stderr",
		false,
		"TIMEFORMAT=T; time while :; do break; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-while-stderr",
		true,
		"TIMEFORMAT=T; time while :; do break; done 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-if-stderr",
		false,
		"TIMEFORMAT=T; time if :; then :; fi 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-if-stderr",
		true,
		"TIMEFORMAT=T; time if :; then :; fi 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-arith-stderr",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-arith-stderr",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < $((1/0)) & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-badsub-stderr",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-badsub-stderr",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"${x!y}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-sub-word-stderr",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-group-sub-word-stderr",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-two-sub-words",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"$(true)$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-group-two-sub-words",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < \"$(true)$(true)${x:?u}\" & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-setu",
		false,
		"set -u; TIMEFORMAT=T; time { :; } 2>/dev/null < $nosuch & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-timed-group-setu",
		true,
		"set -u; TIMEFORMAT=T; time { :; } 2>/dev/null < $nosuch & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-then-after",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"; echo after",
		0,
		"st=127\nafter\n",
		"",
	),
	(
		"h19-bg-timed-group-then-after",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"; echo after",
		0,
		"st=1\nafter\n",
		"",
	),
	(
		"h19-bg-timed-external-stderr",
		false,
		"TIMEFORMAT=T; time /bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"T\n",
	),
	(
		"h19-bg-timed-external-stderr",
		true,
		"TIMEFORMAT=T; time /bin/cat 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"T\n",
	),
	(
		"h19-bg-timed-simple-report-null",
		false,
		"TIMEFORMAT=T; time : 2>/dev/null & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"T\n",
	),
	(
		"h19-bg-timed-simple-report-null",
		true,
		"TIMEFORMAT=T; time : 2>/dev/null & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"T\n",
	),
	(
		"h19-bg-timed-group-pipe",
		false,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} | cat & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"T\n",
	),
	(
		"h19-bg-timed-group-pipe",
		true,
		"TIMEFORMAT=T; time { :; } 2>/dev/null < ${x:?u} | cat & wait $!; echo \"st=$?\"",
		0,
		"st=0\n",
		"T\n",
	),
	(
		"h19-bg-group-stderr",
		false,
		"{ :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"",
	),
	(
		"h19-bg-group-stderr",
		true,
		"{ :; } 2>/dev/null < ${x:?u} & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"",
	),
	(
		"h19-bg-timed-group-ok",
		false,
		"TIMEFORMAT=T; time { echo in; } & wait $!; echo \"st=$?\"",
		0,
		"in\nst=0\n",
		"T\n",
	),
	(
		"h19-bg-timed-group-ok",
		true,
		"TIMEFORMAT=T; time { echo in; } & wait $!; echo \"st=$?\"",
		0,
		"in\nst=0\n",
		"T\n",
	),
];

/// The rows bash 5.2.21 runs otherwise, as bash 5.3.20 runs them (this
/// library follows bash 5.3), in the form of [`ROWS`].
const ROWS53: &[(&str, bool, &str, i32, &str, &str)] = &[
	// 18 rows bash 5.2.21 runs otherwise, as bash 5.3.20 runs them
	(
		"h-in-fn",
		false,
		"f() { /bin/cat < ${x:?u}; }; f; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"h-bg-fn",
		false,
		"f() { echo ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	("h-null", false, "< ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "bash: line 1: x: u\n"),
	(
		"g-null-move",
		false,
		"<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-null-move",
		true,
		"<&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-assign-move",
		false,
		"x=1 <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: line 1: 7: Bad file descriptor\n",
	),
	(
		"g-assign-move",
		true,
		"x=1 <&7-; echo \"s=$?\"",
		0,
		"s=1\n",
		"./s.sh: line 1: 7: Bad file descriptor\n",
	),
	(
		"x-fn",
		false,
		"f() { /bin/cat < ${x:?u}; echo \"in=$?\"; }; f; echo \"s=$?\"",
		0,
		"in=127\ns=0\n",
		"bash: line 1: x: u\n",
	),
	("x-null-var", false, "{v}< ${x:?u}; echo \"s=$?\"", 0, "s=1\n", "bash: line 1: x: u\n"),
	(
		"r2-bg-fn-eval",
		false,
		"f() { eval 'echo ${x:?u}'; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-sub-redir-fn",
		false,
		"f() { ( echo g ) < ${x:?u}; echo \"in=$?\"; }; f; echo \"s=$?\"",
		0,
		"in=127\ns=0\n",
		"bash: line 1: x: u\n",
	),
	(
		"r2-var-local",
		false,
		"f() { local v=y; /bin/cat {v}<in < nonexist; echo \"v=$v\"; }; f; echo \"v=${v-unset}\"",
		0,
		"v=y\nv=unset\n",
		"bash: line 1: nonexist: No such file or directory\n",
	),
	(
		"g-fn-group-move-bg",
		false,
		"f() { { :; } <&7-; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"g-fn-close-move-bg",
		false,
		"f() { echo x <&7-; }; f & wait $!; echo \"st=$?\"",
		0,
		"st=1\n",
		"bash: redirection error: cannot duplicate fd: Bad file descriptor\nbash: line 1: 7: Bad \
		 file descriptor\n",
	),
	(
		"l-not-bg-fn-fatal",
		false,
		"f() { /bin/cat < ${x:?u}; }; ! f & wait $!; echo \"st=$?\"",
		0,
		"st=127\n",
		"bash: line 1: x: u\n",
	),
	// The fork made for a program's or a `( … )`'s redirections in a function
	// that a background job or a pipeline element runs: its fatal error ends
	// where the fork's forking shell's would (bash's fork copies `top_level`).
	(
		"o-bg-fn-ext",
		false,
		"f() { /bin/cat < ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"o-pipe-fn-ext",
		false,
		"f() { /bin/cat < ${x:?u}; }; : | f; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
	(
		"o-bg-fn-subshell",
		false,
		"f() { ( : ) < ${x:?u}; }; f & wait $!; echo \"s=$?\"",
		0,
		"s=127\n",
		"bash: line 1: x: u\n",
	),
];

/// The directory a row runs in: `in` and the FIFO `fifo`.
fn files(dir: &Path) {
	fs::write(dir.join("in"), "hello\n").unwrap();
	let fifo =
		std::ffi::CString::new(dir.join("fifo").into_os_string().into_encoded_bytes()).unwrap();
	// SAFETY: `fifo` is a NUL-terminated path that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
}

/// How row `(id, file, script, status, out, err)` differs from bash, if it
/// does.
fn differs(
	&(id, file, script, status, out, err): &(&str, bool, &str, i32, &str, &str),
) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let mut cmd = obash();
	cmd.arg0("bash").current_dir(dir.path());
	if file {
		fs::write(dir.path().join("s.sh"), format!("{script}\n")).unwrap();
		cmd.arg("./s.sh");
	} else {
		cmd.arg("-c").arg(script);
	}
	let how = if file { "./s.sh" } else { "-c" };
	// `output` panics on a process past the obash tests' bound: the row hung,
	// and is reported with the others.
	let Ok(got) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| output(&mut cmd))) else {
		return Some(format!(
			"{id} ({how}): `{script}`\n  bash: {status} {out:?} {err:?}\n  got:  no end within the \
			 bound"
		));
	};
	let real = dir.path().canonicalize().unwrap();
	let clean = |b: &[u8]| {
		String::from_utf8_lossy(b)
			.replace(&*real.to_string_lossy(), "DIR")
			.replace(&*dir.path().to_string_lossy(), "DIR")
	};
	let got = (got.status.code(), clean(&got.stdout), clean(&got.stderr));
	(got != (Some(status), out.to_owned(), err.to_owned())).then(|| {
		format!(
			"{id} ({how}): `{script}`\n  bash: {status} {out:?} {err:?}\n  got:  {:?} {:?} {:?}",
			got.0, got.1, got.2
		)
	})
}

/// Runs `rows` a few at once (each in its own directory) and asserts each
/// is bash's, reporting every row that is not.
fn check(rows: &[(&str, bool, &str, i32, &str, &str)]) {
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		// Every worker starts before the first is joined.
		let mut workers = Vec::with_capacity(threads);
		for chunk in rows.chunks(rows.len().div_ceil(threads).max(1)) {
			workers.push(scope.spawn(move || chunk.iter().filter_map(differs).collect::<Vec<_>>()));
		}
		let mut failures = Vec::new();
		for worker in workers {
			failures.extend(worker.join().unwrap());
		}
		failures
	});
	assert!(
		failures.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		failures.len(),
		rows.len(),
		failures.join("\n")
	);
}

/// (h): a fatal expansion error in a forked command's redirections is that
/// command's, with bash's status, wherever the command runs.
#[test]
fn a_forked_commands_redirection_error_ends_only_that_command() {
	let rows: Vec<_> = ROWS
		.iter()
		.copied()
		.filter(|r| !r.0.starts_with("g-"))
		.collect();
	assert!(rows.len() > 60, "{} (h) rows", rows.len());
	check(&rows);
}

/// (g): a duplication of a fd that is not open names it as bash does, with
/// bash's `cannot duplicate fd` line where bash prints one.
#[test]
fn a_duplication_of_a_closed_fd_is_named_as_bash_names_it() {
	let rows: Vec<_> = ROWS
		.iter()
		.copied()
		.filter(|r| r.0.starts_with("g-"))
		.collect();
	assert!(rows.len() > 40, "{} (g) rows", rows.len());
	check(&rows);
}

/// The rows bash 5.2.21 runs otherwise (a null command's fatal redirection,
/// a function's fatal error under `-c`), as bash 5.3.20 runs them.
#[test]
fn rows_bash_5_2_runs_otherwise_are_as_bash_5_3_runs_them() {
	assert!(ROWS53.len() > 10, "{} rows", ROWS53.len());
	check(ROWS53);
}

/// A `( … )`'s own `{var}`s are its fork's (the subshell reads the fd, the
/// shell keeps neither fd nor value) also when the shell is imaged and
/// restored into a fresh engine over a `MemFs` whose every answer comes late:
/// at every op and at every other open (`Rig::run`, which images a `{var}`
/// between the list and the subshell's fork), and at every other wait with
/// no op run on between ([`imaged_at_every_other_wait`], which images one
/// while a later open of its list waits). The subshell reads a here-string's
/// fd: a memory object survives an image, where a host file's fd is lost by
/// design (`FdObjImage::Host`).
#[test]
fn a_subshells_own_var_is_its_forks_across_a_restore() {
	const SRC: &[u8] =
		b"( read -r l <&$v; echo \"in=[$v] l=$l\" ) {v}<<<x; echo \"out=[$v]\"; ( : ) \
	                     {w}</in {x}</in {y}</in < /missing; echo \"w=[$w] x=[$x] y=[$y]\"";
	let host = || {
		let fs = MemFs::with_latency(5, 1.0, 1);
		fs.add_file("/in", b"x\n", 0o644);
		FakeHost::new().with_fs(fs)
	};
	let plain = run_script(host(), SRC, &[], Fault::None);
	let imaged = run_script(host(), SRC, &[], Fault::Snapshot { every: 1 });
	// The shell runs again only once a fork it waits for ends: 13 images at
	// a6a2639b, where the shell made these redirections itself; not one more
	// at each wake of the fork's own opens.
	assert!((11..100).contains(&imaged.snapshots), "{} snapshots", imaged.snapshots);
	let mid_list = imaged_at_every_other_wait(host(), SRC);
	assert!(mid_list.snapshots > 0, "no snapshot mid-list");
	let want = (0, "in=[10] l=x\nout=[]\nw=[] x=[] y=[]\n".to_owned());
	// Each run's difference is reported, not only the first one's.
	let wrong: Vec<String> =
		[("plain", &plain), ("imaged", &imaged), ("imaged mid-list", &mid_list)]
			.into_iter()
			.filter_map(|(what, got)| {
				let err = String::from_utf8_lossy(&got.stderr);
				let out = (got.status, String::from_utf8_lossy(&got.stdout).into_owned());
				(out != want || !err.contains("/missing: No such file or directory"))
					.then(|| format!("{what}: {out:?}, stderr {err:?}"))
			})
			.collect();
	assert!(wrong.is_empty(), "want {want:?}:\n{}", wrong.join("\n"));
}

/// Run `src` as a `-c` script, imaged and restored at every other wait of
/// the shell and waiting at the others: unlike `Rig::run`, which runs on to
/// the op's end after each wait it images, an op that waits at several opens
/// is imaged between them.
fn imaged_at_every_other_wait(host: FakeHost, src: &[u8]) -> Outcome {
	let mut rig = Rig::new(host, skeleton_init(&[]));
	let id = rig.shell().submit(Script::command(src.to_vec()));
	let mut image = true;
	let status = loop {
		let (shell, host, store) = rig.parts();
		match advance_or_blocked(shell, host, store, id, Budget::default()) {
			Stop::Done(status) => break status,
			Stop::Blocked if image => {
				rig.snapshot();
				image = false;
			},
			Stop::Blocked => {
				let (shell, host, _) = rig.parts();
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
				image = true;
			},
			Stop::Yield => {},
			other => panic!("unexpected {other:?}"),
		}
	};
	let outcome = Outcome {
		status,
		stdout: rig.host.stdout.bytes(),
		stderr: rig.host.stderr.bytes(),
		events: comparable(&rig.host.events),
		snapshots: rig.snapshots,
		pauses: rig.pauses,
	};
	let (shell, host, store) = rig.parts();
	host.assert_no_leaks(shell, store);
	outcome
}

/// The shell drops a `( … )`'s own `{var}`s once the subshell's fork is
/// made: while the subshell runs (here held by a native task, and imaged
/// and restored there) the shell holds no `v`, and the subshell still has
/// its value and its fd (a here-string's: a memory object survives the
/// image, a host file's fd does not).
#[test]
fn a_running_subshell_keeps_its_own_var_that_the_shell_dropped() {
	const SRC: &[u8] = b"( echo \"in=[$v]\"; hold; read -r l <&$v; echo \"l=$l v=[$v]\" ) {v}<<<x; \
	                     echo \"out=[$v]\"";
	let mut host = FakeHost::new();
	host.countdown("hold", 20, 0);
	let mut rig = Rig::new(host, skeleton_init(&[]));
	let id = rig.shell().submit(Script::command(SRC.to_vec()));
	let one = Budget { max_ops: 1, max_ns: u64::MAX };
	// Until the subshell has started: it prints `in=` before it holds.
	loop {
		let (shell, host, store) = rig.parts();
		if host.stdout.bytes().starts_with(b"in=") {
			break;
		}
		assert_eq!(advance(shell, host, store, id, one), Stop::Yield, "before the subshell's hold");
	}
	let shell_v = |rig: &mut Rig| rig.parts().2.record(Key::Var(BStr::new("v"))).cloned();
	assert_eq!(shell_v(&mut rig), None, "the shell holds the subshell's `{{var}}` while it runs");
	rig.snapshot();
	assert_eq!(shell_v(&mut rig), None, "the restored shell holds the subshell's `{{var}}`");
	let status = loop {
		let (shell, host, store) = rig.parts();
		match advance(shell, host, store, id, Budget::default()) {
			Stop::Done(status) => break status,
			Stop::Yield => {},
			other => panic!("unexpected {other:?}"),
		}
	};
	let (_, host, _) = rig.parts();
	assert_eq!(
		(status, String::from_utf8_lossy(&host.stdout.bytes()).into_owned()),
		(0, "in=[10]\nl=x v=[10]\nout=[]\n".to_owned()),
		"stderr: {}",
		String::from_utf8_lossy(&host.stderr.bytes())
	);
}

/// The bound of one [`bounded`] run: a run takes milliseconds.
const RUN_BOUND: std::time::Duration = std::time::Duration::from_secs(60);

/// `run` in a thread of its own: a run that has not ended within
/// [`RUN_BOUND`] is a failure (a fork that never stops waiting for its
/// stream), and its thread is left to the end of the binary.
fn bounded<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let _ = tx.send(run());
	});
	rx.recv_timeout(RUN_BOUND).map_err(|e| match e {
		std::sync::mpsc::RecvTimeoutError::Timeout => format!("no end within {RUN_BOUND:?}"),
		std::sync::mpsc::RecvTimeoutError::Disconnected => "the run panicked".to_owned(),
	})
}

/// A run's status, standard output and standard error.
type Got = (i32, String, String);

/// [`run_script`] of `src` on a fresh [`FakeHost`] (with a write storm of
/// `seed`, when given) under `fault`, [`bounded`].
fn bounded_run(src: &'static [u8], storm: Option<u64>, fault: Fault) -> Result<Outcome, String> {
	bounded(move || {
		let host = match storm {
			Some(seed) => FakeHost::new().with_write_storm(seed, 0.5),
			None => FakeHost::new(),
		};
		run_script(host, src, &[], fault)
	})
}

/// `src` as a `-c` script under the write storm of `seed`, run one op at a
/// time and imaged and restored once: at the first op boundary where the
/// standard output holds some but not all of the `len` bytes it gets first
/// (the fork's message, part written, the fork waiting for the stream).
/// What it gave, and whether it was imaged; [`bounded`].
fn bounded_imaged_mid_message(
	src: &'static [u8],
	seed: u64,
	len: usize,
) -> Result<(Got, bool), String> {
	bounded(move || {
		let one = Budget { max_ops: 1, max_ns: u64::MAX };
		let mut rig = Rig::new(FakeHost::new().with_write_storm(seed, 0.5), skeleton_init(&[]));
		let id = rig.shell().submit(Script::command(src.to_vec()));
		let mut imaged = false;
		let status = loop {
			let n = rig.host.stdout.bytes().len();
			if !imaged && n > 0 && n < len {
				rig.snapshot();
				imaged = true;
				continue;
			}
			let (shell, host, store) = rig.parts();
			match advance(shell, host, store, id, one) {
				Stop::Done(status) => break status,
				Stop::Yield => {},
				other => panic!("unexpected {other:?}"),
			}
		};
		let got = (
			status,
			String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
			String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
		);
		let (shell, host, store) = rig.parts();
		host.assert_no_leaks(shell, store);
		(got, imaged)
	})
}

/// The fork of an async command ends only after the message of a fatal
/// error in its redirections is written where those redirections so far
/// sent it (here `2>&1`: the standard output), also when that stream takes a
/// few bytes at a time and is full in between (a write storm: the fork waits
/// for it), when the shell is imaged and restored at every op, and when it
/// is imaged and restored once while the fork waits with its message part
/// written. The fork's command is a builtin, the same behind a `!` (nothing
/// after the fatal error runs, the `!` neither, also after the fork waited),
/// and a `{ }` whose own redirections fail (the fork does not make them
/// again after it waited). Each run is bounded ([`bounded`]); a storm stops
/// at its first run that does not end.
///
/// The storm runs are not imaged at every op: a restored host remakes its
/// streams, and with them the storm's random sequence from its seed, so a
/// run imaged about as often as its fork waits can meet the same full stream
/// after each image (imaged every 2 ops, this test ran past 120 s and 3
/// GiB).
#[test]
fn a_forks_fatal_message_waits_for_the_stream_its_redirections_chose() {
	const MESSAGE: &str = "bash: line 1: x: u\n";
	const JOBS: [(&str, &[u8]); 3] = [
		("echo", b"echo 2>&1 < ${x:?u} & wait $!; echo \"st=$?\""),
		("not-echo", b"! echo 2>&1 < ${x:?u} & wait $!; echo \"st=$?\""),
		("group", b"{ :; } 2>&1 < ${x:?u} & wait $!; echo \"st=$?\""),
	];
	let got = |o: &Outcome| -> Got {
		(
			o.status,
			String::from_utf8_lossy(&o.stdout).into_owned(),
			String::from_utf8_lossy(&o.stderr).into_owned(),
		)
	};
	let mut wrong = Vec::new();
	for (name, src) in JOBS {
		// The status is the rows' to pin; here, where the message goes, and
		// that a run that waited ends as the plain run does.
		let plain = match bounded_run(src, None, Fault::None) {
			Ok(o) => got(&o),
			Err(e) => panic!("{name} plain: {e}"),
		};
		assert!(
			plain.0 == 0 && plain.1.starts_with(&format!("{MESSAGE}st=")) && plain.2.is_empty(),
			"{name} plain: {plain:?}"
		);
		match bounded_run(src, None, Fault::Snapshot { every: 1 }) {
			Ok(imaged) => {
				assert!(imaged.snapshots > 0, "{name}: no snapshot was taken");
				if got(&imaged) != plain {
					wrong.push(format!("{name} imaged at every op: {:?}", got(&imaged)));
				}
			},
			Err(e) => wrong.push(format!("{name} imaged at every op: {e}")),
		}
		for seed in 1..=16 {
			match bounded_run(src, Some(seed), Fault::None) {
				Ok(out) if got(&out) == plain => {},
				Ok(out) => wrong.push(format!("{name} storm {seed}: {:?}", got(&out))),
				Err(e) => {
					wrong.push(format!("{name} storm {seed}: {e}"));
					break;
				},
			}
		}
		// The control of the image runs: some of them are imaged while the
		// message is part written.
		let mut mid = 0;
		for seed in 1..=16 {
			match bounded_imaged_mid_message(src, seed, MESSAGE.len()) {
				Ok((out, imaged)) => {
					mid += u32::from(imaged);
					if out != plain {
						wrong.push(format!("{name} imaged mid-message {seed}: {out:?}"));
					}
				},
				Err(e) => {
					wrong.push(format!("{name} imaged mid-message {seed}: {e}"));
					break;
				},
			}
		}
		if mid == 0 {
			wrong.push(format!("{name}: no run was imaged mid-message"));
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
