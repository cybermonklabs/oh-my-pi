/**
 * The model cache's row codec: the shape of a persisted model, the validator both the
 * read and the write side use, and the projection of a live model to a cache-safe row.
 */
import { type } from "@oh-my-pi/omptype";
import type { Api, Model } from "./types";

/**
 * On-disk materialized row. `null` preserves the distinction between an
 * inferred computer-use value and an explicitly authored boolean through JSON.
 */
export type PersistedModel<TApi extends Api = Api> = Omit<Model<TApi>, "supportsComputerUseConfig"> & {
	supportsComputerUseConfig: boolean | null;
};

/**
 * A cacheable materialized model. Also checked on the write side against
 * in-memory models, so optional keys may be present as `undefined`.
 */
const MaterializedModel = type({
	id: "string > 0",
	name: "string > 0",
	api: "string > 0",
	provider: "string > 0",
	// Empty is legitimate: Azure-style providers resolve the endpoint from
	// configuration at request time, and their bundled rows carry "".
	baseUrl: "string",
	reasoning: "boolean",
	input: "('text' | 'image')[] > 0",
	"headers?": "undefined",
	supportsComputerUseConfig: "boolean | null",
	contextWindow: "number > 0 | null",
	maxTokens: "number > 0 | null",
	identity: { class: "string" },
	"compat?": type("object")
		.narrow(compat => !Array.isArray(compat))
		.or("undefined"),
	cost: { input: "number", output: "number", cacheRead: "number", cacheWrite: "number" },
});

export function isMaterializedModel(value: unknown): value is PersistedModel<Api> {
	return MaterializedModel.allows(value);
}

export function parseMaterializedModels<TApi extends Api>(serialized: string): Model<TApi>[] | null {
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (!Array.isArray(parsed) || !parsed.every(isMaterializedModel)) return null;
		return parsed.map(model => ({
			...model,
			supportsComputerUseConfig: model.supportsComputerUseConfig ?? undefined,
		})) as Model<TApi>[];
	} catch {
		return null;
	}
}

export function parseModelIds(serialized: string): string[] | null {
	try {
		const parsed: unknown = JSON.parse(serialized);
		return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string") ? parsed : null;
	} catch {
		return null;
	}
}

/** Whether a live model carries at least one request header. */
export function hasModelHeaders(model: Model<Api>): boolean {
	if (model.resolveHeaders) return true;
	const headers = model.headers;
	if (!headers) return false;
	for (const _key in headers) return true;
	return false;
}

/**
 * Project a materialized model to cache-safe metadata.
 *
 * Headers are never persisted: custom/runtime providers may use arbitrary
 * credential header names, so no name-based filter can be complete. All other
 * resolved fields are retained verbatim, including sparse provenance fields,
 * so a compatible cache can be consumed without running `buildModel`.
 */
export function toCachedModel<TApi extends Api>(model: Model<TApi>): PersistedModel<TApi> {
	const { headers: _headers, resolveHeaders: _resolveHeaders, ...rest } = model;
	return {
		...rest,
		supportsComputerUseConfig: model.supportsComputerUseConfig ?? null,
	};
}

/** Whether two in-memory header records are byte-for-byte equivalent. */
export function headersEqual(
	left: Record<string, string> | undefined,
	right: Record<string, string> | undefined,
): boolean {
	if (!left || !right) return left === right;
	for (const key in left) {
		if (right[key] !== left[key]) return false;
	}
	for (const key in right) {
		if (!(key in left)) return false;
	}
	return true;
}
