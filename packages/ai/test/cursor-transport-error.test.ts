import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("Cursor transport errors", () => {
	it("surfaces a TLS handshake reset as a stream error", async () => {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-tls-reset.ts")], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			// Marked as a test child, so it reads none of the home's dotenv files (packages/utils/src/env.ts).
			env: { ...process.env, PI_TEST_RUNTIME: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			eventTypes: ["start", "error"],
			stopReason: "error",
		});
	}, 60_000);
});
