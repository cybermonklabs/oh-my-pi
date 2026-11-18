import { describe, expect, it } from "bun:test";
import { LiteralIndex } from "@oh-my-pi/pi-coding-agent/secrets/literal-index";

/** The whole message of the refusal: it names the rule and holds no part of the literal. */
const ASCII_ONLY = /^A case-insensitive literal index holds only ASCII literals$/;

describe("LiteralIndex", () => {
	it("refuses a non-ASCII literal under ignoreCase, shorter or longer than a key, and finds an ASCII literal in upper case", () => {
		// Under 32 characters a literal is its whole key; over 32, the key is its first 32 characters.
		const shortNonAscii = "café-lantern";
		const longNonAscii = `${"a".repeat(32)}É-tail`;
		expect(() => new LiteralIndex([shortNonAscii], { ignoreCase: true })).toThrow(ASCII_ONLY);
		expect(() => new LiteralIndex([longNonAscii], { ignoreCase: true })).toThrow(ASCII_ONLY);

		const shortAscii = "harbor-quill-01";
		const longAscii = `${"meadow-".repeat(6)}orchard`;
		const index = new LiteralIndex([shortAscii, longAscii], { ignoreCase: true });
		const found = [shortAscii, longAscii, "neither-literal"].map(text =>
			index.test(`seen ${text.toUpperCase()} here`),
		);
		expect(found).toEqual([true, true, false]);
	});
});
