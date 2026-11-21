import { describe, expect, it, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProductionChildEnv, hardLinkOrCopy, isDeveloperEnvName } from "../../../scripts/test-env";

const win32 = process.platform === "win32";

/** A value that a `.cmd` launcher could not pass: Bun refuses `"` and `%` in a batch file's arguments. */
const AWKWARD = 'a"%b';

/** Each case that starts a `bun test` child gets this long: the child loads the helper and runs two tests. */
const CHILD_TIMEOUT_MS = 60_000;

describe("createProductionChildEnv", () => {
	it("drops the names that point a child at the developer's configuration, and gives it an empty home", () => {
		const dropped = {
			PI_CODING_AGENT_DIR: "/dev/agent",
			OMP_PROFILE: "work",
			MNEMOPI_DATA_DIR: "/dev/mnemopi",
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
			XDG_CONFIG_HOME: "/dev/xdg",
			CLAUDE_CONFIG_DIR: "/dev/claude",
			AWS_PROFILE: "dev",
			AWS_CONFIG_FILE: "/dev/.aws/config",
			AWS_SHARED_CREDENTIALS_FILE: "/dev/.aws/credentials",
			GOOGLE_APPLICATION_CREDENTIALS: "/dev/gcp.json",
		};
		const env = createProductionChildEnv({ ...dropped, KEEP_ME: "kept", HOME: "/dev/home", PATH: "" });
		expect(env.KEEP_ME).toBe("kept");
		for (const name of Object.keys(dropped)) expect(env[name]).toBeUndefined();
		expect(env.HOME).not.toBe("/dev/home");
		// On Windows the home holds the APPDATA and LOCALAPPDATA directories, and nothing else.
		expect(fs.readdirSync(env.HOME)).toEqual(win32 ? ["AppData"] : []);
	});

	it("compares names without case on Windows, and with case elsewhere", () => {
		expect(isDeveloperEnvName("pi_coding_agent_dir", "win32")).toBe(true);
		expect(isDeveloperEnvName("Aws_Profile", "win32")).toBe(true);
		expect(isDeveloperEnvName("PI_CODING_AGENT_DIR", "linux")).toBe(true);
		expect(isDeveloperEnvName("pi_coding_agent_dir", "linux")).toBe(false);
		expect(isDeveloperEnvName("KEEP_ME", "win32")).toBe(false);
	});

	test.skipIf(!win32)("drops a lower-case name, and keeps one home, on Windows", () => {
		const env = createProductionChildEnv({
			PATH: "",
			pi_coding_agent_dir: "C:\\dev\\agent",
			UserProfile: "C:\\dev",
			appdata: "C:\\dev\\AppData\\Roaming",
			LocalAppData: "C:\\dev\\AppData\\Local",
		});
		const names = Object.keys(env).map(name => name.toUpperCase());
		expect(names).not.toContain("PI_CODING_AGENT_DIR");
		for (const name of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
			expect(names.filter(each => each === name)).toEqual([name]);
		}
		expect(env.USERPROFILE).toBe(env.HOME);
		expect(env.APPDATA).toBe(path.join(env.HOME, "AppData", "Roaming"));
		expect(env.LOCALAPPDATA).toBe(path.join(env.HOME, "AppData", "Local"));
		expect(fs.existsSync(env.APPDATA)).toBe(true);
		expect(fs.existsSync(env.LOCALAPPDATA)).toBe(true);
	});

	let home: string | undefined;
	it("makes the home inside a test", () => {
		home = createProductionChildEnv({ PATH: "" }).HOME;
		expect(fs.existsSync(home)).toBe(true);
	});

	it("removes that home when the test ends", () => {
		expect(home).toBeDefined();
		expect(fs.existsSync(home!)).toBe(false);
	});

	it("removes the home of a process outside the test runner when it exits", async () => {
		const helper = path.join(import.meta.dir, "..", "..", "..", "scripts", "test-env.ts");
		const script = `import { createProductionChildEnv } from ${JSON.stringify(helper)}; process.stdout.write(createProductionChildEnv({ PATH: "" }).HOME);`;
		const proc = Bun.spawn([process.execPath, "-e", script], { env: process.env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).not.toBe("");
		expect(fs.existsSync(stdout)).toBe(false);
	});
});

describe("createProductionChildEnv in concurrent tests", () => {
	const helper = path.join(import.meta.dir, "..", "..", "..", "scripts", "test-env.ts");

	/**
	 * Runs `bun test <args>` on two test files, each with two concurrent tests that make a production
	 * child's environment, and returns the directories each file's tests made, in the order the files
	 * ran. Each test makes a home and a directory for `bun` (an empty PATH has none).
	 */
	async function run(args: string[]): Promise<{ file: string; dirs: string[] }[]> {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-concurrent-"));
		try {
			const files = ["first", "second"].map(name => path.join(root, `${name}.ts`));
			for (const file of files) {
				fs.writeFileSync(
					file,
					`import { test } from "bun:test";
import * as path from "node:path";
import { createProductionChildEnv } from ${JSON.stringify(helper)};
for (const n of [1, 2]) {
	test.concurrent("makes a production child's environment " + n, () => {
		const env = createProductionChildEnv({ PATH: "" });
		console.log("DIRS " + JSON.stringify({ file: ${JSON.stringify(path.basename(file))}, dirs: [env.HOME, env.PATH.split(path.delimiter)[0]] }));
	});
}
`,
				);
			}
			const proc = Bun.spawn([process.execPath, "test", ...args, ...files], {
				cwd: path.join(import.meta.dir, ".."),
				env: process.env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const byFile = new Map<string, string[]>();
			for (const line of `${stdout}${stderr}`.split("\n")) {
				if (!line.startsWith("DIRS ")) continue;
				const { file, dirs } = JSON.parse(line.slice("DIRS ".length)) as { file: string; dirs: string[] };
				byFile.set(file, [...(byFile.get(file) ?? []), ...dirs]);
			}
			expect(
				[...byFile.values()].map(dirs => dirs.length),
				`${stdout}${stderr}`,
			).toEqual([4, 4]);
			return [...byFile].map(([file, dirs]) => ({ file, dirs }));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	const left = (dirs: string[]) => dirs.filter(dir => fs.existsSync(dir));

	// Bun refuses every hook in a concurrent test, and runs no `exit` handler of a `bun test`
	// process: the test file's own hook removes these directories, so each run is a `bun test` child
	// whose directories are checked after it ends.
	for (const args of [["--isolate"], ["--parallel"]]) {
		it(
			`removes the directories of every file when it ends, as bun test ${args.join(" ")} loads the helper for each file`,
			async () => {
				for (const { dirs } of await run(args)) expect(left(dirs)).toEqual([]);
			},
			CHILD_TIMEOUT_MS,
		);
	}

	it(
		"removes only the first file's directories in a plain bun test, which shares the helper between files",
		async () => {
			const [first, second] = await run([]);
			try {
				expect(left(first.dirs)).toEqual([]);
				expect(left(second.dirs)).toEqual(second.dirs);
			} finally {
				for (const dir of second.dirs) fs.rmSync(dir, { recursive: true, force: true });
			}
		},
		CHILD_TIMEOUT_MS,
	);
});

describe("hardLinkOrCopy", () => {
	it("copies the file when the hard link fails, whatever the reason", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-link-"));
		try {
			const file = path.join(dir, "tool");
			fs.writeFileSync(file, "the tool");
			// EXDEV: another volume. EPERM: a FAT volume, or a file the user cannot write (a bun.exe
			// installed for every user). EACCES: a directory the user cannot list.
			for (const code of ["EXDEV", "EPERM", "EACCES"]) {
				const target = path.join(dir, `link-${code}`);
				hardLinkOrCopy(file, target, () => {
					throw Object.assign(new Error(`link refused: ${code}`), { code });
				});
				expect(fs.readFileSync(target, "utf8")).toBe("the tool");
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the production child's PATH", () => {
	/**
	 * A PATH whose first `bun`, `node` and `git` are shims that fail ("No version is set for shim"),
	 * as a version manager's shims do in a new home, followed by the real tools.
	 */
	function shimsFirst(): { root: string; searchPath: string; real: Record<string, string> } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-utils-shims-"));
		const shims = path.join(root, "shims");
		fs.mkdirSync(shims);
		const real: Record<string, string> = {};
		let rest = process.env.PATH ?? "";
		if (win32) {
			for (const tool of ["bun", "node", "git"]) {
				fs.writeFileSync(
					path.join(shims, `${tool}.cmd`),
					"@echo No version is set for shim 1>&2\r\n@exit /b 1\r\n",
				);
			}
			for (const tool of ["node", "git"]) {
				const found = Bun.which(tool, { PATH: rest });
				if (found) real[tool] = found;
			}
		} else {
			const bin = path.join(root, "real");
			fs.mkdirSync(bin);
			for (const tool of ["bun", "node", "git"]) {
				const shim = path.join(shims, tool);
				fs.writeFileSync(shim, '#!/bin/sh\necho "No version is set for shim: $0" >&2\nexit 1\n');
				fs.chmodSync(shim, 0o755);
			}
			for (const tool of ["node", "git"]) {
				const file = path.join(bin, tool);
				fs.writeFileSync(file, `#!/bin/sh\nprintf '%s' "$1"\n`);
				fs.chmodSync(file, 0o755);
				real[tool] = file;
			}
			rest = bin;
		}
		return { root, searchPath: [shims, rest].join(path.delimiter), real };
	}

	/** `env` with `searchPath` as its PATH, whatever case `env` spells PATH in. */
	function withPath(env: Record<string, string | undefined>, searchPath: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [name, value] of Object.entries(env)) {
			if (value !== undefined && name.toUpperCase() !== "PATH") out[name] = value;
		}
		out.PATH = searchPath;
		return out;
	}

	/** What `tool`, found by name on `env`'s PATH, prints for {@link AWKWARD}, or why it could not start. */
	function run(tool: string, env: Record<string, string>): { stdout: string; exitCode: number | null } {
		const searchPath = env[Object.keys(env).find(name => name.toUpperCase() === "PATH") ?? "PATH"] ?? "";
		const file = Bun.which(tool, { PATH: searchPath });
		if (file === null) throw new Error(`no ${tool} on ${searchPath}`);
		const args: Record<string, string[]> = {
			bun: ["-e", "process.stdout.write(process.argv.at(-1))", AWKWARD],
			node: win32 ? ["-e", "process.stdout.write(process.argv.at(-1))", AWKWARD] : [AWKWARD],
			git: win32 ? ["-c", `x.y=${AWKWARD}`, "config", "--get", "x.y"] : [AWKWARD],
		};
		try {
			const child = Bun.spawnSync([file, ...args[tool]], { env, stdout: "pipe", stderr: "pipe" });
			return { stdout: child.stdout.toString().trim(), exitCode: child.exitCode };
		} catch (error) {
			// Bun refuses a `"` or `%` in a batch file's arguments: "contains a cmd.exe special character".
			return { stdout: String(error), exitCode: null };
		}
	}

	for (const tool of ["bun", "node", "git"]) {
		it(`runs this bun or the real ${tool} past a failing shim, with "${AWKWARD}" as an argument`, () => {
			const { root, searchPath, real } = shimsFirst();
			try {
				if (tool !== "bun" && real[tool] === undefined) return;
				const base = withPath(process.env, searchPath);
				// Control: by name on that PATH, the shim runs and fails.
				expect(run(tool, base).exitCode).not.toBe(0);
				expect(run(tool, createProductionChildEnv(base))).toEqual({ stdout: AWKWARD, exitCode: 0 });
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
