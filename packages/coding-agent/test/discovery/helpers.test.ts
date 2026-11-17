import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, invalidate } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { loadFilesFromDir } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import * as natives from "@oh-my-pi/pi-natives";
import { parseFrontmatter, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { swapAfterListing } from "../helpers/swap-after-listing";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});
});

describe("loadFilesFromDir recursion", () => {
	let tempDir!: string;
	let ctx!: LoadContext;

	const write = (rel: string, content: string) => {
		const full = path.join(tempDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
	};

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loadfiles-recursion-"));
		ctx = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		// Top-level tool plus a Python-venv-style frontend asset nested below it,
		// mirroring the ~/.codex/tools/mineru/Lib/site-packages layout from #8552.
		write("my-tool.ts", "export default () => ({});\n");
		write(
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"window.matchMedia;\n",
		);
	});

	afterEach(() => {
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	const names = (dir: string, recursive?: boolean) =>
		loadFilesFromDir<{ name: string }>(ctx, dir, "test", "user", {
			extensions: ["ts", "js"],
			recursive,
			transform: (_name, _content, filePath) => ({ name: path.relative(dir, filePath) }),
		}).then(r => r.items.map(i => i.name).sort());

	// Regression for #8552: the non-recursive default must NOT descend into the
	// venv subtree. The native glob defaults recursive=true, so before the fix
	// `*.{ts,js}` was rewritten to `**/*.{ts,js}` and imported the Svelte asset.
	test("default scan stays top-level and skips the venv subtree", async () => {
		expect(await names(tempDir)).toEqual(["my-tool.ts"]);
	});

	test("recursive:true still walks the whole subtree", async () => {
		expect(await names(tempDir, true)).toEqual([
			path.join("mineru", "Lib", "site-packages", "gradio", "assets", "svelte", "media-query-D37ajmZt.js"),
			"my-tool.ts",
		]);
	});
});

describe("loadFilesFromDir reads below the walked directory", () => {
	let tempDir!: string;
	let dir!: string;
	let ctx!: LoadContext;

	beforeEach(() => {
		clearCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loadfiles-beneath-"));
		dir = path.join(tempDir, "commands");
		ctx = { cwd: tempDir, home: tempDir, repoRoot: tempDir };
		fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "outside", "sub"), { recursive: true });
		fs.writeFileSync(path.join(dir, "top.md"), "inside top\n");
		fs.writeFileSync(path.join(dir, "sub", "nested.md"), "inside nested\n");
		fs.writeFileSync(path.join(tempDir, "outside", "top.md"), "OUTSIDE top\n");
		fs.writeFileSync(path.join(tempDir, "outside", "sub", "nested.md"), "OUTSIDE nested\n");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearCache();
		removeSyncWithRetries(tempDir);
	});

	const load = () =>
		loadFilesFromDir<{ name: string; content: string }>(ctx, dir, "test", "user", {
			extensions: ["md"],
			recursive: true,
			transform: (_name, content, filePath) => ({ name: path.relative(dir, filePath), content }),
		});

	test("refuses a directory swapped for a symlink after the listing", async () => {
		const swap = swapAfterListing(() => {
			fs.renameSync(path.join(dir, "sub"), path.join(dir, "sub.moved"));
			fs.symlinkSync(path.join(tempDir, "outside", "sub"), path.join(dir, "sub"));
		});
		const result = await load();
		expect(swap.ran).toBe(true);
		expect(result.items.map(item => item.content).join("")).not.toContain("OUTSIDE");
		expect(result.items).toEqual([{ name: "top.md", content: "inside top\n" }]);
		expect(result.warnings).toEqual([`Failed to read file: ${path.join(dir, "sub", "nested.md")}`]);
	});

	test("refuses a file swapped for a symlink after the listing", async () => {
		const swap = swapAfterListing(() => {
			fs.rmSync(path.join(dir, "top.md"));
			fs.symlinkSync(path.join(tempDir, "outside", "top.md"), path.join(dir, "top.md"));
		});
		const result = await load();
		expect(swap.ran).toBe(true);
		expect(result.items.map(item => item.content).join("")).not.toContain("OUTSIDE");
		expect(result.items).toEqual([{ name: path.join("sub", "nested.md"), content: "inside nested\n" }]);
		expect(result.warnings).toEqual([`Failed to read file: ${path.join(dir, "top.md")}`]);
	});

	test("still loads a file the listing showed as a symlink", async () => {
		fs.writeFileSync(path.join(dir, "AGENTS.md"), "shared rules\n");
		fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
		fs.symlinkSync(path.join(tempDir, "outside", "top.md"), path.join(dir, "linked.md"));
		const result = await load();
		expect(result.warnings).toEqual([]);
		expect(result.items.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
			{ name: "AGENTS.md", content: "shared rules\n" },
			{ name: "CLAUDE.md", content: "shared rules\n" },
			{ name: "linked.md", content: "OUTSIDE top\n" },
			{ name: path.join("sub", "nested.md"), content: "inside nested\n" },
			{ name: "top.md", content: "inside top\n" },
		]);
	});

	test("reads each file once through the shared content cache", async () => {
		const reads = vi.spyOn(natives, "readFileBeneath");
		const first = await load();
		expect(reads).toHaveBeenCalledTimes(2);
		expect(await load()).toEqual(first);
		expect(reads).toHaveBeenCalledTimes(2);
		// The cache's own invalidation brings the next load back to the disk.
		fs.writeFileSync(path.join(dir, "top.md"), "changed\n");
		invalidate(path.join(dir, "top.md"));
		const changed = await load();
		expect(reads).toHaveBeenCalledTimes(3);
		expect(changed.items).toContainEqual({ name: "top.md", content: "changed\n" });
	});

	test("decodes each file as Bun.file().text() does, UTF-16 with a byte order mark included", async () => {
		const text = "---\ndescription: hi\n---\nbody\n";
		const utf16be = Buffer.from(text, "utf16le").swap16();
		const files = {
			"utf16le.md": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
			"utf16be.md": Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]),
			"utf8bom.md": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
			"invalid.md": Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]),
		};
		for (const [name, bytes] of Object.entries(files)) {
			fs.writeFileSync(path.join(dir, name), bytes);
		}
		const loaded = new Map((await load()).items.map(item => [item.name, item.content]));
		expect(loaded.get("utf16le.md")).toBe(text);
		for (const name of Object.keys(files)) {
			expect(loaded.get(name), name).toBe(await Bun.file(path.join(dir, name)).text());
		}
	});

	test("warns about a sparse file larger than memory and loads the others", async () => {
		const fd = fs.openSync(path.join(dir, "huge.md"), "w");
		try {
			fs.ftruncateSync(fd, 2 ** 50);
		} catch (error) {
			console.error(`UNKNOWN: no 1 PiB sparse file on this filesystem (${error}); the load was not checked`);
			return;
		} finally {
			fs.closeSync(fd);
		}
		const result = await load();
		expect(result.warnings).toEqual([`Failed to read file: ${path.join(dir, "huge.md")}`]);
		expect(result.items.map(item => item.name).sort()).toEqual([path.join("sub", "nested.md"), "top.md"]);
	});
});
