//! GNU getopt's reading of an abbreviated long option, for the utilities
//! whose clap parser holds long options GNU's tool lacks.
//!
//! getopt reads a prefix as the one long option it begins. clap's
//! `infer_long_args` does the same over all of the builtin's options, so a
//! prefix that begins one of GNU's options and also an option only the
//! builtin has is ambiguous to clap where GNU accepts it: `cp --pr` is GNU's
//! `--preserve`, while the builtin also has `--progress`. Each argument is
//! written out by its full name, as getopt resolves it, before clap reads it.

use std::ffi::OsString;

use itertools::Itertools;

/// A long option a utility accepts: its names - the long name first, then
/// its aliases, which getopt counts as the same option - and whether it takes
/// the next argument as its value.
struct LongOption {
	names:       Vec<String>,
	takes_value: bool,
}

/// The options of a utility, read from its parser's own definition, and
/// those of them its GNU tool lacks or hides.
pub(crate) struct OptionTable {
	/// Every long option, so whether one takes the next argument is known
	/// for every name and abbreviation clap accepts (`--bef 1` is
	/// `--before-context 1`).
	long:             Vec<LongOption>,
	/// The short options that take a value (`-e`, `-m`, `-A`, ...).
	pub short_valued: Vec<char>,
	/// The long options the builtin has and GNU's tool does not, or hides
	/// behind a third dash (`rm ---presume-input-tty`): no candidate for an
	/// abbreviation where an option GNU has is one.
	builtin_only:     &'static [&'static str],
}

impl OptionTable {
	/// The options of `command`, of which `builtin_only` are the builtin's
	/// alone.
	pub fn new(mut command: clap::Command, builtin_only: &'static [&'static str]) -> Self {
		command.build();
		// An option whose value is optional (`--color`) does not take the
		// next argument.
		let takes_value =
			|arg: &clap::Arg| arg.get_num_args().is_some_and(|range| range.min_values() > 0);
		let long = command
			.get_arguments()
			.filter_map(|arg| {
				let mut names = vec![arg.get_long()?.to_owned()];
				if let Some(aliases) = arg.get_all_aliases() {
					names.extend(aliases.into_iter().map(str::to_owned));
				}
				Some(LongOption { names, takes_value: takes_value(arg) })
			})
			.collect();
		let short_valued = command
			.get_arguments()
			.filter(|&arg| takes_value(arg))
			.filter_map(clap::Arg::get_short)
			.collect();
		Self { long, short_valued, builtin_only }
	}

	/// The long option `name` names, exactly or as the abbreviation getopt
	/// accepts: a prefix of the names of one option alone, so `--regex` is
	/// `--regexp` and `--col` is `--color`, whose alias `--colour` is the
	/// same option, or, where it also begins one the builtin alone has, of
	/// one of the others alone.
	fn long_option(&self, name: &str) -> Option<&LongOption> {
		if name.is_empty() {
			return None;
		}
		if let Some(option) = self.long.iter().find(|option| option.names.iter().any(|n| n == name)) {
			return Some(option);
		}
		let begins = |option: &&LongOption| option.names.iter().any(|n| n.starts_with(name));
		self.long.iter().filter(begins).exactly_one().ok().or_else(|| {
			self.long
				.iter()
				.filter(begins)
				.filter(|option| !self.builtin_only.contains(&option.names[0].as_str()))
				.exactly_one()
				.ok()
		})
	}

	/// `long`, an argument without its leading `--`, written out by the full
	/// name of the option it names (with its `=value`, if any), and whether
	/// that option takes the next argument as its value; `None` where it
	/// names no option alone, and clap reports it as it stands.
	pub fn spell_out(&self, long: &str) -> Option<(OsString, bool)> {
		let (name, value) =
			long.split_once('=').map_or((long, None), |(name, value)| (name, Some(value)));
		let option = self.long_option(name)?;
		let spelled = match value {
			Some(value) => format!("--{}={value}", option.names[0]),
			None => format!("--{}", option.names[0]),
		};
		Some((OsString::from(spelled), value.is_none() && option.takes_value))
	}

	/// Whether the argument `arg` takes the next argument as its value: a
	/// long option that takes a value, written without its `=value`
	/// (`--lines`), or a group of short options in which the first that
	/// takes a value ends the group (`-n`, `-qn`; `-n5` holds its value).
	pub fn value_follows(&self, arg: &str) -> bool {
		if let Some(long) = arg.strip_prefix("--") {
			return !long.contains('=') && self.long_option(long).is_some_and(|option| option.takes_value);
		}
		arg.strip_prefix('-').is_some_and(|group| {
			group
				.char_indices()
				.find(|&(_, option)| self.short_valued.contains(&option))
				.is_some_and(|(at, option)| at + option.len_utf8() == group.len())
		})
	}

	/// Writes each long option of `argv` out by its full name; see
	/// [`Self::spell_out`]. The value of an option, and every argument after
	/// `--`, is left as it is.
	pub fn spell_out_all(&self, argv: Vec<OsString>) -> Vec<OsString> {
		let mut spelled = Vec::with_capacity(argv.len());
		let mut args = argv.into_iter();
		spelled.extend(args.next());
		while let Some(arg) = args.next() {
			let Some(text) = arg.to_str() else {
				spelled.push(arg);
				continue;
			};
			if text == "--" {
				spelled.push(arg);
				spelled.extend(args);
				break;
			}
			let value_follows = if let Some(long) = text.strip_prefix("--") {
				match self.spell_out(long) {
					Some((full, value_follows)) => {
						spelled.push(full);
						value_follows
					},
					None => {
						spelled.push(arg);
						false
					},
				}
			} else {
				let value_follows = self.value_follows(text);
				spelled.push(arg);
				value_follows
			};
			if value_follows {
				spelled.extend(args.next());
			}
		}
		spelled
	}
}
