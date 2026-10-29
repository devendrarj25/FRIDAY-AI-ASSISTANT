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
const safety = require("./download-safety.cjs");
const library = require("./local-library.cjs");

const HF_HOSTS = voiceInstall.hfHostList(process.env);
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

/**
 * The Hugging Face token of the owner's own account, set for the length of one
 * download. It is sent to huggingface.co and hf.co only, so gated and private
 * repositories open; a redirect to another host drops it (fetch does this by
 * itself), and it is never logged or written.
 */
let hfToken = null;
const HF_AUTH_HOSTS = /^(?:[\w-]+\.)?(?:huggingface\.co|hf\.co)$/i;
function withHfAuth(url, init = {}) {
  if (!hfToken) return init;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return init;
  }
  if (!HF_AUTH_HOSTS.test(host)) return init;
  return { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${hfToken}` } };
}
// One connection to a CDN often tops out far below the line, so a file over a few tens of MB is cut
// into small chunks that a pool of connections pulls from (the way aria2 and hf_xet do): a slow or
// stuck connection only delays its own chunk, and the pool grows while more connections still add speed.
const SEGMENT_THRESHOLD = 24 * 1024 * 1024; // below this, one connection is as fast
const MAX_SEGMENTS = 16; // most connections one file may use
const START_CONNECTIONS = 4; // where the pool starts before it measures
const GLOBAL_CONNECTIONS = 24; // most connections all files together may hold
const CHUNK_BYTES = 8 * 1024 * 1024;
const RAMP_MS = 2500; // how often the pool checks whether another connection still helps
const STALL_MS = 20_000; // no byte for this long ends the connection and asks again
const HEADERS_MS = 20_000; // no response headers for this long ends the request
const PARALLEL_FILES = 3; // files of one repo fetched at the same time
let liveConnections = 0;
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
    const error = new Error(`checksum mismatch for ${path.basename(file)}`);
    error.code = "SHA_MISMATCH";
    throw error;
  }
}

// --------------------------------------------------------------- HF listing
/** Real file listing for a Hugging Face repo (no guessing at filenames). */
async function hfFiles(repo, signal) {
  let lastError = "unreachable";
  for (const host of HF_HOSTS) {
    try {
      // blobs=true makes the listing carry each LFS file's sha256 and size,
      // so every weight is verified against the publisher's own digest.
      const listingUrl = `${host}/api/models/${repo}?blobs=true`;
      safety.assertAllowedUrl(listingUrl);
      const res = await fetch(listingUrl, withHfAuth(listingUrl, { signal }));
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const siblings = Array.isArray(json.siblings) ? json.siblings : [];
      const files = siblings.map((s) => s.rfilename).filter(Boolean);
      const meta = {};
      for (const sibling of siblings) {
        if (!sibling || !sibling.rfilename) continue;
        const lfs = sibling.lfs || {};
        meta[sibling.rfilename] = {
          sha256: lfs.sha256 ? String(lfs.sha256).toLowerCase() : "",
          size: Number(lfs.size) || Number(sibling.size) || 0,
        };
      }
      if (files.length) return { ok: true, host, files, meta };
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
async function headInfo(url, signal, extraHosts = []) {
  try {
    const { res } = await safety.fetchAllowlisted(
      url,
      withHfAuth(url, { method: "HEAD", signal }),
      extraHosts,
    );
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

/** Bytes per second over the last few seconds, so the number follows what the line does now. */
function rateWindow(windowMs = 4000) {
  const samples = [];
  return {
    push(bytes, now = Date.now()) {
      samples.push([now, bytes]);
      while (samples.length > 2 && now - samples[0][0] > windowMs) samples.shift();
    },
    perSecond() {
      if (samples.length < 2) return 0;
      const [t0, b0] = samples[0];
      const [t1, b1] = samples[samples.length - 1];
      return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
    },
  };
}

const mbOf = (bytes) => Number(((bytes || 0) / 1024 ** 2).toFixed(1));

function progressReporter(total, onEvent, label, stats = {}) {
  let done = 0;
  let last = 0;
  const window = rateWindow();
  window.push(0);
  return {
    add(bytes) {
      done += bytes;
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      window.push(done, now);
      const rate = window.perSecond();
      onEvent?.({
        status: label,
        gbTotal: gb(total),
        gbDone: gb(done),
        bytesTotal: total,
        bytesDone: done,
        connections: stats.connections || 0,
        host: stats.host || "",
        progress: total > 0 ? Math.min(100, (done / total) * 100) : null,
        speedMbps: mbOf(rate),
        etaSeconds: total > done && rate > 0 ? Math.round((total - done) / rate) : 0,
        percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
      });
    },
    /** Bytes a resumed download already holds, so the percent starts where it stopped. */
    seed(bytes) {
      done = Math.max(0, Number(bytes) || 0);
    },
    rate: () => window.perSecond(),
    get bytes() {
      return done;
    },
  };
}

/** Run `fn` over `items`, at most `limit` at a time; results keep the order of `items`. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failure = failure || err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure;
  return results;
}

/**
 * Several files downloading together report as one transfer: the sizes add up, so the
 * bar never jumps back to the start of the next file. `totals` are the sizes the repo
 * listing gave, known before the first byte, so the percent is right from the start.
 */
function combinedProgress(count, onEvent, totals = []) {
  const rows = Array.from({ length: count }, (_, i) => ({
    done: 0,
    total: Number(totals[i]) || 0,
    connections: 0,
  }));
  const window = rateWindow();
  window.push(0);
  const exact = (event, key) => (event?.[key] != null ? Number(event[key]) : null);
  return {
    forFile(index, name) {
      return (event) => {
        const row = rows[index];
        const bytesTotal = exact(event, "bytesTotal");
        const bytesDone = exact(event, "bytesDone");
        if (bytesTotal != null && bytesTotal > 0) row.total = Math.max(row.total, bytesTotal);
        if (bytesDone != null) row.done = bytesDone;
        else if (event?.gbDone != null) row.done = event.gbDone * 1024 ** 3;
        if (event?.status === "downloaded") row.done = row.total = Math.max(row.total, row.done);
        row.connections = Number(event?.connections) || 0;
        const total = rows.reduce((sum, r) => sum + r.total, 0);
        const done = rows.reduce((sum, r) => sum + Math.min(r.done, r.total || r.done), 0);
        window.push(done);
        const rate = window.perSecond();
        onEvent?.({
          ...event,
          status: event?.status === "downloaded" ? `downloaded ${name}` : event?.status,
          bytesTotal: total,
          bytesDone: done,
          gbTotal: gb(total),
          gbDone: gb(done),
          connections: rows.reduce((sum, r) => sum + r.connections, 0),
          progress: total > 0 ? Math.min(100, (done / total) * 100) : event?.progress,
          percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : event?.percent,
          speedMbps: mbOf(rate),
          etaSeconds: total > done && rate > 0 ? Math.round((total - done) / rate) : 0,
        });
      };
    },
  };
}

function abortError(signal) {
  return normaliseDownloadAbort(signal?.reason, signal);
}

/**
 * Pause and cancel always reject with the same Error.
 * A string reason, a DOMException, or an Error are all accepted.
 * Anything that is not an abort is returned unchanged.
 */
function normaliseDownloadAbort(err, signal) {
  const reason = signal?.reason;
  const message = typeof err === "string" ? err : String(err?.message || "");
  const abortName = err?.name === "AbortError" || err?.code === "ABORT_ERR";
  const aborted =
    Boolean(signal?.aborted) || abortName || err?.code === "PAUSE" || err?.code === "CANCEL";
  const reasonText = typeof reason === "string" ? reason : typeof err === "string" ? err : "";
  const paused =
    err?.code === "PAUSE" ||
    reasonText === "pause" ||
    reasonText === "paused" ||
    message === "paused";
  if (!aborted && !paused) return err instanceof Error ? err : err;
  const error = new Error(paused ? "paused" : "cancelled");
  error.code = paused ? "PAUSE" : "CANCEL";
  return error;
}

/**
 * Stream a response into the file at `position`. `limit` caps the bytes taken
 * (a segment never writes past its own range) and `onWrite` reports each
 * chunk after it is on disk. Returns the bytes written.
 */
async function pipeInto(
  handle,
  res,
  position,
  report,
  signal,
  control,
  limit = Infinity,
  onWrite = null,
  stallMs = STALL_MS,
) {
  const reader = res.body.getReader();
  /** One read that gives up when the connection goes quiet, instead of hanging for ever. */
  const readOnce = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        const error = new Error(`stalled: no data for ${Math.round(stallMs / 1000)}s`);
        error.code = "STALL";
        reject(error);
      }, stallMs);
      reader.read().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  let pos = position;
  let taken = 0;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    while (control?.paused) {
      if (signal?.aborted) throw abortError(signal);
      await sleep(30);
    }
    const { value, done } = await readOnce();
    if (done) break;
    let buf = Buffer.from(value);
    if (taken + buf.length > limit) buf = buf.subarray(0, limit - taken);
    if (buf.length) {
      await handle.write(buf, 0, buf.length, pos);
      pos += buf.length;
      taken += buf.length;
      report.add(buf.length);
      onWrite?.(buf.length);
    }
    if (taken >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
    const rate = Number(control?.maxBytesPerSecond || 0);
    if (rate > 0) {
      const wait = Math.min(1000, Math.ceil((buf.length / rate) * 1000));
      if (wait > 0) await sleep(wait);
    }
  }
  return taken;
}

const hubChecked = new Map(); // python -> whether huggingface_hub and hf_xet import there
async function hubReady(hub, python) {
  if (!python) return false;
  if (!hubChecked.has(python)) hubChecked.set(python, await hub.available(python));
  return hubChecked.get(python);
}

const SAVE_EVERY_MS = 1500;

/** Errors that end a download for good: retrying the same request cannot change them. */
function endsDownload(err, signal) {
  return (
    Boolean(signal?.aborted) ||
    ["PAUSE", "CANCEL", "OFF_ALLOWLIST", "UNSAFE_URL", "NO_RANGE", "ENOSPC"].includes(err?.code)
  );
}

/** Small chunks a pool of connections takes in turn; `count` is the most connections wanted. */
function planSegments(total, count) {
  const chunk = Math.max(1, Math.min(CHUNK_BYTES, Math.ceil(total / Math.max(1, count))));
  const segments = [];
  for (let start = 0; start < total; start += chunk) {
    segments.push({ start, end: Math.min(total - 1, start + chunk - 1), got: 0 });
  }
  return segments;
}

/** The segment table a stopped download left beside its .part, or null when it cannot be trusted. */
function readSegments(file, total) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const rows = Array.isArray(saved?.segments) ? saved.segments : [];
    const ok =
      saved?.total === total &&
      rows.length > 0 &&
      rows.every(
        (row) =>
          Number.isInteger(row.start) &&
          Number.isInteger(row.end) &&
          Number.isInteger(row.got) &&
          row.start <= row.end &&
          row.got >= 0 &&
          row.got <= row.end - row.start + 1,
      );
    return ok ? rows.map((row) => ({ start: row.start, end: row.end, got: row.got })) : null;
  } catch {
    return null;
  }
}

/** One request that gives up when the server sends no headers, and still honours pause and cancel. */
async function requestWithin(url, init, ctx) {
  const { signal, extraHosts, headersMs = HEADERS_MS } = ctx;
  const own = new AbortController();
  const link = () => own.abort(signal.reason);
  if (signal?.aborted) link();
  else signal?.addEventListener("abort", link, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`no response from ${new URL(url).hostname} after ${headersMs / 1000}s`);
    error.code = "TIMEOUT";
    own.abort(error);
  }, headersMs);
  try {
    return await safety.fetchAllowlisted(
      url,
      withHfAuth(url, { ...init, signal: own.signal }),
      extraHosts,
    );
  } finally {
    clearTimeout(timer);
    // The listener stays until the body has been read; the controller dies with the request.
    signal?.removeEventListener("abort", link);
  }
}

/**
 * Pull the chunks with a pool of connections. It starts small, then adds two connections at a
 * time while the speed still rises, so each PC and line finds its own best number instead of a
 * fixed guess, and stops adding the moment more connections stop helping or the global cap is hit.
 */
async function runSegments(segments, ctx, maxConnections, startConnections = START_CONNECTIONS) {
  const size = (segment) => segment.end - segment.start + 1;
  let next = 0;
  let failure = null;
  const take = () => {
    while (next < segments.length) {
      const segment = segments[next];
      next += 1;
      if (segment.got < size(segment)) return segment;
    }
    return null;
  };
  const running = [];
  const spawn = () => {
    ctx.stats.connections += 1;
    liveConnections += 1;
    running.push(
      (async () => {
        try {
          for (;;) {
            if (failure) return;
            const segment = take();
            if (!segment) return;
            try {
              await fetchSegment(segment, ctx);
            } catch (err) {
              failure = failure || err;
              ctx.stop?.(err);
              return;
            }
          }
        } finally {
          ctx.stats.connections -= 1;
          liveConnections -= 1;
        }
      })(),
    );
  };
  const waiting = () => segments.length - next;
  const first = Math.min(maxConnections, startConnections, Math.max(1, waiting()));
  for (let i = 0; i < first; i += 1) spawn();
  let best = 0;
  const ramp = setInterval(() => {
    if (failure || maxConnections <= ctx.stats.connections) return;
    const rate = ctx.report.rate();
    // Add connections only while the last step paid off (at least 12% more speed).
    if (best > 0 && rate < best * 1.12) return;
    best = Math.max(best, rate);
    if (waiting() <= ctx.stats.connections || liveConnections >= GLOBAL_CONNECTIONS) return;
    for (let i = 0; i < 2 && ctx.stats.connections < maxConnections; i += 1) spawn();
  }, ctx.rampMs || RAMP_MS);
  try {
    // Connections added later are appended while this waits, so loop until none is left.
    while (running.length) await Promise.all(running.splice(0));
  } finally {
    clearInterval(ramp);
  }
  if (failure) throw failure;
}

/**
 * Fetch one byte range to completion. The bytes already written are kept: a
 * stream that ends early, or a connection that drops, asks again for the rest
 * with a Range request. A server that answers a range request with anything
 * but 206 cannot be resumed or split, so that is reported, not written.
 */
async function fetchSegment(segment, ctx) {
  const { urls, handle, report, signal, control, extraHosts, canRange, single, save } = ctx;
  const length = segment.end - segment.start + 1;
  let failures = 0;
  while (segment.got < length) {
    const from = segment.start + segment.got;
    // The first try uses the preferred source; each failure moves on to the next one in the list.
    const url = urls[failures % urls.length];
    try {
      const { res } = await requestWithin(
        url,
        { headers: canRange ? { Range: `bytes=${from}-${segment.end}` } : {} },
        ctx,
      );
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (canRange && res.status !== 206 && !(single && from === 0)) {
        const error = new Error("the server ignored the Range request");
        error.code = "NO_RANGE";
        throw error;
      }
      const wrote = await pipeInto(
        handle,
        res,
        from,
        report,
        signal,
        control,
        length - segment.got,
        (bytes) => {
          segment.got += bytes;
          save(false);
        },
        ctx.stallMs,
      );
      if (wrote > 0) failures = 0;
      if (segment.got < length) throw new Error("the connection closed before the range ended");
    } catch (err) {
      if (endsDownload(err, signal)) throw err;
      // Without Range support there is nothing to resume from: start the file again.
      if (!canRange) segment.got = 0;
      failures += 1;
      if (failures >= RETRIES) {
        const message = String(err?.message || err);
        const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(
          message,
        );
        throw new Error(
          offline && !message.startsWith("offline:") ? `offline: ${message}` : message,
        );
      }
      await sleep(800 * failures);
    }
  }
}

/** A body of unknown length (no usable HEAD): one plain stream, tried again from the start. */
async function fetchUnknownLength(ctx) {
  const { url, handle, report, signal, control, extraHosts } = ctx;
  for (let failures = 1; ; failures += 1) {
    try {
      await handle.truncate(0);
      const { res } = await safety.fetchAllowlisted(url, withHfAuth(url, { signal }), extraHosts);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      return await pipeInto(handle, res, 0, report, signal, control, Infinity, null, ctx.stallMs);
    } catch (err) {
      if (endsDownload(err, signal) || failures >= RETRIES) {
        const message = String(err?.message || err);
        const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|fetch failed/i.test(
          message,
        );
        if (endsDownload(err, signal)) throw err;
        throw new Error(
          offline && !message.startsWith("offline:") ? `offline: ${message}` : message,
        );
      }
      await sleep(800 * failures);
    }
  }
}

async function downloadOnce(url, dest, options) {
  const {
    onEvent,
    signal,
    label = "downloading",
    sha256,
    needBytes,
    control,
    forceSingle = false,
    segmentThreshold = SEGMENT_THRESHOLD,
    maxSegments = MAX_SEGMENTS,
    alternates = [],
  } = options;
  // The same file on other hosts of the same publisher, tried in order when one fails or stalls.
  const urls = [url, ...alternates.filter((other) => other && other !== url)];
  // With a digest to check, the vendor may send us on to its own CDN.
  const extraHosts = sha256
    ? [...(options.extraHosts || []), safety.VERIFIED_REDIRECTS]
    : options.extraHosts || [];
  safety.assertAllowedUrl(url, extraHosts);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  assertDiskRoom(path.dirname(dest), needBytes);
  const part = `${dest}.part`;
  const table = `${part}.json`;
  // The first source that answers the size request is used; the others stay as alternates.
  let head = { ok: false };
  for (const candidate of urls) {
    head = await headInfo(candidate, signal, extraHosts);
    if (head.ok || signal?.aborted) break;
  }
  const total = head.ok ? head.size : 0;
  const canRange = head.ok && head.ranges && total > 0 && !forceSingle;
  const count = canRange && total > segmentThreshold ? maxSegments : 1;
  const stats = { connections: 0, host: new URL(url).hostname };
  const report = progressReporter(total, onEvent, label, stats);

  // A partial file is only trusted together with the table of what each range
  // already holds; a size alone says nothing about holes left by parallel ranges.
  let segments = canRange && fs.existsSync(part) ? readSegments(table, total) : null;
  if (!segments) {
    await fsp.rm(part, { force: true });
    await fsp.rm(table, { force: true });
    segments =
      total > 0
        ? canRange
          ? planSegments(total, count)
          : [{ start: 0, end: total - 1, got: 0 }]
        : [];
  }
  report.seed(segments.reduce((sum, row) => sum + row.got, 0));

  let lastSave = 0;
  const save = (force) => {
    if (!canRange) return;
    const now = Date.now();
    if (!force && now - lastSave < SAVE_EVERY_MS) return;
    lastSave = now;
    try {
      fs.writeFileSync(table, JSON.stringify({ total, segments }));
    } catch {
      /* the table only speeds up a resume */
    }
  };

  const handle = await fsp.open(part, fs.existsSync(part) ? "r+" : "w+");
  try {
    // One failed chunk stops the others at once; pause and cancel from outside reach them too.
    const inner = new AbortController();
    const link = () => inner.abort(signal.reason);
    if (signal?.aborted) link();
    else signal?.addEventListener("abort", link, { once: true });
    const ctx = {
      url,
      urls,
      handle,
      report,
      stats,
      signal: inner.signal,
      control,
      extraHosts,
      canRange,
      single: segments.length === 1,
      save,
      stop: (err) => inner.abort(err),
      stallMs: options.stallMs,
      headersMs: options.headersMs,
      rampMs: options.rampMs,
    };
    try {
      if (total > 0) {
        await runSegments(
          segments,
          ctx,
          Math.max(1, Math.min(count, segments.length)),
          options.startConnections,
        );
      } else await fetchUnknownLength(ctx);
    } finally {
      signal?.removeEventListener("abort", link);
    }
  } catch (err) {
    const normalised = normaliseDownloadAbort(err, signal);
    const paused = normalised?.code === "PAUSE";
    // A pause, or a connection that kept failing, leaves the partial file and its
    // table so the next call carries on; anything else starts clean.
    if (paused || !normalised?.code) save(true);
    else {
      await fsp.rm(part, { force: true }).catch(() => {});
      await fsp.rm(table, { force: true }).catch(() => {});
    }
    if (normalised?.code === "PAUSE" || normalised?.code === "CANCEL") throw normalised;
    throw err instanceof Error ? err : new Error(String(err?.message || err));
  } finally {
    await handle.close();
  }

  const stat = await fsp.stat(part);
  if (total > 0 && stat.size !== total) {
    await fsp.rm(part, { force: true });
    await fsp.rm(table, { force: true });
    throw new Error(`incomplete download (${stat.size}/${total} bytes)`);
  }
  await fsp.rm(table, { force: true });
  await fsp.rename(part, dest);
  assertSha256(dest, sha256);
  onEvent?.({
    status: "downloaded",
    gbTotal: gb(stat.size),
    gbDone: gb(stat.size),
    progress: 100,
    percent: 100,
    speedMbps: 0,
    etaSeconds: 0,
  });
  return stat.size;
}

/**
 * Download one URL to `dest`. Big files use parallel range connections, every
 * range is held to its exact length, and a stopped download resumes from the
 * bytes each range really wrote. A server that ignores Range, or a file that
 * fails its SHA-256, is fetched once more as a single clean stream before the
 * error is reported. Returns the number of bytes written.
 */
async function downloadUrl(url, dest, options = {}) {
  try {
    return await downloadOnce(url, dest, options);
  } catch (err) {
    const again =
      (err?.code === "NO_RANGE" && !options.forceSingle) ||
      (err?.code === "SHA_MISMATCH" && !options.retried);
    if (!again) throw err;
    return downloadOnce(url, dest, { ...options, forceSingle: true, retried: true });
  }
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

/** sha256 of a file without blocking the main process (a GGUF is gigabytes). */
function hashFileAsync(file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const total = fs.statSync(file).size || 1;
    let done = 0;
    fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
      .on("data", (chunk) => {
        hash.update(chunk);
        done += chunk.length;
        onProgress?.(done / total);
      })
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** What Ollama said went wrong: its own JSON error, else the HTTP status. */
async function ollamaFailure(res) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      detail = String(JSON.parse(text).error || "");
    } catch {
      detail = text.trim().split("\n").pop() || "";
    }
  } catch {
    /* the status line is all there is */
  }
  return detail ? `HTTP ${res.status}: ${detail.slice(0, 240)}` : `HTTP ${res.status}`;
}

/**
 * Register an on-disk GGUF with the local Ollama daemon.
 *
 * Current Ollama no longer reads a file path from a Modelfile: the file is
 * uploaded as a blob (POST /api/blobs/sha256:<digest>) and /api/create names it
 * under `files`. A server too old for blobs still gets the Modelfile form.
 * https://github.com/ollama/ollama/blob/main/docs/api.md
 */
async function registerGguf(name, file, onEvent, signal, io = {}) {
  const call = io.fetch || fetch;
  if (!(await ollamaReachable(signal))) return { ok: false, error: "ollama not running" };
  try {
    // Creating a tag imports the whole file into Ollama's own store, so a tag
    // that is already there is verified by name and left alone.
    const listed = await call(`${OLLAMA}/api/tags`, { signal });
    if (listed.ok) {
      const have = ((await listed.json()).models || []).map((row) => String(row.name || row.model));
      if (have.some((tag) => tag === name || tag === `${name}:latest`)) {
        onEvent?.({ status: `already registered with Ollama as ${name}` });
        return { ok: true, already: true };
      }
    }
    onEvent?.({ status: "reading the model file" });
    const digest = `sha256:${await hashFileAsync(file, (f) =>
      onEvent?.({ status: `reading the model file ${Math.round(f * 100)}%` }),
    )}`;
    const blob = `${OLLAMA}/api/blobs/${digest}`;
    const have = await call(blob, { method: "HEAD", signal });
    if (have.status === 404) {
      onEvent?.({ status: "handing the model file to Ollama" });
      const size = fs.statSync(file).size;
      const up = await call(blob, {
        method: "POST",
        headers: { "content-length": String(size) },
        body: require("node:stream").Readable.toWeb(fs.createReadStream(file)),
        duplex: "half",
        signal,
      });
      if (up.status === 404 || up.status === 405) return legacyRegister(call, name, file, signal);
      if (!up.ok) return { ok: false, error: await ollamaFailure(up) };
    } else if (!have.ok && have.status !== 200) {
      return legacyRegister(call, name, file, signal);
    }
    const res = await call(`${OLLAMA}/api/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: name,
        files: { [path.basename(file)]: digest },
        stream: false,
      }),
      signal,
    });
    if (!res.ok) return { ok: false, error: await ollamaFailure(res) };
    onEvent?.({ status: `registered with Ollama as ${name}` });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function legacyRegister(call, name, file, signal) {
  const res = await call(`${OLLAMA}/api/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, modelfile: `FROM ${file}`, stream: false }),
    signal,
  });
  return res.ok ? { ok: true } : { ok: false, error: await ollamaFailure(res) };
}

function remember(root, job, fields) {
  if (job.persist === false || !root) return;
  const file = job.storePath || path.join(root, "transfers.json");
  const id = String(job.transferId || job.modelId || "transfer");
  const jobs = safety.loadTransfers(file).filter((row) => row.id !== id);
  const row = safety.blankTransfer({
    id,
    modelId: job.modelId,
    sourceUrl: fields.sourceUrl,
    dest: fields.dest,
    bytes: fields.bytes,
    sha256: fields.sha256,
  });
  row.status = fields.status || "queued";
  row.done = Number(fields.done) || 0;
  row.error = fields.error || "";
  safety.saveTransfers(file, [...jobs, row]);
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
async function downloadModelInner(job, onEvent, signal, deps = {}) {
  const { modelId, sources = [], dir } = job;
  // Every downloaded byte is persistent FRIDAY data, so it must land inside
  // the selected FRIDAY folder. There is no temp-folder fallback: a caller
  // without a canonical destination is a bug, not something to work around.
  const canonical = contract.rootFromEnv();
  const root = dir || (canonical ? path.join(canonical, "models") : null);
  const attempts = [];
  let active = null;

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

      if (source.gated)
        throw new Error("gated repo: accept the license on the official page first");

      if (source.kind === "github" || source.kind === "url") {
        const fileUrl = source.url;
        if (!fileUrl) throw new Error("source has no url");
        const name = path.basename(new URL(fileUrl).pathname) || `${modelId}.bin`;
        const dest = path.join(root, modelId, name);
        if (
          fs.existsSync(dest) &&
          (!source.sha256 || hashFile(dest) === String(source.sha256).toLowerCase())
        ) {
          onEvent?.({ status: "already on disk", progress: 100 });
          remember(root, job, { status: "installed", dest, sourceUrl: fileUrl });
          return {
            ok: true,
            via: source.kind,
            path: dest,
            bytes: fs.statSync(dest).size,
            source: label,
            attempts,
          };
        }
        active = { dest, sourceUrl: fileUrl, sha256: source.sha256 || "" };
        remember(root, job, { status: "downloading", ...active });
        const bytes = await downloadUrl(fileUrl, dest, {
          onEvent,
          signal,
          sha256: source.sha256,
          needBytes: source.bytes,
          label: source.label,
          control: job.control,
        });
        remember(root, job, {
          status: "installed",
          dest,
          sourceUrl: fileUrl,
          bytes,
          sha256: source.sha256,
        });
        return { ok: true, via: source.kind, path: dest, bytes, source: label, attempts };
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
          remember(root, job, {
            status: "installed",
            dest,
            sourceUrl: `https://huggingface.co/${source.repo}`,
          });
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
        const digest = listing.meta && listing.meta[file] ? listing.meta[file] : {};
        active = {
          dest,
          sourceUrl: `https://huggingface.co/${source.repo}`,
          sha256: digest.sha256 || "",
        };
        remember(root, job, { status: "downloading", ...active });
        for (const host of HF_HOSTS) {
          try {
            bytes = await downloadUrl(
              `${host}/${source.repo}/resolve/main/${encodeURI(file)}?download=true`,
              dest,
              {
                alternates: HF_HOSTS.filter((other) => other !== host).map(
                  (other) =>
                    `${other}/${source.repo}/resolve/main/${encodeURI(file)}?download=true`,
                ),
                onEvent,
                signal,
                label: `downloading ${path.basename(file)}`,
                control: job.control,
                sha256: digest.sha256 || "",
                needBytes: digest.size || 0,
              },
            );
            lastError = null;
            break;
          } catch (err) {
            if (signal?.aborted) throw err;
            lastError = err;
          }
        }
        if (lastError) throw lastError;
        remember(root, job, { status: "installed", dest, sourceUrl: active.sourceUrl, bytes });
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
        const todo = wanted.filter((file) => !fs.existsSync(path.join(dest, file)));
        const sizeOf = (file) => Number(listing.meta?.[file]?.size) || 0;
        let bytes = 0;
        let engine = "own";
        // First choice: Hugging Face's official client with hf_xet (see hf-hub-download.cjs). It is
        // used only against huggingface.co itself, and any failure falls through to the downloader below.
        const hub = deps.hub || require("./hf-hub-download.cjs");
        const mode = hub.engineMode(process.env);
        if (todo.length && mode !== "own" && listing.host === "https://huggingface.co") {
          const python = deps.hubPython !== undefined ? deps.hubPython : hub.findPython({ root });
          if (await hubReady(hub, python)) {
            onEvent?.({ status: "source: Hugging Face official client (hf_xet)" });
            const res = await hub.download({
              repo: source.repo,
              dest,
              python,
              files: todo.map((file) => ({
                name: file,
                size: sizeOf(file),
                sha256: listing.meta?.[file]?.sha256 || "",
              })),
              onProgress: onEvent,
              signal,
            });
            if (signal?.aborted) throw abortError(signal);
            if (res.ok) {
              bytes = res.bytes;
              engine = "hub";
            } else {
              onEvent?.({
                status: `the Hugging Face client did not finish (${res.error}); using FRIDAY's own downloader`,
              });
              if (mode === "hub") throw new Error(`Hugging Face client: ${res.error}`);
            }
          } else if (mode === "hub") {
            throw new Error(
              "the Hugging Face client (huggingface_hub with hf_xet) is not installed",
            );
          }
        }
        if (engine === "own") {
          const progress = combinedProgress(todo.length, onEvent, todo.map(sizeOf));
          const fileUrl = (host, file) =>
            `${host}/${source.repo}/resolve/main/${encodeURI(file)}?download=true`;
          const sizes = await mapPool(todo, PARALLEL_FILES, async (file, index) => {
            const row = listing.meta && listing.meta[file] ? listing.meta[file] : {};
            return downloadUrl(fileUrl(listing.host, file), path.join(dest, file), {
              alternates: HF_HOSTS.filter((host) => host !== listing.host).map((host) =>
                fileUrl(host, file),
              ),
              onEvent: progress.forFile(index, path.basename(file)),
              signal,
              label: `downloading ${path.basename(file)}`,
              control: job.control,
              sha256: row.sha256 || "",
              needBytes: row.size || 0,
            });
          });
          bytes = sizes.reduce((sum, size) => sum + size, 0);
        }
        remember(root, job, {
          status: "installed",
          dest,
          sourceUrl: `https://huggingface.co/${source.repo}`,
          bytes,
        });
        return { ok: true, via: "hf-repo", path: dest, bytes, source: label, engine, attempts };
      }

      throw new Error(`unsupported source kind: ${source.kind}`);
    } catch (err) {
      if (signal?.aborted) {
        if (signal.reason === "pause") {
          if (active) {
            remember(root, job, {
              status: "paused",
              dest: active.dest,
              sourceUrl: active.sourceUrl,
              sha256: active.sha256,
              error: "paused",
            });
          }
          return { ok: false, error: "paused", cause: "pause", attempts };
        }
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

/** One download, with the owner's Hugging Face token (deps.hfToken) in place while it runs. */
let tokenUsers = 0;
async function downloadModel(job, onEvent, signal, deps = {}) {
  if (deps.hfToken) {
    hfToken = String(deps.hfToken);
    tokenUsers += 1;
  }
  try {
    return await downloadModelInner(job, onEvent, signal, deps);
  } finally {
    if (deps.hfToken && (tokenUsers -= 1) <= 0) {
      tokenUsers = 0;
      hfToken = null;
    }
  }
}

module.exports = {
  withHfAuth,
  HF_HOSTS,
  selfCheckPlan,
  hfFiles,
  pickGguf,
  headInfo,
  hashFile,
  assertDiskRoom,
  assertSha256,
  downloadUrl,
  mapPool,
  combinedProgress,
  planSegments,
  CHUNK_BYTES,
  SEGMENT_THRESHOLD,
  MAX_SEGMENTS,
  PARALLEL_FILES,
  normaliseDownloadAbort,
  registerGguf,
  downloadModel,
  listLocalWeights,
  uniqueGgufPaths,
  uniqueSafetensorDirs,
  safety,
  library,
};
