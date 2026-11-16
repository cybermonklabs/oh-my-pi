import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectEnvSecrets } from "@oh-my-pi/pi-coding-agent/secrets";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import * as storeMatcher from "@oh-my-pi/pi-coding-agent/secrets/session-store-matcher";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { failNextReads, plainYml, sourceReadWarnings, YML_MARKER } from "../helpers/masker-sources";
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
	vi.restoreAllMocks();
	await fs.promises.rm(root, { recursive: true, force: true });
});

function maskerFor(env: Record<string, string>): storeMask.SessionStoreMasker {
	return new storeMask.SessionStoreMasker({ env: () => env, agentDir, now: () => clock });
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

const ENV_MARKER = "[REDACTED:env:SERVICE_API_KEY]";
const FILE_MARKER = "[REDACTED:file:EXAMPLE_TOKEN_FILE]";
const NOW = 1_700_000_000_000;

/** `text` as JSON text holds it. */
function jsonEscaped(text: string): string {
	return JSON.stringify(text).slice(1, -1);
}

/**
 * `chars` characters of JSON lines about `word`. Its quotes, spaces and line ends each take several
 * pattern characters once escaped, so a pattern that held it whole would pass the 1,048,576
 * characters the engine accepts long before the text passes the 1 MiB a `_FILE` may hold.
 */
function jsonLines(chars: number, word: string): string {
	const lines: string[] = [];
	for (let row = 0, length = 0; length < chars; row++) {
		const line = JSON.stringify({ row, note: `${word} lantern orchard`, places: ["meadow", "harbor"] });
		lines.push(line);
		length += line.length + 1;
	}
	const text = lines.join("\n").slice(0, chars);
	// A `_FILE` value is trimmed: it must not end in white space.
	return /\s$/.test(text) ? `${text.slice(0, -1)}x` : text;
}

interface MaskedSession {
	manager: SessionManager;
	/** The persistence errors the session reported. */
	errors: Error[];
}

/**
 * A file-backed session in `cwd` whose writes take their mask from `masker`, as the manager of a
 * session with the setting on takes it from the process masker.
 */
async function sessionMaskedBy(masker: storeMask.SessionStoreMasker): Promise<MaskedSession> {
	spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(masker);
	const manager = SessionManager.create(cwd, path.join(root, "sessions"), new FileSessionStorage());
	manager.setStoreMasking({ enabled: () => true, agentDir });
	const errors: Error[] = [];
	manager.onPersistenceError(error => errors.push(error));
	await manager.ensureOnDisk();
	return { manager, errors };
}

/** The content of each message the session file of `manager` holds, in file order. */
async function storedContents(manager: SessionManager): Promise<string[]> {
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	const contents: string[] = [];
	for (const record of Bun.JSONL.parse(await Bun.file(file).text())) {
		if (isRecord(record) && isRecord(record.message) && typeof record.message.content === "string") {
			contents.push(record.message.content);
		}
	}
	return contents;
}

/** The details of each call of `spy`, a spy on a `logger` method, whose message is `message`. */
function loggedDetails(spy: { mock: { calls: unknown[][] } }, message: string): unknown[] {
	return spy.mock.calls.filter(call => call[0] === message).map(call => call[1]);
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
		await Bun.write(globalYml, plainYml("global-plain-value-12"));
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
			await Bun.write(projectYml, plainYml(value));
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

	it("masks a multi-line _FILE value as written and inside JSON text, where it is escaped", async () => {
		const value = 'first line of the "held" file\nsecond line of the held file';
		const escaped = JSON.stringify(value).slice(1, -1);
		const marker = "[REDACTED:file:EXAMPLE_KEY_FILE]";
		const mask = maskerFor({ EXAMPLE_KEY_FILE: await writeFile("key.txt", `${value}\n`) }).snapshot(cwd);
		expect(mask.maskText(`key: ${value}.`)).toBe(`key: ${marker}.`);

		const json = mask.maskText(JSON.stringify({ report: `deploy with ${value}`, lines: [value] }, null, 2));
		expect(JSON.parse(json)).toEqual({ report: `deploy with ${marker}`, lines: [marker] });
		expect([json.includes(value), json.includes(escaped)]).toEqual([false, false]);
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

describe("K22: a held value set past the pattern size the engine accepts", () => {
	/**
	 * Whether `text` becomes `expected` when `masker` masks it and when a session write under file
	 * storage stores it, and how many errors that session reported. Booleans and a count, so a
	 * failure prints no value.
	 */
	async function maskedAs(
		masker: storeMask.SessionStoreMasker,
		text: string,
		expected: string,
	): Promise<{ direct: boolean; stored: boolean; errors: number }> {
		const direct = masker.snapshot(cwd).maskText(text) === expected;
		const { manager, errors } = await sessionMaskedBy(masker);
		manager.appendMessage({ role: "user", content: text, timestamp: NOW });
		const contents = await storedContents(manager);
		await manager.close();
		return { direct, stored: contents.length === 1 && contents[0] === expected, errors: errors.length };
	}

	it("K22 (a): masks a _FILE value of 700,000 characters and an env value, as written and as JSON text holds them", async () => {
		const fileValue = jsonLines(700_000, "alpha");
		const masker = maskerFor({
			EXAMPLE_TOKEN_FILE: await writeFile("large.txt", fileValue),
			SERVICE_API_KEY: ENV_VALUE,
		});
		const text = [fileValue, jsonEscaped(fileValue), ENV_VALUE].join("\n");
		const expected = [FILE_MARKER, FILE_MARKER, ENV_MARKER].join("\n");
		expect(await maskedAs(masker, text, expected)).toEqual({ direct: true, stored: true, errors: 0 });
	}, 60_000);

	it("K22 (b): masks each of 4,000 env values of 300 characters, as written and as JSON text holds them", async () => {
		const env: Record<string, string> = {};
		const values: string[] = [];
		const markers: string[] = [];
		for (let n = 0; n < 4_000; n++) {
			const value = `${`"row ${n}" ${"meadow harbor lantern orchard ".repeat(10)}`.slice(0, 299)}.`;
			env[`SERVICE_${n}_TOKEN`] = value;
			values.push(value);
			markers.push(`[REDACTED:env:SERVICE_${n}_TOKEN]`);
		}
		const text = [...values, ...values.map(jsonEscaped)].join("\n");
		const expected = [...markers, ...markers].join("\n");
		expect(await maskedAs(maskerFor(env), text, expected)).toEqual({ direct: true, stored: true, errors: 0 });
	}, 60_000);

	it("K22 (c): masks a _FILE value that grows past that size at the next refresh, and the value it held before", async () => {
		const before = "first-file-value-1111";
		const tokenFile = await writeFile("growing.txt", before);
		const masker = maskerFor({ EXAMPLE_TOKEN_FILE: tokenFile });
		expect(masker.snapshot(cwd).maskText(before)).toBe(FILE_MARKER);

		const grown = jsonLines(700_000, "bravo");
		await Bun.write(tokenFile, grown);
		await nextRun();
		clock += MINUTE;
		const text = [before, grown, jsonEscaped(grown)].join("\n");
		const expected = [FILE_MARKER, FILE_MARKER, FILE_MARKER].join("\n");
		expect(await maskedAs(masker, text, expected)).toEqual({ direct: true, stored: true, errors: 0 });
	}, 60_000);
});

describe("K23: a refresh whose read of a source fails", () => {
	it("K23: keeps masking what it holds, logs the source and the cause, and reads the source again at the next refresh", async () => {
		const [ymlBefore, ymlAfter] = ["yml-held-value-A1", "yml-held-value-A2"];
		const [fileBefore, fileAfter] = ["file-held-value-B1", "file-held-value-B2"];
		const tokenFile = await writeFile("rotating.txt", fileBefore);
		await Bun.write(projectYml, plainYml(ymlBefore));
		const masker = maskerFor({ EXAMPLE_TOKEN_FILE: tokenFile });
		const text = [ymlBefore, fileBefore, ymlAfter, fileAfter].join(" ");
		const beforeRotation = [YML_MARKER, FILE_MARKER, ymlAfter, fileAfter].join(" ");
		expect(masker.snapshot(cwd).maskText(text)).toBe(beforeRotation);

		// Both rotate, and the next read of each fails in a way that leaves the file's stat as it is.
		await Bun.write(projectYml, plainYml(ymlAfter));
		await Bun.write(tokenFile, fileAfter);
		const pending = failNextReads([projectYml, tokenFile]);
		const warnings = sourceReadWarnings();
		await nextRun();
		clock += MINUTE;
		// The write goes on under what the masker held.
		expect(masker.snapshot(cwd).maskText(text)).toBe(beforeRotation);
		expect(pending.size).toBe(0);

		// Neither file has changed since the rotation: each is read again because its read had failed.
		await nextRun();
		clock += MINUTE;
		expect(masker.snapshot(cwd).maskText(text)).toBe([YML_MARKER, FILE_MARKER, YML_MARKER, FILE_MARKER].join(" "));
		expect(warnings()).toEqual([
			{ kind: "file", source: "EXAMPLE_TOKEN_FILE", cause: "EIO" },
			{ kind: "secrets.yml", source: projectYml, cause: "EIO" },
		]);
	});
});

describe("K24: matches that overlap", () => {
	const LEFT = "left-part-AAAA";
	const RIGHT = "AAAA-right-part";
	const INSIDE = "synthpart-0001";
	const LEAD = "lead-value-ord-12";
	const TAIL = "3456-tail-value";
	const HELD = "held-x-value-01";
	const HELD_MARKER = "[REDACTED:env:X_TOKEN]";
	const WRAPPED = `wrap ${HELD_MARKER} wrap`;
	const EDGE = "X_TOKEN]-edge-value";
	const SHORT = "prefix-value-01";
	const LONG = `${SHORT}-and-a-longer-tail-of-the-value-99`;
	const REPEATING = "xyzw-xyzw";
	const CASES: readonly {
		readonly name: string;
		readonly env: Record<string, string>;
		readonly regex?: string;
		readonly text: string;
		readonly masked: string;
	}[] = [
		{
			name: "(a) two env values, the second starting inside the first",
			env: { A_TOKEN: LEFT, B_TOKEN: RIGHT },
			text: `x ${LEFT}${RIGHT.slice(4)} y`,
			masked: "x [REDACTED:env:A_TOKEN] y",
		},
		{
			name: "(b) a regex match that holds an env value",
			env: { SERVICE_API_KEY: INSIDE },
			regex: "acct-[a-z0-9-]{20,}",
			text: `id acct-aaaa-${INSIDE}-zzzz-tail-9999 end`,
			masked: `id ${YML_MARKER} end`,
		},
		{
			name: "(c) a regex match with an env value across each of its ends",
			env: { A_TOKEN: LEAD, B_TOKEN: TAIL },
			regex: "ord-[0-9]{6}",
			text: `see ${LEAD}${TAIL} now`,
			masked: "see [REDACTED:env:A_TOKEN] now",
		},
		{
			name: "(d) an env value that holds another value's marker",
			env: { X_TOKEN: HELD, WRAP_TOKEN: WRAPPED },
			text: `see ${WRAPPED} end, then ${HELD} and ${HELD_MARKER}`,
			masked: `see [REDACTED:env:WRAP_TOKEN] end, then ${HELD_MARKER} and ${HELD_MARKER}`,
		},
		{
			name: "(e) an env value that starts inside another value's marker: the marker is taken whole, not cut",
			env: { X_TOKEN: HELD, EDGE_TOKEN: EDGE },
			text: `see ${HELD_MARKER}-edge-value end`,
			masked: "see [REDACTED:env:EDGE_TOKEN] end",
		},
		{
			name: "(f) a short value that starts where a longer value's start occurs, though the longer value does not",
			env: { A_TOKEN: SHORT, B_TOKEN: LONG },
			text: `see ${SHORT}-and-a-longer-tail-of-the-XXXX end`,
			masked: "see [REDACTED:env:A_TOKEN]-and-a-longer-tail-of-the-XXXX end",
		},
		{
			name: "(g) a value that occurs twice, the second starting inside the first",
			env: { X_TOKEN: REPEATING },
			text: `a ${REPEATING}-xyzw b`,
			masked: "a [REDACTED:env:X_TOKEN] b",
		},
	];

	it("K24: replaces each run of overlapping or touching matches with one marker, that of the match that starts first", async () => {
		for (const { name, env, regex, text, masked } of CASES) {
			if (regex) await Bun.write(projectYml, ["- type: regex", `  content: '${regex}'`].join("\n"));
			else await fs.promises.rm(projectYml, { force: true });
			const mask = maskerFor(env).snapshot(cwd);
			const once = mask.maskText(text);
			// The name rides along so a failure says which case; no fragment of a value is left, no marker is nested.
			expect([name, once]).toEqual([name, masked]);
			expect([name, mask.maskText(once)]).toEqual([name, once]);
		}
	});
});

describe("K25: a FIFO whose writer waits in its own open", () => {
	const word = "fifo-carried-value-64";
	const secretsFileModule = path.join(import.meta.dir, "../../src/secrets/secrets-file.ts");

	/** What a child runs while the writer waits: its code, its arguments, and what its stdout must parse to. */
	interface Probe {
		lines: readonly string[];
		args: readonly string[];
		output: unknown;
	}

	/**
	 * A child that builds a masker of `env` and `agentDir`, masks for `cwd` and refreshes once a
	 * minute later; each round must end within a second holding no source.
	 */
	function maskerProbe(masker: { env: Record<string, string>; agentDir: string; cwd: string }): Probe {
		const round = { withinASecond: true, sources: 0, kept: true };
		return {
			lines: [
				`import { SessionStoreMasker } from ${JSON.stringify(MODULE_PATH)};`,
				"const [envText, agentDir, cwd, word] = process.argv.slice(2);",
				"const env = JSON.parse(envText);",
				"let now = 1_000_000;",
				"const masker = new SessionStoreMasker({ env: () => env, agentDir, now: () => now });",
				"const rounds = [];",
				"for (let round = 0; round < 2; round++) {",
				"	const started = performance.now();",
				"	const mask = masker.snapshot(cwd);",
				"	const withinASecond = performance.now() - started < 1_000;",
				"	rounds.push({ withinASecond, sources: mask.sources.length, kept: mask.maskText(word) === word });",
				"	now += 60_000;",
				"	await Promise.resolve();",
				"}",
				"process.stdout.write(JSON.stringify(rounds));",
			],
			args: [JSON.stringify(masker.env), masker.agentDir, masker.cwd, word],
			output: [round, round],
		};
	}

	/**
	 * Makes `fifo` a FIFO whose writer waits in its own open to write `content`, and while it waits
	 * runs `probe` in a child. Expects the child to print the probe's output, and the writer, still
	 * waiting after the child, to deliver `content` to the test's own open.
	 *
	 * As the FIFO case above, the probe runs in a child the spawn timeout kills, so code that blocks
	 * fails here instead of hanging the suite.
	 */
	async function expectWriterStillDelivers(fifo: string, content: string, probe: Probe): Promise<void> {
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		// Says it is about to open, then waits in its open until a reader opens the FIFO, and writes.
		// A child that opens the FIFO lets it go on: its write then finds the reader gone, or lands
		// in a pipe the child's close empties, and the test's own read below gets nothing.
		const writer = Bun.spawn(["sh", "-c", 'echo ready; exec 3>"$1" && printf %s "$2" >&3', "sh", fifo, content], {
			stdout: "pipe",
			stderr: "ignore",
			timeout: 20_000,
			killSignal: "SIGKILL",
		});
		let reader: number | undefined;
		try {
			// The writer opens right after this line; the child takes far longer to start.
			await (writer.stdout as ReadableStream<Uint8Array>).getReader().read();
			const probeFile = await writeFile("fifo-probe.ts", probe.lines.join("\n"));
			const child = Bun.spawn([process.execPath, probeFile, ...probe.args], {
				stdout: "pipe",
				stderr: "ignore",
				env: { ...process.env, PI_TEST_RUNTIME: "1", PI_CODING_AGENT_DIR: agentDir },
				timeout: 15_000,
				killSignal: "SIGKILL",
			});
			const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
			expect(exitCode).toBe(0);
			expect(JSON.parse(stdout)).toEqual(probe.output);

			// The child opened nothing, so the writer still waits.
			expect(writer.exitCode).toBeNull();
			// Non-blocking, so a writer that is gone fails the test instead of hanging it.
			reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
			expect(await writer.exited).toBe(0);
			const buffer = Buffer.alloc(256);
			const length = fs.readSync(reader, buffer, 0, buffer.length, null);
			expect(buffer.toString("utf8", 0, length)).toBe(content);
		} finally {
			if (reader !== undefined) fs.closeSync(reader);
			writer.kill("SIGKILL");
		}
	}

	it.skipIf(process.platform === "win32")(
		"K25: as a _FILE, neither blocks on the FIFO nor opens it, at the build and at a refresh, so the writer still delivers",
		async () => {
			const fifo = path.join(root, "pipe");
			await expectWriterStillDelivers(
				fifo,
				word,
				maskerProbe({ env: { PIPE_FILE: fifo }, agentDir: root, cwd: root }),
			);
		},
		40_000,
	);

	it.skipIf(process.platform === "win32")(
		"K25: as the project secrets.yml, neither blocks on the FIFO nor opens it, at the build and at a refresh, so the writer still delivers",
		async () => {
			// A secrets.yml whose entry the masker would hold, had it read the FIFO.
			await expectWriterStillDelivers(projectYml, plainYml(word), maskerProbe({ env: {}, agentDir, cwd }));
		},
		40_000,
	);

	it.skipIf(process.platform === "win32")(
		"K25: the provider obfuscator's load of the project secrets.yml neither blocks on the FIFO nor opens it, so the writer still delivers",
		async () => {
			// A secrets.yml whose entry the load would return, had it read the FIFO.
			await expectWriterStillDelivers(projectYml, plainYml(word), {
				lines: [
					`import { loadSecretsFile } from ${JSON.stringify(secretsFileModule)};`,
					"const started = performance.now();",
					"const entries = await loadSecretsFile(process.argv[2]);",
					"const withinASecond = performance.now() - started < 1_000;",
					"process.stdout.write(JSON.stringify({ withinASecond, entries: entries.length }));",
				],
				args: [projectYml],
				output: { withinASecond: true, entries: 0 },
			});
		},
		40_000,
	);
});

describe("K27: the project secrets.yml of each cwd", () => {
	it("K27: reaches the mask of its own cwd only, whatever the order the cwds are asked in", async () => {
		const [ownValue, otherValue] = ["project-a-plain-value-1", "project-b-plain-value-2"];
		const other = path.join(root, "other");
		await Bun.write(projectYml, plainYml(ownValue));
		await Bun.write(path.join(other, ".omp", "secrets.yml"), plainYml(otherValue));
		const masker = maskerFor({ SERVICE_API_KEY: ENV_VALUE });
		const text = [ownValue, otherValue, ENV_VALUE].join(" ");
		const own = [YML_MARKER, otherValue, ENV_MARKER].join(" ");

		expect(masker.snapshot(cwd).maskText(text)).toBe(own);
		expect(masker.snapshot(other).maskText(text)).toBe([ownValue, YML_MARKER, ENV_MARKER].join(" "));
		expect(masker.snapshot(cwd).maskText(text)).toBe(own);

		// A refresh changes nothing of it: each cwd still reads its own file only.
		await nextRun();
		clock += MINUTE;
		expect(masker.snapshot(other).maskText(text)).toBe([ownValue, YML_MARKER, ENV_MARKER].join(" "));
		expect(masker.snapshot(cwd).maskText(text)).toBe(own);
	});
});

describe("K28: the file PI_SESSION_FILE names", () => {
	it("K28: is neither read nor masked, and is not a logged source, while another _FILE is", async () => {
		// 40 characters: long enough for the `_FILE` source to hold, were the variable not left out.
		const transcript = "forty characters of transcript text 0001";
		const transcriptFile = await writeFile("transcript.jsonl", transcript);
		const heldFile = await writeFile("held.txt", FILE_VALUE);
		const reads = [spyOn(fs, "statSync"), spyOn(fs, "openSync"), spyOn(fs, "readFileSync")];
		const info = spyOn(logger, "info").mockImplementation(() => {});

		// SERVICE_FILE, not a secret-named variable: the env source would also hold such a variable's path.
		const mask = maskerFor({ PI_SESSION_FILE: transcriptFile, SERVICE_FILE: heldFile }).snapshot(cwd);
		expect(mask.maskText(`${transcript} ${FILE_VALUE}`)).toBe(`${transcript} [REDACTED:file:SERVICE_FILE]`);
		expect(mask.sources).toEqual([{ kind: "file", name: "SERVICE_FILE" }]);
		expect(loggedDetails(info, "Session store masking sources")).toEqual([{ sources: ["file:SERVICE_FILE"] }]);
		const readPaths = reads.flatMap(spy => spy.mock.calls.map(call => call[0]));
		expect([readPaths.includes(heldFile), readPaths.includes(transcriptFile)]).toEqual([true, false]);
	});
});

describe("K31: a masker build that throws", () => {
	it("K31: fails the write at the first build and at a refresh, logs the cause each time, and builds again at the next call", async () => {
		const [first, second] = ["first-held-value-1111", "second-held-value-2222"];
		const env: Record<string, string> = { A_TOKEN: first };
		const masker = maskerFor(env);
		const build = spyOn(storeMatcher, "buildSessionStoreMatcher");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		/** The details of each warning that says a write fails rather than store a value raw. */
		const failures = (): unknown[] =>
			warn.mock.calls
				.filter(call => String(call[0]).includes("the write fails rather than store a value raw"))
				.map(call => call[1]);
		const firstFailure = { error: expect.stringContaining("injected first failure") };
		const refreshFailure = { error: expect.stringContaining("injected refresh failure") };

		// The first build: no mask exists yet, and none is handed out.
		build.mockImplementationOnce(() => {
			throw new Error("injected first failure");
		});
		expect(() => masker.snapshot(cwd)).toThrow("injected first failure");
		expect(failures()).toEqual([firstFailure]);
		// The next call builds again, with no wait for a refresh.
		const before = masker.snapshot(cwd);
		expect(before.maskText(`${first} ${second}`)).toBe(`[REDACTED:env:A_TOKEN] ${second}`);

		// A refresh takes in a new value, and its build throws: the mask without that value is not handed out again.
		env.B_TOKEN = second;
		await nextRun();
		clock += MINUTE;
		build.mockImplementationOnce(() => {
			throw new Error("injected refresh failure");
		});
		expect(() => masker.snapshot(cwd)).toThrow("injected refresh failure");
		expect(failures()).toEqual([firstFailure, refreshFailure]);
		// A snapshot a writer already holds keeps masking what it held.
		expect(before.maskText(first)).toBe("[REDACTED:env:A_TOKEN]");

		// The next call builds again and masks the old value and the new one.
		expect(masker.snapshot(cwd).maskText(`${first} ${second}`)).toBe("[REDACTED:env:A_TOKEN] [REDACTED:env:B_TOKEN]");
		expect(failures()).toEqual([firstFailure, refreshFailure]);
	});
});
