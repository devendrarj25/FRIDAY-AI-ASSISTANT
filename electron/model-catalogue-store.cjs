/**
 * Canonical model catalogue. One schema, one disk file per provider.
 * A bad refresh never replaces the last good file.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const FRESH_MS = 24 * 60 * 60 * 1000;
const CHANGE_LOG_LIMIT = 40;

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function nullish(value) {
  return value === undefined ? null : value;
}

const SECRET_KEYS = new Set([
  "api_key",
  "apiKey",
  "authorization",
  "token",
  "secret",
  "password",
  "headers",
]);

function publicCopy(value) {
  if (!value || typeof value !== "object") return value;
  const json = JSON.stringify(value, (key, item) => {
    if (key && SECRET_KEYS.has(key)) return undefined;
    if (typeof item === "string" && /\bsk-[a-z0-9]{8,}\b/i.test(item)) return "redacted";
    return item;
  });
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function redactRaw(value) {
  if (!value || typeof value !== "object") return null;
  const copy = publicCopy(value);
  const text = JSON.stringify(copy);
  if (!text) return null;
  if (text.length > 2000) return { truncated: true };
  return copy;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalFromRoutable(model) {
  const meta = model?.meta || {};
  const providerId = String(
    model?.providerId || meta.providerId || model?.provider || "",
  ).toLowerCase();
  const nativeId =
    String(meta.modelName || model?.providerModelId || "").trim() || String(model?.id || "");
  const pricing = model?.pricing || meta.pricing || null;
  const accessName = model?.access || meta.access || null;
  const accessClass =
    accessName === "free" || accessName === "paid" || accessName === "unknown"
      ? accessName
      : "unknown";
  const kind = meta.kind === "local" || model?.type === "local" ? "local" : "cloud";
  return {
    providerId,
    nativeId,
    displayName: String(model?.label || model?.name || nativeId || ""),
    family: nullish(meta.family),
    owner: nullish(meta.ownedBy || meta.owner),
    lifecycle: {
      state: meta.deprecated === true ? "deprecated" : "active",
      deprecatedAt: null,
      retiredAt: null,
      replacement: nullish(meta.replacement),
    },
    endpointKinds: Array.isArray(meta.endpointKinds) ? meta.endpointKinds : ["chat"],
    protocol: nullish(meta.protocol),
    capabilities:
      meta.capabilities && typeof meta.capabilities === "object"
        ? publicCopy(meta.capabilities)
        : {},
    modalities: {
      in: Array.isArray(meta.modalitiesIn) ? meta.modalitiesIn : null,
      out: Array.isArray(meta.modalitiesOut) ? meta.modalitiesOut : null,
    },
    limits: {
      context: numberOrNull(meta.context ?? model?.contextK),
      maxOutput: numberOrNull(meta.maxOutput),
      media: null,
    },
    pricing: {
      inputPerMTok: pricing ? (pricing.inputPerMTok ?? pricing.input ?? null) : null,
      outputPerMTok: pricing ? (pricing.outputPerMTok ?? pricing.output ?? null) : null,
      currency: pricing?.currency || null,
      source: pricing?.source || null,
      checkedAt: pricing?.checkedAt || null,
    },
    access: {
      class: accessClass,
      evidence: meta.accessEvidence || meta.verification || null,
      accountSpecific: null,
      conditions: null,
      quota: null,
    },
    policy: {
      mayTrain: meta.mayTrain === true ? true : meta.mayTrain === false ? false : null,
      retention: null,
      source: null,
    },
    availability: { health: model?.status || null },
    provenance: {
      sourceUrl: meta.sourceUrl || null,
      method: meta.method || null,
      fetchedAt: meta.fetchedAt || null,
      verifiedAt: null,
      confidence: meta.confidence || "unknown",
    },
    location: {
      kind,
      runner: kind === "local" ? providerId : null,
      installed: meta.installed === true ? true : null,
      loaded:
        meta.loaded === true || meta.resident === true
          ? true
          : meta.loaded === false
            ? false
            : null,
      fileSize: numberOrNull(meta.sizeGb),
      quantisation: meta.quantisation || null,
      licence: meta.licence || null,
      gated: meta.gated === true ? true : null,
    },
    raw: redactRaw(model?.catalogue || meta.catalogue || null),
  };
}

function bodyOf(doc) {
  return {
    schemaVersion: SCHEMA_VERSION,
    providerId: doc.providerId,
    fetchedAt: doc.fetchedAt,
    records: doc.records,
    routable: doc.routable,
    changes: doc.changes || [],
  };
}

function withChecksum(doc) {
  const body = bodyOf(doc);
  return { ...body, checksum: sha256(JSON.stringify(body)) };
}

function envelope(providerId, records, fetchedAt, routable, changes) {
  return {
    schemaVersion: SCHEMA_VERSION,
    providerId: String(providerId || ""),
    fetchedAt: Number(fetchedAt) || 0,
    records: Array.isArray(records) ? records : [],
    routable: Array.isArray(routable) ? routable.map((row) => publicCopy(row)) : [],
    changes: Array.isArray(changes) ? changes.slice(-CHANGE_LOG_LIMIT) : [],
  };
}

function readEnvelope(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: false, error: "missing" };
    return { ok: false, error: "malformed" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: "schema" };
  if (!Array.isArray(parsed.records)) return { ok: false, error: "records" };
  const expected = sha256(JSON.stringify(bodyOf(parsed)));
  if (expected !== parsed.checksum) return { ok: false, error: "checksum" };
  return { ok: true, doc: parsed };
}

function commitRecords(previous, next) {
  const prior = previous && Array.isArray(previous.records) ? previous : null;
  if (!next || !Array.isArray(next.records) || next.records.length === 0) {
    return { ok: false, doc: prior, keptPrevious: true, reason: "empty" };
  }
  for (const row of next.records) {
    if (!row || !row.providerId || !row.nativeId) {
      return { ok: false, doc: prior, keptPrevious: true, reason: "identity" };
    }
  }
  return { ok: true, doc: withChecksum(next), keptPrevious: false, reason: "accepted" };
}

function freshness(fetchedAt, now, opts = {}) {
  const stamp = Number(fetchedAt);
  if (!Number.isFinite(stamp) || stamp <= 0) return "expired";
  if (opts.offline === true || opts.privacy === true) return "stale";
  const age = Number(now) - stamp;
  if (Number.isFinite(age) && age >= 0 && age < FRESH_MS) return "fresh";
  return "expired";
}

function planCatalogueRefresh(input = {}) {
  const trigger = String(input.trigger || "startup");
  const privacy = input.privacy === true;
  const age = Number(input.ageMs);
  const stale = !Number.isFinite(age) || age >= FRESH_MS;
  const jitter = Math.abs(Number(input.jitterMs) || 0) % 60_000;
  const base = { sendsPrompt: false, spend: "zero" };
  if (privacy) {
    return {
      ...base,
      refresh: false,
      targeted: false,
      delayMs: 0,
      mark: "stale",
      reason: "privacy mode uses the persisted catalogue",
    };
  }
  if (trigger === "manual" || trigger === "foreground") {
    return {
      ...base,
      refresh: true,
      targeted: false,
      delayMs: 0,
      mark: "fresh",
      reason: "the owner asked for a refresh",
    };
  }
  if (trigger === "model-404" || trigger === "after-failure") {
    return {
      ...base,
      refresh: true,
      targeted: true,
      delayMs: 0,
      mark: "stale",
      reason: "a model 404 asked for this provider",
    };
  }
  if (!stale) {
    return {
      ...base,
      refresh: false,
      targeted: false,
      delayMs: 0,
      mark: "fresh",
      reason: "the persisted catalogue is inside 24 hours",
    };
  }
  return {
    ...base,
    refresh: true,
    targeted: false,
    delayMs: jitter,
    mark: "expired",
    reason: "the persisted catalogue is missing or older than 24 hours",
  };
}

function recordKey(row) {
  return `${row.providerId}/${row.nativeId}`;
}

function diffCatalogues(previous, next) {
  const before = new Map((previous || []).map((row) => [recordKey(row), row]));
  const after = new Map((next || []).map((row) => [recordKey(row), row]));
  const added = [];
  const removed = [];
  const renamed = [];
  const deprecated = [];
  const price = [];
  const limit = [];
  const access = [];
  for (const [key, row] of after) {
    const prev = before.get(key);
    if (!prev) {
      added.push(key);
      continue;
    }
    if ((prev.displayName || "") !== (row.displayName || "")) renamed.push(key);
    const state = row.lifecycle?.state;
    if (prev.lifecycle?.state !== state && (state === "deprecated" || state === "retired")) {
      deprecated.push(key);
    }
    if (
      prev.pricing?.inputPerMTok !== row.pricing?.inputPerMTok ||
      prev.pricing?.outputPerMTok !== row.pricing?.outputPerMTok
    ) {
      price.push(key);
    }
    if (prev.limits?.context !== row.limits?.context) limit.push(key);
    if (prev.access?.class !== row.access?.class) access.push(key);
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return { added, removed, renamed, deprecated, price, limit, access };
}

function changeLines(diff) {
  const lines = [];
  const push = (label, ids) => {
    for (const id of ids || []) lines.push(`${label} ${id}`);
  };
  push("added", diff?.added);
  push("removed", diff?.removed);
  push("renamed", diff?.renamed);
  push("deprecated", diff?.deprecated);
  push("price", diff?.price);
  push("limit", diff?.limit);
  push("access", diff?.access);
  return lines.slice(0, CHANGE_LOG_LIMIT);
}

function remapRemoved(removed, replacementMap) {
  const map = replacementMap || {};
  return (removed || []).map((id) => {
    const native = String(id).split("/").slice(1).join("/");
    const next = Object.prototype.hasOwnProperty.call(map, native) ? map[native] : null;
    return { from: id, to: next || null };
  });
}

function retryDelay(headers, attempt, jitterMs) {
  const source = headers || {};
  const raw = source["retry-after"] ?? source["Retry-After"];
  if (raw != null && String(raw).trim() !== "" && /^\d+(\.\d+)?$/.test(String(raw).trim())) {
    return Math.min(30_000, Math.round(Number(raw) * 1000));
  }
  const exp = Math.min(30_000, 500 * 2 ** Math.max(0, Number(attempt) || 0));
  const jitter = Math.abs(Number(jitterMs) || 0) % 1000;
  return Math.min(30_000, exp + jitter);
}

function conditionalHeaders(previous) {
  const headers = {};
  if (previous?.etag) headers["If-None-Match"] = String(previous.etag);
  if (previous?.lastModified) headers["If-Modified-Since"] = String(previous.lastModified);
  return headers;
}

function staggerPlan(ids, jitterMs) {
  const jitter = Math.abs(Number(jitterMs) || 0) % 60_000;
  return (ids || []).map((id, index) => ({
    id: String(id),
    delayMs: (jitter + index * 750) % 60_000,
  }));
}

function fileFor(dir, providerId) {
  const safe = String(providerId || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  if (!safe) throw new Error("provider id");
  return path.join(dir, `${safe}.json`);
}

function atomicWrite(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
  return file;
}

function groupByProvider(models) {
  const out = {};
  for (const model of models || []) {
    const id = String(
      model?.providerId || model?.meta?.providerId || model?.provider || "",
    ).toLowerCase();
    if (!id) continue;
    if (!out[id]) out[id] = [];
    out[id].push(model);
  }
  return out;
}

function inspectDir(dir, now) {
  const clock = Number(now) || Date.now();
  const notes = [];
  const providers = [];
  const changes = [];
  const docs = [];
  let oldest = null;
  if (!dir || !fs.existsSync(dir)) {
    return {
      notes,
      providers,
      changes,
      docs,
      freshness: "expired",
      summary: "no persisted catalogue yet",
      count: 0,
      oldestFetchedAt: null,
    };
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const read = readEnvelope(path.join(dir, name));
    if (!read.ok) {
      if (read.error !== "missing") notes.push(`${name} ignored (${read.error})`);
      continue;
    }
    docs.push(read.doc);
    providers.push(read.doc.providerId);
    if (Array.isArray(read.doc.changes)) changes.push(...read.doc.changes);
    const stamp = Number(read.doc.fetchedAt);
    if (Number.isFinite(stamp) && (oldest == null || stamp < oldest)) oldest = stamp;
  }
  const mark = providers.length ? freshness(oldest, clock, {}) : "expired";
  return {
    notes,
    providers,
    changes: changes.slice(-CHANGE_LOG_LIMIT),
    docs,
    freshness: mark,
    summary: providers.length
      ? `${providers.length} providers on disk, ${mark}`
      : "no persisted catalogue yet",
    count: providers.length,
    oldestFetchedAt: oldest,
  };
}

function status(dir, now, opts = {}) {
  const inspected = inspectDir(dir, now);
  const mark =
    opts.privacy === true || opts.offline === true
      ? inspected.count
        ? "stale"
        : "expired"
      : inspected.freshness;
  return {
    summary:
      opts.privacy === true
        ? `privacy mode, ${inspected.count} providers on disk, stale`
        : inspected.summary,
    freshness: mark,
    changes: inspected.changes,
    providers: inspected.providers,
    notes: inspected.notes,
    privacy: opts.privacy === true,
  };
}

function doctorCheck(dir, now) {
  const inspected = inspectDir(dir, now);
  return {
    id: "model-catalogue",
    label: "Model catalogue",
    group: "Models",
    status: inspected.notes.length ? "Warning" : "Ready",
    detail: inspected.notes.length ? inspected.notes.join("; ") : inspected.summary,
    fixable: false,
  };
}

module.exports = {
  SCHEMA_VERSION,
  FRESH_MS,
  CHANGE_LOG_LIMIT,
  canonicalFromRoutable,
  envelope,
  readEnvelope,
  commitRecords,
  freshness,
  planCatalogueRefresh,
  diffCatalogues,
  changeLines,
  remapRemoved,
  retryDelay,
  conditionalHeaders,
  staggerPlan,
  fileFor,
  atomicWrite,
  groupByProvider,
  inspectDir,
  status,
  doctorCheck,
  publicCopy,
};
