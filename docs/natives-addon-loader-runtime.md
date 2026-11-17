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
- `nativesDir`: `getNativesDir()` from `native/natives-dir.js` (`@oh-my-pi/pi-natives/natives-dir`), the function pi-utils' `getNativesDir()` also calls, so the grammar directory the addon loads from is the one the agent installs into. In order: `PI_NATIVES_DIR` (trimmed, `~`-expanded, and normalized; empty or relative values are ignored), `<OMP_DOWNLOAD_ROOT>/natives`, on Linux and macOS `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists, otherwise `<OMP_CONFIG_ROOT or ~/<PI_CONFIG_DIR or .omp>>/natives`. It never depends on the profile: the loader fixes the addon's grammar directory once, at load, and the profile can change later;
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

`scripts/gen-npm-packages.ts` writes `nativeAddons` into each leaf's `package.json` when it generates the package: `files[]` with each addon's `filename`, `size` and `sha256`, and `digest`, the SHA-256 over every `filename` and `sha256`, computed as the embedded manifest's is (`addonSetDigest()` in `scripts/embed-native.ts`). The loader reads it and never hashes an addon to name the directory.

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

Every build of a release carries the same version, and two builds' addons can have the same size, so neither decides whether a cached file is this build's. Each build extracts into its own `versionedDir`, named by its digest, and only ever reads files it wrote there. The loader creates `versionedDir` and rejects any manifest filename that is not a bare basename. Each manifest file that is already a regular file with the declared size is reused: the loader puts a file in this directory only by renaming a copy whose SHA-256 it checked, so the size shows the file is whole without reading it at every start. Every other file is decompressed from its zstd frame, checked against the declared size and `sha256`, and written to a temporary file that is synced to disk, renamed into place, and followed by a sync of the directory (not on Windows, which cannot open a directory; a directory sync that fails is ignored, since the file is already whole and in place). A crash therefore never leaves a file of the right size with missing bytes. Unreadable frames, corrupt frames, size mismatches, and digest mismatches are errors, and nothing is written for them. A same-size file changed in place after extraction is not detected.

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

Cache cleanup ignores read/delete failures. It considers only directories named `<major.minor.patch>` or `<major.minor.patch>-<12 hex digits>`, whatever their version, never `versionedDir`, and removes those whose mtime is more than a day old. Every start marks the directory it loads from as used: `prepareNativeVersionDir()` refreshes the mtime before extraction and at every staging start, reused copy or not. Two builds run in turn therefore keep one extracted addon each instead of extracting one at every switch, a directory a concurrent start is populating survives, and a build nobody has started for a day loses its directory and extracts again if it starts. Cleanup preserves `grammars`, prerelease and other names, and ordinary files.

## Workspace addons built from other Rust sources

A release difference is not the only way a workspace addon goes stale: an addon of this release built before the checkout's Rust sources changed carries other code under the same version. The native build therefore records the sources it compiled next to the addon, in `<addon>.sources.json`, and a workspace load compares that record with the checkout (`native/workspace-sources.js`). Compiled binaries and package installs never read it.

- **What the sources are:** the files the build that made the addon compiles, named in the record as roots. A Cargo build (`CARGO_SOURCE_ROOTS`): `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/` and `crates/`. A Bazel build (`BAZEL_SOURCE_ROOTS`): those, plus the root `BUILD.bazel`, `MODULE.bazel`, `.bazelrc`, `.bazelversion`, `.bazelignore` and `bazel/` (each crate's `BUILD.bazel` is under `crates/`). `MODULE.bazel.lock` is left out: a build rewrites it after `MODULE.bazel` changes, and it follows from `MODULE.bazel`. Below a root, `target` directories and names starting with a dot (editor swap files, `.DS_Store`; no compiled input is one) are skipped. A record naming a root outside the checkout is not judged.
- **Who writes the record:** `scripts/bazel-natives.ts` (Bazel builds, and the copy of a Cargo build it installs elsewhere) and `packages/natives/scripts/build-bindings.ts` (Cargo builds), from the sources read before the build begins, so an edit made during the build reads as other sources rather than current. The record names the addon file by its size and modification time. It also keeps the build's settings (`build`: for Cargo the profile, features and `RUSTFLAGS`; for Bazel the labels, extra arguments and `OMP_BAZEL_RC`) to explain an addon; they are never compared. A `--source` install of prebuilt addons removes any record, since those sources are unknown.
- **What a load compares:** the record holds the sources' digest (SHA-256 over each file's path, size and bytes) and a fingerprint (SHA-256 over each file's path, size and modification time) of a tree state whose digest is known. A start reads the record, the addon's size and time, and every source file's size and time. It reads the sources' bytes only for a fingerprint it has not seen, then writes that fingerprint and its digest back into the record (best-effort), so a tree whose files were rewritten with the same content is read once, not at every start.
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
