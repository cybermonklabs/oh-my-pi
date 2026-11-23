/**
 * The Agent Hub transcript viewer reads a parked subagent's transcript through
 * the session storage. Under `session.storage: sql` the transcript is a row
 * with no file behind it; a viewer that stats and reads the filesystem treats
 * it as missing and shows an empty transcript.
 */
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource, createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { type AgentTranscriptSource, AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { STILL } from "./session/chunked-read-race";
import { LEASE_BACKENDS, openLeaseDb } from "./session/sql-session-lease-fixture";

const TS = "2026-11-02T00:00:00.000Z";
const AGENT_ID = "Worker";

function userLine(id: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content: text, attribution: "user", timestamp: 0 },
	});
}

async function openStorage(kind: "file" | "sql"): Promise<{ storage: SessionStorage; close(): Promise<void> }> {
	if (kind === "file") return { storage: new FileSessionStorage(), close: async () => {} };
	const client = new SQL("sqlite::memory:");
	return { storage: await SqlSessionStorage.create({ client }), close: () => client.end() };
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

describe("Agent Hub transcript viewer storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`renders a parked subagent transcript held by ${kind} storage and tails what it appends`, async () => {
			const previous = defaultSessionStorage();
			const { storage, close } = await openStorage(kind);
			setDefaultSessionStorage(storage);
			cleanups.push(async () => {
				setDefaultSessionStorage(previous);
				await close();
			});
			const dir = TempDir.createSync("@omp-hub-transcript-storage-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", `${AGENT_ID}.jsonl`);
			const header = JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: AGENT_ID,
				timestamp: TS,
				cwd: "/tmp",
			});
			await storage.writeText(sessionFile, `${header}\n${userLine("u1", "FIRSTVIEWMARKER")}\n`);

			const agents = new AgentRegistry();
			agents.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Main",
				session: null,
				sessionFile,
				status: "parked",
			});
			// The viewer asks for a render whenever loaded rows change: that is the signal to read the body.
			const renderWaiters: (() => void)[] = [];
			vi.useFakeTimers();
			const viewer = new AgentTranscriptViewer({
				transcript: agentTranscriptSource,
				agentId: AGENT_ID,
				registry: agents,
				ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
				cwd: "/tmp",
				expandKeys: ["ctrl+o"],
				hubKeys: ["ctrl+s"],
				requestRender: () => {
					for (const resolve of renderWaiters.splice(0)) resolve();
				},
				onClose: () => {},
				onHubClose: () => {},
			});
			cleanups.push(() => viewer.dispose());
			const body = () =>
				viewer
					.render(100)
					.map(line => Bun.stripANSI(line))
					.join("\n");
			const untilBodyShows = async (marker: string) => {
				while (!body().includes(marker)) {
					const { promise, resolve } = Promise.withResolvers<void>();
					renderWaiters.push(resolve);
					await promise;
				}
			};

			await untilBodyShows("FIRSTVIEWMARKER");

			const writer = storage.openWriter(sessionFile, { flags: "a" });
			await writer.append(`${userLine("u2", "APPENDEDVIEWMARKER")}\n`);
			await writer.close();
			// One poll interval notices the growth.
			vi.advanceTimersByTime(250);
			await untilBodyShows("APPENDEDVIEWMARKER");
			// The tail appends the new entry; it does not replay what was already shown.
			expect(body().match(/FIRSTVIEWMARKER/g)).toHaveLength(1);
		});
	}

	it("reads on at each poll from a source that answers a long transcript in windows", async () => {
		const WINDOW = 16 * 1024;
		const LINES = 100;
		const header = JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: AGENT_ID,
			timestamp: TS,
			cwd: "/tmp",
		});
		const lines = [header];
		for (let n = 0; n < LINES; n++) lines.push(userLine(`u${n}`, `WINDOWLINE${n}MARK ${"w".repeat(300)}`));
		const content = Buffer.from(`${lines.join("\n")}\n`);
		// Each read answers one window, as the source over a long stored transcript does.
		const readEnds: number[] = [];
		let read = Promise.resolve("");
		const source: AgentTranscriptSource = {
			stat: () => ({ size: content.byteLength, mtimeMs: 1 }),
			readFrom: (_file, offset) => {
				const end = Math.min(content.byteLength, offset + WINDOW);
				readEnds.push(end);
				read = Promise.resolve(content.subarray(offset, end).toString("utf-8"));
				return read;
			},
			parseEntries: agentTranscriptSource.parseEntries,
		};
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/sessions/main/Worker.jsonl",
			status: "parked",
		});
		vi.useFakeTimers();
		const viewer = new AgentTranscriptViewer({
			transcript: source,
			agentId: AGENT_ID,
			registry: agents,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: "/tmp",
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+s"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
		cleanups.push(() => viewer.dispose());
		// The viewer handles a read before a later wait on the same promise resumes.
		await read;
		while (readEnds.length <= LINES) {
			const reads = readEnds.length;
			vi.advanceTimersByTime(250);
			if (readEnds.length === reads) break;
			await read;
		}

		// No poll idled while a window stopped short of the end: the reads reached it.
		expect(readEnds.at(-1)).toBe(content.byteLength);
		const body = viewer
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(body.match(new RegExp(`WINDOWLINE${LINES - 1}MARK`, "g"))).toHaveLength(1);
	});

	it("returns the next line to a read that starts inside rendered text, though that line is longer than a read window", async () => {
		const dir = TempDir.createSync("@omp-hub-transcript-window-");
		cleanups.push(() => dir.removeSync());
		const sessionFile = dir.join("main", `${AGENT_ID}.jsonl`);
		const header = JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: AGENT_ID,
			timestamp: TS,
			cwd: "/tmp",
		});
		const shown = [header];
		for (let n = 0; n < 20; n++) shown.push(userLine(`u${n}`, `shown ${n} ${"s".repeat(400)}`));
		const rendered = `${shown.join("\n")}\n`;
		await Bun.write(
			sessionFile,
			`${rendered}${userLine("long", "l".repeat(9 * 1024 * 1024))}\n${userLine("tail", "after")}\n`,
		);
		const { transcript } = createAgentHubRuntime({
			storage: new FileSessionStorage(),
			registry: new AgentRegistry(),
		});

		// The viewer reads again from up to 4096 characters before the end of what it rendered.
		const anchor = 4096;
		const text = await transcript.readFrom(sessionFile, Buffer.byteLength(rendered) - anchor);
		const unseen = text.slice(anchor, text.lastIndexOf("\n") + 1);
		const ids = unseen
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => {
				const entry: unknown = JSON.parse(line);
				return typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined;
			});
		expect(ids).toEqual(["long", "tail"]);
	});

	for (const { adapter, url } of LEASE_BACKENDS) {
		it.skipIf(!url)(
			`renders one body of a long SQL transcript another store rewrites between two polls of its windowed read (${adapter})`,
			async () => {
				// If this regresses, the Agent Hub shows a parked subagent whose long SQL transcript another
				// process rewrote with turns of the old transcript above turns of the new one.
				await using db = await openLeaseDb(adapter, url ?? "");
				const sessionFile = path.join(db.dir.path(), "sessions", "main", `${AGENT_ID}.jsonl`);
				const header = JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: AGENT_ID,
					timestamp: TS,
					cwd: "/tmp",
				});
				const marker = (tag: string, n: number) => `${tag}${String(n).padStart(2, "0")}VIEWMARK`;
				// Past the 8 MiB a read window holds: a turn after each 1 MiB entry the viewer does not render.
				const body = (tag: string) => [
					`${header}\n`,
					...Array.from({ length: 12 }, (_, n) => [
						`${JSON.stringify({ type: "custom", customType: "pad", id: `p${n}`, parentId: null, timestamp: TS, data: tag.repeat(1024 * 1024) })}\n`,
						`${userLine(`u${n}`, marker(tag, n))}\n`,
					]).flat(),
				];
				const holder = await db.open({ lease: STILL });
				await holder.writeLinesAtomic(sessionFile, body("a"));
				await holder.drain();
				const reader = await db.open({ lease: STILL });
				const { transcript } = createAgentHubRuntime({ storage: reader, registry: new AgentRegistry() });
				const reads: Promise<string>[] = [];
				const source: AgentTranscriptSource = {
					...transcript,
					readFrom: (file, offset) => {
						const read = transcript.readFrom(file, offset);
						reads.push(read);
						return read;
					},
				};
				// Every read the viewer started has been handled: it handles a read before a later wait on it resumes.
				const settle = async () => {
					for (let i = 0; i < reads.length; i++) await reads[i];
				};
				const agents = new AgentRegistry();
				agents.register({
					id: AGENT_ID,
					displayName: AGENT_ID,
					kind: "sub",
					parentId: "Main",
					session: null,
					sessionFile,
					status: "parked",
				});
				vi.useFakeTimers();
				const viewer = new AgentTranscriptViewer({
					transcript: source,
					agentId: AGENT_ID,
					registry: agents,
					// Tall enough to show every turn, so a render shows all the rows the viewer holds.
					ui: { requestRender: () => {}, requestComponentRender: () => {}, terminal: { rows: 10_000 } } as never,
					cwd: "/tmp",
					expandKeys: ["ctrl+o"],
					hubKeys: ["ctrl+s"],
					requestRender: () => {},
					onClose: () => {},
					onHubClose: () => {},
				});
				cleanups.push(() => viewer.dispose());
				await settle();
				const shown = (tag: string) => {
					const rendered = viewer
						.render(100)
						.map(line => Bun.stripANSI(line))
						.join("\n");
					return Array.from({ length: 12 }, (_, n) => marker(tag, n)).filter(mark => rendered.includes(mark))
						.length;
				};
				const firstWindow = shown("a");

				await holder.writeLinesAtomic(sessionFile, body("b"), { expectedSize: holder.statSync(sessionFile).size });
				await holder.drain();
				for (let poll = 0; poll < 8; poll++) {
					vi.advanceTimersByTime(250);
					await settle();
				}

				expect({ firstWindow: firstWindow > 0 && firstWindow < 12, reads: reads.length > 2 }).toEqual({
					firstWindow: true,
					reads: true,
				});
				expect([
					{ a: 12, b: 0 },
					{ a: 0, b: 12 },
				]).toContainEqual({ a: shown("a"), b: shown("b") });
			},
			120_000,
		);
	}
});
