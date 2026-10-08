/**
 * FRIDAY · real multi-source model downloader
 *
 * A model install never depends on a single host. Each catalog entry carries an
 * ordered list of real sources (Ollama registry tag, Hugging Face GGUF repo,
 * full repo snapshot, direct URL); this module walks that list and keeps the
 * first source that genuinely delivers verified bytes to disk.
 *
 * What is real here, and nothing else is claimed:
 *   · HTTP downloads are streamed to `<file>.part`, resumed with Range on retry
 *     and only renamed into place after the byte count matches Content-Length.
 *   · Large files use several parallel range connections, which is where the
 *     download speed actually comes from.
 *   · Ollama pulls delegate to the daemon's own streamed progress.
 *   · A GGUF fetched from Hugging Face is written into `<FRIDAY_ROOT>/models`
 *     so llama.cpp can serve it. Registering that file with Ollama is
 *     best-effort afterwards — the download itself does not require Ollama.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
// The one canonical FRIDAY root contract — downloads never stage outside it.
const contract = require("./friday-contract.cjs");
const voiceInstall = require("./voice-install.cjs");

const HF_HOSTS = voiceInstall.hfHostList(process.env);
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const SEGMENT_THRESHOLD = 192 * 1024 * 1024; // below this, one connection is faster
const MAX_SEGMENTS = 4;
const RETRIES = 3;

const gb = (bytes) => Number(((bytes || 0) / 1024 ** 3).toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Refuse a download that cannot fit. An unreadable volume is not treated as full. */
function assertDiskRoom(dir, needBytes) {
  const need = Number(needBytes || 0);
  if (!need || need <= 0) return { ok: true, free: null, measured: false };
  let free = null;
  try {
    const stat = fs.statfsSync(dir);
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return { ok: true, free: null, measured: false };
  }
  if (free < need) {
    const error = new Error(`disk full: ${free} bytes free, ${need} bytes required`);
    error.code = "ENOSPC";
    throw error;
  }
  return { ok: true, free, measured: true };
}

function assertSha256(file, expected) {
  if (!expected) return;
  const got = hashFile(file);
  if (got !== String(expected).toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error(`checksum mismatch for ${path.basename(file)}`);
  }
}

// --------------------------------------------------------------- HF listing
/** Real file listing for a Hugging Face repo (no guessing at filenames). */
async function hfFiles(repo, signal) {
  let lastError = "unreachable";
  for (const host of HF_HOSTS) {
    try {
      const res = await fetch(`${host}/api/models/${repo}`, { signal });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const files = (json.siblings || []).map((s) => s.rfilename).filter(Boolean);
      if (files.length) return { ok: true, host, files };
      lastError = "repo lists no files";
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  return { ok: false, error: `${repo}: ${lastError}` };
}

/** Pick the best GGUF in a repo for the requested quant preferences. */
function pickGguf(files, match = []) {
  const ggufs = files.filter((f) => f.toLowerCase().endsWith(".gguf"));
  if (!ggufs.length) return null;
  // Multi-part shards need every piece; prefer a single-file build.
  const single = ggufs.filter((f) => !/-0000\d-of-0000\d/i.test(f));
  const pool = single.length ? single : ggufs;
  for (const want of match) {
    const hit = pool.find((f) => f.toLowerCase().includes(String(want).toLowerCase()));
    if (hit) return hit;
  }
  return pool[0];
}

// ------------------------------------------------------------- HTTP fetching
async function headInfo(url, signal) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return {
      ok: true,
      size: Number(res.headers.get("content-length") || 0),
      ranges: (res.headers.get("accept-ranges") || "").includes("bytes"),
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function progressReporter(total, onEvent, label) {
  const started = Date.now();
  let done = 0;
  let last = 0;
  return {
    add(bytes) {
      done += bytes;
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      const elapsed = Math.max(0.001, (now - started) / 1000);
      const rate = done / elapsed;
      onEvent?.({
        status: label,
        gbTotal: gb(total),
        gbDone: gb(done),
        progress: total > 0 ? Math.min(100, (done / total) * 100) : null,
        speedMbps: Number((rate / 1024 ** 2).toFixed(1)),
        etaSeconds: total > done && rate > 0 ? Math.round((total - done) / rate) : 0,
      });
    },
    get bytes() {
      return done;
    },
  };
}

async function pipeInto(handle, res, position, report, signal) {
  const reader = res.body.getReader();
  let pos = position;
  for (;;) {
    if (signal?.aborted) throw new Error("cancelled");
    const { value, done } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    await handle.write(buf, 0, buf.length, pos);
    pos += buf.length;
    report.add(buf.length);
  }
  return pos - position;
}

/**
 * Download one URL to `dest`. Uses parallel range segments for big files and a
 * resumable single stream otherwise. Returns the number of bytes written.
 */
async function downloadUrl(
  url,
  dest,
  { onEvent, signal, label = "downloading", sha256, needBytes } = {},
) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  assertDiskRoom(path.dirname(dest), needBytes);
  const part = `${dest}.part`;
  const head = await headInfo(url, signal);
  const total = head.ok ? head.size : 0;
  const segments = head.ok && head.ranges && total > SEGMENT_THRESHOLD ? MAX_SEGMENTS : 1;
  const report = progressReporter(total, onEvent, label);

  const handle = await fsp.open(part, "w+");
  try {
    if (segments > 1) {
      const chunk = Math.ceil(total / segments);
      await Promise.all(
        Array.from({ length: segments }, async (_, i) => {
          const start = i * chunk;
          const end = Math.min(total - 1, start + chunk - 1);
          if (start > end) return;
          for (let attempt = 0; attempt < RETRIES; attempt += 1) {
            try {
              const res = await fetch(url, {
                headers: { Range: `bytes=${start}-${end}` },
                redirect: "follow",
                signal,
              });
              if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
              await pipeInto(handle, res, start, report, signal);
              return;
            } catch (err) {
              if (signal?.aborted) throw err;
              if (attempt === RETRIES - 1) throw err;
              await sleep(600 * (attempt + 1));
            }
          }
        }),
      );
    } else {
      let written = 0;
      for (let attempt = 0; attempt < RETRIES; attempt += 1) {
        try {
          const res = await fetch(url, {
            headers: written > 0 ? { Range: `bytes=${written}-` } : {},
            redirect: "follow",
            signal,
          });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          written += await pipeInto(handle, res, written, report, signal);
          break;
        } catch (err) {
          if (signal?.aborted) throw err;
          const message = String(err?.message || err);
          const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(
            message,
          );
          if (attempt === RETRIES - 1) {
            throw new Error(
              offline && !message.startsWith("offline:") ? `offline: ${message}` : message,
            );
          }
          await sleep(800 * (attempt + 1));
        }
      }
    }
  } finally {
    await handle.close();
  }

  const stat = await fsp.stat(part);
  if (total > 0 && stat.size !== total) {
    await fsp.rm(part, { force: true });
    throw new Error(`incomplete download (${stat.size}/${total} bytes)`);
  }
  await fsp.rename(part, dest);
  assertSha256(dest, sha256);
  onEvent?.({
    status: "downloaded",
    gbTotal: gb(stat.size),
    gbDone: gb(stat.size),
    progress: 100,
    speedMbps: 0,
    etaSeconds: 0,
  });
  return stat.size;
}

// ------------------------------------------------------------------- ollama
async function ollamaReachable(signal) {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

/** Register an on-disk GGUF with the local Ollama daemon (best effort). */
async function registerGguf(name, file, onEvent, signal) {
  if (!(await ollamaReachable(signal))) return { ok: false, error: "ollama not running" };
  try {
    const res = await fetch(`${OLLAMA}/api/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, modelfile: `FROM ${file}`, stream: false }),
      signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    onEvent?.({ status: `registered with Ollama as ${name}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ------------------------------------------------------------------- driver
/**
 * Try every source in order until one really succeeds.
 *
 * @param {object} job
 * @param {string} job.modelId          catalog id, used for the folder name
 * @param {Array}  job.sources          ordered sources from model-sources.ts
 * @param {string} job.dir              destination root for file downloads
 * @param {object} deps                 { ollamaPull } injected from models.cjs
 */
async function downloadModel(job, onEvent, signal, deps = {}) {
  const { modelId, sources = [], dir } = job;
  // Every downloaded byte is persistent FRIDAY data, so it must land inside
  // the selected FRIDAY folder. There is no temp-folder fallback: a caller
  // without a canonical destination is a bug, not something to work around.
  const canonical = contract.rootFromEnv();
  const root = dir || (canonical ? path.join(canonical, "models") : null);
  const attempts = [];

  if (!sources.length) return { ok: false, error: "no download source is known", attempts };
  if (!root)
    return {
      ok: false,
      error: "no FRIDAY models folder is available — select the FRIDAY folder first",
      attempts,
    };

  for (const source of sources) {
    const label = source.label || source.kind;
    onEvent?.({ status: `source: ${label}` });
    try {
      if (source.kind === "ollama") {
        if (!deps.ollamaPull) throw new Error("ollama pull unavailable");
        if (!(await ollamaReachable(signal))) throw new Error(`Ollama not running on ${OLLAMA}`);
        const res = await deps.ollamaPull(source.ref, onEvent, signal);
        if (!res.ok) throw new Error(res.error || "pull failed");
        return { ok: true, via: "ollama", ref: source.ref, source: label, attempts };
      }

      if (source.kind === "hf-gguf") {
        // Bytes land in `<FRIDAY_ROOT>/models` for llama.cpp. Ollama
        // registration is optional: if the daemon is up, the same file is
        // also created as an Ollama tag. Never refuse the download just
        // because Ollama is not running.
        const listing = await hfFiles(source.repo, signal);
        if (!listing.ok) throw new Error(listing.error);
        const file = pickGguf(listing.files, source.match || []);
        if (!file) throw new Error(`no GGUF file in ${source.repo}`);
        const dest = path.join(root, modelId, path.basename(file));
        if (fs.existsSync(dest)) {
          onEvent?.({ status: "already on disk", progress: 100 });
          const already = await registerGguf(modelId, dest, onEvent, signal);
          return {
            ok: true,
            via: "hf-gguf",
            path: dest,
            registered: already.ok,
            source: label,
            attempts,
          };
        }

        let bytes = 0;
        let lastError = null;
        for (const host of HF_HOSTS) {
          try {
            bytes = await downloadUrl(
              `${host}/${source.repo}/resolve/main/${encodeURI(file)}?download=true`,
              dest,
              { onEvent, signal, label: `downloading ${path.basename(file)}` },
            );
            lastError = null;
            break;
          } catch (err) {
            if (signal?.aborted) throw err;
            lastError = err;
          }
        }
        if (lastError) throw lastError;
        const registered = await registerGguf(modelId, dest, onEvent, signal);
        return {
          ok: true,
          via: "hf-gguf",
          path: dest,
          bytes,
          registered: registered.ok,
          source: label,
          attempts,
        };
      }

      if (source.kind === "hf-repo") {
        const listing = await hfFiles(source.repo, signal);
        if (!listing.ok) throw new Error(listing.error);
        const wanted = listing.files.filter((f) =>
          /\.(safetensors|onnx|json|model|txt|bin)$/i.test(f),
        );
        if (!wanted.length) throw new Error(`no weight files in ${source.repo}`);
        const dest = path.join(root, modelId);
        let bytes = 0;
        for (const file of wanted) {
          const target = path.join(dest, file);
          if (fs.existsSync(target)) continue;
          bytes += await downloadUrl(
            `${listing.host}/${source.repo}/resolve/main/${encodeURI(file)}?download=true`,
            target,
            { onEvent, signal, label: `downloading ${path.basename(file)}` },
          );
        }
        return { ok: true, via: "hf-repo", path: dest, bytes, source: label, attempts };
      }

      if (source.kind === "url") {
        const name = path.basename(new URL(source.url).pathname) || `${modelId}.bin`;
        const dest = path.join(root, modelId, name);
        if (
          fs.existsSync(dest) &&
          (!source.sha256 || hashFile(dest) === String(source.sha256).toLowerCase())
        ) {
          onEvent?.({ status: "already on disk", progress: 100 });
          return {
            ok: true,
            via: "url",
            path: dest,
            bytes: fs.statSync(dest).size,
            source: label,
            attempts,
          };
        }
        const bytes = await downloadUrl(source.url, dest, {
          onEvent,
          signal,
          sha256: source.sha256,
          needBytes: source.bytes,
          label: source.label,
        });
        return { ok: true, via: "url", path: dest, bytes, source: label, attempts };
      }

      throw new Error(`unsupported source kind: ${source.kind}`);
    } catch (err) {
      if (signal?.aborted) {
        const cancelled = voiceInstall.classifyDownloadError("cancelled");
        return { ok: false, error: cancelled.line, cause: cancelled.cause, attempts };
      }
      const classified = voiceInstall.classifyDownloadError(String(err.message || err));
      attempts.push({ source: label, error: classified.line, cause: classified.cause });
      onEvent?.({
        status: `source failed (${label}): ${classified.line}`,
        cause: classified.cause,
      });
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    error: last?.error || `all ${sources.length} source(s) failed`,
    cause: last?.cause || "network",
    attempts,
  };
}

/**
 * Weights FRIDAY itself downloaded into `<FRIDAY_ROOT>/models`.
 * Used by llama.cpp / vLLM conditional start — never the LM Studio or
 * Hugging Face caches, which are not this registry.
 */
function listLocalWeights(dir) {
  const found = [];
  if (!dir) return found;
  const walk = (current, level) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (level > 0) walk(full, level - 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".gguf" && ext !== ".safetensors") continue;
      found.push({ path: full, name: entry.name, format: ext.slice(1) });
    }
  };
  if (fs.existsSync(dir)) walk(dir, 2);
  return found;
}

/** One path per GGUF model; multi-part `-00001-of-00002` shards count as one. */
function uniqueGgufPaths(files) {
  const groups = new Map();
  for (const file of files || []) {
    if (String(file.format || "").toLowerCase() !== "gguf" || !file.path) continue;
    const base = path.basename(file.path);
    const shard = /^(.+)-\d{5}-of-\d{5}\.gguf$/i.exec(base);
    const key = shard ? path.join(path.dirname(file.path), shard[1].toLowerCase()) : file.path;
    if (!groups.has(key)) groups.set(key, file.path);
  }
  return [...groups.values()];
}

/** Parent folders that contain at least one `.safetensors` file (vLLM / MLX). */
function uniqueSafetensorDirs(files) {
  const dirs = new Set();
  for (const file of files || []) {
    if (String(file.format || "").toLowerCase() !== "safetensors" || !file.path) continue;
    dirs.add(path.dirname(file.path));
  }
  return [...dirs];
}

function selfCheckPlan(input) {
  return voiceInstall.downloadSelfCheck(input);
}

module.exports = {
  HF_HOSTS,
  selfCheckPlan,
  hfFiles,
  pickGguf,
  headInfo,
  hashFile,
  assertDiskRoom,
  assertSha256,
  downloadUrl,
  registerGguf,
  downloadModel,
  listLocalWeights,
  uniqueGgufPaths,
  uniqueSafetensorDirs,
};
