import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Judge, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";
import { tokenUsage } from "@oh-my-pi/pi-ai";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import { runCascade } from "../../src/tools/jfind/cascade";
import { readText } from "../../src/tools/jfind/text";
import { listFiles, resolveSearchRoot } from "../../src/tools/jfind/tree";
import { swapAfterListing } from "../helpers/swap-after-listing";

describe("linked find candidates", () => {
	let dir: string;
	let scope: string;
	let filesystem: InternalUrlFilesystem;
	const source = "export function linkedSource() { return 1; }\n";

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfind-linked-files-")));
		scope = path.join(dir, "scope");
		await fs.mkdir(scope);
		await Bun.write(path.join(dir, "target.ts"), source);
		await fs.utimes(path.join(dir, "target.ts"), 1_600_000_000, 1_600_000_000);
		await fs.symlink(path.join(dir, "target.ts"), path.join(scope, "source.ts"), "file");
		filesystem = new InternalUrlFilesystem({ context: { cwd: dir }, tier: "read" });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("reports a filtered linked file's target size and mtime instead of missing metadata", async () => {
		for (const sortByMtime of [false, true]) {
			const result = await glob({
				path: scope,
				pattern: "*",
				fileType: FileType.File,
				gitignore: false,
				sortByMtime,
			});
			expect(result.matches).toEqual([
				{
					path: "source.ts",
					fileType: FileType.File,
					size: Buffer.byteLength(source),
					mtime: 1_600_000_000_000,
					symlink: true,
				},
			]);
		}
	});

	it("lists and reads a nonempty linked file without constructing a judge, including a linked root", async () => {
		await fs.symlink(scope, path.join(dir, "linked-root"), "dir");
		for (const rootPath of [scope, path.join(dir, "linked-root")]) {
			const root = await resolveSearchRoot(filesystem, rootPath, dir);
			const entries = await listFiles(root, { filesystem: filesystem.shellFilesystem(), includeHidden: false });
			expect(entries).toEqual([
				{
					path: path.join(rootPath, "source.ts"),
					rel: "source.ts",
					size: source.length,
					root: rootPath,
					symlink: true,
				},
			]);
			expect((await readText(filesystem, entries[0]!, 1000)).text).toBe(source);
		}
	});

	it("still excludes empty, dangling, hidden, credential, and binary linked entries", async () => {
		await Bun.write(path.join(dir, "empty.ts"), "");
		await fs.symlink(path.join(dir, "empty.ts"), path.join(scope, "empty.ts"), "file");
		await fs.symlink(path.join(dir, "absent.ts"), path.join(scope, "dangling.ts"), "file");
		for (const name of [".hidden.ts", ".env", "private.pem", "image.png"]) {
			await fs.symlink(path.join(dir, "target.ts"), path.join(scope, name), "file");
		}
		const entries = await listFiles(
			{ path: scope, type: "directory" },
			{ filesystem: filesystem.shellFilesystem(), includeHidden: false },
		);
		expect(entries.map(entry => entry.rel)).toEqual(["source.ts"]);
		const hidden = await listFiles(
			{ path: scope, type: "directory" },
			{ filesystem: filesystem.shellFilesystem(), includeHidden: true },
		);
		expect(hidden.map(entry => entry.rel)).toEqual([".hidden.ts", "source.ts"]);
	});

	it("admits the linked candidate to the fake judge and makes no requests for an empty candidate set", async () => {
		const judge = new AcceptingJudge();
		const result = await runCascade({
			root: { path: scope, type: "directory" },
			filesystem,
			query: "linked source",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		expect(result.stats.listed).toBe(1);
		expect(result.hits.map(hit => hit.rel)).toEqual(["source.ts"]);
		expect(judge.requests).toBeGreaterThan(0);
		await fs.unlink(path.join(scope, "source.ts"));
		const emptyJudge = new AcceptingJudge();
		const empty = await runCascade({
			root: { path: scope, type: "directory" },
			filesystem,
			query: "linked source",
			extraKeywords: [],
			judge: emptyJudge,
			includeHidden: false,
		});
		expect(empty.stats.listed).toBe(0);
		expect(emptyJudge.requests).toBe(0);
	});
});

describe("find reads below the walked root", () => {
	let dir: string;
	let scope: string;
	let filesystem: InternalUrlFilesystem;

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jfind-beneath-")));
		scope = path.join(dir, "scope");
		await fs.mkdir(path.join(scope, "sub"), { recursive: true });
		await fs.mkdir(path.join(dir, "outside", "sub"), { recursive: true });
		const files = {
			"scope/top.ts": "inside top",
			"scope/sub/nested.ts": "inside nested",
			"outside/top.ts": "OUTSIDE top",
			"outside/sub/nested.ts": "OUTSIDE nested",
		};
		for (const [rel, text] of Object.entries(files)) {
			await Bun.write(path.join(dir, rel), `export function linkedSource() { return "${text}"; }\n`);
		}
		filesystem = new InternalUrlFilesystem({ context: { cwd: dir }, tier: "read" });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** The files `find` reports, and everything it sent the judge. */
	async function find(): Promise<{ hits: string[]; sent: string }> {
		const judge = new RecordingJudge();
		const result = await runCascade({
			root: { path: scope, type: "directory" },
			filesystem,
			query: "linked source",
			extraKeywords: [],
			judge,
			includeHidden: false,
		});
		return { hits: result.hits.map(hit => hit.rel).sort(), sent: judge.sent.join("\n") };
	}

	it("reads both listed files when nothing is swapped", async () => {
		const { hits, sent } = await find();
		expect(hits).toEqual(["sub/nested.ts", "top.ts"]);
		expect(sent).toContain("inside nested");
	});

	it("refuses a directory swapped for a symlink after the listing", async () => {
		const swap = swapAfterListing(
			async () => {
				await fs.rename(path.join(scope, "sub"), path.join(scope, "sub.moved"));
				await fs.symlink(path.join(dir, "outside", "sub"), path.join(scope, "sub"), "dir");
			},
			options => options.path === scope,
		);
		const { hits, sent } = await find();
		expect(swap.ran).toBe(true);
		expect(sent).not.toContain("OUTSIDE");
		expect(hits).toEqual(["top.ts"]);
	});

	it("refuses a file swapped for a symlink after the listing", async () => {
		const swap = swapAfterListing(
			async () => {
				await fs.rm(path.join(scope, "top.ts"));
				await fs.symlink(path.join(dir, "outside", "top.ts"), path.join(scope, "top.ts"), "file");
			},
			options => options.path === scope,
		);
		const { hits, sent } = await find();
		expect(swap.ran).toBe(true);
		expect(sent).not.toContain("OUTSIDE");
		expect(hits).toEqual(["sub/nested.ts"]);
	});
});

class AcceptingJudge implements Judge {
	readonly label = "accepting-fixture";
	requests = 0;

	async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.requests++;
		const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: 0.9 }]));
		return {
			api: "typesafe",
			provider: "fake",
			model: "fake",
			answers: answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(100, 0, 0.001),
		};
	}
}

/** Accepts everything, and keeps each request it was sent. */
class RecordingJudge extends AcceptingJudge {
	readonly sent: string[] = [];

	override async judge<Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
		this.sent.push(JSON.stringify(request));
		return super.judge(request);
	}
}
