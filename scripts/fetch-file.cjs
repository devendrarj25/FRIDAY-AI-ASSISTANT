/**
 * One file over HTTPS with the live download row the other setup downloads use (scripts/download-board.cjs): the
 * solid coloured bar, the percent, `done/total` in MB, the speed and the time left on a real console, a plain line
 * every tenth in a log file. setup-windows.ps1 runs it for the installers it downloads once Node.js is there; the
 * file is checked by the caller (SHA-256 or publisher signature), never here. A connection that breaks keeps the
 * `.part` file and the next run continues it with a Range request (a 206 that starts at the right byte, else a clean
 * restart).
 *
 *   node scripts/fetch-file.cjs --url <https url> --out <file> [--label <name>]
 *
 * Exit 0 = the file is complete at --out; 1 = failed (a cut connection keeps the .part file for the next run, any other failure leaves nothing); 2 = bad arguments; 3 = this machine
 * reaches the network through a proxy, which this script does not use, so the caller uses its own transports.
 * The row is written to stderr and stdout stays empty, so a PowerShell function that captures its output still shows
 * the bar. TLS stays fully on: only https is followed, redirects included.
 */
"use strict";

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const MAX_REDIRECTS = 10;
const CONNECT_MS = 20_000;
const IDLE_MS = 30_000;

/** One argument value after its flag, or "". */
function argValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? String(argv[at + 1]) : "";
}

/** The next URL of a redirect: relative or absolute, https only. Null when it is not one this script may follow. */
function nextUrl(current, location) {
  try {
    const next = new URL(String(location), current);
    return next.protocol === "https:" ? next.toString() : null;
  } catch {
    return null;
  }
}

/** True when the environment names a proxy: those downloads belong to curl.exe and Invoke-WebRequest. */
function proxyConfigured(env = process.env) {
  return ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some((name) =>
    String(env[name] || "").trim(),
  );
}

/** An error that keeps the `.part` file: the connection broke, the bytes so far are good and a retry can continue. */
function interrupted(message) {
  return Object.assign(new Error(message), { keepPart: true });
}

/** One GET that follows redirects and hands the final 200 or 206 response to `onResponse`. */
function request(url, headers, onResponse, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "FRIDAY-Setup", ...headers }, timeout: CONNECT_MS },
      (res) => {
        const status = Number(res.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          const next = nextUrl(url, res.headers.location);
          if (!next) return reject(new Error(`redirect to a URL that is not https`));
          if (redirects >= MAX_REDIRECTS) return reject(new Error("too many redirects"));
          return request(next, headers, onResponse, redirects + 1).then(resolve, reject);
        }
        if (status !== 200 && status !== 206) {
          res.resume();
          return reject(Object.assign(new Error(`HTTP ${status}`), { status }));
        }
        res.setTimeout(IDLE_MS, () => req.destroy(interrupted("the connection went quiet")));
        return onResponse(res).then(resolve, reject);
      },
    );
    req.on("timeout", () => req.destroy(interrupted("connection timed out")));
    req.on("error", (error) => reject(Object.assign(error, { keepPart: true })));
  });
}

/** Size of the bytes already kept in `part`, 0 when there are none. */
function keptBytes(part) {
  try {
    return fs.statSync(part).size;
  } catch {
    return 0;
  }
}

/** `start` and `total` of a `Content-Range: bytes 100-199/200` header, or null. */
function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  return match ? { start: Number(match[1]), total: match[3] === "*" ? 0 : Number(match[3]) } : null;
}

/**
 * One try: continue after the `have` bytes already kept when there are any (a Range request), start over on a 200.
 * A 206 counts only when its range begins exactly at `have`; anything else asks for a clean restart.
 */
function attempt(url, part, have, onProgress) {
  const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
  return request(
    url,
    headers,
    (res) =>
      new Promise((resolve, reject) => {
        const status = Number(res.statusCode || 0);
        let done = 0;
        let total = 0;
        if (status === 206) {
          const range = parseContentRange(res.headers["content-range"]);
          if (have <= 0 || !range || range.start !== have) {
            res.resume();
            return reject(
              Object.assign(new Error("the server sent the wrong range"), { restart: true }),
            );
          }
          done = have;
          total = range.total || have + Number(res.headers["content-length"] || 0);
        } else {
          total = Number(res.headers["content-length"] || 0);
        }
        const sink = fs.createWriteStream(part, { flags: status === 206 ? "a" : "w" });
        const cut = (error) => sink.end(() => reject(error));
        res.on("data", (chunk) => {
          done += chunk.length;
          onProgress({ bytesDone: done, bytesTotal: total });
        });
        res.on("error", (error) => cut(Object.assign(error, { keepPart: true })));
        res.on("aborted", () => cut(interrupted("the connection was cut")));
        sink.on("error", reject);
        sink.on("finish", () => {
          if (total && done !== total) reject(new Error(`got ${done} of ${total} bytes`));
          else resolve(done);
        });
        res.pipe(sink);
      }),
  );
}

/**
 * Download `url` to `out` (through `<out>.part`), calling `onProgress({ bytesDone, bytesTotal })`. A connection that
 * breaks leaves the `.part` file, and the next call asks only for the rest (Range); the caller still checks the whole
 * file's SHA-256 or signature. Any other failure leaves nothing behind.
 */
async function fetchFile(url, out, onProgress = () => {}) {
  const part = `${out}.part`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  let have = keptBytes(part);
  if (have === 0) fs.rmSync(part, { force: true });
  try {
    for (let tries = 0; ; tries += 1) {
      try {
        await attempt(url, part, have, onProgress);
        break;
      } catch (error) {
        const stale = have > 0 && (error.restart || error.status === 416);
        if (!stale || tries > 0) throw error;
        fs.rmSync(part, { force: true });
        have = 0;
      }
    }
    fs.rmSync(out, { force: true });
    fs.renameSync(part, out);
    return fs.statSync(out).size;
  } catch (error) {
    if (!(error && error.keepPart && keptBytes(part) > 0)) fs.rmSync(part, { force: true });
    throw error;
  }
}

/** The row printer: a redrawn coloured row on a console, a plain line every tenth in a log. */
function makeReporter(label, stream = process.stderr, env = process.env, now = Date.now) {
  const board = require("./download-board.cjs");
  const { rollingSpeed } = require("./live-console.cjs");
  const tty = Boolean(stream && stream.isTTY);
  const colour = board.colourWanted(stream, env);
  const samples = [];
  let lastDraw = 0;
  let lastTenth = -1;
  return (progress, state = "running") => {
    const at = now();
    samples.push({ at, bytes: progress.bytesDone });
    while (samples.length > 40) samples.shift();
    const percent = progress.bytesTotal > 0 ? (100 * progress.bytesDone) / progress.bytesTotal : 0;
    const finished = state === "done";
    if (tty && !finished && at - lastDraw < 200) return;
    if (!tty && !finished && Math.floor(percent / 10) === lastTenth) return;
    lastDraw = at;
    lastTenth = Math.floor(percent / 10);
    const speed = rollingSpeed(samples, at) / 1024 ** 2;
    const left =
      speed > 0 && progress.bytesTotal > progress.bytesDone
        ? (progress.bytesTotal - progress.bytesDone) / 1024 ** 2 / speed
        : 0;
    const row = board.renderRow(
      {
        id: label.slice(0, 24),
        state: "running",
        percent: finished ? 100 : percent,
        bytesDone: progress.bytesDone,
        bytesTotal: progress.bytesTotal,
        speed: finished ? 0 : speed,
        eta: finished ? 0 : left,
      },
      Math.min(24, Math.max(8, label.length)),
    );
    const shown = colour ? board.paint(row, finished ? "done" : "running") : row;
    stream.write(tty ? `\r${shown}\x1b[K${finished ? "\n" : ""}` : `${shown}\n`);
  };
}

async function main(argv) {
  const url = argValue(argv, "--url");
  const out = argValue(argv, "--out");
  const label = argValue(argv, "--label") || path.basename(out || "download");
  if (!/^https:\/\//i.test(url) || !out) {
    process.stderr.write(
      "usage: node scripts/fetch-file.cjs --url <https url> --out <file> [--label <name>]\n",
    );
    return 2;
  }
  if (proxyConfigured()) return 3;
  const report = makeReporter(label);
  let last = { bytesDone: 0, bytesTotal: 0 };
  try {
    await fetchFile(url, path.resolve(out), (progress) => {
      last = progress;
      report(progress);
    });
    report({ bytesDone: last.bytesDone, bytesTotal: last.bytesTotal || last.bytesDone }, "done");
    return 0;
  } catch (error) {
    process.stderr.write(`[friday] ${label}: ${String((error && error.message) || error)}\n`);
    return 1;
  }
}

module.exports = {
  fetchFile,
  nextUrl,
  proxyConfigured,
  makeReporter,
  argValue,
  parseContentRange,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
