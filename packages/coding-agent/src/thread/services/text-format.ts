/**
 * YAML, TOML, JSONC, JSON5 and XML parses a subagent worker forwards to main
 * (`../text-format-forwarding`).
 *
 * Main side: serves the worker's `parseTextFormat` calls on main's heap. Worker
 * side: gives the link to the forwarders the worker entry's early import of
 * that module installed.
 */
import type { ThreadService } from "../services";
import { attachTextFormatLink, parseTextFormatForWorker } from "../text-format-forwarding";

/** Text-format parses across worker links; see the module doc. */
export const textFormatThreadService: ThreadService = {
	name: "textFormat",

	installMain(peer) {
		peer.link.handle("parseTextFormat", parseTextFormatForWorker);
	},

	installWorker(link) {
		attachTextFormatLink(link);
	},
};
