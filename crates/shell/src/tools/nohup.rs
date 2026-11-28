//! `nohup COMMAND [ARG]...`: runs the command in a detached subshell tree
//! ([`crate::bash::Lineage::detached`]) and reports its status.
//!
//! pi's `nohup` exists so a backgrounded server outlives the shell: the
//! session's cancel leaves a detached tree running and the spawner does not
//! end its externals at teardown. A signal aimed at the `nohup` itself
//! (`kill $!` of `nohup cmd &`, `kill %1`) still reaches the command, as it
//! reaches the program a real `nohup` `exec`s. Unlike coreutils, `SIGHUP` is
//! not masked and output is not redirected to `nohup.out`. A program it
//! cannot run is reported as coreutils reports it (`nohup: failed to run
//! command 'NAME': …`, 127 when nothing was found, else 126).

use bstr::BString;
use omp_builtins::extras::gnu_quote_shell_bytes;

use super::{Child, Out, Turn, ctype_is_utf8};
use crate::bash::{CallOutcome, ShellApi, ToolCall};

/// coreutils' exit status for `nohup`'s own failures.
const EXIT_FAILURE: i32 = 125;

const HELP: &str = "\
Usage: nohup COMMAND [ARG]...
  or:  nohup OPTION
Run COMMAND immune to the shell's teardown, in a new process group.

      --help     display this help and exit
      --version  output version information and exit
";

/// What an invocation asks for.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
	Run(Vec<BString>),
	Help,
	Version,
	Missing,
}

/// Parse `argv` (with `nohup` itself) as GNU nohup does: `--help` and
/// `--version` only as the first argument, and one leading `--` ends option
/// processing (`nohup -- --help` runs a command named `--help`).
fn parse(argv: &[BString]) -> Parsed {
	let mut operands = argv.get(1..).unwrap_or_default();
	match operands.first().map(|a| a.as_slice()) {
		Some(b"--help") => return Parsed::Help,
		Some(b"--version") => return Parsed::Version,
		Some(b"--") => operands = &operands[1..],
		_ => {},
	}
	if operands.is_empty() {
		Parsed::Missing
	} else {
		Parsed::Run(operands.to_vec())
	}
}

/// A `nohup` call.
pub(super) struct Nohup {
	pub(super) child: Child,
	call:             ToolCall,
	out:              Out,
	/// The command, until it starts.
	command:          Option<Vec<BString>>,
	/// The command's name, which a report of a program it cannot run quotes.
	name:             BString,
	/// The answer, once known.
	exit:             Option<i32>,
}

impl Nohup {
	pub(super) fn new(call: ToolCall) -> Self {
		let mut out = Out::default();
		let (command, exit) = match parse(&call.argv) {
			Parsed::Run(command) => (Some(command), None),
			Parsed::Help => {
				out.push(1, HELP);
				(None, Some(0))
			},
			Parsed::Version => {
				out.push(1, format!("nohup (pi) {}\n", env!("CARGO_PKG_VERSION")));
				(None, Some(0))
			},
			Parsed::Missing => {
				out.push(2, "nohup: missing operand\n");
				(None, Some(EXIT_FAILURE))
			},
		};
		let child = Child { reports: true, ..Child::default() };
		Self { child, call, out, command, name: BString::default(), exit }
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		if let Some(command) = self.command.take() {
			self.name.clone_from(&command[0]);
			self.child.start(api, turn, &self.call, command, true, "");
		}
		if self.exit.is_none() {
			let status = self.child.status?;
			self.exit = Some(self.ended(status));
		}
		let code = self.exit?;
		self.out.flush(api).then_some(CallOutcome::Exit(code))
	}

	/// The answer once the command ended with `status`: GNU's report of a
	/// program it could not run (`nohup: failed to run command 'NAME': …`,
	/// 126, or 127 when nothing was found), or the status.
	fn ended(&mut self, status: i32) -> i32 {
		let Some((code, text)) = self.child.cannot_run() else {
			return status;
		};
		let name = gnu_quote_shell_bytes(ctype_is_utf8(&self.call), &self.name);
		self
			.out
			.push(2, format!("nohup: failed to run command {name}: {text}\n"));
		code
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parsed(argv: &[&str]) -> Parsed {
		let argv: Vec<BString> = std::iter::once("nohup")
			.chain(argv.iter().copied())
			.map(BString::from)
			.collect();
		parse(&argv)
	}

	fn run(argv: &[&str]) -> Parsed {
		Parsed::Run(argv.iter().copied().map(BString::from).collect())
	}

	#[test]
	fn options_only_lead_and_one_dashdash_ends_them() {
		assert_eq!(parsed(&["--", "sleep", "1"]), run(&["sleep", "1"]));
		assert_eq!(parsed(&["--", "--", "x"]), run(&["--", "x"]));
		assert_eq!(parsed(&["--", "--help"]), run(&["--help"]));
		assert_eq!(parsed(&["echo", "a", "--", "b"]), run(&["echo", "a", "--", "b"]));
		assert_eq!(parsed(&["--help"]), Parsed::Help);
		assert_eq!(parsed(&["--version"]), Parsed::Version);
		assert_eq!(parsed(&[]), Parsed::Missing);
		assert_eq!(parsed(&["--"]), Parsed::Missing);
	}
}
