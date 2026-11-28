//! `mv` builtin: move files and directories.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fmt,
	io::{self, Write},
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, error::ErrorKind};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use pi_vfs::{
	BlockingFs, CanonicalizeOptions, MissingHandling, ResolveMode, child_path, file_name,
	is_virtual_path, parent_path,
};
use rustc_hash::FxHashSet;
use thiserror::Error;
#[cfg(unix)]
use uucore::fs::display_permissions_unix;
use uucore::{
	backup_control::{self, BackupMode},
	display::Quotable,
	fs::path_ends_with_terminator,
	update_control::{self, UpdateMode},
};

use crate::{
	cp::{CpError, MoveCopier},
	file_backup::{
		backup_display, backup_is_source, backup_path, determine_backup_mode, determine_backup_suffix,
		source_is_destination_backup,
	},
	host::{Host, Utility, format_usage, matches_parser},
	progress::stderr_draw_target,
};

#[derive(Debug, Error)]
enum MvError {
	#[error("cannot stat {0}: No such file or directory")]
	NoSuchFile(String),
	#[error("cannot stat {0}: Not a directory")]
	CannotStatNotADirectory(String),
	#[error("{0} and {1} are the same file")]
	SameFile(String, String),
	#[error("cannot move {0} to a subdirectory of itself, {1}")]
	SelfTargetSubdirectory(String, String),
	#[error("cannot overwrite directory {0} with non-directory {1}")]
	DirectoryToNonDirectory(String, String),
	#[error("cannot overwrite non-directory {1} with directory {0}")]
	NonDirectoryToDirectory(String, String),
	#[error("backing up {0} might destroy source;  {1} not moved")]
	BackupWouldDestroySource(String, String),
	#[error("cannot backup {0}: File exists")]
	CannotBackup(String),
	#[error("target {0}: Not a directory")]
	NotADirectory(String),
	#[error("target directory {0}: Not a directory")]
	TargetNotADirectory(String),
	#[error("failed to access {0}: Not a directory")]
	FailedToAccessNotADirectory(String),
}

#[derive(Debug, Error)]
enum MvFailure {
	#[error(transparent)]
	Move(#[from] MvError),
	#[error(transparent)]
	Io(#[from] io::Error),
	#[error("{0}")]
	Message(String),
}

type MvResult<T> = Result<T, MvFailure>;

/// A move that failed after its diagnostics were printed: the copy between
/// filesystems reports each entry it could not copy as it goes.
#[derive(Debug, Error)]
#[error("")]
struct Reported;

/// Parsed `mv` invocation.
pub(crate) struct Mv {
	matches: ArgMatches,
}

matches_parser!(Mv, app);

fn progress_manager(host: &Host, enabled: bool) -> Option<MultiProgress> {
	if !enabled {
		return None;
	}
	stderr_draw_target(host).map(MultiProgress::with_draw_target)
}

/// Options contains all the possible behaviors and flags for mv.
///
/// All options are public so that the options can be programmatically
/// constructed by other crates, such as nushell. That means that this struct is
/// part of our public API. It should therefore not be changed without good
/// reason.
///
/// The fields are documented with the arguments that determine their value.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Options {
	/// specifies overwrite behavior
	/// '-n' '--no-clobber'
	/// '-i' '--interactive'
	/// '-f' '--force'
	pub overwrite: OverwriteMode,

	/// `--backup[=CONTROL]`, `-b`
	pub backup: BackupMode,

	/// '-S' --suffix' backup suffix
	pub suffix: String,

	/// Available update mode "--update-mode=all|none|older"
	pub update: UpdateMode,

	/// Specifies target directory
	/// '-t, --target-directory=DIRECTORY'
	pub target_dir: Option<OsString>,

	/// Treat destination as a normal file
	/// '-T, --no-target-directory
	pub no_target_dir: bool,

	/// '-v, --verbose'
	pub verbose: bool,

	/// '--strip-trailing-slashes'
	pub strip_slashes: bool,

	/// '-g, --progress'
	pub progress_bar: bool,

	/// `--debug`
	pub debug: bool,

	/// `-Z, --context`
	pub context: Option<String>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			overwrite:     OverwriteMode::default(),
			backup:        BackupMode::default(),
			suffix:        backup_control::DEFAULT_BACKUP_SUFFIX.to_owned(),
			update:        UpdateMode::default(),
			target_dir:    None,
			no_target_dir: false,
			verbose:       false,
			strip_slashes: false,
			progress_bar:  false,
			debug:         false,
			context:       None,
		}
	}
}

/// specifies behavior of the overwrite flag
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub enum OverwriteMode {
	/// No flag specified - prompt for unwriteable files when stdin is TTY
	#[default]
	Default,
	/// '-n' '--no-clobber'   do not overwrite
	NoClobber,
	/// '-i' '--interactive'  prompt before overwrite
	Interactive,
	///'-f' '--force'         overwrite without prompt
	Force,
}

static OPT_FORCE: &str = "force";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_NO_CLOBBER: &str = "no-clobber";
static OPT_STRIP_TRAILING_SLASHES: &str = "strip-trailing-slashes";
static OPT_TARGET_DIRECTORY: &str = "target-directory";
static OPT_NO_TARGET_DIRECTORY: &str = "no-target-directory";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static ARG_FILES: &str = "files";
static OPT_DEBUG: &str = "debug";
static OPT_CONTEXT: &str = "context";
static OPT_SELINUX: &str = "selinux";
impl Utility for Mv {
	const NAME: &'static str = "mv";

	fn run(self, host: &mut Host) -> i32 {
		let files_len = self.matches.get_many::<OsString>(ARG_FILES).map_or(0, |v| v.len());
		if files_len == 1 && !self.matches.contains_id(OPT_TARGET_DIRECTORY) {
			let err = app().error(
				ErrorKind::TooFewValues,
				format!(
					"The argument '<{ARG_FILES}>...' requires at least 2 values, but only 1 was provided"
				),
			);
			let _ = write!(host.stderr, "{err}");
			return 1;
		}

		match run_matches(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				let _ = writeln!(host.stderr, "{}: {err}", Self::NAME);
				1
			},
		}
	}
}

fn show(host: &mut Host, err: impl fmt::Display) {
	host.error(err, 1);
}

fn run_matches(matches: &ArgMatches, host: &mut Host) -> MvResult<()> {
	let files: Vec<OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap_or_default()
		.cloned()
		.collect();

	let overwrite_mode = determine_overwrite_mode(matches);
	let backup_mode = determine_backup_mode(matches, host).map_err(MvFailure::Message)?;
	let update_mode = update_control::determine_update_mode(matches);

	if backup_mode != BackupMode::None
		&& (overwrite_mode == OverwriteMode::NoClobber
			|| update_mode == UpdateMode::None
			|| update_mode == UpdateMode::NoneFail)
	{
		return Err(MvFailure::Message(
			"cannot combine --backup with -n/--no-clobber or --update=none-fail".to_string(),
		));
	}

	let backup_suffix = determine_backup_suffix(matches, host);
	let target_dir = matches.get_one::<OsString>(OPT_TARGET_DIRECTORY).cloned();
	if let Some(maybe_dir) = &target_dir
		&& !host.fs().is_dir(host.resolve(Path::new(maybe_dir)))
	{
		return Err(MvError::TargetNotADirectory(maybe_dir.quote().to_string()).into());
	}

	let context = if matches.get_flag(OPT_SELINUX) {
		Some(String::new())
	} else {
		matches.get_one::<String>(OPT_CONTEXT).cloned()
	};

	let opts = Options {
		overwrite: overwrite_mode,
		backup: backup_mode,
		suffix: backup_suffix,
		update: update_mode,
		target_dir,
		no_target_dir: matches.get_flag(OPT_NO_TARGET_DIRECTORY),
		verbose: matches.get_flag(OPT_VERBOSE) || matches.get_flag(OPT_DEBUG),
		strip_slashes: matches.get_flag(OPT_STRIP_TRAILING_SLASHES),
		progress_bar: matches.get_flag(OPT_PROGRESS),
		debug: matches.get_flag(OPT_DEBUG),
		context,
	};

	mv(host, &files, &opts)
}

fn app() -> Command {
	Command::new("mv")
		.version("0.8.0")
		.about("Move SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.")
		.override_usage(format_usage(
			"mv [OPTION]... [-T] SOURCE DEST\nmv [OPTION]... SOURCE... DIRECTORY\nmv [OPTION]... -t \
			 DIRECTORY SOURCE...",
		))
		.after_help(format!(
			"{}\n\n{}",
			"When specifying more than one of -i, -f, -n, only the final one will take effect.\n\nDo \
			 not move a non-directory that has an existing destination with the same or newer \
			 modification timestamp;\ninstead, silently skip the file without failing. If the move \
			 is across file system boundaries, the comparison is\nto the source timestamp truncated \
			 to the resolutions of the destination file system and of the system calls used\nto \
			 update timestamps; this avoids duplicate work if several mv -u commands are executed \
			 with the same source\nand destination. This option is ignored if the -n or --no-clobber \
			 option is also specified. which gives more control\nover which existing files in the \
			 destination are replaced, and its value can be one of the following:\n\n- all This is \
			 the default operation when an --update option is not specified, and results in all \
			 existing files in the destination being replaced.\n- none This is similar to the \
			 --no-clobber option, in that no files in the destination are replaced, but also \
			 skipping a file does not induce a failure.\n- older This is the default operation when \
			 --update is specified, and results in files being replaced if they're older than the \
			 corresponding source file.",
			backup_control::BACKUP_CONTROL_LONG_HELP
		))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("do not prompt before overwriting")
				.overrides_with_all([OPT_INTERACTIVE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.short('i')
				.long(OPT_INTERACTIVE)
				.help("prompt before override")
				.overrides_with_all([OPT_FORCE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_CLOBBER)
				.short('n')
				.long(OPT_NO_CLOBBER)
				.help("do not overwrite an existing file")
				.overrides_with_all([OPT_FORCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_STRIP_TRAILING_SLASHES)
				.long(OPT_STRIP_TRAILING_SLASHES)
				.help("remove any trailing slashes from each SOURCE argument")
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(OPT_TARGET_DIRECTORY)
				.short('t')
				.long(OPT_TARGET_DIRECTORY)
				.help("move all SOURCE arguments into DIRECTORY")
				.value_name("DIRECTORY")
				.value_hint(clap::ValueHint::DirPath)
				.conflicts_with(OPT_NO_TARGET_DIRECTORY)
				.value_parser(ValueParser::os_string()),
		)
		.arg(
			Arg::new(OPT_NO_TARGET_DIRECTORY)
				.short('T')
				.long(OPT_NO_TARGET_DIRECTORY)
				.help("treat DEST as a normal file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("explain what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROGRESS)
				.short('g')
				.long(OPT_PROGRESS)
				.help("Display a progress bar.\nNote: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SELINUX)
				.short('Z')
				.help("set SELinux security context of destination file to default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CONTEXT)
				.long(OPT_CONTEXT)
				.value_name("CTX")
				.value_parser(clap::value_parser!(String))
				.help("like -Z, or if CTX is specified then set the SELinux security context to CTX")
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(""),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("explain how a file is copied. Implies -v")
				.action(ArgAction::SetTrue),
		)
}

fn determine_overwrite_mode(matches: &ArgMatches) -> OverwriteMode {
	// This does not exactly match the GNU implementation:
	// The GNU mv defaults to Force, but if more than one of the
	// overwrite options are supplied, only the last takes effect.
	// To default to no-clobber in that situation seems safer:
	//
	if matches.get_flag(OPT_NO_CLOBBER) {
		OverwriteMode::NoClobber
	} else if matches.get_flag(OPT_INTERACTIVE) {
		OverwriteMode::Interactive
	} else if matches.get_flag(OPT_FORCE) {
		OverwriteMode::Force
	} else {
		OverwriteMode::Default
	}
}

fn parse_paths(files: &[OsString], opts: &Options) -> Vec<PathBuf> {
	let paths = files.iter().map(Path::new);

	if opts.strip_slashes {
		paths
			.map(|p| {
				// A virtual root keeps the `//` of its `scheme://` spelling.
				if is_virtual_path(p) && parent_path(p).is_none() {
					p.to_owned()
				} else {
					p.components().as_path().to_owned()
				}
			})
			.collect::<Vec<PathBuf>>()
	} else {
		paths.map(ToOwned::to_owned).collect::<Vec<PathBuf>>()
	}
}

fn handle_two_paths(host: &mut Host, source: &Path, target: &Path, opts: &Options) -> MvResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let target_fs = host.resolve(target);

	if filesystem.symlink_metadata(&source_fs).is_err() {
		return Err(if path_ends_with_terminator(source) {
			MvError::CannotStatNotADirectory(source.quote().to_string()).into()
		} else {
			MvError::NoSuchFile(source.quote().to_string()).into()
		});
	}

	let source_is_dir = filesystem.is_dir(&source_fs) && !filesystem.is_symlink(&source_fs);
	let target_is_dir = if filesystem.is_symlink(&target_fs) {
		filesystem
			.canonicalize(&target_fs)
			.is_ok_and(|p| filesystem.is_dir(p))
	} else {
		filesystem.is_dir(&target_fs)
	};

	if path_ends_with_terminator(target)
		&& (!target_is_dir && !source_is_dir)
		&& !opts.no_target_dir
		&& opts.update != UpdateMode::IfOlder
	{
		return Err(MvError::FailedToAccessNotADirectory(target.quote().to_string()).into());
	}

	assert_not_same_file(host, source, target, target_is_dir, opts)?;

	if target_is_dir {
		if !opts.no_target_dir {
			return move_files_into_dir(host, &[source.to_path_buf()], target, opts);
		}
		if !filesystem.is_dir(&source_fs) {
			return Err(MvError::DirectoryToNonDirectory(target.quote().to_string(), source.quote().to_string()).into());
		}
	}

	match rename(host, source, target, opts, None, &mut MoveCopier::new(opts.verbose)) {
		Ok(()) => Ok(()),
		Err(e) if e.get_ref().is_some_and(|e| e.is::<Reported>()) => {
			host.fail(1);
			Ok(())
		},
		Err(e) if target_is_dir && !is_refusal(&e) => Err(MvFailure::Message(format!(
			"cannot move {} to {}: {e}",
			source.quote(),
			target.quote()
		))),
		Err(e) => Err(MvFailure::Message(e.to_string())),
	}
}

fn assert_not_same_file(
	host: &mut Host,
	source: &Path,
	target: &Path,
	target_is_dir: bool,
	opts: &Options,
) -> MvResult<()> {
	let filesystem = host.fs().clone();
	let source_abs = host.resolve(source);
	let target_abs = host.resolve(target);
	let logical = CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Logical);

	// we'll compare canonicalized_source and canonicalized_target for same file
	// detection
	let canonicalized_source = match filesystem.canonicalize_with(&source_abs, &logical) {
		Ok(source) if filesystem.exists(&source) => source,
		_ => source_abs.clone(), /* file or symlink target doesn't exist but its absolute path
		                          * is still used for comparison */
	};

	// special case if the target exists, is a directory, and the `-T` flag wasn't
	// used
	let target_is_dir = target_is_dir && !opts.no_target_dir;
	let canonicalized_target = if target_is_dir {
		// `mv source_file target_dir` => target_dir/source_file
		// canonicalize the path that exists (target directory) and join the source file
		// name
		child_path(
			&filesystem.canonicalize_with(&target_abs, &logical)?,
			&file_name(source).unwrap_or_default(),
		)
	} else {
		// `mv source target_dir/target` => target_dir/target
		// we canonicalize target_dir and join /target
		match parent_path(&target_abs) {
			Some(parent) if !parent.is_empty() => child_path(
				&filesystem.canonicalize_with(parent, &logical)?,
				&file_name(target).unwrap_or_default(),
			),
			// the parent is empty or missing if there's no parent
			_ => target_abs.clone(), /* absolute paths should always have a parent, but we'll fall
			                          * back just in case */
		}
	};

	let same_file = (canonicalized_source.eq(&canonicalized_target)
		|| are_hardlinks_to_same_file(&filesystem, &source_abs, &target_abs)
		|| are_hardlinks_or_one_way_symlink_to_same_file(&filesystem, &source_abs, &target_abs))
		&& opts.backup == BackupMode::None;

	// get the expected target path to show in errors
	// this is based on the argument and not canonicalized
	let target_display = match file_name(source) {
		// A virtual root keeps the `//` of its `scheme://` spelling.
		Some(file_name) if target_is_dir && is_virtual_path(target) && parent_path(target).is_none() => {
			child_path(target, &file_name).quote().to_string()
		},
		Some(file_name) if target_is_dir => {
			// join target_dir/source_file in a platform-independent manner
			let mut path = target
				.display()
				.to_string()
				.trim_end_matches('/')
				.to_owned();

			path.push('/');
			path.push_str(&file_name.to_string_lossy());

			path.quote().to_string()
		},
		_ => target.quote().to_string(),
	};

	if same_file
		&& (canonicalized_source.eq(&canonicalized_target)
			|| source.eq(Path::new("."))
			|| source.ends_with("/.")
			|| filesystem.is_file(&source_abs))
	{
		return Err(MvError::SameFile(source.quote().to_string(), target_display).into());
	} else if (same_file || canonicalized_target.starts_with(&canonicalized_source))
        // don't error if we're moving a symlink of a directory into itself
        && !filesystem.is_symlink(&source_abs)
	{
		return Err(
			MvError::SelfTargetSubdirectory(source.quote().to_string(), target_display).into(),
		);
	}
	Ok(())
}

/// Whether `source` and `target` are hard links to the same file, without
/// following either.
fn are_hardlinks_to_same_file(filesystem: &BlockingFs, source: &Path, target: &Path) -> bool {
	let (Ok(source), Ok(target)) =
		(filesystem.symlink_metadata(source), filesystem.symlink_metadata(target))
	else {
		return false;
	};
	source.same_file(&target)
}

/// Whether `source`, followed, is the same file as `target`, unfollowed: hard
/// links, or a symlink `source` that resolves to `target`.
fn are_hardlinks_or_one_way_symlink_to_same_file(
	filesystem: &BlockingFs,
	source: &Path,
	target: &Path,
) -> bool {
	let (Ok(source), Ok(target)) =
		(filesystem.metadata(source), filesystem.symlink_metadata(target))
	else {
		return false;
	};
	source.same_file(&target)
}

fn handle_multiple_paths(host: &mut Host, paths: &[PathBuf], opts: &Options) -> MvResult<()> {
	if opts.no_target_dir {
		return Err(MvFailure::Message(format!("mv: extra operand {}", paths.last().unwrap().quote()),
		));
	}
	let target_dir = paths.last().unwrap();
	let sources = &paths[..paths.len() - 1];

	move_files_into_dir(host, sources, target_dir, opts)
}

/// Execute the mv command. This moves 'source' to 'target', where
/// 'target' is a directory. If 'target' does not exist, and source is a single
/// file or directory, then 'source' will be renamed to 'target'.
fn mv(host: &mut Host, files: &[OsString], opts: &Options) -> MvResult<()> {
	let paths = parse_paths(files, opts);

	if let Some(name) = &opts.target_dir {
		return move_files_into_dir(host, &paths, &PathBuf::from(name), opts);
	}

	match paths.len() {
		2 => handle_two_paths(host, &paths[0], &paths[1], opts),
		_ => handle_multiple_paths(host, &paths, opts),
	}
}

#[allow(clippy::cognitive_complexity)]
fn move_files_into_dir(host: &mut Host, files: &[PathBuf], target_dir: &Path, options: &Options) -> MvResult<()> {
	// remember the moved destinations for further usage
	let mut moved_destinations: FxHashSet<PathBuf> =
		FxHashSet::with_capacity_and_hasher(files.len(), rustc_hash::FxBuildHasher);
	// Hard links among the moved files survive a move between filesystems.
	let mut copier = MoveCopier::new(options.verbose);

	if !host.fs().is_dir(host.resolve(target_dir)) {
		return Err(MvError::NotADirectory(target_dir.quote().to_string()).into());
	}

	let display_manager = progress_manager(host, options.progress_bar);

	let count_progress = if let Some(display_manager) = &display_manager
		&& files.len() > 1
	{
		Some(
			display_manager.add(
				ProgressBar::new(files.len().try_into().unwrap()).with_style(
					ProgressStyle::with_template(&format!(
						"{} {{msg}} {{wide_bar}} {{pos}}/{{len}}",
						"moving"
					))
					.unwrap(),
				),
			),
		)
	} else {
		None
	};

	for sourcepath in files {
		if host.fs().symlink_metadata(host.resolve(sourcepath)).is_err() {
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		}

		if let Some(pb) = &count_progress {
			let msg = format!("{} (scanning hardlinks)", sourcepath.display());
			pb.set_message(msg);
		}

		let targetpath = if let Some(name) = file_name(sourcepath) {
			child_path(target_dir, &name)
		} else {
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		};

		if moved_destinations.contains(&targetpath) && options.backup != BackupMode::Numbered {
			// If the target file was already created in this mv call, do not overwrite
			show(host, format!(
					"will not overwrite just-created {} with {}",
					targetpath.quote(),
					sourcepath.quote()
				),
			);
			continue;
		}

		// Check if we have mv dir1 dir2 dir2
		// And generate an error if this is the case
		if let Err(e) = assert_not_same_file(host, sourcepath, target_dir, true, options) {
			show(host, e);
			continue;
		}

		match rename(host, sourcepath, &targetpath, options, display_manager.as_ref(), &mut copier) {
			Err(e) if e.to_string().is_empty() => host.fail(1),
			Err(e) => {
				let e = if is_refusal(&e) {
					e.to_string()
				} else {
					format!("cannot move {} to {}: {e}", sourcepath.quote(), targetpath.quote())
				};
				if let Some(pb) = &display_manager {
					pb.suspend(|| show(host, e));
				} else {
					show(host, e);
				}
			},
			Ok(()) => (),
		}
		if let Some(pb) = &count_progress {
			pb.inc(1);
		}
		moved_destinations.insert(targetpath.clone());
	}
	Ok(())
}

fn rename(
	host: &mut Host,
	from: &Path,
	to: &Path,
	opts: &Options,
	display_manager: Option<&MultiProgress>,
	copier: &mut MoveCopier,
) -> io::Result<()> {
	let mut backup = None;

	// filesystem checks; keep `from`/`to` for display.
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	// The destination as `lstat` sees it, as GNU mv sees it: a symlink there
	// is a destination to skip, ask about, compare and back up, even one that
	// points nowhere.
	if let Ok(to_meta) = filesystem.symlink_metadata(&to_fs) {
		if opts.update == UpdateMode::None {
			if opts.debug {
				let _ = writeln!(host.stdout, "skipped {}", to.quote());
			}
			return Ok(());
		}

		// GNU compares the times only for a source that is not a directory,
		// each as `lstat` reports it; a directory goes on to the checks below.
		if opts.update == UpdateMode::IfOlder {
			let from_meta = filesystem.symlink_metadata(&from_fs)?;
			if !from_meta.file_type().is_dir() && from_meta.modified()? <= to_meta.modified()? {
				return Ok(());
			}
		}

		if opts.update == UpdateMode::NoneFail {
			return Err(io::Error::other(format!("not replacing {}", to.quote())));
		}

		match opts.overwrite {
			OverwriteMode::NoClobber => {
				if opts.debug {
					let _ = writeln!(host.stdout, "skipped {}", to.quote());
				}
				return Ok(());
			},
			OverwriteMode::Interactive => prompt_overwrite(host, to, None)?,
			OverwriteMode::Force => {},
			OverwriteMode::Default => {
				// GNU mv prompts when stdin is a TTY and target is not writable
				let (writable, mode) = is_writable(host, to);
				if !writable && stdin_is_terminal(host) {
					prompt_overwrite(host, to, mode)?;
				}
			},
		}

		// The backup would be renamed over a source that is the destination's
		// simple backup, so GNU refuses one in every mode but numbered, where
		// the backup takes a fresh `.~N~` name (`copy.c`, `source_is_dst_backup`).
		// mv reads its source without following it.
		if !matches!(opts.backup, BackupMode::None | BackupMode::Numbered)
			&& source_is_destination_backup(&filesystem, &from_fs, false, &to_fs, &opts.suffix)
		{
			return Err(io::Error::other(MvError::BackupWouldDestroySource(
				to.quote().to_string(),
				from.quote().to_string(),
			)));
		}

		// numbered-backup probing goes through the injected filesystem. GNU mv
		// renames a numbered backup without replacing and fails when an entry
		// holds a long name's `~` fallback; here `backup_path` refuses that
		// name after an lstat (`exclusive`), and the rename below then
		// replaces whatever is there, as a simple backup's does. A backup
		// whose entry is the source's own is refused: the rename would
		// replace the source. Another hard link of the source is another
		// entry and is replaced, as GNU mv replaces it.
		backup = backup_path(&filesystem, opts.backup, &to_fs, &opts.suffix, true)
			.map_err(|_| io::Error::other(MvError::CannotBackup(to.quote().to_string())))?;
		if let Some(backup) = &backup
			&& backup_is_source(&filesystem, &from_fs, false, backup)
		{
			return Err(io::Error::other(MvError::BackupWouldDestroySource(
				to.quote().to_string(),
				from.quote().to_string(),
			)));
		}
		if let Some(backup) = &backup {
			// The existing file is only moved aside: its copy, if any, is
			// neither reported nor linked to the moved files.
			rename_with_fallback(host, to, backup, display_manager, &mut MoveCopier::new(false))?;
		}
	}

	// A directory replaces only a directory, as GNU mv decides before it moves
	// anything. On one file system `rename(2)` refuses any other destination
	// too (`ENOTDIR`), but across file systems it fails with `EXDEV` before it
	// looks at the types, and the copy would remove the file or the link in
	// the directory's place. A backup has moved the destination aside above.
	if filesystem
		.symlink_metadata(&from_fs)
		.is_ok_and(|from| from.file_type().is_dir())
		&& filesystem
			.symlink_metadata(&to_fs)
			.is_ok_and(|to| !to.file_type().is_dir())
	{
		return Err(io::Error::other(MvError::NonDirectoryToDirectory(
			from.quote().to_string(),
			to.quote().to_string(),
		)));
	}

	// "to" may no longer exist if it was backed up
	if filesystem.exists(&to_fs) && filesystem.is_dir(&to_fs) && !filesystem.is_symlink(&to_fs) {
		// normalize behavior between *nix and windows
		if filesystem.is_dir(&from_fs) {
			if is_empty_dir(host, to) {
				filesystem.remove_dir(&to_fs)?;
			} else {
				return Err(io::Error::other("Directory not empty"));
			}
		}
	}

	let report = opts.verbose.then_some(backup.as_deref());
	let copied = match move_entry(host, from, to, display_manager, copier, report) {
		Ok(copied) => copied,
		Err(error) => {
		// The move failed after the destination was backed up: GNU puts the
		// backup back (`un_backup` in copy.c), so the destination keeps its
		// name and data. Where that rename fails too, the move's error comes
		// first and then `cannot un-backup`, as GNU reports them.
		if let Some(backup) = &backup {
			match filesystem.rename(backup, &to_fs) {
				Ok(_) => {
					if opts.verbose {
						let _ = writeln!(
							host.stdout,
							"{} -> {} (unbackup)",
							backup_display(to, backup).quote(),
							to.quote()
						);
					}
				},
				Err(rename_error) => {
					return Err(io::Error::new(
						error.kind(),
						format!(
							"{error}\n{}: cannot un-backup {}: {}",
							Mv::NAME,
							to.quote(),
							crate::host::strip_errno(&rename_error)
						),
					));
				},
			}
		}
			return Err(error);
		},
	};

	// A move between filesystems reported itself as GNU's does: `copied`, then
	// rm's `removed` lines.
	if opts.verbose && !copied {
		let message = if let Some(path) = &backup {
			// rebuild a display path from the operand for the verbose message.
			let backup_display = backup_display(to, path);
			format!("renamed {} -> {} (backup: {})", from.quote(), to.quote(), backup_display.quote())
		} else {
			format!("renamed {} -> {}", from.quote(), to.quote())
		};

		match display_manager {
			Some(pb) => pb.suspend(|| {
				let _ = writeln!(host.stdout, "{message}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{message}");
			},
		}
	}
	Ok(())
}

/// Whether a failed rename crossed devices or filesystem providers, so the
/// move may be completed by copying and removing.
fn crosses_devices(error: &io::Error) -> bool {
	error.kind() == io::ErrorKind::CrossesDevices
}

/// Whether a failed move is one of mv's own refusals ([`MvError`]), whose
/// message names both paths, as GNU's does.
fn is_refusal(error: &io::Error) -> bool {
	error.get_ref().is_some_and(|inner| inner.is::<MvError>())
}

/// A wrapper around `rename`, so that if it fails, we try falling back on
/// copying and removing, with nothing reported. Returns whether the move
/// copied. mv moves an existing file aside to its backup name with it.
fn rename_with_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	copier: &mut MoveCopier,
) -> io::Result<bool> {
	move_entry(host, from, to, display_manager, copier, None)
}

/// [`rename_with_fallback`], reporting a copy under `report` (`-v`, with the
/// backup the move made, if any) as GNU mv reports it: `copied 'from' ->
/// 'to'` before a file's copy, `created directory` and `copied` lines for a
/// directory's, then rm's `removed` lines.
fn move_entry(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	copier: &mut MoveCopier,
	report: Option<Option<&Path>>,
) -> io::Result<bool> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	let Err(err) = filesystem.rename(&from_fs, &to_fs) else {
		return Ok(false);
	};
	// We will only copy if:
	// 1. Files are on different devices or filesystem providers (EXDEV error)
	// 2. On Windows, if the target file exists and source file is opened by another
	//    process (MoveFileExW fails with "Access Denied" even if the source file
	//    has FILE_SHARE_DELETE permission)
	let should_fallback =
		crosses_devices(&err) || (filesystem.is_file(&from_fs) && can_delete_file(host, &from_fs));
	if !should_fallback {
		return Err(err);
	}
	// Get metadata without following symlinks
	let metadata = filesystem.symlink_metadata(&from_fs)?;
	let file_type = metadata.file_type();
	// Copy and unlink failures of a native file other than a link or a pipe
	// keep this port's plain `Permission denied`; the rest report their own
	// error.
	let plain_denial = !(file_type.is_dir() || file_type.is_symlink() || file_type.is_fifo())
		&& filesystem.is_native_local(&from_fs)
		&& filesystem.is_native_local(&to_fs);
	let describe = |err: io::Error| {
		if plain_denial { io::Error::new(err.kind(), "Permission denied") } else { err }
	};

	// The copy replaces the destination as the rename would have: a
	// directory is not merged into, a file is not written through. A
	// directory replaces only a directory: `rename` refused any other
	// destination, and one put there since is refused the same way.
	if file_type.is_dir() {
		match filesystem.symlink_metadata(&to_fs) {
			Ok(to_meta) if to_meta.file_type().is_dir() => remove_moved_tree(host, to, &to_fs)?,
			Ok(_) => {
				return Err(io::Error::other(MvError::NonDirectoryToDirectory(
					from.quote().to_string(),
					to.quote().to_string(),
				)));
			},
			Err(_) => {},
		}
	} else if filesystem.is_symlink(&to_fs) {
		filesystem.remove_file(&to_fs).map_err(|err| {
			let inter_device_msg = format!(
				"inter-device move failed: {} to {}; unable to remove target: {err}",
				from.quote(),
				to.quote()
			);
			io::Error::new(err.kind(), inter_device_msg)
		})?;
	} else if filesystem.exists(&to_fs) {
		filesystem.remove_file(&to_fs)?;
	}

	if let Some(backup) = report
		&& !file_type.is_dir()
	{
		let message = match backup {
			Some(backup) => format!(
				"copied {} -> {} (backup: {})",
				from.quote(),
				to.quote(),
				backup_display(to, backup).quote()
			),
			None => format!("copied {} -> {}", from.quote(), to.quote()),
		};
		match display_manager {
			Some(pb) => pb.suspend(|| {
				let _ = writeln!(host.stdout, "{message}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{message}");
			},
		}
	}
	match copier.copy(host, from, to, metadata, display_manager) {
		Ok(()) => {},
		Err(CpError::IoErr(error) | CpError::IoErrContext(error, _)) => return Err(describe(error)),
		Err(CpError::Error(message) | CpError::Usage(message)) => {
			return Err(describe(io::Error::other(message)));
		},
		// The source stays: some of it was not copied, as already reported.
		Err(CpError::NotAllFilesCopied | CpError::Skipped(_)) => return Err(io::Error::other(Reported)),
	}

	if file_type.is_dir() {
		remove_tree(host, from, &from_fs, report.is_some())?;
	} else {
		filesystem.remove_file(&from_fs).map_err(describe)?;
		if report.is_some() {
			let _ = writeln!(host.stdout, "removed {}", from.quote());
		}
	}
	Ok(true)
}

/// Removes the tree at `path` (resolved: `fs_path`) that a move across
/// filesystems replaces or copied: a symlink is removed itself, and a
/// directory with everything in it. A native Unix tree goes through rm's own
/// descriptor walk ([`crate::rm::remove_moved`]), as GNU mv removes with
/// rm's code: it opens each directory as the one `lstat` found, following no
/// symlink, on every kernel. `std::fs::remove_dir_all` trusts `O_DIRECTORY |
/// O_NOFOLLOW`, which gVisor before release-20261109.0 follows. rm reports
/// its own errors, so a failure here is [`Reported`]. Nothing else is
/// reported: mv removes a replaced destination with it.
fn remove_moved_tree(host: &mut Host, path: &Path, fs_path: &Path) -> io::Result<()> {
	remove_tree(host, path, fs_path, false)
}

/// [`remove_moved_tree`], saying `removed` for each entry of a native tree
/// under `verbose`, as GNU's mv does through rm's code.
fn remove_tree(host: &mut Host, path: &Path, fs_path: &Path, verbose: bool) -> io::Result<()> {
	#[cfg(all(unix, not(target_os = "redox")))]
	if host.fs().is_native_local(fs_path) {
		return if crate::rm::remove_moved(host, path, verbose) { Err(io::Error::other(Reported)) } else { Ok(()) };
	}
	#[cfg(not(all(unix, not(target_os = "redox"))))]
	let _ = (path, verbose);
	host.fs().remove_dir_all(fs_path)
}

fn is_empty_dir(host: &Host, path: &Path) -> bool {
	host.fs()
		.read_dir(host.resolve(path))
		.is_ok_and(|mut contents| contents.next().is_none())
}

/// Check if file is writable, returning the mode for potential reuse.
#[cfg(unix)]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	let path = host.resolve(path);
	// A symlink is writable whatever it points to, as GNU mv's
	// `writable_destination` decides: the move replaces the link itself.
	if host.fs().is_symlink(&path) {
		return (true, None);
	}
	if let Ok(metadata) = host.fs().metadata(path) {
		let mode = metadata.permissions().mode();
		// Check if user write bit is set
		((mode & 0o200) != 0, Some(mode))
	} else {
		(false, None) // If we can't get metadata, prompt user to be safe
	}
}

/// Check if file is writable.
#[cfg(not(unix))]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	let path = host.resolve(path);
	// A symlink is writable whatever it points to, as on Unix.
	if host.fs().is_symlink(&path) {
		return (true, None);
	}
	if let Ok(metadata) = host.fs().metadata(path) {
		(!metadata.permissions().readonly(), None)
	} else {
		(false, None) // If we can't get metadata, prompt user to be safe
	}
}

#[cfg(unix)]
fn get_interactive_prompt(host: &Host, to: &Path, cached_mode: Option<u32>) -> String {
	// Use cached mode if available, otherwise fetch it
	let mode = cached_mode.or_else(|| {
		host.fs()
			.metadata(host.resolve(to))
			.ok()
			.map(|m| m.permissions().mode())
	});
	if let Some(mode) = mode {
		let file_mode = mode & 0o777;
		// Check if file is not writable by user
		if (mode & 0o200) == 0 {
			let perms = display_permissions_unix(mode, false);
			let mode_info = format!("{file_mode:04o} ({perms})");
			return format!("replace {}, overriding mode {mode_info}?", to.quote());
		}
	}
	format!("overwrite {}?", to.quote())
}

#[cfg(not(unix))]
fn get_interactive_prompt(_host: &Host, to: &Path, _cached_mode: Option<u32>) -> String {
	format!("overwrite {}?", to.quote())
}

/// stdin one byte at a time (no buffering) so consecutive prompts don't
/// over-read into a later prompt's input. Returns true when the first character
/// of the line is `y`/`Y`.
fn read_yes(host: &mut Host) -> bool {
	use std::io::Read as _;
	let stdin = &mut host.stdin;
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match stdin.read(&mut buf) {
			Ok(0) => break, // EOF
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

/// we report "not a terminal" and take GNU mv's non-interactive path (overwrite
/// unwritable targets without prompting) instead of blocking on a read that may
/// never receive input. Explicit `-i` still prompts (it does not consult this).
fn stdin_is_terminal(host: &Host) -> bool {
	host.stdin.file().is_terminal()
}

/// Prompts the user for confirmation and returns an error if declined.
fn prompt_overwrite(host: &mut Host, to: &Path, cached_mode: Option<u32>) -> io::Result<()> {
	let prompt = get_interactive_prompt(host, to, cached_mode);
	{
		let err = &mut host.stderr;
		let _ = write!(err, "mv: {prompt} ");
		let _ = err.flush();
	}
	if !read_yes(host) {
		return Err(io::Error::other(Reported));
	}
	Ok(())
}

/// Checks if a file can be deleted by attempting to open it with delete
/// permissions.
#[cfg(windows)]
fn can_delete_file(host: &Host, path: &Path) -> bool {
	use std::{
		os::windows::ffi::OsStrExt as _,
		ptr::{null, null_mut},
	};

	use windows_sys::Win32::{
		Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
		Storage::FileSystem::{
			CreateFileW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
			FILE_SHARE_WRITE, OPEN_EXISTING,
		},
	};

	let resolved = host.resolve(path);
	// Only native host files have a Win32 handle to probe.
	if !host.fs().is_native_local(&resolved) {
		return false;
	}
	let wide_path = resolved
		.as_os_str()
		.encode_wide()
		.chain([0])
		.collect::<Vec<u16>>();

	let handle = unsafe {
		CreateFileW(
			wide_path.as_ptr(),
			DELETE,
			FILE_SHARE_DELETE | FILE_SHARE_READ | FILE_SHARE_WRITE,
			null(),
			OPEN_EXISTING,
			FILE_ATTRIBUTE_NORMAL,
			null_mut(),
		)
	};

	if handle == INVALID_HANDLE_VALUE {
		return false;
	}

	unsafe { CloseHandle(handle) };

	true
}

#[cfg(not(windows))]
fn can_delete_file(_host: &Host, _: &Path) -> bool {
	// On non-Windows platforms, always return false to indicate that we don't need
	// to try the copy+delete fallback. This is because on Unix-like systems,
	// rename failing with errors other than EXDEV means the operation cannot
	// succeed even with a copy+delete approach (e.g. permission errors).
	false
}

#[cfg(test)]
mod tests {
	use std::{env, fs};

	use clap::Parser;

	use tempfile::tempdir;

	use super::Mv;
	#[cfg(unix)]
	use crate::host::run_util_on;
	use crate::host::{Host, Utility, run_util};

	#[test]
	fn relative_rename_uses_host_working_directory() {
		let fixture = tempdir().unwrap();
		assert_ne!(env::current_dir().unwrap(), fixture.path());
		fs::write(fixture.path().join("source"), b"payload").unwrap();

		let (code, capture) = run_util::<Mv>(&["source", "target"], "", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("source").exists());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"payload");
	}

	#[test]
	fn interactive_decline_preserves_destination() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Mv>(&["-i", "source", "target"], "n\n", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(fs::read(fixture.path().join("source")).unwrap(), b"new");
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"old");
		// GNU's prompt, and nothing after it: the answer is the user's.
		assert_eq!(capture.err(), "mv: overwrite 'target'? ");
	}

	#[test]
	fn interactive_accept_replaces_destination() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Mv>(&["-i", "source", "target"], "y\n", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("source").exists());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"new");
	}

	#[test]
	fn backup_configuration_uses_host_environment() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();
		let (mut host, capture) = Host::for_test("mv", "", fixture.path());
		host.set_test_var("VERSION_CONTROL", "simple");
		host.set_test_var("SIMPLE_BACKUP_SUFFIX", ".old");
		let parsed = Mv::try_parse_from(["mv", "-b", "source", "target"]).unwrap();

		let code = parsed.run(&mut host);

		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"new");
		assert_eq!(fs::read(fixture.path().join("target.old")).unwrap(), b"old");
	}

	#[test]
	fn missing_source_reports_original_operand() {
		let fixture = tempdir().unwrap();
		let (code, capture) = run_util::<Mv>(&["missing", "target"], "", fixture.path());
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "mv: cannot stat 'missing': No such file or directory\n");
	}

	/// The removal that ends a directory move across filesystems goes, on a
	/// native path, through rm's walk, which keeps only the directory it
	/// stat'd: `mv-seam-tree/sub`, replaced by another real directory at rm's
	/// seam just before its open, is refused, and that directory's file
	/// stays. The kernel refuses nothing here, so this holds on Linux too.
	/// `std::fs::remove_dir_all` would never reach rm's seam. The seam is
	/// keyed by the walk's relative path, so no other test walks a tree of
	/// this name: under `cargo test`, tests share the seam's hooks.
	#[cfg(unix)]
	#[test]
	fn the_moved_tree_removal_keeps_a_directory_swapped_in_after_its_stat() {
		use std::sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		};
		const TREE: &str = "mv-seam-tree";
		let cwd = tempdir().unwrap();
		let (tree, other) = (cwd.path().join(TREE), cwd.path().join("other"));
		fs::create_dir_all(tree.join("sub")).unwrap();
		fs::write(tree.join("sub/in"), b"").unwrap();
		fs::create_dir(&other).unwrap();
		fs::write(other.join("kept"), b"").unwrap();
		let swapped = Arc::new(AtomicBool::new(false));
		let (sub, parked, other_dir, seen) =
			(tree.join("sub"), cwd.path().join("parked"), other.clone(), Arc::clone(&swapped));
		crate::host::hook_at(std::path::Path::new(TREE).join("sub"), move || {
			fs::rename(&sub, &parked).unwrap();
			fs::rename(&other_dir, &sub).unwrap();
			seen.store(true, Ordering::SeqCst);
		});
		let (mut host, _capture) = Host::for_test(Mv::NAME, "", cwd.path());
		let removed = super::remove_moved_tree(&mut host, std::path::Path::new(TREE), &tree);
		assert!(swapped.load(Ordering::SeqCst), "the removal did not go through rm's walk");
		assert!(tree.join("sub/kept").exists(), "removed a directory that was not the one it stat'd");
		assert!(removed.is_err(), "a refused directory was reported as removed");
	}

	/// The removal that ends a directory move across filesystems deletes
	/// nothing outside the moved tree while `tree/sub` flips between a
	/// directory and a symlink to `outside/`, 2,000 times. gVisor before
	/// release-20261109.0 follows a final symlink to a directory despite
	/// `O_NOFOLLOW` when `O_DIRECTORY` is set (google/gvisor#14786), the
	/// flags with which `std::fs::remove_dir_all` opens each directory.
	#[cfg(unix)]
	fn moved_tree_removal_through_a_swapped_directory(piece: usize) {
		use std::sync::atomic::{AtomicBool, Ordering};
		/// As `rm`'s swapping tests: the runs are split so the run reports.
		const SWAP_PIECES: usize = 4;
		const RUNS: usize = 2_000;
		let runs = RUNS / SWAP_PIECES;
		let mut escapes = 0;
		for _ in 0..runs {
			let cwd = tempdir().unwrap();
			let (tree, parked, outside) =
				(cwd.path().join("tree"), cwd.path().join("parked"), cwd.path().join("outside"));
			let sub = tree.join("sub");
			fs::create_dir_all(&sub).unwrap();
			fs::create_dir_all(&outside).unwrap();
			for i in 0..4 {
				fs::write(sub.join(format!("in{i}")), b"").unwrap();
				fs::write(outside.join(format!("victim{i}")), b"").unwrap();
			}
			let stop = AtomicBool::new(false);
			std::thread::scope(|scope| {
				scope.spawn(|| {
					while !stop.load(Ordering::Relaxed) {
						if fs::rename(&sub, &parked).is_err() {
							std::thread::yield_now();
							continue;
						}
						let _ = std::os::unix::fs::symlink(&outside, &sub);
						for _ in 0..50 {
							std::hint::spin_loop();
						}
						let _ = fs::remove_file(&sub);
						let _ = fs::rename(&parked, &sub);
					}
				});
				let (mut host, _capture) = Host::for_test(Mv::NAME, "", cwd.path());
				let _ = super::remove_moved_tree(&mut host, std::path::Path::new("tree"), &tree);
				stop.store(true, Ordering::Relaxed);
			});
			if (0..4).any(|i| !outside.join(format!("victim{i}")).exists()) {
				escapes += 1;
			}
		}
		eprintln!(
			"piece {} of {}, {runs} of {RUNS} runs swapping tree/sub: {escapes} removed a file outside the tree",
			piece + 1,
			SWAP_PIECES
		);
		assert_eq!(escapes, 0, "the moved tree's removal went outside it through a swapped symlink");
	}
	#[cfg(unix)]
	#[test]
	fn the_moved_tree_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_1() {
		moved_tree_removal_through_a_swapped_directory(0);
	}

	#[cfg(unix)]
	#[test]
	fn the_moved_tree_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_2() {
		moved_tree_removal_through_a_swapped_directory(1);
	}

	#[cfg(unix)]
	#[test]
	fn the_moved_tree_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_3() {
		moved_tree_removal_through_a_swapped_directory(2);
	}

	#[cfg(unix)]
	#[test]
	fn the_moved_tree_removal_deletes_nothing_through_a_directory_swapped_for_a_symlink_4() {
		moved_tree_removal_through_a_swapped_directory(3);
	}

	/// `mv` to another file system copies, then removes the source: a tree
	/// deeper than the open-file limit moves whole (100 levels under a limit of
	/// 32, from /dev/shm to the temporary directory). In a process of its own,
	/// since the limit belongs to the whole process. It needs the two to be
	/// different file systems, which is decided before the process starts.
	#[cfg(target_os = "linux")]
	#[test]
	fn moves_a_tree_deeper_than_the_descriptor_limit_to_another_file_system() {
		use std::os::unix::fs::MetadataExt as _;

		use crate::deep_tree::{RemoveTree, assert_file_chain, file_chain, limit_descriptors};

		let device = |path: &std::path::Path| fs::metadata(path).map(|metadata| metadata.dev());
		match (device("/dev/shm".as_ref()), device(&crate::deep_tree::temp_root())) {
			(Ok(shm), Ok(temp)) if shm != temp => {},
			(shm, temp) => {
				eprintln!("skipped: /dev/shm ({shm:?}) and the temporary directory ({temp:?}) are not two file systems");
				return;
			},
		}
		if !crate::own_process::own_process() {
			return;
		}
		let from = tempfile::tempdir_in("/dev/shm").unwrap();
		let to = crate::deep_tree::tempdir();
		let src = from.path().join("src");
		let dst = to.path().join("dst");
		let _trees = [RemoveTree(src.clone()), RemoveTree(dst.clone())];
		file_chain(&src, 100);
		limit_descriptors(32);
		let (code, capture) = run_util::<Mv>(&[src.to_str().unwrap(), dst.to_str().unwrap()], "", to.path());
		assert_eq!((code, capture.err().as_str()), (0, ""));
		assert!(!src.exists(), "the source is gone");
		assert_file_chain(&dst, 100);
	}

	/// A directory moved into a directory that holds a regular file, or a
	/// symlink to a directory, at its name is refused as GNU mv 9.4 refuses it,
	/// with exit status 1, and the file and the link stay. On one file system
	/// `rename(2)` refuses it too (`ENOTDIR`).
	#[cfg(unix)]
	#[test]
	fn a_directory_does_not_replace_a_non_directory() {
		let cwd = tempdir().unwrap();
		refuses_to_replace_non_directories(cwd.path(), cwd.path());
	}

	/// The same from /dev/shm to the temporary directory, two file systems:
	/// there `rename(2)` fails with `EXDEV` before it looks at the types, and
	/// the move removed the file or the link to copy the directory in its
	/// place.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_directory_moved_across_file_systems_does_not_replace_a_non_directory() {
		use std::os::unix::fs::MetadataExt as _;

		let device = |path: &std::path::Path| fs::metadata(path).map(|metadata| metadata.dev());
		match (device("/dev/shm".as_ref()), device(&env::temp_dir())) {
			(Ok(shm), Ok(temp)) if shm != temp => {},
			(shm, temp) => {
				eprintln!("skipped: /dev/shm ({shm:?}) and the temporary directory ({temp:?}) are not two file systems");
				return;
			},
		}
		let from = tempfile::tempdir_in("/dev/shm").unwrap();
		let to = tempdir().unwrap();
		refuses_to_replace_non_directories(from.path(), to.path());
		// The copy fallback refuses on its own too: a non-directory put at
		// the destination after the move's check is not removed.
		let (mut host, _capture) = Host::for_test(Mv::NAME, "", to.path());
		let (src, dest) = (from.path().join("src"), to.path().join("file-dest/src"));
		let err = super::rename_with_fallback(
			&mut host,
			&src,
			&dest,
			None,
			&mut crate::cp::MoveCopier::new(false),
		)
		.expect_err("the copy fallback replaced a regular file with a directory");
		assert!(err.to_string().starts_with("cannot overwrite non-directory"), "{err}");
		assert_eq!(fs::read(&dest).unwrap(), b"kept", "the fallback removed the file");
		assert_eq!(fs::read(src.join("moved")).unwrap(), b"moved", "the source changed");
	}

	/// `mv -b` across file systems from a source it cannot read, as GNU mv
	/// 9.4 does as uid 1000: the copy fails ("cannot open ... for reading"),
	/// and the backup is put back (`un_backup`), so `b` keeps its name and data
	/// and no backup is left; `-v` says `'b~' -> 'b' (unbackup)`. Root reads
	/// a file of mode 000, so the test runs only as another user.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_failed_move_across_file_systems_puts_the_backup_back() {
		use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

		// SAFETY: `geteuid` has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			eprintln!("skipped: root reads a file of mode 000");
			return;
		}
		let device = |path: &std::path::Path| fs::metadata(path).map(|metadata| metadata.dev());
		match (device("/dev/shm".as_ref()), device(&env::temp_dir())) {
			(Ok(shm), Ok(temp)) if shm != temp => {},
			(shm, temp) => {
				eprintln!("skipped: /dev/shm ({shm:?}) and the temporary directory ({temp:?}) are not two file systems");
				return;
			},
		}
		for (flags, backup, verbose) in [
			(&["-b"][..], "b~", ""),
			(&["--backup=numbered"][..], "b.~1~", ""),
			(&["-v", "-b"][..], "b~", "'b~' -> 'b' (unbackup)\n"),
		] {
			let from = tempfile::tempdir_in("/dev/shm").unwrap();
			let to = tempdir().unwrap();
			let source = from.path().join("a");
			fs::write(&source, b"A").unwrap();
			fs::set_permissions(&source, fs::Permissions::from_mode(0o000)).unwrap();
			fs::write(to.path().join("b"), b"old").unwrap();
			let mut argv = flags.to_vec();
			argv.extend([source.to_str().unwrap(), "b"]);
			let (code, capture) = run_util::<Mv>(&argv, "", to.path());
			let case = flags.join(" ");
			assert_eq!(code, 1, "{case}: {:?}", capture.err());
			assert!(capture.err().contains("Permission denied"), "{case}: {:?}", capture.err());
			assert!(capture.out().ends_with(verbose), "{case}: {:?}", capture.out());
			assert_eq!(fs::read(to.path().join("b")).ok().as_deref(), Some(&b"old"[..]), "{case}: b lost its data");
			assert!(!to.path().join(backup).exists(), "{case}: b is left under its backup name");
			assert!(source.exists(), "{case}: the source is gone");
			fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
		}
	}

	/// A link that leads nowhere at the destination, as GNU 9.7 treats it as
	/// uid 1000 and as root: `mv -b l b` keeps it as `b~`, `-n` keeps it and
	/// exits 0, and `-i` answered no keeps it and exits 1, with nothing after
	/// the prompt.
	#[cfg(unix)]
	#[test]
	fn a_link_to_nothing_at_the_destination_is_kept_as_gnu_does() {
		type Row = (&'static [&'static str], &'static str, i32, &'static str, &'static str, Option<&'static str>);
		let rows: [Row; 3] = [
			(&["-b"], "", 0, "", "a", Some("missing")),
			(&["-n"], "", 0, "", "missing", None),
			(&["-i"], "n\n", 1, "mv: overwrite 'b'? ", "missing", None),
		];
		for (flags, stdin, code, err, b, backup) in rows {
			let dir = tempdir().unwrap();
			fs::write(dir.path().join("a"), b"A").unwrap();
			std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
			std::os::unix::fs::symlink("missing", dir.path().join("b")).unwrap();
			let mut args = flags.to_vec();
			args.extend(["l", "b"]);
			let (got, capture) = run_util::<Mv>(&args, stdin, dir.path());
			let case = format!("mv {}, b a link to nothing", args.join(" "));
			assert_eq!((got, capture.err()), (code, err.to_owned()), "{case}");
			assert_eq!(fs::read_link(dir.path().join("b")).unwrap(), std::path::Path::new(b), "{case}: b");
			assert_eq!(
				fs::read_link(dir.path().join("b~")).ok(),
				backup.map(std::path::PathBuf::from),
				"{case}: the backup"
			);
		}
	}

	/// `mv -T` of a non-directory onto a directory is refused with GNU 9.7's
	/// message, which names the source too (9.4's did not), and both stay.
	#[cfg(unix)]
	#[test]
	fn a_non_directory_moved_onto_a_directory_under_t_is_refused_as_gnu_does() {
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("a"), b"A").unwrap();
		std::os::unix::fs::symlink("a", dir.path().join("l")).unwrap();
		fs::create_dir(dir.path().join("b")).unwrap();
		fs::write(dir.path().join("b/x"), b"X").unwrap();
		for source in ["l", "a"] {
			let (code, capture) = run_util::<Mv>(&["-T", source, "b"], "", dir.path());
			assert_eq!(
				(code, capture.err()),
				(1, format!("mv: cannot overwrite directory 'b' with non-directory '{source}'\n")),
				"mv -T {source} b"
			);
			assert!(fs::symlink_metadata(dir.path().join(source)).is_ok(), "mv -T {source} b: the source is gone");
			assert_eq!(fs::read(dir.path().join("b/x")).unwrap(), b"X", "mv -T {source} b: b changed");
		}
	}

	/// `mv -v` between file systems says what GNU 9.4 and 9.7 say, as uid
	/// 1000 and as root: `copied 'a' -> 'b'` (with the backup, if any), then
	/// `removed 'a'`, for a file; for a directory, `created directory` for
	/// it and each directory in it, `copied` for every other entry, in the
	/// order GNU copies them (by inode number), then rm's `removed` lines.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_move_across_file_systems_is_reported_as_gnu_does() {
		use std::os::unix::fs::MetadataExt as _;

		let device = |path: &std::path::Path| fs::metadata(path).map(|metadata| metadata.dev());
		match (device("/dev/shm".as_ref()), device(&env::temp_dir())) {
			(Ok(shm), Ok(temp)) if shm != temp => {},
			(shm, temp) => {
				eprintln!("skipped: /dev/shm ({shm:?}) and the temporary directory ({temp:?}) are not two file systems");
				return;
			},
		}
		for backup in [false, true] {
			let from = tempfile::tempdir_in("/dev/shm").unwrap();
			let to = tempdir().unwrap();
			let source = from.path().join("a");
			fs::write(&source, b"A").unwrap();
			if backup {
				fs::write(to.path().join("b"), b"old").unwrap();
			}
			let shown = source.display().to_string();
			let mut args = vec!["-v"];
			args.extend(backup.then_some("-b"));
			args.extend([shown.as_str(), "b"]);
			let (code, capture) = run_util::<Mv>(&args, "", to.path());
			let note = if backup { " (backup: 'b~')" } else { "" };
			assert_eq!(
				(code, capture.err(), capture.out()),
				(0, String::new(), format!("copied '{shown}' -> 'b'{note}\nremoved '{shown}'\n")),
				"mv {}",
				args.join(" ")
			);
		}
		let from = tempfile::tempdir_in("/dev/shm").unwrap();
		let to = tempdir().unwrap();
		let d = from.path().join("d");
		fs::create_dir(&d).unwrap();
		fs::write(d.join("x"), b"X").unwrap();
		fs::create_dir(d.join("e")).unwrap();
		fs::write(d.join("e/y"), b"Y").unwrap();
		std::os::unix::fs::symlink("x", d.join("l")).unwrap();
		let shown = d.display().to_string();
		// GNU copies a directory's entries by inode number (`savedir` sorts
		// them), and reports each directory as created before what is in it.
		let mut entries: Vec<_> = ["x", "e", "l"]
			.into_iter()
			.map(|name| (fs::symlink_metadata(d.join(name)).unwrap().ino(), name))
			.collect();
		entries.sort_unstable();
		let mut expected = vec!["created directory 'd'".to_owned()];
		for (_, name) in entries {
			if name == "e" {
				expected.push("created directory 'd/e'".to_owned());
				expected.push(format!("copied '{shown}/e/y' -> 'd/e/y'"));
			} else {
				expected.push(format!("copied '{shown}/{name}' -> 'd/{name}'"));
			}
		}
		let (code, capture) = run_util::<Mv>(&["-v", shown.as_str(), "d"], "", to.path());
		assert_eq!((code, capture.err()), (0, String::new()), "mv -v {shown} d");
		let out = capture.out();
		let lines: Vec<_> = out.lines().collect();
		let copied: Vec<_> = lines
			.iter()
			.filter(|line| line.starts_with("copied ") || line.starts_with("created directory "))
			.map(|line| (*line).to_owned())
			.collect();
		let removed: Vec<_> = lines.iter().filter(|line| line.starts_with("removed ")).copied().collect();
		assert_eq!(copied.len() + removed.len(), lines.len(), "{out}");
		assert_eq!(copied, expected, "{out}");
		let mut sorted_removed = removed.clone();
		sorted_removed.sort_unstable();
		assert_eq!(
			sorted_removed,
			[
				"removed '<D>/e/y'".replace("<D>", &shown),
				"removed '<D>/l'".replace("<D>", &shown),
				"removed '<D>/x'".replace("<D>", &shown),
				"removed directory '<D>'".replace("<D>", &shown),
				"removed directory '<D>/e'".replace("<D>", &shown),
			],
			"{out}"
		);
		assert_eq!(removed.last(), Some(&format!("removed directory '{shown}'").as_str()), "{out}");
		assert!(lines.iter().position(|line| line.starts_with("removed ")) > Some(copied.len() - 1), "{out}");
	}

	/// Moves `from/src`, a directory, into `to/file-dest`, which holds a
	/// regular file `src`, and into `to/link-dest`, which holds a symlink `src`
	/// to a directory: each move must fail with GNU's message and leave both
	/// sides as they were.
	#[cfg(unix)]
	fn refuses_to_replace_non_directories(from: &std::path::Path, to: &std::path::Path) {
		let src = from.join("src");
		fs::create_dir(&src).unwrap();
		fs::write(src.join("moved"), b"moved").unwrap();
		fs::create_dir_all(to.join("file-dest")).unwrap();
		fs::write(to.join("file-dest/src"), b"kept").unwrap();
		fs::create_dir_all(to.join("link-dest")).unwrap();
		fs::create_dir(to.join("elsewhere")).unwrap();
		std::os::unix::fs::symlink(to.join("elsewhere"), to.join("link-dest/src")).unwrap();
		for dest in ["file-dest", "link-dest"] {
			let target = to.join(dest);
			let (code, capture) =
				run_util::<Mv>(&[src.to_str().unwrap(), target.to_str().unwrap()], "", to);
			assert_eq!(
				(code, capture.err()),
				(
					1,
					format!(
						"mv: cannot overwrite non-directory '{}' with directory '{}'\n",
						target.join("src").display(),
						src.display()
					)
				),
				"{dest}"
			);
			assert_eq!(fs::read(src.join("moved")).unwrap(), b"moved", "{dest}: the source changed");
		}
		assert_eq!(fs::read(to.join("file-dest/src")).unwrap(), b"kept", "the file was replaced");
		assert_eq!(
			fs::read_link(to.join("link-dest/src")).unwrap(),
			to.join("elsewhere"),
			"the link was replaced"
		);
		assert!(!to.join("elsewhere/moved").exists(), "the move went through the link");
	}

	/// Runs `mv` with `args` and `stdin` in `dir`, returning the exit status
	/// and standard error.
	#[cfg(unix)]
	fn mv_in(dir: &std::path::Path, args: &[&str], stdin: &str) -> (i32, String) {
		let (code, capture) = run_util::<Mv>(args, stdin, dir);
		(code, capture.err())
	}

	/// Where a symlink to nothing is the destination's name.
	#[cfg(unix)]
	fn dangling(path: &std::path::Path) {
		std::os::unix::fs::symlink("missing", path).unwrap();
	}

	/// The link at `path`, if it is one.
	#[cfg(unix)]
	fn link_at(path: &std::path::Path) -> Option<std::path::PathBuf> {
		fs::read_link(path).ok()
	}

	/// A symlink at the destination's name is a destination, even one that
	/// points nowhere: GNU mv looks at the destination without following a
	/// symlink there. Each expectation is GNU coreutils 9.7's, checked against
	/// it and 9.4 in the same runs; `-n` is 9.5's and later (a silent skip
	/// with status 0), as this port's `-n` is for any destination.
	#[cfg(unix)]
	#[test]
	fn a_dangling_link_at_the_destination_is_a_destination() {
		let cwd = tempdir().unwrap();
		let case = |name: &str| {
			let dir = cwd.path().join(name);
			fs::create_dir_all(dir.join("src")).unwrap();
			fs::write(dir.join("src/moved"), b"moved").unwrap();
			fs::create_dir(dir.join("dd")).unwrap();
			dangling(&dir.join("dd/src"));
			dir
		};

		// --backup: the link is moved aside, as any destination is, and the
		// directory takes its name.
		let dir = case("backup");
		assert_eq!(mv_in(&dir, &["--backup=simple", "src", "dd"], ""), (0, String::new()), "backup");
		assert_eq!(link_at(&dir.join("dd/src~")), Some("missing".into()), "backup: the link was not backed up");
		assert_eq!(fs::read(dir.join("dd/src/moved")).unwrap(), b"moved", "backup: the directory did not move");

		// -n: the destination exists, so nothing is moved.
		let dir = case("no-clobber");
		assert_eq!(mv_in(&dir, &["-n", "src", "dd"], ""), (0, String::new()), "-n");
		assert_eq!(link_at(&dir.join("dd/src")), Some("missing".into()), "-n: the link was replaced");
		assert!(dir.join("src/moved").exists(), "-n: the source moved");

		// --update=none: the same.
		let dir = case("update-none");
		assert_eq!(mv_in(&dir, &["--update=none", "src", "dd"], ""), (0, String::new()), "--update=none");
		assert_eq!(link_at(&dir.join("dd/src")), Some("missing".into()), "--update=none: the link was replaced");

		// -i: the link is a destination to ask about; declining keeps it.
		let dir = cwd.path().join("interactive");
		fs::create_dir_all(dir.join("dd")).unwrap();
		fs::write(dir.join("src"), b"src").unwrap();
		dangling(&dir.join("dd/src"));
		assert_eq!(
			mv_in(&dir, &["-i", "src", "dd"], "n\n"),
			(1, "mv: overwrite 'dd/src'? ".to_owned()),
			"-i: no prompt for the link"
		);
		assert_eq!(link_at(&dir.join("dd/src")), Some("missing".into()), "-i: the link was replaced");
		assert_eq!(fs::read(dir.join("src")).unwrap(), b"src", "-i: the source moved");

		// -u: the link's own time is the destination's; it is newer than
		// the source, so nothing is moved.
		let dir = cwd.path().join("update-older");
		fs::create_dir_all(dir.join("dd")).unwrap();
		fs::write(dir.join("src"), b"src").unwrap();
		fs::File::options()
			.write(true)
			.open(dir.join("src"))
			.unwrap()
			.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000))
			.unwrap();
		dangling(&dir.join("dd/src"));
		assert_eq!(mv_in(&dir, &["-u", "src", "dd"], ""), (0, String::new()), "-u");
		assert_eq!(link_at(&dir.join("dd/src")), Some("missing".into()), "-u: the link was replaced");
		assert_eq!(fs::read(dir.join("src")).unwrap(), b"src", "-u: the source moved");

		// With neither, a directory does not replace the link (the control:
		// this held before).
		let dir = case("plain");
		assert_eq!(
			mv_in(&dir, &["src", "dd"], ""),
			(1, "mv: cannot overwrite non-directory 'dd/src' with directory 'src'\n".to_owned()),
			"plain"
		);
		assert_eq!(link_at(&dir.join("dd/src")), Some("missing".into()), "plain: the link was replaced");

		// Without -i, a destination the user cannot write to is asked about
		// when stdin is a terminal, but a link is writable whatever it points
		// to, as GNU's `writable_destination` decides: a dangling link here
		// would otherwise be asked about, which GNU never does.
		let (host, _capture) = Host::for_test(Mv::NAME, "", &dir);
		assert_eq!(
			super::is_writable(&host, std::path::Path::new("dd/src")),
			(true, None),
			"the link is not writable"
		);
	}

	/// `-u` does not skip a directory, whatever the destination's time: GNU
	/// compares times only for a source that is not a directory, so a
	/// directory moved onto a newer regular file is refused, not skipped.
	#[cfg(unix)]
	#[test]
	fn update_older_does_not_skip_a_directory() {
		let cwd = tempdir().unwrap();
		fs::create_dir_all(cwd.path().join("src")).unwrap();
		fs::create_dir(cwd.path().join("dd")).unwrap();
		fs::write(cwd.path().join("dd/src"), b"kept").unwrap();
		std::fs::File::open(cwd.path().join("src"))
			.unwrap()
			.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000))
			.unwrap();
		assert_eq!(
			mv_in(cwd.path(), &["-u", "src", "dd"], ""),
			(1, "mv: cannot overwrite non-directory 'dd/src' with directory 'src'\n".to_owned())
		);
		assert_eq!(fs::read(cwd.path().join("dd/src")).unwrap(), b"kept");
		assert!(cwd.path().join("src").is_dir());
	}

	/// With two operands, a directory moved onto a regular file or a symlink
	/// is refused unless the destination is backed up (`-b`), as GNU mv
	/// allows: then the destination is moved aside and the directory takes
	/// its name. `--update=none` skips it with status 0.
	#[cfg(unix)]
	#[test]
	fn a_directory_replaces_a_non_directory_operand_only_with_a_backup() {
		let cwd = tempdir().unwrap();
		let case = |name: &str, link: bool| {
			let dir = cwd.path().join(name);
			fs::create_dir_all(dir.join("src")).unwrap();
			fs::write(dir.join("src/moved"), b"moved").unwrap();
			if link {
				dangling(&dir.join("dest"));
			} else {
				fs::write(dir.join("dest"), b"kept").unwrap();
			}
			dir
		};

		let dir = case("file-backup", false);
		assert_eq!(mv_in(&dir, &["-b", "src", "dest"], ""), (0, String::new()), "-b onto a file");
		assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"kept", "-b onto a file: no backup");
		assert_eq!(fs::read(dir.join("dest/moved")).unwrap(), b"moved", "-b onto a file: not moved");

		let dir = case("link-backup", true);
		assert_eq!(mv_in(&dir, &["-b", "src", "dest"], ""), (0, String::new()), "-b onto a link");
		assert_eq!(link_at(&dir.join("dest~")), Some("missing".into()), "-b onto a link: no backup");
		assert_eq!(fs::read(dir.join("dest/moved")).unwrap(), b"moved", "-b onto a link: not moved");

		let dir = case("file-update-none", false);
		assert_eq!(mv_in(&dir, &["--update=none", "src", "dest"], ""), (0, String::new()), "--update=none");
		assert_eq!(fs::read(dir.join("dest")).unwrap(), b"kept", "--update=none: replaced");

		// The controls: without a backup each is refused, as before.
		for (name, link) in [("file", false), ("link", true)] {
			let dir = case(name, link);
			assert_eq!(
				mv_in(&dir, &["src", "dest"], ""),
				(1, "mv: cannot overwrite non-directory 'dest' with directory 'src'\n".to_owned()),
				"{name}"
			);
			assert!(dir.join("src/moved").exists(), "{name}: the source moved");
		}
	}

	/// `mv --backup` never makes its numbered backup over an entry already
	/// at a backup name, a symlink that points nowhere included, and numbers
	/// after the highest one, as GNU mv does
	/// ([`crate::file_backup::tests::check_numbered_backups`]).
	#[cfg(unix)]
	#[test]
	fn numbered_backups_count_every_entry_at_a_backup_name() {
		crate::file_backup::tests::check_numbered_backups(|dir, control| {
			let (code, capture) = run_util::<Mv>(&[&format!("--backup={control}"), "src", "dest"], "", dir);
			(code, capture.err())
		});
	}

	/// A source that is the destination's simple backup (`dest~` for `dest`,
	/// by name and as the same file) is not moved over the destination when
	/// a backup is to be made in any mode but `numbered`: the backup would be
	/// renamed over the source first. GNU mv refuses with "backing up 'dest'
	/// might destroy source;  'dest~' not moved", status 1, also when `dest`
	/// is a symlink that points nowhere, and also for `./dest~`; `numbered`
	/// backs `dest` up as `dest.~1~` and moves. A `dest~` elsewhere is
	/// another file, and moves. Each answer is GNU coreutils 9.4's and 9.7's.
	#[cfg(unix)]
	#[test]
	fn a_source_that_is_the_destinations_simple_backup_is_not_moved_over_it() {
		let cwd = tempdir().unwrap();
		let case = |name: &str, dest: Option<bool>| {
			let dir = cwd.path().join(name);
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("dest~"), b"payload").unwrap();
			match dest {
				Some(true) => dangling(&dir.join("dest")),
				Some(false) => fs::write(dir.join("dest"), b"old").unwrap(),
				None => {},
			}
			dir
		};
		let refused = |source: &str| {
			(1, format!("mv: backing up 'dest' might destroy source;  '{source}' not moved\n"))
		};
		for control in ["--backup=simple", "--backup=existing", "-b"] {
			for link in [true, false] {
				let what = format!("{control} onto a {}", if link { "dangling link" } else { "file" });
				let dir = case(&format!("{}-{link}", control.trim_start_matches('-')), Some(link));
				assert_eq!(mv_in(&dir, &[control, "dest~", "dest"], ""), refused("dest~"), "{what}");
				assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"payload", "{what}: the source was lost");
				if link {
					assert_eq!(link_at(&dir.join("dest")), Some("missing".into()), "{what}: dest replaced");
				} else {
					assert_eq!(fs::read(dir.join("dest")).unwrap(), b"old", "{what}: dest replaced");
				}
			}
		}
		let dir = case("dot-slash", Some(false));
		assert_eq!(mv_in(&dir, &["-b", "./dest~", "dest"], ""), refused("./dest~"), "./dest~");
		assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"payload", "./dest~: the source was lost");

		// The controls: numbered backups, no destination, a `dest~` elsewhere.
		for link in [true, false] {
			let dir = case(&format!("numbered-{link}"), Some(link));
			assert_eq!(mv_in(&dir, &["--backup=numbered", "dest~", "dest"], ""), (0, String::new()));
			assert_eq!(fs::read(dir.join("dest")).unwrap(), b"payload", "numbered: not moved");
			if link {
				assert_eq!(link_at(&dir.join("dest.~1~")), Some("missing".into()), "numbered: no backup");
			} else {
				assert_eq!(fs::read(dir.join("dest.~1~")).unwrap(), b"old", "numbered: no backup");
			}
		}
		let dir = case("no-dest", None);
		assert_eq!(mv_in(&dir, &["-b", "dest~", "dest"], ""), (0, String::new()), "no dest");
		assert_eq!(fs::read(dir.join("dest")).unwrap(), b"payload", "no dest: not moved");
		let dir = cwd.path().join("elsewhere");
		fs::create_dir_all(dir.join("s")).unwrap();
		fs::write(dir.join("s/dest~"), b"payload").unwrap();
		fs::write(dir.join("dest"), b"old").unwrap();
		assert_eq!(mv_in(&dir, &["-b", "s/dest~", "dest"], ""), (0, String::new()), "elsewhere");
		assert_eq!(fs::read(dir.join("dest")).unwrap(), b"payload", "elsewhere: not moved");
		assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"old", "elsewhere: no backup");
	}

	/// `-u` compares the source's own time, as `lstat` reports it: a source
	/// symlink older than the destination is not moved, though the file it
	/// points to is newer, as GNU mv decides.
	#[cfg(unix)]
	#[test]
	fn update_older_compares_a_source_links_own_time() {
		let cwd = tempdir().unwrap();
		let at = |secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
		let target = cwd.path().join("target");
		fs::write(&target, b"target").unwrap();
		std::os::unix::fs::symlink("target", cwd.path().join("src")).unwrap();
		fs::write(cwd.path().join("dest"), b"old").unwrap();
		// The link keeps the time it was made at, now; the destination is
		// newer than it, and the link's target newer still.
		let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
		fs::File::options().write(true).open(&target).unwrap().set_modified(at(now + 2_000)).unwrap();
		fs::File::options()
			.write(true)
			.open(cwd.path().join("dest"))
			.unwrap()
			.set_modified(at(now + 1_000))
			.unwrap();
		assert_eq!(mv_in(cwd.path(), &["-u", "src", "dest"], ""), (0, String::new()));
		assert_eq!(fs::read(cwd.path().join("dest")).unwrap(), b"old", "the link was moved");
		assert_eq!(link_at(&cwd.path().join("src")), Some("target".into()), "the link was moved");
	}

	/// A directory moved with `--backup=numbered` onto a symlink that points
	/// nowhere, beside an earlier backup that is also such a link, backs the
	/// link up one past it and keeps both, as GNU mv does: `dd/src.~1~` was
	/// taken as free and replaced.
	#[cfg(unix)]
	#[test]
	fn a_numbered_backup_keeps_an_earlier_dangling_backup() {
		let cwd = tempdir().unwrap();
		fs::create_dir_all(cwd.path().join("src")).unwrap();
		fs::create_dir(cwd.path().join("dd")).unwrap();
		dangling(&cwd.path().join("dd/src"));
		std::os::unix::fs::symlink("gone", cwd.path().join("dd/src.~1~")).unwrap();
		assert_eq!(mv_in(cwd.path(), &["--backup=numbered", "src", "dd"], ""), (0, String::new()));
		assert!(cwd.path().join("dd/src").is_dir(), "the directory was not moved");
		assert_eq!(link_at(&cwd.path().join("dd/src.~1~")), Some("gone".into()), "the earlier backup was lost");
		assert_eq!(link_at(&cwd.path().join("dd/src.~2~")), Some("missing".into()), "the link was not backed up");
	}

	/// On a provider whose metadata has no file identities, a source that is
	/// the destination's simple backup is still refused: without both
	/// identities the two names are compared by location, as cp compares
	/// files. A `dest~` in another directory, with another `dest~` beside
	/// `dest`, still moves, and the backup replaces that `dest~`: the names
	/// match there, so only the location comparison lets the move go on.
	#[cfg(unix)]
	#[test]
	fn a_provider_without_file_ids_still_refuses_the_backup_as_source() {
		let provider = crate::file_backup::tests::HostWithoutIds::fs(false);
		let cwd = tempdir().unwrap();
		for control in ["--backup=simple", "--backup=existing", "-b"] {
			let dir = cwd.path().join(control.trim_start_matches('-'));
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("dest~"), b"payload").unwrap();
			fs::write(dir.join("dest"), b"old").unwrap();
			let (code, capture) = run_util_on::<Mv>(&provider, &[control, "dest~", "dest"], "", &dir);
			assert_eq!(
				(code, capture.err()),
				(1, "mv: backing up 'dest' might destroy source;  'dest~' not moved\n".to_owned()),
				"{control}"
			);
			assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"payload", "{control}: the source was lost");
			assert_eq!(fs::read(dir.join("dest")).unwrap(), b"old", "{control}: dest replaced");
		}
		let dir = cwd.path().join("elsewhere");
		fs::create_dir_all(dir.join("s")).unwrap();
		fs::write(dir.join("s/dest~"), b"payload").unwrap();
		fs::write(dir.join("dest~"), b"other").unwrap();
		fs::write(dir.join("dest"), b"old").unwrap();
		let (code, capture) = run_util_on::<Mv>(&provider, &["-b", "s/dest~", "dest"], "", &dir);
		assert_eq!((code, capture.err()), (0, String::new()), "elsewhere");
		assert_eq!(fs::read(dir.join("dest")).unwrap(), b"payload", "elsewhere: not moved");
		assert_eq!(fs::read(dir.join("dest~")).unwrap(), b"old", "elsewhere: no backup");
		assert!(!dir.join("s/dest~").exists(), "elsewhere: the source is still there");
	}

	/// `mv --backup=numbered` past the name limit backs up as GNU mv does
	/// ([`crate::file_backup::tests::check_name_limit`]).
	#[cfg(unix)]
	#[test]
	fn a_numbered_backup_past_the_name_limit_ends_in_a_tilde() {
		crate::file_backup::tests::check_name_limit(|dir, name| mv_in(dir, &["--backup=numbered", "src", name], ""));
	}

	/// `mv -b -S ''` backs up to `dest~`, as GNU mv does
	/// ([`crate::file_backup::tests::check_empty_suffix`]).
	#[cfg(unix)]
	#[test]
	fn an_empty_suffix_backs_up_with_a_tilde() {
		crate::file_backup::tests::check_empty_suffix(|dir| mv_in(dir, &["-b", "-S", "", "src", "dest"], ""));
	}

	/// `mv` with long names refuses each backup that would replace its source
	/// or the destination itself, or that GNU mv refuses
	/// ([`crate::file_backup::tests::check_long_name_backups`]).
	#[cfg(unix)]
	#[test]
	fn a_long_name_backup_never_replaces_the_source_or_the_destination() {
		crate::file_backup::tests::check_long_name_backups("mv", |dir, args| mv_in(dir, args, ""));
	}

	/// `mv CONTROL a dest`, where `dest~` is another hard link of `a`, backs
	/// `dest` up over that link and moves, as GNU mv does
	/// ([`crate::file_backup::tests::check_hard_link_backups`]).
	#[cfg(unix)]
	#[test]
	fn a_backup_over_another_hard_link_of_the_source_is_made() {
		crate::file_backup::tests::check_hard_link_backups("mv", false, |dir, control| {
			mv_in(dir, &[control, "a", "dest"], "")
		});
	}

	/// `mv -b dest~ dest`, where `dest~` is a symbolic link (to a file, or
	/// to nothing), is refused: the backup of `dest` would replace the link,
	/// the source's own entry, and the move would then put `dest` back,
	/// losing the link. This differs from GNU mv 9.4 and 9.7, which exit 0
	/// there and lose the link: GNU's `source_is_dst_backup` compares the link
	/// with the file it points to, which is never the link itself.
	/// `--backup=numbered` backs `dest` up as `dest.~1~` and moves the link,
	/// as GNU does.
	#[cfg(unix)]
	#[test]
	fn a_symlink_named_as_the_backup_is_not_moved_over_the_destination() {
		let cwd = tempdir().unwrap();
		for target in ["t", "missing"] {
			let dir = cwd.path().join(target);
			fs::create_dir(&dir).unwrap();
			fs::write(dir.join("t"), b"T").unwrap();
			fs::write(dir.join("dest"), b"old").unwrap();
			std::os::unix::fs::symlink(target, dir.join("dest~")).unwrap();
			assert_eq!(
				mv_in(&dir, &["-b", "dest~", "dest"], ""),
				(1, "mv: backing up 'dest' might destroy source;  'dest~' not moved\n".to_owned()),
				"to {target}"
			);
			assert_eq!(link_at(&dir.join("dest~")), Some(target.into()), "to {target}: the link was lost");
			assert_eq!(fs::read(dir.join("dest")).unwrap(), b"old", "to {target}: dest replaced");
			assert_eq!(fs::read(dir.join("t")).unwrap(), b"T", "to {target}: t changed");
			// The control: a numbered backup leaves the link's entry alone.
			assert_eq!(mv_in(&dir, &["--backup=numbered", "dest~", "dest"], ""), (0, String::new()), "to {target}");
			assert_eq!(link_at(&dir.join("dest")), Some(target.into()), "to {target}: the link was not moved");
			assert_eq!(fs::read(dir.join("dest.~1~")).unwrap(), b"old", "to {target}: no numbered backup");
		}
	}

	/// `mv -b DEST~ dest` where names fold
	/// ([`crate::file_backup::tests::check_folded_sources`]).
	#[cfg(unix)]
	#[test]
	fn a_source_whose_name_folds_to_the_backup_is_not_moved_over_it() {
		crate::file_backup::tests::check_folded_sources("mv", |fs, dir, args| {
			let (code, capture) = run_util_on::<Mv>(fs, args, "", dir);
			(code, capture.err())
		});
	}
}
