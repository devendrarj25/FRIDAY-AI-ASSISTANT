#!/usr/bin/env node
// Offline adapter self-test. Live provider calls run only with --live and a key.
const fs = require("node:fs");
const path = require("node:path");
const federation = require(path.resolve(__dirname, "..", "electron", "provider-federation.cjs"));

const live = process.argv.includes("--live");
let failed = 0;

function check(name, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failed += 1;
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const spec = {
  url: "https://example.invalid/v1/models",
  list: (body) => (body.data || []).map((row) => row.id),
};
const first = federation.syncProvider({
  spec,
  response: { status: 200, body: { data: [{ id: "a" }, { id: "b" }] }, etag: "v1" },
  previous: null,
  now: 1,
});
check("list", first.ok && first.snapshot.ids.join() === "a,b");
const same = federation.syncProvider({
  spec,
  response: { status: 304 },
  previous: first.snapshot,
  now: 2,
});
check("not-modified", same.unchanged && same.snapshot.ids.join() === "a,b");
const drifted = federation.syncProvider({
  spec: {
    url: spec.url,
    list: () => {
      throw new Error("schema");
    },
  },
  response: { status: 200, body: {} },
  previous: first.snapshot,
  now: 3,
});
check("drift", drifted.drift === true && drifted.snapshot.ids.join() === "a,b");
const healed = federation.healSnapshot(first.snapshot, { dead: ["b"], recovered: [] });
const back = federation.healSnapshot(
  { ...healed, ids: ["a", "b"] },
  { dead: [], recovered: ["b"] },
);
check("heal", healed.disabled.includes("b") && !back.disabled.includes("b"));
check("remap", federation.remapDeprecated("old", { old: "new" }).to === "new");
check(
  "sse",
  federation.normalizeSse('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n').length === 1,
);
const secret = federation.connectionTestResult({
  status: 401,
  body: "bad sk-abcdefghijklmnopqrstuvwxyz",
  elapsedMs: 12,
});
check(
  "redact",
  secret.category === "auth" && !secret.detail.includes("abcdefghijklmnopqrstuvwxyz"),
);
check(
  "free-without-evidence",
  federation.freeEvidence({ billingMode: "FREE_QUOTA", evidence: {} }) === false,
);
check(
  "pipeline",
  federation.mapPipelineTag("text-generation").usable === true &&
    federation.mapPipelineTag("text-to-video").usable === false,
);
check("hardware", federation.hardwareFit({ sizeGb: 8, vramGb: 4, ramGb: 16 }).fit === "cpu");
check(
  "engine",
  federation.localEngineHealth({ name: "Ollama", installed: false }).status === "not-installed",
);
const report = federation.formatProviderReport({
  id: "groq",
  list: "OK",
  chat: "OK",
  stream: "OK",
  access: "FREE",
  why: "provider_free_plan",
  usable: 3,
  selector: ["Groq · openai/gpt-oss-20b"],
});
check(
  "report",
  report.includes("list OK") &&
    report.includes("chat OK") &&
    report.includes("stream OK") &&
    report.includes("class FREE") &&
    report.includes("why provider_free_plan") &&
    report.includes("usable 3") &&
    report.includes("Groq · openai/gpt-oss-20b") &&
    !report.includes("sk-"),
);

function classifyListed(providerId, providerName, ids) {
  const router = require(path.resolve(__dirname, "..", "electron", "model-router.cjs"));
  const pool = ids.slice(0, 40).map((target) => ({
    id: `${providerId}:${target}`,
    type: "cloud",
    providerId,
    providerModelId: target,
    contextK: 8,
    meta: {
      providerId,
      providerName,
      kind: "cloud",
      modelName: target,
      connected: true,
    },
  }));
  const view = router.usableModels(pool, { policy: "free-preferred", task: "chat" });
  const shown = view.rows.filter((row) => row.visibility === "show");
  const sample = shown[0] || view.rows[0];
  const record = sample && sample.model ? sample.model.accessRecord : null;
  return {
    access: shown[0] ? shown[0].badge : "none",
    why:
      (record && record.evidence && record.evidence.source) || (sample && sample.reason) || "none",
    usable: shown.length,
    selector: shown.slice(0, 8).map((row) => row.choiceLabel),
  };
}

async function runLive(cloud, env, fetchImpl, modelsApi) {
  const plan = federation.planLiveChecks(cloud, env);
  const lines = [];
  for (const row of plan) {
    if (row.action !== "probe") {
      lines.push({
        id: row.id,
        result: "SKIP",
        keyValid: false,
        modelsFound: 0,
        freeProof: "",
        statusClass: null,
        category: "missing_key",
        detail: federation.formatProviderReport({
          id: row.id,
          list: "SKIP",
          chat: "SKIP",
          stream: "SKIP",
          access: "unknown",
          why: "missing key",
          usable: 0,
          selector: [],
        }),
      });
      continue;
    }
    const spec = cloud[row.id];
    const key = env[row.keyName];
    const started = Date.now();
    try {
      const res = await fetchImpl(row.url, {
        headers: spec.headers(key),
        signal: AbortSignal.timeout(12000),
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const listed = federation.readListedIds(spec, body);
      const mark = res.ok && listed.ok ? "PASS" : "FAIL";
      let chat = "SKIP";
      let stream = "SKIP";
      let access = "unknown";
      let why = listed.ok ? "listed" : "list failed";
      let usable = 0;
      let selector = [];
      if (res.ok && listed.ok && listed.ids.length) {
        const classified = classifyListed(row.id, spec.name, listed.ids);
        access = classified.access;
        why = classified.why;
        usable = classified.usable;
        selector = classified.selector;
        const probed = await modelsApi.testProviderChat(row.id, {
          apiKey: key,
          policy: "free-preferred",
          fetchImpl,
        });
        chat = probed.ok ? "OK" : probed.category || "FAIL";
        stream = probed.stream ? "OK" : probed.ok ? "NO" : "SKIP";
        if (probed.detail) why = `${why}; ${probed.detail}`;
      }
      const detail = federation.formatProviderReport({
        id: row.id,
        list: mark === "PASS" ? "OK" : "FAIL",
        chat,
        stream,
        access,
        why,
        usable,
        selector,
      });
      lines.push({
        id: row.id,
        result: mark,
        keyValid: res.status !== 401 && res.status !== 403,
        modelsFound: listed.ok ? listed.ids.length : 0,
        freeProof: access,
        statusClass: `${Math.floor(res.status / 100)}xx`,
        category: res.ok ? "ok" : `http_${res.status}`,
        latencyMs: Date.now() - started,
        fixtureHint: listed.ok ? null : "response did not match the documented list shape",
        detail: federation.redactSecrets(detail),
      });
    } catch (err) {
      lines.push({
        id: row.id,
        result: "FAIL",
        category: "transport",
        latencyMs: Date.now() - started,
        detail: federation.redactSecrets(err && err.message ? err.message : String(err)),
      });
    }
  }
  return lines;
}

function writeLiveReport(rows, file) {
  const enriched = (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id || ""),
    result: String(row.result || ""),
    keyValid: row.keyValid === true ? true : row.keyValid === false ? false : null,
    modelsFound: Number.isFinite(row.modelsFound) ? row.modelsFound : null,
    freeProof: String(row.freeProof || ""),
    statusClass: row.statusClass == null ? null : String(row.statusClass),
    category: String(row.category || ""),
    latencyMs: Number.isFinite(row.latencyMs) ? row.latencyMs : null,
    fixtureHint: row.fixtureHint ? String(row.fixtureHint) : null,
    detail: federation.redactSecrets(String(row.detail || "")),
  }));
  const body = JSON.stringify({ providers: enriched }, null, 2);
  if (/sk-(?!redacted\b)[a-z0-9_-]{8,}/i.test(body)) {
    throw new Error("live report contained a key");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

async function main() {
  if (!live) {
    console.log("SKIP  live keyed checks (pass --live with provider keys; missing keys skip)");
    process.exit(failed ? 1 : 0);
  }
  const models = require(path.resolve(__dirname, "..", "electron", "models.cjs"));
  const rows = await runLive(models.CLOUD, process.env, globalThis.fetch, models);
  const report = writeLiveReport(
    rows,
    path.join(process.cwd(), "debug", "reports", "models-check-live.json"),
  );
  console.log(`REPORT  ${report}`);
  for (const row of rows) {
    if (row.result === "FAIL") failed += 1;
    console.log(`${row.result}  ${row.id} — ${row.detail}`);
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { writeLiveReport, runLive };
