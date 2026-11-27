import { expect, it } from "bun:test";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getAgentDir, getBlobsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const FILE = path.resolve("/sessions/transcript.jsonl");
const TIMESTAMP = "2025-01-01T00:00:00.000Z";
const HEADER = { type: "session", version: 3, id: "source", timestamp: TIMESTAMP };

it("hydrates image URLs in imported runtime values without sharing them", async () => {
	using dir = TempDir.createSync("@omp-runtime-blob-");
	const previousAgentDir = getAgentDir();
	setAgentDir(dir.path());
	try {
		const storage = new MemorySessionStorage();
		const url = "data:image/png;base64,YWJj";
		const blob = await new BlobStore(getBlobsDir()).put(Buffer.from(url));
		const entries = [
			{ version: "1", image_url: blob.ref },
			{ version: "1", image_url: blob.ref },
			{ version: "1" },
			{ version: "1" },
		].map((runtime, index) => ({
			type: "custom",
			id: String(index),
			parentId: index === 0 ? null : String(index - 1),
			timestamp: TIMESTAMP,
			customType: "imported",
			runtime,
		}));
		storage.writeTextSync(FILE, [HEADER, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));

		const manager = await SessionManager.open(FILE, undefined, storage, { suppressBreadcrumb: true });
		// Imported runtime values carry fields `RuntimeIdentity` does not declare.
		const runtimes: unknown[] = manager.getEntries().map(entry => entry.runtime);
		const [image, otherImage, stamp, otherStamp] = runtimes;
		expect(image).toEqual({ version: "1", image_url: url });
		expect(otherImage).toEqual(image);
		expect(otherImage).not.toBe(image);
		expect(otherStamp).toBe(stamp);
		expect(Object.isFrozen(stamp)).toBe(true);
		await manager.close();
	} finally {
		setAgentDir(previousAgentDir);
	}
});

it("bumps the fork body revision once when sanitizing multiple assistant entries", async () => {
	const storage = new MemorySessionStorage();
	const message = {
		role: "assistant",
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
		content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale" }],
		providerPayload: { type: "openaiResponsesHistory", items: [] },
		stopReason: "stop",
		timestamp: 1,
	};
	const first = { type: "message", id: "a1", parentId: null, timestamp: TIMESTAMP, message };
	const second = { ...first, id: "a2", parentId: first.id };
	storage.writeTextSync(FILE, [HEADER, first, second].map(entry => `${JSON.stringify(entry)}\n`).join(""));

	const fork = await SessionManager.forkFrom(FILE, process.cwd(), path.dirname(FILE), storage, {
		copyArtifacts: false,
		suppressBreadcrumb: true,
	});

	const entries = fork.getEntries();
	expect(entries.map(entry => entry.id)).toEqual(["a1", "a2"]);
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Expected assistant entry");
		expect(entry.message.providerPayload).toBeUndefined();
		const block = entry.message.content[0];
		if (block?.type !== "thinking") throw new Error("Expected thinking block");
		expect(block.thinkingSignature).toBeUndefined();
	}
	expect(fork.bodyRevision).toBe(1);
	await fork.close();
});
