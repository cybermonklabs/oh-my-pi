//! A process substitution's name and the fds zsh hands out from 10,
//! through the obash binary. zsh mode runs in a new empty directory both
//! as `zsh -f` reading the script from its standard input (a file) and as
//! `zsh -f -c`: the name is zsh's `PATH_DEV_FD` (`/proc/self/fd` on Linux,
//! `/dev/fd` elsewhere) and the fd zsh's `mpipe` picks (both ends of the
//! pipe moved to the lowest free fds from 10, the shell keeping the read
//! end of `<(…)` and the write end of `>(…)`). Under `-c` zsh keeps its
//! own input (`SHIN`, /dev/null) at fd 10, so its `{var}`, `sysopen`,
//! `zsystem flock`, `zsocket -l` and `zpty` fds start at 11; the commands
//! of a process substitution or `=(…)` start without it. Expected output
//! from zsh 5.9 on Linux run the same two ways, `@fd` standing for the
//! prefix. bash mode runs as `bash --norc --noprofile -c` and keeps bash's
//! `/dev/fd/63` counting down (bash 5.2.21 and 5.3.20 print the same on
//! every bash row).

#![cfg(unix)]

mod obash_support;

use std::{fs, os::unix::process::CommandExt, process::Command};

use crate::obash_support::{obash, output};

/// zsh's `PATH_DEV_FD` here: zsh's configure takes `/proc/self/fd` where it
/// reopens a descriptor.
const DEV_FD: &str = if cfg!(target_os = "linux") {
	"/proc/self/fd"
} else {
	"/dev/fd"
};

/// stdout, stderr and status.
type Outcome = (&'static str, &'static str, i32);

/// A zsh row.
struct Row {
	name:    &'static str,
	script:  &'static str,
	/// `zsh -f < script`.
	stdin:   Outcome,
	/// `zsh -f -c script`.
	command: Outcome,
}

const ROWS: &[Row] = &[
	Row {
		name:    "in",
		script:  "echo <(true)",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "out",
		script:  "echo >(true)",
		stdin:   ("@fd/11\n", "", 0),
		command: ("@fd/12\n", "", 0),
	},
	Row {
		name:    "two-in",
		script:  "echo <(true) <(true)",
		stdin:   ("@fd/10 @fd/11\n", "", 0),
		command: ("@fd/11 @fd/12\n", "", 0),
	},
	Row {
		name:    "in-out",
		script:  "echo <(true) >(true)",
		stdin:   ("@fd/10 @fd/12\n", "", 0),
		command: ("@fd/11 @fd/13\n", "", 0),
	},
	Row {
		name:    "out-in",
		script:  "echo >(true) <(true)",
		stdin:   ("@fd/11 @fd/10\n", "", 0),
		command: ("@fd/12 @fd/11\n", "", 0),
	},
	Row {
		name:    "in-out-in",
		script:  "echo <(true) >(true) <(true)",
		stdin:   ("@fd/10 @fd/12 @fd/11\n", "", 0),
		command: ("@fd/11 @fd/13 @fd/12\n", "", 0),
	},
	Row {
		name:    "function",
		script:  "f() { echo <(true); }; f",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "cmdsub",
		script:  "echo \"$(echo <(true))\"",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "background",
		script:  "{ echo <(true); } & wait",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "subshell",
		script:  "( echo <(true) )",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "nested",
		script:  "cat <(echo <(true))",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/10\n", "", 0),
	},
	Row {
		name:    "nested-two",
		script:  "cat <(echo <(true) >(true))",
		stdin:   ("@fd/10 @fd/12\n", "", 0),
		command: ("@fd/10 @fd/12\n", "", 0),
	},
	Row {
		name:    "fds-10-12",
		script:  "exec {a}</dev/null {b}</dev/null {c}</dev/null; echo $a $b $c <(true) >(true)",
		stdin:   ("10 11 12 @fd/13 @fd/15\n", "", 0),
		command: ("11 12 13 @fd/14 @fd/16\n", "", 0),
	},
	Row {
		name:    "fd-var-after",
		script:  "exec {a}</dev/null; echo $a <(true); exec {b}</dev/null; echo $b",
		stdin:   ("10 @fd/11\n11\n", "", 0),
		command: ("11 @fd/12\n12\n", "", 0),
	},
	Row {
		name:    "fd-var-in-command",
		script:  "echo <(true) {a}>/dev/null; echo $a",
		stdin:   ("@fd/10\n11\n", "", 0),
		command: ("@fd/11\n12\n", "", 0),
	},
	Row {
		name:    "fds-3-9",
		script:  "exec 3</dev/null 4</dev/null 5</dev/null 6</dev/null 7</dev/null 8</dev/null \
		          9</dev/null; echo <(true) >(true)",
		stdin:   ("@fd/10 @fd/12\n", "", 0),
		command: ("@fd/11 @fd/13\n", "", 0),
	},
	Row {
		name:    "fd-var-in-procsub",
		script:  "cat <(exec {a}</dev/null; echo $a <(true))",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("10 @fd/11\n", "", 0),
	},
	Row {
		name:    "fd-var-in-subshell",
		script:  "( exec {a}</dev/null; echo $a <(true) )",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("11 @fd/12\n", "", 0),
	},
	Row {
		name:    "dot-break",
		script:  "for i in 1 2; do . <(echo 'break'); done; true",
		stdin:   (
			"",
			"@fd/10:break:1: not in while, until, select, or repeat loop\n@fd/10:break:1: not in \
			 while, until, select, or repeat loop\n",
			0,
		),
		command: (
			"",
			"@fd/11:break:1: not in while, until, select, or repeat loop\n@fd/11:break:1: not in \
			 while, until, select, or repeat loop\n",
			0,
		),
	},
	Row {
		name:    "dot-error",
		script:  ". <(echo 'nosuchcmd_psn')",
		stdin:   ("", "@fd/10:1: command not found: nosuchcmd_psn\n", 127),
		command: ("", "@fd/11:1: command not found: nosuchcmd_psn\n", 127),
	},
	Row {
		name:    "dot-argzero",
		script:  "source <(echo 'echo $0')",
		stdin:   ("@fd/10\n", "", 0),
		command: ("@fd/11\n", "", 0),
	},
	Row {
		name:    "open-by-path",
		script:  "f() { read y < $1; echo $y; while read -r l; do echo \"[$l]\"; done < $2; }; f \
		          <(echo via-path) <(printf 'a\\nb\\n')",
		stdin:   ("via-path\n[a]\n[b]\n", "", 0),
		command: ("via-path\n[a]\n[b]\n", "", 0),
	},
	Row {
		name:    "pipeline-word",
		script:  "echo <(echo x) | read p; echo ${p%/*}",
		stdin:   ("@fd\n", "", 0),
		command: ("@fd\n", "", 0),
	},
	Row {
		name:    "external-reads",
		script:  "cat <(echo ext); wc -c < <(printf abc)",
		stdin:   ("ext\n3\n", "", 0),
		command: ("ext\n3\n", "", 0),
	},
	Row {
		name:    "fd-var",
		script:  "exec {a}</dev/null; echo $a",
		stdin:   ("10\n", "", 0),
		command: ("11\n", "", 0),
	},
	Row {
		name:    "cmdsub-fd-var",
		script:  "echo $(exec {a}</dev/null; echo $a)",
		stdin:   ("10\n", "", 0),
		command: ("11\n", "", 0),
	},
	Row {
		name:    "eq-subst",
		script:  "cat =(exec {a}</dev/null; echo $a <(true))",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("10 @fd/11\n", "", 0),
	},
	Row {
		name:    "eq-subst-sub",
		script:  "cat =( (exec {a}</dev/null; echo $a) )",
		stdin:   ("10\n", "", 0),
		command: ("10\n", "", 0),
	},
	Row {
		name:    "sysopen",
		script:  "zmodload zsh/system; sysopen -r -u fd /dev/null; echo $fd <(true)",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("11 @fd/12\n", "", 0),
	},
	Row {
		name:    "flock",
		script:  "zmodload zsh/system; : > lk; zsystem flock -f fd lk; echo $fd <(true)",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("11 @fd/12\n", "", 0),
	},
	Row {
		name:    "zsocket",
		script:  "zmodload zsh/net/socket; zsocket -l sock; echo $REPLY <(true)",
		stdin:   ("10 @fd/11\n", "", 0),
		command: ("11 @fd/12\n", "", 0),
	},
	Row {
		name:    "zpty",
		script:  "zmodload zsh/zpty; zpty z cat; exec {a}</dev/null; echo $a <(true); zpty -d z",
		stdin:   ("11 @fd/12\n", "", 0),
		command: ("12 @fd/13\n", "", 0),
	},
];

/// A bash row: stdout, stderr and status of `bash --norc --noprofile -c`.
struct BashRow {
	name:     &'static str,
	script:   &'static str,
	expected: Outcome,
}

const BASH_ROWS: &[BashRow] = &[
	BashRow { name: "in", script: "echo <(true)", expected: ("/dev/fd/63\n", "", 0) },
	BashRow { name: "out", script: "echo >(true)", expected: ("/dev/fd/63\n", "", 0) },
	BashRow {
		name:     "two-in",
		script:   "echo <(true) <(true)",
		expected: ("/dev/fd/63 /dev/fd/62\n", "", 0),
	},
	BashRow {
		name:     "in-out",
		script:   "echo <(true) >(true)",
		expected: ("/dev/fd/63 /dev/fd/62\n", "", 0),
	},
	BashRow {
		name:     "function",
		script:   "f() { echo <(true); }; f",
		expected: ("/dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "cmdsub",
		script:   "echo \"$(echo <(true))\"",
		expected: ("/dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "background",
		script:   "{ echo <(true); } & wait",
		expected: ("/dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "subshell",
		script:   "( echo <(true) )",
		expected: ("/dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "nested",
		script:   "cat <(echo <(true))",
		expected: ("/dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "fds-10-12",
		script:   "exec 10</dev/null 11</dev/null 12</dev/null; echo <(true) >(true)",
		expected: ("/dev/fd/63 /dev/fd/62\n", "", 0),
	},
	BashRow {
		name:     "fd-63-taken",
		script:   "exec 63</dev/null; echo <(true) >(true)",
		expected: ("/dev/fd/62 /dev/fd/61\n", "", 0),
	},
	BashRow {
		name:     "fd-var",
		script:   "exec {a}</dev/null; echo $a <(true)",
		expected: ("10 /dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "dot-argzero",
		script:   "source <(echo 'echo $0 $BASH_SOURCE')",
		expected: ("bash /dev/fd/63\n", "", 0),
	},
	BashRow {
		name:     "open-by-path",
		script:   "f() { read y < $1; echo $y; }; f <(echo via-path)",
		expected: ("via-path\n", "", 0),
	},
	BashRow {
		name:     "external-reads",
		script:   "cat <(echo ext); wc -c < <(printf abc)",
		expected: ("ext\n3\n", "", 0),
	},
];

/// stdout, stderr and status of `cmd`.
fn outcome(cmd: &mut Command) -> (String, String, i32) {
	let out = output(cmd);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// Run `script` with the obash binary as `zsh -f` reading it from its
/// standard input, in a new empty directory.
fn zsh_stdin(script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let path = dir.path().join(".script");
	fs::write(&path, format!("{script}\n")).unwrap();
	let mut cmd = obash();
	cmd.arg0("zsh")
		.current_dir(dir.path())
		.arg("-f")
		.stdin(fs::File::open(&path).unwrap());
	outcome(&mut cmd)
}

/// Run `script` with the obash binary as `zsh -f -c script`, in a new empty
/// directory.
fn zsh_command(script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash();
	cmd.arg0("zsh")
		.current_dir(dir.path())
		.args(["-f", "-c", script]);
	outcome(&mut cmd)
}

/// A row's expected output with `@fd` spelled for this platform.
fn spelled((out, err, status): Outcome) -> (String, String, i32) {
	(out.replace("@fd", DEV_FD), err.replace("@fd", DEV_FD), status)
}

/// The rows whose output differs, one line each.
fn differing<'a>(
	rows: impl Iterator<Item = (&'a str, (String, String, i32), (String, String, i32))>,
) -> Vec<String> {
	rows
		.filter(|(_, got, want)| got != want)
		.map(|(name, got, want)| format!("{name}: got {got:?}, zsh {want:?}"))
		.collect()
}

#[test]
fn zsh_names_a_process_substitution_as_zsh_reading_its_standard_input() {
	let wrong = differing(
		ROWS
			.iter()
			.map(|r| (r.name, zsh_stdin(r.script), spelled(r.stdin))),
	);
	assert!(
		wrong.is_empty(),
		"{} of {} rows differ:\n{}",
		wrong.len(),
		ROWS.len(),
		wrong.join("\n")
	);
}

#[test]
fn zsh_skips_its_own_input_fd_under_c() {
	let wrong = differing(
		ROWS
			.iter()
			.map(|r| (r.name, zsh_command(r.script), spelled(r.command))),
	);
	assert!(
		wrong.is_empty(),
		"{} of {} rows differ:\n{}",
		wrong.len(),
		ROWS.len(),
		wrong.join("\n")
	);
}

#[test]
fn bash_names_a_process_substitution_from_fd_63_down() {
	let wrong: Vec<String> = BASH_ROWS
		.iter()
		.filter_map(|r| {
			let mut cmd = obash();
			cmd.arg0("bash")
				.args(["--norc", "--noprofile", "-c", r.script]);
			let got = outcome(&mut cmd);
			let want = (r.expected.0.to_owned(), r.expected.1.to_owned(), r.expected.2);
			(got != want).then(|| format!("{}: got {got:?}, bash {want:?}", r.name))
		})
		.collect();
	assert!(
		wrong.is_empty(),
		"{} of {} rows differ:\n{}",
		wrong.len(),
		BASH_ROWS.len(),
		wrong.join("\n")
	);
}
