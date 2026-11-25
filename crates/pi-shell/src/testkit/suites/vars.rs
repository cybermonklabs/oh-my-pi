//! Variables: assignment with attributes (also on the in-place fast path),
//! `$RANDOM`, name references, dynamic scoping of `local`/`unset`,
//! `local -`, the temporary environment of `export`/`readonly`, `shopt`
//! and `SHELLOPTS`, array conversions, associative-array order, arrays
//! filled by `mapfile` and its callbacks.
//! Goldens: bash 5.3.20 (`bash -c`).

use crate::testkit::{FakeHost, Fault, MemFs, run_script};

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

// Goldens: bash 5.3.20 (5.2.21 agrees). A scalar has no element to count a
// negative subscript back from: every expansion of it warns `x: bad array
// subscript` and is unset (`array_value_internal`); `@a` and `@A` look it
// up twice. A dynamic scalar is one too.
#[test]
fn negative_subscript_of_a_scalar_warns_and_is_unset() {
	let (out, err) = run(
		r#"x=abc; echo "[${x[-1]}] [${x[-1]:-u}] [${x[-1]#a}] [${x[-1]@a}]"; declare -i n=4; echo "[${n[-1]}]"; echo "[${BASHPID[-1]:+s}]"; a=(1); echo "[${a[-3]@a}]""#,
	);
	assert_eq!(out, "[] [u] [] []\n[]\n[]\n[a]\n");
	let bad = |name: &str| format!("bash: line 1: {name}: bad array subscript\n");
	let want = [bad("x").repeat(5), bad("n"), bad("BASHPID"), bad("a").repeat(2)].concat();
	assert_eq!(err, want);
}

// Goldens: bash 5.3.20 (5.2.21 agrees). Arithmetic counts a negative
// subscript back from the end of an indexed array (a scalar is its element
// 0 when assigned); a read before the start warns `a: bad array subscript`
// and is 0, an assignment there warns `a[-3]: …` and assigns nothing.
#[test]
fn negative_subscript_in_arithmetic_counts_back() {
	let (out, err) = run(
		"a=(1 2); echo $((a[-1])) $((a[-3])); x=5; ((x[-1]=7)); declare -p x; ((a[-1]=7)); \
		 ((a[-3]=9)); declare -p a; ((u[-1]=1)); declare -p u",
	);
	assert_eq!(out, "2 0\ndeclare -a x=([0]=\"7\")\ndeclare -a a=([0]=\"1\" [1]=\"7\")\n");
	assert_eq!(
		err,
		"bash: line 1: a: bad array subscript\nbash: line 1: a[-3]: bad array subscript\nbash: line \
		 1: u[-1]: bad array subscript\nbash: line 1: declare: u: not found\n"
	);
}

// Golden: bash 5.3.20 (5.2.21 agrees): `-v` counts a negative subscript
// back too; a scalar's warns.
#[test]
fn negative_subscript_in_test_v_counts_back() {
	let (out, err) = run(r"a=(1 2); [[ -v a[-1] ]] && echo s1; x=abc; [[ -v x[-1] ]] || echo u");
	assert_eq!(out, "s1\nu\n");
	assert_eq!(err, "bash: line 1: x: bad array subscript\n");
}

// Golden: bash 5.3.20 (5.2.21 agrees): `${p:?}` names the parameter as
// written, subscript and `!` included (`parameter_brace_expand_error`).
#[test]
fn error_operator_names_the_parameter_as_written() {
	let (out, err) = run(
		r#"x=abc; ( : "${x[1]:?}" ); ( : "${x[$i]?}" ); ( : "${u[@]:?msg}" ); v=u; ( : "${!v:?}" ); echo after"#,
	);
	assert_eq!(out, "after\n");
	assert_eq!(
		err,
		"bash: line 1: x[1]: parameter null or not set\nbash: line 1: u[@]: msg\nbash: line 1: !v: \
		 parameter null or not set\n"
	);
}

// Golden: bash 5.3.20 (5.2.21 agrees): a scalar's `[@]` with `@A` is its
// `@A`, with `@K` or `@k` its value quoted (one word).
#[test]
fn scalar_all_elements_transforms_quote_the_value() {
	let (out, err) = run(
		r#"x=abc; declare -i z=7; y="a b"; echo "${x[@]@A}" "${z[*]@A}" "${x[@]@K}" "${y[@]@k}"; set -- "${y[@]@k}"; echo $#"#,
	);
	assert_eq!(out, "x='abc' declare -i z='7' 'abc' 'a b'\n1\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): `@a` and `@A` of a name reference
// describe its target (`find_variable` follows it); one naming no
// variable describes nothing. `${!r@op}` applies the operator to `${!r}`,
// the name the reference holds, and describes the target.
#[test]
fn name_reference_transforms_describe_the_target() {
	let (out, err) = run(
		r#"declare -i n=4; declare -n r=n; echo "[${r@a}] [${r[@]@a}] [${!r@a}] [${r@A}]"; declare -n u=nosuch e; echo "[${u@a}] [${u@A}] [${e@a}]""#,
	);
	assert_eq!(out, "[i] [i] [i] [declare -i n='4']\n[] [] []\n");
	assert_eq!(err, "");
	let (out, err) = run(
		r#"declare -i n=4; declare -n r=n; echo "[${!r@Q}] [${!r@A}] [${!r@U}]"; x=abc; declare -n s=x; echo "[${!s@Q}] [${!s@A}]""#,
	);
	assert_eq!(out, "['n'] [declare -i n='n'] [N]\n['x'] [x='x']\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): `x[@]` and `x[*]` name no one
// element in arithmetic: each lookup warns, a read is 0, an assignment
// assigns nothing; an associative array's `@` is a key.
#[test]
fn all_elements_in_arithmetic_warn_and_read_zero() {
	let (out, err) = run(
		"x=abc; echo $((x[@])) $(( x[*] + 1 )); echo $((x[@]=5)) $((x[@]++)); declare -p x; declare \
		 -A A=([k]=1); echo $((A[@]))",
	);
	assert_eq!(out, "0 1\n5 0\ndeclare -- x=\"abc\"\n0\n");
	let bad = |s: &str| format!("bash: line 1: {s}: bad array subscript\n");
	assert_eq!(err, [bad("x[@]"), bad("x[*]"), bad("x[@]").repeat(3)].concat());
}

// Golden: bash 5.3.20 (5.2.21 agrees): under `set -u` arithmetic reports an
// unset variable before its subscript (`expr_streval` checks it first), for
// a negative index and for `[@]` alike.
#[test]
fn arithmetic_under_set_u_reports_the_unset_variable_first() {
	let (out, err) = run(
		"set -u; ( : $((u[-1])) ); ( declare x; : $((x[-1])) ); ( declare -a d; : $((d[-1])) ); ( : \
		 $((u[@])); echo no ); echo after",
	);
	assert_eq!(out, "after\n");
	let unbound = |s: &str| format!("bash: line 1: {s}: unbound variable\n");
	assert_eq!(err, [unbound("u"), unbound("x"), unbound("d"), unbound("u")].concat());
}

// Golden: bash 5.3.20 (5.2.21 agrees): an arithmetic assignment to `[-1]` of
// a declared but unset scalar, or of a dynamic scalar, counts it as element
// 0 (`assign_array_element`).
#[test]
fn arithmetic_counts_a_declared_unset_scalar_as_element_0() {
	let (out, err) = run(
		"declare -i x; ((x[-1]=3)); declare -p x; f() { local y; ((y[-1]=4)); declare -p y; }; f; \
		 ((LINENO[-1]=5)); echo st=$?",
	);
	assert_eq!(out, "declare -ai x=([0]=\"3\")\ndeclare -a y=([0]=\"4\")\nst=0\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): `-v` of a negative subscript looks up
// a key of a declared empty associative array, and counts back from the end
// of a dynamic array, silently.
#[test]
fn test_v_negative_subscript_of_an_assoc_or_dynamic_array() {
	let (out, err) = run(
		"declare -A A; [[ -v A[-1] ]] || echo nv; test -v 'A[-1]' || echo nv2; true | true; [[ -v \
		 PIPESTATUS[-1] ]] && echo p1",
	);
	assert_eq!(out, "nv\nnv2\np1\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): through a name reference to an
// associative array, `@` in arithmetic is its key.
#[test]
fn arithmetic_all_elements_through_a_reference_to_an_assoc() {
	let (out, err) = run(
		"declare -A A=([@]=5); declare -n r=A; echo $((r[@])); declare -A B=([k]=1); declare -n \
		 s=B; echo $((s[@]=3)) $((s[k])); declare -p B",
	);
	assert_eq!(out, "5\n3 1\ndeclare -A B=([\"@\"]=\"3\" [k]=\"1\" )\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): `test -v` expands its subscript once
// more (`array_expand_index`, `expand_subscript_string`).
#[test]
fn test_v_expands_its_subscript() {
	let (out, err) = run(
		"a=(x y); test -v 'a[$(echo 1)]' && echo yes; test -v 'a[$(echo 5)]' || echo no; declare -A \
		 h; test -v 'h[$(echo k)]'; echo st=$?; h[k]=1; test -v 'h[$(echo k)]' && echo hk",
	);
	assert_eq!(out, "yes\nno\nst=1\nhk\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees on the global reference only): an
// unset name reference names no variable, so an arithmetic `[-1]` write
// through it names no element: bash warns and assigns nothing, and the
// reference stays.
#[test]
fn negative_write_through_an_unset_reference_assigns_nothing() {
	let (out, err) = run(
		r#"declare -n r; ((r[-1]=3)); echo "st=$?"; declare -p r; f() { local -n s; ((s[-1]=4)); declare -p s; }; f"#,
	);
	assert_eq!(out, "st=0\ndeclare -n r\ndeclare -n s\n");
	assert_eq!(
		err,
		"bash: line 1: r[-1]: bad array subscript\nbash: line 1: s[-1]: bad array subscript\n"
	);
}

// Golden: bash 5.3.20 (5.2.21 agrees): `-v` of a negative subscript through
// a name reference (and a chain of them) to a declared empty associative
// array looks up a key, silently.
#[test]
fn test_v_negative_subscript_through_a_reference_to_an_empty_assoc() {
	let (out, err) = run(
		r"declare -A A; declare -n r=A s=r; [[ -v r[-1] ]] || echo nv; test -v 'r[-1]' || echo nv2; [[ -v s[-1] ]] || echo nv3; f() { local -n t=A; [[ -v t[-2] ]] || echo nl; }; f",
	);
	assert_eq!(out, "nv\nnv2\nnv3\nnl\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): at a script file's top level
// `FUNCNAME` holds an invisible `main`, so `FUNCNAME[-1]` names it, unset,
// silently; a `-c` string has none, and the subscript is bad.
#[test]
fn funcname_negative_subscript_at_a_scripts_top_level() {
	let (out, err) = run_file("[[ -v FUNCNAME[-1] ]] || echo top\n");
	assert_eq!(out, "top\n");
	assert_eq!(err, "");
	let (out, err) = run("[[ -v FUNCNAME[-1] ]] || echo top");
	assert_eq!(out, "top\n");
	assert_eq!(err, "bash: line 1: FUNCNAME: bad array subscript\n");
}

/// `src` run as the script file `t.sh`, `$0` too (bash pushes `main` onto
/// `FUNCNAME` for a file, not for a `-c` string).
fn run_file(src: &str) -> (String, String) {
	use crate::{
		bash::{Origin, Script, ShellInit},
		testkit::fault::{Rig, skeleton_init},
	};
	let init = ShellInit { argv0: "t.sh".into(), ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let script =
		Script { origin: Origin::File("t.sh".into()), ..Script::command(src.as_bytes().to_vec()) };
	rig.run(script, Fault::None);
	(
		String::from_utf8_lossy(&rig.host.stdout.bytes()).into_owned(),
		String::from_utf8_lossy(&rig.host.stderr.bytes()).into_owned(),
	)
}

// Golden: bash 5.3.20 (5.2.21 agrees): `[[ -v` expands its subscript again,
// a command substitution in it included (`array_expand_once` is off there).
#[test]
fn cond_v_runs_a_substitution_in_its_subscript() {
	let (out, err) = run(
		r#"a=(x y); [[ -v 'a[$(echo 1)]' ]] && echo yes; echo "st=$?"; [[ -v 'a[`echo 5`]' ]] || echo no; declare -A h; [[ -v 'h[$(echo k)]' ]]; echo "st=$?"; h[k]=1; if [[ -v 'h[$(echo k)]' ]]; then echo hk; fi; echo after"#,
	);
	assert_eq!(out, "yes\nst=0\nno\nst=1\nhk\nafter\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): a subscript in double quotes is
// expanded once, like an unquoted one, and its value is quoted for `-v`:
// what the value holds is never expanded again (no `PWNED`, `B`, `C`, `D`
// or `R` on stderr, `u` and `n` untouched), through a name reference too.
#[test]
fn cond_v_never_expands_a_value_in_a_subscript_again() {
	let (out, err) = run(concat!(
		r#"f() { local -A m=([a]=1); [[ -v "m[$1]" ]] && echo has || echo no; }; f a; f '$(echo PWNED >&2)'"#,
		"\n",
		r#"declare -A h=([k]=1); n=0; for v in '`echo B >&2; echo k`' '${u:=k}' '$((n+=1))' '$(echo C >&2; echo k)' 'x],b[$(echo D >&2)'; do [[ -v "h[$v]" ]] && echo "y:$v" || echo "n:$v"; [[ -v h[$v] ]] && echo "Y:$v"; done; echo "u=${u-unset} n=$n""#,
		"\n",
		r#"[[ -v "h[\$(echo k)]" ]] || echo esc; [[ -v "h[$(echo k)]" ]] && echo live; declare -n r=h; k='$(echo R >&2; echo k)'; [[ -v "r[$k]" ]] || echo nr"#,
	));
	assert_eq!(
		out,
		concat!(
			"has\nno\nn:`echo B >&2; echo k`\nn:${u:=k}\nn:$((n+=1))\nn:$(echo C >&2; echo k)\n",
			"n:x],b[$(echo D >&2)\nu=unset n=0\nesc\nlive\nnr\n"
		)
	);
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 says `syntax error` for `arithmetic syntax
// error`): an index in double quotes (or after a quoted name) is expanded
// once; a value holding a substitution is then an arithmetic syntax error,
// never run.
#[test]
fn cond_v_index_value_in_a_subscript_is_an_arithmetic_error() {
	let (out, err) = run(
		r#"a=(x y); k='$(echo S >&2; echo 1)'; ( [[ -v "a[$k]" ]] && echo dq ); echo "st=$?"; k='`echo B >&2; echo 1`'; ( [[ -v "a[$k]" ]] && echo bq ); echo "st=$?"; k='${u:=1}'; ( [[ -v "a[${k}]" ]] && echo br ); echo "st=$?"; k='$((n+=1))'; ( [[ -v "a"[$k] ]] && echo ar ); echo "st=$?"; ( [[ -v "a[\$(echo 1)]" ]] && echo esc ); echo "st=$?""#,
	);
	assert_eq!(out, "st=1\nst=1\nst=1\nst=1\nst=1\n");
	assert_eq!(
		err,
		concat!(
			"bash: line 1: $(echo S >&2; echo 1): arithmetic syntax error: operand expected (error \
			 token is \"$(echo S >&2; echo 1)\")\n",
			"bash: line 1: `echo B >&2; echo 1`: arithmetic syntax error: operand expected (error \
			 token is \"`echo B >&2; echo 1`\")\n",
			"bash: line 1: ${u:=1}: arithmetic syntax error: operand expected (error token is \
			 \"${u:=1}\")\n",
			"bash: line 1: $((n+=1)): arithmetic syntax error: operand expected (error token is \
			 \"$((n+=1))\")\n",
			"bash: line 1: $(echo 1): arithmetic syntax error: operand expected (error token is \
			 \"$(echo 1)\")\n",
		)
	);
}

// Golden: bash 5.3.20 (5.2.21 says `syntax error` for `arithmetic syntax
// error`): an arithmetic operand of `[[ ]]`, in double quotes too, and
// arithmetic expansion quote a subscript's value, and `test -v 'h[$j]'`
// expands `$j` once: no `E` or `T` on stderr.
#[test]
fn arithmetic_never_expands_a_value_in_a_subscript_again() {
	let (out, err) = run(
		r#"a=(5 6); declare -A h=([k]=1); k='$(echo E >&2; echo 1)'; ( [[ "a[$k]" -eq 6 ]] && echo eq ); echo "st=$?"; ( [[ a[$k] -eq 6 ]] && echo eq2 ); echo "st=$?"; ( echo "$(( a[$k] ))" ); echo "st=$?"; ( echo "$(( "a[$k]" ))" ); echo "st=$?"; j='$(echo T >&2; echo k)'; test -v 'h[$j]' || echo nt; [[ "a[1]" -eq 6 ]] && echo eq1"#,
	);
	assert_eq!(out, "st=1\nst=1\nst=1\nst=1\nnt\neq1\n");
	let e = "bash: line 1: $(echo E >&2; echo 1): arithmetic syntax error: operand expected (error \
	         token is \"$(echo E >&2; echo 1)\")\n";
	assert_eq!(err, e.repeat(4));
}

// Golden: bash 5.3.20 (5.2.21 agrees): an index whose substitution expands
// to nothing is 0, as an empty arithmetic expression is.
#[test]
fn cond_v_empty_index_is_element_0() {
	let (out, err) = run(
		r#"a=(x y); [[ -v 'a[$(echo)]' ]] && echo e0; [[ -v 'a[$(exit 7)]' ]]; echo "st=$?"; b=(); [[ -v 'b[$(echo)]' ]] || echo nb"#,
	);
	assert_eq!(out, "e0\nst=0\nnb\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): outside a function bash's `FUNCNAME`
// holds a `source` for each `.` file being read (and `main` for a script
// file): a negative subscript counts back from them in `-v`, expansions
// and arithmetic, silently; in a function the array shows them.
#[test]
fn funcname_negative_subscript_in_a_sourced_file() {
	let src = concat!(
		r#"printf '%s\n' '[[ -v FUNCNAME[-1] ]] || echo src; echo "[${FUNCNAME[-1]}] [$((FUNCNAME[-1]))]"; f() { [[ -v FUNCNAME[-1] ]] && echo "fin:${FUNCNAME[-1]}"; }; f' > /tmp/s.sh; . /tmp/s.sh"#,
		"\n"
	);
	let (out, err) = run(src);
	assert_eq!(out, "src\n[] [0]\nfin:source\n");
	assert_eq!(err, "");
	let (out, err) = run_file(src);
	assert_eq!(out, "src\n[] [0]\nfin:main\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): at a script file's top level
// `FUNCNAME[-1]` names the invisible `main` in arithmetic and expansions
// too (a subshell and a command substitution keep it), and `[-2]` is
// bad; a `-c` string has nothing to count back to; under `set -u` the
// invisible array is unset.
#[test]
fn funcname_negative_subscript_in_arithmetic_and_expansions() {
	let src = concat!(
		r#"echo "[$((FUNCNAME[-1]))] [${FUNCNAME[-1]}]"; x=$(echo "[${FUNCNAME[-1]}]"); echo "$x"; ( echo "[$((FUNCNAME[-1]))]" ); echo "[$((FUNCNAME[-2]))]""#,
		"\n"
	);
	let (out, err) = run_file(src);
	assert_eq!(out, "[0] []\n[]\n[0]\n[0]\n");
	assert_eq!(err, "t.sh: line 1: FUNCNAME: bad array subscript\n");
	let (out, err) = run(src);
	assert_eq!(out, "[0] []\n[]\n[0]\n[0]\n");
	assert_eq!(err, "bash: line 1: FUNCNAME: bad array subscript\n".repeat(5));
	let (out, err) = run(r#"set -u; echo "[$((FUNCNAME[@]))]"; echo after"#);
	assert_eq!(out, "");
	assert_eq!(err, "bash: line 1: FUNCNAME: unbound variable\n");
}

// Golden: bash 5.3.20 (5.2.21 says `syntax error` for `arithmetic syntax
// error`): in double quotes a `[` after any character, not only a name
// character (`"${n}[$k]"`, `"$(echo h)[$k]"`), opens a subscript that is
// expanded once and quoted: what the value holds is never run (no `S`, `B`,
// `C` or `D` on stderr, `v` and `m` untouched); an index is an arithmetic
// syntax error, a key the value as written.
#[test]
fn cond_v_subscript_after_an_expansion_in_double_quotes_expands_once() {
	let (out, err) = run(concat!(
		r#"a=(x y); n=a; for k in '$(echo S >&2; echo 1)' '`echo B >&2; echo 1`' '${u:=1}' '$((m+=1))'; do ( [[ -v "${n}[$k]" ]] && echo "y:$k" ); echo "st=$?"; done"#,
		"\n",
		r#"declare -A h=([k]=1); n=h; m=0; for k in '$(echo C >&2; echo k)' '`echo D >&2; echo k`' '${v:=k}' '$((m+=1))' k; do [[ -v "${n}[$k]" ]] && echo "Y:$k" || echo "N:$k"; [[ -v "$(echo h)[$k]" ]] && echo "Z:$k"; done; echo "v=${v-unset} m=$m""#,
	));
	assert_eq!(
		out,
		concat!(
			"st=1\nst=1\nst=1\nst=1\n",
			"N:$(echo C >&2; echo k)\nN:`echo D >&2; echo k`\nN:${v:=k}\nN:$((m+=1))\nY:k\nZ:k\n",
			"v=unset m=0\n"
		)
	);
	assert_eq!(
		err,
		concat!(
			"bash: line 1: $(echo S >&2; echo 1): arithmetic syntax error: operand expected (error \
			 token is \"$(echo S >&2; echo 1)\")\n",
			"bash: line 1: `echo B >&2; echo 1`: arithmetic syntax error: operand expected (error \
			 token is \"`echo B >&2; echo 1`\")\n",
			"bash: line 1: ${u:=1}: arithmetic syntax error: operand expected (error token is \
			 \"${u:=1}\")\n",
			"bash: line 1: $((m+=1)): arithmetic syntax error: operand expected (error token is \
			 \"$((m+=1))\")\n",
		)
	);
}

// Golden: bash 5.3.20 (5.2.21 agrees): an empty key of an associative array
// (a name reference's target too) names no element; only an index is 0.
// bash also warns `h: bad array subscript` there, which this engine does
// not yet, so that warning goes to /dev/null.
#[test]
fn cond_v_empty_key_of_an_associative_array_names_no_element() {
	let (out, err) = run(
		r"declare -A h=([0]=1 [k]=2); [[ -v 'h[$(echo)]' ]] 2>/dev/null && echo y0 || echo n0; declare -n r=h; [[ -v 'r[$(echo)]' ]] 2>/dev/null && echo r0 || echo nr; [[ -v 'h[$(echo k)]' ]] && echo hk; a=(x); [[ -v 'a[$(echo)]' ]] && echo a0",
	);
	assert_eq!(out, "n0\nnr\nhk\na0\n");
	assert_eq!(err, "");
}

// Golden: bash 5.3.20 (5.2.21 agrees): at a script file's top level (and in
// a command substitution there) `FUNCNAME` hides one element, `main`, so
// `${FUNCNAME[-2]}` is bad; a `.` file read there hides two (`source`,
// `main`), so it is silent there.
#[test]
fn funcname_negative_subscript_past_the_hidden_elements_is_bad() {
	let (out, err) = run_file(concat!(
		r#"echo "[${FUNCNAME[-2]}] [${FUNCNAME[-1]}]"; x=$(echo "[${FUNCNAME[-2]}]"); echo "$x"; printf '%s\n' 'echo "[${FUNCNAME[-2]}]"' > /tmp/s.sh; . /tmp/s.sh; echo after"#,
		"\n"
	));
	assert_eq!(out, "[] []\n[]\n[]\nafter\n");
	assert_eq!(err, "t.sh: line 1: FUNCNAME: bad array subscript\n".repeat(2));
}

// Golden: bash 5.3.20 (5.2.21 agrees): under `set -u` the element
// `FUNCNAME[-1]` names at a script file's top level (the invisible `main`)
// is unset, in arithmetic (`FUNCNAME: unbound variable`) as in an
// expansion (`FUNCNAME[-1]: unbound variable`).
#[test]
fn funcname_negative_subscript_under_set_u_is_unbound() {
	let (out, err) = run_file(concat!(
		r#"( set -u; echo "[$((FUNCNAME[-1]))]"; echo no ); echo "st=$?"; ( set -u; echo "[${FUNCNAME[-1]}]"; echo no ); echo "st=$?"; echo after"#,
		"\n"
	));
	assert_eq!(out, "st=1\nst=1\nafter\n");
	assert_eq!(
		err,
		"t.sh: line 1: FUNCNAME: unbound variable\nt.sh: line 1: FUNCNAME[-1]: unbound variable\n"
	);
}

// Golden: bash 5.3.20 (5.2.21 agrees, but starts the warning in the
// function with `environment:`, not `bash:`): under `set -u` a set dynamic
// array (`PIPESTATUS`, `LINENO`, `BASH_SUBSHELL`, `BASH_LINENO`, and
// `FUNCNAME` in a function) is no unbound variable: its `[@]` or `[*]` in
// arithmetic warns and reads 0, as any array's does.
#[test]
fn all_elements_of_a_set_dynamic_array_under_set_u_warn_in_arithmetic() {
	let (out, err) = run(
		r#"set -u; true | true; echo "[$((PIPESTATUS[@]))]"; echo "[$((LINENO[@])) $((BASH_SUBSHELL[*]))]"; echo "[$((BASH_LINENO[@]))]"; f() { echo "[$((FUNCNAME[@]))]"; }; f; echo after"#,
	);
	assert_eq!(out, "[0]\n[0 0]\n[0]\n[0]\nafter\n");
	assert_eq!(
		err,
		concat!(
			"bash: line 1: PIPESTATUS[@]: bad array subscript\n",
			"bash: line 1: LINENO[@]: bad array subscript\n",
			"bash: line 1: BASH_SUBSHELL[*]: bad array subscript\n",
			"bash: line 1: BASH_LINENO[@]: bad array subscript\n",
			"bash: line 1: FUNCNAME[@]: bad array subscript\n",
		)
	);
}
