import { describe, expect, it } from "bun:test";
import { formatPrCheckoutResult } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout";

type CheckoutResult = Parameters<typeof formatPrCheckoutResult>[0];

const base: CheckoutResult = {
	data: {
		number: 7,
		url: "https://github.com/o/r/pull/7",
		headRefName: "fix",
		baseRefName: "main",
	} as CheckoutResult["data"],
	localBranch: "pr-7",
	worktreePath: "/w/pr-7",
	remoteName: "origin",
	remoteUrl: "https://github.com/o/r.git",
	reused: false,
};

describe("formatPrCheckoutResult", () => {
	it("carries the worktree add's notes into the tool result", () => {
		const note = "worktree /w/pr-7 is still locked: could not remove /r/locked: Permission denied";
		const text = formatPrCheckoutResult({ ...base, notes: [note] });
		expect(text).toContain(`Notes:\n- ${note}`);
	});

	it("adds no notes section when the add had none", () => {
		expect(formatPrCheckoutResult({ ...base, notes: [] })).not.toContain("Notes:");
		expect(formatPrCheckoutResult(base)).not.toContain("Notes:");
	});
});
