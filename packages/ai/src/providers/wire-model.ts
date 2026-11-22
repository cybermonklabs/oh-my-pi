/**
 * The model a main request goes out as, for the decisions that read the wire rather than the catalog entry: what the
 * prompt cache keys on (how a thinking level change goes out, which tools go out strict, the strict-tools fallback the
 * provider state keeps, which tool choice goes out).
 */
import { getCustomApi } from "../api-registry";
import { getProviderDefinition } from "../registry";
import type { Api, Model, SimpleStreamOptions } from "../types";
import { sameOwnFields } from "../utils/same-own-fields";
import { factoryDroidRouteModel } from "./factory-droid";
import { gitLabDuoUpstreamModel } from "./gitlab-duo";
import { kimiRequestModel } from "./kimi";
import { syntheticRequestModel } from "./synthetic";

/** The request options that choose the model a request goes out as: Kimi Code's and Synthetic's API format. */
export type WireModelOptions = Pick<SimpleStreamOptions, "kimiApiFormat" | "syntheticApiFormat">;

interface WireModelEntry {
	/** A shallow snapshot of the model it was resolved from. */
	source: Model<Api>;
	wire: Model<Api>;
}

/**
 * Wire models kept per source model and per combination of API formats, so a decision taken again on the same model
 * in the same formats does no compat resolution and reads the same object, whichever formats were asked for between;
 * a source with a field replaced in place since misses the snapshot and resolves again.
 */
const wireModels = new WeakMap<Model<Api>, Map<string, WireModelEntry>>();

/**
 * The model a main request on `model` with `options` goes out as, as `streamSimple` dispatches it: a wrapper
 * transport's inner model, with the API, id and compat of the request it sends; `model` itself elsewhere.
 *
 * - Factory Droid (`factory-droid-agent`): the shared transport's model for the route ({@link factoryDroidRouteModel}).
 * - GitLab Duo: the routed API's model under the upstream id ({@link gitLabDuoUpstreamModel}).
 * - Kimi Code and Synthetic: the Anthropic- or OpenAI-compatible model of the API format the options or the model
 *   select ({@link kimiRequestModel}, {@link syntheticRequestModel}).
 * - A provider whose transport prepares the model (Cloudflare AI Gateway's reroutes): the prepared model.
 *
 * A pi-native gateway resolves its own model, and an extension API streams the model as given.
 */
export function wireModel(model: Model<Api>, options?: WireModelOptions): Model<Api> {
	const kimiApiFormat = options?.kimiApiFormat;
	const syntheticApiFormat = options?.syntheticApiFormat;
	const formats = `${kimiApiFormat}/${syntheticApiFormat}`;
	let entries = wireModels.get(model);
	const cached = entries?.get(formats);
	if (cached !== undefined && sameOwnFields(cached.source, model)) return cached.wire;
	const wire = resolveWireModel(model, kimiApiFormat, syntheticApiFormat);
	if (wire === model) return wire;
	if (!entries) {
		entries = new Map();
		wireModels.set(model, entries);
	}
	entries.set(formats, { source: { ...model }, wire });
	return wire;
}

function resolveWireModel(
	model: Model<Api>,
	kimiApiFormat: WireModelOptions["kimiApiFormat"],
	syntheticApiFormat: WireModelOptions["syntheticApiFormat"],
): Model<Api> {
	if (model.transport === "pi-native" || getCustomApi(model.api)) return model;
	if (model.provider === "gitlab-duo") return gitLabDuoUpstreamModel(model) ?? model;
	if (model.api === "factory-droid-agent") return factoryDroidRouteModel(model as Model<"factory-droid-agent">);
	if (model.provider === "kimi-code") return kimiRequestModel(model as Model<"openai-completions">, kimiApiFormat);
	if (model.provider === "synthetic") {
		return syntheticRequestModel(model as Model<"openai-completions">, syntheticApiFormat);
	}
	return getProviderDefinition(model.provider)?.prepareModel?.(model) ?? model;
}
