// FRIDAY · background-agent runtime.
//
// Discovery is capabilities.list() (tree === agents). Each pack exports
// plan(input) (inspect only) and run(input) (dryRun defaults true; mutates
// only when dryRun:false and approved:true). Shipped packs run in-process;
// workspace packs use sandbox.cjs, the same isolation custom tools use.
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
  const agents = (report.items || []).filter((item) => item.tree === "agents").map(withRunnable);
  return { ok: true, agents };
}

function find(rootOrRoots, id) {
  const wanted = String(id || "");
  if (!wanted) return null;
  const { agents } = list(rootOrRoots);
  return (
    agents.find((item) => item.id === wanted) ||
    agents.find((item) => item.id.endsWith(`/${wanted}`)) ||
    null
  );
}

function entryFile(item) {
  if (!item || !item.path) return null;
  const declared = item.entry ? path.join(item.path, item.entry) : null;
  if (declared && fs.existsSync(declared) && fs.statSync(declared).isFile()) return declared;
  for (const name of ["index.cjs", "index.js", "agent.cjs"]) {
    const file = path.join(item.path, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function withRunnable(item) {
  return { ...item, runnable: Boolean(entryFile(item)) };
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  return {};
}

function harness(code, input, method) {
  return `import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(__dir, "agent.cjs"), ${JSON.stringify(String(code || ""))});
const __mod = require("./agent.cjs");
const __fn = typeof __mod?.[${JSON.stringify(method)}] === "function" ? __mod[${JSON.stringify(method)}] : null;
if (!__fn) { console.error("agent does not define ${method}(input)"); process.exit(1); }
const __input = ${JSON.stringify(input ?? {})};
const __out = await __fn(__input);
writeFileSync("result.json", JSON.stringify({ ok: true, value: __out ?? null }));
console.log("agent finished");
`;
}

async function invokeShipped(item, method, input) {
  const file = entryFile(item);
  if (!file) return { ok: false, error: "This agent has no index.cjs to run." };
  const mod = require(file);
  const fn = mod && typeof mod[method] === "function" ? mod[method] : null;
  if (!fn) return { ok: false, error: `This agent does not export ${method}().` };
  const value = await fn(input || {});
  if (value && typeof value === "object" && value.ok === false) {
    return { ok: false, error: String(value.error || "agent failed"), value };
  }
  return { ok: true, value };
}

async function invokeCustom(item, method, input, workspace) {
  const file = entryFile(item);
  if (!file) return { ok: false, error: "This agent has no index.cjs to run." };
  let code = "";
  try {
    code = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
  const allowNetwork = (item.permissions || []).some((p) => /web|net/i.test(String(p)));
  const result = await sandbox.runIsolated({
    root: workspace,
    code: harness(code, input || {}, method),
    language: "node",
    timeoutMs: 60000,
    allowNetwork,
  });
  const ok = Boolean(result.ok && result.result?.ok);
  return {
    ok,
    value: ok ? (result.result?.value ?? null) : null,
    error: ok ? undefined : String(result.output || result.error || "agent failed").slice(-1200),
    ms: result.ms,
  };
}

function prepareInput(method, raw) {
  const input = asRecord(raw);
  if (method === "run" && input.dryRun === undefined) input.dryRun = true;
  return input;
}

async function invoke(rootOrRoots, id, method, input = {}, ctx = {}) {
  const started = Date.now();
  const roots = normalizeRoots(rootOrRoots);
  const item = find(roots, id);
  const verb = method === "plan" ? "plan" : "run";
  if (!item) return { ok: false, id, error: "Agent not found.", ms: Date.now() - started };
  if (!item.enabled && !ctx.allowDisabled)
    return { ok: false, id, error: "Agent is disabled.", ms: Date.now() - started };
  const args = prepareInput(verb, input);
  try {
    const result =
      item.origin === "workspace"
        ? await invokeCustom(item, verb, args, roots.workspaceRoot || roots.appRoot)
        : await invokeShipped(item, verb, args);
    return { ...result, id, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, id, error: String(error.message || error), ms: Date.now() - started };
  }
}

function plan(rootOrRoots, id, input = {}, ctx = {}) {
  return invoke(rootOrRoots, id, "plan", input, ctx);
}

function run(rootOrRoots, id, input = {}, ctx = {}) {
  return invoke(rootOrRoots, id, "run", input, ctx);
}

module.exports = { list, find, plan, run, invoke };
