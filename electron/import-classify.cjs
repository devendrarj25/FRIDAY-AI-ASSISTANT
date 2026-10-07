// FRIDAY · content recogniser.
//
// One canonical classifier used by every import path (ZIP, folder, loose
// files, GitHub download). It answers two questions for each incoming file:
//
//   * which FRIDAY area does it belong to (and can it be swapped live)?
//   * where exactly inside the FRIDAY folder must it land?
//
// Nothing ever resolves to the workspace root: content FRIDAY cannot place
// with confidence goes to updates/unsorted/<package>/ with a stated reason,
// so the workspace tree always stays organised.
const fs = require("fs");
const path = require("path");
const packShape = require("./pack-shape.cjs");

// Areas of a FRIDAY-shaped package: top-level folder → area + hot-swap flag.
const AREAS = [
  { match: /^(modules)\//i, area: "modules", hot: true },
  { match: /^(plugins)\//i, area: "plugins", hot: true },
  { match: /^(agents)\//i, area: "agents", hot: true },
  { match: /^(skills)\//i, area: "skills", hot: true },
  { match: /^(workflows)\//i, area: "workflows", hot: true },
  { match: /^(themes|resources)\//i, area: "resources", hot: true },
  { match: /^(brain-data|memory)\//i, area: "brain", hot: true },
  { match: /^(config)\//i, area: "config", hot: false },
  { match: /^(kernel)\//i, area: "kernel", hot: false },
  { match: /^(electron|scripts|installer|updater|builder)\//i, area: "shell", hot: false },
  { match: /^(src|public)\//i, area: "renderer", hot: false },
  { match: /^(core|tools|system|models|testing)\//i, area: "core", hot: false },
  { match: /^(docs|README|INSTALL)/i, area: "docs", hot: true },
];

const HOT_AREAS = new Set([
  "modules",
  "plugins",
  "agents",
  "skills",
  "tools",
  "workflows",
  "resources",
  "brain",
  "models",
  "database",
  "docs",
  "projects",
  "unsorted",
  "other",
  "voices",
  "connectors",
]);

/**
 * Where a recognised package of each kind lives inside the FRIDAY folder.
 * One table, used by every import path, so a plugin always lands in the same
 * registry folder whether it arrived as a ZIP, a folder or a GitHub download.
 */
const REGISTRY_HOMES = {
  plugin: "plugins/installed",
  module: "modules/custom",
  skill: "skills/custom",
  agent: "agents/custom",
  tool: "tools/custom",
  workflow: "workflows/saved",
  // Real homes — not invented. Voices land where voice:import already writes
  // (`paths.ensureDir("voices")`). Chat transcripts park for approval and are
  // never merged into live history. Connector bundles park beside config until
  // the owner confirms through the connectors system.
  voice: "voices",
  chat: "memory/imports/chats",
  connector: "config/connector-imports",
};

const TREE_TO_KIND = {
  skills: "skill",
  tools: "tool",
  agents: "agent",
  modules: "module",
  plugins: "plugin",
  workflows: "workflow",
};

const areaOfKind = (kind) => {
  if (kind === "tool") return "tools";
  if (kind === "voice") return "voices";
  if (kind === "chat") return "memory";
  if (kind === "connector") return "connectors";
  return `${kind}s`;
};

/**
 * Manifest file names FRIDAY recognises. A kind-named manifest (skill.json,
 * tool.json, …) also declares what the folder is, which is how FRIDAY's own
 * skills and tools are shaped on disk.
 */
const MANIFEST_FILES = {
  "manifest.json": null,
  "plugin.json": "plugin",
  "module.json": "module",
  "skill.json": "skill",
  "agent.json": "agent",
  "tool.json": "tool",
  "workflow.json": "workflow",
};

const EXT = {
  model: [".gguf", ".safetensors", ".onnx", ".pt", ".ggml"],
  doc: [".md", ".txt", ".pdf", ".docx", ".rst", ".doc"],
  image: [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico"],
  font: [".ttf", ".otf", ".woff", ".woff2"],
  sound: [".mp3", ".wav", ".ogg", ".flac"],
  voice: [".onnx", ".pt", ".pth", ".vits", ".wav", ".mp3", ".ogg", ".flac"],
  data: [".csv", ".parquet", ".tsv"],
  db: [".sqlite3", ".sqlite", ".db"],
  memory: [".jsonl", ".ndjson", ".embeddings"],
  config: [".yaml", ".yml", ".toml", ".ini", ".cfg", ".env"],
  code: [".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"],
  archive: [".zip", ".tar", ".tgz", ".gz", ".7z", ".rar"],
};

const extOf = (p) => path.extname(p).toLowerCase();
const baseOf = (p) => p.split("/").pop() || p;
const slug = (value) =>
  String(value || "import")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "import";

/** Read a small text file; returns "" for binaries and unreadable paths. */
function peek(file, limit = 262_144) {
  try {
    if (!file || fs.statSync(file).size > limit) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Is this extracted tree a FRIDAY package (an upgrade of the app itself)? */
function isFridayPackage(root) {
  if (!root || !fs.existsSync(root)) return false;
  const markers = ["electron", "kernel", "core", "src/routes"].filter((m) =>
    fs.existsSync(path.join(root, m)),
  );
  if (markers.length >= 2) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return /friday/i.test(String(pkg.name || "")) || Boolean(pkg.build?.appId?.match(/friday/i));
  } catch {
    return false;
  }
}

/**
 * A manifest describing a plugin / module / skill / agent / tool / workflow.
 * Accepts the generic manifest.json and the kind-named manifests FRIDAY's own
 * content uses (skill.json, tool.json, plugin.json, …).
 */
function readManifest(dir) {
  for (const [fileName, declaredKind] of Object.entries(MANIFEST_FILES)) {
    const file = path.join(dir, fileName);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object") continue;
      const label = data.name || data.id || data.title;
      if (!label) continue;
      const declared = String(data.kind || data.type || "").toLowerCase();
      let kind = ["plugin", "module", "skill", "agent", "workflow", "tool"].includes(declared)
        ? declared
        : declaredKind;
      const shaped = packShape.detectPackShape({
        ...data,
        filename: fileName,
        manifestName: fileName,
        manifest: data,
        code: "",
      });
      if (shaped.tree && TREE_TO_KIND[shaped.tree]) kind = TREE_TO_KIND[shaped.tree];
      if (!kind) {
        const perms = (data.permissions || []).join(" ");
        if (/agent/i.test(String(data.entry || ""))) kind = "agent";
        else if (perms || data.entry) kind = "module";
        else kind = "plugin";
      }
      return { kind, name: slug(label), manifest: data };
    } catch {
      /* unreadable/invalid manifest — try the next candidate */
    }
  }
  return null;
}

/**
 * Every recognised package inside a staged tree, keyed by its folder relative
 * to the tree root. A drop that contains many skills/plugins therefore installs
 * each one into its own registry folder instead of being scattered by file type.
 */
function discoverPackages(contentRoot, maxDepth = 5) {
  const found = new Map();
  const visit = (dir, relative, depth) => {
    if (depth > maxDepth) return;
    const manifest = readManifest(dir);
    if (manifest) {
      found.set(relative, manifest);
      return; // a package owns everything beneath it
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      visit(
        path.join(dir, entry.name),
        relative ? `${relative}/${entry.name}` : entry.name,
        depth + 1,
      );
    }
  };
  if (contentRoot && fs.existsSync(contentRoot)) visit(contentRoot, "", 0);
  found.delete(""); // the root itself is handled by inspectPackage
  return found;
}

/** The package (if any) a file belongs to — the closest manifest above it. */
function packageFor(normalized, packages) {
  if (!packages || !packages.size) return null;
  let best = null;
  for (const [dir, info] of packages) {
    if (!dir) continue;
    if (normalized === dir || normalized.startsWith(`${dir}/`)) {
      if (!best || dir.length > best.dir.length) best = { dir, info };
    }
  }
  return best;
}

/** A foreign project (someone else's repo) rather than FRIDAY content. */
function isProject(root) {
  return ["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod"].some((m) =>
    fs.existsSync(path.join(root, m)),
  );
}

/** Guess the role of a loose code file from its source. */
function codeRole(file, relative) {
  const text = peek(file);
  const name = baseOf(relative).toLowerCase();
  if (
    /class\s+\w*agent|\bAGENT_MANIFEST\b|autonomous agent/i.test(text) ||
    name.includes("agent")
  ) {
    return { area: "agents", dir: "agents/custom" };
  }
  if (/def\s+register\s*\(|export\s+const\s+\w+Module|register\s*\(manifest/.test(text)) {
    return { area: "modules", dir: "modules/custom" };
  }
  if (
    /def\s+run\s*\(|export\s+async\s+function\s+run|\bSKILL\b/i.test(text) ||
    name.includes("skill")
  ) {
    return { area: "skills", dir: "skills/custom" };
  }
  if (/tool|command|execute/i.test(name)) return { area: "tools", dir: "tools/custom" };
  return { area: "skills", dir: "skills/custom" };
}

/** Does this JSON look like an n8n / FRIDAY workflow definition? */
function isWorkflowJson(file, relative) {
  const name = baseOf(relative).toLowerCase();
  if (/workflow|n8n|flow/.test(name)) return true;
  const text = peek(file, 1_000_000);
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return false;
  try {
    const data = JSON.parse(text);
    const node = Array.isArray(data) ? data[0] : data;
    return Boolean(node && node.nodes && (node.connections || node.edges));
  } catch {
    return false;
  }
}

function parseJsonFile(file) {
  const text = peek(file, 1_000_000);
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageLike(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const role = String(entry.role || entry.speaker || "").toLowerCase();
  const hasBody =
    typeof entry.content === "string" ||
    typeof entry.text === "string" ||
    typeof entry.message === "string";
  return Boolean(role && hasBody);
}

/** Exported chat/conversation JSON — never treated as a capability pack. */
function isChatTranscript(data) {
  if (!data) return false;
  if (Array.isArray(data)) return data.length > 0 && data.every(messageLike);
  if (typeof data !== "object") return false;
  if (data.kind || data.type || data.nodes || data.steps || data.capabilities || data.entry) {
    return false;
  }
  const messages = data.messages || data.transcript || data.conversation || data.history;
  return Array.isArray(messages) && messages.length > 0 && messages.every(messageLike);
}

/** Connector definition or credential bundle — parks for owner confirm. */
function isConnectorBundle(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const kind = String(data.kind || data.type || "").toLowerCase();
  if (kind === "connector" || kind === "credential-bundle") return true;
  const auth = String(data.authType || data.auth_type || "").toLowerCase();
  const id = String(data.id || data.connectorId || data.connector || "").trim();
  if (!id || !["oauth", "apikey", "phone", "mcp"].includes(auth.replace(/[-_]/g, ""))) return false;
  if (data.capabilities || data.entry || data.steps || data.hooks) return false;
  return Boolean(data.fields || data.credentials || data.apiKey || data.token || data.secrets);
}

function isVoiceFile(relative, ext) {
  const name = baseOf(relative).toLowerCase();
  const posix = String(relative).replace(/\\/g, "/").toLowerCase();
  if (
    /(^|\/)voices\//.test(posix) ||
    /(?:^|[-_])(voice|tts|piper|speaker|wake)(?:[-_.]|$)/.test(name)
  ) {
    return EXT.voice.includes(ext) || EXT.model.includes(ext) || EXT.sound.includes(ext);
  }
  return false;
}

function jsonShapeKind(file, relative) {
  const data = parseJsonFile(file);
  if (!data) return null;
  if (isChatTranscript(data)) {
    return {
      kind: "chat",
      reason: "chat transcript — parked until you confirm merging into history",
    };
  }
  if (isConnectorBundle(data)) {
    return {
      kind: "connector",
      reason: "connector definition — parked until you confirm in Connectors",
    };
  }
  const shaped = packShape.detectPackShape({
    ...(typeof data === "object" && !Array.isArray(data) ? data : {}),
    filename: baseOf(relative),
    manifestName: baseOf(relative),
    manifest: typeof data === "object" && !Array.isArray(data) ? data : {},
    code: "",
  });
  if (shaped.tree && TREE_TO_KIND[shaped.tree]) {
    return { kind: TREE_TO_KIND[shaped.tree], reason: shaped.reason };
  }
  return null;
}

/**
 * Classify one incoming file.
 *
 * @param {string} relative  path inside the imported package (posix)
 * @param {object} ctx       { mode, full, packageName, manifestKind, manifestName }
 * @returns {{ area:string, hot:boolean, dest:string, reason:string }}
 */
function classify(relative, ctx = {}) {
  const normalized = String(relative).replace(/\\/g, "/").replace(/^\.\//, "");
  const mode = ctx.mode || "friday";
  const pkg = slug(ctx.packageName || "import");

  // 1 · FRIDAY package — keep the original layout, it is an app upgrade.
  if (mode === "friday") {
    for (const rule of AREAS) {
      if (rule.match.test(normalized)) {
        return {
          area: rule.area,
          hot: rule.hot,
          dest: normalized,
          reason: "FRIDAY package layout",
        };
      }
    }
  }

  // 2 · Manifest package — the whole folder belongs to one registry.
  if (mode === "manifest") {
    const kind = ctx.manifestKind || "module";
    const home = REGISTRY_HOMES[kind] || "modules/custom";
    const area = areaOfKind(kind);
    return {
      area,
      hot: HOT_AREAS.has(area),
      dest: `${home}/${ctx.manifestName || pkg}/${normalized}`,
      reason: `manifest declares a ${kind}`,
    };
  }

  // 2b · A package nested inside the drop — installed whole, folder intact.
  const nested = mode === "loose" ? packageFor(normalized, ctx.packages) : null;
  if (nested) {
    const kind = nested.info.kind || "module";
    const home = REGISTRY_HOMES[kind] || "modules/custom";
    const area = areaOfKind(kind);
    const inside = normalized.slice(nested.dir.length).replace(/^\//, "");
    return {
      area,
      hot: HOT_AREAS.has(area),
      dest: `${home}/${nested.info.name}/${inside}`,
      reason: `${kind} package "${nested.info.name}" kept intact`,
    };
  }

  // 3 · Foreign project — kept intact under the workspace projects folder.
  if (mode === "project") {
    return {
      area: "projects",
      hot: true,
      dest: `workspace/projects/${pkg}/${normalized}`,
      reason: "external project kept intact",
    };
  }

  // 4 · Loose content — routed by type, name and (for code) its contents.
  const ext = extOf(normalized);
  const name = baseOf(normalized);
  const flat = (dir, why) => ({
    area: dir.split("/")[0],
    hot: true,
    dest: `${dir}/${name}`,
    reason: why,
  });

  if (EXT.model.includes(ext) && isVoiceFile(normalized, ext)) {
    return { ...flat("voices", "voice model"), area: "voices" };
  }
  if (EXT.model.includes(ext))
    return { ...flat("models/local", `${ext} model weight`), area: "models" };
  if (ext === ".json" && isWorkflowJson(ctx.full, normalized)) {
    return { ...flat("workflows/saved", "workflow definition"), area: "workflows" };
  }
  if (ext === ".json") {
    const shaped = jsonShapeKind(ctx.full, normalized);
    if (shaped?.kind === "chat") {
      return {
        ...flat("memory/imports/chats", shaped.reason),
        area: "memory",
        needsApproval: true,
      };
    }
    if (shaped?.kind === "connector") {
      return {
        ...flat("config/connector-imports", shaped.reason),
        area: "connectors",
        needsApproval: true,
      };
    }
    if (shaped?.kind && REGISTRY_HOMES[shaped.kind]) {
      const home = REGISTRY_HOMES[shaped.kind];
      const area = areaOfKind(shaped.kind);
      return {
        area,
        hot: HOT_AREAS.has(area),
        dest: `${home}/${slug(baseOf(normalized))}/${name}`,
        reason: shaped.reason,
      };
    }
    const text = peek(ctx.full);
    if (/"model"|"provider"|"models"\s*:/.test(text))
      return {
        area: "models",
        hot: true,
        dest: `models/manifests/${name}`,
        reason: "model manifest",
      };
    return { area: "config", hot: false, dest: `config/${name}`, reason: "JSON configuration" };
  }
  if (EXT.doc.includes(ext))
    return {
      ...flat("brain-data/knowledge", "document — extract via document-extract"),
      area: "brain",
      extract: true,
    };
  if (EXT.image.includes(ext))
    return {
      ...flat(/icon|logo/i.test(name) ? "resources/icons" : "resources/assets", "image asset"),
      area: "resources",
    };
  if (EXT.font.includes(ext))
    return { ...flat("resources/fonts", "font asset"), area: "resources" };
  if (EXT.sound.includes(ext) && isVoiceFile(normalized, ext))
    return { ...flat("voices", "voice sample"), area: "voices" };
  if (EXT.sound.includes(ext))
    return { ...flat("resources/sounds", "sound asset"), area: "resources" };
  if (EXT.db.includes(ext))
    return { ...flat("database/backups", "database file"), area: "database" };
  if (EXT.data.includes(ext))
    return { ...flat("memory/semantic", "dataset for memory"), area: "brain" };
  if (EXT.memory.includes(ext))
    return { ...flat("memory/permanent", "memory records"), area: "brain" };
  if (EXT.config.includes(ext) || /^(config|settings)\./i.test(name))
    return { area: "config", hot: false, dest: `config/${name}`, reason: "configuration file" };
  if (EXT.code.includes(ext)) {
    const role = codeRole(ctx.full, normalized);
    return {
      area: role.area,
      hot: true,
      dest: `${role.dir}/${name}`,
      reason: `recognised ${role.area} code`,
    };
  }
  if (EXT.archive.includes(ext))
    return {
      area: "unsorted",
      hot: true,
      dest: `updates/unsorted/${pkg}/${normalized}`,
      reason: "nested archive",
    };

  return {
    area: "unsorted",
    hot: true,
    dest: `updates/unsorted/${pkg}/${normalized}`,
    reason: "type not recognised — parked for review",
  };
}

/**
 * Work out how a whole staged tree should be treated.
 * @returns {{ mode:string, packageName:string, manifestKind?:string, manifestName?:string, label:string }}
 */
function inspectPackage(contentRoot, fallbackName = "import") {
  const packageName = slug(path.basename(contentRoot) || fallbackName);
  if (isFridayPackage(contentRoot)) {
    return { mode: "friday", packageName, label: "FRIDAY package" };
  }
  const manifest = readManifest(contentRoot);
  if (manifest) {
    return {
      mode: "manifest",
      packageName,
      manifestKind: manifest.kind,
      manifestName: manifest.name,
      label: `${manifest.kind} · ${manifest.name}`,
    };
  }
  if (isProject(contentRoot)) {
    return { mode: "project", packageName, label: "external project" };
  }
  // A loose drop may still contain complete packages (skills, plugins, tools…).
  const packages = discoverPackages(contentRoot);
  const label = packages.size
    ? `${packages.size} package${packages.size === 1 ? "" : "s"}`
    : "loose content";
  return { mode: "loose", packageName, packages, label };
}

module.exports = {
  AREAS,
  HOT_AREAS,
  REGISTRY_HOMES,
  discoverPackages,
  classify,
  inspectPackage,
  isFridayPackage,
  readManifest,
  isChatTranscript,
  isConnectorBundle,
  isVoiceFile,
  slug,
};
