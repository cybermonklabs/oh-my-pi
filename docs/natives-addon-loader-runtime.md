# Natives Addon Loader Runtime

This page documents `packages/natives/native/loader-state.js`, the runtime between an ESM entrypoint and a validated `pi_natives.*.node` addon.

## Entrypoints and eager/lazy loading

- `native/index.js` calls `loadNative()` at module evaluation and exposes the generated root API.
- `native/desktop.js`, `native/clipboard.js`, `native/path.js`, and `native/vcs.js` defer native loading. Desktop, path, and VCS wrappers cache their selected class/bindings; clipboard calls `loadNative()` on each invocation. Path helpers return their input unchanged without loading on non-Windows platforms.
- Pure loader helpers are exported for focused tests and do not perform detection or filesystem probing until `loadNative()` or `initLoaderContext()` is called.

A successful call is not memoized by JS. Repeated calls rely on the runtime's `require(...)` module cache, while post-load setup is idempotent or best-effort.

## Loader context

`initLoaderContext()` derives:

- `platformTag`: `${platform}-${process.arch}`;
- package version (the expected addon release, subject to the pre-sentinel compatibility exception below);
- package-local `nativeDir` and the directory of `process.execPath`;
- `nativesDir`: `getNativesDir()` from `native/natives-dir.js` (`@oh-my-pi/pi-natives/natives-dir`), the function pi-utils' `getNativesDir()` also calls, so the grammar directory the addon loads from is the one the agent installs into. In order: `PI_NATIVES_DIR` (trimmed, `~`-expanded, and normalized; empty or relative values are ignored), `<OMP_DOWNLOAD_ROOT>/natives`, on Linux and macOS `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists, otherwise `<OMP_CONFIG_ROOT or ~/<PI_CONFIG_DIR or .omp>>/natives`. It never depends on the profile: the loader fixes the addon's grammar directory once, at load, and the profile can change later. It is one answer per process. The first call resolves it (pi-utils' `env.ts` makes that call before it applies `.env` files, in every omp process) and every later call returns that answer. Worker threads inherit it through the private `__PI_NATIVES_DIR_CACHE` entry, keyed to the process's life: on Linux its pid and start time (`/proc/self/stat`), elsewhere its pid and recorded parent, where a parent that has exited still counts (a re-parented process keeps its answer; a zombie parent, exited but unreaped, counts as running there, so such a process resolves again). A directory variable that changes later, as one a `.env` file sets does, moves nothing, so the loader never loads a second copy of the addon from another directory; omp's own `.env` loading never applies a `.env` file's `PI_NATIVES_DIR` at all. A compiled omp has Bun's own `.env` loading off. A non-compiled omp (the npm package's `bun` script, `bun src/cli.ts`) resolves its natives directory with the values Bun's own `.env` loading gave it before omp ran; `launchEnvValue`, and so the `PI_NATIVES_DIR` commands get, reads the environment the process was started with, which lacks them. Its subprocess workers, launch broker, detached `omp gc` and the bash tool's `git worktree add` helper run with `bun --no-env-file` (`resolveWorkerSpawnCmd`, `resolveCliChildCmd`), so they start with the environment omp gives them, wherever they start. Where the launch environment can be read, `/restart` and a `/fork` session (`resolveCliEntryCmd`) get exactly the values Bun's own loading gave the first launch (`bunRelaunchArgs`), since `/restart`'s `execvp(3)` and the terminal that starts a fork pass the environment the process was started with, which they are not in: `env.ts` records, when it loads, the entries of `process.env` as the process first saw it (`@oh-my-pi/pi-utils/startup-env`, the CLI's first import, taken once per process and kept on `globalThis`, so a `bun --hot` reload does not take it again) that the launch environment lacks or holds otherwise, and the relaunch, which `/restart` builds after its cleanups and stdout drain, writes only those to a private file (mode 0600, in a 0700 `mkdtemp` directory, a path with no comma) passed as the only `--env-file`. The file names its own path on its first line, a comment (`# omp relaunch file: <path>`), which Bun loads into no variable. The directory sits directly under `TMPDIR` as the session was started with it; where that is unset, missing, not absolute or cannot be written, under `/tmp`; never under `os.tmpdir()`, which follows a `TMPDIR` omp's own `.env` loading sets later. Where neither can be written, the relaunch passes `--no-env-file` and logs a warning that names each reason: the new process then starts without those values. The new process removes the file named in its own `--env-file`, wherever it is (a fork pane's terminal may have another `TMPDIR`); the parent removes it when the start fails; and a later session start, on its main thread only, removes this user's ones left for more than ten minutes under that directory and `/tmp` (a new image that died before `env.ts` loaded, a fork pane that never ran omp). A removal acts only on a real directory (not a link) of this user, named like one, that holds `loaded.env` and nothing else, where `loaded.env` is a regular file whose first line names its own path. The check never blocks: `lstat` refuses a link, a FIFO or a device before any `open`, the `open` neither follows a link nor waits (`O_NOFOLLOW | O_NONBLOCK`), `fstat` refuses anything but a regular file, and only the marker's length is read. A removal unlinks the file, then removes the directory, never recursively; any other directory stays whole: an accidental look-alike a user named in `--env-file` or `BUN_OPTIONS`, a copy (its line names another path), one whose `loaded.env` is a link, a FIFO or a device, and one a failed `/restart` or `/fork` passed on. A user who writes the line on a file of their own makes it count as omp's, which removes only a directory of that user's that has the relaunch name and holds that file alone; and a relaunch file from a build before the line was added has none, so it is never removed, by its new process or by the sweep. Under `bun --watch`, a restart after the first load starts without the relaunch values, as the file is gone by then. An entry Bun's parser cannot read back is left out: a name with a character other than a letter, a digit, `_`, `-` or `.`, and a value with a carriage return, one that ends in a backslash, or one that holds a single quote, a backtick and also a double quote or a backslash. The new process's `BUN_OPTIONS` (the command starts through `env`) is the old one split as Bun 1.4.4 splits it (`append_options_env`: an argument that starts with `--` keeps a quoted value whole, quotes included; any other is read shell-like) without its `--env-file` arguments, each kept argument written as a backslash-escaped word that Bun reads back as exactly that argument, so no two join; so Bun does not read the files again from the new directory. Where their meaning is not certain (a bare `--env-file` with no file argument after it, or with an option after it), `BUN_OPTIONS` is unset. The launch environment is `/proc/self/environ` on Linux; a compiled omp's, or a `--no-env-file` start's, is `process.env` as it first saw it. A non-compiled omp on macOS or Windows started with Bun's loading on cannot read it (neither procfs nor the addon gives it), so `/restart` and `/fork` there run the command they ran before this change, the runtime and the CLI's entry with no env-file flag and `BUN_OPTIONS` as it is, and Bun loads the `.env` files of the directory the session is in; `launchEnvValue` there returns the value the process first saw, Bun's included. Two test seams, read from the launch environment only, never from a `.env` file: `PI_TEST_NO_LAUNCH_ENV=1` makes a Linux process take this path, and `PI_TEST_RELAUNCH_FALLBACK_DIR` names the fallback in place of `/tmp`. `PI_NATIVES_DIR` in the environment is left as it is, so every program omp starts gets it as omp was started with it, or none, and a command, and an omp it starts with its own `HOME`, resolves its own directory: the commands the agent runs (`filterChildShellEnv`), the commands and services the launch broker runs (`managedDaemonEnv`: the broker's environment as a command's, with the spec over it, so no project `.env` value reaches a service), and the programs started from the whole environment (the debugger's adapter and debuggee, MCP stdio servers, language servers, the JS eval kernel's programs). omp's children that are omp take the answer from the private `__PI_NATIVES_DIR_HANDOFF` entry instead: its subprocess workers (`workerEnvFromParent`), the launch broker (`brokerEnvFromParent`), the omp daemons the broker runs (their spec carries it, `ompDaemonSpecEnv`, and the broker re-issues it), and a forked session (`/fork`, which also pins the rule's inputs at this session's launch values; its handoff, taken after the relaunch command is built, records an input the fork leaves unset at the value the relaunch file gives it, `bunRelaunchValue`, and at none when there is no relaunch file, as when none could be written and `--no-env-file` stands in its place). The entry records the child's values of the rule's inputs (`nativesDirInputNames()`: the five variables and the home directory's) and, except for a fork, which the terminal starts, the pid and start time of the process that starts the child. A process takes it only when its inputs are the recorded ones and, where a parent is recorded, that process is its parent or no longer runs (it exited, and the child was re-parented); a recorded parent that still runs started some other process. On Linux a zombie (`/proc/<pid>/stat` state `Z`, exited but not yet waited for) or a dead process (`X`) no longer runs, and a pid with another start time names another process; elsewhere only `kill(pid, 0)` tells, and a zombie counts as running, so a child re-parented while its old parent is unreaped resolves for itself. The first call removes the entry from `process.env`. A spawn with no `env` and the bash tool's native shell start from the process's startup environment, where it remains, so `filterChildShellEnv` gives commands an empty entry (an empty entry is none). A program omp starts with no `env` keeps the entry: the parent check refuses it while the recorded parent runs, so a program a worker starts that way after the session has exited takes the session's directory, and a fork's entry names no parent, so an omp such a program of the fork starts, with the fork's inputs, takes the fork's directory;
- `versionedDir`, this process's addon cache directory: `<nativesDir>/<packageVersion>-<digest prefix>`, where the digest prefix is the first 12 hex digits of the `digest` the addons carry from their build: the embedded manifest's for a compiled binary, the leaf package's `nativeAddons` for a Windows install that stages. Otherwise `<nativesDir>/<packageVersion>`, which only a compiled binary with no embedded addon probes;
- legacy compiled-binary directory: `%LOCALAPPDATA%/omp` (or `~/AppData/Local/omp`) on Windows, `~/.local/bin` elsewhere;
- workspace/install/compiled mode, optional leaf directory, Windows staging policy, CPU variant, filenames, and ordered candidates.

Compiled mode is true when a populated embedded manifest exists, `PI_COMPILED` is set, or `import.meta.url` contains a Bun embedded marker (`$bunfs`, `~BUN`, or `%7EBUN`). A non-compiled `nativeDir` outside a `node_modules` path is a workspace load. Windows path classification is case-insensitive; other platforms use case-sensitive path matching.

## Platforms and variants

Supported publish tags are:

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`
- `win32-arm64`

An unsupported tag is reported only after probing candidates.

For x64, `PI_NATIVE_VARIANT=modern|baseline` wins. Invalid values are ignored. Otherwise the private inherited `__PI_NATIVE_VARIANT_CACHE` result is used when valid; only then does the loader detect AVX2:

- Linux reads `/proc/cpuinfo`.
- macOS tries `/usr/sbin/sysctl` and then `sysctl`, querying `machdep.cpu.leaf7_features` and `machdep.cpu.features`.
- Windows under Bun first calls `kernel32.dll!IsProcessorFeaturePresent(40)` through `bun:ffi`. If FFI is unavailable, it tries non-interactive `pwsh.exe`, then `powershell.exe`, for `System.Runtime.Intrinsics.X86.Avx2`; absent/failed probes select baseline.

Detection uses `Bun.spawnSync` when available, then falls back to `node:child_process`. A detected result is written to the private cache environment entry so later workers/children inherit the same decision. Non-x64 does not use or populate a variant.

`getAddonFilenames()` returns:

| Runtime selection    | Ordered filenames                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------- |
| modern x64           | `pi_natives.<tag>-modern.node`, `pi_natives.<tag>-baseline.node`, `pi_natives.<tag>.node` |
| baseline x64         | `pi_natives.<tag>-baseline.node`, `pi_natives.<tag>.node`                                 |
| non-x64 / no variant | `pi_natives.<tag>.node`                                                                   |

## Candidate ordering

`resolveLoaderCandidates()` de-duplicates paths while retaining first occurrence.

### Installed, non-compiled package

1. Every selected filename in `@oh-my-pi/pi-natives-<tag>`.
2. For each filename, package-local `nativeDir`, then the executable directory.

The platform leaf wins over a stale core artifact. Workspace loads deliberately skip leaf resolution.

### Windows `node_modules` staging

When the platform is Windows, the runtime is non-compiled, `nativeDir` contains a `node_modules` segment, and the platform leaf package records its addons (`nativeAddons` in its `package.json`, see [the leaf package's addon list](#the-leaf-packages-addon-list)):

1. Every selected filename in `versionedDir`.
2. Leaf-package candidates.
3. Package-local and executable candidates.

Before probing, `maybeStageNodeModulesAddon()` marks `versionedDir` used and copies each selected filename the leaf records into it. A copy already there with the recorded size is reused; any other is read from the leaf, checked against the recorded size and `sha256`, and written as extraction writes (below). `versionedDir` is named by the leaf's digest, so two installs of one release with different addons never share a staged copy. This keeps the loaded DLL handle away from the package-manager copy that an update must replace. Directory, read, check and write failures are recorded and normal probing continues. A leaf that records no addons is not staged: its addons load from where they are installed, never from a directory another install could have filled.

#### The leaf package's addon list

`scripts/gen-npm-packages.ts` writes `nativeAddons` into each leaf's `package.json` when it generates the package: `files[]` with each addon's `filename`, `size` and `sha256`, and `digest`, the SHA-256 over every `filename` and `sha256`, computed as the embedded manifest's is (`addonSetDigest()` in `scripts/embed-native.ts`). The loader reads it and never hashes an addon to name the directory. A list in another shape (a digest or an addon SHA-256 that is not 64 hex digits, an entry without a string `filename` or a whole-number `size`) counts as no list: the leaf is loaded where it is installed, and the start never fails on it.

### Compiled runtime

1. For each filename, `versionedDir`, then the legacy user-data directory.
2. For each filename, package-local `nativeDir`, then the executable directory.

A successfully selected embedded candidate is prepended. Windows staging is disabled in compiled mode.

## Embedded manifest and extraction

`embedded-addon.js` is always `embeddedAddon = null` on disk, including the published core. Standalone binary builds replace it in memory with a manifest from `scripts/embed-native.ts` containing:

- `platformTag` and package `version`;
- `digest`, the SHA-256 over every file's `filename` and `sha256`: the build's identity, computed when the binary is built;
- `files[]` with `variant`, basename-only `filename`, decompressed `size`, the decompressed addon's `sha256`, and `zstdPath`, the embedded `<filename>.zst` zstd frame holding that addon.

Extraction runs only for compiled mode with matching platform and version and a selectable file. Selection is:

- non-x64: `default`, then first file;
- modern x64: `modern`, then `baseline`;
- baseline x64: `baseline` only.

Every build of a release carries the same version, and two builds' addons can have the same size, so neither decides whether a cached file is this build's. Each build extracts into its own `versionedDir`, named by its digest, and only ever reads files it wrote there. The loader creates `versionedDir` and rejects any manifest filename that is not a bare basename. Each manifest file that is already a regular file with the declared size is reused: the loader puts a file in this directory only by renaming a copy whose SHA-256 it checked, so the size shows the file is whole without reading it at every start. Every other file is decompressed from its zstd frame, checked against the declared size and `sha256`, and written to a temporary file that is synced to disk, renamed into place, and followed by a sync of the directory (not on Windows, which cannot open a directory; a directory sync that fails is ignored, since the file is already whole and in place). A crash therefore never leaves a file of the right size with missing bytes. The temporary file's name carries the process id and a random UUID, so worker threads of one process never share one. A write that finds its directory gone, because cleanup in another process claimed it at that moment (below), makes the directory again and writes once more. Unreadable frames, corrupt frames, size mismatches, and digest mismatches are errors, and nothing is written for them. A same-size file changed in place after extraction is not detected.

Extraction errors are accumulated; the loader continues to ordinary candidates.

## Candidate validation and post-load setup

For each candidate:

1. Emit a startup marker when enabled.
2. `require(candidate)`.
3. Unless this is workspace development, require `__piNativesBuildVersion()` to return the package version. The build pipeline writes that version into a fixed 64-byte slot (`PI_NATIVES_VERSION_STAMP:<version>` + NUL padding) after linking (`scripts/stamp-native-version.ts`, called from every `scripts/bazel-natives.ts` install, the local cargo build, and the Nix package build), so a release bump edits no Rust input. Addons published before the stamp expose a per-release `__piNativesV<version_with_underscores>` export instead; those are still read as their release for diagnosis.
4. Call `__ompInstallTokioRuntime()` if the addon provides it.
5. Best-effort remove the addon cache directories no omp process has used for a day, other than `versionedDir`.
6. Return the bindings.

The version error distinguishes a previous addon still resident in the current process from a stale file on disk. If the loaded exports report an older release but the candidate bytes contain the current stamp (`PI_NATIVES_VERSION_STAMP:<packageVersion>\0`), the diagnostic says to restart. Otherwise it says to reinstall. The loader does not validate all public exports. As a compatibility exception, an addon with no release identity is accepted if it has `countTokens`, `executeShell`, `visibleWidth`, and a `DesktopSession` with `capture`, `execute`, and `close`, and the candidate bytes do not carry the expected current stamp. An unstamped current addon that exposes the stamp reader is not eligible.

Workspace development skips the version check entirely, so a checkout that pulled a newer release boots before its rebuild. That tolerance is not silent: `native/index.js` uses `missingNativeExport(symbol)` for missing ordinary function exports (release-identity functions remain raw passthroughs), which is `undefined` on a current addon and a throwing stub on a stale one naming the symbol, the addon path, the loaded and expected releases, and `bun run build:native`. `nativeAddonStatus()` reports the same identity (`path`, `version`, `packageVersion`, `stale`, `builtFromOtherSources`) for callers that surface it themselves.

Rust module initialization installs crash diagnostics but does not spawn runtime threads under the dynamic-loader lock. The optional post-load hook installs bounded Windows Tokio and Rayon pools. It is best-effort; older addons or hook failures fall back to napi-rs behavior. Set `PI_DEBUG_STARTUP` to emit synchronous `[startup]` markers to stderr, including hook success/failure.

Cache cleanup ignores read/delete failures. It considers only directories named `<major.minor.patch>` or `<major.minor.patch>-<12 hex digits>`, whatever their version, never `versionedDir`, and removes those whose mtime is more than a day old. Every start marks the directory it loads from as used: `prepareNativeVersionDir()` refreshes the mtime before extraction and at every staging start, reused copy or not. Because a start can mark a directory used just after cleanup read its time, cleanup first renames a stale directory to a private name (`.<name>.removing.<pid>.<uuid>`, which no start reaches), reads its time again, and renames it back when a start marked it meanwhile; only a directory still stale is removed. For the moment between the two renames the directory's path does not exist. A start that extracts then makes it again and writes once more (above). A start whose load of a file in its own `versionedDir` fails because the file was not there, after the check that found it there, loads it once more: from the directory cleanup has renamed back, or, if it has not, after extracting or staging the file again, so the start does not fail. The loader tries each candidate path once, so this retry is the only second load of a path. Private names a cleanup left when it stopped half-way are removed once they too are a day old. Two builds run in turn therefore keep one extracted addon each instead of extracting one at every switch, a directory a concurrent start is populating survives, and a build nobody has started for a day loses its directory and extracts again if it starts. Cleanup preserves `grammars`, prerelease and other names, and ordinary files.

## Workspace addons built from other Rust sources

A release difference is not the only way a workspace addon goes stale: an addon of this release built before the checkout's Rust sources changed carries other code under the same version. The native build therefore records the sources it compiled next to the addon, in `<addon>.sources.json`, and a workspace load compares that record with the checkout (`native/workspace-sources.js`). Compiled binaries and package installs never read it.

- **What the sources are:** the source files the build had, listed in the record. They come from the build's roots: for a Cargo build (`CARGO_SOURCE_ROOTS`) `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/` and `crates/`; for a Bazel build (`BAZEL_SOURCE_ROOTS`) those, plus the root `BUILD.bazel`, `MODULE.bazel`, `.bazelrc`, `.bazelversion`, `.bazelignore` and `bazel/` (each crate's `BUILD.bazel` is under `crates/`). `MODULE.bazel.lock` is left out: a build rewrites it after `MODULE.bazel` changes, and it follows from `MODULE.bazel`. In a repository whose top level is the tree (`git rev-parse --show-toplevel`), the build lists the files git tracks or would track (`git ls-files --cached --others --exclude-standard`), so gitignored files (tool caches, `__pycache__`) are not sources. Elsewhere (a Docker build context, a tree with no `.git` of its own inside another repository), or when git fails in the repository, it runs the same listing against a throwaway repository, as the Dockerfile's key step does, so the tree's `.gitignore` files still apply, `target` directories are left out and every listed file counts as tracked; only when that fails too, or git cannot run at all, does it list every file, skipping `target` directories and names starting with a dot. A symbolic link is recorded as a link, by its target path, and never followed, so a link loop or a link out of the checkout neither fails the build nor brings in other files.
- **Inputs no listed file names:** a build also takes in files no source file declares. The record covers the two ways it does:
  - a directory a build script scans (`crates/pi-shell/build.rs` compiles every `src/minimizer/defs/*.toml`): the directories each listed `BUILD.bazel` gives its `cargo_build_script` through a `glob()` (its first list or `include = […]`, with its `exclude = […]`), which Bazel requires for a build script to see a file and which Cargo's `rerun-if-changed` matches. The record keeps each glob's patterns and lists the files in that directory they match, gitignored or not, as Bazel gives them to the build script: `*` and `?` within one path segment (a leading dot included), `**` across segments, `exclude` honoured; links are entries, never followed. It keeps the modification times of the directory and the directories below it. A start whose times differ lists that directory again, and a matched file added or removed there, gitignored or not, means other sources; a file the globs do not match (a README, a file in a subdirectory a non-recursive glob does not reach, an editor's swap file) changes nothing. A start whose times match lists nothing.
  - a `build.rs` Cargo finds by itself in a package's directory: the record notes which package directories (those with a listed `Cargo.toml`) have one, and a start where that differs means other sources.

  Any other file added after the build (an editor backup such as `lib.rs~`, a merge leftover, a new integration test, a snapshot draft) changes nothing, and a new module the addon compiles is seen through the listed file that declares it (`mod`, `include!`). A record listing a path outside the checkout is not judged.
- **Who writes the record:** `scripts/bazel-natives.ts` (Bazel builds, and the copy of a Cargo build it installs elsewhere) and `packages/natives/scripts/build-bindings.ts` (Cargo builds). The sources are read before the build begins and checked again after it: when the only listed file that changed is `Cargo.lock`, which Cargo rewrites when a manifest's dependencies changed, the record takes the lock as the build left it; when anything else changed, the record keeps the read from before the build, so an edit made during the build reads as other sources rather than current. The record names the addon file by its size and modification time, and the build first sets that time to a whole second, so a copy that keeps only whole seconds (a Docker layer `COPY`, tar) still names the same addon. It also keeps the build's settings (`build`: for Cargo the profile, features and `RUSTFLAGS`; for Bazel the labels, extra arguments and `OMP_BAZEL_RC`) to explain an addon; they are never compared. A `--source` install of prebuilt addons removes any record, since those sources are unknown.
- **What a load compares:** the record holds the digest of the files git tracked at build time (SHA-256 over each one's path and content, a link's target for a link), each untracked listed file's own SHA-256, and a fingerprint (SHA-256 over each listed file's path, size and modification time) of a tree state whose verdict is known. A listed file that is neither a regular file nor a link (a FIFO, a socket or a device, which a scanned directory may hold) is hashed by its kind alone and never opened, and a regular one is opened without following a link or waiting (`O_NOFOLLOW | O_NONBLOCK`), so neither a build nor a start blocks on one; a recorded file replaced by a FIFO reads as other sources. An untracked file (a new module not yet added, a local cargo config) counts: its bytes must match, and in the checkout that built the addon one that moved or went away means other sources. Only in another checkout of the commit, as robomp's cache and the image seed carry a record between checkouts, is a missing untracked file no difference. The record names the checkout that wrote it by a random id the first build keeps in the checkout's git directory (`<git dir>/omp-checkout-id`: a `.git` directory, also through a link to it, or the directory a `.git` file names, resolved against the checkout's real path as git resolves it): the id moves with the checkout (a `mv`, a bind mount at another path, a dev container), and a new checkout, also one made where an old one was, has none until it builds, so it is another checkout. The first build writes the id under a temporary name and links it into place, so builds that start at once in a fresh checkout read one id, and none reads the file empty. A tree with no `.git` of its own (a Docker build context, an export), and a checkout whose git directory cannot be written, are always another checkout. A start reads the record, the addon's size and time, each package's `build.rs`, each scanned directory's time, and every listed file's size and time. It reads the listed files' bytes only for a tree state it has not seen (the fingerprint, and, for a record with an untracked file, whether the judging checkout is the record's), then writes that state and its verdict back into the record (best-effort), so a tree whose files were rewritten with the same content is read once, not at every start. A checkout the start cannot write (read-only) reads the bytes at every start whose tree state differs from the one recorded.
- **The verdict:** a digest other than the build's marks the addon `stale` with `builtFromOtherSources`: the stale-addon notice names the addon and its record, and absent exports get the throwing stubs. An addon without a record, or whose record names another addon file (an addon built before records existed, or copied in, as CI's prebuilt addons are), is not judged and loads as before.
- **Limit:** a source changed without a new size or modification time (a copy that keeps both) is not seen, as git and cargo do not see it either.

## Failure diagnostics

If no candidate succeeds:

- an unsupported tag throws `Unsupported platform: <tag>`, the supported list, and issue guidance;
- a supported tag throws `Failed to load pi_natives native addon for <tag>` (including the x64 variant), followed by every candidate/preparation error and mode-specific help.

Compiled help lists expected cache paths, suggests deleting the versioned directory, and prints release-download `curl` commands. Installed-package help suggests reinstalling, the local host build (`bun --cwd=packages/natives run build`), and explicit `scripts/bazel-natives.ts <target> --dest packages/natives/native` builds.

## Lifecycle

```text
entrypoint evaluates or lazy wrapper is invoked
  -> initialize loader context
  -> extract matching embedded addons, if any
  -> otherwise stage Windows node_modules addon, if applicable
  -> require candidates in deterministic order
       -> validate release stamp outside workspace development
       -> install optional post-load runtime; record addon identity
       -> best-effort clean cache directories unused for a day
       -> return bindings
  -> no success: throw unsupported-platform or aggregated load error
```
