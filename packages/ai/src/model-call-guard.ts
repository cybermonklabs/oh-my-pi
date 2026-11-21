import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, AssistantMessage, Model, Usage } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

/**
 * A process-wide check on model calls. Every chat call passes {@link stream} or {@link streamSimple}
 * (`complete` and `completeSimple` go through them), and image generation, speech synthesis and
 * native judgments pass their own entries; each consults the registered guards before the request
 * is built. A host can so hold a model for every caller at once, a run already in flight included,
 * without each caller checking for itself.
 *
 * A guard registered with a scope sees only the calls made inside {@link runInModelCallScope} with
 * that scope, and the calls made outside every scope; a guard without one sees every call. So one
 * host's guard does not hold another host's calls in the same process when both enter their scopes.
 */
export interface ModelCallGuard {
	/** A reason when no request may go to `model` now; `undefined` lets the call through. */
	refuse(model: Model<Api>): string | undefined;
	/**
	 * Sees how every call it let through ended: a stream's final message (a failed one included), or
	 * the error a request threw.
	 */
	settled?(model: Model<Api>, outcome: unknown): void;
}

/** A model call a {@link ModelCallGuard} held: no request was sent. Its message is the guard's reason. */
export class ModelCallRefusedError extends Error {
	readonly provider: string;
	readonly model: string;

	constructor(model: Model<Api>, reason: string) {
		super(reason);
		this.name = "ModelCallRefusedError";
		this.provider = model.provider;
		this.model = model.id;
	}
}

interface GuardEntry {
	readonly guard: ModelCallGuard;
	readonly scope: object | undefined;
}

const guards = new Set<GuardEntry>();
const scopeStorage = new AsyncLocalStorage<object>();

/**
 * Registers `guard` for the model calls of this process: with `scope`, only those made inside that
 * scope or outside every scope. Returns its removal.
 */
export function addModelCallGuard(guard: ModelCallGuard, scope?: object): () => void {
	const entry: GuardEntry = { guard, scope };
	guards.add(entry);
	return () => {
		guards.delete(entry);
	};
}

/** Runs `fn` with `scope` as the scope of every model call it makes, across its awaits and timers. */
export function runInModelCallScope<T>(scope: object | undefined, fn: () => T): T {
	return scope === undefined ? fn() : scopeStorage.run(scope, fn);
}

function applicable(): GuardEntry[] {
	const scope = scopeStorage.getStore();
	const entries = Array.from(guards);
	return scope === undefined ? entries : entries.filter(entry => entry.scope === undefined || entry.scope === scope);
}

function refusal(entries: readonly GuardEntry[], model: Model<Api>): string | undefined {
	for (const { guard } of entries) {
		const reason = guard.refuse(model);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

function report(entries: readonly GuardEntry[], model: Model<Api>, outcome: unknown): void {
	for (const { guard } of entries) guard.settled?.(model, outcome);
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A call a guard held: no request, one error naming the guard's reason. */
function refusedCall(model: Model<Api>, reason: string): AssistantMessageEventStream {
	const events = new AssistantMessageEventStream();
	const failure: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: reason,
		timestamp: Date.now(),
	};
	events.push({ type: "start", partial: failure });
	events.push({ type: "error", reason: "error", error: failure });
	return events;
}

/**
 * Runs the streaming `call` unless a guard that sees it holds `model`, and reports the call's final
 * message to those guards before the caller's consumer sees the final event.
 */
export function guardModelCall(
	model: Model<Api>,
	call: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (guards.size === 0) return call();
	const entries = applicable();
	const reason = refusal(entries, model);
	if (reason !== undefined) return refusedCall(model, reason);
	const events = call();
	events.result().then(
		message => report(entries, model, message),
		error => report(entries, model, error),
	);
	return events;
}

/**
 * Runs `request` unless a guard that sees it holds `model` (then rejects with
 * {@link ModelCallRefusedError}), and reports an error it throws to those guards before the caller
 * sees it.
 */
export async function guardModelRequest<T>(model: Model<Api>, request: () => Promise<T>): Promise<T> {
	if (guards.size === 0) return request();
	const entries = applicable();
	const reason = refusal(entries, model);
	if (reason !== undefined) throw new ModelCallRefusedError(model, reason);
	try {
		return await request();
	} catch (error) {
		report(entries, model, error);
		throw error;
	}
}
