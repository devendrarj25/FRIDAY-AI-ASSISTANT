// FRIDAY · her own skills.
//
// Two kinds of skill live side by side:
//   • built-in skills — real capabilities implemented natively here (web,
//     files, system, memory, and the self-authoring skill itself);
//   • custom skills — folders under skills/custom/<id> that FRIDAY (or the
//     owner) wrote. They are plain ES modules and only ever run inside the
//     sandbox, never in the main process.
//
// A skill is described by one manifest shape, so the registry, the Skills page
// and the brain all see the same thing.
const fs = require("fs");
const path = require("path");

const browser = require("./browser.cjs");
const sandbox = require("./sandbox.cjs");
const documents = require("./document-extract.cjs");
const tenderExtract = require("./tender-extract.cjs");
const live = require("./browser-live.cjs");

function speakableBuiltinError(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const message = value.error || value.message || value.detail;
    if (typeof message === "string" && message.trim() && message !== "[object Object]") {
      return message.trim();
    }
  }
  const text = value == null ? "" : String(value);
  if (text && text !== "[object Object]") return text;
  return "skill failed";
}

const customRoot = (root) => path.join(root, "skills", "custom");

// Every skill segment the ONE structure contract defines. A skill imported
// into skills/installed (or core/system/experimental) is exactly as real as
// one FRIDAY wrote into skills/custom — it must list, enable and invoke the
// same way, so discovery here reads the same segments capabilities.cjs scans.
const SKILL_SEGMENTS = require("./friday-contract.cjs").TREES.skills.segments;

const skillRoots = (root) => SKILL_SEGMENTS.map((segment) => path.join(root, "skills", segment));

/**
 * Folder of one custom skill, wherever it was installed. Falls back to the
 * writable `custom` segment so creating a new skill behaves exactly as before.
 */
function skillDir(root, id) {
  const safe = String(id || "").replace(/[\\/]/g, "");
  for (const base of skillRoots(root)) {
    const dir = path.join(base, safe);
    if (fs.existsSync(path.join(dir, "skill.json"))) return dir;
  }
  return path.join(customRoot(root), safe);
}

/**
 * skills:list / invoke used to see only getWorkspaceRoot(). The Skills page
 * lists capabilities from BOTH the packaged app folder and the selected
 * workspace (electron/capabilities.cjs). Shipped catalog packs therefore
 * showed up as Enable-able but were invisible to the router. Same two-root
 * shape as capabilityRoots(), with a string root still meaning "workspace".
 */
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

function contains(base, target) {
  if (!base || !target) return false;
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function locateInRoot(root, id) {
  if (!root) return null;
  const safe = String(id || "").replace(/[\\/]/g, "");
  if (!safe) return null;
  for (const segment of SKILL_SEGMENTS) {
    const dir = path.join(root, "skills", segment, safe);
    if (fs.existsSync(path.join(dir, "skill.json"))) return { dir, segment, id: safe, root };
  }
  return null;
}

function locate(rootOrRoots, id) {
  const { appRoot, workspaceRoot } = normalizeRoots(rootOrRoots);
  return locateInRoot(workspaceRoot, id) || locateInRoot(appRoot, id);
}

/** Same override file capabilities.cjs writes — Enable on the page is this map. */
function readOverrides(workspaceRoot) {
  if (!workspaceRoot) return {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(workspaceRoot, "config", "capabilities.json"), "utf8"),
    );
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function applyOverride(workspaceRoot, skill, segment) {
  if (!skill) return skill;
  const overrides = readOverrides(workspaceRoot);
  const key = `skills/${segment || "custom"}/${skill.id}`;
  if (overrides[key] !== undefined) return { ...skill, enabled: Boolean(overrides[key]) };
  return skill;
}

/**
 * User mutations live in the workspace (friday-paths contract). Enabling a
 * shipped catalog skill copies it there so setEnabled / run stats / Remove
 * never write into a read-only Program Files tree.
 */
function ensureWorkspaceCopy(rootOrRoots, id) {
  const { appRoot, workspaceRoot } = normalizeRoots(rootOrRoots);
  if (!workspaceRoot) return null;
  const existing = locateInRoot(workspaceRoot, id);
  if (existing) return existing;
  const fromApp = locateInRoot(appRoot, id);
  if (!fromApp) return null;
  const dest = path.join(workspaceRoot, "skills", fromApp.segment, fromApp.id);
  if (!contains(workspaceRoot, dest)) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(fromApp.dir, dest, { recursive: true });
  return locateInRoot(workspaceRoot, id);
}

/* ------------------------------------------------------------------ built-in */

const BUILTIN = [
  {
    id: "web.search",
    name: "Web search",
    summary: "Search the web and return ranked results with snippets.",
    category: "web",
    capabilities: ["web.access"],
    risk: "safe",
    inputs: ["query", "limit"],
  },
  {
    id: "web.read",
    name: "Read a page",
    summary: "Open a URL and return its readable text and links.",
    category: "web",
    capabilities: ["web.access"],
    risk: "safe",
    inputs: ["url", "render"],
  },
  {
    id: "web.download",
    name: "Download a file",
    summary: "Download a file from the web into the workspace downloads folder.",
    category: "web",
    capabilities: ["web.access", "fs.write"],
    risk: "write",
    inputs: ["url", "name"],
  },
  {
    id: "project.summarise",
    name: "Summarise the workspace",
    summary: "Count and describe what currently lives in the FRIDAY workspace.",
    category: "project",
    capabilities: ["fs.read"],
    risk: "safe",
    inputs: [],
  },
  {
    id: "file.organise",
    name: "Organise a folder",
    summary: "Group loose files in a folder into typed subfolders.",
    category: "files",
    capabilities: ["fs.write"],
    risk: "write",
    inputs: ["folder", "dryRun"],
  },
  {
    id: "system.report",
    name: "System report",
    summary: "Report CPU, memory, platform and uptime of this machine.",
    category: "system",
    capabilities: ["system.read"],
    risk: "safe",
    inputs: [],
  },
  {
    id: "sandbox.run",
    name: "Run code safely",
    summary: "Execute Node or Python code in an isolated sandbox and return its output.",
    category: "developer",
    capabilities: ["sandbox.exec"],
    risk: "exec",
    inputs: ["code", "language", "allowNetwork"],
  },
  {
    id: "docs.extract",
    name: "Extract document text",
    summary: "Read real text and rows out of CSV, XLSX, DOCX and text-based PDFs.",
    category: "documents",
    capabilities: ["fs.read", "web.access"],
    risk: "safe",
    inputs: ["path", "filename", "text", "url", "prompt"],
  },
  {
    id: "tender.read",
    name: "Read a tender",
    summary:
      "Extract stated tender/RFP clauses (scope, eligibility, deadline, BOQ) from a document or URL.",
    category: "documents",
    capabilities: ["fs.read", "web.access"],
    risk: "safe",
    inputs: ["path", "url", "filename", "text", "prompt"],
  },
];

const TYPE_FOLDERS = {
  images: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"],
  documents: [".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt"],
  archives: [".zip", ".7z", ".rar", ".tar", ".gz"],
  code: [".ts", ".tsx", ".js", ".jsx", ".py", ".cjs", ".mjs", ".json", ".yaml", ".yml"],
  models: [".gguf", ".safetensors", ".bin", ".onnx", ".pt"],
  media: [".mp3", ".wav", ".mp4", ".mkv", ".mov"],
};

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : "";
}

function looksLikePath(text) {
  const value = String(text || "").trim();
  if (!value || value.length > 400 || extractUrl(value) || /[\n\r]/.test(value)) return false;
  return /[\\/]/.test(value) || /\.[a-z0-9]{1,8}$/i.test(value);
}

function enrichBuiltin(skill, raw, workspaceRoot) {
  // Reuse the catalog tool mapper so chat/agent `{ prompt }` fills query/url/path.
  const tools = require("./tools.cjs");
  return tools.enrichInput({ inputs: skill.inputs || [] }, raw, workspaceRoot);
}

async function fetchBytes(url) {
  const response = await live.sessionFetch(url, { redirect: "follow" });
  if (!response || !response.ok) {
    const status = response && response.status != null ? response.status : "offline";
    throw new Error(`request failed [${status}]`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function filenameFromUrl(url, fallback) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "");
    return name || fallback;
  } catch {
    return fallback;
  }
}

async function loadDocument(input) {
  let bytes = input.bytes || null;
  let text = input.text ? String(input.text) : "";
  let filename = String(input.filename || input.path || "");
  const filePath = String(input.path || "").trim();
  const url = String(input.url || extractUrl(text) || "").trim();

  if (!bytes && filePath && fs.existsSync(filePath)) {
    bytes = fs.readFileSync(filePath);
    filename = filename || filePath;
  }

  if (!bytes && !url && looksLikePath(text) && fs.existsSync(text.trim())) {
    const found = text.trim();
    bytes = fs.readFileSync(found);
    filename = filename || found;
    text = "";
  }

  if (!bytes && url && /^https?:\/\//i.test(url)) {
    const nameHint = filename || filenameFromUrl(url, "download.bin");
    const binary =
      /\.(pdf|docx|xlsx|xlsm|csv|tsv)(\?|$)/i.test(url) ||
      /\.(pdf|docx|xlsx|xlsm|csv|tsv)$/i.test(nameHint);
    if (binary) {
      bytes = await fetchBytes(url);
      filename = nameHint;
      text = "";
    } else {
      const page = await browser.open(url, { render: Boolean(input.render) });
      if (page?.ok === false) return page;
      return {
        kind: "html",
        text: page.text || "",
        title: page.title || url,
        url: page.url || url,
        links: page.links || [],
        rows: [],
      };
    }
  }

  return documents.extract({ filename, text, bytes });
}

async function runBuiltin(id, input, ctx) {
  const root = ctx.root;
  switch (id) {
    case "web.search":
      return browser.search(input.query || input.prompt, { limit: Number(input.limit) || 8 });
    case "web.read":
      return browser.open(input.url || extractUrl(input.prompt || input.text || ""), {
        render: Boolean(input.render),
      });
    case "web.download":
      return browser.download(input.url || extractUrl(input.prompt || ""), {
        root,
        name: input.name,
      });
    case "project.summarise": {
      if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
      const entries = fs.readdirSync(root, { withFileTypes: true });
      const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const counts = {};
      for (const name of folders) {
        try {
          counts[name] = fs.readdirSync(path.join(root, name)).length;
        } catch {
          counts[name] = 0;
        }
      }
      return {
        ok: true,
        root,
        folders: folders.length,
        files: entries.length - folders.length,
        counts,
      };
    }
    case "file.organise": {
      const folder = String(input.folder || "");
      if (!folder || !fs.existsSync(folder)) return { ok: false, error: "Folder not found." };
      const dryRun = input.dryRun !== false;
      const moved = [];
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const bucket =
          Object.keys(TYPE_FOLDERS).find((key) => TYPE_FOLDERS[key].includes(ext)) || "other";
        const to = path.join(folder, bucket, entry.name);
        moved.push({ from: entry.name, to: path.join(bucket, entry.name) });
        if (!dryRun) {
          fs.mkdirSync(path.join(folder, bucket), { recursive: true });
          try {
            fs.renameSync(path.join(folder, entry.name), to);
          } catch {
            /* locked file — reported as planned, not moved */
          }
        }
      }
      return { ok: true, dryRun, moved };
    }
    case "system.report": {
      const os = require("node:os");
      return {
        ok: true,
        platform: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
        freeMemGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
        uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      };
    }
    case "sandbox.run":
      return sandbox.runIsolated({
        root,
        code: input.code,
        language: input.language === "python" ? "python" : "node",
        allowNetwork: Boolean(input.allowNetwork),
        timeoutMs: Number(input.timeoutMs) || 30000,
      });
    case "docs.extract": {
      try {
        const extracted = await loadDocument(input);
        if (extracted && extracted.ok === false) return extracted;
        return extracted?.error ? { ok: false, ...extracted } : { ok: true, ...extracted };
      } catch (error) {
        return { ok: false, error: String(error.message || error) };
      }
    }
    case "tender.read": {
      try {
        const extracted = await loadDocument(input);
        if (extracted && extracted.ok === false) return extracted;
        if (extracted?.error) return { ok: false, ...extracted };
        const body = String(extracted?.text || input.text || input.prompt || "");
        const tender = tenderExtract.extractTender(body);
        return {
          ok: true,
          kind: extracted?.kind || "text",
          text: tenderExtract.formatTenderExtract(tender),
          tender,
          sourceChars: tender.sourceChars,
          ...(extracted?.url ? { url: extracted.url } : {}),
        };
      } catch (error) {
        return { ok: false, error: String(error.message || error) };
      }
    }
    default:
      return { ok: false, error: `Unknown built-in skill: ${id}` };
  }
}

/* -------------------------------------------------------------------- custom */

function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "skill.json"), "utf8"));
    return {
      id: String(manifest.id || path.basename(dir)),
      name: String(manifest.name || manifest.id || path.basename(dir)),
      summary: String(manifest.summary || ""),
      category: String(manifest.category || "custom"),
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
      risk: manifest.risk || "safe",
      inputs: Array.isArray(manifest.inputs) ? manifest.inputs : [],
      version: Number(manifest.version || 1),
      author: manifest.author || "friday",
      createdAt: Number(manifest.createdAt || Date.now()),
      updatedAt: Number(manifest.updatedAt || Date.now()),
      runs: Number(manifest.runs || 0),
      failures: Number(manifest.failures || 0),
      enabled: manifest.enabled !== false,
      builtin: false,
      dir,
    };
  } catch {
    return null;
  }
}

function collectCustom(root) {
  const custom = [];
  const seen = new Set();
  if (!root) return custom;
  for (const segment of SKILL_SEGMENTS) {
    const dir = path.join(root, "skills", segment);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        const manifest = readManifest(path.join(dir, entry.name));
        if (!manifest) continue;
        seen.add(entry.name);
        custom.push({ ...manifest, segment });
      }
    } catch {
      /* segment folder created on the first write */
    }
  }
  return custom;
}

function list(rootOrRoots) {
  const builtin = BUILTIN.map((skill) => ({
    ...skill,
    version: 1,
    author: "friday-core",
    enabled: true,
    builtin: true,
    runs: 0,
    failures: 0,
    dir: null,
  }));
  const { appRoot, workspaceRoot } = normalizeRoots(rootOrRoots);
  if (!appRoot && !workspaceRoot) return { ok: true, skills: builtin };
  const byId = new Map();
  for (const skill of collectCustom(appRoot)) byId.set(skill.id, skill);
  for (const skill of collectCustom(workspaceRoot)) byId.set(skill.id, skill);
  const custom = [...byId.values()].map((skill) =>
    applyOverride(workspaceRoot, skill, skill.segment),
  );
  return { ok: true, skills: [...builtin, ...custom] };
}

function read(rootOrRoots, id) {
  const roots = normalizeRoots(rootOrRoots);
  const located = locate(roots, id);
  if (!located) return { ok: false, error: "Skill not found." };
  const manifest = applyOverride(roots.workspaceRoot, readManifest(located.dir), located.segment);
  if (!manifest) return { ok: false, error: "Skill not found." };
  let code = "";
  try {
    code = fs.readFileSync(path.join(located.dir, "skill.mjs"), "utf8");
  } catch {
    /* manifest without code is still readable */
  }
  return { ok: true, skill: manifest, code };
}

/** Write (or version-up) a custom skill. The previous version is kept. */
function write(root, { id, name, summary, category, capabilities, risk, inputs, code, author }) {
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  const safeId = String(id || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
  if (!safeId) return { ok: false, error: "A skill needs an id." };
  // Upgrade in place wherever the skill really lives; new skills go to custom.
  const dir = skillDir(root, safeId);

  const previous = readManifest(dir);
  fs.mkdirSync(dir, { recursive: true });

  if (previous) {
    // Keep the outgoing version so a bad upgrade can be rolled back.
    const archive = path.join(dir, "versions", `v${previous.version}`);
    fs.mkdirSync(archive, { recursive: true });
    for (const file of ["skill.json", "skill.mjs"]) {
      try {
        fs.copyFileSync(path.join(dir, file), path.join(archive, file));
      } catch {
        /* nothing to archive */
      }
    }
  }

  const manifest = {
    id: safeId,
    name: name || previous?.name || safeId,
    summary: summary || previous?.summary || "",
    category: category || previous?.category || "custom",
    capabilities: capabilities || previous?.capabilities || [],
    risk: risk || previous?.risk || "safe",
    inputs: inputs || previous?.inputs || [],
    version: (previous?.version ?? 0) + 1,
    author: author || previous?.author || "friday",
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    runs: previous?.runs ?? 0,
    failures: previous?.failures ?? 0,
    enabled: previous?.enabled ?? true,
  };
  fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (code) fs.writeFileSync(path.join(dir, "skill.mjs"), String(code), "utf8");
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `# ${manifest.name}\n\n${manifest.summary}\n\n- id: \`${manifest.id}\`\n- version: ${manifest.version}\n- author: ${manifest.author}\n- capabilities: ${manifest.capabilities.join(", ") || "none"}\n\nWritten and maintained by FRIDAY.\n`,
    "utf8",
  );
  return { ok: true, skill: { ...manifest, builtin: false, dir } };
}

function rollback(root, id) {
  const dir = skillDir(root, id);
  const current = readManifest(dir);
  if (!current || current.version < 2)
    return { ok: false, error: "No previous version to roll back to." };
  const archive = path.join(dir, "versions", `v${current.version - 1}`);
  if (!fs.existsSync(archive)) return { ok: false, error: "Previous version is not archived." };
  for (const file of ["skill.json", "skill.mjs"]) {
    try {
      fs.copyFileSync(path.join(archive, file), path.join(dir, file));
    } catch {
      /* partial archive */
    }
  }
  return { ok: true, skill: readManifest(dir) };
}

function setEnabled(rootOrRoots, id, enabled) {
  const roots = normalizeRoots(rootOrRoots);
  if (!roots.workspaceRoot) return { ok: false, error: "No FRIDAY workspace is selected." };
  const located = ensureWorkspaceCopy(roots, id) || locateInRoot(roots.workspaceRoot, id);
  if (!located) return { ok: false, error: "Skill not found." };
  const manifest = readManifest(located.dir);
  if (!manifest) return { ok: false, error: "Skill not found." };
  const next = { ...manifest, enabled: Boolean(enabled), updatedAt: Date.now() };
  delete next.builtin;
  delete next.dir;
  fs.writeFileSync(path.join(located.dir, "skill.json"), JSON.stringify(next, null, 2), "utf8");
  return { ok: true, skill: { ...next, builtin: false, dir: located.dir } };
}

function remove(root, id) {
  const dir = skillDir(root, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "Skill not found." };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, id };
}

function recordRun(root, id, ok) {
  const dir = skillDir(root, id);
  const manifest = readManifest(dir);
  if (!manifest) return;
  const next = { ...manifest, runs: manifest.runs + 1, failures: manifest.failures + (ok ? 0 : 1) };
  delete next.builtin;
  delete next.dir;
  try {
    fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* stats are best-effort */
  }
}

/** Wrapper that runs a custom skill's default export inside the sandbox. */
function harness(code, input) {
  return `${code}\n\n// --- FRIDAY sandbox harness ---\nimport { writeFileSync } from "node:fs";\nconst __input = ${JSON.stringify(input ?? {})};\nconst __fn = typeof run === "function" ? run : (typeof globalThis.run === "function" ? globalThis.run : null);\nif (!__fn) { console.error("skill does not define run(input)"); process.exit(1); }\nconst __out = await __fn(__input);\nwriteFileSync("result.json", JSON.stringify({ ok: true, value: __out ?? null }));\nconsole.log("skill finished");\n`;
}

/** Verify a candidate skill without installing it. */
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

/** Invoke any skill — built-in natively, custom in the sandbox. */
async function invoke(rootOrRoots, id, input = {}, ctx = {}) {
  const started = Date.now();
  const roots = normalizeRoots(rootOrRoots);
  const workspace = roots.workspaceRoot || roots.appRoot;
  const builtin = BUILTIN.find((skill) => skill.id === id);
  if (builtin) {
    try {
      const args = enrichBuiltin(builtin, input || {}, workspace);
      const value = await runBuiltin(id, args, { root: workspace, ...ctx });
      const ok = value?.ok !== false;
      return {
        ok,
        id,
        value,
        ms: Date.now() - started,
        ...(ok
          ? {}
          : {
              error: speakableBuiltinError(value),
            }),
      };
    } catch (error) {
      return { ok: false, id, error: speakableBuiltinError(error), ms: Date.now() - started };
    }
  }
  let found = read(roots, id);
  if (!found.ok) return { ok: false, id, error: found.error, ms: Date.now() - started };
  const allowDisabled = Boolean(ctx.allowDisabled);
  if (!found.skill.enabled && !allowDisabled)
    return { ok: false, id, error: "Skill is disabled.", ms: Date.now() - started };
  if (found.skill.enabled && roots.workspaceRoot && !locateInRoot(roots.workspaceRoot, id)) {
    ensureWorkspaceCopy(roots, id);
    found = read(roots, id);
    if (!found.ok) return { ok: false, id, error: found.error, ms: Date.now() - started };
  }
  const allowNetwork = found.skill.capabilities.includes("web.access");
  const result = await sandbox.runIsolated({
    root: workspace,
    code: harness(found.code, input || {}),
    language: "node",
    timeoutMs: 60000,
    allowNetwork,
  });
  const ok = Boolean(result.ok && result.result?.ok);
  if (!allowDisabled) recordRun(roots.workspaceRoot || workspace, id, ok);
  return {
    ok,
    id,
    value: result.result?.value ?? null,
    output: result.output,
    ms: Date.now() - started,
    ...(ok ? {} : { error: result.output?.slice(-800) || "skill failed" }),
  };
}

module.exports = {
  BUILTIN,
  list,
  read,
  write,
  remove,
  rollback,
  setEnabled,
  invoke,
  verifyCandidate,
  harness,
  ensureWorkspaceCopy,
  locate,
};
