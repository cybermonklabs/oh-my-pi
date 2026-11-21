import type { Model } from "@oh-my-pi/pi-ai";

/** `notice` source of the session's reports that a closed route kept it from a model call. */
export const CYBER_POLICY_NOTICE_SOURCE = "cyber-policy";

/** A model call the closure kept from being sent. */
export interface CyberPolicyStop {
	readonly message: string;
}

/**
 * Whether a refusal closes `model`'s route: an OpenAI model, whichever provider serves it, and a
 * model whose family the catalog cannot tell (OpenAI's Daybreak models, a gateway's alias names),
 * which could be OpenAI. A model of a known other family stays open.
 */
export function closedByCyberPolicy(model: Pick<Model, "identity">): boolean {
	return model.identity.class === "openai" || model.identity.class === "unknown";
}

/** The message a session reports when the closure keeps it from a model call. */
export function cyberPolicyStopMessage(model: Pick<Model, "provider" | "id">): string {
	return `OpenAI refused this turn's content (cyber_policy); no request goes to ${model.provider}/${model.id} or another OpenAI route until your next prompt.`;
}

/**
 * The surface a session tree shares. {@link CyberPolicyClosure} implements it for the root; a
 * subagent worker holds a remote implementation over the root's closure
 * (`thread/services/runtime-remote.ts`).
 */
export interface CyberPolicyClosureApi {
	/** Whether a refusal holds the routes closed. */
	readonly active: boolean;
	/** Whether a request to `model` must not be sent now. */
	isClosed(model: Pick<Model, "identity"> | undefined): boolean;
	/** Records a `cyber_policy` refusal: OpenAI refused, whichever route carried the request. */
	record(): void;
	/** Calls `onChange` after {@link active} changes; returns the unsubscribe. */
	onChange(onChange: () => void): () => void;
}

/**
 * After OpenAI refuses a request's content for cyber policy (`cyber_policy`), each copy of that
 * content sent again to OpenAI adds a refusal to the organization's record, and repeated refusals
 * can revoke its access. The closure keeps every route {@link closedByCyberPolicy} closes away from
 * the whole session tree until the next prompt a person (or the harness on their behalf) sends;
 * only the root session ends it. The session's own prompts (job results, queued drains, hook
 * continuations, IRC deliveries, advisor turns), its subagents, title generation, memory
 * completions and the prompt-cache warmer keep it. A model of a known other family may still take
 * the work.
 */
export class CyberPolicyClosure implements CyberPolicyClosureApi {
	#active = false;
	readonly #listeners = new Set<() => void>();

	get active(): boolean {
		return this.#active;
	}

	isClosed(model: Pick<Model, "identity"> | undefined): boolean {
		return this.#active && model !== undefined && closedByCyberPolicy(model);
	}

	record(): void {
		if (this.#active) return;
		this.#active = true;
		this.#notify();
	}

	/** Ends the closure: the next prompt a person sends may reach OpenAI again. */
	end(): void {
		if (!this.#active) return;
		this.#active = false;
		this.#notify();
	}

	onChange(onChange: () => void): () => void {
		this.#listeners.add(onChange);
		return () => {
			this.#listeners.delete(onChange);
		};
	}

	#notify(): void {
		for (const listener of Array.from(this.#listeners)) listener();
	}
}
