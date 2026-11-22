import type { AssistantMessage, Model, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Creates a Codex model whose provider policy enables Harmony leak mitigation. */
export function createHarmonyMitigationModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	});
}

/** Runs `fn` with `PI_DIALECT` unset, so the agent calls tools natively, and puts the variable back after it. */
export async function withNativeDialectEnv<T>(fn: () => T | Promise<T>): Promise<T> {
	const previous = Bun.env.PI_DIALECT;
	delete Bun.env.PI_DIALECT;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete Bun.env.PI_DIALECT;
		} else {
			Bun.env.PI_DIALECT = previous;
		}
	}
}

/**
 * Runs the fixture at `fixturePath` as a process of its own with `PI_NO_STRICT` set, which the providers read once,
 * when they load, and neither `PI_DIALECT` nor Claude Code's experimental-beta kill switch; gives what it writes to
 * stdout.
 */
export async function runUnderNoStrict(fixturePath: string): Promise<string> {
	const child = Bun.spawn([process.execPath, fixturePath], {
		env: {
			...process.env,
			PI_NO_STRICT: "1",
			PI_DIALECT: undefined,
			CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`The process exited with ${exitCode}: ${stderr}`);
	return stdout;
}

/** Creates a timestamped user message for agent-loop tests. */
export function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** Creates a timestamped mock assistant message with zero usage. */
export function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
