/**
 * One download routine for everything FRIDAY fetches to update herself: the
 * Windows installer, the repository source zip and the plugin / module packs.
 *
 * What a plain `fetch` + write loses on a real connection, and what this does
 * about it:
 *  - A connection that drops, resets or closes early mid-file: the bytes already
 *    on disk are kept in `<file>.part` and the next attempt asks for the rest
 *    (HTTP Range), up to `attempts` times with a growing pause.
 *  - A connection that stays open but sends nothing: a stall watchdog aborts it
 *    after `stallMs` and counts it as a normal retry.
 *  - A server that ignores Range (answers 200): the file restarts cleanly.
 *  - 429 / 5xx: waited out (Retry-After honoured) and retried. 401 / 403 / 404 /
 *    410 are not retried, they will not change.
 *  - Redirects (GitHub answers an asset with a signed CDN address): followed by
 *    hand so the token goes only to the host it was meant for, never to the CDN,
 *    and so every attempt gets a fresh signed address.
 *  - A page where a file should be (an HTML login or error page) is refused.
 *  - A file shorter or longer than announced is never accepted.
 *  - The network stack is the app's own (`fetchCompat`: Windows proxy, PAC and
 *    certificates), not bare Node.
 *  - The finished file is renamed into place with a short retry, because a
 *    virus scanner can hold a new .exe for a moment on Windows.
 * It writes with async I/O so a 200 MB download does not freeze the main process.
 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

const DEFAULTS = Object.freeze({
  attempts: 6,
  stallMs: 45_000,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 15_000],
});

const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);

class DownloadError extends Error {
  constructor(message, { fatal = false, status = 0, code = "" } = {}) {
    super(message);
    this.name = "DownloadError";
    this.fatal = fatal;
    this.status = status;
    this.code = code;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Loaded with this module on purpose: net-fetch notes the global fetch as it was
// at that moment, so anything that replaces it later is recognised as deliberate.
const { fetchCompat } = require("./net-fetch.cjs");

/** The app's own network stack when it exists, Node's otherwise. */
function defaultFetch() {
  return fetchCompat;
}

/**
 * GET with manual redirects. `auth` ({ authorization }) is attached only to
 * hops on the first request's host, so a signed CDN address never sees it.
 */
async function followRedirects(
  url,
  { fetchImpl, headers = {}, auth = null, signal, maxHops = 12 } = {},
) {
  const doFetch = fetchImpl || defaultFetch();
  const origin = hostOf(url);
  let current = url;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const sendHeaders = { ...headers };
    if (auth && hostOf(current) === origin) Object.assign(sendHeaders, auth);
    const res = await doFetch(current, {
      method: "GET",
      headers: sendHeaders,
      redirect: "manual",
      signal,
    });
    const location = res.headers?.get?.("location");
    if (!location && res.status >= 300 && res.status < 400 && res.status !== 304) {
      // A stack that hides the Location of a manual redirect: let it follow the
      // redirect itself. Fetch drops the Authorization header on a cross-origin
      // hop, so the token still stays with the host it was meant for.
      try {
        await res.body?.cancel?.();
      } catch {
        /* already closed */
      }
      return doFetch(current, { method: "GET", headers: sendHeaders, redirect: "follow", signal });
    }
    if (location && res.status >= 300 && res.status < 400) {
      try {
        await res.body?.cancel?.();
      } catch {
        /* already closed */
      }
      current = new URL(location, current).href;
      continue;
    }
    return res;
  }
  throw new DownloadError("The server redirected too many times.", { fatal: true });
}

const contentRangeStart = (res) => {
  const match = /^bytes\s+(\d+)-/i.exec(res.headers?.get?.("content-range") || "");
  return match ? Number(match[1]) : null;
};

const retryAfterMs = (res) => {
  const value = Number(res.headers?.get?.("retry-after"));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60) * 1000 : 0;
};

const statusMessage = (status) =>
  status === 404
    ? "The server could not find the file (404). If the repository is private, add a token that can read it."
    : status === 401 || status === 403
      ? "The server refused the download. Check the stored token can read this repository (Contents: Read-only)."
      : `The server answered ${status}.`;

/** Free bytes on the drive that holds `dir`, or null when the platform cannot say. */
async function freeBytes(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

const mbText = (bytes) => `${Math.ceil(bytes / 1048576)} MB`;

/** Rename into place, tolerating a scanner that briefly holds the new file. */
async function commitFile(part, dest, { retries = 6, sleep = defaultSleep } = {}) {
  const verified = `${dest}.verified`;
  await fsp.rm(verified, { force: true });
  let last = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      await fsp.rename(part, verified);
      await fsp.rm(dest, { force: true });
      await fsp.rename(verified, dest);
      return;
    } catch (error) {
      last = error;
      if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) break;
      await sleep(250 * (i + 1));
    }
  }
  throw last;
}

/** Does this file start like a web page instead of the file that was asked for? */
function looksLikeHtml(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(96);
  let n = 0;
  try {
    n = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const head = buf.subarray(0, n).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<?xml");
}

/** A zip ends with an end-of-central-directory record; a cut-off one does not. */
function zipLooksComplete(file) {
  const size = fs.statSync(file).size;
  if (size < 22) return false;
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (head.readUInt32LE(0) !== 0x04034b50 && head.readUInt32LE(0) !== 0x06054b50) return false;
    const span = Math.min(size, 65_557);
    const tail = Buffer.alloc(span);
    fs.readSync(fd, tail, 0, span, size - span);
    return tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** "" when the file is fine; a message when it is a zip that was cut off. Other formats pass. */
function archiveProblem(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4);
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.readUInt32LE(0) === 0x04034b50 && !zipLooksComplete(file)) {
    return "The archive is incomplete (its end is missing).";
  }
  return "";
}

/**
 * Download `url` to `dest` (a path, or a function of the first good response
 * that returns one). Returns { ok, file, bytes, attempts, resumed } or
 * { ok:false, error, cancelled?, fatal?, attempts, resumable }.
 */
async function downloadToFile(options = {}) {
  const {
    url,
    headers = {},
    token = "",
    expectedBytes = 0,
    part: partPath,
    signal: outer,
    onProgress = () => {},
    attempts = DEFAULTS.attempts,
    stallMs = DEFAULTS.stallMs,
    backoffMs = DEFAULTS.backoffMs,
    resume = true,
    validate = null,
    fetchImpl,
    sleep = defaultSleep,
    phase = "Downloading",
    freeSpace = freeBytes,
  } = options;
  if (!url) return { ok: false, error: "There is nothing to download.", fatal: true, attempts: 0 };
  const auth = token ? { authorization: `Bearer ${token}` } : null;
  const dest0 = typeof options.dest === "string" ? options.dest : "";
  const part = partPath || (dest0 ? `${dest0}.part` : "");
  if (!part) return { ok: false, error: "No destination was given.", fatal: true, attempts: 0 };
  await fsp.mkdir(path.dirname(part), { recursive: true });

  let knownTotal = Number(expectedBytes) || 0;
  let lastError = "";
  let finalRes = null;
  let resumed = false;
  let made = 0;
  let invalid = 0;
  /** The last figures reported, kept so a retry notice does not look like a restart. */
  const progress = {
    percent: 0,
    received: 0,
    total: 0,
    speedBps: 0,
    speedMbps: 0,
    etaSeconds: null,
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    made = attempt;
    if (outer?.aborted)
      return { ok: false, cancelled: true, error: "Cancelled.", attempts: attempt - 1 };
    let existing = 0;
    try {
      existing = resume && knownTotal ? (await fsp.stat(part)).size : 0;
    } catch {
      existing = 0;
    }
    if (!resume) await fsp.rm(part, { force: true });
    if (knownTotal && existing > knownTotal) {
      await fsp.rm(part, { force: true });
      existing = 0;
    }

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener?.("abort", onOuterAbort, { once: true });
    let stalled = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallMs);
      timer.unref?.();
    };
    let handle = null;
    try {
      arm();
      if (!(knownTotal && existing === knownTotal)) {
        const res = await followRedirects(url, {
          fetchImpl,
          headers: {
            "user-agent": "FRIDAY",
            accept: "application/octet-stream",
            // Byte offsets and Content-Length only mean something on the raw file.
            "accept-encoding": "identity",
            ...headers,
            ...(existing ? { range: `bytes=${existing}-` } : {}),
          },
          auth,
          signal: controller.signal,
        });
        finalRes = res;
        if (res.status === 416) {
          // The server says our offset is past its end: either we are complete or the part is bad.
          try {
            await res.body?.cancel?.();
          } catch {
            /* closed */
          }
          if (!(knownTotal && existing === knownTotal)) {
            await fsp.rm(part, { force: true });
            throw new DownloadError("The partial file did not match the server; starting again.", {
              code: "RANGE",
            });
          }
        } else {
          if (FATAL_STATUS.has(res.status)) {
            throw new DownloadError(statusMessage(res.status), { fatal: true, status: res.status });
          }
          if (!res.ok && res.status !== 206) {
            const error = new DownloadError(statusMessage(res.status), { status: res.status });
            error.waitMs = retryAfterMs(res);
            throw error;
          }
          const type = String(res.headers?.get?.("content-type") || "").toLowerCase();
          if (type.includes("text/html")) {
            throw new DownloadError(
              "The server returned a web page instead of the file. If the repository is private, add a token that can read it.",
              { fatal: true, status: res.status },
            );
          }
          let append = false;
          if (res.status === 206 && existing > 0) {
            const start = contentRangeStart(res);
            if (start === existing) append = true;
            else {
              await fsp.rm(part, { force: true });
              existing = 0;
            }
          } else if (existing > 0) {
            // The server ignored Range and is sending the whole file again.
            existing = 0;
          }
          if (append) resumed = true;
          // A compressed body is longer once decoded than Content-Length says.
          const encoded = String(res.headers?.get?.("content-encoding") || "").toLowerCase();
          const length =
            encoded && encoded !== "identity"
              ? 0
              : Number(res.headers?.get?.("content-length") || 0);
          if (!knownTotal && length) knownTotal = append ? existing + length : length;
          // Fail early and plainly when the drive cannot hold the rest, instead of
          // retrying a write that will keep failing halfway.
          if (knownTotal) {
            const need = knownTotal - (append ? existing : 0) + 64 * 1048576;
            const free = await freeSpace(path.dirname(part));
            if (free !== null && free < need) {
              await res.body?.cancel?.().catch?.(() => {});
              throw new DownloadError(
                `Not enough free disk space: about ${mbText(need)} are needed and ${mbText(free)} are free on that drive. Free some space and press Retry.`,
                { fatal: true, code: "ENOSPC" },
              );
            }
          }
          handle = await fsp.open(part, append ? "a" : "w");
          let received = append ? existing : 0;
          let windowAt = Date.now();
          let windowBytes = 0;
          let smoothed = 0;
          let lastEmit = 0;
          const reader = res.body?.getReader?.();
          if (reader) {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              arm();
              await handle.write(value);
              received += value.length;
              windowBytes += value.length;
              // The live figures follow every chunk, so a notice raised when the
              // connection drops is exact; only the report to the screen is throttled.
              progress.received = received;
              progress.total = knownTotal;
              progress.percent = knownTotal
                ? Math.min(99, Math.round((received / knownTotal) * 100))
                : 0;
              const now = Date.now();
              // Four reports a second at most: smooth enough for a live bar and
              // speed, light enough not to flood the interface.
              if (now - lastEmit >= 250) {
                const seconds = Math.max(0.001, (now - windowAt) / 1000);
                const instant = windowBytes / seconds;
                smoothed = smoothed ? smoothed * 0.7 + instant * 0.3 : instant;
                windowAt = now;
                windowBytes = 0;
                lastEmit = now;
                progress.speedBps = Math.round(smoothed);
                progress.speedMbps = Math.round((smoothed / 1048576) * 10) / 10;
                progress.etaSeconds =
                  knownTotal && smoothed > 0
                    ? Math.max(0, Math.round((knownTotal - received) / smoothed))
                    : null;
                onProgress({ phase, ...progress, attempt, attempts, state: "DOWNLOADING" });
              }
            }
            // Whatever arrived after the last report still counts: end on the true figures.
            progress.etaSeconds = knownTotal ? 0 : null;
            onProgress({ phase, ...progress, attempt, attempts, state: "DOWNLOADING" });
          } else {
            const buffer = Buffer.from(await res.arrayBuffer());
            await handle.write(buffer);
            received += buffer.length;
          }
          await handle.close();
          handle = null;
        }
      }
      clearTimeout(timer);
      const size = (await fsp.stat(part)).size;
      if (knownTotal && size < knownTotal) {
        throw new DownloadError(`The connection closed early (${size} of ${knownTotal} bytes).`, {
          code: "SHORT",
        });
      }
      if (knownTotal && size > knownTotal) {
        await fsp.rm(part, { force: true });
        throw new DownloadError(
          `The file is larger than announced (${size} of ${knownTotal} bytes).`,
          { code: "LONG" },
        );
      }
      outer?.removeEventListener?.("abort", onOuterAbort);

      // Whole file on disk: check it, then put it in place.
      if (size < 1) {
        await fsp.rm(part, { force: true });
        throw new DownloadError("The downloaded file was empty.", { fatal: true });
      }
      if (looksLikeHtml(part)) {
        await fsp.rm(part, { force: true });
        throw new DownloadError("The server returned a web page instead of the file.", {
          fatal: true,
        });
      }
      if (validate) {
        const problem = await validate(part, size);
        if (problem) {
          await fsp.rm(part, { force: true });
          throw new DownloadError(String(problem), { code: "INVALID" });
        }
      }
      const dest = typeof options.dest === "function" ? options.dest(finalRes) : dest0;
      if (!dest) throw new DownloadError("No destination was given.", { fatal: true });
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await commitFile(part, dest, { sleep });
      return {
        ok: true,
        file: dest,
        bytes: size,
        attempts: attempt,
        resumed,
        headers: finalRes?.headers,
      };
    } catch (error) {
      clearTimeout(timer);
      outer?.removeEventListener?.("abort", onOuterAbort);
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
      }
      if (outer?.aborted) {
        return {
          ok: false,
          cancelled: true,
          error: "Cancelled.",
          attempts: attempt,
          resumable: true,
        };
      }
      if (error?.fatal) {
        // A full disk is the owner's to fix; what already arrived stays for Retry.
        if (error.code !== "ENOSPC") await fsp.rm(part, { force: true });
        return {
          ok: false,
          error: error.message,
          status: error.status,
          fatal: true,
          attempts: attempt,
        };
      }
      if (error?.code === "INVALID") {
        // A file that fails its check twice will not pass a third time.
        invalid += 1;
        if (invalid >= 2) {
          return { ok: false, error: error.message, fatal: true, attempts: attempt };
        }
      }
      if (["ENOSPC", "EDQUOT"].includes(error?.code)) {
        return {
          ok: false,
          error:
            "The drive ran out of free space while downloading. Free some space and press Retry.",
          fatal: true,
          attempts: attempt,
          resumable: true,
        };
      }
      lastError = stalled
        ? `No data arrived for ${Math.round(stallMs / 1000)} seconds.`
        : `${error?.message || error}${error?.cause?.code ? ` (${error.cause.code})` : ""}`;
      if (attempt < attempts) {
        const wait = Math.max(
          error?.waitMs || 0,
          backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 15_000,
        );
        onProgress({
          phase: `${phase} — connection lost, retrying (${attempt}/${attempts - 1})`,
          percent: progress.percent,
          received: progress.received,
          total: progress.total,
          speedBps: 0,
          speedMbps: 0,
          etaSeconds: null,
          attempt,
          attempts,
          state: "RETRYING",
          detail: lastError,
        });
        await sleep(wait);
      }
    }
  }
  let kept = false;
  try {
    kept = (await fsp.stat(part)).size > 0;
  } catch {
    kept = false;
  }
  return {
    ok: false,
    error: `${lastError || "The download failed."} Tried ${made} times${kept ? "; what arrived is kept and the next try continues from it" : ""}.`,
    attempts: made,
    resumable: kept,
  };
}

module.exports = {
  DEFAULTS,
  DownloadError,
  downloadToFile,
  followRedirects,
  freeBytes,
  commitFile,
  looksLikeHtml,
  zipLooksComplete,
  archiveProblem,
  hostOf,
};
