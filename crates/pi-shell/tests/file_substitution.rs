//! `$(< file)` reads the file in the shell itself, as bash and zsh do: no
//! subshell runs the `< file`. Each row runs `obash -c` (as `bash`, or as
//! `zsh -f`) in a directory holding `f` (`hello` and two blank lines), `e`
//! (empty), `n` (`x`, no newline) and the directory `dd`, and checks stdout,
//! stderr and the status against what bash 5.3.20 or zsh 5.9 print for the
//! same script there (bash 5.2.21 agrees with 5.3.20 on every bash row but
//! the last, where it names the function's line `environment: line 1:`).

mod obash_support;

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

use crate::obash_support::{obash, output};

/// `(script, stdout, stderr, status)`.
type Row = (&'static str, &'static str, &'static str, i32);

/// bash's message for the file `missing`.
const MISSING: &str = "bash: line 1: missing: No such file or directory\n";

/// Run `script` as `name` (`bash` or `zsh`) in a fresh directory holding the
/// rows' files: stdout, stderr, status.
fn run(name: &str, script: &str) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	std::fs::write(dir.path().join("f"), "hello\n\n\n").unwrap();
	std::fs::write(dir.path().join("e"), "").unwrap();
	std::fs::write(dir.path().join("n"), "x").unwrap();
	std::fs::create_dir(dir.path().join("dd")).unwrap();
	let mut cmd = obash();
	#[cfg(unix)]
	cmd.arg0(name);
	if name == "zsh" {
		cmd.arg("-f");
	}
	let out = output(cmd.current_dir(dir.path()).args(["-c", script]));
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// Every row of `rows` run as `name`; the mismatches listed together.
fn check(name: &str, rows: &[Row]) {
	let mut mismatches = Vec::new();
	for &(script, out, err, status) in rows {
		let got = run(name, script);
		if got != (out.to_owned(), err.to_owned(), status) {
			mismatches.push(format!("{script:?}\n  want {:?}\n  got  {got:?}", (out, err, status)));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

#[cfg(unix)]
#[test]
fn bash_reads_a_file_substitution_in_the_shell() {
	let missing = MISSING;
	check("bash", &[
		("false; echo \"[$(< f)]\" $?", "[hello] 0\n", "", 0),
		("false; echo \"[$(< missing)]\" $?", "[] 1\n", missing, 0),
		("x=$(< missing); echo \"st=$?\"", "st=1\n", missing, 0),
		("x=$(< e); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("x=$(< n); echo \"st=$? [$x]\"", "st=0 [x]\n", "", 0),
		// A read error is no failure: bash's `read_comsub` ends the value.
		("x=$(< dd); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("g=f; x=$(< $g); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		// A substitution in the name: the body is the `< word` after its block.
		("x=$(< $(echo f)); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(< \"$(echo f)\"); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(0< f); echo \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		// The `< file` is no command: no DEBUG trap or `BASH_COMMAND` for it.
		(
			"set -T; trap 'echo \"D:$BASH_COMMAND\"' DEBUG; x=$(< f); trap - DEBUG; echo \"[$x]\"",
			"D:x=$(< f)\nD:trap - DEBUG\n[hello]\n",
			"",
			0,
		),
		(
			"trap 'echo \"ERR:$BASH_COMMAND\"' ERR; x=$(< missing); echo \"st=$?\"",
			"ERR:x=$(< missing)\nst=1\n",
			missing,
			0,
		),
		("set -x; x=$(< f); set +x", "", "+ x=hello\n+ set +x\n", 0),
		// The word expands in the shell: `set -u` ends it.
		(
			"set -u; x=$(< $undef); echo \"st=$? [$x]\"",
			"",
			"bash: line 1: undef: unbound variable\n",
			127,
		),
		("set -e; x=$(< missing); echo after", "", missing, 1),
		("false; x=$(< f); echo \"st=$?\"", "st=0\n", "", 0),
		("x=$(< f)$(< missing); echo \"st=$? [$x]\"", "st=1 [hello]\n", missing, 0),
		("x=$(< f) y=$(false); echo \"st=$?\"", "st=1\n", "", 0),
		("x=$(< /dev/null); echo \"st=$? [$x]\"", "st=0 []\n", "", 0),
		// bash 5.3.20's prefix; 5.2.21 prints `environment: line 1:` here.
		(
			"f() { echo \"[$(< \"$1\")]\"; }; f f; f missing; echo \"st=$?\"",
			"[hello]\n[]\nst=0\n",
			missing,
			0,
		),
	]);
}

#[cfg(unix)]
#[test]
fn zsh_reads_a_file_substitution_in_the_shell() {
	check("zsh", &[
		// `$?` is left alone on success (zsh sets it only on failure).
		("false; print \"[$(< f)]\" $?", "[hello] 1\n", "", 0),
		(
			"false; print \"[$(< missing)]\" $?",
			"[] 1\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		("x=$(< e); print \"st=$? [$x]\"", "st=0 []\n", "", 0),
		("x=$(< n); print \"st=$? [$x]\"", "st=0 [x]\n", "", 0),
		(
			"x=$(< dd); print \"st=$? [$x]\"",
			"st=1 []\n",
			"zsh:1: error when reading dd: is a directory\n",
			0,
		),
		("g=f; x=$(< $g); print \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(< $(print f)); print \"st=$? [$x]\"", "st=0 [hello]\n", "", 0),
		("x=$(<f); print \"[$x]\"", "[hello]\n", "", 0),
		// The name is not globbed.
		("x=$(< f*); print \"st=$? [$x]\"", "st=1 []\n", "zsh:1: no such file or directory: f*\n", 0),
		(
			"TRAPZERR() { print \"ERR:$?\" }; x=$(< missing); print \"st=$?\"",
			"ERR:1\nst=1\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		// No command runs for the `< f`: no DEBUG trap, no trace line.
		(
			"TRAPDEBUG() { print \"D:$ZSH_DEBUG_CMD\" }; x=$(< f); unfunction TRAPDEBUG; print \
			 \"[$x]\"",
			"D:x=$(< f) \nD:unfunction TRAPDEBUG\n[hello]\n",
			"",
			0,
		),
		(
			"setopt xtrace; x=$(< f); unsetopt xtrace",
			"",
			"+zsh:1> x=hello \n+zsh:1> unsetopt xtrace\n",
			0,
		),
		(
			"setopt errexit; x=$(< missing); print after",
			"",
			"zsh:1: no such file or directory: missing\n",
			1,
		),
		(
			"x=$(< f)$(< missing); print \"st=$? [$x]\"",
			"st=1 [hello]\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		// The failed read's message once, though the word expands again for
		// the second file; its status stays.
		(
			"x=$(< missing)$(< f); print \"st=$? [$x]\"",
			"st=1 [hello]\n",
			"zsh:1: no such file or directory: missing\n",
			0,
		),
		("x=$(< /dev/null); print \"st=$? [$x]\"", "st=0 []\n", "", 0),
	]);
}
