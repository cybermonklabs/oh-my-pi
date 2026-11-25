/**
 * The dashboard's JSON view (`JsonBlock`, the span drawer's "Raw entry" and the request drawer's payloads) shows a
 * transcript entry nested as deep as a session line holds (400,000 levels), where `JSON.stringify(data, null, 2)`
 * ran out of stack while rendering, and pi-utils' JSON writer it uses runs in the browser bundle.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { stringifyJsonIteratively } from "@oh-my-pi/pi-utils/json";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { act } from "react";
import { clientBundlePlugins } from "../src/client-bundle";
import { JsonBlock } from "../src/client/ui/JsonBlock";
import { nestedChain, nestedChainJson } from "../../ai/test/helpers/deep-nesting";
import { mountDomRoot, tearDownDomRoot } from "./helpers/dom-root";

afterEach(tearDownDomRoot);

/** The text of the `<code>` a JsonBlock of `data` renders. */
async function renderedJson(data: unknown): Promise<string | null | undefined> {
	const root = await mountDomRoot();
	await act(async () => {
		root.render(<JsonBlock data={data} title="Raw entry" />);
	});
	return document.querySelector("code")?.textContent;
}

describe("JsonBlock", () => {
	it("indents an entry as before, and shows one nested past 1,000 levels on one line", async () => {
		const shallow = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
		expect(await renderedJson(shallow)).toBe(JSON.stringify(shallow, null, 2));

		const deep = nestedChain();
		expect((await renderedJson(deep)) === stringifyJsonIteratively(deep)).toBe(true);
	}, 20_000);
});

describe("the dashboard's browser bundle", () => {
	// Bun's browser target gives `node:util/types` no exports, so without the bundle plugin the writer's
	// boxed-primitive checks are not functions and every deep entry fails to render in the browser.
	it("runs pi-utils' JSON writer: boxed primitives unwrapped, a 50,000-level value written", async () => {
		const built = await Bun.build({
			entrypoints: [path.join(import.meta.dir, "fixtures", "browser-json-entry.ts")],
			target: "browser",
			plugins: clientBundlePlugins,
		});
		expect(built.success).toBe(true);
		using dir = TempDir.createSync("@omp-stats-browser-json-");
		const bundle = path.join(dir.path(), "entry.js");
		await Bun.write(bundle, await built.outputs[0].text());

		const printed = await $`${process.execPath} ${bundle}`.quiet().nothrow();

		expect(printed.stderr.toString()).toBe("");
		expect(JSON.parse(printed.stdout.toString())).toEqual({
			boxed: '{"n":5,"b":true,"s":"x","plain":{"a":[1]}}',
			deepLength: nestedChainJson().length,
		});
	}, 20_000);
});
