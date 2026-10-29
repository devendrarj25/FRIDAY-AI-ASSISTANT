/**
 * FRIDAY · differential installer download.
 *
 * A new installer shares most of its bytes with the one that is installed. The
 * release publishes a block map next to each installer (electron-builder's
 * `<installer>.blockmap`: gzip'd JSON of per-block checksums and sizes). Given
 * the block map of the installer already on this PC and the one of the new
 * release, only the blocks that changed are fetched (HTTP Range) and the rest is
 * copied from the old file. This is the method electron-updater uses for NSIS
 * installers (same plan: reuse a block when its checksum AND size match).
 *
 * The result is only ever a candidate: the caller still checks the whole file
 * against the published SHA-256, and anything that does not add up (a missing or
 * foreign block map, a server that ignores Range, too little saving, a checksum
 * mismatch) returns { ok:false } so the normal full download runs instead. This
 * module never throws to its caller and never leaves a half-written file behind.
 */
const fs = require("node:fs");
const fsp = fs.promises;
const zlib = require("node:zlib");
const crypto = require("node:crypto");

// Loaded up front so net-fetch notes the global fetch before anything replaces it.
const { fetchCompat } = require("./net-fetch.cjs");
const { followRedirects } = require("./resilient-download.cjs");

const COPY = "copy";
const DOWNLOAD = "download";

/** gzip'd JSON → { version, files:[{ name, offset, checksums[], sizes[] }] } */
function parseBlockMap(buffer) {
  if (!buffer || !buffer.length) throw new Error("the block map is empty");
  let json;
  try {
    json = JSON.parse(zlib.gunzipSync(buffer).toString("utf8"));
  } catch (error) {
    throw new Error(`the block map cannot be read (${error.message})`);
  }
  const file = json?.files?.[0];
  if (
    !file ||
    !Array.isArray(file.checksums) ||
    !Array.isArray(file.sizes) ||
    file.checksums.length !== file.sizes.length ||
    !file.checksums.length
  ) {
    throw new Error("the block map has no usable file entry");
  }
  return json;
}

const mapSize = (map) => map.files[0].sizes.reduce((sum, n) => sum + n, 0);

/**
 * The plan: for every block of the new file, copy it from the old file when the
 * old file has a block with the same checksum and size, otherwise download it.
 * Neighbouring operations of one kind are merged into a single range.
 */
function computeOperations(oldMap, newMap) {
  if (oldMap.version !== newMap.version) {
    throw new Error(`block map versions differ (${oldMap.version} / ${newMap.version})`);
  }
  const oldFile = oldMap.files[0];
  const newFile = newMap.files[0];
  const known = new Map();
  let offset = oldFile.offset || 0;
  for (let i = 0; i < oldFile.checksums.length; i += 1) {
    if (!known.has(oldFile.checksums[i])) {
      known.set(oldFile.checksums[i], { offset, size: oldFile.sizes[i] });
    }
    offset += oldFile.sizes[i];
  }
  const ops = [];
  let at = newFile.offset || 0;
  let last = null;
  for (let i = 0; i < newFile.checksums.length; at += newFile.sizes[i], i += 1) {
    const size = newFile.sizes[i];
    const match = known.get(newFile.checksums[i]);
    if (match && match.size === size) {
      if (last && last.kind === COPY && last.end === match.offset) last.end += size;
      else ops.push((last = { kind: COPY, start: match.offset, end: match.offset + size }));
    } else if (last && last.kind === DOWNLOAD && last.end === at) {
      last.end += size;
    } else {
      ops.push((last = { kind: DOWNLOAD, start: at, end: at + size }));
    }
  }
  return ops;
}

function summarize(ops) {
  let download = 0;
  let copy = 0;
  let ranges = 0;
  for (const op of ops) {
    if (op.kind === DOWNLOAD) {
      download += op.end - op.start;
      ranges += 1;
    } else copy += op.end - op.start;
  }
  return { download, copy, ranges };
}

const skip = (reason, error = "") => ({ ok: false, reason, error });

/**
 * Build the new installer at `part` from `oldFile` plus the changed ranges of
 * `url`. Resolves { ok:true, file, bytes, downloaded, reused, sha256 } or
 * { ok:false, reason, error } (use the full download).
 */
async function downloadDifferential(options = {}) {
  const {
    url,
    token = "",
    oldFile,
    oldBlockMap,
    newBlockMap,
    part,
    expectedBytes = 0,
    sha256: expected = "",
    onProgress = () => {},
    signal,
    stallMs = 45_000,
    fetchImpl,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    minSaving = 0.15,
    maxRanges = 1500,
    phase = "Downloading changes",
  } = options;
  let oldFd = null;
  let outFd = null;
  try {
    if (!url || !oldFile || !part || !oldBlockMap || !newBlockMap) return skip("missing-input");
    if (!expected) return skip("no-checksum", "no published checksum to verify the result against");
    if (!fs.existsSync(oldFile)) return skip("no-old-file");
    const newSize = mapSize(newBlockMap);
    if (expectedBytes && newSize !== Number(expectedBytes)) return skip("size-mismatch");
    if (fs.statSync(oldFile).size !== mapSize(oldBlockMap)) {
      return skip("old-file-changed", "the old installer no longer matches its block map");
    }
    const ops = computeOperations(oldBlockMap, newBlockMap);
    const plan = summarize(ops);
    if (plan.download + plan.copy !== newSize) return skip("plan-mismatch");
    if (plan.download > newSize * (1 - minSaving)) return skip("not-worth", "too little is shared");
    if (plan.ranges > maxRanges) return skip("too-many-ranges");

    const doFetch = fetchImpl || fetchCompat;
    const auth = token ? { authorization: `Bearer ${token}` } : null;
    const track = {};
    let resolved = null;

    oldFd = await fsp.open(oldFile, "r");
    await fsp.rm(part, { force: true });
    outFd = await fsp.open(part, "w");
    const hash = crypto.createHash("sha256");
    const write = async (chunk) => {
      hash.update(chunk);
      await outFd.write(chunk);
    };

    let fetched = 0;
    let windowAt = Date.now();
    let windowBytes = 0;
    let smoothed = 0;
    let lastEmit = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      const seconds = Math.max(0.001, (now - windowAt) / 1000);
      smoothed = smoothed ? smoothed * 0.7 + (windowBytes / seconds) * 0.3 : windowBytes / seconds;
      windowAt = now;
      windowBytes = 0;
      lastEmit = now;
      onProgress({
        phase,
        percent: plan.download ? Math.min(99, Math.round((fetched / plan.download) * 100)) : 99,
        received: fetched,
        total: plan.download,
        speedBps: Math.round(smoothed),
        speedMbps: Math.round((smoothed / 1048576) * 10) / 10,
        etaSeconds:
          smoothed > 0 ? Math.max(0, Math.round((plan.download - fetched) / smoothed)) : null,
        state: "DOWNLOADING",
        differential: true,
      });
    };

    const fetchRange = async (start, end) => {
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        if (signal?.aborted) throw Object.assign(new Error("Cancelled."), { cancelled: true });
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener?.("abort", onAbort, { once: true });
        let timer = null;
        let wrote = 0;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(), stallMs);
          timer.unref?.();
        };
        try {
          arm();
          const headers = {
            "user-agent": "FRIDAY",
            accept: "*/*",
            range: `bytes=${start}-${end - 1}`,
          };
          const res = resolved
            ? await doFetch(resolved, {
                method: "GET",
                headers,
                redirect: "follow",
                signal: controller.signal,
              })
            : await followRedirects(url, {
                fetchImpl: doFetch,
                headers,
                auth,
                signal: controller.signal,
                track,
              });
          if (!resolved && track.url) resolved = track.url;
          if (res.status !== 206) {
            try {
              await res.body?.cancel?.();
            } catch {
              /* closed */
            }
            // 200 means the server ignored Range: a differential download cannot work.
            if (res.status === 200)
              throw Object.assign(new Error("ranges unsupported"), { fatal: true });
            resolved = null; // an expired signed address is fetched afresh
            throw new Error(`the server answered ${res.status}`);
          }
          const reader = res.body?.getReader?.();
          if (!reader) throw new Error("no body");
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            got += value.length;
            if (got > end - start) throw new Error("the server sent more than was asked");
            await write(value);
            wrote += value.length;
            fetched += value.length;
            windowBytes += value.length;
            report();
          }
          if (got !== end - start) throw new Error(`short range (${got} of ${end - start} bytes)`);
          return;
        } catch (error) {
          if (error.fatal || error.cancelled || signal?.aborted) throw error;
          // Bytes of this range are already in the sequential file and cannot be
          // taken back: stop here and let the full download take over.
          if (wrote > 0) throw Object.assign(error, { fatal: true });
          lastError = error;
          await sleep(400 * attempt);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener?.("abort", onAbort);
        }
      }
      throw lastError || new Error("range download failed");
    };

    for (const op of ops) {
      if (op.kind === COPY) {
        let at = op.start;
        const buffer = Buffer.allocUnsafe(1 << 20);
        while (at < op.end) {
          const want = Math.min(buffer.length, op.end - at);
          const { bytesRead } = await oldFd.read(buffer, 0, want, at);
          if (bytesRead <= 0) throw new Error("the old installer ended early");
          await write(buffer.subarray(0, bytesRead));
          at += bytesRead;
        }
      } else {
        await fetchRange(op.start, op.end);
      }
    }
    report(true);
    await outFd.close();
    outFd = null;
    const digest = hash.digest("hex");
    if (digest.toLowerCase() !== String(expected).toLowerCase()) {
      await fsp.rm(part, { force: true });
      return skip("checksum", "the rebuilt installer does not match the published checksum");
    }
    return {
      ok: true,
      file: part,
      bytes: newSize,
      downloaded: plan.download,
      reused: plan.copy,
      sha256: digest,
    };
  } catch (error) {
    if (error?.cancelled || signal?.aborted) {
      await fsp.rm(part, { force: true }).catch(() => {});
      return { ok: false, cancelled: true, reason: "cancelled", error: "Cancelled." };
    }
    await fsp.rm(part, { force: true }).catch(() => {});
    return skip("failed", String(error?.message || error));
  } finally {
    await oldFd?.close().catch(() => {});
    await outFd?.close().catch(() => {});
  }
}

module.exports = { parseBlockMap, computeOperations, summarize, downloadDifferential, mapSize };
