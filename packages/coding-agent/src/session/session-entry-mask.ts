/**
 * Copy-on-write masking of a session entry or header, and of a `/btw` record, before it reaches
 * the session store (`secrets.maskSessionStore`). Every string is masked except a field that
 * {@link POSITIONS} keeps, and a field is kept only at the position the table names for it: under
 * a tool call's `arguments`, a tool result's `details`, custom data or any other key the table
 * does not name, every string is masked whatever its key or shape. Object keys, numbers, booleans
 * and `null` are never masked (KR13). An entry with nothing to mask comes back as the same object;
 * a masked one shares every untouched subtree with the live entry.
 *
 * The `KRn` tags on the table's rows name the keep rules:
 * - KR1: every entry: its `type`, `id`, `parentId`, `timestamp`, `activeLeafId` and the build that wrote it.
 * - KR2: the session header: its working directories, the links to other sessions and the cache keys.
 * - KR3: the fields of each entry `type`.
 * - KR4: an entry's `message`, by `role`.
 * - KR5: a content block of an entry, of its message or of `compactionSummary.blocks`.
 * - KR6: a block's signature, kept unscanned except an OpenAI Responses reasoning item's summary and content texts.
 * - KR7: image data outside a content array.
 * - KR8: a provider replay carrier: its protocol keys and ciphertext, each at its own place in it.
 * - KR9: the snapcompact slot of a compaction: its frames.
 * - KR10: the drop rules: a changed signed block loses its signature; a changed carrier, server-tool
 *   group or snapcompact slot is left out of the stored copy.
 * - KR11: the `/btw` history record.
 * - KR12: outside this walk, `SessionStoreMask.maskText` leaves a range that equals one of its own markers as it is.
 * - KR13: object keys, numbers, booleans and `null`, never masked.
 */
import { countNewlines, isRecord, tryParseJson } from "@oh-my-pi/pi-utils";
import type { SessionStoreMask } from "../secrets/session-store-mask";
import type { SessionTitleUpdate } from "./session-title-slot";

/** A child the parent copy leaves out: an object key omitted, an array item removed. */
const DROP: unique symbol = Symbol("drop");

/** A place in the session format where the table keeps fields. */
type PositionName =
	| "entry"
	| "runtime"
	| "serviceTierByFamily"
	| "retryFallback"
	| "preserveData"
	| "message"
	| "stopDetails"
	| "retryRecovery"
	| "supersededBy"
	| "inputTransformation"
	| "requestControls"
	| "requestControlTools"
	| "requestControlEffort"
	| "toolResultMetadata"
	| "screenshot"
	| "safetyCheck"
	| "outputMeta"
	| "truncation"
	| "outputSource"
	| "limits"
	| "columnTruncated"
	| "minimized"
	| "fileMentionFile"
	| "block"
	| "toolCallMetadata"
	| "computerAction"
	| "fallbackModel"
	| "image"
	| "providerFile"
	| "providerPayload"
	| "responsesItem"
	| "responsesPart"
	| "responsesTyped"
	| "computerOutput"
	| "mcpItem"
	| "mcpListTools"
	| "mcpTool"
	| "toolChange"
	| "anthropicCompaction"
	| "geminiContent"
	| "geminiPart"
	| "geminiFunction"
	| "geminiInlineData"
	| "geminiFileData"
	| "geminiExecutableCode"
	| "geminiCodeResult"
	| "openaiRemoteCompaction"
	| "serverToolBlock"
	| "cacheControl"
	| "serverToolContent"
	| "toolReference"
	| "snapcompact"
	| "snapcompactFrame"
	| "snapcompactView"
	| "btwRecord"
	| "btwTurn"
	| "btwImage";

/** What the masker keeps at one position, and where the objects under it sit. */
interface Position {
	/** Fields kept as written here: a string value, or each string item of an array value. */
	readonly keep?: readonly string[];
	/** Fields whose object value, or each object item of whose array value `items` does not name, sits at the named position. */
	readonly children?: Readonly<Record<string, PositionName>>;
	/** Fields whose array value's object items sit at the named position; an object value under the same key reads `children` only. */
	readonly items?: Readonly<Record<string, PositionName>>;
	/** More rules for an object here, chosen by the string under `key`: a row of its own, or a named position's. */
	readonly variants?: {
		readonly key: "type" | "role";
		readonly by: Readonly<Record<string, Position | PositionName>>;
	};
	/** Read where a child is placed: dropped from the stored copy whole when masking changes any string in it (KR8, KR9, KR10). */
	readonly carrier?: true;
	/** Read on a variant: the signature binding a block to its exact bytes, dropped when masking changes any other string of it (KR6, KR10). */
	readonly signature?: string;
	/** Read on a variant: the signature may be an OpenAI Responses reasoning item, whose summary and content texts are scanned (KR6). */
	readonly reasoning?: true;
	/** Read on a variant: when masking changes it, it and each sibling with the same `type` are dropped from the stored copy (KR10). */
	readonly pair?: true;
}

/**
 * The keep rules, one row per position. A field is kept as written only where its row names it;
 * anywhere else the same name holds free data and is masked.
 */
const POSITIONS: Readonly<Record<PositionName, Position>> = {
	/** KR1: every entry, the header included; KR2 and KR3 add the fields of each entry `type`. */
	entry: {
		keep: ["type", "id", "parentId", "timestamp", "activeLeafId"],
		children: { runtime: "runtime" },
		variants: {
			key: "type",
			by: {
				/** KR2: the header. Its `title` is masked. */
				session: {
					keep: [
						"titleSource",
						"cwd",
						"additionalDirectories",
						"parentSession",
						"continuationOf",
						"previousSessionFiles",
						"seanceSource",
						"providerPromptCacheKey",
						"taskPromptCacheKey",
					],
				},
				/** KR3. `errorMessage` is masked. */
				model_usage: { keep: ["purpose", "role", "api", "provider", "model", "stopReason"] },
				/** KR3. */
				thinking_level_change: { keep: ["thinkingLevel", "configured"] },
				/** KR3. */
				model_change: { keep: ["model", "role"] },
				/** KR3: a legacy single tier, or a tier per provider family. */
				service_tier_change: { keep: ["serviceTier"], children: { serviceTier: "serviceTierByFamily" } },
				/** KR3. `summary`, `shortSummary`, `warning` and `details` are masked. */
				compaction: {
					keep: ["firstKeptEntryId", "method", "providerReplayThroughEntryId"],
					children: { preserveData: "preserveData" },
				},
				/** KR3. `summary` and `details` are masked. */
				branch_summary: { keep: ["fromId"] },
				/** KR3. `data` is masked. */
				custom: { keep: ["customType"] },
				/** KR3, KR5: its `content` blocks. `details` is masked. */
				custom_message: { keep: ["customType", "attribution", "tag"], children: { content: "block" } },
				/** KR3. `label` is masked. */
				label: { keep: ["targetId"] },
				/** KR3. `title`, `previousTitle` and `trigger` are masked. */
				title_change: { keep: ["source"] },
				/** KR3. */
				ttsr_injection: { keep: ["injectedRules"] },
				/** KR3. */
				credential_pin: { keep: ["provider", "hash"] },
				/** KR3. `systemPrompt`, `task`, `outputSchema` and `workPoolYieldItems` are masked. */
				session_init: {
					keep: [
						"tools",
						"mountedTools",
						"agent",
						"modelRole",
						"resolvedModel",
						"perCallModelIdentity",
						"perCallThinkingLevel",
						"outputSchemaMode",
						"spawns",
						"advisor",
					],
					children: { retryFallback: "retryFallback" },
				},
				/** KR3. `data` is masked. */
				mode_change: { keep: ["mode"] },
				/** KR4: the entry's message. */
				message: { children: { message: "message" } },
			},
		},
	},
	/** KR1: the build that wrote an entry. `label` is masked. */
	runtime: { keep: ["version", "commit", "branch", "diff"] },
	/** KR3: `service_tier_change.serviceTier`, each family's tier. */
	serviceTierByFamily: { keep: ["openai", "anthropic", "google"] },
	/** KR3: `session_init.retryFallback`. */
	retryFallback: { keep: ["primary", "chain"] },
	/** KR8, KR9: the slots of `compaction.preserveData` that replay provider state; any other slot is masked. */
	preserveData: {
		children: {
			openaiRemoteCompaction: "openaiRemoteCompaction",
			anthropicCompaction: "anthropicCompaction",
			snapcompact: "snapcompact",
		},
	},
	/** KR4: an entry's message, by `role`; KR5 its `content` blocks; KR8 its `providerPayload`. */
	message: {
		keep: ["role", "timestamp"],
		children: { content: "block", providerPayload: "providerPayload" },
		variants: {
			key: "role",
			by: {
				/** KR4. `parentIrc` is masked. */
				user: { keep: ["attribution", "tag"] },
				/** KR4. */
				developer: { keep: ["attribution"] },
				/** KR4. `errorMessage`, `errorDisplayMessage`, `toolCallAbortMessages` and the like are masked. */
				assistant: {
					keep: [
						"api",
						"provider",
						"model",
						"responseId",
						"upstreamProvider",
						"upstreamModel",
						"serviceTier",
						"stopReason",
						"disabledFeatures",
					],
					children: {
						stopDetails: "stopDetails",
						retryRecovery: "retryRecovery",
						inputTransformations: "inputTransformation",
						requestControls: "requestControls",
					},
				},
				/** KR4, KR7. `details` is masked. */
				toolResult: {
					keep: ["toolCallId", "toolName", "attribution"],
					children: { providerMetadata: "toolResultMetadata" },
				},
				/** KR4. `details` is masked. */
				custom: { keep: ["customType", "attribution", "tag"] },
				/** KR4. `details` is masked. */
				hookMessage: { keep: ["customType", "attribution", "tag"] },
				/** KR4. `summary` is masked. */
				branchSummary: { keep: ["fromId"] },
				/** KR4, KR5: its `blocks`; KR7: its `images`. `summary`, `shortSummary` and `warning` are masked. */
				compactionSummary: { keep: ["method"], children: { blocks: "block", images: "image" } },
				/** KR4, KR7. `command` and `output` are masked. */
				bashExecution: { children: { meta: "outputMeta", images: "image" } },
				/** KR4. `code` and `output` are masked. */
				pythonExecution: { children: { meta: "outputMeta" } },
				/** KR4. */
				fileMention: { children: { files: "fileMentionFile" } },
			},
		},
	},
	/** KR4: an assistant message's `stopDetails`. `explanation` is masked. */
	stopDetails: { keep: ["type", "category"] },
	/** KR4: an assistant message's `retryRecovery`. `note` is masked. */
	retryRecovery: { keep: ["kind", "status", "recovery", "recoveredAt"], children: { supersededBy: "supersededBy" } },
	/** KR4. */
	supersededBy: { keep: ["responseId", "provider", "model"] },
	/** KR4: an item of an assistant message's `inputTransformations`; its other keys are masked. */
	inputTransformation: { keep: ["type", "path", "reason"] },
	/** KR4: an assistant message's `requestControls`. */
	requestControls: { children: { tools: "requestControlTools", effort: "requestControlEffort" } },
	/** KR4. */
	requestControlTools: { keep: ["declared", "deferred", "active"] },
	/** KR4. */
	requestControlEffort: { keep: ["topLevel", "tail"] },
	/** KR4: a tool result's `providerMetadata`. */
	toolResultMetadata: {
		keep: ["type"],
		children: { screenshot: "screenshot", acknowledgedSafetyChecks: "safetyCheck" },
	},
	/** KR4; KR7: its `image_url`. */
	screenshot: { keep: ["type", "file_id", "image_url"] },
	/** KR4, KR5, KR8: a computer-use safety check. `message` is masked. */
	safetyCheck: { keep: ["id", "code"] },
	/** KR4: a `bashExecution` or `pythonExecution` message's `meta`. `diagnostics` is masked. */
	outputMeta: {
		keep: ["artifactError"],
		children: { truncation: "truncation", source: "outputSource", limits: "limits", minimized: "minimized" },
	},
	/** KR4. */
	truncation: { keep: ["direction", "truncatedBy", "artifactId"] },
	/** KR4. `value` is masked. */
	outputSource: { keep: ["type"] },
	/** KR4. */
	limits: { children: { columnTruncated: "columnTruncated" } },
	/** KR4. */
	columnTruncated: { keep: ["unit", "artifactId", "selectorBase"] },
	/** KR4. `filter` is masked. */
	minimized: { keep: ["artifactId"] },
	/** KR4; KR7: its `image`. `path` and `content` are masked. */
	fileMentionFile: { keep: ["skippedReason"], children: { image: "image" } },
	/** KR5: an item of a `content` array of an entry or its message, or of `compactionSummary.blocks`. */
	block: {
		keep: ["type"],
		variants: {
			key: "type",
			by: {
				/** KR5, KR6. `thinking` is masked. */
				thinking: {
					keep: ["itemId", "thinkingSignature"],
					signature: "thinkingSignature",
					reasoning: true,
				},
				/** KR6. `text` is masked. */
				text: { keep: ["textSignature"], signature: "textSignature" },
				/** KR5, KR6. `intent` and `rawBlock` are masked; `arguments` is free data. */
				toolCall: {
					keep: ["id", "name", "customWireName", "namespace", "thoughtSignature"],
					children: { providerMetadata: "toolCallMetadata" },
					signature: "thoughtSignature",
				},
				/** KR5. */
				redactedThinking: { keep: ["data"] },
				/** KR5. */
				fallback: { children: { from: "fallbackModel", to: "fallbackModel" } },
				/** KR5. */
				image: "image",
				/** KR5, KR8, KR10: its `block` is a carrier, and a changed one goes with its server-tool siblings. */
				anthropicServerTool: { children: { block: "serverToolBlock" }, pair: true },
			},
		},
	},
	/** KR5: a tool call's `providerMetadata`. */
	toolCallMetadata: {
		keep: ["type", "providerItemId"],
		children: { actions: "computerAction", pendingSafetyChecks: "safetyCheck" },
	},
	/** KR5, KR8: a computer-use action. `text` is masked. */
	computerAction: { keep: ["type", "button", "keys"] },
	/** KR5: a `fallback` block's `from` and `to`. */
	fallbackModel: { keep: ["model"] },
	/** KR5: an `image` block; KR7: an image outside a content array. */
	image: { keep: ["type", "data", "mimeType", "detail", "url"], children: { providerFile: "providerFile" } },
	/** KR5. */
	providerFile: { keep: ["provider", "id", "uri"] },
	/** KR8: a message's or `compactionSummary`'s `providerPayload`, by `type`. */
	providerPayload: {
		carrier: true,
		keep: ["type"],
		variants: {
			key: "type",
			by: {
				/** KR8. */
				openaiResponsesHistory: { keep: ["provider"], children: { items: "responsesItem" } },
				/** KR8. */
				anthropicMessage: { keep: ["clearAt", "effort"], children: { toolChanges: "toolChange" } },
				/** KR8. */
				anthropicCompaction: "anthropicCompaction",
				/** KR8. `records` is masked. */
				cursorHistory: { keep: ["wireRoute", "digest"] },
				/** KR8. */
				geminiNativeContent: { keep: ["digest"], children: { content: "geminiContent" } },
			},
		},
	},
	/**
	 * KR8: an OpenAI Responses item of a carrier. `arguments`, `input`, text and the other fields of
	 * `action`, `output` and `operation` are masked, and so is all of an object `content` or `summary`.
	 */
	responsesItem: {
		keep: ["type", "id", "call_id", "status", "role", "phase", "name", "namespace", "encrypted_content"],
		children: {
			action: "responsesTyped",
			output: "responsesTyped",
			operation: "responsesTyped",
			pending_safety_checks: "safetyCheck",
			acknowledged_safety_checks: "safetyCheck",
		},
		items: { content: "responsesPart", summary: "responsesPart", output: "responsesPart" },
		variants: {
			key: "type",
			by: {
				/** KR8. */
				image_generation_call: { keep: ["result"] },
				/** KR8: the fields KR5 keeps on the block copy of the same call. */
				computer_call: { children: { action: "computerAction", actions: "computerAction" } },
				/** KR8. */
				computer_call_output: { children: { output: "computerOutput" } },
				/** KR8. */
				mcp_list_tools: "mcpListTools",
				/** KR8. */
				mcp_call: "mcpItem",
				/** KR8. */
				mcp_approval_request: "mcpItem",
				/** KR8. */
				mcp_approval_response: "mcpItem",
			},
		},
	},
	/** KR8: an element of a Responses item's `content[]`, `summary[]` or `output[]`. `text` is masked. */
	responsesPart: {
		keep: ["type"],
		variants: { key: "type", by: { input_image: { keep: ["image_url", "detail", "file_id"] } } },
	},
	/** KR8: a Responses item's `action`, `operation` or object `output`. */
	responsesTyped: { keep: ["type"] },
	/** KR8: a `computer_call_output` item's `output`. */
	computerOutput: { keep: ["type", "image_url", "file_id"] },
	/** KR8: an `mcp_call`, `mcp_approval_request` or `mcp_approval_response` item. `arguments`, `output`, `error` and `reason` are masked. */
	mcpItem: { keep: ["server_label", "approval_request_id"] },
	/** KR8: an `mcp_list_tools` item. `error` is masked. */
	mcpListTools: { keep: ["server_label", "approval_request_id"], children: { tools: "mcpTool" } },
	/** KR8: a tool an `mcp_list_tools` item lists. `description` and `input_schema` are masked. */
	mcpTool: { keep: ["name"] },
	/** KR8: a tool change of an Anthropic message or compaction. */
	toolChange: { keep: ["type", "name"] },
	/**
	 * KR8: `compaction.preserveData.anthropicCompaction`, and an `anthropicCompaction` payload.
	 * `content`, `filesText` and `retainedFiles` are masked.
	 */
	anthropicCompaction: {
		carrier: true,
		keep: ["type", "provider", "model", "signature", "encryptedContent"],
		children: { toolChanges: "toolChange" },
	},
	/** KR8: a `geminiNativeContent` payload's `content`. */
	geminiContent: { keep: ["role"], children: { parts: "geminiPart" } },
	/** KR8: an element of a `geminiNativeContent` payload's `content.parts`, a Gemini `Part`. `text` is masked. */
	geminiPart: {
		keep: ["thoughtSignature"],
		children: {
			functionCall: "geminiFunction",
			functionResponse: "geminiFunction",
			inlineData: "geminiInlineData",
			fileData: "geminiFileData",
			executableCode: "geminiExecutableCode",
			codeExecutionResult: "geminiCodeResult",
		},
	},
	/** KR8: a Gemini part's `functionCall` or `functionResponse`. `args` and `response` are masked. */
	geminiFunction: { keep: ["id", "name"] },
	/** KR8. */
	geminiInlineData: { keep: ["mimeType", "data"] },
	/** KR8. */
	geminiFileData: { keep: ["mimeType", "fileUri"] },
	/** KR8. `code` is masked. */
	geminiExecutableCode: { keep: ["language"] },
	/** KR8. `output` is masked. */
	geminiCodeResult: { keep: ["outcome"] },
	/** KR8: `compaction.preserveData.openaiRemoteCompaction`, classic or `version: "v2"`. */
	openaiRemoteCompaction: {
		carrier: true,
		keep: ["type", "provider", "version"],
		children: { replacementHistory: "responsesItem", compactionItem: "responsesItem" },
	},
	/** KR8: an `anthropicServerTool` block's `block`. `input` is masked. */
	serverToolBlock: {
		carrier: true,
		keep: ["type", "id", "name", "tool_use_id"],
		children: { cache_control: "cacheControl", content: "serverToolContent" },
	},
	/** KR8: an `anthropicServerTool` block's `block.cache_control`. */
	cacheControl: { keep: ["type", "ttl", "scope"] },
	/** KR8: a server-tool result, error or tool search result. `url`, `title` and `page_age` are masked. */
	serverToolContent: {
		keep: ["type", "encrypted_content", "error_code"],
		children: { tool_references: "toolReference" },
	},
	/** KR8. */
	toolReference: { keep: ["type", "tool_name"] },
	/**
	 * KR9: `compaction.preserveData.snapcompact`, and the archive of its `withoutThinking`. `text`,
	 * `textHead`, `textTail` and `withoutThinking.summary` are masked.
	 */
	snapcompact: { carrier: true, children: { frames: "snapcompactFrame", withoutThinking: "snapcompactView" } },
	/** KR9. */
	snapcompactFrame: { keep: ["data", "mimeType", "detail", "font", "variant"] },
	/** KR9. */
	snapcompactView: { children: { archive: "snapcompact" } },
	/** KR11: a `/btw` record. `question`, `answer` and `error` are masked. */
	btwRecord: { keep: ["id", "leafId", "status"], children: { images: "btwImage", followUps: "btwTurn" } },
	/** KR11: a `/btw` follow-up. `question`, `answer` and `error` are masked. */
	btwTurn: { keep: ["status"], children: { images: "btwImage" } },
	/** KR7, KR11: an image of a `/btw` record or follow-up. */
	btwImage: { keep: ["type", "data", "mimeType"] },
};

/**
 * `entry` with every held secret replaced by its marker, for the stored copy
 * only: the live entry is never mutated. Returns `entry` itself when nothing
 * changes or `mask` is `null`. Signed blocks that change lose their signature;
 * provider replay state that changes is dropped whole.
 */
export function maskSessionEntry<T>(entry: T, mask: SessionStoreMask | null): T {
	return mask === null || mask.empty ? entry : (maskValue(entry, mask, POSITIONS.entry) as T);
}

/** `record`, a `/btw` history record, with every held secret replaced by its marker, for the stored copy only. */
export function maskBtwRecord<T>(record: T, mask: SessionStoreMask | null): T {
	return mask === null || mask.empty ? record : (maskValue(record, mask, POSITIONS.btwRecord) as T);
}

/**
 * `value` with every held secret replaced by its marker, for a stored copy of free data, such as a
 * subagent's yield data: no field in it is kept. The value itself is masked, never dropped.
 */
export function maskStoredData<T>(value: T, mask: SessionStoreMask | null): T {
	return mask === null || mask.empty ? value : (maskValue(value, mask, undefined) as T);
}

/** `update` with its title masked, so the store's title field holds what the title slot holds. */
export function maskTitleUpdate(update: SessionTitleUpdate, mask: SessionStoreMask | null): SessionTitleUpdate {
	if (mask === null || update.title === undefined) return update;
	const title = mask.maskText(update.title);
	return title === update.title ? update : { ...update, title };
}

/** `value` masked at `at`; `undefined` is free data, where every string is masked. */
function maskValue(value: unknown, mask: SessionStoreMask, at: Position | undefined): unknown {
	if (typeof value === "string") return mask.maskText(value);
	if (Array.isArray(value)) return maskArray(value, mask, at, false);
	return isRecord(value) ? maskObject(value, mask, at) : value;
}

/** `value` masked at `at`, or {@link DROP} when `at` is a carrier that masking changed. */
function maskChild(value: unknown, mask: SessionStoreMask, at: Position | undefined): unknown {
	const next = maskValue(value, mask, at);
	return next !== value && at?.carrier ? DROP : next;
}

/** `items` masked: each object at `at`, each string kept when `keepStrings`, every nested array as free data. */
function maskArray(
	items: unknown[],
	mask: SessionStoreMask,
	at: Position | undefined,
	keepStrings: boolean,
): unknown[] {
	let copy: unknown[] | undefined;
	let droppedPair: unknown;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		let next: unknown;
		if (typeof item === "string") next = keepStrings ? item : mask.maskText(item);
		else if (Array.isArray(item)) next = maskArray(item, mask, undefined, false);
		else next = maskChild(item, mask, at);
		if (copy === undefined) {
			if (next === item) continue;
			copy = items.slice(0, i);
		}
		if (next !== item && at?.variants && isRecord(item) && variantOf(item, at.variants)?.pair) {
			droppedPair = item[at.variants.key];
		}
		if (next !== DROP) copy.push(next);
	}
	if (copy === undefined) return items;
	if (droppedPair === undefined || at?.variants === undefined) return copy;
	const { key } = at.variants;
	return copy.filter(item => !isRecord(item) || item[key] !== droppedPair);
}

function maskObject(
	obj: Record<string, unknown>,
	mask: SessionStoreMask,
	at: Position | undefined,
): Record<string, unknown> {
	const variant = at?.variants === undefined ? undefined : variantOf(obj, at.variants);
	const signatureKey = signatureKeyOf(obj, variant);
	let copy: Record<string, unknown> | undefined;
	let maskedContent: string | undefined;
	for (const key in obj) {
		if (!Object.hasOwn(obj, key)) continue;
		const value = obj[key];
		const next = maskField(value, mask, at, variant, key);
		if (copy === undefined) {
			if (next === value) continue;
			copy = copyBefore(obj, key, signatureKey);
		}
		// A signed block that changed no longer matches its signature: store it unsigned.
		if (next === DROP || key === signatureKey) continue;
		setOwn(copy, key, next);
		if (key === "content" && typeof next === "string" && next !== value) maskedContent = next;
	}
	if (copy === undefined) {
		// Nothing else changed: a Responses reasoning signature whose texts hold a value is still left out.
		if (signatureKey === undefined || !variant?.reasoning || !reasoningHoldsValue(obj[signatureKey], mask))
			return obj;
		return copyBefore(obj, undefined, signatureKey);
	}
	if (maskedContent !== undefined && typeof copy.lineCount === "number") {
		copy.lineCount = countNewlines(maskedContent) + 1;
	}
	return copy;
}

/** The value under `key` of an object at `at` (with its `variant`), masked. */
function maskField(
	value: unknown,
	mask: SessionStoreMask,
	at: Position | undefined,
	variant: Position | undefined,
	key: string,
): unknown {
	if (isRecord(value)) return maskChild(value, mask, childPosition(at, variant, key, false));
	if (typeof value !== "string" && !Array.isArray(value)) return value;
	// Kept as written: a string the table names here, or each string of an array it names.
	const kept = at !== undefined && (at.keep?.includes(key) === true || variant?.keep?.includes(key) === true);
	if (typeof value === "string") return kept ? value : mask.maskText(value);
	return maskArray(value, mask, childPosition(at, variant, key, true), kept);
}

/** The position of the object under `key`, or of each object item of an array there (`element`), or `undefined` for free data. */
function childPosition(
	at: Position | undefined,
	variant: Position | undefined,
	key: string,
	element: boolean,
): Position | undefined {
	const name =
		(element ? (ownValue(variant?.items, key) ?? ownValue(at?.items, key)) : undefined) ??
		ownValue(variant?.children, key) ??
		ownValue(at?.children, key);
	return name === undefined ? undefined : POSITIONS[name];
}

/** The rules `variants` adds for `obj`, by its `type` or `role`. */
function variantOf(obj: Record<string, unknown>, variants: NonNullable<Position["variants"]>): Position | undefined {
	const tag = obj[variants.key];
	const variant = typeof tag === "string" ? ownValue(variants.by, tag) : undefined;
	return typeof variant === "string" ? POSITIONS[variant] : variant;
}

function ownValue<V>(record: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
	return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** The signature key of a signed `thinking`/`text`/`toolCall` block, or `undefined` when it is unsigned. */
function signatureKeyOf(obj: Record<string, unknown>, variant: Position | undefined): string | undefined {
	const key = variant?.signature;
	if (key === undefined) return undefined;
	const signature = obj[key];
	return typeof signature === "string" && signature.length > 0 ? key : undefined;
}

/**
 * Whether `signature` is an OpenAI Responses reasoning item (JSON with `type: "reasoning"`) whose
 * `summary[].text` or `content[].text` holds a value. Its `encrypted_content` is never scanned.
 */
function reasoningHoldsValue(signature: unknown, mask: SessionStoreMask): boolean {
	if (typeof signature !== "string" || !/^\s*\{/.test(signature)) return false;
	const item = tryParseJson(signature);
	return (
		isRecord(item) &&
		item.type === "reasoning" &&
		(textsHoldValue(item.summary, mask) || textsHoldValue(item.content, mask))
	);
}

function textsHoldValue(parts: unknown, mask: SessionStoreMask): boolean {
	if (!Array.isArray(parts)) return false;
	for (const part of parts) {
		if (isRecord(part) && typeof part.text === "string" && mask.maskText(part.text) !== part.text) return true;
	}
	return false;
}

/** A copy of `obj`'s own keys that come before `stop` (all of them when `stop` is `undefined`), leaving out `skip`. */
function copyBefore(
	obj: Record<string, unknown>,
	stop: string | undefined,
	skip: string | undefined,
): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const key in obj) {
		if (key === stop) break;
		if (Object.hasOwn(obj, key) && key !== skip) setOwn(copy, key, obj[key]);
	}
	return copy;
}

/** Assign an own data property, so a parsed `__proto__` key stays a field rather than a prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
	} else {
		target[key] = value;
	}
}
