/**
 * `omp gc` while `session.storage: sql` keeps transcripts as database rows.
 * A phase may delete only what the configured storage proves dead: the files
 * on disk can veto a deletion, never authorize one. Phases that work only on
 * session files on disk refuse, and say so.
 *
 * The command-line refusal of `--strip` runs against SQLite always, and
 * against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a server, each in a database of its own.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectGcErrors, runGcCommand } from "@oh-my-pi/pi-coding-agent/cli/gc-cli";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionReadConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as sessionStorageConfig from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	getBlobsDir,
	getCustomSessionFilesDir,
	getSessionsDir,
	getTerminalSessionsDir,
	hashPath,
} from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { paddedTranscript, raceAfterFirstChunk, STILL } from "./session/chunked-read-race";
import { cliDatabase, LEASE_BACKENDS, openLeaseDb } from "./session/sql-session-lease-fixture";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");

let root: string;
let client: SQL | undefined;
let storage: SqlSessionStorage;
let settingsState: SettingsTestState | undefined;
let stdoutSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	delete process.env.OMP_SESSION_STORAGE;
	delete process.env.OMP_SESSION_SQL_DSN_FILE;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gc-sql-"));
	stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	const url = `sqlite:${path.join(root, "sessions.db")}`;
	const dsnFile = path.join(root, "session.dsn");
	await Bun.write(dsnFile, url);
	await Bun.write(
		path.join(root, "config.yml"),
		["session:", "  storage: sql", "  sql:", `    dsnFile: ${dsnFile}`, ""].join("\n"),
	);
	client = new SQL(url);
	storage = await SqlSessionStorage.create({ client });
});

afterEach(async () => {
	stdoutSpy?.mockRestore();
	stdoutSpy = undefined;
	await client?.end();
	client = undefined;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	AgentStorage.close();
	await fs.rm(root, { recursive: true, force: true });
});

function hashFor(label: string): string {
	return new Bun.SHA256().update(label).digest("hex");
}

function transcript(id: string, text: string): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd: root }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		}),
	].join("\n")}\n`;
}

async function agedBlob(label: string): Promise<string> {
	const blob = path.join(getBlobsDir(root), hashFor(label));
	await Bun.write(blob, label);
	const old = new Date(Date.now() - 86_400_000);
	await fs.utimes(blob, old, old);
	return blob;
}

async function agedFile(file: string, content: string): Promise<string> {
	await Bun.write(file, content);
	const old = new Date(Date.now() - 3 * 86_400_000);
	await fs.utimes(file, old, old);
	return file;
}

/** A read of `path` that a concurrent rewrite raced before it yielded anything. */
function racedRead(path: string): AsyncIterable<Uint8Array> {
	return {
		[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new SessionReadConflictError(path)) }),
	};
}

/** `chunks` cut into pieces of at most `size` bytes. */
async function* smallChunks(chunks: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
	for await (const chunk of chunks) {
		for (let start = 0; start < chunk.byteLength; start += size) yield chunk.subarray(start, start + size);
	}
}

describe("omp gc --blobs under session.storage: sql", () => {
	const parent = () => path.join(getSessionsDir(root), "project", "2026-10-01_root.jsonl");
	// Each row is a transcript position the file scan cannot prove unreferenced.
	const placements: Array<[string, () => string]> = [
		["a subagent transcript", () => `${parent().slice(0, -6)}/Worker.jsonl`],
		["a grandchild transcript", () => `${parent().slice(0, -6)}/Worker/Worker.Helper.jsonl`],
		["a custom --session path outside the sessions root", () => path.join(root, "custom", "session.jsonl")],
	];

	for (const [where, key] of placements) {
		test(`--apply keeps a blob referenced only by ${where}`, async () => {
			const referenced = await agedBlob(`ref:${where}`);
			const orphan = await agedBlob(`orphan:${where}`);
			await storage.writeText(parent(), transcript("root", "no blob here"));
			await storage.writeText(key(), transcript("ref", `blob:sha256:${hashFor(`ref:${where}`)}`));

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect(await Bun.file(referenced).exists()).toBe(true);
			// The sweep still runs: the unreferenced blob goes.
			expect(await Bun.file(orphan).exists()).toBe(false);
			expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
		});
	}

	test("--apply keeps a blob referenced by a SQL row whose path also names a stale local file", async () => {
		const referenced = await agedBlob("shadowed");
		const file = parent();
		await storage.writeText(file, transcript("root", `blob:sha256:${hashFor("shadowed")}`));
		// A copy left on disk from before the switch to sql, without the reference.
		await Bun.write(file, transcript("root", "stale local copy"));

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(await Bun.file(referenced).exists()).toBe(true);
		expect(result.blobs).toMatchObject({ referenced: 1, deleted: 0 });
	});

	test("--apply keeps a blob referenced by a registered custom session that has no local file", async () => {
		const referenced = await agedBlob("registered");
		const file = path.join(root, "elsewhere", "registered.jsonl");
		await storage.writeText(file, transcript("custom", `blob:sha256:${hashFor("registered")}`));
		await Bun.write(path.join(getCustomSessionFilesDir(root), hashPath(file)), file);

		await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		expect(await Bun.file(referenced).exists()).toBe(true);
	});

	test("--apply deletes the blob-table rows no session names, and keeps one a transcript names and one written within the grace", async () => {
		await storage.writeText(parent(), transcript("root", `blob:sha256:${hashFor("named")}`));
		await storage.drain();
		const row = async (label: string, createdMs: number) =>
			client?.unsafe(
				"INSERT INTO omp_session_files_blobs (sha256, content, byte_len, mime_type, created_ms) VALUES (?, ?, ?, ?, ?)",
				[hashFor(label), Buffer.from(label), label.length, "image/png", createdMs],
			);
		const old = Date.now() - 3 * 86_400_000;
		// Written after the transcript, so no reference row names it: only the transcript does.
		await row("named", old);
		await row("orphan", old);
		await row("fresh", Date.now());
		// A machine that stored an image has a blob directory; a blob phase that cannot identify one deletes nothing.
		await fs.mkdir(getBlobsDir(root), { recursive: true });

		const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

		const left = ((await client?.unsafe("SELECT sha256 FROM omp_session_files_blobs")) as Array<{ sha256: string }>)
			.map(found => found.sha256)
			.sort();
		expect(left).toEqual([hashFor("named"), hashFor("fresh")].sort());
		expect(result.blobs?.table).toMatchObject({ candidates: 1, deleted: 1, bytes: "orphan".length });
	});

	describe("reading the store's transcripts through gc's own reads", () => {
		let resolve: { mockRestore(): void } | undefined;
		beforeEach(() => {
			resolve = spyOn(sessionStorageConfig, "resolveSessionStorage").mockResolvedValue(storage);
		});
		afterEach(() => {
			resolve?.mockRestore();
		});

		test("--apply reads again a transcript whose read a concurrent rewrite raced, and keeps its blob", async () => {
			const referenced = await agedBlob("raced");
			const orphan = await agedBlob("orphan:raced");
			const file = parent();
			await storage.writeText(file, transcript("root", `blob:sha256:${hashFor("raced")}`));
			const read = storage.readChunks;
			let reads = 0;
			spyOn(storage, "readChunks").mockImplementation((path, fromByte) =>
				path === file && reads++ === 0 ? racedRead(path) : read(path, fromByte),
			);

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect(reads).toBe(2);
			expect(await Bun.file(referenced).exists()).toBe(true);
			expect(await Bun.file(orphan).exists()).toBe(false);
			expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
		});

		test("fails, deleting nothing, when every read of a transcript is raced", async () => {
			const referenced = await agedBlob("always-raced");
			const file = parent();
			await storage.writeText(file, transcript("root", `blob:sha256:${hashFor("always-raced")}`));
			const read = storage.readChunks;
			let reads = 0;
			spyOn(storage, "readChunks").mockImplementation((path, fromByte) => {
				if (path !== file) return read(path, fromByte);
				reads++;
				return racedRead(path);
			});

			await expect(runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } })).rejects.toBeInstanceOf(
				SessionReadConflictError,
			);

			// The first read and three more; never skipped, or the blob only it references would go.
			expect(reads).toBe(4);
			expect(await Bun.file(referenced).exists()).toBe(true);
		});

		test("--apply keeps a blob whose reference sits in a line the read splits across many chunks", async () => {
			const referenced = await agedBlob("split");
			const orphan = await agedBlob("orphan:split");
			const file = parent();
			const text = `${"x".repeat(5000)} blob:sha256:${hashFor("split")} ${"y".repeat(5000)}`;
			await storage.writeText(file, transcript("root", text));
			const read = storage.readChunks;
			spyOn(storage, "readChunks").mockImplementation((path, fromByte) => smallChunks(read(path, fromByte), 7));

			const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

			expect(await Bun.file(referenced).exists()).toBe(true);
			expect(await Bun.file(orphan).exists()).toBe(false);
			expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
		});

		for (const { adapter, url } of LEASE_BACKENDS) {
			test.skipIf(!url)(
				`--apply keeps a blob both bodies reference when another store rewrites the transcript after the scan's first chunk (${adapter})`,
				async () => {
					// If this regresses, gc run while another process compacts a long SQL session fails, or
					// deletes an image blob the session still references and the session shows it as missing.
					await using db = await openLeaseDb(adapter, url ?? "");
					const referenced = await agedBlob("raced by a store");
					const orphan = await agedBlob("orphan:raced by a store");
					const file = parent();
					// The reference sits past the first chunk, in a line both bodies hold.
					const body = (fill: string) => [
						...paddedTranscript("root", "first", fill, 3),
						`${JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-10-01T00:00:02.000Z", message: { role: "user", content: `blob:sha256:${hashFor("raced by a store")}`, timestamp: 2 } })}\n`,
					];
					const holder = await db.open({ lease: STILL });
					await holder.writeLinesAtomic(file, body("a"));
					await holder.drain();
					const reader = await db.open({ lease: STILL });
					resolve?.mockRestore();
					resolve = spyOn(sessionStorageConfig, "resolveSessionStorage").mockResolvedValue(reader);
					const race = raceAfterFirstChunk(reader, file, async () => {
						await holder.writeLinesAtomic(file, body("b"), { expectedSize: holder.statSync(file).size });
						await holder.drain();
					});

					const result = await runGcCommand({ flags: { agentDir: root, blobs: true, apply: true } });

					expect(race.ran).toBe(true);
					expect(await Bun.file(referenced).exists()).toBe(true);
					expect(await Bun.file(orphan).exists()).toBe(false);
					expect(result.blobs).toMatchObject({ referenced: 1, deleted: 1, errors: [] });
				},
				120_000,
			);
		}
	});
});

describe("omp gc --stale under session.storage: sql", () => {
	test("--apply keeps pointers to SQL rows and prunes pointers whose session is gone everywhere", async () => {
		const project = path.join(getSessionsDir(root), "project");
		const live = path.join(project, "live.jsonl");
		const gone = path.join(project, "gone.jsonl");
		await storage.writeText(live, transcript("live", "still here"));
		const markers = getCustomSessionFilesDir(root);
		const crumbs = getTerminalSessionsDir(root);
		const liveMarker = await agedFile(path.join(markers, "live"), live);
		const goneMarker = await agedFile(path.join(markers, "gone"), gone);
		const liveCrumb = await agedFile(path.join(crumbs, "tty-live"), `${project}\n${live}\n`);
		const goneCrumb = await agedFile(path.join(crumbs, "tty-gone"), `${project}\n${gone}\n`);

		const result = await runGcCommand({
			flags: { agentDir: root, stale: true, staleRetainNewest: 20, staleRetainDays: 30, apply: true },
		});

		expect(result.stale).toMatchObject({ danglingMarkers: 1, staleBreadcrumbs: 1, deleted: 2, errors: [] });
		expect(await Bun.file(liveMarker).exists()).toBe(true);
		expect(await Bun.file(liveCrumb).exists()).toBe(true);
		expect(await Bun.file(goneMarker).exists()).toBe(false);
		expect(await Bun.file(goneCrumb).exists()).toBe(false);
	});
});

describe("omp gc disk-only phases under session.storage: sql", () => {
	/**
	 * A cold session file on disk with replay data outside its latest replay
	 * turn: the first response's signed reasoning is what `--strip` removes, so
	 * a strip that ran would change the bytes as well as report itself.
	 */
	async function coldLocalSession(): Promise<{ file: string; bytes: Uint8Array }> {
		const file = path.join(getSessionsDir(root), "project", "cold.jsonl");
		const assistant = (thinking: string, signature: string) =>
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-4-5",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking, thinkingSignature: signature },
						{ type: "text", text: "done" },
					],
				},
			});
		const prompt = JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "again" }] },
		});
		await Bun.write(
			file,
			`${transcript("cold", "old")}${assistant("earlier", "EqQBearly")}\n${prompt}\n${assistant("latest", "EqQBlatest")}\n`,
		);
		const old = new Date(Date.now() - 90 * 86_400_000);
		await fs.utimes(file, old, old);
		return { file, bytes: await Bun.file(file).bytes() };
	}

	for (const phase of ["archive", "compress", "strip"] as const) {
		test(`--${phase} --apply refuses, names the storage, and leaves session files alone`, async () => {
			const { file, bytes } = await coldLocalSession();

			const result = await runGcCommand({
				flags: {
					agentDir: root,
					[phase]: true,
					apply: true,
					coldArchiveAfterDays: 0,
					retainNewestGlobal: 0,
					retainNewestPerCwd: 0,
					compressAfterDays: 0,
					stripAfterDays: 0,
				},
			});

			expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
			expect(result[phase]).toBeUndefined();
			expect(result.refused).toEqual([
				{ phase, requested: true, reason: expect.stringContaining("unavailable with session.storage: sql") },
			]);
			expect(collectGcErrors(result)).toEqual([
				expect.stringContaining(`${phase}: unavailable with session.storage: sql`),
			]);
			expect(await Bun.file(path.join(root, "archive")).exists()).toBe(false);
		});
	}

	test("an unqualified run leaves the archive phase alone without failing", async () => {
		// `gc.archive` is off by default (#17398): an unqualified run does not
		// select the phase, so there is nothing to refuse.
		const { file, bytes } = await coldLocalSession();

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.refused).toBeUndefined();
		expect(result.archive).toBeUndefined();
		expect(collectGcErrors(result)).toEqual([]);
		expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
	});

	/** Keep `session:` as `storage` names it and select only the strip phase through `gc.strip`. */
	async function selectStripBySettings(storage: "sql" | "file"): Promise<void> {
		const session =
			storage === "sql"
				? ["session:", "  storage: sql", "  sql:", `    dsnFile: ${path.join(root, "session.dsn")}`]
				: ["session:", "  storage: file"];
		const gc = ["gc:", "  strip: true", "  stripAfterDays: 0", "  archive: false"];
		await Bun.write(path.join(root, "config.yml"), [...session, ...gc, ""].join("\n"));
	}

	test("a strip gc.strip selects is reported as not run without failing", async () => {
		await selectStripBySettings("sql");
		const { file, bytes } = await coldLocalSession();

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.strip).toBeUndefined();
		expect(result.refused).toEqual([
			{ phase: "strip", requested: false, reason: expect.stringContaining("unavailable with session.storage: sql") },
		]);
		expect(collectGcErrors(result)).toEqual([]);
		expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
	});

	// The control: the same selection under file storage runs the strip.
	test("a strip gc.strip selects runs under file storage", async () => {
		await selectStripBySettings("file");
		const { file } = await coldLocalSession();

		const result = await runGcCommand({ flags: { agentDir: root, apply: true } });

		expect(result.refused).toBeUndefined();
		expect(result.strip).toBeDefined();
		expect(collectGcErrors(result)).toEqual([]);
		const after = await Bun.file(file).text();
		expect(after).not.toContain("EqQBearly");
		expect(after).toContain("EqQBlatest");
	});

	// What a person runs under each SQL backend. `omp gc --strip --apply` fails
	// with one line naming the storage and the reason; `omp gc --apply` with
	// `gc.strip` on reports the strip as not run and succeeds. Neither changes a file.
	const runs = [
		{
			how: "omp gc --strip --apply",
			args: ["--strip", "--apply", "--strip-after-days", "0"],
			bySettings: false,
			exitCode: 1,
			stream: "stderr" as const,
			line: "- strip: unavailable with session.storage: sql: stripping rewrites session files on disk",
		},
		{
			how: "omp gc --apply with gc.strip on",
			args: ["--apply"],
			bySettings: true,
			exitCode: 0,
			stream: "stdout" as const,
			line: "strip: not run, unavailable with session.storage: sql: stripping rewrites session files on disk",
		},
	];
	for (const backend of LEASE_BACKENDS) {
		for (const run of runs) {
			test.skipIf(!backend.url)(
				`${run.how} on ${backend.adapter} exits ${run.exitCode} naming the storage and leaves session files alone`,
				async () => {
					const db = backend.adapter === "sqlite" ? undefined : await cliDatabase(backend.adapter, backend.url!);
					try {
						if (run.bySettings) await selectStripBySettings("sql");
						const dsnFile = path.join(root, "cli.dsn");
						await Bun.write(dsnFile, `${db?.dsn ?? `sqlite:${path.join(root, "cli-sessions.db")}`}\n`);
						const { file, bytes } = await coldLocalSession();

						const proc = Bun.spawn([process.execPath, CLI_ENTRY, "gc", ...run.args, "--agent-dir", root], {
							cwd: root,
							env: {
								...process.env,
								NO_COLOR: "1",
								PI_CODING_AGENT_DIR: root,
								OMP_SESSION_STORAGE: "sql",
								OMP_SESSION_SQL_DSN_FILE: dsnFile,
							},
							stdin: "ignore",
							stdout: "pipe",
							stderr: "pipe",
						});
						const [exitCode, stdout, stderr] = await Promise.all([
							proc.exited,
							new Response(proc.stdout).text(),
							new Response(proc.stderr).text(),
						]);

						expect(exitCode, `${stdout}\n${stderr}`).toBe(run.exitCode);
						expect(run.stream === "stdout" ? stdout : stderr).toContain(run.line);
						expect(await Bun.file(file).bytes()).toEqual(new Uint8Array(bytes));
					} finally {
						await db?.[Symbol.asyncDispose]();
					}
				},
				60_000,
			);
		}
	}
});
