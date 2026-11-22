/**
 * How an Anthropic messages request declares each tool's `input_schema`, `strict` and `eager_input_streaming`,
 * without loading the provider: the provider builds its tools from {@link anthropicWireToolFields}, and the agent's
 * declared-tools fingerprint reads the same flags ({@link anthropicStrictnessHashedTools}), so the two cannot drift.
 */
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import type { Model, Tool } from "../types";
import { isRecord } from "../utils";
import { COMBINATOR_KEYS, NO_STRICT, toolWireSchema } from "../utils/schema";
import { spillToDescription } from "../utils/schema/spill";
import { withoutDisabledExperimentalBetas } from "./anthropic-beta-kill-switch";
import { resolveAnthropicBaseUrl } from "./anthropic-http-options";
import type { ToolInputSchema as AnthropicToolInputSchema } from "./anthropic-wire";
import type { StrictnessHashedTool } from "./openai-tool-strict";

/**
 * Whether a request on `model` to `effectiveBaseUrl` sends each tool's `eager_input_streaming` flag
 * ({@link anthropicWireToolFields}): read off the compat the request goes out with, so Claude Code's experimental-beta
 * kill switch turns it off ({@link withoutDisabledExperimentalBetas}).
 */
export function anthropicEagerInputStreaming(
	model: Model<"anthropic-messages">,
	effectiveBaseUrl: string | undefined,
): boolean {
	if (!model.compat.supportsEagerToolInputStreaming) return false;
	// First-party Anthropic endpoints accept the per-tool flag.
	if (isOfficialAnthropicApiUrl(effectiveBaseUrl)) return true;
	// Non-official effective endpoint. `supportsEagerToolInputStreaming` may be
	// stale-true here because compat is materialized once at build time and is
	// never rebuilt for a baseUrl-only reroute — either a runtime provider
	// override (`pi.registerProvider("anthropic", { baseUrl })`) or Foundry
	// (`CLAUDE_CODE_USE_FOUNDRY`). Both leave the canonical model's resolved
	// compat in place. `officialEndpoint` records whether compat was built for
	// the canonical Anthropic URL, so only endpoints whose compat was authored
	// for a non-official host (an explicit `compat.supportsEagerToolInputStreaming`
	// opt-in on a custom `baseUrl`) still send the field.
	return !model.compat.officialEndpoint;
}

/** What decides how an Anthropic request declares its tools' schemas and per-tool flags. */
export interface AnthropicToolsRequest {
	/**
	 * No tool goes out strict: the compat the request goes out with disables strict tools, or the provider's
	 * strict-tools fallback after the endpoint rejected them.
	 */
	disableStrictTools?: boolean;
	/** `PI_NO_STRICT`; the value read when the module loaded ({@link NO_STRICT}) unless given. */
	noStrict?: boolean;
	/** The request sends each tool's `eager_input_streaming` flag ({@link anthropicEagerInputStreaming}). */
	eagerInputStreaming?: boolean;
}

/** A tool as an Anthropic request declares it, its name, description and deferral aside. */
export interface AnthropicWireToolFields {
	/** The `input_schema` it goes out with, strict-normalized when {@link strict} is set. */
	inputSchema: AnthropicToolInputSchema;
	/** It goes out with `strict: true`; without the flag otherwise. */
	strict: boolean;
	/** The `eager_input_streaming` flag it goes out with; `undefined` for none. */
	eagerInputStreaming: boolean | undefined;
}

/**
 * The request `model`'s main requests to `baseUrl` declare their tools with: strict tools off where the compat the
 * request goes out with disables them or `disableStrictTools` (the provider's strict-tools fallback) holds, and the
 * eager flag where {@link anthropicEagerInputStreaming} allows it.
 */
export function anthropicToolsRequest(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
	disableStrictTools = false,
): AnthropicToolsRequest {
	return {
		disableStrictTools: disableStrictTools || model.compat.disableStrictTools === true,
		eagerInputStreaming: anthropicEagerInputStreaming(model, baseUrl),
	};
}

/**
 * A tool as a hash of what an Anthropic request declares reads it ({@link anthropicStrictnessHashedTools}): `strict:
 * null` stands for no flag where it has one by default, `eagerInputStreaming: null` for no `eager_input_streaming`
 * where it has one by default.
 */
export type AnthropicHashedTool = StrictnessHashedTool & { eagerInputStreaming?: boolean | null };

/**
 * `tools` as a hash of what `model`'s next main request declares reads them, so the hash changes exactly when
 * `PI_NO_STRICT`, the strict-tools fallback (`settings.disableStrictTools`) or Claude Code's experimental-beta kill
 * switch changes a flag the request sends ({@link anthropicWireToolFields}): each tool as it is where it goes out with
 * the `strict` and `eager_input_streaming` flags it has under default settings (`PI_NO_STRICT` unset, no fallback, the
 * switch off), so the hash under default settings is the one taken before the flags counted; otherwise with each flag
 * that differs set to the one it goes out with, `null` for none. Those settings only take flags away, so a flag set
 * here never matches a tool's own and the two never stand for the same wire. The model's compat decides both sides: a
 * compat change between processes is not seen. `tools` itself under default settings.
 */
export function anthropicStrictnessHashedTools(
	model: Model<"anthropic-messages">,
	tools: readonly Tool[],
	settings: { disableStrictTools?: boolean; noStrict?: boolean } = {},
): readonly AnthropicHashedTool[] {
	const noStrict = settings.noStrict ?? NO_STRICT;
	const disableStrictTools = settings.disableStrictTools === true;
	const sentModel = withoutDisabledExperimentalBetas(model);
	if (!noStrict && !disableStrictTools && sentModel === model) return tools;
	const baseUrl = resolveAnthropicBaseUrl(model);
	const sent = anthropicWireToolFields(
		{ ...anthropicToolsRequest(sentModel, baseUrl, disableStrictTools), noStrict },
		tools,
	);
	const byDefault = anthropicWireToolFields({ ...anthropicToolsRequest(model, baseUrl), noStrict: false }, tools);
	return tools.map((tool, index) => {
		const { strict, eagerInputStreaming } = sent[index];
		const strictChanged = strict !== byDefault[index].strict;
		const eagerChanged = eagerInputStreaming !== byDefault[index].eagerInputStreaming;
		if (!strictChanged && !eagerChanged) return tool;
		return {
			...tool,
			...(strictChanged ? { strict: strict ? true : null } : {}),
			...(eagerChanged ? { eagerInputStreaming: eagerInputStreaming ?? null } : {}),
		};
	});
}

/**
 * JSON Schema whitelist for Anthropic tool `input_schema` nodes.
 *
 * Tracks the Anthropic Python SDK's `lib/_parse/_transform.py::transform_schema`,
 * with live Messages API guardrails for keywords the SDK preserves but the API rejects.
 * We keep only structural/metadata keywords Anthropic's validator honors, and demote
 * anything else into the node's `description` as `\n\n{key: value, ...}` so the model
 * still sees the constraint as a natural-language hint.
 *
 * `Set` (not `Record<string, true>`) because membership is probed against arbitrary
 * user/Zod-derived schema keys: a literal Record would falsely match prototype names
 * like `"toString"` and silently strip valid properties.
 */
const ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP = new Set([
	"$ref",
	"$defs",
	"$schema",
	"definitions",
	"type",
	"anyOf",
	"allOf",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"nullable",
]);
/** Keys preserved on `type: "object"` nodes (in addition to the universal set). */
const ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP = new Set(["properties", "required", "additionalProperties"]);
/** Keys preserved on `type: "array"` nodes; `minItems` only when its value is 0 or 1. */
const ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP = new Set(["items", "prefixItems", "minItems"]);
/** Keys preserved on `type: "string"` nodes; `format` only when its value is in the supported list. */
const ANTHROPIC_TOOL_SCHEMA_STRING_KEEP = new Set(["format"]);
/**
 * String `format` values Anthropic accepts; everything else (including `pattern`-style
 * format hints) gets demoted into `description`. Matches `SupportedStringFormats` in the
 * Anthropic SDK's `_transform.py`.
 */
const ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"uri",
	"ipv4",
	"ipv6",
	"uuid",
]);
// Not `bash`: strict decoding fixes property order, so an optional key declared
// before one the model has already written can no longer be emitted, and bash's
// `timeout` vanished from every `async`-first call.
// `yield` carries a subagent's whole structured result. Its properties (`type`,
// `data`, `error`) are declared in the order callers write them; schema-less and
// workpool yields report `strict: false`. Strict only holds together with buffered
// input streaming (see ANTHROPIC_BUFFERED_INPUT_TOOLS).
const ANTHROPIC_STRICT_TOOL_ALLOWLIST = new Set(["python", "edit", "find", "yield"]);
const MAX_ANTHROPIC_STRICT_TOOLS = 20;
const MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS = 24;
const MAX_ANTHROPIC_STRICT_UNION_PARAMETERS = 16;
// Tools sent with `eager_input_streaming: false`, so the API buffers and validates
// their input. Eagerly streamed `yield` input from Claude Haiku arrived as invalid
// JSON (a large nested result closed with one brace too many) even with `strict`
// set; buffered, it did not. Where the per-tool flag is unsupported, their presence
// drops the request-wide fine-grained streaming beta instead.
export const ANTHROPIC_BUFFERED_INPUT_TOOLS: ReadonlySet<string> = new Set(["yield"]);

/** `minItems` / `maxItems` apply to arrays; Anthropic rejects them on `type: "object"` (including `minItems: 0`/`1`). */
function isJsonSchemaArrayNode(schema: Record<string, unknown>): boolean {
	const t = schema.type;
	if (t === "array") return true;
	if (Array.isArray(t) && t.includes("array") && !t.includes("object")) return true;
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return true;
	return false;
}

function isJsonSchemaObjectNode(schema: Record<string, unknown>): boolean {
	if (isJsonSchemaArrayNode(schema)) return false;
	if (schema.type === "object") return true;
	if (Array.isArray(schema.type) && schema.type.includes("object")) return true;
	if (isRecord(schema.properties)) return true;
	return false;
}

/**
 * Pick the principal non-null scalar type from a `type` keyword. Anthropic accepts
 * `type` as either a single string or an array (e.g. `["number", "null"]` for a
 * nullable value); the SDK whitelist is keyed off the scalar type, with `"null"`
 * ignored so nullable variants are normalized as their underlying type.
 */
function pickAnthropicScalarType(type: unknown): string | undefined {
	if (typeof type === "string") return type;
	if (Array.isArray(type)) {
		for (const entry of type) {
			if (typeof entry === "string" && entry !== "null") return entry;
		}
	}
	return undefined;
}
function pickAnthropicEffectiveScalarType(schema: Record<string, unknown>): string | undefined {
	const explicit = pickAnthropicScalarType(schema.type);
	if (explicit) return explicit;
	if (isRecord(schema.properties)) return "object";
	if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return "array";
	return undefined;
}

function anthropicPerTypeKeep(scalarType: string | undefined): Set<string> | undefined {
	switch (scalarType) {
		case "object":
			return ANTHROPIC_TOOL_SCHEMA_OBJECT_KEEP;
		case "array":
			return ANTHROPIC_TOOL_SCHEMA_ARRAY_KEEP;
		case "string":
			return ANTHROPIC_TOOL_SCHEMA_STRING_KEEP;
		default:
			return undefined;
	}
}

/**
 * Normalize a JSON Schema node for Anthropic tool `input_schema`.
 *
 * Applies the full whitelist semantics from the Anthropic Python SDK's
 * `lib/_parse/_transform.py::transform_schema`:
 *
 * 1. Universal keys (`$ref`, `$defs`, `type`, `anyOf`, `allOf`, `enum`, `const`,
 *    `description`, `title`, `default`, `nullable`) are preserved on every node, with
 *    one position-dependent exception: the combinator keys. Root `anyOf`/`allOf` are
 *    spilled (recent Anthropic Messages validators reject combinators at the tool
 *    `input_schema` root) but kept when nested; `oneOf` is spilled at every position
 *    (it is not in the documented supported subset).
 * 2. Per-type keys are kept additively (object → `properties`/`required`/`additionalProperties`,
 *    array → `items`/`prefixItems` plus `minItems` only when 0 or 1, string → `format`
 *    only when in the supported value set).
 * 3. Everything else is demoted into the node's `description` as `\n\n{key: value, ...}`
 *
 * Object nodes default to `additionalProperties: false`, but explicit open-map
 * declarations (`additionalProperties: true` or a schema literal — Zod's
 * `z.record(z.string(), z.unknown())` produces `{}`) are preserved. The strict-mode
 * pass downstream demotes those shapes to non-strict instead of fabricating a closed
 * object, so callers like the resolve tool keep working open-map semantics.
 */
function normalizeAnthropicToolSchemaNode(
	schema: unknown,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
	isRoot = false,
): unknown {
	if (Array.isArray(schema)) return schema.map(entry => normalizeAnthropicToolSchemaNode(entry, cache));
	if (!isRecord(schema)) return schema;

	const existing = cache.get(schema);
	if (existing !== undefined) return existing;

	const result: Record<string, unknown> = {};
	cache.set(schema, result);

	const scalarType = pickAnthropicEffectiveScalarType(schema);
	const perTypeKeep = anthropicPerTypeKeep(scalarType);
	const spill: Array<[string, unknown]> = [];

	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];
		const isRootCombinator = isRoot && COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]);
		if (!isRootCombinator && (ANTHROPIC_TOOL_SCHEMA_UNIVERSAL_KEEP.has(key) || perTypeKeep?.has(key))) {
			result[key] = value;
		} else {
			spill.push([key, value]);
		}
	}

	// Per-type conditional keys: prune within the kept set.
	if (scalarType === "string") {
		const format = result.format;
		if (typeof format === "string" && !ANTHROPIC_TOOL_SCHEMA_STRING_FORMATS.has(format)) {
			spill.push(["format", format]);
			delete result.format;
		}
	}
	if (scalarType === "array" && result.minItems !== undefined) {
		const minItems = result.minItems;
		if (!(typeof minItems === "number" && (minItems === 0 || minItems === 1))) {
			spill.push(["minItems", minItems]);
			delete result.minItems;
		}
	}
	if (scalarType === "object" && result.additionalProperties === undefined) {
		result.additionalProperties = false;
	}

	// Recurse on structural keys.
	if (isRecord(result.properties)) {
		const normalizedProperties: Record<string, unknown> = {};
		const sourceProperties = result.properties as Record<string, unknown>;
		for (const propName in sourceProperties) {
			if (!Object.hasOwn(sourceProperties, propName)) continue;
			normalizedProperties[propName] = normalizeAnthropicToolSchemaNode(sourceProperties[propName], cache);
		}
		result.properties = normalizedProperties;
	}
	if (isRecord(result.additionalProperties)) {
		const normalized = normalizeAnthropicToolSchemaNode(result.additionalProperties, cache);
		if (isRecord(normalized) && Object.keys(normalized).length === 0) {
			result.additionalProperties = true;
		} else {
			result.additionalProperties = normalized;
		}
	}
	if (Array.isArray(result.items)) {
		result.items = result.items.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	} else if (isRecord(result.items)) {
		result.items = normalizeAnthropicToolSchemaNode(result.items, cache);
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(item => normalizeAnthropicToolSchemaNode(item, cache));
	}
	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (Array.isArray(variants)) {
			result[key] = variants.map(variant => normalizeAnthropicToolSchemaNode(variant, cache));
		}
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefs: Record<string, unknown> = {};
		const sourceDefs = definitions as Record<string, unknown>;
		for (const name in sourceDefs) {
			if (!Object.hasOwn(sourceDefs, name)) continue;
			normalizedDefs[name] = normalizeAnthropicToolSchemaNode(sourceDefs[name], cache);
		}
		result[defsKey] = normalizedDefs;
	}

	spillToDescription(result, spill);
	return result;
}

function stringEntries(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Whether a root combinator variant can merge into the root object. `allOf` branches
 * may be open (every branch must hold, so an open one loosens nothing); an open
 * `anyOf`/`oneOf` variant admits any value for keys other variants declare.
 */
function isFoldableAnthropicRootVariant(variant: unknown, conjunctive: boolean): variant is Record<string, unknown> {
	if (!isRecord(variant)) return false;
	const type = pickAnthropicEffectiveScalarType(variant);
	if (type !== undefined && type !== "object") return false;
	if (variant.$ref !== undefined || variant.not !== undefined || variant.if !== undefined) return false;
	if (COMBINATOR_KEYS.some(key => variant[key] !== undefined)) return false;
	return conjunctive || variant.additionalProperties === undefined || variant.additionalProperties === false;
}

/**
 * Fold root `anyOf`/`oneOf`/`allOf` object variants into the root object.
 *
 * Messages rejects combinators at the tool `input_schema` root, so
 * {@link normalizeAnthropicToolSchemaNode} spills them into `description`. Without
 * this fold a pure root union reaches the wire as a closed object with no
 * properties, which admits only `{}`. The folded root admits every value the
 * union admits:
 * - properties merge; a key declared differently by several variants keeps every
 *   declaration under a nested `anyOf` (`allOf` for a root `allOf`);
 * - `required` gains the keys every `anyOf`/`oneOf` variant requires, or every
 *   key any `allOf` branch requires;
 * - variants that cannot merge (non-object, `$ref`, nested combinators, open
 *   `anyOf`/`oneOf` members) open the root with `additionalProperties: true`.
 *
 * The exact union still reaches the model through the spilled description, and
 * {@link validateToolArguments} enforces it against the original tool schema.
 */
function foldAnthropicRootCombinators(schema: Record<string, unknown>): Record<string, unknown> {
	const rootType = pickAnthropicEffectiveScalarType(schema);
	if (rootType !== undefined && rootType !== "object") return schema;
	if (!COMBINATOR_KEYS.some(key => Array.isArray(schema[key]) && schema[key].length > 0)) return schema;

	const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {};
	const required = new Set(stringEntries(schema.required));
	let open = false;
	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants) || variants.length === 0) continue;
		const conjunctive = key === "allOf";
		if (!variants.every(variant => isFoldableAnthropicRootVariant(variant, conjunctive))) {
			open = true;
			continue;
		}

		const declared = new Map<string, unknown[]>();
		let shared: Set<string> | undefined;
		for (const variant of variants) {
			if (isRecord(variant.properties)) {
				for (const name in variant.properties) {
					if (!Object.hasOwn(variant.properties, name)) continue;
					const propertySchema = variant.properties[name];
					const declarations = declared.get(name) ?? [];
					if (!declarations.some(entry => Bun.deepEquals(entry, propertySchema)))
						declarations.push(propertySchema);
					declared.set(name, declarations);
				}
			}
			const variantRequired = stringEntries(variant.required);
			if (conjunctive) {
				for (const name of variantRequired) required.add(name);
			} else {
				shared = new Set(shared ? variantRequired.filter(name => shared?.has(name)) : variantRequired);
			}
			if (variant.additionalProperties !== undefined && variant.additionalProperties !== false) open = true;
		}
		for (const name of shared ?? []) required.add(name);
		// A key the root (or an earlier combinator) already declares keeps that
		// declaration: both must hold, so either alone admits every valid value.
		for (const [name, declarations] of declared) {
			if (Object.hasOwn(properties, name)) continue;
			properties[name] =
				declarations.length === 1 ? declarations[0] : { [conjunctive ? "allOf" : "anyOf"]: declarations };
		}
	}

	const folded: Record<string, unknown> = { ...schema };
	if (Object.keys(properties).length > 0 || isRecord(schema.properties)) folded.properties = properties;
	if (required.size > 0) folded.required = [...required];
	if (open && folded.additionalProperties === undefined && isRecord(folded.properties)) {
		folded.additionalProperties = true;
	}
	return folded;
}

/**
 * Normalize a tool parameter schema into an Anthropic `input_schema`: root
 * combinators fold into the root object ({@link foldAnthropicRootCombinators}),
 * then {@link normalizeAnthropicToolSchemaNode} applies the keyword whitelist.
 */
export function normalizeAnthropicToolSchema(schema: unknown): unknown {
	const root = isRecord(schema) ? foldAnthropicRootCombinators(schema) : schema;
	return normalizeAnthropicToolSchemaNode(root, new WeakMap(), true);
}

type AnthropicStrictBudget = {
	optionalRemaining: number;
	unionRemaining: number;
	optionalCount: number;
	unionCount: number;
};

type AnthropicStrictSchemaResult = {
	schema: Record<string, unknown>;
	optionalCount: number;
	unionCount: number;
};

function hasAnthropicUnionType(schema: Record<string, unknown>): boolean {
	return Array.isArray(schema.type) || Array.isArray(schema.anyOf);
}

function hasNullVariant(schema: Record<string, unknown>): boolean {
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some(variant => isRecord(variant) && variant.type === "null");
}
function hasAnthropicSchemaDefiningKeyword(schema: Record<string, unknown>): boolean {
	if (
		schema.type !== undefined ||
		schema.properties !== undefined ||
		schema.additionalProperties !== undefined ||
		schema.items !== undefined ||
		schema.prefixItems !== undefined ||
		schema.enum !== undefined ||
		schema.const !== undefined ||
		schema.$ref !== undefined
	) {
		return true;
	}
	for (const key of COMBINATOR_KEYS) {
		if (schema[key] !== undefined) return true;
	}
	return schema.$defs !== undefined || schema.definitions !== undefined;
}

function makeAnthropicNullableSchema(schema: unknown, budget: AnthropicStrictBudget): unknown | undefined {
	if (isRecord(schema)) {
		if (hasNullVariant(schema)) return schema;
		if (Array.isArray(schema.anyOf)) {
			return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
		}
		if (Array.isArray(schema.type)) {
			return { ...schema, type: [...schema.type, "null"] };
		}
	}

	if (budget.unionRemaining <= 0) return undefined;
	budget.unionRemaining--;
	budget.unionCount++;
	return { anyOf: [schema, { type: "null" }] };
}

function normalizeAnthropicStrictSchemaNode(
	schema: unknown,
	budget: AnthropicStrictBudget,
	cache: WeakMap<Record<string, unknown>, AnthropicStrictSchemaResult | null>,
): unknown | undefined {
	if (Array.isArray(schema)) {
		const result: unknown[] = [];
		for (const entry of schema) {
			const normalized = normalizeAnthropicStrictSchemaNode(entry, budget, cache);
			if (normalized === undefined) return undefined;
			result.push(normalized);
		}
		return result;
	}

	if (!isRecord(schema)) return schema;

	const cached = cache.get(schema);
	if (cached === null) return undefined;
	if (
		cached !== undefined &&
		cached.optionalCount <= budget.optionalRemaining &&
		cached.unionCount <= budget.unionRemaining
	) {
		// JSON repeats shared nodes; Anthropic charges every serialized occurrence.
		budget.optionalRemaining -= cached.optionalCount;
		budget.optionalCount += cached.optionalCount;
		budget.unionRemaining -= cached.unionCount;
		budget.unionCount += cached.unionCount;
		return cached.schema;
	}

	// Re-normalize an overflowing occurrence so optionals can become nullable-required.
	if (!hasAnthropicSchemaDefiningKeyword(schema)) return undefined;

	// Strict tool use only supports closed objects. Open maps stay available on
	// the non-strict schema plan instead of producing an Anthropic 400.
	if (isJsonSchemaObjectNode(schema) && schema.additionalProperties !== false) {
		return undefined;
	}

	const result: Record<string, unknown> = { ...schema };
	const optionalCountBefore = budget.optionalCount;
	const unionCountBefore = budget.unionCount;
	// An unfinished entry denotes a cycle, not a reusable serialized subtree.
	cache.set(schema, null);

	if (hasAnthropicUnionType(result)) {
		if (budget.unionRemaining <= 0) return undefined;
		budget.unionRemaining--;
		budget.unionCount++;
	}

	if (isRecord(result.properties)) {
		const originalRequired = new Set(
			Array.isArray(result.required)
				? result.required.filter((entry): entry is string => typeof entry === "string")
				: [],
		);
		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const [propertyName, propertySchema] of Object.entries(result.properties)) {
			const normalizedProperty = normalizeAnthropicStrictSchemaNode(propertySchema, budget, cache);
			if (normalizedProperty === undefined) return undefined;

			if (originalRequired.has(propertyName)) {
				properties[propertyName] = normalizedProperty;
				required.push(propertyName);
				continue;
			}

			if (budget.optionalRemaining > 0) {
				budget.optionalRemaining--;
				budget.optionalCount++;
				properties[propertyName] = normalizedProperty;
				continue;
			}

			const nullableProperty = makeAnthropicNullableSchema(normalizedProperty, budget);
			if (nullableProperty === undefined) return undefined;
			properties[propertyName] = nullableProperty;
			required.push(propertyName);
		}

		result.properties = properties;
		result.required = required;
	}

	if (Array.isArray(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	} else if (isRecord(result.items)) {
		const items = normalizeAnthropicStrictSchemaNode(result.items, budget, cache);
		if (items === undefined) return undefined;
		result.items = items;
	}
	if (Array.isArray(result.prefixItems)) {
		const prefixItems = normalizeAnthropicStrictSchemaNode(result.prefixItems, budget, cache);
		if (prefixItems === undefined) return undefined;
		result.prefixItems = prefixItems;
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = result[key];
		if (!Array.isArray(variants)) continue;
		const normalizedVariants = normalizeAnthropicStrictSchemaNode(variants, budget, cache);
		if (normalizedVariants === undefined) return undefined;
		result[key] = normalizedVariants;
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const definitions = result[defsKey];
		if (!isRecord(definitions)) continue;
		const normalizedDefinitions: Record<string, unknown> = {};
		for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
			const normalizedDefinition = normalizeAnthropicStrictSchemaNode(definitionSchema, budget, cache);
			if (normalizedDefinition === undefined) return undefined;
			normalizedDefinitions[definitionName] = normalizedDefinition;
		}
		result[defsKey] = normalizedDefinitions;
	}

	cache.set(schema, {
		schema: result,
		optionalCount: budget.optionalCount - optionalCountBefore,
		unionCount: budget.unionCount - unionCountBefore,
	});
	return result;
}

const ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS = [
	"oneOf",
	"allOf",
	"$ref",
	"patternProperties",
	"propertyNames",
] as const;

/**
 * Anthropic's strict grammar subset supports anyOf/type-array unions only.
 * oneOf/allOf/$ref compile unpredictably (rejections arrive as 400s the
 * grammar-too-large fallback does not recognize, so they would hard-fail the
 * turn), and patternProperties/propertyNames describe open key sets that the
 * strict pipeline's injected `additionalProperties: false` would contradict.
 * Runs against the raw wire schema — the base normalizer spills several of
 * these keywords into the description, erasing the evidence.
 */
function hasAnthropicStrictIncompatibleKeyword(schema: unknown, seen = new Set<object>()): boolean {
	if (Array.isArray(schema)) {
		if (seen.has(schema)) return false;
		seen.add(schema);
		return schema.some(entry => hasAnthropicStrictIncompatibleKeyword(entry, seen));
	}
	if (!isRecord(schema)) return false;
	if (seen.has(schema)) return false;
	seen.add(schema);
	for (const keyword of ANTHROPIC_STRICT_INCOMPATIBLE_KEYWORDS) {
		if (schema[keyword] !== undefined) return true;
	}
	return Object.values(schema).some(value => hasAnthropicStrictIncompatibleKeyword(value, seen));
}

function normalizeAnthropicStrictSchema(
	schema: Record<string, unknown>,
	optionalRemaining: number,
	unionRemaining: number,
): AnthropicStrictSchemaResult | undefined {
	const budget: AnthropicStrictBudget = {
		optionalRemaining,
		unionRemaining,
		optionalCount: 0,
		unionCount: 0,
	};
	const normalized = normalizeAnthropicStrictSchemaNode(schema, budget, new WeakMap());
	if (!isRecord(normalized)) return undefined;
	return { schema: normalized, optionalCount: budget.optionalCount, unionCount: budget.unionCount };
}

function buildAnthropicBaseToolInputSchema(tool: Tool): Record<string, unknown> {
	const jsonSchema = toolWireSchema(tool);
	return normalizeAnthropicToolSchema({
		...jsonSchema,
		type: "object",
		properties: isRecord(jsonSchema.properties) ? jsonSchema.properties : {},
		required: stringEntries(jsonSchema.required),
	}) as Record<string, unknown>;
}

/**
 * The schema and flags `request` declares each of `tools` with, index-aligned. A tool goes out strict only when it is
 * on the strict allowlist, not marked `strict: false`, its schema uses no keyword strict decoding rejects and, in wire
 * order, it fits the request-wide strict budgets (tools, optional and union parameters); `PI_NO_STRICT` and
 * `request.disableStrictTools` send none. Where `request.eagerInputStreaming` holds, every tool carries
 * `eager_input_streaming`, `false` for one whose input the API must buffer ({@link ANTHROPIC_BUFFERED_INPUT_TOOLS}).
 * The provider builds its tools from it, and the agent's declared-tools fingerprint reads its flags
 * ({@link anthropicStrictnessHashedTools}).
 */
export function anthropicWireToolFields(
	request: AnthropicToolsRequest,
	tools: readonly Tool[],
): AnthropicWireToolFields[] {
	const eager = request.eagerInputStreaming === true;
	const fields = tools.map((tool): AnthropicWireToolFields => ({
		inputSchema: buildAnthropicBaseToolInputSchema(tool) as AnthropicToolInputSchema,
		strict: false,
		eagerInputStreaming: eager ? !ANTHROPIC_BUFFERED_INPUT_TOOLS.has(tool.name) : undefined,
	}));
	if ((request.noStrict ?? NO_STRICT) || request.disableStrictTools) return fields;

	const candidateIndexes = tools.flatMap((tool, index) => {
		if (!ANTHROPIC_STRICT_TOOL_ALLOWLIST.has(tool.name)) return [];
		if (tool.strict === false) return [];
		if (hasAnthropicStrictIncompatibleKeyword(toolWireSchema(tool))) return [];
		return [index];
	});

	let strictToolCount = 0;
	let strictOptionalParameterCount = 0;
	let strictUnionParameterCount = 0;
	for (const index of candidateIndexes) {
		if (strictToolCount >= MAX_ANTHROPIC_STRICT_TOOLS) break;

		const strictResult = normalizeAnthropicStrictSchema(
			fields[index].inputSchema as Record<string, unknown>,
			MAX_ANTHROPIC_STRICT_OPTIONAL_PARAMETERS - strictOptionalParameterCount,
			MAX_ANTHROPIC_STRICT_UNION_PARAMETERS - strictUnionParameterCount,
		);
		if (!strictResult) continue;

		fields[index] = {
			...fields[index],
			inputSchema: strictResult.schema as AnthropicToolInputSchema,
			strict: true,
		};
		strictToolCount++;
		strictOptionalParameterCount += strictResult.optionalCount;
		strictUnionParameterCount += strictResult.unionCount;
	}

	return fields;
}
