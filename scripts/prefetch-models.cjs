#!/usr/bin/env node
/**
 * Build-time model prefetch: the weights FRIDAY needs to hear, turn-take and
 * chat land in the selected FRIDAY folder during setup, so a fresh install
 * listens and answers offline on first boot instead of downloading on first
 * use.
 *
 * Everything goes through the app's own downloader (electron/model-download.cjs):
 * official sources first, the same allowlist, resumable parts, and a SHA-256
 * check against the publisher's digest (pinned here, or read from the Hugging
 * Face listing). The running app later reuses, repairs and updates the same
 * folders from Models and Install Manager. A failed or offline download never
 * fails the build; it is reported and the app fetches it on first use.
 *
 * Opt out: FRIDAY_PREFETCH=0 skips all of it, FRIDAY_PREFETCH_CHAT=0 skips the
 * local chat model only. Hosted CI skips it unless FRIDAY_PREFETCH=1, so a
 * workflow run does not pull gigabytes on every build.
 */
const fs = require("node:fs");
const path = require("node:path");

const voiceWeights = require("../electron/voice-weights.cjs");

/** Speech sizes: base starts listening fast, small is the Hindi/Hinglish default. */
const STT_SIZES = ["base", "small"];

/** A small, fast, Apache-2.0 local chat model from the publisher's own GGUF repo. */
const CHAT_MODEL = {
  id: "qwen2.5-1.5b-instruct",
  sources: [
    {
      kind: "hf-gguf",
      repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
      match: ["q4_k_m", "q5_k_m", "q8_0"],
      label: "Hugging Face (Qwen official)",
    },
  ],
};

function enabled(env, key) {
  return String(env[key] ?? "1").trim() !== "0";
}

/** The ordered jobs for one FRIDAY root. Pure, so a test can read it. */
function prefetchPlan(root, env = process.env) {
  if (!root || !enabled(env, "FRIDAY_PREFETCH")) return [];
  const hosted = Boolean(env.CI || env.GITHUB_ACTIONS);
  if (hosted && String(env.FRIDAY_PREFETCH || "") !== "1") return [];
  const jobs = [];
  for (const size of STT_SIZES) {
    const plan = voiceWeights.sttPlan(size, root);
    jobs.push({
      id: plan.id,
      kind: "stt",
      ready: plan.dir,
      job: { modelId: plan.size, sources: plan.sources, dir: path.dirname(plan.dir) },
    });
  }
  for (const pinned of voiceWeights.pinnedJobs()) {
    const dir = path.join(root, ...pinned.dir);
    jobs.push({
      id: pinned.id,
      kind: "pinned",
      ready: path.join(dir, pinned.file),
      job: {
        modelId: path.basename(dir),
        dir: path.dirname(dir),
        sources: [
          {
            kind: "url",
            url: pinned.url,
            sha256: pinned.sha256,
            bytes: pinned.bytes,
            label: "official release",
          },
        ],
      },
    });
  }
  if (enabled(env, "FRIDAY_PREFETCH_CHAT")) {
    jobs.push({
      id: CHAT_MODEL.id,
      kind: "chat",
      ready: "",
      job: { modelId: CHAT_MODEL.id, sources: CHAT_MODEL.sources, dir: path.join(root, "models") },
    });
  }
  return jobs;
}

function alreadyThere(row) {
  if (!row.ready) return false;
  if (row.kind === "stt") return voiceWeights.weightsReady(row.ready, fs.existsSync);
  return fs.existsSync(row.ready);
}

/** Run every job; returns one row per job. Never throws. */
async function prefetch(root, { env = process.env, log = console.log, download } = {}) {
  const rows = [];
  const jobs = prefetchPlan(root, env);
  if (!jobs.length) {
    log("[friday] model prefetch skipped");
    return rows;
  }
  const fetchModel = download || require("../electron/model-download.cjs").downloadModel;
  for (const row of jobs) {
    if (alreadyThere(row)) {
      log(`[friday] ok       ${row.id} already on disk`);
      rows.push({ id: row.id, ok: true, downloaded: false });
      continue;
    }
    log(`[friday] fetching ${row.id}`);
    let result;
    try {
      result = await fetchModel(row.job, null, undefined);
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    if (result && result.ok) {
      log(`[friday] ok       ${row.id} (${result.source || result.via || "downloaded"})`);
      rows.push({ id: row.id, ok: true, downloaded: true });
    } else {
      const why = (result && result.error) || "download failed";
      log(`[friday] INFO     ${row.id} not prefetched (${why}); FRIDAY fetches it on first use`);
      rows.push({ id: row.id, ok: false, error: why });
    }
  }
  return rows;
}

module.exports = { STT_SIZES, CHAT_MODEL, prefetchPlan, prefetch };

if (require.main === module) {
  const fridayRoot = require("./friday-root.cjs");
  const picked = fridayRoot.workspaceRootOrDev();
  process.env.FRIDAY_ROOT = process.env.FRIDAY_ROOT || picked.root;
  prefetch(picked.root).then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
