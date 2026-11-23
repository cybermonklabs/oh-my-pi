import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A built-in command an RPC client sends in a `prompt` frame is input from outside the session: the runtime
// RPC mode builds for it carries `origin: "outside"`, so the client's `/compact` ends a cyber-policy hold as a
// person's does. The fixture records the options its session's compaction received.
describe("RPC built-in command origin", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-builtin-origin-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "compact-origin-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		await client.start();
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("runs a client's /compact with the origin of input from outside", async () => {
		await client.promptAndWait("/compact focus on the parser");

		const lines = (await Bun.file(path.join(directory, "compact-calls.jsonl")).text()).trim().split("\n");
		expect(lines.map(line => JSON.parse(line))).toEqual([{ instructions: "focus on the parser", origin: "outside" }]);
	}, 30_000);
});
