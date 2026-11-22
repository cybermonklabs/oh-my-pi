import { addModelCallGuard, type Model, ModelCallRefusedError } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";

/**
 * Whether a refusal closes `model`'s route: an OpenAI model, whichever provider serves it, and a
 * model whose family the catalog cannot tell (OpenAI's Daybreak models, a gateway's alias names),
 * which could be OpenAI. A model of a known other family stays open.
 */
export function closedByCyberPolicy(model: Pick<Model, "identity">): boolean {
	return model.identity.class === "openai" || model.identity.class === "unknown";
}

const HOLD_PREFIX = "OpenAI refused content of this session (cyber_policy); no request goes to ";

/** Why the process's model-call guard held a request to `model`. Names `cyber_policy`, so the error is not retried. */
export function cyberPolicyHoldMessage(model: Pick<Model, "provider" | "id">): string {
	return `${HOLD_PREFIX}${model.provider}/${model.id} or another OpenAI route until the root session's next input from outside it.`;
}

function isHeldCall(link: unknown): boolean {
	if (link instanceof ModelCallRefusedError) return true;
	const text =
		link instanceof Error
			? link.message
			: typeof link === "object" && link !== null && "errorMessage" in link && typeof link.errorMessage === "string"
				? link.errorMessage
				: "";
	return text.startsWith(HOLD_PREFIX);
}

/**
 * Whether `outcome` is a refusal to record: OpenAI's own `cyber_policy` refusal. A call the hold itself
 * held names the code too (so nothing retries it), anywhere in its cause chain; recording it would start
 * the hold again after a person's input ended it, with no new refusal.
 */
export function isRecordableCyberPolicyRefusal(outcome: unknown): boolean {
	if (!AIError.isCyberPolicyRefusal(outcome)) return false;
	const seen = new Set<unknown>();
	for (let link: unknown = outcome; link !== undefined && link !== null && !seen.has(link);) {
		seen.add(link);
		if (isHeldCall(link)) return false;
		link = link instanceof Error ? link.cause : undefined;
	}
	return true;
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
 * can revoke its access. The closure holds every route {@link closedByCyberPolicy} closes. The root
 * session owns it; its subagents share it. Only input that crosses the root session's outer boundary
 * (`origin: "outside"`: a person, or the harness or an RPC client on their behalf) ends it; input made
 * inside the session (loops, job results, queued drains, extensions without that origin, other agents'
 * messages, advisor turns) keeps it. {@link installCyberPolicyGuard} enforces it at the process's
 * model-call checkpoint and records the refusals that checkpoint sees.
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

	/** Ends the closure: requests may reach OpenAI again. */
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

const installed = new Map<CyberPolicyClosureApi, { holders: number; remove: () => void }>();

/**
 * Enforces `closure` at the process's model-call checkpoint (`addModelCallGuard` in pi-ai), which every
 * model call passes: while the closure holds, a request to a closed route is held (an error naming
 * `cyber_policy`, no request sent), whichever caller makes it, a run already in flight included. Every
 * `cyber_policy` refusal a call meets is recorded. One guard per closure, however many sessions of
 * the tree hold it; returns the release.
 *
 * The closure is the guard's scope: a session enters it for its agent's runs and its own work
 * (`runInModelCallScope`), so the guard sees that tree's calls and the calls made outside every
 * scope, never another tree's. A call outside every scope (a host's own call outside any session)
 * is held while any tree's closure holds, and its refusal closes every tree's routes: in a process
 * that runs several session trees (an SDK host, an ACP agent, a server), that errs toward sending
 * nothing.
 */
export function installCyberPolicyGuard(closure: CyberPolicyClosureApi): () => void {
	let entry = installed.get(closure);
	if (!entry) {
		const remove = addModelCallGuard(
			{
				refuse: model => (closure.isClosed(model) ? cyberPolicyHoldMessage(model) : undefined),
				settled: (_model, outcome) => {
					if (isRecordableCyberPolicyRefusal(outcome)) closure.record();
				},
			},
			closure,
		);
		entry = { holders: 0, remove };
		installed.set(closure, entry);
	}
	entry.holders++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = installed.get(closure);
		if (!current || --current.holders > 0) return;
		current.remove();
		installed.delete(closure);
	};
}
