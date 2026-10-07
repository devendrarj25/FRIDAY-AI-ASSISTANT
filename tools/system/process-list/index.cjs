// FRIDAY · tools/system/process-list
//
// tasklist / ps via electron/sandbox.cjs runCommand. Read-only.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

async function run() {
  const sandbox = require(path.join(ELECTRON, "sandbox.cjs"));
  const win = process.platform === "win32";
  const result = win
    ? await sandbox.runCommand("tasklist", ["/fo", "csv", "/nh"], process.cwd(), 8000)
    : await sandbox.runCommand(
        "ps",
        ["-eo", "pid,user,rss,comm", "--no-headers"],
        process.cwd(),
        8000,
      );
  const lines = String(result.output || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);
  return {
    ok: Boolean(result.ok) || lines.length > 0,
    platform: process.platform,
    count: lines.length,
    processes: lines,
    ...(result.ok ? {} : { error: result.output }),
  };
}

module.exports = { run };
