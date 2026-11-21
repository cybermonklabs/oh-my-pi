/**
 * An `E2E=1` run sees the environment omp itself would see.
 *
 * A test process does not load the developer's own dotenv files (`packages/utils/src/env.ts`): the
 * agent dir's `.env`, the config root's and `~/.env`. A live provider test takes its keys and the
 * settings beside them from there (a Bedrock key's `AWS_SESSION_TOKEN`, Vertex's
 * `GOOGLE_APPLICATION_CREDENTIALS`), so when `E2E` is set in the environment this module loads them
 * with the loader's own rule: in the loader's order, a name already set left as it is, an empty
 * value never hiding a later file's, and `OTEL_*` kept out of the environment
 * (`claimOmpOtelEnvFileEntry`). Import it before the provider code reads the environment.
 */
import * as os from "node:os";
import * as path from "node:path";
import {
	$flag,
	claimOmpOtelEnvFileEntry,
	getAgentDir,
	getConfigRootDir,
	isMacosMallocStackLoggingEnvName,
	parseEnvFile,
	refreshDirsFromEnv,
} from "@oh-my-pi/pi-utils";

if ($flag("E2E")) {
	for (const dir of [getAgentDir(), getConfigRootDir(), os.homedir()]) {
		const file = parseEnvFile(path.join(dir, ".env"));
		for (const key in file) {
			if (isMacosMallocStackLoggingEnvName(key) || claimOmpOtelEnvFileEntry(key, file[key])) continue;
			if (!Bun.env[key]) Bun.env[key] = file[key];
		}
	}
	refreshDirsFromEnv();
}
