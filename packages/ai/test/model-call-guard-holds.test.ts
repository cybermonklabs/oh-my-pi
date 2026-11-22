import { afterEach, describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { addModelCallGuard, ModelCallRefusedError } from "@oh-my-pi/pi-ai/model-call-guard";
import { CodexSteerPump } from "@oh-my-pi/pi-ai/providers/openai-codex/live-steering";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type {
	Api,
	AssistantMessage,
	Context,
	DispatchHold,
	FetchImpl,
	LiveSteering,
	Model,
} from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
	fetchAuthorizedAtWire,
	transportFetch,
	type WireAuthorization,
	withoutDispatchHold,
} from "@oh-my-pi/pi-ai/utils/transport-fetch";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

/**
 * A send that waits on the caller's dispatch hold (`/pause`) reads the model-call guards in the same step as the
 * send, after the hold: a refusal another call of the session tree records while the send waits holds it, and
 * nothing goes out. Each control answers the hold with no refusal, and the send goes out. Synthetic sends only.
 */
const HOLD = "held: cyber_policy";
const CASES = [
	["sends nothing when a refusal is recorded while the hold waits", true],
	["sends when the hold answers with no refusal (control)", false],
] as const;

/** A guard that holds `model` once `held()` is true, and a hold that records the refusal as it waits. */
function holdThatRefuses(model: Model<Api>, refused: boolean) {
	let held = false;
	const removeGuard = addModelCallGuard({
		refuse: candidate => (held && candidate.id === model.id ? HOLD : undefined),
	});
	const hold: DispatchHold = async () => {
		await Bun.sleep(1);
		// Another call of the session tree meets a refusal while this send waits.
		if (refused) held = true;
	};
	return { hold, removeGuard };
}

const model = getBundledModel("openai", "gpt-5-mini") as Model<Api>;

describe("the transport fetch behind a dispatch hold", () => {
	it.each(CASES)("%s", async (_name, refused) => {
		const { hold, removeGuard } = holdThatRefuses(model, refused);
		let sent = 0;
		const base: FetchImpl = async () => {
			sent++;
			return new Response("{}", { status: 200 });
		};
		try {
			const fetchImpl = transportFetch(model, base, hold);
			const request = fetchImpl("https://api.example.test/v1/responses", { method: "POST", body: "{}" });
			if (refused) {
				await expect(request).rejects.toBeInstanceOf(ModelCallRefusedError);
				expect(sent).toBe(0);
				// Unheld traffic (a workflow stop, a cancellation, a token mint) still goes out.
				const unheld = await withoutDispatchHold(fetchImpl)("https://api.example.test/v1/cancel", {
					method: "POST",
					body: "{}",
				});
				expect(unheld.status).toBe(200);
				expect(sent).toBe(1);
			} else {
				expect((await request).status).toBe(200);
				expect(sent).toBe(1);
			}
		} finally {
			removeGuard();
		}
	});
});

// A direct caller of pi-ai's transports has no dispatch hold, but a request with a wire authorization (a Codex
// attestation, a Vertex token, a Bedrock signature) still awaits that authorization after the provider's read. The
// transport fetch reads the model-call guards in the same step as the send whenever it awaited one, so a refusal
// recorded while the authorization is made holds the request. The control authorizes with no refusal.
describe("the transport fetch behind a wire authorization, with no hold", () => {
	it.each([
		["sends nothing when a refusal is recorded while the request is authorized", true],
		["sends when the authorization answers with no refusal (control)", false],
	] as const)("%s", async (_name, refused) => {
		let held = false;
		const removeGuard = addModelCallGuard({
			refuse: candidate => (held && candidate.id === model.id ? HOLD : undefined),
		});
		let sent = 0;
		const base: FetchImpl = async () => {
			sent++;
			return new Response("{}", { status: 200 });
		};
		const authorize: WireAuthorization = async init => {
			await Bun.sleep(1);
			// Another call of the session tree meets a refusal while this request is authorized.
			if (refused) held = true;
			return init;
		};
		try {
			const request = fetchAuthorizedAtWire(
				transportFetch(model, base),
				"https://api.example.test/v1/responses",
				{ method: "POST", body: "{}" },
				authorize,
			);
			if (refused) {
				await expect(request).rejects.toBeInstanceOf(ModelCallRefusedError);
				expect(sent).toBe(0);
			} else {
				expect((await request).status).toBe(200);
				expect(sent).toBe(1);
			}
		} finally {
			removeGuard();
		}
	});
});

describe("a Codex steer behind a dispatch hold", () => {
	it.each(CASES)("%s", async (_name, refused) => {
		const { hold, removeGuard } = holdThatRefuses(model, refused);
		const settled: string[] = [];
		let claimed = false;
		const source: LiveSteering = {
			wait: async () => {},
			claim: async () => {
				if (claimed) return undefined;
				claimed = true;
				return {
					messages: [{ role: "user", content: "steer", timestamp: 1 }],
					accept: () => settled.push("accepted"),
					reject: () => settled.push("rejected"),
				};
			},
		};
		const steers: unknown[] = [];
		const socket = {
			steer: async (previousResponseId: string, input: unknown[]) => {
				steers.push({ previousResponseId, input });
				return { accepted: true as const, id: "steer_1" };
			},
		};
		try {
			const pump = new CodexSteerPump(source, socket, () => [{ role: "user", content: "steer" }] as never, {
				hold,
				model,
			});
			pump.start("resp_1");
			for (let attempt = 0; attempt < 200 && settled.length === 0; attempt++) await Bun.sleep(1);
			const outcome = await pump.finish();
			if (refused) {
				expect(steers).toHaveLength(0);
				expect(settled).toEqual(["rejected"]);
				expect(outcome.submitted).toBe(false);
			} else {
				expect(steers).toHaveLength(1);
				expect(settled).toEqual(["accepted"]);
			}
		} finally {
			removeGuard();
		}
	});
});

describe("the provider-dispatch chokepoint behind a dispatch hold", () => {
	const SOURCE_ID = "model-call-guard-holds-test";
	const api = "model-call-guard-holds" as Api;
	const chokepointModel = {
		...model,
		id: "model-call-guard-holds",
		api,
		provider: "model-call-guard-holds",
	} as Model<Api>;
	const context: Context = { messages: [{ role: "user", content: "go", timestamp: 0 }] };

	afterEach(() => {
		unregisterCustomApis(SOURCE_ID);
	});

	it.each(CASES)("%s", async (_name, refused) => {
		let dispatched = 0;
		registerCustomApi(
			api,
			() => {
				dispatched++;
				const events = new AssistantMessageEventStream();
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api,
					provider: chokepointModel.provider,
					model: chokepointModel.id,
					timestamp: 0,
					stopReason: "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
				queueMicrotask(() => events.push({ type: "done", reason: "stop", message }));
				return events;
			},
			SOURCE_ID,
		);
		const { hold, removeGuard } = holdThatRefuses(chokepointModel, refused);
		try {
			const result = await stream(chokepointModel, context, { beforeDispatch: hold }).result();
			if (refused) {
				expect(dispatched).toBe(0);
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain(HOLD);
			} else {
				expect(dispatched).toBe(1);
				expect(result.stopReason).toBe("stop");
			}
		} finally {
			removeGuard();
		}
	});
});
