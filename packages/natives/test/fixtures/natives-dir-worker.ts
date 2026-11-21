// Worker half of "gives a worker thread the main thread's answer": reports the natives
// directory this thread's own copy of the module resolves.
import { getNativesDir } from "../../native/natives-dir.js";

postMessage(getNativesDir());
