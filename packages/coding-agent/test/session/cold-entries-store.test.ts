import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TextContent } from "@oh-my-pi/pi-ai";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const COLD_DIR = path.join(os.tmpdir(), "omp-cold");

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: usage(),
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

/**
 * A session whose compaction keeps `u2` on: `u1` and `a1` lie before the cut,
 * and so does `m1`, a model change, which stays whole by kind. Its id is the
 * directory's name, so no two tests share a session (a manager another test
 * left open keeps its writer claim on its session).
 */
async function writeSession(dir: string): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const id = path.basename(dir);
	const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: dir };
	const entries = [
		header,
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: `u1 ${BODY}`, timestamp: 1 },
		},
		{ type: "model_change", id: "m1", parentId: "u1", timestamp, model: "anthropic/claude-sonnet-4-20250514" },
		{ type: "message", id: "a1", parentId: "m1", timestamp, message: assistant(`a1 ${BODY}`) },
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp,
			message: { role: "user", content: `u2 ${BODY}`, timestamp: 3 },
		},
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		},
		{ type: "message", id: "a2", parentId: "c1", timestamp, message: assistant(`a2 ${BODY}`) },
	];
	await Bun.write(file, entries.map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function open(file: string, coldStore = true): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });
}

function entry(manager: SessionManager, id: string): SessionEntry {
	const found = manager.getEntry(id);
	if (!found) throw new Error(`missing entry ${id}`);
	return found;
}

function messageOf(found: SessionEntry) {
	if (found.type !== "message") throw new Error(`entry ${found.id} is not a message`);
	return found.message;
}

/** The content of a user or assistant message entry of the fixture. */
function contentOf(found: SessionEntry): string | TextContent[] {
	const message = messageOf(found);
	if (message.role !== "user" && message.role !== "assistant") throw new Error(`entry ${found.id} has no text`);
	return message.content as string | TextContent[];
}

function textOf(found: SessionEntry): string {
	const content = contentOf(found);
	if (typeof content === "string") return content;
	return content.map(block => block.text).join("");
}

/** Descriptors of this process open on a cold store file, by fd number. */
function coldStoreDescriptors(): Map<string, string> {
	const found = new Map<string, string>();
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		let target: string;
		try {
			target = fs.readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			continue;
		}
		if (target.startsWith(`${COLD_DIR}${path.sep}`)) found.set(fd, target);
	}
	return found;
}

/**
 * Run full collections until `done` holds, at most `rounds` times. Finalizers
 * run as tasks after a collection, so each round yields one event-loop turn;
 * no clock is involved.
 */
async function collectGarbage(done: () => boolean, rounds = 20): Promise<void> {
	for (let round = 0; round < rounds && !done(); round++) {
		Bun.gc(true);
		await Bun.sleep(0);
	}
}

describe("cold entry store", () => {
	it("keeps entries before the cut cold except the kinds kept whole, and serves a read from the record once", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));

		const before = manager.coldStoreStats();
		expect(before.coldEntries).toBe(2);
		expect(before.storeBytes).toBeGreaterThan(0);
		expect(before.materializations).toBe(0);

		expect(textOf(entry(manager, "u1"))).toBe(`u1 ${BODY}`);
		expect(textOf(entry(manager, "u1"))).toBe(`u1 ${BODY}`);
		expect(manager.coldStoreStats().materializations).toBe(1);

		const modelChange = entry(manager, "m1");
		expect(Object.getOwnPropertyDescriptor(modelChange, "model")?.get).toBeUndefined();
		expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
	});

	it("serializes every entry exactly as a manager holding every entry does", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const file = await writeSession(dir.path());
		const cold = await open(file);
		const whole = await open(file, false);
		expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(0);
		expect(whole.coldStoreStats().coldEntries).toBe(0);

		expect(cold.getEntries().map(found => JSON.stringify(found))).toEqual(
			whole.getEntries().map(found => JSON.stringify(found)),
		);
		expect(cold.getEntries().map(found => structuredClone(found))).toEqual(
			whole.getEntries().map(found => structuredClone(found)),
		);
		expect({ ...messageOf(entry(cold, "a1")) }).toEqual({ ...messageOf(entry(whole, "a1")) });
	});

	it("keeps each entry and its message the same objects while they go cold and whole", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		const view = manager.getBranchView();
		const a2 = entry(manager, "a2");
		const a2Message = messageOf(a2);

		const a3 = manager.appendMessage(assistant(`a3 ${BODY}`));
		manager.appendCompaction(`c2 ${BODY}`, undefined, a3, 2000);
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBeGreaterThan(2);

		expect(entry(manager, "a2")).toBe(a2);
		expect(messageOf(a2)).toBe(a2Message);
		expect(view).toContain(a2);
		expect(textOf(a2)).toBe(`a2 ${BODY}`);
	});

	it("moves the cut to the new compaction once the context is rebuilt from it", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		expect(manager.coldStoreStats().coldEntries).toBe(2);

		const a3 = manager.appendMessage(assistant(`a3 ${BODY}`));
		manager.appendCompaction(`c2 ${BODY}`, undefined, a3, 2000);
		const context = manager.buildSessionContext();

		// u1, a1, u2, c1 and a2 now lie before the cut at a3.
		expect(manager.coldStoreStats().coldEntries).toBe(5);
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "assistant"]);
		expect(textOf(entry(manager, a3))).toBe(`a3 ${BODY}`);
		expect(Object.getOwnPropertyDescriptor(messageOf(entry(manager, a3)), "content")?.get).toBeUndefined();

		// Back on the older compaction's branch, its kept entries are whole again.
		manager.branch("a2");
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBe(2);
	});

	it("returns frozen values from a cold body, so a nested write fails loudly", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		const content = contentOf(entry(manager, "a1")) as TextContent[];

		expect(() => {
			content[0]!.text = "changed";
		}).toThrow(TypeError);
		expect(() => content.push({ type: "text", text: "more" })).toThrow(TypeError);
		expect(textOf(entry(manager, "a1"))).toBe(`a1 ${BODY}`);
	});

	it("makes a cold entry whole when one of its fields is assigned, and persists the write", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const file = await writeSession(dir.path());
		const manager = await open(file);
		const a1 = entry(manager, "a1");
		const message = messageOf(a1);
		if (message.role !== "assistant") throw new Error("expected an assistant message");

		message.content = [{ type: "text", text: "replaced" }];
		const stats = manager.coldStoreStats();
		expect(stats.coldEntries).toBe(1);
		expect(stats.hydrations).toBeGreaterThanOrEqual(1);
		expect(messageOf(entry(manager, "a1"))).toBe(message);
		(message.content[0] as TextContent).text = "edited in place";
		expect(message.usage.totalTokens).toBe(2);

		await manager.rewriteEntries();
		await manager.close();
		const reopened = await open(file, false);
		expect(textOf(entry(reopened, "a1"))).toBe("edited in place");
		expect(textOf(entry(reopened, "u1"))).toBe(`u1 ${BODY}`);
	});

	it("applies updateEntryBody to a cold entry's nested values and keeps the entry cold", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));

		manager.updateEntryBody("a1", target => {
			const content = contentOf(target) as TextContent[];
			content[0]!.text = `updated ${BODY}`;
		});

		expect(textOf(entry(manager, "a1"))).toBe(`updated ${BODY}`);
		expect(manager.coldStoreStats().coldEntries).toBe(2);
	});

	it("lets a clone read cold entries after the original manager is released", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		let original: SessionManager | undefined = await open(await writeSession(dir.path()));
		const clone = original.cloneCurrentSession({ persist: false });
		original.releaseRetainedEntries();
		original = undefined;
		await collectGarbage(() => false, 3);

		expect(clone.coldStoreStats().coldEntries).toBe(2);
		expect(textOf(entry(clone, "u1"))).toBe(`u1 ${BODY}`);
		expect(textOf(entry(clone, "a1"))).toBe(`a1 ${BODY}`);
	});

	it.skipIf(!fs.existsSync("/proc/self/fd"))(
		"leaves no store file in the directory and closes its descriptor once the last cold entry is gone",
		async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const file = await writeSession(dir.path());
			const before = coldStoreDescriptors();

			const opened = async (): Promise<string[]> => {
				const manager = await open(file);
				expect(manager.coldStoreStats().coldEntries).toBe(2);
				const added = [...coldStoreDescriptors()].filter(([fd, target]) => before.get(fd) !== target);
				expect(added).toHaveLength(1);
				const [fd, target] = added[0]!;
				expect(target.endsWith(" (deleted)")).toBe(true);
				expect(fs.readdirSync(COLD_DIR)).not.toContain(path.basename(target.replace(/ \(deleted\)$/, "")));
				manager.releaseRetainedEntries();
				return [fd, target];
			};
			const [fd, target] = await opened();

			const stillOpen = () => coldStoreDescriptors().get(fd) === target;
			await collectGarbage(() => !stillOpen());
			expect(stillOpen()).toBe(false);
		},
	);
});
