//! A program found through `$PATH` is named as bash built its file name:
//! `dir/name` with the entry as written (`./s` for `PATH=.` or an empty
//! entry, `bin/u`, `../s`), not the absolute path the search probed
//! (`D/./s`). That is a script's `$0`, the name in the messages, and the
//! hash table's entry (`hash -l`, `BASH_CMDS`). A later run reads a
//! relative entry as bash's `phash_search` does (so do `hash -t`, `type`
//! and `command -v`): `./bin/u` while that is an executable file, else
//! `bin/u` as it is; an entry in the current directory itself (`./s`) is
//! searched again after a `cd` takes the file away.
//!
//! Goldens: bash 5.3.20, measured in a cluster Job (bash 5.2.21 agrees).
//! Each row runs as `-c` and as a script file, in a directory of its own:
//! in the expected stderr `PFX` is the messages' prefix (the shell's name
//! under `-c`, `D/s.sh` from the script).
#![cfg(unix)]

mod obash_support;

use std::fs;

use crate::obash_support::{obash, output};

/// A row: the script, its stdout, its stderr (`PFX` as above) and status.
type Row = (&'static str, &'static str, &'static str, i32);

/// Each row as `-c` and as a script: one line per mismatch.
fn mismatches(rows: &[Row]) -> Vec<String> {
	let sh = env!("CARGO_BIN_EXE_obash");
	let mut out = Vec::new();
	for &(code, want_out, want_err, want_status) in rows {
		for script in [false, true] {
			let tmp = tempfile::tempdir().unwrap();
			let dir = fs::canonicalize(tmp.path()).unwrap();
			let d = dir.to_str().unwrap().to_owned();
			let mut cmd = obash();
			cmd.current_dir(&dir)
				.env("PATH", "/usr/bin:/bin")
				.env("LC_ALL", "C");
			let prefix = if script {
				let file = dir.join("s.sh");
				fs::write(&file, code).unwrap();
				cmd.arg(&file);
				"D/s.sh"
			} else {
				cmd.args(["-c", code]);
				"SH"
			};
			let o = output(&mut cmd);
			let norm = |b: &[u8]| {
				String::from_utf8_lossy(b)
					.replace(sh, "SH")
					.replace(&d, "D")
			};
			let got = (norm(&o.stdout), norm(&o.stderr), o.status.code());
			let want = (want_out.to_owned(), want_err.replace("PFX", prefix), Some(want_status));
			if got != want {
				let how = if script { "script" } else { "-c" };
				out.push(format!("{code:?} ({how}): got {got:?}, want {want:?}"));
			}
		}
	}
	out
}

fn check(rows: &[Row]) {
	let wrong = mismatches(rows);
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn a_script_found_through_a_relative_entry_is_named_by_it() {
	check(&[
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s"#, "./s\n", "", 0),
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=:$PATH; s"#, "./s\n", "", 0),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u"#,
			"bin/u\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=./bin:$PATH; u"#,
			"./bin/u\n",
			"",
			0,
		),
		(
			r#"printf "echo \$0\n" > s; chmod +x s; mkdir sub; cd sub; PATH=..:$PATH; s"#,
			"../s\n",
			"",
			0,
		),
		// Control: an absolute entry names the absolute file.
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=$PWD:$PATH; s"#, "D/s\n", "", 0),
	]);
}

#[test]
fn the_messages_name_the_file_as_bash_built_it() {
	check(&[
		(
			r#": > f; PATH=.:$PATH; f; echo "st=$?""#,
			"st=126\n",
			"PFX: line 1: ./f: Permission denied\n",
			0,
		),
		(
			r#"printf "a\0b\n" > b2; chmod +x b2; PATH=.:$PATH; b2; echo "st=$?""#,
			"st=126\n",
			"PFX: line 1: ./b2: cannot execute binary file: Exec format error\n",
			0,
		),
		// From the hash table: `./bin/b2` while it is an executable file,
		// `bin/u` once it is not.
		(
			r#"mkdir bin; printf "a\0b\n" > bin/b2; chmod +x bin/b2; PATH=bin:$PATH; b2; b2; echo "st=$?""#,
			"st=126\n",
			"PFX: line 1: bin/b2: cannot execute binary file: Exec format error\nPFX: line 1: \
			 ./bin/b2: cannot execute binary file: Exec format error\n",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u; chmod -x bin/u; u; echo "st=$?""#,
			"bin/u\nst=126\n",
			"PFX: line 1: bin/u: Permission denied\n",
			0,
		),
	]);
}

#[test]
fn the_hash_table_keeps_the_name() {
	check(&[
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; hash -t s"#, "./s\n./s\n", "", 0),
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; s"#, "./s\n./s\n", "", 0),
		// A later run, `hash -t`, `type` and `command -v` read a relative
		// entry as `./entry`; `hash -l` shows the entry as it is.
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u; u; hash -t u"#,
			"bin/u\n./bin/u\n./bin/u\n",
			"",
			0,
		),
		(
			r#"printf "echo \$0\n" > s; chmod +x s; mkdir sub; cd sub; PATH=..:$PATH; s; s; hash -t s"#,
			"../s\n./../s\n./../s\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; hash -r; u; type u; command -v u; hash -l"#,
			"bin/u\nu is hashed (./bin/u)\n./bin/u\nbuiltin hash -p bin/u u\n",
			"",
			0,
		),
		// `checkhash` runs the checked file and keeps the entry.
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; shopt -s checkhash; PATH=bin:$PATH; hash -r; u; u; hash -l"#,
			"bin/u\n./bin/u\nbuiltin hash -p bin/u u\n",
			"",
			0,
		),
	]);
}

#[test]
fn a_hashed_entry_is_read_from_the_current_directory() {
	check(&[
		// `./s` is searched again once a `cd` takes it away...
		(
			r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; mkdir sub; cd sub; s; echo "st=$?""#,
			"./s\nst=127\n",
			"PFX: line 1: s: command not found\n",
			0,
		),
		(
			r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; mkdir sub; cd sub; hash -t s; echo "st=$?""#,
			"./s\nst=1\n",
			"PFX: line 1: hash: s: not found\n",
			0,
		),
		// ...and the new directory's `./s` runs.
		(
			r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; mkdir sub; printf "echo other \$0\n" > sub/s; chmod +x sub/s; cd sub; s"#,
			"./s\nother ./s\n",
			"",
			0,
		),
		// Another relative entry runs as it is, from the new directory.
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=./bin:$PATH; u; mkdir sub; cd sub; u; echo "st=$?""#,
			"./bin/u\nst=127\n",
			"PFX: line 1: ./bin/u: No such file or directory\n",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u; mkdir sub; cd sub; u; echo "st=$?"; hash -t u; type u"#,
			"bin/u\nst=127\nbin/u\nu is hashed (bin/u)\n",
			"PFX: line 1: bin/u: No such file or directory\n",
			0,
		),
		(
			r#"mkdir -p w/sub; printf "echo \$0\n" > w/s; chmod +x w/s; cd w/sub; PATH=..:$PATH; s; cd ..; s; echo "st=$?""#,
			"../s\nst=127\n",
			"PFX: line 1: ../s: No such file or directory\n",
			0,
		),
	]);
}
