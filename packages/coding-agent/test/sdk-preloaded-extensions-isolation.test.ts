/**
 * Regression guard for issue #2190 / PR #2193 review.
 *
 * The CLI loads extensions early to parse custom flags, then hands the result
 * back through `preloadedExtensions` so its OWN session can reuse the loaded
 * instances without redoing the FS scan. `createAgentSession()` augments the
 * result with inline extensions (autoresearch + custom-tools wrapper), so it
 * MUST clone the caller's `extensions` array before mutating it — otherwise
 * the caller's array accumulates session-local wrappers it never authored.
 *
 * Subagent forwarding is a separate path (`preloadedExtensionPaths`) which
 * reloads extensions per session so each session's `ExtensionAPI` is its own.
 * The paths a session forwards name each file of a caller-loaded result at
 * its prepared entry's scope; a file with no prepared entry is the caller's
 * own, `explicit`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("createAgentSession preloadedExtensions isolation (issue #2190)", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preloaded-ext-"));
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	it("does not mutate the caller's extensions array when preloadedExtensions is provided", async () => {
		const preloaded: LoadExtensionsResult = {
			extensions: [],
			errors: [],
			runtime: {
				flagValues: new Map(),
				pendingProviderRegistrations: [],
				// Cast: only the fields we touch matter; the SDK happily accepts a
				// minimal runtime when no extension hooks fire.
			} as unknown as LoadExtensionsResult["runtime"],
		};
		const beforeLength = preloaded.extensions.length;
		const beforeArrayRef = preloaded.extensions;

		const { session } = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			// Disable everything that would touch the network / FS scans.
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			// The session's own `extensionsResult` carries inline wrappers, but the
			// caller's array (and its identity) must be untouched.
			expect(preloaded.extensions).toBe(beforeArrayRef);
			expect(preloaded.extensions.length).toBe(beforeLength);
		} finally {
			await session.dispose();
		}
	});
});

describe("createAgentSession preloadedExtensions forwarding to child sessions", () => {
	let dir: string;
	let authStorage: AuthStorage;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preloaded-ext-forward-"));
		authStorage = createInMemoryAuthStorage();
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	it("forwards a caller-loaded extension that has no prepared entry as the caller's explicit one", async () => {
		const file = path.join(dir, "caller-extension.ts");
		fs.writeFileSync(file, "export default function () {}\n");
		const loaded = await loadExtensions([{ path: file, scope: "explicit" }], dir);
		expect(loaded.errors).toEqual([]);
		// An SDK caller that loads extensions itself hands over the bound extensions without prepared entries.
		const preloaded: LoadExtensionsResult = {
			extensions: loaded.extensions,
			errors: loaded.errors,
			runtime: loaded.runtime,
		};

		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(dir, "models.yml")),
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			expect(session.extensionPaths).toEqual([{ path: file, scope: "explicit" }]);
		} finally {
			await session.dispose();
		}
	});
});
