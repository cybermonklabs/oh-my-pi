import * as path from "node:path";
import type { BunPlugin } from "bun";

/**
 * Plugins of every browser bundle of the dashboard client's code: the
 * dashboard's own (`build.ts`) and the HTML export viewer's, which shows the
 * client's trace views (`collab-web/scripts/build-export-viewer.ts`).
 * `node:util/types`, which Bun's browser target leaves without exports,
 * resolves to the browser checks in `client/node-util-types.ts`, so the
 * pi-utils JSON writer the client shows entries with runs in the browser.
 */
export const clientBundlePlugins: BunPlugin[] = [
	{
		name: "browser-node-util-types",
		setup(build) {
			build.onResolve({ filter: /^node:util\/types$/ }, () => ({
				path: path.join(import.meta.dir, "client", "node-util-types.ts"),
			}));
		},
	},
];
