/**
 * Draw a picture with a connected cloud provider.
 *
 * Which models can draw is not guessed here: `electron/model-capabilities.cjs`
 * says a model makes images (its name, what the provider lists it as giving
 * out, or its Hugging Face pipeline tag). This module only picks among those,
 * asks the provider, checks that what came back is really a picture, and keeps
 * it in <FRIDAY folder>\assets\images.
 *
 * The caller passes every model through the billing and privacy gates first;
 * this file never decides whether a request may leave the PC.
 *
 * Provider shapes (all documented):
 *  · OpenAI-style POST /images/generations: OpenAI, Together AI, xAI, Google
 *    Gemini (OpenAI compatibility), DeepInfra. `b64_json` comes back inline.
 *  · Hugging Face Inference Providers, hf-inference route:
 *    POST https://router.huggingface.co/hf-inference/models/<model> with
 *    {"inputs": prompt} answers the image bytes.
 */
const fs = require("node:fs");
const path = require("node:path");

const OPENAI_STYLE = {
  openai: "https://api.openai.com/v1/images/generations",
  together: "https://api.together.xyz/v1/images/generations",
  xai: "https://api.x.ai/v1/images/generations",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/images/generations",
  deepinfra: "https://api.deepinfra.com/v1/openai/images/generations",
};
const HF_ROUTE = "https://router.huggingface.co/hf-inference/models/";

/** Providers FRIDAY can draw with. */
const PROVIDERS = Object.freeze([...Object.keys(OPENAI_STYLE), "huggingface"]);

const MAX_BYTES = 25 * 1024 * 1024;

/** The image type a buffer really is, from its first bytes, or null. */
function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { ext: "png", type: "image/png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { ext: "jpg", type: "image/jpeg" };
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return { ext: "webp", type: "image/webp" };
  if (buffer.subarray(0, 3).toString("latin1") === "GIF") return { ext: "gif", type: "image/gif" };
  return null;
}

/** The request for one provider. */
function requestFor(providerId, model, prompt, key, size) {
  if (providerId === "huggingface") {
    return {
      url: `${HF_ROUTE}${model}`,
      init: {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "image/png, image/jpeg, image/webp",
        },
        body: JSON.stringify({ inputs: prompt }),
      },
    };
  }
  const url = OPENAI_STYLE[providerId];
  if (!url) return null;
  const body = { model, prompt, n: 1 };
  // gpt-image-* always answers b64_json and rejects response_format; the others
  // are asked for it so the picture is not a link that expires.
  if (!/^gpt-image/i.test(model)) body.response_format = "b64_json";
  if (size && providerId !== "xai") body.size = size;
  return {
    url,
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

async function readBytes(res) {
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error("the picture is larger than 25 MB");
  return buffer;
}

/** Why a provider said no, in its own words. */
async function failureText(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* the status is all there is */
  }
  try {
    const body = JSON.parse(text);
    const message = body?.error?.message || body?.error || body?.message || "";
    if (message) return `HTTP ${res.status}: ${String(message).slice(0, 240)}`;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

/**
 * Ask one provider for one picture.
 * @returns {{ok:true,buffer:Buffer,type:string,ext:string}|{ok:false,error:string}}
 */
async function draw({ providerId, model, prompt, key, size, fetchImpl = fetch, signal }) {
  const text = String(prompt || "").trim();
  if (!text) return { ok: false, error: "there is nothing to draw — describe the picture" };
  if (!key) return { ok: false, error: `${providerId} has no key` };
  const request = requestFor(providerId, model, text, key, size);
  if (!request) return { ok: false, error: `${providerId} cannot draw pictures from FRIDAY yet` };
  let res;
  try {
    res = await fetchImpl(request.url, { ...request.init, signal });
  } catch (err) {
    return { ok: false, error: `could not reach ${providerId} — ${(err && err.message) || err}` };
  }
  if (!res.ok) return { ok: false, error: await failureText(res) };
  try {
    let buffer;
    const contentType = String(res.headers?.get?.("content-type") || "");
    if (providerId === "huggingface" || /^image\//i.test(contentType)) {
      buffer = await readBytes(res);
    } else {
      const body = await res.json();
      const first = body?.data?.[0] || {};
      if (first.b64_json) buffer = Buffer.from(String(first.b64_json), "base64");
      else if (first.url && /^https:\/\//i.test(first.url)) {
        const link = await fetchImpl(first.url, { signal });
        if (!link.ok) return { ok: false, error: `the picture link answered HTTP ${link.status}` };
        buffer = await readBytes(link);
      } else return { ok: false, error: "the provider answered without a picture" };
    }
    const kind = sniffImage(buffer);
    if (!kind) return { ok: false, error: "the provider answered something that is not a picture" };
    return { ok: true, buffer, type: kind.type, ext: kind.ext };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

const slugOf = (text) =>
  String(text || "picture")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "picture";

/** Keep a picture under <FRIDAY folder>\assets\images and return where. */
function save(outDir, prompt, picture, now = Date.now()) {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${now}-${slugOf(prompt)}.${picture.ext}`);
  fs.writeFileSync(file, picture.buffer);
  return file;
}

/**
 * The connected models that can draw, best first: free before paid, then by
 * provider order. `allowed(model)` is the caller's cost and health gate.
 */
function candidates(models, allowed = () => true) {
  const rank = { free: 0, unknown: 2, paid: 1 };
  return (Array.isArray(models) ? models : [])
    .filter(
      (model) =>
        model?.type === "cloud" &&
        PROVIDERS.includes(model.providerId) &&
        model.capabilities?.imageGeneration === true &&
        allowed(model),
    )
    .sort(
      (a, b) =>
        (rank[a.access] ?? 3) - (rank[b.access] ?? 3) ||
        PROVIDERS.indexOf(a.providerId) - PROVIDERS.indexOf(b.providerId),
    );
}

module.exports = {
  PROVIDERS,
  OPENAI_STYLE,
  HF_ROUTE,
  sniffImage,
  requestFor,
  draw,
  save,
  candidates,
  slugOf,
};
