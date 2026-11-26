/**
 * The tester's red test: the committed export viewer manifest pins the viewer that the
 * committed sources build. The root package.json's `prepare` runs `gen:export-viewer`, which checks
 * the manifest under CI=true, and `ci:release:build-binaries` checks it with `--check`. So a stale
 * pin fails `bun install` in CI (the sami release workflow's bun-install step among them) and the
 * release build, and a release's exported HTML names a hosted viewer whose bytes are not the ones
 * its integrity attribute pins.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildExportViewer, type ExportViewerMetadata } from "../scripts/build-export-viewer";

const manifestPath = path.join(import.meta.dir, "../../coding-agent/src/export/html/viewer.generated.json");
const temp = TempDir.createSync("@omp-export-viewer-pin-");

afterAll(() => temp[Symbol.dispose]());

describe("the committed export viewer manifest", () => {
	it("pins the exact viewer the committed sources build", async () => {
		const committed: ExportViewerMetadata = await Bun.file(manifestPath).json();
		const built = await buildExportViewer({
			outDir: temp.path(),
			metadataPath: path.join(temp.path(), "built.json"),
		});
		expect(built).toEqual(committed);
	}, 30_000);
});
