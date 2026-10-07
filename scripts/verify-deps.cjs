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
