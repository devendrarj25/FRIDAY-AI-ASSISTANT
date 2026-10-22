// Runs expensive discovery outside Electron's main/UI thread.
// One worker file, four jobs, so the app never spawns a second scanner:
//   "scan"        → the workspace folder overview shown in the UI
//   "index"       → the architecture index used by self-maintenance
//   "env-refresh" → the environment registry probes (many synchronous child
//                   processes: npm, Python, pip). On the main thread they
//                   froze the window into "Not Responding".
//   "env-repair"  → one registry repair, or all of them
const { parentPort, workerData } = require("node:worker_threads");

function runJob(data) {
  if (data.job === "env-refresh" || data.job === "env-repair") {
    // A worker has no Electron `app`: the main thread hands over what the
    // registry would otherwise ask Electron for.
    if (data.packaged) process.env.FRIDAY_PACKAGED_APP = JSON.stringify(data.packaged);
    if (data.resourcesPath && !process.resourcesPath) process.resourcesPath = data.resourcesPath;
    const registry = require(data.registryPath);
    if (data.job === "env-refresh") return registry.refreshRegistry();
    return data.id ? registry.repairComponent(String(data.id)) : registry.repairAll();
  }
  if (data.job === "index") return require("./architecture-index.cjs").buildIndex(data.root);
  return require("./workspace.cjs").scanWorkspace(data.root);
}

try {
  parentPort?.postMessage({ ok: true, result: runJob(workerData) });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
