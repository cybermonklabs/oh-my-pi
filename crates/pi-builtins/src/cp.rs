//! `cp` builtin: copy files and directories.
//!
//! Ported from uutils coreutils 0.8.0.
//!
//! Every filesystem access goes through the shell's [`BlockingFs`], so
//! `scheme://` paths work as sources and destinations. Kernel fast paths
//! (copy-on-write clones through [`pi_iso::cow`], `copy_file_range`,
//! `SEEK_DATA` sparse copies) only run when both ends are native host files;
//! other pairs stream through the provider's handles. Diagnostics follow GNU
//! cp.
//!
//! Copies clone by default (`--reflink=auto`, or macOS's `-c`) and fall back
//! to a data copy wherever cloning is impossible, e.g. across filesystems.

use std::{
	cmp::Ordering,
	ffi::OsString,
	fmt,
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, value_parser};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use pi_vfs::{
	BlockingFs, CanonicalizeOptions, DirOptions, File, FileId, FileTime, Metadata, MissingHandling,
	NodeKind, OpenOptions, Permissions, ResolveMode, SymlinkKind, child_path, decode_segment, file_name,
	is_virtual_path, join_path, normalize_lexically, parent_path, url_scheme,
};
use rustc_hash::{FxHashMap, FxHashSet};
use thiserror::Error;
use uucore::{
	backup_control::{self, BackupMode},
	display::Quotable,
	fs::path_ends_with_terminator,
	parser::shortcut_value_parser::ShortcutValueParser,
	update_control::{self, UpdateMode},
};

use crate::{
	file_backup::{backup_display, backup_path, determine_backup_mode, determine_backup_suffix},
	host::{Host, Utility, format_usage, matches_parser, strip_errno},
	progress::stderr_draw_target,
};

/// Failure of one copy step.
#[derive(Debug, Error)]
pub(crate) enum CpError {
	/// A bare I/O failure.
	#[error("{}", strip_errno(.0))]
	IoErr(#[from] io::Error),

	/// An I/O failure with the operation it interrupted (`context: strerror`).
	#[error("{}: {}", .1, strip_errno(.0))]
	IoErrContext(io::Error, String),

	/// A complete diagnostic.
	#[error("{0}")]
	Error(String),

	/// A usage diagnostic, followed by GNU's pointer to `--help`.
	#[error("{0}\nTry 'cp --help' for more information.")]
	Usage(String),

	/// Some files were not copied; their diagnostics are already printed.
	#[error("")]
	NotAllFilesCopied,

	/// A destination was left alone (`-n`, a declined `-i` prompt, ...);
	/// `true` makes the skip fail the run.
	#[error("")]
	Skipped(bool),
}

type CopyResult<T> = Result<T, CpError>;

/// `ENOTSUP`-style failure for operations a filesystem cannot perform.
fn operation_not_supported() -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, "Operation not supported")
}

/// Specifies how to overwrite files.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum ClobberMode {
	Force,
	RemoveDestination,
	#[default]
	Standard,
}

/// Specifies whether files should be overwritten.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum OverwriteMode {
	/// [Default] Always overwrite existing files
	Clobber(ClobberMode),
	/// Prompt before overwriting a file
	Interactive(ClobberMode),
	/// Never overwrite a file
	NoClobber,
}

/// Possible arguments for `--reflink`; clones go through
/// [`pi_iso::cow::clone_file`].
#[derive(Debug, Copy, Clone, Eq, PartialEq, Default)]
enum ReflinkMode {
	Always,
	#[default]
	Auto,
	Never,
}

/// Possible arguments for `--sparse`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Default)]
enum SparseMode {
	Always,
	#[default]
	Auto,
	Never,
}

/// The expected file type of copy target
#[derive(Copy, Clone)]
enum TargetType {
	Directory,
	File,
}

/// Copy action to perform
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum CopyMode {
	Link,
	SymLink,
	#[default]
	Copy,
	Update,
	AttrOnly,
}

/// Preservation settings for various attributes
///
/// It should be derived from options as follows:
///
///  - if there is a list of attributes to preserve (i.e.
///    `--preserve=ATTR_LIST`) parse that list with [`Attributes::parse_iter`],
///  - if `-p` or `--preserve` is given without arguments, use
///    [`Attributes::DEFAULT`],
///  - if `-a`/`--archive` is passed, use [`Attributes::ALL`],
///  - if `-d` is passed use [`Attributes::LINKS`],
///  - otherwise, use [`Attributes::NONE`].
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Attributes {
	ownership:  Preserve,
	mode:       Preserve,
	timestamps: Preserve,
	context:    Preserve,
	links:      Preserve,
	xattr:      Preserve,
}

/// Whether one attribute is preserved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preserve {
	/// Not preserved; `explicit` when `--no-preserve` named it (e.g.
	/// `--no-preserve=mode` means `mode = No { explicit: true }`).
	No { explicit: bool },
	/// Preserved; failing to preserve is fatal when `required`.
	Yes { required: bool },
}

impl PartialOrd for Preserve {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Preserve {
	fn cmp(&self, other: &Self) -> Ordering {
		match (self, other) {
			(Self::No { .. }, Self::No { .. }) => Ordering::Equal,
			(Self::Yes { .. }, Self::No { .. }) => Ordering::Greater,
			(Self::No { .. }, Self::Yes { .. }) => Ordering::Less,
			(Self::Yes { required: req_self }, Self::Yes { required: req_other }) => {
				req_self.cmp(req_other)
			},
		}
	}
}

/// Options for the `cp` command, documented with the arguments that
/// determine their value.
#[derive(Debug)]
struct Options {
	/// `--attributes-only`
	attributes_only:        bool,
	/// `--backup[=CONTROL]`, `-b`
	backup:                 BackupMode,
	/// `--copy-contents`
	copy_contents:          bool,
	/// `-H`
	cli_dereference:        bool,
	/// `-l`, `-s`, `-u`, `--attributes-only`, or a plain copy.
	copy_mode:              CopyMode,
	/// `-L`, `--dereference`
	dereference:            bool,
	/// `-T`, `--no-target-dir`
	no_target_dir:          bool,
	/// `-x`, `--one-file-system`
	one_file_system:        bool,
	/// `-i`/`-n` with `-f`/`--remove-destination`.
	overwrite:              OverwriteMode,
	/// `--parents`
	parents:                bool,
	/// `--sparse[=WHEN]`
	sparse_mode:            SparseMode,
	/// `--strip-trailing-slashes`
	strip_trailing_slashes: bool,
	/// `--reflink[=WHEN]`
	reflink_mode:           ReflinkMode,
	/// `--preserve=[=ATTRIBUTE_LIST]` and `--no-preserve=ATTRIBUTE_LIST`
	attributes:             Attributes,
	/// `-R`, `-r`, `--recursive`
	recursive:              bool,
	/// `-S`, `--suffix`
	backup_suffix:          String,
	/// `-t`, `--target-directory`
	target_dir:             Option<PathBuf>,
	/// `--update[=UPDATE]`
	update:                 UpdateMode,
	/// `--debug`
	debug:                  bool,
	/// `-v`, `--verbose`
	verbose:                bool,
	/// `-g`, `--progress`
	progress_bar:           bool,
	/// `-Z`, `--context`: never copy the source's SELinux label.
	set_selinux_context:    bool,
	/// `mv` copying between filesystems: entries below a moved directory are
	/// reported as renamed, and the operands are left for `mv` to report once
	/// their sources are gone.
	move_mode:              bool,
}

/// Debug states of the offload and reflink actions.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
	not(any(target_os = "linux", target_os = "android")),
	allow(dead_code, reason = "only the Linux fast paths detect offloads")
)]
enum OffloadReflinkDebug {
	Unknown,
	No,
	Yes,
	Avoided,
	Unsupported,
}

/// Debug states of the sparse detection.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
	not(any(target_os = "linux", target_os = "android")),
	allow(dead_code, reason = "only the Linux fast paths detect holes")
)]
enum SparseDebug {
	No,
	Zeros,
	SeekHole,
	SeekHoleZeros,
	Unsupported,
}

/// How one file's data was copied, for `--debug`.
#[derive(Debug)]
struct CopyDebug {
	offload:          OffloadReflinkDebug,
	reflink:          OffloadReflinkDebug,
	sparse_detection: SparseDebug,
}

impl CopyDebug {
	/// A copy that streamed through read and write calls.
	const STREAMED: Self = Self {
		offload:          OffloadReflinkDebug::Unsupported,
		reflink:          OffloadReflinkDebug::Unsupported,
		sparse_detection: SparseDebug::Unsupported,
	};
	/// A copy-on-write clone: the files share their storage.
	const CLONED: Self = Self {
		offload:          OffloadReflinkDebug::Unknown,
		reflink:          OffloadReflinkDebug::Yes,
		sparse_detection: SparseDebug::Unsupported,
	};
}

impl fmt::Display for OffloadReflinkDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::No => "no",
			Self::Yes => "yes",
			Self::Avoided => "avoided",
			Self::Unsupported => "unsupported",
			Self::Unknown => "unknown",
		})
	}
}

impl fmt::Display for SparseDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::No => "no",
			Self::Zeros => "zeros",
			Self::SeekHole => "SEEK_HOLE",
			Self::SeekHoleZeros => "SEEK_HOLE + zeros",
			Self::Unsupported => "unsupported",
		})
	}
}

impl fmt::Display for CopyDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"copy offload: {}, reflink: {}, sparse detection: {}",
			self.offload, self.reflink, self.sparse_detection
		)
	}
}

// Argument constants
mod options {
	pub const ARCHIVE: &str = "archive";
	pub const ATTRIBUTES_ONLY: &str = "attributes-only";
	pub const CLI_SYMBOLIC_LINKS: &str = "cli-symbolic-links";
	pub const CLONE: &str = "c";
	pub const CONTEXT: &str = "context";
	pub const COPY_CONTENTS: &str = "copy-contents";
	pub const DEREFERENCE: &str = "dereference";
	pub const FORCE: &str = "force";
	pub const INTERACTIVE: &str = "interactive";
	pub const LINK: &str = "link";
	pub const NO_CLOBBER: &str = "no-clobber";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const NO_DEREFERENCE_PRESERVE_LINKS: &str = "no-dereference-preserve-links";
	pub const NO_PRESERVE: &str = "no-preserve";
	pub const NO_TARGET_DIRECTORY: &str = "no-target-directory";
	pub const ONE_FILE_SYSTEM: &str = "one-file-system";
	pub const PARENT: &str = "parent";
	pub const PARENTS: &str = "parents";
	pub const PATHS: &str = "paths";
	pub const PROGRESS_BAR: &str = "progress";
	pub const PRESERVE: &str = "preserve";
	pub const PRESERVE_DEFAULT_ATTRIBUTES: &str = "preserve-default-attributes";
	pub const RECURSIVE: &str = "recursive";
	pub const REFLINK: &str = "reflink";
	pub const REMOVE_DESTINATION: &str = "remove-destination";
	pub const SELINUX: &str = "Z";
	pub const SPARSE: &str = "sparse";
	pub const STRIP_TRAILING_SLASHES: &str = "strip-trailing-slashes";
	pub const SYMBOLIC_LINK: &str = "symbolic-link";
	pub const TARGET_DIRECTORY: &str = "target-directory";
	pub const DEBUG: &str = "debug";
	pub const VERBOSE: &str = "verbose";
}

#[cfg(unix)]
static PRESERVABLE_ATTRIBUTES: &[&str] =
	&["mode", "ownership", "timestamps", "context", "links", "xattr", "all"];

#[cfg(not(unix))]
static PRESERVABLE_ATTRIBUTES: &[&str] = &["mode", "timestamps", "context", "links", "xattr", "all"];

const PRESERVE_DEFAULT_VALUES: &str =
	if cfg!(unix) { "mode,ownership,timestamp" } else { "mode,timestamp" };

/// Chunk size of streamed copies.
const COPY_BUFFER: usize = 128 * 1024;

/// Progress bar over the bytes of the copied tree.
const PROGRESS_TEMPLATE: &str = "{msg}: [{elapsed_precise}] {wide_bar} {bytes:>7}/{total_bytes:7}";

/// Parsed `cp` invocation.
pub(crate) struct Cp {
	matches: ArgMatches,
}

matches_parser!(Cp, uu_app);

impl Utility for Cp {
	const NAME: &'static str = "cp";

	fn run(self, host: &mut Host) -> i32 {
		match cp_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(CpError::NotAllFilesCopied) => 1,
			Err(error) => {
				show_error(host, &error);
				1
			},
		}
	}
}

/// Writes `<utility>: <message>` to stderr, named after the running utility
/// because `mv` copies between filesystems through this engine too. Exit
/// status is decided by the caller: status 0 records nothing.
fn show_error(host: &mut Host, message: impl fmt::Display) {
	host.error(message, 0);
}

/// Writes `cp: warning: <message>` to stderr.
fn show_warning(host: &mut Host, message: impl fmt::Display) {
	let _ = writeln!(host.stderr, "{}: warning: {message}", Cp::NAME);
}

fn uu_app() -> Command {
	const MODE_ARGS: &[&str] = &[
		options::LINK,
		options::REFLINK,
		options::CLONE,
		options::SYMBOLIC_LINK,
		options::ATTRIBUTES_ONLY,
		options::COPY_CONTENTS,
	];
	Command::new("cp")
		.version("0.8.0")
		.about("Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.")
		.override_usage(format_usage(
			"cp [OPTION]... [-T] SOURCE DEST\ncp [OPTION]... SOURCE... DIRECTORY\ncp [OPTION]... -t \
			 DIRECTORY SOURCE...",
		))
		.after_help(format!(
			"{}\n\n{}",
			"Do not copy a non-directory that has an existing destination with the same or newer \
			 modification timestamp;\ninstead, silently skip the file without failing. If \
			 timestamps are being preserved, the comparison is to the\nsource timestamp truncated \
			 to the resolutions of the destination file system and of the system calls used \
			 to\nupdate timestamps; this avoids duplicate work if several cp -pu commands are \
			 executed with the same source\nand destination. This option is ignored if the -n or \
			 --no-clobber option is also specified. Also, if\n--preserve=links is also specified \
			 (like with cp -au for example), that will take precedence; consequently,\ndepending \
			 on the order that files are processed from the source, newer files in the \
			 destination may be replaced,\nto mirror hard links in the source. which gives more \
			 control over which existing files in the destination are\nreplaced, and its value \
			 can be one of the following:\n\n- all This is the default operation when an \
			 --update option is not specified, and results in all existing files in the \
			 destination being replaced.\n- none This is similar to the --no-clobber option, in \
			 that no files in the destination are replaced, but also skipping a file does not \
			 induce a failure.\n- older This is the default operation when --update is \
			 specified, and results in files being replaced if they're older than the \
			 corresponding source file.",
			backup_control::BACKUP_CONTROL_LONG_HELP
		))
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::TARGET_DIRECTORY)
				.short('t')
				.conflicts_with(options::NO_TARGET_DIRECTORY)
				.long(options::TARGET_DIRECTORY)
				.value_name(options::TARGET_DIRECTORY)
				.value_hint(clap::ValueHint::DirPath)
				.value_parser(ValueParser::path_buf())
				.help("copy all SOURCE arguments into target-directory"),
		)
		.arg(
			Arg::new(options::NO_TARGET_DIRECTORY)
				.short('T')
				.long(options::NO_TARGET_DIRECTORY)
				.conflicts_with(options::TARGET_DIRECTORY)
				.help("Treat DEST as a regular file and not a directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::INTERACTIVE)
				.short('i')
				.long(options::INTERACTIVE)
				.overrides_with(options::NO_CLOBBER)
				.help("ask before overwriting files")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::LINK)
				.short('l')
				.long(options::LINK)
				.overrides_with_all(MODE_ARGS)
				.help("hard-link files instead of copying")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CLOBBER)
				.short('n')
				.long(options::NO_CLOBBER)
				.overrides_with(options::INTERACTIVE)
				.help("don't overwrite a file that already exists")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RECURSIVE)
				.short('R')
				.visible_short_alias('r')
				.long(options::RECURSIVE)
				// --archive sets this option
				.help("copy directories recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::STRIP_TRAILING_SLASHES)
				.long(options::STRIP_TRAILING_SLASHES)
				.help("remove any trailing slashes from each SOURCE argument")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEBUG)
				.long(options::DEBUG)
				.help("explain how a file is copied. Implies -v")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("explicitly state what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SYMBOLIC_LINK)
				.short('s')
				.long(options::SYMBOLIC_LINK)
				.overrides_with_all(MODE_ARGS)
				.help("make symbolic links instead of copying")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.long(options::FORCE)
				.help(
					"if an existing destination file cannot be opened, remove it and try again (this \
					 option is ignored when the -n option is also used).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REMOVE_DESTINATION)
				.long(options::REMOVE_DESTINATION)
				.overrides_with(options::FORCE)
				.help(
					"remove each existing destination file before attempting to open it (contrast \
					 with --force).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(options::REFLINK)
				.long(options::REFLINK)
				.value_name("WHEN")
				.overrides_with_all(MODE_ARGS)
				.require_equals(true)
				.default_missing_value("always")
				.value_parser(ShortcutValueParser::new(["auto", "always", "never"]))
				.num_args(0..=1)
				.help("control clone/CoW copies. See below"),
		)
		.arg(
			// macOS cp's spelling, which falls back to a copy like `auto`.
			Arg::new(options::CLONE)
				.short('c')
				.overrides_with_all(MODE_ARGS)
				.help("clone files where the filesystem allows, else copy; same as --reflink=auto")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ATTRIBUTES_ONLY)
				.long(options::ATTRIBUTES_ONLY)
				.overrides_with_all(MODE_ARGS)
				.help("Don't copy the file data, just the attributes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESERVE)
				.long(options::PRESERVE)
				.action(ArgAction::Append)
				.use_value_delimiter(true)
				.value_parser(ShortcutValueParser::new(PRESERVABLE_ATTRIBUTES))
				.num_args(0..)
				.require_equals(true)
				.value_name("ATTR_LIST")
				.default_missing_value(PRESERVE_DEFAULT_VALUES)
				// -d sets this option
				// --archive sets this option
				.help(
					"Preserve the specified attributes (default: mode, ownership (unix only), \
					 timestamps), if possible additional attributes: context, links, xattr, all",
				),
		)
		.arg(
			Arg::new(options::PRESERVE_DEFAULT_ATTRIBUTES)
				.short('p')
				.long(options::PRESERVE_DEFAULT_ATTRIBUTES)
				.help("same as --preserve=mode,ownership(unix only),timestamps")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_PRESERVE)
				.long(options::NO_PRESERVE)
				.action(ArgAction::Append)
				.use_value_delimiter(true)
				.value_parser(ShortcutValueParser::new(PRESERVABLE_ATTRIBUTES))
				.num_args(0..)
				.require_equals(true)
				.value_name("ATTR_LIST")
				.help("don't preserve the specified attributes"),
		)
		.arg(
			Arg::new(options::PARENTS)
				.long(options::PARENTS)
				.alias(options::PARENT)
				.help("use full source file name under DIRECTORY")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('P')
				.long(options::NO_DEREFERENCE)
				.overrides_with_all([
					options::DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				// -d sets this option
				.help("never follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEREFERENCE)
				.short('L')
				.long(options::DEREFERENCE)
				.overrides_with_all([
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("always follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CLI_SYMBOLIC_LINKS)
				.short('H')
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("follow command-line symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ARCHIVE)
				.short('a')
				.long(options::ARCHIVE)
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("Same as -dR --preserve=all")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE_PRESERVE_LINKS)
				.short('d')
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
				])
				.help("same as --no-dereference --preserve=links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ONE_FILE_SYSTEM)
				.short('x')
				.long(options::ONE_FILE_SYSTEM)
				.help("stay on this file system")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SPARSE)
				.long(options::SPARSE)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new(["never", "auto", "always"]))
				.help("control creation of sparse files. See below"),
		)
		.arg(
			Arg::new(options::SELINUX)
				.short('Z')
				.help("set SELinux security context of destination file to default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.long(options::CONTEXT)
				.value_name("CTX")
				.value_parser(value_parser!(String))
				.help(
					"like -Z, or if CTX is specified then set the SELinux or SMACK security context \
					 to CTX",
				)
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(""),
		)
		.arg(
			// The 'g' short flag is modeled after advcpmv
			// See this repo: https://github.com/jarun/advcpmv
			Arg::new(options::PROGRESS_BAR)
				.long(options::PROGRESS_BAR)
				.short('g')
				.action(ArgAction::SetTrue)
				.help("Display a progress bar. Note: this feature is not supported by GNU coreutils."),
		)
		.arg(
			Arg::new(options::COPY_CONTENTS)
				.long(options::COPY_CONTENTS)
				.overrides_with(options::ATTRIBUTES_ONLY)
				.help("copy contents of special files when recursive")
				.action(ArgAction::SetTrue),
		)
		.arg(
			// Optional so a missing operand gets GNU's diagnostic, not clap's.
			Arg::new(options::PATHS)
				.action(ArgAction::Append)
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(ValueParser::os_string()),
		)
}

fn cp_main(matches: &ArgMatches, host: &mut Host) -> CopyResult<()> {
	let options = Options::from_matches(matches, host)?;

	if options.overwrite == OverwriteMode::NoClobber && options.backup != BackupMode::None {
		return Err(CpError::Usage(
			"--backup is mutually exclusive with -n or --update=none-fail".to_string(),
		));
	}

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(options::PATHS)
		.map_or_default(|values| values.map(PathBuf::from).collect());

	let (sources, target) = parse_path_args(paths, &options)?;
	if let Some(dir) = &options.target_dir {
		check_target_directory(host, dir)?;
	}

	copy(host, &sources, &target, &options)
}

impl ClobberMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::FORCE) {
			Self::Force
		} else if matches.get_flag(options::REMOVE_DESTINATION) {
			Self::RemoveDestination
		} else {
			Self::Standard
		}
	}
}

impl OverwriteMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::INTERACTIVE) {
			Self::Interactive(ClobberMode::from_matches(matches))
		} else if matches.get_flag(options::NO_CLOBBER) {
			Self::NoClobber
		} else {
			Self::Clobber(ClobberMode::from_matches(matches))
		}
	}
}

impl CopyMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::LINK) {
			Self::Link
		} else if matches.get_flag(options::SYMBOLIC_LINK) {
			Self::SymLink
		} else if matches
			.get_one::<String>(update_control::arguments::OPT_UPDATE)
			.is_some()
			|| matches.get_flag(update_control::arguments::OPT_UPDATE_NO_ARG)
		{
			Self::Update
		} else if matches.get_flag(options::ATTRIBUTES_ONLY) {
			if matches.get_flag(options::REMOVE_DESTINATION) { Self::Copy } else { Self::AttrOnly }
		} else {
			Self::Copy
		}
	}
}

impl Attributes {
	/// `--preserve=all` / `-a`. Without SELinux support there is no context
	/// to preserve.
	const ALL: Self = Self {
		ownership:  Preserve::Yes { required: true },
		mode:       Preserve::Yes { required: true },
		timestamps: Preserve::Yes { required: true },
		context:    Preserve::No { explicit: false },
		links:      Preserve::Yes { required: true },
		xattr:      Preserve::Yes { required: false },
	};
	/// `-p`: GNU's `--preserve=mode,ownership,timestamps`.
	const DEFAULT: Self = Self {
		ownership: Preserve::Yes { required: true },
		mode: Preserve::Yes { required: true },
		timestamps: Preserve::Yes { required: true },
		..Self::NONE
	};
	/// `-d`.
	const LINKS: Self = Self { links: Preserve::Yes { required: true }, ..Self::NONE };
	/// What GNU mv carries over when it copies between filesystems: all of
	/// `-a`, but failing to preserve an attribute does not fail the move.
	const MOVE: Self = Self {
		ownership:  Preserve::Yes { required: false },
		mode:       Preserve::Yes { required: false },
		timestamps: Preserve::Yes { required: false },
		context:    Preserve::No { explicit: false },
		links:      Preserve::Yes { required: false },
		xattr:      Preserve::Yes { required: false },
	};
	/// Nothing preserved.
	const NONE: Self = Self {
		ownership:  Preserve::No { explicit: false },
		mode:       Preserve::No { explicit: false },
		timestamps: Preserve::No { explicit: false },
		context:    Preserve::No { explicit: false },
		links:      Preserve::No { explicit: false },
		xattr:      Preserve::No { explicit: false },
	};

	fn union(self, other: &Self) -> Self {
		Self {
			ownership:  self.ownership.max(other.ownership),
			context:    self.context.max(other.context),
			timestamps: self.timestamps.max(other.timestamps),
			mode:       self.mode.max(other.mode),
			links:      self.links.max(other.links),
			xattr:      self.xattr.max(other.xattr),
		}
	}

	/// Set the field to `Preserve::No { explicit: true }` if the corresponding
	/// field in other is set to `Preserve::Yes { .. }`.
	fn diff(self, other: &Self) -> Self {
		fn update_preserve_field(current: Preserve, other: Preserve) -> Preserve {
			if matches!(other, Preserve::Yes { .. }) { Preserve::No { explicit: true } } else { current }
		}
		Self {
			ownership:  update_preserve_field(self.ownership, other.ownership),
			mode:       update_preserve_field(self.mode, other.mode),
			timestamps: update_preserve_field(self.timestamps, other.timestamps),
			context:    update_preserve_field(self.context, other.context),
			links:      update_preserve_field(self.links, other.links),
			xattr:      update_preserve_field(self.xattr, other.xattr),
		}
	}

	fn parse_iter<T: AsRef<str>>(values: impl Iterator<Item = T>) -> CopyResult<Self> {
		let mut new = Self::NONE;
		for value in values {
			new = new.union(&Self::parse_single_string(value.as_ref())?);
		}
		Ok(new)
	}

	/// Tries to match string containing a parameter to preserve with the
	/// corresponding entry in the Attributes struct.
	fn parse_single_string(value: &str) -> CopyResult<Self> {
		let value = value.to_lowercase();

		if value == "all" {
			return Ok(Self::ALL);
		}

		let mut new = Self::NONE;
		let attribute = match value.as_ref() {
			"mode" => &mut new.mode,
			"ownership" => &mut new.ownership,
			"timestamps" => &mut new.timestamps,
			"context" => &mut new.context,
			"link" | "links" => &mut new.links,
			"xattr" => &mut new.xattr,
			_ => {
				return Err(CpError::Usage(format!("invalid attribute {}", value.quote())));
			},
		};

		*attribute = Preserve::Yes { required: true };

		Ok(new)
	}
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &mut Host) -> CopyResult<Self> {
		let recursive = matches.get_flag(options::RECURSIVE) || matches.get_flag(options::ARCHIVE);

		let backup_mode = determine_backup_mode(matches, host).map_err(CpError::Usage)?;
		let update_mode = update_control::determine_update_mode(matches);

		if backup_mode != BackupMode::None
			&& matches
				.get_one::<String>(update_control::arguments::OPT_UPDATE)
				.is_some_and(|v| v == "none" || v == "none-fail")
		{
			return Err(CpError::Usage(
				"--backup is mutually exclusive with -n or --update=none-fail".to_string(),
			));
		}

		let backup_suffix = determine_backup_suffix(matches, host);

		let overwrite = OverwriteMode::from_matches(matches);

		let no_target_dir = matches.get_flag(options::NO_TARGET_DIRECTORY);
		let target_dir = matches
			.get_one::<PathBuf>(options::TARGET_DIRECTORY)
			.cloned();

		// cp follows POSIX conventions for overriding options such as "-a",
		// "-d", "--preserve", and "--no-preserve". clap removes an overridden
		// argument from the matches entirely, but "-a" expands to "-dR
		// --preserve=all" and only the "--preserve=all" part must be
		// overridden; flags may also repeat. So rebuild the command-line order
		// of these options and apply them in sequence.
		let mut overriding_order: Vec<(usize, &str, Vec<&String>)> = vec![];
		for option in [
			options::PRESERVE,
			options::NO_PRESERVE,
			options::ARCHIVE,
			options::PRESERVE_DEFAULT_ATTRIBUTES,
			options::NO_DEREFERENCE_PRESERVE_LINKS,
		] {
			if let (Ok(Some(val)), Some(index)) = (
				matches.try_get_one::<bool>(option),
				// For a flag, `index_of` is the last index it appeared at (it
				// overrides itself), which is all that matters for a flag.
				matches.index_of(option),
			) {
				if *val {
					overriding_order.push((index, option, vec![]));
				}
			} else if let (Some(occurrences), Some(mut indices)) =
				(matches.get_occurrences::<String>(option), matches.indices_of(option))
			{
				occurrences.for_each(|val| {
					if let Some(index) = indices.next() {
						let val = val.collect::<Vec<&String>>();
						// `indices_of` yields one index per value; skip to the
						// first value of the next occurrence.
						for _ in 1..val.len() {
							indices.next();
						}
						overriding_order.push((index, option, val));
					}
				});
			}
		}
		overriding_order.sort_by_key(|a| a.0);

		let mut attributes = Attributes::NONE;

		for (_, option, val) in overriding_order {
			match option {
				options::ARCHIVE => {
					attributes = Attributes::ALL;
				},
				options::PRESERVE_DEFAULT_ATTRIBUTES => {
					attributes = attributes.union(&Attributes::DEFAULT);
				},
				options::NO_DEREFERENCE_PRESERVE_LINKS => {
					attributes = attributes.union(&Attributes::LINKS);
				},
				options::PRESERVE => {
					attributes = attributes.union(&Attributes::parse_iter(val.into_iter())?);
				},
				options::NO_PRESERVE => {
					if !val.is_empty() {
						attributes = attributes.diff(&Attributes::parse_iter(val.into_iter())?);
					}
				},
				_ => (),
			}
		}

		// No SELinux support: an explicit request to preserve a security
		// context cannot be honored.
		if let Preserve::Yes { required } = attributes.context {
			if required {
				return Err(CpError::Error(
					"cannot preserve security context without an SELinux-enabled kernel".to_string(),
				));
			}
			attributes.context = Preserve::No { explicit: false };
		}

		let set_selinux_context = matches.get_flag(options::SELINUX);
		let context = matches.get_one::<String>(options::CONTEXT);
		if context.is_some_and(|context| !context.is_empty()) {
			show_warning(host, "ignoring --context; it requires an SELinux-enabled kernel");
		}

		let copy_mode = CopyMode::from_matches(matches);

		let reflink = if matches.get_flag(options::CLONE) {
			Some("auto")
		} else {
			matches.get_one::<String>(options::REFLINK).map(String::as_str)
		};
		let reflink_mode = match reflink {
			Some("always") => ReflinkMode::Always,
			Some("auto") => ReflinkMode::Auto,
			Some("never") => ReflinkMode::Never,
			Some(value) => {
				return Err(CpError::Usage(format!(
					"invalid argument {} for '--reflink'",
					value.quote()
				)));
			},
			None => ReflinkMode::default(),
		};
		let sparse_mode = match matches.get_one::<String>(options::SPARSE).map(String::as_str) {
			Some("always") => SparseMode::Always,
			Some("auto") | None => SparseMode::Auto,
			Some("never") => SparseMode::Never,
			Some(value) => {
				return Err(CpError::Usage(format!(
					"invalid argument {} for '--sparse'",
					value.quote()
				)));
			},
		};
		if reflink_mode == ReflinkMode::Always && sparse_mode != SparseMode::Auto {
			return Err(CpError::Usage("--reflink can be used only with --sparse=auto".to_string()));
		}

		Ok(Self {
			attributes_only: matches.get_flag(options::ATTRIBUTES_ONLY),
			copy_contents: matches.get_flag(options::COPY_CONTENTS),
			cli_dereference: matches.get_flag(options::CLI_SYMBOLIC_LINKS),
			copy_mode,
			// No dereference is set with -P, -d and --archive
			dereference: !(matches.get_flag(options::NO_DEREFERENCE)
				|| matches.get_flag(options::NO_DEREFERENCE_PRESERVE_LINKS)
				|| matches.get_flag(options::ARCHIVE)
				// cp normally follows the link only when not copying recursively or when
				// --link (-l) is used
				|| (recursive && copy_mode != CopyMode::Link))
				|| matches.get_flag(options::DEREFERENCE),
			one_file_system: matches.get_flag(options::ONE_FILE_SYSTEM),
			parents: matches.get_flag(options::PARENTS),
			update: update_mode,
			debug: matches.get_flag(options::DEBUG),
			verbose: matches.get_flag(options::VERBOSE) || matches.get_flag(options::DEBUG),
			strip_trailing_slashes: matches.get_flag(options::STRIP_TRAILING_SLASHES),
			reflink_mode,
			sparse_mode,
			backup: backup_mode,
			backup_suffix,
			overwrite,
			no_target_dir,
			attributes,
			recursive,
			target_dir,
			progress_bar: matches.get_flag(options::PROGRESS_BAR),
			set_selinux_context: set_selinux_context || context.is_some(),
			move_mode: false,
		})
	}

	fn dereference(&self, in_command_line: bool) -> bool {
		self.dereference || (in_command_line && self.cli_dereference)
	}

	fn preserve_hard_links(&self) -> bool {
		matches!(self.attributes.links, Preserve::Yes { .. })
	}

	/// `(preserve mode, mode explicitly not preserved)`.
	fn preserve_mode(&self) -> (bool, bool) {
		match self.attributes.mode {
			Preserve::No { explicit } => (false, explicit),
			Preserve::Yes { .. } => (true, false),
		}
	}

	/// Whether to force overwriting the destination file.
	fn force(&self) -> bool {
		matches!(self.overwrite, OverwriteMode::Clobber(ClobberMode::Force))
	}

	/// Whether each existing destination is removed before it is opened.
	fn remove_destination(&self) -> bool {
		matches!(self.overwrite, OverwriteMode::Clobber(ClobberMode::RemoveDestination))
	}

	/// `-f`: whether a destination that cannot be opened is removed and
	/// opened again.
	fn unlink_after_failed_open(&self) -> bool {
		matches!(
			self.overwrite,
			OverwriteMode::Clobber(ClobberMode::Force) | OverwriteMode::Interactive(ClobberMode::Force)
		)
	}
}

/// Bookkeeping shared by every copy of one `cp` invocation, or of one `mv`
/// invocation's moves between filesystems. Paths are kept in their operand
/// spelling.
#[derive(Default)]
struct CopyState {
	/// Identities of the symlinks this invocation created.
	symlinked_files:     FxHashSet<FileId>,
	/// Destinations of the operands copied so far.
	copied_destinations: FxHashSet<PathBuf>,
	/// Source identity to its first destination, for `--preserve=links`.
	copied_files:        FxHashMap<FileId, PathBuf>,
	/// `-g` progress over the total source size.
	progress_bar:        Option<ProgressBar>,
	/// Source devices whose filesystem refused to clone: later files from
	/// them skip straight to copying the data.
	#[cfg(any(target_os = "linux", target_os = "android", windows))]
	clone_unsupported:   FxHashSet<u64>,
}

impl CopyState {
	/// Prints a line on stdout, keeping it clear of the progress bar.
	fn say(&self, host: &mut Host, line: impl fmt::Display) {
		match &self.progress_bar {
			Some(bar) => bar.suspend(|| {
				let _ = writeln!(host.stdout, "{line}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{line}");
			},
		}
	}
}

/// The copying half of `mv`'s moves between filesystems, which GNU builds on
/// cp's `copy()` too: `cp -a` on one entry whose destination is already
/// gone, without failing the move over an attribute it cannot preserve.
/// Hard links are remembered across every operand of one `mv`, so the later
/// names of a moved file become links to its copy.
pub(crate) struct MoveCopier {
	options: Options,
	state:   CopyState,
}

impl MoveCopier {
	/// `verbose` reports each entry below a moved directory as renamed.
	pub(crate) fn new(verbose: bool) -> Self {
		Self {
			options: Options {
				attributes_only: false,
				backup: BackupMode::None,
				copy_contents: false,
				cli_dereference: false,
				copy_mode: CopyMode::Copy,
				dereference: false,
				no_target_dir: true,
				one_file_system: false,
				overwrite: OverwriteMode::Clobber(ClobberMode::Standard),
				parents: false,
				sparse_mode: SparseMode::Auto,
				strip_trailing_slashes: false,
				reflink_mode: ReflinkMode::Auto,
				attributes: Attributes::MOVE,
				recursive: true,
				backup_suffix: String::new(),
				target_dir: None,
				update: UpdateMode::All,
				debug: false,
				verbose,
				progress_bar: false,
				set_selinux_context: false,
				move_mode: true,
			},
			state:   CopyState::default(),
		}
	}

	/// Copies `source`, whose lstat is `metadata`, to the vacant `dest`. The
	/// failures of entries below a directory are reported as they happen and
	/// the copy goes on, as GNU's does; the result is then
	/// [`CpError::NotAllFilesCopied`]. Under `display_manager` a directory's
	/// copy shows its progress.
	pub(crate) fn copy(
		&mut self,
		host: &mut Host,
		source: &Path,
		dest: &Path,
		metadata: Metadata,
		display_manager: Option<&MultiProgress>,
	) -> Result<(), CpError> {
		if !metadata.is_dir() {
			return copy_file(host, &mut self.state, source, dest, &self.options, true, Some(metadata));
		}

		self.state.progress_bar = display_manager.map(|display_manager| {
			let total = disk_usage_directory(host, &host.resolve(source));
			let style = ProgressStyle::with_template(PROGRESS_TEMPLATE).expect("valid progress template");
			display_manager
				.add(ProgressBar::new(total).with_style(style))
				.with_message(source.to_string_lossy().into_owned())
		});
		let mut walk =
			Walk { options: &self.options, root_dev: None, ancestors: Vec::new(), failed: false };
		let copied = copy_entry(host, &mut self.state, &mut walk, source, dest, true);
		self.state.progress_bar = None;
		copied?;
		if walk.failed { Err(CpError::NotAllFilesCopied) } else { Ok(()) }
	}
}

impl TargetType {
	/// Treat target as a dir if we have multiple sources or the target
	/// exists and already is a directory
	fn determine(host: &Host, sources: &[PathBuf], target: &Path) -> Self {
		if sources.len() > 1 || host.fs().is_dir(host.resolve(target)) {
			Self::Directory
		} else {
			Self::File
		}
	}
}

/// Returns tuple of (Source paths, Target)
fn parse_path_args(mut paths: Vec<PathBuf>, options: &Options) -> CopyResult<(Vec<PathBuf>, PathBuf)> {
	if paths.is_empty() {
		return Err(CpError::Usage("missing file operand".to_string()));
	} else if paths.len() == 1 && options.target_dir.is_none() {
		return Err(CpError::Usage(format!(
			"missing destination file operand after {}",
			paths[0].quote()
		)));
	}

	// Return an error if the user requested to copy more than one
	// file source to a file target
	if options.no_target_dir && options.target_dir.is_none() && paths.len() > 2 {
		return Err(CpError::Usage(format!("extra operand {}", paths[2].quote())));
	}

	let target = match &options.target_dir {
		Some(target) => target.clone(),
		None => paths.pop().expect("at least two operands"),
	};

	Ok((paths, target))
}

/// `--strip-trailing-slashes`: `sources` without their trailing slashes.
fn strip_trailing_slashes(sources: &[PathBuf]) -> Vec<PathBuf> {
	sources
		.iter()
		.map(|source| {
			// A virtual root keeps the `//` of its `scheme://` spelling.
			if is_virtual_path(source) && parent_path(source).is_none() {
				source.clone()
			} else {
				source.components().as_path().to_owned()
			}
		})
		.collect()
}

/// Validates the `-t` directory the way GNU does.
fn check_target_directory(host: &Host, dir: &Path) -> CopyResult<()> {
	match host.fs().metadata(host.resolve(dir)) {
		Ok(metadata) if metadata.is_dir() => Ok(()),
		Ok(_) => Err(CpError::IoErrContext(
			pi_vfs::not_a_directory(),
			format!("target directory {}", dir.quote()),
		)),
		Err(error) => Err(CpError::IoErrContext(error, format!("target directory {}", dir.quote()))),
	}
}

/// Whether `error` means the filesystem cannot store the attribute at all.
fn is_enotsup_error(error: &CpError) -> bool {
	match error {
		CpError::IoErr(e) | CpError::IoErrContext(e, _) => {
			if e.kind() == io::ErrorKind::Unsupported {
				return true;
			}
			#[cfg(unix)]
			{
				matches!(e.raw_os_error(), Some(code) if code == libc::EOPNOTSUPP || code == libc::ENOTSUP)
			}
			#[cfg(not(unix))]
			{
				false
			}
		},
		_ => false,
	}
}

/// Prints `error` unless it is a silent skip or an already-reported summary.
fn show_error_if_needed(host: &mut Host, error: &CpError) {
	match error {
		CpError::NotAllFilesCopied | CpError::Skipped(_) => {},
		_ => show_error(host, error),
	}
}

/// Copy all `sources` to `target`.
///
/// Returns an `Err(Error::NotAllFilesCopied)` if at least one non-fatal error
/// was encountered.
fn copy(host: &mut Host, sources: &[PathBuf], target: &Path, options: &Options) -> CopyResult<()> {
	let target_type = TargetType::determine(host, sources, target);
	verify_target_type(host, target, target_type)?;
	// Like GNU, only sources copied into a directory are stripped.
	let stripped;
	let sources = if options.strip_trailing_slashes && matches!(target_type, TargetType::Directory) {
		stripped = strip_trailing_slashes(sources);
		&stripped
	} else {
		sources
	};
	if options.parents && !host.fs().is_dir(host.resolve(target)) {
		return Err(CpError::Usage("with --parents, the destination must be a directory".to_string()));
	}

	let mut non_fatal_errors = false;
	let mut seen_sources = FxHashSet::default();
	let mut state = CopyState::default();

	if options.progress_bar
		&& let Some(draw_target) = stderr_draw_target(host)
	{
		let total = disk_usage(host, sources, options.recursive);
		let bar = ProgressBar::with_draw_target(Some(total), draw_target)
			.with_style(ProgressStyle::with_template(PROGRESS_TEMPLATE).expect("valid progress template"))
			.with_message("cp");
		bar.tick();
		state.progress_bar = Some(bar);
	}

	for source in sources {
		if host.is_cancelled() {
			non_fatal_errors = true;
			break;
		}
		let normalized_source = normalize_lexically(source);
		if options.backup == BackupMode::None && seen_sources.contains(&normalized_source) {
			let file_type = if host
				.fs()
				.symlink_metadata(host.resolve(source))
				.is_ok_and(|metadata| metadata.is_dir())
			{
				"directory"
			} else {
				"file"
			};
			show_warning(host, format_args!("source {file_type} {} specified more than once", source.quote()));
		} else if let Err(error) = copy_operand(host, &mut state, source, target, target_type, options) {
			show_error_if_needed(host, &error);
			if !matches!(error, CpError::Skipped(false)) {
				non_fatal_errors = true;
			}
		}
		seen_sources.insert(normalized_source);
	}

	if let Some(bar) = &state.progress_bar {
		bar.finish();
	}

	if non_fatal_errors { Err(CpError::NotAllFilesCopied) } else { Ok(()) }
}

/// Copies one command-line operand, refusing to overwrite a destination this
/// invocation already produced.
fn copy_operand(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	target: &Path,
	target_type: TargetType,
	options: &Options,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest = construct_dest_path(host, source, target, target_type, options);
	let dest_fs = host.resolve(&dest);
	let source_fs = host.resolve(source);

	if (filesystem.metadata(&dest_fs).is_ok() && !filesystem.is_symlink(&dest_fs))
		// if both `source` and `dest` are symlinks, it should be considered as an overwrite.
		|| (filesystem.metadata(&source_fs).is_ok() && filesystem.is_symlink(&source_fs))
		|| options.copy_mode == CopyMode::SymLink
	{
		// Directories merge (GNU cp behavior); anything else must not replace a
		// destination this invocation just created.
		if state.copied_destinations.contains(&dest)
			&& options.backup != BackupMode::Numbered
			&& !(filesystem.is_dir(&dest_fs) && filesystem.is_dir(&source_fs))
		{
			return Err(CpError::Error(format!(
				"will not overwrite just-created {} with {}",
				dest.quote(),
				source.quote()
			)));
		}
	}

	copy_source(host, state, source, target, &dest, options)?;
	state.copied_destinations.insert(dest);
	Ok(())
}

/// `source` below its root, for `--parents`: `/a/b` is `a/b`, and a URL
/// `scheme://a/b` is `a/b` with its segments decoded.
fn parents_relative(source: &Path) -> PathBuf {
	if let Some(scheme) = url_scheme(source) {
		// The `scheme://` root is ASCII, so a lossy spelling keeps its length.
		let spelled = source.as_os_str().to_string_lossy();
		let rest = &spelled[scheme.len() + "://".len()..];
		let mut relative = PathBuf::new();
		for segment in rest.split('/').filter(|segment| !segment.is_empty()) {
			relative.push(decode_segment(std::ffi::OsStr::new(segment)));
		}
		relative
	} else if cfg!(unix) && source.has_root() {
		source.strip_prefix("/").unwrap_or(source).to_path_buf()
	} else {
		source.to_path_buf()
	}
}

fn construct_dest_path(
	host: &Host,
	source: &Path,
	target: &Path,
	target_type: TargetType,
	options: &Options,
) -> PathBuf {
	// `-T`: the target is the destination, a directory there too; a
	// non-directory over it is refused by `copy_file` once -n, -i and -u let
	// the copy go on, as GNU refuses it.
	if options.no_target_dir {
		return target.to_path_buf();
	}
	match target_type {
		TargetType::Directory => {
			if options.parents {
				join_path(target, &parents_relative(source))
			} else if source == "." && host.fs().is_dir(host.resolve(target)) {
				// Copying `.` into an existing directory copies its contents.
				target.to_path_buf()
			} else {
				match file_name(source) {
					Some(name) => child_path(target, &name),
					None => target.to_path_buf(),
				}
			}
		},
		TargetType::File => target.to_path_buf(),
	}
}

/// Copies `source` into `target`: a directory recursively, anything else as
/// a file to `dest` (from [`construct_dest_path`]).
fn copy_source(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	target: &Path,
	dest: &Path,
	options: &Options,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	if filesystem.is_dir(&source_fs)
		&& (options.dereference(true) || !filesystem.is_symlink(&source_fs))
	{
		return copy_directory(host, state, source, target, options);
	}

	if options.parents {
		make_parent_dirs(host, state, source, dest, options)?;
	}
	let result = copy_file(host, state, source, dest, options, true, None);
	if options.parents {
		for (x, y) in aligned_ancestors(source, dest) {
			if let Ok(src) = filesystem.canonicalize_with(
				host.resolve(&x),
				&CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Physical),
			) {
				copy_attributes(
					host,
					&src,
					&y,
					&options.attributes,
					false,
					true,
					options.set_selinux_context,
					None,
					DestFacts::default(),
				)?;
			}
		}
	}
	result
}

/// Reads one answer from stdin one byte at a time (no buffering, so
/// consecutive prompts don't over-read). True when the line starts with `y`.
fn read_yes(host: &mut Host) -> bool {
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut buf) {
			Ok(0) => break,
			Ok(_) => {
				if buf[0] == b'\n' {
					break;
				}
				if first.is_none() {
					first = Some(buf[0]);
				}
			},
			Err(_) => return false,
		}
	}
	matches!(first, Some(b'y' | b'Y'))
}

/// The `-i` question for `path`, naming the mode of an unwritable file as
/// GNU does.
fn interactive_prompt(host: &Host, path: &Path, clobber: ClobberMode) -> String {
	#[cfg(unix)]
	{
		let filesystem = host.fs();
		let resolved = host.resolve(path);
		if !filesystem.is_symlink(&resolved)
			&& filesystem.access(&resolved, false, true, false).is_err()
			&& let Ok(metadata) = filesystem.metadata(&resolved)
		{
			let mode = metadata.mode() & 0o7777;
			let permissions = uucore::fs::display_permissions_unix(mode, false);
			return if clobber == ClobberMode::Standard {
				format!("unwritable {} (mode {mode:04o}, {permissions}); try anyway?", path.quote())
			} else {
				format!("replace {}, overriding mode {mode:04o} ({permissions})?", path.quote())
			};
		}
	}
	#[cfg(not(unix))]
	let _ = (host, clobber);
	format!("overwrite {}?", path.quote())
}

impl OverwriteMode {
	fn verify(self, host: &mut Host, path: &Path, debug: bool) -> CopyResult<()> {
		match self {
			Self::NoClobber => {
				if debug {
					let _ = writeln!(host.stdout, "skipped {}", path.quote());
				}
				Err(CpError::Skipped(false))
			},
			Self::Interactive(clobber) => {
				let prompt = interactive_prompt(host, path, clobber);
				let _ = write!(host.stderr, "{}: {prompt} ", Cp::NAME);
				let _ = host.stderr.flush();
				read_yes(host).ok_or(CpError::Skipped(true))
			},
			Self::Clobber(_) => Ok(()),
		}
	}
}

/// Handles errors for attributes preservation. If the attribute is not
/// required, and errored, tries to show error (see `show_error_if_needed`
/// for additional behavior details). If it's required, then the error is
/// thrown.
///
/// ENOTSUP errors are silently ignored when not required, as per GNU cp:
/// "Try to preserve SELinux security context and extended attributes
/// (xattr), but ignore any failure to do that and print no corresponding
/// diagnostic."
fn handle_preserve(
	host: &mut Host,
	preserve: Preserve,
	f: impl FnOnce() -> CopyResult<()>,
) -> CopyResult<()> {
	match preserve {
		Preserve::No { .. } => {},
		Preserve::Yes { required } => {
			let result = f();
			if required {
				result?;
			} else if let Err(error) = &result
				&& !is_enotsup_error(error)
			{
				show_error_if_needed(host, error);
			}
		},
	}
	Ok(())
}

/// Applies a metadata change to `path`, retrying on an open handle when the
/// provider only implements the change for handles.
fn preserve_via(
	filesystem: &BlockingFs,
	path: &Path,
	by_path: impl FnOnce(&BlockingFs, &Path) -> io::Result<()>,
	by_handle: impl FnOnce(&File) -> io::Result<()>,
) -> io::Result<()> {
	match by_path(filesystem, path) {
		Err(error) if error.kind() == io::ErrorKind::Unsupported => {
			let file = filesystem.open_with(path, OpenOptions::new().write(true))?;
			let applied = by_handle(&file);
			let closed = file.close();
			applied.and(closed)
		},
		result => result,
	}
}

/// Copies extended attributes (xattrs) from `source` to `dest`, making a
/// read-only `dest` temporarily user-writable so the attributes can be set.
/// A source without any leaves `dest` untouched.
fn copy_extended_attrs(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	follow_source: bool,
	skip_selinux: bool,
) -> io::Result<()> {
	let mut names = filesystem.list_xattr(source, follow_source)?;
	// With -Z the destination gets the default context instead.
	if skip_selinux {
		names.retain(|name| name != "security.selinux");
	}
	if names.is_empty() {
		return Ok(());
	}

	let metadata = filesystem.symlink_metadata(dest)?;

	let mut permissions = metadata.permissions();
	let was_readonly = !metadata.is_symlink() && permissions.readonly();
	if was_readonly {
		permissions.set_readonly(false);
		filesystem.set_permissions(dest, permissions)?;
	}

	let copied = names.iter().try_for_each(|name| {
		match filesystem.get_xattr(source, name, follow_source)? {
			Some(value) => filesystem.set_xattr(dest, name, &value, false),
			None => Ok(()),
		}
	});

	if was_readonly {
		let mut permissions = filesystem.symlink_metadata(dest)?.permissions();
		permissions.set_readonly(true);
		filesystem.set_permissions(dest, permissions)?;
	}

	copied
}

/// Copy the specified attributes from one path to another. `follow_source`
/// reads the attributes of the file a symlinked `source` points to;
/// `source_metadata`, when the caller already holds it, must have been read
/// the same way. `dest_facts` is what the caller knows of `dest`: no need to
/// look again, or to change what already matches.
#[allow(clippy::too_many_arguments, reason = "mirrors the call sites' copy state")]
fn copy_attributes(
	host: &mut Host,
	source: &Path,
	dest: &Path,
	attributes: &Attributes,
	dest_is_freshly_created_dir: bool,
	follow_source: bool,
	skip_selinux_xattr: bool,
	source_metadata: Option<&Metadata>,
	dest_facts: DestFacts,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	// A link the copy wrote through: its attributes go to the file it leads
	// to, as GNU sets them on the descriptor it wrote.
	let resolved = host.resolve(dest);
	let dest_fs = if dest_facts.through {
		filesystem.canonicalize(&resolved).unwrap_or(resolved)
	} else {
		resolved
	};
	// A new file's final mode, where no preserved mode sets it; set after
	// its owner, so the group and other bits left out until then are not
	// given to the user who runs cp (GNU's `copy_reg`). Like GNU, an error
	// setting it is not reported.
	let set_then_mode = |filesystem: &BlockingFs, dest_fs: &Path| {
		if let Some(mode) = dest_facts.then_mode {
			let _ = filesystem.set_permissions(dest_fs, Permissions::from_mode(mode));
		}
	};
	// Plain `cp`/`cp -r` preserves nothing: skip the stats below. A freshly
	// created directory always gets its mode set, one way or the other.
	let preserves_nothing = [attributes.ownership, attributes.mode, attributes.timestamps, attributes.xattr]
		.iter()
		.all(|preserve| matches!(preserve, Preserve::No { .. }));
	if preserves_nothing && !dest_is_freshly_created_dir {
		set_then_mode(&filesystem, &dest_fs);
		return Ok(());
	}
	let source_fs = host.resolve(source);
	let fetched;
	let source_metadata = match source_metadata {
		Some(metadata) => metadata,
		None => {
			fetched = if follow_source {
				filesystem.metadata(&source_fs)
			} else {
				filesystem.symlink_metadata(&source_fs)
			}
			.map_err(|e| CpError::IoErrContext(e, context_for(source, dest)))?;
			&fetched
		},
	};
	let dest_is_symlink = dest_facts
		.symlink
		.unwrap_or_else(|| filesystem.is_symlink(&dest_fs));
	// As in GNU, an owner or mode `dest` already has is not set again.
	let source_owner = source_metadata.uid().zip(source_metadata.gid());
	let chowns = matches!(attributes.ownership, Preserve::Yes { .. })
		&& source_owner.is_some()
		&& dest_facts.owner != source_owner;
	let mode_in_place =
		!chowns && dest_facts.mode == Some(source_metadata.permissions().mode() & 0o7777);

	let mode_explicitly_disabled = matches!(attributes.mode, Preserve::No { explicit: true });

	// preserve is true by default if the destination is created by us and it's
	// a directory
	let mode = if !mode_explicitly_disabled && dest_is_freshly_created_dir {
		Preserve::Yes { required: false }
	} else {
		attributes.mode
	};

	// Ownership must be changed first to avoid interfering with mode change.
	handle_preserve(host, attributes.ownership, || {
		// A provider without owners has nothing to carry over.
		let Some((uid, gid)) = source_owner.filter(|_| chowns) else {
			return Ok(());
		};
		// GNU cp doesn't report a failure to set the ownership, and falls back
		// to changing only the group.
		if filesystem.chown(&dest_fs, Some(uid), Some(gid), false).is_err() {
			let _ = filesystem.chown(&dest_fs, None, Some(gid), false);
		}
		Ok(())
	})?;
	set_then_mode(&filesystem, &dest_fs);

	handle_preserve(host, mode, || {
		// chmod cannot change a symbolic link, and every link has the same
		// permissions anyway.
		if !dest_is_symlink && !mode_in_place {
			set_mode(&filesystem, &dest_fs, dest, source_metadata.permissions())?;
		}
		Ok(())
	})?;

	// A directory is created with a restrictive mode (see `build_dir`); when
	// its mode is not preserved it ends up with the default one.
	if dest_is_freshly_created_dir && mode_explicitly_disabled {
		let umask = host.umask();
		handle_preserve(host, Preserve::Yes { required: false }, || {
			set_mode(&filesystem, &dest_fs, dest, Permissions::from_mode(0o777 & !umask))
		})?;
	}

	handle_preserve(host, attributes.timestamps, || {
		let times_error =
			|e| CpError::IoErrContext(e, format!("preserving times for {}", dest.quote()));
		let accessed = FileTime::from(source_metadata.accessed().ok());
		let modified = FileTime::from(source_metadata.modified().map_err(times_error)?);
		if dest_is_symlink {
			filesystem.set_times(&dest_fs, accessed, modified, false)
		} else {
			preserve_via(
				&filesystem,
				&dest_fs,
				|filesystem, path| filesystem.set_times(path, accessed, modified, true),
				|file| file.set_times(accessed, modified),
			)
		}
		.map_err(times_error)
	})?;

	handle_preserve(host, attributes.xattr, || {
		copy_extended_attrs(&filesystem, &source_fs, &dest_fs, follow_source, skip_selinux_xattr)
			.map_err(|e| CpError::IoErrContext(e, format!("setting attributes for {}", dest.quote())))
	})?;

	Ok(())
}

/// Sets the permissions of `dest` (resolved as `dest_fs`), for attribute
/// preservation.
fn set_mode(
	filesystem: &BlockingFs,
	dest_fs: &Path,
	dest: &Path,
	permissions: Permissions,
) -> CopyResult<()> {
	preserve_via(
		filesystem,
		dest_fs,
		|filesystem, path| filesystem.set_permissions(path, permissions),
		|file| file.set_permissions(permissions),
	)
	.map_err(|e| CpError::IoErrContext(e, format!("preserving permissions for {}", dest.quote())))
}

/// Creates the symlink `dest` pointing at the literal `target`.
fn symlink_file(
	host: &mut Host,
	state: &mut CopyState,
	target: &Path,
	dest: &Path,
	kind: SymlinkKind,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	filesystem.symlink_with(target, &dest_fs, kind).map_err(|e| {
		CpError::IoErrContext(
			e,
			format!("cannot create symbolic link {} to {}", dest.quote(), target.quote()),
		)
	})?;
	if let Some(id) = file_id(&filesystem, &dest_fs, false) {
		state.symlinked_files.insert(id);
	}
	Ok(())
}

fn context_for(src: &Path, dest: &Path) -> String {
	format!("{} -> {}", src.quote(), dest.quote())
}

/// Backs `dest` up to `backup_path`: renamed away, as GNU does, so the copy
/// creates a new file; copied when `dest` is the source itself, which must
/// stay readable.
fn backup_dest(
	filesystem: &BlockingFs,
	dest: &Path,
	dest_fs: &Path,
	backup_path: &Path,
	rename: bool,
) -> CopyResult<()> {
	if rename {
		filesystem.rename(dest_fs, backup_path).map(drop)
	} else {
		filesystem.copy(dest_fs, backup_path).map(drop)
	}
	.map_err(|e| CpError::IoErrContext(e, format!("cannot backup {}", dest.quote())))
}

/// The identity of `path`, when its filesystem reports one.
fn file_id(filesystem: &BlockingFs, path: &Path, follow: bool) -> Option<FileId> {
	let metadata = if follow { filesystem.metadata(path) } else { filesystem.symlink_metadata(path) };
	metadata.ok()?.file_id()
}

/// Whether `a` and `b` are the same file. Identities decide when both come
/// from one namespace; otherwise (a provider without identities, or one
/// aliasing host files) the same location does.
fn paths_refer_to_same_file(filesystem: &BlockingFs, a: &Path, b: &Path, dereference: bool) -> bool {
	let stat = |path: &Path| {
		if dereference { filesystem.metadata(path) } else { filesystem.symlink_metadata(path) }
	};
	let (Ok(a_metadata), Ok(b_metadata)) = (stat(a), stat(b)) else {
		return false;
	};
	match (a_metadata.file_id(), b_metadata.file_id()) {
		(Some(a), Some(b)) if a.is_native() == b.is_native() => a == b,
		_ if dereference => {
			matches!((location(filesystem, a), location(filesystem, b)), (Some(a), Some(b)) if a == b)
		},
		_ => normalize_lexically(a) == normalize_lexically(b),
	}
}

/// Where `path` physically is: the canonical host file a provider path
/// aliases, else its canonical path.
fn location(filesystem: &BlockingFs, path: &Path) -> Option<PathBuf> {
	match filesystem.backing_path(path).ok().flatten() {
		Some(backing) => Some(filesystem.canonicalize(&backing).unwrap_or(backing)),
		None => filesystem.canonicalize(path).ok(),
	}
}

/// Whether `source` and `target` are hard links to the same file, without
/// following either.
fn are_hardlinks_to_same_file(filesystem: &BlockingFs, source: &Path, target: &Path) -> bool {
	paths_refer_to_same_file(filesystem, source, target, false)
}

/// Whether following `path` revisits a symlink.
fn is_symlink_loop(filesystem: &BlockingFs, path: &Path) -> bool {
	let mut visited = FxHashSet::default();
	let mut current = path.to_path_buf();
	while let (Ok(metadata), Ok(link)) =
		(filesystem.symlink_metadata(&current), filesystem.read_link(&current))
	{
		if !metadata.is_symlink() {
			return false;
		}
		if !visited.insert(current.clone()) {
			return true;
		}
		// A relative target is relative to the link's directory.
		current = match parent_path(&current) {
			Some(parent) => join_path(parent, &link),
			None => link,
		};
	}
	false
}

/// Decide whether source and destination files are the same and
/// copying is forbidden.
///
/// Copying to the same file is only allowed if both `--backup` and
/// `--force` are specified and the file is a regular file.
fn is_forbidden_to_copy_to_same_file(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	source_fs: &Path,
	dest_fs: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	let source_is_symlink = filesystem.is_symlink(source_fs);
	let dest_is_symlink = filesystem.is_symlink(dest_fs);
	// only disable dereference if both source and dest is symlink and dereference
	// flag is disabled
	let dereference_to_compare =
		options.dereference(source_in_command_line) || (!source_is_symlink || !dest_is_symlink);
	if !paths_refer_to_same_file(filesystem, source_fs, dest_fs, dereference_to_compare) {
		return false;
	}
	if options.backup != BackupMode::None {
		if options.force() && !source_is_symlink {
			return false;
		}
		if source_is_symlink && !options.dereference {
			return false;
		}
		if dest_is_symlink {
			return false;
		}
		if !dest_is_symlink && !source_is_symlink && dest != source {
			return false;
		}
	}
	if options.copy_mode == CopyMode::Link {
		return false;
	}
	if options.copy_mode == CopyMode::SymLink && dest_is_symlink {
		return false;
	}
	// If source and dest are both the same symlink but with different names,
	// then allow the copy. This can occur, for example, if source and dest are
	// both hardlinks to the same symlink.
	if dest_is_symlink
		&& source_is_symlink
		&& file_name(source) != file_name(dest)
		&& !options.dereference
	{
		return false;
	}
	true
}

/// The destination as GNU's `copy.c` reads it (`use_lstat`): with lstat
/// where the copy would not write through a link there (a source that is
/// not copied as a regular file, `-l`, `-s`, a backup,
/// `--remove-destination`, `mv`), and followed where a regular file is
/// written through it.
fn read_dest(
	filesystem: &BlockingFs,
	dest_fs: &Path,
	source_metadata: &Metadata,
	options: &Options,
) -> io::Result<Metadata> {
	let copy_as_regular = !options.recursive || options.copy_contents;
	let use_lstat = (!source_metadata.is_file()
		&& (!copy_as_regular || source_metadata.is_dir() || source_metadata.is_symlink()))
		|| options.move_mode
		|| matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink)
		|| options.backup != BackupMode::None
		|| options.remove_destination();
	if use_lstat { filesystem.symlink_metadata(dest_fs) } else { filesystem.metadata(dest_fs) }
}

/// Back up, remove, or leave intact the existing destination file, depending
/// on the options. Returns the backup made, if any. `source_metadata` is the
/// source as the copy reads it.
fn handle_existing_dest(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	source_metadata: &Metadata,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<Option<PathBuf>> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	if options.update == UpdateMode::None {
		if options.debug {
			let _ = writeln!(host.stdout, "skipped {}", dest.quote());
		}
		return Err(CpError::Skipped(false));
	}

	if options.update != UpdateMode::IfOlder {
		options.overwrite.verify(host, dest, options.debug)?;
	}

	// GNU refuses a non-directory over a directory once -n, -i and -u let
	// the copy go on, unless a backup is asked for (`copy.c`). A copy never
	// backs a directory up: with a backup the copy then fails where it makes
	// the name, and the directory stays. `mv` backs a directory up.
	if !options.move_mode
		&& read_dest(&filesystem, &dest_fs, source_metadata, options).is_ok_and(|existing| existing.is_dir())
	{
		if options.backup == BackupMode::None {
			return Err(CpError::Error(format!(
				"cannot overwrite directory {} with non-directory {}",
				dest.quote(),
				source.quote()
			)));
		}
		return Ok(None);
	}

	let mut is_dest_removed = false;
	let backup = backup_path(&filesystem, options.backup, &dest_fs, &options.backup_suffix);
	if let Some(backup) = &backup {
		if paths_refer_to_same_file(&filesystem, &source_fs, backup, true) {
			return Err(CpError::Error(format!(
				"backing up {} might destroy source;  {} not copied",
				dest.quote(),
				source.quote()
			)));
		}
		is_dest_removed = filesystem.is_symlink(&dest_fs)
			|| !paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true);
		backup_dest(&filesystem, dest, &dest_fs, backup, is_dest_removed)?;
	}
	if !is_dest_removed {
		delete_dest_if_needed_and_allowed(host, state, source, dest, options, source_in_command_line)?;
	}

	Ok(backup)
}

/// Puts the backup `handle_existing_dest` made (`backup`, a filesystem path)
/// back under the destination's name after cp failed to create the
/// destination with `error`, as GNU's `un_backup` does (`copy.c`): `b` keeps
/// its name and its data, and a file the failed copy left at `b` is replaced.
/// Returns the error to report. Where the rename back fails too, GNU reports
/// the copy's error first and then `cannot un-backup`, so both are reported
/// here, in that order, and an already reported failure is returned.
fn un_backup(host: &mut Host, options: &Options, dest: &Path, backup: &Path, error: CpError) -> CpError {
	let dest_fs = host.resolve(dest);
	let renamed = host.fs().rename(backup, &dest_fs);
	match renamed {
		Ok(_) => {
			if options.verbose {
				let _ = writeln!(
					host.stdout,
					"{} -> {} (unbackup)",
					backup_display(dest, backup).quote(),
					dest.quote()
				);
			}
			error
		},
		Err(rename_error) => {
			show_error_if_needed(host, &error);
			show_error(host, CpError::IoErrContext(rename_error, format!("cannot un-backup {}", dest.quote())));
			CpError::NotAllFilesCopied
		},
	}
}

/// Deletes `dest` when it has to go before the copy can proceed and the
/// options allow it.
fn delete_dest_if_needed_and_allowed(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let delete_dest = match options.overwrite {
		OverwriteMode::Clobber(clobber) | OverwriteMode::Interactive(clobber) => match clobber {
			// Removed only once opening it fails (see `copy_data`).
			ClobberMode::Force => false,
			ClobberMode::RemoveDestination => true,
			ClobberMode::Standard => {
				// With `cp -a src/ dest/`, a hard link `src/link` to `src/f` may be
				// copied before `src/f`; an existing `dest/src/f` must then be
				// replaced by a link to the copy.
				options.preserve_hard_links()
					&& file_id(
						&filesystem,
						&host.resolve(source),
						options.dereference(source_in_command_line),
					)
					.is_some_and(|id| state.copied_files.contains_key(&id))
			},
		},
		OverwriteMode::NoClobber => false,
	};

	if delete_dest { delete_path(host, state, dest, options) } else { Ok(()) }
}

fn delete_path(host: &mut Host, state: &CopyState, path: &Path, options: &Options) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let path_fs = host.resolve(path);
	// Windows requires clearing readonly attribute before deletion when using
	// --force
	#[cfg(windows)]
	if options.force()
		&& let Ok(mut permissions) = filesystem.metadata(&path_fs).map(|m| m.permissions())
	{
		permissions.set_readonly(false);
		let _ = filesystem.set_permissions(&path_fs, permissions);
	}

	match filesystem.remove_file(&path_fs) {
		Ok(()) => {
			if options.verbose {
				state.say(host, format_args!("removed {}", path.quote()));
			}
		},
		// target could have been deleted earlier (e.g. same-file with
		// --remove-destination)
		Err(err) if err.kind() == io::ErrorKind::NotFound => {},
		Err(err) => {
			return Err(CpError::IoErrContext(err, format!("cannot remove {}", path.quote())));
		},
	}

	Ok(())
}

/// Zip the ancestors of a source path and destination path, outermost first,
/// without the paths themselves: `a/b/c` and `d/a/b/c` give `(a, d/a)` and
/// `(a/b, d/a/b)`.
fn aligned_ancestors(source: &Path, dest: &Path) -> Vec<(PathBuf, PathBuf)> {
	let source_ancestors: Vec<&Path> = std::iter::successors(Some(source), |p| parent_path(p)).collect();
	let dest_ancestors: Vec<&Path> = std::iter::successors(Some(dest), |p| parent_path(p)).collect();

	// Neither the full path nor the empty path (or root) is an ancestor to
	// create.
	let Some(source_ancestors) = source_ancestors.get(1..source_ancestors.len().saturating_sub(1))
	else {
		return Vec::new();
	};
	let Some(dest_ancestors) = dest_ancestors.get(1..=source_ancestors.len()) else {
		return Vec::new();
	};

	source_ancestors
		.iter()
		.rev()
		.zip(dest_ancestors.iter().rev())
		.map(|(x, y)| (x.to_path_buf(), y.to_path_buf()))
		.collect()
}

/// For `--parents`, creates the missing directories between `dest` and its
/// target, each like the source directory it mirrors; `-v` reports each
/// one, e.g. `a -> d/a` and `a/b -> d/a/b` before copying `a/b/c` to
/// `d/a/b/c`.
fn make_parent_dirs(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
) -> CopyResult<()> {
	for (x, y) in aligned_ancestors(source, dest) {
		match host.fs().metadata(host.resolve(&y)) {
			Ok(metadata) if metadata.is_dir() => {},
			Ok(_) => {
				return Err(CpError::Error(format!("{} exists but is not a directory", y.quote())));
			},
			Err(_) => {
				build_dir(host, &y, false, options, Some(&x))?;
				if options.verbose {
					state.say(host, format_args!("{} -> {}", x.display(), y.display()));
				}
			},
		}
	}
	Ok(())
}

/// Reports one copy for `-v`: `'source' -> 'dest'`, or `renamed 'source'
/// -> 'dest'` for an entry below a directory `mv` moves.
fn print_verbose_output(
	host: &mut Host,
	state: &CopyState,
	options: &Options,
	source: &Path,
	dest: &Path,
	backup: Option<&Path>,
) {
	let action = if options.move_mode { "renamed " } else { "" };
	match backup {
		Some(backup) => state.say(
			host,
			format_args!(
				"{action}{} (backup: {})",
				context_for(source, dest),
				backup_display(dest, backup).quote()
			),
		),
		None => state.say(host, format_args!("{action}{}", context_for(source, dest))),
	}
}

/// Whether a relative symlink target named by `-s` would resolve from `dest`
/// the same way it does from the working directory.
fn dest_in_working_directory(host: &Host, dest: &Path) -> bool {
	match parent_path(dest) {
		None => true,
		Some(parent) if parent.is_empty() || parent == "." => true,
		Some(parent) => host
			.fs()
			.same_file(host.resolve(parent), host.resolve("."))
			.unwrap_or(false),
	}
}

/// Handles the copy mode for a file copy operation: hard linking, copying
/// (`-u` already decided to), symbolic linking, or attribute-only copying.
fn handle_copy_mode(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
	// The lstat of `dest` just before the copy; `None` when there is none.
	dest_metadata: Option<&Metadata>,
	source_in_command_line: bool,
	backed_up: bool,
) -> CopyResult<DestFate> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	match options.copy_mode {
		CopyMode::Link => {
			// A destination that survived `handle_existing_dest` was backed up
			// by copying, or is replaced under `-f`.
			if filesystem.exists(&dest_fs) && (backed_up || options.force()) {
				filesystem.remove_file(&dest_fs)?;
			}
			let original = if options.dereference(source_in_command_line)
				&& filesystem.is_symlink(&source_fs)
			{
				filesystem.canonicalize_with(
					&source_fs,
					&CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical),
				)?
			} else {
				source_fs
			};
			filesystem.hard_link(&original, &dest_fs).map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), source.quote()),
				)
			})?;
		},
		CopyMode::Copy | CopyMode::Update => {
			return copy_helper(host, state, source, dest, options, source_metadata, dest_metadata);
		},
		CopyMode::SymLink => {
			if !source.is_absolute()
				&& !is_virtual_path(source)
				&& !dest_in_working_directory(host, dest)
			{
				return Err(CpError::Error(format!(
					"{}: can make relative symbolic links only in current directory",
					dest.maybe_quote()
				)));
			}
			if filesystem.exists(&dest_fs) && options.force() {
				filesystem.remove_file(&dest_fs)?;
			}
			symlink_file(host, state, source, dest, SymlinkKind::Auto)?;
		},
		CopyMode::AttrOnly => {
			filesystem
				.open_with(&dest_fs, OpenOptions::new().write(true).create(true))
				.and_then(File::close)
				.map_err(|e| {
					CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()))
				})?;
		},
	}

	Ok(DestFate::Kept)
}

/// What a copy did to an existing destination, which decides the
/// destination's permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestFate {
	/// Written in place, or swapped for a clone standing in for it; an
	/// existing destination keeps its permissions.
	Kept,
	/// Removed and created anew (`-f`, special files); the destination takes
	/// the source's permissions.
	Recreated,
	/// Created by the copy where there was none, with `mode` (permission
	/// bits) in place when known, and owned by `owner` (uid, gid) when the
	/// copy looked: only ownership preservation needs it. `through`: made
	/// through a symbolic link that led nowhere (POSIXLY_CORRECT), so the
	/// file is the one the link leads to.
	Created { mode: Option<u32>, owner: Option<(u32, u32)>, through: bool },
}

/// What a caller knows of a destination without looking at it again.
#[derive(Debug, Clone, Copy, Default)]
struct DestFacts {
	/// Whether it is a symlink; `None` looks.
	symlink: Option<bool>,
	/// Its permission bits, when this copy created it.
	mode:      Option<u32>,
	/// Its owner and group, when this copy created it and looked.
	owner:     Option<(u32, u32)>,
	/// The mode a new file gets when no preserved mode sets it, set once its
	/// owner is, as GNU's `copy_reg` sets it.
	then_mode: Option<u32>,
	/// It is a symbolic link the copy wrote through: its attributes go to
	/// the file it leads to.
	through:   bool,
}

/// The mode a new destination gets: the source's, less
/// `--no-preserve=mode` and the umask.
fn new_dest_mode(source_metadata: &Metadata, options: &Options, umask: u32) -> u32 {
	handle_no_preserve_mode(options, source_metadata.permissions().mode()) & !umask
}

/// Copy the a file from `source` to `dest`. `source` will be dereferenced if
/// `options.dereference` is set to true. `dest` will be dereferenced only if
/// the source was not a symlink.
///
/// Behavior when copying to existing files is contingent on the
/// `options.overwrite` mode. If a file is skipped, the return type
/// should be `Error:Skipped`
///
/// The original permissions of `source` will be copied to `dest`
/// after a successful copy.
fn copy_file(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
	// An lstat of `source` the caller already holds.
	source_lstat: Option<Metadata>,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let dereference = options.dereference(source_in_command_line);
	// `mv` reports a moved operand itself, once its source is gone.
	let report = options.verbose && !(options.move_mode && source_in_command_line);

	// GNU stats the source before touching the destination. The caller's
	// lstat answers unless dereferencing must look through a symlink.
	let lstat_is_symlink = source_lstat.as_ref().map(Metadata::is_symlink);
	let source_metadata = match source_lstat {
		Some(lstat) if !dereference || !lstat.is_symlink() => Ok(lstat),
		_ if dereference => filesystem.metadata(&source_fs),
		_ => filesystem.symlink_metadata(&source_fs),
	}
	.map_err(|e| CpError::IoErrContext(e, format!("cannot stat {}", source.quote())))?;

	let source_is_symlink = if dereference {
		lstat_is_symlink.unwrap_or_else(|| filesystem.is_symlink(&source_fs))
	} else {
		source_metadata.is_symlink()
	};
	let initial_dest_metadata = match filesystem.symlink_metadata(&dest_fs) {
		Ok(metadata) => Some(metadata),
		Err(error) if error.kind() == io::ErrorKind::NotFound => None,
		Err(error) => {
			return Err(CpError::IoErrContext(error, format!("cannot stat {}", dest.quote())));
		},
	};
	let dest_is_symlink = initial_dest_metadata
		.as_ref()
		.is_some_and(Metadata::is_symlink);
	// Set when a branch below removes or renames the destination, so its
	// first stat no longer describes it.
	let mut dest_replaced = false;
	// Fail if dest is a dangling symlink or a symlink this program created
	// previously
	if dest_is_symlink {
		if file_id(&filesystem, &dest_fs, false).is_some_and(|id| state.symlinked_files.contains(&id))
			// Two sources of the same name must not both go through one symlink.
			|| state.copied_destinations.contains(dest)
		{
			return Err(CpError::Error(format!(
				"will not copy {} through just-created symlink {}",
				source.quote(),
				dest.quote()
			)));
		}

		let copy_contents = dereference || !source_is_symlink;
		if copy_contents
			&& !filesystem.try_exists(&dest_fs).unwrap_or(false)
			&& !options.remove_destination()
			&& !is_symlink_loop(&filesystem, &dest_fs)
			&& host.var("POSIXLY_CORRECT").is_none()
		{
			return Err(CpError::Error(format!(
				"not writing through dangling symlink {}",
				dest.quote()
			)));
		}
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.remove_destination()
			&& options.backup == BackupMode::None
		{
			filesystem.remove_file(&dest_fs)?;
			dest_replaced = true;
		}
	}

	if options.remove_destination()
		&& source != dest
		&& are_hardlinks_to_same_file(&filesystem, &source_fs, &dest_fs)
	{
		filesystem.remove_file(&dest_fs)?;
		dest_replaced = true;
	}

	let check_existing_dest = initial_dest_metadata.is_some()
		&& (!options.attributes_only || options.remove_destination());
	if check_existing_dest {
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.copy_mode == CopyMode::Link
		{
			if source_is_symlink {
				if !dest_is_symlink || !options.dereference {
					return Ok(());
				}
			} else if options.backup != BackupMode::None && !dest_is_symlink {
				if source != dest || !options.force() {
					return Ok(());
				}
			}
		}
		// Disallow copying a file to itself, unless `--force` and
		// `--backup` are both specified.
		if is_forbidden_to_copy_to_same_file(
			&filesystem,
			source,
			dest,
			&source_fs,
			&dest_fs,
			options,
			source_in_command_line,
		) {
			return Err(CpError::Error(format!(
				"{} and {} are the same file",
				source.quote(),
				dest.quote()
			)));
		}
	}

	// `-u`/`--update` decides before anything is backed up or removed, on the
	// destination as GNU reads it: a link at it is one, where a link is
	// copied, even one that leads nowhere.
	let update_dest = if options.copy_mode == CopyMode::Update {
		read_dest(&filesystem, &dest_fs, &source_metadata, options).ok()
	} else {
		None
	};
	if let Some(existing) = update_dest {
		match options.update {
			UpdateMode::All => {},
			UpdateMode::None => {
				if options.debug {
					let _ = writeln!(host.stdout, "skipped {}", dest.quote());
				}
				return Ok(());
			},
			UpdateMode::NoneFail => {
				return Err(CpError::Error(format!("not replacing {}", dest.quote())));
			},
			UpdateMode::IfOlder => {
				let dest_time = existing.modified()?;
				if source_metadata.modified()? <= dest_time {
					return Ok(());
				}
				options.overwrite.verify(host, dest, options.debug)?;
			},
		}
	}

	let mut backup = None;
	if check_existing_dest {
		backup =
			handle_existing_dest(host, state, source, &source_metadata, dest, options, source_in_command_line)?;
		dest_replaced = true;
		if are_hardlinks_to_same_file(&filesystem, &source_fs, &dest_fs) {
			if options.copy_mode == CopyMode::Copy {
				return Ok(());
			}
			if options.copy_mode == CopyMode::Link && (!source_is_symlink || !dest_is_symlink) {
				return Ok(());
			}
		}
	}

	if options.attributes_only && source_is_symlink && !options.remove_destination() {
		return Err(CpError::Error(format!(
			"cannot change attribute {}: Source file is a non regular file",
			dest.quote()
		)));
	}

	// When using --link mode, hard link structure is automatically preserved
	// because we link to source files (which share inodes). The lookup ignores
	// the link count: `mv` removed the other names of an earlier operand, so
	// its later names may be down to one.
	if options.preserve_hard_links()
		&& options.copy_mode != CopyMode::Link
		&& let Some(new_source) = source_metadata
			.file_id()
			.and_then(|id| state.copied_files.get(&id))
	{
		// A matching identity in the source tree becomes a hard link between
		// the corresponding names in the destination tree.
		let new_source = new_source.clone();
		let linked = filesystem.hard_link(host.resolve(&new_source), &dest_fs);
		if let Err(e) = linked {
			let error = CpError::IoErrContext(
				e,
				format!("cannot create hard link {} to {}", dest.quote(), new_source.quote()),
			);
			return Err(match &backup {
				Some(backup) => un_backup(host, options, dest, backup, error),
				None => error,
			});
		}

		if report {
			print_verbose_output(host, state, options, source, dest, backup.as_deref());
		}

		return Ok(());
	}

	let mut dest_metadata = if backup.is_some() {
		// GNU takes the name as new after its backup, a rename (`new_dst`).
		// Where the backup was a copy (the source leads to the destination's
		// own file), the file found before is still at the name and is
		// replaced as before. A rename onto another link of the same file does
		// nothing, and GNU still takes the name as new: the exclusive create
		// fails on it, and a symlink replaces it only under `-f`. Any other
		// file there appeared after the backup and is new to cp too.
		let backup_fs = backup.as_deref().map(|backup| host.resolve(backup));
		match filesystem.symlink_metadata(&dest_fs) {
			Ok(now)
				if initial_dest_metadata.as_ref().is_some_and(|before| before.same_file(&now))
					&& !backup_fs
						.and_then(|backup| filesystem.symlink_metadata(backup).ok())
						.is_some_and(|backup| backup.same_file(&now)) =>
			{
				Some(now)
			},
			_ => None,
		}
	} else if dest_replaced {
		filesystem.symlink_metadata(&dest_fs).ok()
	} else {
		initial_dest_metadata
	};

	// A copied symlink replaces any destination that is not a directory (a
	// FIFO, socket or device too), which GNU removes before reporting the
	// copy, saying `removed` under `-v` (`copy.c`).
	if source_metadata.is_symlink()
		&& matches!(options.copy_mode, CopyMode::Copy | CopyMode::Update)
		&& dest_metadata.as_ref().is_some_and(|metadata| !metadata.is_dir())
	{
		delete_path(host, state, dest, options)?;
		dest_metadata = None;
	}

	let source_is_stream = is_stream(&source_metadata);

	// GNU reports each copy as it starts it.
	if report {
		print_verbose_output(host, state, options, source, dest, backup.as_deref());
	}

	let fate = match handle_copy_mode(
		host,
		state,
		source,
		dest,
		options,
		&source_metadata,
		dest_metadata.as_ref(),
		source_in_command_line,
		backup.is_some(),
	) {
		Ok(fate) => fate,
		Err(error) => {
			return Err(match &backup {
				Some(backup) => un_backup(host, options, dest, backup, error),
				None => error,
			});
		},
	};

	// A file this copy created has a known mode and maybe owner; one made
	// through a link that led nowhere is the file the link leads to.
	let (mut created_mode, owner, through) = match fate {
		DestFate::Created { mode, owner, through } => (mode, owner, through),
		DestFate::Kept | DestFate::Recreated => (None, None, false),
	};

	// Links share their target's permissions; only a copy gets its own.
	let copied_data = !source_metadata.is_symlink()
		&& !matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink);
	// A preserved mode is set by `copy_attributes` below. An existing
	// destination the copy wrote keeps its own, as GNU's does. A new file gets
	// the source's, less `--no-preserve=mode` and the umask, which
	// `copy_attributes` sets after the owner (GNU's `copy_reg`); like GNU, an
	// error setting it is not reported.
	let mode_set_later = matches!(options.attributes.mode, Preserve::Yes { .. }) && !source_is_stream;
	let kept = dest_metadata
		.as_ref()
		.filter(|_| fate == DestFate::Kept);
	let mut then_mode = None;
	if (!dest_is_symlink || through) && copied_data && !mode_set_later && kept.is_none() {
		let mode = new_dest_mode(&source_metadata, options, host.umask());
		if created_mode != Some(mode) {
			then_mode = Some(mode);
			created_mode = None;
		}
	}

	// What the copy left at `dest`: a recreated symlink, or a file wherever no
	// symlink was written through.
	let dest_facts = DestFacts {
		symlink: match options.copy_mode {
			CopyMode::Copy | CopyMode::Update if source_metadata.is_symlink() => Some(true),
			CopyMode::Copy | CopyMode::Update
				if !dest_metadata.as_ref().is_some_and(Metadata::is_symlink) =>
			{
				Some(false)
			},
			_ => None,
		},
		mode: created_mode,
		owner,
		then_mode,
		through,
	};

	// Some stream files may not exist after we have copied them, like
	// anonymous pipes; there are no attributes left to copy, only the mode.
	if !(source_is_stream && !filesystem.exists(&source_fs)) {
		copy_attributes(
			host,
			source,
			dest,
			&options.attributes,
			false,
			dereference,
			options.set_selinux_context,
			Some(&source_metadata),
			dest_facts,
		)?;
	} else if let Some(mode) = then_mode {
		let _ = filesystem.set_permissions(&dest_fs, Permissions::from_mode(mode));
	}

	// Only `--preserve=links` looks copies up, and only a file with other
	// names, or reached through a followed symlink, can be met again; GNU's
	// `remember_copied` keeps the same ones.
	if options.preserve_hard_links()
		&& options.copy_mode != CopyMode::Link
		&& (dereference || source_metadata.nlink().is_none_or(|links| links > 1))
		&& let Some(id) = source_metadata.file_id()
	{
		state.copied_files.insert(id, dest.to_path_buf());
	}

	if let Some(bar) = &state.progress_bar {
		bar.inc(source_metadata.len());
	}

	Ok(())
}

fn is_stream(metadata: &Metadata) -> bool {
	let file_type = metadata.file_type();
	file_type.is_fifo() || file_type.is_char_device() || file_type.is_block_device()
}

fn handle_no_preserve_mode(options: &Options, org_mode: u32) -> u32 {
	const MODE_RW_UGO: u32 = 0o666;
	const S_IRWXUGO: u32 = 0o777;
	let (is_preserve_mode, is_explicit_no_preserve_mode) = options.preserve_mode();
	if is_preserve_mode {
		org_mode
	} else if is_explicit_no_preserve_mode {
		MODE_RW_UGO
	} else {
		org_mode & S_IRWXUGO
	}
}

/// Copy the file from `source` to `dest` either using the normal copy or a
/// copy-on-write scheme if --reflink is specified and the filesystem
/// supports it.
fn copy_helper(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
	dest_metadata: Option<&Metadata>,
) -> CopyResult<DestFate> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	if path_ends_with_terminator(dest) && !filesystem.is_dir(&dest_fs) {
		let error = if filesystem.exists(&dest_fs) {
			pi_vfs::not_a_directory()
		} else {
			io::Error::new(io::ErrorKind::NotFound, "No such file or directory")
		};
		return Err(CpError::IoErrContext(
			error,
			format!("cannot create regular file {}", dest.quote()),
		));
	}

	if options.recursive && !options.copy_contents {
		let file_type = source_metadata.file_type();
		if file_type.is_socket() {
			return copy_special(host, dest, options, NodeKind::Socket, 0o777);
		}
		if file_type.is_fifo() {
			return copy_special(host, dest, options, NodeKind::Fifo, 0o666);
		}
		if file_type.is_char_device() || file_type.is_block_device() {
			let rdev = source_metadata.rdev().ok_or_else(|| {
				CpError::IoErrContext(
					operation_not_supported(),
					format!("cannot create special file {}", dest.quote()),
				)
			})?;
			let kind = if file_type.is_char_device() {
				NodeKind::CharDevice(rdev)
			} else {
				NodeKind::BlockDevice(rdev)
			};
			return copy_special(host, dest, options, kind, source_metadata.mode() & 0o7777);
		}
	}

	if source_metadata.is_symlink() {
		copy_link(host, state, source, dest, options, source_metadata)?;
		return Ok(DestFate::Kept);
	}
	let (copy_debug, fate) = copy_data(host, state, source, dest, options, source_metadata, dest_metadata)?;
	if !options.attributes_only && options.debug {
		state.say(host, copy_debug);
	}
	Ok(fate)
}

/// "Copies" a FIFO, socket, or device node by creating a new one with `mode`
/// at `dest`; its contents are not copied (see `--copy-contents`).
fn copy_special(
	host: &mut Host,
	dest: &Path,
	options: &Options,
	kind: NodeKind,
	mode: u32,
) -> CopyResult<DestFate> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	if filesystem.exists(&dest_fs) {
		options.overwrite.verify(host, dest, options.debug)?;
		filesystem.remove_file(&dest_fs)?;
	}

	let created = match kind {
		NodeKind::Fifo => filesystem
			.make_fifo(&dest_fs, mode)
			.map_err(|e| CpError::IoErrContext(e, format!("cannot create fifo {}", dest.quote()))),
		// A native socket is made the portable way, by binding it.
		#[cfg(unix)]
		NodeKind::Socket if filesystem.is_native_local(&dest_fs) => {
			std::os::unix::net::UnixListener::bind(&dest_fs)
				.map(drop)
				.map_err(CpError::IoErr)
		},
		_ => filesystem.make_node(&dest_fs, kind, mode).map_err(|e| {
			CpError::IoErrContext(e, format!("cannot create special file {}", dest.quote()))
		}),
	};
	created.map(|()| DestFate::Recreated)
}

/// Recreates the symlink `source`, whose lstat is `source_metadata`, at
/// `dest`; any existing destination was removed by `copy_file`.
fn copy_link(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
) -> CopyResult<()> {
	let link = host.fs().read_link(host.resolve(source)).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot read symbolic link {}", source.quote()))
	})?;
	// Windows tells file from directory symlinks, even dangling ones; keep the
	// kind the source link has.
	#[cfg(windows)]
	let kind = {
		let file_type = source_metadata.file_type();
		if file_type.is_symlink_dir() {
			SymlinkKind::Dir
		} else if file_type.is_symlink_file() {
			SymlinkKind::File
		} else {
			SymlinkKind::Auto
		}
	};
	#[cfg(not(windows))]
	let kind = SymlinkKind::Auto;
	match symlink_file(host, state, &link, dest, kind) {
		// GNU's `force_symlinkat`: under `-f` a name still there (taken as new
		// after a backup that left it) is replaced by the link.
		Err(CpError::IoErrContext(error, _))
			if error.kind() == io::ErrorKind::AlreadyExists && options.unlink_after_failed_open() =>
		{
			let dest_fs = host.resolve(dest);
			host.fs().remove_file(&dest_fs).map_err(|e| {
				CpError::IoErrContext(e, format!("cannot remove {}", dest.quote()))
			})?;
			symlink_file(host, state, &link, dest, kind)?;
		},
		// A copied link is named by its destination alone, as GNU names it
		// (`copy.c`); `-s` names its target too.
		Err(CpError::IoErrContext(error, _)) => {
			return Err(CpError::IoErrContext(error, format!("cannot create symbolic link {}", dest.quote())));
		},
		result => result?,
	}
	copy_attributes(
		host,
		source,
		dest,
		&options.attributes,
		false,
		false,
		options.set_selinux_context,
		Some(source_metadata),
		DestFacts { symlink: Some(true), ..DestFacts::default() },
	)
}

/// Streams `source` into `dest` through their handles, polling cancellation
/// between chunks.
fn copy_stream_data(
	host: &Host,
	source_file: &File,
	dest_file: &File,
	source: &Path,
	dest: &Path,
) -> CopyResult<()> {
	let mut buffer = vec![0; COPY_BUFFER];
	let mut reader = source_file;
	let mut writer = dest_file;
	loop {
		if host.is_cancelled() {
			return Err(CpError::NotAllFilesCopied);
		}
		let read = match reader.read(&mut buffer) {
			Ok(0) => return Ok(()),
			Ok(read) => read,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => {
				return Err(CpError::IoErrContext(error, format!("error reading {}", source.quote())));
			},
		};
		writer
			.write_all(&buffer[..read])
			.map_err(|e| CpError::IoErrContext(e, format!("error writing {}", dest.quote())))?;
	}
}

/// Refuses `--reflink=always`/`--sparse=always` where the copy would have to
/// stream, rather than silently ignoring them.
fn check_streamed_modes(options: &Options, source: &Path, dest: &Path) -> CopyResult<()> {
	if options.reflink_mode == ReflinkMode::Always {
		return Err(CpError::IoErrContext(
			operation_not_supported(),
			format!("failed to clone {} from {}", dest.quote(), source.quote()),
		));
	}
	if options.sparse_mode == SparseMode::Always {
		return Err(CpError::IoErrContext(
			operation_not_supported(),
			format!("cannot create sparse file {}", dest.quote()),
		));
	}
	Ok(())
}

/// Whether cp runs with root's privileges over files it does not own, as
/// GNU's `owner_privileges` asks: then it sets extended attributes on a file
/// whatever the file's mode.
fn owner_privileges() -> bool {
	#[cfg(unix)]
	{
		nix::unistd::geteuid().is_root()
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// Copies the data of the regular file (or stream) `source` to `dest`, whose
/// lstat just before the copy is `dest_metadata` (`None`: absent).
///
/// Opens the source, then creates or truncates the destination, reporting
/// either failure as GNU does. Two native host files take the platform's
/// kernel fast paths; any other pair streams through the filesystem's handles
/// and refuses reflink/sparse requests it cannot honor.
fn copy_data(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
	dest_metadata: Option<&Metadata>,
) -> CopyResult<(CopyDebug, DestFate)> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let source_is_stream = is_stream(source_metadata);
	let native = filesystem.is_native_local(&source_fs) && filesystem.is_native_local(&dest_fs);

	if !native && !source_is_stream {
		check_streamed_modes(options, source, dest)?;
	}

	#[cfg(not(any(target_os = "linux", target_os = "android")))]
	if native && !source_is_stream && options.sparse_mode == SparseMode::Always {
		return Err(CpError::Error("--sparse is only supported on linux".to_string()));
	}

	let mut reflink_debug = OffloadReflinkDebug::No;
	// `always`, and every clone on macOS, goes by path before opening
	// anything: a failed clone then leaves no empty `dest` behind, and an
	// APFS clone carries the source's timestamps, which a copy does not.
	let clone_by_path = native
		&& !source_is_stream
		&& match options.reflink_mode {
			ReflinkMode::Always => true,
			ReflinkMode::Auto => cfg!(target_os = "macos"),
			ReflinkMode::Never => false,
		};
	if clone_by_path {
		match pi_iso::cow::clone_file(&source_fs, &dest_fs) {
			Ok(()) => {
				if !matches!(options.attributes.timestamps, Preserve::Yes { .. }) {
					filesystem
						.set_times(&dest_fs, FileTime::Now, FileTime::Now, true)
						.map_err(|e| CpError::IoErrContext(e, context_for(source, dest)))?;
				}
				return Ok((CopyDebug::CLONED, DestFate::Kept));
			},
			Err(_) if options.reflink_mode == ReflinkMode::Auto => {
				reflink_debug = OffloadReflinkDebug::Unsupported;
			},
			Err(error) => {
				return Err(CpError::IoErrContext(
					error,
					format!("failed to clone {} from {}", dest.quote(), source.quote()),
				));
			},
		}
	}

	let source_file = filesystem.open(&source_fs).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot open {} for reading", source.quote()))
	})?;
	// A stream destination (a FIFO, a device) is written, not truncated. A
	// file is created as GNU's `copy_reg` creates it: with the source's
	// permission bits, a stream's too, less its group and other bits while
	// its owner may still change (`--preserve=ownership`), which its final
	// mode puts back once the owner is set; owner-writable only where the
	// copy sets extended attributes without root's privileges, and where a
	// provider that sets times only through a handle reopens it for writing.
	let source_mode = source_metadata.permissions().mode() & 0o777;
	let omitted = if matches!(options.attributes.ownership, Preserve::Yes { .. }) {
		source_mode & 0o077
	} else {
		0
	};
	let writable = !native
		|| cfg!(not(unix))
		|| (matches!(options.attributes.xattr, Preserve::Yes { .. }) && !owner_privileges());
	let create_mode = (source_mode & !omitted) | if writable { 0o200 } else { 0 };
	let mut dest_options = OpenOptions::new();
	dest_options.write(true).mode(create_mode);
	// A link that led nowhere before the copy began (POSIXLY_CORRECT): the
	// open makes the file it leads to, new to cp as it is to GNU.
	let dangling = dest_metadata.is_some_and(Metadata::is_symlink) && !filesystem.exists(&dest_fs);
	// A destination cp found nothing at, or backed up, is created with
	// O_EXCL and nothing to truncate, as GNU creates a new one (`copy_reg`):
	// whatever appeared there meanwhile is not written through or over.
	if dest_metadata.is_none() {
		dest_options.create_new(true);
	} else {
		dest_options.create(true).truncate(!source_is_stream);
	}
	let cannot_create =
		|e| CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()));
	let (dest_file, fate) = match filesystem.open_with(&dest_fs, &dest_options) {
		// A host file this open created has its creation mode less the umask
		// (see `Fs::with_creation_mask`), unless the parent directory has a
		// default ACL; see the fstat below for when that matters.
		Ok(file) if dest_metadata.is_none() && native => {
			(file, DestFate::Created { mode: Some(create_mode & !host.umask()), owner: None, through: false })
		},
		Ok(file) if dangling => {
			(file, DestFate::Created { mode: native.then(|| create_mode & !host.umask()), owner: None, through: true })
		},
		Ok(file) => (file, DestFate::Kept),
		// The exclusive create of a new destination met a name that appeared
		// since: GNU fails and keeps it (`copy_reg`), `-f` or not. A link
		// there is "not writing through dangling symlink", which
		// POSIXLY_CORRECT opens through instead.
		Err(error) if dest_metadata.is_none() && error.kind() == io::ErrorKind::AlreadyExists => {
			if !filesystem.symlink_metadata(&dest_fs).is_ok_and(|now| now.is_symlink()) {
				return Err(cannot_create(error));
			}
			if host.var("POSIXLY_CORRECT").is_none() {
				return Err(CpError::Error(format!("not writing through dangling symlink {}", dest.quote())));
			}
			// The file the link leads to is new to cp as it is to GNU: made with
			// the same mode, and given its final mode and owner as one is.
			let mut through = OpenOptions::new();
			through.write(true).create(true).truncate(!source_is_stream).mode(create_mode);
			let file = filesystem.open_with(&dest_fs, &through).map_err(cannot_create)?;
			(file, DestFate::Created { mode: native.then(|| create_mode & !host.umask()), owner: None, through: true })
		},
		// `-f`: remove a destination that cannot be opened, and try again.
		Err(_) if options.unlink_after_failed_open() && filesystem.symlink_metadata(&dest_fs).is_ok() => {
			delete_path(host, state, dest, options)?;
			let file = filesystem
				.open_with(&dest_fs, &dest_options)
				.map_err(cannot_create)?;
			(file, DestFate::Recreated)
		},
		Err(error) => return Err(cannot_create(error)),
	};

	// `always` gets here only with a source that is not a regular file (any
	// other was cloned by path above, or refused): GNU cp asks for the clone
	// on its descriptors here too, and reports the answer. A destination this
	// copy made is removed again; an existing one keeps its data, where GNU
	// cp has already truncated it.
	let always_cloned = if options.reflink_mode == ReflinkMode::Always {
		#[cfg(any(target_os = "linux", target_os = "android", windows))]
		let answer = match (source_file.native(), dest_file.native()) {
			(Some(source_native), Some(dest_native)) => pi_iso::cow::clone_open(source_native, dest_native),
			_ => Err(operation_not_supported()),
		};
		#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
		let answer: io::Result<()> = Err(operation_not_supported());
		if let Err(error) = answer {
			drop(dest_file);
			if dest_metadata.is_none() || fate == DestFate::Recreated {
				let _ = filesystem.remove_file(&dest_fs);
			}
			return Err(CpError::IoErrContext(
				error,
				format!("failed to clone {} from {}", dest.quote(), source.quote()),
			));
		}
		true
	} else {
		false
	};

	// Elsewhere `auto` clones on the open handles, as GNU cp issues FICLONE
	// on its descriptors, and copies the data wherever the files cannot
	// share extents (another filesystem, ext4, NTFS, ...). A source
	// filesystem that refused once is not asked again.
	#[cfg(any(target_os = "linux", target_os = "android", windows))]
	let cloned = match (source_file.native(), dest_file.native()) {
		_ if always_cloned => true,
		(Some(source_native), Some(dest_native))
			if native && !source_is_stream && options.reflink_mode == ReflinkMode::Auto =>
		{
			let device = source_metadata.dev();
			if device.is_some_and(|device| state.clone_unsupported.contains(&device)) {
				reflink_debug = OffloadReflinkDebug::Unsupported;
				false
			} else if let Err(error) = pi_iso::cow::clone_open(source_native, dest_native) {
				if pi_iso::cow::is_unsupported(&error)
					&& !pi_iso::cow::is_cross_device(&error)
					&& let Some(device) = device
				{
					state.clone_unsupported.insert(device);
				}
				reflink_debug = OffloadReflinkDebug::Unsupported;
				false
			} else {
				true
			}
		},
		_ => false,
	};
	#[cfg(not(any(target_os = "linux", target_os = "android", windows)))]
	let cloned = always_cloned;

	let copy_debug = if cloned {
		CopyDebug::CLONED
	} else if source_is_stream {
		let dest_is_stream = dest_file.metadata().is_ok_and(|metadata| is_stream(&metadata));
		if !dest_is_stream {
			dest_file.set_len(0).map_err(|e| {
				CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()))
			})?;
		}
		copy_stream_data(host, &source_file, &dest_file, source, dest)?;
		CopyDebug { offload: OffloadReflinkDebug::Avoided, ..CopyDebug::STREAMED }
	} else {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let fast = match (native, source_file.native(), dest_file.native(), source_metadata.native()) {
			(true, Some(source_native), Some(dest_native), Some(source_stat)) => {
				// Only a FIFO the open found, possibly through a symlink, is one.
				let dest_is_fifo = match dest_metadata {
					_ if fate != DestFate::Kept => false,
					Some(metadata) if metadata.is_symlink() => dest_native
						.metadata()
						.is_ok_and(|metadata| std::os::unix::fs::FileTypeExt::is_fifo(&metadata.file_type())),
					Some(metadata) => metadata.file_type().is_fifo(),
					None => false,
				};
				let copy_debug = linux::copy(
					source_native,
					dest_native,
					source_stat,
					dest_is_fifo,
					options.sparse_mode,
					options.debug && !options.attributes_only,
					source,
					dest,
				)?;
				Some(CopyDebug { reflink: reflink_debug, ..copy_debug })
			},
			_ => None,
		};
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let fast: Option<CopyDebug> = None;

		match fast {
			Some(copy_debug) => copy_debug,
			None => {
				copy_stream_data(host, &source_file, &dest_file, source, dest)?;
				CopyDebug { reflink: reflink_debug, ..CopyDebug::STREAMED }
			},
		}
	};

	// Preserving ownership changes it only where it differs; the open handle
	// tells a created file's owner cheaper than a chown that changes nothing,
	// and its actual mode with it. A default ACL on the parent replaces the
	// umask, so without that fstat the computed mode only stands where no
	// preserved mode relies on it to skip the chmod: a plain copy, like GNU
	// cp's, keeps whatever mode the open gave it.
	let fate = match fate {
		DestFate::Created { through, .. } if matches!(options.attributes.ownership, Preserve::Yes { .. }) => {
			match dest_file.metadata() {
				Ok(metadata) => DestFate::Created {
					mode: Some(metadata.permissions().mode() & 0o7777),
					owner: metadata.uid().zip(metadata.gid()),
					through,
				},
				Err(_) => DestFate::Created { mode: None, owner: None, through },
			}
		},
		DestFate::Created { owner, through, .. } if matches!(options.attributes.mode, Preserve::Yes { .. }) => {
			DestFate::Created { mode: None, owner, through }
		},
		fate => fate,
	};
	drop(source_file);
	dest_file
		.close()
		.map_err(|e| CpError::IoErrContext(e, format!("failed to close {}", dest.quote())))?;
	Ok((copy_debug, fate))
}

/// Generate an error message if `target` is not the correct `target_type`
fn verify_target_type(host: &Host, target: &Path, target_type: TargetType) -> CopyResult<()> {
	match (target_type, host.fs().metadata(host.resolve(target))) {
		(TargetType::Directory, Ok(metadata)) if !metadata.is_dir() => Err(CpError::IoErrContext(
			pi_vfs::not_a_directory(),
			format!("target {}", target.quote()),
		)),
		(TargetType::Directory, Err(error)) => {
			Err(CpError::IoErrContext(error, format!("target {}", target.quote())))
		},
		(TargetType::File, Ok(metadata)) if metadata.is_dir() => Err(CpError::Error(format!(
			"cannot overwrite directory {} with non-directory",
			target.quote()
		))),
		_ => Ok(()),
	}
}

/// Get the total size of a slice of files and directories, like `du`.
///
/// Files are not deduplicated when appearing in multiple sources, and
/// directories only count when copying recursively. Unreadable entries count
/// as empty; the copy itself reports them.
fn disk_usage(host: &Host, paths: &[PathBuf], recursive: bool) -> u64 {
	let filesystem = host.fs();
	paths
		.iter()
		.map(|path| {
			let resolved = host.resolve(path);
			match filesystem.metadata(&resolved) {
				Ok(metadata) if metadata.is_dir() => {
					if recursive { disk_usage_directory(host, &resolved) } else { 0 }
				},
				Ok(metadata) => metadata.len(),
				Err(_) => 0,
			}
		})
		.sum()
}

/// A helper for `disk_usage` specialized for directories.
fn disk_usage_directory(host: &Host, path: &Path) -> u64 {
	let Ok(entries) = host.fs().read_dir(path) else {
		return 0;
	};
	entries
		.flatten()
		.map(|entry| {
			if host.is_cancelled() {
				return 0;
			}
			match entry.metadata() {
				Ok(metadata) if metadata.is_dir() => disk_usage_directory(host, &entry.path()),
				Ok(metadata) => metadata.len(),
				Err(_) => 0,
			}
		})
		.sum()
}

/// Traversal state of one `cp -r` operand.
struct Walk<'a> {
	options:   &'a Options,
	/// Device of the operand, for `-x`.
	root_dev:  Option<u64>,
	/// Identities of the directories being copied, outermost first.
	ancestors: Vec<FileId>,
	/// Whether an entry failed after its diagnostic was printed.
	failed:    bool,
}

impl Walk<'_> {
	/// Whether to descend into the directory `source`: not across a `-x`
	/// filesystem boundary, and not into one of its own ancestors (reachable
	/// through a followed symlink). `Some(true)` when its identity was pushed
	/// onto [`Walk::ancestors`], to be popped once its contents are copied.
	fn enter(&mut self, host: &mut Host, source: &Path, is_root: bool) -> Option<bool> {
		let Ok(metadata) = host.fs().metadata(host.resolve(source)) else {
			return Some(false);
		};
		if !is_root
			&& self.options.one_file_system
			&& let (Some(root_dev), Some(dev)) = (self.root_dev, metadata.dev())
			&& root_dev != dev
		{
			return None;
		}
		let Some(id) = metadata.file_id() else {
			return Some(false);
		};
		if self.ancestors.contains(&id) {
			show_error(host, format_args!("{}: file system loop detected", source.quote()));
			self.failed = true;
			return None;
		}
		self.ancestors.push(id);
		Some(true)
	}
}

/// Read the contents of the directory `root` and recursively copy the
/// contents to `target`.
///
/// Errors inside the tree are reported and the traversal continues, as GNU
/// cp does; the operand then fails as a whole.
fn copy_directory(
	host: &mut Host,
	state: &mut CopyState,
	root: &Path,
	target: &Path,
	options: &Options,
) -> CopyResult<()> {
	if !options.recursive {
		return Err(CpError::Error(format!(
			"-r not specified; omitting directory {}",
			root.quote()
		)));
	}

	let filesystem = host.fs().clone();

	// If in `--parents` mode, create all the necessary ancestor directories.
	//
	// For example, if the command is `cp --parents a/b/c d`, that
	// means we need to copy the two ancestor directories first:
	//
	// a -> d/a
	// a/b -> d/a/b
	let target: PathBuf = match parent_path(root) {
		Some(parent) if options.parents && !parent.is_empty() => {
			make_parent_dirs(host, state, root, &join_path(target, &parents_relative(root)), options)?;
			join_path(target, &parents_relative(parent))
		},
		_ => target.to_path_buf(),
	};

	// The copy of `root`: `target` itself, unless it is an existing directory
	// the copy goes into (`dir/.` into `target/.`, the contents). `-T` copies
	// the contents into `target`.
	let root_dest = match filesystem.metadata(host.resolve(&target)) {
		Ok(metadata) if !metadata.is_dir() => {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				target.quote(),
				root.quote()
			)));
		},
		Ok(_) if !options.no_target_dir => {
			if root == "." || root.as_os_str().as_encoded_bytes().ends_with(b"/.") {
				child_path(&target, std::ffi::OsStr::new("."))
			} else {
				match file_name(root) {
					Some(name) => child_path(&target, &name),
					None => target.clone(),
				}
			}
		},
		_ => target.clone(),
	};

	// check if root is a prefix of target
	let logical = CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Logical);
	if let (Ok(root_canonical), Ok(dest_canonical)) = (
		filesystem.canonicalize_with(host.resolve(root), &logical),
		filesystem.canonicalize_with(host.resolve(&root_dest), &logical),
	) {
		if root_canonical == dest_canonical {
			return Err(CpError::Error(format!(
				"{} and {} are the same file",
				root.quote(),
				root_dest.quote()
			)));
		}
		if dest_canonical.starts_with(&root_canonical) {
			return Err(CpError::Error(format!(
				"cannot copy a directory, {}, into itself, {}",
				root.quote(),
				root_dest.quote()
			)));
		}
	}

	let mut walk = Walk {
		options,
		root_dev: filesystem
			.metadata(host.resolve(root))
			.ok()
			.and_then(|metadata| metadata.dev()),
		ancestors: Vec::new(),
		failed: false,
	};
	copy_entry(host, state, &mut walk, root, &root_dest, true)?;

	// Also fix permissions for parent directories,
	// if we were asked to create them.
	if options.parents
		&& let Some(name) = file_name(root)
	{
		let dest = child_path(&target, &name);
		for (x, y) in aligned_ancestors(root, &dest) {
			if let Ok(src) = filesystem.canonicalize_with(
				host.resolve(&x),
				&CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Physical),
			) {
				copy_attributes(
					host,
					&src,
					&y,
					&options.attributes,
					false,
					true,
					options.set_selinux_context,
					None,
					DestFacts::default(),
				)?;
			}
		}
	}

	if walk.failed { Err(CpError::NotAllFilesCopied) } else { Ok(()) }
}

/// Copies one entry of a directory tree: a directory recursively (fixing its
/// attributes once its contents are in place), anything else as a file.
fn copy_entry(
	host: &mut Host,
	state: &mut CopyState,
	walk: &mut Walk<'_>,
	source: &Path,
	dest: &Path,
	is_root: bool,
) -> CopyResult<()> {
	let options = walk.options;
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let metadata = filesystem
		.symlink_metadata(&source_fs)
		.map_err(|e| CpError::IoErrContext(e, format!("cannot stat {}", source.quote())))?;
	let entry_is_symlink = metadata.is_symlink();
	// The operand itself was already judged a directory to copy.
	let source_is_dir = if is_root {
		true
	} else if entry_is_symlink {
		options.dereference && filesystem.is_dir(&source_fs)
	} else {
		metadata.is_dir()
	};

	if !source_is_dir {
		return copy_file(host, state, source, dest, options, false, Some(metadata));
	}

	let created = match filesystem.metadata(host.resolve(dest)) {
		Err(_) => {
			build_dir(host, dest, false, options, Some(source))?;
			// `mv` reports a moved operand itself, once its source is gone.
			if options.verbose && !(is_root && options.move_mode) {
				print_verbose_output(host, state, options, source, dest, None);
			}
			true
		},
		Ok(existing) if !existing.is_dir() => {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				dest.quote(),
				source.quote()
			)));
		},
		Ok(_) => false,
	};

	if let Some(pushed) = walk.enter(host, source, is_root) {
		match filesystem.read_dir(&source_fs) {
			Err(error) => {
				show_error(host, CpError::IoErrContext(error, format!("cannot access {}", source.quote())));
				walk.failed = true;
			},
			Ok(entries) => {
				for entry in entries {
					if host.is_cancelled() {
						walk.failed = true;
						break;
					}
					let entry = match entry {
						Ok(entry) => entry,
						Err(error) => {
							show_error(
								host,
								CpError::IoErrContext(error, format!("cannot access {}", source.quote())),
							);
							walk.failed = true;
							continue;
						},
					};
					let name = entry.file_name();
					let child_source = child_path(source, &name);
					let child_dest = child_path(dest, &name);
					if let Err(error) = copy_entry(host, state, walk, &child_source, &child_dest, false) {
						show_error_if_needed(host, &error);
						if !matches!(error, CpError::Skipped(false)) {
							walk.failed = true;
						}
					}
				}
			},
		}
		if pushed {
			walk.ancestors.pop();
		}
	}

	// Directories are created without some permissions so nobody can use
	// them before they are ready; now that the contents are in place, give
	// the directory its final attributes.
	// The entry's lstat is its followed stat unless it is a symlink.
	copy_attributes(
		host,
		source,
		dest,
		&options.attributes,
		created && options.copy_mode != CopyMode::Link,
		true,
		options.set_selinux_context,
		(!entry_is_symlink).then_some(&metadata),
		DestFacts { symlink: created.then_some(false), ..DestFacts::default() },
	)
}

/// Builds a directory at the specified path with the given options.
///
/// If `copy_attributes_from` is `Some`, the new directory's mode starts from
/// that file's; otherwise from the umask. Group/other permissions are held
/// back while ownership or mode could still change (see
/// `test_dir_perm_race_with_preserve_mode_and_ownership`), and the owner
/// write bit is kept so the contents can be copied in; the final attributes
/// are applied afterwards. `recursive` creates missing parents too.
fn build_dir(
	host: &mut Host,
	path: &Path,
	recursive: bool,
	options: &Options,
	copy_attributes_from: Option<&Path>,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let mut excluded_perms = if matches!(options.attributes.ownership, Preserve::Yes { .. }) {
		0o077 // exclude rwx for group and other
	} else if matches!(options.attributes.mode, Preserve::Yes { .. }) {
		0o022 // exclude w for group and other
	} else {
		0
	};

	excluded_perms |= match (copy_attributes_from, options.attributes.mode) {
		(Some(from), Preserve::Yes { .. }) => {
			!filesystem
				.symlink_metadata(host.resolve(from))?
				.permissions()
				.mode()
		},
		_ => host.umask(),
	};

	let mode = (!excluded_perms & 0o777) | 0o200;
	filesystem
		.create_dir_with(host.resolve(path), &DirOptions::new().recursive(recursive).mode(mode))
		.map_err(|e| CpError::IoErrContext(e, format!("cannot create directory {}", path.quote())))
}

/// Native Linux data copies after a declined or failed clone:
/// `copy_file_range` (through `io::copy`) and `SEEK_DATA`/`SEEK_HOLE` sparse
/// copies on already opened descriptors.
#[cfg(any(target_os = "linux", target_os = "android"))]
mod linux {
	use std::{
		fs::{File, Metadata},
		io::{self, Read as _, Seek as _, SeekFrom},
		os::{
			fd::AsRawFd as _,
			unix::fs::{FileExt as _, MetadataExt as _},
		},
		path::Path,
	};

	use super::{
		CopyDebug, CopyResult, CpError, OffloadReflinkDebug, SparseDebug, SparseMode, context_for,
	};

	/// Debug report of a copy whose source could not be inspected.
	const UNDETECTED: CopyDebug = CopyDebug {
		offload:          OffloadReflinkDebug::Unknown,
		reflink:          OffloadReflinkDebug::No,
		sparse_detection: SparseDebug::No,
	};

	/// Type of method used for copying files
	#[derive(Clone, Copy)]
	enum CopyMethod {
		/// Do a sparse copy
		SparseCopy,
		/// Use a plain kernel copy.
		FSCopy,
		/// Default (can either be [`CopyMethod::SparseCopy`] or
		/// [`CopyMethod::FSCopy`])
		Default,
		/// Use [`sparse_copy_without_hole`]
		SparseCopyWithoutHole,
	}

	/// Copies all of `source` into `dest` from their current offsets;
	/// `io::copy` uses `copy_file_range`/`sendfile` between files.
	fn fs_copy(source: &File, dest: &File) -> io::Result<()> {
		io::copy(&mut &*source, &mut &*dest).map(drop)
	}

	/// Whether `source`, described by `metadata`, holds any data: `(has data,
	/// size, allocated blocks)`, blocks counted as none for an empty file. The
	/// file offset is left at the start.
	fn check_for_data(source: &File, metadata: &Metadata) -> io::Result<(bool, u64, u64)> {
		let size = metadata.size();
		let blocks = metadata.blocks();
		// checks edge case of virtual files in /proc which have a size of zero
		// but contains data
		if size == 0 {
			let mut buf = vec![0; usize::try_from(metadata.blksize()).unwrap_or(4096)];
			let read = source.read_at(&mut buf, 0)?;
			return Ok((buf[..read].iter().any(|&x| x != 0x0), size, 0));
		}

		// SAFETY: plain `lseek` on a live descriptor.
		let result = unsafe { libc::lseek(source.as_raw_fd(), 0, libc::SEEK_DATA) };
		let error = io::Error::last_os_error();
		(&*source).seek(SeekFrom::Start(0))?;

		match result {
			-1 => Ok((false, size, blocks)), // No data found or end of file
			0.. => Ok((true, size, blocks)), // Data found
			_ => Err(error),
		}
	}

	/// Converts a byte offset for `lseek`/`pread`.
	fn offset(value: u64) -> io::Result<libc::off_t> {
		libc::off_t::try_from(value).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
	}

	/// Optimized [`sparse_copy`] doesn't create holes for large sequences of
	/// zeros in non `sparse_files` Used when `--sparse=auto`
	fn sparse_copy_without_hole(source: &File, dest: &File) -> io::Result<()> {
		let size = source.metadata()?.size();
		dest.set_len(size)?;
		let src_fd = source.as_raw_fd();
		// Maximize the data read at once to 16 MiB to avoid memory hogging with
		// large files; 16 MiB chunks should saturate an SSD
		let step = usize::try_from(size.min(16 * 1024 * 1024)).unwrap_or(16 * 1024 * 1024);
		let mut buf: Vec<u8> = vec![0x0; step];
		let mut current: libc::off_t = 0;
		loop {
			// SAFETY: plain `lseek` on a live descriptor.
			let data = unsafe { libc::lseek(src_fd, current, libc::SEEK_DATA) };
			if data < 0 {
				break;
			}
			// SAFETY: plain `lseek` on a live descriptor.
			let hole = unsafe { libc::lseek(src_fd, data, libc::SEEK_HOLE) };
			if hole < 0 {
				break;
			}
			let mut position = u64::try_from(data).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			let end = u64::try_from(hole).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			// Read and write data in chunks of `step` while reusing the same
			// buffer
			while position < end {
				let len = usize::try_from(end - position).map_or(step, |len| len.min(step));
				let chunk = &mut buf[..len];
				source.read_exact_at(chunk, position)?;
				dest.write_all_at(chunk, position)?;
				position += u64::try_from(len).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			}
			current = offset(end)?;
		}
		Ok(())
	}

	/// Perform a sparse copy from one file to another.
	/// Creates a holes for large sequences of zeros in `non_sparse_files`,
	/// used for `--sparse=always`
	fn sparse_copy(source: &File, dest: &File) -> io::Result<()> {
		let size = source.metadata()?.size();
		dest.set_len(size)?;

		let blksize = usize::try_from(dest.metadata()?.blksize()).unwrap_or(4096).max(1);
		let mut buf: Vec<u8> = vec![0; blksize];
		let mut current: u64 = 0;

		while current < size {
			let this_read = (&*source).read(&mut buf)?;
			if this_read == 0 {
				break;
			}
			let buf = &buf[..this_read];
			if buf.iter().any(|&x| x != 0) {
				dest.write_all_at(buf, current)?;
			}
			current += u64::try_from(this_read).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
		}
		Ok(())
	}

	/// Copies the native file `source`, whose stat is `metadata`, into the
	/// freshly truncated `dest`, making holes per `sparse_mode`. The report's
	/// `reflink` is `No`; the caller accounts for its own clone attempt.
	/// Without `report`, the data is only looked for where the copy needs it.
	pub(super) fn copy(
		source: &File,
		dest: &File,
		metadata: &Metadata,
		dest_is_fifo: bool,
		sparse_mode: SparseMode,
		report: bool,
		source_path: &Path,
		dest_path: &Path,
	) -> CopyResult<CopyDebug> {
		let (copy_debug, result) = match sparse_mode {
			SparseMode::Always => {
				let (debug, method) = detect_sparse_always(source, metadata, dest_is_fifo).unwrap_or((
					CopyDebug { sparse_detection: SparseDebug::Zeros, ..UNDETECTED },
					CopyMethod::Default,
				));
				let result = match method {
					CopyMethod::FSCopy => fs_copy(source, dest),
					_ => sparse_copy(source, dest),
				};
				(debug, result)
			},
			SparseMode::Never => {
				let debug = if report {
					detect_sparse_never(source, metadata).unwrap_or(UNDETECTED)
				} else {
					UNDETECTED
				};
				(debug, fs_copy(source, dest))
			},
			SparseMode::Auto => {
				let (debug, method) = detect_sparse_auto(source, metadata, dest_is_fifo, report)
					.unwrap_or((UNDETECTED, CopyMethod::Default));
				let result = match method {
					CopyMethod::SparseCopyWithoutHole => sparse_copy_without_hole(source, dest),
					_ => fs_copy(source, dest),
				};
				(debug, result)
			},
		};
		result.map_err(|e| CpError::IoErrContext(e, context_for(source_path, dest_path)))?;
		Ok(copy_debug)
	}

	/// Debug report for `--sparse=never`.
	fn detect_sparse_never(source: &File, metadata: &Metadata) -> io::Result<CopyDebug> {
		let mut copy_debug = UNDETECTED;
		let (data_flag, size, _blocks) = check_for_data(source, metadata)?;

		if metadata.blocks() < metadata.size() / 512 {
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		Ok(copy_debug)
	}

	/// Debug report and copy method for `--sparse=auto`.
	fn detect_sparse_auto(
		source: &File,
		metadata: &Metadata,
		dest_is_fifo: bool,
		report: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let sparse_flag = metadata.blocks() < metadata.size() / 512;
		// Only a sparse file is copied by where its data is.
		if !sparse_flag && !report {
			return Ok((UNDETECTED, CopyMethod::Default));
		}

		let mut copy_debug = UNDETECTED;
		let mut copy_method = CopyMethod::Default;
		let (data_flag, size, blocks) = check_for_data(source, metadata)?;

		if (data_flag && size != 0) || (size > 0 && size < 512) {
			copy_debug.offload = OffloadReflinkDebug::Yes;
		}

		if data_flag && size == 0 {
			// Handling /proc/ files
			copy_debug.offload = OffloadReflinkDebug::Unsupported;
		}
		if sparse_flag {
			if blocks == 0 && data_flag {
				// Handling other "virtual" files
				copy_debug.offload = OffloadReflinkDebug::Unsupported;

				copy_method = CopyMethod::FSCopy; // Doing a standard copy for the virtual files
			} else {
				copy_method = CopyMethod::SparseCopyWithoutHole;
			} // Since sparse_flag is true, sparse_detection shall be SeekHole for any non
			// virtual regular sparse file and the file will be sparsely copied
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}
		Ok((copy_debug, copy_method))
	}

	/// Debug report and copy method for `--sparse=always`.
	fn detect_sparse_always(
		source: &File,
		metadata: &Metadata,
		dest_is_fifo: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let mut copy_debug = CopyDebug { sparse_detection: SparseDebug::Zeros, ..UNDETECTED };
		let mut copy_method = CopyMethod::SparseCopy;

		let (data_flag, size, blocks) = check_for_data(source, metadata)?;
		let sparse_flag = metadata.blocks() < metadata.size() / 512;

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		match (sparse_flag, data_flag, blocks) {
			(true, true, 0) => {
				// Handling funny files with 0 block allocation but has data
				// in it, e.g. files in /sys and other virtual files
				copy_method = CopyMethod::FSCopy;
				copy_debug.sparse_detection = SparseDebug::SeekHoleZeros;
			},
			// Handling data containing zero sized files in /proc
			(false, true, 0) => copy_method = CopyMethod::FSCopy,
			// Handles files with 0 blocks allocated in disk
			(true, false, 0) => copy_debug.sparse_detection = SparseDebug::SeekHole,
			// Any sparse_files with data in it will display SeekHoleZeros
			(true, true, _) => copy_debug.sparse_detection = SparseDebug::SeekHoleZeros,
			(true, false, _) => {
				copy_debug.offload = OffloadReflinkDebug::Unknown;
				copy_debug.sparse_detection = SparseDebug::SeekHole;
			},

			(_, _, _) => (),
		}
		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}

		Ok((copy_debug, copy_method))
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		time::{Duration, SystemTime},
	};

	use tempfile::tempdir;

	use super::Cp;
	use crate::host::run_util;

	#[test]
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
	fn clone_overwrite_keeps_destination_mode_and_hard_links() {
		use std::os::unix::fs::PermissionsExt as _;

		let fixture = tempdir().unwrap();
		let path = |name: &str| fixture.path().join(name);
		fs::write(path("source"), b"new").unwrap();
		fs::write(path("private"), b"old").unwrap();
		fs::set_permissions(path("private"), fs::Permissions::from_mode(0o600)).unwrap();
		fs::write(path("linked"), b"old").unwrap();
		fs::hard_link(path("linked"), path("alias")).unwrap();

		for dest in ["private", "linked"] {
			let (code, capture) = run_util::<Cp>(&["-c", "source", dest], "", fixture.path());
			assert_eq!(code, 0, "{}", capture.err());
		}

		// A clone swapped in for `private` must still pass for an in-place copy.
		assert_eq!(fs::read(path("private")).unwrap(), b"new");
		assert_eq!(fs::metadata(path("private")).unwrap().permissions().mode() & 0o777, 0o600);
		// A hard-linked destination cannot be swapped; every link sees the data.
		assert_eq!(fs::read(path("alias")).unwrap(), b"new");
		let mut names: Vec<_> = fs::read_dir(fixture.path())
			.unwrap()
			.map(|entry| entry.unwrap().file_name())
			.collect();
		names.sort();
		assert_eq!(names, ["alias", "linked", "private", "source"], "no temporary clone is left");
	}

	/// `cp --reflink=always` reports the answer of the clone itself, as GNU
	/// cp 9.4 and 9.7 do (`failed to clone 'b' from 'a': ` and its error
	/// text), and leaves no `b` behind: in one directory, whatever `FICLONE`
	/// answers there (a clone on XFS or btrfs, "Operation not supported" on
	/// tmpfs, ext4 or an overlayfs that cannot clone), from `/dev/shm` into
	/// the temporary directory where they are two filesystems, "Invalid
	/// cross-device link" on Linux, and from `/dev/null`, which GNU cp tries
	/// to clone too rather than copy (gVisor answers "Operation not
	/// supported" to every clone, and GNU cp prints that there). An existing
	/// `b` keeps its data, where GNU cp has truncated it. With a backup
	/// (`-b`, `--backup=numbered`, `-f -b`), `b` is renamed to its backup
	/// name before the clone, and a failed clone renames it back, as GNU's
	/// `un_backup` does (`-v` says so). With `-f`, a socket at `b`, which
	/// cannot be opened, is removed first and the new `b` removed after a
	/// failed clone, as GNU removes them.
	#[test]
	#[cfg(target_os = "linux")]
	fn reflink_always_reports_the_clones_own_answer() {
		use std::os::unix::fs::MetadataExt as _;

		/// What is at `b` before cp runs.
		#[derive(Clone, Copy, PartialEq)]
		enum Before {
			Nothing,
			Old,
			Socket,
		}

		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("a"), b"A").unwrap();
		let shm = tempfile::tempdir_in("/dev/shm").ok();
		let mut sources = vec![
			("one directory", fixture.path().join("a"), &b"A"[..]),
			("a character device", std::path::PathBuf::from("/dev/null"), &b""[..]),
		];
		let device = |path: &std::path::Path| fs::metadata(path).unwrap().dev();
		match &shm {
			Some(shm) if device(shm.path()) != device(fixture.path()) => {
				fs::write(shm.path().join("a"), b"A").unwrap();
				sources.push(("two filesystems", shm.path().join("a"), &b"A"[..]));
			},
			_ => eprintln!("skipped: /dev/shm and the temporary directory are not two filesystems"),
		}
		// The options, what is at `b` before, and the backup name cp makes.
		let ways: [(&[&str], Before, Option<&str>); 7] = [
			(&[], Before::Nothing, None),
			(&[], Before::Old, None),
			(&["-b"], Before::Old, Some("b~")),
			(&["--backup=numbered"], Before::Old, Some("b.~1~")),
			(&["-f", "-b"], Before::Old, Some("b~")),
			(&["-v", "-b"], Before::Old, Some("b~")),
			(&["-f"], Before::Socket, None),
		];
		for (case, source, data) in sources {
			// What `FICLONE` answers for this pair, asked on a probe file.
			let probe = fixture.path().join("probe");
			let answer = pi_iso::cow::clone_open(
				&fs::File::open(&source).unwrap(),
				&fs::OpenOptions::new().write(true).create_new(true).open(&probe).unwrap(),
			);
			fs::remove_file(&probe).unwrap();
			let shown = if case == "one directory" { "a".to_owned() } else { source.display().to_string() };
			let dest = fixture.path().join("b");
			for (flags, before, backup) in ways {
				// The socket row covers the stream path's `-f` removal; a
				// regular source is cloned by path.
				if before == Before::Socket && case != "a character device" {
					continue;
				}
				let case = format!("{case}, cp {}", flags.join(" "));
				match before {
					Before::Nothing => {},
					Before::Old => fs::write(&dest, b"old").unwrap(),
					Before::Socket => drop(std::os::unix::net::UnixListener::bind(&dest).unwrap()),
				}
				let mut argv = flags.to_vec();
				argv.extend(["--reflink=always", shown.as_str(), "b"]);
				let (code, capture) = run_util::<Cp>(&argv, "", fixture.path());
				eprintln!("{case}: cp exits {code}: {:?}", capture.err());
				let backup_path = backup.map(|name| fixture.path().join(name));
				let verbose = |tail: &str| {
					if flags.contains(&"-v") {
						format!("'{shown}' -> 'b' (backup: '{}'){tail}\n", backup.unwrap())
					} else {
						String::new()
					}
				};
				match &answer {
					Ok(()) => {
						assert_eq!((code, capture.err()), (0, String::new()), "{case}");
						assert_eq!(capture.out(), verbose(""), "{case}");
						assert_eq!(fs::read(&dest).unwrap(), data, "{case}");
						if let Some(backup_path) = &backup_path {
							assert_eq!(fs::read(backup_path).unwrap(), b"old", "{case}: the backup");
						}
					},
					Err(error) => {
						let message =
							format!("cp: failed to clone 'b' from '{shown}': {}\n", crate::host::strip_errno(error));
						assert_eq!((code, capture.err()), (1, message), "{case}");
						assert_eq!(capture.out(), verbose("\n'b~' -> 'b' (unbackup)"), "{case}");
						match before {
							Before::Nothing | Before::Socket => assert!(
								fs::symlink_metadata(&dest).is_err(),
								"{case}: the failed clone left b"
							),
							Before::Old => assert_eq!(
								fs::read(&dest).ok().as_deref(),
								Some(&b"old"[..]),
								"{case}: b lost its data"
							),
						}
						if let Some(backup_path) = &backup_path {
							assert!(!backup_path.exists(), "{case}: b is left under its backup name");
						}
					},
				}
				let _ = fs::remove_file(&dest);
				if let Some(backup_path) = &backup_path {
					let _ = fs::remove_file(backup_path);
				}
			}
		}
	}

	/// The backup is put back only where cp failed to create `b`, as GNU's
	/// `un_backup` does (`copy.c`), as GNU 9.4 and 9.7 do as uid 1000 and
	/// root:
	/// - a copy that works leaves the new `b` and the old data in `b~`;
	/// - with `--preserve=links` (`-a`), the second name of a file is a hard
	///   link to the first copy; where that link fails (here across
	///   filesystems, `--parents` going through a link to `/dev/shm`), `b`
	///   comes back with its data and no `b~` is left;
	/// The rename back that fails is
	/// [`a_rename_back_that_fails_is_reported_after_the_copy`].
	#[test]
	#[cfg(target_os = "linux")]
	fn a_failed_copy_puts_the_backup_back() {
		use std::os::unix::fs::MetadataExt as _;

		let fixture = tempdir().unwrap();
		let path = |name: &str| fixture.path().join(name);

		// A copy that works.
		fs::write(path("a"), b"A").unwrap();
		fs::write(path("b"), b"old").unwrap();
		let (code, capture) = run_util::<Cp>(&["-b", "--reflink=auto", "a", "b"], "", fixture.path());
		assert_eq!((code, capture.err()), (0, String::new()), "a copy that works");
		assert_eq!(fs::read(path("b")).unwrap(), b"A", "the copy is at b");
		assert_eq!(fs::read(path("b~")).unwrap(), b"old", "the old data is in b~");

		// The hard link `--preserve=links` makes fails across filesystems.
		let shm = tempfile::tempdir_in("/dev/shm").ok();
		let device = |path: &std::path::Path| fs::metadata(path).unwrap().dev();
		match &shm {
			Some(shm) if device(shm.path()) != device(fixture.path()) => {
				fs::write(path("x"), b"X").unwrap();
				fs::create_dir(path("m")).unwrap();
				fs::hard_link(path("x"), path("m/y")).unwrap();
				fs::create_dir(path("t")).unwrap();
				std::os::unix::fs::symlink(shm.path(), path("t/m")).unwrap();
				fs::write(shm.path().join("y"), b"old").unwrap();
				let (code, capture) =
					run_util::<Cp>(&["--parents", "-a", "-b", "x", "m/y", "t"], "", fixture.path());
				assert_eq!(
					(code, capture.err()),
					(1, "cp: cannot create hard link 't/m/y' to 't/x': Invalid cross-device link\n".to_owned()),
					"the hard link across filesystems"
				);
				assert_eq!(fs::read(shm.path().join("y")).ok().as_deref(), Some(&b"old"[..]), "y lost its data");
				assert!(!shm.path().join("y~").exists(), "y is left under its backup name");
			},
			_ => eprintln!("skipped: /dev/shm and the temporary directory are not two filesystems"),
		}
	}


	/// Where the rename back fails too, as GNU 9.4 and 9.7 do as uid 1000 and
	/// root, on runc and gVisor: once cp has renamed `b` to `b~` and waits for
	/// the FIFO's writer, a directory is made at `b`. The new `b` is created
	/// with O_EXCL, as GNU creates it after a backup, so its error is "File
	/// exists" (a create that read the name again would see the directory and
	/// say "Is a directory"); then `cannot un-backup 'b'`, and `b~` keeps the
	/// data. Its own test, so the root arm of the Jobs runs it by name.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_rename_back_that_fails_is_reported_after_the_copy() {
		let dir = tempdir().unwrap();
		let fifo = dir.path().join("p");
		let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `fifo_name` is NUL-terminated and outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o644) }, 0, "mkfifo");
		fs::write(dir.path().join("b"), b"old").unwrap();
		let cwd = dir.path().to_owned();
		let copy = std::thread::spawn(move || {
			let (code, capture) = run_util::<Cp>(&["-v", "-b", "p", "b"], "", &cwd);
			(code, capture.err(), capture.out())
		});
		// cp renames `b` before it opens the FIFO, whose open waits for a
		// writer. No writer is opened until the directory is at `b`: it would
		// let cp go on. A cp that waits on the FIFO before the backup is seen
		// waiting in the kernel (`fifo_open`), and fails the row.
		let waits_on_a_fifo = || {
			fs::read_dir("/proc/self/task").into_iter().flatten().flatten().any(|task| {
				fs::read_to_string(task.path().join("wchan")).is_ok_and(|wchan| wchan.trim() == "fifo_open")
			})
		};
		while !dir.path().join("b~").exists() {
			if waits_on_a_fifo() && !dir.path().join("b~").exists() {
				fs::write(&fifo, b"F").unwrap();
				let _ = copy.join();
				panic!("cp opened the FIFO before it backed b up");
			}
			assert!(!copy.is_finished(), "cp ended before it backed b up");
			std::thread::yield_now();
		}
		fs::create_dir(dir.path().join("b")).unwrap();
		// cp may fail at `b` and close the FIFO before the write lands
		// (EPIPE); the row is decided by what cp did, not by the write.
		let _ = fs::write(&fifo, b"F");
		let (code, err, out) = copy.join().unwrap();
		assert_eq!(
			(code, err.as_str()),
			(1, "cp: cannot create regular file 'b': File exists\ncp: cannot un-backup 'b': Is a directory\n"),
			"the rename back fails"
		);
		assert_eq!(out, "'p' -> 'b' (backup: 'b~')\n");
		assert!(dir.path().join("b").is_dir(), "the directory made at b stays");
		assert_eq!(fs::read(dir.path().join("b~")).unwrap(), b"old", "b~ keeps the data");
	}


	/// A backup that leaves the destination's name in place, as GNU 9.4 and
	/// 9.7 answer it as uid 1000 and as root: a copy backup (pi backs up by
	/// copy where the source leads to the destination's own file) keeps the
	/// file there to be replaced, so `cp -P -f -b l a`, `l` a link to `a`,
	/// makes `a` the link and `a~` the data, with `-R` and with
	/// `--remove-destination` too, and without `-f` (`-P -b`, `-R -b`). A
	/// backup renamed onto another link of the same file does nothing on
	/// Linux, and GNU still takes the name as new: the link replaces it only
	/// under `-f`, and without `-f` the copy fails with "File exists" and keeps
	/// both names. Where the kernel's rename removes the name instead (gVisor
	/// on its overlay root), GNU makes the link in every case, so the rows
	/// expect what the kernel's rename does, probed first.
	#[test]
	#[cfg(unix)]
	fn a_backup_that_leaves_the_name_is_replaced_as_gnu_does() {
		let shown = |dir: &std::path::Path| {
			let mut names: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect();
			names.sort();
			names
				.iter()
				.map(|name| {
					let path = dir.join(name);
					let name = name.to_string_lossy();
					match fs::read_link(&path) {
						Ok(target) => format!("{name}=link:{}", target.display()),
						Err(_) => {
							use std::os::unix::fs::MetadataExt as _;
							let links = fs::metadata(&path).unwrap().nlink();
							format!("{name}={}#{links}", fs::read_to_string(&path).unwrap())
						},
					}
				})
				.collect::<Vec<_>>()
				.join(" ")
		};
		// Whether a rename onto another link of the same file removes the old
		// name here (it does nothing on Linux; gVisor's overlay removes it).
		let probe = tempdir().unwrap();
		fs::write(probe.path().join("x"), b"x").unwrap();
		fs::hard_link(probe.path().join("x"), probe.path().join("y")).unwrap();
		fs::rename(probe.path().join("x"), probe.path().join("y")).unwrap();
		let rename_removes = !probe.path().join("x").exists();
		// (arguments, setup with `dest~` another link of `dest`, exit, stderr, entries after)
		let rows: [(&[&str], bool, i32, &str, &str); 10] = [
			(&["-P", "-f", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-P", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-R", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-R", "-f", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-P", "--remove-destination", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-P", "-f", "--remove-destination", "-b", "l", "a"], false, 0, "", "a=link:a a~=A#1 l=link:a"),
			(&["-P", "-fb", "l", "dest"], true, 0, "", "a=A#1 dest=link:a dest~=old#1 l=link:a"),
			(&["-R", "-fb", "l", "dest"], true, 0, "", "a=A#1 dest=link:a dest~=old#1 l=link:a"),
			(
				&["-P", "-b", "l", "dest"],
				true,
				1,
				"cp: cannot create symbolic link 'dest': File exists\n",
				"a=A#1 dest=old#2 dest~=old#2 l=link:a",
			),
			(
				&["-P", "--remove-destination", "-b", "l", "dest"],
				true,
				1,
				"cp: cannot create symbolic link 'dest': File exists\n",
				"a=A#1 dest=old#2 dest~=old#2 l=link:a",
			),
		];
		for (args, linked_backup, code, err, after) in rows {
			let (code, err, after) = if linked_backup && rename_removes {
				(0, "", "a=A#1 dest=link:a dest~=old#1 l=link:a")
			} else {
				(code, err, after)
			};
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			if linked_backup {
				fs::write(dir.path().join("dest"), b"old").unwrap();
				fs::hard_link(dir.path().join("dest"), dir.path().join("dest~")).unwrap();
			}
			let (got, capture) = run_util::<Cp>(args, "", dir.path());
			let case = args.join(" ");
			assert_eq!((got, capture.err()), (code, err.to_owned()), "cp {case}");
			assert_eq!(shown(dir.path()), after, "cp {case}");
		}
	}

	/// A name that appears at the destination while cp copies is kept, as GNU
	/// 9.4 and 9.7 keep it as uid 1000 and as root. With `-f -b p b`, `p` a
	/// FIFO and `b` holding `old`, cp renames `b` to `b~` and then waits for
	/// the FIFO's writer; a file or a link to nothing is made at `b` meanwhile.
	/// The exclusive create fails on it: "File exists", or "not writing
	/// through dangling symlink" for the link, `-f` or not (its
	/// remove-and-retry is only for a destination cp found), and the backup
	/// is put back over it. Under POSIXLY_CORRECT cp writes through the link,
	/// and the file it makes there has the source's permissions (604 for a
	/// FIFO of mode 604, and as root 440 for one of mode 440, not
	/// owner-writable), as GNU's has; with `--reflink=always` the clone then
	/// fails with what `FICLONE` answers, the backup comes back over the link,
	/// and the file made through it stays, empty, with those permissions.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_name_that_appears_during_the_copy_is_kept() {
		use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

		// What `FICLONE` answers from a FIFO here.
		let probe = tempdir().unwrap();
		let fifo = probe.path().join("p");
		let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `name` is NUL-terminated and outlives the call.
		assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "mkfifo");
		fs::write(probe.path().join("f"), b"").unwrap();
		let clone = pi_iso::cow::clone_open(
			&fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap(),
			&fs::OpenOptions::new().write(true).open(probe.path().join("f")).unwrap(),
		)
		.expect_err("a clone from a FIFO");
		let clone_err = format!("cp: failed to clone 'b' from 'p': {}\n", crate::host::strip_errno(&clone));
		// (what appears, POSIXLY_CORRECT, --reflink=always, the FIFO's mode, exit, stderr, the
		// entries after). The last row is root's: a FIFO of mode 440 is written only by root, and
		// GNU then leaves the file it makes through the link with 440, not owner-writable.
		// SAFETY: `geteuid` has no preconditions.
		let as_root = unsafe { libc::geteuid() } == 0;
		let mut rows = vec![
			("file", false, false, 0o604, 1, "cp: cannot create regular file 'b': File exists\n", "b=old#644"),
			("link", false, false, 0o604, 1, "cp: not writing through dangling symlink 'b'\n", "b=old#644"),
			("link", true, false, 0o604, 0, "", "b=link:none b~=old#644 none=F#604"),
			("link", true, true, 0o604, 1, clone_err.as_str(), "b=old#644 none=#604"),
		];
		if as_root {
			rows.push(("link", true, true, 0o440, 1, clone_err.as_str(), "b=old#644 none=#440"));
		} else {
			eprintln!("skipped: the row of a FIFO of mode 440 needs root");
		}
		for (kind, posix, reflink, fifo_mode, code, err, after) in rows {
			let dir = tempdir().unwrap();
			let fifo = dir.path().join("p");
			let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
			// SAFETY: `name` is NUL-terminated and outlives the call.
			assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "mkfifo");
			fs::set_permissions(&fifo, fs::Permissions::from_mode(fifo_mode)).unwrap();
			fs::write(dir.path().join("b"), b"old").unwrap();
			fs::set_permissions(dir.path().join("b"), fs::Permissions::from_mode(0o644)).unwrap();
			let cwd = dir.path().to_owned();
			let copy = std::thread::spawn(move || {
				use crate::host::{Host, Utility as _};
				let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
				if posix {
					host.set_test_var("POSIXLY_CORRECT", "1");
				}
				let args: &[&str] =
					if reflink { &["cp", "-f", "-b", "--reflink=always", "p", "b"] } else { &["cp", "-f", "-b", "p", "b"] };
				let parsed = <Cp as clap::Parser>::try_parse_from(args).unwrap();
				let code = parsed.run(&mut host);
				(code, capture.err())
			});
			// cp backs `b` up before it opens the FIFO, whose open waits for a
			// writer; none is opened until the name is made.
			while !dir.path().join("b~").exists() {
				assert!(!copy.is_finished(), "cp ended before it backed b up");
				std::thread::yield_now();
			}
			let case = format!(
				"a {kind} appears{}{}, a FIFO of mode {fifo_mode:o}",
				if posix { ", POSIXLY_CORRECT" } else { "" },
				if reflink { ", --reflink=always" } else { "" }
			);
			match kind {
				"file" => fs::write(dir.path().join("b"), b"new").unwrap(),
				_ => std::os::unix::fs::symlink("none", dir.path().join("b")).unwrap(),
			}
			// cp may fail at `b` and close the FIFO before the write lands.
			let _ = fs::write(&fifo, b"F");
			let (got, got_err) = copy.join().unwrap();
			assert_eq!((got, got_err.as_str()), (code, err), "{case}");
			let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
			names.sort();
			let found = names
				.iter()
				.filter(|name| name.to_str() != Some("p"))
				.map(|name| {
					let path = dir.path().join(name);
					let name = name.to_string_lossy();
					match fs::read_link(&path) {
						Ok(target) => format!("{name}=link:{}", target.display()),
						Err(_) => format!(
							"{name}={}#{:o}",
							fs::read_to_string(&path).unwrap(),
							fs::metadata(&path).unwrap().permissions().mode() & 0o777
						),
					}
				})
				.collect::<Vec<_>>()
				.join(" ");
			assert_eq!(found, after, "{case}");
		}
	}

	/// A copied link replaces any destination that is not a directory, as
	/// GNU 9.4 and 9.7 do as uid 1000 and as root (`copy.c` removes it before
	/// it makes the link): `cp -P l b`, with `-R`, `-d` and `-f` too, onto a
	/// FIFO, a socket and, where a device node can be made (root), a device,
	/// makes `b` the link; with `-v` GNU says `removed 'b'` before
	/// `'l' -> 'b'`, `-f` or `--remove-destination` or not.
	#[test]
	#[cfg(unix)]
	fn a_copied_link_replaces_a_special_file_as_gnu_does() {
		use std::os::unix::ffi::OsStrExt as _;

		let flags: [&[&str]; 7] =
			[&["-P"], &["-R"], &["-d"], &["-P", "-f"], &["-P", "-v"], &["-P", "-f", "-v"], &["-P", "--remove-destination", "-v"]];
		for kind in ["fifo", "socket", "device"] {
			for flag in flags {
				let dir = tempdir().unwrap();
				fs::write(dir.path().join("a"), b"A").unwrap();
				std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
				let b = dir.path().join("b");
				let name = std::ffi::CString::new(b.as_os_str().as_bytes()).unwrap();
				let made = match kind {
					// SAFETY: `name` is NUL-terminated and outlives the call.
					"fifo" => (unsafe { libc::mkfifo(name.as_ptr(), 0o644) }) == 0,
					"socket" => std::os::unix::net::UnixListener::bind(&b).is_ok(),
					// SAFETY: as above.
					_ => (unsafe { libc::mknod(name.as_ptr(), libc::S_IFCHR | 0o644, libc::makedev(1, 3)) }) == 0,
				};
				if !made {
					assert_eq!(kind, "device", "making the {kind}");
					eprintln!("skipped: a device node cannot be made here");
					break;
				}
				let mut args = flag.to_vec();
				args.extend(["l", "b"]);
				let (code, capture) = run_util::<Cp>(&args, "", dir.path());
				let case = format!("cp {} onto a {kind}", args.join(" "));
				let out = if flag.contains(&"-v") { "removed 'b'\n'l' -> 'b'\n" } else { "" };
				assert_eq!((code, capture.err(), capture.out()), (0, String::new(), out.to_owned()), "{case}");
				assert_eq!(fs::read_link(&b).ok(), Some(std::path::PathBuf::from("a")), "{case}: b is not the link");
			}
		}
	}

	/// A new file is made as GNU's `copy_reg` makes it (`copy.c` 9.7, lines
	/// 1450-1460 and 1675-1704): with the source's permission bits, less its
	/// group and other bits while its owner may still change (`-p`,
	/// `--preserve=ownership`), plus the owner's write bit where extended
	/// attributes are copied without root's privileges. Its final mode is set
	/// after its owner: the source's under a preserved mode, 666 less the umask
	/// under `--no-preserve=mode`, else the source's less the umask. A link
	/// that leads nowhere before cp starts (POSIXLY_CORRECT) makes such a new
	/// file, which gets its final mode and owner too. GNU 9.4 and 9.7 give
	/// these, as uid 1000 and as root, on runc and gVisor. From a FIFO the
	/// test reads the mode and owner while cp waits for its data; as root the
	/// FIFO belongs to uid 1000, so a preserved owner is set.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_new_file_is_private_until_its_owner_is_set() {
		use std::{
			io::Write as _,
			os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
		};

		use crate::host::{Host, Utility as _};

		// SAFETY: `geteuid` and `getegid` have no preconditions.
		let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
		let as_root = uid == 0;
		let umask = crate::host::process_umask();
		let source_owner = if as_root { (1000, 1000) } else { (uid, gid) };
		let flags = ["", "-p", "--preserve=ownership", "--preserve=mode", "--no-preserve=mode", "--preserve=xattr", "--preserve=all"];
		// GNU's modes for (flag, source mode): while cp copies, and after.
		let expected = |flag: &str, mode: u32| {
			let owner_kept = matches!(flag, "-p" | "--preserve=ownership" | "--preserve=all");
			let xattr = matches!(flag, "--preserve=xattr" | "--preserve=all");
			let omitted = if owner_kept { mode & 0o077 } else { 0 };
			let open = (mode & !omitted) | if xattr && !as_root { 0o200 } else { 0 };
			let during = (open & !umask) | (open & !mode);
			let after = match flag {
				"-p" | "--preserve=mode" | "--preserve=all" => mode,
				"--no-preserve=mode" => 0o666 & !umask,
				_ => mode & !umask,
			};
			(during, after, if owner_kept { source_owner } else { (uid, gid) })
		};
		// Rows GNU 9.4 and 9.7 gave under umask 022, as uid 1000 and as root.
		if umask == 0o022 {
			let modes = |flag, mode| {
				let (during, after, _) = expected(flag, mode);
				(during, after)
			};
			assert_eq!(modes("-p", 0o440), (0o400, 0o440));
			assert_eq!(modes("-p", 0o666), (0o600, 0o666));
			assert_eq!(modes("--no-preserve=mode", 0o440), (0o440, 0o644));
			assert_eq!(modes("", 0o604), (0o604, 0o604));
		}
		for mode in [0o440, 0o640, 0o666, 0o604] {
			for flag in flags {
				for through in [false, true] {
					let dir = tempdir().unwrap();
					let fifo = dir.path().join("p");
					let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
					// SAFETY: `name` is NUL-terminated and outlives the call.
					assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "mkfifo");
					// Held read-write, so cp's open does not wait and its read does.
					let writer = fs::OpenOptions::new()
						.read(true)
						.write(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&fifo)
						.unwrap();
					fs::set_permissions(&fifo, fs::Permissions::from_mode(mode)).unwrap();
					if as_root {
						std::os::unix::fs::chown(&fifo, Some(1000), Some(1000)).unwrap();
					}
					let made = if through {
						std::os::unix::fs::symlink("none", dir.path().join("b")).unwrap();
						dir.path().join("none")
					} else {
						dir.path().join("b")
					};
					let case = format!(
						"cp {flag} p b, a FIFO of mode {mode:o}{}",
						if through { ", b a link to nothing (POSIXLY_CORRECT)" } else { "" }
					);
					let cwd = dir.path().to_owned();
					let copy = std::thread::spawn(move || {
						let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
						if through {
							host.set_test_var("POSIXLY_CORRECT", "1");
						}
						let mut args = vec!["cp"];
						args.extend((!flag.is_empty()).then_some(flag));
						args.extend(["p", "b"]);
						let parsed = <Cp as clap::Parser>::try_parse_from(args).unwrap();
						(parsed.run(&mut host), capture.err())
					});
					let during = loop {
						if let Ok(metadata) = fs::metadata(&made) {
							break (metadata.mode() & 0o7777, (metadata.uid(), metadata.gid()));
						}
						assert!(!copy.is_finished(), "{case}: cp ended before it made the file");
						std::thread::yield_now();
					};
					(&writer).write_all(b"F").unwrap();
					drop(writer);
					let (code, err) = copy.join().unwrap();
					assert_eq!((code, err.as_str()), (0, ""), "{case}");
					let metadata = fs::metadata(&made).unwrap();
					let (mode_during, mode_after, owner_after) = expected(flag, mode);
					assert_eq!(
						format!(
							"{:o} {:?}, then {:o} {:?}",
							during.0,
							during.1,
							metadata.mode() & 0o7777,
							(metadata.uid(), metadata.gid())
						),
						format!("{mode_during:o} {:?}, then {mode_after:o} {owner_after:?}", (uid, gid)),
						"{case}: mode and owner while cp copies, then after"
					);
					assert_eq!(fs::read_to_string(&made).unwrap(), "F", "{case}");
				}
			}
		}
	}

	/// A regular file copied through a link that leads nowhere before cp
	/// starts (POSIXLY_CORRECT) is new to cp, as it is to GNU 9.4 and 9.7:
	/// the file the link leads to gets the final mode and owner a new file
	/// gets (see [`a_new_file_is_private_until_its_owner_is_set`]).
	#[test]
	#[cfg(target_os = "linux")]
	fn a_file_copied_through_a_link_to_nothing_gets_a_new_files_mode() {
		use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

		use crate::host::{Host, Utility as _};

		// SAFETY: `geteuid` has no preconditions.
		let as_root = unsafe { libc::geteuid() } == 0;
		let umask = crate::host::process_umask();
		let own = if as_root { (0, 0) } else { unsafe { (libc::geteuid(), libc::getegid()) } };
		let source_owner = if as_root { (1000, 1000) } else { own };
		for mode in [0o440, 0o640, 0o604] {
			for flag in ["", "-p", "--preserve=ownership", "--preserve=mode", "--no-preserve=mode"] {
				let dir = tempdir().unwrap();
				fs::write(dir.path().join("a"), b"A").unwrap();
				fs::set_permissions(dir.path().join("a"), fs::Permissions::from_mode(mode)).unwrap();
				if as_root {
					std::os::unix::fs::chown(dir.path().join("a"), Some(1000), Some(1000)).unwrap();
				}
				std::os::unix::fs::symlink("none", dir.path().join("b")).unwrap();
				let (mut host, capture) = Host::for_test(Cp::NAME, "", dir.path());
				host.set_test_var("POSIXLY_CORRECT", "1");
				let mut args = vec!["cp"];
				args.extend((!flag.is_empty()).then_some(flag));
				args.extend(["a", "b"]);
				let code = <Cp as clap::Parser>::try_parse_from(args).unwrap().run(&mut host);
				let case = format!("POSIXLY_CORRECT cp {flag} a b, a of mode {mode:o}, b a link to nothing");
				assert_eq!((code, capture.err().as_str()), (0, ""), "{case}");
				let made = fs::metadata(dir.path().join("none")).unwrap();
				let mode_after = match flag {
					"-p" | "--preserve=mode" => mode,
					"--no-preserve=mode" => 0o666 & !umask,
					_ => mode & !umask,
				};
				let owner_after =
					if matches!(flag, "-p" | "--preserve=ownership") { source_owner } else { own };
				assert_eq!(
					format!("{:o} {:?}", made.mode() & 0o7777, (made.uid(), made.gid())),
					format!("{mode_after:o} {owner_after:?}"),
					"{case}: mode and owner of the file the link leads to"
				);
				assert_eq!(fs::read_link(dir.path().join("b")).unwrap(), std::path::Path::new("none"), "{case}");
			}
		}
	}

	/// A non-directory is not copied over a directory, as GNU 9.7 refuses it
	/// (`copy.c` lines 2458-2471), once `-n`, `-i` and `-u` let the copy go
	/// on: a link in a tree (`cp -RT S D`, also with -H and -a, with `S/l` a
	/// link and `D/l` a directory) and one operand under `-T`. With a backup
	/// GNU does not refuse, and makes no backup of a directory in a copy: the
	/// link's creation fails, and the directory stays. Under `-a` the failure
	/// is reported, not dropped, and `-i` answered no fails, as GNU's does.
	/// A link to nothing that is newer than the copied link is kept by `-u`.
	#[test]
	#[cfg(unix)]
	fn a_non_directory_is_not_copied_over_a_directory_as_gnu_does() {
		type Row = (&'static [&'static str], &'static str, i32, &'static str);
		let refused = "cp: cannot overwrite directory 'D/l' with non-directory 'S/l'\n";
		let exists = "cp: cannot create symbolic link 'D/l': File exists\n";
		for mode in ["-RT", "-RHT", "-aT"] {
			let rows: [Row; 8] = [
				(&[], "", 1, refused),
				(&["-f"], "", 1, refused),
				(&["-v"], "", 1, refused),
				(&["-f", "-v"], "", 1, refused),
				(&["--remove-destination"], "", 1, refused),
				(&["-b"], "", 1, exists),
				(&["-n"], "", 0, ""),
				(&["-i"], "n\n", 1, "cp: overwrite 'D/l'? "),
			];
			for (flags, stdin, code, err) in rows {
				let dir = tempdir().unwrap();
				fs::write(dir.path().join("a"), b"A").unwrap();
				fs::create_dir_all(dir.path().join("S")).unwrap();
				std::os::unix::fs::symlink("../a", dir.path().join("S/l")).unwrap();
				fs::create_dir_all(dir.path().join("D/l")).unwrap();
				fs::write(dir.path().join("D/l/x"), b"X").unwrap();
				let mut args = vec![mode];
				args.extend(flags);
				args.extend(["S", "D"]);
				let (got, capture) = run_util::<Cp>(&args, stdin, dir.path());
				let case = format!("cp {}", args.join(" "));
				assert_eq!((got, capture.err(), capture.out()), (code, err.to_owned(), String::new()), "{case}");
				assert_eq!(fs::read_to_string(dir.path().join("D/l/x")).unwrap(), "X", "{case}: D/l is not kept");
				assert!(!dir.path().join("D/l~").exists(), "{case}: D/l was backed up");
			}
			// `-i` answered no onto any other kind fails too.
			for (kind, make) in [("file", 0), ("link to nothing", 1), ("FIFO", 2)] {
				let dir = tempdir().unwrap();
				fs::write(dir.path().join("a"), b"A").unwrap();
				fs::create_dir_all(dir.path().join("S")).unwrap();
				std::os::unix::fs::symlink("../a", dir.path().join("S/l")).unwrap();
				fs::create_dir_all(dir.path().join("D")).unwrap();
				let l = dir.path().join("D/l");
				match make {
					0 => fs::write(&l, b"OLD").unwrap(),
					1 => std::os::unix::fs::symlink("missing", &l).unwrap(),
					_ => {
						let name = std::ffi::CString::new(l.as_os_str().as_encoded_bytes()).unwrap();
						// SAFETY: `name` is NUL-terminated and outlives the call.
						assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "mkfifo");
					},
				}
				let (got, capture) = run_util::<Cp>(&[mode, "-i", "S", "D"], "n\n", dir.path());
				assert_eq!((got, capture.err()), (1, "cp: overwrite 'D/l'? ".to_owned()), "cp {mode} -i onto a {kind}");
			}
		}
		let onto_dir: [Row; 7] = [
			(&[], "", 1, "cp: cannot overwrite directory 'b' with non-directory 'l'\n"),
			(&["-f"], "", 1, "cp: cannot overwrite directory 'b' with non-directory 'l'\n"),
			(&["-n"], "", 0, ""),
			(&["-u"], "", 0, ""),
			(&["-i"], "n\n", 1, "cp: overwrite 'b'? "),
			(&["-i"], "y\n", 1, "cp: overwrite 'b'? cp: cannot overwrite directory 'b' with non-directory 'l'\n"),
			(&["-b"], "", 1, "cp: cannot create symbolic link 'b': File exists\n"),
		];
		for (flags, stdin, code, err) in onto_dir {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			// The link is older than `b`, which `-u` keeps.
			let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
			fs::File::options()
				.write(true)
				.open(dir.path().join("a"))
				.unwrap()
				.set_modified(old)
				.unwrap();
			set_link_times(&dir.path().join("l"), old);
			fs::create_dir(dir.path().join("b")).unwrap();
			fs::write(dir.path().join("b/x"), b"X").unwrap();
			let mut args = vec!["-T", "-P"];
			args.extend(flags);
			args.extend(["l", "b"]);
			let (got, capture) = run_util::<Cp>(&args, stdin, dir.path());
			let case = format!("cp {}, b a directory", args.join(" "));
			assert_eq!((got, capture.err(), capture.out()), (code, err.to_owned(), String::new()), "{case}");
			assert_eq!(fs::read_to_string(dir.path().join("b/x")).unwrap(), "X", "{case}: b is not kept");
		}
		for flag in ["-P", "-R", "-d"] {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			set_link_times(&dir.path().join("l"), std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000));
			std::os::unix::fs::symlink("missing", dir.path().join("b")).unwrap();
			let (got, capture) = run_util::<Cp>(&[flag, "-u", "l", "b"], "", dir.path());
			let case = format!("cp {flag} -u l b, b a newer link to nothing");
			assert_eq!((got, capture.err()), (0, String::new()), "{case}");
			assert_eq!(fs::read_link(dir.path().join("b")).unwrap(), std::path::Path::new("missing"), "{case}");
		}
	}

	/// Sets the times of the link `path` itself.
	#[cfg(unix)]
	fn set_link_times(path: &std::path::Path, time: SystemTime) {
		let secs = time.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as libc::time_t;
		let times = [libc::timespec { tv_sec: secs, tv_nsec: 0 }, libc::timespec { tv_sec: secs, tv_nsec: 0 }];
		let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `name` is NUL-terminated, and `times` holds two timespecs.
		let rc = unsafe { libc::utimensat(libc::AT_FDCWD, name.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
		assert_eq!(rc, 0, "lutimes {}", path.display());
	}
	#[test]
	fn recursive_copy_creates_missing_target_then_nests_into_existing_one() {
		let fixture = tempdir().unwrap();
		fs::create_dir_all(fixture.path().join("src/sub")).unwrap();
		fs::write(fixture.path().join("src/top.txt"), b"top").unwrap();
		fs::write(fixture.path().join("src/sub/leaf.txt"), b"leaf").unwrap();

		let (code, capture) = run_util::<Cp>(&["-r", "src", "out"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("out/top.txt")).unwrap(), b"top");
		assert_eq!(fs::read(fixture.path().join("out/sub/leaf.txt")).unwrap(), b"leaf");

		// `out` now exists, so a second copy goes inside it.
		let (code, capture) = run_util::<Cp>(&["-r", "src", "out"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("out/src/sub/leaf.txt")).unwrap(), b"leaf");
	}

	#[test]
	fn no_clobber_keeps_existing_destination_and_succeeds() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Cp>(&["-n", "source", "target"], "", fixture.path());

		assert_eq!(code, 0);
		assert_eq!(capture.err(), "");
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"old");
	}

	#[test]
	fn target_directory_receives_every_source() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("a"), b"A").unwrap();
		fs::write(fixture.path().join("b"), b"B").unwrap();

		let (code, capture) = run_util::<Cp>(&["-t", "dir", "a", "b"], "", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("dir/a")).unwrap(), b"A");
		assert_eq!(fs::read(fixture.path().join("dir/b")).unwrap(), b"B");
	}

	#[test]
	fn missing_source_is_reported_and_remaining_sources_still_copy() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("present"), b"here").unwrap();

		let (code, capture) = run_util::<Cp>(&["missing", "present", "dir"], "", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(capture.err(), "cp: cannot stat 'missing': No such file or directory\n");
		assert_eq!(fs::read(fixture.path().join("dir/present")).unwrap(), b"here");
	}

	#[test]
	fn directory_without_recursive_is_omitted() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("dir/file"), b"x").unwrap();

		let (code, capture) = run_util::<Cp>(&["dir", "out"], "", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(capture.err(), "cp: -r not specified; omitting directory 'dir'\n");
		assert!(!fixture.path().join("out").exists());
	}

	#[test]
	fn preserve_keeps_modification_time_that_a_plain_copy_refreshes() {
		let fixture = tempdir().unwrap();
		let source = fixture.path().join("source");
		fs::write(&source, b"payload").unwrap();
		let past = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
		fs::File::options()
			.write(true)
			.open(&source)
			.unwrap()
			.set_modified(past)
			.unwrap();

		let (code, capture) = run_util::<Cp>(&["-p", "source", "kept"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let (code, capture) = run_util::<Cp>(&["source", "fresh"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let modified = |name: &str| fs::metadata(fixture.path().join(name)).unwrap().modified().unwrap();
		assert_eq!(modified("kept"), past);
		assert_ne!(modified("fresh"), past);
	}

	/// Under a default ACL the parent's ACL, not the umask, shapes a new
	/// file's mode, so a preserved mode must not be assumed in place.
	#[test]
	#[cfg(target_os = "linux")]
	fn preserved_mode_is_set_under_a_default_acl() {
		use std::os::unix::fs::PermissionsExt as _;

		let fixture = tempdir().unwrap();
		let path = |name: &str| fixture.path().join(name);
		fs::write(path("source"), b"x").unwrap();
		fs::set_permissions(path("source"), fs::Permissions::from_mode(0o644)).unwrap();
		fs::create_dir(path("shared")).unwrap();
		// `default:user::rwx,group::rwx,other::---` in the kernel's xattr form:
		// version 2, then (tag, permissions, unused id) per entry.
		let mut acl = 2u32.to_le_bytes().to_vec();
		for (tag, permissions) in [(0x01u16, 7u16), (0x04, 7), (0x20, 0)] {
			acl.extend(tag.to_le_bytes());
			acl.extend(permissions.to_le_bytes());
			acl.extend(u32::MAX.to_le_bytes());
		}
		if let Err(error) = pi_vfs::BlockingFs::native().set_xattr(
			path("shared"),
			"system.posix_acl_default",
			&acl,
			true,
		) {
			eprintln!("skipped: no POSIX ACLs on the temporary filesystem: {error}");
			return;
		}

		for (flag, dest) in [("-p", "shared/all"), ("--preserve=mode", "shared/mode")] {
			let (code, capture) = run_util::<Cp>(&[flag, "source", dest], "", fixture.path());
			assert_eq!(code, 0, "{}", capture.err());
			assert_eq!(fs::metadata(path(dest)).unwrap().permissions().mode() & 0o7777, 0o644, "{flag}");
		}
	}
}
