/**
 * FRIDAY · one manifest-driven adapter helper.
 *
 * Discovery and chat stay in `electron/models.cjs` and `kernel/router.py`.
 * This module normalises list diffs, health, streaming, and task metadata
 * for those callers. It does not open a second provider table.
 */

const HF_PIPELINES = Object.freeze({
  "text-generation": { capability: "chat", runtime: "chat", usable: true },
  "text2text-generation": { capability: "chat", runtime: "chat", usable: true },
  "feature-extraction": { capability: "embeddings", runtime: "embeddings", usable: true },
  "sentence-similarity": { capability: "embeddings", runtime: "embeddings", usable: true },
  "text-ranking": { capability: "rerank", runtime: "rerank", usable: true },
  "automatic-speech-recognition": { capability: "audio-in", runtime: "whisper", usable: true },
  "text-to-speech": { capability: "audio-out", runtime: "tts", usable: true },
  "text-to-image": { capability: "image-generation", runtime: "image", usable: true },
  "image-to-image": { capability: "image-generation", runtime: "image", usable: true },
  "image-to-text": { capability: "vision", runtime: "vision", usable: true },
  "image-text-to-text": { capability: "vision", runtime: "vision", usable: true },
  "visual-question-answering": { capability: "vision", runtime: "vision", usable: true },
  "text-classification": { capability: "classification", runtime: "transformers", usable: true },
  "token-classification": { capability: "classification", runtime: "transformers", usable: true },
  "zero-shot-classification": {
    capability: "classification",
    runtime: "transformers",
    usable: true,
  },
  translation: { capability: "translation", runtime: "transformers", usable: true },
  summarization: { capability: "summarization", runtime: "transformers", usable: true },
  "question-answering": { capability: "chat", runtime: "transformers", usable: true },
  "text-to-video": { capability: "video", runtime: null, usable: false },
  "video-classification": { capability: "video", runtime: null, usable: false },
});

const FREE_MODES = new Set(["ZERO_COST", "FREE_QUOTA", "FREE_CREDIT"]);

function manifestFromSpec(id, spec) {
  if (!spec || typeof spec !== "object") return null;
  return {
    id: String(id || ""),
    name: spec.name || id,
    class: "cloud",
    sources: {
      list: spec.url || null,
      chat: spec.chat || null,
    },
    auth: { kind: spec.wire === "anthropic" ? "x-api-key" : "bearer" },
    discovery: { usesProviderList: typeof spec.list === "function" },
    transports: ["https", "sse"],
  };
}

function customOpenAiManifest({ id, baseUrl, name } = {}) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "missing-base" };
  return {
    ok: true,
    manifest: {
      id: String(id || "custom-openai"),
      name: name || "Custom OpenAI-compatible",
      class: "cloud",
      sources: { list: `${base}/models`, chat: base },
      auth: { kind: "bearer" },
      discovery: { usesProviderList: true, listShape: "openai" },
      transports: ["https", "sse"],
    },
  };
}

function readListedIds(spec, body) {
  if (!spec || typeof spec.list !== "function")
    return { ok: false, drift: true, reason: "no-list" };
  try {
    const ids = spec.list(body);
    if (!Array.isArray(ids)) return { ok: false, drift: true, reason: "schema" };
    return { ok: true, ids: ids.map((id) => String(id || "")).filter(Boolean) };
  } catch (err) {
    return {
      ok: false,
      drift: true,
      reason: "schema",
      error: String(err && err.message ? err.message : err),
    };
  }
}

function diffIds(previous, next) {
  const before = new Set(previous || []);
  const after = new Set(next || []);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  };
}

function syncProvider({ spec, response, previous, now }) {
  const prior = previous || { ids: [], disabled: [], fetchedAt: null, source: spec?.url || null };
  if (!response) return { ok: false, drift: true, reason: "fetch", snapshot: prior };
  if (response.status === 304) {
    return {
      ok: true,
      unchanged: true,
      drift: false,
      snapshot: prior,
      diff: { added: [], removed: [] },
    };
  }
  const listed = readListedIds(spec, response.body);
  if (!listed.ok) {
    return {
      ok: false,
      drift: true,
      reason: listed.reason,
      snapshot: prior,
      alert: "adapter self-test failed",
    };
  }
  const diff = diffIds(prior.ids, listed.ids);
  const snapshot = {
    ids: listed.ids,
    disabled: (prior.disabled || []).filter((id) => listed.ids.includes(id)),
    etag: response.etag || null,
    fetchedAt: now,
    source: spec.url || prior.source || null,
  };
  return { ok: true, unchanged: false, drift: false, snapshot, diff };
}

function healSnapshot(snapshot, health = {}) {
  const ids = new Set(snapshot?.ids || []);
  const disabled = new Set(snapshot?.disabled || []);
  for (const id of health.dead || []) disabled.add(id);
  for (const id of health.recovered || []) disabled.delete(id);
  return {
    ...(snapshot || {}),
    disabled: [...disabled].filter((id) => ids.has(id) || (health.dead || []).includes(id)),
  };
}

function remapDeprecated(id, table = {}) {
  const next = table[id];
  if (!next) return { from: id, to: id, remapped: false };
  return { from: id, to: next, remapped: true };
}

function normalizeSse(chunk) {
  const events = [];
  const text = String(chunk || "");
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;
    if (data === "[DONE]") {
      events.push({ type: "done", text: "" });
      continue;
    }
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta || {};
      const tool = delta.tool_calls || json.tool_calls || null;
      const content = typeof delta.content === "string" ? delta.content : json.delta?.text || "";
      events.push({ type: tool ? "tool" : "delta", text: content || "", tool });
    } catch {
      events.push({ type: "delta", text: data, tool: null });
    }
  }
  return events;
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-redacted")
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer redacted")
    .replace(/hf_[A-Za-z0-9]{8,}/g, "hf_redacted");
}

function connectionTestResult({ status, body, elapsedMs, error } = {}) {
  const detail = redactSecrets(typeof body === "string" ? body : JSON.stringify(body || {})).slice(
    0,
    240,
  );
  let category = "ok";
  let fix = null;
  if (error) {
    category = "network";
    fix = "Check the endpoint, proxy, and TLS, then try again.";
  } else if (status === 401 || status === 403) {
    category = "auth";
    fix = "Replace the key in Connections. Keys stay in safeStorage.";
  } else if (status === 429) {
    category = "rate_limit";
    fix = "Wait for the quota window, then try again.";
  } else if (status >= 500) {
    category = "provider";
    fix = "The provider failed. Retry later or pick another provider.";
  } else if (status >= 400) {
    category = "invalid_request";
    fix = "The probe was rejected. Check the model id and endpoint.";
  }
  return {
    ok: !error && status >= 200 && status < 300,
    status: Number(status || 0),
    elapsedMs: Number(elapsedMs || 0),
    category,
    fix,
    detail,
  };
}

function freeEvidence(record) {
  if (!record || !FREE_MODES.has(record.billingMode)) return false;
  const evidence = record.evidence;
  if (!evidence || !evidence.source) return false;
  return Number(evidence.checkedAt) > 0;
}

function applyProbeOverride(record, probe) {
  const base =
    record && typeof record === "object" ? record : { billingMode: "UNKNOWN", evidence: {} };
  if (!probe || typeof probe !== "object") return base;
  if (probe.paid === true || Number(probe.status) === 402) {
    return {
      ...base,
      billingMode: "PAID",
      evidence: {
        ...(base.evidence || {}),
        source: "live_probe",
        checkedAt: Number(probe.checkedAt) || 0,
        confidence: 0.9,
      },
    };
  }
  if (probe.free === true && probe.evidence === "quota-header" && Number(probe.checkedAt) > 0) {
    return {
      ...base,
      billingMode: "FREE_QUOTA",
      eligibility: "ELIGIBLE",
      evidence: { source: "live_probe", checkedAt: Number(probe.checkedAt), confidence: 0.85 },
    };
  }
  return base;
}

function mapPipelineTag(tag) {
  if (!tag) return { capability: "unknown", runtime: null, usable: false };
  return HF_PIPELINES[tag] || { capability: "unknown", runtime: null, usable: false, tag };
}

function hardwareFit({ sizeGb, vramGb, ramGb } = {}) {
  const size = Number(sizeGb);
  if (!Number.isFinite(size)) return { fit: "unknown" };
  const vram = Number(vramGb);
  const ram = Number(ramGb);
  if (Number.isFinite(vram) && vram >= size) return { fit: "gpu" };
  if (Number.isFinite(ram) && ram >= size * 1.2) return { fit: "cpu" };
  if (!Number.isFinite(vram) && !Number.isFinite(ram)) return { fit: "unknown" };
  return { fit: "too-large" };
}

function localEngineHealth(engine) {
  if (!engine) return { status: "unknown", detail: "unknown" };
  const name = engine.name || "engine";
  if (!engine.installed) return { status: "not-installed", detail: `${name} is not installed` };
  if (engine.running) return { status: "running", version: engine.version || null, detail: name };
  return { status: "installed", version: engine.version || null, detail: name };
}

function createExactCache() {
  const map = new Map();
  return {
    key(text) {
      return String(text || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    },
    get(text) {
      const key = this.key(text);
      return map.has(key) ? map.get(key) : null;
    },
    set(text, value) {
      map.set(this.key(text), value);
    },
  };
}

function snapshotAgeDays(fetchedAt, now) {
  if (!fetchedAt || !now) return null;
  const days = Math.floor((Number(now) - Number(fetchedAt)) / (24 * 60 * 60 * 1000));
  return days < 0 ? null : days;
}

/** Which providers a keyed check may call. The key itself is never copied out. */
function planLiveChecks(cloud, env = {}) {
  const table = cloud && typeof cloud === "object" ? cloud : {};
  const source = env && typeof env === "object" ? env : {};
  const rows = [];
  for (const [id, spec] of Object.entries(table)) {
    const keyName = spec && spec.env ? String(spec.env) : "";
    const present = Boolean(keyName && String(source[keyName] || "").trim());
    rows.push({
      id,
      action: present ? "probe" : "skip",
      reason: present ? null : "missing-key",
      url: spec && spec.url ? String(spec.url) : null,
      keyName: keyName || null,
    });
  }
  return rows;
}

function formatProviderReport(row = {}) {
  const selector =
    Array.isArray(row.selector) && row.selector.length ? row.selector.join(", ") : "none";
  return [
    String(row.id || "provider"),
    `list ${row.list || "SKIP"}`,
    `chat ${row.chat || "SKIP"}`,
    `stream ${row.stream || "SKIP"}`,
    `class ${row.access || "unknown"}`,
    `why ${row.why || "unknown"}`,
    `usable ${Number(row.usable || 0)}`,
    `selector ${selector}`,
  ].join(" · ");
}

function summariseProbe({ id, status, elapsedMs, listedCount, error, drift } = {}) {
  return {
    id: id || null,
    status: Number(status || 0),
    elapsedMs: Number(elapsedMs || 0),
    listed: drift ? null : Number(listedCount || 0),
    drift: Boolean(drift),
    error: error ? redactSecrets(String(error)).slice(0, 180) : null,
  };
}

module.exports = {
  HF_PIPELINES,
  manifestFromSpec,
  customOpenAiManifest,
  readListedIds,
  diffIds,
  syncProvider,
  healSnapshot,
  remapDeprecated,
  normalizeSse,
  redactSecrets,
  connectionTestResult,
  freeEvidence,
  applyProbeOverride,
  mapPipelineTag,
  hardwareFit,
  localEngineHealth,
  createExactCache,
  snapshotAgeDays,
  planLiveChecks,
  summariseProbe,
  formatProviderReport,
};
