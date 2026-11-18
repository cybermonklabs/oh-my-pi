//! zsh/net/socket and zsh/net/tcp over real sockets, through the obash
//! binary run as `zsh -f -c SCRIPT` in a fresh temporary directory: a
//! Unix-domain listen/accept/connect round trip and a TCP loopback round
//! trip with `ztcp -L` and `ztcp` listings. Expected output from
//! `/bin/zsh -f SCRIPT` 5.9 in the same setup (macOS); fd numbers are not
//! compared where zsh's own input (fd 10) shifts them.

#![cfg(unix)]

mod obash_support;

use std::{os::unix::process::CommandExt, process::Command};

use crate::obash_support::{obash, output};

/// Run `script` as `zsh -f -c script` in a new empty directory with
/// `$PORT` set: stdout, stderr, status.
fn zsh(script: &str, port: u16) -> (String, String, i32) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd: Command = obash();
	cmd.arg0("zsh");
	let out = output(
		cmd.current_dir(dir.path())
			.env("PORT", port.to_string())
			.args(["-f", "-c", script]),
	);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status.code().unwrap_or(-1),
	)
}

/// A TCP port nothing listens on right now. The probe's listener is dropped,
/// so another process can take the port before the script listens on it:
/// see [`zsh_tcp_on_a_free_port`].
fn free_port() -> u16 {
	let l = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
	l.local_addr().unwrap().port()
}

/// Runs `script` on a free port. The script listens on `$PORT` on its second
/// line (`ztcp -l $PORT`), and its last two lines connect to the port once it
/// has closed every socket there, expecting a refusal (each `echo $?` prints
/// 1). `ztcp` takes no port 0, so the port is probed first, and another
/// process can take it before the listen or after the close. A run that lost
/// the port either way is retried on a fresh port: the listen failed, or one
/// of those last connects reached a listener (its `echo $?` printed 0). Any
/// other output is the test's, and after 5 lost ports the test fails.
fn zsh_tcp_on_a_free_port(script: &str) -> (u16, (String, String, i32)) {
	let mut lost = Vec::new();
	for _ in 0..5 {
		let port = free_port();
		let run = zsh(script, port);
		if run.1.starts_with("zsh:ztcp:2:") {
			lost.push(format!("port {port}: {}", run.1.lines().next().unwrap_or_default()));
			continue;
		}
		let last: Vec<&str> = run.0.lines().rev().take(2).collect();
		if last.contains(&"0") {
			lost.push(format!(
				"port {port}: a connect after the close was accepted ({last:?}, last first)"
			));
			continue;
		}
		return (port, run);
	}
	panic!("the script lost its port on 5 fresh ports: {lost:?}");
}

#[test]
fn zsh_mod_net_unix_socket_round_trip() {
	let (out, err, st) = zsh(
		"zmodload zsh/net/socket
zsocket -l sock; l=$REPLY; (( l >= 10 )) && echo listener
zsocket -a -t $l; echo t=$?
( zsocket sock; print -u $REPLY hello )
zsocket -v -a -t $l; a=$REPLY
read -u $a line; echo got $line
zsocket -v sock2; echo $?
zsocket -l sock; echo $?
exec {l}>&-; rm sock",
		0,
	);
	assert_eq!(out, "listener\nt=1\nnew connection from  is on fd 3\ngot hello\n1\n1\n");
	assert_eq!(
		err,
		"zsh:zsocket:7: connection failed: no such file or directory
zsh:zsocket:8: could not bind to sock: address already in use
"
	);
	assert_eq!(st, 0);
}

#[test]
fn zsh_mod_net_tcp_loopback_round_trip() {
	let (port, (out, err, st)) = zsh_tcp_on_a_free_port(
		"zmodload zsh/net/tcp
ztcp -l $PORT; l=$REPLY
ztcp -L | while read fd rest; do print -r -- $rest; done
ztcp 127.0.0.1 $PORT; o=$REPLY
ztcp -a $l; i=$REPLY
ztcp -L | while read fd t la lp ra rp; do print -r -- $t $la $lp $ra ${${t:#I}:+$rp}; done
ztcp | while read l1 dir r rest; do print -r -- ${l1%:<->}  $dir ${r%:<->}; done
print -u $o hi; read -u $i x; echo $x
print -u $i back; read -u $o y; echo $y
x=$(ztcp -v 127.0.0.1 $PORT); print -r -- ${x%% is now*}
ztcp -c $o; n=(${(f)\"$(ztcp -L)\"}); echo $#n
ztcp -c; n=(${(f)\"$(ztcp -L)\"}); echo $#n
ztcp 127.0.0.1 $PORT; echo $?
ztcp localhost $PORT; echo $?",
	);
	// zsh prints the port of `ztcp -v HOST PORT` in network byte order.
	let shown = i32::from(port.to_be());
	assert_eq!(
		out,
		format!(
			"L 0.0.0.0 {port} 0.0.0.0 0\nL 0.0.0.0 {port} 0.0.0.0 0\nO 0.0.0.0 0 localhost {port}\nI \
			 0.0.0.0 0 localhost\n0.0.0.0 -< 0.0.0.0\n0.0.0.0 -> localhost\n0.0.0.0 <- \
			 localhost\nhi\nback\n127.0.0.1:{shown}\n2\n0\n1\n1\n"
		)
	);
	assert_eq!(
		err,
		"zsh:ztcp:13: connection failed: connection refused
zsh:ztcp:14: connection failed: connection refused
"
	);
	assert_eq!(st, 0);
}
