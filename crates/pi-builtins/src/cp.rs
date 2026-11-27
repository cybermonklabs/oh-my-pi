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

/// What `-f` and `--remove-destination` ask of an existing destination. GNU
/// keeps the two apart (`unlink_dest_after_failed_open` and
/// `unlink_dest_before_opening`): either, both or neither, in any order.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
struct ClobberMode {
	/// `-f`: a destination that cannot be opened is removed and opened again.
	force:              bool,
	/// `--remove-destination`: each existing destination is removed before it
	/// is opened.
	remove_destination: bool,
}

/// Specifies whether files should be overwritten. `-n` is `--update=none`
/// (GNU's `cp.c` sets it so after reading the options).
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum OverwriteMode {
	/// [Default] Always overwrite existing files
	Clobber(ClobberMode),
	/// Prompt before overwriting a file
	Interactive(ClobberMode),
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

/// Copy action to perform. `-u`/`--update` is not one: it decides, in every
/// mode, whether an existing destination is replaced at all (`Options.update`).
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum CopyMode {
	Link,
	SymLink,
	#[default]
	Copy,
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
	/// `-l`, `-s`, `--attributes-only`, or a plain copy.
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
	/// `mv` copying between filesystems: a moved directory and the entries
	/// below it are reported as GNU's mv reports them (`created directory`,
	/// `copied`), and an operand that is not a directory is left for `mv`.
	move_mode:              bool,
	/// The two-operand form, `cp SOURCE DEST` with `DEST` not a directory:
	/// only there GNU turns `cp -fb a a` into a copy to the backup name
	/// (`cp.c`).
	two_operands:           bool,
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
	Unknown,
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
	/// A copy-on-write clone: the files share their storage. GNU looks for no
	/// holes in a file it cloned, and says so as `unknown`.
	const CLONED: Self = Self {
		offload:          OffloadReflinkDebug::Unknown,
		reflink:          OffloadReflinkDebug::Yes,
		sparse_detection: SparseDebug::Unknown,
	};
	/// A copy that failed before it moved any data: GNU reports what it
	/// never reached as unknown, and a refused clone as unsupported.
	fn failed(clone_refused: bool, reflink_mode: ReflinkMode) -> Self {
		Self {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          match reflink_mode {
				ReflinkMode::Never => OffloadReflinkDebug::No,
				_ if clone_refused => OffloadReflinkDebug::Unsupported,
				_ => OffloadReflinkDebug::Unknown,
			},
			sparse_detection: SparseDebug::Unknown,
		}
	}
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
			Self::Unknown => "unknown",
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
	// GNU's -l, -s, --attributes-only and --copy-contents set options of their
	// own (`cp.c`): -l and -s together are refused, and a link is made with
	// either whatever the others say. Only the two spellings of --reflink
	// replace each other.
	const REFLINK_ARGS: &[&str] = &[options::REFLINK, options::CLONE];
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
				// -T with -t is refused after the operands are counted, as GNU
				// refuses it (`cp_main`).
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
				.help(
					"remove each existing destination file before attempting to open it (contrast \
					 with --force).",
				)
				.action(ArgAction::SetTrue),
		)
		// Every `--backup` is kept: a bare one keeps the control given before it.
		.arg(backup_control::arguments::backup().action(ArgAction::Append))
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(options::REFLINK)
				.long(options::REFLINK)
				.value_name("WHEN")
				.overrides_with_all(REFLINK_ARGS)
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
				.overrides_with_all(REFLINK_ARGS)
				.help("clone files where the filesystem allows, else copy; same as --reflink=auto")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ATTRIBUTES_ONLY)
				.long(options::ATTRIBUTES_ONLY)
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
		// -P, -L, -H, -a and -d override none of each other: the last of them
		// decides how links are followed (see `Options::from_matches`), and -a
		// and -d keep their other parts, as GNU cp's options do.
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('P')
				.long(options::NO_DEREFERENCE)
				// -d sets this option
				.help("never follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEREFERENCE)
				.short('L')
				.long(options::DEREFERENCE)
				.help("always follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CLI_SYMBOLIC_LINKS)
				.short('H')
				.help("follow command-line symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ARCHIVE)
				.short('a')
				.long(options::ARCHIVE)
				.help("Same as -dR --preserve=all")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE_PRESERVE_LINKS)
				.short('d')
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
	let mut options = Options::from_matches(matches, host)?;

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(options::PATHS)
		.map_or_default(|values| values.map(PathBuf::from).collect());

	let (sources, target) = parse_path_args(paths, &options)?;
	if let Some(dir) = &options.target_dir {
		check_target_directory(host, dir)?;
	}

	// -T makes the last operand the destination itself, a directory too; the
	// copy then decides what a directory there takes (`copy.c`).
	let target_type =
		if options.no_target_dir { TargetType::File } else { TargetType::determine(host, &sources, &target) };
	options.two_operands = matches!(target_type, TargetType::File);
	copy(host, &sources, &target, target_type, &options)
}

impl ClobberMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		Self {
			force:              matches.get_flag(options::FORCE),
			remove_destination: matches.get_flag(options::REMOVE_DESTINATION),
		}
	}
}

impl OverwriteMode {
	/// `-i`; `-n` after it, which clap lets override it, is `--update=none`.
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::INTERACTIVE) {
			Self::Interactive(ClobberMode::from_matches(matches))
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
		} else if matches.get_flag(options::ATTRIBUTES_ONLY) {
			// GNU copies no data with `--attributes-only` (`data_copy_required`),
			// whatever else it does to the destination first.
			Self::AttrOnly
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

		if matches.get_flag(options::LINK) && matches.get_flag(options::SYMBOLIC_LINK) {
			return Err(CpError::Usage("cannot make both hard and symbolic links".to_string()));
		}
		// The last of -u and --update=WHEN decides; -n, where -i does not come
		// after it, is --update=none whatever else was given (`cp.c`).
		let update_mode = if matches.get_flag(options::NO_CLOBBER) {
			UpdateMode::None
		} else {
			let update = matches.index_of(update_control::arguments::OPT_UPDATE);
			let update_no_arg = matches
				.get_flag(update_control::arguments::OPT_UPDATE_NO_ARG)
				.then(|| matches.index_of(update_control::arguments::OPT_UPDATE_NO_ARG))
				.flatten();
			match (update, update_no_arg) {
				(Some(update), Some(no_arg)) if no_arg > update => UpdateMode::IfOlder,
				_ => update_control::determine_update_mode(matches),
			}
		};
		// Any backup option, `--backup=none` too, conflicts with skipping.
		let backup_given = [
			backup_control::arguments::OPT_BACKUP,
			backup_control::arguments::OPT_BACKUP_NO_ARG,
			backup_control::arguments::OPT_SUFFIX,
		]
		.into_iter()
		.any(|option| matches.value_source(option) == Some(clap::parser::ValueSource::CommandLine));
		if backup_given && matches!(update_mode, UpdateMode::None | UpdateMode::NoneFail) {
			return Err(CpError::Usage(
				"--backup is mutually exclusive with -n or --update=none-fail".to_string(),
			));
		}
		let backup_mode = determine_backup_mode(matches, host).map_err(CpError::Usage)?;

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
		// `--sparse=never` turns cloning off where it was only tried (`cp.c`).
		let reflink_mode = if reflink_mode == ReflinkMode::Auto && sparse_mode == SparseMode::Never {
			ReflinkMode::Never
		} else {
			reflink_mode
		};

		// The last of -P, -d, -a (never follow), -L (always) and -H (only on
		// the command line) decides how links are followed; none of them: the
		// default below. `Some(None)` is -H.
		let follow = [
			(options::NO_DEREFERENCE, Some(false)),
			(options::NO_DEREFERENCE_PRESERVE_LINKS, Some(false)),
			(options::ARCHIVE, Some(false)),
			(options::DEREFERENCE, Some(true)),
			(options::CLI_SYMBOLIC_LINKS, None),
		]
		.into_iter()
		.filter(|(option, _)| matches.get_flag(option))
		.max_by_key(|(option, _)| matches.index_of(option))
		.map(|(_, follow)| follow);

		Ok(Self {
			attributes_only: matches.get_flag(options::ATTRIBUTES_ONLY),
			// GNU reads special files as files only with -R (`copy_as_regular`).
			copy_contents: recursive && matches.get_flag(options::COPY_CONTENTS),
			cli_dereference: follow == Some(None),
			copy_mode,
			dereference: match follow {
				Some(always) => always.unwrap_or(false),
				// cp normally follows the link only when not copying recursively
				// or when --link (-l) is used
				None => !(recursive && copy_mode != CopyMode::Link),
			},
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
			two_operands: false,
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

	/// `-f` without `-i`: Windows clears a read-only destination's attribute
	/// before it removes it.
	#[cfg(windows)]
	fn force(&self) -> bool {
		matches!(self.overwrite, OverwriteMode::Clobber(ClobberMode { force: true, .. }))
	}

	/// Whether each existing destination is removed before it is opened,
	/// with or without `-i`, as GNU's `--remove-destination` does.
	fn remove_destination(&self) -> bool {
		matches!(
			self.overwrite,
			OverwriteMode::Clobber(ClobberMode { remove_destination: true, .. })
				| OverwriteMode::Interactive(ClobberMode { remove_destination: true, .. })
		)
	}

	/// `-f`: whether a destination that cannot be opened is removed and
	/// opened again.
	fn unlink_after_failed_open(&self) -> bool {
		matches!(
			self.overwrite,
			OverwriteMode::Clobber(ClobberMode { force: true, .. })
				| OverwriteMode::Interactive(ClobberMode { force: true, .. })
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
	/// The host file the copy in progress wrote, by a descriptor of its own:
	/// its owner, mode and times are set through it, as GNU sets them with
	/// `fchown`, `fchmod` and `futimens` on the descriptor it wrote, so a name
	/// swapped for a link after the write cannot send them elsewhere.
	written:             Option<std::fs::File>,
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
	/// `verbose` reports a moved directory and each entry below it as GNU's mv
	/// does: `created directory` for a directory, `copied` for anything else.
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
				overwrite: OverwriteMode::Clobber(ClobberMode::default()),
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
				two_operands: false,
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

	if options.no_target_dir && options.target_dir.is_some() {
		return Err(CpError::Error(
			"cannot combine --target-directory (-t) and --no-target-directory (-T)".to_string(),
		));
	}
	// Return an error if the user requested to copy more than one
	// file source to a file target
	if options.no_target_dir && paths.len() > 2 {
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
fn copy(
	host: &mut Host,
	sources: &[PathBuf],
	target: &Path,
	target_type: TargetType,
	options: &Options,
) -> CopyResult<()> {
	verify_target_type(host, target, target_type)?;
	// Like GNU, only sources copied into a directory are stripped.
	let stripped;
	let sources = if options.strip_trailing_slashes && matches!(target_type, TargetType::Directory) {
		stripped = strip_trailing_slashes(sources);
		&stripped
	} else {
		sources
	};
	// -T says the destination is not a directory (`do_copy`).
	if options.parents && (options.no_target_dir || !host.fs().is_dir(host.resolve(target))) {
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
	let created = if options.parents { make_parent_dirs(host, state, source, &dest, options)? } else { Vec::new() };
	let result = copy_file(host, state, source, &dest, options, true, None);
	if options.parents {
		for (x, y) in aligned_ancestors(source, &dest) {
			if let Ok(src) = filesystem.canonicalize_with(
				host.resolve(&x),
				&CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Physical),
			) {
				// A directory --parents made takes its source's mode as any
				// directory cp makes does, after the ownership was set (GNU's
				// `re_protect`).
				let fresh = created.contains(&y);
				copy_attributes(
					host,
					&src,
					&y,
					&options.attributes,
					fresh,
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
			return if !clobber.force && !clobber.remove_destination {
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
			Self::Interactive(clobber) => {
				let prompt = interactive_prompt(host, path, clobber);
				let _ = write!(host.stderr, "{}: {prompt} ", Cp::NAME);
				let _ = host.stderr.flush();
				read_yes(host).ok_or_else(|| {
					// GNU's `--debug` names a destination `-i` kept.
					if debug {
						let _ = writeln!(host.stdout, "skipped {}", path.quote());
					}
					CpError::Skipped(true)
				})
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

/// Copies extended attributes (xattrs) from `source` to `dest`. A source
/// without any leaves `dest` untouched.
///
/// The file the copy wrote (`written`) gets them through its descriptor, as
/// GNU's `attr_copy_fd`, before its final mode (see [`copy_attributes`]). A
/// new file cp made is owner-writable then; a file of cp's own that is not
/// (a clone macOS's `clonefile` gives a read-only source's mode) is made
/// owner-writable through its descriptor for them and given its mode back,
/// as GNU's `copy_reg` gives the file it creates the owner's write bit for
/// the same reason. A file another user owns, which cp writes through its
/// group or other bits, is left as it is, as GNU leaves it. A destination
/// cp did not open (a directory, a provider's file) that is read-only is
/// made user-writable by name for them, and read-only again. Neither is
/// needed with an owner's privileges, which need no write bit. A failure to
/// give a mode back is reported only where setting the attributes did not
/// fail first.
fn copy_extended_attrs(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	follow_source: bool,
	skip_selinux: bool,
	written: Option<&std::fs::File>,
) -> io::Result<()> {
	let mut names = filesystem.list_xattr(source, follow_source)?;
	// With -Z the destination gets the default context instead.
	if skip_selinux {
		names.retain(|name| name != "security.selinux");
	}
	if names.is_empty() {
		return Ok(());
	}

	let readonly = if written.is_none() && !owner_privileges() {
		let metadata = filesystem.symlink_metadata(dest)?;
		Some(metadata.permissions()).filter(|permissions| !metadata.is_symlink() && permissions.readonly())
	} else {
		None
	};
	if let Some(mut permissions) = readonly.clone() {
		permissions.set_readonly(false);
		filesystem.set_permissions(dest, permissions)?;
	}
	// The attributes are tried also where the write bit cannot be given; the
	// mode is given back only where it was.
	let written_mode = match written {
		Some(file) if !owner_privileges() => owned_read_only_mode(file)?,
		_ => None,
	}
	.filter(|mode| written.is_some_and(|file| set_handle_mode(file, mode | 0o200).is_ok()));

	let copied = names.iter().try_for_each(|name| {
		match filesystem.get_xattr(source, name, follow_source)? {
			Some(value) => match written.and_then(|file| set_handle_xattr(file, name, &value)) {
				Some(set) => set,
				None => filesystem.set_xattr(dest, name, &value, false),
			},
			None => Ok(()),
		}
	});

	let mut restored = Ok(());
	if readonly.is_some() {
		restored = filesystem.symlink_metadata(dest).and_then(|metadata| {
			let mut permissions = metadata.permissions();
			permissions.set_readonly(true);
			filesystem.set_permissions(dest, permissions)
		});
	}
	if let (Some(file), Some(mode)) = (written, written_mode) {
		restored = restored.and(set_handle_mode(file, mode));
	}

	copied.and(restored)
}

/// The permission bits of the host file `file`, read through its descriptor,
/// where the file is cp's own and its owner may not write it; `None`
/// otherwise. Off Unix, 0444 for a read-only file.
fn owned_read_only_mode(file: &std::fs::File) -> io::Result<Option<u32>> {
	let metadata = file.metadata()?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt as _;
		let own = metadata.uid() == nix::unistd::geteuid().as_raw();
		Ok(Some(metadata.mode() & 0o7777).filter(|mode| own && mode & 0o200 == 0))
	}
	#[cfg(not(unix))]
	{
		Ok(metadata.permissions().readonly().then_some(0o444))
	}
}

/// Sets the extended attribute `name` of the host file `file` through its
/// descriptor (`fsetxattr`), as GNU's `attr_copy_fd` does; `None` where the
/// platform has no such call, for the caller to set it by name.
fn set_handle_xattr(file: &std::fs::File, name: &std::ffi::OsStr, value: &[u8]) -> Option<io::Result<()>> {
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
	{
		use std::os::{fd::AsRawFd as _, unix::ffi::OsStrExt as _};

		let name = match std::ffi::CString::new(name.as_bytes()) {
			Ok(name) => name,
			Err(error) => return Some(Err(io::Error::from(error))),
		};
		// SAFETY: the descriptor is borrowed from a live file, `name` is
		// NUL-terminated, and `value` is valid for `value.len()` bytes; the
		// kernel retains none of them.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let set = unsafe { libc::fsetxattr(file.as_raw_fd(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0) };
		// SAFETY: as above; position 0 and no options.
		#[cfg(target_os = "macos")]
		let set = unsafe { libc::fsetxattr(file.as_raw_fd(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
		Some(if set == 0 { Ok(()) } else { Err(io::Error::last_os_error()) })
	}
	#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
	{
		let _ = (file, name, value);
		None
	}
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
	dest_facts: DestFacts<'_>,
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
			let _ = match dest_facts.written {
				Some(file) => set_handle_mode(file, mode),
				None => filesystem.set_permissions(dest_fs, Permissions::from_mode(mode)),
			};
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
	// The file the copy wrote, held open, is never a link, whatever the name
	// now holds (a link the copy wrote through, or one put in its place).
	let dest_is_symlink = dest_facts.written.is_none()
		&& dest_facts
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

	// The seam where a test reads the file's mode before its owner is set.
	#[cfg(test)]
	crate::host::run_hook(&dest_fs);
	// Ownership must be changed first to avoid interfering with mode change.
	handle_preserve(host, attributes.ownership, || {
		// A provider without owners has nothing to carry over.
		let Some((uid, gid)) = source_owner.filter(|_| chowns) else {
			return Ok(());
		};
		// GNU cp doesn't report a failure to set the ownership, and falls back
		// to changing only the group. The file the copy wrote is changed
		// through its descriptor, as GNU's `fchown`.
		let chown = |uid: Option<u32>, gid: Option<u32>| match dest_facts.written {
			Some(file) => chown_handle(file, uid, gid),
			None => filesystem.chown(&dest_fs, uid, gid, !dest_is_symlink),
		};
		if chown(Some(uid), Some(gid)).is_err() {
			let _ = chown(None, Some(gid));
		}
		Ok(())
	})?;

	// The extended attributes go before the mode, as GNU's `copy_reg` copies
	// them (after the owner, before the final mode): a new file is still
	// writable then, so a read-only final mode needs no toggle around them.
	// For a file whose data the copy wrote (a provider's too), a failure to
	// set them is reported after the mode and the times are set, as GNU's
	// `copy_reg` records it and goes on; a directory, a symbolic link or a
	// special file made anew gets no mode past it, as GNU's `copy_internal`
	// returns there, and only its times (GNU sets them first).
	let xattrs = handle_preserve(host, attributes.xattr, || {
		copy_extended_attrs(&filesystem, &source_fs, &dest_fs, follow_source, skip_selinux_xattr, dest_facts.written)
			.map_err(|e| CpError::IoErrContext(e, format!("setting attributes for {}", dest.quote())))
	});
	if !dest_facts.stops_at_attributes || xattrs.is_ok() {
		set_then_mode(&filesystem, &dest_fs);

		handle_preserve(host, mode, || {
			// The seam where a test makes the mode fail.
			#[cfg(all(test, unix))]
			crate::host::fault(&dest_fs)
				.map_err(|e| CpError::IoErrContext(e, format!("preserving permissions for {}", dest.quote())))?;
			// chmod cannot change a symbolic link, and every link has the same
			// permissions anyway.
			if !dest_is_symlink && !mode_in_place {
				set_mode(&filesystem, &dest_fs, dest, source_metadata.permissions(), dest_facts.written)?;
			}
			Ok(())
		})
		.map_err(|later| after_xattrs(host, &xattrs, later))?;

		// A directory is created with a restrictive mode (see `build_dir`);
		// when its mode is not preserved it ends up with the default one.
		if dest_is_freshly_created_dir && mode_explicitly_disabled {
			let umask = host.umask();
			handle_preserve(host, Preserve::Yes { required: false }, || {
				set_mode(&filesystem, &dest_fs, dest, Permissions::from_mode(0o777 & !umask), None)
			})?;
		}
	}

	handle_preserve(host, attributes.timestamps, || {
		let times_error =
			|e| CpError::IoErrContext(e, format!("preserving times for {}", dest.quote()));
		let accessed_at = source_metadata.accessed().ok();
		let modified_at = source_metadata.modified().map_err(times_error)?;
		let (accessed, modified) = (FileTime::from(accessed_at), FileTime::At(modified_at));
		if dest_is_symlink {
			filesystem.set_times(&dest_fs, accessed, modified, false)
		} else if let Some(file) = dest_facts.written {
			// GNU's `futimens` on the descriptor it wrote.
			let times = std::fs::FileTimes::new().set_modified(modified_at);
			file.set_times(match accessed_at {
				Some(accessed_at) => times.set_accessed(accessed_at),
				None => times,
			})
		} else {
			preserve_via(
				&filesystem,
				&dest_fs,
				|filesystem, path| filesystem.set_times(path, accessed, modified, true),
				|file| file.set_times(accessed, modified),
			)
		}
		.map_err(times_error)
	})
	.map_err(|later| after_xattrs(host, &xattrs, later))?;
	xattrs
}

/// `later`, with the attributes' failure `xattrs` reported first, as GNU
/// reports both.
fn after_xattrs(host: &mut Host, xattrs: &CopyResult<()>, later: CpError) -> CpError {
	if let Err(attributes) = xattrs {
		show_error_if_needed(host, attributes);
	}
	later
}

/// Sets the permissions of `dest` (resolved as `dest_fs`), for attribute
/// preservation.
fn set_mode(
	filesystem: &BlockingFs,
	dest_fs: &Path,
	dest: &Path,
	permissions: Permissions,
	written: Option<&std::fs::File>,
) -> CopyResult<()> {
	match written {
		// GNU's `fchmod` on the descriptor it wrote.
		Some(file) => set_handle_mode(file, permissions.mode()),
		None => preserve_via(
			filesystem,
			dest_fs,
			|filesystem, path| filesystem.set_permissions(path, permissions),
			|file| file.set_permissions(permissions),
		),
	}
	.map_err(|e| CpError::IoErrContext(e, format!("preserving permissions for {}", dest.quote())))
}

/// Sets the permission bits of the host file `file` through its descriptor
/// (`fchmod`); off Unix only whether it is read-only.
fn set_handle_mode(file: &std::fs::File, mode: u32) -> io::Result<()> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		file.set_permissions(std::fs::Permissions::from_mode(mode))
	}
	#[cfg(not(unix))]
	{
		let mut permissions = file.metadata()?.permissions();
		permissions.set_readonly(mode & 0o222 == 0);
		file.set_permissions(permissions)
	}
}

/// Sets the owner and group of the host file `file` through its descriptor
/// (`fchown`); a platform without owners has none to set.
fn chown_handle(file: &std::fs::File, uid: Option<u32>, gid: Option<u32>) -> io::Result<()> {
	#[cfg(unix)]
	{
		std::os::unix::fs::fchown(file, uid, gid)
	}
	#[cfg(not(unix))]
	{
		let _ = (file, uid, gid);
		Ok(())
	}
}

/// Creates the symlink `dest` pointing at the literal `target`; `replace`
/// replaces an existing `dest` as GNU's `force_symlinkat` does (`-f`).
fn symlink_file(
	host: &mut Host,
	state: &mut CopyState,
	target: &Path,
	dest: &Path,
	kind: SymlinkKind,
	replace: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	link_over(&filesystem, &dest_fs, replace, |at| filesystem.symlink_with(target, at, kind)).map_err(|e| {
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

/// Makes a link at `dest` with `make`, as GNU's `force_linkat` and
/// `force_symlinkat` do (`lib/force-link.c`): where `dest` exists and
/// `replace` holds, the link is made at a fresh name in `dest`'s directory and
/// renamed over `dest`. The destination is never removed before the new link
/// is in place, so a link that cannot be made loses nothing.
fn link_over(
	filesystem: &BlockingFs,
	dest_fs: &Path,
	replace: bool,
	make: impl Fn(&Path) -> io::Result<()>,
) -> io::Result<()> {
	match make(dest_fs) {
		Err(error) if replace && error.kind() == io::ErrorKind::AlreadyExists => {},
		made => return made,
	}
	let dir = parent_path(dest_fs).filter(|parent| !parent.is_empty()).unwrap_or_else(|| Path::new("."));
	let options = pi_vfs::TempOptions::new().prefix("Cu").random_len(16);
	for _ in 0..100 {
		// The file `create_temp` makes reserves a name no entry has; the link
		// takes its place.
		let (temp, file) = filesystem.create_temp(dir, &options)?;
		file.close()?;
		filesystem.remove_file(&temp)?;
		match make(&temp) {
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
			Err(error) => return Err(error),
			Ok(()) => {
				let renamed = filesystem.rename(&temp, dest_fs);
				// GNU unlinks the fresh name either way: a rename between two
				// links of one file does nothing.
				let _ = filesystem.remove_file(&temp);
				return renamed;
			},
		}
	}
	Err(io::Error::from(io::ErrorKind::AlreadyExists))
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
	// GNU refuses a link at `a~` that leads to a directory or nowhere, and
	// reports any other failure to read where it leads (`cannot stat`), with
	// or without `--attributes-only`.
	if existing.as_ref().is_ok_and(Metadata::is_symlink) {
		match filesystem.metadata(backup) {
			Ok(target) if target.is_dir() => return Err(overwrite_directory(&shown, source)),
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
	}
	let (file, temp) = match &existing {
		// With `--attributes-only` no data is written, so the link at `a~` is
		// followed as GNU follows it (its target's data stays); otherwise the
		// link is replaced, where GNU writes the source's data into its target.
		Ok(metadata) if metadata.is_symlink() && !options.attributes_only => {
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
			if existing.is_ok() && options.remove_destination() {
				// `--remove-destination` removes the backup name before the
				// converted copy writes it, as GNU's does
				// (`unlink_dest_before_opening`): `--attributes-only` then
				// leaves it empty, and its other links keep their data.
				match filesystem.remove_file(backup) {
					Ok(()) => {},
					Err(error) if error.kind() == io::ErrorKind::NotFound => {},
					Err(error) => {
						return Err(CpError::IoErrContext(error, format!("cannot remove {}", shown.quote())));
					},
				}
				(create(backup).map_err(cannot_create)?, None)
			} else if existing.is_ok() {
				let mut open = OpenOptions::new();
				open.write(true).truncate(!options.attributes_only);
				// No link is written through here, but under `--attributes-only`,
				// whose open writes no data (see above).
				#[cfg(unix)]
				if filesystem.is_native_local(backup) && !options.attributes_only {
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
/// (`cp.c`): the two-operand form (not a copy into a directory, which GNU
/// says is the same file), `-f` (with or without `-i`) and a backup, the two
/// names the same string, and a destination `stat` reads as a regular file.
/// A FIFO, a device or a link to nothing that is its own destination is not
/// turned.
fn converts_to_backup(filesystem: &BlockingFs, source: &Path, dest: &Path, dest_fs: &Path, options: &Options) -> bool {
	options.two_operands
		&& options.backup != BackupMode::None
		&& options.unlink_after_failed_open()
		&& source.as_os_str() == dest.as_os_str()
		&& filesystem.is_file(dest_fs)
}

/// Whether the source is a link cp follows whose own entry is the destination,
/// with a backup that is not turned into a copy, under another string
/// (`cp -fb l ./l`) or the same one (`cp -fb l l`, `l` leading to a FIFO; `cp
/// -b l l`), or under any name with `--remove-destination` and no backup (`l
/// ./l`, `l l`). GNU reads the destination with lstat there (`use_lstat`),
/// another file than the one it follows, so it backs the link up by renaming
/// it, after `-i` asks and `-u` compares, or removes it. A copy then cannot
/// open the source through the name that is gone, and `-l` cannot link to
/// it ([`loses_the_followed_source`]); `-s` makes its link from the source's
/// text, so `cp -s -b l l` makes `l -> l` and keeps the old link as `l~`.
fn renames_the_followed_source(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	source_fs: &Path,
	dest_fs: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	(options.backup != BackupMode::None && !converts_to_backup(filesystem, source, dest, dest_fs, options)
		|| options.backup == BackupMode::None && options.remove_destination())
		&& options.dereference(source_in_command_line)
		&& filesystem.is_symlink(source_fs)
		&& same_entry(filesystem, source_fs, dest_fs)
}

/// Whether the copy or the hard link reads the source through a name
/// [`renames_the_followed_source`] moves. GNU then fails and renames the
/// backup back; under `--remove-destination` it has removed the link, which
/// is lost. Here the same failure comes first and the link stays.
fn loses_the_followed_source(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	source_fs: &Path,
	dest_fs: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	options.copy_mode != CopyMode::SymLink
		&& renames_the_followed_source(filesystem, source, dest, source_fs, dest_fs, options, source_in_command_line)
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
			&& !renames_the_followed_source(filesystem, source, dest, source_fs, dest_fs, options, source_in_command_line)
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
		if source_is_symlink && !options.dereference(source_in_command_line) {
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
	// is another file, which it replaces, unless cp reads the source without
	// following it and it is that link itself (`-P l ./l`); and so is another
	// hard link of a source that is not a link, in another entry. The source's
	// own entry, by any name, is the same file, and nothing is removed before
	// this check.
	if options.backup == BackupMode::None && options.remove_destination() {
		if dest_is_symlink
			&& (options.dereference(source_in_command_line) || !same_entry(filesystem, source_fs, dest_fs))
		{
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
	// A special file -R makes again (no `--copy-contents`) reads the
	// destination with lstat, as GNU's `use_lstat` does: a link there is
	// another file, whatever it leads to.
	// Only where cp follows links (-H, -L) does it compare that link with the
	// source; never following, a link there to the source is the same file.
	if dest_is_symlink
		&& options.recursive
		&& !options.copy_contents
		&& options.dereference(source_in_command_line)
		&& filesystem
			.metadata(source_fs)
			.is_ok_and(|metadata| is_stream(&metadata) || metadata.file_type().is_socket())
	{
		return false;
	}
	// If source and dest are both the same symlink but with different names,
	// then allow the copy. This can occur, for example, if source and dest are
	// both hardlinks to the same symlink.
	if dest_is_symlink
		&& source_is_symlink
		&& file_name(source) != file_name(dest)
		&& !options.dereference(source_in_command_line)
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
	dest_by_lstat: bool,
) -> CopyResult<(Option<PathBuf>, bool)> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let asked_about = match own_backup {
		// GNU asks about the backup name only where `stat` of it succeeds
		// (`copy.c`): a link to nothing there is a new destination. Under
		// `--remove-destination` it reads the name with `lstat`, so any link
		// there, even one to itself, is asked about.
		Some(backup) => {
			let there = if options.remove_destination() {
				filesystem.symlink_metadata(backup).is_ok()
			} else {
				filesystem.metadata(backup).is_ok()
			};
			there.then(|| backup_display(dest, backup))
		},
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
	// A directory at the destination, as GNU reads it, takes no
	// non-directory: GNU refuses it once `-u` compared and `-i` asked, unless
	// a backup is asked for. It backs up no directory in copy mode, so the
	// create then fails on it (`copy.c`).
	if own_backup.is_none() && !options.move_mode {
		let existing =
			if dest_by_lstat { filesystem.symlink_metadata(&dest_fs) } else { filesystem.metadata(&dest_fs) };
		if existing.is_ok_and(|metadata| metadata.is_dir()) {
			if options.backup == BackupMode::None {
				return Err(overwrite_directory(dest, source));
			}
			return Ok((None, false));
		}
	}
	if loses_the_followed_source(&filesystem, source, dest, &source_fs, &dest_fs, options, source_in_command_line) {
		return Err(CpError::Error(if options.copy_mode == CopyMode::Link {
			format!("cannot create hard link {} to {}: No such file or directory", dest.quote(), source.quote())
		} else {
			format!("cannot open {} for reading: No such file or directory", source.quote())
		}));
	}
	// GNU refuses a relative `-s` link outside the working directory after the
	// backup, and renames the backup back: the destination stays as it was.
	if options.copy_mode == CopyMode::SymLink
		&& !converts_to_backup(&filesystem, source, dest, &dest_fs, options)
		&& let Some(refused) = relative_link_refused(host, source, dest)
	{
		return Err(refused);
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
		if same_entry(&filesystem, &source_fs, &dest_fs)
			&& !renames_the_followed_source(&filesystem, source, dest, &source_fs, &dest_fs, options, source_in_command_line)
		{
			if !options.unlink_after_failed_open() {
				// Without `-f` GNU backs the destination up by renaming it,
				// which renames the source it follows: it then cannot open it,
				// and renames the backup back. A source read as a link, or in
				// another mode, `copy_file` refused first (`refuses_own_entry`).
				return Err(CpError::Error(format!(
					"cannot open {} for reading: No such file or directory",
					source.quote()
				)));
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
		// the destination's own file, Linux's rename does nothing and the
		// create then meets the name (`copy_file` takes it as new after the
		// backup, as GNU does: a file fails, a copied link replaces it only
		// under `-f`, and the backup is put back); gVisor's overlay removes the
		// name, and the copy makes it. Either way the answer is GNU's for the
		// kernel the copy runs on.
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
		OverwriteMode::Clobber(clobber) | OverwriteMode::Interactive(clobber) => {
			if clobber.remove_destination
				|| removed_before_written(host, source, dest, options, source_in_command_line)
			{
				true
			} else if clobber.force {
				// Removed only once opening it fails (see `copy_data`).
				false
			} else {
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
			}
		},
	};

	if delete_dest { delete_path(host, state, dest, options) } else { Ok(()) }
}

/// Whether GNU removes an existing destination before it writes the copy
/// (`copy.c`): where data is copied, the destination is not a directory, and
/// either links are preserved (`-a`, `-d`, `--preserve=links`) and the
/// destination has another name, or cp never follows links (`-R`, `-P`, `-a`)
/// and the source is not a regular file. The destination's other names, and a
/// file a link there leads to, then keep their data. The destination is read
/// as GNU's `use_lstat` reads it: through a link only where a regular file is
/// written through it.
fn removed_before_written(
	host: &Host,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	if options.attributes_only || options.move_mode {
		return false;
	}
	let filesystem = host.fs();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let source_metadata = if options.dereference(source_in_command_line) {
		filesystem.metadata(&source_fs)
	} else {
		filesystem.symlink_metadata(&source_fs)
	};
	let Ok(source_metadata) = source_metadata else {
		return false;
	};
	let source_is_regular = source_metadata.is_file();
	let copy_as_regular = !options.recursive || options.copy_contents;
	let use_lstat = (!source_is_regular
		&& (!copy_as_regular || source_metadata.is_dir() || source_metadata.is_symlink()))
		|| matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink)
		|| options.backup != BackupMode::None
		|| options.remove_destination();
	let dest_metadata = if use_lstat { filesystem.symlink_metadata(&dest_fs) } else { filesystem.metadata(&dest_fs) };
	let Ok(dest_metadata) = dest_metadata else {
		return false;
	};
	// A hard link `-l` would make again to the same file is left as it is, as
	// GNU returns before its removal (`copy.c` 9.4, lines 1758-1761).
	if options.copy_mode == CopyMode::Link && are_hardlinks_to_same_file(filesystem, &source_fs, &dest_fs) {
		return false;
	}
	let never_follows = !options.dereference && !options.cli_dereference;
	!dest_metadata.is_dir()
		&& (options.preserve_hard_links() && dest_metadata.nlink().is_some_and(|links| links > 1)
			|| never_follows && !source_is_regular)
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
) -> CopyResult<Vec<PathBuf>> {
	let mut created = Vec::new();
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
				created.push(y);
			},
		}
	}
	Ok(created)
}

/// Reports one copy for `-v`: `'source' -> 'dest'`, or `copied 'source' ->
/// 'dest'` for an entry below a directory `mv` moves between filesystems, as
/// GNU's mv reports it.
fn print_verbose_output(
	host: &mut Host,
	state: &CopyState,
	options: &Options,
	source: &Path,
	dest: &Path,
	backup: Option<&Path>,
) {
	let action = if options.move_mode { "copied " } else { "" };
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

/// GNU's refusal of a relative `-s` link made outside the working directory
/// (`copy.c`); `None` where the link can be made.
fn relative_link_refused(host: &Host, source: &Path, dest: &Path) -> Option<CpError> {
	(!source.is_absolute() && !is_virtual_path(source) && !dest_in_working_directory(host, dest)).then(|| {
		CpError::Error(format!(
			"{}: can make relative symbolic links only in current directory",
			dest.maybe_quote()
		))
	})
}

/// `-u`/`--update` on an existing destination, read as `existing` (stat or
/// lstat, as GNU's `use_lstat` reads it), as GNU's `copy.c` decides it in every
/// mode, before anything is backed up, removed or replaced: `Ok(true)` keeps
/// the destination (`-u` where it is not older than the source,
/// `--update=none`), `--update=none-fail` fails, and `Ok(false)` goes on, after
/// `-i` asks where `-u` compared.
fn update_keeps(
	host: &mut Host,
	options: &Options,
	source_metadata: &Metadata,
	existing: &Metadata,
	shown: &Path,
) -> CopyResult<bool> {
	match options.update {
		UpdateMode::All => Ok(false),
		UpdateMode::None => {
			if options.debug {
				let _ = writeln!(host.stdout, "skipped {}", shown.quote());
			}
			Ok(true)
		},
		UpdateMode::NoneFail => Err(CpError::Error(format!("not replacing {}", shown.quote()))),
		UpdateMode::IfOlder => {
			if source_metadata.modified()? <= existing.modified()? {
				if options.debug {
					let _ = writeln!(host.stdout, "skipped {}", shown.quote());
				}
				return Ok(true);
			}
			options.overwrite.verify(host, shown, options.debug)?;
			Ok(false)
		},
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
) -> CopyResult<DestFate> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	match options.copy_mode {
		CopyMode::Link => {
			// GNU resolves a source it follows before it touches the
			// destination, and replaces an existing destination as
			// `force_linkat` does, where `-f` or `-i` lets it (`copy.c`). It
			// never removes the destination first, so `cp -lf l l` leaves `l`
			// another link of `l`'s target.
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
			let replace =
				options.unlink_after_failed_open() || matches!(options.overwrite, OverwriteMode::Interactive(_));
			link_over(&filesystem, &dest_fs, replace, |at| filesystem.hard_link(&original, at)).map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), source.quote()),
				)
			})?;
		},
		CopyMode::Copy => {
			return copy_helper(host, state, source, dest, options, source_metadata, dest_metadata);
		},
		CopyMode::SymLink => {
			if let Some(refused) = relative_link_refused(host, source, dest) {
				return Err(refused);
			}
			symlink_file(host, state, source, dest, SymlinkKind::Auto, options.unlink_after_failed_open())?;
		},
		CopyMode::AttrOnly => {
			// GNU makes a link, and under -R without --copy-contents a FIFO,
			// socket or device, as a copy does; it opens only a file whose data
			// a copy would write, and writes none.
			if source_metadata.is_symlink()
				|| options.recursive
					&& !options.copy_contents
					&& (is_stream(source_metadata) || source_metadata.file_type().is_socket())
			{
				return copy_helper(host, state, source, dest, options, source_metadata, dest_metadata);
			}
			// A destination cp found nothing at, or backed up, is created with
			// O_EXCL, as GNU's `copy_reg` creates it: a name still there (a
			// backup rename that did nothing) fails with "File exists".
			let mut create = OpenOptions::new();
			create.write(true);
			if dest_metadata.is_none() {
				create.create_new(true);
			} else {
				create.create(true);
			}
			let cannot_create =
				|e| CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()));
			let file = filesystem.open_with(&dest_fs, &create).map_err(cannot_create)?;
			// Its attributes go through this descriptor, as GNU's do.
			state.written = keep_written(&file, dest)?;
			file.close().map_err(cannot_create)?;
		},
	}

	Ok(DestFate::Kept)
}

/// A descriptor of its own for the host file `file` the copy wrote at `dest`,
/// to set its owner, mode and times through (see `CopyState::written`); none
/// for a provider's file. A descriptor that cannot be duplicated fails the
/// copy rather than leaving those to be set by name.
fn keep_written(file: &File, dest: &Path) -> CopyResult<Option<std::fs::File>> {
	file.native()
		.map(|file| {
			file.try_clone().map_err(|e| {
				CpError::IoErrContext(e, format!("cannot set the attributes of {}", dest.quote()))
			})
		})
		.transpose()
}

/// Makes `link` another name of `original`, replacing what is at `link`, as
/// GNU's `force_linkat` does for a file copied before under `--preserve=links`:
/// a name already of that file is left; another is replaced by renaming a new
/// link, made under a fresh temporary name beside it, over it, so it is never
/// missing. A directory there refuses the rename. Returns whether a name was
/// replaced, which `-v` reports as GNU does.
fn link_replacing(filesystem: &BlockingFs, original: &Path, link: &Path) -> io::Result<bool> {
	let error = match filesystem.hard_link(original, link) {
		Ok(()) => return Ok(false),
		Err(error) if error.kind() == io::ErrorKind::AlreadyExists => error,
		Err(error) => return Err(error),
	};
	let (Ok(there), Ok(wanted)) = (filesystem.symlink_metadata(link), filesystem.symlink_metadata(original)) else {
		return Err(error);
	};
	if there.same_file(&wanted) {
		return Ok(false);
	}
	// GNU's `try_tempname` with `CuXXXXXX`: a short random name, tried again
	// only where one exists already.
	let parent = link.parent().unwrap_or_else(|| Path::new(""));
	let mut tries = 0;
	let temp = loop {
		let temp = parent.join(temp_link_name());
		match filesystem.hard_link(original, &temp) {
			Ok(()) => break temp,
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists && tries < 100 => tries += 1,
			Err(error) => return Err(error),
		}
	};
	filesystem.rename(&temp, link).inspect_err(|_| {
		let _ = filesystem.remove_file(&temp);
	})?;
	Ok(true)
}

/// A fresh name for [`link_replacing`]'s temporary link: `Cu` and six random
/// letters and digits, as GNU's.
fn temp_link_name() -> String {
	use rand::{RngExt as _, distr::Alphanumeric, rng};

	let mut rng = rng();
	let mut name = String::from("Cu");
	name.extend((0..6).map(|_| char::from(rng.sample(Alphanumeric))));
	name
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
struct DestFacts<'a> {
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
	/// The host file the copy wrote, by its own descriptor: its owner, mode
	/// and times are set through it, not by its name.
	written:   Option<&'a std::fs::File>,
	/// It is a directory, a symbolic link or a special file made anew, not a
	/// file whose data the copy wrote: past a failure to set its extended
	/// attributes it gets its times but no mode, as GNU's `copy_internal`
	/// treats what `copy_reg` did not copy.
	stops_at_attributes: bool,
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
	// GNU reads the destination with lstat where the copy would not write
	// through a link there (`copy.c`, `use_lstat`): a source copied as a link
	// or as a special file, `-l`, `-s`, a backup or `--remove-destination`.
	// Only a regular file is written through a link at the destination, and
	// only then does a link to nothing refuse the copy.
	let copy_contents = dereference || !source_is_symlink;
	let lstat_without_backup = !copy_contents
		|| (options.recursive && !options.copy_contents && !source_metadata.is_file())
		|| matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink)
		|| options.remove_destination()
		|| options.move_mode;
	let dest_by_lstat = lstat_without_backup || options.backup != BackupMode::None;
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

		// A link cp writes through must lead somewhere: one to nothing is
		// refused, and one whose target cannot be read (a directory nobody may
		// search) is reported as GNU's `stat` of it reports it.
		if !dest_by_lstat && !is_symlink_loop(&filesystem, &dest_fs) {
			match filesystem.metadata(&dest_fs) {
				Ok(_) => {},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {
					if host.var("POSIXLY_CORRECT").is_none() {
						// GNU refuses it when it opens the destination, after
						// `-v` named the copy, and `--debug` reports it.
						if report {
							print_verbose_output(host, state, options, source, dest, None);
						}
						if options.debug && !options.attributes_only {
							state.say(host, CopyDebug::failed(false, options.reflink_mode));
						}
						return Err(CpError::Error(format!(
							"not writing through dangling symlink {}",
							dest.quote()
						)));
					}
				},
				Err(error) => return Err(CpError::IoErrContext(error, format!("cannot stat {}", dest.quote()))),
			}
		}
	}

	// `--attributes-only` keeps an existing destination's data, unless it is
	// to be removed or backed up first, as GNU's are; GNU decides whether the
	// two are the same file either way (`same_file_ok`).
	let check_existing_dest = initial_dest_metadata.is_some()
		&& (!options.attributes_only || options.remove_destination() || options.backup != BackupMode::None);
	// `-n` and `--update=none[-fail]` leave an existing destination, as GNU
	// reads it, alone before anything else is decided, the same-file check
	// too (`copy.c`).
	if matches!(options.update, UpdateMode::None | UpdateMode::NoneFail)
		&& let Some(existing) = &initial_dest_metadata
		&& (dest_by_lstat || filesystem.metadata(&dest_fs).is_ok())
	{
		return update_keeps(host, options, &source_metadata, existing, dest).map(drop);
	}
	if let Some(existing) = &initial_dest_metadata {
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.copy_mode == CopyMode::Link
		{
			// GNU does nothing where the two are one file as lstat reads them
			// (`same_file_ok`); a link at `dest` that leads to the source
			// link is another file, which -P replaces.
			if source_is_symlink && !dereference && paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, false) {
				return Ok(());
			}
			if !dest_is_symlink
				&& (options.backup == BackupMode::None
					|| !converts_to_backup(&filesystem, source, dest, &dest_fs, options))
			{
				// The destination is the source's file (or the file a source
				// link cp follows leads to), already linked, unless GNU turns
				// this into a copy to the backup name: GNU compares under `-u`
				// and asks under `-i`, then does nothing (`copy.c`,
				// `same_file_ok`), so `--remove-destination` removes nothing here.
				if !update_keeps(host, options, &source_metadata, existing, dest)?
					&& matches!(options.overwrite, OverwriteMode::Interactive(_))
				{
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
	// The converted copy makes no backup, so its `-u` reads the backup name
	// as the rest of the command reads a destination.
	let update_by_lstat = if own_backup.is_some() { lstat_without_backup } else { dest_by_lstat };
	let update_dest = if update_by_lstat {
		filesystem.symlink_metadata(&update_fs)
	} else {
		filesystem.metadata(&update_fs)
	};
	// Without `-f`, GNU's `same_file_ok` refuses the source's own entry as the
	// destination of a backup where cp reads the source as a link, or copies in
	// another mode than a copy it follows, before `-u` compares or `-i` asks
	// (`copy.c`). A followed source is backed up by renaming and then cannot be
	// opened (`handle_existing_dest`).
	if check_existing_dest
		&& options.backup != BackupMode::None
		&& !options.unlink_after_failed_open()
		&& !(matches!(options.copy_mode, CopyMode::Copy | CopyMode::AttrOnly)
			&& options.dereference(source_in_command_line))
		&& same_entry(&filesystem, &source_fs, &dest_fs)
		&& !renames_the_followed_source(&filesystem, source, dest, &source_fs, &dest_fs, options, source_in_command_line)
	{
		return Err(CpError::Error(format!("{} and {} are the same file", source.quote(), dest.quote())));
	}
	// `-u`/`--update` decides in every mode (`-l`, `-s`, `--attributes-only`
	// and a copy alike) before anything is backed up or removed, and `-i`
	// asks after it.
	if let Ok(update_dest) = update_dest
		&& update_keeps(host, options, &source_metadata, &update_dest, &update_shown)?
	{
		return Ok(());
	}
	// `--attributes-only` leaves the destination where it is, but GNU asks
	// about it under `-i` all the same (`copy.c`).
	if !check_existing_dest && options.attributes_only && initial_dest_metadata.is_some() {
		let existing =
			if dest_by_lstat { filesystem.symlink_metadata(&dest_fs) } else { filesystem.metadata(&dest_fs) };
		if let Ok(existing) = existing {
			if options.update != UpdateMode::IfOlder {
				options.overwrite.verify(host, dest, options.debug)?;
			}
			// A directory there takes no non-directory (`handle_existing_dest`).
			if existing.is_dir() && !options.move_mode {
				return Err(overwrite_directory(dest, source));
			}
		}
	}

	let mut backup = None;
	if check_existing_dest {
		let own_entry;
		(backup, own_entry) =
			handle_existing_dest(
			host,
			state,
			source,
			dest,
			options,
			source_in_command_line,
			own_backup.as_deref(),
			dest_by_lstat,
		)?;
		if own_entry {
			return Ok(());
		}
		dest_replaced = true;
		if are_hardlinks_to_same_file(&filesystem, &source_fs, &dest_fs) {
			// After a backup the name is new to GNU even where the rename did
			// nothing (the backup name another link of the same file): its
			// create then fails on it, as below.
			if options.copy_mode == CopyMode::Copy && backup.is_none() {
				return Ok(());
			}
			if options.copy_mode == CopyMode::Link && (!source_is_symlink || !dest_is_symlink) {
				return Ok(());
			}
		}
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
		let replaced = match link_replacing(&filesystem, &host.resolve(&new_source), &dest_fs) {
			Ok(replaced) => replaced,
			Err(e) => {
				let error = CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), new_source.quote()),
				);
				return Err(match &backup {
					Some(backup) => un_backup(host, options, dest, backup, error),
					None => error,
				});
			},
		};

		// GNU reports a name its `force_linkat` replaced after the copy's line
		// for a file; for a link it removed the name first (it never writes
		// through a link), and says so first.
		let say_removed = |host: &mut Host, state: &CopyState| {
			if replaced && options.verbose {
				state.say(host, format_args!("removed {}", dest.quote()));
			}
		};
		if source_is_symlink {
			say_removed(host, state);
		}
		if report {
			print_verbose_output(host, state, options, source, dest, backup.as_deref());
		}
		if !source_is_symlink {
			say_removed(host, state);
		}

		return Ok(());
	}

	let mut dest_metadata = if backup.is_some() {
		// GNU takes the name as new after its backup, a rename (`new_dst`).
		// `handle_existing_dest` backs up by renaming every destination but
		// the source's own entry, whose backup is the whole copy and returns
		// there. A rename onto another link of the same file does nothing,
		// and GNU still takes the name as new: the exclusive create fails on
		// it, and a symlink replaces it only under `-f`. Any other file there
		// appeared after the backup and is new to cp too.
		None
	} else if dest_replaced {
		filesystem.symlink_metadata(&dest_fs).ok()
	} else {
		initial_dest_metadata
	};

	// A copied symlink replaces any destination that is not a directory (a
	// FIFO, socket or device too), which GNU removes before reporting the
	// copy, saying `removed` under `-v` (`copy.c`).
	if source_metadata.is_symlink()
		&& options.copy_mode == CopyMode::Copy
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

	state.written = None;
	let fate = handle_copy_mode(
		host,
		state,
		source,
		dest,
		options,
		&source_metadata,
		dest_metadata.as_ref(),
		source_in_command_line,
	);
	// The file a regular copy wrote, by its own descriptor (see
	// `CopyState::written`).
	let written = state.written.take();
	let fate = match fate {
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
	if copied_data && !mode_set_later && kept.is_none() {
		let mode = new_dest_mode(&source_metadata, options, host.umask());
		if created_mode != Some(mode) {
			then_mode = Some(mode);
			created_mode = None;
		}
	}

	// What the copy left at `dest`: a recreated symlink, or a file, which may
	// be a link's target the copy wrote through. GNU sets the attributes of
	// that file through its descriptor, so they go to the target.
	let dest_facts = DestFacts {
		symlink: match options.copy_mode {
			CopyMode::Copy if source_metadata.is_symlink() => Some(true),
			CopyMode::Copy | CopyMode::AttrOnly if !source_metadata.is_symlink() => Some(false),
			_ => None,
		},
		mode: created_mode,
		owner,
		then_mode,
		through,
		written: written.as_ref(),
		stops_at_attributes: source_metadata.is_symlink() || (written.is_none() && !source_metadata.is_file()),
	};

	// Some stream files may not exist after we have copied them, like
	// anonymous pipes or a FIFO whose writer removed its name: what cp read of
	// the source before stands for it, as GNU's `copy_reg` uses its `fstat`.
	// The owner, then the final mode, are set through the descriptor cp wrote.
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
	} else {
		// The seam where a test swaps the name before the owner and mode are
		// set.
		#[cfg(test)]
		crate::host::run_hook(&dest_fs);
		// Like GNU, a refused owner falls back to the group alone, and is not
		// reported.
		if matches!(options.attributes.ownership, Preserve::Yes { .. })
			&& let Some(file) = &written
			&& let Some((uid, gid)) = source_metadata.uid().zip(source_metadata.gid())
			&& owner != Some((uid, gid))
			&& chown_handle(file, Some(uid), Some(gid)).is_err()
		{
			let _ = chown_handle(file, None, Some(gid));
		}
		if let Some(mode) = then_mode {
			let _ = match &written {
				Some(file) => set_handle_mode(file, mode),
				None => filesystem.set_permissions(&dest_fs, Permissions::from_mode(mode)),
			};
		}
		// The mode and the times `-p` keeps, from what cp read of it, through
		// the descriptor, as GNU's `copy_reg` sets them from its `fstat`.
		if let Some(file) = &written {
			handle_preserve(host, options.attributes.mode, || {
				set_mode(&filesystem, &dest_fs, dest, source_metadata.permissions(), Some(file))
			})?;
			handle_preserve(host, options.attributes.timestamps, || {
				let modified = source_metadata
					.modified()
					.map_err(|e| CpError::IoErrContext(e, format!("preserving times for {}", dest.quote())))?;
				let times = std::fs::FileTimes::new().set_modified(modified);
				file.set_times(match source_metadata.accessed() {
					Ok(accessed) => times.set_accessed(accessed),
					Err(_) => times,
				})
				.map_err(|e| CpError::IoErrContext(e, format!("preserving times for {}", dest.quote())))
			})?;
		}
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
			return copy_special(host, dest, NodeKind::Socket, 0o777);
		}
		if file_type.is_fifo() {
			return copy_special(host, dest, NodeKind::Fifo, 0o666);
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
			return copy_special(host, dest, kind, source_metadata.mode() & 0o7777);
		}
	}

	if source_metadata.is_symlink() {
		copy_link(host, state, source, dest, options, source_metadata)?;
		return Ok(DestFate::Kept);
	}
	let (copy_debug, fate) = match copy_data(host, state, source, dest, options, source_metadata, dest_metadata) {
		Ok(done) => done,
		Err(error) => {
			// GNU's `--debug` reports a copy that failed too (`copy.c`).
			if !options.attributes_only && options.debug {
				let clone_refused = options.reflink_mode == ReflinkMode::Always
					&& matches!(&error, CpError::IoErrContext(_, context) if context.starts_with("failed to clone"));
				state.say(host, CopyDebug::failed(clone_refused, options.reflink_mode));
			}
			return Err(error);
		},
	};
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
	kind: NodeKind,
	mode: u32,
) -> CopyResult<DestFate> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	// An existing destination GNU replaces was removed before this
	// (`delete_dest_if_needed_and_allowed`); one that is still there makes
	// the new node fail with "File exists", as GNU's does.

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
	// A copied link is named by its destination alone, as GNU names it
	// (`copy.c`); `-s` names its target too.
	// Under `-f` a name still there (taken as new after a backup that left
	// it) is replaced, as GNU's `force_symlinkat` does.
	symlink_file(host, state, &link, dest, kind, options.unlink_after_failed_open()).map_err(|error| match error {
		CpError::IoErrContext(e, _) => CpError::IoErrContext(e, format!("cannot create symbolic link {}", dest.quote())),
		other => other,
	})?;
	copy_attributes(
		host,
		source,
		dest,
		&options.attributes,
		false,
		false,
		options.set_selinux_context,
		Some(source_metadata),
		DestFacts { symlink: Some(true), stops_at_attributes: true, ..DestFacts::default() },
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
				Ok(clone) => {
					// The clone's times, owner and mode are set through the
					// descriptor it was made with, as GNU sets them on the one it
					// cloned into (see `CopyState::written`).
					if !matches!(options.attributes.timestamps, Preserve::Yes { .. }) {
						let now = std::time::SystemTime::now();
						clone
							.set_times(std::fs::FileTimes::new().set_accessed(now).set_modified(now))
							.map_err(|e| CpError::IoErrContext(e, context_for(source, dest)))?;
					}
					state.written = Some(clone);
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
		// GNU's words for a stream (`copy.c`): no offload or clone is tried
		// on one, `--reflink=never` and `--sparse=always` avoid the offload,
		// and only `--sparse=always` looks for zeros.
		match (options.reflink_mode, options.sparse_mode) {
			(ReflinkMode::Never, _) => CopyDebug {
				offload:          OffloadReflinkDebug::Avoided,
				reflink:          OffloadReflinkDebug::No,
				sparse_detection: SparseDebug::No,
			},
			(_, SparseMode::Always) => CopyDebug {
				offload:          OffloadReflinkDebug::Avoided,
				reflink:          OffloadReflinkDebug::Unsupported,
				sparse_detection: SparseDebug::Zeros,
			},
			_ => CopyDebug { sparse_detection: SparseDebug::No, ..CopyDebug::STREAMED },
		}
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
					// `--reflink=never` avoids the copy offload too, which can
					// share extents, as GNU's does.
					options.reflink_mode != ReflinkMode::Never,
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
	state.written = keep_written(&dest_file, dest)?;
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
		// A directory is the destination itself only under -T, where the copy
		// decides (`handle_existing_dest`).
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
			let _created = make_parent_dirs(host, state, root, &join_path(target, &parents_relative(root)), options)?;
			join_path(target, &parents_relative(parent))
		},
		_ => target.to_path_buf(),
	};

	// The copy of `root`: `target` itself, unless it is an existing directory
	// the copy goes into (`dir/.` into `target/.`, the contents). `-T` copies
	// the contents into `target`.
	let root_dest = match filesystem.metadata(host.resolve(&target)) {
		// With a backup asked for, `copy_entry` backs a non-directory up.
		Ok(metadata) if !metadata.is_dir() && options.backup != BackupMode::None => target.clone(),
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
		// A link there that leads to no directory (to nothing, or into a
		// directory nobody may search) is a non-directory, as GNU reads it.
		Err(_) if options.backup == BackupMode::None && filesystem.symlink_metadata(host.resolve(&target)).is_ok() => {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				target.quote(),
				root.quote()
			)));
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

/// A directory of the tree being copied, while the entries below it are.
///
/// Its entries are read whole when it is entered, as GNU cp's fts reads a
/// directory before it descends, so the walk holds no descriptor of it while
/// it copies the levels below: depth costs memory, not file descriptors. The
/// walk keeps these on a stack of its own instead of recursing, so depth does
/// not cost the thread's stack either.
struct DirCopy {
	source:           PathBuf,
	dest:             PathBuf,
	names:            std::vec::IntoIter<io::Result<OsString>>,
	/// Whether its identity is on [`Walk::ancestors`], to be popped once its
	/// contents are copied.
	pushed:           bool,
	created:          bool,
	entry_is_symlink: bool,
	metadata:         Metadata,
}

/// What runs before the walk takes up an entry below the operand, with the
/// entry's source path: a test changes the tree there, as another process
/// could.
#[cfg(test)]
type EntryHook = Box<dyn FnMut(&Path)>;

#[cfg(test)]
thread_local! {
	static BEFORE_ENTRY: std::cell::RefCell<Option<EntryHook>> = const { std::cell::RefCell::new(None) };
}

/// Copies one entry of a directory tree: a directory with everything below
/// it (each directory gets its attributes once its contents are in place),
/// anything else as a file. A failure below the entry is reported and the
/// walk goes on, as GNU cp does; the entry's own failure is returned.
fn copy_entry(
	host: &mut Host,
	state: &mut CopyState,
	walk: &mut Walk<'_>,
	source: &Path,
	dest: &Path,
	is_root: bool,
) -> CopyResult<()> {
	let Some(top) = enter_entry(host, state, walk, source, dest, is_root)? else {
		return Ok(());
	};
	let mut stack = vec![top];
	while let Some(dir) = stack.last_mut() {
		let next = match dir.names.next() {
			Some(_) if host.is_cancelled() => {
				walk.failed = true;
				dir.names = Vec::new().into_iter();
				continue;
			},
			next => next,
		};
		match next {
			Some(Ok(name)) => {
				let child_source = child_path(&dir.source, &name);
				let child_dest = child_path(&dir.dest, &name);
				#[cfg(test)]
				BEFORE_ENTRY.with_borrow_mut(|hook| {
					if let Some(hook) = hook {
						hook(&child_source);
					}
				});
				match enter_entry(host, state, walk, &child_source, &child_dest, false) {
					Ok(Some(child)) => stack.push(child),
					Ok(None) => {},
					Err(error) => entry_failed(host, walk, &error),
				}
			},
			Some(Err(error)) => {
				show_error(host, CpError::IoErrContext(error, format!("cannot access {}", dir.source.quote())));
				walk.failed = true;
			},
			None => {
				let Some(done) = stack.pop() else { break };
				let result = leave_dir(host, walk, done);
				if stack.is_empty() {
					return result;
				}
				if let Err(error) = result {
					entry_failed(host, walk, &error);
				}
			},
		}
	}
	Ok(())
}

/// A failure of an entry below the operand, reported where it happened; the
/// walk goes on.
fn entry_failed(host: &mut Host, walk: &mut Walk<'_>, error: &CpError) {
	show_error_if_needed(host, error);
	if !matches!(error, CpError::Skipped(false)) {
		walk.failed = true;
	}
}

/// Copies `source` to `dest` when it is not a directory to descend into,
/// and returns `None`. For a directory it makes the copy's directory, reads
/// the source's entries whole, and returns them for the walk to copy.
fn enter_entry(
	host: &mut Host,
	state: &mut CopyState,
	walk: &mut Walk<'_>,
	source: &Path,
	dest: &Path,
	is_root: bool,
) -> CopyResult<Option<DirCopy>> {
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
		return copy_file(host, state, source, dest, options, false, Some(metadata)).map(|()| None);
	}

	let dest_fs = host.resolve(dest);
	// A non-directory there, a link to nothing too, takes no directory unless
	// a backup is asked for: GNU then renames it to its backup name and makes
	// the directory (`copy.c`).
	let non_directory = match filesystem.symlink_metadata(&dest_fs) {
		Ok(existing) => !existing.is_dir(),
		Err(_) => false,
	};
	let mut backup = None;
	if non_directory {
		if options.backup == BackupMode::None || options.move_mode {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				dest.quote(),
				source.quote()
			)));
		}
		let named = backup_path(&filesystem, options.backup, &dest_fs, &options.backup_suffix, true)
			.map_err(|_| CpError::Error(format!("cannot backup {}: File exists", dest.quote())))?;
		if let Some(named) = named {
			filesystem
				.rename(&dest_fs, &named)
				.map_err(|e| CpError::IoErrContext(e, format!("cannot backup {}", dest.quote())))?;
			backup = Some(named);
		}
	}
	let created = if filesystem.metadata(&dest_fs).is_err() {
		build_dir(host, dest, false, options, Some(source))?;
		// A directory `mv` copies between filesystems, the operand too, is
		// reported as GNU's mv reports it.
		if options.verbose && options.move_mode {
			state.say(host, format_args!("created directory {}", dest.quote()));
		} else if options.verbose {
			print_verbose_output(host, state, options, source, dest, backup.as_deref());
		}
		true
	} else {
		false
	};

	let mut names = Vec::new();
	let pushed = match walk.enter(host, source, is_root) {
		None => false,
		Some(pushed) => {
			match filesystem.read_dir(&source_fs) {
				Err(error) => {
					show_error(host, CpError::IoErrContext(error, format!("cannot access {}", source.quote())));
					walk.failed = true;
				},
				// GNU reads a directory with `savedir` sorted by inode number
				// (`SAVEDIR_SORT_FASTREAD`), and copies its entries in that
				// order, which `-v` shows. Only the names are kept: an entry
				// would keep the listing's descriptor open.
				Ok(entries) => {
					let mut entries: Vec<_> = entries.collect();
					entries.sort_by_key(|entry| entry.as_ref().ok().and_then(entry_inode));
					names = entries.into_iter().map(|entry| entry.map(|entry| entry.file_name())).collect();
				},
			}
			pushed
		},
	};
	Ok(Some(DirCopy {
		source: source.to_path_buf(),
		dest: dest.to_path_buf(),
		names: names.into_iter(),
		pushed,
		created,
		entry_is_symlink,
		metadata,
	}))
}

/// Ends a directory once everything below it is copied: it leaves the walk's
/// ancestors, then gets its final attributes. Directories are created without
/// some permissions so nobody can use them before they are ready.
fn leave_dir(host: &mut Host, walk: &mut Walk<'_>, dir: DirCopy) -> CopyResult<()> {
	if dir.pushed {
		walk.ancestors.pop();
	}
	let options = walk.options;
	// The entry's lstat is its followed stat unless it is a symlink.
	copy_attributes(
		host,
		&dir.source,
		&dir.dest,
		&options.attributes,
		dir.created && options.copy_mode != CopyMode::Link,
		true,
		options.set_selinux_context,
		(!dir.entry_is_symlink).then_some(&dir.metadata),
		DestFacts { symlink: dir.created.then_some(false), stops_at_attributes: true, ..DestFacts::default() },
	)
}

/// The inode number of a native directory entry, as `readdir` gives it.
fn entry_inode(entry: &pi_vfs::DirEntry) -> Option<u64> {
	#[cfg(unix)]
	{
		entry.native().map(std::os::unix::fs::DirEntryExt::ino)
	}
	#[cfg(not(unix))]
	{
		let _ = entry;
		None
	}
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
		io::{self, Read as _, Seek as _, SeekFrom, Write as _},
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

	/// Copies all of `source` into `dest` from their current offsets with
	/// plain reads and writes: no `copy_file_range`, which may share extents.
	fn read_write_copy(mut source: &File, mut dest: &File) -> io::Result<()> {
		let mut buffer = vec![0; 128 * 1024];
		loop {
			let read = match source.read(&mut buffer) {
				Ok(0) => return Ok(()),
				Ok(read) => read,
				Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
				Err(error) => return Err(error),
			};
			dest.write_all(&buffer[..read])?;
		}
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
		offload: bool,
		report: bool,
		source_path: &Path,
		dest_path: &Path,
	) -> CopyResult<CopyDebug> {
		let (copy_debug, result) = match sparse_mode {
			// Without the offload GNU reads and writes, and says so.
			SparseMode::Auto | SparseMode::Never if !offload => (
				CopyDebug {
					offload: OffloadReflinkDebug::Avoided,
					reflink: OffloadReflinkDebug::No,
					sparse_detection: SparseDebug::No,
				},
				read_write_copy(source, dest),
			),
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

	/// Writes `F` into the FIFO `fifo`, which the copy `copy` opens for
	/// reading, and holds its end until the byte is read or the copy has
	/// ended. gVisor's blocking opens of a FIFO can miss each other. cp's read
	/// open can miss a writer that opens, writes and closes while the opener
	/// gets ready to wait, and then waits for the next writer's open, which
	/// nothing makes; Linux's open waits on the count of writer opens and sees
	/// that writer (`wait_for_partner` in fs/pipe.c). A writer's blocking open
	/// can miss cp's read open the same way, and then both wait for ever. So
	/// the end is opened for reading and writing, which never waits
	/// (`fifo(7)`), before cp's open or after it, and is held open, there to
	/// be seen whenever cp's open looks. As a reader too, it takes no EPIPE
	/// from a copy that fails and closes the FIFO first.
	#[cfg(target_os = "linux")]
	fn feed_until_read<T>(fifo: &std::path::Path, copy: &std::thread::JoinHandle<T>) {
		let Ok(mut end) = fs::OpenOptions::new().read(true).write(true).open(fifo) else {
			return;
		};
		if std::io::Write::write_all(&mut end, b"F").is_err() {
			return;
		}
		while !copy.is_finished() && unread(&end) > 0 {
			std::thread::sleep(Duration::from_millis(1));
		}
	}

	/// How many bytes the FIFO that `fifo` is an end of holds.
	#[cfg(target_os = "linux")]
	fn unread(fifo: &fs::File) -> libc::c_int {
		use std::os::fd::AsRawFd as _;
		let mut bytes: libc::c_int = 0;
		// SAFETY: `fifo` is open, and `FIONREAD` writes one `int` to
		// `bytes`, which outlives the call.
		let read = unsafe { libc::ioctl(fifo.as_raw_fd(), libc::FIONREAD, &raw mut bytes) };
		assert_eq!(read, 0, "FIONREAD of a FIFO: {}", std::io::Error::last_os_error());
		bytes
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
				feed_until_read(&fifo, &copy);
				let _ = copy.join();
				panic!("cp opened the FIFO before it backed b up");
			}
			assert!(!copy.is_finished(), "cp ended before it backed b up");
			std::thread::yield_now();
		}
		fs::create_dir(dir.path().join("b")).unwrap();
		// cp may fail at `b` and close the FIFO without reading it; the row is
		// decided by what cp did, not by the write.
		feed_until_read(&fifo, &copy);
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
			// cp may fail at `b` and close the FIFO without reading it.
			feed_until_read(&fifo, &copy);
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

	/// The new file's final mode is set only after its owner: until then it
	/// keeps the open mode of [`a_new_file_is_private_until_its_owner_is_set`],
	/// with no group or other bits where the owner may change, as GNU's
	/// `copy_reg` keeps it (`copy.c` 9.7, lines 1675-1704). The test reads the
	/// mode at the seam just before the owner is set, for a regular file and a
	/// FIFO, with `-p`, `--preserve=ownership` and `--preserve=all`.
	#[test]
	#[cfg(target_os = "linux")]
	fn the_final_mode_waits_for_the_owner() {
		use std::{
			io::Write as _,
			os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
			sync::{Arc, Mutex},
		};

		use crate::host::{Host, Utility as _};

		let umask = crate::host::process_umask();
		for flag in ["-p", "--preserve=ownership", "--preserve=all"] {
			for fifo in [false, true] {
				let dir = tempdir().unwrap();
				let source = dir.path().join("a");
				let writer = if fifo {
					let name = std::ffi::CString::new(source.as_os_str().as_encoded_bytes()).unwrap();
					// SAFETY: `name` is NUL-terminated and outlives the call.
					assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o644) }, 0, "mkfifo");
					// Held read-write, so cp's open does not wait; written before cp reads.
					let mut writer = fs::OpenOptions::new()
						.read(true)
						.write(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&source)
						.unwrap();
					writer.write_all(b"F").unwrap();
					Some(writer)
				} else {
					fs::write(&source, b"F").unwrap();
					None
				};
				fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
				let made = dir.path().join("b");
				let seen = Arc::new(Mutex::new(None));
				{
					let (read, seen) = (made.clone(), Arc::clone(&seen));
					crate::host::hook_at(made.clone(), move || {
						*seen.lock().unwrap() = fs::metadata(&read).ok().map(|metadata| metadata.permissions().mode() & 0o7777);
					});
				}
				let case = format!("cp {flag} a b from a {}", if fifo { "FIFO" } else { "file" });
				let cwd = dir.path().to_owned();
				let copy = std::thread::spawn(move || {
					let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
					let code = <Cp as clap::Parser>::try_parse_from(["cp", flag, "a", "b"]).unwrap().run(&mut host);
					(code, capture.err())
				});
				if fifo {
					// cp reads `F`, then waits for the end: wait for b, then close.
					while !made.exists() {
						assert!(!copy.is_finished(), "{case}: cp ended before it made the file");
						std::thread::yield_now();
					}
					drop(writer);
				}
				let (code, err) = copy.join().unwrap();
				assert_eq!((code, err.as_str()), (0, ""), "{case}");
				assert_eq!(
					seen.lock().unwrap().map(|mode| format!("{mode:o}")),
					Some(format!("{:o}", 0o600 & !umask)),
					"{case}: the mode just before the owner is set"
				);
				// A preserved mode is the source's; else the source's less the umask.
				let after = if flag == "--preserve=ownership" { 0o640 & !umask } else { 0o640 };
				assert_eq!(
					format!("{:o}", fs::metadata(&made).unwrap().permissions().mode() & 0o7777),
					format!("{after:o}"),
					"{case}: after"
				);
			}
		}
	}

	/// A clone made by `--reflink=always` holds the source's data from the
	/// start, so no other user may open it before cp sets its mode, as none may
	/// open GNU's (`copy.c` 9.4, lines 1449-1451 and 1513): at the seam just
	/// before the owner and mode are set, the new clone has no group or other
	/// bits, and after it has its final mode. The source is 0644, with `-p`,
	/// `--preserve=ownership` and `--preserve=mode` (with none, cp sets the
	/// final mode before the seam; `cow`'s test reads the clone it is handed).
	/// Where the filesystem cannot clone the row says it is skipped.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_clone_is_private_until_its_mode_is_set() {
		use std::{
			os::unix::fs::PermissionsExt as _,
			sync::{Arc, Mutex},
		};

		use crate::host::{Host, Utility as _};

		let umask = crate::host::process_umask();
		let rows: [&[&str]; 3] = [
			&["--reflink=always", "-p"],
			&["--reflink=always", "--preserve=ownership"],
			&["--reflink=always", "--preserve=mode"],
		];
		for flags in rows {
			let dir = tempdir().unwrap();
			let source = dir.path().join("a");
			fs::write(&source, b"secret").unwrap();
			fs::set_permissions(&source, fs::Permissions::from_mode(0o644)).unwrap();
			let made = dir.path().join("b");
			let seen = Arc::new(Mutex::new(None));
			{
				let (read, seen) = (made.clone(), Arc::clone(&seen));
				crate::host::hook_at(made.clone(), move || {
					*seen.lock().unwrap() = fs::metadata(&read).ok().map(|metadata| metadata.permissions().mode() & 0o7777);
				});
			}
			let case = format!("cp {} a b", flags.join(" "));
			let (mut host, capture) = Host::for_test(Cp::NAME, "", dir.path());
			let mut args = vec!["cp"];
			args.extend(flags);
			args.extend(["a", "b"]);
			let code = <Cp as clap::Parser>::try_parse_from(args).unwrap().run(&mut host);
			let err = capture.err();
			if err.starts_with("cp: failed to clone") {
				eprintln!("{case}: skipped, this filesystem does not clone ({})", err.trim_end());
				continue;
			}
			assert_eq!((code, err.as_str()), (0, ""), "{case}");
			assert_eq!(
				seen.lock().unwrap().map(|mode| format!("{:o}", mode & 0o077)),
				Some("0".to_owned()),
				"{case}: the clone's group and other bits before its mode is set"
			);
			let after = if flags[1] == "--preserve=ownership" { 0o644 & !umask } else { 0o644 };
			assert_eq!(
				format!("{:o}", fs::metadata(&made).unwrap().permissions().mode() & 0o7777),
				format!("{after:o}"),
				"{case}: after"
			);
		}
	}

	/// `--copy-contents` from a source that is not a regular file, not
	/// followed (`-P`, `-R`, `-d`, `-a`), onto an existing `b` removes `b`
	/// first, says so under `-v`, and makes a new file, as GNU does (`copy.c`
	/// 9.4, lines 2570-2587): a link at `b` keeps leading to `c`, which keeps
	/// its data; `b`'s second hard link `h` keeps the old data; and the new
	/// `b` has a new file's mode, not the old one's 600. The sources: a FIFO of
	/// mode 640 that holds `N`, and `/dev/null`. GNU 9.4's answers, measured
	/// as uid 1000 with umask 022, are the rows' (the modes are the umask's).
	#[test]
	#[cfg(target_os = "linux")]
	fn a_special_source_replaces_the_destination_as_gnu_does() {
		use std::{
			io::Write as _,
			os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
		};

		use crate::host::{Host, Utility as _};

		let umask = crate::host::process_umask();
		for source in ["fifo", "/dev/null"] {
			for flag in ["-P", "-R", "-d", "-a"] {
				for at in ["plain", "link", "hard"] {
					let dir = tempdir().unwrap();
					let path = |name: &str| dir.path().join(name);
					let mut writer = None;
					let shown = if source == "fifo" {
						let name = std::ffi::CString::new(path("a").as_os_str().as_encoded_bytes()).unwrap();
						// SAFETY: `name` is NUL-terminated and outlives the call.
						assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
						fs::set_permissions(path("a"), fs::Permissions::from_mode(0o640)).unwrap();
						// Held read-write, so cp's open does not wait; written before cp reads.
						let mut fifo = fs::OpenOptions::new()
							.read(true)
							.write(true)
							.custom_flags(libc::O_NONBLOCK)
							.open(path("a"))
							.unwrap();
						fifo.write_all(b"N").unwrap();
						writer = Some(fifo);
						"a"
					} else {
						"/dev/null"
					};
					fs::write(path("c"), b"OLD").unwrap();
					fs::set_permissions(path("c"), fs::Permissions::from_mode(0o600)).unwrap();
					match at {
						"plain" => fs::rename(path("c"), path("b")).unwrap(),
						"link" => std::os::unix::fs::symlink("c", path("b")).unwrap(),
						_ => {
							fs::hard_link(path("c"), path("b")).unwrap();
							fs::rename(path("c"), path("h")).unwrap();
						},
					}
					let case = format!("cp {flag} --copy-contents -v {shown} b, b {at}");
					let cwd = dir.path().to_owned();
					let copy = std::thread::spawn(move || {
						let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
						let code = <Cp as clap::Parser>::try_parse_from(["cp", flag, "--copy-contents", "-v", shown, "b"])
							.unwrap()
							.run(&mut host);
						(code, capture.out(), capture.err())
					});
					if let Some(fifo) = writer {
						// cp has read `N` once it wrote it, wherever it wrote it; then the end.
						while fs::read(path("b")).ok().as_deref() != Some(b"N") {
							assert!(!copy.is_finished(), "{case}: cp ended before it wrote the data");
							std::thread::yield_now();
						}
						drop(fifo);
					}
					let (code, out, err) = copy.join().unwrap();
					assert_eq!(
						(code, out, err),
						(0, format!("removed 'b'\n'{shown}' -> 'b'\n"), String::new()),
						"{case}"
					);
					let made = fs::symlink_metadata(path("b")).unwrap();
					let (data, mode) = match (source, flag) {
						("fifo", "-a") => (b"N".to_vec(), 0o640),
						("fifo", _) => (b"N".to_vec(), 0o640 & !umask),
						(_, "-a") => (Vec::new(), 0o666),
						_ => (Vec::new(), 0o666 & !umask),
					};
					assert!(made.is_file(), "{case}: b is not a new regular file");
					assert_eq!(
						(fs::read(path("b")).unwrap(), format!("{:o}", made.mode() & 0o7777)),
						(data, format!("{mode:o}")),
						"{case}: the new b"
					);
					match at {
						"link" => assert_eq!(fs::read(path("c")).unwrap(), b"OLD", "{case}: c"),
						"hard" => assert_eq!(fs::read(path("h")).unwrap(), b"OLD", "{case}: h"),
						_ => {},
					}
				}
			}
		}
	}

	/// A file the copy wrote that is read-only when its extended attributes
	/// are set, as a clone macOS's `clonefile` makes with a read-only
	/// source's mode, is made owner-writable through its descriptor for them
	/// and given its mode back, unless cp has an owner's privileges; GNU's
	/// `copy_reg` gives the file it creates the owner's write bit for the same
	/// reason. On Linux a new file cp made is never read-only there, so the
	/// test makes it so at the seam before the owner is set. As root no write
	/// bit is needed, and the test says it is skipped. A file another user
	/// owns, which cp leaves as it is, is the next test's.
	/// Under gVisor (its kernel release names it), an `fsetxattr` after the
	/// file's mode changed answers `EACCES` in some runs (measured: 1 of 4),
	/// so the test says it is skipped there, as it does where the kernel
	/// refuses the attribute once the mode is writable again.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_read_only_file_cp_wrote_gets_its_attributes() {
		use std::os::unix::fs::PermissionsExt as _;

		let set = |file: &fs::File| {
			use std::os::fd::AsRawFd as _;
			// SAFETY: the name is NUL-terminated and `file` is open.
			unsafe { libc::fsetxattr(file.as_raw_fd(), c"user.cp_test".as_ptr(), b"v".as_ptr().cast(), 1, 0) }
		};
		if fs::read_to_string("/proc/sys/kernel/osrelease").is_ok_and(|release| release.contains("gvisor")) {
			eprintln!("skipped: under gVisor an attribute set after the mode changed is refused in some runs");
			return;
		}
		if nix::unistd::geteuid().is_root() {
			eprintln!("skipped: an owner's privileges need no write bit for an attribute");
			return;
		}
		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		// The kernel's answer: an open file made read-only by name, as the
		// test makes `b`, and writable again through its descriptor takes an
		// attribute through it.
		let probe = fs::OpenOptions::new().write(true).create_new(true).open(path("probe")).unwrap();
		fs::set_permissions(path("probe"), fs::Permissions::from_mode(0o444)).unwrap();
		probe.set_permissions(fs::Permissions::from_mode(0o644)).unwrap();
		if set(&probe) != 0 {
			eprintln!("skipped: {} for an attribute once the mode is writable again", std::io::Error::last_os_error());
			return;
		}
		fs::write(path("a"), b"A").unwrap();
		let source = fs::OpenOptions::new().write(true).open(path("a")).unwrap();
		assert_eq!(set(&source), 0, "an attribute on the source");
		let made = path("b");
		{
			let made = made.clone();
			crate::host::hook_at(made.clone(), move || {
				fs::set_permissions(&made, fs::Permissions::from_mode(0o444)).unwrap();
			});
		}
		let (code, capture) = run_util::<Cp>(&["--preserve=xattr", "a", "b"], "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		let mut value = [0_u8; 4];
		let name = std::ffi::CString::new(made.as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: both strings are NUL-terminated, and `value` is valid for its length.
		let got = unsafe { libc::getxattr(name.as_ptr(), c"user.cp_test".as_ptr(), value.as_mut_ptr().cast(), value.len()) };
		assert_eq!(got, 1, "the attribute on b");
		assert_eq!(fs::metadata(&made).unwrap().permissions().mode() & 0o7777, 0o444, "b's mode after");
	}

	/// A file another user owns that cp may write (through its other bits)
	/// and its owner may not gets the source's extended attributes and keeps
	/// its owner and mode, as GNU 9.4 sets them on it as it is (`copy.c`,
	/// lines 1660-1665): cp does not make it writable for them, which only
	/// its owner could do. As root the test makes `b` uid 65534's, of mode
	/// 446, and runs the copy as uid 1000 in a child process: the test binary
	/// run again for this test alone. Where uid 1000 cannot reach the test's
	/// directory, or the kernel refuses it an attribute of such a file, and
	/// not as root, the test says it is skipped.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_file_another_user_owns_gets_its_attributes_as_it_is() {
		use std::os::unix::{
			fs::{MetadataExt as _, PermissionsExt as _},
			process::CommandExt as _,
		};

		const CHILD: &str = "PI_CP_TEST_OTHER_OWNER_DIR";
		let set = |file: &fs::File| {
			use std::os::fd::AsRawFd as _;
			// SAFETY: the name is NUL-terminated and `file` is open.
			unsafe { libc::fsetxattr(file.as_raw_fd(), c"user.cp_test".as_ptr(), b"v".as_ptr().cast(), 1, 0) }
		};
		if let Some(dir) = std::env::var_os(CHILD) {
			// The child, as uid 1000: the kernel's answer for such a file first.
			let dir = std::path::PathBuf::from(dir);
			if let Err(e) = fs::metadata(dir.join("probe")) {
				eprintln!("CHILD skipped: uid 1000 cannot reach the test's directory: {e}");
				return;
			}
			let probe = fs::OpenOptions::new().write(true).open(dir.join("probe")).unwrap();
			if set(&probe) != 0 {
				eprintln!("CHILD skipped: {} for an attribute of another user's file", std::io::Error::last_os_error());
				return;
			}
			let (code, capture) = run_util::<Cp>(&["--preserve=xattr", "a", "b"], "", &dir);
			eprintln!("CHILD {code} {:?}", capture.err());
			return;
		}
		if !nix::unistd::geteuid().is_root() {
			eprintln!("skipped: only root can make a file another user owns");
			return;
		}
		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
		fs::write(path("a"), b"A").unwrap();
		fs::set_permissions(path("a"), fs::Permissions::from_mode(0o644)).unwrap();
		if set(&fs::OpenOptions::new().write(true).open(path("a")).unwrap()) != 0 {
			eprintln!("skipped: {} for an attribute", std::io::Error::last_os_error());
			return;
		}
		for name in ["b", "probe"] {
			fs::write(path(name), b"B").unwrap();
			std::os::unix::fs::chown(path(name), Some(65534), Some(65534)).unwrap();
			fs::set_permissions(path(name), fs::Permissions::from_mode(0o446)).unwrap();
		}
		// The child answers on stderr: with one test thread libtest writes the
		// test's name to stdout, with no line end, before the test runs.
		let child = std::process::Command::new(std::env::current_exe().unwrap())
			.args(["cp::tests::a_file_another_user_owns_gets_its_attributes_as_it_is", "--exact", "--nocapture", "--test-threads=1"])
			.env(CHILD, dir.path())
			.uid(1000)
			.gid(1000)
			.output();
		let child = match child {
			Ok(child) => child,
			Err(e) => {
				eprintln!("skipped: uid 1000 cannot run the test binary: {e}");
				return;
			},
		};
		let err = String::from_utf8_lossy(&child.stderr);
		let Some(line) = err.lines().find_map(|line| line.strip_prefix("CHILD ")) else {
			panic!("the child printed no answer: {}{err}", String::from_utf8_lossy(&child.stdout));
		};
		if let Some(why) = line.strip_prefix("skipped: ") {
			eprintln!("skipped: {why}");
			return;
		}
		assert_eq!(line, "0 \"\"", "cp --preserve=xattr a b as uid 1000");
		let made = fs::metadata(path("b")).unwrap();
		assert_eq!((made.uid(), made.mode() & 0o7777), (65534, 0o446), "b's owner and mode");
		assert_eq!(fs::read(path("b")).unwrap(), b"A");
		let mut value = [0_u8; 4];
		let name = std::ffi::CString::new(path("b").as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: both strings are NUL-terminated, and `value` is valid for its length.
		let got = unsafe { libc::getxattr(name.as_ptr(), c"user.cp_test".as_ptr(), value.as_mut_ptr().cast(), value.len()) };
		assert_eq!(got, 1, "the attribute on b");
	}

	/// Only a read-only file cp owns is made owner-writable for its extended
	/// attributes: the mode `owned_read_only_mode` gives is `None` for a file
	/// its owner may write and, made as root, for a read-only file another
	/// user owns, which cp leaves as it is. Not as root, the test says that
	/// row is skipped.
	#[test]
	#[cfg(target_os = "linux")]
	fn only_a_read_only_file_cp_owns_is_made_writable_for_its_attributes() {
		use std::os::unix::fs::PermissionsExt as _;

		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		let mode_of = |name: &str, mode: u32, owner: Option<u32>| {
			fs::write(path(name), b"B").unwrap();
			if owner.is_some() {
				std::os::unix::fs::chown(path(name), owner, owner).unwrap();
			}
			fs::set_permissions(path(name), fs::Permissions::from_mode(mode)).unwrap();
			super::owned_read_only_mode(&fs::File::open(path(name)).unwrap()).unwrap()
		};
		assert_eq!(mode_of("own-ro", 0o444, None), Some(0o444), "cp's own read-only file");
		assert_eq!(mode_of("own-rw", 0o644, None), None, "cp's own writable file");
		if !nix::unistd::geteuid().is_root() {
			eprintln!("skipped: only root can make a file another user owns");
			return;
		}
		assert_eq!(mode_of("other-ro", 0o444, Some(65534)), None, "another user's read-only file");
	}

	/// `cp -alvT S D` run again onto its own copy, where every entry of `D` is
	/// already a hard link to `S`'s, leaves `D` as it is and prints nothing, as
	/// GNU 9.4 does (`copy.c`, lines 1758-1761): a FIFO there is not removed
	/// and linked again as a special source onto an existing file would be
	/// (the inodes would not show a removal and a new link to the same file;
	/// the `-v` lines do).
	/// Where a FIFO cannot be hard-linked (gVisor answers `EOPNOTSUPP`), the
	/// test says it is skipped.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_hard_link_tree_copied_again_is_left_as_gnu_leaves_it() {
		use std::os::unix::fs::MetadataExt as _;

		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		fs::create_dir(path("S")).unwrap();
		fs::write(path("S/f"), b"A").unwrap();
		let fifo = std::ffi::CString::new(path("S/p").as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `fifo` is NUL-terminated and outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o640) }, 0, "mkfifo");
		std::os::unix::fs::symlink("f", path("S/l")).unwrap();
		if let Err(error) = fs::hard_link(path("S/p"), path("probe")) {
			eprintln!("skipped: a hard link to a FIFO answers {error} here");
			return;
		}
		fs::remove_file(path("probe")).unwrap();
		let (code, capture) = run_util::<Cp>(&["-alvT", "S", "D"], "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()), "the first copy");
		let inodes = || {
			["D/f", "D/p", "D/l"].map(|name| fs::symlink_metadata(path(name)).unwrap().ino())
		};
		let before = inodes();
		for flags in ["-alvT", "-lPRvT"] {
			let (code, capture) = run_util::<Cp>(&[flags, "S", "D"], "", dir.path());
			assert_eq!((code, capture.out(), capture.err()), (0, String::new(), String::new()), "cp {flags} S D again");
			assert_eq!(inodes(), before, "cp {flags} S D again: the same entries");
		}
		assert_eq!(fs::metadata(path("D/p")).unwrap().ino(), fs::metadata(path("S/p")).unwrap().ino());
	}

	/// An extended attribute that cannot be set under `--preserve=xattr`
	/// fails the copy of a file only once the mode and the times are set, as
	/// GNU records the failure and goes on (`copy.c` 9.4, lines 1660-1701);
	/// a directory gets its times but not its mode, as GNU sets its times
	/// and returns at the failure (lines 3249-3282). The failure is made at
	/// the seam before the owner is set, where the test removes the source's
	/// name, so its attributes cannot be read.
	#[test]
	#[cfg(target_os = "linux")]
	fn an_attribute_that_fails_leaves_the_mode_and_times_set() {
		use std::os::unix::fs::PermissionsExt as _;

		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
		fs::write(path("a"), b"A").unwrap();
		fs::File::options().write(true).open(path("a")).unwrap().set_modified(old).unwrap();
		fs::set_permissions(path("a"), fs::Permissions::from_mode(0o555)).unwrap();
		{
			let source = path("a");
			crate::host::hook_at(path("b"), move || fs::remove_file(&source).unwrap());
		}
		let (code, capture) = run_util::<Cp>(&["--preserve=timestamps,xattr", "a", "b"], "", dir.path());
		assert_eq!(code, 1);
		assert!(capture.err().starts_with("cp: setting attributes for 'b': "), "{:?}", capture.err());
		let made = fs::metadata(path("b")).unwrap();
		assert_eq!(made.permissions().mode() & 0o7777, 0o555 & !crate::host::process_umask(), "b's mode");
		assert_eq!(made.modified().unwrap(), old, "b's times");

		fs::create_dir(path("d")).unwrap();
		fs::File::open(path("d")).unwrap().set_modified(old).unwrap();
		fs::set_permissions(path("d"), fs::Permissions::from_mode(0o555)).unwrap();
		{
			let source = path("d");
			crate::host::hook_at(path("e"), move || fs::remove_dir(&source).unwrap());
		}
		let (code, capture) = run_util::<Cp>(&["-R", "--preserve=mode,timestamps,xattr", "d", "e"], "", dir.path());
		assert_eq!(code, 1);
		assert!(capture.err().starts_with("cp: setting attributes for 'e': "), "{:?}", capture.err());
		let made = fs::metadata(path("e")).unwrap();
		assert_ne!(made.permissions().mode() & 0o7777, 0o555, "e's mode is set past the failure");
		assert_eq!(made.modified().unwrap(), old, "e's times");
	}

	/// Where the extended attributes fail and a later step fails too, both
	/// errors are shown, the attributes' first, as GNU 9.4 shows both
	/// (`copy.c`, lines 768-793 and 1696). The attributes fail as in
	/// `an_attribute_that_fails_leaves_the_mode_and_times_set`; the mode
	/// fails at a test seam (`EIO`).
	#[test]
	#[cfg(target_os = "linux")]
	fn an_attribute_and_a_later_step_that_fail_are_both_shown() {
		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		fs::write(path("a"), b"A").unwrap();
		{
			let source = path("a");
			crate::host::hook_at(path("b"), move || fs::remove_file(&source).unwrap());
		}
		crate::host::fault_at(path("b"), libc::EIO);
		let (code, capture) = run_util::<Cp>(&["--preserve=mode,xattr", "a", "b"], "", dir.path());
		let err = capture.err();
		let lines: Vec<&str> = err.lines().collect();
		assert_eq!((code, lines.len()), (1, 2), "{err:?}");
		assert!(lines[0].starts_with("cp: setting attributes for 'b': "), "{err:?}");
		assert!(lines[1].starts_with("cp: preserving permissions for 'b': "), "{err:?}");
	}

	/// `cp -p` from a FIFO whose writer removes its name once cp has read it
	/// gives the new file the FIFO's own mode (not less the umask) and times,
	/// from what cp read of it, as GNU's `copy_reg` does from its `fstat`.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_fifo_whose_name_is_gone_keeps_its_mode_and_times_under_p() {
		use std::{
			io::Write as _,
			os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
		};

		use crate::host::{Host, Utility as _};

		let dir = tempdir().unwrap();
		let path = |name: &str| dir.path().join(name);
		let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
		let fifo = std::ffi::CString::new(path("a").as_os_str().as_encoded_bytes()).unwrap();
		// SAFETY: `fifo` is NUL-terminated and outlives the call.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
		fs::set_permissions(path("a"), fs::Permissions::from_mode(0o666)).unwrap();
		// Held read-write, so cp's open does not wait; written before cp reads.
		let mut writer = fs::OpenOptions::new()
			.read(true)
			.write(true)
			.custom_flags(libc::O_NONBLOCK)
			.open(path("a"))
			.unwrap();
		writer.write_all(b"N").unwrap();
		writer.set_modified(old).unwrap();
		let cwd = dir.path().to_owned();
		let copy = std::thread::spawn(move || {
			let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
			let code = <Cp as clap::Parser>::try_parse_from(["cp", "-p", "a", "b"]).unwrap().run(&mut host);
			(code, capture.err())
		});
		while fs::read(path("b")).ok().as_deref() != Some(b"N") {
			assert!(!copy.is_finished(), "cp ended before it wrote the data");
			std::thread::yield_now();
		}
		fs::remove_file(path("a")).unwrap();
		drop(writer);
		assert_eq!(copy.join().unwrap(), (0, String::new()));
		let made = fs::metadata(path("b")).unwrap();
		assert_eq!(format!("{:o}", made.permissions().mode() & 0o7777), "666", "b's mode");
		assert_eq!(made.modified().unwrap(), old, "b's times");
	}

	/// A special file `-R` makes anew (a FIFO, without `--copy-contents`)
	/// onto a link to nothing removes the link and makes the FIFO, as GNU 9.4
	/// does; with `--copy-contents`, which writes the FIFO's data, the link is
	/// refused as GNU refuses it. GNU's answers, measured as uid 1000 with
	/// umask 022, are the rows': the FIFO of mode 662 is made 640 under `-R`
	/// (the umask applies) and 662 under `-a`. Where cp opens the FIFO to read
	/// it, a writer the test opens then ends it, so the row fails, not hangs.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_special_file_made_anew_replaces_a_link_to_nothing_as_gnu_does() {
		use std::os::unix::fs::{FileTypeExt as _, OpenOptionsExt as _, PermissionsExt as _};

		let umask = crate::host::process_umask();
		let rows: [(&[&str], i32, &str, &str); 4] = [
			(&["-R"], 0, "", ""),
			(&["-Rv"], 0, "removed 'b'\n'p' -> 'b'\n", ""),
			(&["-a"], 0, "", ""),
			(&["-R", "--copy-contents"], 1, "", "cp: not writing through dangling symlink 'b'\n"),
		];
		for (flags, want_code, want_out, want_err) in rows {
			let dir = tempdir().unwrap();
			let path = |name: &str| dir.path().join(name);
			let fifo = std::ffi::CString::new(path("p").as_os_str().as_encoded_bytes()).unwrap();
			// SAFETY: `fifo` is NUL-terminated and outlives the call.
			assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");
			fs::set_permissions(path("p"), fs::Permissions::from_mode(0o662)).unwrap();
			std::os::unix::fs::symlink("none", path("b")).unwrap();
			let mut args: Vec<String> = flags.iter().map(|flag| (*flag).to_owned()).collect();
			args.extend(["p".to_owned(), "b".to_owned()]);
			let case = format!("cp {} p b", args.join(" "));
			let cwd = dir.path().to_owned();
			let copy = std::thread::spawn(move || {
				let args: Vec<&str> = args.iter().map(String::as_str).collect();
				let (code, capture) = run_util::<Cp>(&args, "", cwd);
				(code, capture.out(), capture.err())
			});
			while !copy.is_finished() {
				// cp reading the FIFO: a writer that opens and closes ends it.
				if let Ok(writer) = fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(path("p")) {
					drop(writer);
				}
				std::thread::sleep(std::time::Duration::from_millis(10));
			}
			assert_eq!(copy.join().unwrap(), (want_code, want_out.to_owned(), want_err.to_owned()), "{case}");
			let made = fs::symlink_metadata(path("b")).unwrap();
			if want_code == 0 {
				assert!(made.file_type().is_fifo(), "{case}: b is not a FIFO");
				let mode = if flags == ["-a"] { 0o662 } else { 0o662 & !umask };
				assert_eq!(made.permissions().mode() & 0o7777, mode, "{case}: b's mode");
			} else {
				assert!(made.is_symlink(), "{case}: b is not the link");
			}
			assert!(!path("none").exists(), "{case}: the link's target was made");
		}
	}

	/// The owner, mode, times and extended attributes go to the file the copy
	/// wrote, through its descriptor, as GNU's `fchown`, `fchmod`, `futimens`
	/// and `attr_copy_fd` set them. At the seam, just before the owner is set,
	/// the test moves the written name aside and puts something else in its
	/// place: a link to another file, and, as root copying uid 1000's file, a
	/// file of root's own, the one a by-name `lchown` would hand to uid 1000.
	/// Neither changes. The rows: a new file, a file made through a link to
	/// nothing (POSIXLY_CORRECT), `--attributes-only` onto an existing file,
	/// `--reflink=always` where the filesystem clones (elsewhere that row
	/// says it is skipped), `--preserve=xattr` from a read-only source (its
	/// attributes set before its read-only mode, as GNU sets them, so it is
	/// never made writable for them), as root `--attributes-only
	/// --preserve=xattr` onto a read-only file (root needs no write bit for
	/// them; the file keeps its mode 440),
	/// and a FIFO whose name its writer removes, under
	/// `--preserve=ownership`, past which cp sets the owner and the final
	/// mode from what it read of the FIFO, as GNU does (the seam is then just
	/// before them).
	#[test]
	#[cfg(target_os = "linux")]
	fn the_attributes_go_to_the_written_file_not_a_link_put_in_its_place() {
		use std::{
			io::Write as _,
			os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
			sync::{
				Arc,
				atomic::{AtomicBool, Ordering},
			},
		};

		use crate::host::{Host, Utility as _};

		let xattr = |path: &std::path::Path| -> Option<Vec<u8>> {
			let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
			let mut value = [0_u8; 16];
			// SAFETY: both strings are NUL-terminated, and `value` is valid for its length.
			let got = unsafe {
				libc::lgetxattr(path.as_ptr(), c"user.cp_test".as_ptr(), value.as_mut_ptr().cast(), value.len())
			};
			usize::try_from(got).ok().map(|len| value[..len].to_vec())
		};
		// SAFETY: `geteuid` has no preconditions.
		let as_root = unsafe { libc::geteuid() } == 0;
		let umask = crate::host::process_umask();
		let old = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
		// (flags, what is at `b`, the source: a file of mode 640 or 440, or a
		// FIFO of mode 640 whose name is gone when cp has read it)
		let rows: [(&[&str], &str, &str); 11] = [
			(&["-p"], "new", "640"),
			(&["--preserve=ownership"], "new", "640"),
			(&["--preserve=mode"], "new", "640"),
			(&["--preserve=timestamps"], "new", "640"),
			(&["--preserve=xattr"], "new", "640"),
			(&["--preserve=xattr"], "new", "440"),
			(&["-p"], "through", "640"),
			(&["--attributes-only", "-p"], "existing", "640"),
			(&["--attributes-only", "--preserve=xattr"], "existing-ro", "640"),
			(&["--reflink=always", "-p"], "new", "640"),
			(&["--preserve=ownership"], "new", "fifo"),
		];
		let swaps: &[&str] = if as_root { &["link", "file"] } else { &["link"] };
		for (flags, at, kind) in rows {
			for &swap in swaps {
				let dir = tempdir().unwrap();
				let source = dir.path().join("a");
				let source_mode = if kind == "440" { 0o440 } else { 0o640 };
				let mut writer = None;
				if kind == "fifo" {
					let name = std::ffi::CString::new(source.as_os_str().as_encoded_bytes()).unwrap();
					// SAFETY: `name` is NUL-terminated and outlives the call.
					assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
					// Held read-write, so cp's open does not wait; written before cp reads.
					let mut fifo = fs::OpenOptions::new()
						.read(true)
						.write(true)
						.custom_flags(libc::O_NONBLOCK)
						.open(&source)
						.unwrap();
					fifo.write_all(b"A").unwrap();
					writer = Some(fifo);
				} else {
					fs::write(&source, b"A").unwrap();
					fs::File::options().write(true).open(&source).unwrap().set_modified(old).unwrap();
				}
				if as_root {
					std::os::unix::fs::chown(&source, Some(1000), Some(1000)).unwrap();
				}
				let case = format!("cp {} a b from a {kind} source, b {at}, {swap} put in its place", flags.join(" "));
				if flags.contains(&"--preserve=xattr") {
					let name = std::ffi::CString::new(source.as_os_str().as_encoded_bytes()).unwrap();
					// SAFETY: both strings are NUL-terminated, and the value is valid for its length.
					let set = unsafe {
						libc::setxattr(name.as_ptr(), c"user.cp_test".as_ptr(), b"v".as_ptr().cast(), 1, 0)
					};
					if set != 0 {
						eprintln!("{case}: skipped, no user extended attributes here");
						continue;
					}
				}
				// Set after the attribute: a read-only file takes none from its owner.
				fs::set_permissions(&source, fs::Permissions::from_mode(source_mode)).unwrap();
				let victim = dir.path().join("victim");
				fs::write(&victim, b"V").unwrap();
				fs::set_permissions(&victim, fs::Permissions::from_mode(0o604)).unwrap();
				let before = fs::metadata(&victim).unwrap();
				// The name the copy writes, as cp resolves it: `b`, or the
				// file the link at `b` leads to.
				let written = match at {
					"through" => {
						std::os::unix::fs::symlink("none", dir.path().join("b")).unwrap();
						fs::canonicalize(dir.path()).unwrap().join("none")
					},
					"existing" => {
						fs::write(dir.path().join("b"), b"OLD").unwrap();
						dir.path().join("b")
					},
					"existing-ro" => {
						// A read-only file opens for writing only as root.
						if !as_root {
							eprintln!("{case}: skipped, it needs root");
							continue;
						}
						fs::write(dir.path().join("b"), b"OLD").unwrap();
						fs::set_permissions(dir.path().join("b"), fs::Permissions::from_mode(0o440)).unwrap();
						dir.path().join("b")
					},
					_ => dir.path().join("b"),
				};
				let moved = written.with_extension("real");
				let swapped = Arc::new(AtomicBool::new(false));
				{
					let (name, moved, victim, swapped) = (written.clone(), moved.clone(), victim.clone(), Arc::clone(&swapped));
					crate::host::hook_at(written.clone(), move || {
						fs::rename(&name, &moved).unwrap();
						if swap == "link" {
							std::os::unix::fs::symlink(&victim, &name).unwrap();
						} else {
							fs::write(&name, b"X").unwrap();
							fs::set_permissions(&name, fs::Permissions::from_mode(0o600)).unwrap();
						}
						swapped.store(true, Ordering::SeqCst);
					});
				}
				let cwd = dir.path().to_owned();
				let copy = std::thread::spawn(move || {
					let (mut host, capture) = Host::for_test(Cp::NAME, "", &cwd);
					if at == "through" {
						host.set_test_var("POSIXLY_CORRECT", "1");
					}
					let mut args = vec!["cp"];
					args.extend(flags);
					args.extend(["a", "b"]);
					let code = <Cp as clap::Parser>::try_parse_from(args).unwrap().run(&mut host);
					(code, capture.err())
				});
				if let Some(fifo) = writer {
					// cp has read `A` once it made `b`; the name goes, then the end.
					while !written.exists() && !moved.exists() {
						assert!(!copy.is_finished(), "{case}: cp ended before it made the file");
						std::thread::yield_now();
					}
					fs::remove_file(&source).unwrap();
					drop(fifo);
				}
				let (code, err) = copy.join().unwrap();
				if flags.contains(&"--reflink=always") && err.starts_with("cp: failed to clone") {
					eprintln!("{case}: skipped, this filesystem does not clone ({})", err.trim_end());
					continue;
				}
				assert_eq!((code, err.as_str()), (0, ""), "{case}");
				assert!(swapped.load(Ordering::SeqCst), "{case}: the seam did not run; the test saw nothing");
				// What was put in the name's place keeps its mode, owner,
				// times, data and attributes.
				let (target, kept) = if swap == "link" { (victim.clone(), b"V".to_vec()) } else { (written.clone(), b"X".to_vec()) };
				let after = fs::symlink_metadata(&target).unwrap();
				let want = if swap == "link" {
					(before.mode() & 0o7777, before.uid(), before.gid(), before.mtime())
				} else {
					(0o600, 0, 0, after.mtime())
				};
				assert_eq!(
					(format!("{:o}", after.mode() & 0o7777), after.uid(), after.gid(), after.mtime(), fs::read(&target).unwrap(), xattr(&target)),
					(format!("{:o}", want.0), want.1, want.2, want.3, kept, None),
					"{case}: what was put in its place changed"
				);
				if swap == "file" {
					assert_ne!(after.mtime(), 1_000_000_000, "{case}: what was put in its place got the source's times");
				}
				// The written file gets them.
				let real = fs::metadata(&moved).unwrap();
				let data: &[u8] = if at.starts_with("existing") { b"OLD" } else { b"A" };
				assert_eq!(fs::read(&moved).unwrap(), data, "{case}");
				let preserved_mode = flags.iter().any(|flag| matches!(*flag, "-p" | "--preserve=mode"));
				if at == "existing-ro" && !preserved_mode {
					// Root sets its attributes with no change of its mode.
					assert_eq!(format!("{:o}", real.mode() & 0o7777), "440", "{case}: the mode of the written file");
				} else if at != "existing" || preserved_mode {
					let mode = if preserved_mode { source_mode } else { source_mode & !umask };
					assert_eq!(format!("{:o}", real.mode() & 0o7777), format!("{mode:o}"), "{case}: the mode of the written file");
				}
				if flags.iter().any(|flag| matches!(*flag, "-p" | "--preserve=timestamps")) {
					assert_eq!(real.mtime(), 1_000_000_000, "{case}: the times of the written file");
				}
				if as_root && flags.iter().any(|flag| matches!(*flag, "-p" | "--preserve=ownership")) {
					assert_eq!((real.uid(), real.gid()), (1000, 1000), "{case}: the owner of the written file");
				}
				if flags.contains(&"--preserve=xattr") {
					assert_eq!(xattr(&moved), Some(b"v".to_vec()), "{case}: the attributes of the written file");
				}
			}
		}
	}

	/// The owner is set before the mode, as GNU's `copy_reg` sets them, also
	/// where the files are a provider's: a provider over the host's files that
	/// records each `chown` and `set_permissions` it is asked for sees the
	/// owner first, with `-p` and with `--preserve=ownership`. Its files report
	/// another owner, so cp has one to set; it records the change and makes
	/// none.
	#[test]
	#[cfg(unix)]
	fn the_owner_is_set_before_the_mode_through_a_provider() {
		use std::{
			io::{self, SeekFrom},
			os::unix::fs::PermissionsExt as _,
			path::{Path, PathBuf},
			sync::Arc,
		};

		use parking_lot::Mutex;
		use pi_vfs::{FileSystem, FileTime, Metadata, OpenOptions, Permissions, ReadDir, SymlinkKind};

		use crate::host::{Host, Utility as _};

		/// A host file served as a provider's, reporting another owner.
		#[derive(Debug)]
		struct Handle(pi_vfs::File);

		#[async_trait::async_trait]
		impl pi_vfs::FileHandle for Handle {
			async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
				self.0.read_async(buf).await
			}

			async fn write(&self, buf: &[u8]) -> io::Result<usize> {
				self.0.write_async(buf).await
			}

			async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
				self.0.seek_async(pos).await
			}

			async fn metadata(&self) -> io::Result<Metadata> {
				let metadata = self.0.metadata_async().await?;
				let (uid, gid) = metadata.uid().zip(metadata.gid()).unwrap_or_default();
				Ok(metadata.with_owner(uid + 1, gid))
			}

			async fn set_len(&self, size: u64) -> io::Result<()> {
				self.0.set_len_async(size).await
			}
		}

		/// The host's files, recording the owner and mode changes.
		#[derive(Debug)]
		struct Recorder {
			inner: pi_vfs::Fs,
			calls: Arc<Mutex<Vec<String>>>,
		}

		#[async_trait::async_trait]
		impl FileSystem for Recorder {
			async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<pi_vfs::File> {
				Ok(pi_vfs::File::from_handle(Handle(self.inner.open_with(path, options).await?)))
			}

			async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
				self.inner.metadata(path).await
			}

			async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
				self.inner.symlink_metadata(path).await
			}

			async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
				self.inner.read_dir(path).await
			}

			async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
				self.inner.read_link(path).await
			}

			async fn remove_file(&self, path: &Path) -> io::Result<()> {
				self.inner.remove_file(path).await
			}

			async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
				self.inner.rename(from, to).await
			}

			async fn symlink(&self, target: &Path, link: &Path, kind: SymlinkKind) -> io::Result<()> {
				self.inner.symlink_with(target, link, kind).await
			}

			async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
				self.calls.lock().push(format!("chmod {:o}", permissions.mode() & 0o7777));
				self.inner.set_permissions(path, permissions).await
			}

			async fn set_times(
				&self,
				path: &Path,
				accessed: FileTime,
				modified: FileTime,
				follow: bool,
			) -> io::Result<()> {
				self.inner.set_times(path, accessed, modified, follow).await
			}

			async fn chown(&self, _path: &Path, uid: Option<u32>, gid: Option<u32>, _follow: bool) -> io::Result<()> {
				self.calls.lock().push(format!("chown {uid:?} {gid:?}"));
				Ok(())
			}
		}

		let umask = crate::host::process_umask();
		// SAFETY: `geteuid` and `getegid` have no preconditions.
		let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
		for (flag, mode) in [("-p", 0o640), ("--preserve=ownership", 0o640 & !umask)] {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			fs::set_permissions(dir.path().join("a"), fs::Permissions::from_mode(0o640)).unwrap();
			let calls = Arc::new(Mutex::new(Vec::new()));
			let recorder = Recorder { inner: pi_vfs::Fs::native(), calls: Arc::clone(&calls) };
			let (mut host, capture) = Host::for_test(Cp::NAME, "", dir.path());
			host.set_test_fs(&pi_vfs::Fs::new(Arc::new(recorder)));
			let code = <Cp as clap::Parser>::try_parse_from(["cp", flag, "a", "b"]).unwrap().run(&mut host);
			assert_eq!((code, capture.err().as_str()), (0, ""), "cp {flag} a b");
			assert_eq!(
				*calls.lock(),
				[format!("chown Some({uid}) Some({gid})"), format!("chmod {mode:o}")],
				"cp {flag} a b: the owner first, then the mode"
			);
			assert_eq!(fs::read(dir.path().join("b")).unwrap(), b"A", "cp {flag} a b");
		}
		// Past a failure to set the extended attributes (this provider has
		// none), a provider's file the copy wrote still gets its mode, as
		// GNU's `copy_reg` sets it.
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("a"), b"A").unwrap();
		fs::set_permissions(dir.path().join("a"), fs::Permissions::from_mode(0o640)).unwrap();
		let calls = Arc::new(Mutex::new(Vec::new()));
		let recorder = Recorder { inner: pi_vfs::Fs::native(), calls: Arc::clone(&calls) };
		let (mut host, capture) = Host::for_test(Cp::NAME, "", dir.path());
		host.set_test_fs(&pi_vfs::Fs::new(Arc::new(recorder)));
		let code = <Cp as clap::Parser>::try_parse_from(["cp", "--preserve=mode,xattr", "a", "b"]).unwrap().run(&mut host);
		assert_eq!(code, 1, "cp --preserve=mode,xattr a b");
		assert!(capture.err().starts_with("cp: setting attributes for 'b': "), "{:?}", capture.err());
		assert!(calls.lock().contains(&"chmod 640".to_owned()), "the mode past the attributes' failure: {:?}", calls.lock());
	}

	/// `--attributes-only` refuses a non-directory over a directory with
	/// GNU 9.7's message (9.4's leaves out the source): `cp -T --attributes-only a d`,
	/// and in a tree (`-RT --attributes-only S D`) from a file and from a link
	/// at `S/l`, with `D/l` a directory. The status is 1 and the directory is
	/// kept.
	#[test]
	#[cfg(unix)]
	fn attributes_only_refuses_a_non_directory_over_a_directory() {
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("a"), b"A").unwrap();
		fs::create_dir(dir.path().join("d")).unwrap();
		fs::write(dir.path().join("d/x"), b"X").unwrap();
		let (code, capture) = run_util::<Cp>(&["-T", "--attributes-only", "a", "d"], "", dir.path());
		assert_eq!(
			(code, capture.err()),
			(1, "cp: cannot overwrite directory 'd' with non-directory 'a'\n".to_owned()),
			"cp -T --attributes-only a d"
		);
		assert_eq!(fs::read(dir.path().join("d/x")).unwrap(), b"X", "d is not kept");
		for link in [false, true] {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			fs::create_dir(dir.path().join("S")).unwrap();
			if link {
				std::os::unix::fs::symlink("../a", dir.path().join("S/l")).unwrap();
			} else {
				fs::write(dir.path().join("S/l"), b"L").unwrap();
			}
			fs::create_dir_all(dir.path().join("D/l")).unwrap();
			fs::write(dir.path().join("D/l/x"), b"X").unwrap();
			let (code, capture) = run_util::<Cp>(&["-RT", "--attributes-only", "S", "D"], "", dir.path());
			let case = format!("cp -RT --attributes-only S D, S/l a {}", if link { "link" } else { "file" });
			assert_eq!(
				(code, capture.err()),
				(1, "cp: cannot overwrite directory 'D/l' with non-directory 'S/l'\n".to_owned()),
				"{case}"
			);
			assert_eq!(fs::read(dir.path().join("D/l/x")).unwrap(), b"X", "{case}: D/l is not kept");
		}
	}

	/// A link copied onto a directory under `-f` with a backup: GNU 9.7's
	/// `force_symlinkat` renames its new link over the name, which the
	/// directory refuses, so `cp -T -P -f -b l b` (also with `-R` and `-d`)
	/// says `cannot create symbolic link 'b': Is a directory`, exits 1 and
	/// keeps the directory.
	#[test]
	#[cfg(unix)]
	fn a_link_forced_onto_a_directory_says_is_a_directory() {
		for flag in ["-P", "-R", "-d"] {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			fs::create_dir(dir.path().join("b")).unwrap();
			fs::write(dir.path().join("b/x"), b"X").unwrap();
			let (code, capture) = run_util::<Cp>(&["-T", flag, "-f", "-b", "l", "b"], "", dir.path());
			let case = format!("cp -T {flag} -f -b l b, b a directory");
			assert_eq!(
				(code, capture.err()),
				(1, "cp: cannot create symbolic link 'b': Is a directory\n".to_owned()),
				"{case}"
			);
			assert_eq!(fs::read(dir.path().join("b/x")).unwrap(), b"X", "{case}: b is not kept");
		}
	}

	/// Under `--attributes-only`, `-n` and `-i` decide first, as GNU 9.7 does
	/// (`copy.c`, lines 2432-2441) and GNU 9.4 answers: what they keep is
	/// kept, with no refusal and no link made over it. `cp -a -n
	/// --attributes-only -T S D`, where `S/h1` and `S/h2` are two names of one
	/// file and `D/h1`, `D/h2` hold other data, exits 0 and keeps both; `-i`
	/// answered no asks for each and keeps both. `cp -n -T --attributes-only a
	/// d`, `d` a directory, exits 0 and says nothing; `cp -n --attributes-only
	/// -p a b` leaves `b`'s mode.
	#[test]
	#[cfg(unix)]
	fn attributes_only_keeps_what_n_and_i_keep() {
		use std::os::unix::fs::PermissionsExt as _;

		for (flag, stdin, code, err) in [
			("-n", "", 0, String::new()),
			("-i", "n\nn\n", 1, "cp: overwrite 'D/h1'? cp: overwrite 'D/h2'? ".to_owned()),
		] {
			let dir = tempdir().unwrap();
			fs::create_dir(dir.path().join("S")).unwrap();
			fs::write(dir.path().join("S/h1"), b"S").unwrap();
			fs::hard_link(dir.path().join("S/h1"), dir.path().join("S/h2")).unwrap();
			fs::create_dir(dir.path().join("D")).unwrap();
			fs::write(dir.path().join("D/h1"), b"D1").unwrap();
			fs::write(dir.path().join("D/h2"), b"D2").unwrap();
			let (got, capture) = run_util::<Cp>(&["-a", flag, "--attributes-only", "-T", "S", "D"], stdin, dir.path());
			let case = format!("cp -a {flag} --attributes-only -T S D");
			// The order of the two prompts follows the directory's order.
			let mut prompts: Vec<_> = capture.err().split_inclusive("? ").map(str::to_owned).collect();
			prompts.sort();
			let mut want: Vec<_> = err.split_inclusive("? ").map(str::to_owned).collect();
			want.sort();
			assert_eq!((got, prompts), (code, want), "{case}");
			assert_eq!(fs::read(dir.path().join("D/h1")).unwrap(), b"D1", "{case}: D/h1");
			assert_eq!(fs::read(dir.path().join("D/h2")).unwrap(), b"D2", "{case}: D/h2");
		}
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("a"), b"A").unwrap();
		fs::set_permissions(dir.path().join("a"), fs::Permissions::from_mode(0o640)).unwrap();
		fs::create_dir(dir.path().join("d")).unwrap();
		let (got, capture) = run_util::<Cp>(&["-n", "-T", "--attributes-only", "a", "d"], "", dir.path());
		assert_eq!((got, capture.err()), (0, String::new()), "cp -n -T --attributes-only a d, d a directory");
		fs::write(dir.path().join("b"), b"B").unwrap();
		fs::set_permissions(dir.path().join("b"), fs::Permissions::from_mode(0o604)).unwrap();
		let (got, capture) = run_util::<Cp>(&["-n", "--attributes-only", "-p", "a", "b"], "", dir.path());
		assert_eq!((got, capture.err()), (0, String::new()), "cp -n --attributes-only -p a b");
		assert_eq!(
			format!("{:o}", fs::metadata(dir.path().join("b")).unwrap().permissions().mode() & 0o7777),
			"604",
			"cp -n --attributes-only -p a b: b's mode"
		);
	}

	/// A second name that `--preserve=links` replaces, as GNU's `force_linkat`
	/// does through a short temporary name: the two names are 240 bytes long,
	/// so whichever the directory lists second, a name built from it would not
	/// fit, and `-v` prints `removed` after the copy's line for a file, as GNU
	/// 9.4 and 9.7 do.
	#[test]
	#[cfg(unix)]
	fn a_second_name_is_replaced_and_reported_as_gnu_does() {
		use std::os::unix::fs::MetadataExt as _;

		let (first, long) = ("g".repeat(240), "h".repeat(240));
		let dir = tempdir().unwrap();
		fs::create_dir(dir.path().join("S")).unwrap();
		fs::write(dir.path().join("S").join(&first), b"H").unwrap();
		fs::hard_link(dir.path().join("S").join(&first), dir.path().join("S").join(&long)).unwrap();
		fs::create_dir(dir.path().join("D")).unwrap();
		// The earlier copy holds two unrelated files at those names.
		fs::write(dir.path().join("D").join(&first), b"1").unwrap();
		fs::write(dir.path().join("D").join(&long), b"2").unwrap();
		let (got, capture) = run_util::<Cp>(&["-aTfv", "S", "D"], "", dir.path());
		let case = "cp -aTfv S D, two names of 240 bytes";
		assert_eq!((got, capture.err()), (0, String::new()), "{case}");
		let ino = |name: &str| fs::symlink_metadata(dir.path().join("D").join(name)).unwrap().ino();
		assert_eq!(ino(&first), ino(&long), "{case}: one file");
		let out = capture.out();
		let lines: Vec<_> = out.lines().collect();
		// Whichever name comes second in the directory's order is the one replaced.
		let second = lines.iter().rposition(|line| line.contains(" -> ")).unwrap();
		assert_eq!(
			lines.get(second + 1).copied(),
			Some(lines[second].rsplit(" -> ").next().map(|dest| format!("removed {dest}")).unwrap().as_str()),
			"{case}: {out}"
		);
	}

	/// `cp -p a b`, with `b` a link to an existing file `c`: the copy writes
	/// `c`, and `c` gets the mode and times, as GNU 9.4 and 9.7 give them; the
	/// link itself keeps its own times.
	#[test]
	#[cfg(unix)]
	fn a_copy_through_a_link_to_a_file_sets_that_file() {
		use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

		let dir = tempdir().unwrap();
		let a = dir.path().join("a");
		fs::write(&a, b"A").unwrap();
		fs::set_permissions(&a, fs::Permissions::from_mode(0o640)).unwrap();
		fs::File::options()
			.write(true)
			.open(&a)
			.unwrap()
			.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000))
			.unwrap();
		fs::write(dir.path().join("c"), b"C").unwrap();
		fs::set_permissions(dir.path().join("c"), fs::Permissions::from_mode(0o604)).unwrap();
		std::os::unix::fs::symlink("c", dir.path().join("b")).unwrap();
		let link_before = fs::symlink_metadata(dir.path().join("b")).unwrap().mtime();
		let (code, capture) = run_util::<Cp>(&["-p", "a", "b"], "", dir.path());
		assert_eq!((code, capture.err()), (0, String::new()), "cp -p a b, b a link to c");
		let c = fs::metadata(dir.path().join("c")).unwrap();
		assert_eq!(
			(format!("{:o}", c.mode() & 0o7777), c.mtime(), fs::read(dir.path().join("c")).unwrap()),
			("640".to_owned(), 1_000_000_000, b"A".to_vec()),
			"cp -p a b: c's mode, times and data"
		);
		let link = fs::symlink_metadata(dir.path().join("b")).unwrap();
		assert!(link.is_symlink(), "cp -p a b: b is still a link");
		assert_eq!(link.mtime(), link_before, "cp -p a b: the link's own times");
	}

	/// A tree with two names of one file and two names of one link, copied
	/// with `-a` onto its own earlier copy, exits 0 as GNU 9.4 and 9.7 do,
	/// with `-f`, without it and with `--remove-destination`: the second name
	/// is made another name of the first again (GNU's `force_linkat`).
	#[test]
	#[cfg(unix)]
	fn a_tree_with_hard_links_copies_again_onto_its_copy() {
		use std::os::unix::fs::MetadataExt as _;

		for flags in [&["-aT"][..], &["-aTf"], &["-aT", "--remove-destination"]] {
			let dir = tempdir().unwrap();
			let s = dir.path().join("S");
			fs::create_dir(&s).unwrap();
			fs::write(s.join("h1"), b"H").unwrap();
			fs::hard_link(s.join("h1"), s.join("h2")).unwrap();
			std::os::unix::fs::symlink("h1", s.join("sl1")).unwrap();
			// A second name of the link itself (`link(2)` does not follow it).
			let (from, to) = (
				std::ffi::CString::new(s.join("sl1").as_os_str().as_encoded_bytes()).unwrap(),
				std::ffi::CString::new(s.join("sl2").as_os_str().as_encoded_bytes()).unwrap(),
			);
			// SAFETY: both paths are NUL-terminated and outlive the call.
			assert_eq!(unsafe { libc::linkat(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), 0) }, 0);
			let (code, capture) = run_util::<Cp>(&["-aT", "S", "D"], "", dir.path());
			assert_eq!((code, capture.err()), (0, String::new()), "the first cp -aT S D");
			let mut args = flags.to_vec();
			args.extend(["S", "D"]);
			let (code, capture) = run_util::<Cp>(&args, "", dir.path());
			let case = format!("cp {} S D onto its copy", args[..args.len() - 2].join(" "));
			assert_eq!((code, capture.err()), (0, String::new()), "{case}");
			let ino = |name: &str| fs::symlink_metadata(dir.path().join("D").join(name)).unwrap().ino();
			assert_eq!(ino("h1"), ino("h2"), "{case}: D/h1 and D/h2");
			assert_eq!(ino("sl1"), ino("sl2"), "{case}: D/sl1 and D/sl2");
			assert_eq!(fs::read(dir.path().join("D/h2")).unwrap(), b"H", "{case}");
		}
	}

	/// A new file made where a link was (the link backed up, or removed) gets
	/// a new file's final mode, as GNU 9.4 and 9.7 give it: the source's less
	/// the umask, with `--preserve=ownership` too, where the group and other
	/// bits left out at the open must come back.
	#[test]
	#[cfg(unix)]
	fn a_new_file_where_a_link_was_gets_a_new_files_mode() {
		use std::os::unix::fs::PermissionsExt as _;

		let umask = crate::host::process_umask();
		let rows: [(&[&str], &str, u32); 5] = [
			(&["-b", "--preserve=ownership"], "a", 0o640),
			(&["-b", "--preserve=ownership"], "/dev/null", 0o666),
			(&["--remove-destination", "--preserve=ownership"], "a", 0o640),
			(&["-P", "--preserve=ownership"], "/dev/null", 0o666),
			(&["-b"], "a", 0o640),
		];
		for (flags, source, mode) in rows {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			fs::set_permissions(dir.path().join("a"), fs::Permissions::from_mode(0o640)).unwrap();
			fs::write(dir.path().join("c"), b"C").unwrap();
			std::os::unix::fs::symlink("c", dir.path().join("b")).unwrap();
			let mut args = flags.to_vec();
			args.extend([source, "b"]);
			let (code, capture) = run_util::<Cp>(&args, "", dir.path());
			let case = format!("cp {}, b a link to c", args.join(" "));
			assert_eq!((code, capture.err()), (0, String::new()), "{case}");
			let made = fs::symlink_metadata(dir.path().join("b")).unwrap();
			assert!(made.is_file(), "{case}: b is not a new file");
			assert_eq!(
				format!("{:o}", made.permissions().mode() & 0o7777),
				format!("{:o}", mode & !umask),
				"{case}: the mode of the new b"
			);
			assert_eq!(fs::read(dir.path().join("c")).unwrap(), b"C", "{case}: c changed");
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

	/// `cp --reflink=always a b`, where `b` has a second name `c`, clones
	/// into the file `b` names, as GNU cp clones into the file it opened:
	/// where the filesystem clones, both names read `a` afterwards, stay one
	/// file, and the status is 0, from a source shorter than `b` (ending
	/// inside a block or at a block's end) and from a longer one. Where it
	/// cannot clone, the clone fails with the system's answer and both names
	/// keep `b`'s data (GNU has truncated it). No temporary file is left.
	#[test]
	#[cfg(target_os = "linux")]
	fn a_forced_clone_onto_a_file_with_two_names_reaches_both() {
		use std::os::unix::fs::MetadataExt as _;

		const BLOCK: usize = 4096;

		let probe = tempdir().unwrap();
		fs::write(probe.path().join("x"), b"x").unwrap();
		let clones = pi_iso::cow::clone_open(
			&fs::File::open(probe.path().join("x")).unwrap(),
			&fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(probe.path().join("y"))
				.unwrap(),
		);
		for (src_len, dst_len) in [(3, 5), (BLOCK + 5, 2 * BLOCK), (BLOCK, 2 * BLOCK), (2 * BLOCK + 7, 5)] {
			let case = format!("{src_len} bytes onto {dst_len}");
			let (new, old) = (vec![b'A'; src_len], vec![b'B'; dst_len]);
			let dir = tempdir().unwrap();
			let path = |name: &str| dir.path().join(name);
			fs::write(path("a"), &new).unwrap();
			fs::write(path("b"), &old).unwrap();
			fs::hard_link(path("b"), path("c")).unwrap();
			let (code, capture) = run_util::<Cp>(&["--reflink=always", "a", "b"], "", dir.path());
			let data = match &clones {
				Ok(()) => {
					assert_eq!((code, capture.err()), (0, String::new()), "{case}");
					&new
				},
				Err(error) => {
					let message = format!("cp: failed to clone 'b' from 'a': {}\n", crate::host::strip_errno(error));
					assert_eq!((code, capture.err()), (1, message), "{case}");
					&old
				},
			};
			for name in ["b", "c"] {
				assert!(fs::read(path(name)).unwrap() == *data, "{case}: {name} holds what is due");
			}
			assert_eq!(fs::metadata(path("b")).unwrap().ino(), fs::metadata(path("c")).unwrap().ino(), "{case}: one file");
			let mut names: Vec<_> = fs::read_dir(dir.path())
				.unwrap()
				.map(|entry| entry.unwrap().file_name())
				.collect();
			names.sort();
			assert_eq!(names, ["a", "b", "c"], "{case}: no temporary file is left");
		}
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

	/// `cp -r` copies a tree deeper than the open-file limit, as GNU cp does:
	/// the walk reads each directory whole before it goes below, so it holds
	/// no descriptor per level (100 levels under a limit of 32, where cp's
	/// walk failed with "Too many open files" while it still held a descriptor
	/// per level). In a process of its own, since the limit belongs to the
	/// whole process.
	#[cfg(unix)]
	#[test]
	fn copies_a_tree_deeper_than_the_descriptor_limit() {
		use crate::deep_tree::{RemoveTree, assert_file_chain, file_chain, limit_descriptors};

		if !crate::own_process::own_process() {
			return;
		}
		let fixture = crate::deep_tree::tempdir();
		let _trees = [RemoveTree(fixture.path().join("src")), RemoveTree(fixture.path().join("dst"))];
		file_chain(&fixture.path().join("src"), 100);
		limit_descriptors(32);
		let (code, capture) = run_util::<Cp>(&["-r", "src", "dst"], "", fixture.path());
		assert_eq!((code, capture.err().as_str()), (0, ""));
		assert_file_chain(&fixture.path().join("dst"), 100);
	}

	/// `cp -r` copies a chain of 200 levels on a thread with 256 KiB of
	/// stack: the walk keeps its directories on a stack of its own, so depth
	/// costs no thread stack. Before it did, the walk recursed per level and
	/// overflowed that stack by 63 levels in a debug build; deeper chains
	/// prove nothing more, and each level's lookups by path cost more. An
	/// overflow ends the process, so the test runs in a process of its own.
	#[cfg(unix)]
	#[test]
	fn copies_a_tree_deeper_than_the_stack() {
		use crate::deep_tree::{RemoveTree, assert_file_chain, file_chain};

		if !crate::own_process::own_process() {
			return;
		}
		let fixture = crate::deep_tree::tempdir();
		let _trees = [RemoveTree(fixture.path().join("src")), RemoveTree(fixture.path().join("dst"))];
		file_chain(&fixture.path().join("src"), 200);
		let cwd = fixture.path().to_path_buf();
		let (code, err) = std::thread::Builder::new()
			.stack_size(256 * 1024)
			.spawn(move || {
				let (code, capture) = run_util::<Cp>(&["-r", "src", "dst"], "", cwd);
				(code, capture.err())
			})
			.unwrap()
			.join()
			.unwrap();
		assert_eq!((code, err.as_str()), (0, ""));
		assert_file_chain(&fixture.path().join("dst"), 200);
	}

	/// The walk follows a symbolic link deep in the tree only when asked: `-r`
	/// and `-rH` copy it as a link, `-rL` copies the directory it names.
	#[cfg(unix)]
	#[test]
	fn a_deep_link_is_copied_as_a_link_unless_dereferenced() {
		let fixture = tempdir().unwrap();
		let outside = fixture.path().join("outside");
		fs::create_dir(&outside).unwrap();
		fs::write(outside.join("kept"), b"k").unwrap();
		crate::deep_tree::file_chain(&fixture.path().join("src"), 20);
		let at_level_ten = |top: &str| (0..10).fold(fixture.path().join(top), |path, _| path.join("d")).join("link");
		std::os::unix::fs::symlink(&outside, at_level_ten("src")).unwrap();
		for (flag, dest) in [("-r", "plain"), ("-rH", "command-line")] {
			let (code, capture) = run_util::<Cp>(&[flag, "src", dest], "", fixture.path());
			assert_eq!((code, capture.err().as_str()), (0, ""), "{flag}");
			assert_eq!(fs::read_link(at_level_ten(dest)).unwrap(), outside, "{flag}");
		}
		let (code, capture) = run_util::<Cp>(&["-rL", "src", "followed"], "", fixture.path());
		assert_eq!((code, capture.err().as_str()), (0, ""));
		assert!(fs::symlink_metadata(at_level_ten("followed")).unwrap().is_dir());
		assert_eq!(fs::read(at_level_ten("followed").join("kept")).unwrap(), b"k");
	}

	/// An entry removed after its directory was read is reported, and the rest
	/// is copied: `cannot stat`, exit 1. The same as before the walk read each
	/// directory whole, when the listing's first batch already held the name,
	/// and as GNU cp, whose fts reads a directory whole too.
	#[test]
	fn an_entry_removed_after_its_directory_was_read_is_reported() {
		let fixture = tempdir().unwrap();
		let src = fixture.path().join("src");
		fs::create_dir(&src).unwrap();
		for name in ["a", "b", "c"] {
			fs::write(src.join(name), name).unwrap();
		}
		// Before the first entry, one of the others goes.
		let removed = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
		let record = std::rc::Rc::clone(&removed);
		super::BEFORE_ENTRY.set(Some(Box::new(move |entry: &std::path::Path| {
			let mut removed = record.borrow_mut();
			if removed.is_none() {
				let victim = if entry.ends_with("b") { "c" } else { "b" };
				fs::remove_file(src.join(victim)).unwrap();
				*removed = Some(victim.to_string());
			}
		})));
		let (code, capture) = run_util::<Cp>(&["-r", "src", "dst"], "", fixture.path());
		super::BEFORE_ENTRY.set(None);
		let victim = removed.borrow().clone().expect("the hook ran");
		assert_eq!(
			(code, capture.err()),
			(1, format!("cp: cannot stat 'src/{victim}': No such file or directory\n"))
		);
		for name in ["a", "b", "c"].into_iter().filter(|name| *name != victim) {
			assert_eq!(fs::read(fixture.path().join("dst").join(name)).unwrap(), name.as_bytes());
		}
		assert!(!fixture.path().join("dst").join(&victim).exists());
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
		// Where a backup name is another link of the destination's own file,
		// Linux's rename does nothing and these rows hold GNU's answer there.
		// Where the kernel's rename removes the name instead (gVisor's
		// overlay), GNU's answer differs; the probe matrix holds those rows
		// for that kernel (`x/hl3-bk-*`, `x/hl-bk-*`, `x/hl-fifo-*`, family
		// `rename:`), so they are not repeated here.
		fs::write(root.path().join("probe-x"), b"").unwrap();
		fs::hard_link(root.path().join("probe-x"), root.path().join("probe-y")).unwrap();
		fs::rename(root.path().join("probe-x"), root.path().join("probe-y")).unwrap();
		let rename_removes = !root.path().join("probe-x").exists();
		let mut failures = Vec::new();
		let mut skipped = Vec::new();
		for (index, (case, setup, args, code, err, after)) in cases.into_iter().enumerate() {
			// `--backup=numbered` renames to a new name, which no kernel keeps.
			if rename_removes
				&& ["three-links", "backup-is-dest", "linked", "linked-fifo"].contains(&case)
				&& !args.contains(&"--backup=numbered")
			{
				skipped.push(format!("{case} cp {}", args.join(" ")));
				continue;
			}
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
		if !skipped.is_empty() {
			eprintln!(
				"skipped, the kernel's rename here removes a name onto another link of its file (the matrix's `rename:` rows hold them): {}",
				skipped.join("; ")
			);
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
	/// exists"), nothing changed. Where the kernel's rename onto another link
	/// of the same file removes the old name (gVisor's tmpfs and overlay; the
	/// test probes its own directory), `dest` is gone after the backup, and
	/// GNU 9.7 makes each of them there, exit 0 (measured under gVisor).
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
		fs::write(root.path().join("probe-x"), "").unwrap();
		fs::hard_link(root.path().join("probe-x"), root.path().join("probe-y")).unwrap();
		fs::rename(root.path().join("probe-x"), root.path().join("probe-y")).unwrap();
		let rename_removes = !root.path().join("probe-x").exists();
		let mut failures = Vec::new();
		for (index, (args, code, err, after)) in cases.into_iter().enumerate() {
			// Where the rename removes `dest`, it is made anew; `-l` is the same.
			let (code, err, after) = match (rename_removes, args[1]) {
				(true, "-s") => (0, "", " a=A#1 dest=link:<W>/a dest~=old#1 l=link:a"),
				(true, "-P") => (0, "", " a=A#1 dest=link:a dest~=old#1 l=link:a"),
				(true, "-b") => (0, "", " a=A#1 dest=A#1 dest~=old#1 l=link:a"),
				_ => (code, err, after),
			};
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

	/// The probe matrix, in two families. The scenarios: `cp` across its
	/// operand forms (the source's own entry by several names, a directory
	/// target, `-t`), the options that decide what happens to an existing
	/// destination (`-f`, `-i`, `-u`, `-b`, `--backup=numbered`, `-l`, `-s`,
	/// `-P`, `-L`, `-R`, `-a`, `-d`, `--preserve=links`, `--attributes-only`,
	/// `--remove-destination`, alone and together) and the destination's kind.
	/// The kinds: every option cp parses that GNU cp has, alone and in ordered
	/// pairs (an option given after another, which may override it, is there
	/// in both orders), with each kind of source (a regular file, a FIFO, a
	/// character device, a symbolic link, a directory) onto each kind of
	/// destination (none, a regular file, another link of a file, a symbolic
	/// link to the source, one to another file, one to nothing, one to a
	/// directory, one into a directory nobody may search, a directory).
	///
	/// Each row of `cp-gnu-matrix.txt.zst` is what GNU cp 9.7 does on a Linux
	/// kernel as uid 1000 with umask 022: its exit status, standard error and
	/// output, and every entry on disk after it, with its permission bits and
	/// whether its modification time changed, measured on a filesystem that
	/// cannot clone (ext4, tmpfs). `cp-gnu-matrix-root.txt.zst` holds the
	/// rows root gets otherwise (root may search a directory of mode 000 and
	/// make a device node). Where the rows' directory clones (XFS with
	/// reflink, btrfs), `--reflink` and `--debug` copies clone there, and
	/// `cp-gnu-matrix-reflink.txt.zst` holds the rows GNU 9.7 gives there
	/// instead; under gVisor, `cp-gnu-matrix-gvisor.txt.zst` holds those of
	/// its kernel's answers. A probe in the rows' filesystem picks them.
	/// `cp-gnu-matrix.sh`, next to them, makes the rows again from a GNU
	/// build (its header says how).
	///
	/// A row in `cp-gnu-matrix-stated.txt` is one where this cp does on
	/// purpose what GNU does not: its id, this cp's exit status, standard
	/// error, standard output and entries, GNU's answer beside them (checked
	/// against the matrix's), and the reason, one of the reasons that file's
	/// header lists.
	///
	/// A row is `id`, setup, arguments, standard input, exit status, standard
	/// error, standard output (`\n` for a newline) and the entries after it,
	/// tab-separated. Setup steps: `C>name` writes `C`, `target@name` makes a
	/// symbolic link, `ln:a=b` makes `b` another link of `a`, `dir:d` makes a
	/// directory, `fifo:p` a FIFO; then every entry's own times are set to
	/// 1000000000, `T:name=secs` sets `name`'s (following a link), and
	/// `mode:NNN=name` its permission bits. `feed:p` writes `F` into the FIFO
	/// `p` once cp has it open for reading. `<D>` is the row's directory.
	///
	/// The rows run on as many threads as the machine has, each row in its own
	/// directory, removed once the row is checked. A row that has not ended
	/// two minutes after any other row did fails the test, naming the rows
	/// still running.
	///
	/// The rows are GNU's answers on a Linux kernel, so the test runs on
	/// Linux. macOS answers otherwise for the source and destination kinds
	/// the matrix holds: a device node is refused (`EPERM`), `/dev/null` is
	/// on another filesystem (`EXDEV` for a hard link to it), a clone is
	/// `clonefile`'s, and setting attributes on a device is refused; 5,545
	/// rows differ there.
	/// How many pieces the matrix runs in. Each piece is a test of its own
	/// with its own bound in `.config/nextest.toml`, so a run of the whole
	/// binary reports a result every piece: the gate's runner fails a test
	/// only after nothing has been reported for the longest bound among the
	/// tests it is running (`libtest-bound.py`), and one test that took the
	/// whole matrix reported nothing for its own 1,200 s bound. Measured on
	/// runc beside 64 busy loops, the whole matrix took up to 1,413 s and was
	/// stopped at 1,552 s.
	///
	/// Four, not more: libtest runs as many tests at once as it has test
	/// threads, and eight pieces held every one of them under heavy load,
	/// leaving no other test to report and so nothing to reset the runner's
	/// quiet timer — the binary was stopped with every piece named and 2,027
	/// tests never run. Fewer pieces than the binary has test threads keeps
	/// the rest of the run reporting while the matrix works.
	#[cfg(target_os = "linux")]
	const MATRIX_PIECES: usize = 4;

	/// The rows of the probe matrix whose place in the file is `piece` of
	/// [`MATRIX_PIECES`], run as [`cp_does_what_gnu_does_across_the_probe_matrix_1`]
	/// and its three siblings do. Every row runs in exactly one piece
	/// (`the_probe_matrix_pieces_run_every_row_exactly_once`).
	#[cfg(target_os = "linux")]
	fn probe_matrix_piece(piece: usize) {
		use std::{
			collections::{BTreeSet, HashMap},
			os::unix::{
				ffi::OsStrExt as _,
				fs::{FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
			},
			path::Path,
			sync::{
				Arc, Mutex,
				atomic::{AtomicBool, Ordering},
				mpsc,
			},
			time::Duration,
		};

		struct Row {
			id:    String,
			setup: String,
			args:  String,
			input: String,
			want:  (i32, String, String, String),
		}

		fn decode(bytes: &[u8]) -> String {
			String::from_utf8(zstd::decode_all(bytes).unwrap()).unwrap()
		}
		fn unescape(text: &str) -> String {
			text.replace("\\n", "\n")
		}
		fn parse(line: &str) -> Row {
			let [id, setup, args, input, code, err, out, after] = line.split('\t').collect::<Vec<_>>()[..] else {
				panic!("row {line:?}");
			};
			Row {
				id:    id.to_owned(),
				setup: setup.to_owned(),
				args:  args.to_owned(),
				input: input.to_owned(),
				want:  (code.parse().unwrap(), unescape(err), unescape(out), after.to_owned()),
			}
		}
		fn set_time(path: &Path, secs: i64, follow: bool) {
			let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
			// SAFETY: `timespec` is plain data, all zero a valid value.
			let mut time: libc::timespec = unsafe { std::mem::zeroed() };
			time.tv_sec = secs;
			let times = [time, time];
			let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
			// SAFETY: `path` is NUL-terminated and `times` holds two values,
			// both outliving the call.
			assert_eq!(unsafe { libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), flags) }, 0, "utimensat");
		}
		// Every entry below `dir`, as `find | sort` names it, each directory
		// made searchable first, its mode as it was kept in `modes`.
		fn entries(dir: &Path, rel: &Path, out: &mut Vec<std::path::PathBuf>, modes: &mut HashMap<std::path::PathBuf, u32>) {
			for entry in fs::read_dir(dir.join(rel)).unwrap() {
				let name = rel.join(entry.unwrap().file_name());
				let path = dir.join(&name);
				let metadata = fs::symlink_metadata(&path).unwrap();
				out.push(name.clone());
				if metadata.is_dir() {
					let mode = metadata.permissions().mode() & 0o7777;
					modes.insert(name.clone(), mode);
					fs::set_permissions(&path, fs::Permissions::from_mode(mode | 0o700)).unwrap();
					entries(dir, &name, out, modes);
				}
			}
		}
		// `timed`: false where a FIFO writer took part in the row, whose writes
		// change the FIFO's times whenever they come; every time is then `-`.
		fn listing(dir: &Path, timed: bool) -> String {
			let (mut names, mut modes) = (Vec::new(), HashMap::new());
			entries(dir, Path::new(""), &mut names, &mut modes);
			names.sort_by(|a, b| a.as_os_str().as_bytes().cmp(b.as_os_str().as_bytes()));
			names
				.iter()
				.map(|name| {
					let path = dir.join(name);
					let metadata = fs::symlink_metadata(&path).unwrap();
					let shown = name.display();
					let mode = metadata.permissions().mode() & 0o7777;
					let time = match metadata.mtime() {
						_ if !timed => '-',
						1_000_000_000 => '0',
						2_000_000_000 => '2',
						_ => 'n',
					};
					let kind = metadata.file_type();
					if kind.is_symlink() {
						format!(" {shown}=link:{}", fs::read_link(&path).unwrap().display())
					} else if kind.is_dir() {
						format!(" {shown}=dir#{:o}", modes[name])
					} else if kind.is_socket() {
						format!(" {shown}=sock#{mode:o}")
					} else if kind.is_fifo() {
						format!(" {shown}=fifo#{mode:o}#{time}")
					} else if kind.is_char_device() {
						format!(" {shown}=chr#{mode:o}")
					} else if kind.is_block_device() {
						format!(" {shown}=blk#{mode:o}")
					} else {
						let contents = fs::read_to_string(&path).unwrap();
						format!(" {shown}={contents}#{}#{mode:o}#{time}", metadata.nlink())
					}
				})
				.collect()
		}
		// Writes `F` into the FIFO `path` once a reader has it open. The open
		// waits for cp's read open; where cp never opens the FIFO, the row's
		// end releases it with a reader of its own (`release`), and after
		// `stop` nothing is written. The feeder then holds its end until the
		// byte is read or the row's cp has ended. gVisor's blocking open of a
		// FIFO can miss a writer that opens, writes and closes while the opener
		// gets ready to wait: it then waits for the next writer's open, for
		// ever if none comes, where Linux's waits on the count of writer opens
		// and sees that one (`wait_for_partner` in fs/pipe.c). GNU cp's open
		// waits there the same way. A writer the feeder still holds open is
		// there to be seen whenever the opener looks. (A writer opened without
		// waiting, retried until a reader shows, was missed the same way.)
		fn feed(path: std::path::PathBuf, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()> {
			std::thread::spawn(move || {
				let Ok(mut fifo) = fs::OpenOptions::new().write(true).open(&path) else {
					return;
				};
				// A reader that closed before the write leaves EPIPE, as it does
				// GNU's feeder.
				if stop.load(Ordering::Relaxed) || std::io::Write::write_all(&mut fifo, b"F").is_err() {
					return;
				}
				while !stop.load(Ordering::Relaxed) && unread(&fifo) > 0 {
					std::thread::sleep(Duration::from_millis(1));
				}
			})
		}
		// Lets a feeder still waiting in its open go: a reader that does not
		// wait opens the FIFO.
		fn release(path: &Path) {
			let _ = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path);
		}
		// Runs one row in `dir`: this cp's exit status, standard error, standard
		// output and the entries after it.
		fn run(row: &Row, dir: &Path) -> (i32, String, String, String) {
			let steps: Vec<&str> = row.setup.split(' ').filter(|step| !step.is_empty()).collect();
			for step in &steps {
				if step.starts_with("T:") || step.starts_with("mode:") || step.starts_with("feed:") {
				} else if let Some(name) = step.strip_prefix("dir:") {
					fs::create_dir(dir.join(name)).unwrap();
				} else if let Some(name) = step.strip_prefix("sock:") {
					drop(std::os::unix::net::UnixListener::bind(dir.join(name)).unwrap());
				} else if let Some(name) = step.strip_prefix("fifo:") {
					let path = std::ffi::CString::new(dir.join(name).as_os_str().as_bytes()).unwrap();
					// SAFETY: `path` is NUL-terminated and outlives the call.
					assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o666) }, 0, "mkfifo");
				} else if let Some((from, to)) = step.strip_prefix("ln:").and_then(|link| link.split_once('=')) {
					fs::hard_link(dir.join(from), dir.join(to)).unwrap();
				} else if let Some((contents, name)) = step.split_once('>') {
					fs::write(dir.join(name), contents).unwrap();
				} else if let Some((target, link)) = step.split_once('@') {
					std::os::unix::fs::symlink(target, dir.join(link)).unwrap();
				} else {
					panic!("{}: setup step {step}", row.id);
				}
			}
			let (mut names, mut modes) = (Vec::new(), HashMap::new());
			entries(dir, Path::new(""), &mut names, &mut modes);
			for name in names {
				set_time(&dir.join(name), 1_000_000_000, false);
			}
			let mut feeders = Vec::new();
			let stop = Arc::new(AtomicBool::new(false));
			for step in &steps {
				if let Some((name, secs)) = step.strip_prefix("T:").and_then(|step| step.split_once('=')) {
					set_time(&dir.join(name), secs.parse().unwrap(), true);
				} else if let Some((mode, name)) = step.strip_prefix("mode:").and_then(|step| step.split_once('=')) {
					let mode = u32::from_str_radix(mode, 8).unwrap();
					fs::set_permissions(dir.join(name), fs::Permissions::from_mode(mode)).unwrap();
				} else if let Some(name) = step.strip_prefix("feed:") {
					feeders.push((feed(dir.join(name), Arc::clone(&stop)), dir.join(name)));
				}
			}
			let shown = dir.to_str().unwrap();
			let argv: Vec<String> =
				row.args.split(' ').filter(|arg| !arg.is_empty()).map(|arg| arg.replace("<D>", shown)).collect();
			let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
			let answer = if row.input.is_empty() { String::new() } else { format!("{}\n", row.input) };
			let (code, capture) = run_util::<Cp>(&argv, &answer, dir);
			stop.store(true, Ordering::Relaxed);
			for (feeder, fifo) in feeders {
				while !feeder.is_finished() {
					release(&fifo);
					std::thread::yield_now();
				}
				feeder.join().unwrap();
			}
			let timed = !steps.iter().any(|step| step.starts_with("feed:"));
			(code, capture.err().replace(shown, "<D>"), capture.out().replace(shown, "<D>"), listing(dir, timed))
		}

		// The answers this kernel and filesystem give where the ones the rows
		// were measured under (Linux, on a filesystem that cannot clone) are
		// others, probed in `dir`: gVisor's kernel answers, and a clone that a
		// filesystem which can clone makes. An answer that is neither fails
		// the test, naming the probe, so no rows are picked for an unknown
		// kernel.
		#[cfg(not(target_os = "linux"))]
		fn kernel_answers(_dir: &Path) -> BTreeSet<&'static str> {
			BTreeSet::new()
		}
		#[cfg(target_os = "linux")]
		fn kernel_answers(dir: &Path) -> BTreeSet<&'static str> {
			let mut answers = BTreeSet::new();
			let fifo = dir.join("probe-fifo");
			let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
			// SAFETY: `fifo_name` is NUL-terminated and outlives the call.
			assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o644) }, 0, "mkfifo");
			let file = dir.join("probe-file");
			fs::write(&file, b"").unwrap();
			// A clone from a FIFO: EINVAL on Linux, EOPNOTSUPP under gVisor.
			let source = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&fifo).unwrap();
			let target = fs::OpenOptions::new().write(true).open(&file).unwrap();
			match pi_iso::cow::clone_open(&source, &target).map_err(|error| error.raw_os_error()) {
				Err(Some(libc::EINVAL)) => {},
				Err(Some(libc::EOPNOTSUPP)) => {
					answers.insert("clone");
				},
				other => panic!("probe `clone` (a clone from a FIFO) answered {other:?}: neither Linux's nor gVisor's"),
			}
			// A hard link of a FIFO: made on Linux, EOPNOTSUPP under gVisor's v9fs.
			match fs::hard_link(&fifo, dir.join("probe-link")).map_err(|error| error.raw_os_error()) {
				Ok(()) => {},
				Err(Some(libc::EOPNOTSUPP)) => {
					answers.insert("link");
				},
				other => panic!("probe `link` (a hard link of a FIFO) answered {other:?}: neither Linux's nor gVisor's"),
			}
			// A rename onto another link of the same file: does nothing on Linux
			// (both names stay), removes the old name on gVisor's overlay.
			fs::write(dir.join("probe-x"), b"").unwrap();
			fs::hard_link(dir.join("probe-x"), dir.join("probe-y")).unwrap();
			fs::rename(dir.join("probe-x"), dir.join("probe-y")).unwrap();
			match (dir.join("probe-x").exists(), dir.join("probe-y").exists()) {
				(true, true) => {},
				(false, true) => {
					answers.insert("rename");
				},
				other => panic!("probe `rename` (onto another link of the same file) left {other:?}: neither Linux's nor gVisor's"),
			}
			// A device node: as root, at a new name, made on Linux and EPERM
			// under gVisor; as another user, where a name is, EEXIST on Linux
			// and EPERM under gVisor (it checks the permission first).
			// SAFETY: `geteuid` has no preconditions.
			let as_root = unsafe { libc::geteuid() } == 0;
			let node = if as_root { dir.join("probe-node") } else { file };
			let node_name = std::ffi::CString::new(node.as_os_str().as_bytes()).unwrap();
			// SAFETY: `node_name` is NUL-terminated and outlives the call.
			let made = unsafe { libc::mknod(node_name.as_ptr(), libc::S_IFCHR | 0o644, libc::makedev(1, 3)) };
			match (as_root, made, std::io::Error::last_os_error().raw_os_error()) {
				(true, 0, _) | (false, -1, Some(libc::EEXIST)) => {},
				(_, -1, Some(libc::EPERM)) => {
					answers.insert("mknod");
				},
				other => panic!("probe `mknod` (a device node; root, made, errno) answered {other:?}: neither Linux's nor gVisor's"),
			}
			// A clone between two regular files of `dir`: made where the
			// filesystem can clone (XFS with reflink, btrfs), refused where it
			// cannot (EOPNOTSUPP on ext4, tmpfs, overlayfs and under gVisor;
			// EXDEV, EINVAL or ENOTTY where a filesystem refuses it another way).
			fs::write(dir.join("probe-clone-a"), b"A").unwrap();
			fs::write(dir.join("probe-clone-b"), b"").unwrap();
			let source = fs::File::open(dir.join("probe-clone-a")).unwrap();
			let target = fs::OpenOptions::new().write(true).open(dir.join("probe-clone-b")).unwrap();
			match pi_iso::cow::clone_open(&source, &target).map_err(|error| error.raw_os_error()) {
				Ok(()) => {
					answers.insert("reflink");
				},
				Err(Some(libc::EOPNOTSUPP | libc::EXDEV | libc::EINVAL | libc::ENOTTY)) => {},
				other => panic!("probe `reflink` (a clone between two files) answered {other:?}: neither a clone nor a refusal"),
			}
			answers
		}
		// The rows every piece runs, prepared once for the process: decoding and
		// parsing the matrix, applying the root rows, the kernel and filesystem
		// overlays and the stated rows, and probing this kernel, cost the same
		// whichever piece asks for them, and a piece that repeated them took
		// that work away from the rest of the binary.
		type Prepared = (String, String, String, String, (i32, String, String, String));
		static PREPARED: std::sync::OnceLock<Vec<Prepared>> = std::sync::OnceLock::new();
		let prepared = PREPARED.get_or_init(|| {
			let root_probe = tempdir().unwrap();

			// SAFETY: `umask` only sets the process's file mode creation mask; the
			// rows are GNU's under umask 022.
			unsafe { libc::umask(0o022) };
			// SAFETY: `geteuid` has no preconditions.
			let as_root = unsafe { libc::geteuid() } == 0;
			let mut rows: Vec<Row> = decode(include_bytes!("cp-gnu-matrix.txt.zst")).lines().map(parse).collect();
			assert!(!rows.is_empty(), "the matrix has no rows");
			// GNU's answers as the files hold them, before the root rows and the
			// overlays apply: a stated row shows its row's beside this cp's.
			let gnu_rows: HashMap<String, (i32, String, String, String)> =
				rows.iter().map(|row| (row.id.clone(), row.want.clone())).collect();
			let gnu_root: HashMap<String, (i32, String, String, String)> =
				decode(include_bytes!("cp-gnu-matrix-root.txt.zst")).lines().map(parse).map(|row| (row.id, row.want)).collect();
			let mut gnu_overlays: HashMap<(bool, String, String), (i32, String, String, String)> = HashMap::new();
			for text in [decode(include_bytes!("cp-gnu-matrix-gvisor.txt.zst")), decode(include_bytes!("cp-gnu-matrix-reflink.txt.zst"))] {
				for line in text.lines() {
					let (for_root, line) = match line.strip_prefix("root:") {
						Some(line) => (true, line),
						None => (false, line),
					};
					let (family, line) = line.split_once(':').expect("an overlay row without a family");
					let row = parse(line);
					gnu_overlays.insert((for_root, family.to_owned(), row.id), row.want);
				}
			}
			if as_root {
				let root_rows: HashMap<String, Row> = decode(include_bytes!("cp-gnu-matrix-root.txt.zst"))
					.lines()
					.map(|line| {
						let row = parse(line);
						(row.id.clone(), row)
					})
					.collect();
				let mut used = 0;
				for row in &mut rows {
					if let Some(root_row) = root_rows.get(&row.id) {
						row.want = root_row.want.clone();
						used += 1;
					}
				}
				assert_eq!(used, root_rows.len(), "a root row names no row of the matrix");
			}
			// Under gVisor four kernel answers can differ from Linux's, and GNU's
			// own rows with them (`cp-gnu-matrix-gvisor.txt.zst`, GNU 9.7 measured
			// there): `clone:` rows where a clone from a FIFO answers EOPNOTSUPP
			// (EINVAL on Linux), `link:` rows where a hard link of a FIFO answers
			// EOPNOTSUPP (made on Linux), `mknod:` rows where a device node
			// answers EPERM (made, or EEXIST where a name is, on Linux), and
			// `rename:` rows where a rename onto another link of the same file
			// removes the old name (does nothing on Linux; gVisor's overlay root).
			// Where the filesystem clones, GNU's rows differ where its copy
			// clones: the `reflink:` rows of `cp-gnu-matrix-reflink.txt.zst` (GNU
			// 9.7 measured on XFS with reflink), `--reflink` and `--debug` copies.
			// A family's rows replace the rows above where the kernel and the
			// filesystem here give its answer; a `root:` row only as root, after
			// them.
			let answers = kernel_answers(root_probe.path());
			let mut overlaid = 0;
			// The rows the reflink overlay replaced: their stated rows without a
			// family no longer apply (below).
			let mut cloned_rows = BTreeSet::new();
			{
				let overlays =
					[decode(include_bytes!("cp-gnu-matrix-gvisor.txt.zst")), decode(include_bytes!("cp-gnu-matrix-reflink.txt.zst"))];
				let overlay: Vec<(bool, String, Row)> = overlays
					.iter()
					.flat_map(|text| text.lines())
					.map(|line| {
						let (for_root, line) = match line.strip_prefix("root:") {
							Some(line) => (true, line),
							None => (false, line),
						};
						let (family, line) = line.split_once(':').expect("an overlay row without a family");
						(for_root, family.to_owned(), parse(line))
					})
					.collect();
				let index: HashMap<String, usize> =
					rows.iter().enumerate().map(|(index, row)| (row.id.clone(), index)).collect();
				for pass_root in [false, true] {
					for (for_root, family, row) in &overlay {
						if *for_root != pass_root || (*for_root && !as_root) || !answers.contains(family.as_str()) {
							continue;
						}
						let at = *index.get(&row.id).expect("an overlay row names no row of the matrix");
						rows[at].want = row.want.clone();
						overlaid += 1;
						if family == "reflink" {
							cloned_rows.insert(row.id.clone());
						}
					}
				}
			}
			eprintln!("answers unlike the rows' own (gVisor's, a filesystem that clones): {answers:?}; {overlaid} rows from the overlays");
			// The stated rows: id, then this cp's exit status, standard error,
			// standard output and entries, GNU's four, and the reason.
			// A row whose id starts with `root:` holds root's answer, where root's
			// differs from another user's; it is used only as root. A family next
			// (`clone:`, `link:`, `mknod:`, `rename:`, `reflink:`) uses it only
			// where the kernel and the filesystem here answer as that family says,
			// after the rows without one. A row without a family states a
			// difference from the rows measured where the filesystem cannot clone;
			// where the reflink overlay replaced GNU's row (GNU's copy clones
			// there), only a `reflink:` row states one.
			let mut stated: HashMap<&str, (i32, String, String, String)> = HashMap::new();
			let mut ordered: [Vec<(&str, (i32, String, String, String))>; 4] = Default::default();
			for line in include_str!("cp-gnu-matrix-stated.txt").lines().filter(|line| !line.starts_with('#')) {
				let [id, code, err, out, after, gnu_code, gnu_err, gnu_out, gnu_after, reason] =
					line.split('\t').collect::<Vec<_>>()[..]
				else {
					panic!("stated row {line:?}");
				};
				assert!(!reason.is_empty(), "{id}: a stated row with no reason");
				let answer = (code.parse().unwrap(), unescape(err), unescape(out), after.to_owned());
				let (for_root, id) = match id.strip_prefix("root:") {
					Some(id) => (true, id),
					None => (false, id),
				};
				let (family, id) = match id.split_once(':') {
					Some((family, id)) if ["clone", "link", "mknod", "rename", "reflink"].contains(&family) => (Some(family), id),
					_ => (None, id),
				};
				// GNU's answer it shows is the matrix's for its user and family.
				let mut gnu = gnu_rows.get(id).unwrap_or_else(|| panic!("stated row {line:?} names no row of the matrix")).clone();
				if for_root && let Some(root) = gnu_root.get(id) {
					gnu = root.clone();
				}
				for overlay_root in [false, true].into_iter().filter(|overlay_root| !overlay_root || for_root) {
					if let Some(over) = family.and_then(|family| gnu_overlays.get(&(overlay_root, family.to_owned(), id.to_owned()))) {
						gnu = over.clone();
					}
				}
				let shown = (gnu_code.parse().unwrap(), unescape(gnu_err), unescape(gnu_out), gnu_after.to_owned());
				assert_eq!(shown, gnu, "stated row {line:?}: GNU's answer it shows is not the matrix's");
				if for_root && !as_root
					|| family.is_some_and(|family| !answers.contains(family))
					|| family.is_none() && cloned_rows.contains(id)
				{
					continue;
				}
				ordered[usize::from(family.is_some()) * 2 + usize::from(for_root)].push((id, answer));
			}
			for (id, answer) in ordered.into_iter().flatten() {
				stated.insert(id, answer);
			}
			let mut stated_rows = 0;
			for row in &mut rows {
				if let Some(ours) = stated.get(row.id.as_str()) {
					assert_ne!(*ours, row.want, "{}: a stated row is GNU's own", row.id);
					row.want = ours.clone();
					stated_rows += 1;
				}
			}
			assert_eq!(stated_rows, stated.len(), "a stated row names no row of the matrix");

			rows.into_iter().map(|row| (row.id, row.setup, row.args, row.input, row.want)).collect()
		});
		let whole = prepared.len();
		let rows: Vec<Row> = prepared
			.iter()
			.enumerate()
			.filter(|(place, _)| place % MATRIX_PIECES == piece)
			.map(|(_, (id, setup, args, input, want))| Row {
				id:    id.clone(),
				setup: setup.clone(),
				args:  args.clone(),
				input: input.clone(),
				want:  want.clone(),
			})
			.collect();
		let total = rows.len();
		eprintln!("piece {} of {MATRIX_PIECES}: {total} of {whole} rows", piece + 1);
		static IN_TURN: Mutex<()> = Mutex::new(());
		let _turn = IN_TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
		let root = tempdir().unwrap();
		let rows = Arc::new(rows);
		let next = Arc::new(Mutex::new(0_usize));
		let running = Arc::new(Mutex::new(BTreeSet::new()));
		let (done, results) = mpsc::channel();
		// One piece at a time, each with the machine: pieces that ran together
		// with a share of the workers each all finished at about the moment the
		// whole matrix would have, so the run still waited as long for its
		// first result. Taken in turn, a piece runs its quarter of the rows on
		// the whole pool and reports in about a quarter of the matrix's time,
		// and the run gets a result four times rather than once. A piece
		// waiting its turn reports nothing, which is why there are fewer
		// pieces than the binary has test threads.
		let threads = std::thread::available_parallelism().map_or(4, |count| count.get());
		for _ in 0..threads {
			let (rows, next, running, done, base) =
				(Arc::clone(&rows), Arc::clone(&next), Arc::clone(&running), done.clone(), root.path().to_owned());
			std::thread::spawn(move || {
				loop {
					let index = {
						let mut next = next.lock().unwrap();
						let index = *next;
						*next += 1;
						index
					};
					let Some(row) = rows.get(index) else { return };
					running.lock().unwrap().insert(index);
					let dir = base.join(index.to_string());
					fs::create_dir(&dir).unwrap();
					let found = run(row, &dir);
					fs::remove_dir_all(&dir).unwrap();
					let failure = (found != row.want).then(|| format!("{}: cp {}: {found:?}", row.id, row.args));
					running.lock().unwrap().remove(&index);
					if done.send(failure).is_err() {
						return;
					}
				}
			});
		}
		drop(done);
		let mut failures = Vec::new();
		for _ in 0..total {
			match results.recv_timeout(Duration::from_secs(120)) {
				Ok(failure) => failures.extend(failure),
				Err(_) => {
					let running: Vec<String> =
						running.lock().unwrap().iter().map(|&index| format!("{} (cp {})", rows[index].id, rows[index].args)).collect();
					panic!("no row ended for two minutes; still running: {}", running.join(", "));
				},
			}
		}
		failures.sort();
		for failure in &failures {
			eprintln!("differs: {failure}");
		}
		let shown = failures.iter().take(300).cloned().collect::<Vec<_>>().join("\n");
		assert!(failures.is_empty(), "{} of {total} rows differ from GNU (the first 300 by id):\n{shown}", failures.len());
	}

	/// The four tests and the pieces they run, from one declaration: the
	/// macro writes each test and the list the coverage test reads, so two
	/// tests cannot run the same piece without the list saying so.
	#[cfg(target_os = "linux")]
	macro_rules! matrix_pieces {
		($($name:ident runs $piece:literal),+ $(,)?) => {
			const MATRIX_PIECE_OF_TEST: &[usize] = &[$($piece),+];
			$(
				#[cfg(target_os = "linux")]
				#[test]
				fn $name() {
					probe_matrix_piece($piece);
				}
			)+
		};
	}

	#[cfg(target_os = "linux")]
	matrix_pieces! {
		cp_does_what_gnu_does_across_the_probe_matrix_1 runs 0,
		cp_does_what_gnu_does_across_the_probe_matrix_2 runs 1,
		cp_does_what_gnu_does_across_the_probe_matrix_3 runs 2,
		cp_does_what_gnu_does_across_the_probe_matrix_4 runs 3,
	}

	/// The pieces run every row of the matrix, each in exactly one of them:
	/// the split moved where a row runs, not which rows run. Counted from the
	/// file the pieces read.
	#[cfg(target_os = "linux")]
	#[test]
	fn the_probe_matrix_pieces_run_every_row_exactly_once() {
		let text = String::from_utf8(zstd::decode_all(&include_bytes!("cp-gnu-matrix.txt.zst")[..]).unwrap()).unwrap();
		let ids: Vec<&str> = text.lines().map(|line| line.split('\t').next().expect("a row with no id")).collect();
		assert!(!ids.is_empty(), "the matrix has no rows");
		let mut seen: Vec<usize> = MATRIX_PIECE_OF_TEST.to_vec();
		seen.sort_unstable();
		assert_eq!(seen, (0..MATRIX_PIECES).collect::<Vec<_>>(), "the tests do not run every piece, each once: {MATRIX_PIECE_OF_TEST:?}");
		let mut ran: Vec<&str> = Vec::new();
		for &piece in MATRIX_PIECE_OF_TEST {
			let of_piece: Vec<&str> =
				ids.iter().enumerate().filter(|(place, _)| place % MATRIX_PIECES == piece).map(|(_, id)| *id).collect();
			assert!(!of_piece.is_empty(), "piece {} of {MATRIX_PIECES} has no row", piece + 1);
			ran.extend(of_piece);
		}
		assert_eq!(ran.len(), ids.len(), "the pieces hold {} rows, the file {}", ran.len(), ids.len());
		let mut sorted = ran.clone();
		sorted.sort_unstable();
		let before = sorted.len();
		sorted.dedup();
		assert_eq!(sorted.len(), before, "a row runs in more than one piece");
		let mut whole = ids.clone();
		whole.sort_unstable();
		let mut pieces = ran;
		pieces.sort_unstable();
		assert_eq!(pieces, whole, "the pieces' rows are not the file's rows");
	}

	/// `--attributes-only` onto the source's own entry is the same file, as
	/// GNU cp 9.4 and 9.7 say it is (the same as uid 1000 and as root), with
	/// or without `-f` and `--remove-destination`; `-fb a a` copies the
	/// attributes to an empty `a~`, and `-l` does nothing.
	#[cfg(unix)]
	#[test]
	fn attributes_only_onto_its_own_entry_is_the_same_file_as_gnu_says() {
		let same = |a: &str, b: &str| format!("cp: '{a}' and '{b}' are the same file\n");
		let ao = "--attributes-only";
		#[rustfmt::skip]
		let cases: [(&[&str], i32, String, &str); 10] = [
			(&[ao, "a", "a"], 1, same("a", "a"), " a=A#1 b=B#1"),
			(&[ao, "a", "./a"], 1, same("a", "./a"), " a=A#1 b=B#1"),
			(&[ao, "a", "<D>/a"], 1, same("a", "<D>/a"), " a=A#1 b=B#1"),
			(&[ao, "a", "b"], 0, String::new(), " a=A#1 b=B#1"),
			(&[ao, "-f", "a", "./a"], 1, same("a", "./a"), " a=A#1 b=B#1"),
			(&[ao, "--remove-destination", "a", "./a"], 1, same("a", "./a"), " a=A#1 b=B#1"),
			(&[ao, "-fb", "a", "a"], 0, String::new(), " a=A#1 a~=#1 b=B#1"),
			(&[ao, "-b", "a", "./a"], 1, same("a", "./a"), " a=A#1 b=B#1"),
			(&[ao, "-l", "a", "./a"], 0, String::new(), " a=A#1 b=B#1"),
			(&[ao, "-P", "a", "./a"], 1, same("a", "./a"), " a=A#1 b=B#1"),
		];
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (args, code, err, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("a"), "A").unwrap();
			fs::write(dir.join("b"), "B").unwrap();
			let shown = dir.to_str().unwrap();
			let args: Vec<String> = args.iter().map(|arg| arg.replace("<D>", shown)).collect();
			let args: Vec<&str> = args.iter().map(String::as_str).collect();
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			let found = (got, capture.err().replace(shown, "<D>"), crate::file_backup::tests::listing(&dir));
			if found != (code, err, after.to_owned()) {
				failures.push(format!("cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `cp -l -f`, and `cp -l -i` answered yes, replace a destination as GNU's
	/// `force_linkat` does, never removing it before the new link is in place:
	/// where the link cannot be made, here from /dev/shm to the temporary
	/// directory (two file systems), the destination stays, with GNU's message
	/// (GNU cp 9.4 and 9.7, as uid 1000 and as root). Without either, the
	/// destination is there and the link fails with `File exists`.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_hard_link_that_cannot_be_made_keeps_the_destination() {
		use std::{os::unix::fs::MetadataExt as _, path::Path};
		let root = tempdir().unwrap();
		let device = |path: &Path| fs::metadata(path).map(|metadata| metadata.dev()).ok();
		match (device("/dev/shm".as_ref()), device(root.path())) {
			(Some(shm), Some(temp)) if shm != temp => {},
			(shm, temp) => {
				eprintln!("skipped: /dev/shm ({shm:?}) and the temporary directory ({temp:?}) are not two file systems");
				return;
			},
		}
		let from = tempfile::tempdir_in("/dev/shm").unwrap();
		let source = from.path().join("a");
		fs::write(&source, "A").unwrap();
		let shown = source.to_str().unwrap();
		let crossing = format!("cp: cannot create hard link 'b' to '{shown}': Invalid cross-device link\n");
		#[rustfmt::skip]
		let cases: [(&[&str], &str, String); 3] = [
			(&["-l", "-f"], "", crossing.clone()),
			(&["-l", "-i"], "y\n", format!("cp: overwrite 'b'? {crossing}")),
			(&["-l"], "", format!("cp: cannot create hard link 'b' to '{shown}': File exists\n")),
		];
		for (flags, answer, err) in cases {
			fs::write(root.path().join("b"), "B").unwrap();
			let args: Vec<&str> = flags.iter().copied().chain([shown, "b"]).collect();
			let (code, capture) = run_util::<Cp>(&args, answer, root.path());
			assert_eq!((code, capture.err()), (1, err), "cp {}", args.join(" "));
			assert_eq!(fs::read_to_string(root.path().join("b")).unwrap(), "B", "cp {}: the destination", args.join(" "));
		}
	}

	/// A FIFO or a device as the source, copied onto an existing destination,
	/// as GNU cp 9.4 and 9.7 copy it (the same as uid 1000 and as root): where
	/// cp never follows links (`-R`, `-a`) and the source is not a regular
	/// file, GNU removes the destination before it writes (`copy.c`), so another
	/// link of it, and a file a link there leads to, keep their data; without
	/// `-R` it writes into the destination. While a row runs, the test opens and
	/// closes the FIFO's write end, so a cp that opens it for reading reads
	/// end-of-file.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_special_source_replaces_the_destination_where_gnu_removes_it_first() {
		use std::{
			os::unix::fs::{FileTypeExt as _, MetadataExt as _, OpenOptionsExt as _},
			path::Path,
		};
		// Source (`fifo`, a FIFO `p`; `null`, `/dev/null`), destination (`link`,
		// a link to `b`; `other-link`, another link of `b`; `dir-link`, a link to
		// `../b` in the target directory `d`; `regular`; `none`), the options,
		// and GNU's exit status and entries after it (standard error is empty).
		#[rustfmt::skip]
		let cases: [(&str, &str, &[&str], i32, &str); 30] = [
			("fifo", "link", &["-R", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "link", &["--copy-contents"], 0, " b=#1 p=fifo p.dst=link:b"),
			("fifo", "link", &["-a", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "link", &["-R"], 0, " b=B#1 p=fifo p.dst=fifo"),
			("fifo", "other-link", &["-R", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "other-link", &["--copy-contents"], 0, " b=#2 p=fifo p.dst=#2"),
			("fifo", "other-link", &["-a", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "other-link", &["-R"], 0, " b=B#1 p=fifo p.dst=fifo"),
			("fifo", "dir-link", &["-R", "--copy-contents"], 0, " b=B#1 d=dir d/p=#1 p=fifo"),
			("fifo", "dir-link", &["--copy-contents"], 0, " b=#1 d=dir d/p=link:../b p=fifo"),
			("fifo", "dir-link", &["-a", "--copy-contents"], 0, " b=B#1 d=dir d/p=#1 p=fifo"),
			("fifo", "dir-link", &["-R"], 0, " b=B#1 d=dir d/p=fifo p=fifo"),
			("fifo", "regular", &["-R", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "regular", &["--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "regular", &["-a", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "regular", &["-R"], 0, " b=B#1 p=fifo p.dst=fifo"),
			("fifo", "none", &["-R", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "none", &["--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "none", &["-a", "--copy-contents"], 0, " b=B#1 p=fifo p.dst=#1"),
			("fifo", "none", &["-R"], 0, " b=B#1 p=fifo p.dst=fifo"),
			("null", "link", &["-R", "--copy-contents"], 0, " b=B#1 null.dst=#1"),
			("null", "link", &["--copy-contents"], 0, " b=#1 null.dst=link:b"),
			("null", "other-link", &["-R", "--copy-contents"], 0, " b=B#1 null.dst=#1"),
			("null", "other-link", &["--copy-contents"], 0, " b=#2 null.dst=#2"),
			("null", "dir-link", &["-R", "--copy-contents"], 0, " b=B#1 d=dir d/null=#1"),
			("null", "dir-link", &["--copy-contents"], 0, " b=#1 d=dir d/null=link:../b"),
			("null", "regular", &["-R", "--copy-contents"], 0, " b=B#1 null.dst=#1"),
			("null", "regular", &["--copy-contents"], 0, " b=B#1 null.dst=#1"),
			("null", "none", &["-R", "--copy-contents"], 0, " b=B#1 null.dst=#1"),
			("null", "none", &["--copy-contents"], 0, " b=B#1 null.dst=#1"),
		];
		// Every entry below `dir`, as `find | sort` names it.
		fn listing(dir: &Path) -> String {
			fn walk(dir: &Path, rel: &Path, out: &mut Vec<std::path::PathBuf>) {
				for entry in fs::read_dir(dir.join(rel)).unwrap() {
					let name = rel.join(entry.unwrap().file_name());
					let is_dir = fs::symlink_metadata(dir.join(&name)).unwrap().is_dir();
					out.push(name.clone());
					if is_dir {
						walk(dir, &name, out);
					}
				}
			}
			let mut names = Vec::new();
			walk(dir, Path::new(""), &mut names);
			names.sort();
			names
				.iter()
				.map(|name| {
					let path = dir.join(name);
					let metadata = fs::symlink_metadata(&path).unwrap();
					let shown = name.display();
					if metadata.is_symlink() {
						format!(" {shown}=link:{}", fs::read_link(&path).unwrap().display())
					} else if metadata.file_type().is_fifo() {
						format!(" {shown}=fifo")
					} else if metadata.is_dir() {
						format!(" {shown}=dir")
					} else {
						format!(" {shown}={}#{}", fs::read_to_string(&path).unwrap(), metadata.nlink())
					}
				})
				.collect()
		}
		let root = tempdir().unwrap();
		let mut failures = Vec::new();
		for (index, (source, kind, flags, code, after)) in cases.into_iter().enumerate() {
			let dir = root.path().join(index.to_string());
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("b"), "B").unwrap();
			let (operand, name) = match source {
				"fifo" => {
					let path = std::ffi::CString::new(dir.join("p").into_os_string().into_encoded_bytes()).unwrap();
					// SAFETY: `path` is a NUL-terminated path that outlives the call.
					assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0, "mkfifo");
					("p", "p")
				},
				_ => ("/dev/null", "null"),
			};
			let dst = format!("{name}.dst");
			let target = match kind {
				"link" => {
					std::os::unix::fs::symlink("b", dir.join(&dst)).unwrap();
					dst
				},
				"other-link" => {
					fs::hard_link(dir.join("b"), dir.join(&dst)).unwrap();
					dst
				},
				"dir-link" => {
					fs::create_dir(dir.join("d")).unwrap();
					std::os::unix::fs::symlink("../b", dir.join("d").join(name)).unwrap();
					"d".to_owned()
				},
				"regular" => {
					fs::write(dir.join(&dst), "R").unwrap();
					dst
				},
				_ => dst,
			};
			let args: Vec<&str> = flags.iter().copied().chain([operand, target.as_str()]).collect();
			let (row_done, done) = std::sync::mpsc::channel::<()>();
			let fifo = dir.join("p");
			let guard = (source == "fifo").then(|| {
				std::thread::spawn(move || {
					while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
						done.recv_timeout(std::time::Duration::from_millis(10))
					{
						// Opens without waiting only once cp has the FIFO open
						// for reading; closing it at once gives cp end-of-file.
						let _ = fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&fifo);
					}
				})
			});
			let (got, capture) = run_util::<Cp>(&args, "", &dir);
			drop(row_done);
			if let Some(guard) = guard {
				guard.join().unwrap();
			}
			let found = (got, capture.err(), listing(&dir));
			if found != (code, String::new(), after.to_owned()) {
				failures.push(format!("{source} {kind}: cp {}: {found:?}", args.join(" ")));
			}
		}
		assert!(failures.is_empty(), "rows that differ from GNU:\n{}", failures.join("\n"));
	}

	/// `link_over` makes the new link at a fresh name and renames it over the
	/// destination. Where the destination is already a link of the same file,
	/// Linux's rename does nothing and leaves the fresh name, which `link_over`
	/// then removes, as GNU's `force_linkat` does. cp does nothing before it
	/// links a source onto its own file, so the test calls `link_over` itself.
	#[cfg(unix)]
	#[test]
	fn link_over_leaves_no_fresh_name_where_the_rename_does_nothing() {
		let dir = tempdir().unwrap();
		let original = dir.path().join("a");
		let dest = dir.path().join("b");
		fs::write(&original, "A").unwrap();
		fs::hard_link(&original, &dest).unwrap();
		let filesystem = pi_vfs::BlockingFs::native();
		super::link_over(&filesystem, &dest, true, |at| filesystem.hard_link(&original, at)).unwrap();
		let mut names: Vec<_> =
			fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
		names.sort();
		assert_eq!(names, ["a", "b"], "the entries after link_over");
		assert_eq!(fs::metadata(&dest).unwrap().len(), 1, "b");
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
