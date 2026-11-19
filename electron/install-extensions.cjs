/**
 * Install Manager · tools added by data, not by code.
 *
 * A new tool is one JSON entry, not an edit of `electron/toolchain.cjs` and `src/lib/friday/catalog.ts`. Two files
 * are read, in this order, and a later id never replaces an earlier one or a built-in tool:
 *
 *   1. `config/install-extensions.json`            shipped with FRIDAY, replaced by an update
 *   2. `<FRIDAY folder>/config/install-extensions.user.json`   the owner's own, never touched by an update
 *
 * Each file is `{ "tools": [ { ... } ] }`. An entry may carry only the fields below, so a file can describe a tool
 * but can never run a command of its own: installs go through the same winget, npm and pip paths every built-in
 * tool uses, `required` is always false (an extension can never block setup), and a bad entry is skipped with a
 * reason instead of breaking the rest. The renderer needs no change: a detected tool the catalog does not know
 * becomes a row by itself (`installer-engine.ts`, `state.extra`).
 *
 *   id        text, 2 to 64 characters, unique              category  one of the known categories
 *   cmd       the command to look for on PATH (no path)      args      up to 4 version flags, default ["--version"]
 *   winget    Publisher.Package                              npm       global npm package   pip  PyPI package
 *   pipImport module the pip package must import             url       https page of the tool   source  its host text
 *   latest    { kind: "npm" | "pypi" | "github", ref }       manual    text shown when no unattended install exists
 */
const fs = require("node:fs");
const path = require("node:path");

const FILE_NAME = "install-extensions.json";
const USER_FILE_NAME = "install-extensions.user.json";

const FIELDS = new Set([
  "id",
  "category",
  "cmd",
  "args",
  "winget",
  "npm",
  "pip",
  "pipImport",
  "url",
  "source",
  "latest",
  "manual",
]);

const RE = {
  id: /^[A-Za-z0-9][A-Za-z0-9 ._+()/-]{1,63}$/,
  cmd: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/,
  arg: /^(--?)?[A-Za-z0-9][A-Za-z0-9._=:-]{0,30}$/,
  winget: /^[A-Za-z0-9][A-Za-z0-9+-]*(\.[A-Za-z0-9+-]+)+$/,
  npm: /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pip: /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/,
  module: /^[A-Za-z_][A-Za-z0-9_]{0,60}$/,
  github: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
  source: /^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,80}$/,
};

/** One entry, or the reason it was skipped. */
function validate(entry, { categories = [], taken = new Set() } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    return { reason: "not an object" };
  const unknown = Object.keys(entry).filter((key) => !FIELDS.has(key));
  if (unknown.length) return { reason: `field not allowed: ${unknown.join(", ")}` };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!RE.id.test(id)) return { reason: "id must be 2-64 plain characters" };
  if (taken.has(id.toLowerCase())) return { id, reason: "id already used" };
  const category = categories.includes(entry.category) ? entry.category : "Developer Tools";

  const out = { id, category };
  const text = (key, re) => {
    if (entry[key] == null) return null;
    if (typeof entry[key] !== "string" || !re.test(entry[key])) return `${key} is not valid`;
    out[key] = entry[key];
    return null;
  };
  for (const [key, re] of [
    ["cmd", RE.cmd],
    ["winget", RE.winget],
    ["npm", RE.npm],
    ["pip", RE.pip],
    ["pipImport", RE.module],
    ["source", RE.source],
  ]) {
    const problem = text(key, re);
    if (problem) return { id, reason: problem };
  }

  if (entry.args != null) {
    if (
      !Array.isArray(entry.args) ||
      entry.args.length > 4 ||
      !entry.args.every((arg) => typeof arg === "string" && RE.arg.test(arg))
    ) {
      return { id, reason: "args must be up to 4 plain flags" };
    }
    out.args = entry.args;
  }
  if (out.cmd && !out.args) out.args = ["--version"];

  if (typeof entry.url !== "string" || !/^https:\/\/[^\s/]+\.[^\s/]+(\/[^\s]*)?$/.test(entry.url)) {
    return { id, reason: "url must be an https page" };
  }
  out.url = entry.url;
  if (!out.source) out.source = new URL(entry.url).hostname;

  if (entry.latest != null) {
    const spec = entry.latest;
    const ok =
      spec &&
      typeof spec === "object" &&
      typeof spec.ref === "string" &&
      ((spec.kind === "npm" && RE.npm.test(spec.ref)) ||
        (spec.kind === "pypi" && RE.pip.test(spec.ref)) ||
        (spec.kind === "github" && RE.github.test(spec.ref)));
    if (!ok) return { id, reason: "latest must be npm, pypi or github with a valid ref" };
    out.latest = { kind: spec.kind, ref: spec.ref };
  } else if (out.npm) {
    out.latest = { kind: "npm", ref: out.npm };
  } else if (out.pip) {
    out.latest = { kind: "pypi", ref: out.pip };
  }

  if (entry.manual != null) {
    if (typeof entry.manual !== "string" || entry.manual.length > 240) {
      return { id, reason: "manual must be text of at most 240 characters" };
    }
    out.manual = entry.manual;
  }
  if (!out.winget && !out.npm && !out.pip && !out.manual) {
    return { id, reason: "needs winget, npm, pip or a manual note" };
  }
  if (!out.cmd && !out.pip) return { id, reason: "needs cmd (or pip, detected by import)" };
  out.required = false;
  return { tool: out };
}

function readFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { entries: [], stamp: "absent" };
  }
  if (!stat.isFile() || stat.size > 512 * 1024)
    return { entries: [], stamp: "skipped", problem: "not a file under 512 KB" };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed?.tools) ? parsed.tools : [];
    return { entries, stamp: `${stat.mtimeMs}:${stat.size}` };
  } catch (error) {
    return {
      entries: [],
      stamp: `${stat.mtimeMs}:${stat.size}`,
      problem: `not valid JSON (${error.message})`,
    };
  }
}

/**
 * Every valid extension tool from the shipped file and the owner's file.
 * `taken` is the ids already in use (the built-in tools, lowercase).
 */
function loadExtensions({ shippedFile, root, categories, taken }) {
  const files = shippedFile ? [shippedFile] : [];
  if (root) files.push(path.join(root, "config", USER_FILE_NAME));
  const used = new Set([...taken].map((id) => String(id).toLowerCase()));
  const tools = [];
  const problems = [];
  const stamps = [];
  for (const file of files) {
    const read = readFile(file);
    stamps.push(`${file}|${read.stamp}`);
    if (read.problem) problems.push({ file, reason: read.problem });
    for (const entry of read.entries) {
      const result = validate(entry, { categories, taken: used });
      if (result.tool) {
        used.add(result.tool.id.toLowerCase());
        tools.push(result.tool);
      } else {
        problems.push({ file, id: result.id || null, reason: result.reason });
      }
    }
  }
  return { tools, problems, stamp: stamps.join("\n") };
}

module.exports = { FILE_NAME, USER_FILE_NAME, FIELDS, validate, loadExtensions };
