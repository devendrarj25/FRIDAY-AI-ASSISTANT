// Runs expensive workspace discovery outside Electron's main/UI thread.
// Two jobs share this worker so the app never spawns a second scanner:
//   "scan"  → the workspace folder overview shown in the UI
//   "index" → the architecture index used by self-maintenance
const { parentPort, workerData } = require("node:worker_threads");
const { scanWorkspace } = require("./workspace.cjs");
const { buildIndex } = require("./architecture-index.cjs");

try {
  const result =
    workerData.job === "index" ? buildIndex(workerData.root) : scanWorkspace(workerData.root);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
