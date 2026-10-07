/** Initialise FRIDAY's canonical folders and SQLite schema with the live venv. */
const fs = require("node:fs");
const path = require("node:path");
const fridayRoot = require("./friday-root.cjs");
const pythonRuntime = require("./python-runtime.cjs");
const paths = require("../electron/friday-paths.cjs");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
paths.restoreCheckoutCollisions(root);
const python = pythonRuntime.resolveVenvPython();
// One selected folder owns everything. Nothing is written to AppData or the
// user home; without a selected folder this falls back to a development
// folder inside the checkout and says so.
const picked = fridayRoot.workspaceRootOrDev();
const workspace = picked.root;
const dataRoot = process.env.FRIDAY_DATA_DIR || fridayRoot.layout(workspace).data;
if (picked.development) {
  console.log(`[friday] no FRIDAY folder selected yet — using dev folder ${workspace}`);
}

if (!fs.existsSync(python)) {
  console.error(`[friday] isolated Python is missing: ${python}`);
  process.exit(1);
}
// Same contract the EXE uses at boot (`ensureStructure`) — not a second folder list.
paths.setRoot(workspace);
paths.ensureStructure(workspace);
fs.mkdirSync(dataRoot, { recursive: true });

const wake = require("../electron/wake-engine.cjs");
const wakeModel = wake.installBundledModel();
if (wakeModel) {
  console.log(`[friday] wake model ready: ${wakeModel}`);
} else {
  console.log(
    "[friday] bundled wake model not copied — transcript fallback remains until the app copies it",
  );
}

const kernel = paths.resolveKernelSource(root) || path.join(root, "kernel");
// ONE canonical database: <FRIDAY folder>/database/friday.sqlite3, exactly the
// file kernel/main.py opens. Nothing writes a second store under data/.
const db = process.env.FRIDAY_DB_PATH || fridayRoot.layout(workspace).database;
fs.mkdirSync(path.dirname(db), { recursive: true });

const code = [
  "import json, sqlite3, sys",
  `sys.path.insert(0, ${JSON.stringify(kernel)})`,
  "from db import SCHEMA",
  `db = ${JSON.stringify(db)}`,
  "conn = sqlite3.connect(db)",
  "conn.executescript(SCHEMA)",
  "conn.commit()",
  "integrity = conn.execute('PRAGMA integrity_check').fetchone()[0]",
  "tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]",
  "conn.close()",
  "print(json.dumps({'integrity': integrity, 'tables': tables}))",
].join("\n");
const result = spawnSync(python, ["-c", code], { encoding: "utf8", cwd: root });
if (result.status !== 0) {
  console.error(
    `[friday] database initialization failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
  );
  process.exit(1);
}
const report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
if (report.integrity !== "ok" || !report.tables.includes("chats")) {
  console.error(`[friday] database verification failed: ${JSON.stringify(report)}`);
  process.exit(1);
}
console.log(`[friday] runtime ready: ${workspace}`);
console.log(
  `[friday] database ready: ${db} (${report.tables.length} tables, integrity ${report.integrity})`,
);
