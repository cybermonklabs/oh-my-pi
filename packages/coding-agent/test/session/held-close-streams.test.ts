/**
 * (R3, check c-no-join on the candidate release cut): a session whose close the SQL store refused
 * keeps its transcript and sends it once another session's write lands (the held send, SessionManager#hold and
 * #sendHeld). That send reads what the store holds at the session's path first, to compare it with what the
 * close left. No step of a running session builds the whole transcript in memory as one value, so the read
 * goes in parts too: no string the storage hands back to the session may hold more than 16 MiB of a
 * transcript longer than that, as the streamed resume and the streamed full write already keep.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";
import { byteSize, Longest } from "../helpers/longest-value";
import { assistant, heldIds, RefusingSqlClient, storedIds, storedSqlContent } from "../helpers/refusing-session-stores";

const BOUND = 16 * 1024 * 1024;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the held send of a transcript whose close a SQL store refused", () => {
	for (const refusal of ["read-only", "connection"] as const) {
		it(`reads the stored transcript in parts, never as one value (${refusal})`, async () => {
			const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
			const storage = await SqlSessionStorage.create({ client });
			const child = await SessionManager.open(path.resolve("/sessions/parent/Long.jsonl"), undefined, storage, {
				initialCwd: "/cwd",
			});
			// 24 MiB of answers, stored while the store accepts writes.
			const answer = "x".repeat(256 * 1024);
			for (let i = 0; i < 96; i++) child.appendMessage(assistant(`answer ${i}: ${answer}`));
			await storage.drain();

			client.refusal = refusal;
			child.appendMessage(assistant("Long: refused answer"));
			await storage.drain().catch(() => undefined);
			const ids = heldIds(child);
			child.seal({});
			await expect(child.close()).rejects.toThrow();
			expect(child.holdsTranscript()).toBe(true);

			// Every string the storage hands back to a session from here on.
			const longest = new Longest();
			for (const method of ["readText", "readTextSync"] as const) {
				const original = (storage as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
				if (typeof original !== "function") continue;
				vi.spyOn(storage as unknown as Record<string, (...args: unknown[]) => unknown>, method).mockImplementation(
					(...args: unknown[]) => {
						const result = original.apply(storage, args);
						if (result instanceof Promise) {
							return result.then(value => {
								longest.note(byteSize(value), `${method}(${String(args[0])})`);
								return value;
							});
						}
						longest.note(byteSize(result), `${method}(${String(args[0])})`);
						return result;
					},
				);
			}

			client.refusal = undefined;
			const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
			parent.appendMessage(assistant("the parent's write lands"));
			await parent.close();

			// The held transcript landed ...
			expect(child.holdsTranscript()).toBe(false);
			vi.restoreAllMocks();
			expect(storedIds(await storedSqlContent(client, child.getSessionFile() as string))).toEqual(ids);
			// ... and no read on the way handed the session the whole transcript as one value.
			expect({ bytes: longest.bytes, what: longest.what, underBound: longest.bytes <= BOUND }).toMatchObject({
				underBound: true,
			});
			await client.end();
		});
	}
});
