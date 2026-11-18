//! `grep` builtin implemented on top of the ripgrep libraries.
//!
//! Matching uses `grep-regex`/`grep-searcher`; recursive searches walk
//! through `pi-walker` and search the files inline, moving to parallel
//! workers once the search runs long, printing files in path order. Also hosts
//! the plumbing `rg` shares with it: exit status, record layout, and the
//! line-length bound.


use std::{
	ffi::{OsStr, OsString},
	fmt,
	io::{self, Write},
	path::{Path, PathBuf},
	sync::{
		Arc, LazyLock, OnceLock,
		atomic::{AtomicBool, Ordering},
	},
};

use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, ValueEnum, parser::ValueSource};
use globset::{Glob, GlobMatcher};
use grep_matcher::{ByteSet, LineMatchKind, LineTerminator, Matcher};
use grep_pcre2::RegexMatcherBuilder as PcreMatcherBuilder;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{
	BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkFinish, SinkMatch,
};
use pi_walker::{
	FileType,
	exec,
	fs::FileOpener,
	grep::{Engine, pcre2_jit_enabled},
	walk,
};
use crate::bre;
use crate::host::{AsyncUtility, Host, StdoutFile};
use crate::stdio;

/// Exit status of a `grep` or `rg` run: 0 when a line was selected, 1 when
/// none was, 2 on any error, except that under `-q` a match outranks errors.
pub(crate) const fn exit_status(quiet: bool, any_match: bool, had_error: bool) -> i32 {
	if quiet && any_match {
		0
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}

/// How `grep` and `rg` lay out the file name and record ends they print.
#[derive(Clone, Copy)]
pub(crate) struct RecordFormat {
	/// Byte printed in place of each `/` in a path (`rg --path-separator`).
	/// On Windows `\` is rewritten too, so displayed paths stay uniform.
	pub path_separator: Option<u8>,
	/// End a printed path with NUL instead of its separator or terminator
	/// (`grep -Z`, `rg -0`).
	pub null_paths:     bool,
	/// Ends each record: `\n`, or NUL under `grep -z`.
	pub terminator:     u8,
}

impl RecordFormat {
	fn write_path<W: Write + ?Sized>(&self, out: &mut W, path: &[u8]) -> io::Result<()> {
		let Some(separator) = self.path_separator else {
			return out.write_all(path);
		};
		let mut rest = path;
		while let Some(pos) = rest
			.iter()
			.position(|&byte| byte == b'/' || (cfg!(windows) && byte == b'\\'))
		{
			out.write_all(&rest[..pos])?;
			out.write_all(&[separator])?;
			rest = &rest[pos + 1..];
		}
		out.write_all(rest)
	}

	/// Writes the `PATH:LINE:COLUMN:OFFSET:` prefix of a line record, skipping
	/// absent fields; under `null_paths` NUL replaces the separator after the
	/// path. Returns whether any field was written.
	pub fn write_prefix<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
		line_number: Option<u64>,
		column: Option<usize>,
		byte_offset: Option<u64>,
		separator: u8,
	) -> io::Result<bool> {
		if let Some(path) = path {
			self.write_path(out, path)?;
			out.write_all(&[if self.null_paths { b'\0' } else { separator }])?;
		}
		if let Some(number) = line_number {
			out.write_all(number.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		if let Some(column) = column {
			out.write_all(column.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		if let Some(offset) = byte_offset {
			out.write_all(offset.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
			out.write_all(&[separator])?;
		}
		Ok(path.is_some() || line_number.is_some() || column.is_some() || byte_offset.is_some())
	}

	/// Writes a file-name record (`-l`, `-L`, `rg --files`): the path ended
	/// by NUL under `null_paths`, else by the terminator. An unnamed input
	/// prints only the terminator, and nothing under `null_paths`.
	pub fn write_path_record<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
	) -> io::Result<()> {
		match path {
			Some(path) => {
				self.write_path(out, path)?;
				out.write_all(&[if self.null_paths { b'\0' } else { self.terminator }])
			},
			None if self.null_paths => Ok(()),
			None => out.write_all(&[self.terminator]),
		}
	}

	/// Writes a `-c` record: the optional `PATH:` prefix, then `count`.
	pub fn write_count_record<W: Write + ?Sized>(
		&self,
		out: &mut W,
		path: Option<&[u8]>,
		count: u64,
	) -> io::Result<()> {
		self.write_prefix(out, path, None, None, None, b':')?;
		out.write_all(count.format_into(&mut fmt::NumBuffer::new()).as_bytes())?;
		out.write_all(&[self.terminator])
	}
}

/// Calls `visit` with each non-empty match in `line`, left to right as `-o`
/// prints them, plus its absolute byte offset given the line's `line_offset`.
#[cfg(feature = "util.rg")]
pub(crate) fn for_each_nonempty_match<M: Matcher>(
	matcher: &M,
	line: &[u8],
	line_offset: u64,
	visit: impl FnMut(grep_matcher::Match, u64) -> io::Result<()>,
) -> io::Result<()> {
	for_each_match_with(matcher, line, line_offset, |_| Ok(None), visit)
}

/// Calls `visit` with each match `-o` prints in `line`, left to right, plus
/// its absolute byte offset given the line's `line_offset`.
///
/// GNU prints the longest match at each position and never prints an empty
/// one, while the engines prefer the first alternative that matches there.
/// `longest_at` answers, for the position the engine's match starts at, the
/// longest non-empty match any alternative has there; with no alternative to
/// search it answers `None` and the engine's own match is printed.
fn for_each_match_with<M: Matcher>(
	matcher: &M,
	line: &[u8],
	line_offset: u64,
	mut longest_at: impl FnMut(usize) -> io::Result<Option<grep_matcher::Match>>,
	mut visit: impl FnMut(grep_matcher::Match, u64) -> io::Result<()>,
) -> io::Result<()> {
	let mut at = 0usize;
	while at <= line.len() {
		let Some(found) = matcher
			.find_at(line, at)
			.map_err(|error| io::Error::other(error.to_string()))?
		else {
			break;
		};
		let printed = match longest_at(found.start())? {
			Some(longest) => longest,
			None if !found.is_empty() => found,
			// An empty match with nothing longer at that position prints
			// nothing, and the search goes on past it.
			None => {
				at = found.end() + 1;
				continue;
			},
		};
		let match_offset = line_offset.saturating_add(
			u64::try_from(printed.start()).map_err(|error| io::Error::other(error.to_string()))?,
		);
		visit(printed, match_offset)?;
		// What is printed is never empty and starts at `at` or later, so the
		// search always moves on.
		at = printed.end();
	}
	Ok(())
}

/// The longest non-empty match that one of `patterns`, each compiled alone,
/// finds starting at `start` in `line`.
///
/// `next` holds, for each pattern, its leftmost match at or after the last
/// position asked in this line (`Some(None)`: none), or `None` until asked.
/// A pattern is searched again only once `start` passes that match, so asked
/// at each position of a long line, each pattern scans the line once.
fn longest_match_at(
	patterns: &[Engine],
	next: &mut [Option<Option<grep_matcher::Match>>],
	line: &[u8],
	start: usize,
) -> io::Result<Option<grep_matcher::Match>> {
	let mut longest: Option<grep_matcher::Match> = None;
	for (pattern, cached) in patterns.iter().zip(next.iter_mut()) {
		let found = match *cached {
			Some(found) if found.is_none_or(|found| found.start() >= start) => found,
			_ => {
				let found = pattern
					.find_at(line, start)
					.map_err(|error| io::Error::other(error.to_string()))?;
				*cached = Some(found);
				found
			},
		};
		if let Some(found) = found
			&& found.start() == start
			&& found.end() > longest.map_or(start, |best| best.end())
		{
			longest = Some(found);
		}
	}
	Ok(longest)
}

#[derive(Parser, Debug)]
#[command(
	name = "grep",
	version = concat!("grep (pi-uu-grep) ", env!("CARGO_PKG_VERSION")),
	about = "Search for PATTERN in each FILE or standard input.",
	disable_help_flag = true,
	disable_version_flag = true,
	args_override_self = true,
	infer_long_args = true
)]
struct GrepArgs {
	/// Use PATTERN for matching (may be repeated; all patterns are OR-ed).
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN", allow_hyphen_values = true)]
	patterns: Vec<String>,

	/// Read patterns from FILE, one per line.
	#[arg(short = 'f', long = "file", value_name = "FILE", allow_hyphen_values = true)]
	pattern_files: Vec<OsString>,

	/// Interpret PATTERN as a strict extended regular expression.
	#[arg(short = 'E', long = "extended-regexp")]
	extended: bool,

	/// Interpret PATTERN using the default basic-compatible mode.
	#[arg(short = 'G', long = "basic-regexp")]
	basic: bool,

	/// Interpret PATTERN as a fixed string.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed: bool,

	/// Interpret PATTERN as a Perl-compatible regular expression.
	#[arg(short = 'P', long = "perl-regexp")]
	perl: bool,

	/// Ignore case distinctions in patterns and data.
	#[arg(short = 'i', short_alias = 'y', long = "ignore-case")]
	ignore_case: bool,

	/// Restore case-sensitive matching after an earlier -i.
	#[arg(long = "no-ignore-case")]
	no_ignore_case: bool,

	/// Select non-matching lines.
	#[arg(short = 'v', long = "invert-match")]
	invert: bool,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Print only a count of selected lines per FILE.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print only the names of FILEs with at least one selected line.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Print only the names of FILEs with no selected lines.
	#[arg(short = 'L', long = "files-without-match")]
	files_without_match: bool,

	/// Stop after NUM selected lines in each input.
	#[arg(short = 'm', long = "max-count", value_name = "NUM", allow_hyphen_values = true)]
	max_count: Option<i64>,

	/// Print only the matched non-empty parts of selected lines.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Quiet; suppress normal output and stop after the first selected line.
	#[arg(short = 'q', long = "quiet", visible_alias = "silent")]
	quiet: bool,

	/// Suppress error messages about nonexistent or unreadable files.
	#[arg(short = 's', long = "no-messages")]
	no_messages: bool,

	/// Prefix output with the zero-based byte offset.
	#[arg(short = 'b', long = "byte-offset")]
	byte_offset: bool,

	/// Always print the file name with output lines.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Never print the file name with output lines.
	#[arg(short = 'h', long = "no-filename")]
	no_filename: bool,

	/// Use LABEL as the displayed name for standard input.
	#[arg(long = "label", value_name = "LABEL")]
	label: Option<OsString>,

	/// Prefix each output line with its one-based line number.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Align line content on a tab stop after output prefixes.
	#[arg(short = 'T', long = "initial-tab")]
	initial_tab: bool,

	/// Write NUL instead of the separator following a file name.
	#[arg(short = 'Z', long = "null")]
	null_paths: bool,

	/// Print NUM lines of trailing context after selected lines.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Print NUM lines of leading context before selected lines.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Print NUM lines of leading and trailing context.
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Print STRING between non-adjacent groups of context lines.
	#[arg(long = "group-separator", value_name = "STRING")]
	group_separator: Option<String>,

	/// Do not print a separator between context groups.
	#[arg(long = "no-group-separator")]
	no_group_separator: bool,

	/// Process binary input as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Treat binary input as having no selected lines.
	#[arg(short = 'I')]
	binary_without_match: bool,

	/// Choose how binary input is searched.
	#[arg(long = "binary-files", value_name = "TYPE")]
	binary_files: Option<BinaryFiles>,

	/// Choose how device, FIFO, and socket operands are handled.
	#[arg(short = 'D', long = "devices", value_name = "ACTION")]
	devices: Option<DeviceAction>,

	/// Choose how directory operands are handled.
	#[arg(short = 'd', long = "directories", value_name = "ACTION")]
	directories: Option<DirectoryAction>,

	/// Search files matching GLOB.
	#[arg(long = "include", value_name = "GLOB")]
	include: Vec<String>,

	/// Skip files matching GLOB.
	#[arg(long = "exclude", value_name = "GLOB")]
	exclude: Vec<String>,

	/// Read file exclusion globs from FILE.
	#[arg(long = "exclude-from", value_name = "FILE")]
	exclude_from: Vec<OsString>,

	/// Skip directories matching GLOB during recursive searches.
	#[arg(long = "exclude-dir", value_name = "GLOB")]
	exclude_dir: Vec<String>,

	/// Search directories matching GLOB during recursive searches.
	#[arg(long = "include-dir", value_name = "GLOB")]
	include_dir: Vec<String>,

	/// Recursively search each directory operand.
	#[arg(short = 'r', long = "recursive")]
	recursive: bool,

	/// Recursively search and follow every symbolic link.
	#[arg(short = 'R', long = "dereference-recursive")]
	dereference_recursive: bool,

	/// Follow symbolic links named as command-line operands.
	#[arg(short = 'O')]
	follow_command_line: bool,

	/// Do not follow symbolic links during recursive searches.
	#[arg(short = 'p')]
	no_follow: bool,

	/// Follow every symbolic link during recursive searches.
	#[arg(short = 'S')]
	follow_all: bool,

	/// Flush standard output after each output record.
	#[arg(long = "line-buffered")]
	line_buffered: bool,

	/// Use binary I/O where the platform distinguishes it.
	#[arg(short = 'U', long = "binary")]
	binary_io: bool,

	/// Treat NUL rather than newline as the input and output record delimiter.
	#[arg(short = 'z', long = "null-data")]
	null_data: bool,

	/// Request memory-mapped input where supported.
	#[allow(dead_code, reason = "accepted BSD grep compatibility option")]
	#[arg(long = "mmap")]
	mmap: bool,

	/// Accepted compatibility option with no effect.
	#[allow(dead_code, reason = "accepted GNU grep compatibility option")]
	#[arg(short = 'u')]
	unix_byte_offsets: bool,

	/// Print a help message.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// Print version information.
	#[allow(dead_code, reason = "clap consumes version before options are inspected")]
	#[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
	version: Option<bool>,

	/// Accept color configuration without injecting ANSI into redirected output.
	#[allow(dead_code, reason = "color is intentionally disabled for builtin output")]
	#[arg(
		long = "color",
		alias = "colour",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto",
	)]
	color: Option<String>,

	/// PATTERN followed by FILEs (PATTERN is omitted with -e or -f).
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

/// Parsed GNU `grep` invocation, including option occurrence order.
pub(crate) struct Grep {
	cli: GrepArgs,
	matches: ArgMatches,
}

impl CommandFactory for Grep {
	fn command() -> clap::Command { GrepArgs::command() }
	fn command_for_update() -> clap::Command { GrepArgs::command_for_update() }
}

impl FromArgMatches for Grep {
	fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { cli: GrepArgs::from_arg_matches(matches)?, matches: matches.clone() })
	}
	fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
		self.cli.update_from_arg_matches(matches)?;
		self.matches = matches.clone();
		Ok(())
	}
}

impl Parser for Grep {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BinaryFiles {
	Binary,
	Text,
	WithoutMatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DeviceAction {
	Read,
	Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DirectoryAction {
	Read,
	Skip,
	Recurse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchMode {
	Default,
	Extended,
	Fixed,
	Perl,
}

/// Resolved, flag-free options shared with the search [`Sink`].
#[derive(Clone)]
struct Options {
	line_number:         bool,
	byte_offset:         bool,
	count:               bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	before:              usize,
	after:               usize,
	no_messages:         bool,
	quiet:               bool,
	prefix_filename:     bool,
	initial_tab:         bool,
	record:              RecordFormat,
	group_separator:     Option<Vec<u8>>,
	line_buffered:       bool,
	binary_files:        BinaryFiles,
	/// How many lines `-m` lets the search select, `None` when unbounded.
	/// The count is kept here rather than in the searcher because GNU prints
	/// the trailing context of the line that reaches it, and prints a
	/// matching line inside that context as context; see [`GrepSink`].
	max_count:           Option<u64>,
	/// Whether the sink writes the `--` between two groups of lines itself.
	/// The searcher reports a break only where a context count is larger
	/// than zero, while GNU prints one whenever a context option was given:
	/// `grep -C0 mid` prints `mid`, `--`, `mid`.
	mark_gaps:           bool,
	/// Whether an input that is the file stdout lands in is refused; see
	/// [`Grep::run`].
	refuse_output_file:  bool,
	/// The alternatives of a `-o` search, to search each alone; see
	/// [`GrepSink::print_only_matching`].
	alternatives:        Option<Arc<Alternatives>>,
}

/// The alternatives of a `-o` search - the branches of each pattern's
/// alternation - compiled one by one at the first match that needs them,
/// once for every file and worker of the search.
struct Alternatives {
	patterns:     Vec<String>,
	spec:         MatcherSpec,
	engines:      OnceLock<Option<Vec<Engine>>>,
	/// The same, for a line that is not UTF-8; see [`LineMatcher`].
	byte_engines: OnceLock<Option<Vec<Engine>>>,
}

impl Alternatives {
	/// Each alternative's engine, for a line that is not UTF-8 when `bytes`,
	/// compiled on the first call.
	fn engines(&self, bytes: bool) -> Option<&[Engine]> {
		let (engines, spec) = if bytes {
			(&self.byte_engines, MatcherSpec { bytes: true, ..self.spec })
		} else {
			(&self.engines, self.spec)
		};
		engines
			.get_or_init(|| {
				// An alternative that fails to compile alone gives up the
				// longest-match search; the engine's own match is printed
				// then.
				self.patterns
					.iter()
					.map(|pattern| build_matcher(std::slice::from_ref(pattern), spec).ok())
					.collect()
			})
			.as_deref()
	}
}

#[derive(Clone)]
struct PathRule {
	include: bool,
	matcher: GlobMatcher,
}

struct RuleSpec {
	index:   usize,
	include: bool,
	pattern: String,
}

#[derive(Clone, Default)]
struct PathRules {
	files: Vec<PathRule>,
	dirs:  Vec<PathRule>,
}

impl PathRules {
	fn allows_file(&self, path: &Path) -> bool {
		Self::allows(&self.files, path)
	}

	fn allows_dir(&self, path: &Path) -> bool {
		Self::allows(&self.dirs, path)
	}

	fn allows(rules: &[PathRule], path: &Path) -> bool {
		let mut allowed = rules.first().is_none_or(|first| !first.include);
		for rule in rules {
			if path_suffix_matches(&rule.matcher, path) {
				allowed = rule.include;
			}
		}
		allowed
	}
}

fn path_suffix_matches(matcher: &GlobMatcher, path: &Path) -> bool {
	let mut components = path.components();
	loop {
		let suffix = components.as_path();
		if suffix.is_empty() {
			return false;
		}
		if matcher.is_match(suffix) {
			return true;
		}
		if components.next().is_none() {
			return false;
		}
	}
}

fn last_index(matches: &ArgMatches, id: &str) -> Option<usize> {
	if matches.value_source(id) != Some(ValueSource::CommandLine) {
		return None;
	}
	matches.indices_of(id).and_then(|indices| indices.max())
}

fn choose_latest<T>(selected: &mut (usize, T), index: Option<usize>, value: T) {
	if let Some(index) = index
		&& index >= selected.0
	{
		*selected = (index, value);
	}
}

fn resolve_match_mode(matches: &ArgMatches) -> MatchMode {
	let mut selected = (0, MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "basic"), MatchMode::Default);
	choose_latest(&mut selected, last_index(matches, "extended"), MatchMode::Extended);
	choose_latest(&mut selected, last_index(matches, "fixed"), MatchMode::Fixed);
	choose_latest(&mut selected, last_index(matches, "perl"), MatchMode::Perl);
	selected.1
}

fn resolve_ignore_case(matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "ignore_case"), true);
	choose_latest(&mut selected, last_index(matches, "no_ignore_case"), false);
	selected.1
}

fn resolve_filename_prefix(matches: &ArgMatches) -> Option<bool> {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "with_filename"), Some(true));
	choose_latest(&mut selected, last_index(matches, "no_filename"), Some(false));
	selected.1
}

fn resolve_file_list_modes(matches: &ArgMatches) -> (bool, bool) {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "files_with_matches"), Some(true));
	choose_latest(&mut selected, last_index(matches, "files_without_match"), Some(false));
	match selected.1 {
		Some(true) => (true, false),
		Some(false) => (false, true),
		None => (false, false),
	}
}

/// The context counts, and whether any context option was given.
///
/// `-A` and `-B` each set their own count, while `-C` and a digit option set
/// the default the other two fall back to, whatever their order: GNU's
/// `grep -A1 -C3` prints three lines before each match and one after. The
/// last flag of each kind wins.
///
/// Whether one was given at all is what makes grep print a `--` between two
/// groups of lines: `grep -C0` prints it and a plain `grep` does not.
fn resolve_context(cli: &GrepArgs) -> (usize, usize, bool) {
	let (after, before, default) = (cli.after_context, cli.before_context, cli.context);
	(
		before.or(default).unwrap_or(0),
		after.or(default).unwrap_or(0),
		before.is_some() || after.is_some() || default.is_some(),
	)
}

fn resolve_group_separator(cli: &GrepArgs, matches: &ArgMatches) -> Option<Vec<u8>> {
	let mut selected = (0, Some(b"--".to_vec()));
	if let Some(separator) = &cli.group_separator {
		choose_latest(
			&mut selected,
			last_index(matches, "group_separator"),
			Some(separator.as_bytes().to_vec()),
		);
	}
	choose_latest(&mut selected, last_index(matches, "no_group_separator"), None);
	selected.1
}

fn resolve_directory_action(cli: &GrepArgs, matches: &ArgMatches) -> DirectoryAction {
	let mut selected = (0, DirectoryAction::Read);
	choose_latest(&mut selected, last_index(matches, "recursive"), DirectoryAction::Recurse);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		DirectoryAction::Recurse,
	);
	if let Some(action) = cli.directories {
		choose_latest(&mut selected, last_index(matches, "directories"), action);
	}
	selected.1
}

/// Whether a recursive search follows symbolic links met below its operands
/// (`-R`, `-S`); a directory operand that is itself a link is always followed.
fn resolve_follow_links(cli: &GrepArgs, matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "recursive"), false);
	choose_latest(&mut selected, last_index(matches, "dereference_recursive"), true);
	if cli.directories == Some(DirectoryAction::Recurse) {
		choose_latest(&mut selected, last_index(matches, "directories"), false);
	}
	choose_latest(&mut selected, last_index(matches, "follow_command_line"), false);
	choose_latest(&mut selected, last_index(matches, "no_follow"), false);
	choose_latest(&mut selected, last_index(matches, "follow_all"), true);
	selected.1
}

fn resolve_binary_files(cli: &GrepArgs, matches: &ArgMatches) -> BinaryFiles {
	// GNU's default: input holding a NUL byte is binary, so its matches are
	// reported on standard error instead of being written as bytes into a
	// pipeline, and a NUL ends a line (`grep -c . ` counts the runs between
	// them). `-a` asks for the bytes themselves.
	let mut selected = (0, BinaryFiles::Binary);
	choose_latest(&mut selected, last_index(matches, "text"), BinaryFiles::Text);
	choose_latest(
		&mut selected,
		last_index(matches, "binary_without_match"),
		BinaryFiles::WithoutMatch,
	);
	if let Some(mode) = cli.binary_files {
		choose_latest(&mut selected, last_index(matches, "binary_files"), mode);
	}
	choose_latest(&mut selected, last_index(matches, "binary_io"), BinaryFiles::Binary);
	selected.1
}

/// How many lines `-m` lets the search select, `None` when it is unbounded.
///
/// GNU holds the count in a signed counter the search decrements, so a
/// negative one never reaches zero and never stops the search, while `-v`
/// instead clamps the lines it may still print to that negative number and
/// prints none. Measured: `grep -m -2 x` prints every match, `grep -v -m -1
/// x` prints nothing and exits 1, and `grep -cv -m -1 x` prints `0`.
fn resolve_max_count(cli: &GrepArgs) -> Option<u64> {
	match cli.max_count {
		None => None,
		Some(value) if value < 0 => cli.invert.then_some(0),
		Some(value) => u64::try_from(value).ok(),
	}
}

/// A long option `grep` accepts: its names - the long name first, then its
/// aliases, which getopt counts as the same option - and whether it takes
/// the next argument as its value.
struct LongOption {
	names:       Vec<String>,
	takes_value: bool,
}

/// Every long option, read from the parser's own definition, so whether a
/// long option takes the next argument is known for every name and
/// abbreviation clap accepts (`--bef 1` is `--before-context 1`). An option
/// whose value is optional (`--color`) does not take the next argument.
static LONG_OPTIONS: LazyLock<Vec<LongOption>> = LazyLock::new(|| {
	let mut command = GrepArgs::command();
	command.build();
	command
		.get_arguments()
		.filter_map(|arg| {
			let mut names = vec![arg.get_long()?.to_owned()];
			if let Some(aliases) = arg.get_all_aliases() {
				names.extend(aliases.into_iter().map(str::to_owned));
			}
			let takes_value = arg.get_num_args().is_some_and(|range| range.min_values() > 0);
			Some(LongOption { names, takes_value })
		})
		.collect()
});

/// The long option `name` names, exactly or as the abbreviation getopt
/// accepts: a prefix of the names of one option alone, so `--regex` is
/// `--regexp` and `--col` is `--color`, whose alias `--colour` is the same
/// option.
fn long_option(name: &str) -> Option<&'static LongOption> {
	if name.is_empty() {
		return None;
	}
	if let Some(option) = LONG_OPTIONS.iter().find(|option| option.names.iter().any(|n| n == name)) {
		return Some(option);
	}
	let mut named = LONG_OPTIONS
		.iter()
		.filter(|option| option.names.iter().any(|n| n.starts_with(name)));
	let option = named.next()?;
	named.next().is_none().then_some(option)
}

/// Whether `long`, a long option or the abbreviation of one without its
/// `--`, takes the next argument as its value: one with no value attached
/// that needs one.
fn long_option_takes_next_value(long: &str) -> bool {
	!long.contains('=') && long_option(long).is_some_and(|option| option.takes_value)
}

/// Rewrites what clap reads otherwise than GNU grep: a context count becomes
/// `--context=N`, as an argument of digits (`-5`) and as each run of digits
/// in a group of short options (`-5e mid`, `-n2e mid`), and an option's value
/// attached with a leading `=` (`-e=x`, `-ve=x`) is passed apart, as clap
/// would drop the `=`. clap itself reads an abbreviated long option
/// (`--regex=zz`), and refuses an ambiguous one, as GNU does.
///
/// A group is read as getopt reads it with GNU grep's digit options: a run of
/// digits is one count (`-15`), and a later count replaces it (`-5n3` is
/// `-3`). The first option in the group that takes a value takes the rest of
/// it (`-ve-5`, `-m5`), or the next argument whatever its first character
/// when the group ends there (`-ve -5`, `-2f -1`). Any other group is passed
/// on as it is, and so is one with a `-` before that option (`-5-`), which
/// GNU grep and clap both refuse.
fn normalize_context_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut normalized = Vec::with_capacity(argv.len());
	let mut literal = false;
	let mut value_pending = false;
	for (index, arg) in argv.into_iter().enumerate() {
		if index == 0 || literal || value_pending {
			value_pending = false;
			normalized.push(arg);
			continue;
		}
		let Some(text) = arg.to_str() else { normalized.push(arg); continue };
		if text == "--" { literal = true; normalized.push(arg); continue }
		if let Some(long) = text.strip_prefix("--") {
			value_pending = long_option_takes_next_value(long);
			normalized.push(arg);
			continue;
		}
		let Some(group) = text.strip_prefix('-') else { normalized.push(arg); continue };
		// The options before the first that takes a value, then that option
		// and the rest of the group, its value.
		let (options, valued) = group.split_at(
			group
				.find(|option: char| matches!(option, 'e' | 'f' | 'm' | 'A' | 'B' | 'C' | 'D' | 'd'))
				.unwrap_or(group.len()),
		);
		value_pending = valued.len() == 1;
		let value_starts_with_equals = valued.get(1..).is_some_and(|value| value.starts_with('='));
		if options.contains('-')
			|| !(value_starts_with_equals || options.contains(|c: char| c.is_ascii_digit()))
		{
			normalized.push(arg);
			continue;
		}
		let mut rest = options;
		while !rest.is_empty() {
			let count = rest.starts_with(|c: char| c.is_ascii_digit());
			let (run, after) =
				rest.split_at(rest.find(|c: char| c.is_ascii_digit() != count).unwrap_or(rest.len()));
			normalized.push(OsString::from(if count {
				format!("--context={run}")
			} else {
				format!("-{run}")
			}));
			rest = after;
		}
		if !valued.is_empty() {
			// Apart, so clap takes the value as it is: attached, it would
			// drop a leading `=`.
			let (option, value) = valued.split_at(1);
			normalized.push(OsString::from(format!("-{option}")));
			if !value.is_empty() {
				normalized.push(OsString::from(value));
			}
		}
	}
	normalized
}

/// The dialect a pattern is read in, or `None` for the modes that read no
/// POSIX pattern: a fixed string, and PCRE's own dialect under `-P`.
const fn dialect_of(mode: MatchMode) -> Option<bre::Dialect> {
	match mode {
		MatchMode::Default => Some(bre::Dialect::Basic),
		MatchMode::Extended => Some(bre::Dialect::Extended),
		MatchMode::Fixed | MatchMode::Perl => None,
	}
}

/// Translates every pattern for `target`, reporting the first one GNU
/// refuses with the message GNU prints for it.
fn translate_patterns(
	patterns: &[String],
	dialect: bre::Dialect,
	target: bre::Target,
	icase: bool,
) -> Result<Vec<String>, String> {
	patterns
		.iter()
		.map(|pattern| bre::translate(pattern, dialect, target, icase, bre::Strictness::Lenient))
		.collect::<Result<_, _>>()
		.map_err(|error: bre::BreError| error.message().to_owned())
}

/// `pattern`, in the `regex` crate's syntax, read as `spec` says: for a line
/// that is not UTF-8 each character outside ASCII is written as the escapes
/// of its UTF-8 bytes, which that crate reads with Unicode off as those
/// bytes, in a bracket expression too, as GNU grep reads them in the C
/// locale.
fn regex_syntax(pattern: String, spec: MatcherSpec) -> String {
	if !spec.bytes || pattern.is_ascii() {
		return pattern;
	}
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let mut escaped = String::with_capacity(pattern.len() * 2);
	for c in pattern.chars() {
		if c.is_ascii() {
			escaped.push(c);
			continue;
		}
		for byte in c.encode_utf8(&mut [0; 4]).bytes() {
			escaped.push_str("\\x");
			escaped.push(char::from(HEX[usize::from(byte >> 4)]));
			escaped.push(char::from(HEX[usize::from(byte & 0xF)]));
		}
	}
	escaped
}

/// Compiles `patterns` - already in PCRE2's syntax - with PCRE2.
fn build_pcre_matcher(patterns: &[String], spec: MatcherSpec) -> Result<Engine, String> {
	let mut builder = PcreMatcherBuilder::new();
	builder
		.caseless(spec.ignore_case)
		.word(spec.word && !spec.line_regexp)
		.whole_line(spec.line_regexp)
		.utf(!spec.bytes)
		.ucp(!spec.bytes)
		.jit_if_available(spec.jit);
	builder
		.build_many(patterns)
		.map(Engine::Pcre)
		.map_err(|error| error.to_string())
}

/// What compiling the patterns takes, resolved once from the command line
/// and the shell.
#[derive(Clone, Copy)]
struct MatcherSpec {
	mode:        MatchMode,
	ignore_case: bool,
	word:        bool,
	line_regexp: bool,
	null_data:   bool,
	/// PCRE2's JIT, as the shell's `OMP_PCRE2_JIT` sets it.
	jit:         bool,
	/// For a line that is not UTF-8, which GNU grep reads a byte to a
	/// character in the C locale; see [`LineMatcher`].
	bytes:       bool,
}

/// Compile all patterns using the last-selected matcher mode.
///
/// A pattern the engine cannot compile is an ERROR, as it is for GNU, which
/// refuses `grep '\(a'` with exit 2. Matching such a pattern as the text the
/// user typed answers a different question with a success status.
fn build_matcher(patterns: &[String], spec: MatcherSpec) -> Result<Engine, String> {
	if spec.mode == MatchMode::Perl {
		return build_pcre_matcher(patterns, spec);
	}

	// With no pattern (`-f` of an empty file) no line matches. To fold case,
	// `grep-regex` parses the patterns joined by `|`, and with none that is
	// the empty regex, which matches every line; without folding it builds an
	// alternation of nothing, which matches none.
	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(spec.ignore_case && !patterns.is_empty())
		.word(spec.word && !spec.line_regexp)
		.whole_line(spec.line_regexp)
		.unicode(!spec.bytes);
	if spec.null_data {
		builder.line_terminator(Some(b'\0'));
	}
	// A BRE is a distinct dialect, not an ERE with different escaping: `\+`
	// is the operator and a bare `+` is a literal. Both dialects go through
	// the shared module, which also writes each bracket expression and each
	// brace the way the engine reads it with POSIX's meaning.
	let Some(dialect) = dialect_of(spec.mode) else {
		// A fixed string, `-P` having been compiled above. The longest come
		// first, so at the leftmost position a match starts the engine takes
		// the longest string that matches there, as GNU's `-o` prints it:
		// `grep -oF -e a -e ab` prints `ab`.
		let mut longest_first: Vec<&String> = patterns.iter().collect();
		longest_first.sort_by_key(|pattern| std::cmp::Reverse(pattern.len()));
		let escaped: Vec<String> = longest_first
			.into_iter()
			.map(|pattern| regex_syntax(regex::escape(pattern), spec))
			.collect();
		return builder
			.build_many(&escaped)
			.map(Engine::Rust)
			.map_err(|error| error.to_string());
	};
	// `grep-regex` cannot run a back-reference at all. GNU answers
	// `grep '\(a\)\1'` with the lines holding a doubled character, so the
	// pattern is compiled with PCRE2 - the engine `-P` already uses - rather
	// than refused or searched as the text `\1`.
	if patterns.iter().any(|pattern| bre::has_backreference(pattern)) {
		let translated = translate_patterns(patterns, dialect, bre::Target::Pcre, spec.ignore_case)?;
		return build_pcre_matcher(&translated, spec);
	}
	let target = if spec.bytes { bre::Target::RustBytes } else { bre::Target::Rust };
	let translated: Vec<String> = translate_patterns(patterns, dialect, target, spec.ignore_case)?
		.into_iter()
		.map(|pattern| regex_syntax(pattern, spec))
		.collect();
	builder
		.build_many(&translated)
		.map(Engine::Rust)
		.map_err(|error| error.to_string())
}

/// The alternatives of every pattern, for the longest match `-o` prints at
/// each position, or `None` where searching them apart can print nothing the
/// patterns together do not.
fn pattern_alternatives(patterns: &[String], spec: MatcherSpec) -> Option<Vec<String>> {
	// `-P` is PCRE2, which prefers the first branch of an alternation as
	// GNU's own `-P` does. Under `-x` a match is the whole line, so there is
	// no longer one. Fixed strings come longest first (see `build_matcher`),
	// which picks the longest at each position by itself; under `-i` a
	// folded string can match more or fewer bytes than it holds, and under
	// `-w` the word test sits outside the alternation, so there each string
	// is still searched alone.
	if spec.mode == MatchMode::Perl
		|| spec.line_regexp
		|| (spec.mode == MatchMode::Fixed && !spec.ignore_case && !spec.word)
	{
		return None;
	}
	let dialect = dialect_of(spec.mode);
	let mut all = Vec::with_capacity(patterns.len());
	for pattern in patterns {
		match dialect {
			Some(dialect) => all.extend(bre::alternatives(pattern, dialect, bre::Split::Grep)),
			None => all.push(pattern.clone()),
		}
	}
	// An alternative that can only match the empty string is never printed;
	// `grep -o -e '' -e zz` prints the matches of `zz`.
	all.retain(|alternative| !alternative.is_empty());
	// One alternative that is the whole pattern answers exactly what the
	// search already found, so there is nothing to compile for it.
	let trivial = all.len() == 1 && patterns.len() == 1 && all[0] == patterns[0];
	(!all.is_empty() && !trivial).then_some(all)
}

/// Whether `patterns` read a line that is not UTF-8 as they read text: each
/// is ASCII and holds no character a dialect reads otherwise than as
/// itself, and neither case folding nor word edges are asked for, so the
/// same bytes match either way.
fn reads_bytes_as_text(patterns: &[String], spec: MatcherSpec) -> bool {
	!spec.ignore_case
		&& !spec.word
		&& patterns.iter().all(|pattern| {
			pattern.is_ascii()
				&& (spec.mode == MatchMode::Fixed
					|| !pattern.contains(|c: char| r"\.[]*^$+?{}()|".contains(c)))
		})
}

/// The matcher of a search. A line that is UTF-8 is read by `text`, and one
/// that is not by an engine that reads each byte as one character, as GNU
/// grep reads every line in the C locale: `grep -o 'x.('` prints `x\303(`
/// from a line holding the bytes 0xC3 0x28, which `.` in `text` does not
/// match. That engine is compiled at the first such line.
#[derive(Clone)]
struct LineMatcher<M> {
	text:         M,
	/// `None` where the patterns read such a line as `text` does; see
	/// [`reads_bytes_as_text`].
	bytes:        Option<Arc<BytesEngine<M>>>,
	terminator:   u8,
	/// The line terminators no match of either engine holds, which is what
	/// the searcher asks of [`Matcher::non_matching_bytes`]: the engines read
	/// them alike.
	non_matching: ByteSet,
}

/// The engine for a line that is not UTF-8, compiled at its first use;
/// `None` where the patterns compile only as text.
type BytesEngine<M> = LazyLock<Option<M>, Box<dyn FnOnce() -> Option<M> + Send>>;

/// The matcher of a search for `text`, which `build_matcher` compiled from
/// `patterns` with `spec` and which `engine` takes out of what it returns.
fn line_matcher<M: Send + Sync + 'static>(
	text: M,
	patterns: Vec<String>,
	spec: MatcherSpec,
	terminator: u8,
	engine: fn(Engine) -> Option<M>,
) -> LineMatcher<M>
where
	M: Matcher,
{
	let bytes = (!reads_bytes_as_text(&patterns, spec)).then(|| {
		let spec = MatcherSpec { bytes: true, ..spec };
		let build: Box<dyn FnOnce() -> Option<M> + Send> =
			Box::new(move || build_matcher(&patterns, spec).ok().and_then(engine));
		Arc::new(LazyLock::new(build))
	});
	let mut non_matching = ByteSet::empty();
	if let Some(set) = text.non_matching_bytes() {
		for byte in [b'\n', b'\0'] {
			if set.contains(byte) {
				non_matching.add(byte);
			}
		}
	}
	LineMatcher { text, bytes, terminator, non_matching }
}

impl<M: Matcher> LineMatcher<M> {
	/// The engine for a line that is not UTF-8: `text` where the patterns
	/// read it alike, or where they compile only as text.
	fn bytes_engine(&self) -> &M {
		self.bytes
			.as_deref()
			.and_then(|bytes| LazyLock::force(bytes).as_ref())
			.unwrap_or(&self.text)
	}

	/// Whether `line`, a whole line, is read by the engine for a line that
	/// is not UTF-8.
	fn reads_as_bytes(&self, line: &[u8]) -> bool {
		self.bytes.is_some() && std::str::from_utf8(line).is_err()
	}

	/// Where the line holding `at` starts.
	fn line_start(&self, haystack: &[u8], at: usize) -> usize {
		memchr::memrchr(self.terminator, &haystack[..at]).map_or(0, |found| found + 1)
	}

	/// Where the line holding `at` ends, past its terminator.
	fn line_end(&self, haystack: &[u8], at: usize) -> usize {
		memchr::memchr(self.terminator, &haystack[at..]).map_or(haystack.len(), |found| at + found + 1)
	}

	/// The first line of `haystack[from..to]`, both line boundaries, that is
	/// not UTF-8, as its start and its end.
	fn invalid_line(&self, haystack: &[u8], from: usize, to: usize) -> Option<(usize, usize)> {
		let at = from + std::str::from_utf8(&haystack[from..to]).err()?.valid_up_to();
		Some((self.line_start(haystack, at).max(from), self.line_end(haystack, at).min(to)))
	}

	/// The first result at or after `at`, each engine asked for its own by
	/// `first(engine, haystack, from)`, and each result placed in its line by
	/// `position`. A line that is UTF-8 holds the text engine's result; a
	/// line that is not is searched alone by the other engine. The text
	/// before the text engine's result is checked once, and each line in it
	/// that is not UTF-8 searched once.
	fn search<T>(
		&self,
		haystack: &[u8],
		at: usize,
		first: impl Fn(&M, &[u8], usize) -> Result<Option<T>, M::Error>,
		position: impl Fn(&T) -> usize,
	) -> Result<Option<T>, M::Error> {
		let mut found = first(&self.text, haystack, at)?;
		if self.bytes.is_none() {
			return Ok(found);
		}
		let mut from = self.line_start(haystack, at);
		loop {
			let to = found
				.as_ref()
				.map_or(haystack.len(), |found| self.line_end(haystack, position(found)));
			let Some((start, end)) = self.invalid_line(haystack, from, to) else {
				return Ok(found);
			};
			if let Some(in_line) = first(self.bytes_engine(), &haystack[..end], at.max(start))? {
				return Ok(Some(in_line));
			}
			from = end;
			// The text engine's result stands where it lies past this line.
			if found.as_ref().is_some_and(|found| position(found) < end) {
				found = first(&self.text, haystack, end)?;
			}
		}
	}
}

impl<M: Matcher> Matcher for LineMatcher<M> {
	type Captures = M::Captures;
	type Error = M::Error;

	fn find_at(
		&self,
		haystack: &[u8],
		at: usize,
	) -> Result<Option<grep_matcher::Match>, Self::Error> {
		self.search(
			haystack,
			at,
			|engine: &M, haystack: &[u8], from: usize| engine.find_at(haystack, from),
			|found: &grep_matcher::Match| found.start(),
		)
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		self.text.new_captures()
	}

	fn capture_count(&self) -> usize {
		self.text.capture_count()
	}

	fn capture_index(&self, name: &str) -> Option<usize> {
		self.text.capture_index(name)
	}

	fn captures_at(
		&self,
		haystack: &[u8],
		at: usize,
		caps: &mut Self::Captures,
	) -> Result<bool, Self::Error> {
		let Some(found) = self.find_at(haystack, at)? else {
			return Ok(false);
		};
		let (start, end) =
			(self.line_start(haystack, found.start()), self.line_end(haystack, found.start()));
		let engine =
			if self.reads_as_bytes(&haystack[start..end]) { self.bytes_engine() } else { &self.text };
		engine.captures_at(&haystack[..end], found.start(), caps)
	}

	fn non_matching_bytes(&self) -> Option<&ByteSet> {
		Some(&self.non_matching)
	}

	fn line_terminator(&self) -> Option<LineTerminator> {
		self.text.line_terminator()
	}

	fn find_candidate_line(&self, haystack: &[u8]) -> Result<Option<LineMatchKind>, Self::Error> {
		self.search(
			haystack,
			0,
			|engine: &M, haystack: &[u8], from: usize| {
				Ok(engine.find_candidate_line(&haystack[from..])?.map(|kind| match kind {
					LineMatchKind::Confirmed(at) => LineMatchKind::Confirmed(from + at),
					LineMatchKind::Candidate(at) => LineMatchKind::Candidate(from + at),
				}))
			},
			|kind: &LineMatchKind| match *kind {
				LineMatchKind::Confirmed(at) | LineMatchKind::Candidate(at) => at,
			},
		)
	}
}

/// A search sink that renders GNU-compatible records and tracks selection.
struct GrepSink<'a, M: Matcher, W: Write> {
	out:          &'a mut W,
	/// What the search reports on standard error: the binary-file summary,
	/// which GNU 3.11 writes there rather than into the pipeline.
	err:          &'a mut Vec<u8>,
	matcher:      &'a LineMatcher<M>,
	display:      &'a [u8],
	opts:         &'a Options,
	match_count:  u64,
	any_match:    bool,
	binary:       bool,
	/// Where the line last printed ends, to tell one group of lines from the
	/// next where the context counts are zero; see [`Options::mark_gaps`].
	last_end:     Option<u64>,
	/// How many records may still follow the line that reached `-m`'s count,
	/// `None` until it is reached.
	after_left:   Option<usize>,
	/// Where each alternative alone next matches in the line `-o` prints;
	/// see [`longest_match_at`]. Kept to be reused from line to line.
	next_matches: Vec<Option<Option<grep_matcher::Match>>>,
}

impl<M: Matcher, W: Write> GrepSink<'_, M, W> {
	fn flush_record(&mut self) -> io::Result<()> {
		if self.opts.line_buffered {
			self.out.flush()?;
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		byte_offset: u64,
		separator: u8,
	) -> io::Result<()> {
		let has_prefix = self.opts.record.write_prefix(
			self.out,
			self.opts.prefix_filename.then_some(self.display),
			line_number.filter(|_| self.opts.line_number),
			None,
			self.opts.byte_offset.then_some(byte_offset),
			separator,
		)?;
		if self.opts.initial_tab && has_prefix {
			self.out.write_all(b"\t")?;
		}
		Ok(())
	}

	fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
		self.out.write_all(record)?;
		if record.last().copied() != Some(self.opts.record.terminator) {
			self.out.write_all(&[self.opts.record.terminator])?;
		}
		self.flush_record()
	}

	fn write_path_record(&mut self) -> io::Result<()> {
		self.opts.record.write_path_record(self.out, Some(self.display))?;
		self.flush_record()
	}

	/// Writes the `--` (or `--group-separator`) between two groups of lines,
	/// unless `--no-group-separator` asked for none.
	fn write_group_separator(&mut self) -> io::Result<()> {
		if let Some(separator) = &self.opts.group_separator {
			self.out.write_all(separator)?;
			self.out.write_all(&[self.opts.record.terminator])?;
			self.flush_record()?;
		}
		Ok(())
	}

	/// Writes the separator before a line that does not follow the last one
	/// printed, where the context counts are zero and the searcher reports
	/// no break of its own.
	fn mark_gap(&mut self, offset: u64) -> io::Result<()> {
		if self.opts.mark_gaps && self.last_end.is_some_and(|end| end != offset) {
			self.write_group_separator()?;
		}
		Ok(())
	}

	/// Notes where the line just printed ends, for the next [`Self::mark_gap`].
	fn note_line(&mut self, offset: u64, length: usize) {
		self.last_end = Some(offset.saturating_add(length as u64));
	}

	/// Prints the matches in `line`, as `-o` does: at each position the
	/// longest match of any alternative, never an empty one. The engines
	/// take the first alternative that matches there, so `-o -e 'q\?' -e zz`
	/// printed nothing and `-oE 'a|ab'` printed `a`; each alternative is
	/// searched alone to print what GNU prints.
	fn print_only_matching(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		// The searcher selects a line on its text alone, and GNU grep's `-o`
		// matches within that text too: a class such as `[^x]` or
		// `[[:space:]]` printed the record's terminator as one more match.
		let line = line.strip_suffix(&[self.opts.record.terminator]).unwrap_or(line);
		let (line_matcher, opts) = (self.matcher, self.opts);
		// The engine that reads this line, chosen once for all its matches.
		let bytes = line_matcher.reads_as_bytes(line);
		let matcher = if bytes { line_matcher.bytes_engine() } else { &line_matcher.text };
		let mut next = std::mem::take(&mut self.next_matches);
		// No alternative is searched in this line yet.
		next.clear();
		let printed = for_each_match_with(
			matcher,
			line,
			line_offset,
			|start| {
				let Some(engines) =
					opts.alternatives.as_deref().and_then(|alternatives| alternatives.engines(bytes))
				else {
					return Ok(None);
				};
				if next.is_empty() {
					next.resize(engines.len(), None);
				}
				longest_match_at(engines, &mut next, line, start)
			},
			|found, match_offset| {
				self.write_prefix(line_number, match_offset, b':')?;
				self.write_record(&line[found.start()..found.end()])
			},
		);
		self.next_matches = next;
		printed
	}

	/// A line the search does not select: context the searcher reports, or a
	/// matching line past `-m`'s count, which GNU prints as context
	/// (`grep -n12m1 -e mid` prints the second match as `13-mid`). Returns
	/// whether the search goes on.
	fn context_record(
		&mut self,
		bytes: &[u8],
		line_number: Option<u64>,
		offset: u64,
	) -> io::Result<bool> {
		// Past `-m`'s count only the trailing context the count allows is
		// printed; with none, the search stops at the selected line.
		if self.after_left == Some(0) {
			return Ok(false);
		}
		// No gap is marked here: the sink marks gaps only where both context
		// counts are zero, and then no context line reaches it and a line
		// past `-m`'s count is not printed.
		if !self.normal_output_is_suppressed() && !self.opts.only_matching && !self.binary_summary()
		{
			self.write_prefix(line_number, offset, b'-')?;
			self.write_record(bytes)?;
		}
		if let Some(left) = &mut self.after_left {
			*left -= 1;
			if *left == 0 {
				return Ok(false);
			}
		}
		Ok(true)
	}

	fn normal_output_is_suppressed(&self) -> bool {
		self.opts.count
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.quiet
	}

	fn binary_summary(&self) -> bool {
		self.binary
			&& self.opts.binary_files == BinaryFiles::Binary
			&& !self.normal_output_is_suppressed()
	}
}

impl<M: Matcher, W: Write> Sink for GrepSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		if self.binary && self.opts.binary_files == BinaryFiles::WithoutMatch {
			return Ok(false);
		}
		// A line that `-m`'s count no longer reaches is trailing context, as
		// it is for GNU: `grep -n12m1 -e mid` prints the second match as
		// `13-mid` and stops at the end of that context. A count of zero -
		// `-v` with a negative one - selects nothing at all.
		if self.after_left.is_none() && self.opts.max_count == Some(self.match_count) {
			self.after_left = Some(self.opts.after);
		}
		if self.after_left.is_some() {
			return self.context_record(mat.bytes(), mat.line_number(), mat.absolute_byte_offset());
		}
		self.any_match = true;
		self.match_count += 1;
		if self.opts.quiet
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.binary_summary()
		{
			return Ok(false);
		}
		if !self.opts.count {
			self.mark_gap(mat.absolute_byte_offset())?;
			if self.opts.only_matching {
				self.print_only_matching(mat.bytes(), mat.line_number(), mat.absolute_byte_offset())?;
			} else {
				self.write_prefix(mat.line_number(), mat.absolute_byte_offset(), b':')?;
				self.write_record(mat.bytes())?;
			}
			self.note_line(mat.absolute_byte_offset(), mat.bytes().len());
		}
		if self.opts.max_count == Some(self.match_count) {
			// The search goes on only for the trailing context this line is
			// allowed.
			self.after_left = Some(self.opts.after);
			return Ok(self.opts.after > 0);
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		self.context_record(ctx.bytes(), ctx.line_number(), ctx.absolute_byte_offset())
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		// `-o` prints no context line, and GNU still separates its groups.
		if !self.normal_output_is_suppressed() && !self.binary_summary() {
			self.write_group_separator()?;
		}
		Ok(true)
	}

	fn binary_data(
		&mut self,
		_searcher: &Searcher,
		_binary_byte_offset: u64,
	) -> Result<bool, io::Error> {
		self.binary = true;
		if self.opts.binary_files == BinaryFiles::WithoutMatch {
			self.any_match = false;
			self.match_count = 0;
			return Ok(false);
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if self.binary_summary() && self.any_match {
			// GNU 3.11 reports a binary file on standard error, so what a
			// pipeline reads holds the matched text alone.
			self.err.write_all(b"grep: ")?;
			self.err.write_all(self.display)?;
			self.err.write_all(b": binary file matches\n")?;
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.count {
			self.opts.record.write_count_record(
				self.out,
				self.opts.prefix_filename.then_some(self.display),
				self.match_count,
			)?;
			self.flush_record()?;
		}
		Ok(())
	}
}

/// Cancellation seen by the search workers: raised when either the whole
/// utility body or the directory search they serve is dropped.
#[derive(Clone)]
struct Halt {
	scope: Arc<AtomicBool>,
	outer: Arc<AtomicBool>,
}

impl Halt {
	fn raised(&self) -> bool {
		self.scope.load(Ordering::Relaxed) || self.outer.load(Ordering::Relaxed)
	}
}

/// Raises its flag on drop, halting every task that observes it.
struct HaltGuard(Arc<AtomicBool>);

impl HaltGuard {
	fn new() -> (Self, Arc<AtomicBool>) {
		let flag = Arc::new(AtomicBool::new(false));
		(Self(Arc::clone(&flag)), flag)
	}
}

impl Drop for HaltGuard {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
	}
}

/// Bytes requested per asynchronous input read.
const READ_CHUNK: usize = 64 * 1024;

fn display_path_for_operand(operand: &OsStr, resolved: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(resolved).unwrap_or(path);
	if rel.is_empty() {
		PathBuf::from(operand)
	} else {
		Path::new(operand).join(rel)
	}
}

/// One searched file's output, handed to the consumer in path order.
struct FileSearch {
	out:       Vec<u8>,
	err:       Vec<u8>,
	had_error: bool,
	matched:   io::Result<bool>,
}

/// What one search worker reuses across files: its searcher, read buffer, output buffer, and the opener of a native tree's files.
struct Worker {
	searcher: Searcher,
	buf:      Vec<u8>,
	out:      Vec<u8>,
	/// What the search reports on standard error, kept apart from `out` so
	/// the file's matches stay a pipeline's input.
	err:      Vec<u8>,
	opener:   Option<FileOpener>,
	/// Reused for the path of each listed file.
	path:     PathBuf,
	/// Reused for the displayed name of each listed file.
	display:  PathBuf,
}

/// A file being searched.
enum Input {
	/// A regular file a native walk listed, opened relative to its directory.
	Listed(pi_walker::fs::File),
	Source(stdio::Source),
}

impl Input {
	/// The identity of the file that was opened, read from the handle rather
	/// than from the path it was opened by.
	async fn metadata(&self) -> Option<pi_vfs::Metadata> {
		match self {
			Self::Listed(file) => file.metadata().ok(),
			Self::Source(source) => source.handle_metadata().await,
		}
	}

	/// Reads up to `buf.len()` bytes; 0 at end of input.
	async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Listed(file) => {
				// Reads never suspend: spend the coop budget so a long run
				// still yields and its cancellation takes effect.
				tokio::task::coop::consume_budget().await;
				file.read(buf).await
			},
			Self::Source(source) => source.read(buf).await,
		}
	}
}

/// Hands a file's buffered output to the consumer, leaving the buffer in
/// place (its capacity kept for the next file) when nothing was written.
fn take_written(buffer: &mut Vec<u8>) -> Vec<u8> {
	if buffer.is_empty() { Vec::new() } else { std::mem::take(buffer) }
}

/// The walked files of a directory operand, searched by index.
struct Listed {
	layer: pi_walker::Fs,
	files: walk::Collection,
}

/// Everything the concurrent per-file searches of one directory operand share.
struct DirSearch<M> {
	fs:       pi_vfs::Fs,
	/// The directory operand's files; a native tree's open through each
	/// worker's [`FileOpener`]. `None` for a file operand.
	listed:   Option<Listed>,
	halt:     Halt,
	operand:  OsString,
	resolved: PathBuf,
	matcher:  LineMatcher<M>,
	searcher: SearcherBuilder,
	opts:     Options,
	/// The file stdout lands in, when the refusal in [`DirSearch::refused`]
	/// is on and stdout is a regular file.
	stdout:   Option<StdoutFile>,
}

impl<M: Matcher + Send + Sync + 'static> DirSearch<M> {
	/// A worker whose searcher is built once from the shared builder.
	fn worker(&self) -> Worker {
		Worker {
			searcher: self.searcher.build(),
			buf:      vec![0u8; READ_CHUNK],
			out:      Vec::new(),
			err:      Vec::new(),
			opener:   self
				.listed
				.as_ref()
				.filter(|listed| listed.layer.is_native())
				.map(|listed| FileOpener::new(&listed.layer)),
			path:     PathBuf::new(),
			display:  PathBuf::new(),
		}
	}

	/// Classifies one file's search result; a broken pipe stops the search, any other error is reported per file.
	fn finish(
		&self,
		display_path: &Path,
		searched: io::Result<bool>,
		out: Vec<u8>,
		mut err: Vec<u8>,
	) -> FileSearch {
		let mut had_error = false;
		let matched = match searched {
			Ok(matched) => Ok(matched),
			// Propagate BrokenPipe to stop the search; the host maps its status.
			Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Err(error),
			Err(error) => {
				had_error = true;
				if !self.opts.no_messages {
					let _ = writeln!(
						err,
						"grep: {}: {}",
						display_path.display(),
						describe_search_error(&error)
					);
				}
				Ok(false)
			},
		};
		FileSearch { out, err, had_error, matched }
	}

	/// Pushes `input` through the worker's searcher into its output buffer, failing with the cancellation error once the halt is raised.
	async fn push_input(
		&self,
		input: &mut Input,
		display: &[u8],
		worker: &mut Worker,
	) -> io::Result<bool> {
		let Worker { searcher, buf, out, err, .. } = worker;
		let terminator = bound_terminator(searcher, &self.matcher);
		let mut sink = GrepSink {
			out,
			err,
			matcher: &self.matcher,
			display,
			opts: &self.opts,
			match_count: 0,
			any_match: false,
			binary: false,
			last_end: None,
			after_left: None,
			next_matches: Vec::new(),
		};
		let mut search = searcher.search_push(&self.matcher, &mut sink);
		let mut run = 0;
		loop {
			if self.halt.raised() {
				return Err(pi_vfs::cancelled());
			}
			let read = input.read(buf).await?;
			if read == 0 {
				break;
			}
			check_run(terminator, &mut run, &buf[..read])?;
			if !search.push(&buf[..read])? {
				break;
			}
		}
		search.finish()?;
		Ok(sink.any_match)
	}

	/// Opens `path`: a listed file of a native tree through the worker's
	/// opener, anything that fails there (a special file, an error) through
	/// `fs`, which reports it as a standalone open would.
	async fn open(&self, worker: &mut Worker, path: &Path) -> io::Result<Input> {
		if let Some(opener) = &mut worker.opener
			&& self.fs.is_native_local(path)
			&& let Ok(file) = opener.open(path).await
		{
			return Ok(Input::Listed(file));
		}
		stdio::Source::open(&self.fs, path).await.map(Input::Source)
	}

	/// Searches the `index`th listed file, its paths built in the worker's
	/// buffers.
	async fn search_listed(&self, worker: &mut Worker, index: usize) -> FileSearch {
		let listed = self.listed.as_ref().expect("a directory search lists its files");
		let rel = listed.files.get(index).path;
		let (mut path, mut display) = (std::mem::take(&mut worker.path), std::mem::take(&mut worker.display));
		listed.layer.join_into(&mut path, &self.resolved, rel);
		if listed.layer.is_native() {
			listed.layer.join_into(&mut display, Path::new(&self.operand), rel);
		} else {
			display = display_path_for_operand(&self.operand, &self.resolved, &path);
		}
		let found = self.search_at(worker, &path, &display).await;
		(worker.path, worker.display) = (path, display);
		found
	}

	async fn search(&self, worker: &mut Worker, path: &Path) -> FileSearch {
		let display_path = display_path_for_operand(&self.operand, &self.resolved, path);
		self.search_at(worker, path, &display_path).await
	}

	/// The search of a file that is also the file stdout lands in, refused
	/// the way GNU grep refuses it: the matches written into the file would
	/// be read back and matched again, so the file grows without bound.
	fn refused(&self, display_path: &Path) -> FileSearch {
		let mut err = Vec::new();
		if !self.opts.no_messages {
			let _ = writeln!(
				err,
				"grep: {}: input file is also the output",
				display_path.display()
			);
		}
		FileSearch { out: Vec::new(), err, had_error: true, matched: Ok(false) }
	}

	/// Whether `input` — already opened — is the file stdout lands in.
	///
	/// The decision is made on the handle that was opened, as GNU grep's
	/// `SAME_INODE (st, out_stat)` is, so a path replaced or a symlink
	/// retargeted between the walk and the open cannot slip past the refusal.
	async fn is_output_file(&self, input: &Input) -> bool {
		let Some(stdout) = &self.stdout else {
			return false;
		};
		match input.metadata().await {
			Some(opened) => stdout.matches(&opened),
			None => false,
		}
	}

	async fn search_at(&self, worker: &mut Worker, path: &Path, display_path: &Path) -> FileSearch {
		match self.open(worker, path).await {
			Ok(mut input) => {
				if self.opts.refuse_output_file && self.is_output_file(&input).await {
					return self.refused(display_path);
				}
				let searched = self
					.push_input(&mut input, display_path.as_os_str().as_encoded_bytes(), worker)
					.await;
				let (out, err) = (take_written(&mut worker.out), take_written(&mut worker.err));
				self.finish(display_path, searched, out, err)
			},
			Err(error) => {
				let mut err = Vec::new();
				if !self.opts.no_messages {
					let _ = writeln!(err, "grep: {}: {error}", display_path.display());
				}
				FileSearch { out: Vec::new(), err, had_error: true, matched: Ok(false) }
			},
		}
	}
}

/// Recursively searches a directory operand ([`exec::adaptive`]: inline, then on parallel workers), pruning
/// excluded directories and writing each file's output in path order.
#[allow(clippy::too_many_arguments)]
async fn search_dir<M: Matcher + Clone + Send + Sync + 'static, W: Write + Send>(
	host: &mut Host,
	operand: &OsStr,
	resolved: &Path,
	matcher: &LineMatcher<M>,
	searcher: &SearcherBuilder,
	opts: &Options,
	rules: &PathRules,
	follow_links: bool,
	outer: &Arc<AtomicBool>,
	out: &mut W,
	had_error: &mut bool,
) -> io::Result<bool> {
	let vfs = host.vfs();
	let (_guard, scope) = HaltGuard::new();
	let layer = pi_walker::Fs::new(&vfs, resolved);
	let walk_opts = walk::Options { hidden: true, follow_links, ..walk::Options::default() };
	let filter_rules = Arc::new(rules.clone());
	let collected = walk::collect(&layer, resolved, &walk_opts, true, move |_, entry| {
		let rel = entry.rel_path();
		match entry.file_type {
			FileType::Dir if !filter_rules.allows_dir(rel) => walk::Action::SkipDir,
			FileType::File if filter_rules.allows_file(rel) => walk::Action::Continue,
			_ => walk::Action::Skip,
		}
	})
	.await;
	let files = match collected {
		Ok(files) => files,
		Err(walk::WalkError::Root { path, error }) => {
			*had_error = true;
			if !opts.no_messages {
				let display_path = display_path_for_operand(operand, resolved, &path);
				let _ = writeln!(host.stderr, "grep: {}: {error}", display_path.display());
			}
			return Ok(false);
		},
	};
	let mut errors: Vec<_> = files.errors().iter().collect();
	errors.sort_unstable_by(|a, b| a.path.cmp(&b.path));
	for error in errors {
		*had_error = true;
		if !opts.no_messages {
			let display_path = display_path_for_operand(operand, resolved, &error.path);
			let _ = writeln!(host.stderr, "grep: {}: {}", display_path.display(), error.error);
		}
	}
	let count = files.len();
	let workers = if opts.line_buffered { 1 } else { walk_opts.parallelism(&layer) };
	let shared = Arc::new(DirSearch {
		fs:       vfs.clone(),
		listed:   Some(Listed { layer, files }),
		halt:     Halt { scope, outer: Arc::clone(outer) },
		operand:  operand.to_owned(),
		resolved: resolved.to_owned(),
		matcher:  matcher.clone(),
		searcher: searcher.clone(),
		opts:     opts.clone(),
		stdout:   host.stdout_file(),
	});
	let mut any = false;
	let mut failed = None;
	let mut pace = host.output_pace();
	let mut results = exec::adaptive(0..count, workers, exec::INLINE_BUDGET, || shared.worker(), {
		let shared = Arc::clone(&shared);
		move |mut worker: Worker, index: usize| {
			let shared = Arc::clone(&shared);
			async move {
				let found = shared.search_listed(&mut worker, index).await;
				(worker, found)
			}
		}
	});
	while let Some(found) = results.next().await {
		// Most files print nothing; their empty writes are skipped.
		if !found.out.is_empty() {
			let written = out
				.write_all(&found.out)
				.and_then(|()| if opts.line_buffered { out.flush() } else { Ok(()) });
			if let Err(error) = written {
				failed = Some(error);
				break;
			}
		}
		if !found.err.is_empty() {
			let _ = host.stderr.write_all(&found.err);
		}
		let delivered = if opts.line_buffered || !results.next_ready() {
			host.flush_output().await
		} else {
			host.pace_output(&mut pace).await
		};
		if let Err(error) = delivered {
			failed = Some(error);
			break;
		}
		*had_error |= found.had_error;
		match found.matched {
			Ok(matched) => any |= matched,
			Err(error) => {
				failed = Some(error);
				break;
			},
		}
		if opts.quiet && any {
			break;
		}
	}
	drop(results);
	if let Some(error) = failed {
		return Err(error);
	}
	Ok(any)
}

async fn read_auxiliary_file(host: &mut Host, path: &OsStr) -> Result<Vec<u8>, String> {
	let result = if path == OsStr::new("-") {
		let mut bytes = Vec::new();
		match host.read_stdin_to_end(&mut bytes, MAX_LINE_BYTES).await {
			Ok(_) => Ok(bytes),
			Err(error) if error.kind() == io::ErrorKind::OutOfMemory => Err(io::Error::other(format!(
				"pattern file larger than {} MiB",
				MAX_LINE_BYTES >> 20
			))),
			Err(error) => Err(error),
		}
	} else {
		read_pattern_file(&host.vfs(), &host.resolve(path)).await
	};
	result.map_err(|error| format!("{}: {error}", path.display()))
}

fn pattern_file_lines(bytes: &[u8]) -> Vec<String> {
	if bytes.is_empty() {
		return Vec::new();
	}
	String::from_utf8_lossy(bytes)
		.split_terminator('\n')
		.map(str::to_owned)
		.collect()
}

async fn resolve_patterns(host: &mut Host, cli: &GrepArgs) -> Result<(Vec<String>, Vec<OsString>), String> {
	let has_explicit_patterns = !cli.patterns.is_empty() || !cli.pattern_files.is_empty();
	let mut patterns = Vec::new();
	let mut files = Vec::new();

	if has_explicit_patterns {
		for pattern in &cli.patterns {
			patterns.extend(pattern.split('\n').map(str::to_owned));
		}
		for path in &cli.pattern_files {
			patterns.extend(pattern_file_lines(&read_auxiliary_file(host, path).await?));
		}
		files.clone_from(&cli.args);
		return Ok((patterns, files));
	}

	let mut args = cli.args.iter();
	let Some(pattern) = args.next() else {
		return Err("no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]...".to_owned());
	};
	patterns.extend(pattern.to_string_lossy().split('\n').map(str::to_owned));
	files.extend(args.cloned());
	Ok((patterns, files))
}

async fn collect_rule_specs(
	host: &mut Host,
	cli: &GrepArgs,
	matches: &ArgMatches,
) -> Result<(Vec<RuleSpec>, Vec<RuleSpec>), String> {
	let mut files = Vec::new();
	if let Some(indices) = matches.indices_of("include") {
		for (index, pattern) in indices.zip(&cli.include) {
			files.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude") {
		for (index, pattern) in indices.zip(&cli.exclude) {
			files.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_from") {
		for (index, path) in indices.zip(&cli.exclude_from) {
			for pattern in pattern_file_lines(&read_auxiliary_file(host, path).await?) {
				files.push(RuleSpec { index, include: false, pattern });
			}
		}
	}

	let mut dirs = Vec::new();
	if let Some(indices) = matches.indices_of("include_dir") {
		for (index, pattern) in indices.zip(&cli.include_dir) {
			dirs.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_dir") {
		for (index, pattern) in indices.zip(&cli.exclude_dir) {
			dirs.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	Ok((files, dirs))
}

fn compile_rules(mut specs: Vec<RuleSpec>) -> Result<Vec<PathRule>, String> {
	specs.sort_by_key(|spec| spec.index);
	specs
		.into_iter()
		.map(|spec| {
			Glob::new(&spec.pattern)
				.map(|glob| PathRule { include: spec.include, matcher: glob.compile_matcher() })
				.map_err(|error| format!("{}: {error}", spec.pattern))
		})
		.collect()
}

async fn build_path_rules(host: &mut Host, cli: &GrepArgs, matches: &ArgMatches) -> Result<PathRules, String> {
	let (files, dirs) = collect_rule_specs(host, cli, matches).await?;
	Ok(PathRules { files: compile_rules(files)?, dirs: compile_rules(dirs)? })
}

/// Largest line, in bytes, one search may buffer; `grep` and `rg` share it.
/// Both run inside the host process, so their line buffer is the host's
/// memory: without a bound, a file with no line terminator (a sparse file reads
/// as one endless run of NUL bytes) grows it until the kernel kills the host. A
/// longer line is reported as an error for that file and the search goes on.
/// Pattern files (`-f`) are held to the same size.
pub(crate) const MAX_LINE_BYTES: usize = 256 * 1024 * 1024;

/// The searcher's own allocation cap, a backstop behind [`check_run`].
///
/// The bound stops a run one read past [`MAX_LINE_BYTES`], so the buffer needs
/// that much room plus one read's worth of growth before the typed error fires;
/// retained context lines can still push it over, and that rarer failure is
/// reported with the searcher's own message.
pub(crate) const SEARCH_HEAP_LIMIT: usize = MAX_LINE_BYTES + (1 << 20);

/// A search stopped because one record outgrew [`MAX_LINE_BYTES`].
#[derive(Debug)]
pub(crate) struct LineLimitExceeded {
	/// The searcher buffers the whole file (multi-line search), not one line.
	whole_file: bool,
}

impl fmt::Display for LineLimitExceeded {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let what = if self.whole_file { "file larger than" } else { "line longer than" };
		write!(f, "{what} {} MiB, not searched", MAX_LINE_BYTES >> 20)
	}
}

impl std::error::Error for LineLimitExceeded {}

/// The record terminator `searcher` buffers up to, or `None` when it buffers
/// the whole input (multi-line search).
pub(crate) fn bound_terminator<M: Matcher>(searcher: &Searcher, matcher: M) -> Option<u8> {
	(!searcher.multi_line_with_matcher(matcher)).then(|| searcher.line_terminator().as_byte())
}

/// Accounts one more `chunk` of input against [`MAX_LINE_BYTES`], failing with
/// a typed [`LineLimitExceeded`] instead of letting the searcher's buffer grow.
/// In line mode `run` is the unterminated run carried over from the previous
/// chunks; in whole-file mode (no terminator) every byte counts.
pub(crate) fn check_run(terminator: Option<u8>, run: &mut usize, chunk: &[u8]) -> io::Result<()> {
	let n = chunk.len();
	// Lines strictly inside one read are shorter than the read, which the
	// searcher's heap limit already bounds; only the run crossing into
	// this read and the one left open at its end can grow without bound.
	let (crossing, open) = match terminator {
		Some(byte) => match memchr::memchr(byte, chunk) {
			Some(first) => (*run + first, n - memchr::memrchr(byte, chunk).map_or(0, |last| last + 1)),
			None => (*run + n, *run + n),
		},
		None => (*run + n, *run + n),
	};
	if crossing.max(open) > MAX_LINE_BYTES {
		return Err(io::Error::other(LineLimitExceeded { whole_file: terminator.is_none() }));
	}
	*run = open;
	Ok(())
}

/// The message for a failed search: [`LineLimitExceeded`] says which bound it
/// hit, anything else reads as reported.
pub(crate) fn describe_search_error(error: &io::Error) -> String {
	match error.get_ref().and_then(|inner| inner.downcast_ref::<LineLimitExceeded>()) {
		Some(limit) => limit.to_string(),
		None => error.to_string(),
	}
}

/// Reads a pattern file (`-f`, FIFOs and `<(…)` included) without blocking,
/// refusing one larger than [`MAX_LINE_BYTES`].
pub(crate) async fn read_pattern_file(fs: &pi_vfs::Fs, path: &Path) -> io::Result<Vec<u8>> {
	let mut bytes = Vec::new();
	let mut source = stdio::Source::open(fs, path).await?;
	match source.read_to_end(&mut bytes, MAX_LINE_BYTES).await {
		Ok(_) => Ok(bytes),
		Err(error) if error.kind() == io::ErrorKind::OutOfMemory => {
			Err(io::Error::other(format!("pattern file larger than {} MiB", MAX_LINE_BYTES >> 20)))
		},
		Err(error) => Err(error),
	}
}

/// The searcher the whole search shares. `-m`'s count is NOT given to it:
/// GNU prints the trailing context of the line that reaches the count, and
/// a matching line inside that context as a context line, which the sink
/// does; the searcher would stop at the count instead.
fn build_searcher(cli: &GrepArgs, opts: &Options) -> SearcherBuilder {
	let binary_detection = if cli.null_data || opts.binary_files == BinaryFiles::Text {
		BinaryDetection::none()
	} else if opts.binary_files == BinaryFiles::WithoutMatch {
		BinaryDetection::quit(b'\0')
	} else {
		BinaryDetection::convert(b'\0')
	};
	let mut builder = SearcherBuilder::new();
	builder
		.line_number(opts.line_number)
		.before_context(opts.before)
		.after_context(opts.after)
		.invert_match(cli.invert)
		.binary_detection(binary_detection)
		.heap_limit(Some(SEARCH_HEAP_LIMIT));
	if cli.null_data {
		builder.line_terminator(LineTerminator::byte(b'\0'));
	}
	builder
}

/// Searches stdin chunk by chunk, flushing output after each chunk so matches
/// are visible before end of input.
async fn search_stdin<M: Matcher + Clone + Send + Sync + 'static>(
	host: &mut Host,
	matcher: &LineMatcher<M>,
	builder: &SearcherBuilder,
	display: Vec<u8>,
	opts: &Options,
	out: &mut impl Write,
) -> io::Result<bool> {
	let mut searcher = builder.build();
	let terminator = bound_terminator(&searcher, matcher);
	let mut err = Vec::new();
	let mut sink = GrepSink {
		out,
		err: &mut err,
		matcher,
		display: &display,
		opts,
		match_count: 0,
		any_match: false,
		binary: false,
		last_end: None,
		after_left: None,
		next_matches: Vec::new(),
	};
	let mut search = searcher.search_push(matcher, &mut sink);
	let mut buf = vec![0u8; READ_CHUNK];
	let mut run = 0;
	loop {
		let read = host.read_stdin(&mut buf).await?;
		if read == 0 {
			break;
		}
		check_run(terminator, &mut run, &buf[..read])?;
		let more = search.push(&buf[..read])?;
		host.flush_output().await?;
		if !more {
			break;
		}
	}
	search.finish()?;
	let matched = sink.any_match;
	host.flush_output().await?;
	let _ = host.stderr.write_all(&err);
	Ok(matched)
}

#[allow(clippy::too_many_arguments)]
async fn execute_search<M: Matcher + Clone + Send + Sync + 'static>(
	host: &mut Host,
	cli: &GrepArgs,
	matcher: &LineMatcher<M>,
	files: &[OsString],
	directory_action: DirectoryAction,
	follow_links: bool,
	rules: &PathRules,
	opts: &Options,
) -> i32 {
	let builder = build_searcher(cli, opts);
	let fs = host.vfs();
	let (_guard, outer) = HaltGuard::new();
	let mut out = host.stdout_writer();
	let mut any_match = false;
	let mut had_error = false;

	for operand in files {
		if opts.quiet && any_match {
			break;
		}

		if operand == OsStr::new("-") {
			// `--label` names standard input everywhere else, so it names it
			// in the refusal diagnostic too.
			let input_name = cli.label.as_deref().unwrap_or_else(|| OsStr::new("(standard input)"));
			if opts.refuse_output_file && host.stdin_is_stdout() {
				// GNU grep refuses standard input that is the file its output
				// lands in: the matches it writes would be read back and
				// matched again, so the input is never read.
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(
						host.stderr,
						"grep: {}: input file is also the output",
						input_name.to_string_lossy()
					);
				}
				continue;
			}
			let display = input_name.as_encoded_bytes();
			match search_stdin(host, matcher, &builder, display.to_vec(), opts, &mut out).await {
				Ok(matched) => any_match |= matched,
				// Abort remaining work; the host maps the BrokenPipe status.
				Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
					return crate::host::SIGPIPE_EXIT_CODE;
				},
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							host.stderr,
							"grep: (standard input): {}",
							describe_search_error(&error)
						);
					}
				},
			}
			continue;
		}

		let resolved = host.resolve(operand);
		match fs.metadata(&resolved).await {
			Ok(metadata) if metadata.is_dir() => match directory_action {
				DirectoryAction::Recurse => {
					if rules.allows_dir(Path::new(operand)) {
						match search_dir(
							host,
							operand.as_os_str(),
							&resolved,
							matcher,
							&builder,
							opts,
							rules,
							follow_links,
							&outer,
							&mut out,
							&mut had_error,
						)
						.await
						{
							Ok(matched) => any_match |= matched,
							Err(_) => return crate::host::SIGPIPE_EXIT_CODE,
						}
					}
				},
				DirectoryAction::Skip => {},
				DirectoryAction::Read => {
					had_error = true;
					// `-s` silences this message as it silences the others;
					// `grep -s zz . f1` prints the match and exits 2.
					if !opts.no_messages {
						let _ = writeln!(
							host.stderr,
							"grep: {}: Is a directory",
							operand.display()
						);
					}
				},
			},
			Ok(metadata) => {
				if cli.devices == Some(DeviceAction::Skip) && !metadata.is_file() {
					continue;
				}
				if !rules.allows_file(Path::new(operand)) {
					continue;
				}
				let shared = DirSearch {
					fs:       fs.clone(),
					listed:   None,
					halt:     Halt { scope: Arc::clone(&outer), outer: Arc::clone(&outer) },
					operand:  operand.clone(),
					resolved: resolved.clone(),
					matcher:  matcher.clone(),
					searcher: builder.clone(),
					opts:     opts.clone(),
					stdout:   host.stdout_file(),
				};
				// Its own task, so dropping this body (cancellation) raises the
				// halt flag the search checks between reads.
				let path = resolved.clone();
				let found = match tokio::spawn(async move {
					let mut worker = shared.worker();
					shared.search(&mut worker, &path).await
				})
				.await
				{
					Ok(found) => found,
					Err(join) => std::panic::resume_unwind(join.into_panic()),
				};
				let written = out
					.write_all(&found.out)
					.and_then(|()| if opts.line_buffered { out.flush() } else { Ok(()) });
				if written.is_err() {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
				let _ = host.stderr.write_all(&found.err);
				if host.flush_output().await.is_err() {
					return crate::host::SIGPIPE_EXIT_CODE;
				}
				had_error |= found.had_error;
				match found.matched {
					Ok(matched) => any_match |= matched,
					Err(_) => return crate::host::SIGPIPE_EXIT_CODE,
				}
			},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ =
						writeln!(host.stderr, "grep: {}: {error}", operand.display());
				}
			},
		}
	}

	if let Err(error) = out.flush() {
		if error.kind() == io::ErrorKind::BrokenPipe {
			return crate::host::SIGPIPE_EXIT_CODE;
		}
	}
	if host.flush_output().await.is_err() {
		return crate::host::SIGPIPE_EXIT_CODE;
	}
	exit_status(opts.quiet, any_match, had_error)
}

impl AsyncUtility for Grep {
	const NAME: &'static str = "grep";
	const USAGE_ERROR: u8 = 2;
	/// grep must not read the file its own output lands in.
	const CHECKS_STDOUT_PATH: bool = true;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(normalize_context_args(argv))
	}

	async fn run(self, host: &mut Host) -> i32 {
		let cli = self.cli;
		let matches = self.matches;

	let (patterns, mut files) = match resolve_patterns(host, &cli).await {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	let directory_action = resolve_directory_action(&cli, &matches);
	if files.is_empty() {
		files.push(OsString::from(if directory_action == DirectoryAction::Recurse {
			"."
		} else {
			"-"
		}));
	}

	let max_count = resolve_max_count(&cli);
	let rules = match build_path_rules(host, &cli, &matches).await {
		Ok(rules) => rules,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	// A search that selects no record: an empty pattern file leaves nothing to
	// match, an inverted empty pattern matches every record and so selects
	// none, and `-m0` stops before the first. `-x` and `-w` constrain the empty
	// pattern, so they can still select records. GNU grep answers it without
	// reading its input, so it prints no count and reports no unreadable file:
	// it exits 1, unless `-L` is to list every file. With `-m0` it does not
	// compile the patterns either (`grep -m0 -E '('` exits 1).
	let zero_patterns = patterns.is_empty();
	let inverted_empty_pattern = cli.invert
		&& !cli.line_regexp
		&& !cli.word
		&& !zero_patterns
		&& patterns.iter().all(|pattern| pattern.is_empty());
	let selects_no_record =
		(zero_patterns && !cli.invert) || inverted_empty_pattern || cli.max_count == Some(0);
	let (files_with_matches, files_without_match) = resolve_file_list_modes(&matches);
	if selects_no_record && (cli.quiet || !files_without_match) {
		return 1;
	}
	let spec = MatcherSpec {
		mode:        resolve_match_mode(&matches),
		ignore_case: resolve_ignore_case(&matches),
		word:        cli.word,
		line_regexp: cli.line_regexp,
		null_data:   cli.null_data,
		jit:         pcre2_jit_enabled(host.var("OMP_PCRE2_JIT")),
		bytes:       false,
	};
	let matcher = match build_matcher(&patterns, spec) {
		Ok(matcher) => matcher,
		Err(error) => {
			let _ = writeln!(host.stderr, "grep: {error}");
			return 2;
		},
	};
	let output_suppressed = cli.count || files_with_matches || files_without_match || cli.quiet;
	// At each position `-o` prints the longest match of any alternative; see
	// `GrepSink::print_only_matching`. The lines `-v` selects hold no match,
	// and `-c`, `-l`, `-L` and `-q` print none.
	let prints_matches = cli.only_matching && !cli.invert && !output_suppressed;
	let alternatives = prints_matches
		.then(|| pattern_alternatives(&patterns, spec))
		.flatten()
		.map(|patterns| {
			Arc::new(Alternatives {
				patterns,
				spec,
				engines: OnceLock::new(),
				byte_engines: OnceLock::new(),
			})
		});
	let terminator = if cli.null_data { b'\0' } else { b'\n' };

	// `-o` prints no context line, and GNU still groups its output by the
	// context counts, printing a `--` between two groups.
	let (before, after, context_given) = if output_suppressed {
		(0, 0, false)
	} else {
		resolve_context(&cli)
	};
	let prefix_filename = resolve_filename_prefix(&matches)
		.unwrap_or(directory_action == DirectoryAction::Recurse || files.len() > 1);
	// GNU grep refuses to search the file its own output lands in: the matches
	// it writes would be read back and matched again, so the file grows
	// without bound. It exempts the modes that write at most one line per file
	// (`-q`, `-c`, `-l`, `-L`) and a count of at most one, tested on the
	// signed count as typed: `grep -m -2 x f >>f` searches `f`, as `-m1` does.
	let refuse_output_file = !output_suppressed && cli.max_count.is_none_or(|count| count > 1);
	let opts = Options {
		line_number: cli.line_number,
		byte_offset: cli.byte_offset,
		count: cli.count,
		files_with_matches,
		files_without_match,
		only_matching: cli.only_matching,
		before,
		after,
		no_messages: cli.no_messages,
		quiet: cli.quiet,
		prefix_filename,
		initial_tab: cli.initial_tab,
		record: RecordFormat {
			path_separator: None,
			null_paths:     cli.null_paths,
			terminator,
		},
		group_separator: resolve_group_separator(&cli, &matches),
		line_buffered: cli.line_buffered,
		binary_files: resolve_binary_files(&cli, &matches),
		max_count,
		mark_gaps: context_given && before == 0 && after == 0,
		refuse_output_file,
		alternatives,
	};
	let follow_links = resolve_follow_links(&cli, &matches);

	match matcher {
		Engine::Rust(text) => {
			let matcher = line_matcher(text, patterns, spec, terminator, |engine| match engine {
				Engine::Rust(engine) => Some(engine),
				Engine::Pcre(_) => None,
			});
			execute_search(host, &cli, &matcher, &files, directory_action, follow_links, &rules, &opts)
				.await
		},
		Engine::Pcre(text) => {
			let matcher = line_matcher(text, patterns, spec, terminator, |engine| match engine {
				Engine::Pcre(engine) => Some(engine),
				Engine::Rust(_) => None,
			});
			execute_search(host, &cli, &matcher, &files, directory_action, follow_links, &rules, &opts)
				.await
		},
	}
}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{self, Read, Write},
		sync::Arc,
	};

	use parking_lot::Mutex;

	use super::*;
	use crate::openfile as openfiles;
	use crate::host::{Host, run_async_util, run_caught_async};
	#[cfg(unix)]
	use crate::host::tree_with_sparse_file;

	#[tokio::test(flavor = "multi_thread")]
	async fn path_separator_rewrites_the_native_separator_on_windows() {
		// Defends: --path-separator must rewrite the platform's own separator
		// too, or Windows paths keep mixing `\` and the configured separator.
		let mut out = Vec::new();
		RecordFormat {
			path_separator: Some(b'#'),
			null_paths:     false,
			terminator:     b'\n',
		}
		.write_path(&mut out, b"a\\b/c")
		.unwrap();
		if cfg!(windows) {
			assert_eq!(out, b"a#b#c");
		} else {
			assert_eq!(out, b"a\\b#c");
		}
	}

	struct SnapshottingStdin {
		pos:      usize,
		snapped:  bool,
		stdout:   Arc<Mutex<Option<Arc<Mutex<Vec<u8>>>>>>,
		snapshot: Arc<Mutex<Vec<u8>>>,
	}

	const SNAPSHOT_INPUT: &[u8] = b"hit\nmiss\n";

	impl Read for SnapshottingStdin {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if self.pos < SNAPSHOT_INPUT.len() {
				let n = buf.len().min(SNAPSHOT_INPUT.len() - self.pos);
				buf[..n].copy_from_slice(&SNAPSHOT_INPUT[self.pos..self.pos + n]);
				self.pos += n;
				return Ok(n);
			}
			// Input exhausted: grep is back asking for more. Whatever it has
			// already flushed to stdout is what a live consumer would see now.
			if !self.snapped {
				let stdout = self.stdout.lock().clone().expect("stdout buffer is initialized");
				*self.snapshot.lock() = stdout.lock().clone();
				self.snapped = true;
			}
			Ok(0)
		}
	}

	impl Write for SnapshottingStdin {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl openfiles::Stream for SnapshottingStdin {}

	async fn run(args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_async_util::<Grep>(args, stdin, "/").await;
		(code, capture.out(), capture.err())
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn stdin_matches_are_visible_before_eof() {
		let stdout = Arc::new(Mutex::new(None));
		let snapshot = Arc::new(Mutex::new(Vec::new()));
		let stdin = Box::new(SnapshottingStdin {
			pos: 0,
			snapped: false,
			stdout: Arc::clone(&stdout),
			snapshot: Arc::clone(&snapshot),
		});
		let (mut host, capture) = Host::for_test_with_stdin("grep", stdin, "/");
		*stdout.lock() = Some(capture.stdout_buffer());

		let parsed = Grep::try_parse_from(["grep", "hit", "-"]).unwrap();
		assert_eq!(parsed.run(&mut host).await, 0, "{}", capture.err());

		// A regression re-buffering grep's output makes matches invisible until EOF.
		assert_eq!(snapshot.lock().as_slice(), b"hit\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn max_count_and_no_match_statuses_are_gnu_compatible() {
		let (code, out, err) = run(&["-m1", "hit"], "hit\nmiss\nhit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "hit\n");
		let (code, out, _) = run(&["absent"], "hit\n").await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
	}

	/// `-e` exists so a pattern may start with `-` (GNU grep); clap used to
	/// read `-e --canary` as an unknown `--canary` flag and exit 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn regexp_operand_may_start_with_a_dash() {
		let input = "x --canary\n-> y\nz\n";
		let (code, out, err) = run(&["-e", "--canary"], input).await;
		assert_eq!((code, out.as_str()), (0, "x --canary\n"), "{err}");
		let (code, out, err) = run(&["-ne", "->", "--regexp", "-z"], input).await;
		assert_eq!((code, out.as_str()), (0, "2:-> y\n"), "{err}");
		// These agree with GNU grep 3.11: its count, `-o` output and `-n`
		// output for each.
		for (args, line) in [
			(&["-e", "- x"][..], "- x\n"),
			(&["-F", "-e", "- x"][..], "- x\n"),
			(&["-e", "-v"][..], "-v\n"),
		] {
			let outputs = [("-c", "1\n".to_owned()), ("-o", line.to_owned()), ("-n", format!("1:{line}"))];
			for (flag, want) in outputs {
				let argv: Vec<&str> = std::iter::once(flag).chain(args.iter().copied()).collect();
				let (code, out, err) = run(&argv, line).await;
				assert_eq!((code, out), (0, want), "{argv:?}: {err}");
			}
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn pattern_file_is_resolved_against_shell_cwd() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("patterns"), "alpha\nbeta\n").unwrap();
		std::fs::write(tree.path().join("haystack"), "alpha\ngamma\nbeta\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-f", "patterns", "haystack"], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "alpha\nbeta\n");
	}

	/// GNU grep reads the argument after `-f` as the file whatever its first
	/// character; clap refused `-f -pats` with "a value is required for
	/// '--file <FILE>'" and exit 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn pattern_file_name_may_start_with_a_dash() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("-pats"), "b\n").unwrap();
		std::fs::write(tree.path().join("haystack"), "a\nb\nc\n").unwrap();
		for (args, want) in [
			(&["-c", "-f", "-pats", "haystack"][..], "1\n"),
			(&["-o", "-f", "-pats", "haystack"][..], "b\n"),
			(&["-n", "--file", "-pats", "haystack"][..], "2:b\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out().as_str()), (0, want), "{args:?}: {}", capture.err());
		}
	}

	/// GNU grep 3.11 reads a group of short options as getopt does: the first
	/// option in it that takes a value takes the rest of the group, or the next
	/// argument whatever its first character when the group ends there. Only
	/// a lone `-e` or `-f` took the next argument, so after `-ve` a `-5` was
	/// rewritten to `--context=5`, which clap then took as the pattern.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_option_ending_a_group_takes_the_next_argument_as_its_value() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("in"), "-5\n-1\nx\nzz\nb\n").unwrap();
		std::fs::write(tree.path().join("-1"), "-5\n").unwrap();
		for (args, want) in [
			(&["-ve", "-5", "in"][..], "-1\nx\nzz\nb\n"),
			(&["-ce", "-5", "in"][..], "1\n"),
			(&["-ne", "-1", "in"][..], "2:-1\n"),
			(&["-cf", "-1", "in"][..], "1\n"),
			(&["-cm", "-1", "x", "in"][..], "1\n"),
			// A value inside the group, and an option alone, as before.
			(&["-ve-5", "in"][..], "-1\nx\nzz\nb\n"),
			(&["-c", "-e", "-5", "in"][..], "1\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out().as_str()), (0, want), "{args:?}: {}", capture.err());
		}
	}

	/// GNU grep 3.11 reads the digits in a group of short options as a context
	/// count, as getopt reads its digit options: a run of digits is one count
	/// and a later one replaces it, and the first option that takes a value
	/// takes the rest of the group or the next argument. Only an argument of
	/// digits was a count, so clap refused `-5e` with "unexpected argument
	/// '-5'" and exit 2. A value attached with a leading `=` keeps it, as GNU
	/// grep reads it, where clap dropped it: `-e=x` searched `x`.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_context_count_in_a_group_of_short_options_is_read_as_gnu_grep_reads_it() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("ctx"), "1\n2\n3\nmid\n5\n6\n7\n").unwrap();
		std::fs::write(tree.path().join("in"), "-5\n-1\nx\nzz\nb\n").unwrap();
		std::fs::write(tree.path().join("-1"), "-5\n").unwrap();
		std::fs::write(tree.path().join("eq"), "a=x\nx\n").unwrap();
		for (args, want) in [
			(&["-5e", "mid", "ctx"][..], "1\n2\n3\nmid\n5\n6\n7\n"),
			(&["-2f", "-1", "in"][..], "-5\n-1\nx\n"),
			(&["-n2e", "mid", "ctx"][..], "2-2\n3-3\n4:mid\n5-5\n6-6\n"),
			// A later run of digits replaces the count, and one run is one count.
			(&["-2n1e", "mid", "ctx"][..], "3-3\n4:mid\n5-5\n"),
			(&["-n12", "-e", "mid", "ctx"][..], "1-1\n2-2\n3-3\n4:mid\n5-5\n6-6\n7-7\n"),
			// The rest of the group after a count and `-e` is the pattern.
			(&["-c1e-5", "in"][..], "1\n"),
			// A digit in an option's value is that value, as before.
			(&["-m5", "mid", "ctx"][..], "mid\n"),
			(&["-A2", "mid", "ctx"][..], "mid\n5\n6\n"),
			(&["-e5", "ctx"][..], "5\n"),
			(&["-5", "mid", "ctx"][..], "1\n2\n3\nmid\n5\n6\n7\n"),
			(&["-e=x", "eq"][..], "a=x\n"),
			(&["-ve=x", "eq"][..], "x\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out().as_str()), (0, want), "{args:?}: {}", capture.err());
		}
		// GNU grep refuses a `-` in a group ("invalid option -- '-'") and a
		// count with a leading `=` ("invalid max count"), and exits 2.
		for args in [&["-5-", "mid", "ctx"][..], &["-5-3", "ctx"][..], &["-m=1", "x", "eq"][..]] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out().as_str()), (2, ""), "{args:?}: {}", capture.err());
		}
	}

	/// A file with no line terminator used to make grep buffer it whole: on a
	/// sparse file that is an endless line of NUL bytes, and the host process
	/// grew until the kernel killed it. Now that file is a per-file error and
	/// the walk still reports matches in the other files.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn line_longer_than_the_limit_is_a_file_error_not_unbounded_memory() {
		let tree = tree_with_sparse_file();

		let (code, capture) = run_async_util::<Grep>(&["-rl", "needle", "."], "", tree.path()).await;

		assert_eq!(code, 2, "an unreadable file makes the status 2, as in GNU grep");
		assert_eq!(capture.out(), "./small\n");
		let err = capture.err();
		assert!(err.contains("grep: ./big: line longer than 256 MiB, not searched"), "{err}");
	}

	/// `-f` used to read the whole pattern file into memory, so pointing it at
	/// a sparse file (or an endless stdin) killed the host. Now an over-size
	/// pattern file is refused before anything is searched.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn pattern_file_larger_than_the_limit_is_refused() {
		let tree = tree_with_sparse_file();

		let (code, capture) = run_async_util::<Grep>(&["-f", "big", "small"], "", tree.path()).await;

		assert_eq!(code, 2);
		assert_eq!(capture.out(), "");
		let err = capture.err();
		assert!(err.contains("grep: big: pattern file larger than 256 MiB"), "{err}");
	}

	/// Drains `input` through the line bound, as the searcher would, and
	/// returns the typed limit error if one stopped it.
	fn drain_bounded(input: impl Read, terminator: Option<u8>) -> Option<String> {
		let mut input = input;
		let mut run = 0;
		let mut buf = vec![0u8; 64 * 1024];
		loop {
			let read = input.read(&mut buf).unwrap();
			if read == 0 {
				return None;
			}
			match check_run(terminator, &mut run, &buf[..read]) {
				Ok(()) => {},
				Err(error) => {
					assert!(
						error.get_ref().is_some_and(|inner| inner.is::<LineLimitExceeded>()),
						"untyped error: {error}"
					);
					return Some(describe_search_error(&error));
				},
			}
		}
	}

	/// The bound counts the unterminated run, including one that a terminator
	/// later in the same read closes: a line one byte over fails with the typed
	/// error whether or not it is ever terminated, and a terminator resets it.
	#[test]
	fn line_bound_fails_one_byte_past_the_limit_with_a_typed_error() {
		let limit = MAX_LINE_BYTES as u64;
		let line = || io::repeat(b'x').take(limit);

		assert_eq!(drain_bounded(line().chain(&b"\n"[..]).chain(line()), Some(b'\n')), None);
		let over = Some("line longer than 256 MiB, not searched".to_owned());
		assert_eq!(drain_bounded(line().chain(&b"x"[..]), Some(b'\n')), over);
		assert_eq!(drain_bounded(line().chain(&b"x\nshort\n"[..]), Some(b'\n')), over);
		assert_eq!(
			drain_bounded(line().chain(&b"\n"[..]).chain(line()).chain(&b"\n"[..]), None),
			Some("file larger than 256 MiB, not searched".to_owned())
		);
	}

	/// Runs `grep` with `args` in `cwd` and stdout redirected (`>>`) into
	/// `stdout_path`, the way the shell sets it up, returning its exit status
	/// together with the captured stderr.
	async fn run_with_stdout_file(
		args: &[&str],
		cwd: &std::path::Path,
		stdout_path: &std::path::Path,
	) -> (i32, String) {
		let stdout = std::fs::OpenOptions::new()
			.append(true)
			.open(stdout_path)
			.expect("stdout file");
		let (mut host, capture) = Host::for_test_async("grep", "", cwd);
		host.set_test_stdout(openfiles::OpenFile::File(Arc::new(stdout)));
		let code = run_parsed(args, &mut host).await;
		(code, capture.err())
	}

	/// Runs `grep` with `args` and standard input and stdout both on `path`,
	/// the way `… < out >> out` sets them up, returning its exit status
	/// together with the captured stderr.
	async fn run_with_stdin_and_stdout_file(
		args: &[&str],
		cwd: &std::path::Path,
		path: &std::path::Path,
	) -> (i32, String) {
		let stdout = std::fs::OpenOptions::new()
			.append(true)
			.open(path)
			.expect("stdout file");
		let stdin = std::fs::OpenOptions::new()
			.read(true)
			.open(path)
			.expect("stdin file");
		let (mut host, capture) = Host::for_test_async("grep", "", cwd);
		host.set_test_stdin(openfiles::OpenFile::File(Arc::new(stdin)));
		host.set_test_stdout(openfiles::OpenFile::File(Arc::new(stdout)));
		let code = run_parsed(args, &mut host).await;
		(code, capture.err())
	}

	/// Parses `args` as the adapter does, runs `grep` on `host`, and drains
	/// the output the body buffered.
	async fn run_parsed(args: &[&str], host: &mut Host) -> i32 {
		let argv = std::iter::once(OsString::from("grep"))
			.chain(args.iter().copied().map(OsString::from))
			.collect::<Vec<_>>();
		let argv = Grep::rewrite_argv(argv).expect("rewrite argv");
		let parsed = Grep::try_parse_from(argv).expect("parse");
		run_caught_async::<Grep>(parsed, host).await
	}

	/// Contract: grep refuses to search the file its own output lands in.
	///
	/// GNU grep rejects that input with exit status 2 and "input file is also
	/// the output", because the matches it writes would be read back and
	/// matched again. A consumer that redirects grep's output into a file it
	/// also searches must see that diagnostic rather than a growing file.
	#[tokio::test(flavor = "multi_thread")]
	async fn searching_the_output_file_itself_is_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-m2", "needle", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("input file is also the output"), "{err}");
		// The refused input is left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: grep refuses standard input that is the file its output lands
	/// in.
	///
	/// GNU grep reports `(standard input): input file is also the output` and
	/// exits 2, because the matches it writes would be read back and matched
	/// again; the input is never read at all.
	#[tokio::test(flavor = "multi_thread")]
	async fn reading_standard_input_that_is_the_output_file_is_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdin_and_stdout_file(&["needle", "-"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(
			err.contains("(standard input): input file is also the output"),
			"{err}"
		);
		// The refused input is left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: `--label` names standard input in the refusal diagnostic.
	///
	/// GNU grep reports the label it was given, not the generic
	/// `(standard input)`, when it refuses an input that is also its output.
	#[tokio::test(flavor = "multi_thread")]
	async fn the_label_names_standard_input_in_the_refusal_diagnostic() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdin_and_stdout_file(&["--label=foo", "needle", "-"], tree.path(), &path)
				.await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("grep: foo: input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: `--no-messages` silences the refusal but keeps its status.
	///
	/// GNU grep still exits 2 for an input that is also its output when `-s`
	/// is given; only the diagnostic is suppressed.
	#[tokio::test(flavor = "multi_thread")]
	async fn no_messages_suppresses_the_refusal_message_but_not_its_status() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-s", "needle", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2);
		assert_eq!(err, "");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: a recursive search refuses the output file it walks into.
	///
	/// GNU grep names the offending file by its path under the searched
	/// directory and exits 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_recursive_search_refuses_the_output_file_it_walks_into() {
		let tree = tempfile::tempdir().unwrap();
		let dir = tree.path().join("tree");
		std::fs::create_dir(&dir).unwrap();
		let path = dir.join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		let (code, err) = run_with_stdout_file(&["-r", "needle", "tree"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		// The name is built with `Path::join`, as the implementation builds
		// it, so the separator is the native one.
		let named = Path::new("tree").join("out.txt");
		assert!(
			err.contains(&format!("{}: input file is also the output", named.display())),
			"{err}"
		);
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: the modes whose output cannot feed back into the search still
	/// read the file they write to.
	///
	/// GNU grep exempts them from the same-file rejection: `-q`, `-c` and the
	/// list modes write at most one line per file, and `-m1` stops after the
	/// first match. Each row below checks the record the mode leaves in the
	/// file it read, and the exit status it reports.
	#[tokio::test(flavor = "multi_thread")]
	async fn modes_that_cannot_feed_their_output_back_still_read_the_output_file() {
		for (args, expected_code, expected_file) in [
			(&["-q", "needle", "out.txt"][..], 0, &b"needle\n"[..]),
			(&["-c", "needle", "out.txt"][..], 0, &b"needle\n1\n"[..]),
			(&["-l", "needle", "out.txt"][..], 0, &b"needle\nout.txt\n"[..]),
			// A file without a match is the one `-L` lists, so it prints its
			// name and reports that no line matched.
			(&["-L", "absent", "out.txt"][..], 1, &b"needle\nout.txt\n"[..]),
			(&["-m1", "needle", "out.txt"][..], 0, &b"needle\nneedle\n"[..]),
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\n").unwrap();
			let (code, err) = run_with_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, expected_code, "{args:?}: {err}");
			assert_eq!(std::fs::read(&path).unwrap(), *expected_file, "{args:?}: {err}");
		}
	}

	/// Contract: the modes whose output cannot feed back into the search still
	/// read standard input that is also the output file.
	///
	/// The exemption holds for standard input as well as for a named file.
	#[tokio::test(flavor = "multi_thread")]
	async fn modes_that_cannot_feed_their_output_back_still_read_standard_input() {
		for (args, expected_code, expected_file) in [
			(&["-q", "needle"][..], 0, &b"needle\n"[..]),
			(&["-c", "needle"][..], 0, &b"needle\n1\n"[..]),
			(&["-l", "needle"][..], 0, &b"needle\n(standard input)\n"[..]),
			(&["-L", "absent"][..], 1, &b"needle\n(standard input)\n"[..]),
			(&["-m1", "needle"][..], 0, &b"needle\nneedle\n"[..]),
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\n").unwrap();
			let (code, err) =
				run_with_stdin_and_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, expected_code, "{args:?}: {err}");
			assert_eq!(std::fs::read(&path).unwrap(), *expected_file, "{args:?}: {err}");
		}
	}

	/// Contract: a search with no pattern at all is not reading its own
	/// output.
	///
	/// GNU grep answers a search whose pattern file is empty without reading
	/// the file: it reports that no line matched and leaves the file alone. The
	/// search selects no record, so it writes nothing that could be read back.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_search_with_no_patterns_is_not_refused_as_the_output_file() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		std::fs::write(tree.path().join("patterns"), "").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-f", "patterns", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 1, "{err}");
		assert!(!err.contains("input file is also the output"), "{err}");
		// The file is left exactly as it was.
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: an inverted search with no pattern at all is still refused.
	///
	/// The boundary of the exemption above: with no pattern the matcher
	/// matches nothing, and an inverted search of it selects every record.
	/// GNU grep therefore still rejects the file it writes into.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inverted_search_with_no_patterns_is_still_refused() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\n").unwrap();
		std::fs::write(tree.path().join("patterns"), "").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-v", "-f", "patterns", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\n");
	}

	/// Contract: an inverted empty pattern is not reading its own output.
	///
	/// GNU grep answers `grep -v ''` without reading the file, and writes
	/// nothing: the empty pattern matches every record, so the inverted search
	/// selects none of them and the file is not its own output.
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inverted_empty_pattern_is_not_refused_as_the_output_file() {
		let tree = tempfile::tempdir().unwrap();
		let path = tree.path().join("out.txt");
		std::fs::write(&path, "needle\nother\n").unwrap();
		let (code, err) =
			run_with_stdout_file(&["-v", "-e", "", "out.txt"], tree.path(), &path).await;
		assert_eq!(code, 1, "{err}");
		assert!(!err.contains("input file is also the output"), "{err}");
		assert_eq!(std::fs::read(&path).unwrap(), b"needle\nother\n");
	}

	/// Contract: an empty pattern constrained by `-x` or `-w` is still refused.
	///
	/// The boundary of the exemption above: `-x` limits the empty pattern to
	/// empty lines and `-w` leaves it matching nothing, so an inverted search
	/// of either still selects records and can write into the file it reads.
	/// GNU grep rejects that file.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_constrained_inverted_empty_pattern_is_still_refused() {
		for args in [
			&["-v", "-x", "-e", "", "out.txt"][..],
			&["-v", "-w", "-e", "", "out.txt"][..],
		] {
			let tree = tempfile::tempdir().unwrap();
			let path = tree.path().join("out.txt");
			std::fs::write(&path, "needle\nother\n").unwrap();
			let (code, err) = run_with_stdout_file(args, tree.path(), &path).await;
			assert_eq!(code, 2, "{args:?}: {err}");
			assert!(err.contains("input file is also the output"), "{args:?}: {err}");
			assert_eq!(
				std::fs::read(&path).unwrap(),
				b"needle\nother\n",
				"{args:?}: {err}"
			);
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn perl_mode_supports_lookbehind() {
		let (code, out, err) = run(&["-P", "(?<=foo)bar"], "foobar\nbar\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "foobar\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn compact_numeric_context_is_rewritten_before_clap() {
		let input = "a\nhit\nb\ngap\nc\nhit\nd\n";
		let (code, out, err) = run(&["-1", "--group-separator=@", "hit"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "a\nhit\nb\n@\nc\nhit\nd\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_rules_filter_walk_and_preserve_relative_names() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("keep.rs"), "hit\n").unwrap();
		std::fs::write(tree.path().join("drop.txt"), "hit\n").unwrap();
		std::fs::create_dir(tree.path().join("vendor")).unwrap();
		std::fs::write(tree.path().join("vendor/hidden.rs"), "hit\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-r", "--include=*.rs", "--exclude-dir=vendor", "hit", "."], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		assert!(capture.out().contains("keep.rs:hit"));
		assert!(!capture.out().contains("drop.txt"));
		assert!(!capture.out().contains("hidden.rs"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_search_prints_files_in_path_order() {
		let tree = tempfile::tempdir().unwrap();
		let files = ["t/z.txt", "t/b/1.txt", "t/a/c/2.txt", "t/a/b/3.txt", "t/a/0.txt", "t/m.txt"];
		for file in files {
			let path = tree.path().join(file);
			std::fs::create_dir_all(path.parent().unwrap()).unwrap();
			std::fs::write(path, "hit\n").unwrap();
		}
		let (code, capture) = run_async_util::<Grep>(&["-rl", "hit", "t"], "", tree.path()).await;
		assert_eq!(code, 0, "{}", capture.err());
		let expected: String = ["t/a/0.txt", "t/a/b/3.txt", "t/a/c/2.txt", "t/b/1.txt", "t/m.txt", "t/z.txt"]
			.iter()
			.map(|path| format!("{}\n", path.replace('/', std::path::MAIN_SEPARATOR_STR)))
			.collect();
		assert_eq!(capture.out(), expected);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn quiet_match_wins_over_later_error() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("hit"), "needle\n").unwrap();
		let (code, capture) = run_async_util::<Grep>(&["-q", "needle", "hit", "missing"], "", tree.path()).await;
		assert_eq!(code, 0);
		assert!(capture.out().is_empty());
		assert!(capture.err().is_empty());
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn byte_offsets_labels_and_nul_separators_are_rendered() {
		let (code, out, err) = run(&["-bn", "hit"], "no\nhit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2:3:hit\n");
		let (code, out, err) = run(&["--label=pipe", "-HZ", "hit"], "hit\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out.as_bytes(), b"pipe\0hit\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn basic_mode_is_posix_bre_and_extended_mode_is_strict() {
		let (code, out, err) = run(&["-A", "1", "fail)"], "ok\n(1 fail)\nnext\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "(1 fail)\nnext\n");
		// GNU grep 3.11 takes an unmatched `)` in an ERE literally:
		// `printf 'fail)\n' | grep -cE 'fail)'` counts the line and exits 0.
		let (code, out, err) = run(&["-cE", "fail)"], "fail)\nplain\n").await;
		assert_eq!((code, out.as_str()), (0, "1\n"), "{err}");
		// In a BRE a bare `+` is a LITERAL, so `fo+` does not match `foooo`.
		// This assertion previously expected `foooo`, which is ERE
		// behaviour; `/usr/bin/grep -e 'fo+' -e 'bar)' -h` on this input
		// prints `bar)` alone on both GNU and BSD grep. Use `fo\+` for the
		// quantifier.
		let (code, out, err) =
			run(&["-e", "fo+", "-e", "bar)", "-h"], "foooo\nbar)\nbaz\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "bar)\n");
		let (code, out, err) = run(&["-e", r"fo\+", "-h"], "foooo\nbar)\nbaz\n").await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "foooo\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn gnu_basic_alternation_and_color_aliases_are_supported() {
		let input = "\"tools.xdev\": {}\n\"tools.toolbox\": {}\n\"tools.other\": {}\n";
		let (code, out, err) = run(&["-c", r"tools.xdev\|tools.toolbox"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");
		for color in ["--color=auto", "--color=always", "--color=never", "--color"] {
			let (code, out, err) = run(&[color, "foo"], "foo\nbar\n").await;
			assert_eq!(code, 0, "{err}");
			assert_eq!(out, "foo\n");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn version_is_reported_on_stdout() {
		let (code, out, err) = run(&["--version"], "").await;
		assert_eq!(code, 0);
		assert!(err.is_empty());
		assert!(out.contains("grep") && out.contains("pi-uu-grep"));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn repetition_with_no_operand_is_literal_in_a_bre_and_dropped_in_an_ere() {
		// Measured against /usr/bin/grep 3.11 on this fixture. Before this,
		// every BRE row below returned 5 - the whole file - because `^+`
		// reached the engine as an operator and compiled to `(?:^)+`,
		// matching the empty string at every line start.
		let input = "alpha\n+added\n-removed\n context\n+another\n";
		for (pattern, want) in
			[("^+", "2\n"), ("^*", "0\n"), ("^?", "0\n"), ("*x", "0\n"), ("^\\+", "2\n")]
		{
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert!(code == 0 || code == 1, "{pattern}: {err}");
			assert_eq!(out, want, "pattern {pattern}");
		}

		// The forms that already agreed must not regress.
		for (pattern, want) in [("+added", "1\n"), ("[+]", "2\n"), ("a\\+", "3\n")] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!(code, 0, "{pattern}: {err}");
			assert_eq!(out, want, "pattern {pattern}");
		}

		// An ERE drops the operator instead, with a warning of its own:
		// `grep -cE '^+'` counts every line and `grep -cE '*x'` the lines
		// holding an `x`. An anchor breaks adjacency to an earlier atom too,
		// so `a^+` repeats the anchor and can never match.
		for (pattern, want) in
			[("^+", "5\n"), ("^*", "5\n"), ("^?", "5\n"), ("*x", "1\n"), ("a^+", "0\n"), ("a$*", "3\n")]
		{
			let (code, out, err) = run(&["-Ec", pattern], input).await;
			assert!(code == 0 || code == 1, "-E {pattern}: {err}");
			assert_eq!(out, want, "-E {pattern}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn an_interval_with_no_operand_is_the_text_itself_in_a_bre() {
		// Measured: `printf '{1,4}\n' | grep -c '\{1,4\}'` is 1 and the same
		// pattern counts no line of the fixture below, so the interval is the
		// text, neither an operator nor an error. Emitting the operator let
		// `grep-regex` compile `^{2}` as `(?:^){2}`, which matches at every
		// line start, so the whole file came back with exit 0.
		let input = "alpha\n+added\n-removed\n context\n+another\n";
		for pattern in [r"^\{2\}", r"^\{1,4\}", r"\{1,4\}", r"\(\{2\}\)"] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!((code, out.as_str()), (1, "0\n"), "{pattern}: {err}");
		}
		let (code, out, err) = run(&["-c", r"\{1,4\}"], "x{1,4}y\nplain\n").await;
		assert_eq!((code, out.as_str()), (0, "1\n"), "{err}");
		// With an operand it is an ordinary quantifier and still works.
		for pattern in [r"a\{1,2\}", r"a\|\{2\}"] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!((code, out.as_str()), (0, "3\n"), "{pattern}: {err}");
		}
		// A `\{` an atom precedes must open an interval: GNU refuses
		// `grep 'a\{1'` with "Unmatched \{".
		for pattern in [r"a\{1", r"a\{x", r"a\{"] {
			let (code, out, err) = run(&["-c", pattern], input).await;
			assert_eq!((code, out.as_str()), (2, ""), "{pattern}");
			assert!(err.contains("Unmatched \\{"), "{pattern}: {err}");
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn literal_brace_is_not_rejected_by_the_operand_check() {
		// `grep -E '^{"'` is a real pattern - the common JSON-line filter -
		// and GNU grep accepts it, because a `{` that opens no interval is a
		// literal. An earlier revision of this guard exited 2 on it.
		let input = "{\"a\":1}\n{foo\nplain\n";
		for args in
			[vec!["-c", "^{"], vec!["-Ec", "^\\{"], vec!["-Ec", "^\\{\""], vec!["-c", "{foo"]]
		{
			let (code, _, err) = run(&args, input).await;
			assert!(code == 0 || code == 1, "{args:?} must not error: {err}");
			assert!(!err.contains("operand invalid"), "{args:?}: {err}");
		}
		let (code, out, err) = run(&["-c", "^{"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_back_reference_is_run_by_the_pcre_engine() {
		// `grep-regex` cannot run a back-reference at all, so the pattern is
		// compiled with PCRE2 and gives GNU's answer: `grep -c '\(a\)\1'`
		// counts the lines holding a doubled `a`, not the lines holding the
		// text of the pattern.
		let (code, out, err) = run(&["-c", r"\(a\)\1"], "aa\nnope\n").await;
		assert_eq!((code, out.as_str()), (0, "1\n"), "{err}");
		let (code, out, err) = run(&["-cE", r"(a)\1"], "aa\nnope\n").await;
		assert_eq!((code, out.as_str()), (0, "1\n"), "{err}");
		let (code, out, err) = run(&["-c", r"\(a\)\1"], "x(a)\\1y\nnope\n").await;
		assert_eq!((code, out.as_str()), (1, "0\n"), "the pattern's own text is not what matches: {err}");
		// A back-reference to no group is refused, as GNU refuses it.
		let (code, out, _) = run(&["-c", r"\1"], "x\n").await;
		assert_eq!((code, out.as_str()), (2, ""));
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn only_the_first_caret_of_a_branch_anchors() {
		// Measured: `grep -c '^^'` counts lines beginning with a literal
		// caret, and `sed 's/^^/X/'` rewrites only those. Treating the second
		// caret as another anchor matched every line.
		let input = "^a\naaa\n^^b\n";
		let (code, out, err) = run(&["-c", "^^"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n");
		let (code, out, err) = run(&["-c", r"^\^"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n", "the escaped form must agree with the bare one");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_dollar_before_a_branch_boundary_still_anchors() {
		// `$` anchors at the end of a BRE BRANCH, not only at the end of the
		// whole pattern. Escaping it made the first branch unmatchable, so
		// lines ending in `a` were silently dropped from the result.
		let input = "a\nb\nca\nxb\nz\nax\n";
		let (code, out, err) = run(&["-c", r"a$\|b"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "4\n", "a, b, ca and xb all match");

		// The same alternation written the other way round must agree.
		let (_, out, err) = run(&["-c", r"b\|a$"], input).await;
		assert_eq!(out, "4\n", "{err}");

		// And inside a group, where `\)` ends the branch instead of `\|`.
		let (_, out, err) = run(&["-c", r"\(a$\)"], input).await;
		assert_eq!(out, "2\n", "{err}");

		// A `$` that ends neither is still a literal dollar sign.
		let (_, out, err) = run(&["-c", "a$b"], "a$b\nab\n").await;
		assert_eq!(out, "1\n", "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn bracket_expressions_are_not_translated_as_bre() {
		// Inside `[...]` the BRE operators are ordinary characters. The
		// translator used to read `\(` as a group opener, producing a pattern
		// the engine refused, which then fell back to a literal match.
		let input = "has ( paren\nhas \\ slash\nplain\n";
		let (code, out, err) = run(&["-c", r"[\(]"], input).await;
		assert_eq!(code, 0, "{err}");
		assert_eq!(out, "2\n", "a backslash OR a parenthesis, as measured");

		// `]` first is a literal, `^` still negates, and a character class
		for (pattern, want) in
			[(r"[]x]", "1\n"), (r"[^abc]", "3\n"), (r"[[:digit:]]", "1\n"), (r"[*+]", "1\n")]
		{
			let (code, out, err) = run(&["-c", pattern], "]\nq7\n*\nabc\n").await;
			assert_eq!(code, 0, "{pattern}: {err}");
			assert_eq!(out, want, "{pattern}");
		}

		// An unterminated bracket expression is not silently swallowed as an
		// empty class, nor matched as the text typed: GNU grep 3.11 refuses it.
		let (code, out, err) = run(&["-c", "a[d"], "a[d\nplain\n").await;
		assert_eq!((code, out.as_str()), (2, ""), "{err}");
		assert!(err.contains("grep: Unmatched [, [^, [:, [., or [="), "{err}");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn a_brace_that_opens_no_interval_is_literal_in_an_ere() {
		// Every expectation below is a measurement from /usr/bin/grep against
		// this same input, not a reading of the spec.
		let input = "{a}\na{\n{foo\na{1}b\nplain\n}\n[{]\n";
		for (pattern, want) in [
			("{a}", "1\n"),
			("a{", "2\n"),
			("{foo", "1\n"),
			("}", "3\n"),
			("[{]", "5\n"),
			(r"\{a\}", "1\n"),
			// Still a real interval, and still applied.
			("a{1}", "4\n"),
			("a{1,2}", "4\n"),
		] {
			let (code, out, err) = run(&["-Ec", pattern], input).await;
			assert_eq!(code, 0, "-E {pattern}: {err}");
			assert_eq!(out, want, "-E {pattern}");
		}
		// An unterminated interval is the text itself to GNU grep 3.11
		// (`grep -cE 'a{1,2'` counts the lines holding `a{1,2`), and an
		// interval with nothing to repeat is dropped with a warning, so
		// `{1}` matches every line.
		let (code, out, err) = run(&["-Ec", "a{1,2"], input).await;
		assert_eq!((code, out.as_str()), (1, "0\n"), "{err}");
		let (code, out, err) = run(&["-Ec", "{1}"], input).await;
		assert_eq!((code, out.as_str()), (0, "7\n"), "{err}");
		// An interval whose bounds run backwards stays an error, as it is
		// for GNU ("Invalid content of \\{\\}").
		let (code, out, _) = run(&["-Ec", "a{2,1}"], input).await;
		assert_eq!((code, out.as_str()), (2, ""));
	}

	/// Every expectation is GNU grep 3.11 on the same line: its count, `-o`
	/// output and `-n` output, in BRE and in ERE. The `regex` crate read these
	/// bracket expressions as a nested class or a set operation, so the count
	/// was 0 and `-E '[[]'` failed with "unclosed character class".
	#[tokio::test(flavor = "multi_thread")]
	async fn bracket_expressions_match_what_gnu_grep_matches() {
		for (pattern, line, only) in [
			("[[:space:]*?[]", "X=a b\n", " \n"),
			("[[]", "a[b\n", "[\n"),
			("[a&&b]", "a&b\n", "a\n&\nb\n"),
			("[~~]", "a~b\n", "~\n"),
			("[!--]", "a-b\n", "-\n"),
		] {
			for mode in ["-G", "-E"] {
				let (code, out, err) = run(&[mode, "-c", pattern], line).await;
				assert_eq!((code, out.as_str()), (0, "1\n"), "{mode} -c {pattern}: {err}");
				let (code, out, err) = run(&[mode, "-o", pattern], line).await;
				assert_eq!((code, out.as_str()), (0, only), "{mode} -o {pattern}: {err}");
				let (code, out, err) = run(&[mode, "-n", pattern], line).await;
				assert_eq!((code, out), (0, format!("1:{line}")), "{mode} -n {pattern}: {err}");
			}
		}
	}

	/// The bracket forms that already agreed with GNU grep 3.11 keep its
	/// meaning, in BRE and in ERE. `\` is an ordinary member, so `[\]]` is a
	/// backslash then a `]`; outside a bracket expression `\]` is a `]`.
	#[tokio::test(flavor = "multi_thread")]
	async fn common_bracket_expressions_keep_what_gnu_grep_matches() {
		let input = "abc\nx\n]\n7\n\\]\nx]\n";
		for (pattern, only, numbered) in [
			("[a-z]", "a\nb\nc\nx\nx\n", "1:abc\n2:x\n6:x]\n"),
			("[^x]", "a\nb\nc\n]\n7\n\\\n]\n]\n", "1:abc\n3:]\n4:7\n5:\\]\n6:x]\n"),
			("[]a]", "a\n]\n]\n]\n", "1:abc\n3:]\n5:\\]\n6:x]\n"),
			("[^]a]", "b\nc\nx\n7\n\\\nx\n", "1:abc\n2:x\n4:7\n5:\\]\n6:x]\n"),
			("[[:alpha:]]", "a\nb\nc\nx\nx\n", "1:abc\n2:x\n6:x]\n"),
			(r"[\]]", "\\]\n", "5:\\]\n"),
			(r"\]", "]\n]\n]\n", "3:]\n5:\\]\n6:x]\n"),
		] {
			for mode in ["-G", "-E"] {
				let (code, out, err) = run(&[mode, "-o", pattern], input).await;
				assert_eq!((code, out.as_str()), (0, only), "{mode} -o {pattern}: {err}");
				let (code, out, err) = run(&[mode, "-n", pattern], input).await;
				assert_eq!((code, out.as_str()), (0, numbered), "{mode} -n {pattern}: {err}");
			}
		}
	}

	/// GNU grep 3.11 refuses these bracket expressions with these words and
	/// exit 2, in BRE and in ERE, where the `regex` crate read them as a nested
	/// class, a class only it knows, or a list of characters. An unterminated
	/// one is refused too; see the next test.
	#[tokio::test(flavor = "multi_thread")]
	async fn invalid_bracket_expressions_are_refused_as_gnu_grep_refuses_them() {
		for (pattern, message) in [
			("[[:foo:]]", "Invalid character class name"),
			("[[:ascii:]]", "Invalid character class name"),
			("[[.space.]]", "Invalid collation character"),
			("[z-a]", "Invalid range end"),
			("[a-b-z]", "Invalid range end"),
			("[[:alpha:]-z]", "Invalid range end"),
		] {
			for mode in ["-G", "-E"] {
				let (code, out, err) = run(&[mode, "-c", pattern], "a\n").await;
				assert_eq!(code, 2, "{mode} {pattern} must be refused, got {out:?}");
				assert!(err.contains(message), "{mode} {pattern}: {err}");
			}
		}
		let (code, _, err) = run(&["-E", "-c", "a[b"], "a[b\n").await;
		assert_eq!(code, 2, "{err}");
		assert!(err.contains("Unmatched [, [^, [:, [., or [="), "{err}");
	}

	/// GNU grep 3.11 refuses each of these BRE patterns with "Unmatched [, [^,
	/// [:, [., or [=" and exit 2, as `-E` already did here, and the whole
	/// command when one of its patterns is one. A BRE passed the `[` on as a
	/// plain one, so grep matched the text typed or a nested class with exit
	/// 0, or found nothing with exit 1.
	#[tokio::test(flavor = "multi_thread")]
	async fn unterminated_bracket_expressions_are_refused_in_a_bre() {
		let input = "a\n:\nb]\n^\na[b\nx[]\nx\n[x\n";
		for args in [
			&["[[:alpha]]"][..],
			&["[[.a]b]"][..],
			&["[[=a]b]"][..],
			&["[a[:]b]"][..],
			&["a[b"][..],
			&["x[]"][..],
			&["[]"][..],
			&["[^]"][..],
			&["[[:alpha:]"][..],
			&["-e", "[x", "-e", "x"][..],
		] {
			let argv: Vec<&str> = std::iter::once("-n").chain(args.iter().copied()).collect();
			let (code, out, err) = run(&argv, input).await;
			assert_eq!((code, out.as_str()), (2, ""), "{argv:?}: {err}");
			assert!(err.contains("grep: Unmatched [, [^, [:, [., or [="), "{argv:?}: {err}");
		}
	}

	/// `-o` matches within the line's text, as GNU grep 3.11 does: a class that
	/// takes in the newline printed it as one more, empty-looking match.
	#[tokio::test(flavor = "multi_thread")]
	async fn only_matching_never_prints_the_line_terminator() {
		let (code, out, err) = run(&["-o", "[^x]"], "ab\nx\n").await;
		assert_eq!((code, out.as_str()), (0, "a\nb\n"), "{err}");
		let (code, out, err) = run(&["-o", "[[:space:]]"], "a b\nc\n").await;
		assert_eq!((code, out.as_str()), (0, " \n"), "{err}");
		let (code, out, err) = run(&["-zo", "[^x]"], "ab\0x\0").await;
		assert_eq!((code, out.as_str()), (0, "a\0b\0"), "{err}");
	}

	/// `-o` prints the matches of the non-empty patterns beside an empty one,
	/// as GNU grep 3.11 does. The empty pattern, earlier in the alternation,
	/// matched at every position, and its empty match hid the others'.
	#[tokio::test(flavor = "multi_thread")]
	async fn only_matching_prints_the_matches_beside_an_empty_pattern() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("in"), "-5\n-1\nx\nzz\nb\n").unwrap();
		std::fs::write(tree.path().join("pats"), "zz\n\nb\n").unwrap();
		for mode in ["-G", "-E", "-F"] {
			for (args, want) in [
				(&[mode, "-o", "-e", "", "-e", "zz", "in"][..], "zz\n"),
				(&[mode, "-on", "-e", "", "-e", "zz", "in"][..], "4:zz\n"),
				(&[mode, "-o", "-f", "pats", "in"][..], "zz\nb\n"),
			] {
				let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
				assert_eq!((code, capture.out().as_str()), (0, want), "{args:?}: {}", capture.err());
			}
		}
	}

	/// GNU grep 3.11's `-o` prints at each position the longest match of any
	/// pattern. The engines take the first pattern that matches there, so one
	/// that matches empty there, such as `q\?`, `()` or `x*`, hid a longer
	/// match of another: `-o -e 'q\?' -e zz` printed nothing.
	#[tokio::test(flavor = "multi_thread")]
	async fn only_matching_prints_another_patterns_match_where_one_matches_empty() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("ab"), "abc\nzz\nxxzz\nZZ\naab\n").unwrap();
		for (args, want) in [
			(&["-o", "-e", r"q\?", "-e", "zz", "ab"][..], "zz\nzz\n"),
			(&["-oE", "-e", "()", "-e", "zz", "ab"][..], "zz\nzz\n"),
			// `xx`, a non-empty match of the first pattern, is printed as before.
			(&["-o", "-e", "x*", "-e", "zz", "ab"][..], "zz\nxx\nzz\n"),
			// The offset is that of the match printed, and each pattern alone
			// still ignores case.
			(&["-ob", "-e", r"q\?", "-e", "zz", "ab"][..], "4:zz\n9:zz\n"),
			(&["-oi", "-e", r"q\?", "-e", "zz", "ab"][..], "zz\nzz\nZZ\n"),
			// No match is empty: each prints as the first pattern that matches there finds it.
			(&["-o", "-e", "zz", "-e", "b", "ab"][..], "b\nzz\nzz\nb\n"),
		] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out().as_str()), (0, want), "{args:?}: {}", capture.err());
		}
	}

	/// With no pattern, as from an empty `-f` file, GNU grep 3.11 selects no
	/// line, with `-i` as without: it exits 1 without reading its input, so it
	/// prints no count and reports no missing file, and only `-L` reads it, to
	/// list every file. Folding case turned no pattern into the empty regex,
	/// which selected every line.
	#[tokio::test(flavor = "multi_thread")]
	async fn no_pattern_selects_no_line_when_ignoring_case() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("in"), "-5\n-1\nx\nzz\nb\n").unwrap();
		std::fs::write(tree.path().join("empty"), "").unwrap();
		for mode in ["-G", "-E", "-F", "-P"] {
			for flags in ["-i", "-ic", "-in", "-io"] {
				let args = [mode, flags, "-f", "empty", "in", "missing"];
				let (code, capture) = run_async_util::<Grep>(&args, "", tree.path()).await;
				assert_eq!((code, capture.out(), capture.err()), (1, String::new(), String::new()), "{args:?}");
			}
		}
		let (code, capture) = run_async_util::<Grep>(&["-iL", "-f", "empty", "in"], "", tree.path()).await;
		assert_eq!((code, capture.out().as_str()), (1, "in\n"), "{}", capture.err());
	}

	/// GNU grep 3.11 answers `-m0` without reading its input or compiling its
	/// patterns: it prints nothing, not even a count, reports no missing file,
	/// and exits 1; only `-L` reads the files, to list every one. The search
	/// stopped before its first match instead, so `-c` printed `0` and a
	/// missing file was reported with exit 2.
	#[tokio::test(flavor = "multi_thread")]
	async fn max_count_zero_selects_no_line_without_reading_the_input() {
		let tree = tempfile::tempdir().unwrap();
		std::fs::write(tree.path().join("in"), "x\n").unwrap();
		for args in [
			&["-m0", "-c", "x", "in"][..],
			&["-m0", "-q", "x", "missing"][..],
			&["-m0", "-l", "x", "in", "missing"][..],
			&["-m0", "-E", "(", "in"][..],
		] {
			let (code, capture) = run_async_util::<Grep>(args, "", tree.path()).await;
			assert_eq!((code, capture.out(), capture.err()), (1, String::new(), String::new()), "{args:?}");
		}
		let (code, capture) =
			run_async_util::<Grep>(&["-m0", "-L", "x", "in", "missing"], "", tree.path()).await;
		assert_eq!((code, capture.out().as_str()), (2, "in\n"), "{}", capture.err());
		assert!(capture.err().contains("grep: missing: "), "{}", capture.err());
	}
}

