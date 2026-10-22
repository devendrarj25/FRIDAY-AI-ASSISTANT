/**
 * ComfyUI as an optional local runner.
 *
 * ComfyUI is GPL-3.0 and stays a separate program the owner installs and
 * starts. FRIDAY never bundles it and only talks to it over its local HTTP API:
 *   GET  /system_stats           is it running, which device
 *   POST /prompt                 queue an API-format workflow (prompt, client_id, prompt_id)
 *   GET  /history/{prompt_id}    outputs once the run is done
 *   GET  /view?filename&subfolder&type   one output file
 * Source: the official script_examples/websockets_api_example.py in
 * github.com/comfyanonymous/ComfyUI (read 2026-10-22). History is polled
 * instead of the websocket so no extra dependency is needed.
 *
 * Only a loopback address is accepted: the workflow and its outputs stay on
 * this PC. A workflow is owner data; it is validated for shape, never run as code.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_ENDPOINT = "http://127.0.0.1:8188";

function endpoint(env = process.env) {
  const raw = String(env.FRIDAY_COMFYUI_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, base: "", reason: "the ComfyUI address is not a URL" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host) || url.protocol !== "http:") {
    return { ok: false, base: "", reason: "ComfyUI must run on this PC (http://127.0.0.1)" };
  }
  return { ok: true, base: `${url.protocol}//${url.host}`, reason: "" };
}

async function getJson(fetcher, url, timeoutMs = 5000) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Is ComfyUI answering? Never throws. */
async function status(options = {}) {
  const where = endpoint(options.env);
  if (!where.ok) return { online: false, endpoint: "", reason: where.reason };
  const fetcher = options.fetch || fetch;
  try {
    const stats = await getJson(fetcher, `${where.base}/system_stats`, options.timeoutMs || 3000);
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];
    return {
      online: true,
      endpoint: where.base,
      version: String(stats?.system?.comfyui_version || ""),
      device: String(devices[0]?.name || devices[0]?.type || ""),
      reason: "",
    };
  } catch (error) {
    return {
      online: false,
      endpoint: where.base,
      reason: `ComfyUI is not running at ${where.base} (${String(error?.message || error).slice(0, 80)})`,
    };
  }
}

/** Checkpoints ComfyUI can load, from GET /object_info/CheckpointLoaderSimple. */
async function checkpoints(options = {}) {
  const where = endpoint(options.env);
  if (!where.ok) return [];
  try {
    const info = await getJson(
      options.fetch || fetch,
      `${where.base}/object_info/CheckpointLoaderSimple`,
    );
    const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(names) ? names.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The standard text-to-image graph from ComfyUI's own API example: checkpoint,
 * two prompts, an empty latent, KSampler, VAE decode, save.
 */
function textToImageWorkflow(input = {}) {
  const clamp = (value, low, high, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;
  };
  const size = (value) => clamp(value, 256, 2048, 1024) - (clamp(value, 256, 2048, 1024) % 8);
  return {
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: String(input.checkpoint) } },
    5: {
      class_type: "EmptyLatentImage",
      inputs: { width: size(input.width), height: size(input.height), batch_size: 1 },
    },
    6: {
      class_type: "CLIPTextEncode",
      inputs: { text: String(input.prompt || ""), clip: ["4", 1] },
    },
    7: {
      class_type: "CLIPTextEncode",
      inputs: { text: String(input.negative || "blurry, low quality, watermark"), clip: ["4", 1] },
    },
    3: {
      class_type: "KSampler",
      inputs: {
        seed: clamp(input.seed, 0, 2 ** 31 - 1, Math.floor(Math.random() * 2 ** 31)),
        steps: clamp(input.steps, 1, 80, 25),
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    8: { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    9: { class_type: "SaveImage", inputs: { filename_prefix: "FRIDAY", images: ["8", 0] } },
  };
}

/** API-format workflow: { "<node id>": { class_type, inputs } }. */
function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return "the workflow must be a JSON object in ComfyUI API format (Save (API) in ComfyUI)";
  }
  const nodes = Object.entries(workflow);
  if (!nodes.length) return "the workflow has no nodes";
  for (const [id, node] of nodes) {
    if (!node || typeof node !== "object" || typeof node.class_type !== "string") {
      return `node ${id} has no class_type; export the workflow with Save (API)`;
    }
  }
  return "";
}

function safeName(name) {
  const base = path.basename(String(name || "output"));
  return base.replace(/[^\w.-]+/g, "_").slice(0, 120) || "output";
}

/**
 * Queue one workflow, wait for its outputs, save them into `outDir`.
 * Returns the saved file paths or the plain reason it failed.
 */
async function run(workflow, options = {}) {
  const invalid = validateWorkflow(workflow);
  if (invalid) return { ok: false, files: [], reason: invalid };
  const where = endpoint(options.env);
  if (!where.ok) return { ok: false, files: [], reason: where.reason };
  const fetcher = options.fetch || fetch;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const promptId = options.promptId || crypto.randomUUID();
  let queued;
  try {
    const response = await fetcher(`${where.base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: "friday", prompt_id: promptId }),
      signal: AbortSignal.timeout(15000),
    });
    queued = await response.json().catch(() => ({}));
    if (!response.ok || queued?.error) {
      const node = queued?.node_errors ? Object.keys(queued.node_errors)[0] : "";
      const message = queued?.error?.message || queued?.error || `HTTP ${response.status}`;
      return {
        ok: false,
        files: [],
        reason: `ComfyUI refused the workflow: ${String(message).slice(0, 160)}${node ? ` (node ${node})` : ""}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      files: [],
      reason: `ComfyUI is not reachable: ${String(error?.message || error).slice(0, 120)}`,
    };
  }
  const id = String(queued?.prompt_id || promptId);
  const deadline = Date.now() + (options.timeoutMs || 10 * 60 * 1000);
  let entry = null;
  while (Date.now() < deadline) {
    try {
      const history = await getJson(fetcher, `${where.base}/history/${encodeURIComponent(id)}`);
      entry = history?.[id] || null;
    } catch {
      entry = null;
    }
    if (entry?.status?.status_str === "error") {
      return {
        ok: false,
        files: [],
        promptId: id,
        reason: "ComfyUI reported an error while running the workflow",
      };
    }
    if (entry?.outputs && Object.keys(entry.outputs).length) break;
    await wait(options.pollMs ?? 1000);
  }
  if (!entry?.outputs) {
    return { ok: false, files: [], promptId: id, reason: "ComfyUI did not finish in time" };
  }
  const outDir = options.outDir;
  if (!outDir) return { ok: false, files: [], promptId: id, reason: "no output folder" };
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const output of Object.values(entry.outputs)) {
    const items = [
      ...(Array.isArray(output?.images) ? output.images : []),
      ...(Array.isArray(output?.gifs) ? output.gifs : []),
    ];
    for (const item of items) {
      const query = new URLSearchParams({
        filename: String(item.filename || ""),
        subfolder: String(item.subfolder || ""),
        type: String(item.type || "output"),
      });
      const response = await fetcher(`${where.base}/view?${query}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) continue;
      const target = path.join(outDir, `${id.slice(0, 8)}-${safeName(item.filename)}`);
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      files.push(target);
    }
  }
  return {
    ok: files.length > 0,
    files,
    promptId: id,
    reason: files.length ? "" : "the workflow finished without an image output",
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  endpoint,
  status,
  checkpoints,
  textToImageWorkflow,
  validateWorkflow,
  run,
};
