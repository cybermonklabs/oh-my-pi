import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

/**
 * Re-emits `stream` with its terminal error tagged with the stored credential
 * row that served the request, as pi-ai's stream driver tags a real failure.
 */
export function servedByCredential(
	stream: AssistantMessageEventStream,
	credentialId: number,
): AssistantMessageEventStream {
	const served = new AssistantMessageEventStream();
	void (async () => {
		for await (const event of stream) {
			if (event.type === "error") event.error.credentialId = credentialId;
			served.push(event);
		}
	})();
	return served;
}
