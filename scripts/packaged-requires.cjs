#!/usr/bin/env node
/**
 * Fail a pack in seconds when an electron module requires a file that
 * app.asar does not contain.
 *
 *   node scripts/packaged-requires.cjs
 *   node scripts/packaged-requires.cjs --asar release/win-unpacked/resources/app.asar
 *
 * CMD, Test Build, and Release run this from scripts/build-pipeline.cjs
 * after package and before readiness. No workflow file lists the phase.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/**
 * Relative requires that are allowed to miss app.asar.
 * Each entry must be lazy (inside a function) and guarded (try/catch).
 * scripts/release-engine.cjs is inside the asar, so it is not listed here.
 */
const LAZY_GUARDED = [];

const PACKED_PREFIXES = ["electron/", "dist-desktop/"];
const PACKED_FILES = new Set(["package.json", "scripts/release-engine.cjs"]);

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".cjs")) out.push(full);
  }
  return out;
}

function normaliseList(files) {
  return (files || []).map((file) =>
    String(file || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, ""),
  );
}

function insideTemplate(source, index) {
  let open = false;
  for (let i = 0; i < index; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "`") open = !open;
  }
  return open;
}

function relativeRequires(source) {
  const found = [];
  const literal = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;
  let match = literal.exec(source);
  while (match) {
    // A require written into a generated script is not loaded with this file.
    if (!insideTemplate(source, match.index)) found.push({ spec: match[2], index: match.index });
    match = literal.exec(source);
  }
  const engine =
    /require\(\s*path\.(?:resolve|join)\(\s*__dirname\s*,\s*(['"])\.\.\1\s*,\s*(['"])scripts\2\s*,\s*(['"])([^'"]+)\3/g;
  match = engine.exec(source);
  while (match) {
    found.push({ spec: `../scripts/${match[4]}`, index: match.index });
    match = engine.exec(source);
  }
  return found;
}

function candidatePaths(fromFile, spec, root) {
  const raw = path.normalize(path.join(path.dirname(fromFile), spec));
  const rel = path.relative(root, raw).split(path.sep).join("/");
  const candidates = [rel];
  if (!path.extname(rel)) {
    candidates.push(
      `${rel}.cjs`,
      `${rel}.js`,
      `${rel}.json`,
      `${rel}/index.cjs`,
      `${rel}/index.js`,
    );
  }
  return candidates;
}

function isGuarded(file, spec) {
  return LAZY_GUARDED.some((row) => row.file === file && row.spec === spec);
}

function checkRequires({ root = ROOT, asarFiles }) {
  const listed = new Set(normaliseList(asarFiles).filter(Boolean));
  const failures = [];
  const electronDir = path.join(root, "electron");
  for (const file of walk(electronDir)) {
    const relFile = path.relative(root, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    for (const hit of relativeRequires(source)) {
      const tried = candidatePaths(file, hit.spec, root);
      const inside = tried.some((candidate) => listed.has(candidate));
      if (inside || isGuarded(relFile, hit.spec)) continue;
      failures.push({ file: relFile, spec: hit.spec, tried });
    }
  }
  return failures;
}

/**
 * The glob subset electron-builder `files` entries use: `**`, `*`, `?`, `[abc]` and `{a,b}`, with dot files
 * matched and `/` as the only separator. Written here so the check does not depend on which minimatch major
 * npm happened to hoist out of electron-builder.
 */
function globToRegExp(pattern) {
  const text = String(pattern).replace(/^\.\//, "");
  let out = "";
  let braces = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "*") {
      if (text[i + 1] === "*") {
        i += 1;
        if (text[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") {
      braces += 1;
      out += "(?:";
    } else if (ch === "}" && braces) {
      braces -= 1;
      out += ")";
    } else if (ch === "," && braces) out += "|";
    else if (ch === "[") {
      const end = text.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        const body = text
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = end;
      }
    } else out += ch.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// A minimatch module from electron-builder: version 3 exports the matcher itself, version 10 exports it as
// `minimatch`. Kept for the tests that compare this file's matcher with the real one.
function matcherFrom(loaded) {
  return typeof loaded === "function" ? loaded : loaded.minimatch;
}

function globMatches(rel, pattern) {
  return globToRegExp(pattern).test(String(rel).split(path.sep).join("/"));
}

function filesFromPatterns(root, patterns) {
  const positive = patterns.filter((pattern) => pattern && !String(pattern).startsWith("!"));
  const negative = patterns
    .filter((pattern) => String(pattern).startsWith("!"))
    .map((pattern) => String(pattern).slice(1));
  const matched = [];
  const skip = new Set(["node_modules", ".git", "release", ".cache", "runtime"]);
  function visit(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name) && dir === root) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const yes = positive.some((pattern) => globMatches(rel, pattern));
      const no = negative.some((pattern) => globMatches(rel, pattern));
      if (yes && !no) matched.push(rel);
    }
  }
  visit(root);
  return matched;
}

function findAsar(root) {
  const release = path.join(root, "release");
  const direct = [
    path.join(release, "win-unpacked", "resources", "app.asar"),
    path.join(release, "linux-unpacked", "resources", "app.asar"),
    path.join(release, "mac", "FRIDAY.app", "Contents", "Resources", "app.asar"),
  ];
  for (const file of direct) {
    if (fs.existsSync(file)) return file;
  }
  if (!fs.existsSync(release)) return null;
  const stack = [release];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.name === "app.asar") return full;
    }
  }
  return null;
}

function listAsar(file) {
  const asar = require("@electron/asar");
  return normaliseList(asar.listPackage(file));
}

/**
 * Folders that ship beside app.asar (extraResources), never inside it. Inside the packaged app `__dirname/..` is
 * the archive root, so `path.join(__dirname, "..", "kernel", ...)` names a file that does not exist there, and
 * Python or a child process cannot read from an archive anyway. A module may name such a folder from `__dirname`
 * only as the checkout fallback behind electron/resource-paths.cjs or `process.resourcesPath`.
 */
const OUTSIDE_ASAR = new Set([
  "kernel",
  "docs",
  "config",
  "skills",
  "tools",
  "agents",
  "plugins",
  "workflows",
  "modules",
  "installer",
  "updater",
  "builder",
  "resources",
  "public",
  "memory",
  "database",
  "models",
  "runtime",
  "src",
  "core",
  "scripts",
]);

function checkAsarPaths({ root = ROOT } = {}) {
  const failures = [];
  const reach = /(?:join|resolve)\(\s*__dirname\s*,\s*(['"])\.\.\1\s*,\s*(['"])([A-Za-z_-]+)\2/g;
  for (const file of walk(path.join(root, "electron"))) {
    const relFile = path.relative(root, file).split(path.sep).join("/");
    if (relFile === "electron/resource-paths.cjs") continue;
    const source = fs.readFileSync(file, "utf8");
    const resolved = /resource-paths|resourcesPath/.test(source);
    reach.lastIndex = 0;
    let match = reach.exec(source);
    while (match) {
      const folder = match[3];
      const rest = source.slice(match.index + match[0].length, match.index + match[0].length + 40);
      const releaseEngine =
        folder === "scripts" && /^\s*,\s*['"]release-engine\.cjs['"]/.test(rest);
      if (OUTSIDE_ASAR.has(folder) && !releaseEngine && !resolved) {
        failures.push({
          file: relFile,
          folder,
          line: source.slice(0, match.index).split("\n").length,
        });
      }
      match = reach.exec(source);
    }
  }
  return failures;
}

/**
 * Scripts the installed app loads from resources/scripts (outside the archive) must not require a sibling `electron` folder by relative path:
 * there `electron/` is inside app.asar, so the relative path finds nothing. They use scripts/electron-module.cjs.
 * The set is what the main process loads or spawns, plus the scripts those load.
 */
const PACKAGED_SCRIPT_ROOTS = [
  "scripts/env-registry.cjs",
  "scripts/setup-notices.cjs",
  "scripts/stage-toolchain.cjs",
  "scripts/identity.cjs",
  "scripts/win-spawn.cjs",
];

function checkPackagedScripts({ root = ROOT, roots = PACKAGED_SCRIPT_ROOTS } = {}) {
  const failures = [];
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    let source;
    try {
      source = fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return;
    }
    // Comments may quote the pattern (scripts/electron-module.cjs explains it); only code counts.
    source = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    const direct = /require\(\s*(['"])\.\.\/electron\/[^'"]+\1\s*\)/g;
    let hit = direct.exec(source);
    while (hit) {
      failures.push({ file: rel, spec: hit[0] });
      hit = direct.exec(source);
    }
    const local = /require\(\s*(['"])\.\/([A-Za-z0-9._-]+)\1\s*\)/g;
    let next = local.exec(source);
    while (next) {
      const name = /\.(?:cjs|js|json)$/.test(next[2]) ? next[2] : `${next[2]}.cjs`;
      visit(`scripts/${name}`);
      next = local.exec(source);
    }
  };
  for (const rel of roots) visit(rel);
  return failures;
}

/** Every file or folder the code asks resource-paths for must be one electron-builder copies into resources/. */
function checkResourceReferences({ root = ROOT, extraResources } = {}) {
  let shipped = extraResources;
  if (!shipped) {
    const yaml = require("js-yaml");
    const cfg = yaml.load(fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8"));
    shipped = (cfg.extraResources || []).map((row) =>
      typeof row === "string" ? row : row.to || "",
    );
  }
  const failures = [];
  const ask = /resolveResource(?:File|Dir)\(\s*(['"])([^'"]+)\1/g;
  for (const file of walk(path.join(root, "electron"))) {
    const relFile = path.relative(root, file).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf8");
    ask.lastIndex = 0;
    let match = ask.exec(source);
    while (match) {
      const wanted = match[2].replace(/\\/g, "/");
      const covered = shipped.some((to) => to && (wanted === to || wanted.startsWith(`${to}/`)));
      if (!covered) failures.push({ file: relFile, wanted });
      match = ask.exec(source);
    }
  }
  return failures;
}

function formatFailure(row) {
  return `${row.file} requires ${row.spec} — not in app.asar (tried ${row.tried.join(", ")})`;
}

function allowedOutsideAsar(rel) {
  if (PACKED_FILES.has(rel)) return true;
  return PACKED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function main(argv) {
  const args = argv.slice(2);
  let asarPath = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--asar") asarPath = path.resolve(args[++i] || "");
  }
  const file = asarPath || findAsar(ROOT);
  if (!file || !fs.existsSync(file)) {
    console.error("[friday] packaged requires: app.asar was not found under release/");
    process.exit(1);
  }
  let listed = [];
  try {
    listed = listAsar(file);
  } catch (error) {
    console.error(
      `[friday] packaged requires: could not list ${file} (${error && error.message ? error.message : error})`,
    );
    process.exit(1);
  }
  const scriptFailures = checkPackagedScripts({ root: ROOT });
  if (scriptFailures.length) {
    for (const row of scriptFailures) {
      console.error(
        `[friday] packaged scripts: ${row.file} uses ${row.spec}; inside the installed app electron/ is in app.asar, use scripts/electron-module.cjs`,
      );
    }
    process.exit(1);
  }
  const pathFailures = checkAsarPaths({ root: ROOT });
  const resourceFailures = checkResourceReferences({ root: ROOT });
  if (pathFailures.length || resourceFailures.length) {
    for (const row of pathFailures) {
      console.error(
        `[friday] packaged paths: ${row.file}:${row.line} reaches ${row.folder}/ from __dirname, which is not inside app.asar; resolve it through electron/resource-paths.cjs`,
      );
    }
    for (const row of resourceFailures) {
      console.error(
        `[friday] packaged resources: ${row.file} asks for ${row.wanted}, which electron-builder.yml extraResources does not copy`,
      );
    }
    process.exit(1);
  }
  const failures = checkRequires({ root: ROOT, asarFiles: listed });
  if (failures.length) {
    console.error(
      `[friday] packaged requires: ${failures.length} relative require(s) missing from ${file}`,
    );
    for (const row of failures) console.error(`[friday] ${formatFailure(row)}`);
    process.exit(1);
  }
  console.log(
    `[friday] packaged requires: ${listed.length} asar entries, electron requires resolve`,
  );
}

if (require.main === module) main(process.argv);

module.exports = {
  LAZY_GUARDED,
  PACKED_FILES,
  checkRequires,
  checkAsarPaths,
  checkPackagedScripts,
  PACKAGED_SCRIPT_ROOTS,
  checkResourceReferences,
  OUTSIDE_ASAR,
  filesFromPatterns,
  matcherFrom,
  globMatches,
  globToRegExp,
  findAsar,
  listAsar,
  formatFailure,
  allowedOutsideAsar,
  relativeRequires,
  normaliseList,
};
