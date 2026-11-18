/**
 * `omp auth-broker logout` without `--provider`: the picker offers the providers a logout
 * can still remove a login from. A provider whose only login a failure disabled is one of
 * them — the logout records the user's removal on that tombstone, which otherwise keeps
 * reading as a login a new one restores, so turns go on waiting for its key.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, isRecoverableDisabledCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import * as oauthTerminal from "@oh-my-pi/pi-coding-agent/cli/oauth-terminal";
import { __resetDirsFromEnvForTests, getAgentDbPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

/** What `setAgentDir` sets or clears, put back after each test. */
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

describe("auth-broker logout provider picker", () => {
	let agentDir = "";
	let savedEnv: Record<string, string | undefined> = {};

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logout-agent-"));
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(agentDir);
	});

	test("offers a provider whose only login a failure disabled, and retires its tombstone", async () => {
		// If this regresses, the provider is missing from the picker and the user cannot log out of
		// a login a failure disabled, so it keeps reading as one a new login restores.
		const storage = await AuthStorage.create(getAgentDbPath());
		try {
			await storage.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
					email: "disabled@example.test",
				},
			]);
			await storage.credentials.disable(
				storage.credentials.list("anthropic")[0]!.id,
				"oauth refresh failed: invalid_grant",
			);
		} finally {
			storage.close();
		}
		const offered: string[][] = [];
		vi.spyOn(oauthTerminal, "pickIndex").mockImplementation(async (_rl, _title, labels) => {
			offered.push([...labels]);
			return labels.indexOf("anthropic");
		});
		let stdout = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += String(chunk);
			return true;
		});

		await runAuthBrokerCommand({ action: "logout", flags: {} });
		write.mockRestore();

		expect(offered).toEqual([["anthropic"]]);
		expect(stdout).toContain("Logged out of anthropic");
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
		try {
			const tombstones = await store.listDisabledCredentials("anthropic");
			expect(tombstones.some(tombstone => isRecoverableDisabledCredential(tombstone, tombstones))).toBe(false);
		} finally {
			store.close();
		}
	});
});
