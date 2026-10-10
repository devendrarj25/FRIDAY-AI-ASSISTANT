/**
 * FRIDAY · one MCP protocol layer.
 *
 * The client and the server both speak through this file. Revisions:
 * 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, and 2026-07-28.
 * Field names follow the 2026-07-28 specification (read 2026-10-10).
 * Older clients still use initialize. A 2026-07-28 peer uses server/discover
 * and per-request _meta, and does not use a session id.
 */
const crypto = require("node:crypto");
const path = require("node:path");

const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];
const CURRENT_VERSION = "2026-07-28";
const LEGACY_VERSION = "2024-11-05";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
const META_FRIDAY_TOKEN = "io.friday/clientToken";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

const ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_CAPABILITY: -32021,
  UNSUPPORTED_VERSION: -32022,
};

const PAGE_SIZE = 20;
const OUTPUT_CAP = 8000;

function publicVersion() {
  try {
    const file = require("../config/friday-version.json");
    return `${file.major}.${file.minor}.${file.patch}.${file.revision}`;
  } catch {
    return "1.0.1.2";
  }
}

function clientInfo() {
  return { name: "FRIDAY", version: publicVersion() };
}

function serverInfo() {
  return { name: "FRIDAY", version: publicVersion() };
}

function negotiate(clientVersion) {
  const version = String(clientVersion || "");
  if (SUPPORTED_VERSIONS.includes(version)) return version;
  return null;
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message: String(message || "MCP error") };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function unsupportedVersion(id) {
  return jsonRpcError(id, ERROR.UNSUPPORTED_VERSION, "Unsupported protocol version.", {
    supported: SUPPORTED_VERSIONS,
  });
}

function requestMeta(version, capabilities) {
  return {
    [META_VERSION]: version,
    [META_CLIENT_INFO]: clientInfo(),
    [META_CLIENT_CAPS]: capabilities || { tools: {} },
  };
}

function stampResult(version, result, info = serverInfo()) {
  const body = result && typeof result === "object" ? { ...result } : { value: result };
  if (version === CURRENT_VERSION) {
    if (!body.resultType) body.resultType = "complete";
    body._meta = { ...(body._meta || {}), [META_SERVER_INFO]: info };
  }
  return body;
}

function listCache(version, result) {
  const body = stampResult(version, result);
  if (version === CURRENT_VERSION) {
    body.ttlMs = body.ttlMs ?? 0;
    body.cacheScope = body.cacheScope || "private";
  }
  return body;
}

function readVersion(message) {
  const meta = message?.params?._meta;
  if (meta && typeof meta[META_VERSION] === "string") return meta[META_VERSION];
  if (typeof message?.params?.protocolVersion === "string") return message.params.protocolVersion;
  return null;
}

function splitFrames(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length) {
    if (rest.startsWith("Content-Length:")) {
      const headerEnd = rest.indexOf("\r\n\r\n");
      const altEnd = rest.indexOf("\n\n");
      const splitAt = headerEnd >= 0 ? headerEnd : altEnd;
      if (splitAt < 0) break;
      const header = rest.slice(0, splitAt);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      const len = match ? Number(match[1]) : 0;
      const start = splitAt + (headerEnd >= 0 ? 4 : 2);
      if (rest.length < start + len) break;
      messages.push(rest.slice(start, start + len));
      rest = rest.slice(start + len);
      continue;
    }
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (line) messages.push(line);
  }
  return { messages, rest };
}

function encodeLine(message) {
  return `${JSON.stringify(message)}\n`;
}

function parseSse(raw) {
  const out = [];
  const blocks = String(raw || "").split(/\n\n+/);
  for (const block of blocks) {
    const data = [];
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      data.push(trimmed.slice(5).trim());
    }
    if (!data.length) continue;
    try {
      out.push(JSON.parse(data.join("\n")));
    } catch {
      /* skip a non-JSON event */
    }
  }
  return out;
}

function paginate(items, cursor, pageSize = PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  let start = 0;
  if (cursor) {
    try {
      start = Number(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch {
      start = 0;
    }
    if (!Number.isFinite(start) || start < 0) start = 0;
  }
  const page = list.slice(start, start + pageSize);
  const next =
    start + pageSize < list.length
      ? Buffer.from(String(start + pageSize)).toString("base64url")
      : undefined;
  return { page, nextCursor: next };
}

function isLoopbackHost(host) {
  const name = String(host || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function isLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return isLoopbackHost(parsed.hostname);
}

function validateOrigin(origin) {
  if (origin == null || origin === "") return { ok: true, absent: true };
  const value = String(origin).trim();
  if (value === "*" || value.includes("*")) return { ok: false, reason: "wildcard" };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "scheme" };
  if (!isLoopbackHost(parsed.hostname)) return { ok: false, reason: "host" };
  if (parsed.username || parsed.password) return { ok: false, reason: "user" };
  if (parsed.pathname && parsed.pathname !== "/") return { ok: false, reason: "path" };
  return { ok: true, absent: false, origin: parsed.origin };
}

function validateHost(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return { ok: false, reason: "missing" };
  const withoutPort = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
  if (!isLoopbackHost(withoutPort)) return { ok: false, reason: "host" };
  return { ok: true };
}

function assertBindHost(host) {
  const name = String(host || "");
  if (name !== "127.0.0.1" && name !== "::1") {
    throw new Error("The MCP server binds to loopback only.");
  }
}

const SECRET_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;

function redactSecrets(value) {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return String(raw).replace(SECRET_RE, "[redacted]");
}

function isolateToolOutput(result) {
  const text = redactSecrets(result).slice(0, OUTPUT_CAP);
  return { untrusted: true, instruction: false, text };
}

function capText(value) {
  const text = redactSecrets(value);
  if (text.length <= OUTPUT_CAP) return { text, truncated: false };
  return { text: `${text.slice(0, OUTPUT_CAP)} [truncated]`, truncated: true };
}

function confinePath(root, requestPath) {
  if (!root) return { ok: false, error: "No workspace is open." };
  const base = path.resolve(root);
  const raw = String(requestPath || "");
  if (!raw || raw.includes("\0"))
    return { ok: false, error: "That path is outside the workspace." };
  const target = path.resolve(base, raw);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "That path is outside the workspace." };
  }
  return { ok: true, full: target, rel: (rel || ".").replace(/\\/g, "/") };
}

function publicUrlBlock(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return "That URL is not valid.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http and https URLs are allowed.";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    return "That URL is a local or metadata address and is refused.";
  }
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return "That URL is a private address and is refused.";
    }
  }
  return null;
}

function annotationsForRisk(risk, extra = {}) {
  const openWorld = extra.openWorld === true;
  if (risk === "safe") {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: openWorld,
    };
  }
  if (risk === "write") {
    return {
      readOnlyHint: false,
      destructiveHint: extra.destructive === true,
      idempotentHint: extra.idempotent === true,
      openWorldHint: openWorld,
    };
  }
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: openWorld,
  };
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
}

function pinTools(tools, previous) {
  const pins = {};
  const changes = [];
  for (const tool of tools || []) {
    const name = String(tool?.name || "");
    if (!name) continue;
    const description = String(tool.description || "");
    const hash = sha256(description);
    pins[name] = { hash, description };
    const prior = previous?.[name];
    if (prior && prior.hash !== hash) {
      changes.push({ name, before: prior.description, after: description });
    }
  }
  return { pins, changes };
}

function headerMismatch(headerVersion, metaVersion) {
  if (!headerVersion || !metaVersion) return false;
  return String(headerVersion) !== String(metaVersion);
}

function quoteWindows(arg) {
  const text = String(arg ?? "");
  if (!/[ \t"]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

module.exports = {
  SUPPORTED_VERSIONS,
  CURRENT_VERSION,
  LEGACY_VERSION,
  META_VERSION,
  META_CLIENT_INFO,
  META_CLIENT_CAPS,
  META_SERVER_INFO,
  META_LOG_LEVEL,
  META_FRIDAY_TOKEN,
  META_SUBSCRIPTION,
  ERROR,
  PAGE_SIZE,
  OUTPUT_CAP,
  publicVersion,
  clientInfo,
  serverInfo,
  negotiate,
  jsonRpcResult,
  jsonRpcError,
  unsupportedVersion,
  requestMeta,
  stampResult,
  listCache,
  readVersion,
  splitFrames,
  encodeLine,
  parseSse,
  paginate,
  isLoopbackHost,
  isLoopbackUrl,
  validateOrigin,
  validateHost,
  assertBindHost,
  redactSecrets,
  isolateToolOutput,
  capText,
  confinePath,
  publicUrlBlock,
  annotationsForRisk,
  sha256,
  pinTools,
  headerMismatch,
  quoteWindows,
};
