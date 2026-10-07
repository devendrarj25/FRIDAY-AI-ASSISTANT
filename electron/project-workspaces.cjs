/**
 * FRIDAY · project workspaces (main process)
 *
 * Durable owner projects under <FRIDAY_ROOT>/projects/<id>/. One manifest
 * schema. Folders (/workspace) stays the primary FRIDAY_ROOT scan. Sandbox
 * lab stays isolated experiments. Never wipe FRIDAY_ROOT.
 */
const fs = require("node:fs");
const path = require("node:path");
let shell = { openPath: () => false };
try {
  ({ shell } = require("electron"));
} catch {
  /* vitest / node — reveal is a no-op */
}
const paths = require("./friday-paths.cjs");

const INDEX = "index.json";
const MANIFEST = "manifest.json";
const INSTRUCTIONS = "instructions.md";

function now() {
  return Date.now();
}

function projectsDir() {
  return paths.ensureDir("projects");
}

function indexPath() {
  return path.join(projectsDir(), INDEX);
}

function projectFolder(id) {
  const dir = path.join(projectsDir(), String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeId(id) {
  return String(id || "")
    .replace(/[\\/]+/g, "")
    .replace(/\.\./g, "")
    .slice(0, 80);
}

function newId() {
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readIndex() {
  try {
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      activeId: parsed.activeId || null,
      ids: Array.isArray(parsed.ids) ? parsed.ids : [],
    };
  } catch {
    return { version: 1, activeId: null, ids: [] };
  }
}

function writeIndex(state) {
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      { version: 1, updatedAt: now(), activeId: state.activeId || null, ids: state.ids || [] },
      null,
      2,
    ),
  );
}

function readManifest(id) {
  const folder = path.join(projectsDir(), safeId(id));
  const file = path.join(folder, MANIFEST);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    try {
      const instructions = fs.readFileSync(path.join(folder, INSTRUCTIONS), "utf8");
      if (instructions) parsed.instructions = instructions;
    } catch {
      /* keep manifest instructions */
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeManifest(project) {
  const id = safeId(project.id);
  if (!id) return { ok: false, error: "Invalid project id." };
  const folder = projectFolder(id);
  const copy = { ...project };
  if (!copy.isolation) delete copy.isolation;
  fs.writeFileSync(path.join(folder, INSTRUCTIONS), String(copy.instructions || ""), "utf8");
  fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(copy, null, 2));
  if (!copy.rootPath) {
    const work = path.join(folder, "work");
    fs.mkdirSync(work, { recursive: true });
    copy.rootPath = work;
    copy.relativeRoot = path
      .relative(paths.root() || folder, work)
      .split(path.sep)
      .join("/");
    fs.writeFileSync(path.join(folder, MANIFEST), JSON.stringify(copy, null, 2));
  }
  return { ok: true, item: copy };
}

function list() {
  const index = readIndex();
  const items = [];
  const seen = new Set();
  for (const id of index.ids) {
    const item = readManifest(id);
    if (item) {
      items.push(item);
      seen.add(id);
    }
  }
  try {
    for (const entry of fs.readdirSync(projectsDir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name) || entry.name === "work") continue;
      const item = readManifest(entry.name);
      if (item) {
        items.push(item);
        index.ids.push(entry.name);
      }
    }
  } catch {
    /* empty */
  }
  writeIndex({ activeId: index.activeId, ids: [...new Set(index.ids)] });
  return { ok: true, items, activeId: index.activeId, dir: projectsDir() };
}

function defaultWorkPath(id) {
  const folder = path.join(projectFolder(id), "work");
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function protectedRoot(rootPath, fridayRoot) {
  if (!fridayRoot || !rootPath) return false;
  const root = path.resolve(fridayRoot).toLowerCase();
  const target = path.resolve(rootPath).toLowerCase();
  if (target === root) return true;
  const names = [
    "config",
    "security",
    "memory",
    "conversations",
    "brain-data",
    "database",
    "models",
    "voices",
    "runtime",
    "agents",
    "skills",
    "plugins",
    "modules",
    "workflows",
    "library",
  ];
  return names.some((name) => {
    const folder = path.join(root, name);
    return target === folder || target.startsWith(`${folder}${path.sep}`);
  });
}

function save(payload = {}) {
  const current = payload.id ? readManifest(payload.id) : null;
  const id = safeId(payload.id) || newId();
  const nowTs = now();
  let rootPath = String(payload.rootPath || current?.rootPath || "");
  const fridayRoot = paths.root();
  if (fridayRoot && rootPath && path.resolve(rootPath) === path.resolve(fridayRoot)) {
    return { ok: false, error: "Refusing to use FRIDAY_ROOT as a project folder." };
  }
  if (fridayRoot && rootPath && protectedRoot(rootPath, fridayRoot)) {
    return { ok: false, error: "Refusing to use a protected FRIDAY folder as a project root." };
  }
  if (!rootPath) rootPath = defaultWorkPath(id);
  const item = {
    id,
    name: String(payload.name || current?.name || "Untitled project"),
    kind: payload.kind || current?.kind || "mixed",
    rootPath,
    instructions:
      payload.instructions != null
        ? String(payload.instructions)
        : String(current?.instructions || ""),
    preferences: payload.preferences ||
      current?.preferences || {
        language: "",
        stack: "",
        format: "",
        handsOffAuto: Boolean(payload.handsOffAuto),
      },
    knowledge: Array.isArray(payload.knowledge) ? payload.knowledge : current?.knowledge || [],
    sources: Array.isArray(payload.sources) ? payload.sources : current?.sources || [],
    runtime: Array.isArray(payload.runtime) ? payload.runtime : current?.runtime || [],
    isolation:
      payload.isolation === "" || payload.isolation === null
        ? undefined
        : payload.isolation || current?.isolation,
    handsOffAuto: Boolean(
      payload.handsOffAuto ?? payload.preferences?.handsOffAuto ?? current?.handsOffAuto,
    ),
    archived: Boolean(payload.archived ?? current?.archived),
    activity: payload.activity || current?.activity || { lastFiles: [], updatedAt: nowTs },
    createdAt: current?.createdAt || nowTs,
    updatedAt: nowTs,
  };
  const written = writeManifest(item);
  if (!written.ok) return written;
  const index = readIndex();
  if (!index.ids.includes(id)) index.ids.unshift(id);
  if (!index.activeId) index.activeId = id;
  writeIndex(index);
  return { ok: true, item: written.item, activeId: index.activeId };
}

function get(id) {
  const item = readManifest(id);
  if (!item) return { ok: false, error: "Project not found." };
  return { ok: true, item };
}

function setActive(id) {
  const index = readIndex();
  const target = String(id || "");
  if (target && !readManifest(target)) return { ok: false, error: "Project not found." };
  index.activeId = target || null;
  writeIndex(index);
  return { ok: true, activeId: index.activeId, items: list().items };
}

function duplicate(id) {
  const source = readManifest(id);
  if (!source) return { ok: false, error: "Project not found." };
  const copy = {
    ...source,
    id: newId(),
    name: `${source.name} copy`,
    rootPath: "",
    createdAt: now(),
    updatedAt: now(),
    archived: false,
  };
  return save(copy);
}

function archive(id, archived = true) {
  const item = readManifest(id);
  if (!item) return { ok: false, error: "Project not found." };
  item.archived = Boolean(archived);
  item.updatedAt = now();
  return save(item);
}

function remove(id) {
  const target = safeId(id);
  if (!target) return { ok: false, error: "Invalid project id." };
  const item = readManifest(target);
  const index = readIndex();
  index.ids = index.ids.filter((row) => row !== target);
  if (index.activeId === target) index.activeId = index.ids[0] || null;
  writeIndex(index);
  const folder = path.join(projectsDir(), target);
  const root = paths.root();
  if (root && path.resolve(folder) === path.resolve(root)) {
    return { ok: false, error: "Refusing to delete FRIDAY_ROOT." };
  }
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    /* missing folder is fine */
  }
  return { ok: true, activeId: index.activeId, removed: item?.id || target };
}

function reveal(id) {
  const item = readManifest(id);
  const target = item?.rootPath || (id ? path.join(projectsDir(), safeId(id)) : projectsDir());
  shell.openPath(target);
  return true;
}

function writeFileInProject(payload = {}) {
  const item = readManifest(payload.id);
  if (!item) return { ok: false, error: "Project not found." };
  if ((item.handsOffAuto || item.preferences?.handsOffAuto) && payload.actor !== "owner") {
    return {
      ok: false,
      error: `Auto Mode hands-off: I will not write into project "${item.name}" until you turn hands-off off or instruct me in Manual Chat.`,
    };
  }
  const root = item.rootPath || defaultWorkPath(item.id);
  if (!root) return { ok: false, error: "This project has no folder yet." };
  const fridayRoot = paths.root();
  if (fridayRoot && path.resolve(root) === path.resolve(fridayRoot)) {
    return { ok: false, error: "Refusing to wipe FRIDAY_ROOT." };
  }
  const name = String(payload.name || "note.md")
    .replace(/[\\/]+/g, "_")
    .slice(0, 180);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, name);
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { ok: false, error: "That path is outside the project folder." };
  }
  fs.writeFileSync(file, String(payload.text || ""), "utf8");
  const rel = path.relative(root, file).split(path.sep).join("/");
  item.activity = item.activity || { lastFiles: [], updatedAt: now() };
  item.activity.lastFiles = [rel, ...(item.activity.lastFiles || [])].slice(0, 24);
  item.activity.lastGenerate = rel;
  item.activity.updatedAt = now();
  item.updatedAt = now();
  writeManifest(item);
  return { ok: true, item, file: rel };
}

function listFiles(id) {
  const item = readManifest(id);
  if (!item) return { ok: false, error: "Project not found." };
  const root = item.rootPath;
  if (!root || !fs.existsSync(root)) return { ok: true, files: [], item };
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 3 || files.length >= 80) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) walk(full, depth + 1);
      else files.push(rel);
      if (files.length >= 80) return;
    }
  };
  walk(root, 0);
  return { ok: true, files, item };
}

function readFileInProject(payload = {}) {
  const item = readManifest(payload.id);
  if (!item) return { ok: false, error: "Project not found." };
  const root = item.rootPath || defaultWorkPath(item.id);
  const name = String(payload.name || payload.file || "").replace(/\\/g, "/");
  if (!name || name.includes("..")) return { ok: false, error: "Invalid file name." };
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(root, name);
  if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${path.sep}`)) {
    return { ok: false, error: "That path is outside the project folder." };
  }
  try {
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return { ok: false, error: "File not found in this project folder." };
    }
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) {
      return { ok: false, error: "File is too large to preview here (>2 MB)." };
    }
    const content = fs.readFileSync(file, "utf8");
    return {
      ok: true,
      content,
      size: stat.size,
      name: path.relative(root, file).split(path.sep).join("/"),
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = {
  list,
  save,
  get,
  setActive,
  duplicate,
  archive,
  remove,
  reveal,
  writeFileInProject,
  listFiles,
  readFileInProject,
  projectsDir,
};
