/**
 * `omp --session-id <id>` under SQL session storage, with the claims the CLI turns on (a SQLite file
 * always; PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a
 * server). While another store holds the stored session's claim, as another live omp process does,
 * a launch under the id waits for that lease as an explicit resume does and is then refused before
 * any model call, writing nothing: the session keeps its content and no second session takes the id.
 * Once the holder lets go, the same command resumes the session: the model gets the earlier turn, and
 * the session's own row grows.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SqlSessionStorageAdapter } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { cliDatabase, cliSession, LEASE_BACKENDS, transcript } from "./sql-session-lease-fixture";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const ID = "019ea530-5e55-7000-8000-0000000051d1";

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

/**
 * An OpenAI-compatible model for CLI launches whose agent directory is `agentDir` (model
 * `fake/fake-model`): it answers `pong`, and keeps the user messages of every request it gets.
 */
function startModel(agentDir: string): { requests: string[][]; [Symbol.dispose](): void } {
	const requests: string[][] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as {
				messages?: Array<{ role?: string; content?: unknown }>;
				stream?: boolean;
			};
			requests.push((body.messages ?? []).filter(m => m.role === "user").map(m => messageText(m.content)));
			const base = { id: "chatcmpl-fake", created: 0, model: "fake-model" };
			const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
			if (!body.stream) {
				return Response.json({
					...base,
					object: "chat.completion",
					choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
					usage,
				});
			}
			const chunk = { ...base, object: "chat.completion.chunk" };
			const events = [
				{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
				{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				{ ...chunk, choices: [], usage },
			].map(event => `data: ${JSON.stringify(event)}\n\n`);
			return new Response(`${events.join("")}data: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${server.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-model",
			"        name: Fake Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
	return { requests, [Symbol.dispose]: () => server.stop(true) };
}

/** A database of its own for the CLI: a SQLite file in `dir`, or one on the server `url` names. */
async function database(
	adapter: SqlSessionStorageAdapter,
	url: string,
	dir: TempDir,
): Promise<AsyncDisposable & { dsn: string; sql: InstanceType<typeof SQL> }> {
	if (adapter !== "sqlite") return await cliDatabase(adapter, url);
	const dsn = `sqlite://${dir.join("sessions.db")}`;
	const sql = new SQL(dsn);
	return {
		dsn,
		sql,
		async [Symbol.asyncDispose]() {
			await sql.end();
		},
	};
}

/** `omp --session-id <ID> -p <prompt>` from source, against the SQL store `dsnFile` names, in `home`. */
async function launch(
	session: { cwd: string; home: string; sessionDir: string; dsnFile: string },
	prompt: string,
): Promise<{ exitCode: number; stderr: string }> {
	const { home } = session;
	const proc = Bun.spawn(
		[
			process.execPath,
			cliEntry,
			"--no-extensions",
			"--session-dir",
			session.sessionDir,
			"--session-id",
			ID,
			"--model",
			"fake/fake-model",
			"-p",
			prompt,
		],
		{
			cwd: session.cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_STATE_HOME: path.join(home, "state"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				TMPDIR: process.env.TMPDIR,
				// A SQLite claim is a file lease in this directory: the CLI must meet the holder's.
				PI_TEST_SESSION_OWNERS_DIR: process.env.PI_TEST_SESSION_OWNERS_DIR,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
				OMP_SESSION_STORAGE: "sql",
				OMP_SESSION_SQL_DSN_FILE: session.dsnFile,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

/** The session paths the store holds, and the stored content of `file`, read by a store that claims nothing. */
async function stored(dsn: string, file: string): Promise<{ paths: string[]; content: string }> {
	const client = new SQL(dsn);
	try {
		const store = await SqlSessionStorage.create({ client, claims: false });
		const rows = (await client.unsafe("SELECT path FROM omp_session_files ORDER BY path")) as Array<{ path: string }>;
		return { paths: rows.map(row => row.path), content: await store.readText(file) };
	} finally {
		await client.end();
	}
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --session-id under SQL session storage (${adapter})`, () => {
		it("refuses while another process holds the session, writing nothing, then resumes it once that process lets go", async () => {
			using dir = TempDir.createSync("@omp-session-id-sql-");
			await using db = await database(adapter, url ?? "", dir);
			const session = await cliSession(dir, db.dsn, ID, { model: false });
			using model = startModel(path.join(session.home, ".omp", "agent"));
			const before = await stored(db.dsn, session.file);
			expect(before.content).toBe(transcript(ID, "before", session.cwd));

			// Another live process: a store of its own that holds the session's claim.
			const holder = await SqlSessionStorage.create({ client: new SQL(db.dsn), claims: true });
			const release = await holder.acquireSessionClaim?.(ID, session.file);
			if (!release) throw new Error("the holder could not claim the session");
			let refused: { exitCode: number; stderr: string };
			try {
				refused = await launch(session, "while it is held");
			} finally {
				release();
				await holder.drain();
			}
			expect(refused.exitCode, refused.stderr).toBe(1);
			// A lease row waits for its holder's heartbeat to stop (35 s); a SQLite file's OS lock is dropped the
			// moment its holder exits, so the claim tries again only briefly and says nothing.
			if (adapter !== "sqlite") expect(refused.stderr).toContain(`Session ${ID} is held by another omp process`);
			expect(refused.stderr).toContain(`Session "${ID}" is open in another running omp process.`);
			expect(model.requests, "no model call").toEqual([]);
			expect(await stored(db.dsn, session.file), "the refused launch wrote nothing").toEqual(before);

			const resumed = await launch(session, "after it let go");
			expect(resumed.exitCode, resumed.stderr).toBe(0);
			const after = await stored(db.dsn, session.file);
			expect(after.paths, "no second session took the id").toEqual(before.paths);
			expect(after.content, "the session's own row keeps the stored turn").toContain('"content":"before"');
			expect(after.content).toContain("after it let go");
			const request = model.requests.find(texts => texts.some(text => text.includes("after it let go")));
			expect(
				request?.some(text => text.includes("before")),
				"the resumed request carries the stored turn",
			).toBe(true);
		}, 180_000);
	});
}
