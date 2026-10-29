// FRIDAY · catalog tool runtime.
//
// Shipped tools (appRoot) run their existing index.cjs in-process — they
// already delegate to electron engines. Workspace / forged / imported tools
// run inside sandbox.cjs, the same isolation custom skills use. Discovery is
// capabilities.list(); this module does not scan a second tree.
const fs = require("fs");
const path = require("path");

const capabilities = require("./capabilities.cjs");
const sandbox = require("./sandbox.cjs");

function isRoots(value) {
  return Boolean(
    value && typeof value === "object" && (value.appRoot || value.workspaceRoot || value.root),
  );
}

function normalizeRoots(rootOrRoots) {
  if (isRoots(rootOrRoots)) {
    return {
      appRoot: rootOrRoots.appRoot || null,
      workspaceRoot: rootOrRoots.workspaceRoot || rootOrRoots.root || null,
    };
  }
  return { appRoot: null, workspaceRoot: rootOrRoots || null };
}

function list(rootOrRoots) {
  const roots = normalizeRoots(rootOrRoots);
  const report = capabilities.list(roots);
  const tools = (report.items || []).filter((item) => item.tree === "tools").map(withRunnable);
  return { ok: true, tools };
}

function find(rootOrRoots, id) {
  const wanted = String(id || "");
  if (!wanted) return null;
  const { tools } = list(rootOrRoots);
  return (
    tools.find((item) => item.id === wanted) ||
    tools.find((item) => item.id.endsWith(`/${wanted}`)) ||
    null
  );
}

function entryFile(item) {
  if (!item || !item.path) return null;
  const declared = item.entry ? path.join(item.path, item.entry) : null;
  if (declared && fs.existsSync(declared) && fs.statSync(declared).isFile()) return declared;
  for (const name of ["index.cjs", "index.js", "tool.cjs"]) {
    const file = path.join(item.path, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { prompt: String(value) };
  }
  return {};
}

function valueToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const lastOk = [...value]
      .reverse()
      .find((item) => item && typeof item === "object" && item.ok !== false && item.value != null);
    if (lastOk) return valueToText(lastOk.value);
    if (value.length && (typeof value[0] === "string" || typeof value[0] === "number")) {
      return value.map(String).join("\n");
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.value === "string") return value.value;
    if (typeof value.content === "string") return value.content;
    if (typeof value.result === "string") return value.result;
    if (typeof value.host === "string") return value.host;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function previousText(input) {
  if (!input || input.previous == null || input.previous === "") return "";
  return valueToText(input.previous);
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : "";
}

function looksLikePath(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 400 || extractUrl(value) || /[\n\r]/.test(value)) return false;
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function extractHost(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const url = extractUrl(value);
  if (url) {
    try {
      return new URL(url).hostname;
    } catch {
      /* ignore */
    }
  }
  const dotted = value.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
  if (dotted) return dotted[1];
  if (/^[a-z0-9.-]+$/i.test(value) && value.length < 255) return value;
  return "";
}

function missing(input, key) {
  return input[key] == null || input[key] === "";
}

function declaredInputs(item) {
  return new Set(Array.isArray(item && item.inputs) ? item.inputs.map(String) : []);
}

/**
 * Chat and Test selected often send `{ prompt }`. Shipped packs read `text`,
 * `query`, `url`, `path`, `host`, … Fill only missing declared keys. A prior
 * successful sequence output wins over the original prompt.
 */
function enrichInput(item, raw, workspaceRoot) {
  const input = asRecord(raw);
  const declared = declaredInputs(item);
  const prompt = input.prompt != null && input.prompt !== "" ? String(input.prompt) : "";
  const fromPrev = previousText(input);
  const source = fromPrev || prompt;

  if (missing(input, "prompt") && source) input.prompt = source;

  const fill = (key, extraWhenEmpty) => {
    if (!missing(input, key)) return;
    if (declared.has(key) || (extraWhenEmpty && declared.size === 0)) input[key] = source;
  };

  if (source) {
    fill("text", true);
    fill("query", false);
    fill("content", false);
    fill("html", false);
    fill("csv", false);
    fill("json", false);
    if (!declared.has("from") && !declared.has("to")) fill("value", false);

    const url = extractUrl(prompt || source);
    if (url && declared.has("url") && missing(input, "url")) input.url = url;

    const pathHint = looksLikePath(prompt)
      ? prompt.trim()
      : looksLikePath(source)
        ? String(source).trim()
        : "";
    for (const key of ["path", "folder", "file"]) {
      if (pathHint && declared.has(key) && missing(input, key)) input[key] = pathHint;
    }

    const host = extractHost(prompt || source);
    for (const key of ["host", "hostname"]) {
      if (host && declared.has(key) && missing(input, key)) input[key] = host;
    }
  }

  if (workspaceRoot && missing(input, "root")) input.root = workspaceRoot;
  return input;
}

function withRunnable(item) {
  return { ...item, runnable: Boolean(entryFile(item)) };
}

function harness(code, input) {
  // Sandbox always writes main.mjs (ESM). Shipped / forged tools are CJS
  // (module.exports = { run }), so the harness writes tool.cjs beside it and
  // require()s that file instead of evaluating CJS inside ESM.
  return `import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(__dir, "tool.cjs"), ${JSON.stringify(String(code || ""))});
const __mod = require("./tool.cjs");
const __fn = typeof __mod?.run === "function" ? __mod.run : typeof __mod === "function" ? __mod : null;
if (!__fn) { console.error("tool does not define run(input)"); process.exit(1); }
const __input = ${JSON.stringify(input ?? {})};
const __out = await __fn(__input);
writeFileSync("result.json", JSON.stringify({ ok: true, value: __out ?? null }));
console.log("tool finished");
`;
}

async function verifyCandidate(root, { code, sample = {}, allowNetwork = false }) {
  const result = await sandbox.runIsolated({
    root,
    code: harness(code, sample),
    language: "node",
    timeoutMs: 30000,
    allowNetwork,
  });
  return {
    ok: Boolean(result.ok && result.result?.ok),
    output: result.output,
    value: result.result?.value ?? null,
    ms: result.ms,
  };
}

function write(workspaceRoot, pack) {
  return capabilities.installPack({ workspaceRoot }, { ...pack, tree: "tools" }, "tools");
}

async function invokeShipped(item, input) {
  const file = entryFile(item);
  if (!file) return { ok: false, error: "This tool has no index.cjs to run." };
  const mod = require(file);
  const fn =
    mod && (typeof mod.run === "function" ? mod.run : typeof mod === "function" ? mod : null);
  if (!fn) return { ok: false, error: "This tool does not export run()." };
  const value = await fn(input || {});
  if (value && typeof value === "object" && value.ok === false) {
    return { ok: false, error: String(value.error || "tool failed"), value };
  }
  return { ok: true, value };
}

async function invokeCustom(item, input, workspace) {
  const file = entryFile(item);
  if (!file) return { ok: false, error: "This tool has no index.cjs to run." };
  let code = "";
  try {
    code = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
  const allowNetwork = (item.permissions || []).some((p) => /web|net/i.test(String(p)));
  const result = await sandbox.runIsolated({
    root: workspace,
    code: harness(code, input || {}),
    language: "node",
    timeoutMs: 60000,
    allowNetwork,
  });
  const ok = Boolean(result.ok && result.result?.ok);
  return {
    ok,
    value: ok ? (result.result?.value ?? null) : null,
    error: ok ? undefined : String(result.output || result.error || "tool failed").slice(-1200),
    ms: result.ms,
  };
}

async function invoke(rootOrRoots, id, input = {}, ctx = {}) {
  const started = Date.now();
  const roots = normalizeRoots(rootOrRoots);
  const item = find(roots, id);
  if (!item) return { ok: false, id, error: "Tool not found.", ms: Date.now() - started };
  if (!item.enabled && !ctx.allowDisabled)
    return { ok: false, id, error: "Tool is disabled.", ms: Date.now() - started };
  const args = enrichInput(item, input, roots.workspaceRoot || roots.appRoot);
  try {
    if (item.origin === "workspace") {
      const custom = await invokeCustom(item, args, roots.workspaceRoot || roots.appRoot);
      return { ...custom, id, ms: custom.ms ?? Date.now() - started };
    }
    const shipped = await invokeShipped(item, args);
    return { ...shipped, id, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, id, error: String(error.message || error), ms: Date.now() - started };
  }
}

module.exports = { list, find, invoke, verifyCandidate, write, harness, enrichInput, entryFile };
