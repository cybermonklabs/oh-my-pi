//! Bash traces each assignment at its binding boundary, not after the whole
//! assignment list. These literal stdout/stderr goldens are from Bash 5.3 -c.

#![cfg(unix)]

use bytes::Bytes;
use pi_shell::{
	ShellExecuteOptions,
	cancel::CancelToken,
	shell::{StreamSinks, execute_shell_streams},
};

async fn assert_trace(script: &str, stdout: &str, stderr: &str) {
	let dir = tempfile::tempdir().expect("working directory");
	let (out_tx, out_rx) = flume::unbounded::<Bytes>();
	let (err_tx, err_rx) = flume::unbounded::<Bytes>();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: script.into(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			..Default::default()
		},
		StreamSinks { stdout: Some(out_tx), stderr: Some(err_tx) },
		CancelToken::new(Some(3000)),
	)
	.await
	.expect("shell execution");
	let collect = |rx: flume::Receiver<Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect())
			.expect("UTF-8 output")
	};
	assert_eq!(
		(collect(out_rx), collect(err_rx), result.exit_code, result.timed_out),
		(stdout.into(), stderr.into(), Some(0), false),
		"{script}"
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assignment_only_traces_before_binding_each_value() {
	for (script, stdout, stderr) in [
		(
			r#"unset b; PS4='+${b-unset} '; set -x; a=one b=two; set +x"#,
			"",
			"+unset a=one\n+unset b=two\n+two set +x\n",
		),
		(
			r#"unset a b; PS4='+${a-unset}:${b-unset} '; set -x; a=one b=$a c=$b; set +x; printf '%s:%s:%s\n' "$a" "$b" "$c""#,
			"one:one:one\n",
			"+unset:unset a=one\n+one:unset b=one\n+one:one c=one\n+one:one set +x\n",
		),
		(
			r#"v=old; PS4='+${v} '; set -x; v+=new a=$v; set +x; printf '%s:%s\n' "$v" "$a""#,
			"oldnew:oldnew\n",
			"+old v+=new\n+oldnew a=oldnew\n+oldnew set +x\n",
		),
		(
			r#"declare -i n=5; PS4='+${n} '; set -x; n=1+2 n+=4; set +x; printf '%s\n' "$n""#,
			"7\n",
			"+5 n=1+2\n+3 n+=4\n+7 set +x\n",
		),
		(
			r#"i=0; a=(old); PS4='+${i}:${a[0]-none}:${a[1]-none} '; set -x; a[i++]=X b=$i; set +x; printf '%s:%s:%s\n' "$i" "${a[*]}" "$b""#,
			"1:X:1\n",
			"+0:old:none a[i++]=X\n+1:X:none b=1\n+1:X:none set +x\n",
		),
		(
			r#"PS4='+OLD '; set -x; PS4='+NEW ' a=1; set +x"#,
			"",
			"+OLD PS4='+NEW '\n+NEW a=1\n+NEW set +x\n",
		),
		(
			r#"a=(old); PS4='+${a[*]} '; set -x; a+=(new) b="${a[*]}"; set +x; printf '%s:%s\n' "${a[*]}" "$b""#,
			"old new:old new\n",
			"+old a+=(new)\n+old new b='old new'\n+old new set +x\n",
		),
		(
			r#"n=0; PS4='+${n} '; set -x; a=($((n++))) b=$n; set +x; printf '%s:%s:%s\n' "$n" "${a[*]}" "$b""#,
			"1:0:1\n",
			"+0 a=($((n++)))\n+1 b=1\n+1 set +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn assignment_values_do_not_repeat_when_their_trace_parks() {
	for (script, stdout, stderr) in [
		(
			r#"n=0; PS4='+${n} '; set -x; a=$((n++)) b=$((n++)); set +x; printf '%s:%s:%s\n' "$n" "$a" "$b""#,
			"2:0:1\n",
			"+1 a=0\n+2 b=1\n+2 set +x\n",
		),
		(
			r#"n=0; PS4='+${n} '; set -x; a=$(printf V) b=$((n++)); set +x; printf '%s:%s:%s\n' "$n" "$a" "$b""#,
			"1:V:0\n",
			"++0 printf V\n+0 a=V\n+1 b=0\n+1 set +x\n",
		),
		// No-fork command substitution is new in Bash 5.3; Bash 5.2
		// rejects this prompt syntax instead of performing its side effect.
		(
			r#"n=0; PS4='${ n=$((n+1)); printf P; } '; set -x; a=$n b=$n; set +x; printf '%s:%s:%s\n' "$n" "$a" "$b""#,
			"3:0:1\n",
			"P a=0\nP b=1\nP set +x\n",
		),
		(
			r#"n=1; declare -i v=10; PS4='${ n=$((n+1)); printf P; } '; set -x; v=n v+=n; set +x; printf '%s:%s\n' "$n" "$v""#,
			"4:5\n",
			"P v=n\nP v+=n\nP set +x\n",
		),
		(
			r#"i=0; PS4='${ i=$((i+1)); printf P; } '; set -x; a[i]=X; set +x; printf '%s:%s:%s\n' "$i" "${!a[*]}" "${a[*]}""#,
			"2:1:X\n",
			"P a[i]=X\nP set +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prefix_assignments_trace_the_bound_environment_but_command_trace_does_not() {
	for (script, stdout, stderr) in [
		(
			r#"unset a b; PS4='+${a-unset}:${b-unset} '; set -x; a=one b=$a printf 'ARGS=%s:%s\n' "$a" "$b"; set +x; printf 'AFTER=%s:%s\n' "${a-unset}" "${b-unset}""#,
			"ARGS=:\nAFTER=unset:unset\n",
			"+one:unset a=one\n+one:one b=one\n+unset:unset printf 'ARGS=%s:%s\\n' '' \
			 ''\n+unset:unset set +x\n",
		),
		(
			r#"declare -i n=5; PS4='+${n} '; set -x; n+=1+2 :; set +x; printf '%s\n' "$n""#,
			"5\n",
			"+8 n=8\n+5 :\n+5 set +x\n",
		),
		(
			r#"n=0; PS4='${ n=$((n+1)); printf P; } '; set -x; a=$n b=$n :; set +x; printf '%s:%s:%s\n' "$n" "${a-unset}" "${b-unset}""#,
			"4:unset:unset\n",
			"P a=0\nP b=1\nP :\nP set +x\n",
		),
		(
			r#"v=old; PS4='+${v} '; set -x; v+=new :; set +x; printf '%s\n' "$v""#,
			"old\n",
			"+oldnew v=oldnew\n+old :\n+old set +x\n",
		),
		(
			r#"target=old; declare -n r=target; PS4='+${r}:${target} '; set -x; r+=X :; set +x; printf '%s:%s\n' "$r" "$target""#,
			"old:old\n",
			"+oldX:oldX r=oldX\n+old:old :\n+old:old set +x\n",
		),
		(
			r#"unset a b; set -k; PS4='+${a-unset}:${b-unset} '; set -x; : a=one b=$a; set +x; printf '%s:%s\n' "${a-unset}" "${b-unset}""#,
			"unset:unset\n",
			"+one:unset a=one\n+one:one b=one\n+unset:unset :\n+unset:unset set +x\n",
		),
		(
			r#"a=old; PS4='${ printf "<%s>" "$a"; }${a} '; set -x; a=prefix b=$a :; set +x"#,
			"",
			"<old>prefix a=prefix\n<old>prefix b=prefix\n<old>old :\n<old>old set +x\n",
		),
		(
			r#"a=old; PS4='$(printf "<%s>" "$a")${a} '; set -x; a=prefix b=$a :; set +x"#,
			"",
			"<prefix>prefix a=prefix\n<prefix>prefix b=prefix\n<prefix>old :\n<old>old set +x\n",
		),
		(
			r#"a=old; PS4='${ a=ps4; printf "<%s>" "$a"; }${a} '; set -x; a=prefix b=$a :; set +x; printf '%s\n' "$a""#,
			"ps4\n",
			"<ps4>ps4 a=prefix\n<ps4>ps4 b=prefix\n<ps4>ps4 :\n<ps4>ps4 set +x\n",
		),
		(
			r#"a=old; n=0; PS4='${ n=$((n+1)); a=ps4; printf P; } '; set -x; a=prefix b=$a /bin/sh -c 'printf "child=%s:%s\n" "$a" "$b"'; set +x; printf 'root=%s n=%s\n' "$a" "$n""#,
			"child=prefix:prefix\nroot=ps4 n=4\n",
			"P a=prefix\nP b=prefix\nP /bin/sh -c 'printf \"child=%s:%s\\n\" \"$a\" \"$b\"'\nP set \
			 +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_side_effects_use_the_trace_boundary_streams() {
	for (script, stdout, stderr) in [
		(
			r#"PS4='$(printf PS4OUT >&2)+ '; set -x; a=one b=two printf BODY 2>trace; set +x; printf 'TRACE='; cat trace"#,
			"BODYTRACE=",
			"PS4OUT+ a=one\nPS4OUT+ b=two\nPS4OUT+ printf BODY\nPS4OUT+ set +x\n",
		),
		(
			r#"PS4='${ printf SIDE >&2; exec 2>trace; printf P; } '; set -x; a=one b=two; set +x; cat trace"#,
			"P set +x\n",
			"SIDE",
		),
		(
			r#"exec 2>&-; n=0; PS4='${| n=$((n+1)); exec 2>trace; REPLY=P; } '; set -x; a=$n b=$n; set +x; printf '%s:%s:%s\n' "$n" "$a" "$b"; cat trace"#,
			"3:0:1\nP set +x\n",
			"",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn indexed_assignments_trace_before_expanding_the_subscript() {
	for (script, stdout, stderr) in [
		(
			r#"i=1; a=(old); PS4='+${i} '; set -x; a[$i]=X; set +x; printf '%s:%s\n' "${!a[*]}" "${a[*]}""#,
			"0 1:old X\n",
			"+1 a[$i]=X\n+1 set +x\n",
		),
		(
			r#"i=0; PS4='+${i} '; set -x; a[$((i++))]=$((i++)); set +x; printf '%s:%s:%s\n' "$i" "${!a[*]}" "${a[*]}""#,
			"2:1:0\n",
			"+1 a[$((i++))]=0\n+2 set +x\n",
		),
		(
			r#"i=0; PS4='${ i=$((i+1)); printf P; } '; set -x; a[$i]=X; set +x; printf '%s:%s:%s\n' "$i" "${!a[*]}" "${a[*]}""#,
			"2:1:X\n",
			"P a[$i]=X\nP set +x\n",
		),
		(
			r#"i=0; PS4='+${i} '; set -x; a[$(printf 1)]=$((i++)); set +x; printf '%s:%s:%s\n' "$i" "${!a[*]}" "${a[*]}""#,
			"1:1:0\n",
			"+1 a[$(printf 1)]=0\n++1 printf 1\n+1 set +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_temporary_environment_visibility_uses_execution_context() {
	for (script, stdout, stderr) in [
		(
			r#"unset a; PS4='+${a-unset} '; set -x; eval 'a=one :'; set +x"#,
			"",
			"+unset eval 'a=one :'\n++one a=one\n++one :\n+unset set +x\n",
		),
		(
			r#"printf '%s\n' 'a=one :' >body; unset a; PS4='+${a-unset} '; set -x; . ./body; set +x"#,
			"",
			"+unset . ./body\n++one a=one\n++one :\n+unset set +x\n",
		),
		(
			r#"f(){ a=one :; }; unset a; PS4='+${a-unset} '; set -x; f; set +x"#,
			"",
			"+unset f\n+one a=one\n+unset :\n+unset set +x\n",
		),
		(
			r#"f(){ a=one :; }; unset a; PS4='+${a-unset} '; set -x; builtin eval f; set +x"#,
			"",
			"+unset builtin eval f\n++unset f\n++one a=one\n++one :\n+unset set +x\n",
		),
		(
			r#"f(){ a=one :; }; unset a; PS4='+${a-unset} '; set -x; command eval f; set +x"#,
			"",
			"+unset command eval f\n++unset f\n++one a=one\n++one :\n+unset set +x\n",
		),
		(
			r#"exec 3>trace; BASH_XTRACEFD=3; f(){ a=one :; COMPREPLY=(ok); }; unset a; PS4='+${a-unset} '; set -x; compgen -F f 2>/dev/null; set +x; cat trace"#,
			"ok\n+unset compgen -F f\n+one a=one\n+one :\n+unset COMPREPLY=(ok)\n+unset set +x\n",
			"",
		),
		(
			r#"unset a; PS4='+${a-unset} '; set -x; ( a=one : ); set +x"#,
			"",
			"+one a=one\n+one :\n+unset set +x\n",
		),
		(
			r#"unset a; PS4='+${a-unset} '; set -x; x=$(a=one :); set +x"#,
			"",
			"++one a=one\n++one :\n+unset x=\n+unset set +x\n",
		),
		(
			r#"a=old; PS4='${ a=ps4; printf "<%s>" "$a"; }${a} '; set -x; eval 'a=prefix b=$a :'; set +x; printf '%s\n' "$a""#,
			"ps4\n",
			"<ps4>ps4 eval 'a=prefix b=$a :'\n<<ps4>prefix a=prefix\n<<ps4>prefix \
			 b=prefix\n<<ps4>prefix :\n<ps4>ps4 set +x\n",
		),
		(
			r#"bash --noprofile --norc -c 'unset a; PS4="+\${a-unset} "; set -x; a=one :; set +x'"#,
			"",
			"+one a=one\n+unset :\n+unset set +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn value_substitution_replies_reach_their_waiting_prompt() {
	for (script, stdout, stderr) in [
		(
			r#"REPLY=outer; PS4='${| REPLY=P; } '; set -x; :; set +x; printf 'reply=[%s]\n' "$REPLY""#,
			"reply=[outer]\n",
			"P :\nP set +x\n",
		),
		// An operation and a prompt can both own a pending no-fork value.
		// Completing the prompt must not fill the operation's capture.
		(
			r#"REPLY=outer; PS4='${| REPLY=P; } '; set -x; x=${| REPLY=X; }; set +x; printf 'x=[%s] reply=[%s]\n' "$x" "$REPLY""#,
			"x=[X] reply=[outer]\n",
			"PP REPLY=X\nP x=X\nP set +x\n",
		),
		// Conversely, a prompt body can contain an ordinary value expansion.
		(
			r#"REPLY=outer; PS4='${| REPLY=${| REPLY=P; }; } '; set -x; :; set +x; printf 'reply=[%s]\n' "$REPLY""#,
			"reply=[outer]\n",
			"P :\nP set +x\n",
		),
	] {
		assert_trace(script, stdout, stderr).await;
	}
}
