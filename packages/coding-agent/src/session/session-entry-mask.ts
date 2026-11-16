/**
 * Copy-on-write masking of a session entry or header, and of a `/btw` record, before it reaches
 * the session store (`secrets.maskSessionStore`). Every string is masked except a field that
 * {@link POSITIONS} keeps, and a field is kept only at the position the table names for it: under
 * a tool call's `arguments`, a tool result's `details`, custom data or any other key the table
 * does not name, every string is masked whatever its key or shape. Object keys, numbers, booleans
 * and `null` are never masked (KR13). An entry made of primitives, plain objects and real arrays
 * with nothing to mask comes back as the same object; a masked one shares every untouched such
 * subtree with the live entry.
 *
 * The walk reads each value as `stringifyJson` writes it to the session line: through its `toJSON`,
 * a `bigint` as its decimal string, a boxed primitive as its primitive, an object as its own
 * enumerable keys; the copy holds any node of another kind as that stored form, in plain data.
 * A position keeps a value only in the shape the table declares for it, judged on the live value:
 * a string field a primitive string, a `[]` field a real array of strings, an object or
 * array-element position a plain object; any other shape there is free content, every string masked.
 *
 * The `KRn` tags on the table's rows name the keep rules:
 * - KR1: every entry: its `type`, `id`, `parentId`, `timestamp`, `activeLeafId` and the build that wrote it.
 * - KR2: the session header, which is not an entry: its working directories, the links to other
 *   sessions and the cache keys.
 * - KR3: the fields of each entry `type`; a `service_tier_change` keeps only the tier of each provider family.
 * - KR4: an entry's `message`, by `role`.
 * - KR5: a content block of an entry, of its message or of `compactionSummary.blocks`.
 * - KR6: a block's signature, kept unscanned except an OpenAI Responses reasoning item's summary and content texts.
 * - KR7: image data outside a content array, each image keeping what KR5's image block keeps.
 * - KR8: a provider replay carrier: its protocol keys and ciphertext, each at its own place in it; an
 *   `anthropicCompaction` tool change keeps its `type`, its `tool`'s `type` and `name` and its whole
 *   `opaque` object, and a server tool's result content keeps fields by element type only.
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
	| "header"
	| "runtime"
	| "serviceTier"
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
	| "messageToolChange"
	| "anthropicCompaction"
	| "compactionToolChange"
	| "compactionTool"
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
	| "webSearchResult"
	| "webSearchError"
	| "toolSearchContent"
	| "toolReference"
	| "snapcompact"
	| "snapcompactFrame"
	| "snapcompactView"
	| "btwRecord"
	| "btwTurn"
	| "btwImage";

/**
 * What the masker keeps in a plain object at one position, each field by the shape it declares.
 * A field's value in any other shape is free content.
 */
interface Position {
	/** Fields kept as written when their value is a primitive string. */
	readonly strings?: readonly string[];
	/** Fields whose value, when a real array, has each primitive-string element kept as written. */
	readonly stringArrays?: readonly string[];
	/** Fields whose value, when a plain object, is kept whole and unscanned. */
	readonly wholeObjects?: readonly string[];
	/** Fields whose value, when a plain object, sits at the named position. */
	readonly objects?: Readonly<Record<string, PositionName>>;
	/** Fields whose value, when a real array, has each plain-object element at the named position. */
	readonly elements?: Readonly<Record<string, PositionName>>;
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

/** The fields of a position that list names. */
type ListedField = "strings" | "stringArrays" | "wholeObjects";

/**
 * The keep rules, one row per position. A field is kept as written only where its row names it,
 * and only in the shape the row declares; anywhere else the same name holds free data and is masked.
 */
const POSITIONS: Readonly<Record<PositionName, Position>> = {
	/** KR1: every entry; KR3 adds the fields of each entry `type`. */
	entry: {
		strings: ["type", "id", "parentId", "timestamp", "activeLeafId"],
		objects: { runtime: "runtime" },
		variants: {
			key: "type",
			by: {
				/** KR3. `errorMessage` is masked. */
				model_usage: { strings: ["purpose", "role", "api", "provider", "model", "stopReason"] },
				/** KR3. */
				thinking_level_change: { strings: ["thinkingLevel", "configured"] },
				/** KR3. */
				model_change: { strings: ["model", "role"] },
				/** KR3: a tier per provider family; a scalar `serviceTier` is masked. */
				service_tier_change: { objects: { serviceTier: "serviceTier" } },
				/** KR3. `summary`, `shortSummary`, `warning` and `details` are masked. */
				compaction: {
					strings: ["firstKeptEntryId", "method", "providerReplayThroughEntryId"],
					objects: { preserveData: "preserveData" },
				},
				/** KR3. `summary` and `details` are masked. */
				branch_summary: { strings: ["fromId"] },
				/** KR3. `data` is masked. */
				custom: { strings: ["customType"] },
				/** KR3, KR5: its `content` blocks. `details` is masked. */
				custom_message: { strings: ["customType", "attribution", "tag"], elements: { content: "block" } },
				/** KR3. `label` is masked. */
				label: { strings: ["targetId"] },
				/** KR3. `title`, `previousTitle` and `trigger` are masked. */
				title_change: { strings: ["source"] },
				/** KR3. */
				ttsr_injection: { stringArrays: ["injectedRules"] },
				/** KR3. */
				credential_pin: { strings: ["provider", "hash"] },
				/** KR3. `systemPrompt`, `task`, `outputSchema` and `workPoolYieldItems` are masked. */
				session_init: {
					strings: [
						"agent",
						"modelRole",
						"resolvedModel",
						"perCallModelIdentity",
						"perCallThinkingLevel",
						"outputSchemaMode",
						"spawns",
						"advisor",
					],
					stringArrays: ["tools", "mountedTools"],
					objects: { retryFallback: "retryFallback" },
				},
				/** KR3. `data` is masked. */
				mode_change: { strings: ["mode"] },
				/** KR4: the entry's message. */
				message: { objects: { message: "message" } },
			},
		},
	},
	/** KR2: the session header (`type: "session"`). Its `title` is masked. */
	header: {
		strings: [
			"type",
			"id",
			"timestamp",
			"titleSource",
			"cwd",
			"parentSession",
			"continuationOf",
			"seanceSource",
			"providerPromptCacheKey",
			"taskPromptCacheKey",
		],
		stringArrays: ["additionalDirectories", "previousSessionFiles"],
	},
	/** KR1: the build that wrote an entry. `label` is masked. */
	runtime: { strings: ["version", "commit", "branch", "diff"] },
	/** KR3: `service_tier_change.serviceTier`, each `ServiceTierFamily`'s tier. */
	serviceTier: { strings: ["openai", "anthropic", "google"] },
	/** KR3: `session_init.retryFallback`. */
	retryFallback: { strings: ["primary"], stringArrays: ["chain"] },
	/** KR8, KR9: the slots of `compaction.preserveData` that replay provider state; any other slot is masked. */
	preserveData: {
		objects: {
			openaiRemoteCompaction: "openaiRemoteCompaction",
			anthropicCompaction: "anthropicCompaction",
			snapcompact: "snapcompact",
		},
	},
	/** KR4: an entry's message, by `role`; KR5 its `content` blocks; KR8 its `providerPayload`. */
	message: {
		strings: ["role", "timestamp"],
		objects: { providerPayload: "providerPayload" },
		elements: { content: "block" },
		variants: {
			key: "role",
			by: {
				/** KR4. `parentIrc` is masked. */
				user: { strings: ["attribution", "tag"] },
				/** KR4. */
				developer: { strings: ["attribution"] },
				/** KR4. `errorMessage`, `errorDisplayMessage`, `toolCallAbortMessages` and the like are masked. */
				assistant: {
					strings: [
						"api",
						"provider",
						"model",
						"responseId",
						"upstreamProvider",
						"upstreamModel",
						"serviceTier",
						"stopReason",
					],
					stringArrays: ["disabledFeatures"],
					objects: {
						stopDetails: "stopDetails",
						retryRecovery: "retryRecovery",
						requestControls: "requestControls",
					},
					elements: { inputTransformations: "inputTransformation" },
				},
				/** KR4, KR7. `details` is masked. */
				toolResult: {
					strings: ["toolCallId", "toolName", "attribution"],
					objects: { providerMetadata: "toolResultMetadata" },
				},
				/** KR4. `details` is masked. */
				custom: { strings: ["customType", "attribution", "tag"] },
				/** KR4. `details` is masked. */
				hookMessage: { strings: ["customType", "attribution", "tag"] },
				/** KR4. `summary` is masked. */
				branchSummary: { strings: ["fromId"] },
				/** KR4, KR5: its `blocks`; KR7: its `images`. `summary`, `shortSummary` and `warning` are masked. */
				compactionSummary: { strings: ["method"], elements: { blocks: "block", images: "image" } },
				/** KR4, KR7. `command` and `output` are masked. */
				bashExecution: { objects: { meta: "outputMeta" }, elements: { images: "image" } },
				/** KR4. `code` and `output` are masked. */
				pythonExecution: { objects: { meta: "outputMeta" } },
				/** KR4. */
				fileMention: { elements: { files: "fileMentionFile" } },
			},
		},
	},
	/** KR4: an assistant message's `stopDetails`. `explanation` is masked. */
	stopDetails: { strings: ["type", "category"] },
	/** KR4: an assistant message's `retryRecovery`. `note` is masked. */
	retryRecovery: {
		strings: ["kind", "status", "recovery", "recoveredAt"],
		objects: { supersededBy: "supersededBy" },
	},
	/** KR4. */
	supersededBy: { strings: ["responseId", "provider", "model"] },
	/** KR4: an element of an assistant message's `inputTransformations[]`; its other keys are masked. */
	inputTransformation: { strings: ["type", "path", "reason"] },
	/** KR4: an assistant message's `requestControls`. */
	requestControls: { objects: { tools: "requestControlTools", effort: "requestControlEffort" } },
	/** KR4. */
	requestControlTools: { stringArrays: ["declared", "deferred", "active"] },
	/** KR4. */
	requestControlEffort: { strings: ["topLevel", "tail"] },
	/** KR4: a tool result's `providerMetadata`. */
	toolResultMetadata: {
		strings: ["type"],
		objects: { screenshot: "screenshot" },
		elements: { acknowledgedSafetyChecks: "safetyCheck" },
	},
	/** KR4; KR7: its `image_url`. */
	screenshot: { strings: ["type", "file_id", "image_url"] },
	/** KR4, KR5, KR8: an element of a computer-use safety check list. `message` is masked. */
	safetyCheck: { strings: ["id", "code"] },
	/** KR4: a `bashExecution` or `pythonExecution` message's `meta`. `diagnostics` is masked. */
	outputMeta: {
		strings: ["artifactError"],
		objects: { truncation: "truncation", source: "outputSource", limits: "limits", minimized: "minimized" },
	},
	/** KR4. */
	truncation: { strings: ["direction", "truncatedBy", "artifactId"] },
	/** KR4. `value` is masked. */
	outputSource: { strings: ["type"] },
	/** KR4. */
	limits: { objects: { columnTruncated: "columnTruncated" } },
	/** KR4. */
	columnTruncated: { strings: ["unit", "artifactId", "selectorBase"] },
	/** KR4. `filter` is masked. */
	minimized: { strings: ["artifactId"] },
	/** KR4: an element of a `fileMention` message's `files[]`; KR7: its `image`. `path` and `content` are masked. */
	fileMentionFile: { strings: ["skippedReason"], objects: { image: "image" } },
	/** KR5: an element of a `content[]` of an entry or its message, or of `compactionSummary.blocks[]`. */
	block: {
		strings: ["type"],
		variants: {
			key: "type",
			by: {
				/** KR5, KR6. `thinking` is masked. */
				thinking: {
					strings: ["itemId", "thinkingSignature"],
					signature: "thinkingSignature",
					reasoning: true,
				},
				/** KR6. `text` is masked. */
				text: { strings: ["textSignature"], signature: "textSignature" },
				/** KR5, KR6. `intent` and `rawBlock` are masked; `arguments` is free data. */
				toolCall: {
					strings: ["id", "name", "customWireName", "namespace", "thoughtSignature"],
					objects: { providerMetadata: "toolCallMetadata" },
					signature: "thoughtSignature",
				},
				/** KR5. */
				redactedThinking: { strings: ["data"] },
				/** KR5. */
				fallback: { objects: { from: "fallbackModel", to: "fallbackModel" } },
				/** KR5. */
				image: "image",
				/** KR5, KR8, KR10: its `block` is a carrier, and a changed one goes with its server-tool siblings. */
				anthropicServerTool: { objects: { block: "serverToolBlock" }, pair: true },
			},
		},
	},
	/** KR5: a tool call's `providerMetadata`. */
	toolCallMetadata: {
		strings: ["type", "providerItemId"],
		elements: { actions: "computerAction", pendingSafetyChecks: "safetyCheck" },
	},
	/** KR5, KR8: a computer-use action. `text` is masked. */
	computerAction: { strings: ["type", "button"], stringArrays: ["keys"] },
	/** KR5: a `fallback` block's `from` and `to`. */
	fallbackModel: { strings: ["model"] },
	/** KR5: an `image` block; KR7: an image outside a content array. */
	image: {
		strings: ["type", "data", "mimeType", "detail", "url"],
		objects: { providerFile: "providerFile" },
	},
	/** KR5, KR7. */
	providerFile: { strings: ["provider", "id", "uri"] },
	/** KR8: a message's or `compactionSummary`'s `providerPayload`, by `type`. */
	providerPayload: {
		carrier: true,
		strings: ["type"],
		variants: {
			key: "type",
			by: {
				/** KR8. */
				openaiResponsesHistory: { strings: ["provider"], elements: { items: "responsesItem" } },
				/** KR8. */
				anthropicMessage: { strings: ["clearAt", "effort"], elements: { toolChanges: "messageToolChange" } },
				/** KR8. */
				anthropicCompaction: "anthropicCompaction",
				/** KR8. `records` is masked. */
				cursorHistory: { strings: ["wireRoute", "digest"] },
				/** KR8. */
				geminiNativeContent: { strings: ["digest"], objects: { content: "geminiContent" } },
			},
		},
	},
	/**
	 * KR8: an OpenAI Responses item of a carrier: an element of `items[]` or `replacementHistory[]`, or
	 * the `compactionItem`. `arguments`, `input`, text and the other fields of `action`, `output` and
	 * `operation` are masked, and so is all of an object `content` or `summary`.
	 */
	responsesItem: {
		strings: ["type", "id", "call_id", "status", "role", "phase", "name", "namespace", "encrypted_content"],
		objects: { action: "responsesTyped", output: "responsesTyped", operation: "responsesTyped" },
		elements: {
			content: "responsesPart",
			summary: "responsesPart",
			output: "responsesPart",
			pending_safety_checks: "safetyCheck",
			acknowledged_safety_checks: "safetyCheck",
		},
		variants: {
			key: "type",
			by: {
				/** KR8. */
				image_generation_call: { strings: ["result"] },
				/** KR8: the fields KR5 keeps on the block copy of the same call. */
				computer_call: { objects: { action: "computerAction" }, elements: { actions: "computerAction" } },
				/** KR8. */
				computer_call_output: { objects: { output: "computerOutput" } },
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
		strings: ["type"],
		variants: { key: "type", by: { input_image: { strings: ["image_url", "detail", "file_id"] } } },
	},
	/** KR8: a Responses item's `action`, `operation` or object `output`. */
	responsesTyped: { strings: ["type"] },
	/** KR8: a `computer_call_output` item's object `output`. */
	computerOutput: { strings: ["type", "image_url", "file_id"] },
	/** KR8: an `mcp_call`, `mcp_approval_request` or `mcp_approval_response` item. `arguments`, `output`, `error` and `reason` are masked. */
	mcpItem: { strings: ["server_label", "approval_request_id"] },
	/** KR8: an `mcp_list_tools` item. `error` is masked. */
	mcpListTools: { strings: ["server_label", "approval_request_id"], elements: { tools: "mcpTool" } },
	/** KR8: an element of an `mcp_list_tools` item's `tools[]`. `description` and `input_schema` are masked. */
	mcpTool: { strings: ["name"] },
	/** KR8: an element of an `anthropicMessage` payload's `toolChanges[]`. */
	messageToolChange: { strings: ["type", "name"] },
	/**
	 * KR8: `compaction.preserveData.anthropicCompaction`, and an `anthropicCompaction` payload.
	 * `content`, `filesText` and `retainedFiles` are masked.
	 */
	anthropicCompaction: {
		carrier: true,
		strings: ["type", "provider", "model", "signature", "encryptedContent"],
		elements: { toolChanges: "compactionToolChange" },
	},
	/**
	 * KR8: an element of an `anthropicCompaction`'s `toolChanges[]`, the API's raw `tool_changes`,
	 * which its signature covers: `opaque` is kept whole, unscanned. Its own `name` is masked.
	 */
	compactionToolChange: { strings: ["type"], objects: { tool: "compactionTool" }, wholeObjects: ["opaque"] },
	/** KR8: an `anthropicCompaction` tool change's `tool`. */
	compactionTool: { strings: ["type", "name"] },
	/** KR8: a `geminiNativeContent` payload's `content`. */
	geminiContent: { strings: ["role"], elements: { parts: "geminiPart" } },
	/** KR8: an element of a `geminiNativeContent` payload's `content.parts[]`, a Gemini `Part`. `text` is masked. */
	geminiPart: {
		strings: ["thoughtSignature"],
		objects: {
			functionCall: "geminiFunction",
			functionResponse: "geminiFunction",
			inlineData: "geminiInlineData",
			fileData: "geminiFileData",
			executableCode: "geminiExecutableCode",
			codeExecutionResult: "geminiCodeResult",
		},
	},
	/** KR8: a Gemini part's `functionCall` or `functionResponse`. `args` and `response` are masked. */
	geminiFunction: { strings: ["id", "name"] },
	/** KR8. */
	geminiInlineData: { strings: ["mimeType", "data"] },
	/** KR8. */
	geminiFileData: { strings: ["mimeType", "fileUri"] },
	/** KR8. `code` is masked. */
	geminiExecutableCode: { strings: ["language"] },
	/** KR8. `output` is masked. */
	geminiCodeResult: { strings: ["outcome"] },
	/** KR8: `compaction.preserveData.openaiRemoteCompaction`, classic or `version: "v2"`. */
	openaiRemoteCompaction: {
		carrier: true,
		strings: ["type", "provider", "version"],
		objects: { compactionItem: "responsesItem" },
		elements: { replacementHistory: "responsesItem" },
	},
	/** KR8: an `anthropicServerTool` block's `block`, by its `type` for its `content`. `input` is masked. */
	serverToolBlock: {
		carrier: true,
		strings: ["type", "id", "name", "tool_use_id"],
		objects: { cache_control: "cacheControl" },
		variants: {
			key: "type",
			by: {
				/** KR8: its results, or its error object. */
				web_search_tool_result: {
					objects: { content: "webSearchError" },
					elements: { content: "webSearchResult" },
				},
				/** KR8: its search result or error object. */
				tool_search_tool_result: { objects: { content: "toolSearchContent" } },
			},
		},
	},
	/** KR8: an `anthropicServerTool` block's `block.cache_control`. */
	cacheControl: { strings: ["type", "ttl", "scope"] },
	/** KR8: an element of a `web_search_tool_result`'s `content[]`: only a `web_search_result` keeps fields. `url`, `title` and `page_age` are masked. */
	webSearchResult: {
		variants: { key: "type", by: { web_search_result: { strings: ["type", "encrypted_content"] } } },
	},
	/** KR8: a `web_search_tool_result`'s object `content`: only a `web_search_tool_result_error` keeps fields. */
	webSearchError: {
		variants: { key: "type", by: { web_search_tool_result_error: { strings: ["type", "error_code"] } } },
	},
	/** KR8: a `tool_search_tool_result`'s object `content`: only its search result and its error keep fields. */
	toolSearchContent: {
		variants: {
			key: "type",
			by: {
				/** KR8. */
				tool_search_tool_search_result: { strings: ["type"], elements: { tool_references: "toolReference" } },
				/** KR8. */
				tool_search_tool_result_error: { strings: ["type", "error_code"] },
			},
		},
	},
	/** KR8: an element of a tool search result's `tool_references[]`: only a `tool_reference` keeps fields. */
	toolReference: { variants: { key: "type", by: { tool_reference: { strings: ["type", "tool_name"] } } } },
	/**
	 * KR9: `compaction.preserveData.snapcompact`, and the archive of its `withoutThinking`. `text`,
	 * `textHead`, `textTail` and `withoutThinking.summary` are masked.
	 */
	snapcompact: {
		carrier: true,
		objects: { withoutThinking: "snapcompactView" },
		elements: { frames: "snapcompactFrame" },
	},
	/** KR9: an element of a snapcompact archive's `frames[]`. */
	snapcompactFrame: { strings: ["data", "mimeType", "detail", "font", "variant"] },
	/** KR9. */
	snapcompactView: { objects: { archive: "snapcompact" } },
	/** KR11: a `/btw` record. `question`, `answer` and `error` are masked. */
	btwRecord: { strings: ["id", "leafId", "status"], elements: { images: "btwImage", followUps: "btwTurn" } },
	/** KR11: an element of a `/btw` record's `followUps[]`. `question`, `answer` and `error` are masked. */
	btwTurn: { strings: ["status"], elements: { images: "btwImage" } },
	/** KR7, KR11: an element of a `/btw` record's or follow-up's `images[]`. */
	btwImage: { strings: ["type", "data", "mimeType"] },
};

/**
 * `entry` with every held secret replaced by its marker, for the stored copy
 * only: the live entry is never mutated. Returns `entry` itself when nothing
 * changes or `mask` is `null`. Signed blocks that change lose their signature;
 * provider replay state that changes is dropped whole.
 */
export function maskSessionEntry<T>(entry: T, mask: SessionStoreMask | null): T {
	if (mask === null || mask.empty) return entry;
	if (!isPlainObject(entry)) return maskFree(entry, "", mask) as T;
	return maskObject(entry, mask, entry.type === "session" ? POSITIONS.header : POSITIONS.entry) as T;
}

/** `record`, a `/btw` history record, with every held secret replaced by its marker, for the stored copy only. */
export function maskBtwRecord<T>(record: T, mask: SessionStoreMask | null): T {
	if (mask === null || mask.empty) return record;
	return (isPlainObject(record) ? maskObject(record, mask, POSITIONS.btwRecord) : maskFree(record, "", mask)) as T;
}

/**
 * `value` with every held secret replaced by its marker, for a stored copy of free data, such as a
 * subagent's yield data: no field in it is kept. The value itself is masked, never dropped.
 */
export function maskStoredData<T>(value: T, mask: SessionStoreMask | null): T {
	return mask === null || mask.empty ? value : (maskFree(value, "", mask) as T);
}

/** `update` with its title masked, so the store's title field holds what the title slot holds. */
export function maskTitleUpdate(update: SessionTitleUpdate, mask: SessionStoreMask | null): SessionTitleUpdate {
	if (mask === null || update.title === undefined) return update;
	const title = mask.maskText(update.title);
	return title === update.title ? update : { ...update, title };
}

/**
 * `value`, free content under `key` of its holder (an array index as a number), masked in the form
 * `stringifyJson` writes it. A primitive, a plain object or a real array is returned as itself when
 * masking changes nothing in it. Any other node (a `bigint`, a boxed primitive, a node with `toJSON`,
 * a class instance) comes back as its stored form in plain data, never as itself: the copy's later
 * readers, `prepareEntryForPersistence` (which rebuilds an object from its own keys) and
 * `stringifyJson`, then read the same form the walk masked.
 */
function maskFree(value: unknown, key: string | number, mask: SessionStoreMask): unknown {
	switch (typeof value) {
		case "string":
			return mask.maskText(value);
		case "bigint":
			return maskPlainForm(storedForm(value, key), mask);
		case "function":
			// A function is not written unless its `toJSON` gives a value.
			return typeof Reflect.get(value, "toJSON") === "function"
				? maskPlainForm(storedForm(value, key), mask)
				: value;
		case "object":
			if (value === null) return value;
			if (isPlainObject(value)) return maskObject(value, mask, undefined);
			if (isRealArray(value)) return maskArray(value, mask, undefined, false);
			return maskPlainForm(storedForm(value, key), mask);
		default:
			// A number or a boolean is written as it is; `undefined` or a symbol not at all.
			return value;
	}
}

/**
 * `form`, a node's stored form read through {@link storedForm}, masked as free content into plain
 * data. It is not read through `toJSON` again, so an object or array that still has one is copied
 * as its own enumerable keys or its items.
 */
function maskPlainForm(form: unknown, mask: SessionStoreMask): unknown {
	if (typeof form === "string") return mask.maskText(form);
	if (isRealArray(form)) return maskArray(form, mask, undefined, false);
	if (Array.isArray(form)) {
		const copy: unknown[] = [];
		for (let i = 0; i < form.length; i++) copy.push(maskFree(form[i], i, mask));
		return copy;
	}
	if (typeof form === "object" && form !== null) {
		if (isPlainObject(form)) return maskObject(form, mask, undefined);
		const copy: Record<string, unknown> = {};
		for (const key in form) {
			if (Object.hasOwn(form, key)) setOwn(copy, key, maskFree(Reflect.get(form, key), key, mask));
		}
		return copy;
	}
	// A number, a boolean or `null` is written as it is; a function, a symbol or `undefined` not at all.
	return typeof form === "function" || typeof form === "symbol" ? undefined : form;
}

/**
 * What `stringifyJson` writes for `value` under `key` before it reads any key of it: the result of
 * its callable `toJSON`, not read through `toJSON` again; then a `bigint` as its decimal string and a
 * boxed `String`, `Number` or `Boolean` as its primitive.
 */
function storedForm(value: object | bigint, key: string | number): unknown {
	const toJSON: unknown =
		typeof value === "bigint" ? Reflect.get(BigInt.prototype, "toJSON", value) : Reflect.get(value, "toJSON");
	const form: unknown = typeof toJSON === "function" ? toJSON.call(value, String(key)) : value;
	if (typeof form === "bigint") return form.toString();
	return typeof form === "object" && form !== null ? (boxedPrimitive(form) ?? form) : form;
}

const objectToString = Object.prototype.toString;

/** The primitive a boxed `String`, `Number` or `Boolean` holds, read as `JSON.stringify` reads it; `undefined` for any other object. */
function boxedPrimitive(value: object): string | number | boolean | undefined {
	// Without a `Symbol.toStringTag`, the tag names the object's internal slot; with one, each slot is tried.
	if (!(Symbol.toStringTag in value)) {
		switch (objectToString.call(value)) {
			case "[object String]":
				return String(value);
			case "[object Number]":
				return Number(value);
			case "[object Boolean]":
				return Boolean.prototype.valueOf.call(value);
			default:
				return undefined;
		}
	}
	if (holdsSlot(String.prototype.valueOf, value)) return String(value);
	if (holdsSlot(Number.prototype.valueOf, value)) return Number(value);
	return holdsSlot(Boolean.prototype.valueOf, value) ? Boolean.prototype.valueOf.call(value) : undefined;
}

/** Whether `value` has the internal slot the built-in `valueOf` reads, which throws on any other object. */
function holdsSlot(valueOf: () => unknown, value: object): boolean {
	try {
		valueOf.call(value);
		return true;
	} catch {
		return false;
	}
}

/** Whether `value` is a plain object: an `Object` or `null` prototype, no callable `toJSON`, no boxed primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		typeof Reflect.get(value, "toJSON") !== "function" &&
		boxedPrimitive(value) === undefined
	);
}

/** Whether `value` is a real array, written as its elements: no callable `toJSON`. */
function isRealArray(value: unknown): value is unknown[] {
	return Array.isArray(value) && typeof Reflect.get(value, "toJSON") !== "function";
}

/** `value`, a plain object, masked at `at`, or {@link DROP} when `at` is a carrier that masking changed. */
function maskChild(value: Record<string, unknown>, mask: SessionStoreMask, at: Position): unknown {
	const next = maskObject(value, mask, at);
	return next !== value && at.carrier ? DROP : next;
}

/**
 * `items`, an array in its stored form, masked: with `at`, each plain-object element at `at`; with
 * `keepStrings`, each primitive-string element kept; every other element free content.
 */
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
		if (typeof item === "string") {
			next = keepStrings ? item : mask.maskText(item);
		} else if (at !== undefined && isPlainObject(item)) {
			next = maskChild(item, mask, at);
			if (next !== item && at.variants !== undefined && variantOf(item, at.variants)?.pair) {
				droppedPair = item[at.variants.key];
			}
		} else {
			next = maskFree(item, i, mask);
		}
		if (copy === undefined) {
			// `Object.is`: a `NaN` left as it is is unchanged.
			if (Object.is(next, item)) continue;
			copy = items.slice(0, i);
		}
		if (next !== DROP) copy.push(next);
	}
	if (copy === undefined) return items;
	if (droppedPair === undefined || at?.variants === undefined) return copy;
	const { key } = at.variants;
	return copy.filter(item => !isRecord(item) || item[key] !== droppedPair);
}

/** `obj`, an object in its stored form, masked at `at`, a listed position of a plain object, or as free content without one. */
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
		const next = at === undefined ? maskFree(value, key, mask) : maskField(value, mask, at, variant, key);
		if (copy === undefined) {
			if (Object.is(next, value)) continue;
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

/**
 * The value under `key` of a plain object at `at` (with its `variant`), masked by the shape `at`
 * declares for `key`, judged on the live value; a value of any other shape is free content.
 */
function maskField(
	value: unknown,
	mask: SessionStoreMask,
	at: Position,
	variant: Position | undefined,
	key: string,
): unknown {
	if (typeof value === "string") return listed(at, variant, "strings", key) ? value : mask.maskText(value);
	if (isPlainObject(value)) {
		if (listed(at, variant, "wholeObjects", key)) return value;
		const child = placed(at, variant, "objects", key);
		return child === undefined ? maskObject(value, mask, undefined) : maskChild(value, mask, child);
	}
	if (isRealArray(value)) {
		if (listed(at, variant, "stringArrays", key)) return maskArray(value, mask, undefined, true);
		return maskArray(value, mask, placed(at, variant, "elements", key), false);
	}
	return maskFree(value, key, mask);
}

/** Whether `at`'s `field` list, or its variant's, names `key`. */
function listed(at: Position, variant: Position | undefined, field: ListedField, key: string): boolean {
	return at[field]?.includes(key) === true || variant?.[field]?.includes(key) === true;
}

/** The position `at`'s `field` map, or its variant's, places `key` at, or `undefined` for free data. */
function placed(
	at: Position,
	variant: Position | undefined,
	field: "objects" | "elements",
	key: string,
): Position | undefined {
	const name = ownValue(variant?.[field], key) ?? ownValue(at[field], key);
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
