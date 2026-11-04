//! The shell reads alias values as Bash 5.3 input, including operators,
//! reserved words, redirections, open quotes and command substitutions.
//!
//! Expected output comes from `bash -c` under Bash 5.3. Bash 5.2.21 agrees
//! except for alias-supplied here-documents and `alias -p` operands.
#![cfg(unix)]

use std::{ffi::OsString, path::Path};

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str) -> String {
	let dir = tempfile::tempdir().expect("tempdir");
	run_in(dir.path(), command).await
}

async fn run_in(cwd: &Path, command: &str) -> String {
	let (tx, rx) = flume::unbounded::<String>();
	execute_shell(
		ShellExecuteOptions {
			command: command.to_owned(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	rx.drain().collect()
}

/// Runs `body` after turning alias expansion on and defining `aliases`.
async fn with_aliases(aliases: &str, body: &str) -> String {
	run(&format!("shopt -s expand_aliases\nalias {aliases}\n{body}")).await
}

// --- alias values that are shell syntax ---

/// B01, B02, B07, B18, B31: lists and pipelines in a value.
#[tokio::test]
async fn alias_value_can_hold_lists_and_pipelines() {
	assert_eq!(with_aliases("q='echo a; echo b'", "q").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a | tr a b'", "q").await, "b\n");
	assert_eq!(with_aliases("q='echo a;'", "q echo b").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a &&'", "q echo b").await, "a\nb\n");
	assert_eq!(with_aliases("q='echo a |'", "q tr a z").await, "z\n");
}

/// B03, B08, B09, B19, B20, B21, B32: compound commands in a value, whole or
/// begun in the value and ended in the input.
#[tokio::test]
async fn alias_value_can_hold_or_begin_compound_commands() {
	assert_eq!(with_aliases("begin='{'", "begin echo braced; }").await, "braced\n");
	assert_eq!(with_aliases("q='if true; then echo yes; fi'", "q").await, "yes\n");
	assert_eq!(with_aliases("q='('", "q echo sub )").await, "sub\n");
	assert_eq!(with_aliases("q='while false; do'", "q :; done; echo end").await, "end\n");
	assert_eq!(with_aliases("q='for i in 1 2; do echo $i; done'", "q").await, "1\n2\n");
	assert_eq!(with_aliases("q='case x in x) echo cx;; esac'", "q").await, "cx\n");
	assert_eq!(with_aliases("q='{ echo in;'", "q }").await, "in\n");
}

/// B05, B28: redirections in a value, before and after the command.
#[tokio::test]
async fn alias_value_can_hold_redirections() {
	assert_eq!(with_aliases("q='echo 2>/dev/null'", "q; echo \"st=$?\"").await, "\nst=0\n");
	assert_eq!(with_aliases("q='>/dev/null echo hidden'", "q; echo \"st=$?\"").await, "st=0\n");
}

/// B10: a here-document begun in a value takes its body from the input.
#[tokio::test]
async fn alias_value_can_begin_a_here_document() {
	assert_eq!(with_aliases("q='cat <<EOF'", "q\nbody\nEOF").await, "body\n");
}

/// B04, B14, B15: a value can open a quote the input closes, end with a
/// backslash that joins the next input line, or span lines.
#[tokio::test]
async fn alias_value_is_read_as_input_text() {
	assert_eq!(with_aliases("q='echo \"unterminated'", "q\nrest\"").await, "unterminated\nrest\n");
	assert_eq!(with_aliases("q='echo x \\'", "q\necho y").await, "x echo y\n");
	assert_eq!(with_aliases("q=$'echo l1\\necho l2'", "q").await, "l1\nl2\n");
}

/// B22, B23: a value can define a function.
#[tokio::test]
async fn alias_value_can_define_a_function() {
	assert_eq!(with_aliases("q='function g { echo fg; }'", "q; g").await, "fg\n");
	assert_eq!(with_aliases("q='g() { echo pg; }'", "q; g").await, "pg\n");
}

/// B24, B12, B25: substitutions and arithmetic in a value.
#[tokio::test]
async fn alias_value_can_hold_substitutions_and_arithmetic() {
	assert_eq!(with_aliases("q='echo $(echo inner)'", "q").await, "inner\n");
	assert_eq!(with_aliases("q='echo $((1+2))'", "q").await, "3\n");
	assert_eq!(with_aliases("q='((x=3)); echo $x'", "q").await, "3\n");
}

/// B30, C33: an alias in a value's later command is substituted too; aliases
/// that name each other stop.
#[tokio::test]
async fn aliases_inside_values_and_cycles() {
	assert_eq!(with_aliases("q='echo a' p='q; echo b'", "p").await, "a\nb\n");
	assert_eq!(with_aliases("a=b b=a", "a 2>/dev/null; echo \"st=$?\"").await, "st=127\n");
}

/// A declaration builtin in a value gets its assignment as an assignment.
#[tokio::test]
async fn alias_value_can_hold_a_declaration_builtin() {
	assert_eq!(with_aliases("q='export X=\"a  b\"'", "q; printenv X").await, "a  b\n");
}

// --- reserved words ---

/// B06: an alias named like a reserved word is substituted where the word is
/// not reserved.
#[tokio::test]
async fn alias_named_like_a_reserved_word_where_it_is_not_reserved() {
	assert_eq!(with_aliases("if='echo not-a-keyword'", "if").await, "not-a-keyword\n");
}

/// B16: an alias substituted for a function's name defines the function under
/// the value's name.
#[tokio::test]
async fn alias_substituted_for_a_function_name() {
	assert_eq!(with_aliases("f=g", "f() { echo in-g; }\ng").await, "in-g\n");
}

// --- POSIX mode: when a substitution's aliases are read ---

/// D01, D02, D04, D06, D09: in POSIX mode a `$( )` or `<( )` substitution gets
/// its aliases when the command around it is read.
#[tokio::test]
async fn posix_mode_substitutions_read_aliases_with_their_command() {
	let early = "set -o posix\nalias q='echo early'\n";
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<$(q)>\"; }}\nalias q='echo late'\nf")).await,
		"<early>\n"
	);
	assert_eq!(run(&format!("{early}f() {{ cat <(q); }}\nalias q='echo late'\nf")).await, "early\n");
	assert_eq!(run(&format!("{early}f() {{ echo \"<$(q)>\"; }}\nunalias q\nf")).await, "<early>\n");
	assert_eq!(run(&format!("{early}x=$(q); echo \"x=$x\"")).await, "x=early\n");
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<$(echo \"$(q)\")>\"; }}\nalias q='echo late'\nf")).await,
		"<early>\n"
	);
}

/// D03, D08, D10: backquoted text is read when it runs, and a substitution
/// read before the alias existed does not get it.
#[tokio::test]
async fn posix_mode_backquotes_read_aliases_when_they_run() {
	let early = "set -o posix\nalias q='echo early'\n";
	assert_eq!(
		run(&format!("{early}f() {{ echo \"<`q`>\"; }}\nalias q='echo late'\nf")).await,
		"<late>\n"
	);
	assert_eq!(
		run("set -o posix\nf() { echo \"<$(q)>\"; }\nalias q='echo late'\nf 2>/dev/null").await,
		"<>\n"
	);
	assert_eq!(
		run(&format!("{early}echo \"<$(q)>\"; alias q='echo late'; echo \"<$(q)>\"")).await,
		"<early>\n<early>\n"
	);
}

// --- alias names and the alias table ---

/// E01, E03, E05, E09: a name holding shell syntax is rejected.
#[tokio::test]
async fn alias_name_with_shell_syntax_is_rejected() {
	for name in ["a/b", "a$b", "a;b", "a(b"] {
		let out = run(&format!("alias '{name}=echo x' 2>/dev/null; echo \"st=$?\"")).await;
		assert_eq!(out, "st=1\n", "name {name}");
	}
}

/// E02, E10: other punctuation is valid; `alias` lists names in order.
#[tokio::test]
async fn alias_name_with_other_punctuation_is_valid() {
	assert_eq!(
		run("alias 'a-b=echo x' '.x=echo y' 'a.b=echo z'; alias").await,
		"alias .x='echo y'\nalias a-b='echo x'\nalias a.b='echo z'\n"
	);
}

/// E23: `alias` and `command -v` quote a value so it reads back.
#[tokio::test]
async fn alias_listing_quotes_values() {
	assert_eq!(
		with_aliases("q=\"it's\"", "command -v q; alias q").await,
		"alias q='it'\\''s'\nalias q='it'\\''s'\n"
	);
}

/// E11: `BASH_ALIASES` reads the alias table.
#[tokio::test]
async fn bash_aliases_reads_the_alias_table() {
	assert_eq!(run("alias q='echo x'; echo \"${BASH_ALIASES[q]}\"").await, "echo x\n");
}

/// E13, E15: unsetting an element or the array leaves the aliases.
#[tokio::test]
async fn unsetting_bash_aliases_leaves_the_aliases() {
	assert_eq!(
		run("alias q='echo x' r='echo y'; unset 'BASH_ALIASES[q]'; alias").await,
		"alias q='echo x'\nalias r='echo y'\n"
	);
	assert_eq!(
		run("alias q='echo x'; unset BASH_ALIASES; alias; echo \"st=$?\"").await,
		"alias q='echo x'\nst=0\n"
	);
}

// --- command -v and -V ---

/// E18, E19, E20, E22: `command -v` and `-V` report aliases (while they are
/// expanded), functions and reserved words.
#[tokio::test]
async fn command_v_reports_aliases_functions_and_reserved_words() {
	assert_eq!(
		with_aliases("q='echo aliased'", "command -v q; command -V q").await,
		"alias q='echo aliased'\nq is aliased to `echo aliased'\n"
	);
	assert_eq!(
		run("f() { echo hi; }; command -v f; command -V f").await,
		"f\nf is a function\nf () \n{ \n    echo hi\n}\n"
	);
	assert_eq!(
		run("command -v if; command -V if; command -v '[['").await,
		"if\nif is a shell keyword\n[[\n"
	);
	assert_eq!(run("alias q='echo x'; command -v q; echo \"st=$?\"").await, "st=1\n");
}

/// G01: a reserved word comes before a function of the same name, as in Bash.
#[tokio::test]
async fn command_v_reports_a_reserved_word_before_a_function() {
	assert_eq!(
		run("function if { echo hi; }; command -V if; command -v if").await,
		"if is a shell keyword\nif\n"
	);
}

// --- a newline inside an alias's value ---

/// G02, G03, G04, G05, G06: a newline in a value ends a complete command,
/// which runs before the rest of the value is read, so the rest is read with
/// the aliases and the option that command left.
#[tokio::test]
async fn newline_in_a_value_runs_the_command_before_it() {
	assert_eq!(with_aliases("q=$'alias r=\"echo NEW\"\\nr'", "q").await, "NEW\n");
	assert_eq!(
		run("shopt -s expand_aliases\nalias r='echo OLD'\nalias q=$'alias r=\"echo NEW\"\\nr'\nq")
			.await,
		"NEW\n"
	);
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias r='echo R'\nalias q=$'shopt -u expand_aliases\\nr'\nq \
			 2>/dev/null; echo \"st=$?\""
		)
		.await,
		"st=127\n"
	);
	assert_eq!(
		run("shopt -s expand_aliases\nalias q=$'alias r=\"echo NEW\"\\nif true; then'\nq r; fi")
			.await,
		"NEW\n"
	);
	assert_eq!(
		with_aliases("q=$'echo one\\nq'", "q 2>/dev/null; echo \"st=$?\"").await,
		"one\nst=127\n"
	);
}

/// G07: a newline in a value does not move the line an error reports.
#[tokio::test]
async fn newline_in_a_value_keeps_error_lines() {
	let out = run("shopt -s expand_aliases\nalias q=$'echo one\\necho two'\nq\n)\necho BAD").await;
	assert!(out.starts_with("one\ntwo\n"), "{out}");
	assert!(out.contains("line 4"), "{out}");
	assert!(!out.contains("BAD"), "{out}");
}

// --- reading long input ---

/// G08: a command continued over many lines (`&&`, `||`, `|` at a line's end)
/// is read in time that grows with its length, not with its square.
#[tokio::test]
async fn long_continued_command_reads_in_linear_time() {
	let mut script = ": &&\n".repeat(6000);
	script.push_str("echo and\n");
	script.push_str(&"false ||\n".repeat(6000));
	script.push_str("echo or\n");
	script.push_str(&"echo piped |\n".repeat(3));
	script.push_str("cat\n");
	let started = std::time::Instant::now();
	let out = run(&script).await;
	let elapsed = started.elapsed();
	assert_eq!(out, "and\nor\npiped\n");
	assert!(elapsed < std::time::Duration::from_secs(20), "took {elapsed:?}");
}

// --- process substitutions read again with aliases ---

/// G09, G10, G11, G12, G13: a here-document inside a compound command or a
/// function in a process substitution still ends at its delimiter when the
/// substitution is read again with aliases.
#[tokio::test]
async fn process_substitution_here_documents_survive_reading_again() {
	let unused = "shopt -s expand_aliases\nalias unused=:\n";
	assert_eq!(
		run(&format!("{unused}cat <(if true; then cat <<EOF\nbody\nEOF\nfi)")).await,
		"body\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(f() {{\ncat <<EOF\nfbody\nEOF\n}}\nf)")).await,
		"fbody\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(while true; do cat <<-EOF\n\twbody\n\tEOF\nbreak; done)")).await,
		"wbody\n"
	);
	// `)` on its own line: brush ends a substitution at the `)` of a `case`
	// pattern line that also holds `esac)`, with or without aliases.
	assert_eq!(
		run(&format!("{unused}cat <(case x in x) cat <<EOF\ncbody\nEOF\n;; esac\n)")).await,
		"cbody\n"
	);
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias say='echo said'\ncat <(if true; then cat <<EOF\nbody \
			 $((1+1))\nEOF\nfi\nsay)"
		)
		.await,
		"body 2\nsaid\n"
	);
}

/// G43, G44: a subshell ending with a here-document, in a process substitution
/// read again with aliases and in `declare -f`, puts its `)` after the
/// delimiter.
#[tokio::test]
async fn subshell_here_document_reads_back() {
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias unused=:\ncat <(if true; then (cat <<EOF\nBODY\nEOF\n); \
			 fi\n)"
		)
		.await,
		"BODY\n"
	);
	assert_eq!(run("f() { (cat <<EOF\nsb\nEOF\n); }\neval \"$(declare -f f)\"; f").await, "sb\n");
}

/// G14: `declare -f` writes a here-document so that reading it back works.
#[tokio::test]
async fn declare_f_here_document_reads_back() {
	assert_eq!(
		run("f() {\nif true; then\ncat <<EOF\nbody\nEOF\nfi\n}\neval \"$(declare -f f)\"\nf").await,
		"body\n"
	);
}

/// G27, G28, G29, G30: a word that holds a newline (a here-document in a
/// command substitution, a quoted string, a here-string) and a nested process
/// substitution keep their text inside a compound command when a process
/// substitution is read again with aliases.
#[tokio::test]
async fn process_substitution_words_with_newlines_survive_reading_again() {
	assert_eq!(
		run(
			"shopt -s expand_aliases\nalias say='echo said'\ncat <(if true; then\necho $(cat \
			 <<EOF\nif-subst\nEOF\n)\nsay\nfi)"
		)
		.await,
		"if-subst\nsaid\n"
	);
	let unused = "shopt -s expand_aliases\nalias unused=:\n";
	assert_eq!(run(&format!("{unused}cat <(if true; then echo \"a\nb\"; fi\n)")).await, "a\nb\n");
	assert_eq!(run(&format!("{unused}cat <(if true; then cat <<<\"a\nb\"; fi\n)")).await, "a\nb\n");
	assert_eq!(run(&format!("{unused}cat <(cat <(cat <<EOF\ninner\nEOF\n))")).await, "inner\n");
	assert_eq!(
		run(&format!("{unused}cat <(if true; then cat <(cat <<EOF\ndeep\nEOF\n); fi\n)")).await,
		"deep\n"
	);
	assert_eq!(run(&format!("{unused}cat <(echo $(cat <<EOF\nsub\nEOF\n))")).await, "sub\n");
}

/// G31, G32, G33, G34: a here-document in the condition of `if`, `elif`,
/// `while` and `until` ends at its delimiter when a process substitution is
/// read again with aliases.
#[tokio::test]
async fn process_substitution_condition_here_documents_survive_reading_again() {
	let unused = "shopt -s expand_aliases\nalias unused=:\n";
	assert_eq!(
		run(&format!("{unused}cat <(if cat <<EOF\nbody\nEOF\nthen echo yes; fi\n)")).await,
		"body\nyes\n"
	);
	assert_eq!(
		run(&format!(
			"{unused}cat <(if false; then :; elif cat <<EOF\nbody\nEOF\nthen echo yes; fi\n)"
		))
		.await,
		"body\nyes\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(while cat <<EOF\nbody\nEOF\ndo break; done\n)")).await,
		"body\n"
	);
	assert_eq!(
		run(&format!("{unused}cat <(until cat <<EOF\nbody\nEOF\ndo break; done\n)")).await,
		"body\n"
	);
}

/// G35, G36, G37: `declare -f` writes words that hold newlines as they are,
/// and a here-document in a condition before `then`, so the printed function
/// reads back.
#[tokio::test]
async fn declare_f_words_and_conditions_read_back() {
	assert_eq!(
		run(
			"f() {\nif true; then\necho $(cat <<EOF\nin-subst\nEOF\n)\nfi\n}\neval \"$(declare -f \
			 f)\"\nf"
		)
		.await,
		"in-subst\n"
	);
	assert_eq!(
		run("f() {\nif true; then\necho \"x\ny\"\nfi\n}\neval \"$(declare -f f)\"\nf").await,
		"x\ny\n"
	);
	assert_eq!(
		run("f() { if cat <<EOF\nbody\nEOF\nthen echo yes; fi; }\neval \"$(declare -f f)\"; f").await,
		"body\nyes\n"
	);
}

/// G38, G39: an alias in a process substitution can begin a here-document
/// whose body is on the lines after it.
#[tokio::test]
async fn process_substitution_alias_begins_a_here_document() {
	assert_eq!(
		run("shopt -s expand_aliases\nalias q='cat <<EOF'\ncat <(q\nBODY\nEOF\n)").await,
		"BODY\n"
	);
	assert_eq!(
		run("shopt -s expand_aliases\ncat <(alias q='cat <<EOF'\nq\nBODY\nEOF\n)").await,
		"BODY\n"
	);
}

/// Bash 5.3 reads a here-document from the remaining alias text before it
/// resumes the source. Bash 5.2.21 instead executes that text after the body.
#[tokio::test]
async fn here_document_body_includes_remaining_alias_text() {
	assert_eq!(
		with_aliases("q=$'cat <<EOF\\necho AFTER'", "q\nbody\nEOF\necho DONE").await,
		"echo AFTER\nbody\nDONE\n"
	);
	assert_eq!(
		with_aliases("q=$'cat <<EOF\\nfrom-alias'", "q\nfrom-input\nEOF\necho next").await,
		"from-alias\nfrom-input\nnext\n"
	);
	assert_eq!(
		with_aliases("q=$'cat <<EOF\\necho AFTER'", "if true; then\nq\nbody\nEOF\nfi\necho DONE")
			.await,
		"echo AFTER\nbody\nDONE\n"
	);
}

/// An alias ending at a here-document's newline must not add a blank body
/// line. Bash 5.3 treats later redirections in the alias as body text.
#[tokio::test]
async fn here_document_body_begins_on_the_next_input_line() {
	assert_eq!(with_aliases("q=$'cat <<EOF\\n'", "q\nBODY\nEOF\necho DONE").await, "BODY\nDONE\n");
	assert_eq!(
		with_aliases("q=$'cat <<EOF\\n'", "q #COMMENT\nBODY\nEOF\necho DONE").await,
		"BODY\nDONE\n"
	);
	assert_eq!(
		with_aliases(
			"q=$'cat <<A\\ncat <<B\\necho AFTER'",
			"TWO() { printf 'TWO-ran\\n'; }\nB() { printf 'B-ran\\n'; }\nq; echo SUFFIX\nONE\nA\nTWO\nB\necho DONE"
		)
		.await,
		"cat <<B\necho AFTER; echo SUFFIX\nONE\nTWO-ran\nB-ran\nDONE\n"
	);
}

/// G51, G52, G53, G54, G55, G56: the blank after an alias's name stays in the
/// input, read after the value: a value ending in a backslash escapes it, and
/// a value that opens a quote takes it into the quoted text.
#[tokio::test]
async fn blank_after_an_alias_name_is_read_after_the_value() {
	assert_eq!(with_aliases("q='echo Q\\'", "q word").await, "Q word\n");
	assert_eq!(with_aliases("q='printf \"<%s>\\n\" \"'", "q word\"").await, "< word>\n");
	assert_eq!(with_aliases("q='echo Q\\'", "q\tword").await, "Q\tword\n");
	assert_eq!(with_aliases("q='echo Q\\'", "q ;echo NEXT").await, "Q \nNEXT\n");
	assert_eq!(
		run("shopt -s expand_aliases\nalias r='echo R\\'\nalias q='r '\nq word").await,
		"R  word\n"
	);
	assert_eq!(with_aliases("q='echo Q\\'", "eval 'q word'").await, "Q word\n");
}

/// G61, G62, G63: a value ending in a backslash, read at the end of the
/// input, continues the line: the end of the input stands for its newline.
#[tokio::test]
async fn backslash_ending_a_value_at_the_end_of_input_continues_the_line() {
	assert_eq!(with_aliases("q='echo Q\\'", "q").await, "Q\n");
	assert_eq!(with_aliases("q='echo Q\\'", "eval q").await, "Q\n");
	assert_eq!(with_aliases("q='echo Q\\'", "echo \"[$(q)]\"").await, "[Q]\n");
}

/// G64 to G69 (`oracle-r7.sh`): a value ending in 3, 7, ... backslashes gets
/// a blank read after it, which its last backslash escapes; one ending in 1,
/// 5, ... has its last backslash escape the input's next character; at the end
/// of the input that backslash is dropped.
#[tokio::test]
async fn trailing_backslashes_follow_bash() {
	let three = "q='printf \"<%s>|\" A\\\\\\'";
	let five = "q='printf \"<%s>|\" A\\\\\\\\\\'";
	let seven = "q='printf \"<%s>|\" A\\\\\\\\\\\\\\'";
	assert_eq!(with_aliases(three, "q").await, "<A\\ >|");
	assert_eq!(with_aliases(three, "q word").await, "<A\\ >|<word>|");
	assert_eq!(with_aliases(five, "q").await, "<A\\\\>|");
	assert_eq!(with_aliases(five, "q word").await, "<A\\\\ word>|");
	assert_eq!(with_aliases(seven, "q").await, "<A\\\\\\ >|");
	assert_eq!(with_aliases(seven, "q word").await, "<A\\\\\\ >|<word>|");
}

/// Bash 5.3 `alias -p` lists aliases and ignores the remaining operands.
#[tokio::test]
async fn alias_p_lists_without_defining_operands() {
	assert_eq!(
		run("alias a=1; alias -p x=new; echo \"st=$?\"; alias").await,
		"alias a='1'\nst=0\nalias a='1'\n"
	);
}

/// Alias-end lookahead, unlike an ordinary escaped blank, does not make a
/// trailing newline part of the pathname in a command substitution.
#[tokio::test]
async fn alias_tail_backslashes_preserve_real_command_substitution_filenames() {
	for (count, expected) in [(1, "F"), (3, "F\\ ")] {
		let dir = tempfile::tempdir().expect("tempdir");
		let command = format!(
			"shopt -s expand_aliases\nalias q='touch F{}'\necho \"[$(q )]\"",
			"\\".repeat(count)
		);
		assert_eq!(run_in(dir.path(), &command).await, "[]\n");
		let names: Vec<OsString> = std::fs::read_dir(dir.path())
			.expect("created files")
			.map(|entry| entry.expect("directory entry").file_name())
			.collect();
		assert_eq!(names, [OsString::from(expected)], "backslashes: {count}");
	}
}

/// An escaped quote in an ANSI-C alias word does not end that quote. The
/// original blank after the alias name supplies the pathname's one blank.
#[tokio::test]
async fn ansi_c_quote_split_across_an_alias_creates_the_bash_filename() {
	let dir = tempfile::tempdir().expect("tempdir");
	let command = r#"shopt -s expand_aliases
alias q='touch $'"'"'A\'"'"'B\\'
q '"#;
	assert_eq!(run_in(dir.path(), command).await, "");
	let names: Vec<OsString> = std::fs::read_dir(dir.path())
		.expect("created files")
		.map(|entry| entry.expect("directory entry").file_name())
		.collect();
	assert_eq!(names, [OsString::from("A'B\\ ")]);
}

/// Backquotes read successive commands with the aliases earlier commands
/// defined, including when the outer shell's alias table began empty.
#[tokio::test]
async fn backquotes_read_later_lines_after_their_alias_definitions() {
	for mode in ["shopt -s expand_aliases", "set -o posix"] {
		assert_eq!(run(&format!("{mode}\necho \"[`alias q='echo NEXT'\nq`]\"")).await, "[NEXT]\n");
	}
}

#[tokio::test]
async fn backquotes_report_syntax_errors_after_alias_expansion_is_disabled() {
	let out = with_aliases(
		"q='printf Q'",
		"shopt -u expand_aliases; printf '<%s>\\n' `q \"`\necho DONE",
	)
	.await;
	assert!(out.contains("unexpected EOF"), "{out}");
	assert!(out.ends_with("<>\nDONE\n"), "{out}");
}
