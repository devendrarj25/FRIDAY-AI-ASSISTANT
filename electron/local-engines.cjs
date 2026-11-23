/**
 * The one table of local inference engines (Ollama, LM Studio, llama.cpp, ...).
 *
 * The table is `kernel/local_engines.json`: the kernel reads it too
 * (`kernel/local_engines.py`), and the packaged app ships it through the kernel
 * extraResources copy. Add an engine by adding one row there, nowhere else.
 *
 * Loading never throws. A missing file, malformed JSON, or no usable row falls
 * back to a small built-in table, and a bad row is skipped on its own.
 */
const fs = require("node:fs");

const TABLE_FILE = "kernel/local_engines.json";
const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const WIRES = new Set(["openai", "ollama"]);
const FLAGS = ["needsLoad", "keepAlive", "offloadHint", "registryPrefix"];

/** Used only when the file cannot be read: the engines a fresh install talks to first. */
const FALLBACK_ROWS = [
  {
    id: "ollama",
    name: "Ollama",
    wire: "ollama",
    endpoint: "http://127.0.0.1:11434",
    apiPath: "",
    chatPath: "/api/chat",
    modelsPath: "/api/tags",
    env: "OLLAMA_HOST",
    keepAlive: true,
    offloadHint: true,
    registryPrefix: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    wire: "openai",
    endpoint: "http://127.0.0.1:1234",
    apiPath: "/v1",
    modelsPath: "/v1/models",
    needsLoad: true,
    registryPrefix: true,
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    wire: "openai",
    endpoint: "http://127.0.0.1:8080",
    apiPath: "/v1",
    modelsPath: "/v1/models",
    healthPath: "/health",
    registryPrefix: true,
    aliases: ["llama.cpp"],
  },
];
const FALLBACK_GENERIC = ["local"];

const text = (value, limit = 200) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const httpBase = (value) => {
  const clean = text(value).replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(clean) ? clean : "";
};
const pathOr = (value, fallback) => {
  const clean = text(value);
  if (!clean) return fallback;
  return clean.startsWith("/") ? clean : "";
};
const list = (value, clean) =>
  Array.isArray(value) ? value.map(clean).filter((item) => item) : [];

/** One validated engine row, or null when it cannot be used. Unknown fields are dropped. */
function cleanRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = text(raw.id).toLowerCase();
  const wire = text(raw.wire).toLowerCase();
  const endpoint = httpBase(raw.endpoint);
  if (!ID.test(id) || !WIRES.has(wire) || !endpoint) return null;
  const modelsPath = pathOr(raw.modelsPath, wire === "ollama" ? "/api/tags" : "/v1/models");
  const row = {
    id,
    name: text(raw.name, 80) || id,
    wire,
    endpoint,
    apiPath: wire === "openai" && raw.apiPath ? pathOr(raw.apiPath, "") : "",
    chatPath: wire === "ollama" ? pathOr(raw.chatPath, "/api/chat") : "",
    modelsPath,
    healthPath: pathOr(raw.healthPath, modelsPath),
    env: text(raw.env, 80),
    alternates: list(raw.alternates, httpBase),
    platforms: list(raw.platforms, (item) => text(item, 40)),
    aliases: list(raw.aliases, (item) => text(item, 80).toLowerCase()),
  };
  for (const flag of FLAGS) row[flag] = raw[flag] === true;
  return row;
}

/** `{ rows: Map(id -> row), generic: string[] }` from a parsed file, or the built-in table. */
function tableFrom(data) {
  const rows = new Map();
  const generic = [];
  const items = data && typeof data === "object" ? data.engines : null;
  for (const item of Array.isArray(items) ? items : []) {
    const row = cleanRow(item);
    if (row && !rows.has(row.id)) rows.set(row.id, row);
  }
  const kinds = data && typeof data === "object" ? data.genericKinds : null;
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    const clean = text(kind, 40).toLowerCase();
    if (ID.test(clean) && !generic.includes(clean)) generic.push(clean);
  }
  if (!rows.size) {
    for (const item of FALLBACK_ROWS) {
      const row = cleanRow(item);
      if (row) rows.set(row.id, row);
    }
    return { rows, generic: [...FALLBACK_GENERIC] };
  }
  return { rows, generic };
}

function tableFile() {
  try {
    return require("./resource-paths.cjs").resolveResourceFile(TABLE_FILE);
  } catch {
    return null;
  }
}

/** Read a table file; any failure is the built-in table. */
function loadTable(file = tableFile()) {
  let data = null;
  try {
    if (file) data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    data = null;
  }
  return tableFrom(data);
}

const { rows: ROWS, generic: GENERIC_KINDS } = loadTable();

function kindsOf(rows, generic) {
  const names = new Set(generic);
  for (const row of rows.values()) {
    names.add(row.id);
    for (const alias of row.aliases) names.add(alias);
  }
  return names;
}

const LOCAL_KINDS = kindsOf(ROWS, GENERIC_KINDS);

const engines = () => [...ROWS.values()];
const engineIds = () => [...ROWS.keys()];
const getEngine = (id) => ROWS.get(String(id || "").toLowerCase()) || null;
/** True for an engine id, an alias such as `llama.cpp`, or the generic `local` kind. */
const isLocalKind = (name) =>
  LOCAL_KINDS.has(
    String(name || "")
      .trim()
      .toLowerCase(),
  );
/** Engine ids plus the generic kinds, without aliases (what the router's id-prefix check matches). */
const localProviderIds = () => new Set([...ROWS.keys(), ...GENERIC_KINDS]);
const supports = (id, flag) =>
  Boolean(getEngine(id) && FLAGS.includes(flag) && getEngine(id)[flag]);
const defaultEndpoint = (id) => getEngine(id)?.endpoint || "";
const modelsPath = (id) => getEngine(id)?.modelsPath || "/v1/models";
const healthPath = (id) => getEngine(id)?.healthPath || modelsPath(id);
/** The environment variable that overrides an engine's endpoint, when the row names one. */
function endpointFromEnv(id, env = process.env) {
  const row = getEngine(id);
  const raw = row && row.env ? httpBase(env[row.env]) : "";
  return raw || row?.endpoint || "";
}

/**
 * The OpenAI-compatible engines the desktop lists as live, in the shape the model
 * inventory uses. Ollama speaks its own wire and is listed apart. A row with
 * `platforms` shows only there (MLX-LM is Apple silicon only).
 */
function listedEngines(platform = process.platform) {
  const out = {};
  for (const row of ROWS.values()) {
    if (row.wire !== "openai") continue;
    if (row.platforms.length && !row.platforms.includes(platform)) continue;
    out[row.id] = {
      name: row.name,
      endpoint: row.endpoint,
      ...(row.alternates.length ? { alternates: [...row.alternates] } : {}),
      ...(row.env ? { env: row.env } : {}),
    };
  }
  return out;
}

/** `{ id: display name }` for every engine, for labels. */
function displayNames() {
  return Object.fromEntries([...ROWS.values()].map((row) => [row.id, row.name]));
}

module.exports = {
  TABLE_FILE,
  FALLBACK_ROWS,
  FALLBACK_GENERIC,
  FLAGS,
  cleanRow,
  tableFrom,
  loadTable,
  kindsOf,
  engines,
  engineIds,
  getEngine,
  isLocalKind,
  localProviderIds,
  supports,
  defaultEndpoint,
  modelsPath,
  healthPath,
  endpointFromEnv,
  listedEngines,
  displayNames,
  LOCAL_KINDS,
  GENERIC_KINDS,
};
