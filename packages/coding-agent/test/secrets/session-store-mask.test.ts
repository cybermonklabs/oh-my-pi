import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectEnvSecrets } from "@oh-my-pi/pi-coding-agent/secrets";
import { SessionStoreMasker } from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MODULE_PATH = path.join(import.meta.dir, "../../src/secrets/session-store-mask.ts");
const ENV_VALUE = "alpha-bravo-charlie-1234";
const FILE_VALUE = "file-held-value-5678";
const MINUTE = 60_000;

let root: string;
let cwd: string;
let agentDir: string;
let projectYml: string;
let globalYml: string;
let clock: number;

beforeEach(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-store-masking-"));
	cwd = path.join(root, "project");
	agentDir = path.join(root, "agent");
	projectYml = path.join(cwd, ".omp", "secrets.yml");
	globalYml = path.join(agentDir, "secrets.yml");
	await fs.promises.mkdir(path.join(cwd, ".omp"), { recursive: true });
	await fs.promises.mkdir(agentDir, { recursive: true });
	clock = 1_000_000;
});

afterEach(async () => {
	await fs.promises.rm(root, { recursive: true, force: true });
});

function maskerFor(env: Record<string, string>): SessionStoreMasker {
	return new SessionStoreMasker({ env: () => env, agentDir, now: () => clock });
}

async function writeFile(name: string, content: string): Promise<string> {
	const filePath = path.join(root, name);
	await Bun.write(filePath, content);
	return filePath;
}

/** Lets the masker's "handed out in this synchronous run" flag clear. */
async function nextRun(): Promise<void> {
	await Promise.resolve();
}

describe("SessionStoreMasker sources", () => {
	it("replaces each source's value with a marker that names the source", async () => {
		const tokenFile = await writeFile("token.txt", FILE_VALUE);
		await Bun.write(
			projectYml,
			[
				"- type: plain",
				"  content: project-plain-value-90",
				"  friendlyName: build cache",
				"- type: regex",
				"  content: 'order-[0-9]{6}'",
			].join("\n"),
		);
		await Bun.write(globalYml, ["- type: plain", "  content: global-plain-value-12"].join("\n"));
		const mask = maskerFor({ SERVICE_API_KEY: ENV_VALUE, EXAMPLE_TOKEN_FILE: tokenFile }).snapshot(cwd);

		const text = [ENV_VALUE, FILE_VALUE, "project-plain-value-90", "order-123456", "global-plain-value-12"].join(" ");
		expect(mask.maskText(text)).toBe(
			[
				"[REDACTED:env:SERVICE_API_KEY]",
				"[REDACTED:file:EXAMPLE_TOKEN_FILE]",
				"[REDACTED:secrets.yml:BUILDCACHE]",
				"[REDACTED:secrets.yml:project#2]",
				"[REDACTED:secrets.yml:global#1]",
			].join(" "),
		);
	});

	it("holds a secret-named variable only at 8 characters or more", () => {
		const belowFloor = "abcdefg";
		const atFloor = "abcdefgh";
		const mask = maskerFor({ SERVICE_API_KEY: belowFloor, EXAMPLE_API_KEY: atFloor }).snapshot(cwd);
		expect(mask.maskText("abcdefg abcdefgh")).toBe("abcdefg [REDACTED:env:EXAMPLE_API_KEY]");
	});

	it("leaves out git config keys and the askpass helper, in the masker and in collectEnvSecrets", () => {
		const gitKey = "http.extraheader";
		const askpass = "/usr/local/bin/askpass-helper";
		const urlPart = "key-url-pass-word-55";
		const env = {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: gitKey,
			GIT_CONFIG_KEY_1: "postgres" + "://app:" + urlPart + "@db.invalid/x",
			SSH_ASKPASS: askpass,
			EXAMPLE_API_KEY: ENV_VALUE,
		};
		const mask = maskerFor(env).snapshot(cwd);
		const text = `${gitKey} ${askpass} ${urlPart}`;
		expect(mask.maskText(text)).toBe(text);
		expect(mask.sources).toEqual([{ kind: "env", name: "EXAMPLE_API_KEY" }]);

		const saved = Object.keys(env).map(name => [name, process.env[name]] as const);
		try {
			Object.assign(process.env, env);
			// Booleans only: the collected set also holds this machine's real secrets.
			const collected = new Set(collectEnvSecrets().map(entry => entry.content));
			expect(collected.has(gitKey)).toBe(false);
			expect(collected.has(askpass)).toBe(false);
			expect(collected.has(urlPart)).toBe(false);
			expect(collected.has(ENV_VALUE)).toBe(true);
		} finally {
			for (const [name, value] of saved) restoreEnvValue(name, value);
		}
	});

	it("masks a _FILE value whose file ends in a newline", async () => {
		const tokenFile = await writeFile("token.txt", `${FILE_VALUE}\n`);
		const mask = maskerFor({ EXAMPLE_TOKEN_FILE: tokenFile }).snapshot(cwd);
		expect(mask.maskText(`auth ${FILE_VALUE} done`)).toBe("auth [REDACTED:file:EXAMPLE_TOKEN_FILE] done");
	});

	it("follows a symbolic link to the _FILE target", async () => {
		const target = await writeFile("target.txt", FILE_VALUE);
		const link = path.join(root, "link.txt");
		fs.symlinkSync(target, link);
		const mask = maskerFor({ EXAMPLE_TOKEN_FILE: link }).snapshot(cwd);
		expect(mask.maskText(FILE_VALUE)).toBe("[REDACTED:file:EXAMPLE_TOKEN_FILE]");
	});

	it("skips a directory, a file over 1 MiB and a short file, and still reads the other files", async () => {
		const directory = path.join(root, "directory");
		await fs.promises.mkdir(directory);
		const env = {
			DIRECTORY_FILE: directory,
			OVERSIZED_FILE: await writeFile("oversized.txt", "b".repeat(1024 * 1024 + 1)),
			SHORT_FILE: await writeFile("short.txt", "short\n"),
			SERVICE_FILE: await writeFile("service.txt", FILE_VALUE),
		};
		expect(maskerFor(env).snapshot(cwd).sources).toEqual([{ kind: "file", name: "SERVICE_FILE" }]);
	});

	it.skipIf(process.getuid?.() === 0)("skips an unreadable file and still reads the other files", async () => {
		const locked = await writeFile("locked.txt", "locked-file-value-31");
		fs.chmodSync(locked, 0o000);
		const env = { LOCKED_FILE: locked, SERVICE_FILE: await writeFile("service.txt", FILE_VALUE) };
		const mask = maskerFor(env).snapshot(cwd);
		expect(mask.sources).toEqual([{ kind: "file", name: "SERVICE_FILE" }]);
		expect(mask.maskText("locked-file-value-31")).toBe("locked-file-value-31");
	});

	// A FIFO with no writer blocks a plain open in the kernel, where no timer in
	// this process can reach it, so the probe runs in a child the spawn timeout
	// kills: a regression fails here instead of hanging the suite.
	it.skipIf(process.platform === "win32")(
		"skips a FIFO without blocking",
		async () => {
			const fifo = path.join(root, "pipe");
			expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
			const serviceFile = await writeFile("service.txt", FILE_VALUE);
			const probe = await writeFile(
				"probe.ts",
				[
					`import { SessionStoreMasker } from ${JSON.stringify(MODULE_PATH)};`,
					"const [fifo, serviceFile, dir] = process.argv.slice(2);",
					"const env = { PIPE_FILE: fifo, SERVICE_FILE: serviceFile };",
					"const masker = new SessionStoreMasker({ env: () => env, agentDir: dir });",
					"process.stdout.write(JSON.stringify(masker.snapshot(dir).sources));",
				].join("\n"),
			);
			const child = Bun.spawn([process.execPath, probe, fifo, serviceFile, root], {
				stdout: "pipe",
				stderr: "ignore",
				env: { ...process.env, PI_TEST_RUNTIME: "1", PI_CODING_AGENT_DIR: agentDir },
				timeout: 15_000,
				killSignal: "SIGKILL",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toEqual([{ kind: "file", name: "SERVICE_FILE" }]);
		},
		20_000,
	);

	it("masks the password of a connection URL inside a _FILE's content", async () => {
		const inFile = "pass-word-in-file-42";
		const dsnFile = await writeFile("dsn.txt", `# primary\n${"postgres" + "://app:" + inFile + "@db.invalid/x"}\n`);
		const mask = maskerFor({ SERVICE_DSN_FILE: dsnFile }).snapshot(cwd);
		expect(mask.maskText(`retrying with ${inFile}`)).toBe("retrying with [REDACTED:file:SERVICE_DSN_FILE]");
	});
});

describe("SessionStoreMasker refresh", () => {
	it("keeps masking a rotated file's old value once the refresh reads the new one", async () => {
		const tokenFile = await writeFile("token.txt", "first-file-value-1111");
		const masker = maskerFor({ EXAMPLE_TOKEN_FILE: tokenFile });
		masker.snapshot(cwd);
		await Bun.write(tokenFile, "second-file-value-22222");
		await nextRun();
		clock += MINUTE;
		expect(masker.snapshot(cwd).maskText("first-file-value-1111 second-file-value-22222")).toBe(
			"[REDACTED:file:EXAMPLE_TOKEN_FILE] [REDACTED:file:EXAMPLE_TOKEN_FILE]",
		);
	});

	it.skipIf(process.getuid?.() === 0)(
		"reads a secrets.yml again at the next refresh once a permission fix makes it readable",
		async () => {
			const value = "project-plain-value-90";
			await Bun.write(projectYml, ["- type: plain", `  content: ${value}`].join("\n"));
			fs.chmodSync(projectYml, 0o000);
			const masker = maskerFor({});
			expect(masker.snapshot(cwd).maskText(value)).toBe(value);
			// The ctime moves in clock ticks: repeat the fix until it shows there, as a later fix would.
			const lockedCtime = fs.statSync(projectYml, { bigint: true }).ctimeNs;
			do {
				fs.chmodSync(projectYml, 0o600);
			} while (fs.statSync(projectYml, { bigint: true }).ctimeNs === lockedCtime);
			await nextRun();
			clock += MINUTE;
			expect(masker.snapshot(cwd).maskText(value)).toBe("[REDACTED:secrets.yml:project#1]");
		},
	);

	it("picks up a variable set after the build at the first refresh a minute later, outside the current run", async () => {
		const late = "late-secret-value-333";
		const env: Record<string, string> = {};
		const masker = maskerFor(env);
		masker.snapshot(cwd);
		env.SERVICE_API_KEY = late;
		await nextRun();

		clock += MINUTE - 1;
		expect(masker.snapshot(cwd).maskText(late)).toBe(late);
		// Same synchronous run as the call above: no refresh even though the minute has passed.
		clock += 1;
		expect(masker.snapshot(cwd).maskText(late)).toBe(late);

		await nextRun();
		expect(masker.snapshot(cwd).maskText(late)).toBe("[REDACTED:env:SERVICE_API_KEY]");
	});
});

describe("SessionStoreMask matching", () => {
	it("masks a value that contains another whole, with the longer value's marker", async () => {
		const inner = "inner-pass-word-77";
		const url = "postgres" + "://app:" + inner + "@db.invalid/x";
		await Bun.write(projectYml, ["- type: plain", `  content: '${url}'`, "  friendlyName: primary dsn"].join("\n"));
		const mask = maskerFor({ SERVICE_DSN: url }).snapshot(cwd);
		expect(mask.maskText(`dsn=${url} pw=${inner}`)).toBe(
			"dsn=[REDACTED:secrets.yml:PRIMARYDSN] pw=[REDACTED:env:SERVICE_DSN]",
		);
	});

	it("is idempotent with a broad secrets.yml regex over text that holds markers and values", async () => {
		await Bun.write(projectYml, ["- type: regex", "  content: '[A-Za-z0-9_]{8,}'"].join("\n"));
		const mask = maskerFor({ SERVICE_API_KEY: ENV_VALUE }).snapshot(cwd);
		// The regex matches "REDACTED" and the variable name, yet exact markers stay as they are.
		expect(mask.maskText(`[REDACTED:env:#1] identifier_long ${ENV_VALUE}`)).toBe(
			"[REDACTED:env:#1] [REDACTED:secrets.yml:project#1] [REDACTED:env:#1]",
		);
		const inputs = [
			`key ${ENV_VALUE} and identifier_long_word`,
			"[REDACTED:env:#1] then longidentifier [REDACTED:secrets.yml:project#1]",
			`[REDACTED:${ENV_VALUE}] [REDACTED:env:SERVICE_API_KEY]`,
			"nested [REDACTED:secrets.yml:[REDACTED:env:#1]] tail_identifier",
		];
		for (const input of inputs) {
			const once = mask.maskText(input);
			expect(once).not.toContain(ENV_VALUE);
			expect(mask.maskText(once)).toBe(once);
		}
	});

	it("masks a value inside text shaped like a marker", () => {
		const mask = maskerFor({ SERVICE_API_KEY: ENV_VALUE }).snapshot(cwd);
		expect(mask.maskText(`[REDACTED:${ENV_VALUE}]`)).toBe("[REDACTED:[REDACTED:env:SERVICE_API_KEY]]");
	});

	it("labels a source by its index when its name would show a held value", async () => {
		await Bun.write(
			projectYml,
			[
				"- type: plain",
				"  content: PLUTOVALUE42",
				"  friendlyName: plutovalue42",
				"- type: plain",
				"  mode: replace",
				"  content: API",
			].join("\n"),
		);
		const mask = maskerFor({ SERVICE_API_KEY: ENV_VALUE }).snapshot(cwd);
		expect(mask.maskText(`PLUTOVALUE42 ${ENV_VALUE}`)).toBe("[REDACTED:secrets.yml:project#1] [REDACTED:env:#1]");
		expect(mask.sources).toEqual([
			{ kind: "env", name: "#1" },
			{ kind: "secrets.yml", name: "project#1" },
			{ kind: "secrets.yml", name: "project#2" },
		]);
	});

	it("skips a secrets.yml that is not an array and an invalid entry while the other sources still mask", async () => {
		await Bun.write(projectYml, "content: not-a-list-value-1\n");
		await Bun.write(
			globalYml,
			[
				"- type: other",
				"  content: invalid-entry-value-2",
				"- type: plain",
				"  content: global-plain-value-12",
			].join("\n"),
		);
		const mask = maskerFor({ SERVICE_API_KEY: ENV_VALUE }).snapshot(cwd);
		expect(mask.maskText(`not-a-list-value-1 invalid-entry-value-2 global-plain-value-12 ${ENV_VALUE}`)).toBe(
			"not-a-list-value-1 invalid-entry-value-2 [REDACTED:secrets.yml:global#2] [REDACTED:env:SERVICE_API_KEY]",
		);
	});
});
