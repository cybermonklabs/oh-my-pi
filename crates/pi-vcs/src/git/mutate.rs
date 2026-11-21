//! In-process local Git mutations.

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet},
	ffi::OsStr,
	fs, io,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use gix::bstr::{BString, ByteSlice};

use super::{
	GitRepo,
	filter::WorktreeFilter,
	normalize_path,
	open::{load_index_or_empty, load_index_or_head, status_with_fresh_index, status_with_index},
	read::literal_pathspec,
};
use crate::{
	error::{Error, Result},
	types::{
		CleanOptions, CommitAuthor, CommitOptions, DetachGitDirResult, ResetMode, RestoreOptions,
		WorktreeAddOptions, WorktreeAddResult, WorktreeClone,
	},
};

const INDEX_WRITE: gix::index::write::Options = gix::index::write::Options {
	extensions: gix::index::write::Extensions::None,
	skip_hash:  false,
};
/// Apply a ref update, synthesizing a committer for the reflog entry when no
/// identity is configured. Reflog lines require a signature, but git never
/// fails branch/reset/stash ref updates over missing identity — only
/// `git commit` demands one — so parity requires a fallback here.
pub(crate) fn update_reference(
	repo: &gix::Repository,
	op: &'static str,
	name: &str,
	id: gix::hash::ObjectId,
	expected: gix::refs::transaction::PreviousValue,
	message: &str,
	force_create_reflog: bool,
) -> Result<()> {
	let name: gix::refs::FullName = name.try_into().map_err(|err| Error::backend(op, err))?;
	let edit = gix::refs::transaction::RefEdit {
		change: gix::refs::transaction::Change::Update {
			log: gix::refs::transaction::LogChange {
				mode: gix::refs::transaction::RefLog::AndReference,
				force_create_reflog,
				message: message.into(),
			},
			expected,
			new: gix::refs::Target::Object(id),
		},
		name,
		deref: false,
	};
	let now;
	let committer = if let Some(signature) = repo
		.committer()
		.transpose()
		.map_err(|err| Error::backend(op, err))?
	{
		signature
	} else {
		now = format!(
			"{} +0000",
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |elapsed| elapsed.as_secs())
		);
		gix::actor::SignatureRef { name: "omp".into(), email: "omp@localhost".into(), time: &now }
	};
	repo
		.edit_references_as(Some(edit), Some(committer))
		.map_err(|err| Error::backend(op, err))?;
	Ok(())
}

impl GitRepo {
	/// Stage worktree files, or every change when `files` is empty.
	///
	/// Empty `files` matches `git add -A`: refresh tracked paths and add
	/// untracked files that survive the standard ignore stack (nested
	/// `.gitignore`, exclude files). Content goes through the worktree-to-git
	/// filter pipeline (`.gitattributes` `text`/`eol`, `core.autocrlf`, clean
	/// drivers) so the index blob matches what `git add` would store — a
	/// `*.cmd text eol=crlf` file stages as LF even though the checkout is
	/// CRLF. When `core.precomposeUnicode` is set,
	/// a worktree path that is a unicode-composition equivalent of an
	/// existing index path (macOS NFD dirent vs NFC index name) is stored
	/// under the index name. Unrelated names that share an inode (hardlinks)
	/// and distinct NFC/NFD files when precompose is off stay separate.
	pub fn stage_files(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let mut index = load_index_or_head(&repo, "git add")?;
		// Whole seconds since the epoch before any file is stat'ed (see
		// `stage_one`).
		let staging_started = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_secs());
		let all = files.is_empty();
		let mut requested: BTreeSet<String> = files
			.iter()
			.map(|path| normalize_stage_path(path))
			.collect();
		if precompose_unicode_enabled(&repo) {
			requested = remap_composed_index_paths(self.root(), &index, requested);
		}
		let mut selected = collect_stage_paths(self, &requested, all)?;
		for entry in index.entries() {
			let path = entry.path(&index).to_str_lossy().into_owned();
			if (all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& fs::symlink_metadata(self.root().join(&path)).is_ok()
			{
				selected.insert(path);
			}
		}
		index.remove_entries(|_, path, _| {
			let path = path.to_str_lossy();
			(all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& !selected.contains(path.as_ref())
		});
		let (mut filter, filter_index) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend("git add", err))?;
		// Hash every selected path first, then rewrite the index in one pass:
		// removing entries path by path rescans the whole index each time.
		let mut replaced = std::collections::HashSet::<BString>::new();
		let mut staged = Vec::new();
		for path in selected {
			match stage_one(self.root(), &mut filter, &filter_index, &path, staging_started)? {
				Staged::Entry(entry) => {
					replaced.insert(path.into());
					staged.push(entry);
				},
				Staged::Removed => {
					replaced.insert(path.into());
				},
				Staged::Kept => {},
			}
		}
		index.remove_entries(|_, path, _| replaced.contains(path));
		// A kept entry's stat as new as the old index is racy: only that
		// index's timestamp makes git re-check the file's content, and the
		// index written here is newer, so the stat is dropped to keep the
		// check (git smudges such entries when it writes an index).
		let racy_from = index.timestamp();
		for entry in index.entries_mut() {
			if entry.stat.is_racy(racy_from, Default::default()) {
				entry.stat = gix::index::entry::Stat::default();
			}
		}
		for entry in staged {
			index.dangerously_push_entry(
				entry.stat,
				entry.id,
				gix::index::entry::Flags::empty(),
				entry.mode,
				entry.path.as_bstr(),
			);
		}
		index.sort_entries();
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git add", err))
	}

	/// Reset selected index entries to HEAD while preserving the worktree.
	pub fn unstage(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let head = head_tree(&repo)?;
		let head_index = index_for_tree(&repo, head.as_ref())?;
		let mut current = load_index_or_head(&repo, "git reset")?;
		copy_index_paths(&mut current, &head_index, files);
		current
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git reset", err))
	}

	/// Create a commit and return its object id. With `commit.gpgSign` enabled
	/// the object is written by `git commit-tree -S` so Git runs the
	/// configured signer; a signer failure leaves HEAD unchanged.
	pub fn commit_create(&self, message: &str, options: &CommitOptions) -> Result<String> {
		let repo = self.gix()?;
		// Git rejects a malformed value before doing any work; reading it as
		// `false` would silently write unsigned commits.
		let sign = repo
			.config_snapshot()
			.try_boolean("commit.gpgSign")
			.transpose()
			.map_err(|err| Error::backend("git commit read commit.gpgSign", err))?
			.unwrap_or(false);
		run_commit_hook(self, "pre-commit", &[])?;
		let mut head = repo
			.head()
			.map_err(|err| Error::backend("git commit", err))?;
		let old_commit = head
			.try_peel_to_id()
			.map_err(|err| Error::backend("git commit", err))?
			.map(|id| id.detach());
		let index = load_index_or_head(&repo, "git commit")?;
		let tree = if options.files.is_empty() {
			write_index_tree(&repo, &index)?
		} else {
			let base = index_for_tree(
				&repo,
				old_commit
					.as_ref()
					.map(|id| commit_tree(&repo, id))
					.transpose()?
					.as_ref(),
			)?;
			let mut partial = base;
			copy_index_paths(&mut partial, &index, &options.files);
			write_index_tree(&repo, &partial)?
		};
		let (parents, inherited_author) = if options.amend {
			let id = old_commit
				.ok_or_else(|| Error::backend("git commit", "cannot amend an unborn HEAD"))?;
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git commit", err))?;
			let parents: Vec<gix::hash::ObjectId> =
				commit.parent_ids().map(|id| id.detach()).collect();
			let author = commit
				.author()
				.map_err(|err| Error::backend("git commit", err))?
				.to_owned()
				.map_err(|err| Error::backend("git commit", err))?;
			(parents, Some(author))
		} else {
			(old_commit.into_iter().collect(), None)
		};
		if !options.allow_empty {
			if let Some(parent) = parents.first() {
				if commit_tree(&repo, parent)? == tree {
					return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
				}
			} else if tree == repo.empty_tree().id {
				return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
			}
		}
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit", err))?;
		let override_author = options.author.as_ref().map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else if let Some(author) = inherited_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit", err))?
		};
		let message_path = self.info().git_dir.join("COMMIT_EDITMSG");
		fs::write(&message_path, message)?;
		run_commit_hook(self, "commit-msg", &[message_path.as_os_str()])?;
		let message = fs::read_to_string(&message_path)
			.map_err(|err| Error::backend("git commit read commit-msg result", err))?;
		let id = if sign {
			sign_commit(self, &message, tree, &parents, author, committer)?
		} else {
			repo
				.new_commit_as(committer, author, message, tree, parents)
				.map_err(|err| Error::backend("git commit", err))?
				.id
		};
		let expected = old_commit
			.map_or(gix::refs::transaction::PreviousValue::MustNotExist, |old| {
				gix::refs::transaction::PreviousValue::MustExistAndMatch(old.into())
			});
		repo
			.edit_reference(gix::refs::transaction::RefEdit {
				change: gix::refs::transaction::Change::Update {
					log: gix::refs::transaction::LogChange {
						mode:                gix::refs::transaction::RefLog::AndReference,
						force_create_reflog: false,
						message:             if options.amend {
							"commit (amend)"
						} else {
							"commit"
						}
						.into(),
					},
					expected,
					new: gix::refs::Target::Object(id),
				},
				name:   "HEAD"
					.try_into()
					.map_err(|err| Error::backend("git commit", err))?,
				deref:  true,
			})
			.map_err(|err| Error::backend("git commit", err))?;
		let _ = run_commit_hook(self, "post-commit", &[]);
		Ok(id.to_hex().to_string())
	}

	/// Write a commit object for `tree` on top of `parents` without touching
	/// HEAD, the index, any ref, or the worktree (`git commit-tree`). No hooks
	/// run. Returns the new commit id.
	pub fn commit_tree(
		&self,
		tree: &str,
		parents: &[String],
		message: &str,
		author: Option<&CommitAuthor>,
	) -> Result<String> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, tree)?;
		let parents = parents
			.iter()
			.map(|parent| resolve_commit(&repo, parent))
			.collect::<Result<Vec<_>>>()?;
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit-tree", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit-tree", err))?;
		let override_author = author.map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit-tree", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit-tree", err))?
		};
		let commit = repo
			.new_commit_as(committer, author, message, tree, parents)
			.map_err(|err| Error::backend("git commit-tree", err))?;
		Ok(commit.id.to_hex().to_string())
	}

	/// Checkout a branch or detached revision without overwriting local changes.
	pub fn checkout(&self, rev: &str) -> Result<()> {
		let repo = self.gix()?;
		let (target, symbolic) = resolve_checkout_target(&repo, rev)?;
		checkout_tree(self, &repo, target, false)?;
		write_head(self.info().head_path.as_path(), symbolic.as_deref(), target)?;
		Ok(())
	}

	/// Create or force-move a local branch.
	pub fn create_branch(&self, name: &str, start: &str, force: bool) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, start)?;
		let full = format!("refs/heads/{name}");
		if force && branch_is_checked_out(&self.info().common_dir, &full) {
			return Err(Error::backend(
				"git branch",
				format!(
					"cannot force update the branch '{name}' checked out at '{}'",
					self.root().display()
				),
			));
		}
		let constraint = if force {
			gix::refs::transaction::PreviousValue::Any
		} else {
			gix::refs::transaction::PreviousValue::MustNotExist
		};
		// git's reflog tells a `-f` move apart from a creation.
		let exists = force
			&& repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git branch", e))?
				.is_some();
		let message = if exists {
			format!("branch: Reset to {start}")
		} else {
			format!("branch: Created from {start}")
		};
		update_reference(&repo, "git branch", &full, id, constraint, &message, false)?;
		Ok(())
	}

	/// Delete a local branch, returning false for missing or unsafe deletion.
	pub fn delete_branch(&self, name: &str, force: bool) -> Result<bool> {
		let repo = self.gix()?;
		let full = format!("refs/heads/{name}");
		if branch_is_checked_out(&self.info().common_dir, &full) {
			return Ok(false);
		}
		let Ok(mut reference) = repo.find_reference(&full) else {
			return Ok(false);
		};
		let id = match reference.peel_to_id() {
			Ok(id) => id.detach(),
			Err(_) => return Ok(false),
		};
		if !force {
			let Ok(head) = repo.head_commit() else {
				return Ok(false);
			};
			let mut walk = head
				.ancestors()
				.all()
				.map_err(|err| Error::backend("git branch", err))?;
			let merged = walk.any(|item| item.is_ok_and(|info| info.id == id));
			if !merged {
				return Ok(false);
			}
		}
		let edit = gix::refs::transaction::RefEdit {
			change: gix::refs::transaction::Change::Delete {
				expected: gix::refs::transaction::PreviousValue::MustExistAndMatch(id.into()),
				log:      gix::refs::transaction::RefLog::AndReference,
			},
			name:   full
				.try_into()
				.map_err(|err| Error::backend("git branch", err))?,
			deref:  false,
		};
		Ok(repo.edit_reference(edit).is_ok())
	}

	/// Create a branch at HEAD and switch to it without touching files.
	pub fn checkout_new_branch(&self, name: &str) -> Result<()> {
		self.create_branch(name, "HEAD", false)?;
		fs::write(&self.info().head_path, format!("ref: refs/heads/{name}\n"))?;
		Ok(())
	}

	/// Restore index and/or worktree paths from a selected source.
	pub fn restore(&self, options: &RestoreOptions) -> Result<()> {
		let repo = self.gix()?;
		let restore_worktree = options.worktree || !options.staged;
		let mut index = load_index_or_head(&repo, "git restore")?;
		if options.staged {
			let source = resolve_tree(&repo, options.source.as_deref().unwrap_or("HEAD"))?;
			let source_index = index_for_tree(&repo, Some(&source))?;
			copy_index_paths(&mut index, &source_index, &options.files);
			index
				.write(INDEX_WRITE)
				.map_err(|e| Error::backend("git restore", e))?;
		}
		if restore_worktree {
			let source_index = if let Some(source) = options.source.as_deref() {
				index_for_tree(&repo, Some(&resolve_tree(&repo, source)?))?
			} else {
				index
			};
			restore_index_paths(self.root(), &repo, &source_index, &options.files)?;
		}
		Ok(())
	}

	/// Write the checkout's uncommitted changes to tracked files as a stash
	/// commit, leaving the working tree, the index, and the stash list as they
	/// are. `None` when nothing is uncommitted. Git cannot record unmerged
	/// entries, so this fails mid-conflict.
	pub fn stash_create(&self) -> Result<Option<String>> {
		let create = ["stash", "create"].map(str::to_owned);
		let created = super::cli::run_sync(self.root(), &create, super::cli::COMMAND_TIMEOUT)?
			.into_checked(&create)?;
		let id = created.stdout.trim();
		Ok((!id.is_empty()).then(|| id.to_owned()))
	}

	/// Point `reference` at `id`, recording `message` on its reflog.
	pub fn record_ref(&self, reference: &str, id: &str, message: &str) -> Result<()> {
		let update =
			["update-ref", "--create-reflog", "-m", message, reference, id].map(str::to_owned);
		super::cli::run_sync(self.root(), &update, super::cli::COMMAND_TIMEOUT)?
			.into_checked(&update)?;
		Ok(())
	}

	/// Reset HEAD, index, and optionally the worktree to a target commit.
	pub fn reset(&self, mode: ResetMode, target: Option<&str>) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, target.unwrap_or("HEAD"))?;
		if mode == ResetMode::Hard {
			checkout_tree(self, &repo, id, true)?;
		} else if mode == ResetMode::Mixed {
			self.read_tree(&id.to_hex().to_string(), None)?;
		}
		update_current_head(&repo, &self.info().head_path, id)?;
		Ok(())
	}

	/// Remove untracked files and directories according to ignore mode.
	pub fn clean(&self, options: &CleanOptions) -> Result<()> {
		// `.` (and `./`) normalize to "" and mean "everything", so they drop out
		// of the restriction set. A literally empty string is rejected the way
		// git rejects it instead of silently widening to the whole worktree.
		let mut paths = BTreeSet::new();
		for raw in &options.paths {
			if raw.is_empty() {
				return Err(Error::backend("git clean", "empty string is not a valid pathspec"));
			}
			let normalized = normalize_stage_path(raw);
			if !normalized.is_empty() {
				paths.insert(normalized);
			}
		}

		// Fresh open: the cached handle snapshots config, so a
		// `core.excludesFile` configured after first use would be missed and
		// its excluded files deleted.
		let repo = self.gix_fresh()?;
		let mut platform =
			status_with_index(&repo, "git clean", load_index_or_head(&repo, "git clean")?)?
				.untracked_files(gix::status::UntrackedFiles::Files);
		let emit_ignored = options.include_ignored || options.ignored_only;
		let for_deletion = if emit_ignored {
			gix::dir::walk::ForDeletionMode::FindNonBareRepositoriesInIgnoredDirectories
		} else {
			gix::dir::walk::ForDeletionMode::IgnoredDirectoriesCanHideNestedRepositories
		};
		platform = platform.dirwalk_options(|opts| {
			let opts = opts
				.emit_empty_directories(true)
				.for_deletion(Some(for_deletion));
			if emit_ignored {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			} else {
				opts
			}
		});

		let iter = platform
			.into_index_worktree_iter(
				paths
					.iter()
					.map(|path| literal_pathspec(path).into_bytes().into()),
			)
			.map_err(|e| Error::backend("git clean", e))?;

		for item in iter {
			let item = item.map_err(|e| Error::backend("git clean", e))?;
			let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = item else {
				continue;
			};
			if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
				continue;
			}
			let wanted = if options.ignored_only {
				matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else if options.include_ignored {
				entry.status == gix::dir::entry::Status::Untracked
					|| matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else {
				entry.status == gix::dir::entry::Status::Untracked
			};
			if !wanted {
				continue;
			}
			let full = self.root().join(entry.rela_path.to_str_lossy().as_ref());
			remove_existing(&full)?;
			prune_empty_parents(self.root(), full.parent(), &paths)?;
		}
		Ok(())
	}

	/// Replace an index file with the entries from `treeish`.
	pub fn read_tree(&self, treeish: &str, index_path: Option<&Path>) -> Result<()> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, treeish)?;
		let mut index = repo
			.index_from_tree(&tree)
			.map_err(|e| Error::backend("git read-tree", e))?;
		if let Some(path) = index_path {
			index.set_path(path);
		}
		index
			.write(INDEX_WRITE)
			.map_err(|e| Error::backend("git read-tree", e))
	}

	/// Write an index as a tree object and return its object id.
	pub fn write_tree(&self, index_path: Option<&Path>) -> Result<String> {
		let repo = self.gix()?;
		let index = match index_path {
			Some(path) => gix::index::File::at(path, repo.object_hash(), false, Default::default())
				.map_err(|e| Error::backend("git write-tree", e))?,
			None => repo
				.open_index()
				.map_err(|e| Error::backend("git write-tree", e))?,
		};
		Ok(write_index_tree(&repo, &index)?.to_hex().to_string())
	}

	/// Set one repository-local configuration value while preserving formatting.
	pub fn config_set(&self, key: &str, value: &str) -> Result<()> {
		set_config_file(&self.info().common_dir.join("config"), key, value)
	}

	/// Add a remote idempotently when its URL already matches.
	pub fn remote_add(&self, name: &str, url: &str) -> Result<()> {
		let key = format!("remote.{name}.url");
		let repo = self.gix()?;
		if let Some(existing) = repo.config_snapshot().string(&key) {
			let existing = existing.to_str_lossy();
			if existing == url {
				return Ok(());
			}
			return Err(Error::backend(
				"git remote add",
				format!("remote {name} already exists with URL {existing}, expected {url}"),
			));
		}
		self.config_set(&key, url)
	}

	/// Create a linked worktree and materialize its checkout.
	///
	/// The registration exists, locked as `git worktree add` locks it, before
	/// the first entry is written, and holds an add-in-progress marker the
	/// adding process keeps locked until the add finishes. Every failure
	/// removes the tree and the registration. An add that dies before it
	/// finishes (a signal, a timeout's kill) leaves its registration locked;
	/// a later add of the same path first empties the tree that add made and
	/// removes the registration, when it can tell both are still that add's
	/// ([`Self::worktree_reclaim_abandoned`]), and refuses otherwise.
	pub fn worktree_add(
		&self,
		path: &Path,
		ref_name: &str,
		options: WorktreeAddOptions,
	) -> Result<WorktreeAddResult> {
		let mut notes = self.worktree_reclaim_abandoned(path)?;
		let repo = self.gix()?;
		let id = resolve_commit(&repo, ref_name)?;
		if path.exists() && fs::read_dir(path)?.next().is_some() {
			return Err(Error::backend(
				"git worktree add",
				"destination already exists and is not empty",
			));
		}
		if options.keep_changes {
			let source_head = repo
				.head_id()
				.map_err(|e| Error::backend("git worktree add", e))?
				.detach();
			if source_head != id {
				return Err(Error::backend(
					"git worktree add",
					"keeping uncommitted changes requires the target to be the source HEAD",
				));
			}
		}
		let head = if options.detach {
			id.to_hex().to_string()
		} else {
			let full = if ref_name.starts_with("refs/heads/") {
				ref_name.to_owned()
			} else {
				format!("refs/heads/{ref_name}")
			};
			if branch_is_checked_out(&self.info().common_dir, &full) {
				return Err(Error::backend(
					"git worktree add",
					format!("'{full}' is already checked out"),
				));
			}
			if repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git worktree add", e))?
				.is_none()
			{
				update_reference(
					&repo,
					"git worktree add",
					full.as_str(),
					id,
					gix::refs::transaction::PreviousValue::MustNotExist,
					"branch: Created from worktree add",
					false,
				)?;
			}
			format!("ref: {full}")
		};

		let preferred = match options.clone {
			WorktreeClone::Off => None,
			WorktreeClone::Auto => Some(None),
			WorktreeClone::Prefer(kind) => Some(Some(kind)),
		};
		let lock = options.lock.as_deref();
		let mut pending = PendingWorktree::begin(path, &self.info().common_dir, &head, lock)?;
		let mut clone_error = None;
		if let Some(preferred) = preferred {
			for kind in pi_iso::clone_candidates(preferred) {
				match self.worktree_add_cloned(&pending, id, kind, options.keep_changes) {
					Ok(()) => {
						notes.extend(pending.finish(lock));
						return Ok(WorktreeAddResult { cloned_with: Some(kind), clone_error, notes });
					},
					Err(err) => {
						clone_error = Some(err.to_string());
						pending.reset_tree()?;
					},
				}
			}
		}

		pending.link()?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		checkout_tree(&linked, &linked_repo, id, true)?;
		if options.keep_changes {
			self.seed_worktree_changes(path, &pending.admin, id)?;
		}
		notes.extend(pending.finish(lock));
		Ok(WorktreeAddResult { cloned_with: None, clone_error, notes })
	}

	/// Remove the registration an interrupted [`Self::worktree_add`] of
	/// `path` left, and empty the tree that add made, so `path` can be added
	/// again. Only a registration that names `path` and holds the
	/// add-in-progress marker is considered. It goes when no process holds
	/// that marker any more, its `locked` file holds exactly what the add
	/// wrote, its `HEAD` is still what the add wrote and has no reflog, and
	/// `path` is missing, or is still the directory the add made (same device
	/// and inode, and the token the add set on it) with no repository in it
	/// (no `.git` but the add's own gitfile at its root, and no bare
	/// repository) and no filesystem mounted in it (every entry on the root's
	/// device). Files written into that tree after the add stopped, and
	/// changes staged there, are removed with it. A live add, a lock someone
	/// changed or removed, a commit or checkout made there, a directory made
	/// again in its place, a repository or a mount point anywhere in the
	/// tree, or a platform that cannot check these is refused with a message
	/// naming the registration, and nothing is removed. A mount made during
	/// the emptying stops it there, with nothing on that filesystem removed.
	/// Registrations earlier reclaims moved out of git's view and did not delete
	/// go first. Returns one note per removal, for the caller to show.
	pub fn worktree_reclaim_abandoned(&self, path: &Path) -> Result<Vec<String>> {
		let common = &self.info().common_dir;
		sweep_moved_registrations(common);
		let Ok(entries) = fs::read_dir(common.join("worktrees")) else {
			return Ok(Vec::new());
		};
		let target = resolve_leaf(path);
		let mut notes = Vec::new();
		for entry in entries {
			let admin = entry?.path();
			if registered_tree(&admin).is_some_and(|tree| resolve_leaf(&tree) == target)
				&& fs::symlink_metadata(admin.join(ADD_IN_PROGRESS)).is_ok()
			{
				notes.extend(reclaim_abandoned_add(common, &admin, path)?);
			}
		}
		Ok(notes)
	}

	/// Replicate the source checkout's uncommitted state onto a worktree at
	/// `path` freshly checked out at the source `HEAD` (`head_commit`): copy
	/// every staged, dirty tracked, and untracked file (deleting what the
	/// source deleted), then install the source index so staged hunks stay
	/// staged, with its stat cache rebased onto the files now on disk.
	fn seed_worktree_changes(
		&self,
		path: &Path,
		admin: &Path,
		head_commit: gix::hash::ObjectId,
	) -> Result<()> {
		let repo = self.gix()?;
		let (dirty_tracked, untracked) = collect_clone_reconciliation_paths(&repo)?;
		// One snapshot of the source index decides which paths to copy and is
		// what gets installed, so a concurrent `git add` in the source cannot
		// split the two.
		let source_index = if self.info().git_dir.join("index").is_file() {
			Some(load_index_or_empty(&repo, "git worktree add")?)
		} else {
			None
		};
		// The checkout wrote `HEAD` content, so paths whose index entry differs
		// from `HEAD` (staged edits, additions, and deletions) need the source
		// bytes too, even when the source worktree matches its index.
		let staged = match &source_index {
			Some(source_index) => {
				let head_index = repo
					.index_from_tree(&commit_tree(&repo, &head_commit)?)
					.map_err(|err| Error::backend("git worktree add", err))?;
				index_diff_paths(source_index, &head_index)
			},
			None => BTreeSet::new(),
		};

		for relative in dirty_tracked.iter().chain(&untracked).chain(&staged) {
			copy_worktree_path(self.root(), path, relative.as_bstr())?;
		}
		let Some(mut index) = source_index else {
			return Ok(());
		};
		// The source stat cache describes the source files. Checkout filters
		// (e.g. `core.autocrlf`) can write clean files at a different size, and
		// git reports a size mismatch as modified without hashing the content.
		refresh_clean_index_stats(&mut index, path, &dirty_tracked)?;
		index.set_path(admin.join("index"));
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))
	}

	/// Fills the pending registration's tree with a `kind` clone of the source
	/// and reconciles it with the target commit.
	fn worktree_add_cloned(
		&self,
		pending: &PendingWorktree,
		id: gix::hash::ObjectId,
		kind: pi_iso::BackendKind,
		keep_changes: bool,
	) -> Result<()> {
		let path = pending.path.as_path();
		let repo = self.gix()?;
		for key in ["core.sparseCheckout", "core.splitIndex"] {
			if repo.config_snapshot().string(key).is_some_and(|value| {
				!matches!(value.to_str_lossy().as_ref(), "false" | "no" | "off" | "0")
			}) {
				return Err(Error::backend("git worktree add", format!("{key} is enabled")));
			}
		}
		let source_index = self.info().git_dir.join("index");
		if !source_index.is_file() {
			return Err(Error::backend("git worktree add", "source index is missing"));
		}

		// One status of the source decides what the clone leaves out and how
		// the copy is reconciled. A path the source neither tracks nor ignores
		// is the user's uncommitted work, which only a kept-changes add
		// carries. A directory below the root holding a `.git` entry is another
		// checkout (a submodule, a linked worktree, a cloned dependency), which
		// no add carries: its `.git` names an administrative directory of its
		// own source, or a relative one that means nothing in the new tree.
		let (dirty_tracked, untracked) = collect_clone_reconciliation_paths(&repo)?;
		let mut exclusions = pi_iso::CloneExclusions::default();
		exclusions.path(".git").marker(".git");
		if !keep_changes {
			for relative in &untracked {
				exclusions.path(relative.to_path_lossy().into_owned());
			}
		}
		let left_out: BTreeSet<PathBuf> = pi_iso::backend(kind)
			.clone_tree(self.root(), path, &exclusions)
			.map_err(|err| Error::backend("git worktree add", err))?
			.into_iter()
			.collect();
		pending.link()?;
		fs::copy(&source_index, pending.admin.join("index"))?;

		// Backends may clone entire subtrees atomically. Apply the same
		// nonrelocatable-directory policy to every backend's disposable copy,
		// independently of Git's ignore rules.
		let mut excluded = prune_nonrelocatable_clone_dirs(path)?;
		// What the target tracks below a checkout the clone left out (a
		// submodule's gitlink, files tracked beside a nested `.git`) is
		// restored like a nonrelocatable directory's tracked files.
		excluded.extend(left_out.iter().cloned());
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		let mut current = load_index_or_empty(&linked_repo, "git worktree add")?;
		if keep_changes {
			// Environment artifacts and other checkouts are never carried,
			// but tracked edits beneath an excluded directory still belong to
			// the user. A gitlink is left an empty directory, as git's own
			// checkout leaves a submodule.
			if !excluded.is_empty() {
				for entry in current.entries() {
					let relative = entry.path(&current);
					if !relative
						.to_path_lossy()
						.ancestors()
						.any(|parent| excluded.contains(parent))
					{
						continue;
					}
					if entry.mode != gix::index::entry::Mode::COMMIT {
						copy_worktree_path(self.root(), path, relative)?;
					} else if !behind_link(path, &relative.to_path_lossy())? {
						fs::create_dir_all(path.join(relative.to_path_lossy()))?;
					}
				}
				// git treats a directory holding a `.git` it cannot open (an
				// empty one, or one naming an administrative directory that is
				// gone), and one the outer index tracks, as ordinary content,
				// and its status names the untracked files inside it: those
				// are the user's work too. A checkout git can open is reported
				// as itself (`?? dir/`), never by the files below it, so it
				// stays out. Nothing below a nonrelocatable directory (a
				// virtual environment, a CMake build directory) is carried,
				// as the clone prunes those wherever it copies them.
				for relative in &untracked {
					let relative_path = relative.to_path_lossy();
					if relative_path
						.ancestors()
						.skip(1)
						.any(|parent| left_out.contains(parent))
						&& !relative_path
							.ancestors()
							.skip(1)
							.any(|parent| is_nonrelocatable_dir(&self.root().join(parent)))
					{
						copy_worktree_path(self.root(), path, relative.as_bstr())?;
					}
				}
			}
			// The clone already mirrors the source's live tree and the copied
			// index carries its staged state. Only the stat cache is stale
			// (new inodes); refresh it for entries the source reports clean so
			// dirty files still hash on the next status.
			refresh_clean_index_stats(&mut current, path, &dirty_tracked)?;
			return current
				.write(INDEX_WRITE)
				.map_err(|err| Error::backend("git worktree add", err));
		}
		let tree = commit_tree(&linked_repo, &id)?;
		let mut target = linked_repo
			.index_from_tree(&tree)
			.map_err(|err| Error::backend("git worktree add", err))?;

		let differing = index_diff_paths(&current, &target);
		let (write_paths, removed): (BTreeSet<BString>, BTreeSet<BString>) = differing
			.into_iter()
			.partition(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some());
		let mut delete = removed;
		delete.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_none())
				.cloned(),
		);

		let mut write = write_paths;
		if !excluded.is_empty() {
			write.extend(target.entries().iter().filter_map(|entry| {
				let relative = entry.path(&target);
				relative
					.to_path_lossy()
					.ancestors()
					.any(|parent| excluded.contains(parent))
					.then(|| relative.to_owned())
			}));
		}
		write.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some())
				.cloned(),
		);

		for relative in &delete {
			let full = path.join(relative.to_path_lossy());
			match fs::remove_file(&full) {
				Ok(()) => prune_empty_parents(path, full.parent(), &BTreeSet::new())?,
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
				Err(err) => return Err(err.into()),
			}
		}

		// `remove_entries` keeps the path backing even when it drops every
		// entry, and gix's checkout asserts the two are empty together; a
		// clone that already matches the target tree must not enter it.
		let changed = if write.is_empty() {
			None
		} else {
			let mut changed = target.clone();
			changed.remove_entries(|_, entry_path, _| !write.contains(entry_path));
			let mut checkout_options = linked_repo
				.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
				.map_err(|err| Error::backend("git worktree add", err))?;
			checkout_options.overwrite_existing = true;
			let progress = gix::progress::Discard;
			let interrupt = std::sync::atomic::AtomicBool::new(false);
			let outcome = gix::worktree::state::checkout(
				&mut changed,
				path,
				linked_repo
					.objects
					.into_arc()
					.map_err(|err| Error::backend("git worktree add", err))?,
				&progress,
				&progress,
				&interrupt,
				checkout_options,
			)
			.map_err(|err| Error::backend("git worktree add", err))?;
			if !outcome.collisions.is_empty() || !outcome.errors.is_empty() {
				return Err(Error::backend(
					"git worktree add",
					format!(
						"checkout reported {} collisions and {} errors",
						outcome.collisions.len(),
						outcome.errors.len()
					),
				));
			}
			Some(changed)
		};

		for (entry, entry_path) in target.entries_mut_with_paths() {
			if let Some(written) = changed
				.as_ref()
				.and_then(|changed| changed.entry_by_path(entry_path))
			{
				entry.stat = written.stat;
			} else {
				let metadata = gix::index::fs::Metadata::from_path_no_follow(
					&path.join(entry_path.to_path_lossy()),
				)?;
				entry.stat = gix::index::entry::Stat::from_fs(&metadata)
					.map_err(|err| Error::backend("git worktree add", err))?;
			}
		}
		target
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))?;
		// The clone carried only what the source tracks or ignores, and the
		// target can leave unignored a path the source ignores. Only now are
		// the target's ignore files and index in place. Clean this fresh
		// clone through the existing repository-safe walk; keep
		// target-ignored caches.
		linked.clean(&CleanOptions::default())
	}

	/// Resolve the executable hook `name` as git's `find_hook` does: under
	/// `core.hooksPath` (a relative value resolves against the checkout root)
	/// or else the shared `hooks` directory, which linked worktrees read from
	/// the common dir. `None` when the hook is missing or not executable.
	pub fn hook_path(&self, name: &str) -> Result<Option<PathBuf>> {
		let dir = self
			.gix()?
			.config_snapshot()
			.string("core.hooksPath")
			.map_or_else(
				|| self.info().common_dir.join("hooks"),
				|value| self.root().join(value.to_str_lossy().as_ref()),
			);
		let hook = dir.join(name);
		Ok(hook_is_executable(&hook).then_some(hook))
	}

	/// Remove a linked worktree, returning false when dirty and not forced.
	pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<bool> {
		let Some(linked) = Self::discover(path)? else {
			return Ok(false);
		};
		if !force && tracked_worktree_dirty(&linked)? {
			return Ok(false);
		}
		let admin = linked.info().git_dir.clone();
		fs::remove_dir_all(path)?;
		if admin.starts_with(self.info().common_dir.join("worktrees")) {
			fs::remove_dir_all(admin)?;
		}
		Ok(true)
	}

	/// Prune linked-worktree administration entries whose back-reference
	/// vanished. As `git worktree prune`, a locked entry is kept; and an
	/// entry is pruned only when its back-reference is known to be gone: an
	/// unreadable `gitdir`, a relative one, or a target that cannot be
	/// checked keeps it.
	pub fn worktree_prune(&self) -> Result<()> {
		let root = self.info().common_dir.join("worktrees");
		let Ok(entries) = fs::read_dir(&root) else {
			return Ok(());
		};
		for entry in entries {
			let entry = entry?;
			if worktree_entry_is_dead(&entry.path()) {
				fs::remove_dir_all(entry.path())?;
			}
		}
		Ok(())
	}
}

/// Whether a `worktrees/<id>` administration entry may be pruned.
///
/// As git, `locked` and the `gitdir` target are tested without following a
/// final symlink: a dangling link is something there, not something gone.
fn worktree_entry_is_dead(entry: &Path) -> bool {
	if !is_not_found(fs::symlink_metadata(entry.join("locked"))) {
		return false;
	}
	let back = match fs::read_to_string(entry.join("gitdir")) {
		Ok(back) => back,
		Err(err) => return err.kind() == io::ErrorKind::NotFound,
	};
	let back = Path::new(back.trim());
	if back.as_os_str().is_empty() {
		return true;
	}
	back.is_absolute() && is_not_found(fs::symlink_metadata(back))
}

/// Whether a metadata lookup found nothing at its path (any other error means
/// it cannot tell).
fn is_not_found(metadata: io::Result<fs::Metadata>) -> bool {
	matches!(metadata, Err(err) if err.kind() == io::ErrorKind::NotFound)
}

fn run_commit_hook(repository: &GitRepo, name: &str, args: &[&OsStr]) -> Result<()> {
	let Some(hook) = repository.hook_path(name)? else {
		return Ok(());
	};
	// Windows CreateProcess cannot execute a shebang script directly. Let Git
	// invoke the hook through its own shell, as `git commit` does.
	#[cfg(windows)]
	let mut command = {
		let _ = hook;
		let mut command = Command::new("git");
		command.args(["hook", "run", "--ignore-missing", name, "--"]);
		command
	};
	#[cfg(not(windows))]
	let mut command = Command::new(&hook);
	super::cli::detach_from_terminal(&mut command);
	let output = command
		.args(args)
		.current_dir(repository.root())
		.env("GIT_DIR", &repository.info().git_dir)
		.env("GIT_WORK_TREE", repository.root())
		.env("GIT_TERMINAL_PROMPT", "0")
		.stdin(Stdio::null())
		.output()
		.map_err(|err| Error::Cli {
			command:   format!("git commit ({name} hook)"),
			exit_code: 1,
			stdout:    String::new(),
			stderr:    err.to_string(),
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(Error::Cli {
		command:   format!("git commit ({name} hook)"),
		exit_code: output.status.code().unwrap_or(1),
		stdout:    String::from_utf8_lossy_owned(output.stdout),
		stderr:    String::from_utf8_lossy_owned(output.stderr),
	})
}

/// Write a signed commit object through `git commit-tree -S`, which runs the
/// signer configured by `gpg.format`/`gpg.program`/`user.signingKey`.
/// gitoxide cannot sign, so this is the one commit path that leaves the
/// process; HEAD is still updated in-process by the caller.
fn sign_commit(
	repository: &GitRepo,
	message: &str,
	tree: gix::hash::ObjectId,
	parents: &[gix::hash::ObjectId],
	author: gix::actor::SignatureRef<'_>,
	committer: gix::actor::SignatureRef<'_>,
) -> Result<gix::hash::ObjectId> {
	let mut args = vec![
		// The repository was opened with `Trust::Full`; without this override
		// git's ownership check rejects checkouts owned by another user
		// (host-mounted repositories in containers) that commit fine unsigned.
		"-c".to_owned(),
		"safe.directory=*".to_owned(),
		"commit-tree".to_owned(),
		"-S".to_owned(),
		tree.to_hex().to_string(),
	];
	for parent in parents {
		args.push("-p".to_owned());
		args.push(parent.to_hex().to_string());
	}
	// Raw `<seconds> <offset>` dates need the `@` marker: without it git falls
	// back to its approximate-date parser, which rejects timestamps under
	// nine digits.
	let author_date = format!("@{}", author.time);
	let committer_date = format!("@{}", committer.time);
	let env: [(&str, &OsStr); 6] = [
		("GIT_AUTHOR_NAME", &author.name.to_os_str_lossy()),
		("GIT_AUTHOR_EMAIL", &author.email.to_os_str_lossy()),
		("GIT_AUTHOR_DATE", author_date.as_ref()),
		("GIT_COMMITTER_NAME", &committer.name.to_os_str_lossy()),
		("GIT_COMMITTER_EMAIL", &committer.email.to_os_str_lossy()),
		("GIT_COMMITTER_DATE", committer_date.as_ref()),
	];
	// The message travels over stdin so it reaches git byte-for-byte, with no
	// file path to re-encode.
	let output = super::cli::run_sync_write(
		repository.root(),
		&args,
		super::cli::COMMAND_TIMEOUT,
		&super::cli::SyncWrite { stdin: message.as_bytes(), env: &env },
	)?
	.into_checked(&args)?;
	gix::hash::ObjectId::from_hex(output.stdout.trim().as_bytes())
		.map_err(|err| Error::backend("git commit-tree", err))
}

/// Mirrors git's `find_hook`: any failure to stat the hook (missing, or
/// `core.hooksPath` pointing at a non-directory such as `/dev/null`) means
/// "no hook", never a commit failure.
fn hook_is_executable(path: &Path) -> bool {
	let Ok(metadata) = fs::metadata(path) else {
		return false;
	};
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		metadata.is_file()
	}
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
	match fs::read(path) {
		Ok(bytes) => Ok(Some(bytes)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// Sever a copied linked worktree from its source metadata without copying
/// objects.
pub fn detach_git_dir(
	worktree_root: &Path,
	source_common_dir: &Path,
) -> Result<DetachGitDirResult> {
	let git_entry = worktree_root.join(".git");
	let meta = match fs::symlink_metadata(&git_entry) {
		Ok(meta) => meta,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DetachGitDirResult::NoGit),
		Err(e) => return Err(e.into()),
	};
	let source_common =
		fs::canonicalize(source_common_dir).unwrap_or_else(|_| normalize_path(source_common_dir));
	let original = GitRepo::require(worktree_root)?;
	let iso_common = fs::canonicalize(&original.info().common_dir)
		.unwrap_or_else(|_| normalize_path(&original.info().common_dir));
	if iso_common != source_common {
		return Ok(DetachGitDirResult::Independent);
	}
	let repo = original.gix()?;
	let head = read_optional_file(&original.info().head_path)?;
	let index = read_optional_file(&original.info().git_dir.join("index"))?;
	let refs = snapshot_refs(&repo)?;
	let config_values = [
		"user.name",
		"user.email",
		"core.fileMode",
		"core.splitIndex",
		"core.sparseCheckout",
		"core.sparseCheckoutCone",
	]
	.into_iter()
	.filter_map(|key| {
		repo
			.config_snapshot()
			.string(key)
			.map(|v| (key, v.to_str_lossy().into_owned()))
	})
	.collect::<Vec<_>>();
	let shared = copy_named_files(&original.info().git_dir, "sharedindex.")?;
	let sparse = read_optional_file(&original.info().git_dir.join("info/sparse-checkout"))?;
	let shallow = read_optional_file(&source_common.join("shallow"))?;
	let own_admin = if meta.is_file() {
		registered_admin(&git_entry)?
	} else {
		None
	};
	if meta.is_dir() {
		fs::remove_dir_all(&git_entry)?;
	} else {
		fs::remove_file(&git_entry)?;
	}
	if let Some(admin) = own_admin {
		fs::remove_dir_all(admin)?;
	}
	gix::init(worktree_root).map_err(|e| Error::backend("git init", e))?;
	let objects_info = git_entry.join("objects/info");
	fs::create_dir_all(&objects_info)?;
	let mut alternates = vec![source_common.join("objects")];
	if let Ok(chained) = fs::read_to_string(source_common.join("objects/info/alternates")) {
		for line in chained
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let path = Path::new(line);
			alternates.push(if path.is_absolute() {
				path.to_owned()
			} else {
				source_common.join("objects").join(path)
			});
		}
	}
	let alternate_text = alternates
		.iter()
		.map(|p| p.to_string_lossy())
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	fs::write(objects_info.join("alternates"), alternate_text)?;
	for (name, id) in refs {
		write_loose_ref(&git_entry, &name, id)?;
	}
	if let Some(head) = head {
		fs::write(git_entry.join("HEAD"), head)?;
	}
	for (key, value) in config_values {
		set_config_file(&git_entry.join("config"), key, &value)?;
	}
	if let Some(bytes) = shallow {
		fs::write(git_entry.join("shallow"), bytes)?;
	}
	if let Some(bytes) = sparse {
		fs::create_dir_all(git_entry.join("info"))?;
		fs::write(git_entry.join("info/sparse-checkout"), bytes)?;
	}
	for (name, bytes) in shared {
		fs::write(git_entry.join(name), bytes)?;
	}
	if let Some(bytes) = index {
		fs::write(git_entry.join("index"), bytes)?;
	} else if let Ok(detached) = GitRepo::require(worktree_root)
		&& resolve_commit(&detached.gix()?, "HEAD").is_ok()
	{
		detached.read_tree("HEAD", None)?;
	}
	Ok(DetachGitDirResult::Detached)
}

/// Author signature for an explicit [`CommitAuthor`]; a missing date means now.
fn signature_for(author: &CommitAuthor) -> Result<gix::actor::Signature> {
	let time = match &author.date {
		Some(date) => {
			gix::date::parse(date, None).map_err(|err| Error::backend("git commit", err))?
		},
		None => gix::date::Time::now_local_or_utc(),
	};
	Ok(gix::actor::Signature {
		name: author.name.clone().into(),
		email: author.email.clone().into(),
		time,
	})
}

fn resolve_commit(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_commit()
		.map(|commit| commit.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn resolve_tree(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_tree()
		.map(|tree| tree.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn commit_tree(repo: &gix::Repository, id: &gix::hash::ObjectId) -> Result<gix::hash::ObjectId> {
	let commit = repo
		.find_commit(*id)
		.map_err(|e| Error::backend("git commit", e))?;
	commit
		.tree_id()
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git commit", e))
}

fn head_tree(repo: &gix::Repository) -> Result<Option<gix::hash::ObjectId>> {
	match repo
		.head()
		.map_err(|e| Error::backend("git reset", e))?
		.try_peel_to_id()
		.map_err(|e| Error::backend("git reset", e))?
	{
		Some(id) => Ok(Some(
			id.object()
				.map_err(|e| Error::backend("git reset", e))?
				.peel_to_commit()
				.map_err(|e| Error::backend("git reset", e))?
				.tree_id()
				.map_err(|e| Error::backend("git reset", e))?
				.detach(),
		)),
		None => Ok(None),
	}
}

fn index_for_tree(
	repo: &gix::Repository,
	tree: Option<&gix::hash::ObjectId>,
) -> Result<gix::index::File> {
	match tree {
		Some(tree) => repo
			.index_from_tree(tree)
			.map_err(|e| Error::backend("git index", e)),
		None => Ok(gix::index::File::from_state(
			gix::index::State::new(repo.object_hash()),
			repo.index_path(),
		)),
	}
}

fn collect_stage_paths(
	repo: &GitRepo,
	requested: &BTreeSet<String>,
	all: bool,
) -> Result<BTreeSet<String>> {
	let untracked = if all || requested.contains("") {
		repo.ls_files(true, true)?
	} else {
		repo.ls_files_at_paths(true, true, requested)?
	};
	Ok(untracked.into_iter().collect())
}

fn normalize_stage_path(path: &str) -> String {
	let normalized = path.replace('\\', "/");
	let mut relative = normalized.as_str();
	while let Some(stripped) = relative.strip_prefix("./") {
		relative = stripped;
	}
	if relative == "." {
		String::new()
	} else {
		relative.trim_end_matches('/').to_owned()
	}
}

fn stage_path_matches(path: &str, wanted: &str) -> bool {
	wanted.is_empty() || path_matches(path, wanted)
}

fn remap_composed_index_paths(
	root: &Path,
	index: &gix::index::File,
	selected: BTreeSet<String>,
) -> BTreeSet<String> {
	let mut exact = BTreeSet::new();
	let mut by_composed = BTreeMap::new();
	let mut dir_by_composed: BTreeMap<String, String> = BTreeMap::new();
	for entry in index.entries() {
		let Ok(name) = entry.path(index).to_str() else {
			continue;
		};
		exact.insert(name.to_owned());
		by_composed
			.entry(precomposed(name).into_owned())
			.or_insert_with(|| name.to_owned());
		let mut start = 0;
		while let Some(slash) = name[start..].find('/') {
			let dir = &name[..start + slash];
			if !dir.is_empty() {
				dir_by_composed
					.entry(precomposed(dir).into_owned())
					.or_insert_with(|| dir.to_owned());
			}
			start += slash + 1;
		}
	}
	selected
		.into_iter()
		.map(|path| {
			if exact.contains(&path) {
				return path;
			}
			if let Some(alias) = by_composed.get(precomposed(&path).as_ref())
				&& alias != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias.clone();
				}
			}
			let composed = precomposed(&path);
			if let Some(alias_dir) = dir_by_composed.get(composed.as_ref())
				&& alias_dir != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias_dir)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias_dir.clone();
				}
			}
			path
		})
		.collect()
}

fn precompose_unicode_enabled(repo: &gix::Repository) -> bool {
	repo
		.config_snapshot()
		.boolean("core.precomposeUnicode")
		.unwrap_or(false)
}

fn precomposed(path: &str) -> std::borrow::Cow<'_, str> {
	gix_utils::str::precompose(std::borrow::Cow::Borrowed(path))
}

#[cfg(unix)]
fn same_worktree_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt;
	left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
#[allow(clippy::missing_const_for_fn, reason = "matches non-const unix signature")]
fn same_worktree_file(_: &fs::Metadata, _: &fs::Metadata) -> bool {
	false
}

/// The new index entry for a staged path.
struct StagedEntry {
	path: BString,
	stat: gix::index::entry::Stat,
	id:   gix::ObjectId,
	mode: gix::index::entry::Mode,
}

/// What staging a path does to its index entries.
enum Staged {
	/// Replace them with this entry.
	Entry(StagedEntry),
	/// Drop them: the path vanished or is untrackable (socket), as `git add`
	/// would.
	Removed,
	/// Leave them: a plain directory.
	Kept,
}

/// Write the filtered worktree content at `path` into the object database.
fn stage_one(
	root: &Path,
	filter: &mut gix::filter::Pipeline<'_>,
	filter_index: &gix::index::State,
	path: &str,
	staging_started: u64,
) -> Result<Staged> {
	use gix::objs::tree::EntryKind;
	let rela_path = path.as_bytes().as_bstr();
	// Stat before reading, as `git add` does, so the entry keeps a valid stat
	// cache: a write landing after the stat changes the file's stat and later
	// status calls re-hash it. A file last changed in the second staging
	// began could change again within that second and keep its stat, so its
	// stat is not recorded and the next status compares contents instead.
	let stat = gix::index::fs::Metadata::from_path_no_follow(&root.join(path))
		.ok()
		.and_then(|metadata| gix::index::entry::Stat::from_fs(&metadata).ok())
		.filter(|stat| u64::from(stat.mtime.secs) < staging_started)
		.unwrap_or_default();
	let Some((id, kind, _)) = filter
		.worktree_file_to_object(rela_path, filter_index)
		.map_err(|err| Error::backend("git add", err))?
	else {
		return Ok(Staged::Removed);
	};
	let mode = match kind {
		EntryKind::Blob => gix::index::entry::Mode::FILE,
		EntryKind::BlobExecutable => gix::index::entry::Mode::FILE_EXECUTABLE,
		EntryKind::Link => gix::index::entry::Mode::SYMLINK,
		EntryKind::Commit => gix::index::entry::Mode::COMMIT,
		EntryKind::Tree => return Ok(Staged::Kept),
	};
	Ok(Staged::Entry(StagedEntry { path: rela_path.to_owned(), stat, id, mode }))
}

fn copy_index_paths(dest: &mut gix::index::File, source: &gix::index::File, files: &[String]) {
	let all = files.is_empty();
	dest.remove_entries(|_, path, _| {
		all || files
			.iter()
			.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
	});
	for entry in source.entries() {
		let path = entry.path(source);
		if all
			|| files
				.iter()
				.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
		{
			dest.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, path);
		}
	}
	dest.sort_entries();
}

#[derive(Default)]
struct TreeNode {
	files: Vec<(BString, gix::index::entry::Mode, gix::hash::ObjectId)>,
	dirs:  BTreeMap<BString, Self>,
}

fn write_index_tree(
	repo: &gix::Repository,
	index: &gix::index::File,
) -> Result<gix::hash::ObjectId> {
	let mut root = TreeNode::default();
	for entry in index
		.entries()
		.iter()
		.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
	{
		let parts: Vec<&[u8]> = entry.path(index).split(|b| *b == b'/').collect();
		let mut node = &mut root;
		for part in &parts[..parts.len().saturating_sub(1)] {
			node = node.dirs.entry(BString::from(*part)).or_default();
		}
		if let Some(name) = parts.last() {
			node
				.files
				.push((BString::from(*name), entry.mode, entry.id));
		}
	}
	write_tree_node(repo, root)
}

fn write_tree_node(repo: &gix::Repository, node: TreeNode) -> Result<gix::hash::ObjectId> {
	let mut entries = Vec::with_capacity(node.files.len() + node.dirs.len());
	for (name, mode, oid) in node.files {
		let mode = gix::objs::tree::EntryMode::try_from(mode.bits())
			.map_err(|m| Error::backend("git write-tree", format!("invalid mode {m:o}")))?;
		entries.push(gix::objs::tree::Entry { mode, filename: name, oid });
	}
	for (name, child) in node.dirs {
		entries.push(gix::objs::tree::Entry {
			mode:     gix::objs::tree::EntryKind::Tree.into(),
			filename: name,
			oid:      write_tree_node(repo, child)?,
		});
	}
	entries.sort();
	repo
		.write_object(&gix::objs::Tree { entries })
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git write-tree", e))
}

fn resolve_checkout_target(
	repo: &gix::Repository,
	rev: &str,
) -> Result<(gix::hash::ObjectId, Option<String>)> {
	let branch = if rev.starts_with("refs/heads/") {
		Some(rev.to_owned())
	} else {
		let full = format!("refs/heads/{rev}");
		repo
			.try_find_reference(&full)
			.map_err(|e| Error::backend("git checkout", e))?
			.map(|_| full)
	};
	Ok((resolve_commit(repo, branch.as_deref().unwrap_or(rev))?, branch))
}

fn checkout_tree(
	owner: &GitRepo,
	repo: &gix::Repository,
	commit: gix::hash::ObjectId,
	overwrite: bool,
) -> Result<()> {
	let tree = commit_tree(repo, &commit)?;
	let mut target = repo
		.index_from_tree(&tree)
		.map_err(|e| Error::backend("git checkout", e))?;
	let current = load_index_or_head(repo, "git checkout")?;
	let conflicts = checkout_conflicts(owner.root(), repo, &current, &target)?;
	if !overwrite && !conflicts.is_empty() {
		return Err(Error::Conflict { paths: conflicts });
	}
	let mut collisions = Vec::new();
	for entry in target.entries() {
		let path = entry.path(&target).to_str_lossy().into_owned();
		if current.entry_by_path(path.as_bytes().as_bstr()).is_none()
			&& fs::symlink_metadata(owner.root().join(&path)).is_ok()
		{
			collisions.push(path);
		}
	}
	if !collisions.is_empty() {
		return Err(Error::Conflict { paths: collisions });
	}
	let target_paths: BTreeSet<String> = target
		.entries()
		.iter()
		.map(|e| e.path(&target).to_str_lossy().into_owned())
		.collect();
	for entry in current.entries() {
		let path = entry.path(&current).to_str_lossy();
		if !target_paths.contains(path.as_ref()) {
			let full = owner.root().join(path.as_ref());
			if full.is_file() || fs::symlink_metadata(&full).is_ok() {
				fs::remove_file(full)?;
			}
		}
	}
	let mut opts = repo
		.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
		.map_err(|e| Error::backend("git checkout", e))?;
	opts.overwrite_existing = true;
	let progress = gix::progress::Discard;
	let interrupt = std::sync::atomic::AtomicBool::new(false);
	gix::worktree::state::checkout(
		&mut target,
		owner.root(),
		repo
			.objects
			.clone()
			.into_arc()
			.map_err(|e| Error::backend("git checkout", e))?,
		&progress,
		&progress,
		&interrupt,
		opts,
	)
	.map_err(|e| Error::backend("git checkout", e))?;
	target
		.write(INDEX_WRITE)
		.map_err(|e| Error::backend("git checkout", e))
}

fn checkout_conflicts(
	root: &Path,
	repo: &gix::Repository,
	current: &gix::index::File,
	target: &gix::index::File,
) -> Result<Vec<String>> {
	let mut conflicts = Vec::new();
	let mut filter = WorktreeFilter::staging(repo, "git checkout")?;
	for entry in current.entries() {
		let path = entry.path(current).to_str_lossy().into_owned();
		let target_entry = target.entry_by_path(path.as_bytes().as_bstr());
		if target_entry.is_some_and(|e| e.id == entry.id && e.mode == entry.mode) {
			continue;
		}
		if worktree_id(repo, &mut filter, root, &path, entry.mode)? != Some(entry.id) {
			conflicts.push(path);
		}
	}
	conflicts.sort();
	conflicts.dedup();
	Ok(conflicts)
}

/// Blob id the worktree entry at repo-relative `path` would be staged as —
/// regular files pass through the clean filters, so a CRLF checkout under
/// `core.autocrlf` matches its LF blob — or `None` when it is missing.
fn worktree_id(
	repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	root: &Path,
	path: &str,
	mode: gix::index::entry::Mode,
) -> Result<Option<gix::hash::ObjectId>> {
	let absolute = root.join(path);
	if !absolute.exists() && fs::symlink_metadata(&absolute).is_err() {
		return Ok(None);
	}
	let data = if mode == gix::index::entry::Mode::SYMLINK {
		fs::read_link(&absolute)?
			.to_string_lossy()
			.into_owned()
			.into_bytes()
	} else {
		filter.worktree_to_git(path, fs::read(&absolute)?)?
	};
	Ok(Some(
		gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, &data)
			.map_err(|e| Error::backend("git checkout", e))?,
	))
}

fn write_head(path: &Path, symbolic: Option<&str>, id: gix::hash::ObjectId) -> Result<()> {
	fs::write(path, match symbolic {
		Some(name) => format!("ref: {name}\n"),
		None => format!("{}\n", id.to_hex()),
	})?;
	Ok(())
}

fn update_current_head(repo: &gix::Repository, path: &Path, id: gix::hash::ObjectId) -> Result<()> {
	let content = fs::read_to_string(path).unwrap_or_default();
	if let Some(name) = content.trim().strip_prefix("ref: ") {
		update_reference(
			repo,
			"git reset",
			name,
			id,
			gix::refs::transaction::PreviousValue::Any,
			"reset: moving to target",
			false,
		)?;
	} else {
		fs::write(path, format!("{}\n", id.to_hex()))?;
	}
	Ok(())
}

fn restore_index_paths(
	root: &Path,
	repo: &gix::Repository,
	index: &gix::index::File,
	files: &[String],
) -> Result<()> {
	let mut filter = WorktreeFilter::staging(repo, "git restore")?;
	for entry in index.entries() {
		let path = entry.path(index).to_str_lossy();
		if files.is_empty() || files.iter().any(|wanted| path_matches(&path, wanted)) {
			let object = repo
				.find_object(entry.id)
				.map_err(|e| Error::backend("git restore", e))?;
			let mut blob = object
				.try_into_blob()
				.map_err(|e| Error::backend("git restore", e))?;
			let full = root.join(path.as_ref());
			if let Some(parent) = full.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::write(full, filter.git_to_worktree(&path, blob.take_data())?)?;
		}
	}
	Ok(())
}

fn path_matches(path: &str, wanted: &str) -> bool {
	let wanted = wanted.trim_end_matches('/');
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|r| r.starts_with('/'))
}

fn set_config_file(path: &Path, key: &str, value: &str) -> Result<()> {
	let mut config = if path.exists() {
		gix::config::File::from_path_no_includes(path.to_owned(), gix::config::Source::Local)
			.map_err(|e| Error::backend("git config", e))?
	} else {
		gix::config::File::default()
	};
	config
		.set_raw_value(key, value)
		.map_err(|e| Error::backend("git config", e))?;
	let mut bytes = Vec::new();
	config.write_to(&mut bytes)?;
	fs::write(path, bytes)?;
	Ok(())
}

/// Paths whose entry differs between `left` and `right` (blob id or mode), or
/// that exist on only one side.
fn index_diff_paths(left: &gix::index::File, right: &gix::index::File) -> BTreeSet<BString> {
	let mut paths = BTreeSet::new();
	for entry in left.entries() {
		let entry_path = entry.path(left);
		if right
			.entry_by_path(entry_path)
			.is_none_or(|other| other.id != entry.id || other.mode != entry.mode)
		{
			paths.insert(entry_path.to_owned());
		}
	}
	for entry in right.entries() {
		let entry_path = entry.path(right);
		if left.entry_by_path(entry_path).is_none() {
			paths.insert(entry_path.to_owned());
		}
	}
	paths
}

/// Point the stat cache of every index entry outside `dirty` at the file now
/// under `root`, so entries whose content matches the index read as clean.
fn refresh_clean_index_stats(
	index: &mut gix::index::File,
	root: &Path,
	dirty: &BTreeSet<BString>,
) -> Result<()> {
	for (entry, entry_path) in index.entries_mut_with_paths() {
		if dirty.contains(entry_path) {
			continue;
		}
		let Ok(metadata) =
			gix::index::fs::Metadata::from_path_no_follow(&root.join(entry_path.to_path_lossy()))
		else {
			continue;
		};
		entry.stat = gix::index::entry::Stat::from_fs(&metadata)
			.map_err(|err| Error::backend("git worktree add", err))?;
	}
	Ok(())
}

fn collect_clone_reconciliation_paths(
	repo: &gix::Repository,
) -> Result<(BTreeSet<BString>, BTreeSet<BString>)> {
	let platform = status_with_fresh_index(repo, "git worktree add")?
		.untracked_files(gix::status::UntrackedFiles::Files);
	let iter = platform
		.into_iter(std::iter::empty::<gix::bstr::BString>())
		.map_err(|err| Error::backend("git worktree add", err))?;
	let mut dirty_tracked = BTreeSet::new();
	let mut untracked = BTreeSet::new();
	for item in iter {
		let item = item.map_err(|err| Error::backend("git worktree add", err))?;
		let gix::status::Item::IndexWorktree(change) = item else {
			continue;
		};
		use gix::status::index_worktree;
		match change {
			index_worktree::Item::Modification { rela_path, status, .. }
				if !matches!(
					status,
					gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_)
				) =>
			{
				dirty_tracked.insert(rela_path);
			},
			index_worktree::Item::DirectoryContents { entry, .. }
				if entry.status == gix::dir::entry::Status::Untracked =>
			{
				untracked.insert(entry.rela_path);
			},
			index_worktree::Item::Rewrite { source, dirwalk_entry, .. } => {
				dirty_tracked.insert(dirwalk_entry.rela_path);
				match source {
					index_worktree::RewriteSource::RewriteFromIndex { source_rela_path, .. } => {
						dirty_tracked.insert(source_rela_path);
					},
					index_worktree::RewriteSource::CopyFromDirectoryEntry {
						source_dirwalk_entry,
						..
					} => {
						untracked.insert(source_dirwalk_entry.rela_path);
					},
				}
			},
			_ => {},
		}
	}
	Ok((dirty_tracked, untracked))
}

/// Whether `dir` is a directory a clone cannot relocate, as its files name
/// their own path: a Python virtual environment (`pyvenv.cfg`) or a build
/// directory holding `CMakeCache.txt`.
fn is_nonrelocatable_dir(dir: &Path) -> bool {
	dir.join("pyvenv.cfg").is_file() || dir.join("CMakeCache.txt").is_file()
}

/// Drop source-bound environments from a fresh clone, never following
/// symlinks or walking Git metadata. Return the removed directory paths so
/// target-tracked entries can be checked out even when both indexes agree.
fn prune_nonrelocatable_clone_dirs(root: &Path) -> Result<BTreeSet<PathBuf>> {
	let mut excluded = BTreeSet::new();
	let mut pending = vec![root.to_path_buf()];
	while let Some(dir) = pending.pop() {
		let marked = is_nonrelocatable_dir(&dir);
		if marked && dir != root {
			remove_existing(&dir)?;
			excluded.insert(
				dir.strip_prefix(root)
					.expect("cloned directory is under root")
					.to_path_buf(),
			);
			continue;
		}
		for entry in fs::read_dir(&dir)? {
			let entry = entry?;
			if entry.file_name() == ".git" {
				continue;
			}
			if marked {
				remove_existing(&entry.path())?;
			} else if entry.file_type()?.is_dir() {
				pending.push(entry.path());
			}
		}
		if marked {
			excluded.insert(PathBuf::new());
		}
	}
	Ok(excluded)
}

/// Carry one live source path without following symlinks, including a
/// deletion. Used both by ordinary-checkout seeding and by tracked files
/// restored after clone exclusions. Git does not see a path behind a
/// symlinked or non-directory ancestor, so in the source such a path is
/// deleted. In the new tree, an ancestor that is not a real directory where
/// the source has one (a tracked file or symlink the source replaced with a
/// directory) is replaced, never followed, and a path the source turned into
/// a directory loses the file or symlink it was.
fn copy_worktree_path(source: &Path, target: &Path, relative: &gix::bstr::BStr) -> Result<()> {
	let relative = relative.to_path_lossy();
	let src = source.join(&relative);
	let dst = target.join(&relative);
	let found = if replace_target_ancestors(source, target, &relative)? {
		fs::symlink_metadata(&src)
	} else {
		Err(std::io::ErrorKind::NotFound.into())
	};
	match found {
		Ok(meta) if meta.file_type().is_symlink() => {
			remove_existing(&dst)?;
			if let Some(parent) = dst.parent() {
				fs::create_dir_all(parent)?;
			}
			copy_symlink(&src, &dst)?;
		},
		Ok(meta) if meta.is_file() => {
			remove_existing(&dst)?;
			if let Some(parent) = dst.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::copy(&src, &dst)?;
		},
		// The entries below it are carried one by one; what the path was in
		// the new tree, if not a directory, goes.
		Ok(meta) if meta.is_dir() => {
			if fs::symlink_metadata(&dst).is_ok_and(|meta| !meta.is_dir()) {
				remove_existing(&dst)?;
			}
		},
		Ok(_) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
			if !behind_link(target, &relative)? {
				remove_existing(&dst)?;
				prune_empty_parents(target, dst.parent(), &BTreeSet::new())?;
			}
		},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

/// Walks the directories between each root and the last component of
/// `relative`. Returns `false` when one of the source's is a symlink, not a
/// directory, or missing, so git sees the path as deleted. Until then, each
/// target ancestor that is a file or symlink where the source has a real
/// directory is removed, so the path is written below a real directory and
/// never through a link.
fn replace_target_ancestors(source: &Path, target: &Path, relative: &Path) -> Result<bool> {
	let Some(parent) = relative.parent() else {
		return Ok(true);
	};
	let (mut src_dir, mut dst_dir) = (source.to_path_buf(), target.to_path_buf());
	let mut dst_present = true;
	for component in parent.components() {
		src_dir.push(component);
		match fs::symlink_metadata(&src_dir) {
			Ok(meta) if meta.is_dir() => {},
			Ok(_) => return Ok(false),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
			Err(err) => return Err(err.into()),
		}
		if !dst_present {
			continue;
		}
		dst_dir.push(component);
		match fs::symlink_metadata(&dst_dir) {
			Ok(meta) if meta.is_dir() => {},
			Ok(_) => {
				remove_existing(&dst_dir)?;
				dst_present = false;
			},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => dst_present = false,
			Err(err) => return Err(err.into()),
		}
	}
	Ok(true)
}

/// Whether a directory between `root` and the last component of `relative`
/// is a symlink or not a directory, so `relative` cannot be reached below
/// `root` without leaving it. A missing ancestor ends the check: nothing
/// lies beyond it.
fn behind_link(root: &Path, relative: &Path) -> std::io::Result<bool> {
	let Some(parent) = relative.parent() else {
		return Ok(false);
	};
	let mut current = root.to_path_buf();
	for component in parent.components() {
		current.push(component);
		match fs::symlink_metadata(&current) {
			Ok(meta) if meta.is_dir() => {},
			Ok(_) => return Ok(true),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
			Err(err) => return Err(err),
		}
	}
	Ok(false)
}

fn git_metadata_path(path: &Path) -> Cow<'_, str> {
	let display = path.to_string_lossy();
	if cfg!(windows) {
		Cow::Owned(display.replace('\\', "/"))
	} else {
		display
	}
}

/// File a running [`GitRepo::worktree_add`] keeps locked in the new
/// registration's administrative directory until the add finishes. Its first
/// line records the tree directory the add made (`tree <dev> <ino> <token>`,
/// see [`TreeMark`], or `tree -` before there is one or where it cannot be
/// marked), its second what the add wrote to the registration's `HEAD`
/// (`head <value>`), and the rest is exactly what the add wrote to `locked`.
/// A registration holding it unlocked is an add that died before it
/// finished.
const ADD_IN_PROGRESS: &str = "omp-add-in-progress";

/// What `git worktree add` writes to a new registration's `locked` file while
/// it fills the tree, so `git worktree prune` leaves the registration alone.
const LOCK_WHILE_ADDING: &str = "initializing\n";

/// A linked worktree's registration from its first write until
/// [`GitRepo::worktree_add`] finishes. It is locked from the start, as git
/// locks it (with the caller's reason, or git's `initializing`), and holds
/// [`ADD_IN_PROGRESS`] locked by this process where the filesystem can lock
/// it. Dropped before [`Self::finish`], it removes the tree and the
/// registration.
struct PendingWorktree {
	path:     PathBuf,
	admin:    PathBuf,
	/// What `locked` holds while the add runs.
	locked:   String,
	/// What the registration's `HEAD` holds, without its final newline.
	head:     String,
	/// The locked marker; `None` where the filesystem cannot lock, so no later
	/// add can take this registration for an abandoned one.
	marker:   Option<fs::File>,
	/// The mode of the empty directory that was at `path` before the add,
	/// which is left there, empty, with that mode; `None` when the add made
	/// the directory.
	existed:  Option<fs::Permissions>,
	finished: bool,
}

impl PendingWorktree {
	/// Registers `path` as a linked worktree of `common` at `head` and makes
	/// its tree directory. With `lock`, the lock is the caller's from the
	/// start, as `git worktree add --lock --reason <lock>` writes it: git's
	/// `write_file` completes non-empty content that lacks a final newline
	/// with one, and writes an empty reason as an empty file.
	fn begin(path: &Path, common: &Path, head: &str, lock: Option<&str>) -> Result<Self> {
		let root = common.join("worktrees");
		fs::create_dir_all(&root)?;
		let admin = loop {
			let admin = root.join(worktree_admin_name(common, path));
			match fs::create_dir(&admin) {
				Ok(()) => break admin,
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {},
				Err(err) => return Err(err.into()),
			}
		};
		let locked = match lock {
			Some(reason) if !reason.is_empty() && !reason.ends_with('\n') => format!("{reason}\n"),
			Some(reason) => reason.to_owned(),
			None => LOCK_WHILE_ADDING.to_owned(),
		};
		let mut pending = Self {
			path: path.to_path_buf(),
			admin,
			locked,
			head: head.to_owned(),
			marker: None,
			existed: fs::symlink_metadata(path)
				.ok()
				.filter(fs::Metadata::is_dir)
				.map(|meta| meta.permissions()),
			finished: false,
		};
		// The lock comes first, as in git's own add, so `git worktree prune`
		// never takes the registration while it is being written.
		fs::write(pending.admin.join("locked"), &pending.locked)?;
		pending.marker = lock_marker(&pending.admin, &pending.record(None))?;
		fs::write(
			pending.admin.join("gitdir"),
			format!("{}\n", git_metadata_path(&path.join(".git"))),
		)?;
		fs::write(pending.admin.join("commondir"), "../..\n")?;
		fs::write(pending.admin.join("HEAD"), format!("{head}\n"))?;
		pending.make_tree()?;
		Ok(pending)
	}

	/// The marker's content for a tree directory marked `mark`.
	fn record(&self, mark: Option<&TreeMark>) -> String {
		let tree = match mark {
			Some(TreeMark { dev, ino, token }) => format!("tree {dev} {ino} {token}"),
			None => "tree -".to_owned(),
		};
		format!("{tree}\nhead {}\n{}", self.head, self.locked)
	}

	/// Makes the tree directory (an empty one already there is kept), marks
	/// it and records the mark in the marker before anything is written into
	/// it, so a later add can tell it from a directory someone made in its
	/// place.
	fn make_tree(&self) -> Result<()> {
		fs::create_dir_all(&self.path)?;
		let Some(marker) = &self.marker else {
			return Ok(());
		};
		let record = self.record(mark_tree(&self.path).as_ref());
		let mut file = marker;
		io::Seek::seek(&mut file, io::SeekFrom::Start(0))?;
		io::Write::write_all(&mut file, record.as_bytes())?;
		marker.set_len(record.len() as u64)?;
		Ok(())
	}

	/// Writes the tree's `.git`, which names the registration.
	fn link(&self) -> Result<()> {
		fs::create_dir_all(&self.path)?;
		fs::write(self.path.join(".git"), format!("gitdir: {}\n", git_metadata_path(&self.admin)))?;
		Ok(())
	}

	/// Clears the tree of a failed attempt and marks it afresh, keeping the
	/// registration for the next attempt. A clone copies the source root's
	/// mode onto the tree, which can leave it unwritable. A directory that
	/// was there before the add (it can be a mount point) stays, emptied,
	/// and gets the mode it had back where the attempt changed it; one the
	/// attempt removed is made again with that mode (a new inode). One the
	/// add made goes, and is made again as the add first made it.
	fn reset_tree(&self) -> Result<()> {
		let is_dir = fs::symlink_metadata(&self.path).is_ok_and(|meta| meta.is_dir());
		match &self.existed {
			Some(mode) if is_dir => {
				restore_mode(&self.path, mode)?;
				remove_contents(&self.path)?;
			},
			Some(mode) => {
				remove_existing(&self.path)?;
				fs::create_dir_all(&self.path)?;
				restore_mode(&self.path, mode)?;
			},
			None => {
				#[cfg(unix)]
				if is_dir {
					make_owner_writable(&self.path)?;
				}
				remove_existing(&self.path)?;
			},
		}
		self.make_tree()
	}

	/// Ends the add. The add counts as finished from here on, so nothing that
	/// fails below removes the worktree; git too only warns when it cannot
	/// remove its lock. The marker goes first, emptied before it is removed so
	/// that even a marker that cannot be removed records nothing a later add
	/// would act on; then `locked`, unless the caller asked for a lock.
	/// Returns a note for each step that failed.
	fn finish(&mut self, lock: Option<&str>) -> Vec<String> {
		self.finished = true;
		let mut notes = Vec::new();
		if let Some(marker) = self.marker.take() {
			let path = self.admin.join(ADD_IN_PROGRESS);
			let emptied = marker.set_len(0);
			if let Err(err) = fs::remove_file(&path) {
				notes.push(match emptied {
					Ok(()) => format!("could not remove the emptied {}: {err}", path.display()),
					Err(empty) => {
						format!("could not remove or empty {}: {err}; {empty}", path.display())
					},
				});
			}
			release(marker);
		}
		clear_tree_mark(&self.path);
		if lock.is_none()
			&& let Err(err) = remove_existing(&self.admin.join("locked"))
		{
			notes.push(format!(
				"worktree {} is still locked: could not remove {}: {err}",
				self.path.display(),
				self.admin.join("locked").display()
			));
		}
		notes
	}
}

impl Drop for PendingWorktree {
	/// An add that returns before it finished removes what it made: the tree
	/// (an empty directory again where one was) and the registration. The
	/// marker is released last, so no reclaim can take the registration
	/// while it is still there.
	fn drop(&mut self) {
		if self.finished {
			return;
		}
		let _ = remove_existing(&self.path);
		if let Some(mode) = &self.existed {
			let _ = fs::create_dir_all(&self.path);
			let _ = restore_mode(&self.path, mode);
		}
		let _ = fs::remove_dir_all(&self.admin);
		#[cfg(test)]
		test_hooks::before_marker_release(&self.admin);
		if let Some(marker) = self.marker.take() {
			release(marker);
		}
	}
}

/// What an add records of the tree directory it made: its device and inode,
/// and a random token it set on the directory as an extended attribute. A
/// directory someone made again in its place (`mkdir`) can get the same
/// device and inode, but never the token. A copy that keeps extended
/// attributes (`cp -a`, `tar --xattrs`) carries the token, but gets another
/// inode unless the filesystem reuses the old one at once.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(windows, allow(dead_code, reason = "Windows never marks a tree or reads a mark back"))]
struct TreeMark {
	dev:   u64,
	ino:   u64,
	token: String,
}

#[cfg(unix)]
impl TreeMark {
	/// Parses a mark as a marker records it after `tree `:
	/// `<dev> <ino> <token>`.
	fn parse(text: &str) -> Option<Self> {
		let mut parts = text.split(' ');
		let mark = Self {
			dev:   parts.next()?.parse().ok()?,
			ino:   parts.next()?.parse().ok()?,
			token: parts.next().filter(|token| !token.is_empty())?.to_owned(),
		};
		parts.next().is_none().then_some(mark)
	}

	/// Whether `meta` and `token` are the directory this mark was set on.
	#[cfg(target_os = "linux")]
	fn is(&self, meta: &fs::Metadata, token: Option<&str>) -> bool {
		use std::os::unix::fs::MetadataExt;
		meta.is_dir()
			&& meta.dev() == self.dev
			&& meta.ino() == self.ino
			&& token == Some(self.token.as_str())
	}
}

/// Sets a fresh token on the directory `dir` and returns its mark; `None`
/// where the filesystem keeps no user extended attributes, or off Linux, so
/// that a later add never takes a directory there for this add's.
#[cfg(target_os = "linux")]
fn mark_tree(dir: &Path) -> Option<TreeMark> {
	use std::os::unix::fs::MetadataExt;
	let token = tree_mark::set(dir).ok()?;
	let meta = fs::symlink_metadata(dir).ok()?;
	Some(TreeMark { dev: meta.dev(), ino: meta.ino(), token })
}

#[cfg(not(target_os = "linux"))]
const fn mark_tree(_dir: &Path) -> Option<TreeMark> {
	None
}

/// The tree directory a reclaim checks and empties, held open from the
/// check to the removal, so a path swapped for a symlink or another directory
/// in between is never followed: the checks and the removal all go through
/// this descriptor, never through the path again.
#[cfg(target_os = "linux")]
mod tree_dir {
	use std::{
		ffi::{CStr, CString, OsStr},
		fs, io,
		os::{
			fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
			unix::ffi::OsStrExt,
		},
		path::{Path, PathBuf},
	};

	use super::{TreeMark, resolve_leaf, tree_mark};

	/// An open directory: `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`.
	pub struct TreeDir(fs::File);

	fn c_name(name: &OsStr) -> io::Result<CString> {
		CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
	}

	/// `openat(dir, name, flags | O_CLOEXEC | O_NOFOLLOW)`.
	fn open_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
		// SAFETY: `name` is a live NUL-terminated string; the flags take no
		// mode argument.
		let fd =
			unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
		if fd < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fd` was just opened and nothing else owns it.
		Ok(unsafe { OwnedFd::from_raw_fd(fd) })
	}

	/// `unlinkat(dir, name, flags)`; a name already gone is fine.
	fn unlink_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<()> {
		// SAFETY: `name` is a live NUL-terminated string.
		if unsafe { libc::unlinkat(dir, name.as_ptr(), flags) } == 0 {
			return Ok(());
		}
		let err = io::Error::last_os_error();
		if err.kind() == io::ErrorKind::NotFound {
			Ok(())
		} else {
			Err(err)
		}
	}

	/// The device the entry `name` in the directory `dir` is on, without
	/// following a symlink or triggering an automount: a mount point reports
	/// the mounted filesystem's. `None` when the entry is gone.
	fn device_at(dir: RawFd, name: &CStr) -> io::Result<Option<libc::dev_t>> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `name` is a live NUL-terminated string, and `stat` is
		// writable memory of the size `fstatat` fills.
		let rc = unsafe {
			libc::fstatat(
				dir,
				name.as_ptr(),
				stat.as_mut_ptr(),
				libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT,
			)
		};
		if rc != 0 {
			let err = io::Error::last_os_error();
			return if err.kind() == io::ErrorKind::NotFound {
				Ok(None)
			} else {
				Err(err)
			};
		}
		// SAFETY: `fstatat` succeeded, so it filled `stat`.
		Ok(Some(unsafe { stat.assume_init() }.st_dev))
	}

	/// The device the open file `fd` is on.
	fn device_of(fd: RawFd) -> io::Result<libc::dev_t> {
		let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
		// SAFETY: `fd` is an open descriptor, and `stat` is writable memory of
		// the size `fstat` fills.
		if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `fstat` succeeded, so it filled `stat`.
		Ok(unsafe { stat.assume_init() }.st_dev)
	}

	/// Whether `found`, the device of an entry below a tree's root, is not the
	/// root's `root`: the entry is a mount point (or on a filesystem that gives
	/// its subvolumes devices of their own), which the reclaim never descends
	/// into or removes.
	const fn other_device(found: libc::dev_t, root: libc::dev_t) -> bool {
		found != root
	}

	/// The error the emptying stops with at `path`, a mount point that
	/// appeared after the checks.
	fn mounted(path: &Path) -> io::Error {
		io::Error::other(format!(
			"a filesystem is mounted at {} in the tree of an interrupted worktree add; the reclaim \
			 stopped there and removed nothing on it",
			path.display()
		))
	}

	/// The names in the directory `dir`, without `.` and `..`.
	fn names(dir: RawFd) -> io::Result<Vec<CString>> {
		// `fdopendir` takes the descriptor over, so it gets a duplicate.
		// SAFETY: `dir` is an open descriptor.
		let dup = unsafe { libc::fcntl(dir, libc::F_DUPFD_CLOEXEC, 0) };
		if dup < 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `dup` is an open directory descriptor this function owns.
		let stream = unsafe { libc::fdopendir(dup) };
		if stream.is_null() {
			let err = io::Error::last_os_error();
			// SAFETY: `fdopendir` failed, so `dup` is still ours to close.
			unsafe { libc::close(dup) };
			return Err(err);
		}
		// The duplicate shares the original's offset, which an earlier
		// listing of the same descriptor moved: start from the beginning.
		// SAFETY: `stream` is the open stream just made.
		unsafe { libc::rewinddir(stream) };
		let mut names = Vec::new();
		loop {
			// SAFETY: as above. A null result is the end or an error, told
			// apart by `errno`, which is cleared first.
			let entry = unsafe {
				*libc::__errno_location() = 0;
				libc::readdir(stream)
			};
			if entry.is_null() {
				// SAFETY: reading the thread's `errno`.
				let errno = unsafe { *libc::__errno_location() };
				// SAFETY: `stream` is open; closing it closes `dup`.
				unsafe { libc::closedir(stream) };
				if errno != 0 {
					return Err(io::Error::from_raw_os_error(errno));
				}
				return Ok(names);
			}
			// SAFETY: a non-null entry's `d_name` is a NUL-terminated string
			// that stays valid until the next `readdir`.
			let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
			if name != c"." && name != c".." {
				names.push(name.to_owned());
			}
		}
	}

	/// Removes everything in the directory `dir` (at `at`), never following a
	/// symlink: each subdirectory is opened `O_NOFOLLOW` from its parent, and
	/// a name that turned into a symlink or a file meanwhile is unlinked
	/// itself. An entry on another device than `dev`, the tree root's, stops
	/// it before anything on that device is touched.
	fn remove_all_in(dir: RawFd, dev: libc::dev_t, at: &Path) -> io::Result<()> {
		for name in names(dir)? {
			let path = at.join(OsStr::from_bytes(name.as_bytes()));
			match device_at(dir, &name)? {
				None => continue,
				Some(found) if other_device(found, dev) => return Err(mounted(&path)),
				Some(_) => {},
			}
			match open_at(dir, &name, libc::O_RDONLY | libc::O_DIRECTORY) {
				Ok(child) => {
					// A mount made on the name after `device_at`: the open
					// went onto it.
					if other_device(device_of(child.as_raw_fd())?, dev) {
						return Err(mounted(&path));
					}
					remove_all_in(child.as_raw_fd(), dev, &path)?;
					drop(child);
					unlink_at(dir, &name, libc::AT_REMOVEDIR)?;
				},
				Err(err) if err.kind() == io::ErrorKind::NotFound => {},
				Err(err) if matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
					unlink_at(dir, &name, 0)?;
				},
				Err(err) => return Err(err),
			}
		}
		Ok(())
	}

	/// What below a tree's root is not the interrupted add's to remove, by
	/// its path relative to the root.
	pub enum Foreign {
		/// A repository: an entry named `.git`, or a directory holding `HEAD`,
		/// `objects` and `refs` (a bare repository).
		Repository(PathBuf),
		/// An entry on another device than the root: a mount point.
		MountPoint(PathBuf),
	}

	/// Looks in the directory `dir` (at `at` below the tree's root, on the
	/// device `dev`) for what is not the add's: an entry on another device,
	/// an entry named `.git` (the root's own is skipped), or, below the root,
	/// `dir` itself holding `HEAD`, `objects` and `refs`. Queues every
	/// subdirectory it opens without following a symlink.
	fn foreign_entry_in(
		dir: RawFd,
		at: &Path,
		root: bool,
		dev: libc::dev_t,
		pending: &mut Vec<(OwnedFd, PathBuf)>,
	) -> io::Result<Option<Foreign>> {
		let names = names(dir)?;
		if !root
			&& [&b"HEAD"[..], b"objects", b"refs"]
				.iter()
				.all(|wanted| names.iter().any(|name| name.as_bytes() == *wanted))
		{
			return Ok(Some(Foreign::Repository(at.to_path_buf())));
		}
		for name in names {
			let relative = at.join(OsStr::from_bytes(name.as_bytes()));
			match device_at(dir, &name)? {
				None => continue,
				Some(found) if other_device(found, dev) => {
					return Ok(Some(Foreign::MountPoint(relative)));
				},
				Some(_) => {},
			}
			if name.as_bytes() == b".git" {
				if root {
					continue;
				}
				return Ok(Some(Foreign::Repository(relative)));
			}
			match open_at(dir, &name, libc::O_RDONLY | libc::O_DIRECTORY) {
				Ok(child) => {
					if other_device(device_of(child.as_raw_fd())?, dev) {
						return Ok(Some(Foreign::MountPoint(relative)));
					}
					pending.push((child, relative));
				},
				Err(err)
					if err.kind() == io::ErrorKind::NotFound
						|| matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {},
				Err(err) => return Err(err),
			}
		}
		Ok(None)
	}

	impl TreeDir {
		/// Opens the directory at `path` without following a symlink there;
		/// `None` when nothing is there, an error when it is not a directory.
		pub fn open(path: &Path) -> io::Result<Option<Self>> {
			let path = c_name(path.as_os_str())?;
			match open_at(libc::AT_FDCWD, &path, libc::O_RDONLY | libc::O_DIRECTORY) {
				Ok(fd) => Ok(Some(Self(fs::File::from(fd)))),
				Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
				Err(err) => Err(err),
			}
		}

		/// Whether this is the directory `mark` was set on: the same device
		/// and inode, carrying the same token.
		pub fn is(&self, mark: &TreeMark) -> io::Result<bool> {
			let meta = self.0.metadata()?;
			let token = tree_mark::get_fd(self.0.as_raw_fd())?;
			Ok(mark.is(&meta, token.as_deref()))
		}

		/// Whether this directory holds no `.git`, or a `.git` file naming the
		/// registration `admin` (a relative name taken from `tree`, the path
		/// it was opened at): anything else (a repository of its own, a
		/// `.git` naming another registration) is not the interrupted add's
		/// to remove.
		pub fn git_entry_is_ours(&self, tree: &Path, admin: &Path) -> bool {
			let entry = match open_at(self.0.as_raw_fd(), c".git", libc::O_RDONLY) {
				Ok(fd) => fs::File::from(fd),
				Err(err) => return err.kind() == io::ErrorKind::NotFound,
			};
			if !entry.metadata().is_ok_and(|meta| meta.is_file()) {
				return false;
			}
			io::read_to_string(entry)
				.ok()
				.and_then(|text| {
					text
						.trim()
						.strip_prefix("gitdir:")
						.map(|raw| tree.join(raw.trim()))
				})
				.is_some_and(|named| resolve_leaf(&named) == resolve_leaf(admin))
		}

		/// The first entry below this directory's root that is not the
		/// add's: an entry on another device (a mount point), an entry named
		/// `.git` (the root's own is not looked at), or a directory holding
		/// `HEAD`, `objects` and `refs`. Walks every subdirectory without
		/// following a symlink or descending onto another device.
		pub fn foreign_entry(&self) -> io::Result<Option<Foreign>> {
			let dev = device_of(self.0.as_raw_fd())?;
			let mut pending = Vec::new();
			if let Some(found) =
				foreign_entry_in(self.0.as_raw_fd(), Path::new(""), true, dev, &mut pending)?
			{
				return Ok(Some(found));
			}
			while let Some((dir, at)) = pending.pop() {
				if let Some(found) = foreign_entry_in(dir.as_raw_fd(), &at, false, dev, &mut pending)? {
					return Ok(Some(found));
				}
			}
			Ok(None)
		}

		/// Adds the owner's read, write and search bits to this directory's
		/// mode, so its entries can be removed and new ones written.
		pub fn make_owner_writable(&self) -> io::Result<()> {
			use std::os::unix::fs::PermissionsExt;
			let mut mode = self.0.metadata()?.permissions();
			if mode.mode() & 0o700 != 0o700 {
				mode.set_mode(mode.mode() | 0o700);
				self.0.set_permissions(mode)?;
			}
			Ok(())
		}

		/// Removes everything in this directory (opened at `path`), keeping
		/// the directory. It stops at an entry on another device than this
		/// directory, before touching anything there.
		pub fn empty(&self, path: &Path) -> io::Result<()> {
			remove_all_in(self.0.as_raw_fd(), device_of(self.0.as_raw_fd())?, path)
		}

		/// Removes the token from this directory if it is still `token`; a
		/// failure is ignored. Another add of the same path may have set its
		/// own since, which stays.
		pub fn clear_mark_if(&self, token: &str) {
			if tree_mark::get_fd(self.0.as_raw_fd())
				.ok()
				.flatten()
				.as_deref()
				== Some(token)
			{
				tree_mark::clear_fd(self.0.as_raw_fd());
			}
		}
	}
}

/// Removes the token from `dir`, where there is one. A token left behind
/// matches no marker, so a failure only leaves an unused attribute.
#[cfg(target_os = "linux")]
fn clear_tree_mark(dir: &Path) {
	tree_mark::clear(dir);
}

#[cfg(not(target_os = "linux"))]
const fn clear_tree_mark(_dir: &Path) {}

/// The token an add sets on its tree directory, in the user extended
/// attribute [`tree_mark::NAME`]. The directory is never followed through a
/// symlink.
#[cfg(target_os = "linux")]
mod tree_mark {
	use std::{
		ffi::{CStr, CString},
		fmt::Write,
		io,
		os::unix::ffi::OsStrExt,
		path::Path,
	};

	/// The attribute's name.
	pub const NAME: &CStr = c"user.omp.worktree-add";

	fn c_path(path: &Path) -> io::Result<CString> {
		CString::new(path.as_os_str().as_bytes())
			.map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
	}

	/// Sets a fresh random token on `dir` and returns it.
	pub fn set(dir: &Path) -> io::Result<String> {
		let mut bytes = [0_u8; 16];
		// SAFETY: `bytes` is a live, writable buffer of the length passed.
		let got = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
		if got != bytes.len() as isize {
			return Err(io::Error::last_os_error());
		}
		let mut token = String::with_capacity(2 * bytes.len());
		for byte in bytes {
			let _ = write!(token, "{byte:02x}");
		}
		let path = c_path(dir)?;
		// SAFETY: both names are live NUL-terminated strings, and the value
		// pointer and length describe `token`'s bytes.
		let rc = unsafe {
			libc::lsetxattr(path.as_ptr(), NAME.as_ptr(), token.as_ptr().cast(), token.len(), 0)
		};
		if rc != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(token)
	}

	/// The token on `dir`, `None` when it has none.
	#[cfg(test)]
	pub fn get(dir: &Path) -> io::Result<Option<String>> {
		let path = c_path(dir)?;
		let mut buf = [0_u8; 64];
		// SAFETY: both names are live NUL-terminated strings, and `buf` is a
		// live, writable buffer of the length passed.
		let len = unsafe {
			libc::lgetxattr(path.as_ptr(), NAME.as_ptr(), buf.as_mut_ptr().cast(), buf.len())
		};
		if len < 0 {
			let err = io::Error::last_os_error();
			return if err.raw_os_error() == Some(libc::ENODATA) {
				Ok(None)
			} else {
				Err(err)
			};
		}
		Ok(std::str::from_utf8(&buf[..len as usize])
			.ok()
			.map(str::to_owned))
	}

	/// The token on the open directory `fd`, `None` when it has none.
	pub fn get_fd(fd: std::os::fd::RawFd) -> io::Result<Option<String>> {
		let mut buf = [0_u8; 64];
		// SAFETY: the name is a live NUL-terminated string, and `buf` is a
		// live, writable buffer of the length passed.
		let len = unsafe { libc::fgetxattr(fd, NAME.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
		if len < 0 {
			let err = io::Error::last_os_error();
			return if err.raw_os_error() == Some(libc::ENODATA) {
				Ok(None)
			} else {
				Err(err)
			};
		}
		Ok(std::str::from_utf8(&buf[..len as usize])
			.ok()
			.map(str::to_owned))
	}

	/// Removes the token from the open directory `fd`; a failure is ignored.
	pub fn clear_fd(fd: std::os::fd::RawFd) {
		// SAFETY: the name is a live NUL-terminated string.
		unsafe { libc::fremovexattr(fd, NAME.as_ptr()) };
	}

	/// Removes the token from `dir`; a failure is ignored.
	pub fn clear(dir: &Path) {
		if let Ok(path) = c_path(dir) {
			// SAFETY: both names are live NUL-terminated strings.
			unsafe { libc::lremovexattr(path.as_ptr(), NAME.as_ptr()) };
		}
	}
}

/// Creates `admin`'s [`ADD_IN_PROGRESS`] marker holding `record`, locked by
/// this process before it takes its name, so no other add sees it unlocked
/// while this one lives. Where the filesystem cannot lock (`ENOLCK` on an NFS
/// mount without a lock daemon, for example) there is no marker: the add goes
/// on as git's does, and its registration is never taken for an abandoned one.
fn lock_marker(admin: &Path, record: &str) -> Result<Option<fs::File>> {
	let staged = admin.join(format!("{ADD_IN_PROGRESS}.{}", std::process::id()));
	let marker = fs::File::create(&staged)?;
	if marker.try_lock().is_err() {
		drop(marker);
		fs::remove_file(&staged)?;
		return Ok(None);
	}
	io::Write::write_all(&mut &marker, record.as_bytes())?;
	fs::rename(&staged, admin.join(ADD_IN_PROGRESS))?;
	Ok(Some(marker))
}

/// Unlocks and closes `marker`. The lock belongs to the open file, which a
/// child forked but not yet exec'd shares for a moment; unlocking frees it
/// for every holder at once.
fn release(marker: fs::File) {
	let _ = marker.unlock();
	drop(marker);
}

/// The tree a `worktrees/<id>` administration entry names: its `gitdir`
/// file's directory, a relative `gitdir` resolved against the entry, as git
/// resolves it.
fn registered_tree(admin: &Path) -> Option<PathBuf> {
	let back = fs::read_to_string(admin.join("gitdir")).ok()?;
	let back = Path::new(back.trim());
	if back.as_os_str().is_empty() {
		return None;
	}
	let git_entry = if back.is_absolute() {
		back.to_path_buf()
	} else {
		normalize_path(&admin.join(back))
	};
	git_entry
		.parent()
		.filter(|tree| tree.file_name().is_some())
		.map(Path::to_path_buf)
}

/// `path` with its symlinks resolved as far as it exists: the whole path, or
/// its parent with the last component appended, or the path normalized.
fn resolve_leaf(path: &Path) -> PathBuf {
	if let Ok(real) = fs::canonicalize(path) {
		return real;
	}
	match (path.parent(), path.file_name()) {
		(Some(parent), Some(name)) => {
			fs::canonicalize(parent).map_or_else(|_| normalize_path(path), |parent| parent.join(name))
		},
		_ => normalize_path(path),
	}
}

/// Removes the registration `admin`, which names `tree` and holds an
/// [`ADD_IN_PROGRESS`] marker, and empties `tree`, when the add that made
/// them is dead and both are still what it left. Returns the note to show;
/// `None` when the marker went or changed meanwhile (the add finished, or
/// another add took the registration), so there is nothing of a dead add
/// left here.
fn reclaim_abandoned_add(common: &Path, admin: &Path, tree: &Path) -> Result<Option<String>> {
	// Open for writing too: an NFS client emulates `flock` with a whole-file
	// `fcntl` lock, and an exclusive one needs a writable descriptor.
	let marker = match fs::OpenOptions::new()
		.read(true)
		.write(true)
		.open(admin.join(ADD_IN_PROGRESS))
	{
		Ok(marker) => marker,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	reclaim_with_marker(common, admin, tree, marker)
}

/// [`reclaim_abandoned_add`] with the marker already open, as a reclaim that
/// opened it before the add finished holds it.
fn reclaim_with_marker(
	common: &Path,
	admin: &Path,
	tree: &Path,
	marker: fs::File,
) -> Result<Option<String>> {
	let checked = take_abandoned_add(common, admin, tree, &marker);
	// The marker goes before the moved registration is deleted: on NFS a file
	// still open when it is deleted is renamed to `.nfs…` instead, which
	// keeps its directory. Unlocking also frees the lock for a child forked
	// but not yet exec'd, which shares the open file, so a retry right after a
	// refusal is not taken for a live add.
	release(marker);
	Ok(checked?.map(Reclaimed::finish))
}

/// What a reclaim took from a dead add while its marker was held: the note
/// so far, the registration moved out of git's view, and (on Linux) the
/// emptied tree with the token the add set on it.
struct Reclaimed {
	note:  String,
	moved: PathBuf,
	#[cfg(target_os = "linux")]
	tree:  Option<(tree_dir::TreeDir, String)>,
}

impl Reclaimed {
	/// Deletes the moved registration and clears the add's token from the
	/// tree, only if the tree still holds that token: an add of the same path
	/// that started after the registration moved has set its own. Returns the
	/// note, with what could not be deleted.
	fn finish(self) -> String {
		use std::fmt::Write as _;
		#[cfg(test)]
		test_hooks::after_registration_moved(&self.moved);
		let mut note = self.note;
		if let Err(err) = fs::remove_dir_all(&self.moved)
			&& err.kind() != io::ErrorKind::NotFound
		{
			let _ = write!(
				note,
				"; could not delete the removed registration {}: {err}",
				self.moved.display()
			);
		}
		#[cfg(target_os = "linux")]
		if let Some((dir, token)) = self.tree {
			dir.clear_mark_if(&token);
		}
		note
	}
}

/// Checks that the registration `admin` is a dead add's and still what it
/// left, empties its tree and moves the registration out of git's view, all
/// while `marker` is held. `None` when the marker went or changed meanwhile.
fn take_abandoned_add(
	common: &Path,
	admin: &Path,
	tree: &Path,
	marker: &fs::File,
) -> Result<Option<Reclaimed>> {
	let refuse = |why: &str| {
		Error::backend(
			"git worktree add",
			format!(
				"'{}' is registered by an interrupted worktree add ({}) {why}; nothing was removed. \
				 Remove the directory yourself, or run 'git worktree unlock' and 'git worktree remove \
				 --force' on it",
				tree.display(),
				admin.display()
			),
		)
	};
	match marker.try_lock() {
		Ok(()) => {},
		Err(fs::TryLockError::WouldBlock) => {
			return Err(Error::backend(
				"git worktree add",
				format!(
					"'{}' is being added by another worktree add that is still running ({}); wait for \
					 it to finish",
					tree.display(),
					admin.display()
				),
			));
		},
		Err(fs::TryLockError::Error(err)) => {
			return Err(refuse(&format!("whose marker cannot be locked here ({err})")));
		},
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		// The marker locked must still be the registration's: one opened
		// before its add finished, or before another add took the
		// registration, is a file nobody keeps any more.
		let held = marker.metadata()?;
		match fs::symlink_metadata(admin.join(ADD_IN_PROGRESS)) {
			Ok(named) if named.dev() == held.dev() && named.ino() == held.ino() => {},
			_ => return Ok(None),
		}
		let mut record = String::new();
		io::Read::read_to_string(&mut &*marker, &mut record)?;
		let refuse_record = || {
			refuse("whose marker records nothing to check, or whose lock was changed or removed since")
		};
		let Some((first, rest)) = record.split_once('\n') else {
			return Err(refuse_record());
		};
		let Some((head, locked)) = rest
			.split_once('\n')
			.and_then(|(line, locked)| Some((line.strip_prefix("head ")?, locked)))
		else {
			return Err(refuse_record());
		};
		let made = match first.strip_prefix("tree ") {
			Some("-") => None,
			Some(text) => Some(TreeMark::parse(text).ok_or_else(refuse_record)?),
			None => return Err(refuse_record()),
		};
		if fs::read(admin.join("locked")).ok().as_deref() != Some(locked.as_bytes()) {
			return Err(refuse_record());
		}
		// A commit or a checkout in the tree after the add died is recorded
		// only here: `HEAD` moves (a detached commit is reachable from nothing
		// else) and `logs/HEAD` appears. Removing the registration would lose
		// both.
		if fs::read_to_string(admin.join("HEAD")).ok().as_deref() != Some(&format!("{head}\n")) {
			return Err(refuse(
				"whose HEAD moved since that add wrote it (a commit or a checkout there), which \
				 removing it would lose",
			));
		}
		match fs::symlink_metadata(admin.join("logs").join("HEAD")) {
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			_ => {
				return Err(refuse(
					"whose HEAD has a reflog (a commit or a checkout there), which removing it would \
					 lose",
				));
			},
		}
		let (note, dir) = reclaim_tree(common, admin, tree, made.as_ref(), &refuse)?;
		// Moved while the marker is held, so no other add can take it first.
		let moved = move_registration(common, admin)?;
		#[cfg(not(target_os = "linux"))]
		let _ = dir;
		Ok(Some(Reclaimed {
			note,
			moved,
			#[cfg(target_os = "linux")]
			tree: dir.zip(made.map(|made| made.token)),
		}))
	}
	#[cfg(not(unix))]
	{
		let _ = common;
		Err(refuse("that this platform cannot check"))
	}
}

/// Empties the tree an interrupted add left at `tree` while it is still the
/// directory that add made (`made`) and holds no repository and no mount
/// point, and returns the note to show with the directory, held open so its
/// token can go after the registration; a tree that is gone leaves only the
/// registration to remove. Anything else is refused with `refuse`, and
/// nothing is removed. The tree is opened once, without following a symlink,
/// and every check and the removal go through that descriptor.
#[cfg(target_os = "linux")]
fn reclaim_tree(
	common: &Path,
	admin: &Path,
	tree: &Path,
	made: Option<&TreeMark>,
	refuse: &impl Fn(&str) -> Error,
) -> Result<(String, Option<tree_dir::TreeDir>)> {
	let not_made_here =
		|| refuse("and the directory there cannot be told apart from one made again in its place");
	let dir = match tree_dir::TreeDir::open(tree) {
		Ok(Some(dir)) => dir,
		Ok(None) => {
			return Ok((
				format!(
					"removed the registration an interrupted worktree add of {} left",
					tree.display()
				),
				None,
			));
		},
		Err(err) if matches!(err.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => {
			return Err(not_made_here());
		},
		Err(err) => return Err(err.into()),
	};
	if !made.is_some_and(|made| dir.is(made).unwrap_or(false)) {
		return Err(not_made_here());
	}
	if common.starts_with(resolve_leaf(tree)) {
		return Err(refuse("and holds this repository"));
	}
	if !dir.git_entry_is_ours(tree, admin) {
		return Err(refuse("and holds a `.git` that is not this registration's"));
	}
	// The add's own tree never holds a `.git` below its root (the clone leaves
	// out directories a `.git` marks, and a checkout writes a submodule as an
	// empty directory), and it is one filesystem: a mount below it is someone
	// else's.
	match dir.foreign_entry()? {
		Some(tree_dir::Foreign::Repository(nested)) => {
			return Err(refuse(&format!(
				"and holds a repository below its root ({})",
				tree.join(nested).display()
			)));
		},
		Some(tree_dir::Foreign::MountPoint(mount)) => {
			return Err(refuse(&format!(
				"and holds a filesystem mounted below its root ({})",
				tree.join(mount).display()
			)));
		},
		None => {},
	}
	#[cfg(test)]
	test_hooks::before_tree_removal(tree);
	// The directory stays, writable by its owner: it can be a mount point, and
	// the add keeps an empty directory anyway.
	dir.make_owner_writable()?;
	dir.empty(tree)?;
	Ok((
		format!(
			"emptied the partial tree an interrupted worktree add left at {}, with any file written \
			 into it after that add stopped",
			tree.display()
		),
		Some(dir),
	))
}

/// Off Linux an add marks no tree (`made` is always `None`), so only a tree
/// that is gone is reclaimed: its registration is removed.
#[cfg(all(unix, not(target_os = "linux")))]
fn reclaim_tree(
	_common: &Path,
	_admin: &Path,
	tree: &Path,
	_made: Option<&TreeMark>,
	refuse: &impl Fn(&str) -> Error,
) -> Result<(String, Option<()>)> {
	match fs::symlink_metadata(tree) {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok((
			format!("removed the registration an interrupted worktree add of {} left", tree.display()),
			None,
		)),
		Err(err) => Err(err.into()),
		Ok(_) => Err(refuse(
			"and the directory there cannot be told apart from one made again in its place",
		)),
	}
}

/// Prefix of a registration a reclaim moved out of `worktrees/` before
/// deleting it.
const MOVED_REGISTRATION: &str = "omp-removed-worktree-";

/// Takes the registration `admin` out of git's view at once, by moving it out
/// of `worktrees/` into the common directory, and returns where it went. A
/// move that fails leaves the registration whole, so a later add finds and
/// retries it.
#[cfg(unix)]
fn move_registration(common: &Path, admin: &Path) -> io::Result<PathBuf> {
	let name = admin
		.file_name()
		.map_or_else(String::new, |name| name.to_string_lossy().into_owned());
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |since| since.as_nanos());
	let moved = common.join(format!("{MOVED_REGISTRATION}{name}-{}-{stamp}", std::process::id()));
	fs::rename(admin, &moved)?;
	Ok(moved)
}

/// Deletes the registrations earlier reclaims moved out of `worktrees/` and
/// did not get to delete (a kill between the move and the delete, or a file
/// that could not go). Git never reads them; a failure is left for the next
/// add.
fn sweep_moved_registrations(common: &Path) {
	let Ok(entries) = fs::read_dir(common) else {
		return;
	};
	for entry in entries.filter_map(std::result::Result::ok) {
		if entry
			.file_name()
			.to_string_lossy()
			.starts_with(MOVED_REGISTRATION)
			&& entry.file_type().is_ok_and(|kind| kind.is_dir())
		{
			let _ = fs::remove_dir_all(entry.path());
		}
	}
}

/// Gives `dir` the permissions `mode` when it has others. Only the owner (or
/// root) may change a mode, even to the same value, so a directory someone
/// else owns that still has its mode is left alone.
fn restore_mode(dir: &Path, mode: &fs::Permissions) -> io::Result<()> {
	if fs::symlink_metadata(dir)?.permissions() != *mode {
		fs::set_permissions(dir, mode.clone())?;
	}
	Ok(())
}

/// Adds the owner's read, write and search bits to the directory `dir`'s
/// mode, so its entries can be removed and new ones written.
#[cfg(unix)]
fn make_owner_writable(dir: &Path) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt;
	let mut mode = fs::symlink_metadata(dir)?.permissions();
	if mode.mode() & 0o700 != 0o700 {
		mode.set_mode(mode.mode() | 0o700);
		fs::set_permissions(dir, mode)?;
	}
	Ok(())
}

/// A seam for tests: code run at fixed points of a worktree add, on the
/// calling thread.
#[cfg(test)]
mod test_hooks {
	use std::{cell::RefCell, path::Path};

	type Hook = Box<dyn FnMut(&Path)>;

	thread_local! {
		static BEFORE_MARKER_RELEASE: RefCell<Option<Hook>> = const { RefCell::new(None) };
		static BEFORE_TREE_REMOVAL: RefCell<Option<Hook>> = const { RefCell::new(None) };
		static AFTER_REGISTRATION_MOVED: RefCell<Option<Hook>> = const { RefCell::new(None) };
	}

	/// Runs `hook` with the moved registration's path after a reclaim on
	/// this thread let go of the marker and before it deletes the moved
	/// registration and clears the token, until [`clear`].
	#[cfg(target_os = "linux")]
	pub fn set_after_registration_moved(hook: impl FnMut(&Path) + 'static) {
		AFTER_REGISTRATION_MOVED.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
	}

	pub fn after_registration_moved(moved: &Path) {
		AFTER_REGISTRATION_MOVED.with(|slot| {
			if let Some(hook) = slot.borrow_mut().as_mut() {
				hook(moved);
			}
		});
	}

	/// Runs `hook` with the tree's path just before a reclaim on this thread
	/// empties it, until [`clear`].
	#[cfg(target_os = "linux")]
	pub fn set_before_tree_removal(hook: impl FnMut(&Path) + 'static) {
		BEFORE_TREE_REMOVAL.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
	}

	#[cfg(target_os = "linux")]
	pub fn before_tree_removal(tree: &Path) {
		BEFORE_TREE_REMOVAL.with(|slot| {
			if let Some(hook) = slot.borrow_mut().as_mut() {
				hook(tree);
			}
		});
	}

	/// Runs `hook` with the registration's administrative directory just
	/// before a failed add on this thread releases its marker, until
	/// [`clear`].
	pub fn set_before_marker_release(hook: impl FnMut(&Path) + 'static) {
		BEFORE_MARKER_RELEASE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
	}

	pub fn clear() {
		BEFORE_MARKER_RELEASE.with(|slot| *slot.borrow_mut() = None);
		BEFORE_TREE_REMOVAL.with(|slot| *slot.borrow_mut() = None);
		AFTER_REGISTRATION_MOVED.with(|slot| *slot.borrow_mut() = None);
	}

	pub fn before_marker_release(admin: &Path) {
		BEFORE_MARKER_RELEASE.with(|slot| {
			if let Some(hook) = slot.borrow_mut().as_mut() {
				hook(admin);
			}
		});
	}
}

/// Removes everything in the directory `dir`, keeping the directory.
fn remove_contents(dir: &Path) -> Result<()> {
	for entry in fs::read_dir(dir)? {
		remove_existing(&entry?.path())?;
	}
	Ok(())
}

/// Remove a file, symlink, or directory tree at `path`; missing is fine.
fn remove_existing(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
		Ok(_) => fs::remove_file(path)?,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

/// Recreate the symlink at `src` as `dst` (a plain file holding the link
/// target on platforms without symlinks, matching git's `core.symlinks=false`).
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
	let target = fs::read_link(src)?;
	#[cfg(unix)]
	std::os::unix::fs::symlink(&target, dst)?;
	#[cfg(not(unix))]
	fs::write(dst, target.to_string_lossy().as_bytes())?;
	Ok(())
}

/// Remove now-empty ancestors of a deleted entry, walking up from `parent`
/// and stopping at `root`, the first non-empty directory, or — when `scope`
/// is non-empty — the first directory outside every scoped pathspec.
fn prune_empty_parents(
	root: &Path,
	mut parent: Option<&Path>,
	scope: &BTreeSet<String>,
) -> Result<()> {
	while let Some(dir) = parent {
		if dir == root {
			break;
		}
		if !scope.is_empty() {
			let Ok(rel) = dir.strip_prefix(root) else {
				break;
			};
			let rel = rel.to_string_lossy().replace('\\', "/");
			let in_scope = scope.iter().any(|p| {
				*p == rel
					|| rel
						.strip_prefix(p.as_str())
						.is_some_and(|r| r.starts_with('/'))
			});
			if !in_scope {
				break;
			}
		}
		match fs::remove_dir(dir) {
			Ok(()) => parent = dir.parent(),
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
				) =>
			{
				break;
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn worktree_admin_name(common: &Path, path: &Path) -> String {
	let base = path
		.file_name()
		.and_then(|s| s.to_str())
		.filter(|s| !s.is_empty())
		.unwrap_or("worktree");
	let mut name = base.to_owned();
	let mut n = 1;
	while common.join("worktrees").join(&name).exists() {
		name = format!("{base}{n}");
		n += 1;
	}
	name
}

fn branch_is_checked_out(common: &Path, full_ref: &str) -> bool {
	let expected = format!("ref: {full_ref}");
	if fs::read_to_string(common.join("HEAD")).is_ok_and(|head| head.trim() == expected) {
		return true;
	}
	let Ok(entries) = fs::read_dir(common.join("worktrees")) else {
		return false;
	};
	entries.filter_map(std::result::Result::ok).any(|entry| {
		fs::read_to_string(entry.path().join("HEAD")).is_ok_and(|head| head.trim() == expected)
	})
}

fn tracked_worktree_dirty(repo: &GitRepo) -> Result<bool> {
	let gix = repo.gix()?;
	let index = load_index_or_head(&gix, "git worktree remove")?;
	let mut filter = WorktreeFilter::staging(&gix, "git worktree remove")?;
	for entry in index.entries() {
		let path = entry.path(&index).to_str_lossy();
		if worktree_id(&gix, &mut filter, repo.root(), &path, entry.mode)? != Some(entry.id) {
			return Ok(true);
		}
	}
	Ok(false)
}

fn snapshot_refs(repo: &gix::Repository) -> Result<Vec<(String, gix::hash::ObjectId)>> {
	let platform = repo
		.references()
		.map_err(|e| Error::backend("git detach", e))?;
	let iter = platform
		.all()
		.map_err(|e| Error::backend("git detach", e))?;
	let mut out = Vec::new();
	for reference in iter {
		let mut reference = reference.map_err(|e| Error::backend("git detach", e))?;
		let name = reference.name().as_bstr().to_str_lossy().into_owned();
		if let Ok(id) = reference.peel_to_id() {
			out.push((name, id.detach()));
		}
	}
	Ok(out)
}

fn copy_named_files(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
	let mut out = Vec::new();
	let Ok(entries) = fs::read_dir(dir) else {
		return Ok(out);
	};
	for entry in entries {
		let entry = entry?;
		let name = entry.file_name().to_string_lossy().into_owned();
		if name.starts_with(prefix) {
			out.push((name, fs::read(entry.path())?));
		}
	}
	Ok(out)
}

fn registered_admin(git_entry: &Path) -> Result<Option<PathBuf>> {
	let text = fs::read_to_string(git_entry)?;
	let Some(raw) = text.trim().strip_prefix("gitdir:") else {
		return Ok(None);
	};
	let admin = normalize_path(
		&git_entry
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(raw.trim()),
	);
	let back = fs::read_to_string(admin.join("gitdir")).unwrap_or_default();
	let real_back =
		fs::canonicalize(back.trim()).unwrap_or_else(|_| normalize_path(Path::new(back.trim())));
	let real_entry = fs::canonicalize(git_entry).unwrap_or_else(|_| normalize_path(git_entry));
	Ok((real_back == real_entry).then_some(admin))
}

fn write_loose_ref(git_dir: &Path, name: &str, id: gix::hash::ObjectId) -> Result<()> {
	let path = git_dir.join(name);
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, format!("{}\n", id.to_hex()))?;
	Ok(())
}
#[cfg(test)]
mod tests {
	use std::process::Command;

	use tempfile::TempDir;

	use super::*;
	use crate::types::CommitAuthor;

	fn git(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout)
			.unwrap()
			.trim_end()
			.to_owned()
	}

	fn fixture() -> (TempDir, GitRepo) {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		// gix reads the developer's `~/.gitconfig`, where a global
		// `core.hooksPath` would redirect hook lookup away from this fixture.
		git(temp.path(), &["config", "core.hooksPath", ".git/hooks"]);
		// Assertions compare exact worktree bytes; Git for Windows' system
		// `core.autocrlf=true` would check them out as CRLF. Tests covering
		// line-ending conversion opt back in explicitly.
		git(temp.path(), &["config", "core.autocrlf", "false"]);
		fs::write(temp.path().join("a"), "one\n").unwrap();
		fs::write(temp.path().join("b"), "two\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		(temp, repo)
	}

	/// An add of `tree` that died after writing into it: a real registration
	/// and marker whose lock nobody holds. Returns the administrative
	/// directory.
	fn abandoned_add(repo: &GitRepo, tree: &Path, lock: Option<&str>) -> PathBuf {
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let mut pending = PendingWorktree::begin(tree, &repo.info().common_dir, &head, lock).unwrap();
		pending.link().unwrap();
		fs::write(tree.join("partial"), "copied\n").unwrap();
		let admin = pending.admin.clone();
		release(pending.marker.take().unwrap());
		pending.finished = true;
		admin
	}

	/// Whether `dir` is an empty directory.
	#[cfg(target_os = "linux")]
	fn is_empty_dir(dir: &Path) -> bool {
		fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_empties_a_dead_adds_tree_removes_its_registration_and_reports_it() {
		use std::os::unix::fs::MetadataExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		let inode = fs::metadata(&tree).unwrap().ino();
		let notes = repo.worktree_reclaim_abandoned(&tree).unwrap();
		assert_eq!(notes.len(), 1, "{notes:?}");
		assert!(notes[0].contains("emptied the partial tree"), "{notes:?}");
		assert!(is_empty_dir(&tree) && !admin.exists());
		assert_eq!(fs::metadata(&tree).unwrap().ino(), inode, "the directory was not kept");
		assert_eq!(tree_mark::get(&tree).unwrap(), None, "the add's token stayed on the directory");
		// With a lock of the caller's, too.
		let admin = abandoned_add(&repo, &tree, Some("in use"));
		assert_eq!(repo.worktree_reclaim_abandoned(&tree).unwrap().len(), 1);
		assert!(is_empty_dir(&tree) && !admin.exists());
	}

	#[test]
	fn reclaim_refuses_a_live_add_and_one_that_recorded_nothing() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let live = trees.path().join("live");
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let pending = PendingWorktree::begin(&live, &repo.info().common_dir, &head, None).unwrap();
		fs::write(live.join("partial"), "copied\n").unwrap();
		let err = repo
			.worktree_reclaim_abandoned(&live)
			.unwrap_err()
			.to_string();
		assert!(err.contains("another worktree add that is still running"), "{err}");
		assert!(!err.contains("Remove the directory"), "{err}");
		assert!(live.join("partial").is_file() && pending.admin.is_dir());
		drop(pending);
		// A marker with no record (written by hand, or emptied) is refused.
		#[cfg(unix)]
		{
			let bare = trees.path().join("bare");
			let admin = abandoned_add(&repo, &bare, None);
			fs::write(admin.join(ADD_IN_PROGRESS), "").unwrap();
			let err = repo
				.worktree_reclaim_abandoned(&bare)
				.unwrap_err()
				.to_string();
			assert!(err.contains("records nothing"), "{err}");
			assert!(bare.join("partial").is_file() && admin.is_dir());
		}
	}

	/// Where the reclaim cannot check a tree, it refuses and keeps it.
	#[cfg(windows)]
	#[test]
	fn reclaim_refuses_where_the_platform_cannot_check() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		let err = repo
			.worktree_reclaim_abandoned(&tree)
			.unwrap_err()
			.to_string();
		assert!(err.contains("cannot check"), "{err}");
		assert!(tree.join("partial").is_file() && admin.is_dir());
	}

	/// A directory made again in the tree's place can get the same device
	/// and inode; without the add's token it is refused and kept.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_refuses_a_directory_without_the_adds_token() {
		use std::os::unix::fs::MetadataExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		// The same inode without the token: what a filesystem that reuses
		// the inode at once gives a directory made again.
		let same = trees.path().join("same-inode");
		let admin = abandoned_add(&repo, &same, None);
		tree_mark::clear(&same);
		fs::write(same.join("my-work.txt"), "mine\n").unwrap();
		let err = repo
			.worktree_reclaim_abandoned(&same)
			.unwrap_err()
			.to_string();
		assert!(err.contains("cannot be told apart"), "{err}");
		assert!(same.join("my-work.txt").is_file() && admin.is_dir());
		// A directory really made again, whatever inode it gets.
		let again = trees.path().join("made-again");
		let admin = abandoned_add(&repo, &again, None);
		let before = fs::metadata(&again).unwrap().ino();
		fs::remove_dir_all(&again).unwrap();
		fs::create_dir(&again).unwrap();
		fs::write(again.join("my-work.txt"), "mine\n").unwrap();
		eprintln!(
			"made again with the same inode: {}",
			fs::metadata(&again).unwrap().ino() == before
		);
		assert!(repo.worktree_reclaim_abandoned(&again).is_err());
		assert!(again.join("my-work.txt").is_file() && admin.is_dir());
	}

	/// A repository someone made in the tree after the add died is theirs.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_refuses_a_tree_holding_a_repository_of_its_own() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		fs::remove_file(tree.join(".git")).unwrap();
		git(&tree, &["init", "-q", "-b", "main"]);
		let err = repo
			.worktree_reclaim_abandoned(&tree)
			.unwrap_err()
			.to_string();
		assert!(err.contains("`.git` that is not this registration's"), "{err}");
		assert!(tree.join(".git/HEAD").is_file() && tree.join("partial").is_file() && admin.is_dir());
	}

	/// A repository made below the tree's root after the add died (a
	/// `git init` there, or a `.git` file of a linked worktree) is someone's
	/// work: the reclaim refuses and keeps it.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_refuses_a_tree_holding_a_repository_below_its_root() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		for nested in ["vendor/dep", "a/b/c"] {
			let tree = trees.path().join(nested.replace('/', "-"));
			let admin = abandoned_add(&repo, &tree, None);
			let inner = tree.join(nested);
			fs::create_dir_all(&inner).unwrap();
			git(&inner, &["init", "-q", "-b", "main"]);
			fs::write(inner.join("work.txt"), "unpushed\n").unwrap();
			let err = repo
				.worktree_reclaim_abandoned(&tree)
				.unwrap_err()
				.to_string();
			assert!(err.contains("holds a repository below its root"), "{nested}: {err}");
			assert!(inner.join(".git/HEAD").is_file() && inner.join("work.txt").is_file(), "{nested}");
			assert!(tree.join("partial").is_file() && admin.is_dir(), "{nested}");
		}
	}

	/// A reclaim whose registration cannot be removed leaves the
	/// registration whole and the tree's token, so the next add can still
	/// reclaim it once the registration can go.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_reclaim_whose_registration_cannot_be_removed_can_be_retried() {
		use std::os::unix::fs::PermissionsExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		// A directory without write permission cannot be moved to another
		// parent (its `..` entry would change), except by root.
		fs::set_permissions(&admin, fs::Permissions::from_mode(0o500)).unwrap();
		let probe = repo.info().common_dir.join("probe-move");
		if fs::rename(&admin, &probe).is_ok() {
			fs::rename(&probe, &admin).unwrap();
			fs::set_permissions(&admin, fs::Permissions::from_mode(0o700)).unwrap();
			eprintln!("SKIP: running as root, where nothing stops the registration from moving");
			return;
		}
		assert!(repo.worktree_reclaim_abandoned(&tree).is_err(), "the registration was removed");
		assert!(admin.join(ADD_IN_PROGRESS).is_file() && admin.join("gitdir").is_file());
		assert!(
			tree_mark::get(&tree).unwrap().is_some(),
			"the token went with the registration still there"
		);
		fs::set_permissions(&admin, fs::Permissions::from_mode(0o700)).unwrap();
		let notes = repo.worktree_reclaim_abandoned(&tree).unwrap();
		assert_eq!(notes.len(), 1, "the retry did not reclaim: {notes:?}");
		assert!(!admin.exists() && is_empty_dir(&tree));
		assert_eq!(tree_mark::get(&tree).unwrap(), None, "the token outlived the registration");
	}

	/// A registration whose removal fails part way still leaves git's view
	/// whole: it is moved out of `worktrees/` first, and what cannot be
	/// deleted afterwards is reported, not left as a broken registration.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_registration_that_cannot_be_fully_deleted_still_leaves_gits_view() {
		use std::os::unix::fs::PermissionsExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		// A directory holding a file in a read-only directory: deletable by
		// root alone.
		let stuck = admin.join("stuck");
		fs::create_dir(&stuck).unwrap();
		fs::write(stuck.join("f"), "").unwrap();
		fs::set_permissions(&stuck, fs::Permissions::from_mode(0o500)).unwrap();
		if fs::write(stuck.join("probe"), "").is_ok() {
			fs::set_permissions(&stuck, fs::Permissions::from_mode(0o700)).unwrap();
			eprintln!(
				"SKIP: running as root, where nothing makes the registration impossible to delete"
			);
			return;
		}
		let notes = repo.worktree_reclaim_abandoned(&tree).unwrap();
		assert_eq!(notes.len(), 1, "{notes:?}");
		assert!(notes[0].contains("could not delete the removed registration"), "{notes:?}");
		assert!(!admin.exists(), "the registration stayed in worktrees/");
		let listed = git(repo.root(), &["worktree", "list", "--porcelain"]);
		assert!(!listed.contains(tree.to_str().unwrap()), "{listed}");
		let moved: Vec<_> = fs::read_dir(&repo.info().common_dir)
			.unwrap()
			.map(|entry| entry.unwrap().path())
			.filter(|path| {
				path
					.file_name()
					.unwrap()
					.to_string_lossy()
					.starts_with("omp-removed-worktree-")
			})
			.collect();
		assert_eq!(moved.len(), 1, "{moved:?}");
		fs::set_permissions(moved[0].join("stuck"), fs::Permissions::from_mode(0o700)).unwrap();
	}

	/// A commit or a checkout in a dead add's tree is recorded only in its
	/// registration (`HEAD`, `logs/HEAD`); the reclaim refuses rather than
	/// lose it.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_refuses_a_tree_whose_head_moved_or_has_a_reflog() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		// A commit on the detached HEAD the add wrote.
		let committed = trees.path().join("committed");
		let admin = abandoned_add(&repo, &committed, None);
		git(&committed, &[
			"-c",
			"user.name=T",
			"-c",
			"user.email=t@example.com",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"mine",
		]);
		let commit = git(&committed, &["rev-parse", "HEAD"]);
		let err = repo
			.worktree_reclaim_abandoned(&committed)
			.unwrap_err()
			.to_string();
		assert!(err.contains("HEAD moved"), "{err}");
		assert_eq!(git(&committed, &["rev-parse", "HEAD"]), commit, "the commit is gone");
		assert!(committed.join("partial").is_file() && admin.is_dir());
		// HEAD moved with no reflog.
		let moved = trees.path().join("moved");
		let admin = abandoned_add(&repo, &moved, None);
		fs::write(admin.join("HEAD"), "ref: refs/heads/elsewhere\n").unwrap();
		let err = repo
			.worktree_reclaim_abandoned(&moved)
			.unwrap_err()
			.to_string();
		assert!(err.contains("HEAD moved"), "{err}");
		assert!(moved.join("partial").is_file() && admin.is_dir());
		// HEAD as the add wrote it, with a reflog.
		let logged = trees.path().join("logged");
		let admin = abandoned_add(&repo, &logged, None);
		fs::create_dir_all(admin.join("logs")).unwrap();
		fs::write(admin.join("logs/HEAD"), "").unwrap();
		let err = repo
			.worktree_reclaim_abandoned(&logged)
			.unwrap_err()
			.to_string();
		assert!(err.contains("reflog"), "{err}");
		assert!(logged.join("partial").is_file() && admin.is_dir());
	}

	/// A bare repository below the tree's root (`git init --bare`, a mirror
	/// clone) is someone's work: the reclaim refuses and keeps it.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_refuses_a_tree_holding_a_bare_repository_below_its_root() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let admin = abandoned_add(&repo, &tree, None);
		git(&tree, &["init", "-q", "--bare", "nested/m.git"]);
		let err = repo
			.worktree_reclaim_abandoned(&tree)
			.unwrap_err()
			.to_string();
		assert!(err.contains("holds a repository below its root"), "{err}");
		assert!(tree.join("nested/m.git/HEAD").is_file() && admin.is_dir());
	}

	/// A filesystem mounted below the tree's root (a bind mount, a tmpfs) is
	/// someone else's: the reclaim refuses and removes nothing, and the
	/// emptying alone, as when the mount appears after the checks, stops at
	/// the mount point too. Making a mount point needs privileges the tests
	/// lack: the builds Job mounts one inside a directory the test user owns
	/// and names it in `PI_VCS_TEST_MOUNT_POINT`; that directory is the tree.
	/// Run with `--ignored`.
	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "needs a mount point inside a directory the test user owns: PI_VCS_TEST_MOUNT_POINT"]
	fn reclaim_refuses_a_tree_holding_a_mount_point() {
		use std::os::unix::fs::MetadataExt;
		let mount = PathBuf::from(std::env::var("PI_VCS_TEST_MOUNT_POINT").expect(
			"PI_VCS_TEST_MOUNT_POINT names a mount point inside a directory the test user owns",
		));
		let tree = mount.parent().unwrap().to_path_buf();
		assert_ne!(
			fs::metadata(&mount).unwrap().dev(),
			fs::metadata(&tree).unwrap().dev(),
			"{} is not a mount point",
			mount.display()
		);
		// What an earlier run left in the tree, beside the mount point.
		for entry in fs::read_dir(&tree).unwrap() {
			let path = entry.unwrap().path();
			if path != mount {
				let _ = fs::remove_dir_all(&path).or_else(|_| fs::remove_file(&path));
			}
		}
		let data = mount.join("data");
		fs::write(&data, "someone's\n").unwrap();
		let (_temp, repo) = fixture();
		let admin = abandoned_add(&repo, &tree, None);
		let result = repo.worktree_reclaim_abandoned(&tree);
		assert!(
			data.is_file(),
			"the reclaim emptied the filesystem mounted at {}: {result:?}",
			mount.display()
		);
		let err = result.unwrap_err().to_string();
		assert!(err.contains("holds a filesystem mounted below its root"), "{err}");
		assert!(
			tree.join("partial").is_file() && tree.join(".git").is_file() && admin.is_dir(),
			"the reclaim removed something: {err}"
		);
		// The emptying alone.
		let dir = tree_dir::TreeDir::open(&tree).unwrap().unwrap();
		let err = dir.empty(&tree).unwrap_err().to_string();
		assert!(data.is_file(), "the emptying removed {}: {err}", data.display());
		assert!(err.contains("a filesystem is mounted at"), "{err}");
	}

	/// A registration an earlier reclaim moved out of `worktrees/` and did not
	/// delete (killed between the move and the delete) goes at the next add.
	#[cfg(unix)]
	#[test]
	fn a_reclaim_deletes_registrations_earlier_reclaims_moved() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let left = common.join("omp-removed-worktree-wt-123-456");
		fs::create_dir_all(left.join("logs")).unwrap();
		fs::write(left.join("gitdir"), "/nowhere/.git\n").unwrap();
		fs::write(left.join("logs/HEAD"), "").unwrap();
		let trees = tempfile::tempdir().unwrap();
		assert!(
			repo
				.worktree_reclaim_abandoned(&trees.path().join("unrelated"))
				.unwrap()
				.is_empty()
		);
		assert!(!left.exists(), "a moved registration was left behind");
	}

	/// A reclaim lets go of the dead add's marker before it deletes the moved
	/// registration: on NFS a file still open when it is deleted is renamed
	/// `.nfs…` instead, and its directory cannot go.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_reclaim_lets_go_of_the_marker_before_deleting_the_moved_registration() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let _admin = abandoned_add(&repo, &tree, None);
		let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
		let record = std::rc::Rc::clone(&seen);
		test_hooks::set_after_registration_moved(move |moved| {
			let marker = fs::OpenOptions::new()
				.read(true)
				.write(true)
				.open(moved.join(ADD_IN_PROGRESS))
				.unwrap();
			record.borrow_mut().push(marker.try_lock().is_ok());
		});
		let result = repo.worktree_reclaim_abandoned(&tree);
		test_hooks::clear();
		assert!(result.is_ok(), "{result:?}");
		assert_eq!(
			*seen.borrow(),
			vec![true],
			"the marker was still held when the moved registration was deleted"
		);
	}

	/// An add of the same path that starts after the dead add's registration
	/// moved sets its own token on the tree; the reclaim clears only the dead
	/// add's.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_reclaim_keeps_a_token_another_add_set_after_the_move() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let _admin = abandoned_add(&repo, &tree, None);
		let theirs = std::rc::Rc::new(std::cell::RefCell::new(None));
		let record = std::rc::Rc::clone(&theirs);
		let path = tree.clone();
		test_hooks::set_after_registration_moved(move |_| {
			*record.borrow_mut() = Some(tree_mark::set(&path).unwrap());
		});
		let result = repo.worktree_reclaim_abandoned(&tree);
		test_hooks::clear();
		assert!(result.is_ok(), "{result:?}");
		let theirs = theirs.borrow().clone();
		assert!(theirs.is_some(), "the seam did not run");
		assert_eq!(tree_mark::get(&tree).unwrap(), theirs, "the other add's token was cleared");
	}

	/// `reset_tree` keeps a directory that was there before the add (a
	/// mount point, say) with the mode it had, and makes the add's own
	/// directory again, writable, whatever mode a clone copied onto it.
	#[cfg(unix)]
	#[test]
	fn reset_tree_keeps_a_directory_that_was_there_and_remakes_its_own_writable() {
		use std::os::unix::fs::{MetadataExt, PermissionsExt};
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let common = repo.info().common_dir.clone();
		let kept = trees.path().join("kept");
		fs::create_dir(&kept).unwrap();
		fs::set_permissions(&kept, fs::Permissions::from_mode(0o750)).unwrap();
		let inode = fs::metadata(&kept).unwrap().ino();
		let made = trees.path().join("made");
		let mut pendings = Vec::new();
		for tree in [&kept, &made] {
			let pending = PendingWorktree::begin(tree, &common, &head, None).unwrap();
			fs::write(tree.join("copied"), "partial\n").unwrap();
			// What a clone of a source whose root is 0500 leaves.
			fs::set_permissions(tree, fs::Permissions::from_mode(0o500)).unwrap();
			pending.reset_tree().unwrap();
			pendings.push(pending);
		}
		assert_eq!(pendings.len(), 2);
		let meta = fs::metadata(&kept).unwrap();
		assert_eq!((meta.ino(), meta.mode() & 0o777), (inode, 0o750), "the directory that was there");
		assert!(is_empty_dir_any(&kept));
		assert!(is_empty_dir_any(&made));
		fs::write(made.join("written"), "").expect("the add's own directory was left unwritable");
		#[cfg(target_os = "linux")]
		for tree in [&kept, &made] {
			assert!(
				tree_mark::get(tree).unwrap().is_some(),
				"{} was not marked afresh",
				tree.display()
			);
		}
	}

	/// A directory that was there before the add and that a failed clone
	/// attempt removed (pi-iso removes a removable destination) is made again
	/// with the mode it had.
	#[cfg(unix)]
	#[test]
	fn reset_tree_makes_a_removed_directory_that_was_there_again_with_its_mode() {
		use std::os::unix::fs::PermissionsExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let kept = trees.path().join("kept");
		fs::create_dir(&kept).unwrap();
		fs::set_permissions(&kept, fs::Permissions::from_mode(0o750)).unwrap();
		let pending = PendingWorktree::begin(&kept, &repo.info().common_dir, &head, None).unwrap();
		fs::remove_dir_all(&kept).unwrap();
		pending.reset_tree().unwrap();
		let mode = fs::metadata(&kept).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o750, "made again with mode {mode:o}");
		assert!(is_empty_dir_any(&kept));
	}

	/// A finished add leaves no token on its tree.
	#[cfg(target_os = "linux")]
	#[test]
	fn finish_clears_the_token() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let mut pending =
			PendingWorktree::begin(&tree, &repo.info().common_dir, &head, None).unwrap();
		assert!(tree_mark::get(&tree).unwrap().is_some(), "begin set no token");
		pending.link().unwrap();
		assert!(pending.finish(None).is_empty());
		assert_eq!(tree_mark::get(&tree).unwrap(), None);
	}

	/// Whether `dir` is an empty directory, on every unix.
	#[cfg(unix)]
	fn is_empty_dir_any(dir: &Path) -> bool {
		fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_none())
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_leaves_a_registration_whose_marker_changed_after_it_was_opened() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let trees = tempfile::tempdir().unwrap();
		// The add finishes between the reclaim's open and its lock.
		let done = trees.path().join("done");
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let mut pending = PendingWorktree::begin(&done, &common, &head, Some("in use")).unwrap();
		pending.link().unwrap();
		fs::write(done.join("work"), "finished\n").unwrap();
		let open = |path: &Path| {
			fs::OpenOptions::new()
				.read(true)
				.write(true)
				.open(path)
				.unwrap()
		};
		let stale = open(&pending.admin.join(ADD_IN_PROGRESS));
		let admin = pending.admin.clone();
		assert!(pending.finish(Some("in use")).is_empty());
		drop(pending);
		assert_eq!(reclaim_with_marker(&common, &admin, &done, stale).unwrap(), None);
		assert!(done.join("work").is_file() && admin.is_dir(), "a finished add was removed");
		// Another add took the registration's marker after the reclaim opened
		// the dead add's: its record still matches the tree.
		let dead = trees.path().join("dead");
		let admin = abandoned_add(&repo, &dead, None);
		let marker = admin.join(ADD_IN_PROGRESS);
		let stale = open(&marker);
		let record = fs::read(&marker).unwrap();
		fs::remove_file(&marker).unwrap();
		fs::write(&marker, &record).unwrap();
		let holder = open(&marker);
		holder.lock().unwrap();
		assert_eq!(reclaim_with_marker(&common, &admin, &dead, stale).unwrap(), None);
		assert!(dead.join("partial").is_file() && admin.is_dir(), "a taken registration was removed");
		// Control: the same registration, once its holder lets go, is the dead
		// add's and goes.
		release(holder);
		let fresh = open(&marker);
		assert!(
			reclaim_with_marker(&common, &admin, &dead, fresh)
				.unwrap()
				.is_some()
		);
		assert!(is_empty_dir(&dead) && !admin.exists());
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_resolves_a_relative_gitdir_against_the_registration() {
		let (temp, repo) = fixture();
		let tree = temp.path().join("inner-wt");
		let admin = abandoned_add(&repo, &tree, None);
		// What `git worktree repair` writes under `worktree.useRelativePaths`:
		// the path from the registration (`.git/worktrees/<id>`) to the tree.
		fs::write(admin.join("gitdir"), "../../../inner-wt/.git\n").unwrap();
		assert_eq!(
			registered_tree(&admin).map(|tree| resolve_leaf(&tree)),
			Some(resolve_leaf(&tree))
		);
		assert_eq!(repo.worktree_reclaim_abandoned(&tree).unwrap().len(), 1);
		assert!(is_empty_dir(&tree) && !admin.exists());
	}

	/// The tree swapped for a symlink to someone's directory between the
	/// reclaim's checks and its removal: nothing is removed through the
	/// symlink; the add's own tree, moved away, is what gets emptied.
	#[cfg(target_os = "linux")]
	#[test]
	fn reclaim_removes_nothing_through_a_symlink_swapped_in_after_the_checks() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let _admin = abandoned_add(&repo, &tree, None);
		let victim = trees.path().join("victim");
		fs::create_dir(&victim).unwrap();
		fs::write(victim.join("theirs.txt"), "not the add's\n").unwrap();
		let moved = trees.path().join("wt-moved");
		let (from, to, target) = (tree.clone(), moved.clone(), victim.clone());
		test_hooks::set_before_tree_removal(move |_| {
			fs::rename(&from, &to).unwrap();
			std::os::unix::fs::symlink(&target, &from).unwrap();
		});
		let result = repo.worktree_reclaim_abandoned(&tree);
		test_hooks::clear();
		assert!(
			victim.join("theirs.txt").is_file(),
			"the reclaim removed a file through the symlink swapped in: {result:?}"
		);
		assert!(
			fs::symlink_metadata(&tree)
				.unwrap()
				.file_type()
				.is_symlink()
		);
		assert!(is_empty_dir(&moved), "the add's own tree, moved away, was not emptied: {result:?}");
	}

	/// A failed add's `Drop` removes the registration before it lets go of
	/// the marker, so a reclaim waiting on that marker finds no
	/// registration to remove (a later add may reuse its name). The seam
	/// runs at the release itself, so the check does not depend on timing.
	#[test]
	fn drop_removes_the_registration_before_it_releases_the_marker() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let tree = trees.path().join("wt");
		let pending = PendingWorktree::begin(&tree, &repo.info().common_dir, &head, None).unwrap();
		fs::write(tree.join("partial"), "partial\n").unwrap();
		let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
		let record = std::rc::Rc::clone(&seen);
		test_hooks::set_before_marker_release(move |admin| {
			record.borrow_mut().push(admin.exists());
		});
		drop(pending);
		test_hooks::clear();
		assert_eq!(
			*seen.borrow(),
			vec![false],
			"the marker was released while the registration was still there"
		);
	}

	/// git only warns when it cannot remove its lock at the end of an add;
	/// the finished worktree stays.
	#[cfg(unix)]
	#[test]
	fn finish_keeps_the_worktree_when_it_cannot_remove_the_lock() {
		use std::os::unix::fs::PermissionsExt;
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let tree = trees.path().join("wt");
		let mut pending =
			PendingWorktree::begin(&tree, &repo.info().common_dir, "ref: refs/heads/side", None)
				.unwrap();
		pending.link().unwrap();
		fs::write(tree.join("work"), "done\n").unwrap();
		// `locked` as a directory holding a file in a read-only directory
		// cannot be removed by anyone but root.
		let locked = pending.admin.join("locked");
		fs::remove_file(&locked).unwrap();
		let read_only = locked.join("ro");
		fs::create_dir_all(&read_only).unwrap();
		fs::write(read_only.join("f"), "").unwrap();
		fs::set_permissions(&read_only, fs::Permissions::from_mode(0o500)).unwrap();
		if fs::write(read_only.join("probe"), "").is_ok() {
			fs::set_permissions(&read_only, fs::Permissions::from_mode(0o700)).unwrap();
			eprintln!("SKIP: running as root, where nothing makes the lock impossible to remove");
			return;
		}
		let admin = pending.admin.clone();
		let _ = pending.finish(None);
		drop(pending);
		fs::set_permissions(&read_only, fs::Permissions::from_mode(0o700)).unwrap();
		assert!(tree.join("work").is_file(), "the finished worktree was removed");
		assert!(admin.join("gitdir").is_file(), "the finished worktree's registration was removed");
		assert!(!admin.join(ADD_IN_PROGRESS).exists(), "the marker outlived the lock's failure");
	}

	/// `omp worktree clear` keeps a locked registration whose tree is out of
	/// reach, as `git worktree prune` does, so a clear while an add writes its
	/// tree keeps the add's registration: it is locked before its `gitdir`
	/// names a `.git` that does not exist yet.
	#[test]
	fn worktree_prune_keeps_a_locked_entry_and_an_add_in_progress() {
		let (_temp, repo) = fixture();
		let trees = tempfile::tempdir().unwrap();
		let head = git(repo.root(), &["rev-parse", "HEAD"]);
		let adding = trees.path().join("adding");
		let pending = PendingWorktree::begin(&adding, &repo.info().common_dir, &head, None).unwrap();
		let gone = trees.path().join("gone");
		let locked = abandoned_add(&repo, &gone, Some("on a disk that is not mounted"));
		fs::remove_dir_all(&gone).unwrap();
		repo.worktree_prune().unwrap();
		assert!(pending.admin.join("gitdir").is_file(), "a clear removed a live add's registration");
		assert!(locked.join("gitdir").is_file(), "a clear removed a locked registration");
	}

	#[test]
	fn mutate_stage_commit_amend_and_empty() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join("new"), "new\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  a\n?? new");
		let first = repo
			.commit_create("change", &CommitOptions {
				author: Some(CommitAuthor {
					name:  "Other".into(),
					email: "other@example.com".into(),
					date:  Some("2020-01-02T03:04:05Z".into()),
				}),
				..Default::default()
			})
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), first);
		assert_eq!(
			git(temp.path(), &["show", "-s", "--format=%an <%ae>", "HEAD"]),
			"Other <other@example.com>"
		);
		assert!(
			repo
				.commit_create("empty", &CommitOptions::default())
				.is_err()
		);
		fs::write(temp.path().join("a"), "amended\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let amended = repo
			.commit_create("amended", &CommitOptions { amend: true, ..Default::default() })
			.unwrap();
		assert_ne!(first, amended);
		assert_eq!(git(temp.path(), &["rev-list", "--count", "HEAD"]), "2");
		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "A  new");
		repo.unstage(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "?? new");
	}

	#[cfg(unix)]
	#[test]
	fn commit_respects_configured_signing_and_refuses_failed_signatures() {
		let (temp, _) = fixture();
		// A pre-1973 author date: git rejects a bare `<seconds> <offset>` under
		// nine digits, so the amend below proves the raw date reaches the
		// signed commit intact.
		git(temp.path(), &["commit", "-q", "--amend", "--no-edit", "--date=@86400 +0130"]);
		let key = temp.path().join("signing-key");
		let output = Command::new("ssh-keygen")
			.args(["-q", "-t", "ed25519", "-N", "", "-f"])
			.arg(&key)
			.output()
			.unwrap();
		assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
		let signers = temp.path().join("allowed-signers");
		fs::write(
			&signers,
			format!("test@example.com {}\n", fs::read_to_string(key.with_extension("pub")).unwrap()),
		)
		.unwrap();
		git(temp.path(), &["config", "gpg.format", "ssh"]);
		git(temp.path(), &["config", "user.signingkey", key.to_str().unwrap()]);
		git(temp.path(), &["config", "gpg.ssh.allowedSignersFile", signers.to_str().unwrap()]);
		git(temp.path(), &["config", "commit.gpgsign", "true"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		let identity = |rev: &str| {
			git(temp.path(), &["log", "-1", "--date=raw", "--format=%an|%ae|%ad|%cn|%ce", rev])
		};

		fs::write(temp.path().join("a"), "amended\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let amended = repo
			.commit_create("signed amend", &CommitOptions { amend: true, ..Default::default() })
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), amended);
		git(temp.path(), &["verify-commit", "HEAD"]);
		assert_eq!(identity("HEAD"), "Test|test@example.com|86400 +0130|Test|test@example.com");
		assert_eq!(git(temp.path(), &["rev-list", "--count", "HEAD"]), "1");

		let message = "subject ünïcode\n\nbody line\n";
		fs::write(temp.path().join("b"), "signed\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		let signed = repo
			.commit_create(message, &CommitOptions::default())
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);
		git(temp.path(), &["verify-commit", "HEAD"]);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD^"]), amended);
		let raw = git(temp.path(), &["cat-file", "commit", "HEAD"]);
		assert!(raw.ends_with(&format!("\n\n{}", message.trim_end())), "{raw}");

		git(temp.path(), &["config", "user.signingkey", "/no-such-signing-key"]);
		fs::write(temp.path().join("a"), "must not commit\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let error = repo
			.commit_create("failed signer", &CommitOptions::default())
			.unwrap_err();
		assert!(matches!(error, Error::Cli { .. }), "{error:?}");
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);

		// Git refuses a malformed boolean; committing unsigned instead would
		// silently drop the signature the user asked for.
		git(temp.path(), &["config", "commit.gpgsign", "sometimes"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		assert!(
			repo
				.commit_create("malformed config", &CommitOptions::default())
				.is_err()
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);

		git(temp.path(), &["config", "commit.gpgsign", "false"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		repo
			.commit_create("unsigned by choice", &CommitOptions::default())
			.unwrap();
		assert!(!git(temp.path(), &["cat-file", "-p", "HEAD"]).contains("\ngpgsig "));
	}

	/// Staged entries record the file's stat so later status calls can skip
	/// re-hashing them; a zeroed stat would force a content check every time.
	/// A file changed in the second staging began could change again within
	/// that second without its stat changing, so it records none.
	#[test]
	fn stage_files_records_the_stat_cache_unless_racy() {
		let (temp, repo) = fixture();
		let set_mtime = |path: &str, when: std::time::SystemTime| {
			fs::OpenOptions::new()
				.write(true)
				.open(temp.path().join(path))
				.and_then(|file| file.set_modified(when))
				.unwrap();
		};
		let now = std::time::SystemTime::now();
		fs::write(temp.path().join("a"), "changed content\n").unwrap();
		set_mtime("a", now - std::time::Duration::from_secs(30));
		set_mtime("b", now + std::time::Duration::from_secs(60));
		repo.stage_files(&[]).unwrap();
		let index = gix::open(temp.path()).unwrap().open_index().unwrap();
		let stat = |path: &str| index.entry_by_path(path.into()).unwrap().stat;
		let size = fs::metadata(temp.path().join("a")).unwrap().len();
		assert_eq!(u64::from(stat("a").size), size, "a records its size");
		assert_ne!(stat("a").mtime, gix::index::entry::stat::Time::default(), "a records its mtime");
		assert_eq!(stat("b"), gix::index::entry::Stat::default(), "a racy stat is not recorded");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  a");
	}

	#[test]
	fn stage_applies_worktree_to_git_filters() {
		// Regression: staging stored raw worktree bytes, so under
		// `*.cmd text eol=crlf` a CRLF checkout staged a CRLF blob over the LF
		// HEAD blob. `stage_files(&[])` re-stages every tracked path, so every
		// untouched .cmd file surfaced as modified in both index and worktree.
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitattributes"), "*.cmd text eol=crlf\n").unwrap();
		fs::write(temp.path().join("run.cmd"), "echo one\r\necho two\r\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "crlf"]);
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		fs::write(temp.path().join("run.cmd"), "echo one\r\necho three\r\n").unwrap();
		repo.stage_files(&["run.cmd".into()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  run.cmd");
		assert_eq!(git(temp.path(), &["show", ":run.cmd"]), "echo one\necho three");
	}

	#[test]
	fn stage_all_skips_nested_gitignore_like_git_add() {
		let (temp, repo) = fixture();
		fs::create_dir_all(temp.path().join("tests/e2e/screenshots")).unwrap();
		fs::write(temp.path().join("tests/e2e/.gitignore"), "screenshots/\ntest-results/\n").unwrap();
		fs::write(temp.path().join("tests/e2e/screenshots/homepage.png"), "png").unwrap();
		fs::write(temp.path().join("tests/e2e/visible.txt"), "ok\n").unwrap();
		repo.stage_files(&[]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("screenshots"), "nested-ignored screenshot was staged:\n{status}");
		assert!(
			status.contains("tests/e2e/.gitignore"),
			"gitignore itself should be staged:\n{status}"
		);
		assert!(
			status.contains("tests/e2e/visible.txt"),
			"unignored sibling should be staged:\n{status}"
		);
	}

	#[test]
	fn stage_explicit_ignored_file_is_skipped() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("secret"), "x\n").unwrap();
		fs::write(temp.path().join("visible"), "y\n").unwrap();
		repo
			.stage_files(&["secret".into(), "visible".into()])
			.unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("secret"), "explicit ignored path was staged:\n{status}");
		assert!(status.contains("visible"), "explicit unignored path should be staged:\n{status}");
	}

	#[test]
	fn stage_dot_pathspec_matches_repository_root() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("visible"), "visible\n").unwrap();
		fs::write(temp.path().join("secret"), "secret\n").unwrap();

		repo.stage_files(&[".".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  a"), "tracked root file should be staged:\n{status}");
		assert!(status.contains("A  visible"), "untracked root file should be staged:\n{status}");
		assert!(
			!git(temp.path(), &["ls-files"])
				.lines()
				.any(|path| path == "secret"),
			"ignored root file must stay untracked"
		);
	}

	#[test]
	fn stage_dot_prefixed_directory_pathspec_is_scoped() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("dir")).unwrap();
		fs::write(temp.path().join("dir/tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "--", "dir/tracked"]);
		git(temp.path(), &["commit", "-qm", "directory"]);
		fs::write(temp.path().join("dir/tracked"), "changed\n").unwrap();
		fs::write(temp.path().join("dir/new"), "new\n").unwrap();
		fs::write(temp.path().join("outside"), "outside\n").unwrap();

		repo.stage_files(&["./dir".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  dir/tracked"), "tracked child should be staged:\n{status}");
		assert!(status.contains("A  dir/new"), "untracked child should be staged:\n{status}");
		assert!(status.contains("?? outside"), "unrequested path should stay untracked:\n{status}");
	}

	#[test]
	fn stage_explicit_metachar_directory_is_literal() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("[x]")).unwrap();
		fs::create_dir(temp.path().join("x")).unwrap();
		fs::write(temp.path().join("[x]/selected"), "selected\n").unwrap();
		fs::write(temp.path().join("x/unselected"), "unselected\n").unwrap();

		repo.stage_files(&["[x]".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(
			status.contains("A  [x]/selected"),
			"literal metacharacter directory should be staged:\n{status}"
		);
		assert!(
			status.contains("?? x/"),
			"pattern lookalike directory should stay untracked:\n{status}"
		);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn stage_all_does_not_add_nfd_duplicate_of_nfc_index_path() {
		let (temp, repo) = fixture();
		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "hello\n").unwrap();
		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "accent"]);
		let before = git(temp.path(), &["ls-files", "-z"]);
		assert!(
			before.split('\0').filter(|p| p.contains("caf")).count() == 1,
			"setup should track one NFC path, got {before:?}"
		);
		assert!(!before.contains('\u{301}'), "git add should store NFC, got {before:?}");

		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe, [nfc], "native add created a unicode duplicate: {after:?}");

		repo.stage_files(&[nfd.to_owned()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after_explicit = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after_explicit
			.split('\0')
			.filter(|p| p.contains("caf"))
			.collect();
		assert_eq!(cafe, [nfc], "explicit NFD add created a unicode duplicate: {after_explicit:?}");
	}

	#[cfg(unix)]
	#[test]
	fn stage_explicit_hardlink_keeps_unrelated_name() {
		let (temp, repo) = fixture();
		fs::hard_link(temp.path().join("a"), temp.path().join("link")).unwrap();
		repo.stage_files(&["link".into()]).unwrap();
		let files = git(temp.path(), &["ls-files"]);
		assert!(files.contains('a'), "tracked original must remain:\n{files}");
		assert!(
			files.contains("link"),
			"unrelated hardlink name must be staged as its own path:\n{files}"
		);
	}

	#[test]
	fn stage_keeps_distinct_nfc_and_nfd_when_precompose_is_off() {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		git(temp.path(), &["config", "core.precomposeunicode", "false"]);
		fs::write(temp.path().join("tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();

		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "nfc\n").unwrap();
		fs::write(temp.path().join(nfd), "nfd\n").unwrap();
		let nfc_body = fs::read_to_string(temp.path().join(nfc)).unwrap();
		let nfd_body = fs::read_to_string(temp.path().join(nfd)).unwrap();
		if nfc_body == nfd_body {
			return;
		}

		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "nfc"]);
		repo.stage_files(&[nfd.to_owned()]).unwrap();
		let files = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = files.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe.len(), 2, "NFC and NFD must stay distinct when precompose is off: {files:?}");
		assert!(cafe.contains(&nfc), "{cafe:?}");
		assert!(cafe.contains(&nfd), "{cafe:?}");
	}

	#[cfg(unix)]
	fn write_hook(path: &Path, body: &str, executable: bool) {
		use std::os::unix::fs::PermissionsExt;
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
	}

	#[cfg(windows)]
	fn write_hook(path: &Path, body: &str, _executable: bool) {
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
	}

	#[test]
	fn stage_commit_survives_unadvanced_index_mtime() {
		// Regression: a commit right after staging on the same cached handle used
		// to read a stale in-memory index snapshot when the on-disk index mtime
		// did not advance past the snapshot's (sub-second writes / coarse mtime
		// filesystems), failing with "nothing to commit, working tree clean".
		let (temp, repo) = fixture();
		// Pin the mtime so the snapshot captured while staging and the index the
		// write leaves behind collide on the exact same tick.
		crate::git::pin_index_mtime(&repo);

		fs::write(temp.path().join("a"), "changed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		// Staging bumped the mtime; forcing it back reproduces the same-tick
		// collision that made gix serve the pre-stage index.
		crate::git::pin_index_mtime(&repo);

		let sha = repo
			.commit_create("change", &CommitOptions::default())
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), sha);
		// The commit must carry the staged content, not the stale base index.
		assert_eq!(git(temp.path(), &["show", "HEAD:a"]), "changed");
	}

	#[test]
	fn commit_hooks_match_git_commit_behavior() {
		let (temp, repo) = fixture();
		let hooks = temp.path().join(".git/hooks");
		let pre_commit = hooks.join("pre-commit");
		write_hook(&pre_commit, "echo 'policy says no' >&2\nexit 1", true);
		fs::write(temp.path().join("a"), "blocked\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let before = git(temp.path(), &["rev-parse", "HEAD"]);
		let error = repo
			.commit_create("blocked", &CommitOptions::default())
			.unwrap_err();
		assert!(matches!(
			&error,
			Error::Cli { stderr, .. } if stderr.contains("policy says no")
		));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), before);

		fs::remove_file(&pre_commit).unwrap();
		write_hook(
			&hooks.join("commit-msg"),
			"printf 'rewritten subject\\n\\nrewritten body\\n' > \"$1\"",
			true,
		);
		repo
			.commit_create("original", &CommitOptions::default())
			.unwrap();
		assert_eq!(
			git(temp.path(), &["log", "-1", "--pretty=%B"]),
			"rewritten subject\n\nrewritten body"
		);

		fs::write(temp.path().join("b"), "changed again\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		fs::remove_file(hooks.join("commit-msg")).unwrap();
		repo
			.commit_create("missing hook is skipped", &CommitOptions::default())
			.unwrap();

		#[cfg(unix)]
		{
			fs::write(temp.path().join("b"), "one more\n").unwrap();
			repo.stage_files(&["b".into()]).unwrap();
			write_hook(&pre_commit, "echo should-not-run >&2\nexit 1", false);
			repo
				.commit_create("non-executable hook is skipped", &CommitOptions::default())
				.unwrap();
		}
		#[cfg(unix)]
		fs::remove_file(&pre_commit).unwrap();
		repo
			.commit_create("subject\n\nbody\n\n", &CommitOptions {
				allow_empty: true,
				..CommitOptions::default()
			})
			.unwrap();
		assert_eq!(repo.commit_details("HEAD").unwrap().message, "subject\n\nbody\n");
	}

	#[test]
	fn mutate_checkout_branches_and_resets() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let main = repo
			.commit_create("main", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(git(temp.path(), &["symbolic-ref", "--short", "HEAD"]), "other");
		repo.checkout("main").unwrap();
		repo.reset(ResetMode::Soft, Some("HEAD^")).unwrap();
		assert!(git(temp.path(), &["status", "--porcelain"]).starts_with("M  a"));
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		fs::write(temp.path().join("a"), "mixed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		repo.reset(ResetMode::Mixed, Some("HEAD^")).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), " M a");
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert!(repo.delete_branch("other", true).unwrap());
		assert!(!repo.delete_branch("missing", true).unwrap());
	}

	#[test]
	fn checkout_restore_and_worktree_remove_honor_autocrlf() {
		// Regression: conflict and dirty checks hashed raw worktree bytes, so a
		// CRLF checkout under `core.autocrlf=true` (the Git for Windows default)
		// read as modified and blocked the next checkout or a non-forced
		// worktree removal, and restore wrote LF where git writes CRLF.
		let (temp, repo) = fixture();
		git(temp.path(), &["config", "core.autocrlf", "true"]);
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		repo
			.commit_create("main", &CommitOptions::default())
			.unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "one\r\n");
		repo.checkout("main").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "main\r\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		fs::write(temp.path().join("a"), "dirty\r\n").unwrap();
		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		repo
			.restore(&RestoreOptions { files: vec!["a".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "main\r\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		let linked = temp.path().join("../linked-autocrlf");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();
		assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "main\r\n");
		assert!(repo.worktree_remove(&linked, false).unwrap(), "clean CRLF checkout is not dirty");
	}

	#[test]
	fn mutate_clean_and_alternate_index() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "ignored\n").unwrap();
		repo.stage_files(&[".gitignore".into()]).unwrap();
		repo
			.commit_create("ignore", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo.clean(&CleanOptions::default()).unwrap();
		assert!(temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		repo
			.clean(&CleanOptions { ignored_only: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo
			.clean(&CleanOptions { include_ignored: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		let alternate = temp.path().join("alternate-index");
		repo.read_tree("HEAD", Some(&alternate)).unwrap();
		assert_eq!(
			repo.write_tree(Some(&alternate)).unwrap(),
			git(temp.path(), &["rev-parse", "HEAD^{tree}"])
		);
	}

	#[test]
	fn clean_respects_nested_ignores_and_preserves_submodules() {
		let (temp, repo) = fixture();
		let outside = tempfile::tempdir().unwrap();
		// 1. Nested gitignore
		let nested = temp.path().join("nested");
		fs::create_dir_all(&nested).unwrap();
		fs::write(nested.join(".gitignore"), "secret.env\n").unwrap();
		repo.stage_files(&["nested/.gitignore".into()]).unwrap();
		repo
			.commit_create("add nested gitignore", &CommitOptions::default())
			.unwrap();
		fs::write(nested.join("secret.env"), "secret\n").unwrap();
		fs::write(nested.join("untracked.txt"), "delete\n").unwrap();

		// 2. Checked-out submodule
		let sub = temp.path().join("sub-repo");
		fs::create_dir_all(&sub).unwrap();
		git(&sub, &["init", "-q", "-b", "main"]);
		git(&sub, &["config", "user.email", "test@example.com"]);
		git(&sub, &["config", "user.name", "test"]);
		fs::write(sub.join("sub-file.txt"), "committed-in-sub\n").unwrap();
		git(&sub, &["add", "."]);
		git(&sub, &["commit", "-qm", "sub init"]);

		git(temp.path(), &[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"add",
			sub.to_str().unwrap(),
			"my-submodule",
		]);
		git(temp.path(), &["commit", "-qm", "add submodule"]);

		let checked_out_sub = temp.path().join("my-submodule");
		fs::write(checked_out_sub.join("dirty-untracked.txt"), "sub untracked\n").unwrap();
		fs::write(checked_out_sub.join("sub-file.txt"), "sub modified\n").unwrap();

		// 3. Parent untracked file
		fs::write(temp.path().join("parent-untracked.txt"), "delete\n").unwrap();

		// 4. Global excludesfile (core.excludesFile), configured *after* `repo`'s
		//    cached gix handle was opened by the staging calls above. The clean
		//    below must observe it or `global.env` is deleted.
		let global_exclude = outside.path().join("global-excludes");
		fs::write(&global_exclude, "global.env\n").unwrap();
		git(temp.path(), &["config", "core.excludesFile", global_exclude.to_str().unwrap()]);
		fs::write(temp.path().join("global.env"), "global-secret\n").unwrap();

		// 4b. Repository-local `.git/info/exclude`
		let info_dir = repo.info().git_dir.join("info");
		fs::create_dir_all(&info_dir).unwrap();
		fs::write(info_dir.join("exclude"), "info-excluded.env\n").unwrap();
		fs::write(temp.path().join("info-excluded.env"), "info-secret\n").unwrap();

		// 5. Untracked nested repository
		let untracked_repo = temp.path().join("untracked-nested-repo");
		fs::create_dir_all(&untracked_repo).unwrap();
		git(&untracked_repo, &["init", "-q", "-b", "main"]);
		fs::write(untracked_repo.join("nested.txt"), "nested content\n").unwrap();

		// 6. Symlink to directory (must unlink the symlink, not delete the target
		//    directory)
		#[cfg(unix)]
		let target_dir = outside.path().join("target-dir");
		#[cfg(unix)]
		{
			fs::create_dir_all(&target_dir).unwrap();
			fs::write(target_dir.join("important.txt"), "keep this\n").unwrap();
			std::os::unix::fs::symlink(&target_dir, temp.path().join("symlink-to-dir")).unwrap();
		}

		// 7. Untracked directory with file inside: empty directory gets pruned
		let to_prune = temp.path().join("untracked-dir/subdir");
		fs::create_dir_all(&to_prune).unwrap();
		fs::write(to_prune.join("leaf.txt"), "leaf\n").unwrap();

		// 8. Untracked directory initially empty: pruned (-d contract)
		let initially_empty = temp.path().join("initially-empty-dir");
		fs::create_dir_all(&initially_empty).unwrap();

		// 9. Ignored empty directory: MUST SURVIVE
		let ignored_empty = temp.path().join("ignored-empty-dir");
		fs::create_dir_all(&ignored_empty).unwrap();
		let sub_gitignore = temp.path().join(".gitignore");
		let mut current_gitignore = fs::read_to_string(&sub_gitignore).unwrap_or_default();
		current_gitignore.push_str("ignored-empty-dir/\n");
		fs::write(&sub_gitignore, current_gitignore).unwrap();

		repo
			.clean(&CleanOptions { paths: vec!["nested".into()], ..Default::default() })
			.unwrap();
		assert!(
			!nested.join("untracked.txt").exists(),
			"pathspec-scoped clean removes matches under the path"
		);
		assert!(
			nested.join("secret.env").exists(),
			"pathspec-scoped clean still honors nested ignores"
		);
		assert!(
			temp.path().join("parent-untracked.txt").exists(),
			"pathspec-scoped clean leaves paths outside the pathspec"
		);
		assert!(
			initially_empty.exists(),
			"pathspec-scoped clean leaves directories outside the pathspec"
		);
		// 10. Pathspec scoping: cleaning with a pathspec prunes empty dirs inside
		//     the pathspec but preserves the parent
		let pathspec_dir = temp.path().join("pathspec-parent/child/grandchild");
		fs::create_dir_all(&pathspec_dir).unwrap();
		fs::write(pathspec_dir.join("leaf.txt"), "leaf\n").unwrap();
		repo
			.clean(&CleanOptions { paths: vec!["pathspec-parent/child".into()], ..Default::default() })
			.unwrap();
		assert!(
			!temp.path().join("pathspec-parent/child").exists(),
			"empty dir inside pathspec must be pruned"
		);
		assert!(
			temp.path().join("pathspec-parent").exists(),
			"parent directory outside pathspec must not be pruned"
		);

		repo.clean(&CleanOptions::default()).unwrap();

		// Untracked files deleted and parent directories pruned
		assert!(!temp.path().join("parent-untracked.txt").exists());
		assert!(!nested.join("untracked.txt").exists());
		assert!(!temp.path().join("untracked-dir").exists());
		assert!(!temp.path().join("pathspec-parent").exists());
		assert!(!initially_empty.exists(), "empty untracked directory must be pruned by -d");

		// Ignored empty directory MUST SURVIVE
		assert!(ignored_empty.exists(), "ignored empty directory must survive clean");

		// Nested ignored file MUST SURVIVE
		assert!(nested.join("secret.env").exists());
		assert_eq!(fs::read_to_string(nested.join("secret.env")).unwrap(), "secret\n");

		// Global excluded file MUST SURVIVE (config set after the handle was
		// cached)
		assert!(temp.path().join("global.env").exists());
		assert_eq!(fs::read_to_string(temp.path().join("global.env")).unwrap(), "global-secret\n");

		// `.git/info/exclude` file MUST SURVIVE
		assert_eq!(
			fs::read_to_string(temp.path().join("info-excluded.env")).unwrap(),
			"info-secret\n"
		);

		// Submodule files and .git MUST SURVIVE
		assert!(checked_out_sub.join(".git").exists());
		assert!(checked_out_sub.join("sub-file.txt").exists());
		assert_eq!(
			fs::read_to_string(checked_out_sub.join("sub-file.txt")).unwrap(),
			"sub modified\n"
		);
		assert!(checked_out_sub.join("dirty-untracked.txt").exists());

		// Untracked nested repo MUST SURVIVE
		assert!(untracked_repo.join(".git").exists());
		assert!(untracked_repo.join("nested.txt").exists());
		// Symlink to directory: symlink is removed, target directory content
		// survives
		#[cfg(unix)]
		{
			assert!(!temp.path().join("symlink-to-dir").exists());
			assert!(target_dir.join("important.txt").exists());
		}
	}

	#[test]
	fn clean_rejects_empty_pathspec_and_treats_dot_as_everything() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("untracked.txt"), "x").unwrap();

		let err = repo
			.clean(&CleanOptions { paths: vec![String::new()], ..Default::default() })
			.unwrap_err();
		assert!(
			err.to_string()
				.contains("empty string is not a valid pathspec"),
			"{err}"
		);
		assert!(
			temp.path().join("untracked.txt").exists(),
			"an empty pathspec must not widen to the whole worktree"
		);

		repo
			.clean(&CleanOptions { paths: vec!["./".into()], ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("untracked.txt").exists(), "`.` selects everything like git");
	}

	#[cfg(unix)]
	#[test]
	fn detach_git_dir_does_not_mutate_when_index_snapshot_fails() {
		use std::os::unix::fs::PermissionsExt;

		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-unreadable-index");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let linked_repo = GitRepo::require(&linked).unwrap();
		let index_path = linked_repo.info().git_dir.join("index");
		let original_mode = fs::metadata(&index_path).unwrap().permissions().mode();
		let pointer_before = fs::read(linked.join(".git")).unwrap();
		fs::set_permissions(&index_path, fs::Permissions::from_mode(0o000)).unwrap();

		let result = detach_git_dir(&linked, &common);
		fs::set_permissions(&index_path, fs::Permissions::from_mode(original_mode)).unwrap();
		assert!(matches!(
			&result,
			Err(Error::Io(err)) if err.kind() == std::io::ErrorKind::PermissionDenied
		));
		assert_eq!(fs::read(linked.join(".git")).unwrap(), pointer_before);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), git(&linked, &["rev-parse", "HEAD"]));
		let _ = fs::remove_dir_all(linked);
	}

	#[test]
	fn worktree_registration_paths_are_accepted_by_git() {
		let (temp, repo) = fixture();
		let linked_dir = tempfile::tempdir().unwrap();
		let linked = linked_dir.path().to_path_buf();
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();

		let admin = registered_admin(&linked.join(".git")).unwrap().unwrap();
		assert_eq!(
			fs::read_to_string(linked.join(".git")).unwrap(),
			format!("gitdir: {}\n", git_metadata_path(&admin))
		);
		assert_eq!(
			fs::read_to_string(admin.join("gitdir")).unwrap(),
			format!("{}\n", git_metadata_path(&linked.join(".git")))
		);

		let listed = git(temp.path(), &["worktree", "list", "--porcelain"]);
		let expected = format!("worktree {}", git_metadata_path(&linked));
		assert!(listed.lines().any(|line| line == expected), "{listed}");
		git(temp.path(), &["worktree", "repair", linked.to_str().unwrap()]);
	}

	#[test]
	fn clone_first_worktree_reconciles_source_state_to_target_tree() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
		git(temp.path(), &["add", ".gitignore"]);
		git(temp.path(), &["commit", "-qm", "ignore build"]);
		git(temp.path(), &["checkout", "-qb", "target"]);
		fs::write(temp.path().join("a"), "target\n").unwrap();
		fs::remove_file(temp.path().join("b")).unwrap();
		fs::write(temp.path().join("c"), "added\n").unwrap();
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "target tree"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		fs::write(temp.path().join("untracked"), "untracked\n").unwrap();
		fs::create_dir_all(temp.path().join("build")).unwrap();
		fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();

		let linked = temp.path().join("../linked-clone-first");
		let _ = fs::remove_dir_all(&linked);
		let result = repo
			.worktree_add(&linked, "target", WorktreeAddOptions {
				detach:       false,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();

		assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "target\n");
		assert_eq!(fs::read_to_string(linked.join("c")).unwrap(), "added\n");
		assert!(!linked.join("b").exists());
		assert!(!linked.join("untracked").exists());
		assert!(
			fs::read_to_string(linked.join(".git"))
				.unwrap()
				.starts_with("gitdir: ")
		);
		let linked_repo = GitRepo::require(&linked).unwrap();
		assert_eq!(
			fs::read_to_string(&linked_repo.info().head_path).unwrap(),
			"ref: refs/heads/target\n"
		);
		let gix = linked_repo.gix().unwrap();
		let mut status = status_with_fresh_index(&gix, "git status")
			.unwrap()
			.untracked_files(gix::status::UntrackedFiles::Files)
			.into_iter(std::iter::empty::<BString>())
			.unwrap();
		assert!(status.next().is_none());

		if result.cloned_with.is_some() {
			assert_eq!(fs::read_to_string(linked.join("build/out.txt")).unwrap(), "ignored\n");
		} else {
			assert!(!linked.join("build/out.txt").exists());
			assert!(
				result.clone_error.is_some() || pi_iso::clone_candidates(None).is_empty(),
				"a failed clone attempt must surface its reason"
			);
		}
		let _ = repo.worktree_remove(&linked, true);
	}

	/// Whether any host-available clone backend can actually clone a tree
	/// on `dir`'s filesystem. `pi_iso::clone_candidates` is a host-level
	/// probe only: Linux reports reflink support even when the temp dir
	/// sits on ext4, where `FICLONE` fails with `EOPNOTSUPP`.
	fn clone_works_on(dir: &Path) -> bool {
		let source = dir.join("clone-probe-src");
		let target = dir.join("clone-probe-dst");
		fs::create_dir_all(&source).unwrap();
		fs::write(source.join("file"), b"probe\n").unwrap();
		let works = pi_iso::clone_candidates(None).into_iter().any(|kind| {
			let _ = fs::remove_dir_all(&target);
			pi_iso::backend(kind)
				.clone_tree(&source, &target, &pi_iso::CloneExclusions::default())
				.is_ok()
		});
		let _ = fs::remove_dir_all(&source);
		let _ = fs::remove_dir_all(&target);
		works
	}

	#[test]
	fn clone_first_worktree_at_source_head_needs_no_checkout() {
		let (temp, repo) = fixture();
		git(temp.path(), &["branch", "same-as-head"]);
		let linked = temp.path().join("../linked-clone-noop");
		let _ = fs::remove_dir_all(&linked);
		let clone_works = clone_works_on(temp.path());
		let result = repo
			.worktree_add(&linked, "same-as-head", WorktreeAddOptions {
				detach:       false,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();
		if clone_works {
			assert!(
				result.cloned_with.is_some(),
				"an identical tree must not fail the clone path: {:?}",
				result.clone_error
			);
		} else {
			assert!(
				result.clone_error.is_some() || pi_iso::clone_candidates(None).is_empty(),
				"a failed clone attempt must surface its reason"
			);
		}
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(&linked, &["status", "--porcelain"]), "");
		let _ = repo.worktree_remove(&linked, true);
	}

	#[test]
	fn worktree_add_keep_changes_carries_dirty_state_on_both_paths() {
		for clone in [WorktreeClone::Auto, WorktreeClone::Off] {
			let (temp, repo) = fixture();
			fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
			git(temp.path(), &["add", ".gitignore"]);
			git(temp.path(), &["commit", "-qm", "ignore build"]);
			fs::write(temp.path().join("a"), "staged\n").unwrap();
			git(temp.path(), &["add", "a"]);
			fs::write(temp.path().join("a"), "staged then edited\n").unwrap();
			fs::remove_file(temp.path().join("b")).unwrap();
			fs::create_dir_all(temp.path().join("new/dir")).unwrap();
			fs::write(temp.path().join("new/dir/untracked"), "untracked\n").unwrap();
			fs::create_dir_all(temp.path().join("build")).unwrap();
			fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();
			git(temp.path(), &["branch", "kept"]);

			let linked = temp.path().join(format!("../linked-keep-{clone:?}"));
			let _ = fs::remove_dir_all(&linked);
			let result = repo
				.worktree_add(&linked, "kept", WorktreeAddOptions {
					detach: false,
					clone,
					keep_changes: true,
					lock: None,
				})
				.unwrap();
			if clone == WorktreeClone::Off {
				assert!(result.cloned_with.is_none());
			}

			assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "staged then edited\n");
			assert!(!linked.join("b").exists());
			assert_eq!(fs::read_to_string(linked.join("new/dir/untracked")).unwrap(), "untracked\n");
			assert_eq!(
				linked.join("build/out.txt").exists(),
				result.cloned_with.is_some(),
				"ignored files ride along only with a clone"
			);
			assert_eq!(
				git(&linked, &["status", "--porcelain"]),
				git(temp.path(), &["status", "--porcelain"]),
				"linked worktree must report the same staged/unstaged/untracked set"
			);
			assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
			assert_eq!(git(&linked, &["symbolic-ref", "HEAD"]), "refs/heads/kept");
			// The source keeps its own dirty state untouched.
			assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged then edited\n");

			let rejected = repo.worktree_add(
				&temp.path().join("../linked-keep-rejected"),
				"HEAD~1",
				WorktreeAddOptions { detach: true, clone, keep_changes: true, lock: None },
			);
			assert!(rejected.is_err(), "keep_changes must require the source HEAD as target");
			let _ = repo.worktree_remove(&linked, true);
		}
	}

	#[test]
	fn worktree_add_keep_changes_carries_staged_only_state_without_phantom_edits() {
		for clone in [WorktreeClone::Auto, WorktreeClone::Off] {
			let (temp, repo) = fixture();
			fs::write(temp.path().join("c"), "three\n").unwrap();
			git(temp.path(), &["add", "c"]);
			git(temp.path(), &["commit", "-qm", "add c"]);
			// The source keeps its LF files; a plain checkout under autocrlf
			// writes CRLF, so clean files land at a different size.
			git(temp.path(), &["config", "core.autocrlf", "true"]);
			fs::write(temp.path().join("a"), "staged only\n").unwrap();
			git(temp.path(), &["add", "a"]);
			git(temp.path(), &["rm", "-q", "b"]);
			fs::write(temp.path().join("added"), "staged add\n").unwrap();
			git(temp.path(), &["add", "added"]);
			let source_status = git(temp.path(), &["status", "--porcelain"]);
			assert_eq!(source_status, "M  a\nA  added\nD  b");
			git(temp.path(), &["branch", "kept-staged"]);

			let linked = temp.path().join(format!("../linked-keep-staged-{clone:?}"));
			let _ = fs::remove_dir_all(&linked);
			let result = repo
				.worktree_add(&linked, "kept-staged", WorktreeAddOptions {
					detach: false,
					clone,
					keep_changes: true,
					lock: None,
				})
				.unwrap();
			if clone == WorktreeClone::Off {
				assert!(result.cloned_with.is_none());
			}

			assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "staged only\n");
			assert_eq!(fs::read_to_string(linked.join("added")).unwrap(), "staged add\n");
			assert!(!linked.join("b").exists());
			assert_eq!(
				git(&linked, &["status", "--porcelain"]),
				source_status,
				"clean and staged-only files must not read as unstaged edits"
			);
			let _ = repo.worktree_remove(&linked, true);
		}
	}

	#[test]
	fn mutate_worktree_and_detach() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-mut");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();
		assert!(
			git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(git_metadata_path(&linked).as_ref())
		);
		assert!(repo.worktree_remove(&linked, true).unwrap());

		let linked = temp.path().join("../linked-detach");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				lock:         None,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let source_head = git(temp.path(), &["rev-parse", "HEAD"]);
		assert_eq!(detach_git_dir(&linked, &common).unwrap(), DetachGitDirResult::Detached);
		let alternates = fs::read_to_string(linked.join(".git/objects/info/alternates")).unwrap();
		assert!(alternates.contains(common.join("objects").to_string_lossy().as_ref()));
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), source_head);
		assert!(
			!git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(git_metadata_path(&linked).as_ref())
		);
		assert!(repo.worktree_prune().is_ok());
		let _ = fs::remove_dir_all(linked);
	}
}
