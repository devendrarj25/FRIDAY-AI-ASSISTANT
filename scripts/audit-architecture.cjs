#!/usr/bin/env node
/**
 * FRIDAY · clean-architecture audit (report only).
 *
 * Runs before a release and looks for the four things that quietly break an
 * upgradeable project:
 *   • duplicate implementations — identical file contents in two places
 *   • conflicting implementations — same filename, same role, different bodies
 *   • orphan modules — source files nothing else imports
 *   • legacy paths — historical folder names that must not come back
 *
 * NOTHING is deleted or rewritten. Uncertain findings are printed for review;
 * only `--strict` turns hard conflicts (duplicate byte-identical runtime files)
 * into a non-zero exit so a release can be stopped deliberately.
 *
 *   node scripts/audit-architecture.cjs [--strict] [--json FILE]
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");

const SCAN_DIRS = ["src", "electron", "core", "scripts", "updater", "builder", "installer"];
const SKIP = new Set([
  "node_modules",
  "release",
  "dist",
  "dist-electron",
  ".git",
  "backup",
  "temporary",
  "__tests__",
]);
const CODE = /\.(ts|tsx|js|jsx|cjs|mjs)$/;

/** Folder names that were used historically and must never reappear. */
const LEGACY_PATHS = [
  "src/pages",
  "src/lib/lovable",
  "electron/updater-old",
  "scripts/release.cjs",
];

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (CODE.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

function audit() {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
  const byHash = new Map();
  const byName = new Map();
  const imports = new Set();

  for (const file of files) {
    const body = fs.readFileSync(file, "utf8");
    // Ignore whitespace-only differences when deciding "identical".
    const hash = crypto.createHash("sha1").update(body.replace(/\s+/g, " ").trim()).digest("hex");
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(rel(file));

    const name = path.basename(file);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(rel(file));

    for (const m of body.matchAll(/(?:from\s+|require\()\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        imports.add(path.basename(spec).replace(CODE, ""));
      }
    }
  }

  const duplicates = [...byHash.values()].filter((group) => group.length > 1);
  const conflicting = [...byName.entries()]
    .filter(([name, group]) => group.length > 1 && name !== "index.ts" && name !== "index.cjs")
    .filter(([, group]) => !duplicates.some((d) => d.join() === group.join()))
    .map(([name, files]) => ({ name, files }));

  const orphans = files.map(rel).filter((f) => {
    const base = path.basename(f).replace(CODE, "");
    if (base === "index" || f.startsWith("src/routes/") || f.startsWith("scripts/")) return false;
    return !imports.has(base);
  });

  const legacy = LEGACY_PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));
  const builderResidue = detectBuilderResidue();

  return { files: files.length, duplicates, conflicting, orphans, legacy, builderResidue };
}

/** AI coding tools may edit this repo; they must not become a package or Vite preset. */
function detectBuilderResidue() {
  const hits = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const names = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
  for (const name of names) {
    if (name.startsWith("@lovable") || name.includes("lovable")) hits.push(`package.json:${name}`);
  }
  const lock = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  if (/lovable-core-prod|sandbox-npm-cache|@lovable\.dev/.test(lock)) {
    hits.push("package-lock.json:lovable-or-sandbox-cache");
  }
  const vite = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
  if (vite.includes("@lovable")) hits.push("vite.config.ts:@lovable");
  return hits;
}

module.exports = { audit };

if (require.main === module) {
  const strict = process.argv.includes("--strict");
  const jsonAt = process.argv.indexOf("--json");
  const report = audit();

  console.log(`[friday] architecture audit — ${report.files} source files`);
  for (const group of report.duplicates)
    console.log(`[friday] DUPLICATE   identical content: ${group.join("  ==  ")}`);
  for (const c of report.conflicting)
    console.log(`[friday] REVIEW      same name, different body: ${c.files.join("  vs  ")}`);
  for (const o of report.orphans) console.log(`[friday] REVIEW      no importer found: ${o}`);
  for (const l of report.legacy) console.log(`[friday] LEGACY      historical path present: ${l}`);
  for (const h of report.builderResidue)
    console.log(`[friday] FORBIDDEN  AI-builder residue: ${h}`);
  if (
    !report.duplicates.length &&
    !report.conflicting.length &&
    !report.legacy.length &&
    !report.builderResidue.length
  )
    console.log("[friday] ok         no duplicate, conflicting, legacy or builder residue");

  if (jsonAt >= 0 && process.argv[jsonAt + 1]) {
    fs.mkdirSync(path.dirname(process.argv[jsonAt + 1]), { recursive: true });
    fs.writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify(report, null, 2)}\n`);
  }

  // Orphans and same-name files are advisory; only true duplicates, a
  // resurrected legacy path, or AI-builder residue can stop a release, and
  // only when asked to.
  if (strict && (report.duplicates.length || report.legacy.length || report.builderResidue.length))
    process.exit(1);
}
