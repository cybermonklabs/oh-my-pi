//! Two older differences from bash in a redirection's failure, each row as
//! bash 5.2.21 and 5.3.20 both run it (`bash -c` and `bash ./s.sh`; the
//! rows where the two bashes differ are left out):
//!
//! - (h) A fatal expansion error (`${x:?}`, `set -u`, `$((1/0))`) in the
//!   redirections of a command bash runs in a fork of its own (an external, a
//!   name not found, `command X`, a null command that redirects fd 0) ends that
//!   fork, not the shell: the command fails with 127 under `-c` or 1 from a
//!   script, and the shell goes on. An asynchronous simple command's or a
//!   pipeline stage's fatal error lands where its parent's would: 127 under
//!   `-c`. A subshell, a command substitution and a compound job catch their
//!   own (status 1).
//! - (g) A duplication whose source is not open names, as bash's
//!   `redirection_error` does, the number of a literal source (`<&07` is `7`),
//!   the word of an expanded one copied onto the operator's own fd (`<&$fd`),
//!   else the fd it sets (`3<&$fd` is `3`, a move `<&$fd-` is `0`); and a move
//!   the shell will undo, or a `{var}` copy, first prints `redirection error:
//!   cannot duplicate fd: Bad file descriptor`.
//!
//! Each row runs in a fresh directory holding `in` ("hello") and a FIFO
//! `fifo`, its program named `bash` (as bash names itself in messages).
#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt as _, path::Path};

use obash_support::{obash, output};

/// Each row: id, run from a script file (else `-c`), script, status,
/// stdout, stderr (the row's directory written `DIR`).
const ROWS: &[(&str, bool, &str, i32, &str, &str)] = &[
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
