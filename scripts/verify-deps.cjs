/**
 * FRIDAY — main-process dependency guard.
 *
 * electron-builder packs only `dependencies` into app.asar. A bare `require()`
 * in electron/*.cjs that resolves in development through a transitive dev-only
 * package disappears in the installed build and the app dies before its first
 * window ("Cannot find module ..."). This check fails the build instead.
 *
 * Read-only. Exit code 1 means a required module is not a production dependency.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies || {}));

// Provided by the runtime itself, never bundled.
const builtin = new Set([...require("node:module").builtinModules, "electron"]);
const bare = (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("node:");
const packageName = (id) =>
  id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];

const dir = path.join(root, "electron");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".cjs") || f.endsWith(".js"))
  .map((f) => path.join(dir, f));

let failed = 0;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    const id = match[1];
    if (!bare(id)) continue;
    const name = packageName(id);
    if (builtin.has(name) || declared.has(name)) continue;
    console.error(
      `[friday] MISSING DEPENDENCY  ${path.relative(root, file)} requires "${id}" ` +
        `but "${name}" is not in package.json dependencies.`,
    );
    failed++;
  }
}

if (failed) {
  console.error(`[friday] dependency check failed (${failed} issue(s)).`);
  process.exit(1);
}
console.log(`[friday] ok       main-process dependencies (${files.length} files checked)`);

const { spawnSync } = require("node:child_process");
const requirements = fs.readFileSync(path.join(root, "kernel", "requirements.txt"), "utf8");
if (!/^\s*av>=17\.0\.0,<19\s*$/m.test(requirements)) {
  console.error(
    '[friday] kernel/requirements.txt must pin av>=17.0.0,<19 (faster-whisper 1.2.1 / PyAV 19).',
  );
  process.exit(1);
}
const pythons = [
  process.env.FRIDAY_PYTHON,
  path.join(root, ".venv", "bin", "python"),
  path.join(root, ".venv", "Scripts", "python.exe"),
  "python3",
].filter(Boolean);
let avChecked = false;
for (const python of pythons) {
  const probe = spawnSync(
    python,
    [
      "-c",
      "import json,sys; sys.path.insert(0,'kernel'); import stt; print(json.dumps(stt.av_guard()))",
    ],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
  if (probe.status !== 0 || !probe.stdout) continue;
  avChecked = true;
  let guard = null;
  try {
    guard = JSON.parse(probe.stdout.trim().split(/\n/).pop());
  } catch {
    guard = null;
  }
  if (!guard) continue;
  if (!guard.installed) {
    console.log(`[friday] skip     av is not installed (${guard.reason})`);
    break;
  }
  if (!guard.ok) {
    console.error(`[friday] ${guard.reason}`);
    console.error(`[friday] fix      ${guard.fix}`);
    process.exit(1);
  }
  console.log(`[friday] ok       av ${guard.version} inside ${guard.requirement}`);
  break;
}
if (!avChecked) {
  console.log("[friday] skip     av pin check: no Python could import kernel/stt.py");
}
