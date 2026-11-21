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
	file_backup::{
		backup_display, backup_is_source, backup_path, determine_backup_mode, determine_backup_suffix, same_entry,
		same_file, source_is_destination_backup,
	},
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
	let dest_path = construct_dest_path(host, source, target, target_type, options);
	let dest = dest_path.as_deref().unwrap_or(target).to_path_buf();
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

	copy_source(host, state, source, target, dest_path, options)?;
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
) -> CopyResult<PathBuf> {
	let target_is_dir = host.fs().is_dir(host.resolve(target));
	if options.no_target_dir && target_is_dir {
		return Err(CpError::Error(format!(
			"cannot overwrite directory {} with non-directory {}",
			target.quote(),
			source.quote()
		)));
	}

	Ok(match target_type {
		TargetType::Directory => {
			if options.parents {
				join_path(target, &parents_relative(source))
			} else if source == "." && target_is_dir {
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
	})
}

/// Copies `source` into `target`: a directory recursively, anything else as
/// a file to `dest` (from [`construct_dest_path`]).
fn copy_source(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	target: &Path,
	dest: CopyResult<PathBuf>,
	options: &Options,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	if filesystem.is_dir(&source_fs)
		&& (options.dereference(true) || !filesystem.is_symlink(&source_fs))
	{
		return copy_directory(host, state, source, target, options);
	}

	let dest = dest?;
	if options.parents {
		make_parent_dirs(host, state, source, &dest, options)?;
	}
	let result = copy_file(host, state, source, &dest, options, true, None);
	if options.parents {
		for (x, y) in aligned_ancestors(source, &dest) {
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
	// Plain `cp`/`cp -r` preserves nothing: skip the stats below. A freshly
	// created directory always gets its mode set, one way or the other.
	let preserves_nothing = [attributes.ownership, attributes.mode, attributes.timestamps, attributes.xattr]
		.iter()
		.all(|preserve| matches!(preserve, Preserve::No { .. }));
	if preserves_nothing && !dest_is_freshly_created_dir {
		return Ok(());
	}
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
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

/// Names beside `path` for a new entry that will be renamed over it.
fn names_beside(path: &Path) -> impl Iterator<Item = PathBuf> {
	let dir = parent_path(path).unwrap_or(Path::new(".")).to_path_buf();
	(0..100).map(move |attempt| child_path(&dir, format!(".cp-backup.{}.{attempt}", std::process::id()).as_ref()))
}

/// Makes an entry at `path` with `make`: at `path` itself when nothing is
/// there, else at a name beside it, renamed over what `path` holds, so that
/// is replaced, never written through.
fn replace_entry(filesystem: &BlockingFs, path: &Path, make: impl Fn(&Path) -> io::Result<()>) -> io::Result<()> {
	match make(path) {
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
		made => return made,
	}
	for temp in names_beside(path) {
		match make(&temp) {
			Ok(()) => {
				let renamed = filesystem.rename(&temp, path);
				if renamed.is_err() {
					let _ = filesystem.remove_file(&temp);
				}
				return renamed;
			},
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error),
		}
	}
	Err(io::ErrorKind::AlreadyExists.into())
}

/// GNU 9.7's error for a directory where a non-directory would go (9.4's
/// leaves out the source).
fn overwrite_directory(directory: &Path, source: &Path) -> CpError {
	CpError::Error(format!(
		"cannot overwrite directory {} with non-directory {}",
		directory.quote(),
		source.quote()
	))
}

/// Makes the backup of a destination that is the source's own entry (`cp
/// -fb a a`) as GNU cp makes it: a copy of the source in the current mode,
/// after which nothing is left to copy. Returns whether it made anything.
/// A directory at the backup name is refused in every mode. `-l` links the
/// backup name to the source's file (nothing to do where it already is that
/// file); `-s` makes it a symbolic link to the source as named, refused for
/// a relative source outside the current directory as GNU refuses any such
/// link; a symbolic link read as a link (`-P`) is copied as a link;
/// otherwise the data is copied ([`copy_into_backup`]). `-s` and a data copy
/// are refused where the backup name is the source's file, which they would
/// replace or truncate: `-s` reads the backup name with lstat, as GNU does,
/// so a link `a~ -> a` is replaced. The errors are GNU's.
fn back_up_own_entry(
	host: &mut Host,
	source: &Path,
	dest: &Path,
	backup: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<bool> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let follow = options.dereference(source_in_command_line);
	let shown = backup_display(dest, backup);
	if filesystem.symlink_metadata(backup).is_ok_and(|metadata| metadata.is_dir()) {
		return Err(overwrite_directory(&shown, source));
	}
	let refuse_same_file = |follow_backup: bool| {
		if paths_refer_to_same_file(&filesystem, &source_fs, backup, follow_backup) {
			return Err(CpError::Error(format!(
				"{} and {} are the same file",
				source.quote(),
				shown.quote()
			)));
		}
		Ok(())
	};
	match options.copy_mode {
		CopyMode::Link => {
			// GNU reads the backup name with lstat for `-l` (`copy.c`), so a
			// link `a~ -> a` is another file, replaced by a hard link of `a`.
			if same_file(&filesystem, &source_fs, follow, backup, false) {
				return Ok(false);
			}
			let original = if follow && filesystem.is_symlink(&source_fs) {
				filesystem.canonicalize_with(
					&source_fs,
					&CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical),
				)?
			} else {
				source_fs.clone()
			};
			replace_entry(&filesystem, backup, |at| filesystem.hard_link(&original, at)).map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", shown.quote(), source.quote()),
				)
			})?;
		},
		CopyMode::SymLink => {
			if !source.is_absolute() && !is_virtual_path(source) && !dest_in_working_directory(host, &shown) {
				return Err(CpError::Error(format!(
					"{}: can make relative symbolic links only in current directory",
					shown.maybe_quote()
				)));
			}
			refuse_same_file(false)?;
			replace_entry(&filesystem, backup, |at| filesystem.symlink(source, at)).map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create symbolic link {} to {}", shown.quote(), source.quote()),
				)
			})?;
			// `-p` gives the new link the source's times, as GNU's does.
			copy_attributes(
				host,
				source,
				&shown,
				&options.attributes,
				false,
				follow,
				options.set_selinux_context,
				None,
				DestFacts { symlink: Some(true), ..DestFacts::default() },
			)?;
		},
		_ if !follow && filesystem.is_symlink(&source_fs) => {
			let target = filesystem.read_link(&source_fs).map_err(|e| {
				CpError::IoErrContext(e, format!("cannot read symbolic link {}", source.quote()))
			})?;
			replace_entry(&filesystem, backup, |at| filesystem.symlink(&target, at))
				.map_err(|e| CpError::IoErrContext(e, format!("cannot create symbolic link {}", shown.quote())))?;
			// `-p` gives the copied link the link's own times, as `copy_link`
			// does for any link it copies.
			copy_attributes(
				host,
				source,
				&shown,
				&options.attributes,
				false,
				false,
				options.set_selinux_context,
				None,
				DestFacts { symlink: Some(true), ..DestFacts::default() },
			)?;
		},
		_ => {
			refuse_same_file(true)?;
			copy_into_backup(host, source, dest, backup, options, follow)?;
		},
	}
	Ok(true)
}

/// Copies the data of `source`, which is cp's own destination, into its
/// backup `backup`, as GNU cp writes it. A regular file there is opened
/// without following a link put there since the lstat (`O_NOFOLLOW`) and
/// written in place, so it keeps its mode, its owner and its other hard
/// links, and the directory needs no write permission; one that cannot be
/// opened is removed and created again (this runs under `-f`). With nothing
/// there the backup is created exclusively (`O_EXCL`), with the source's
/// mode. A symbolic link there is followed to decide, as for any
/// destination: a dangling one ("not writing through dangling symlink") and
/// one that leads to a directory are refused, as GNU refuses them; any other
/// is replaced by a new file renamed over it, never written through, where
/// GNU writes through it. The data goes through the handles opened, and `-p`
/// gives the backup the source's attributes.
fn copy_into_backup(
	host: &mut Host,
	source: &Path,
	dest: &Path,
	backup: &Path,
	options: &Options,
	follow: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let shown = backup_display(dest, backup);
	let cannot_create = |e| CpError::IoErrContext(e, format!("cannot create regular file {}", shown.quote()));
	let source_file = filesystem.open(host.resolve(source)).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot open {} for reading", source.quote()))
	})?;
	let source_metadata = source_file
		.metadata()
		.map_err(|e| CpError::IoErrContext(e, format!("cannot stat {}", source.quote())))?;
	let mode = source_metadata.permissions().mode() & 0o777;
	let create = |at: &Path| filesystem.open_with(at, OpenOptions::new().write(true).create_new(true).mode(mode));
	let existing = filesystem.symlink_metadata(backup);
	let (file, temp) = match &existing {
		Ok(metadata) if metadata.is_symlink() => {
			match filesystem.metadata(backup) {
				Ok(target) if target.is_dir() => return Err(overwrite_directory(&shown, source)),
				// GNU refuses a link that leads nowhere, and reports any other
				// failure to read where a link leads (`cannot stat`).
				Err(error) if !is_symlink_loop(&filesystem, backup) => {
					if error.kind() != io::ErrorKind::NotFound {
						return Err(CpError::IoErrContext(error, format!("cannot stat {}", shown.quote())));
					}
					if host.var("POSIXLY_CORRECT").is_none() {
						return Err(CpError::Error(format!(
							"not writing through dangling symlink {}",
							shown.quote()
						)));
					}
				},
				_ => {},
			}
			let mut created = None;
			for temp in names_beside(backup) {
				match create(&temp) {
					Ok(file) => {
						created = Some((file, Some(temp)));
						break;
					},
					Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
					Err(error) => return Err(cannot_create(error)),
				}
			}
			created.ok_or_else(|| cannot_create(io::ErrorKind::AlreadyExists.into()))?
		},
		_ => {
			// The seam where a test puts an entry at the backup name after cp
			// looked at it, before cp opens it.
			#[cfg(test)]
			crate::host::run_hook(backup);
			if existing.is_ok() {
				let mut open = OpenOptions::new();
				open.write(true).truncate(!options.attributes_only);
				#[cfg(unix)]
				if filesystem.is_native_local(backup) {
					open.custom_flags(libc::O_NOFOLLOW);
				}
				match filesystem.open_with(backup, &open) {
					Ok(file) => (file, None),
					Err(error) if !options.unlink_after_failed_open() => return Err(cannot_create(error)),
					Err(_) => {
						match filesystem.remove_file(backup) {
							Ok(()) => {},
							Err(error) if error.kind() == io::ErrorKind::NotFound => {},
							Err(error) => {
								return Err(CpError::IoErrContext(error, format!("cannot remove {}", shown.quote())));
							},
						}
						// The seam where a test puts an entry back at the backup
						// name after the removal, before the create.
						#[cfg(test)]
						crate::host::run_hook(backup);
						(create(backup).map_err(cannot_create)?, None)
					},
				}
			} else {
				(create(backup).map_err(cannot_create)?, None)
			}
		},
	};
	let written = if options.attributes_only {
		Ok(())
	} else {
		copy_stream_data(host, &source_file, &file, source, &shown)
	};
	let made = written
		.and_then(|()| {
			file.close()
				.map_err(|e| CpError::IoErrContext(e, format!("failed to close {}", shown.quote())))
		})
		.and_then(|()| match &temp {
			Some(temp) => filesystem.rename(temp, backup).map_err(cannot_create),
			None => Ok(()),
		});
	if made.is_err()
		&& let Some(temp) = &temp
	{
		let _ = filesystem.remove_file(temp);
	}
	made?;
	copy_attributes(
		host,
		source,
		&shown,
		&options.attributes,
		false,
		follow,
		options.set_selinux_context,
		Some(&source_metadata),
		DestFacts { symlink: Some(false), ..DestFacts::default() },
	)
}

/// GNU's error where the rename that makes a backup did nothing (the backup
/// name is another link of `dest`'s own file) and its create of `dest` then
/// finds `dest` there; `None` where GNU's `-f` replaces `dest` instead, as it
/// does with a link.
fn create_refused(
	filesystem: &BlockingFs,
	source: &Path,
	source_fs: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> Option<CpError> {
	let exists = |what: String| Some(CpError::Error(format!("{what}: File exists")));
	let link = |what: String| if options.unlink_after_failed_open() { None } else { exists(what) };
	match options.copy_mode {
		// GNU replaces the destination with a hard link where `-f` or `-i`
		// lets it unlink one (`copy.c`), and a symbolic link only under `-f`.
		CopyMode::Link if matches!(options.overwrite, OverwriteMode::Interactive(_)) => None,
		CopyMode::Link => link(format!("cannot create hard link {} to {}", dest.quote(), source.quote())),
		CopyMode::SymLink => link(format!("cannot create symbolic link {} to {}", dest.quote(), source.quote())),
		CopyMode::AttrOnly => exists(format!("cannot create regular file {}", dest.quote())),
		CopyMode::Copy | CopyMode::Update => {
			let read = if options.dereference(source_in_command_line) {
				filesystem.metadata(source_fs)
			} else {
				filesystem.symlink_metadata(source_fs)
			};
			let file_type = read.map(|metadata| metadata.file_type()).ok();
			let special = options.recursive && !options.copy_contents;
			match file_type {
				Some(kind) if kind.is_symlink() => link(format!("cannot create symbolic link {}", dest.quote())),
				Some(kind) if special && kind.is_fifo() => exists(format!("cannot create fifo {}", dest.quote())),
				Some(kind) if special && (kind.is_char_device() || kind.is_block_device() || kind.is_socket()) => {
					exists(format!("cannot create special file {}", dest.quote()))
				},
				_ => exists(format!("cannot create regular file {}", dest.quote())),
			}
		},
	}
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

/// Whether GNU turns this copy into a copy of the source to its backup name
/// (`cp.c`): `-f` (with or without `-i`) and a backup, the two names the same
/// string, and a destination `stat` reads as a regular file. A FIFO, a device
/// or a link to nothing that is its own destination is not turned.
fn converts_to_backup(filesystem: &BlockingFs, source: &Path, dest: &Path, dest_fs: &Path, options: &Options) -> bool {
	options.backup != BackupMode::None
		&& options.unlink_after_failed_open()
		&& source.as_os_str() == dest.as_os_str()
		&& filesystem.is_file(dest_fs)
}

/// Whether the source is a link cp follows whose own entry is the destination,
/// with a backup that is not turned into a copy, under another string
/// (`cp -fb l ./l`) or the same one (`cp -fb l l`, `l` leading to a FIFO; `cp
/// -b l l`), or under any name with `--remove-destination` and no backup (`l
/// ./l`, `l l`). GNU reads the destination with lstat there, another file
/// than the one it follows, so it backs the link up by renaming it, after
/// `-i` asks and `-u` compares, cannot open the source through the name it
/// renamed, and renames the backup back. Under `--remove-destination` GNU
/// removes the link and then cannot open it, losing the link: here the same
/// refusal comes first and the link stays.
fn loses_the_followed_source(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	source_fs: &Path,
	dest_fs: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	(options.backup != BackupMode::None
		&& (source.as_os_str() != dest.as_os_str() || !converts_to_backup(filesystem, source, dest, dest_fs, options))
		|| options.backup == BackupMode::None && options.remove_destination())
		&& matches!(options.copy_mode, CopyMode::Copy | CopyMode::Update)
		&& options.dereference(source_in_command_line)
		&& filesystem.is_symlink(source_fs)
		&& same_entry(filesystem, source_fs, dest_fs)
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
		// GNU makes the backup of a destination that is the source's own
		// entry only where the two names are the same string (`STREQ` in
		// `cp.c`, not their path components): `a` and `./a`, or `d//a` and
		// `d/a`, are the same file.
		if source.as_os_str() != dest.as_os_str()
			&& same_entry(filesystem, source_fs, dest_fs)
			&& !loses_the_followed_source(filesystem, source, dest, source_fs, dest_fs, options, source_in_command_line)
		{
			return true;
		}
		// `-f` makes that backup, with or without `-i`, as GNU's does, where
		// `stat` reads the destination as a regular file. Another own entry
		// with `-f` (a FIFO, a link to nothing read as a link) is the same file
		// before any question or update check, as GNU's; `-l` does nothing
		// there (`copy_file`). A link cp follows to a file that is not regular
		// goes the way of a backup by renaming, as GNU's does.
		if converts_to_backup(filesystem, source, dest, dest_fs, options) {
			return false;
		}
		if options.unlink_after_failed_open()
			&& source.as_os_str() == dest.as_os_str()
			&& options.copy_mode != CopyMode::Link
			&& !loses_the_followed_source(filesystem, source, dest, source_fs, dest_fs, options, source_in_command_line)
		{
			return true;
		}
		if source_is_symlink && !options.dereference {
			return false;
		}
		if dest_is_symlink {
			return false;
		}
		if !dest_is_symlink && !source_is_symlink && dest.as_os_str() != source.as_os_str() {
			return false;
		}
	}
	// `--remove-destination` unlinks the destination before it opens it, and
	// GNU reads it with lstat (`copy.c`, `same_file_ok`): a symbolic link there
	// is another file, which it replaces, and so is another hard link of a
	// source that is not a link, in another entry. The source's own entry, by
	// any name, is the same file, and nothing is removed before this check.
	if options.backup == BackupMode::None && options.remove_destination() {
		if dest_is_symlink && options.dereference(source_in_command_line) {
			return false;
		}
		if !source_is_symlink && !dest_is_symlink && !same_entry(filesystem, source_fs, dest_fs) {
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

/// Back up, remove, or leave intact the existing destination file, depending
/// on the options. Returns the backup made, if any, and whether the
/// destination is the source's own entry, whose backup copy was the whole
/// copy ([`back_up_own_entry`]).
/// `own_backup` is the backup name where the destination is the source's own
/// entry, as `copy_file` found it for `-u`: GNU copies to it in place of the
/// destination (`cp.c`), so `--update=none` and `-i` look at it, and at
/// nothing where nothing is there.
fn handle_existing_dest(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
	own_backup: Option<&Path>,
) -> CopyResult<(Option<PathBuf>, bool)> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let asked_about = match own_backup {
		// GNU asks about the backup name only where `stat` of it succeeds
		// (`copy.c`): a link to nothing there is a new destination.
		Some(backup) => filesystem.metadata(backup).is_ok().then(|| backup_display(dest, backup)),
		None => Some(dest.to_path_buf()),
	};
	if options.update == UpdateMode::None
		&& let Some(path) = &asked_about
	{
		if options.debug {
			let _ = writeln!(host.stdout, "skipped {}", path.quote());
		}
		return Err(CpError::Skipped(false));
	}

	if options.update != UpdateMode::IfOlder
		&& let Some(path) = &asked_about
	{
		options.overwrite.verify(host, path, options.debug)?;
	}
	if loses_the_followed_source(&filesystem, source, dest, &source_fs, &dest_fs, options, source_in_command_line) {
		return Err(CpError::Error(format!(
			"cannot open {} for reading: No such file or directory",
			source.quote()
		)));
	}

	// The backup would be renamed over a source that is the destination's
	// simple backup, so GNU refuses one in every mode but numbered, whatever
	// the backup's own name, by the same rule as mv (`copy.c`,
	// `source_is_dst_backup`), reading the source as the copy reads it.
	if !matches!(options.backup, BackupMode::None | BackupMode::Numbered)
		&& source_is_destination_backup(
			&filesystem,
			&source_fs,
			options.dereference(source_in_command_line),
			&dest_fs,
			&options.backup_suffix,
		) {
		return Err(CpError::Error(format!(
			"backing up {} might destroy source;  {} not copied",
			dest.quote(),
			source.quote()
		)));
	}
	let mut is_dest_removed = false;
	// GNU cp renames a numbered backup without replacing and fails when an
	// entry holds a long name's `~` fallback; here `backup_path` refuses that
	// name after an lstat (`exclusive`), and the backup below then replaces
	// whatever is there. The own entry's backup name `copy_file` found is
	// that name.
	let backup = match own_backup {
		Some(backup) => Some(backup.to_path_buf()),
		None => backup_path(&filesystem, options.backup, &dest_fs, &options.backup_suffix, true)
			.map_err(|_| CpError::Error(format!("cannot backup {}: File exists", dest.quote())))?,
	};
	if let Some(backup) = &backup {
		// A backup whose entry is the source's own, or one the source leads
		// to when cp follows it, would replace what cp is about to read.
		// Another hard link of the source is another entry and is replaced,
		// as GNU cp replaces it.
		if backup_is_source(&filesystem, &source_fs, options.dereference(source_in_command_line), backup) {
			return Err(CpError::Error(format!(
				"backing up {} might destroy source;  {} not copied",
				dest.quote(),
				source.quote()
			)));
		}
		if same_entry(&filesystem, &source_fs, &dest_fs) {
			if !options.unlink_after_failed_open() {
				// Without `-f` GNU backs the destination up by renaming it,
				// which renames the source: a source it follows it then
				// cannot open, and it renames the backup back; one it reads
				// as a link, or in another mode, it refuses first.
				let follows = matches!(options.copy_mode, CopyMode::Copy | CopyMode::Update)
					&& options.dereference(source_in_command_line);
				return Err(CpError::Error(if follows {
					format!("cannot open {} for reading: No such file or directory", source.quote())
				} else {
					format!("{} and {} are the same file", source.quote(), dest.quote())
				}));
			}
			// `cp -fb a a`: the destination is the source's own entry, so
			// its backup is a copy, and the copy is all there is to do. `-v`
			// reports it as GNU does, `'a' -> 'a~'`.
			if back_up_own_entry(host, source, dest, backup, options, source_in_command_line)?
				&& options.verbose
				&& !options.move_mode
			{
				state.say(host, context_for(source, &backup_display(dest, backup)));
			}
			return Ok((Some(backup.clone()), true));
		}
		// GNU renames the destination to the backup name, and the copy then
		// makes a new destination. Where the backup name is another link of
		// the destination's own file the rename does nothing, and GNU's
		// create of the destination then finds it: a regular file or a FIFO
		// fails, a link fails without `-f` and with it replaces the
		// destination. This fails as GNU does, before anything changes.
		if paths_refer_to_same_file(&filesystem, &dest_fs, backup, false)
			&& let Some(refused) =
				create_refused(&filesystem, source, &source_fs, dest, options, source_in_command_line)
		{
			return Err(refused);
		}
		filesystem
			.rename(&dest_fs, backup)
			.map_err(|e| CpError::IoErrContext(e, format!("cannot backup {}", dest.quote())))?;
		is_dest_removed = true;
	}
	if !is_dest_removed {
		delete_dest_if_needed_and_allowed(host, state, source, dest, options, source_in_command_line)?;
	}

	Ok((backup, false))
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
	/// copy looked: only ownership preservation needs it.
	Created { mode: Option<u32>, owner: Option<(u32, u32)> },
}

/// What a caller knows of a destination without looking at it again.
#[derive(Debug, Clone, Copy, Default)]
struct DestFacts {
	/// Whether it is a symlink; `None` looks.
	symlink: Option<bool>,
	/// Its permission bits, when this copy created it.
	mode:    Option<u32>,
	/// Its owner and group, when this copy created it and looked.
	owner:   Option<(u32, u32)>,
}

/// Permissions for the destination: an existing destination keeps its own;
/// a new one gets the source's, less `--no-preserve=mode` and the umask.
fn calculate_dest_permissions(
	dest_metadata: Option<&Metadata>,
	source_metadata: &Metadata,
	options: &Options,
	umask: u32,
) -> Permissions {
	match dest_metadata {
		Some(metadata) => metadata.permissions(),
		None => {
			let mode = handle_no_preserve_mode(options, source_metadata.permissions().mode());
			Permissions::from_mode(mode & !umask)
		},
	}
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
	}

	// `--attributes-only` keeps an existing destination's data, unless it is
	// to be removed or backed up first, as GNU's are.
	let check_existing_dest = initial_dest_metadata.is_some()
		&& (!options.attributes_only || options.remove_destination() || options.backup != BackupMode::None);
	if check_existing_dest {
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.copy_mode == CopyMode::Link
		{
			if source_is_symlink {
				if !dest_is_symlink || !options.dereference {
					return Ok(());
				}
			} else if options.backup != BackupMode::None && !dest_is_symlink {
				// Unless GNU turns this into a copy to the backup name, the link
				// is already there: GNU asks under `-i`, then does nothing.
				if !converts_to_backup(&filesystem, source, dest, &dest_fs, options) {
					if matches!(options.overwrite, OverwriteMode::Interactive(_)) {
						options.overwrite.verify(host, dest, options.debug)?;
					}
					return Ok(());
				}
			} else if options.backup == BackupMode::None && !dest_is_symlink {
				// The destination is the source's file, already linked: GNU
				// asks under `-i`, then does nothing (`copy.c`, `same_file_ok`),
				// so `--remove-destination` removes nothing here.
				if matches!(options.overwrite, OverwriteMode::Interactive(_)) {
					options.overwrite.verify(host, dest, options.debug)?;
				}
				return Ok(());
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

	// GNU turns `cp -fb a a`, the same name of an existing regular destination
	// with `-f`, into a copy of `a` to its backup name without a backup
	// (`cp.c`), so `-u` and `-i` look at the backup name, as `stat` reads it.
	let own_backup = if check_existing_dest && converts_to_backup(&filesystem, source, dest, &dest_fs, options) {
		backup_path(&filesystem, options.backup, &dest_fs, &options.backup_suffix, true).ok().flatten()
	} else {
		None
	};
	let (update_fs, update_shown) = match &own_backup {
		Some(backup) => (backup.clone(), backup_display(dest, backup)),
		None => (dest_fs.to_path_buf(), dest.to_path_buf()),
	};
	// `-u`/`--update` decides before anything is backed up or removed.
	if options.copy_mode == CopyMode::Update && filesystem.exists(&update_fs) {
		match options.update {
			UpdateMode::All => {},
			UpdateMode::None => {
				if options.debug {
					let _ = writeln!(host.stdout, "skipped {}", update_shown.quote());
				}
				return Ok(());
			},
			UpdateMode::NoneFail => {
				return Err(CpError::Error(format!("not replacing {}", update_shown.quote())));
			},
			UpdateMode::IfOlder => {
				let dest_time = match own_backup {
					Some(_) => filesystem.metadata(&update_fs)?,
					None => filesystem.symlink_metadata(&update_fs)?,
				}
				.modified()?;
				if source_metadata.modified()? <= dest_time {
					return Ok(());
				}
				options.overwrite.verify(host, &update_shown, options.debug)?;
			},
		}
	}

	let mut backup = None;
	if check_existing_dest {
		let own_entry;
		(backup, own_entry) =
			handle_existing_dest(host, state, source, dest, options, source_in_command_line, own_backup.as_deref())?;
		if own_entry {
			return Ok(());
		}
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
		filesystem
			.hard_link(host.resolve(&new_source), &dest_fs)
			.map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), new_source.quote()),
				)
			})?;

		if report {
			print_verbose_output(host, state, options, source, dest, backup.as_deref());
		}

		return Ok(());
	}

	let mut dest_metadata = if dest_replaced {
		filesystem.symlink_metadata(&dest_fs).ok()
	} else {
		initial_dest_metadata
	};

	// A copied symlink replaces the destination, which GNU removes before
	// reporting the copy.
	if source_metadata.is_symlink()
		&& matches!(options.copy_mode, CopyMode::Copy | CopyMode::Update)
		&& dest_metadata
			.as_ref()
			.is_some_and(|metadata| metadata.is_symlink() || metadata.is_file())
	{
		delete_path(host, state, dest, options)?;
		dest_metadata = None;
	}

	let source_is_stream = is_stream(&source_metadata);

	// GNU reports each copy as it starts it.
	if report {
		print_verbose_output(host, state, options, source, dest, backup.as_deref());
	}

	let fate = handle_copy_mode(
		host,
		state,
		source,
		dest,
		options,
		&source_metadata,
		dest_metadata.as_ref(),
		source_in_command_line,
		backup.is_some(),
	)?;

	// A file this copy created has a known mode and maybe owner.
	let (mut created_mode, owner) = match fate {
		DestFate::Created { mode, owner } => (mode, owner),
		DestFate::Kept | DestFate::Recreated => (None, None),
	};

	// Links share their target's permissions; only a copy gets its own.
	let copied_data = !source_metadata.is_symlink()
		&& !matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink);
	// A preserved mode is set by `copy_attributes` below.
	let mode_set_later = matches!(options.attributes.mode, Preserve::Yes { .. }) && !source_is_stream;
	if !dest_is_symlink && copied_data && !mode_set_later {
		let kept = dest_metadata
			.as_ref()
			.filter(|_| fate == DestFate::Kept);
		let dest_permissions = calculate_dest_permissions(kept, &source_metadata, options, host.umask());
		// Here, to match GNU semantics, we quietly ignore an error
		// if a user does not have the correct ownership to modify
		// the permissions of a file.
		//
		// FWIW, the OS will throw an error later, on the write op, if
		// the user does not have permission to write to the file.
		if created_mode != Some(dest_permissions.mode()) {
			let _ = filesystem.set_permissions(&dest_fs, dest_permissions);
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
	};

	// Some stream files may not exist after we have copied them, like
	// anonymous pipes; there are no attributes left to copy.
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
	symlink_file(host, state, &link, dest, kind)?;
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
	// The seam where a test replaces the source after cp read it and made
	// the backup, before the copy opens it.
	#[cfg(test)]
	crate::host::run_hook(&source_fs);
	// GNU opens the source and compares it with the one it read before the
	// backup (copy.c, `copy_reg`) before it creates or clones anything:
	// where another name of the source's file aliased the backup name (names
	// that fold, a file with more links), the backup replaced that entry, and
	// the copy would read the old destination.
	let source_file = filesystem.open(&source_fs).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot open {} for reading", source.quote()))
	})?;
	let opened = source_file.metadata().ok().and_then(|metadata| metadata.file_id());
	let replaced =
		|| CpError::Error(format!("skipping file {}, as it was replaced while being copied", source.quote()));
	if let (Some(before), Some(now)) = (source_metadata.file_id(), opened)
		&& now.is_native() == before.is_native()
		&& now != before
	{
		return Err(replaced());
	}
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
	// `always`, and every clone on macOS, goes by path: a failed clone then
	// leaves no empty `dest` behind, and an APFS clone carries the source's
	// timestamps, which a copy does not. The clone opens the source again by
	// its path, which must still name the file opened above: where it no
	// longer does, `always` fails as above, and `auto` copies the file opened,
	// as GNU cp, which clones from its descriptor, does. A swap between this
	// check and the clone's own lookup is not seen.
	let clone_by_path = native
		&& !source_is_stream
		&& match options.reflink_mode {
			ReflinkMode::Always => true,
			ReflinkMode::Auto => cfg!(target_os = "macos"),
			ReflinkMode::Never => false,
		};
	if clone_by_path {
		#[cfg(test)]
		crate::host::run_hook(&source_fs);
		let still = file_id(&filesystem, &source_fs, true);
		if still.is_none() || still != opened {
			if options.reflink_mode == ReflinkMode::Always {
				return Err(replaced());
			}
		} else {
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
	}

	// A stream destination (a FIFO, a device) is written, not truncated.
	// Owner-writable until the final permissions are applied, so a handle can
	// still be reopened to preserve timestamps.
	let create_mode =
		if source_is_stream { 0o622 } else { (source_metadata.permissions().mode() & 0o777) | 0o200 };
	let mut dest_options = OpenOptions::new();
	dest_options
		.write(true)
		.create(true)
		.truncate(!source_is_stream)
		.mode(create_mode);
	let cannot_create =
		|e| CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()));
	let (dest_file, fate) = match filesystem.open_with(&dest_fs, &dest_options) {
		// A host file this open created has its creation mode less the umask
		// (see `Fs::with_creation_mask`), unless the parent directory has a
		// default ACL; see the fstat below for when that matters.
		Ok(file) if dest_metadata.is_none() && native => {
			(file, DestFate::Created { mode: Some(create_mode & !host.umask()), owner: None })
		},
		Ok(file) => (file, DestFate::Kept),
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

	// Elsewhere `auto` clones on the open handles, as GNU cp issues FICLONE
	// on its descriptors, and copies the data wherever the files cannot
	// share extents (another filesystem, ext4, NTFS, ...). A source
	// filesystem that refused once is not asked again.
	#[cfg(any(target_os = "linux", target_os = "android", windows))]
	let cloned = match (source_file.native(), dest_file.native()) {
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
	let cloned = false;

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
		DestFate::Created { .. } if matches!(options.attributes.ownership, Preserve::Yes { .. }) => {
			match dest_file.metadata() {
				Ok(metadata) => DestFate::Created {
					mode:  Some(metadata.permissions().mode() & 0o7777),
					owner: metadata.uid().zip(metadata.gid()),
				},
				Err(_) => DestFate::Created { mode: None, owner: None },
			}
		},
		DestFate::Created { owner, .. } if matches!(options.attributes.mode, Preserve::Yes { .. }) => {
			DestFate::Created { mode: None, owner }
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
		return match copy_file(host, state, source, dest, options, false, Some(metadata)) {
			// With --archive a symlink may be copied before the file it names.
			// A move always copies into a fresh tree, so its failure is real:
			// `mv` must report it and keep the source.
			Err(_) if options.preserve_hard_links() && entry_is_symlink && !options.move_mode => Ok(()),
			result => result,
		};
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

	/// `cp --backup` never makes its numbered backup over an entry already
	/// at a backup name, a symlink that points nowhere included, and numbers
	/// after the highest one, as GNU cp does
	/// ([`crate::file_backup::tests::check_numbered_backups`]).
	#[cfg(unix)]
	#[test]
	fn numbered_backups_count_every_entry_at_a_backup_name() {
		crate::file_backup::tests::check_numbered_backups(|dir, control| {
			let (code, capture) = run_util::<Cp>(&[&format!("--backup={control}"), "src", "dest"], "", dir);
			(code, capture.err())
		});
	}

	/// cp refuses a source that is the destination's simple backup as GNU
	/// does: by the source's name and file, in every mode but numbered,
	/// whatever the backup's own name would be. Beside `dest.~3~`, or a
	/// dangling `dest.~1~`, `-b` and `existing` would back up to a numbered
	/// name, and GNU 9.4 and 9.7 still refuse; `numbered` copies and backs
	/// up to `dest.~4~` or `dest.~2~`.
	#[cfg(unix)]
	#[test]
	fn a_source_that_is_the_destinations_simple_backup_is_not_copied_over_it() {
		let cwd = tempfile::tempdir().unwrap();
		let case = |name: &str, dangling_first: bool| {
			let dir = cwd.path().join(name);
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("dest~"), b"payload").unwrap();
			fs::write(dir.join("dest"), b"old").unwrap();
			if dangling_first {
				std::os::unix::fs::symlink("missing", dir.join("dest.~1~")).unwrap();
			} else {
				fs::write(dir.join("dest.~3~"), b"three").unwrap();
			}
			dir
		};
		for control in ["-b", "--backup=existing"] {
			for dangling_first in [false, true] {
				let what = format!("{control}, dangling .~1~: {dangling_first}");
				let dir = case(&format!("{}-{dangling_first}", control.trim_start_matches('-')), dangling_first);
				let (code, capture) = run_util::<Cp>(&[control, "dest~", "dest"], "", &dir);
				assert_eq!(
					(code, capture.err()),
					(1, "cp: backing up 'dest' might destroy source;  'dest~' not copied\n".to_owned()),
					"{what}"
				);
				assert_eq!(fs::read(dir.join("dest")).unwrap(), b"old", "{what}: dest replaced");
				assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"payload", "{what}: the source changed");
			}
		}
		for (dangling_first, backup) in [(false, "dest.~4~"), (true, "dest.~2~")] {
			let dir = case(&format!("numbered-{dangling_first}"), dangling_first);
			let (code, capture) = run_util::<Cp>(&["--backup=numbered", "dest~", "dest"], "", &dir);
			assert_eq!((code, capture.err()), (0, String::new()), "numbered");
			assert_eq!(fs::read(dir.join("dest")).unwrap(), b"payload", "numbered: not copied");
			assert_eq!(fs::read(dir.join(backup)).unwrap(), b"old", "numbered: no backup at {backup}");
		}
	}

	/// `cp --backup=numbered` past the name limit backs up as GNU cp does
	/// ([`crate::file_backup::tests::check_name_limit`]).
	#[cfg(unix)]
	#[test]
	fn a_numbered_backup_past_the_name_limit_ends_in_a_tilde() {
		crate::file_backup::tests::check_name_limit(|dir, name| {
			let (code, capture) = run_util::<Cp>(&["--backup=numbered", "src", name], "", dir);
			(code, capture.err())
		});
	}

	/// `cp -b -S ''` backs up to `dest~`, as GNU cp does
	/// ([`crate::file_backup::tests::check_empty_suffix`]).
	#[cfg(unix)]
	#[test]
	fn an_empty_suffix_backs_up_with_a_tilde() {
		crate::file_backup::tests::check_empty_suffix(|dir| {
			let (code, capture) = run_util::<Cp>(&["-b", "-S", "", "src", "dest"], "", dir);
			(code, capture.err())
		});
	}

	/// `cp` with long names refuses each backup that would replace its source
	/// or the destination itself, or that GNU cp refuses
	/// ([`crate::file_backup::tests::check_long_name_backups`]).
	#[cfg(unix)]
	#[test]
	fn a_long_name_backup_never_replaces_the_source_or_the_destination() {
		crate::file_backup::tests::check_long_name_backups("cp", |dir, args| {
			let (code, capture) = run_util::<Cp>(args, "", dir);
			(code, capture.err())
		});
	}

	/// `cp CONTROL a dest`, where `dest~` is another hard link of `a`, backs
	/// `dest` up over that link and copies, as GNU cp does
	/// ([`crate::file_backup::tests::check_hard_link_backups`]). The check
	/// that refused it is older than this test: it compared the source with
	/// the backup by file identity, so any link of the source matched.
	#[cfg(unix)]
	#[test]
	fn a_backup_over_another_hard_link_of_the_source_is_made() {
		crate::file_backup::tests::check_hard_link_backups("cp", false, |dir, control| {
			let (code, capture) = run_util::<Cp>(&[control, "a", "dest"], "", dir);
			(code, capture.err())
		});
	}

	/// `cp -b x dest`, where `x` is a symbolic link to `dest~`, is refused:
	/// cp follows `x`, and the backup of `dest` would replace the file it
	/// reads. GNU cp 9.4 and 9.7 make the backup first, losing `dest~`'s
	/// contents, then fail ("skipping file 'x', as it was replaced while being
	/// copied"), status 1; here nothing is lost.
	#[cfg(unix)]
	#[test]
	fn a_source_link_to_the_backup_is_not_copied_over_it() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("dest~"), "payload").unwrap();
		fs::write(dir.path().join("dest"), "old").unwrap();
		std::os::unix::fs::symlink("dest~", dir.path().join("x")).unwrap();
		let (code, capture) = run_util::<Cp>(&["-b", "x", "dest"], "", dir.path());
		assert_eq!(
			(code, capture.err()),
			(1, "cp: backing up 'dest' might destroy source;  'x' not copied\n".to_owned())
		);
		assert_eq!(fs::read_to_string(dir.path().join("dest~")).unwrap(), "payload");
		assert_eq!(fs::read_to_string(dir.path().join("dest")).unwrap(), "old");
	}

	/// The backup of a destination that is the source's own file, as GNU cp
	/// 9.4 and 9.7 make it on a Linux kernel (the states are theirs, links
	/// counted; under gVisor, whose rename(2) of two links of one file removes
	/// the source name where Linux does nothing, GNU's own rows differ, and
	/// this port's do not):
	/// - Where `dest` is another entry of the source's file, it is renamed to
	///   the backup name and the copy makes a new `dest`. Where that name is
	///   another link of the same file, the rename does nothing, and GNU's
	///   create of `dest` then fails where it creates a regular file or a
	///   FIFO ("cannot create regular file 'dest': File exists", with `-f`
	///   and `--remove-destination` too) and, without `-f`, a link ("cannot
	///   create hard link 'dest' to 'a'", "cannot create symbolic link
	///   'dest'"), status 1, nothing changed; with `-f` a link replaces
	///   `dest`, and the backup name keeps the old contents.
	/// - Where `dest` is the source's own entry (`cp -fb a a`), the backup is
	///   a copy, refused where the backup name is the source's file ("'a' and
	///   'a~' are the same file"). A symbolic link at the backup name is
	///   replaced, never written through: a link to an unrelated `u` is
	///   replaced and `u` kept. GNU writes through it, losing `u`'s contents
	///   (`a~=link:u u=A#1`): a stated difference. A regular file there is
	///   written as GNU writes it
	///   ([`a_backup_copy_into_a_regular_file_is_written_as_gnu_writes_it`]).
	///   In each mode the backup is a copy of the source as that mode copies:
	///   `cp -l -fb a a` makes `a~` a link of `a`'s file; `cp -s -fb` makes
	///   `a~` a symbolic link to the source and keeps `a` (refused where `a~`
	///   is `a`'s file by its own lstat, so a link `a~ -> a` is replaced, and
	///   refused for a relative source outside the current directory, as GNU
	///   refuses any relative link there); `cp -P -fb l l` copies the link `l`
	///   to `l~`; `cp -fb l l` copies the file `l` leads to; `--attributes-only`
	///   makes an empty `a~`, or keeps the one there. A data copy refuses a
	///   dangling `a~` ("not writing through dangling symlink") and one that
	///   leads to a directory, and every mode refuses a directory at `a~`, with
	///   GNU 9.7's message (9.4's leaves out the source). Without `-f` GNU makes
	///   none of these: `-l` does nothing, `cp -b l l` cannot open the source it
	///   renamed and renames it back, and the others refuse the same file.
	/// - GNU makes that backup only where the two names are the same string
	///   (`STREQ` in `cp.c`, not a comparison of path components): `cp -fb a
	///   ./a`, `cp -fb <dir>/a a`, `cp -fb .//a ./a` and `cp -fb ././a ./a`
	///   are the same file, and `cp -l -fb a ./a` does nothing. `cp -fb l
	///   ./l`, `l` a link to `a`, fails as GNU's does, which backs `./l` up,
	///   cannot open `l` and renames the backup back.
	/// - `-l` reads `a~` with lstat, as GNU does, so `a~ -> a` is replaced by
	///   a hard link of `a`.
	/// - With `--attributes-only` a destination is backed up as in any copy,
	///   and an empty one with the source's attributes made in its place.
	///
	/// Before, the backup was a copy written through the backup name
	/// whenever the source and `dest` were one file: with `dest~` a third
	/// link, or a symbolic link to `a`, the copy emptied all three, status 0.
	#[cfg(unix)]
	#[test]
	fn a_backup_of_the_sources_own_file_is_made_as_gnu_makes_it() {
		let exists = "cp: cannot create regular file 'dest': File exists\n";
		let same = "cp: 'a' and 'a~' are the same file\n";
		let linked = "A>a old>dest dest=dest~ a@l";
		let unchanged = " a=A#1 dest=old#2 dest~=old#2 l=link:a";
		#[rustfmt::skip]
		let cases: [(&str, &str, &[&str], i32, &str, &str); 58] = [
			("three-links", "A>a a=dest a=dest~", &["-b", "a", "dest"], 1, exists, " a=A#3 dest=A#3 dest~=A#3"),
			("three-links", "A>a a=dest a=dest~", &["--backup=simple", "a", "dest"], 1, exists, " a=A#3 dest=A#3 dest~=A#3"),
			("three-links", "A>a a=dest a=dest~", &["--backup=existing", "a", "dest"], 1, exists, " a=A#3 dest=A#3 dest~=A#3"),
			("three-links", "A>a a=dest a=dest~", &["--backup=numbered", "a", "dest"], 0, "", " a=A#3 dest=A#1 dest.~1~=A#3 dest~=A#3"),
			("three-links", "A>a a=dest a=dest~", &["-fb", "a", "dest"], 1, exists, " a=A#3 dest=A#3 dest~=A#3"),
			("dest~-link", "A>a a=dest a@dest~", &["-b", "a", "dest"], 0, "", " a=A#2 dest=A#1 dest~=A#2"),
			("dest~-other", "A>a a=dest U>u u@dest~", &["-b", "a", "dest"], 0, "", " a=A#2 dest=A#1 dest~=A#2 u=U#1"),
			("dest~-none", "A>a a=dest", &["-b", "a", "dest"], 0, "", " a=A#2 dest=A#1 dest~=A#2"),
			("backup-is-dest", "A>a old>dest dest=dest~", &["-b", "a", "dest"], 1, exists, " a=A#1 dest=old#2 dest~=old#2"),
			("linked", linked, &["-fb", "a", "dest"], 1, exists, unchanged),
			("linked", linked, &["--remove-destination", "-b", "a", "dest"], 1, exists, unchanged),
			("linked", linked, &["--attributes-only", "-b", "a", "dest"], 1, exists, unchanged),
			("linked", linked, &["-l", "-b", "a", "dest"], 1, "cp: cannot create hard link 'dest' to 'a': File exists\n", unchanged),
			("linked", linked, &["-s", "-b", "<W>/a", "dest"], 1, "cp: cannot create symbolic link 'dest' to '<W>/a': File exists\n", unchanged),
			("linked", linked, &["-P", "-b", "l", "dest"], 1, "cp: cannot create symbolic link 'dest': File exists\n", unchanged),
			("linked", linked, &["-l", "-fb", "a", "dest"], 0, "", " a=A#2 dest=A#2 dest~=old#1 l=link:a"),
			("linked", linked, &["-s", "-fb", "<W>/a", "dest"], 0, "", " a=A#1 dest=link:<W>/a dest~=old#1 l=link:a"),
			("linked", linked, &["-P", "-fb", "l", "dest"], 0, "", " a=A#1 dest=link:a dest~=old#1 l=link:a"),
			("linked-fifo", "fifo:p old>dest dest=dest~", &["-R", "-b", "p", "dest"], 1, "cp: cannot create fifo 'dest': File exists\n", " dest=old#2 dest~=old#2 p=fifo"),
			("linked-fifo", "fifo:p old>dest dest=dest~", &["-R", "-fb", "p", "dest"], 1, "cp: cannot create fifo 'dest': File exists\n", " dest=old#2 dest~=old#2 p=fifo"),
			("self-hard", "A>a a=a~", &["-fb", "a", "a"], 1, same, " a=A#2 a~=A#2"),
			("self-sym", "A>a a@a~", &["-fb", "a", "a"], 1, same, " a=A#1 a~=link:a"),
			("self-other", "A>a U>u u@a~", &["-fb", "a", "a"], 0, "", " a=A#1 a~=A#1 u=U#1"),
			("self-none", "A>a", &["-fb", "a", "a"], 0, "", " a=A#1 a~=A#1"),
			("self-none", "A>a", &["-b", "a", "a"], 1, "cp: 'a' and 'a' are the same file\n", " a=A#1"),
			("self-l", "A>a", &["-l", "-fb", "a", "a"], 0, "", " a=A#2 a~=A#2"),
			("self-l-hard", "A>a a=a~", &["-l", "-fb", "a", "a"], 0, "", " a=A#2 a~=A#2"),
			("self-l-old", "A>a old>a~", &["-l", "-fb", "a", "a"], 0, "", " a=A#2 a~=A#2"),
			("self-s", "A>a", &["-s", "-fb", "<W>/a", "<W>/a"], 0, "", " a=A#1 a~=link:<W>/a"),
			("self-P", "A>a a@l", &["-P", "-fb", "l", "l"], 0, "", " a=A#1 l=link:a l~=link:a"),
			("self-s-hard", "A>a a=a~", &["-s", "-fb", "<W>/a", "<W>/a"], 1, "cp: '<W>/a' and '<W>/a~' are the same file\n", " a=A#2 a~=A#2"),
			("self-s-old", "A>a old>a~", &["-s", "-fb", "<W>/a", "<W>/a"], 0, "", " a=A#1 a~=link:<W>/a"),
			("self-P-old", "A>a a@l old>l~", &["-P", "-fb", "l", "l"], 0, "", " a=A#1 l=link:a l~=link:a"),
			("self-follow", "A>a a@l", &["-fb", "l", "l"], 0, "", " a=A#1 l=link:a l~=A#1"),
			("self-ao", "A>a", &["--attributes-only", "-fb", "a", "a"], 0, "", " a=A#1 a~=#1"),
			("self-ao-old", "A>a old>a~", &["--attributes-only", "-fb", "a", "a"], 0, "", " a=A#1 a~=old#1"),
			("ao-backup", "A>a old>dest", &["--attributes-only", "-b", "a", "dest"], 0, "", " a=A#1 dest=#1 dest~=old#1"),
			("self-follow-no-f", "A>a a@l", &["-b", "l", "l"], 1, "cp: cannot open 'l' for reading: No such file or directory\n", " a=A#1 l=link:a"),
			("self-P-no-f", "A>a a@l", &["-P", "-b", "l", "l"], 1, "cp: 'l' and 'l' are the same file\n", " a=A#1 l=link:a"),
			("self-s-no-f", "A>a", &["-s", "-b", "a", "a"], 1, "cp: 'a' and 'a' are the same file\n", " a=A#1"),
			("self-l-no-f", "A>a", &["-l", "-b", "a", "a"], 0, "", " a=A#1"),
			("rel-s", "dir:d A>d/a", &["-s", "-fb", "d/a", "d/a"], 1, "cp: d/a~: can make relative symbolic links only in current directory\n", " d=dir"),
			("dangling-a~", "A>a missing@a~", &["-fb", "a", "a"], 1, "cp: not writing through dangling symlink 'a~'\n", " a=A#1 a~=link:missing"),
			("dir-link-a~", "A>a dir:d d@a~", &["-fb", "a", "a"], 1, "cp: cannot overwrite directory 'a~' with non-directory 'a'\n", " a=A#1 a~=link:d d=dir"),
			("s-self-link", "A>a a@a~", &["-s", "-fb", "<W>/a", "<W>/a"], 0, "", " a=A#1 a~=link:<W>/a"),
			("dot", "A>a", &["-fb", "a", "./a"], 1, "cp: 'a' and './a' are the same file\n", " a=A#1"),
			("abs", "A>a", &["-fb", "<W>/a", "a"], 1, "cp: '<W>/a' and 'a' are the same file\n", " a=A#1"),
			("l-dot", "A>a", &["-l", "-fb", "a", "./a"], 0, "", " a=A#1"),
			("s-dot", "A>a", &["-s", "-fb", "<W>/a", "./a"], 1, "cp: '<W>/a' and './a' are the same file\n", " a=A#1"),
			("l-dir", "A>a dir:a~", &["-l", "-fb", "a", "a"], 1, "cp: cannot overwrite directory 'a~' with non-directory 'a'\n", " a=A#1 a~=dir"),
			("s-dir", "A>a dir:a~", &["-s", "-fb", "<W>/a", "<W>/a"], 1, "cp: cannot overwrite directory '<W>/a~' with non-directory '<W>/a'\n", " a=A#1 a~=dir"),
			("P-dir", "A>a a@l dir:l~", &["-P", "-fb", "l", "l"], 1, "cp: cannot overwrite directory 'l~' with non-directory 'l'\n", " a=A#1 l=link:a l~=dir"),
			("dslash", "A>a", &["-fb", ".//a", "./a"], 1, "cp: './/a' and './a' are the same file\n", " a=A#1"),
			("dotdot", "A>a", &["-fb", "././a", "./a"], 1, "cp: '././a' and './a' are the same file\n", " a=A#1"),
			("l-dslash", "A>a", &["-l", "-fb", ".//a", "./a"], 0, "", " a=A#1"),
			("l-dotdot", "A>a", &["-l", "-fb", "././a", "./a"], 0, "", " a=A#1"),
			("link-dot", "A>a a@l", &["-fb", "l", "./l"], 1, "cp: cannot open 'l' for reading: No such file or directory\n", " a=A#1 l=link:a"),
			("l-link-a~", "A>a a@a~", &["-l", "-fb", "a", "a"], 0, "", " a=A#2 a~=A#2"),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (case, setup, args, code, err, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(format!("{index}-{case}"));
			fs::create_dir(&dir).unwrap();
			for step in setup.split(' ') {
				if let Some(name) = step.strip_prefix("dir:") {
					fs::create_dir(dir.join(name)).unwrap();
				} else if let Some(name) = step.strip_prefix("fifo:") {
					let path = std::ffi::CString::new(dir.join(name).into_os_string().into_encoded_bytes()).unwrap();
					// SAFETY: `path` is a NUL-terminated path that outlives the call.
					assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0, "{case}: mkfifo");
				} else if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((original, link)) = step.split_once('=') {
					fs::hard_link(dir.join(original), dir.join(link)).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				}
			}
			let at = |text: &str| text.replace("<W>", &dir.display().to_string());
			let args = args.iter().map(|arg| at(arg)).collect::<Vec<_>>();
			let args = args.iter().map(String::as_str).collect::<Vec<_>>();
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			let found = (got, capture.err(), crate::file_backup::tests::listing(&dir));
			if found != (code, at(err), at(after)) {
				failures.push(format!("{case} cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// A FIFO is refused as the same file only where it is the destination's
	/// own entry, as GNU cp 9.4 and 9.7 refuse it: its backup would be a copy,
	/// and reading the FIFO waits for a writer. There `-l` does nothing, as
	/// GNU's does. Another link of the FIFO is another entry: `cp -R -b p q`,
	/// with `q` a link of `p`, backs `q` up and makes a new FIFO `q`, and
	/// without `-R` the copy reads `p`, as GNU's does. The test opens the FIFO
	/// for writing whenever a reader has it open, so a cp that reads it gets
	/// end of file and ends; each row says whether cp must read it.
	#[cfg(unix)]
	#[test]
	fn a_fifo_is_not_backed_up_onto_itself() {
		use std::os::unix::fs::OpenOptionsExt as _;
		let same = "cp: 'p' and 'p' are the same file\n";
		#[rustfmt::skip]
		let cases: [(&str, bool, &[&str], i32, &str, &str, bool); 7] = [
			("own -R -fb", false, &["-R", "-fb", "p", "p"], 1, same, " p=fifo", false),
			("own -fb", false, &["-fb", "p", "p"], 1, same, " p=fifo", false),
			("own -l -fb", false, &["-l", "-fb", "p", "p"], 0, "", " p=fifo", false),
			("own -s -fb", false, &["-s", "-fb", "<W>/p", "<W>/p"], 1, "cp: '<W>/p' and '<W>/p' are the same file\n", " p=fifo", false),
			("link -R -b", true, &["-R", "-b", "p", "q"], 0, "", " p=fifo q=fifo q~=fifo", false),
			("link -R -fb", true, &["-R", "-fb", "p", "q"], 0, "", " p=fifo q=fifo q~=fifo", false),
			("link -b", true, &["-b", "p", "q"], 0, "", " p=fifo q=#1 q~=fifo", true),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (case, linked, args, code, err, after, reads)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			let fifo = dir.join("p");
			let path = std::ffi::CString::new(fifo.clone().into_os_string().into_encoded_bytes()).unwrap();
			// SAFETY: `path` is a NUL-terminated path that outlives the call.
			assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0, "{case}: mkfifo");
			// gVisor's gofer filesystem refuses a second link of a FIFO
			// (EOPNOTSUPP); there the rows that need one are skipped, saying so.
			if linked && let Err(error) = fs::hard_link(&fifo, dir.join("q")) {
				assert_eq!(error.kind(), std::io::ErrorKind::Unsupported, "{case}: link of the FIFO: {error}");
				eprintln!("{case}: skipped: this filesystem cannot link a FIFO ({error})");
				continue;
			}
			let at = |text: &str| text.replace("<W>", &dir.display().to_string());
			let args = args.iter().map(|arg| at(arg)).collect::<Vec<_>>();
			let (cwd, shown) = (dir.clone(), args.join(" "));
			let cp = std::thread::spawn(move || {
				let args = args.iter().map(String::as_str).collect::<Vec<_>>();
				let (code, capture) = run_util::<Cp>(&args, "", &cwd);
				(code, capture.err())
			});
			let mut read = false;
			while !cp.is_finished() {
				// A writer opens without waiting only while a reader has it
				// open; dropping it at once gives that reader end of file.
				let writer = fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&fifo);
				if writer.is_ok() {
					read = true;
				} else {
					std::thread::yield_now();
				}
			}
			let (got, got_err) = cp.join().unwrap();
			let found = (got, got_err, crate::file_backup::tests::listing(&dir), read);
			if found != (code, at(err), at(after), reads) {
				failures.push(format!("{case} cp {shown}: {found:?}"));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `cp -fb a a` writes its backup copy into a regular file at the backup
	/// name, as GNU cp 9.4 and 9.7 do: in a directory the user cannot write,
	/// into a file with another hard link (both links then hold the copy),
	/// and keeping that file's mode. With nothing there the backup is a new
	/// file, created exclusively, with `a`'s mode; a file that cannot be
	/// opened for writing is removed and created again, as `-f` replaces a
	/// destination; a directory there is refused with GNU 9.7's message (9.4's
	/// leaves out `'a'`). A symbolic link there is replaced by a new file
	/// renamed over it, never written through, so in a directory the user
	/// cannot write that backup fails; GNU writes through the link and loses
	/// its target's contents. Each row has GNU's answer as uid 1000 and as
	/// root, who writes a file of mode 444 in place and writes a directory of
	/// mode 555; the read-only rows of `-l`, `-s` and `-P` have GNU's messages.
	#[cfg(unix)]
	#[test]
	fn a_backup_copy_into_a_regular_file_is_written_as_gnu_writes_it() {
		use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
		type Outcome = (i32, &'static str, &'static str, &'static [(&'static str, u32)]);
		let root = tempdir().unwrap();
		let root_user = nix::unistd::geteuid().is_root();
		let mode = |path: &std::path::Path| fs::symlink_metadata(path).unwrap().mode() & 0o7777;
		let fb: &[&str] = &["-fb", "a", "a"];
		let denied = "cp: cannot create regular file 'a~': Permission denied\n";
		#[rustfmt::skip]
		let cases: [(&str, &str, &[&str], Outcome, Outcome); 13] = [
			("read-only-dir", "old>a~ a~:640 .:555", fb, (0, "", " a=A#1 a~=A#1", &[("a~", 0o640)]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o640)])),
			("other-link", "old>a~ a~=h", fb, (0, "", " a=A#1 a~=A#2 h=A#2", &[]), (0, "", " a=A#1 a~=A#2 h=A#2", &[])),
			("mode", "old>a~ a~:600", fb, (0, "", " a=A#1 a~=A#1", &[("a~", 0o600)]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o600)])),
			("new", "a:640", fb, (0, "", " a=A#1 a~=A#1", &[("a~", 0o640)]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o640)])),
			("read-only-file", "old>a~ a~:444", fb, (0, "", " a=A#1 a~=A#1", &[("a~", 0o644)]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o444)])),
			("directory", "dir:a~", fb, (1, "cp: cannot overwrite directory 'a~' with non-directory 'a'\n", " a=A#1 a~=dir", &[]), (1, "cp: cannot overwrite directory 'a~' with non-directory 'a'\n", " a=A#1 a~=dir", &[])),
			("read-only-dir-link", "U>u u@a~ .:555", fb, (1, denied, " a=A#1 a~=link:u u=U#1", &[]), (0, "", " a=A#1 a~=A#1 u=U#1", &[])),
			("read-only-dir-new", ".:555", fb, (1, denied, " a=A#1", &[]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o644)])),
			("read-only-dir-444", "old>a~ a~:444 .:555", fb, (1, "cp: cannot remove 'a~': Permission denied\n", " a=A#1 a~=old#1", &[("a~", 0o444)]), (0, "", " a=A#1 a~=A#1", &[("a~", 0o444)])),
			("read-only-dir-l", ".:555", &["-l", "-fb", "a", "a"], (1, "cp: cannot create hard link 'a~' to 'a': Permission denied\n", " a=A#1", &[]), (0, "", " a=A#2 a~=A#2", &[])),
			("read-only-dir-s", ".:555", &["-s", "-fb", "<W>/a", "<W>/a"], (1, "cp: cannot create symbolic link '<W>/a~' to '<W>/a': Permission denied\n", " a=A#1", &[]), (0, "", " a=A#1 a~=link:<W>/a", &[])),
			("read-only-dir-P", "a@l .:555", &["-P", "-fb", "l", "l"], (1, "cp: cannot create symbolic link 'l~': Permission denied\n", " a=A#1 l=link:a", &[]), (0, "", " a=A#1 l=link:a l~=link:a", &[])),
			("unsearchable", "dir:d F>d/f d/f@a~ d:000", fb, (1, "cp: cannot stat 'a~': Permission denied\n", " a=A#1 a~=link:d/f d=dir", &[]), (0, "", " a=A#1 a~=A#1 d=dir", &[])),
		];
		let mut failures = Vec::new();
		for (case, setup, args, as_user, as_root) in cases {
			let (code, err, after, modes) = if root_user { as_root } else { as_user };
			let dir = root.path().join(case);
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("a"), "A").unwrap();
			fs::set_permissions(dir.join("a"), fs::Permissions::from_mode(0o644)).unwrap();
			for step in setup.split(' ') {
				if let Some(name) = step.strip_prefix("dir:") {
					fs::create_dir(dir.join(name)).unwrap();
				} else if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((original, link)) = step.split_once('=') {
					fs::hard_link(dir.join(original), dir.join(link)).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				} else if let Some((name, octal)) = step.split_once(':') {
					let bits = u32::from_str_radix(octal, 8).unwrap();
					fs::set_permissions(dir.join(name), fs::Permissions::from_mode(bits)).unwrap();
				}
			}
			let at = |text: &str| text.replace("<W>", &dir.display().to_string());
			let args = args.iter().map(|arg| at(arg)).collect::<Vec<_>>();
			let args = args.iter().map(String::as_str).collect::<Vec<_>>();
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
			for step in setup.split(' ') {
				if let Some((name, _)) = step.split_once(':')
					&& name != "dir"
					&& dir.join(name).is_dir()
				{
					fs::set_permissions(dir.join(name), fs::Permissions::from_mode(0o755)).unwrap();
				}
			}
			let listed = crate::file_backup::tests::listing(&dir);
			let found_modes = modes.iter().map(|&(name, _)| mode(&dir.join(name))).collect::<Vec<_>>();
			let expected_modes = modes.iter().map(|&(_, bits)| bits).collect::<Vec<_>>();
			if (got, capture.err(), listed.clone(), &found_modes) != (code, at(err), at(after), &expected_modes) {
				let octal = found_modes.iter().map(|bits| format!("{bits:o}")).collect::<Vec<_>>();
				failures.push(format!("{case}: {got} {:?} {listed:?} modes {octal:?}", capture.err()));
			}
		}
		let who = if root_user { "root" } else { "a user" };
		assert!(failures.is_empty(), "rows that differ from GNU as {who}:\n{}", failures.join("\n"));
	}

	/// `cp -i -b` where `dest~` is another link of `dest`, answered yes: the
	/// rename that makes the backup does nothing, and GNU cp 9.4 and 9.7 then
	/// replace `dest` with a hard link (`-l`), as they do under `-f`, and
	/// refuse a symbolic link, a copied link and a regular file ("File
	/// exists"), nothing changed.
	#[cfg(unix)]
	#[test]
	fn an_interactive_backup_onto_a_linked_destination_is_made_as_gnu_makes_it() {
		let unchanged = " a=A#1 dest=old#2 dest~=old#2 l=link:a";
		let prompt = "cp: overwrite 'dest'? ";
		#[rustfmt::skip]
		let cases: [(&[&str], i32, &str, &str); 4] = [
			(&["-i", "-l", "-b", "a", "dest"], 0, "", " a=A#2 dest=A#2 dest~=old#1 l=link:a"),
			(&["-i", "-s", "-b", "<W>/a", "dest"], 1, "cp: cannot create symbolic link 'dest' to '<W>/a': File exists\n", unchanged),
			(&["-i", "-P", "-b", "l", "dest"], 1, "cp: cannot create symbolic link 'dest': File exists\n", unchanged),
			(&["-i", "-b", "a", "dest"], 1, "cp: cannot create regular file 'dest': File exists\n", unchanged),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (args, code, err, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("a"), "A").unwrap();
			std::os::unix::fs::symlink("a", dir.join("l")).unwrap();
			fs::write(dir.join("dest"), "old").unwrap();
			fs::hard_link(dir.join("dest"), dir.join("dest~")).unwrap();
			let at = |text: &str| text.replace("<W>", &dir.display().to_string());
			let args = args.iter().map(|arg| at(arg)).collect::<Vec<_>>();
			let args = args.iter().map(String::as_str).collect::<Vec<_>>();
			let (got, capture) = run_util::<Cp>(&args, "y\n", &dir);
			let found = (got, capture.err(), crate::file_backup::tests::listing(&dir));
			if found != (code, format!("{prompt}{}", at(err)), at(after)) {
				failures.push(format!("cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `-v` reports the backup of the source's own entry as GNU cp 9.4 and 9.7
	/// report it, `'a' -> 'a~'`, in every mode; `-l` reports nothing where
	/// `a~` is already `a`'s file and nothing is made. A backup by renaming is
	/// reported with the copy, as before.
	#[cfg(unix)]
	#[test]
	fn a_backup_of_the_sources_own_entry_is_reported_by_v() {
		#[rustfmt::skip]
		let cases: [(&str, &[&str], &str, &str); 8] = [
			("A>a", &["-fbv", "a", "a"], "'a' -> 'a~'\n", " a=A#1 a~=A#1"),
			("A>a old>a~", &["-fbv", "a", "a"], "'a' -> 'a~'\n", " a=A#1 a~=A#1"),
			("A>a", &["-l", "-fbv", "a", "a"], "'a' -> 'a~'\n", " a=A#2 a~=A#2"),
			("A>a", &["-s", "-fbv", "<W>/a", "<W>/a"], "'<W>/a' -> '<W>/a~'\n", " a=A#1 a~=link:<W>/a"),
			("A>a a@l", &["-P", "-fbv", "l", "l"], "'l' -> 'l~'\n", " a=A#1 l=link:a l~=link:a"),
			("A>a a@l", &["-fbv", "l", "l"], "'l' -> 'l~'\n", " a=A#1 l=link:a l~=A#1"),
			("A>a a=a~", &["-l", "-fbv", "a", "a"], "", " a=A#2 a~=A#2"),
			("A>a old>dest", &["-bv", "a", "dest"], "'a' -> 'dest' (backup: 'dest~')\n", " a=A#1 dest=A#1 dest~=old#1"),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (setup, args, out, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			for step in setup.split(' ') {
				if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((original, link)) = step.split_once('=') {
					fs::hard_link(dir.join(original), dir.join(link)).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				}
			}
			let at = |text: &str| text.replace("<W>", &dir.display().to_string());
			let args = args.iter().map(|arg| at(arg)).collect::<Vec<_>>();
			let args = args.iter().map(String::as_str).collect::<Vec<_>>();
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			let found = (got, capture.out(), capture.err(), crate::file_backup::tests::listing(&dir));
			if found != (0, at(out), String::new(), at(after)) {
				failures.push(format!("cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `cp -fbp a a` gives the backup `a`'s mode and modification time, as GNU
	/// cp 9.4 and 9.7 do, whether `a~` is new or an existing file of another
	/// mode; without `-p` an existing `a~` keeps its mode (the `mode` row of
	/// [`a_backup_copy_into_a_regular_file_is_written_as_gnu_writes_it`]). A
	/// backup copied as a link (`cp -P -fbp l l`, `cp -a -fb l l`) takes the
	/// link's own times, and one made by `cp -s -fbp` the source's, as GNU's
	/// do; without `-p` the copied link has its own new times.
	#[cfg(unix)]
	#[test]
	fn a_backup_of_the_sources_own_entry_takes_its_attributes_under_p() {
		use std::os::unix::{
			ffi::OsStrExt as _,
			fs::{MetadataExt as _, PermissionsExt as _},
		};
		let at = |secs: u64| std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
		for existing in [false, true] {
			let dir = tempdir().unwrap();
			let a = dir.path().join("a");
			fs::write(&a, "A").unwrap();
			fs::set_permissions(&a, fs::Permissions::from_mode(0o640)).unwrap();
			fs::File::options().write(true).open(&a).unwrap().set_modified(at(1_600_000_000)).unwrap();
			if existing {
				fs::write(dir.path().join("a~"), "old").unwrap();
				fs::set_permissions(dir.path().join("a~"), fs::Permissions::from_mode(0o600)).unwrap();
			}
			let (code, capture) = run_util::<Cp>(&["-fbp", "a", "a"], "", dir.path());
			let backup = fs::metadata(dir.path().join("a~")).unwrap();
			assert_eq!(
				(code, capture.err(), fs::read_to_string(dir.path().join("a~")).unwrap()),
				(0, String::new(), "A".to_owned()),
				"existing a~: {existing}"
			);
			assert_eq!(
				(backup.mode() & 0o7777, backup.mtime()),
				(0o640, 1_600_000_000),
				"existing a~: {existing}: a~'s mode and modification time"
			);
		}
		// The link's own times, set without following it.
		let set_link_time = |path: &std::path::Path, secs: i64| {
			let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
			// SAFETY: `timespec` is plain data, all zero a valid value.
			let mut time: libc::timespec = unsafe { std::mem::zeroed() };
			time.tv_sec = secs;
			let times = [time, time];
			// SAFETY: `path` is NUL-terminated and `times` holds two values,
			// both outliving the call.
			let set = unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
			assert_eq!(set, 0, "utimensat");
		};
		#[rustfmt::skip]
		let links: [(&[&str], &str, Option<i64>); 4] = [
			(&["-P", "-fbp", "l", "l"], "l~", Some(1_000_000_000)),
			(&["-a", "-fb", "l", "l"], "l~", Some(1_000_000_000)),
			(&["-P", "-fb", "l", "l"], "l~", None),
			(&["-s", "-fbp", "<W>/a", "<W>/a"], "a~", Some(1_500_000_000)),
		];
		let mut failures = Vec::new();
		for (args, backup, time) in links {
			let dir = tempdir().unwrap();
			let a = dir.path().join("a");
			fs::write(&a, "A").unwrap();
			fs::File::options().write(true).open(&a).unwrap().set_modified(at(1_500_000_000)).unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			set_link_time(&dir.path().join("l"), 1_000_000_000);
			let args = args.iter().map(|arg| arg.replace("<W>", &dir.path().display().to_string())).collect::<Vec<_>>();
			let args = args.iter().map(String::as_str).collect::<Vec<_>>();
			let (code, capture) = run_util::<Cp>(&args, "", dir.path());
			let made = fs::symlink_metadata(dir.path().join(backup));
			let is_link = made.as_ref().is_ok_and(fs::Metadata::is_symlink);
			let mtime = made.map(|metadata| metadata.mtime()).ok();
			let ok = (code, capture.err().as_str(), is_link) == (0, "", true)
				&& match time {
					Some(time) => mtime == Some(time),
					None => mtime.is_some_and(|mtime| mtime != 1_000_000_000),
				};
			if !ok {
				failures.push(format!("cp {}: {code} {:?} link {is_link} mtime {mtime:?}", args.join(" "), capture.err()));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `cp -i -fb a a` makes the backup as `cp -fb a a` does, as GNU cp 9.4
	/// and 9.7 make it: GNU turns it into a copy of `a` to `a~` (`cp.c`), so
	/// it asks only about an `a~` already there, "overwrite 'a~'?", and on no
	/// keeps it, with status 1.
	#[cfg(unix)]
	#[test]
	fn an_interactive_backup_of_the_sources_own_entry_asks_about_the_backup() {
		let prompt = "cp: overwrite 'a~'? ";
		#[rustfmt::skip]
		let cases: [(bool, &str, i32, &str, &str); 3] = [
			(false, "", 0, "", " a=A#1 a~=A#1"),
			(true, "y\n", 0, prompt, " a=A#1 a~=A#1"),
			(true, "n\n", 1, prompt, " a=A#1 a~=old#1"),
		];
		let mut failures = Vec::new();
		for (existing, answer, code, err, after) in cases {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), "A").unwrap();
			if existing {
				fs::write(dir.path().join("a~"), "old").unwrap();
			}
			let (got, capture) = run_util::<Cp>(&["-i", "-fb", "a", "a"], answer, dir.path());
			let found = (got, capture.err(), crate::file_backup::tests::listing(dir.path()));
			if found != (code, err.to_owned(), after.to_owned()) {
				failures.push(format!("a~ there: {existing}, answer {answer:?}: {found:?}"));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `cp -u -fb a a` compares `a` with its backup name, as GNU cp 9.4 and
	/// 9.7 do (`cp.c` turns it into a copy of `a` to `a~`): with no `a~`, or
	/// an older one, it makes `a~`, and it keeps a newer one.
	#[cfg(unix)]
	#[test]
	fn an_update_of_the_sources_own_entry_compares_it_with_the_backup() {
		let at = |secs: u64| std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs);
		#[rustfmt::skip]
		let cases: [(Option<u64>, &str); 3] = [
			(None, " a=A#1 a~=A#1"),
			(Some(1_000_000_000), " a=A#1 a~=A#1"),
			(Some(2_000_000_000), " a=A#1 a~=old#1"),
		];
		let mut failures = Vec::new();
		for (backup_time, after) in cases {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), "A").unwrap();
			fs::File::options().write(true).open(dir.path().join("a")).unwrap().set_modified(at(1_500_000_000)).unwrap();
			if let Some(time) = backup_time {
				fs::write(dir.path().join("a~"), "old").unwrap();
				fs::File::options().write(true).open(dir.path().join("a~")).unwrap().set_modified(at(time)).unwrap();
			}
			let (got, capture) = run_util::<Cp>(&["-u", "-fb", "a", "a"], "", dir.path());
			let found = (got, capture.err(), crate::file_backup::tests::listing(dir.path()));
			if found != (0, String::new(), after.to_owned()) {
				failures.push(format!("a~ time {backup_time:?}: {found:?}"));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// Own entries GNU cp 9.4 and 9.7 do not turn into a copy to the backup
	/// name, and the questions `-i` asks and the times `-u` compares, as GNU's
	/// (the same as uid 1000 and as root). GNU turns `cp -fb a a` into a copy
	/// of `a` to `a~` only where `stat` reads `a` as a regular file (`cp.c`),
	/// and asks about, and compares with, `a~` only where `stat` of it succeeds
	/// (`copy.c`):
	/// - a FIFO, or a link to nothing read as a link, that is its own
	///   destination is the same file before any question or update check;
	/// - `-l` asks about a destination that is already the source's file and
	///   then does nothing, a FIFO own entry included;
	/// - a link at `a~` to nothing is not asked about, and `-u` compares `a`
	///   with what a link at `a~` leads to;
	/// - `cp -fb l ./l` (`l` a link cp follows) asks and compares before it
	///   cannot open `l`, and names `l` as it was given (`.//l`), and so does
	///   `cp -fb l l` where `l` leads to a FIFO (`stat` reads no regular file,
	///   so nothing is turned into a copy, and the destination's lstat, a
	///   link, is another file than the FIFO cp follows); `-P` or `-R` reads
	///   `l` itself, which is the same file.
	///
	/// Rows ending in `(stated)` differ from GNU, as stated in the CHANGELOG:
	/// a link at `a~` is replaced, where GNU writes through it.
	///
	/// A cp that opens a row's FIFO for reading would wait for a writer and
	/// hang the test: while the row runs, the test opens the FIFO's write end
	/// without waiting and closes it, so that cp reads end-of-file and the row
	/// fails at once, saying so.
	#[cfg(unix)]
	#[test]
	fn an_own_entry_is_asked_about_and_compared_as_gnu_does() {
		use std::os::unix::ffi::OsStrExt as _;
		let same_p = "cp: 'p' and 'p' are the same file\n";
		let open_l = "cp: cannot open 'l' for reading: No such file or directory\n";
		let dangling = "cp: not writing through dangling symlink 'a~'\n";
		#[rustfmt::skip]
		let cases: [(&str, &str, &[&str], &str, i32, &str, &str); 36] = [
			("fifo -i y", "fifo:p old>p~", &["-R", "-i", "-fb", "p", "p"], "y\n", 1, same_p, " p=fifo p~=old#1"),
			("fifo -i n", "fifo:p old>p~", &["-R", "-i", "-fb", "p", "p"], "n\n", 1, same_p, " p=fifo p~=old#1"),
			("fifo -i none", "fifo:p", &["-R", "-i", "-fb", "p", "p"], "", 1, same_p, " p=fifo"),
			("fifo -u newer", "fifo:p t:p=1000000000 old>p~ t:p~=2000000000", &["-R", "-u", "-fb", "p", "p"], "", 1, same_p, " p=fifo p~=old#1"),
			("fifo -u none", "fifo:p", &["-R", "-u", "-fb", "p", "p"], "", 1, same_p, " p=fifo"),
			("fifo -l", "fifo:p", &["-l", "-fb", "p", "p"], "", 0, "", " p=fifo"),
			("fifo -l -i y", "fifo:p", &["-l", "-i", "-fb", "p", "p"], "y\n", 0, "cp: overwrite 'p'? ", " p=fifo"),
			("fifo -l -i n", "fifo:p", &["-l", "-i", "-fb", "p", "p"], "n\n", 1, "cp: overwrite 'p'? ", " p=fifo"),
			("-l -i -b ./a y", "A>a", &["-l", "-i", "-b", "a", "./a"], "y\n", 0, "cp: overwrite './a'? ", " a=A#1"),
			("-l -i -b ./a n", "A>a", &["-l", "-i", "-b", "a", "./a"], "n\n", 1, "cp: overwrite './a'? ", " a=A#1"),
			("-l -i -fb ./a y", "A>a", &["-l", "-i", "-fb", "a", "./a"], "y\n", 0, "cp: overwrite './a'? ", " a=A#1"),
			("-l -i -fb ./a n", "A>a", &["-l", "-i", "-fb", "a", "./a"], "n\n", 1, "cp: overwrite './a'? ", " a=A#1"),
			("-l -i -b a y", "A>a", &["-l", "-i", "-b", "a", "a"], "y\n", 0, "cp: overwrite 'a'? ", " a=A#1"),
			("-l -i -b a n", "A>a", &["-l", "-i", "-b", "a", "a"], "n\n", 1, "cp: overwrite 'a'? ", " a=A#1"),
			("-l -i -fb no a~", "A>a", &["-l", "-i", "-fb", "a", "a"], "n\n", 0, "", " a=A#2 a~=A#2"),
			("-l -i -fb a~ y", "A>a old>a~", &["-l", "-i", "-fb", "a", "a"], "y\n", 0, "cp: overwrite 'a~'? ", " a=A#2 a~=A#2"),
			("-l -i -fb a~ n", "A>a old>a~", &["-l", "-i", "-fb", "a", "a"], "n\n", 1, "cp: overwrite 'a~'? ", " a=A#1 a~=old#1"),
			("-i dangling a~", "A>a missing@a~", &["-i", "-fb", "a", "a"], "y\n", 1, dangling, " a=A#1 a~=link:missing"),
			("-i a~ -> u (stated)", "A>a U>u u@a~", &["-i", "-fb", "a", "a"], "y\n", 0, "cp: overwrite 'a~'? ", " a=A#1 a~=A#1 u=U#1"),
			("-u u older (stated)", "A>a t:a=2000000000 U>u t:u=1000000000 u@a~", &["-u", "-fb", "a", "a"], "", 0, "", " a=A#1 a~=A#1 u=U#1"),
			("-u u newer", "A>a t:a=1000000000 U>u t:u=2000000000 u@a~ lt:a~=500000000", &["-u", "-fb", "a", "a"], "", 0, "", " a=A#1 a~=link:u u=U#1"),
			("-u dangling a~", "A>a missing@a~", &["-u", "-fb", "a", "a"], "", 1, dangling, " a=A#1 a~=link:missing"),
			("-P dangling own", "missing@l", &["-P", "-fb", "l", "l"], "", 1, "cp: 'l' and 'l' are the same file\n", " l=link:missing"),
			("dangling own", "missing@l", &["-fb", "l", "l"], "", 1, "cp: cannot stat 'l': No such file or directory\n", " l=link:missing"),
			("-i l ./l y", "A>a a@l", &["-i", "-fb", "l", "./l"], "y\n", 1, "cp: overwrite './l'? cp: cannot open 'l' for reading: No such file or directory\n", " a=A#1 l=link:a"),
			("-i l ./l n", "A>a a@l", &["-i", "-fb", "l", "./l"], "n\n", 1, "cp: overwrite './l'? ", " a=A#1 l=link:a"),
			("-u l ./l older", "A>a t:a=1000000000 a@l lt:l=2000000000", &["-u", "-fb", "l", "./l"], "", 0, "", " a=A#1 l=link:a"),
			("-u l ./l newer", "A>a t:a=2000000000 a@l lt:l=1000000000", &["-u", "-fb", "l", "./l"], "", 1, open_l, " a=A#1 l=link:a"),
			(".//l ./l", "A>a a@l", &["-fb", ".//l", "./l"], "", 1, "cp: cannot open './/l' for reading: No such file or directory\n", " a=A#1 l=link:a"),
			("fifo link -fb l l", "fifo:p p@l", &["-fb", "l", "l"], "", 1, open_l, " l=link:p p=fifo"),
			("fifo link -i y", "fifo:p p@l", &["-i", "-fb", "l", "l"], "y\n", 1, "cp: overwrite 'l'? cp: cannot open 'l' for reading: No such file or directory\n", " l=link:p p=fifo"),
			("fifo link -i n", "fifo:p p@l", &["-i", "-fb", "l", "l"], "n\n", 1, "cp: overwrite 'l'? ", " l=link:p p=fifo"),
			("fifo link -u older", "fifo:p t:p=1000000000 p@l", &["-u", "-fb", "l", "l"], "", 0, "", " l=link:p p=fifo"),
			("fifo link -u newer", "fifo:p t:p=2000000000 p@l lt:l=1000000000", &["-u", "-fb", "l", "l"], "", 1, open_l, " l=link:p p=fifo"),
			("fifo link -P", "fifo:p p@l", &["-P", "-fb", "l", "l"], "", 1, "cp: 'l' and 'l' are the same file\n", " l=link:p p=fifo"),
			("fifo link -R", "fifo:p p@l", &["-R", "-fb", "l", "l"], "", 1, "cp: 'l' and 'l' are the same file\n", " l=link:p p=fifo"),
		];
		// A path's times, set without opening it (a FIFO would wait), following
		// a link or not.
		let set_time = |path: &std::path::Path, secs: i64, follow: bool| {
			let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
			// SAFETY: `timespec` is plain data, all zero a valid value.
			let mut time: libc::timespec = unsafe { std::mem::zeroed() };
			time.tv_sec = secs;
			let times = [time, time];
			let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
			// SAFETY: `path` is NUL-terminated and `times` holds two values,
			// both outliving the call.
			assert_eq!(unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), flags) }, 0, "utimensat");
		};
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (case, setup, args, answer, code, err, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			for step in setup.split(' ') {
				if let Some(name) = step.strip_prefix("fifo:") {
					let path = std::ffi::CString::new(dir.join(name).into_os_string().into_encoded_bytes()).unwrap();
					// SAFETY: `path` is a NUL-terminated path that outlives the call.
					assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0, "{case}: mkfifo");
				} else if let Some(rest) = step.strip_prefix("lt:") {
					let (name, secs) = rest.split_once('=').unwrap();
					set_time(&dir.join(name), secs.parse().unwrap(), false);
				} else if let Some(rest) = step.strip_prefix("t:") {
					let (name, secs) = rest.split_once('=').unwrap();
					set_time(&dir.join(name), secs.parse().unwrap(), true);
				} else if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				}
			}
			// The write end opens without waiting only while something has the
			// FIFO open for reading, which here only cp can do.
			let fifos: Vec<_> = setup.split(' ').filter_map(|step| step.strip_prefix("fifo:")).map(|name| dir.join(name)).collect();
			let (row_done, done) = std::sync::mpsc::channel::<()>();
			let guard = (!fifos.is_empty()).then(|| {
				std::thread::spawn(move || {
					use std::os::unix::fs::OpenOptionsExt as _;
					let mut read = false;
					while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
						done.recv_timeout(std::time::Duration::from_millis(100))
					{
						for fifo in &fifos {
							read |= fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(fifo).is_ok();
						}
					}
					read
				})
			});
			let (got, capture) = run_util::<Cp>(args, answer, &dir);
			drop(row_done);
			let read_fifo = guard.is_some_and(|guard| guard.join().unwrap());
			let found = (got, capture.err(), crate::file_backup::tests::listing(&dir));
			if read_fifo {
				failures.push(format!(
					"{case}: cp {}: cp opened the FIFO for reading and waited for a writer (the test closed a write end to end the wait): {found:?}",
					args.join(" ")
				));
			} else if found != (code, err.to_owned(), after.to_owned()) {
				failures.push(format!("{case}: cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `--remove-destination` keeps a source that is its own destination, as
	/// GNU cp 9.4 and 9.7 do (the same as uid 1000 and as root): GNU decides
	/// whether the two are the same file (`copy.c`, `same_file_ok`) before it
	/// backs up or removes anything. It removes a destination that is a
	/// symbolic link, or another hard link of the source's file in another
	/// entry; the source's own entry, by any name (`./a`, `.`, an absolute
	/// path, `d//a`), is the same file. `<D>` stands for the row's directory.
	///
	/// Rows ending in `(stated)` differ from GNU, as stated in the CHANGELOG:
	/// GNU's `cp --remove-destination l ./l` and `l l`, `l` a link it follows,
	/// remove `l` and then cannot open it; here `l` stays.
	#[cfg(unix)]
	#[test]
	fn a_remove_destination_keeps_its_own_source_as_gnu_does() {
		let same = |a: &str, b: &str| format!("cp: '{a}' and '{b}' are the same file\n");
		let open_l = "cp: cannot open 'l' for reading: No such file or directory\n".to_owned();
		let rd = "--remove-destination";
		#[rustfmt::skip]
		let cases: [(&str, &str, &[&str], i32, String, &str); 30] = [
			("own ./a", "A>a", &[rd, "a", "./a"], 1, same("a", "./a"), " a=A#1"),
			("own .", "A>a", &[rd, "a", "."], 1, same("a", "./a"), " a=A#1"),
			("own absolute", "A>a", &[rd, "<D>/a", "a"], 1, same("<D>/a", "a"), " a=A#1"),
			("own d//a", "dir:d A>d/a", &[rd, "d//a", "d/a"], 1, same("d//a", "d/a"), " d=dir d/a=A#1"),
			("own d/./a", "dir:d A>d/a", &[rd, "d/./a", "d/a"], 1, same("d/./a", "d/a"), " d=dir d/a=A#1"),
			("own a a", "A>a", &[rd, "a", "a"], 1, same("a", "a"), " a=A#1"),
			("own into d", "dir:d A>d/a", &[rd, "d/a", "d"], 1, same("d/a", "d/a"), " d=dir d/a=A#1"),
			("own ./a, 2 links", "A>a ln:a=b", &[rd, "a", "./a"], 1, same("a", "./a"), " a=A#2 b=A#2"),
			("own -f ./a", "A>a", &[rd, "-f", "a", "./a"], 1, same("a", "./a"), " a=A#1"),
			("own -l ./a", "A>a", &[rd, "-l", "a", "./a"], 0, String::new(), " a=A#1"),
			("own -s ./a", "A>a", &[rd, "-s", "<D>/a", "./a"], 1, same("<D>/a", "./a"), " a=A#1"),
			("own -b ./a", "A>a", &[rd, "-b", "a", "./a"], 1, same("a", "./a"), " a=A#1"),
			("own -fb ./a", "A>a", &[rd, "-fb", "a", "./a"], 1, same("a", "./a"), " a=A#1"),
			("own -fb a a", "A>a", &[rd, "-fb", "a", "a"], 0, String::new(), " a=A#1 a~=A#1"),
			("link ./l (stated)", "A>a a@l", &[rd, "l", "./l"], 1, open_l.clone(), " a=A#1 l=link:a"),
			("link -P ./l", "A>a a@l", &[rd, "-P", "l", "./l"], 1, same("l", "./l"), " a=A#1 l=link:a"),
			("link -b ./l", "A>a a@l", &[rd, "-b", "l", "./l"], 1, open_l.clone(), " a=A#1 l=link:a"),
			("link -P -b ./l", "A>a a@l", &[rd, "-P", "-b", "l", "./l"], 1, same("l", "./l"), " a=A#1 l=link:a"),
			("link onto its target", "A>a a@l", &[rd, "l", "a"], 1, same("l", "a"), " a=A#1 l=link:a"),
			("link l l (stated)", "A>a a@l", &[rd, "l", "l"], 1, open_l.clone(), " a=A#1 l=link:a"),
			("link -P l l", "A>a a@l", &[rd, "-P", "l", "l"], 1, same("l", "l"), " a=A#1 l=link:a"),
			("link -b l l", "A>a a@l", &[rd, "-b", "l", "l"], 1, open_l, " a=A#1 l=link:a"),
			("-l onto a link to the source", "A>a a@l", &[rd, "-l", "a", "l"], 0, String::new(), " a=A#2 l=A#2"),
			("-l onto a link to the source, no -r-d", "A>a a@l", &["-l", "a", "l"], 1, "cp: cannot create hard link 'l' to 'a': File exists\n".to_owned(), " a=A#1 l=link:a"),
			("another link", "A>a ln:a=b", &[rd, "a", "b"], 0, String::new(), " a=A#1 b=A#1"),
			("another link in d", "dir:d A>a ln:a=d/b", &[rd, "a", "d/b"], 0, String::new(), " a=A#1 d=dir d/b=A#1"),
			("another link -b", "A>a ln:a=b", &[rd, "-b", "a", "b"], 0, String::new(), " a=A#2 b=A#1 b~=A#2"),
			("a link to the source", "A>a a@l", &[rd, "a", "l"], 0, String::new(), " a=A#1 l=A#1"),
			("a link to the source -b", "A>a a@l", &[rd, "-b", "a", "l"], 0, String::new(), " a=A#1 l=A#1 l~=link:a"),
			("another file", "A>a B>b", &[rd, "a", "b"], 0, String::new(), " a=A#1 b=A#1"),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (case, setup, args, code, err, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			for step in setup.split(' ') {
				if let Some(name) = step.strip_prefix("dir:") {
					fs::create_dir(dir.join(name)).unwrap();
				} else if let Some((from, to)) = step.strip_prefix("ln:").and_then(|link| link.split_once('=')) {
					fs::hard_link(dir.join(from), dir.join(to)).unwrap();
				} else if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				}
			}
			let shown = dir.to_str().unwrap();
			let args: Vec<String> = args.iter().map(|arg| arg.replace("<D>", shown)).collect();
			let args: Vec<&str> = args.iter().map(String::as_str).collect();
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			// `find | sort`: the entries of `d` follow `d`, the last name here.
			let mut entries = crate::file_backup::tests::listing(&dir);
			if dir.join("d").is_dir() {
				entries += &crate::file_backup::tests::listing(&dir.join("d")).replace(' ', " d/");
			}
			let found = (got, capture.err(), entries);
			if found != (code, err.replace("<D>", shown), after.to_owned()) {
				failures.push(format!("{case}: cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// The backup copy of `cp -fb a a` never writes through a symbolic link
	/// put at `a~` after cp looked at the name (test hooks put it there,
	/// pointing at `victim`): an existing regular `a~` is opened without
	/// following a link (`O_NOFOLLOW`), and on that failure `-f` removes the
	/// link and creates `a~` exclusively; where nothing was at `a~`, it is
	/// created exclusively (`O_EXCL`), so the link there fails the copy, with
	/// GNU's message for a create that finds a name taken. The third row puts
	/// the link back between that removal and the create, so only an
	/// exclusive create there keeps `victim`.
	#[cfg(unix)]
	#[test]
	fn a_link_put_at_the_backup_name_is_not_written_through() {
		use std::sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		};
		let taken = "cp: cannot create regular file 'a~': File exists\n";
		#[rustfmt::skip]
		let cases: [(bool, usize, i32, &str, &str); 3] = [
			(true, 1, 0, "", " a=A#1 a~=A#1 victim=V#1"),
			(false, 1, 1, taken, " a=A#1 a~=link:victim victim=V#1"),
			(true, 2, 1, taken, " a=A#1 a~=link:victim victim=V#1"),
		];
		for (existing, hooks, code, err, after) in cases {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), "A").unwrap();
			fs::write(dir.path().join("victim"), "V").unwrap();
			let backup = dir.path().join("a~");
			if existing {
				fs::write(&backup, "old").unwrap();
			}
			let ran = Arc::new(AtomicUsize::new(0));
			for _ in 0..hooks {
				let (link, hook_ran) = (backup.clone(), Arc::clone(&ran));
				crate::host::hook_at(backup.clone(), move || {
					let _ = fs::remove_file(&link);
					std::os::unix::fs::symlink("victim", &link).unwrap();
					hook_ran.fetch_add(1, Ordering::SeqCst);
				});
			}
			let (got, capture) = run_util::<Cp>(&["-fb", "a", "a"], "", dir.path());
			let case = format!("existing a~: {existing}, hooks: {hooks}");
			assert_eq!(ran.load(Ordering::SeqCst), hooks, "{case}: the hooks that ran");
			assert_eq!(
				(got, capture.err(), crate::file_backup::tests::listing(dir.path())),
				(code, err.to_owned(), after.to_owned()),
				"{case}"
			);
		}
	}

	/// A followed source whose chain of symbolic links passes through the
	/// backup's entry: `x -> dest~ -> a`. `cp -b x dest` is refused: the
	/// backup would replace the link `dest~` with the old `dest`, and the copy
	/// would then read that. GNU 9.4 and 9.7 make the backup, losing the link,
	/// then find the source replaced ("skipping file 'x', as it was replaced
	/// while being copied", status 1) and rename the backup back. With `-P`
	/// the link `x` is copied, not followed, and the backup replaces `dest~`,
	/// as GNU's does; so it does where `dest~` holds the contents itself.
	#[cfg(unix)]
	#[test]
	fn a_source_chain_through_the_backup_is_not_copied_over_it() {
		use std::os::unix::fs::symlink;
		let root = tempdir().unwrap();
		#[rustfmt::skip]
		let cases: [(&str, bool, &[&str], i32, &str, &str); 3] = [
			("chain", true, &["-b", "x", "dest"], 1,
				"cp: backing up 'dest' might destroy source;  'x' not copied\n",
				" a=payload#1 dest=old#1 dest~=link:a x=link:dest~"),
			("chain-P", true, &["-P", "-b", "x", "dest"], 0, "",
				" a=payload#1 dest=link:dest~ dest~=old#1 x=link:dest~"),
			("held-P", false, &["-P", "-b", "x", "dest"], 0, "", " dest=link:dest~ dest~=old#1 x=link:dest~"),
		];
		for (case, chain, args, code, err, after) in cases {
			let dir = root.path().join(case);
			fs::create_dir(&dir).unwrap();
			if chain {
				fs::write(dir.join("a"), "payload").unwrap();
				symlink("a", dir.join("dest~")).unwrap();
			} else {
				fs::write(dir.join("dest~"), "payload").unwrap();
			}
			symlink("dest~", dir.join("x")).unwrap();
			fs::write(dir.join("dest"), "old").unwrap();
			let (got, capture) = run_util::<Cp>(args, "", &dir);
			assert_eq!((got, capture.err().as_str()), (code, err), "{case}");
			assert_eq!(crate::file_backup::tests::listing(&dir), after, "{case}");
		}
	}

	/// `cp -b DEST~ dest` and `cp --reflink=always -b DEST~ dest` where names
	/// fold ([`crate::file_backup::tests::check_folded_sources`]).
	#[cfg(unix)]
	#[test]
	fn a_source_whose_name_folds_to_the_backup_is_not_copied_over_it() {
		for util in ["cp", "cp --reflink=always"] {
			crate::file_backup::tests::check_folded_sources(util, |fs, dir, args| {
				let (code, capture) = crate::host::run_util_on::<Cp>(fs, args, "", dir);
				(code, capture.err())
			});
		}
	}

	/// Replaces the file at `path` with a new file holding `contents`.
	#[cfg(unix)]
	fn replace_with(path: &std::path::Path, contents: &str) {
		let new = path.with_file_name("replacement");
		fs::write(&new, contents).unwrap();
		fs::rename(&new, path).unwrap();
	}

	/// A source replaced after cp read it, before cp opens it (here by a test
	/// hook; in use, by a backup over another name of the source's file), is
	/// not copied, whatever the clone mode: cp compares the file it opens with
	/// the one it read, as GNU cp does in `copy_reg`, before any clone, and
	/// fails with GNU's message, status 1, no `dest`. Before, `--reflink=always`
	/// and every copy on macOS cloned by path first, so they copied the
	/// replacement, or failed to clone where the files cannot share extents.
	#[cfg(unix)]
	#[test]
	fn a_source_replaced_before_its_open_is_not_copied() {
		for reflink in ["--reflink=always", "--reflink=auto", "--reflink=never"] {
			let dir = tempdir().unwrap();
			let source = dir.path().join("a");
			fs::write(&source, "A").unwrap();
			let replaced = source.clone();
			crate::host::hook_at(source, move || replace_with(&replaced, "B"));
			let (code, capture) = run_util::<Cp>(&[reflink, "a", "dest"], "", dir.path());
			assert_eq!(
				(code, capture.err().as_str()),
				(1, "cp: skipping file 'a', as it was replaced while being copied\n"),
				"{reflink}"
			);
			assert_eq!(crate::file_backup::tests::listing(dir.path()), " a=B#1", "{reflink}");
		}
	}

	/// A source replaced after cp opened and checked it, before a clone by
	/// path (`--reflink=always`, and `auto` on macOS): the clone would read
	/// the replacement, so the path is read again just before it and must
	/// still name the file opened. `always` then fails as above; `auto`
	/// copies from the file it opened, which is what GNU cp, cloning from its
	/// descriptor, copies. A copy that does not clone by path reads the file
	/// it opened.
	#[cfg(unix)]
	#[test]
	fn a_source_replaced_after_its_open_is_not_cloned() {
		#[rustfmt::skip]
		let cases = [
			("--reflink=always", 1, "cp: skipping file 'a', as it was replaced while being copied\n", " a=B#1"),
			("--reflink=auto", 0, "", " a=B#1 dest=A#1"),
			("--reflink=never", 0, "", " a=B#1 dest=A#1"),
		];
		for (reflink, code, err, after) in cases {
			let dir = tempdir().unwrap();
			let source = dir.path().join("a");
			fs::write(&source, "A").unwrap();
			// The first hook runs before the open, the second before a clone
			// by path; a copy that does not clone by path never reaches it,
			// and it runs after the copy.
			crate::host::hook_at(source.clone(), || {});
			let replaced = source.clone();
			crate::host::hook_at(source.clone(), move || replace_with(&replaced, "B"));
			let (got, capture) = run_util::<Cp>(&[reflink, "a", "dest"], "", dir.path());
			crate::host::run_hook(&source);
			assert_eq!((got, capture.err().as_str()), (code, err), "{reflink}");
			assert_eq!(crate::file_backup::tests::listing(dir.path()), after, "{reflink}");
		}
	}
}
