/**
 * Preloaded by every `bun test` in this repository. Each directory a test run starts in
 * names it in its own bunfig.toml, because Bun reads only the bunfig.toml of that directory.
 *
 * It marks every process a test spawns as a test child (`PI_TEST_RUNTIME=1`, which
 * `isBunTestRuntime()` in @oh-my-pi/pi-utils reads). A test file's own process is recognised
 * by its entrypoint, but a child such as an omp CLI has a production entrypoint. Unmarked, it
 * uses the auth broker and the telemetry collector that the developer's shell names, with the
 * developer's token. ci-test-ts.ts starts `bun test` with the marker already set, so every
 * child inherits it; a direct `bun test` has no such launcher, so this sets it instead.
 *
 * It also starts the process without the developer's machine: every environment name the
 * product reads that a developer's shell, terminal or omp launcher sets is removed, and omp's
 * config root (`OMP_CONFIG_ROOT`), with the agent directory and mnemopi's state in it, is an
 * empty directory of this process's own; only the version-fixed downloads stay in the
 * developer's `~/.omp` (`OMP_DOWNLOAD_ROOT`). git and jj read configuration of the root's own
 * instead of the home's (no identity, no signing). When the first `git` on PATH is a wrapper
 * (a dotfiles or version-manager shim), a directory holding only the real `git` goes first on
 * PATH. `scripts/test-env.ts` says which names, which wrappers and why.
 * A marked process does not read the home `.env` or `~/.omp/.env` either
 * (`packages/utils/src/env.ts`), which would put those names back. A test that needs one of
 * them sets its own value; a test that gives a child a home of its own and wants omp to use
 * that home's `.omp` removes `OMP_CONFIG_ROOT` and `OMP_DOWNLOAD_ROOT` from the child.
 *
 * A child takes its environment from one of three places, all filled from the environment
 * the process was started with, so the removal, the omp directories and the marker go into
 * each:
 * - The environment of the process itself (`environ`). Native code builds a child's from it:
 *   the shell `Shell.run` uses and the terminal `PtySession` opens copy it when they start.
 *   So does a Worker for a child it spawns, since a Worker never sees this realm or its
 *   `Bun.spawn`. Writing `process.env` leaves it untouched, so this calls the C library.
 * - `process.env`, which reaches the children of `node:child_process` and `Bun.$`, any call
 *   that passes `env: { ...process.env }`, and a Worker's own `process.env`.
 * - The environment Bun started with, which a `Bun.spawn` or `Bun.spawnSync` call without
 *   `env` passes, and whose PATH a `Bun.which` call without `PATH` searches; nothing can
 *   change it. For those calls in this realm the default becomes the environment this file
 *   leaves.
 * A call that builds its `env` from nothing, or that removes the marker to run a child as
 * production, still decides for itself, and must keep the developer's broker variables,
 * `OTEL_*` collector and home directory from that child.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createTestChildEnv } from "./test-env";

/**
 * Sets a variable in the environment of the process, which `process.env` does not reach, or
 * removes it when `value` is undefined. It runs before any test code, while nothing else
 * changes that environment. It throws rather than return with the environment unchanged: an
 * unmarked native child, or one that still sees the developer's names, is the leak this file
 * stops.
 */
function setProcessEnvironment(name: string, value: string | undefined): void {
	if (process.platform === "win32") {
		const kernel32 = dlopen("kernel32.dll", {
			SetEnvironmentVariableW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		});
		try {
			const wideName = Buffer.from(`${name}\0`, "utf16le");
			// A null value deletes the variable.
			const wideValue = value === undefined ? null : ptr(Buffer.from(`${value}\0`, "utf16le"));
			if (kernel32.symbols.SetEnvironmentVariableW(ptr(wideName), wideValue) !== 0) return;
		} finally {
			kernel32.close();
		}
		throw new Error(`test preload: SetEnvironmentVariableW could not change ${name}`);
	}
	// Darwin: dyld resolves libSystem from the shared cache. Linux: glibc first, then the
	// generic soname for musl-style layouts (as in pi-utils' stderr-guard.ts).
	const candidates =
		process.platform === "darwin" ? ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	for (const candidate of candidates) {
		const libc = openLibc(candidate);
		if (libc === undefined) continue;
		try {
			const cName = Buffer.from(`${name}\0`, "utf8");
			const status =
				value === undefined
					? libc.symbols.unsetenv(ptr(cName))
					: libc.symbols.setenv(ptr(cName), ptr(Buffer.from(`${value}\0`, "utf8")), 1);
			if (status === 0) return;
		} finally {
			libc.close();
		}
		throw new Error(`test preload: ${value === undefined ? "unsetenv" : "setenv"} could not change ${name}`);
	}
	throw new Error(`test preload: no C library to change ${name} in (tried ${candidates.join(", ")})`);
}

/** The C library's `setenv` and `unsetenv`, or nothing when `library` is not on this system. */
function openLibc(library: string) {
	try {
		return dlopen(library, {
			setenv: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			unsetenv: { args: [FFIType.ptr], returns: FFIType.i32 },
		});
	} catch {
		return undefined;
	}
}

// The environment every test process starts with (scripts/test-env.ts): the machine's names
// removed, omp directories and git and jj configuration of its own, the real git first on PATH,
// and the test-runtime marker. Each change goes into the C environment and `process.env`.
const testEnv = createTestChildEnv(process.env);
for (const name of Object.keys(process.env)) {
	if (name in testEnv) continue;
	setProcessEnvironment(name, undefined);
	delete process.env[name];
}
for (const [name, value] of Object.entries(testEnv)) {
	if (value === undefined || process.env[name] === value) continue;
	setProcessEnvironment(name, value);
	process.env[name] = value;
}
// Taken before any test runs: the environment Bun started with, as this file left it.
const defaultChildEnv: Record<string, string | undefined> = { ...process.env };

interface EnvOption {
	env?: Record<string, string | undefined>;
}

function withDefaultChildEnv<T extends EnvOption>(options: T): T {
	return options.env === undefined ? { ...options, env: defaultChildEnv } : options;
}

const spawn = Bun.spawn;
const spawnSync = Bun.spawnSync;
const which = Bun.which;
// One implementation cannot restate Bun's overloads, so each wrapper is cast to the type of
// the function it forwards to: it fills in an omitted `env` (or `PATH`) and passes everything
// else as is.
Object.assign(Bun, {
	spawn: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawn(command, withDefaultChildEnv(options ?? {}))
			: spawn(withDefaultChildEnv(command))) as unknown as typeof Bun.spawn,
	spawnSync: ((command: string[] | (EnvOption & { cmd: string[] }), options?: EnvOption) =>
		Array.isArray(command)
			? spawnSync(command, withDefaultChildEnv(options ?? {}))
			: spawnSync(withDefaultChildEnv(command))) as unknown as typeof Bun.spawnSync,
	which: ((command: string, options?: { PATH?: string; cwd?: string }) =>
		which(
			command,
			options?.PATH === undefined ? { ...options, PATH: defaultChildEnv.PATH } : options,
		)) as typeof Bun.which,
});
