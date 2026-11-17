import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

describe("write tool hashline header", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-hashline-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("inserts a fresh [path#TAG] header that maps to the written content", async () => {
		const filePath = path.join(tmpDir, "module.ts");
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const content = "export const value = 42;\nexport const flag = true;\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const lines = resultText(result).split("\n");

		// First line is the hashline header; subsequent text is the byte count.
		const match = HASHLINE_HEADER_LINE.exec(lines[0] ?? "");
		expect(match).not.toBeNull();
		const [, headerPath, tag] = match!;
		expect(headerPath).toBe(path.relative(tmpDir, filePath));
		expect(lines[1]).toBe(`Successfully wrote ${content.length} bytes to ${headerPath}`);

		// The tag must address a snapshot whose content matches what we wrote so a
		// follow-up edit can land without an extra `read` round-trip.
		const snapshot = getEditStore(session).byHashText(filePath, tag!);
		expect(snapshot).toBe(content);
	});

	it("reveals a line anchored under a write tag before editing it, then applies the identical retry", async () => {
		const filePath = path.join(tmpDir, "config.ts");
		const session = createSession(tmpDir);
		const content = "export const a = 1;\nexport const enabled = false;\nexport const c = 3;\n";

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";
		expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

		// The write displayed no line numbers, so the first anchored edit under its
		// tag shows the anchored line instead of trusting a guessed number.
		const edit = new EditTool(session, "hashline");
		const patchInput = `${headerLine}\nPUT 2.=2:\n+export const enabled = true;\n`;
		const refused = await edit.execute("call-2", { input: patchInput });
		expect(refused.isError).toBe(true);
		expect(resultText(refused)).toContain("never displayed");
		expect(resultText(refused)).toContain("2:export const enabled = false;");
		expect(await fs.readFile(filePath, "utf8")).toBe(content);

		// The reveal counts as displayed: the same call now applies without a read.
		const applied = await edit.execute("call-3", { input: patchInput });
		expect(applied.isError).not.toBe(true);
		expect(await fs.readFile(filePath, "utf8")).toBe(
			"export const a = 1;\nexport const enabled = true;\nexport const c = 3;\n",
		);
	});

	it("applies head and tail inserts under a write tag without a read", async () => {
		const filePath = path.join(tmpDir, "list.ts");
		const session = createSession(tmpDir);
		const content = "export const a = 1;\nexport const b = 2;\n";

		const writeResult = await new WriteTool(session).execute("call-1", { path: filePath, content });
		const headerLine = resultText(writeResult).split("\n")[0] ?? "";

		const result = await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT <1:\n+// head\nPUT >$:\n+export const z = 26;\n`,
		});
		expect(result.isError).not.toBe(true);
		expect(await fs.readFile(filePath, "utf8")).toBe(`// head\n${content}export const z = 26;\n`);
	});

	it("names a local:// write by its URL, and the header round-trips through edit and write", async () => {
		const session = createSession(tmpDir);
		const backingPath = path.join(tmpDir, "artifacts", "local", "notes.ts");
		const content = "export const enabled = false;\n";

		const writeResult = await new WriteTool(session).execute("call-1", { path: "local://notes.ts", content });
		const [headerLine = "", writeLine] = resultText(writeResult).split("\n");
		expect(HASHLINE_HEADER_LINE.exec(headerLine)?.[1]).toBe("local://notes.ts");
		expect(writeLine).toBe(`Successfully wrote ${content.length} bytes to local://notes.ts`);

		await new EditTool(session, "hashline").execute("call-2", {
			input: `${headerLine}\nPUT <1:\n+// notes\n`,
		});
		expect(await fs.readFile(backingPath, "utf8")).toBe("// notes\nexport const enabled = false;\n");

		// The URL-form header also addresses the same file as a `write` path.
		await new WriteTool(session).execute("call-3", { path: headerLine, content: "export const v = 2;\n" });
		expect(await fs.readFile(backingPath, "utf8")).toBe("export const v = 2;\n");
	});

	it("omits the hashline header when the edit mode is not hashline", async () => {
		const filePath = path.join(tmpDir, "plain.txt");
		const session = createSession(tmpDir);
		cfgEditMode.set(session.settings, "replace");
		const tool = new WriteTool(session);
		const content = "no anchors here\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		const text = resultText(result);
		expect(text.startsWith("[")).toBe(false);
		expect(text).toBe(`Successfully wrote ${content.length} bytes to ${path.relative(tmpDir, filePath)}`);
	});

	it("reports UTF-8 bytes, not JavaScript string length", async () => {
		const filePath = path.join(tmpDir, "notes.txt");
		const session = createSession(tmpDir);
		cfgEditMode.set(session.settings, "replace");
		const tool = new WriteTool(session);
		const content = "café\n";

		const result = await tool.execute("call-1", { path: filePath, content });
		expect(resultText(result)).toBe(`Successfully wrote 6 bytes to ${path.relative(tmpDir, filePath)}`);
	});

	it("writes numbered data verbatim but still strips copied read rows", async () => {
		const session = createSession(tmpDir);
		const tool = new WriteTool(session);
		const dump = "100000000: 30 00 00 54 bc.eq 0x100000004\n100000004: c0 03 5f d6 ret\n";
		const dumpPath = path.join(tmpDir, "disassembly.txt");
		const dumpResult = await tool.execute("call-1", { path: dumpPath, content: dump });
		expect(resultText(dumpResult)).not.toContain("auto-stripped");
		expect(await Bun.file(dumpPath).text()).toBe(dump);

		const echoPath = path.join(tmpDir, "echo.ts");
		await tool.execute("call-2", { path: echoPath, content: "1:const a = 1;\n2:const b = 2;\n" });
		expect(await Bun.file(echoPath).text()).toBe("const a = 1;\nconst b = 2;\n");
	});
});
