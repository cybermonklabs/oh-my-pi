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

/// `exec` of a program the hash table gave from a relative entry names it
/// as bash's `full_pathname` does: the working directory, `/` and the
/// entry less one leading `./` (bash 5.3.20; the review's rows y1, y2,
/// y3, y5, y19 for the entry `./bin/u`, and y25: only one leading `./` goes).
#[test]
fn exec_of_a_hashed_relative_entry_names_its_full_path() {
	check(&[
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u >/dev/null; exec u"#,
			"D/bin/u\n",
			"",
			0,
		),
		(
			r#"printf "echo \$0\n" > s; chmod +x s; mkdir sub; cd sub; PATH=..:$PATH; s >/dev/null; exec s"#,
			"D/sub/../s\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u >/dev/null; chmod -x bin/u; exec u"#,
			"",
			"PFX: line 1: D/bin/u: Permission denied\n",
			126,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; hash -p bin/u u; exec u"#,
			"D/bin/u\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=./bin:$PATH; u >/dev/null; exec u"#,
			"D/bin/u\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; hash -p ././bin/u u; exec u"#,
			"D/./bin/u\n",
			"",
			0,
		),
	]);
}

/// A search that tries the hashed file first (`checkhash`) names the file
/// by what found it: the hash table's entry when it is that file, the
/// `$PATH` entry when the hashed file is gone and the search goes on
/// (bash 5.3.20, row y21).
#[test]
fn a_checkhash_search_names_the_file_by_what_found_it() {
	check(&[(
		r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; mkdir m; printf "echo \$0\n" > m/u; chmod +x m/u; shopt -s checkhash; PATH=bin:m:$PATH; u; rm bin/u; u"#,
		"bin/u\nm/u\n",
		"",
		0,
	)]);
}

/// `exec` of a program a relative `$PATH` entry found names it by its full
/// path, one leading `./` dropped, also after a first run hashed it as
/// `./s` (bash 5.3.20; the review's rows n2, n15, n17, x45, x10, and y26:
/// only one leading `./` goes).
#[test]
fn exec_of_a_relative_find_names_its_full_path() {
	check(&[
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; exec s"#, "D/s\n", "", 0),
		(r": > f; PATH=.:$PATH; exec f", "", "PFX: line 1: D/f: Permission denied\n", 126),
		(r##"printf "#!/bin/sh\necho \$0\n" > t; chmod +x t; PATH=.:$PATH; exec t"##, "D/t\n", "", 0),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=./bin:$PATH; exec u"#,
			"D/bin/u\n",
			"",
			0,
		),
		(r#"printf "echo \$0\n" > s; chmod +x s; PATH=.:$PATH; s; exec s"#, "./s\nD/s\n", "", 0),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=././bin:$PATH; exec u"#,
			"D/./bin/u\n",
			"",
			0,
		),
	]);
}

/// `hash -t` reads an entry whose `./entry` is not executable as the entry
/// itself (bash 5.3.20; the review's row n27).
#[test]
fn hash_t_of_a_non_executable_entry_reads_the_entry() {
	check(&[(
		r#"mkdir bin; printf "echo \$0\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u; chmod -x bin/u; u; echo "st=$?"; hash -t u"#,
		"bin/u\nst=126\nbin/u\n",
		"PFX: line 1: bin/u: Permission denied\n",
		0,
	)]);
}

/// `type` and `command -v` of two hashed names count one hit each, as
/// bash's `phash_search` does per lookup (bash 5.3.20; the review's row
/// y9).
#[test]
fn type_of_two_names_counts_one_hit_each() {
	check(&[(
		r#"mkdir bin; printf "echo \$0\n" > bin/u; printf "echo \$0\n" > bin/v; chmod +x bin/u bin/v; PATH=bin:$PATH; hash -r; u; v; type u v; command -v u v; hash"#,
		"bin/u\nbin/v\nu is hashed (./bin/u)\nv is hashed \
		 (./bin/v)\n./bin/u\n./bin/v\nhits\tcommand\n   3\tbin/v\n   3\tbin/u\n",
		"",
		0,
	)]);
}

/// `type -P` reads the hash table and counts the hit, `type -a` lists every
/// meaning without reading it and counts none, as bash's `describe_command`
/// does (bash 5.3.20, rows y23 and y24).
#[test]
fn type_p_counts_a_hit_and_type_a_none() {
	check(&[
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; printf "echo \$0\n" > bin/v; chmod +x bin/u bin/v; PATH=bin:$PATH; hash -r; u; v; type -P u v; hash"#,
			"bin/u\nbin/v\n./bin/u\n./bin/v\nhits\tcommand\n   2\tbin/v\n   2\tbin/u\n",
			"",
			0,
		),
		(
			r#"mkdir bin; printf "echo \$0\n" > bin/u; printf "echo \$0\n" > bin/v; chmod +x bin/u bin/v; PATH=bin:$PATH; hash -r; u; v; type -a u v >/dev/null; hash"#,
			"bin/u\nbin/v\nhits\tcommand\n   1\tbin/v\n   1\tbin/u\n",
			"",
			0,
		),
	]);
}

/// An assignment to `PATH` empties the hash table, one that changes the
/// variable in place included, and so does the end of a function whose
/// `local PATH` goes away: the next command is searched with the `PATH`
/// in effect, so the new program runs (bash's `sv_path`; bash 5.3.20, rows
/// f1, f2 and f9). `m/u` prints `new`, `bin/u` prints `old`.
#[test]
fn a_path_assignment_empties_the_hash_table() {
	check(&[
		(
			r#"mkdir m bin; printf "echo new\n" > m/u; chmod +x m/u; printf "echo old\n" > bin/u; chmod +x bin/u; PATH=bin:$PATH; u; PATH=$PWD/m:$PATH; u"#,
			"old\nnew\n",
			"",
			0,
		),
		(
			r#"mkdir m bin; printf "echo new\n" > m/u; chmod +x m/u; printf "echo old\n" > bin/u; chmod +x bin/u; export PATH=bin:$PATH; u; export PATH=$PWD/m:$PATH; u"#,
			"old\nnew\n",
			"",
			0,
		),
		(
			r#"mkdir m bin; printf "echo new\n" > m/u; chmod +x m/u; printf "echo old\n" > bin/u; chmod +x bin/u; f() { local PATH=$PWD/m:$PATH; u; }; PATH=bin:$PATH; u; f; u"#,
			"old\nnew\nold\n",
			"",
			0,
		),
	]);
}
