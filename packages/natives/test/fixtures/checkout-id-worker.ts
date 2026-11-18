// One of several builds that start at once, or a reader watching the id file while they run.
// `gate[0]` is the round released, `gate[1]` the number of threads waiting at it, `gate[2]` the
// round whose watchers stop.
import * as fs from "node:fs";
import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { checkoutId } from "../../native/workspace-sources.js";

const gate = new Int32Array(workerData.gate as SharedArrayBuffer);
parentPort!.on("message", ({ repo, round, role }: { repo: string; round: number; role: "build" | "watch" }) => {
	Atomics.add(gate, 1, 1);
	Atomics.wait(gate, 0, round);
	if (role === "build") {
		parentPort!.postMessage(checkoutId(repo, true));
		return;
	}
	// Every read that finds the id file without a whole id in it, as a build that reads it then
	// would find it.
	const idPath = path.join(repo, ".git", "omp-checkout-id");
	let incomplete = 0;
	while (Atomics.load(gate, 2) <= round) {
		try {
			if (!/^[0-9a-f-]{36}$/.test(fs.readFileSync(idPath, "utf8").trim())) incomplete++;
		} catch {
			// Not made yet.
		}
	}
	parentPort!.postMessage(incomplete);
});
