//! An empty word names no file. As a redirection target (the shell's own
//! open, and a background job's process's), `.`/`source`'s file, `exec`'s
//! or a command's name, `hash -p`'s path, it fails as the kernel's
//! `open("")` does (`ENOENT`), where the engine took it for the working
//! directory: `readlink /proc/self/fd/0 < ""` printed the directory, and
//! `exec 3< ""` opened it. An empty `<&`/`>&` word is bash's bad fd number;
//! bash 5.3's `cd ""` is `null directory`, its `history -r ""` `empty
//! filename`. In zsh mode a `$PATH` candidate that is no regular file is
//! zsh's `EACCES` (`exec ""` and `""` are `permission denied`, 126), `exec`
//! of a missing command reports as zsh's `execute` does, and a `#!` line
//! that names no interpreter reports the script's `ENOEXEC`.
//!
//! Each row runs from a script file `./s.sh` in a fresh directory
//! ([`files`]) and wants bash 5.3.20's output (bash mode; 5.2.21 agrees but
//! on `cd ""`, `cd -P ""`, `pushd ""` and `history`, where 5.2 takes `""`
//! for the working directory or fails silently) or zsh 5.9's (`zsh -f`).
#![cfg(unix)]

mod obash_support;

use std::{
	fs,
	os::unix::{fs::PermissionsExt, process::CommandExt as _},
	path::Path,
};

use obash_support::{obash, output};

/// A row: its name, its script, and the stdout, stderr and status wanted.
type Row = (&'static str, &'static str, &'static str, &'static str, i32);

/// The directory a row runs in: `in`, `sub/`, the FIFO `fifo` and `x`, an
/// executable whose `#!` line names no interpreter.
fn files(dir: &Path) {
	fs::write(dir.join("in"), "hello\n").unwrap();
	fs::create_dir(dir.join("sub")).unwrap();
	let fifo =
		std::ffi::CString::new(dir.join("fifo").into_os_string().into_encoded_bytes()).unwrap();
	// SAFETY: `fifo` is a NUL-terminated path that outlives the call.
	assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
	fs::write(dir.join("x"), "#!\necho hi\n").unwrap();
	fs::set_permissions(dir.join("x"), fs::Permissions::from_mode(0o755)).unwrap();
}

/// `text` with the row's directory written `DIR`.
fn clean(text: &[u8], dir: &Path) -> String {
	let real = dir.canonicalize().unwrap();
	String::from_utf8_lossy(text)
		.replace(&*real.to_string_lossy(), "DIR")
		.replace(&*dir.to_string_lossy(), "DIR")
}

/// How row `row` differs from what it wants, run by obash (in zsh mode
/// for `zsh`, with `-c` for `c`), if it does.
fn differs(zsh: bool, c: bool, (id, script, out, err, status): &Row) -> Option<String> {
	let dir = tempfile::tempdir().unwrap();
	files(dir.path());
	let mut cmd = obash();
	if zsh {
		cmd.arg0("zsh");
		cmd.arg("-f");
	} else {
		cmd.arg0("bash");
	}
	if c {
		cmd.arg("-c").arg(script);
	} else {
		fs::write(dir.path().join("s.sh"), format!("{script}\n")).unwrap();
		cmd.arg("./s.sh");
	}
	cmd.current_dir(dir.path())
		.env_clear()
		.env("PATH", "/usr/bin:/bin")
		.env("HOME", dir.path())
		.env("LC_ALL", "C");
	// `output` panics on a process past the obash tests' bound: the row hung,
	// and is reported with the others.
	let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| output(&mut cmd)));
	let Ok(got) = run else {
		return Some(format!(
			"{id}: `{script}`\n  want: {status} {out:?} {err:?}\n  got:  no end within the bound"
		));
	};
	let got = (got.status.code(), clean(&got.stdout, dir.path()), clean(&got.stderr, dir.path()));
	(got != (Some(*status), (*out).to_owned(), (*err).to_owned())).then(|| {
		format!(
			"{id}: `{script}`\n  want: {status} {out:?} {err:?}\n  got:  {:?} {:?} {:?}",
			got.0, got.1, got.2
		)
	})
}

/// Runs each row and reports every one that differs. The rows are
/// independent (a directory each), so a few run at once.
fn check(zsh: bool, c: bool, rows: &[Row]) {
	let threads = std::thread::available_parallelism().map_or(1, |n| n.get().min(8));
	let failures = std::thread::scope(|scope| {
		// Every worker starts before the first is joined.
		let mut workers = Vec::with_capacity(threads);
		for chunk in rows.chunks(rows.len().div_ceil(threads).max(1)) {
			workers.push(scope.spawn(move || {
				chunk
					.iter()
					.filter_map(|row| differs(zsh, c, row))
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

/// bash mode: an empty word names no file, as bash 5.3.20 says.
#[test]
fn an_empty_word_names_no_file_in_bash() {
	check(false, false, BASH);
}

/// zsh mode: an empty word names no file, as zsh 5.9 says.
#[test]
fn an_empty_word_names_no_file_in_zsh() {
	check(true, false, ZSH);
	check(true, true, ZSH_C);
}

/// Rows: bash 5.3.20's (5.2.21 agrees but where [`BASH`]'s notes say).
const BASH: &[Row] = &[
	(
		"in-ext",
		"cat < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"in-sq",
		"cat < ''; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"in-var",
		"e=; cat < \"$e\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"readlink",
		"readlink /proc/self/fd/0 < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"in-builtin",
		"read x < \"\"; echo \"s=$? x=$x\"",
		"s=1 x=\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"out-ext",
		"echo x > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"append",
		"echo x >> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"clobber",
		"echo x >| \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"noclobber",
		"set -C; echo x > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"rw",
		"cat <> \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"both",
		"echo x &> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"both-append",
		"echo x &>> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"err",
		"ls nosuch 2> \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"null-out",
		": > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	("null-in", ": < \"\"", "", "./s.sh: line 1: : No such file or directory\n", 1),
	(
		"exec-fd",
		"exec 3< \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"exec-fd-out",
		"exec 3> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"exec-var",
		"exec {fd}< \"\"; echo \"s=$? fd=$fd\"",
		"s=1 fd=\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"group",
		"{ echo in; } < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"subshell",
		"( echo in ) < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"while",
		"while read -r l; do echo \"$l\"; done < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"fn",
		"f() { echo in; }; f < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"bg",
		"cat < \"\" & wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"pipe",
		"cat < \"\" | cat; echo \"s=$?\"",
		"s=0\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"later",
		"cat < in > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"comsub-file",
		"x=$(< \"\"); echo \"st=$? [$x]\"",
		"st=1 []\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"comsub-cat",
		"x=$(cat < \"\"); echo \"s=$? x=$x\"",
		"s=1 x=\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"mapfile",
		"mapfile a < \"\"; echo \"s=$? n=${#a[@]}\"",
		"s=1 n=0\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"fifo-defer-in",
		"/bin/cat > fifo < \"\" & cat fifo; wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"fifo-defer-err",
		"/bin/cat < in > fifo 2> \"\" & cat fifo; wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"dup-in",
		"cat <& \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: \"\": Bad file descriptor\n",
		0,
	),
	(
		"dup-out",
		"echo x >& \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: \"\": Bad file descriptor\n",
		0,
	),
	(
		"dup-var",
		"e=; echo x >& \"$e\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: \"$e\": Bad file descriptor\n",
		0,
	),
	(
		"dup-out-ext",
		"ls >& \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: \"\": Bad file descriptor\n",
		0,
	),
	("dot", ". \"\"; echo \"s=$?\"", "s=1\n", "./s.sh: line 1: : No such file or directory\n", 0),
	(
		"source",
		"source \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	("exec", "exec \"\"; echo \"s=$?\"", "", "./s.sh: line 1: exec: : not found\n", 127),
	("hash-p", "hash -p \"\" x; echo \"s=$?\"; hash -t x; echo \"t=$?\"", "s=0\n\nt=0\n", "", 0),
	(
		"hash-run",
		"hash -p \"\" x; x; echo \"s=$?\"",
		"s=127\n",
		"./s.sh: line 1: : No such file or directory\n",
		0,
	),
	(
		"cd",
		"cd \"\"; echo \"s=$?\"; [ \"$PWD\" -ef ~ ] && echo here",
		"s=1\nhere\n",
		"./s.sh: line 1: cd: null directory\n",
		0,
	),
	(
		"cd-P",
		"cd -P \"\"; echo \"s=$?\"; [ \"$PWD\" -ef ~ ] && echo here",
		"s=1\nhere\n",
		"./s.sh: line 1: cd: null directory\n",
		0,
	),
	(
		"pushd",
		"pushd \"\" > /dev/null; echo \"s=$?\"; [ \"$PWD\" -ef ~ ] && echo here",
		"s=1\nhere\n",
		"./s.sh: line 1: pushd: null directory\n",
		0,
	),
	(
		"history-r",
		"set -o history; history -r \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: history: empty filename\n",
		0,
	),
	(
		"history-w",
		"set -o history; history -w \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh: line 1: history: empty filename\n",
		0,
	),
	(
		"histfile-empty",
		"set -o history; HISTFILE=; history -w; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: history: HISTFILE: parameter null or not set\n",
		0,
	),
	("command", "\"\"; echo \"s=$?\"", "s=127\n", "./s.sh: line 1: : command not found\n", 0),
	(
		"command-path-dot",
		"PATH=.; \"\"; echo \"s=$?\"",
		"s=127\n",
		"./s.sh: line 1: : command not found\n",
		0,
	),
	("command-v", "command -v \"\"; echo \"s=$?\"", "s=1\n", "", 0),
	("type", "type \"\"; echo \"s=$?\"", "s=1\n", "./s.sh: line 1: type: : not found\n", 0),
	(
		"test",
		"[ -e \"\" ]; echo \"e=$?\"; [ -d \"\" ]; echo \"d=$?\"; [ -f \"\" ]; echo \"f=$?\"; [ -r \
		 \"\" ]; echo \"r=$?\"; [ -x \"\" ]; echo \"x=$?\"; [ -L \"\" ]; echo \"L=$?\"",
		"e=1\nd=1\nf=1\nr=1\nx=1\nL=1\n",
		"",
		0,
	),
	(
		"cond",
		"[[ -e \"\" ]]; echo \"e=$?\"; [[ -d \"\" ]]; echo \"d=$?\"; [[ -r \"\" ]]; echo \"r=$?\"",
		"e=1\nd=1\nr=1\n",
		"",
		0,
	),
	(
		"exec-sub",
		"exec sub; echo \"s=$?\"",
		"",
		"./s.sh: line 1: exec: sub: cannot execute: Is a directory\n",
		126,
	),
	(
		"exec-nosuch",
		"exec nosuch; echo \"s=$?\"",
		"",
		"./s.sh: line 1: exec: nosuch: not found\n",
		127,
	),
	(
		"path-dir",
		"mkdir -p p/foo; PATH=$PWD/p:$PATH; foo; echo \"s=$?\"",
		"s=127\n",
		"./s.sh: line 1: foo: command not found\n",
		0,
	),
	(
		"path-noexec",
		"mkdir p; echo : > p/foo; PATH=$PWD/p:$PATH; foo; echo \"s=$?\"; hash -t foo | sed \
		 \"s#.*/##\"",
		"s=126\nfoo\n",
		"./s.sh: line 1: DIR/p/foo: Permission denied\n",
		0,
	),
	("shebang", "./x; echo \"s=$?\"", "hi\ns=0\n", "", 0),
	("glob", "echo *", "fifo in s.sh sub x\n", "", 0),
	("glob-dir", "echo s*", "s.sh sub\n", "", 0),
	(
		"missing",
		"cat < nosuch; echo \"s=$?\"",
		"s=1\n",
		"./s.sh: line 1: nosuch: No such file or directory\n",
		0,
	),
	("dir", "cat < sub; echo \"s=$?\"", "s=1\n", "cat: -: Is a directory\n", 0),
];

/// Rows: zsh 5.9's (`zsh -f`).
const ZSH: &[Row] = &[
	("in-ext", "cat < \"\"; echo \"s=$?\"", "s=1\n", "./s.sh:1: no such file or directory: \n", 0),
	("in-sq", "cat < ''; echo \"s=$?\"", "s=1\n", "./s.sh:1: no such file or directory: \n", 0),
	(
		"in-var",
		"e=; cat < \"$e\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"readlink",
		"readlink /proc/self/fd/0 < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"in-builtin",
		"read x < \"\"; echo \"s=$? x=$x\"",
		"s=1 x=\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"out-ext",
		"echo x > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"append",
		"echo x >> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"clobber",
		"echo x >| \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"noclobber",
		"setopt noclobber; echo x > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"noclobber-append",
		"setopt noclobber; echo x >> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	("rw", "cat <> \"\"; echo \"s=$?\"", "s=1\n", "./s.sh:1: no such file or directory: \n", 0),
	(
		"both",
		"echo x &> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"dup-out",
		"echo x >& \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"err",
		"ls nosuch 2> \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"null-out",
		": > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	("null-in", ": < \"\"", "", "./s.sh:1: no such file or directory: \n", 1),
	(
		"exec-fd",
		"exec 3< \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"exec-fd-out",
		"exec 3> \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"exec-var",
		"exec {fd}< \"\"; echo \"s=$? fd=$fd\"",
		"s=1 fd=\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"group",
		"{ echo in; } < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"subshell",
		"( echo in ) < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"while",
		"while read -r l; do echo \"$l\"; done < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"fn",
		"f() { echo in; }; f < \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"bg",
		"cat < \"\" & wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"pipe",
		"cat < \"\" | cat; echo \"s=$?\"",
		"s=0\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"later",
		"cat < in > \"\"; echo \"s=$?\"; ls",
		"s=1\nfifo\nin\ns.sh\nsub\nx\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"multios",
		"echo x > \"\" > out; echo \"s=$?\"; cat out",
		"s=1\n",
		"./s.sh:1: no such file or directory: \ncat: out: No such file or directory\n",
		1,
	),
	(
		"comsub-file",
		"x=$(< \"\"); echo \"st=$? [$x]\"",
		"st=1 []\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"comsub-cat",
		"x=$(cat < \"\"); echo \"s=$? x=$x\"",
		"s=1 x=\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"fifo-defer-in",
		"/bin/cat > fifo < \"\" & cat fifo; wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"fifo-defer-err",
		"/bin/cat < in > fifo 2> \"\" & cat fifo; wait $!; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: \n",
		0,
	),
	(
		"sysopen",
		"zmodload zsh/system; sysopen -r -u fd \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:sysopen:1: can't open file : no such file or directory\n",
		0,
	),
	(
		"flock",
		"zmodload zsh/system; zsystem flock \"\"; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:zsystem:1: failed to open  for writing: no such file or directory\n",
		0,
	),
	("exec", "exec \"\"; echo \"s=$?\"", "", "./s.sh:1: permission denied: \n", 126),
	(
		"exec-path-dir",
		"mkdir -p p/foo; PATH=$PWD/p:$PATH; exec foo; echo \"s=$?\"",
		"",
		"./s.sh:1: permission denied: foo\n",
		126,
	),
	(
		"exec-hook-empty",
		"command_not_found_handler() { echo \"cnf:[$1]\"; return 3; }; exec \"\"; echo after",
		"",
		"./s.sh:1: permission denied: \n",
		126,
	),
	("sub-exec", "( exec \"\" ); echo \"s=$?\"", "s=126\n", "./s.sh:1: permission denied: \n", 0),
	("command", "\"\"; echo \"s=$?\"", "s=126\n", "./s.sh:1: permission denied: \n", 0),
	("command-exec", "command \"\"; echo \"s=$?\"", "s=126\n", "./s.sh:1: permission denied: \n", 0),
	(
		"hook-empty",
		"command_not_found_handler() { echo \"cnf:[$1]\"; return 3; }; \"\"; echo \"s=$?\"",
		"s=126\n",
		"./s.sh:1: permission denied: \n",
		0,
	),
	(
		"hook-dir",
		"command_not_found_handler() { echo \"cnf:$1\"; return 3; }; mkdir -p p/foo; \
		 PATH=$PWD/p:$PATH; foo; echo \"s=$?\"",
		"s=126\n",
		"./s.sh:1: permission denied: foo\n",
		0,
	),
	(
		"path-dir",
		"mkdir -p p/foo; PATH=$PWD/p:$PATH; foo; echo \"s=$?\"; hash | grep -c foo",
		"s=126\n0\n",
		"./s.sh:1: permission denied: foo\n",
		1,
	),
	(
		"path-noexec",
		"mkdir p; echo : > p/foo; PATH=$PWD/p:$PATH; foo; echo \"s=$?\"; hash | grep -c foo",
		"s=126\n0\n",
		"./s.sh:1: permission denied: foo\n",
		1,
	),
	(
		"path-empty-entry",
		"PATH=:/usr/bin:/bin; \"\"; echo \"s=$?\"",
		"s=126\n",
		"./s.sh:1: permission denied: \n",
		0,
	),
	("path-dot", "PATH=.; \"\"; echo \"s=$?\"", "s=127\n", "./s.sh:1: command not found: \n", 0),
	(
		"path-only-empty",
		"PATH=; \"\"; echo \"s=$?\"",
		"s=127\n",
		"./s.sh:1: command not found: \n",
		0,
	),
	("hash-run", "hash x=; x; echo \"s=$?\"", "s=127\n", "./s.sh:1: command not found: x\n", 0),
	("shebang", "./x; echo \"s=$?\"", "s=126\n", "./s.sh:1: exec format error: ./x\n", 0),
	(
		"shebang-sp",
		"printf \"#!   \\necho hi\\n\" > z; chmod +x z; ./z; echo \"s=$?\"",
		"s=126\n",
		"./s.sh:1: exec format error: ./z\n",
		0,
	),
	(
		"shebang-path",
		"mkdir p; cp x p/y; PATH=$PWD/p:$PATH; y; echo \"s=$?\"",
		"s=126\n",
		"./s.sh:1: exec format error: y\n",
		0,
	),
	(
		"shebang-missing",
		"printf \"#!/nonexistent\\necho hi\\n\" > z; chmod +x z; ./z; echo \"s=$?\"",
		"s=127\n",
		"./s.sh:1: ./z: bad interpreter: /nonexistent: no such file or directory\n",
		0,
	),
	(
		"hook-plain",
		"command_not_found_handler() { echo \"cnf:$1\"; return 3; }; nosuch; echo \"s=$?\"",
		"cnf:nosuch\ns=3\n",
		"",
		0,
	),
	(
		"path-dir-then-exec",
		"mkdir -p p/ls; PATH=$PWD/p:$PATH; ls in; echo \"s=$?\"",
		"in\ns=0\n",
		"",
		0,
	),
	("command-v", "command -v \"\"; echo \"s=$?\"", "s=1\n", "", 0),
	("whence", "whence -p \"\"; echo \"s=$?\"", "s=1\n", "", 0),
	(
		"test",
		"[ -e \"\" ]; echo \"e=$?\"; [ -d \"\" ]; echo \"d=$?\"; [ -f \"\" ]; echo \"f=$?\"; [ -r \
		 \"\" ]; echo \"r=$?\"; [ -x \"\" ]; echo \"x=$?\"; [ -L \"\" ]; echo \"L=$?\"",
		"e=1\nd=1\nf=1\nr=1\nx=1\nL=1\n",
		"",
		0,
	),
	(
		"cond",
		"[[ -e \"\" ]]; echo \"e=$?\"; [[ -d \"\" ]]; echo \"d=$?\"; [[ -r \"\" ]]; echo \"r=$?\"",
		"e=1\nd=1\nr=1\n",
		"",
		0,
	),
	("cd", "cd \"\"; echo \"s=$?\"; [ \"$PWD\" -ef ~ ] && echo here", "s=0\nhere\n", "", 0),
	("cd-P", "cd -P \"\"; echo \"s=$?\"; [ \"$PWD\" -ef ~ ] && echo here", "s=0\nhere\n", "", 0),
	("glob", "echo *", "fifo in s.sh sub x\n", "", 0),
	("glob-dir", "echo s*", "s.sh sub\n", "", 0),
	(
		"missing",
		"cat < nosuch; echo \"s=$?\"",
		"s=1\n",
		"./s.sh:1: no such file or directory: nosuch\n",
		0,
	),
	("dir", "cat < sub; echo \"s=$?\"", "s=1\n", "cat: -: Is a directory\n", 0),
];

/// Rows: zsh 5.9's with `-c`: from a script file zsh names a failed `.` by the
/// file it sourced, a difference of its own.
const ZSH_C: &[Row] = &[
	("dot-c", ". \"\"; echo \"s=$?\"", "s=127\n", "zsh:.:1: no such file or directory: \n", 0),
	(
		"source-c",
		"source \"\"; echo \"s=$?\"",
		"s=127\n",
		"zsh:source:1: no such file or directory: \n",
		0,
	),
];
