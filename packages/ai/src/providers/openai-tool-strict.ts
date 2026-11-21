import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";
import { $env } from "@oh-my-pi/pi-utils";
import type { Api, Model, Tool } from "../types";
import {
	adaptSchemaForStrict,
	flattenExclusiveRequiredRootUnion,
	NO_STRICT,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";

/** The OpenAI APIs whose requests declare function tools with a `strict` flag. */
export type OpenAIToolsApi = "openai-completions" | "openai-responses" | "openai-codex-responses";

/** The model APIs whose requests go out on an {@link OpenAIToolsApi}: those, and `openrouter`. */
export type OpenAIToolsModelApi = OpenAIToolsApi | "openrouter";

/** The compat fields that decide a function tool's `strict` flag and schema: the compat the request goes out with. */
export type OpenAIStrictToolsCompat = Partial<
	Pick<ResolvedOpenAICompat, "supportsStrictMode" | "toolStrictMode" | "rejectRootObjectUnion" | "toolSchemaFlavor">
>;

/** What decides how an OpenAI request declares its function tools. */
export interface OpenAIToolsRequest {
	/** The API the request goes out on. */
	api: OpenAIToolsApi;
	/** The compat the request goes out with. */
	compat: OpenAIStrictToolsCompat;
	/** Responses and Codex: a tool with a `customFormat` goes out as a freeform custom tool, not a function. */
	freeformApplyPatch?: boolean;
	/** Responses and Codex: the native computer tool goes out as `{ type: "computer" }`, not a function. */
	computerUse?: boolean;
	/** Chat completions and Responses: the provider's strict-tools fallback after the endpoint rejected strict tools. */
	disableStrictTools?: boolean;
	/** `PI_NO_STRICT`; the value read when the module loaded ({@link NO_STRICT}) unless given. */
	noStrict?: boolean;
}

/** A function tool as an OpenAI request declares it. */
export interface OpenAIFunctionToolDeclaration {
	/**
	 * `true`: `strict: true`; `false`: `strict: false`, which some backends read otherwise than no flag (#4336);
	 * `undefined`: no flag.
	 */
	strict: boolean | undefined;
	/**
	 * The parameter schema it goes out with, strict-adapted when `strict` is `true`, before chat completions applies
	 * the compat's schema flavor and each API drops a tool whose schema the provider rejects.
	 */
	parameters: Record<string, unknown>;
}

/** Whether `model`'s requests go out on an {@link OpenAIToolsApi}. */
export function isOpenAIToolsModel(model: Model<Api>): model is Model<OpenAIToolsModelApi> {
	return (
		model.api === "openai-completions" ||
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "openrouter"
	);
}

/**
 * The API `model`'s main requests go out on: an `openrouter` model's go out on Responses, or on chat completions under
 * `PI_OPENROUTER_RESPONSES=0`, as `stream` routes them.
 */
export function openAIToolsApi(model: Model<OpenAIToolsModelApi>): OpenAIToolsApi {
	if (model.api !== "openrouter") return model.api;
	return $env.PI_OPENROUTER_RESPONSES !== "0" ? "openai-responses" : "openai-completions";
}

/**
 * The request `model`'s main requests declare their tools with, under no strict-tools fallback, on the API
 * {@link openAIToolsApi} gives.
 */
export function openAIToolsRequest(model: Model<OpenAIToolsModelApi>): OpenAIToolsRequest {
	return {
		api: openAIToolsApi(model),
		compat: model.compat,
		freeformApplyPatch: model.applyPatchToolType === "freeform",
		// Codex subscription models default to the function fallback. Explicit metadata remains authoritative for
		// future Codex endpoints that implement GA computer use.
		computerUse: model.supportsComputerUse === true,
	};
}

/**
 * The function tools `request` declares from `tools`, index-aligned; `undefined` for a tool it declares otherwise
 * ({@link nonFunctionTool}). `PI_NO_STRICT` asks for no strict tool on any API, and the strict-tools fallback sends
 * none on chat completions and Responses. Those two send the flag only where `compat.supportsStrictMode` is not
 * `false` (#4527); chat completions sends none under `compat.toolStrictMode: "none"`, every tool strict or none under
 * `"all_strict"` (none unless each tool's schema can be made strict), and keeps a tool's own `strict: false`, which
 * some backends read otherwise than no flag (#4336), only under `"mixed"`, `PI_NO_STRICT` or not. Codex asks for
 * strict only for a tool marked `strict: true`. A tool asked for strict goes out `strict: true` only when its schema
 * can be made strict. The providers build their function tools from it, and the agent's declared-tools fingerprint
 * reads its flags ({@link openAIStrictnessHashedTools}), so the two cannot drift.
 */
export function openAIFunctionTools(
	request: OpenAIToolsRequest,
	tools: readonly Tool[],
): (OpenAIFunctionToolDeclaration | undefined)[] {
	switch (request.api) {
		case "openai-completions":
			return chatCompletionsFunctionTools(request, tools);
		case "openai-responses":
			return tools.map(tool => {
				if (nonFunctionTool(request, tool)) return undefined;
				const requested = requestedStrict(request, tool);
				const sanitized = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
				const flattened = request.compat.rejectRootObjectUnion
					? flattenExclusiveRequiredRootUnion(sanitized)
					: sanitized;
				// MFJS must run AFTER the Responses sanitizer: the sanitizer normalizes `{}` → `true` (issue #1179), and
				// Moonshot's validator rejects boolean subschemas ("property schema … must be an object"), so the
				// Moonshot pass re-coerces them last.
				const schema =
					request.compat.toolSchemaFlavor === "moonshot-mfjs"
						? (normalizeSchemaForMoonshot(flattened) as Record<string, unknown>)
						: flattened;
				return declaration(requested, adaptSchemaForStrict(schema, requested === true));
			});
		case "openai-codex-responses":
			return tools.map(tool => {
				if (nonFunctionTool(request, tool)) return undefined;
				const requested = requestedStrict(request, tool);
				const schema = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool), { repairArrayItems: true });
				return declaration(requested, adaptSchemaForStrict(schema, requested === true));
			});
	}
}

/**
 * How a Responses or Codex request declares `tool` other than as a function tool: `"computer"`, as the native computer
 * tool (`{ type: "computer" }`); `"custom"`, as a freeform custom tool in its `customFormat`; `undefined` for a
 * function tool.
 */
export function nonFunctionTool(request: OpenAIToolsRequest, tool: Tool): "computer" | "custom" | undefined {
	if (tool.native?.type === "computer" && request.computerUse === true) return "computer";
	if (request.freeformApplyPatch === true && tool.customFormat) return "custom";
	return undefined;
}

/** A tool as a strictness-aware hash reads it: `strict: null` stands for no flag where it has one by default. */
export type StrictnessHashedTool = Omit<Tool, "strict"> & { strict?: boolean | null };

/**
 * `tools` as a hash of what `model`'s next main request declares reads them, so the hash changes exactly when
 * `PI_NO_STRICT` or the strict-tools fallback changes a flag the request sends (the `all_strict` collapse included,
 * from {@link openAIFunctionTools}): each tool as it is where it goes out with the flag it has under default settings
 * (`PI_NO_STRICT` unset, no fallback), so the hash under default settings is the one taken before strictness counted;
 * otherwise with `strict` set to the flag it goes out with, `null` for none. Those settings only take strictness away,
 * so the flag set here never matches a tool's own and the two never stand for the same wire. The model's compat
 * decides both sides: a compat change between processes is not seen. `tools` itself under default settings.
 */
export function openAIStrictnessHashedTools(
	model: Model<OpenAIToolsModelApi>,
	tools: readonly Tool[],
	settings: { disableStrictTools?: boolean; noStrict?: boolean } = {},
): readonly StrictnessHashedTool[] {
	const noStrict = settings.noStrict ?? NO_STRICT;
	const disableStrictTools = settings.disableStrictTools === true;
	if (!noStrict && !disableStrictTools) return tools;
	const request = openAIToolsRequest(model);
	const sent = openAIFunctionTools({ ...request, noStrict, disableStrictTools }, tools);
	const byDefault = openAIFunctionTools({ ...request, noStrict: false }, tools);
	return tools.map((tool, index) => {
		const strict = sent[index]?.strict;
		return strict === byDefault[index]?.strict ? tool : { ...tool, strict: strict ?? null };
	});
}

function chatCompletionsFunctionTools(
	request: OpenAIToolsRequest,
	tools: readonly Tool[],
): OpenAIFunctionToolDeclaration[] {
	const { compat } = request;
	const adapted = tools.map(tool => {
		const requested = requestedStrict(request, tool);
		const base = compat.rejectRootObjectUnion
			? flattenExclusiveRequiredRootUnion(toolWireSchema(tool))
			: toolWireSchema(tool);
		return { requested, base, ...adaptSchemaForStrict(base, requested === true) };
	});
	const allStrict = compat.toolStrictMode === "all_strict";
	const mode =
		request.disableStrictTools ||
		compat.toolStrictMode === "none" ||
		(allStrict && !adapted.every(tool => tool.strict))
			? "none"
			: allStrict
				? "all_strict"
				: "mixed";
	return adapted.map(({ requested, base, schema, strict }) =>
		mode === "all_strict" || (mode === "mixed" && strict)
			? { strict: true, parameters: schema }
			: { strict: requested === false ? false : undefined, parameters: base },
	);
}

/** A Responses or Codex function tool asked for strict as `requested`, whose schema adapted to `adapted`. */
function declaration(
	requested: boolean | undefined,
	adapted: { schema: Record<string, unknown>; strict: boolean },
): OpenAIFunctionToolDeclaration {
	return { strict: adapted.strict ? true : requested === false ? false : undefined, parameters: adapted.schema };
}

/**
 * The flag `request` asks `tool` to go out with, before its schema is adapted: `true` strict, `false` marked
 * `strict: false`, `undefined` no flag.
 */
function requestedStrict(request: OpenAIToolsRequest, tool: Tool): boolean | undefined {
	const noStrict = request.noStrict ?? NO_STRICT;
	const { compat, disableStrictTools } = request;
	switch (request.api) {
		case "openai-codex-responses":
			return noStrict ? undefined : tool.strict;
		case "openai-responses":
			return noStrict || disableStrictTools || compat.supportsStrictMode === false
				? undefined
				: tool.strict !== false;
		case "openai-completions":
			if (disableStrictTools || compat.supportsStrictMode === false || compat.toolStrictMode === "none") {
				return undefined;
			}
			if (tool.strict === false) return compat.toolStrictMode === "all_strict" ? undefined : false;
			return noStrict ? undefined : true;
	}
}
