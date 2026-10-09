/**
 * Resolve every command a workflow or composite action runs.
 *
 * A `run:` block must name an npm script that exists, or a node, python, or
 * shell file that exists. Each of those files must itself require and shell
 * out only to files that exist. Owner-owned actions must have an action.yml.
 * A deleted working-layer path must not appear.
 */
const fs = require("node:fs");
const path = require("node:path");

const BANNED = [
  "README" + "FIRST",
  "FRIDAY-DEVELOPMENT" + " & VISION",
  "prettier.config" + ".js",
  "ADOPTION_" + "LEDGER",
];
const PATH_RE =
  /(?:^|[\s"'`(:=])((?:\.\/|\.\.\/)?(?:scripts|kernel|config|\.github)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
const REQUIRE_RE = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
const NPM_RUN_RE = /\bnpm run ([A-Za-z0-9:_-]+)/g;
const NODE_BIN_RE = /\bnode\s+([^\s|;|&]+)/g;

function stripExpressions(text) {
  return String(text).replace(/\$\{\{[\s\S]*?\}\}/g, " ");
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

function readYaml(file) {
  const raw = fs.readFileSync(file, "utf8");
  return { raw, doc: parseYaml(raw) };
}

function parseYaml(raw) {
  const yaml = require("js-yaml");
  return yaml.load(raw);
}

function isSkippable(token) {
  if (!token) return true;
  if (token.includes("$") || token.includes("{") || token.includes("*") || token.includes("+"))
    return true;
  if (token.startsWith("-") || token.startsWith("http://") || token.startsWith("https://"))
    return true;
  return false;
}

function cleanToken(token) {
  return token.replace(/^['"`]+|['"`)+,]+$/g, "");
}

function commandPaths(text) {
  const found = new Set();
  const source = stripExpressions(text);
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const invoked =
      /\b(node|python3?|bash|sh|pwsh|powershell|spawn|execFile|execSync|spawnSync)\b/.test(line) ||
      /(^|\s)&\s/.test(line) ||
      /-File\s/.test(line) ||
      /\bpip install\b/.test(line);
    if (!invoked) continue;
    for (const match of line.matchAll(PATH_RE)) {
      const token = cleanToken(match[1]);
      if (!isSkippable(token)) found.add(token);
    }
    for (const match of line.matchAll(NODE_BIN_RE)) {
      const token = cleanToken(match[1]);
      if (isSkippable(token)) continue;
      if (token.includes("/") || /\.(cjs|mjs|js)$/.test(token)) found.add(token);
    }
  }
  return [...found];
}

function npmScripts(text) {
  const names = new Set();
  for (const match of stripExpressions(text).matchAll(NPM_RUN_RE)) names.add(match[1]);
  return [...names];
}

function actionUses(node, found) {
  walk(node, (item) => {
    if (typeof item.uses === "string") found.push(item.uses.trim());
  });
}

function resolveAgainst(root, fromFile, spec) {
  const base = fromFile ? path.dirname(fromFile) : root;
  const abs = path.resolve(base, spec);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

function fileExists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function scanScript(root, rel, problems, seen) {
  const key = rel.split(path.sep).join("/");
  if (seen.has(key)) return;
  seen.add(key);
  const abs = path.join(root, key);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    problems.push(`missing script ${key}`);
    return;
  }
  if (!/\.(cjs|mjs|js|ps1|sh|py)$/.test(key)) return;
  const text = fs.readFileSync(abs, "utf8");
  for (const banned of BANNED) {
    if (text.includes(banned)) problems.push(`${key} mentions ${banned}`);
  }
  for (const match of text.matchAll(REQUIRE_RE)) {
    const target = resolveAgainst(root, abs, match[2]);
    if (!target) {
      problems.push(`${key} require escapes the repo: ${match[2]}`);
      continue;
    }
    const candidates = [
      target,
      `${target}.js`,
      `${target}.cjs`,
      `${target}.mjs`,
      path.join(target, "index.js"),
    ];
    const hit = candidates.find((item) => fileExists(root, item.split(path.sep).join("/")));
    if (!hit) problems.push(`${key} requires missing ${match[2]}`);
    else scanScript(root, hit, problems, seen);
  }
  for (const spec of commandPaths(text)) {
    const target =
      spec.startsWith("./") || spec.startsWith("../") ? resolveAgainst(root, abs, spec) : spec;
    if (!target) continue;
    if (!fileExists(root, target)) problems.push(`${key} shells out to missing ${spec}`);
    else if (/\.(cjs|mjs|js|ps1|sh|py)$/.test(target)) scanScript(root, target, problems, seen);
  }
}

function checkDocument(root, label, raw, doc, problems) {
  for (const banned of BANNED) {
    if (raw.includes(banned)) problems.push(`${label} mentions ${banned}`);
  }
  const runs = [];
  const uses = [];
  walk(doc, (item) => {
    if (typeof item.run === "string") runs.push(item.run);
  });
  actionUses(doc, uses);
  const pkgPath = path.join(root, "package.json");
  const scripts = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {}
    : {};
  const engines = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, "utf8")).engines || {}
    : {};
  for (const run of runs) {
    for (const name of npmScripts(run)) {
      if (!scripts[name]) problems.push(`${label} npm run ${name} is not in package.json`);
    }
    for (const spec of commandPaths(run)) {
      const rel = spec.replace(/^\.\//, "");
      if (!fileExists(root, rel)) problems.push(`${label} runs missing ${spec}`);
      else scanScript(root, rel, problems, new Set());
    }
  }
  for (const spec of uses) {
    let rel = null;
    const local = spec.match(/^\.\/(\.github\/actions\/[^\s@]+)/);
    const owned = spec.match(/devendrarj25\/FRIDAY-AI-ASSISTANT\/(\.github\/actions\/[^\s@]+)/);
    if (local) rel = local[1];
    else if (owned) rel = owned[1];
    else if (spec.startsWith("docker://")) {
      if (!/:[^:\s]+$/.test(spec) || spec.endsWith(":latest")) {
        problems.push(`${label} unpinned image ${spec}`);
      }
      continue;
    } else {
      problems.push(`${label} uses an action outside this repository: ${spec}`);
      continue;
    }
    if (!fileExists(root, `${rel}/action.yml`)) problems.push(`${label} missing action ${rel}`);
  }
  if (raw.includes("engines.node") && !engines.node) problems.push(`${label} reads engines.node`);
  if (raw.includes("engines.npm") && !engines.npm) problems.push(`${label} reads engines.npm`);
  const images = raw.match(/docker run[^\n]*\s([^\s:]+:[^\s]+)/g) || [];
  for (const image of images) {
    const tag = image.split(/\s+/).pop();
    if (!tag || !tag.includes(":") || tag.endsWith(":latest"))
      problems.push(`${label} unpinned image ${tag}`);
  }
}

function resolveRoot(root) {
  const problems = [];
  const workflowDir = path.join(root, ".github", "workflows");
  const actionDir = path.join(root, ".github", "actions");
  if (!fs.existsSync(workflowDir)) problems.push("missing .github/workflows");
  else {
    for (const name of fs.readdirSync(workflowDir).filter((item) => item.endsWith(".yml"))) {
      const file = path.join(workflowDir, name);
      const { raw, doc } = readYaml(file);
      checkDocument(root, name, raw, doc, problems);
    }
  }
  if (fs.existsSync(actionDir)) {
    for (const name of fs.readdirSync(actionDir)) {
      const file = path.join(actionDir, name, "action.yml");
      if (!fs.existsSync(file)) continue;
      const { raw, doc } = readYaml(file);
      checkDocument(root, `.github/actions/${name}`, raw, doc, problems);
    }
  }
  return problems;
}

function resolveRun(root, runText) {
  const problems = [];
  checkDocument(root, "fixture", runText, { jobs: { t: { steps: [{ run: runText }] } } }, problems);
  return problems;
}

module.exports = { resolveRoot, resolveRun, commandPaths, npmScripts };

if (require.main === module) {
  const problems = resolveRoot(path.resolve(__dirname, ".."));
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log("workflow commands resolve");
}
