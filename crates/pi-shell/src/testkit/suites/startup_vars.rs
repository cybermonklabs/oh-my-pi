//! Variables bash sets at startup from host facts.

use crate::{
	bash::{Script, ShellInit},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init, run_script},
};

/// `GROUPS` lists the real gid first, then the other supplementary groups
/// (`FakeHost`: gid 1000, groups 1000 and 27), and ignores assignments like
/// bash's `noassign` attribute (`dynvar.tests`: `GROUPS[0]=-1`).
#[test]
fn groups_lists_real_gid_first_and_ignores_assignment() {
	let src =
		"echo \"${GROUPS[@]}\"; GROUPS[0]=-1; GROUPS=(5); echo \"$? ${GROUPS[0]} ${#GROUPS[@]}\"";
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "1000 27\n0 1000 2\n");
	assert_eq!(String::from_utf8_lossy(&out.stderr), "");
}

/// Interactive shells expand aliases by default; disabling the option stops
/// expansion only for commands read on later lines.
#[test]
fn interactive_aliases_execute_with_the_read_time_option() {
	let init = ShellInit { interactive: true, ..skeleton_init(&[]) };
	let mut rig = Rig::new(FakeHost::new(), init);
	let source = b"alias q='echo interactive'\nq\nshopt -u expand_aliases; q\nq 2>/dev/null; echo st=$?\n";
	assert_eq!(rig.run(Script::command(source.to_vec()), Fault::None), 0);
	assert_eq!(rig.host.stdout.bytes(), b"interactive\ninteractive\nst=127\n");
	assert_eq!(rig.host.stderr.bytes(), b"");
}

/// An explicit startup option takes precedence over the interactive default.
#[test]
fn interactive_alias_startup_override_is_respected() {
	let init = ShellInit {
		interactive: true,
		options: vec![("expand_aliases".into(), false)],
		..skeleton_init(&[])
	};
	let mut rig = Rig::new(FakeHost::new(), init);
	let source = b"alias q='echo interactive'\nq 2>/dev/null; echo st=$?\n";
	assert_eq!(rig.run(Script::command(source.to_vec()), Fault::None), 0);
	assert_eq!(rig.host.stdout.bytes(), b"st=127\n");
	assert_eq!(rig.host.stderr.bytes(), b"");
}
