/**
 * FRIDAY · one provider handler contract.
 *
 * Every local and cloud provider is one handler with the same methods.
 * Handlers are pure: they describe a request and classify a payload.
 * They do not fetch, store a key, or choose a lane.
 */

const METHODS = [
  "discoverModels",
  "classifyAccess",
  "capabilities",
  "buildRequest",
  "parseStream",
  "mapError",
  "quota",
  "health",
  "gate",
];

const SECRET = /\b(?:sk-[a-z0-9]{8,}|api[_-]?key|authorization|bearer)\b/i;

function defaultDiscover(payload) {
  const rows = payload?.data || payload?.models || [];
  return rows
    .map((row) => (typeof row === "string" ? row : row?.id || row?.name || ""))
    .map((id) => String(id || "").trim())
    .filter(Boolean);
}

function withoutSecrets(value) {
  if (!value || typeof value !== "object") return value;
  const copy = { ...value };
  delete copy.headers;
  delete copy.apiKey;
  delete copy.api_key;
  delete copy.key;
  delete copy.token;
  delete copy.authorization;
  if (copy.body && typeof copy.body === "object") {
    const body = { ...copy.body };
    delete body.apiKey;
    delete body.api_key;
    delete body.key;
    delete body.token;
    copy.body = body;
  }
  if (SECRET.test(JSON.stringify(copy))) {
    return {
      url: String(copy.url || ""),
      wire: String(copy.wire || ""),
      body: { model: String(copy.body?.model || "") },
      redacted: true,
    };
  }
  return copy;
}

function createHandler(spec) {
  if (!spec || !spec.id) throw new Error("A provider handler needs an id");
  const kind = spec.kind === "local" ? "local" : "cloud";
  const auth = typeof spec.auth === "function" ? spec.auth() : spec.auth;
  const handler = {
    id: String(spec.id),
    kind,
    baseUrl() {
      const value = typeof spec.baseUrl === "function" ? spec.baseUrl() : spec.baseUrl;
      return String(value || "");
    },
    auth:
      auth && typeof auth === "object"
        ? { scheme: String(auth.scheme || (kind === "local" ? "none" : "bearer")) }
        : { scheme: kind === "local" ? "none" : "bearer" },
    discoverModels(payload) {
      const listed = spec.discoverModels ? spec.discoverModels(payload) : null;
      const rows = Array.isArray(listed) ? listed : defaultDiscover(payload);
      return rows.map((id) => String(id || "").trim()).filter(Boolean);
    },
    classifyAccess(model, now) {
      return spec.classifyAccess(model, now);
    },
    capabilities(model) {
      return spec.capabilities ? spec.capabilities(model) : {};
    },
    buildRequest(input) {
      const built = spec.buildRequest ? spec.buildRequest(input) : {};
      const safe = withoutSecrets(built);
      if (auth?.header) safe.auth = { scheme: "header", header: auth.header };
      else if (handler.auth.header)
        safe.auth = { scheme: handler.auth.scheme, header: handler.auth.header };
      else safe.auth = { scheme: handler.auth.scheme };
      return safe;
    },
    parseStream(chunk) {
      return spec.parseStream
        ? spec.parseStream(chunk)
        : { content: "", sawDone: false, sawTool: false };
    },
    mapError(error) {
      return spec.mapError(error);
    },
    quota(headers) {
      return spec.quota ? spec.quota(headers) : null;
    },
    health(snapshot) {
      return spec.health ? spec.health(snapshot) : { status: "unknown" };
    },
    gate() {
      if (typeof spec.gate === "function") return spec.gate();
      return {
        id: String(spec.id),
        kind,
        listUrl: "",
        chatUrl: "",
        verify: null,
        mayTrain: false,
        privacyUrl: "",
        healthProbe: "zero-spend",
      };
    },
    launcher:
      kind === "local" ? { id: String(spec.id), autoStart: false, ...(spec.launcher || {}) } : null,
  };
  if (auth?.header) handler.auth = { scheme: "header", header: String(auth.header) };
  return handler;
}

const registry = new Map();

function registerHandler(handler) {
  if (!handler || !handler.id) throw new Error("Cannot register an empty handler");
  registry.set(handler.id, handler);
  return handler;
}

function getHandler(id) {
  return registry.get(String(id || "")) || null;
}

function listHandlers() {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function handlerContractErrors(handler) {
  const errors = [];
  if (!handler || typeof handler !== "object") return ["missing"];
  if (!handler.id) errors.push("id");
  if (handler.kind !== "local" && handler.kind !== "cloud") errors.push("kind");
  if (typeof handler.baseUrl !== "function") errors.push("baseUrl");
  if (!handler.auth || !handler.auth.scheme) errors.push("auth");
  for (const name of METHODS) {
    if (typeof handler[name] !== "function") errors.push(name);
  }
  return errors;
}

module.exports = {
  METHODS,
  createHandler,
  registerHandler,
  getHandler,
  listHandlers,
  handlerContractErrors,
  defaultDiscover,
};
