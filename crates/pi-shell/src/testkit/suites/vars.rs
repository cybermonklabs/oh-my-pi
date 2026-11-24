//! Variables: assignment with attributes (also on the in-place fast path),
//! `$RANDOM`, name references, dynamic scoping of `local`/`unset`,
//! `local -`, the temporary environment of `export`/`readonly`, `shopt`
//! and `SHELLOPTS`, array conversions, associative-array order, arrays
//! filled by `mapfile` and its callbacks.
//! Goldens: bash 5.3.20 (`bash -c`).

use bstr::BString;

use crate::{
	bash::{EventMask, Script, ShellInit},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init, run_script},
};

fn run(src: &str) -> (String, String) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
	)
}

#[test]
fn background_children_keep_each_loop_value() {
	let (out, err) = run("for h in alpha beta; do ( echo \"bg:$h\" ) & done; wait");
	let mut lines: Vec<_> = out.lines().collect();
	lines.sort_unstable();
	assert_eq!(lines, ["bg:alpha", "bg:beta"]);
	assert_eq!(err, "");
}

#[test]
fn background_children_keep_absent_and_unset_globals() {
	let (out, err) = run(
		"unset later; kept=before; ( echo \"${later-absent}:${kept-absent}\" ) & later=after; unset \
		 kept; wait",
	);
	assert_eq!(out, "absent:before\n");
	assert_eq!(err, "");
}

#[test]
fn background_children_keep_function_locals_and_arguments() {
	let (out, err) = run(
		"v=global; f() { local v=local; ( echo \"$v:$1:$#\"; printf '<%s>\\n' \"$@\" ) & v=changed; \
		 set -- changed; }; f one 'two words'; wait; echo \"$v\"",
	);
	let mut lines: Vec<_> = out.lines().collect();
	lines.sort_unstable();
	assert_eq!(lines, ["<one>", "<two words>", "global", "local:one:2"]);
	assert_eq!(err, "");
}

#[test]
fn nested_background_children_keep_overlays_and_isolate_writes() {
	let (out, err) = run(
		"v=root; a=(root); ( v=outer; a[0]=outer; ( echo \"nested:$v:${a[0]}\"; v+=child; \
		 a[0]+=child; echo \"child:$v:${a[0]}\" ) & v=changed; a[0]=changed; wait; echo \
		 \"outer:$v:${a[0]}\" ); echo \"root:$v:${a[0]}\"",
	);
	assert_eq!(
		out,
		"nested:outer:outer\nchild:outerchild:outerchild\nouter:changed:changed\nroot:root:root\n"
	);
	assert_eq!(err, "");
}

#[test]
fn background_children_keep_function_definitions_and_shell_options() {
	let (out, err) = run(
		"f() { echo old; }; set +f; shopt -u nullglob; ( f; type -t later; case $- in *f*) echo \
		 noglob;; *) echo glob;; esac; shopt -q nullglob; echo \"nullglob:$?\" ) & f() { echo new; \
		 }; later() { :; }; set -f; shopt -s nullglob; wait",
	);
	assert_eq!(out, "old\nglob\nnullglob:1\n");
	assert_eq!(err, "");
}

#[test]
fn background_children_keep_aliases_traps_umask_and_command_hashes() {
	let (out, err) = run(
		"alias tag='echo old'; trap 'echo old' USR1; umask 022; hash -p /old tool; ( alias tag; \
		 trap -p USR1; umask; hash -t tool; type -t printf ) & alias tag='echo new'; trap 'echo \
		 new' USR1; umask 077; hash -p /new tool; enable -n printf; wait",
	);
	assert_eq!(out, "alias tag='echo old'\ntrap -- 'echo old' SIGUSR1\n0022\n/old\nbuiltin\n");
	assert_eq!(err, "");
}

#[test]
fn background_self_referencing_local_reads_the_fork_global() {
	let (out, err) = run("v=before; f() { local -n v=v; ( echo \"$v\" ) & }; f; v=after; wait");
	assert_eq!(out, "before\n");
	assert!(err.contains("circular name reference"), "{err}");
}

#[test]
fn child_global_edits_start_from_fork_values_and_specials_stay_computed() {
	let (out, err) = run(
		"v=before; a=(before); ( v+=child; a[0]+=child; echo \"$v:${a[0]}:$BASH_SUBSHELL\"; ( echo \
		 \"depth:$BASH_SUBSHELL\" ); false; echo \"status:$?\" ) & v=after; a[0]=after; wait; echo \
		 \"$v:${a[0]}\"",
	);
	assert_eq!(out, "beforechild:beforechild:1\ndepth:2\nstatus:1\nafter:after\n");
	assert_eq!(err, "");
}

#[test]
fn attributes_apply_on_every_assignment() {
	let (out, err) = run(
		"a=4+1; typeset -i a; a+=37; echo $a\ndeclare -ia iarr=(2 2 3); iarr+=1; declare -p \
		 iarr\ndeclare -u up=abc; up+=def; echo $up\ndeclare -l lo; lo=ABC; lo+=DeF; echo \
		 $lo\ndeclare -c ca; ca=hello; echo $ca\nreadonly ro=1; ro=2; echo \"st=$? ro=$ro\"\ns=ab; \
		 s+=cd; echo $s\nx=(1 2); x+=(3 4); x[1]=b; x[1]+=c; echo \"${x[@]}\"\n",
	);
	assert_eq!(
		out,
		"42\ndeclare -ai iarr=([0]=\"3\" [1]=\"2\" [2]=\"3\")\nABCDEF\nabcdef\nHello\nabcd\n1 bc 3 \
		 4\n"
	);
	assert_eq!(err, "bash: line 6: ro: readonly variable\n");
}

#[test]
fn random_is_seeded_by_assignment() {
	let (out, _) = run("RANDOM=42; echo $RANDOM $RANDOM $RANDOM; RANDOM=1+1; echo $RANDOM");
	assert_eq!(out, "17772 26794 1435\n846\n");
}

/// A subshell, a background job and a command substitution draw `$RANDOM`
/// from their own copy of the generator: neither their draws nor their
/// `RANDOM=` move the shell's sequence (bash keeps it in process memory).
/// The shell's first value after `RANDOM=7` is 19344 with or without the
/// child.
#[test]
fn random_children_leave_the_shell_sequence() {
	for child in [
		"( : $RANDOM $RANDOM )",
		"( : $RANDOM $RANDOM ) & wait",
		"x=$(echo $RANDOM $RANDOM)",
		"( RANDOM=99 ) & wait",
		"( RANDOM=99; : $RANDOM )",
	] {
		let (out, err) = run(&format!("RANDOM=7; {child}; echo $RANDOM"));
		assert_eq!((out.as_str(), err.as_str()), ("19344\n", ""), "{child}");
	}
}

/// bash reseeds a subshell's generator on its first `$RANDOM` unless the
/// subshell assigned `RANDOM` first (`get_random_number`'s
/// `seeded_subshell`): an unseeded child does not continue the shell's
/// sequence (19344 after `RANDOM=7`), a seeded one repeats it.
#[test]
fn random_subshell_reseeds_unless_assigned() {
	let (out, err) = run(
		"RANDOM=7; u=$(echo $RANDOM); s=$(RANDOM=7; echo $RANDOM); n=$RANDOM; [ \"$u\" != 19344 ] \
		 && echo own; echo $s $n",
	);
	assert_eq!((out.as_str(), err.as_str()), ("own\n19344 19344\n", ""));
}

/// bash looks a special `RANDOM` up, and so draws, as many times as each
/// builtin, assignment and expansion looks the name up (`find_variable`
/// runs `get_random`): `declare -i RANDOM` twice, `${RANDOM:0}` three
/// times, `let 'RANDOM[1]=8'` four. Each form runs after `RANDOM=5`; the
/// next `$RANDOM` shows how many it drew (18498, 29338, 982, 6493, 16756
/// are the first five values after `RANDOM=5`). One form or more per
/// `dynvars::Site` and per cell of its expansion table. Goldens from bash
/// 5.3.20.
#[test]
fn random_draws_as_often_as_bash_looks_it_up() {
	for (form, want) in [
		("declare RANDOM", "[] 29338\n"),
		("export RANDOM", "[] 29338\n"),
		("declare -p RANDOM > /dev/null", "[] 29338\n"),
		("declare -i RANDOM", "[] 982\n"),
		("declare -g RANDOM", "[] 982\n"),
		("declare RANDOM+=1", "[] 889\n"),
		("declare -n RANDOM 2> /dev/null", "[] 6493\n"),
		("f() { local RANDOM; }; f", "[] 16756\n"),
		("f() { declare -p RANDOM; }; f", "declare -i RANDOM=\"18498\"\n[] 29338\n"),
		("export RANDOM+=1", "[] 1187\n"),
		("declare 'RANDOM[1]=8'", "[] 18498\n"),
		("RANDOM[1]=8", "[] 29338\n"),
		("printf -v 'RANDOM[1]' 8", "[] 29338\n"),
		("RANDOM+=(8)", "[] 18498\n"),
		("read -a RANDOM <<< 8", "[] 8\n"),
		("((RANDOM+=1))", "[] 13373\n"),
		("((RANDOM[1]=8))", "[] 982\n"),
		("x=$((RANDOM[1]=8))", "[8] 982\n"),
		("let 'RANDOM[1]=8'", "[] 6493\n"),
		("x=$((RANDOM[0]))", "[29338] 982\n"),
		("x=$((RANDOM[1]))", "[0] 982\n"),
		("declare -n r=RANDOM; r+=1", "[] 889\n"),
		("declare -n r=RANDOM; ((r=7))", "[] 19344\n"),
		("declare -n r='RANDOM[1]'; r=8", "[] 982\n"),
		("RANDOM=7 true", "[] 29338\n"),
		("f() { :; }; RANDOM=7 f", "[] 29338\n"),
		("for x in $RANDOM; do :; done", "[18498] 29338\n"),
		("unset 'RANDOM[1]' 2>/dev/null", "[] 29338\n"),
		("test -v RANDOM", "[] 29338\n"),
		("[[ -v RANDOM ]]", "[] 29338\n"),
		("[[ -v RANDOM[1] ]]", "[] 982\n"),
		("declare -n r=RANDOM; [[ -v r ]]", "[] 29338\n"),
		("n=RANDOM; x=${!n}", "[18498] 29338\n"),
		("declare -n r=RANDOM; x=${!r}", "[RANDOM] 29338\n"),
		("x=${!RANDOM[@]}", "[0] 29338\n"),
		("x=$RANDOM", "[18498] 29338\n"),
		("x=${RANDOM}", "[18498] 29338\n"),
		("x=${RANDOM:0}", "[18498] 6493\n"),
		("x=${RANDOM@a}", "[i] 6493\n"),
		("x=${#RANDOM}", "[5] 29338\n"),
		("x=${RANDOM[0]-y}", "[29338] 982\n"),
		("x=${RANDOM[0]:0}", "[6493] 16756\n"),
		("x=${RANDOM[0]@a}", "[i] 16756\n"),
		("x=${RANDOM[1]-y}", "[y] 982\n"),
		("x=${RANDOM[1]:0}", "[] 982\n"),
		("x=${RANDOM[1]@a}", "[i] 16756\n"),
		("x=${RANDOM[@]}", "[29338] 982\n"),
		("x=${RANDOM[@]:0}", "[29338] 6493\n"),
		("x=${RANDOM[@]@a}", "[i] 6493\n"),
		("x=${#RANDOM[@]}", "[1] 29338\n"),
		("declare -n r=RANDOM; x=$r", "[18498] 29338\n"),
		("declare -n r=RANDOM; x=$((r))", "[18498] 29338\n"),
		("declare -n r=RANDOM; echo \"$r\" ${r} > /dev/null", "[] 982\n"),
		("x=${!RANDOM}", "[] 982\n"),
		("x=$((RANDOM))", "[18498] 29338\n"),
		// A value that seeds nothing shows the lookups before it.
		("for RANDOM in '1+'; do :; done 2> /dev/null", "[] 29338\n"),
		("set -k; true RANDOM=7; set +k", "[] 29338\n"),
		("set -k; true RANDOM=$RANDOM; set +k", "[] 982\n"),
	] {
		let src = format!("RANDOM=5; {form}; echo \"[${{x-}}] $RANDOM\"");
		assert_eq!(run(&src), (want.to_owned(), String::new()), "{form}");
	}
	// bash's `${#NAME[-1]}` of a scalar fails, naming the subscript, also
	// before anything assigned or read `RANDOM`.
	for src in
		["RANDOM=5; x=${#RANDOM[-1]}; echo \"[${x-}] $RANDOM\"", "x=${#RANDOM[-1]}; echo \"[$x]\""]
	{
		let (out, err) = run(src);
		assert_eq!(out, "", "{src}");
		assert!(err.ends_with("line 1: [-1]: bad array subscript\n"), "{src}: {err}");
	}
}

/// bash applies a subshell's redirections in the child, after the fork: a
/// `$RANDOM` there draws from the child's generator and leaves the shell's
/// sequence and value cell alone. A group's, a function's and a builtin's
/// are the shell's. Goldens from bash 5.3.20.
#[test]
fn random_in_a_subshells_redirections_is_the_childs() {
	for (form, want) in [
		("( : ) > f$RANDOM", "[] 18498\n"),
		("( : $RANDOM ) > f$RANDOM", "[] 18498\n"),
		("( : ) > f$RANDOM; RANDOM+=1", "[] 2539\n"),
		("( : ) > f$RANDOM & wait", "[] 18498\n"),
		("{ :; } > f$RANDOM & wait", "[] 18498\n"),
		("true > f$RANDOM", "[] 29338\n"),
		("{ true; } > f$RANDOM", "[] 29338\n"),
		("f() { :; }; f > f$RANDOM", "[] 29338\n"),
	] {
		let src = format!("RANDOM=5; {form}; echo \"[${{x-}}] $RANDOM\"");
		assert_eq!(run(&src), (want.to_owned(), String::new()), "{form}");
	}
}

/// A readonly `RANDOM` refuses `((RANDOM=5))`, `unset RANDOM` and
/// `declare -a RANDOM` (bash 5.3.20) after the lookups bash makes there,
/// and stays special: after `RANDOM=7` and `readonly RANDOM` (one lookup),
/// the arithmetic assignment and `unset` look it up once, `declare -a`
/// twice. Goldens from bash 5.3.20.
#[test]
fn random_readonly_refusals_look_it_up_first() {
	for (src, want, diag) in [
		(
			"RANDOM=7; readonly RANDOM; ((RANDOM=5)); echo \"st=$? $RANDOM\"",
			"st=1 7409\n",
			"line 1: RANDOM: readonly variable\n",
		),
		(
			"RANDOM=7; readonly RANDOM; unset RANDOM; echo \"st=$? $RANDOM\"",
			"st=1 7409\n",
			"line 1: unset: RANDOM: cannot unset: readonly variable\n",
		),
		(
			"RANDOM=7; readonly RANDOM; declare -a RANDOM; echo \"st=$? $RANDOM\"",
			"st=1 20442\n",
			"line 1: declare: RANDOM: readonly variable\n",
		),
	] {
		let (out, err) = run(src);
		assert_eq!(out, want, "{src}");
		assert!(err.ends_with(diag), "{src}: {err}");
	}
}

/// A builtin that a command substitution in text it expands itself, or a
/// file probe, parks runs again from its start; an assignment's value that
/// parks is expanded again. The lookups of `RANDOM` before the park are
/// made once, as bash makes them once. Each form runs with events on and
/// off: with them off a builtin first runs on the fast path, which hands
/// its replay log to the staged re-run. Goldens from bash 5.3.20.
#[test]
fn random_lookups_happen_once_when_a_command_runs_again() {
	for (form, want) in [
		("a=(1); declare RANDOM a='($(echo 2))'", "[] 29338\n"),
		("declare -a RANDOM='($(echo 7))'", "[] 7\n"),
		("f() { local -a RANDOM a='($(echo 2))'; }; f", "[] 16756\n"),
		("test -v RANDOM -a -e /", "[] 29338\n"),
		("[ -v RANDOM -a -e / ]", "[] 29338\n"),
		("[[ -v RANDOM && -e / ]]", "[] 29338\n"),
		("unset 'RANDOM[$(echo 1)]' 2>/dev/null", "[] 29338\n"),
		("a=(1 2); unset RANDOM 'a[$(echo 1)]'; x=${#a[@]}", "[1] \n"),
		("[[ -v RANDOM[$(echo 0)] ]]", "[] 982\n"),
		("RANDOM=7 x=$(echo 1) true", "[] 29338\n"),
		("RANDOM=$(echo 7) true", "[] 29338\n"),
		("RANDOM=7 x=$RANDOM true", "[] 29338\n"),
		("RANDOM=$RANDOM true", "[] 982\n"),
		("x=${RANDOM}$(echo 1)", "[184981] 29338\n"),
		("x=$((RANDOM))$(echo 1)", "[184981] 29338\n"),
	] {
		let src = format!("RANDOM=5; {form}; echo \"[${{x-}}] $RANDOM\"");
		assert_eq!(run(&src), (want.to_owned(), String::new()), "{form}");
		let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
		rig.shell().set_event_mask(EventMask::NONE);
		rig.run(Script::command(src.into_bytes()), Fault::None);
		let out = String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned();
		let err = String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned();
		assert_eq!((out.as_str(), err.as_str()), (want, ""), "{form} (events off)");
	}
}

/// bash's `RANDOM=` (`assign_random`): the value is arithmetic while
/// `RANDOM` is integer (it is from the start), else a decimal number; one
/// that is neither seeds nothing. The variable's value is then the seed,
/// the text `RANDOM+=` adds to, as it is the last draw after a read. A
/// temporary or local `RANDOM` is a plain variable; the shell's sequence
/// goes on after it. Goldens from bash 5.3.20.
#[test]
fn random_assignment_seeds_as_bash_does() {
	for (src, want) in [
		("RANDOM=abc; echo $RANDOM; RANDOM=0; echo $RANDOM", "20814\n20814\n"),
		(
			"RANDOM=5; declare +i RANDOM; RANDOM=1+6; echo $RANDOM; RANDOM=7; echo $RANDOM",
			"982\n19344\n",
		),
		("x=7; RANDOM=x; echo $RANDOM", "19344\n"),
		(
			"RANDOM=4294967303; echo $RANDOM; RANDOM=4294967303; declare -p RANDOM",
			"19344\ndeclare -i RANDOM=\"19344\"\n",
		),
		("for RANDOM in 7; do echo $RANDOM; done", "19344\n"),
		("read RANDOM <<< 7; echo $RANDOM", "19344\n"),
		("printf -v RANDOM 7; echo $RANDOM", "19344\n"),
		("declare -n r=RANDOM; r=7; echo $RANDOM", "19344\n"),
		("declare -i x; x='RANDOM=7'; echo $x $RANDOM", "7 19344\n"),
		("RANDOM=7; RANDOM+=1; echo $RANDOM", "3386\n"),
		("RANDOM=7; x=$RANDOM; RANDOM+=1; echo $x $RANDOM", "19344 4086\n"),
		("RANDOM=7; ((RANDOM+=1)); echo $RANDOM", "4086\n"),
		("RANDOM=7; declare RANDOM+=1; echo $RANDOM", "9530\n"),
		("f() { echo $RANDOM $RANDOM; }; RANDOM=7 f; RANDOM=7; echo $RANDOM", "7 7\n19344\n"),
		("RANDOM=5; RANDOM=7 declare -p RANDOM; echo $RANDOM", "declare -x RANDOM=\"7\"\n29338\n"),
		("RANDOM=5; RANDOM=$RANDOM eval 'echo $RANDOM'; echo $RANDOM", "29338\n982\n"),
		("RANDOM=7; readonly RANDOM; echo $RANDOM $RANDOM", "26956 7409\n"),
		("RANDOM=7; readonly RANDOM; declare -p RANDOM", "declare -ir RANDOM=\"26956\"\n"),
		(
			"f() { local RANDOM; echo \"[$RANDOM]\"; RANDOM=5; echo $RANDOM $RANDOM; }; f; RANDOM=7; \
			 echo $RANDOM",
			"[]\n5 5\n19344\n",
		),
		(
			"f() { local RANDOM=5; g; }; g() { echo $RANDOM; RANDOM=6; echo $RANDOM; }; f; RANDOM=7; \
			 echo $RANDOM",
			"5\n6\n19344\n",
		),
		(
			"f() { local RANDOM; ((RANDOM=5)); echo $RANDOM $RANDOM; }; f; RANDOM=7; echo $RANDOM",
			"5 5\n19344\n",
		),
		("f() { local RANDOM=5; declare -p RANDOM; }; f", "declare -- RANDOM=\"5\"\n"),
		("f() { local -i RANDOM=2+3; echo $RANDOM; }; f", "5\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `unset RANDOM` and an element, compound or array-attribute assignment
/// (bash's `convert_var_to_array`) make the shell's `RANDOM` a plain
/// variable for good, in children too: an array's element 0 is the last
/// value and the array is integer. A local's `unset` is only the local's.
/// Goldens from bash 5.3.20.
#[test]
fn random_unset_and_array_forms_make_it_plain() {
	for (src, want) in [
		("unset RANDOM; echo \"[$RANDOM]\"; RANDOM=5; echo $RANDOM $RANDOM", "[]\n5 5\n"),
		("unset RANDOM; (echo \"[$RANDOM]\"); RANDOM=5; (echo $RANDOM)", "[]\n5\n"),
		("unset RANDOM; declare -i RANDOM; RANDOM=1+1; echo $RANDOM", "2\n"),
		(
			"f() { local RANDOM=5; unset RANDOM; echo \"[$RANDOM]\"; }; f; RANDOM=7; echo $RANDOM",
			"[]\n19344\n",
		),
		(
			"RANDOM[0]=7; echo \"$RANDOM $RANDOM\"; declare -p RANDOM",
			"7 7\ndeclare -ai RANDOM=([0]=\"7\")\n",
		),
		(
			"RANDOM=7; RANDOM[1]=8; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"26956\" [1]=\"8\")\n",
		),
		("RANDOM=7; RANDOM[-1]=8; declare -p RANDOM", "declare -ai RANDOM=([0]=\"8\")\n"),
		(
			"RANDOM=(7 8); echo \"$RANDOM\"; declare -p RANDOM",
			"7\ndeclare -ai RANDOM=([0]=\"7\" [1]=\"8\")\n",
		),
		("RANDOM=7; RANDOM=([1]=8); declare -p RANDOM", "declare -ai RANDOM=([1]=\"8\")\n"),
		(
			"read -a RANDOM <<< \"7 8\"; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"7\" [1]=\"8\")\n",
		),
		(
			"mapfile -t RANDOM <<< $'7\\n8'; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"7\" [1]=\"8\")\n",
		),
		("RANDOM=7; declare -a RANDOM; declare -p RANDOM", "declare -ai RANDOM=([0]=\"26956\")\n"),
		("RANDOM=7; declare -A RANDOM; declare -p RANDOM", "declare -Ai RANDOM=([0]=\"26956\" )\n"),
		("((RANDOM[0]=7)); declare -p RANDOM", "declare -ai RANDOM=([0]=\"7\")\n"),
		(
			"RANDOM=7; let 'RANDOM[1]=8'; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"20442\" [1]=\"8\")\n",
		),
		(
			"RANDOM=7; declare 'RANDOM[1]=8'; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"19344\" [1]=\"8\")\n",
		),
		(
			"RANDOM=7; : ${RANDOM[1]:=8}; declare -p RANDOM",
			"declare -ai RANDOM=([0]=\"20442\" [1]=\"8\")\n",
		),
		(
			"f() { local RANDOM; RANDOM[0]=5; echo \"$RANDOM\"; }; f; RANDOM=7; echo $RANDOM",
			"5\n19344\n",
		),
		("RANDOM[0]=5; RANDOM=7; echo $RANDOM $RANDOM", "7 7\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `declare -p`, `set`, `export -p` and the environment show the value the
/// last lookup or assignment left in `RANDOM` and `SECONDS` (`declare -p
/// RANDOM` looks it up first; the listings do not); `${RANDOM@a}`,
/// `${RANDOM@A}` and the keys read it as a scalar; a name reference to it
/// reads it as the name does. Goldens from bash 5.3.20 and 5.2.21.
#[test]
#[expect(
	clippy::literal_string_with_formatting_args,
	reason = "Bash parameter expansion is intentional fixture syntax, not Rust formatting."
)]
fn random_and_seconds_show_their_last_value() {
	let set_line = |name: &str| {
		format!("set | while IFS= read -r l; do [[ $l == {name}=* ]] && echo \"$l\"; done")
	};
	// The name after `declare -FLAGS ` (bash's `BASH_EXECUTION_STRING` line
	// holds the script text, so a substring test would match it too).
	let declare_line = |name: &str| {
		format!(
			"declare -p | while IFS= read -r l; do n=${{l#declare -* }}; [[ ${{n%%=*}} == {name} ]] \
			 && echo \"$l\"; done"
		)
	};
	for (src, want) in [
		(
			"RANDOM=7; declare -p RANDOM; echo $RANDOM".to_owned(),
			"declare -i RANDOM=\"19344\"\n26956\n",
		),
		(
			"RANDOM=7; echo $RANDOM; declare -p RANDOM".to_owned(),
			"19344\ndeclare -i RANDOM=\"26956\"\n",
		),
		(format!("RANDOM=7; {}; echo $RANDOM", set_line("RANDOM")), "RANDOM=7\n19344\n"),
		(format!("RANDOM=7; x=$RANDOM; {}", set_line("RANDOM")), "RANDOM=19344\n"),
		(
			format!("RANDOM=7; {}; echo $RANDOM", declare_line("RANDOM")),
			"declare -i RANDOM=\"7\"\n19344\n",
		),
		(
			"RANDOM=7; export RANDOM; export -p | while IFS= read -r l; do [[ $l == *' RANDOM='* ]] \
			 && echo \"$l\"; done"
				.to_owned(),
			"declare -ix RANDOM=\"19344\"\n",
		),
		(format!("SECONDS=100; {}", set_line("SECONDS")), "SECONDS=100\n"),
		(format!("SECONDS=100; {}", declare_line("SECONDS")), "declare -- SECONDS=\"100\"\n"),
		("RANDOM=7; echo ${RANDOM@a}; readonly RANDOM; echo ${RANDOM@a}".to_owned(), "i\nir\n"),
		(
			"RANDOM=7; echo ${RANDOM@A}; export RANDOM; echo ${RANDOM@A}".to_owned(),
			"declare -i RANDOM='19344'\ndeclare -ix RANDOM='22989'\n",
		),
		("RANDOM=7; echo \"${!RANDOM[@]}\" \"${!RANDOM[*]}\"".to_owned(), "0 0\n"),
		("echo \"${!SECONDS[@]}\" ${SECONDS@a}".to_owned(), "0 i\n"),
		("RANDOM=7; declare -n r=RANDOM; echo $r $r".to_owned(), "19344 26956\n"),
		(
			"RANDOM=7; declare -n r=RANDOM; echo \"$r\" ${r} ${r:-x} ${#r} $RANDOM".to_owned(),
			"19344 26956 7409 5 22989\n",
		),
		("RANDOM=7; declare -n r=RANDOM; echo ${r[0]}".to_owned(), "26956\n"),
		("declare -n s=SECONDS; s=100; echo $SECONDS $s".to_owned(), "100 100\n"),
	] {
		assert_eq!(run(&src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `${!prefix@}`, `${!prefix*}` and `compgen -v` list bash's dynamic
/// variables, which this shell computes on use (`dynvars::LISTED`):
/// `FUNCNAME` only in a function, `PIPESTATUS` once a command ran,
/// `RANDOM` and `SECONDS` not after `unset` until they are assigned.
/// Goldens from bash 5.3.20 and 5.2.21.
#[test]
fn dynamic_variables_are_listed_by_name() {
	let (out, err) = run(
		"compgen -v PIPESTATUS; echo \"st=$?\"; compgen -v PIPESTATUS; f() { compgen -v FUNCNAME; \
		 }; f; compgen -v FUNCNAME || echo none; for n in RANDOM SRANDOM SECONDS EPOCHSECONDS \
		 EPOCHREALTIME LINENO BASH_COMMAND BASH_CMDS BASH_ALIASES DIRSTACK BASHPID BASH_SUBSHELL \
		 PIPESTATUS BASH_SOURCE BASH_LINENO BASH_ARGC BASH_ARGV; do eval \"set -- \\${!$n@}\"; s=-; \
		 for v; do [ \"$v\" = $n ] && s=@; done; eval \"set -- \\${!$n*}\"; for v; do [ \"$v\" = $n \
		 ] && s+=*; done; for v in $(compgen -v $n); do [ \"$v\" = $n ] && s+=c; done; echo \"$n \
		 $s\"; done; unset RANDOM SECONDS; echo \"[${!RANDOM@}] [${!SECONDS*}]\"; compgen -v \
		 SECONDS || echo none; RANDOM=1; echo ${!RANDOM@}",
	);
	assert_eq!(
		out,
		"st=1\nPIPESTATUS\nFUNCNAME\nnone\nRANDOM @*c\nSRANDOM @*c\nSECONDS @*c\nEPOCHSECONDS \
		 @*c\nEPOCHREALTIME @*c\nLINENO @*c\nBASH_COMMAND @*c\nBASH_CMDS @*c\nBASH_ALIASES \
		 @*c\nDIRSTACK @*c\nBASHPID @*c\nBASH_SUBSHELL @*c\nPIPESTATUS @*c\nBASH_SOURCE \
		 @*c\nBASH_LINENO @*c\nBASH_ARGC @*c\nBASH_ARGV @*c\n[] []\nnone\nRANDOM\n"
	);
	assert_eq!(err, "");
}

/// `SECONDS=n` restarts the count from n (bash `assign_seconds`; the
/// fake host's clock moves 1 µs per read); a fork counts from its own copy,
/// so neither side's assignment reaches the other.
#[test]
fn seconds_assignment_counts_from_the_value_in_each_process() {
	let (out, err) = run(
		"SECONDS=5000; echo $SECONDS; ( SECONDS=9000; echo c=$SECONDS ); echo p=$SECONDS; x=$( \
		 SECONDS=1; echo $SECONDS ); echo $x $SECONDS; ( (( SECONDS < 7000 )) && echo kept ) & \
		 SECONDS=7000; wait; echo $SECONDS; SECONDS=-5; echo $SECONDS",
	);
	assert_eq!((out.as_str(), err.as_str()), ("5000\nc=9000\np=5000\n1 5000\nkept\n7000\n-5\n", ""));
}

/// bash's `SECONDS=` takes a decimal number (`valid_number`, else 0; out of
/// `i64`'s range too) until the variable is an integer: after `declare -i
/// SECONDS`, or once `$SECONDS` was read (`get_seconds` sets the
/// attribute), the value is arithmetic, and an arithmetic error is
/// reported, counts as 0 and the script goes on with status 0. Each `$(…)`
/// below is a shell that has not read `$SECONDS` before its assignment.
/// Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn seconds_assignment_takes_a_decimal_number_until_seconds_is_an_integer() {
	let (out, err) = run(
		"x=7; for v in 1+1 x 0x10 ' 7 ' abc 5.5 -3 99999999999999999999 -9223372036854775808 \
		 -9223372036854775809; do r=$(SECONDS=$v; echo \"$SECONDS st=$?\"); echo \"[$v] $r\"; done; \
		 r=$(: $SECONDS; SECONDS=1+1; a=$SECONDS; SECONDS=x; b=$SECONDS; SECONDS=0x10; echo $a $b \
		 $SECONDS); echo \"after a read: $r\"; r=$(: $SECONDS; SECONDS=5.5; echo \"st=$? \
		 $SECONDS\"; f() { SECONDS=5.5; echo \"f st=$?\"; }; f; echo \"after f st=$?\"); echo $r; \
		 declare -i SECONDS; SECONDS=1+1; echo $SECONDS",
	);
	assert_eq!(
		out,
		"[1+1] 0 st=0\n[x] 0 st=0\n[0x10] 0 st=0\n[ 7 ] 7 st=0\n[abc] 0 st=0\n[5.5] 0 st=0\n[-3] -3 \
		 st=0\n[99999999999999999999] 0 st=0\n[-9223372036854775808] -9223372036854775808 \
		 st=0\n[-9223372036854775809] 0 st=0\nafter a read: 2 7 16\nst=0 0 f st=0 after f st=0\n2\n"
	);
	assert_eq!(err.matches("5.5: arithmetic syntax error").count(), 2, "{err}");
}

/// bash's `SECONDS+=` makes the value first (`make_variable_value`): the old
/// value's text with the new one after it, or their sum once `SECONDS` is
/// integer; the old value is the last assignment's or read's.
#[test]
fn seconds_append_adds_to_the_last_value() {
	for (src, want) in [
		("SECONDS=5; SECONDS+=5; echo $SECONDS", "55\n"),
		(": $SECONDS; SECONDS=5; SECONDS+=5; echo $SECONDS", "10\n"),
		("SECONDS+=5; echo $SECONDS", "5\n"),
		("SECONDS=7; : $SECONDS; SECONDS+=1+1; echo $SECONDS", "9\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// A local or temporary `SECONDS` is a plain variable (bash's
/// `make_local_variable` copies no dynamic value), and the shell's clock
/// goes on unmoved; `local`, `declare` and `export` with no value look the
/// name up first (`find_variable`), which reads the shell's `SECONDS` and
/// so makes it integer. `unset SECONDS` removes the special meaning for
/// good unless a local is what it unsets. Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn seconds_locals_lookups_and_unset() {
	for (src, want) in [
		("f() { local SECONDS=3; echo $SECONDS; }; f; echo $SECONDS", "3\n0\n"),
		(
			"f() { local SECONDS; echo \"[$SECONDS]\"; SECONDS=7; echo $SECONDS; }; SECONDS=50; f; \
			 echo $SECONDS",
			"[]\n7\n50\n",
		),
		("f() { local SECONDS=1+1; echo $SECONDS; }; f; SECONDS=1+1; echo $SECONDS", "1+1\n2\n"),
		("f() { local SECONDS=4; unset SECONDS; }; f; SECONDS=1+1; echo $SECONDS", "2\n"),
		("declare SECONDS=1+1; echo $SECONDS", "2\n"),
		("export SECONDS=1+1; echo $SECONDS; SECONDS=1+1; echo $SECONDS", "0\n2\n"),
		("export SECONDS; SECONDS=1+1; echo $SECONDS", "2\n"),
		("declare -p SECONDS", "declare -i SECONDS=\"0\"\n"),
		("SECONDS=5; declare -p SECONDS", "declare -i SECONDS=\"5\"\n"),
		(
			"unset SECONDS; echo \"[$SECONDS]\"; SECONDS=1+1; echo $SECONDS; declare -p SECONDS",
			"[]\n1+1\ndeclare -- SECONDS=\"1+1\"\n",
		),
		("f() { unset SECONDS; }; f; SECONDS=1+1; echo $SECONDS", "1+1\n"),
		("( unset SECONDS; SECONDS=1+1; echo $SECONDS ); SECONDS=1+1; echo $SECONDS", "1+1\n0\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `SECONDS` in the environment is the count's starting value, a decimal
/// number (bash's `init_seconds_var`), for the shell and for a nested
/// `bash`. Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn seconds_from_the_environment() {
	for (value, want) in [("100", "100\n"), ("abc", "0\n"), (" 7 ", "7\n")] {
		let init = ShellInit {
			env: vec![
				(BString::from("PATH"), BString::from("/usr/bin:/bin")),
				(BString::from("SECONDS"), BString::from(value)),
			],
			..skeleton_init(&[])
		};
		let mut rig = Rig::new(FakeHost::new(), init);
		rig.run(Script::command(b"echo $SECONDS".to_vec()), Fault::None);
		assert_eq!(String::from_utf8_lossy(&rig.host.stdout.bytes()), want, "{value}");
	}
	for (src, want) in [
		("SECONDS=100 bash -c 'echo $SECONDS'", "100\n"),
		("SECONDS=100; export SECONDS; bash -c 'echo $SECONDS'", "100\n"),
		("SECONDS=abc bash -c 'echo $SECONDS'", "0\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// Two seconds pass on the fake host's clock: `read -t 2` from a coproc
/// that waits for its input blocks until the clock jumps to its deadline,
/// then the coproc is given its line and reaped.
const WAIT_2S: &str =
	"coproc { read x; }; read -t 2 -u ${COPROC[0]} y; echo hi >&${COPROC[1]}; wait $COPROC_PID; ";

/// bash's arithmetic assignment (`bind_int_variable`) runs `SECONDS`'s
/// assign function as `SECONDS=` does: `((…))`, `let`, `$((…))`, an
/// integer variable's value and a subscript all set the clock, which then
/// counts on. A local `SECONDS` is only that local's; after `unset SECONDS`
/// the name is a plain variable. Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn seconds_arithmetic_assignment_sets_the_clock() {
	let counts = format!("((SECONDS=100)); {WAIT_2S}echo $SECONDS");
	for (src, want) in [
		("((SECONDS=100)); echo $SECONDS", "100\n"),
		("let SECONDS=200; echo $SECONDS", "200\n"),
		(": $((SECONDS=50)); echo $SECONDS", "50\n"),
		("((SECONDS+=5)); echo $SECONDS", "5\n"),
		("((SECONDS++)); echo $SECONDS", "1\n"),
		("declare -i x; x='SECONDS=100'; echo $x $SECONDS", "100 100\n"),
		("a[SECONDS=100]=1; echo $SECONDS", "100\n"),
		("f() { local SECONDS; ((SECONDS=7)); echo $SECONDS; }; f; echo $SECONDS", "7\n0\n"),
		(
			"unset SECONDS; ((SECONDS=7)); echo $SECONDS; declare -p SECONDS",
			"7\ndeclare -- SECONDS=\"7\"\n",
		),
		(counts.as_str(), "102\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// An element, compound or array-attribute assignment to the shell's
/// `SECONDS` makes it a plain array (bash's `convert_var_to_array`): the
/// lookup before it reads the clock, so element 0 is the count and the
/// variable is integer, and it counts no more. A local `SECONDS` is only
/// that local's: `local -a`, `local -A`, `declare -a` and a compound value
/// in a function leave the shell's clock counting. Goldens from bash
/// 5.2.21 and 5.3.20.
#[test]
fn seconds_array_forms_make_it_a_plain_array() {
	let stopped = format!("SECONDS[0]=60; {WAIT_2S}echo $SECONDS");
	let counting = format!("SECONDS=60; {WAIT_2S}echo $SECONDS");
	let local_a =
		format!("f() {{ local -a SECONDS=(1 2); echo \"$SECONDS\"; }}; f; {WAIT_2S}echo $SECONDS");
	let declare_a = format!("f() {{ declare -a SECONDS=(1 2); }}; f; {WAIT_2S}echo $SECONDS");
	let local_assoc = format!("f() {{ local -A SECONDS; }}; f; {WAIT_2S}echo $SECONDS");
	let local_compound = format!("f() {{ local SECONDS=(1 2); }}; f; {WAIT_2S}echo $SECONDS");
	for (src, want) in [
		(
			"SECONDS[0]=60; echo \"$SECONDS\"; declare -p SECONDS",
			"60\ndeclare -ai SECONDS=([0]=\"60\")\n",
		),
		(
			"SECONDS[1]=60; echo \"[$SECONDS]\"; declare -p SECONDS",
			"[0]\ndeclare -ai SECONDS=([0]=\"0\" [1]=\"60\")\n",
		),
		("SECONDS=5; SECONDS[0]+=5; echo \"$SECONDS\"", "10\n"),
		(
			"SECONDS=(1 2); echo \"$SECONDS\"; declare -p SECONDS",
			"1\ndeclare -ai SECONDS=([0]=\"1\" [1]=\"2\")\n",
		),
		(
			"SECONDS=5; SECONDS+=(6); declare -p SECONDS",
			"declare -ai SECONDS=([0]=\"5\" [1]=\"6\")\n",
		),
		(
			"read -a SECONDS <<< \"7 8\"; declare -p SECONDS",
			"declare -ai SECONDS=([0]=\"7\" [1]=\"8\")\n",
		),
		(
			"mapfile -t SECONDS <<< $'7\\n8'; declare -p SECONDS",
			"declare -ai SECONDS=([0]=\"7\" [1]=\"8\")\n",
		),
		("declare -a SECONDS; declare -p SECONDS", "declare -ai SECONDS=([0]=\"0\")\n"),
		("declare -A SECONDS; declare -p SECONDS", "declare -Ai SECONDS=([0]=\"0\" )\n"),
		("((SECONDS[0]=60)); declare -p SECONDS", "declare -ai SECONDS=([0]=\"60\")\n"),
		("let 'SECONDS[1]=60'; declare -p SECONDS", "declare -ai SECONDS=([0]=\"0\" [1]=\"60\")\n"),
		("declare 'SECONDS[0]=60'; declare -p SECONDS", "declare -ai SECONDS=([0]=\"60\")\n"),
		("f() { local SECONDS; SECONDS[0]=60; echo \"$SECONDS\"; }; f; echo \"$SECONDS\"", "60\n0\n"),
		(stopped.as_str(), "60\n"),
		(counting.as_str(), "62\n"),
		(local_a.as_str(), "1\n2\n"),
		(declare_a.as_str(), "2\n"),
		(local_assoc.as_str(), "2\n"),
		(local_compound.as_str(), "2\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `unset 'SECONDS[i]'` looks `SECONDS` up first, so it is an integer
/// scalar: element 0 unsets it and removes the special meaning, as `unset
/// SECONDS` does; another index is no element of it. Goldens from bash
/// 5.2.21 and 5.3.20.
#[test]
fn seconds_unset_of_an_element() {
	for (src, want) in [
		("unset 'SECONDS[0]'; echo \"[$SECONDS]\"; SECONDS=1+1; echo $SECONDS", "[]\n1+1\n"),
		("unset 'SECONDS[1-1]'; echo \"[$SECONDS]\"", "[]\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
	let (out, err) = run("unset 'SECONDS[1]'; echo \"st=$? [$SECONDS]\"");
	assert_eq!(out, "st=1 [0]\n");
	assert!(err.contains("unset: SECONDS: not an array variable"), "{err}");
}

/// A readonly `SECONDS` refuses `SECONDS=` and an element assignment, which
/// end the script, the arithmetic forms, which fail the command with status
/// 1, and `declare -a`/`-A`, which fail with status 1 (bash 5.3.20; 5.2.21
/// converts it); the clock is unmoved and counts on. Goldens from bash
/// 5.3.20 (and 5.2.21 but for `declare`).
#[test]
fn seconds_readonly_is_refused() {
	let element =
		format!("readonly SECONDS; ((SECONDS[0]=5)); echo \"st=$?\"; {WAIT_2S}echo $SECONDS");
	let declare_a =
		format!("readonly SECONDS; declare -a SECONDS; echo \"st=$?\"; {WAIT_2S}echo $SECONDS");
	let declare_assoc =
		format!("readonly SECONDS; declare -A SECONDS; echo \"st=$?\"; {WAIT_2S}echo $SECONDS");
	for (src, want, diag) in [
		("readonly SECONDS; SECONDS=5; echo next", "", "SECONDS: readonly variable"),
		(
			"readonly SECONDS; ((SECONDS=5)); echo \"st=$? $SECONDS\"",
			"st=1 0\n",
			"SECONDS: readonly variable",
		),
		("readonly SECONDS; SECONDS[0]=60; echo next", "", "SECONDS: readonly variable"),
		(element.as_str(), "st=1\n2\n", "SECONDS: readonly variable"),
		(declare_a.as_str(), "st=1\n2\n", "declare: SECONDS: readonly variable"),
		(declare_assoc.as_str(), "st=1\n2\n", "declare: SECONDS: readonly variable"),
	] {
		let (out, err) = run(src);
		assert_eq!(out, want, "{src}");
		assert!(err.contains(diag), "{src}: {err}");
	}
}

/// `declare` gives or takes no array, integer or case attribute of a
/// readonly variable (bash 5.3.20's `invalid_readonly_attrs`): it fails
/// with status 1 and the variable stays as it was; the export and trace
/// attributes still change. bash 5.2.21 changes them all. Goldens from bash
/// 5.3.20.
#[test]
fn declare_keeps_a_readonly_variables_array_integer_and_case_attributes() {
	for flag in ["-a", "-A", "-i", "-l", "-u", "-c", "+i", "+a", "-ai"] {
		let src = format!("readonly x=1; declare {flag} x; echo st=$?; declare -p x");
		let (out, err) = run(&src);
		assert_eq!(out, "st=1\ndeclare -r x=\"1\"\n", "{src}");
		assert!(err.contains("declare: x: readonly variable"), "{src}: {err}");
	}
	for (src, want) in [
		("readonly x=1; declare -x x; echo st=$?; declare -p x", "st=0\ndeclare -rx x=\"1\"\n"),
		("readonly x=1; declare -t x; echo st=$?; declare -p x", "st=0\ndeclare -rt x=\"1\"\n"),
		(
			"readonly -a a=(1); declare -a a; echo st=$?; declare -p a",
			"st=1\ndeclare -ar a=([0]=\"1\")\n",
		),
	] {
		let (out, err) = run(src);
		assert_eq!(out, want, "{src}");
		assert_eq!(err.is_empty(), want.starts_with("st=0"), "{src}: {err}");
	}
}

/// `readonly` and `export` take `-a` and `-A` only with a value (bash's
/// `set_or_show_attributes` then declares the name `-g[rx]a`/`-g[rx]A`);
/// without one the name gets only the builtin's own attribute, a readonly
/// one too: status 0, no array made, the value kept. Goldens from bash
/// 5.3.20, the same in 5.2.21.
#[test]
fn readonly_and_export_take_array_flags_only_with_a_value() {
	for (src, want) in [
		("readonly x=1; readonly -a x; echo st=$?; declare -p x", "st=0\ndeclare -r x=\"1\"\n"),
		("readonly x=1; readonly -A x; echo st=$?; declare -p x", "st=0\ndeclare -r x=\"1\"\n"),
		("readonly x=1; export -a x; echo st=$?; declare -p x", "st=0\ndeclare -rx x=\"1\"\n"),
		("readonly x=1; export -A x; echo st=$?; declare -p x", "st=0\ndeclare -rx x=\"1\"\n"),
		("set -o posix; readonly x=1; readonly -a x; echo st=$?", "st=0\n"),
		(
			"readonly -a x=(1); export -a x; echo st=$?; declare -p x",
			"st=0\ndeclare -arx x=([0]=\"1\")\n",
		),
		("readonly -a y; echo st=$?; declare -p y", "st=0\ndeclare -r y\n"),
		("z=5; export -a z; echo st=$?; declare -p z", "st=0\ndeclare -x z=\"5\"\n"),
		("z=5; readonly -A z; echo st=$?; declare -p z", "st=0\ndeclare -r z=\"5\"\n"),
		("export -a y=5; echo st=$?; declare -p y", "st=0\ndeclare -ax y=([0]=\"5\")\n"),
	] {
		assert_eq!(run(src), (want.to_owned(), String::new()), "{src}");
	}
}

/// `SECONDS+=` adds to the value the last lookup stored, as bash's
/// `make_variable_value` reads the variable's cell: a lookup two seconds
/// on stores the count then (7); without one, the 5 stored before is what
/// it adds to. Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn seconds_append_adds_to_the_last_lookups_value() {
	let looked_up = format!("SECONDS=5; : $SECONDS; {WAIT_2S}: $SECONDS; SECONDS+=0; echo $SECONDS");
	let stale = format!("SECONDS=5; : $SECONDS; {WAIT_2S}SECONDS+=0; echo $SECONDS");
	assert_eq!(run(&looked_up), ("7\n".to_owned(), String::new()));
	assert_eq!(run(&stale), ("5\n".to_owned(), String::new()));
}

/// `export` and `readonly` take no subscript, with a value either (bash's
/// `legal_identifier` of the name before `=`): nothing is assigned, the
/// status is 1 and the script goes on. Goldens from bash 5.2.21 and 5.3.20.
#[test]
fn export_and_readonly_refuse_a_subscript() {
	for (src, want, diag) in [
		(
			"export 'x[0]=60'; echo st=$?; declare -p x",
			"st=1\n",
			"export: `x[0]': not a valid identifier",
		),
		(
			"x=1; readonly 'x[0]=60'; echo st=$?; declare -p x",
			"st=1\ndeclare -- x=\"1\"\n",
			"readonly: `x[0]': not a valid identifier",
		),
		(
			"export 'SECONDS[0]=60'; echo $SECONDS; declare -p SECONDS",
			"0\ndeclare -i SECONDS=\"0\"\n",
			"export: `SECONDS[0]': not a valid identifier",
		),
	] {
		let (out, err) = run(src);
		assert_eq!(out, want, "{src}");
		assert!(err.contains(diag), "{src}: {err}");
	}
}

/// bash's `SECONDS=` keeps the value apart and moves the start to now
/// (`assign_seconds`): `printf '%(%s)T' -2` then gives the assignment's
/// time, and posix `time` with no pipeline counts from it. The host's clock
/// starts at 1,000 s: a start moved back by the value would not wrap past
/// 0, where these readers saturate.
#[test]
fn seconds_assignment_moves_the_start_to_now() {
	let out = run_script(
		FakeHost::new().with_clock_at(1_000_000_000_000),
		b"SECONDS=100; a=$(printf '%(%s)T' -2); b=$(printf '%(%s)T' -1); [ \"$a\" = \"$b\" ] && \
		  echo now; echo $SECONDS; set -o posix; TIMEFORMAT=%0R; SECONDS=100; { time; } 2>&1",
		&[],
		Fault::None,
	);
	let (out, err) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
	assert_eq!((&*out, &*err), ("now\n100\n0\n", ""));
}

#[test]
fn name_references_read_assign_and_unset_their_target() {
	let (out, err) = run(
		"x=1; declare -n r=x; echo $r; r=2; echo $x; declare -p r; unset r; echo ${x-unset}; \
		 declare -n e; e=foo; e=bar; echo $foo; declare -n s=s",
	);
	assert_eq!(out, "1\n2\ndeclare -n r=\"x\"\nunset\nbar\n");
	assert_eq!(err, "bash: line 1: declare: s: nameref variable self references not allowed\n");
	let (out, _) = run(
		"f(){ local -n lr=$1; lr=fv; }; f gv; echo $gv; declare -n lv; A=1 B=2; for lv in A B; do \
		 echo $lv; done; declare -p lv",
	);
	assert_eq!(out, "fv\n1\n2\ndeclare -n lv=\"B\"\n");
}

#[test]
fn unset_of_a_callers_local_reveals_the_global() {
	let (out, _) = run(
		"inner(){ unset res; echo ${res-unset}; }; outer(){ local res=L; inner; echo ${res-unset}; \
		 }; res=G; outer; f(){ local x=4; unset x; echo ${x-unset}; }; x=out; f",
	);
	assert_eq!(out, "G\nG\nunset\n");
}

#[test]
fn local_dash_temporary_environment_and_export_n() {
	let (out, _) = run(
		"f(){ local -; set -u; local; }; f; echo $-; export X=1; export -n X; declare -p X; x=5 \
		 export x; declare -p x; y=1; y=6 readonly y; echo $y",
	);
	assert_eq!(out, "local -\nhBc\ndeclare -- X=\"1\"\ndeclare -x x=\"5\"\n6\n");
}

#[test]
fn shopt_listings_and_shellopts() {
	let (out, _) = run(
		"shopt nullglob extglob; echo $?; shopt -o -p xtrace; shopt -o xtrace; set -o posix; echo \
		 $POSIXLY_CORRECT; shopt -po posix; echo $SHELLOPTS",
	);
	assert_eq!(
		out,
		"nullglob            \toff\nextglob             \toff\n1\nset +o xtrace\nxtrace              \
		 \toff\ny\nset -o posix\nbraceexpand:hashall:interactive-comments:posix\n"
	);
}

#[test]
fn array_conversions_and_local_listing() {
	let (out, err) = run(
		"declare -a x=(1)\ndeclare -A x=([a]=b)\necho $?\ndeclare -A h=([k]=v)\ndeclare -a h\necho \
		 $?\nf(){ local v; local -p v; local -p w; }; f\necho $?",
	);
	assert_eq!(out, "1\n1\ndeclare -- v\n1\n");
	assert_eq!(
		err,
		"bash: line 2: x: cannot convert indexed to associative array\nbash: line 5: declare: h: \
		 cannot convert associative to indexed array\nbash: line 7: local: w: not found\n"
	);
	let (out, err) = run(
		"readonly g=1; f(){ local g=2; echo in $g; }; f; declare -A m=([one]=1 [two]=2 [three]=3); \
		 echo ${!m[@]}",
	);
	assert_eq!(out, "in 1\ntwo three one\n");
	assert_eq!(err, "bash: line 1: local: g: readonly variable\n");
}

#[test]
fn ignoreeof_follows_its_variable_and_local_dash() {
	let (out, _) = run(
		"IGNOREEOF=0; shopt -o ignoreeof; f(){ local -; set +o ignoreeof; shopt -o ignoreeof; }; f; \
		 shopt -o ignoreeof; echo $IGNOREEOF; unset IGNOREEOF; shopt -o ignoreeof",
	);
	let on = "ignoreeof           \ton\n";
	let off = "ignoreeof           \toff\n";
	assert_eq!(out, format!("{on}{off}{on}10\n{off}"));
}

#[test]
fn readonly_functions_and_declare_f_errors() {
	let (out, err) = run(
		"func(){ :; }; readonly -f func; unset -f func; echo $?; declare -f +r func; echo $?; \
		 declare -f -a func; echo $?; declare -f x=1; echo $?; unset /bin/sh; echo $?; declare -fp \
		 func",
	);
	let body = ["func () ", "{ ", "    :", "}"].join("\n");
	assert_eq!(out, format!("1\n1\n1\n1\n0\n{body}\ndeclare -fr func\n"));
	assert_eq!(
		err,
		"bash: line 1: unset: func: cannot unset: readonly function\nbash: line 1: declare: func: \
		 readonly function\nbash: line 1: declare: -a: invalid option\nbash: line 1: declare: \
		 cannot use `-f' to make functions\n"
	);
}

#[test]
fn let_keeps_subscript_quotes_with_assoc_expand_once() {
	let (out, err) = run("shopt -s assoc_expand_once\nlet 'a[\"\"]=1'; echo same\necho next\n");
	// `bash -c` abandons the whole string (a script file goes on with the
	// next line).
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 2: \"\": arithmetic syntax error: operand expected (error token is \"\"\"\")\n"
	);
}

#[test]
fn posix_special_builtin_name_errors_are_fatal() {
	let (_, err) = run("set -o posix; readonly a=a; readonly x-y z-w; echo after");
	assert_eq!(err, "bash: line 1: readonly: `x-y': not a valid identifier\n");
	let (out, err) = run("set -o posix; readonly a=a; unset -v a; echo after");
	assert_eq!(out, "");
	assert_eq!(err, "bash: line 1: unset: a: cannot unset: readonly variable\n");
}

#[test]
fn name_reference_targets_must_be_names() {
	let (out, err) = run(
		"r=/; declare -n r; echo $?; unset r\ndeclare -n r; r=/; echo $?; unset -n r\ndeclare -n r; \
		 declare r=/; echo $?; unset -n r\ndeclare -n r=\"\"; echo $?\ndeclare -r RO=x; declare -n \
		 RO; echo $?; declare -p RO",
	);
	assert_eq!(out, "1\n1\n1\n1\ndeclare -r RO=\"x\"\n");
	assert_eq!(
		err,
		"bash: line 1: declare: `/': invalid variable name for name reference\nbash: line 2: `/': \
		 not a valid identifier\nbash: line 3: declare: `/': not a valid identifier\nbash: line 4: \
		 declare: `': not a valid identifier\nbash: line 5: declare: RO: readonly variable\n"
	);
}

#[test]
fn element_assignment_to_a_new_variable_has_no_element_zero() {
	let (out, _) = run(
		"unset a; a[5]=x; declare -p a; declare x; x[5]=1; declare -p x; y=; y[2]=1; declare -p y; \
		 f(){ local z; z[3]=1; declare -p z; }; f",
	);
	assert_eq!(
		out,
		"declare -a a=([5]=\"x\")\ndeclare -a x=([5]=\"1\")\ndeclare -a y=([0]=\"\" \
		 [2]=\"1\")\ndeclare -a z=([3]=\"1\")\n"
	);
}

#[test]
fn array_attribute_on_unset_names_and_references() {
	let (out, _) = run(
		"declare x; declare -a x; declare -p x; declare -n foo; declare -a foo; declare -p foo; \
		 foo[0]=7; declare -p foo",
	);
	assert_eq!(out, "declare -a x\ndeclare -a foo\ndeclare -a foo=([0]=\"7\")\n");
}

#[test]
fn converted_assoc_arrays_list_in_small_table_order() {
	let (out, _) = run(
		"foo=help; declare -A foo=([zero]=zero [one]=one); declare -p foo; unset foo; declare -A \
		 foo=([zero]=zero [one]=one); declare -p foo; declare -A x=([a=b]=1 [@]=2 ['~x']=3 [x~]=4 \
		 [-]=5 [\"a b\"]=6); declare -p x",
	);
	assert_eq!(
		out,
		"declare -A foo=([zero]=\"zero\" [one]=\"one\" )\ndeclare -A foo=([one]=\"one\" \
		 [zero]=\"zero\" )\ndeclare -A x=([-]=\"5\" [a=b]=\"1\" [x~]=\"4\" [\"@\"]=\"2\" [\"a \
		 b\"]=\"6\" [\"~x\"]=\"3\" )\n"
	);
}

#[test]
fn array_subscript_errors_and_subscripted_compound_declare() {
	let (out, err) = run(
		"d=(x y); d=([0]=q []=abcde [1]=t)\ndeclare -p d; declare -ar c; c[-2]=4\ndeclare +a \
		 c\ndeclare -a e[10]=test; declare -a e[10]=\"(test)\"; declare -p e",
	);
	assert_eq!(out, "declare -a d=([0]=\"q\")\ndeclare -a e=([0]=\"test\")\n");
	assert_eq!(
		err,
		"bash: line 1: []=abcde: bad array subscript\nbash: line 2: c[-2]: bad array \
		 subscript\nbash: line 3: declare: c: readonly variable\n"
	);
}

// assoc9: a word written as an array reference (`d["$k"]`, `d[\"]`) names
// its key verbatim; a quoted or expanded one is parsed again and `d["]`
// is no reference. `unset -n` takes no subscript; `unset 'r[0]'` reaches
// the reference's target.
#[test]
fn unset_takes_written_array_references_verbatim() {
	let (out, err) = run(
		"declare -A d; k='\"'; d[$k]=1; unset -v d[\"$k\"]; d[$k]=2; unset -v d[\\\"]; declare -p \
		 d; d[$k]=3; unset -v \"d[$k]\"; x=\"d[$k]\"; unset -v $x; declare -p d; d[\"\\$k\"]=4; \
		 unset -v d[\\$k]; declare -p d; a=(1 2 3); unset -n \"a[1]\"; declare -n r=a; unset \
		 \"r[0]\"; declare -p a; unset -v \"a[1]x\"; echo $?",
	);
	assert_eq!(
		out,
		"declare -A d=()\ndeclare -A d=([\"\\\"\"]=\"3\" )\ndeclare -A d=([\"\\\"\"]=\"3\" \
		 )\ndeclare -a a=([1]=\"2\" [2]=\"3\")\n1\n"
	);
	assert_eq!(
		err,
		"bash: line 1: unset: `d[\"]': not a valid identifier\nbash: line 1: unset: `d[\"]': not a \
		 valid identifier\nbash: line 1: unset: `a[1]x': not a valid identifier\n"
	);
}

// assoc11: `declare -A` key-value pairs with an empty key report it as
// `declare` got it and skip the pair; an odd word out gets "".
#[test]
fn declare_kvpair_skips_empty_keys() {
	let (out, err) = run(
		"declare -A i=( \"\" 1 a 2 ); echo $?; declare -p i; k=; declare -A j=( $k 1 c 2 \"$k\" 3 \
		 ); declare -p j; declare -A w=(k1 v1 k2); declare -p w",
	);
	assert_eq!(
		out,
		"0\ndeclare -A i=([a]=\"2\" )\ndeclare -A j=([c]=\"2\" )\ndeclare -A w=([k1]=\"v1\" \
		 [k2]=\"\" )\n"
	);
	assert_eq!(
		err,
		"bash: line 1: '': bad array subscript\nbash: line 1: '': bad array subscript\nbash: line \
		 1: '': bad array subscript\n"
	);
}

// bash's `posix_initialize`: POSIX mode turns `expand_aliases` on; leaving
// it restores the non-interactive default (off).
#[test]
fn posix_mode_toggles_expand_aliases() {
	let (out, _) = run(
		"shopt -s expand_aliases; set -o posix; shopt -p expand_aliases; set +o posix; shopt -p \
		 expand_aliases; POSIXLY_CORRECT=1; shopt -p expand_aliases; unset POSIXLY_CORRECT; shopt \
		 -p expand_aliases",
	);
	assert_eq!(
		out,
		"shopt -s expand_aliases\nshopt -u expand_aliases\nshopt -s expand_aliases\nshopt -u \
		 expand_aliases\n"
	);
}

// varenv12: the persisted prefix variable keeps the temporary
// environment's export attribute, on a function's local too.
#[test]
fn posix_special_builtin_prefix_stays_exported() {
	let (out, _) = run(
		"set -o posix; foo=abc :; declare -p foo; f(){ local q=in; q=val :; declare -p q; }; q=out; \
		 f; declare -p q; g(){ x=abc : ; typeset +x x; declare -p x; }; g; declare -p x",
	);
	assert_eq!(
		out,
		"declare -x foo=\"abc\"\ndeclare -x q=\"val\"\ndeclare -- q=\"out\"\ndeclare -- x\ndeclare \
		 -x x=\"abc\"\n"
	);
}

#[test]
fn posix_special_builtin_prefix_reaches_the_global_through_a_call_prefix() {
	let (out, _) = run(
		"set -o posix; g(){ b=3 :; }; b=7 g; echo g=$b; f(){ a=3; }; a=7 f; echo a=$a; h(){ \
		 readonly c; }; c=7 h; echo c=$c",
	);
	assert_eq!(out, "g=3\na=\nc=\n");
}

#[test]
fn unset_expands_an_assoc_key_unless_expand_once() {
	let (out, _) = run(
		"declare -A assoc; var=x123; assoc['$var']=value; unset 'assoc[$var]'; declare -p assoc; \
		 assoc[x123]=1; unset 'assoc[$var]'; declare -p assoc; shopt -s assoc_expand_once; \
		 assoc['$var']=v; unset 'assoc[$var]'; declare -p assoc",
	);
	assert_eq!(
		out,
		"declare -A assoc=([\"\\$var\"]=\"value\" )\ndeclare -A assoc=([\"\\$var\"]=\"value\" \
		 )\ndeclare -A assoc=()\n"
	);
}

// Goldens below: bash 5.3.20 `bash -c` (array, quotearray and
// nameref groups).

#[test]
fn element_assignment_errors_carry_no_builtin_name() {
	let (out, err) = run(
		"a=(1); printf -v \"a[@]\" x; declare -a \"a[-9]=1\"; read \"a[-9]\" <<< x; echo $?; unset \
		 \"a[-9]\"; declare -p a",
	);
	assert_eq!(out, "1\ndeclare -a a=([0]=\"1\")\n");
	assert_eq!(
		err,
		"bash: line 1: a[@]: bad array subscript\nbash: line 1: a[-9]: bad array subscript\nbash: \
		 line 1: a[-9]: bad array subscript\nbash: line 1: unset: [-9]: bad array subscript\n"
	);
	// An arithmetic error in `test -v`'s subscript abandons the line.
	let (out, err) = run("test -v \"u[1+]\"; echo not reached");
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 1: 1+: arithmetic syntax error: operand expected (error token is \"+\")\n"
	);
}

#[test]
fn empty_subscripts_are_bad_where_written() {
	let (out, err) = run(
		"b=(1); declare \"b[]=x\"; echo $?; (( y[] + 1 )); echo $?; declare -p b; b[]=z; echo not \
		 reached",
	);
	assert_eq!(out, "1\n0\ndeclare -a b=([0]=\"1\")\n");
	assert_eq!(
		err,
		"bash: line 1: b[]: bad array subscript\nbash: line 1: y[]: bad array subscript\nbash: line \
		 1: y[]: bad array subscript\nbash: line 1: b[]: bad array subscript\n"
	);
}

#[test]
fn compound_values_given_as_strings_are_expanded() {
	let (out, err) = run(
		"x=\"a b\"; y='($(echo Darwin))'; declare -a a=$x c=\"(1 2)\" d='($a)' e=$y; declare -p a c \
		 d e; unset a c d e; declare -A a=$x c=\"(1 2)\" d='($a)' e=$y; declare -p a c d e",
	);
	assert_eq!(
		out,
		"declare -a a=([0]=\"a b\")\ndeclare -a c=([0]=\"1\" [1]=\"2\")\ndeclare -a d=([0]=\"a\" \
		 [1]=\"b\")\ndeclare -a e=([0]=\"Darwin\")\ndeclare -A a=([0]=\"a b\" )\ndeclare -A \
		 c=([1]=\"2\" )\ndeclare -A d=([\"a b\"]=\"\" )\ndeclare -A e=([Darwin]=\"\" )\n"
	);
	assert_eq!(err, "");
	let (out, err) = run(
		"declare a[1]=\"(var)\"; declare -p a; d=(x \"y z\"); declare -a f='(\"${d[@]}\")'; declare \
		 -p f; declare -a v=\"([\\$(echo total 0)]=1 [2]=2)\"; echo not reached",
	);
	assert_eq!(out, "declare -a a=([1]=\"(var)\")\ndeclare -a f=([0]=\"x\" [1]=\"y z\")\n");
	assert_eq!(
		err,
		"bash: line 1: warning: a[1]=(var): quoted compound array assignment deprecated\nbash: line \
		 1: total 0: arithmetic syntax error in expression (error token is \"0\")\n"
	);
}

#[test]
fn whole_array_defaults_and_negative_subscripts_of_unset_arrays() {
	let (out, err) = run(
		"declare -A A; echo ${A[@]:=foo}; declare -p A; declare -ar c; echo ${c[-4]}x; echo \
		 ${u[@]:=x}; echo not reached",
	);
	assert_eq!(out, "foo\ndeclare -A A=([\"@\"]=\"foo\" )\nx\n");
	assert_eq!(
		err,
		"bash: line 1: c: bad array subscript\nbash: line 1: u[@]: bad array subscript\n"
	);
}

#[test]
fn read_a_and_mapfile_need_an_indexed_array() {
	let (out, err) = run(
		"declare -A A; read -a A <<< x; echo $?; declare -n r; mapfile r <<< x; declare -p r; \
		 declare -n ref=XXX[0]; read -a ref <<< \"A B\"; ref+=(y); echo not reached",
	);
	assert_eq!(out, "1\ndeclare -a r=([0]=$'x\\n')\n");
	assert_eq!(
		err,
		"bash: line 1: read: A: not an indexed array\nbash: line 1: warning: r: removing nameref \
		 attribute\nbash: line 1: read: `XXX[0]': not a valid identifier\nbash: line 1: `XXX[0]': \
		 not a valid identifier\n"
	);
}

/// `eval`, `.` and `$( )` text sees the caller's `$?` until its first
/// command runs; text without a command (empty, blanks, a comment) ends
/// with status 0.
#[test]
fn dollar_question_carries_into_eval_source_and_substitutions() {
	let fs = MemFs::new();
	fs.add_file("/w/s", b"echo \"src-in=$?\"\n", 0o644);
	fs.add_file("/w/c", b"# only a comment\n", 0o644);
	let src = "false; eval 'echo in=$?'; false; eval '#c'; echo comment=$?; false; eval ' '; echo \
	           blank=$?; false; eval 'x=$?'; echo x=$x; (exit 3); eval 'eval \"echo \
	           nested=\\$?\"'; f() { return 4; }; f; eval 'echo fn=$?'; false; . /w/s; false; . \
	           /w/c; echo comment-src=$?; false; x=$(); echo empty-cs=$?; false; x=$( ); echo \
	           blank-cs=$?; (exit 3); x=$(echo $?); echo inner=$x";
	let out = run_script(FakeHost::new().with_fs(fs), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
	assert_eq!(
		String::from_utf8_lossy(&out.stdout)
			.lines()
			.collect::<Vec<_>>(),
		[
			"in=1",
			"comment=0",
			"blank=0",
			"x=1",
			"nested=3",
			"fn=4",
			"src-in=1",
			"comment-src=0",
			"empty-cs=0",
			"blank-cs=0",
			"inner=3",
		]
	);
}

/// bash runs a `mapfile -C` callback before its line is stored, and the
/// callback reads what follows that line: from a pipe (read a byte at a
/// time) and from a file (read ahead, then given back).
#[test]
fn mapfile_callbacks_read_the_input_after_their_line() {
	let fs = MemFs::new();
	fs.add_file("/w/lines", b"1\n2\n3\n4\n", 0o644);
	let src = "cb() { read -r x; echo \"cb:$1:$2:$x\"; }; printf '1\\n2\\n3\\n4\\n' | { mapfile -t \
	           -C cb -c 1 arr; echo \"arr=${arr[*]}\"; }; { mapfile -t -C cb -c 1 arr; echo \
	           \"arr=${arr[*]}\"; } < /w/lines; { mapfile -t -C cb -c 2 -n 3 arr; read -r rest; \
	           echo \"arr=${arr[*]} rest=$rest\"; } < /w/lines";
	let out = run_script(FakeHost::new().with_fs(fs), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
	assert_eq!(
		String::from_utf8_lossy(&out.stdout),
		"cb:0:1:2\ncb:1:3:4\narr=1 3\ncb:0:1:2\ncb:1:3:4\narr=1 3\ncb:1:2:3\narr=1 2 4 rest=\n"
	);
}

/// A callback sees the lines before its own stored, and what it does to
/// the array stays; `mapfile`'s status is its own, not the callback's.
#[test]
fn mapfile_callbacks_see_and_change_the_array_as_it_fills() {
	let (out, err) = run(
		"printf 'a\\nb\\nc\\nd\\ne\\n' | { mapfile -t -C 'echo ${#arr[@]}' -c 2 -s 1 -O 3 -n 3 arr; \
		 echo \"st=$? ${!arr[*]} ${arr[*]}\"; }; printf 'a\\nb\\n' | { mapfile -C false -c 1 a2; \
		 echo st=$?; }; printf 'x\\ny\\nz' | { cb() { unset arr; }; mapfile -t -C cb -c 1 arr; \
		 declare -p arr; }; printf 'x\\ny\\n' | { cb() { readonly arr; }; mapfile -C cb -c 1 arr; \
		 echo st=$?; declare -p arr; }",
	);
	assert_eq!(
		out,
		"1 4 c\nst=0 3 4 5 b c d\nst=0\ndeclare -a arr=([2]=\"z\")\nst=1\ndeclare -ar arr=()\n"
	);
	assert_eq!(err, "bash: line 1: arr: readonly variable\n");
}

/// `name+=(…)` keeps a set scalar as element 0, but a new or
/// declared-but-unset variable has none.
#[test]
fn appending_a_list_to_an_unset_variable_adds_no_element_zero() {
	let (out, err) = run(
		"unset a; a+=([3]=x); declare -p a; f() { local l; l+=([4]=y); declare -p l; }; f; declare \
		 b; b+=([2]=z); declare -p b; c=; c+=([1]=z); declare -p c; d=s; d+=(t); declare -p d",
	);
	assert_eq!(
		out,
		"declare -a a=([3]=\"x\")\ndeclare -a l=([4]=\"y\")\ndeclare -a b=([2]=\"z\")\ndeclare -a \
		 c=([0]=\"\" [1]=\"z\")\ndeclare -a d=([0]=\"s\" [1]=\"t\")\n"
	);
	assert_eq!(err, "");
}

#[test]
fn name_reference_values_are_checked_where_bash_checks_them() {
	let (out, err) = run(
		"s=/; unset -n s; declare -p s; var=foo; declare -n ref=var[0]; readonly ref; declare -r \
		 ref; declare -p ref var",
	);
	assert_eq!(
		out,
		"declare -- s=\"/\"\ndeclare -n ref=\"var[0]\"\ndeclare -ar var=([0]=\"foo\")\n"
	);
	assert_eq!(err, "bash: line 1: readonly: `var[0]': not a valid identifier\n");
	let (out, err) = run(
		"declare -n x; declare x=42; declare -p x; declare -n r; ((r=0)); for r in /; do :; done; \
		 declare -p r",
	);
	assert_eq!(out, "declare -n r\n");
	assert_eq!(
		err,
		"bash: line 1: declare: `42': not a valid identifier\nbash: line 1: declare: x: not \
		 found\nbash: line 1: ((: `0': not a valid identifier\nbash: line 1: `/': not a valid \
		 identifier\n"
	);
	let (out, err) = run(
		"declare -n ref=re ref+=f; declare -p ref; declare -n r2=var r2+=[@]; declare -p r2; \
		 declare -rn ro=bar; declare +n ro; declare -n array=\"(one)\"; declare -n arr2=(one two); \
		 declare -p arr2",
	);
	assert_eq!(
		out,
		"declare -n ref=\"re\"\ndeclare -n r2=\"var[@]\"\ndeclare -a arr2=([0]=\"one\" \
		 [1]=\"two\")\n"
	);
	assert_eq!(
		err,
		"bash: line 1: ref: nameref variable self references not allowed\nbash: line 1: declare: \
		 ro: readonly variable\nbash: line 1: declare: `(one)': invalid variable name for name \
		 reference\nbash: line 1: declare: arr2: reference variable cannot be an array\n"
	);
}

#[test]
fn references_to_elements_of_themselves_and_dangling_references() {
	let (out, err) = run(
		"declare -n a=b b; b=a[1]; a=foo; declare -p a b; declare -n xref; declare -a xref[1]=one; \
		 declare -p xref",
	);
	assert_eq!(
		out,
		"declare -a a=([1]=\"foo\")\ndeclare -n b=\"a[1]\"\ndeclare -a xref=([1]=\"one\")\n"
	);
	assert_eq!(
		err,
		"bash: line 1: warning: a: removing nameref attribute\nbash: line 1: warning: xref: \
		 removing nameref attribute\n"
	);
	let (out, err) = run("f() { local -n a=a[0]; a=X; }; a=(0); f; declare -p a");
	assert_eq!(out, "");
	assert_eq!(
		err,
		"bash: line 1: local: warning: a: circular name reference\nbash: line 1: warning: a: \
		 circular name reference\nbash: line 1: `a[0]': not a valid identifier\n"
	);
}

#[test]
fn attributes_given_with_and_without_the_reference() {
	let (out, err) = run(
		"unset bar; declare -n foo=bar; declare +n -i foo=7+4; declare -p foo bar; declare -i iv; \
		 declare -n iv=q; declare -p iv; declare -ai a=(1); declare -in b=\"a[0]\"; declare -p b",
	);
	assert_eq!(out, "declare -- foo=\"bar\"\ndeclare -i bar=\"11\"\ndeclare -n iv=\"q\"\n");
	assert_eq!(err, "bash: line 1: declare: b: not found\n");
	let (out, err) = run(
		"declare -n ref=foo; f() { declare -n ref=var; declare -g ref=(X); declare -p var; }; f; \
		 declare -p foo",
	);
	assert_eq!(out, "declare -a foo=([0]=\"X\")\n");
	assert_eq!(err, "bash: line 1: declare: var: not found\n");
}

// Golden: bash 5.3.20 (upstream exp8.sub, array32.sub): an arithmetic
// error in a compound element's subscript keeps the elements before it in
// the emptied array, then abandons the line.
#[test]
fn compound_subscript_arith_error_keeps_the_elements_before_it() {
	let (out, err) = run("trap 'declare -p a' EXIT; a=(1 2); a=( [2]=b [1+]=hi )");
	assert_eq!(out, "declare -a a=([2]=\"b\")\n");
	assert_eq!(
		err,
		"bash: line 1: 1+: arithmetic syntax error: operand expected (error token is \"+\")\n"
	);
	let (out, err) = run("trap 'declare -p b' EXIT; b=(1 2); declare -a b=( [x y]=1 )");
	assert_eq!(out, "declare -a b=()\n");
	assert_eq!(
		err,
		"bash: line 1: x y: arithmetic syntax error in expression (error token is \"y\")\n"
	);
}

// Golden: bash 5.3.20 (upstream nameref14.sub, nameref12.sub:104): `+=`
// in a prefix assignment through a reference appends to the target; an
// element of an unset reference is no name; a compound value makes it an
// array.
#[test]
fn unset_references_and_appending_prefix_assignments() {
	let (out, err) = run(
		"declare -n ref=var; var=foo; f() { echo $var; }\nref+=X f; echo $var\ndeclare -n \
		 r\nr[0]=x; echo no\ndeclare -p r\nr+=(a)\ndeclare -p r\ndeclare -n s; declare s=(y); \
		 declare -p s",
	);
	assert_eq!(out, "fooX\nfoo\ndeclare -n r\ndeclare -a r=([0]=\"a\")\ndeclare -a s=([0]=\"y\")\n");
	assert_eq!(
		err,
		"bash: line 4: `': not a valid identifier\nbash: line 6: warning: r: removing nameref \
		 attribute\nbash: line 8: warning: s: removing nameref attribute\n"
	);
}

// Golden: bash 5.3.20 (upstream nameref11.sub:26): `{var}` naming no
// variable reports it under the command's name.
#[test]
fn fd_variable_errors_name_the_command() {
	let (_, err) = run("declare -n r; exec {r}>&2; echo hi {r}>&2");
	assert_eq!(
		err,
		"bash: line 1: exec: `10': not a valid identifier\nbash: line 1: r: cannot assign fd to \
		 variable\nbash: line 1: echo: `10': not a valid identifier\nbash: line 1: r: cannot assign \
		 fd to variable\n"
	);
}

// Golden: bash 5.3.20 (upstream set-x1.sub:18, set-x2.sub): a
// `BASH_XTRACEFD` naming no open fd is reported; a compound assignment is
// traced as written, `$'…'` single-quoted.
#[test]
fn xtrace_fd_values_and_compound_assignment_traces() {
	let (out, err) =
		run("BASH_XTRACEFD=7\nBASH_XTRACEFD=x\nBASH_XTRACEFD=\ndeclare -p BASH_XTRACEFD");
	assert_eq!(out, "declare -- BASH_XTRACEFD=\"\"\n");
	assert_eq!(
		err,
		"bash: line 1: BASH_XTRACEFD: 7: invalid value for trace file descriptor\nbash: line 2: \
		 BASH_XTRACEFD: x: invalid value for trace file descriptor\n"
	);
	let (_, err) = run("set -x\nm=( \\|  [k]=$'\\t' \"a b\" $@ 'q' )\nset +x");
	assert_eq!(err, "+ m=(\\| [k]='\t' \"a b\" $@ 'q')\n+ set +x\n");
}

// Golden: bash 5.3.20 (upstream array.tests): `declare -p` lists
// `BASH_ARGC`/`BASH_ARGV` as stored: the top-level base is there only
// after a read pushed it.
#[test]
fn listing_shows_the_argument_base_after_a_read() {
	let (out, _) = run("set -- a b; declare -p");
	assert!(out.contains("\ndeclare -a BASH_ARGC=()\ndeclare -a BASH_ARGV=()\n"), "{out}");
	let (out, _) = run("set -- a b; : $BASH_ARGC; declare -p");
	assert!(
		out.contains(
			"\ndeclare -a BASH_ARGC=([0]=\"2\")\ndeclare -a BASH_ARGV=([0]=\"b\" [1]=\"a\")\n"
		),
		"{out}"
	);
}

// Arithmetic assigns in place where the variable is bound (a local, an
// element, a nameref's target, a subshell's copy) and reads plain decimal
// values without compiling them.
#[test]
fn arithmetic_assigns_in_place_at_every_level() {
	let (out, err) = run(
		"f() { local n=5; ((n++)); ((g+=n)); echo \"f:$n:$g\"; }\ng=1; f; echo \
		 \"g:$g:${n-unset}\"\na=(1 2 3); ((a[1]=7)); ((a[5]++)); echo \"${a[@]} ${!a[@]}\"\ndeclare \
		 -A m=([k]=1); ((m[k]+=4)); echo \"${m[k]}\"\ndeclare -n r=a[2]; ((r=9)); echo \
		 \"${a[2]}\"\ndeclare -n q=g; ((q*=2)); echo \"$g\"\ns=abc; ((s=12)); echo \"$s\"; declare \
		 -i t=3; ((t+=1)); declare -p t\n( ((g=100)); echo \"sub:$g\" ); echo \"parent:$g\"\nx=$( \
		 ((g=50)); echo \"$g\" ); echo \"$x:$g\"\nreadonly ro=1; ((ro=2)); echo \"st=$? \
		 ro=$ro\"\nv=\"  -42 \"; w=010; echo $((v*2)) $((v)) $((w)) $((v+w))\nu=7; h() { local u; \
		 ((u++)); echo \"h:$u\"; }; h; echo \"u:$u\"\nset -u; echo $((g+1)); ( echo $((nope+1)) ); \
		 echo \"after=$?\"\n",
	);
	assert_eq!(
		out,
		"f:6:7\ng:7:unset\n1 7 3 1 0 1 2 5\n5\n9\n14\n12\ndeclare -i \
		 t=\"4\"\nsub:100\nparent:14\n50:14\nst=1 ro=1\n-84 -42 8 -34\nh:1\nu:7\n15\nafter=1\n"
	);
	assert_eq!(err, "bash: line 10: ro: readonly variable\nbash: line 13: nope: unbound variable\n");
}

// Option reads follow `set`/`shopt`/`local -`, subshells and `$( )` (which
// turns `errexit` off unless `inherit_errexit`), with `SHELLOPTS`/`BASHOPTS`
// in step; `enable -n` in a subshell stays there.
#[test]
fn options_follow_scopes_subshells_and_comsubs() {
	let (out, err) = run(
		"echo \"$SHELLOPTS\"\nf() { local -; set -f; set -o pipefail; echo \"in:$SHELLOPTS\"; }; f; \
		 echo \"out:$SHELLOPTS\"\n( set -e; echo \"sub:$SHELLOPTS\" ); echo \
		 \"parent:$SHELLOPTS\"\nset -e; echo \"cs:$(echo $SHELLOPTS)\"; shopt -s inherit_errexit; \
		 echo \"ie:$(echo $SHELLOPTS)\"; set +e; shopt -u inherit_errexit\nshopt -s extglob; ( \
		 shopt -u extglob; shopt extglob ); shopt extglob\n[[ :$BASHOPTS: == *:extglob:* ]] && echo \
		 has\nset -f; echo /*; ( set +f; echo \"$-\" ); echo \"$-\"; set +f\nenable -n echo; ( \
		 enable echo; echo sub ); enable -n; enable echo; echo back\n",
	);
	assert_eq!(
		out,
		"braceexpand:hashall:interactive-comments\nin:braceexpand:hashall:interactive-comments:\
		 noglob:pipefail\nout:braceexpand:hashall:interactive-comments\nsub:braceexpand:errexit:\
		 hashall:interactive-comments\nparent:braceexpand:hashall:interactive-comments\ncs:\
		 braceexpand:hashall:interactive-comments\nie:braceexpand:errexit:hashall:\
		 interactive-comments\nextglob             \toff\nextglob             \
		 \ton\nhas\n/*\nhBc\nfhBc\nsub\nenable -n echo\nback\n"
	);
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 `bash -c`: a fatal expansion error exits a subshell
// (`( )`, `$( )`, nested) with 1 (`execute_in_subshell` keeps the failure
// status) and the `-c` shell itself with 127 (`run_one_command`).
#[test]
fn unbound_variable_exits_subshells_with_one_and_the_c_shell_with_127() {
	let src = "set -u; ( echo $nope ); echo \"s:$?\"; x=$(echo $nope); echo \"c:$?\"; ( \
	           v=${nope}x; echo no ); echo \"a:$?\"; ( ( echo $((nope)) ); echo \"in:$?\"; exit 4 \
	           ); echo \"o:$?\"; echo $nope; echo never";
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "s:1\nc:1\na:1\nin:1\no:4\n");
	assert_eq!(
		out.stderr
			.split(|&c| c == b'\n')
			.filter(|l| !l.is_empty())
			.count(),
		5
	);
	assert_eq!(out.status, 127);
}

// Golden: bash 5.3.20 (`shopt_set_debug_mode`): `extdebug` turns
// `errtrace` and `functrace` on and off with it.
#[test]
fn extdebug_sets_errtrace_and_functrace() {
	let (out, _) = run("shopt -s extdebug; echo $-; shopt -u extdebug; echo $-");
	assert_eq!(out, "hBETc\nhBc\n");
}
