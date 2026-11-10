import { afterEach, expect, it } from "bun:test";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

it("agent:// progress for an aborted run does not promise an output it will never publish", async () => {
	AgentRegistry.global().register({
		id: "AbortedWorker",
		displayName: "sub",
		kind: "sub",
		session: null,
		sessionFile: null,
		status: "aborted",
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://AbortedWorker") as never);

	expect(resource.content).toContain("# AbortedWorker (aborted)");
	expect(resource.content).toContain("The run was aborted and will never publish output");
	expect(resource.content).not.toContain("shows progress until the run publishes its output");
});

it("agent:// progress for a run still going keeps the published-output sentence", async () => {
	AgentRegistry.global().register({
		id: "RunningWorker",
		displayName: "sub",
		kind: "sub",
		session: null,
		sessionFile: null,
		status: "running",
	});

	const resource = await new AgentProtocolHandler().resolve(new URL("agent://RunningWorker") as never);

	expect(resource.content).toContain("# RunningWorker (running)");
	expect(resource.content).toContain("shows progress until the run publishes its output");
});
