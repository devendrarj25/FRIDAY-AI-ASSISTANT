/**
 * Pack-time staging for the bundled toolchain tier.
 * Downloads each pinned archive (primary URL, then pinned mirrors, with a
 * progress bar, resume and retries), checks SHA-256 and size, and writes it
 * under resources/toolchain or resources/speech. Binaries are not committed.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const layout = require("../electron/runtime-layout.cjs");

function packBytes(pack) {
  return Number(pack?.bytes || 0);
}

function stagePlan(manifest) {
  const packs = (manifest?.packs || []).filter((pack) => pack.tier === "bundled");
  const budget = Number(manifest?.budgetBytes || 0);
  const sum = packs.reduce((total, pack) => total + packBytes(pack), 0);
  const errors = [];
  if (budget && sum > budget) errors.push(`bundled tier ${sum} exceeds budget ${budget}`);
  for (const pack of packs) {
    const license = String(pack.license || "");
    if (/GPL|LGPL/i.test(license)) {
      errors.push(`${pack.id} is copyleft and stays on demand`);
    }
    if (!pack.sha256) errors.push(`${pack.id} has no sha256`);
    if (!packBytes(pack)) errors.push(`${pack.id} has no size`);
  }
  return {
    packs: packs.map((pack) => ({
      id: pack.id,
      url: pack.url,
      urls: sourceUrls(pack),
      sha256: String(pack.sha256 || ""),
      bytes: packBytes(pack),
      dest: layout.destFor(pack.id),
    })),
    sum,
    budget,
    errors,
  };
}

/**
 * Primary URL first, then the pinned mirrors. A mirror is only a different road
 * to the same bytes: every candidate is checked against the pinned SHA-256 and
 * size, so a wrong or tampered mirror fails and the next source is tried.
 * hf-mirror.com stays opt-in (FRIDAY_HF_MIRROR=1), as in the app downloader.
 */
function sourceUrls(pack, env = process.env) {
  const urls = [pack.url, ...(Array.isArray(pack.mirrors) ? pack.mirrors : [])].filter(Boolean);
  return urls.filter((url, index) => {
    let host = "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      host = parsed.hostname.toLowerCase();
    } catch {
      return false;
    }
    if (host === "hf-mirror.com") return String(env.FRIDAY_HF_MIRROR || "") === "1";
    return urls.indexOf(url) === index;
  });
}

/** One progress line for a pack download; a TTY redraws it, a log prints every 10 percent. */
function progressLine(id, event, tty) {
  if (!event || event.progress == null) return "";
  const percent = Math.max(0, Math.min(100, Math.round(event.progress)));
  const width = 24;
  const filled = Math.round((percent / 100) * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  const speed = event.speedMbps ? ` ${event.speedMbps} MB/s` : "";
  const eta = event.etaSeconds ? ` eta ${event.etaSeconds}s` : "";
  // Real sizes and the number of connections, when the downloader reports them.
  const mb = (bytes) => (Number(bytes) / 1024 ** 2).toFixed(Number(bytes) < 10 * 1024 ** 2 ? 1 : 0);
  const size = event.bytesTotal > 0 ? ` ${mb(event.bytesDone)}/${mb(event.bytesTotal)} MB` : "";
  const conns = event.connections > 0 ? ` ${event.connections} conn` : "";
  const line = `[friday] ${id.padEnd(14)} [${bar}] ${String(percent).padStart(3)}%${size}${speed}${eta}${conns}`;
  // \x1b[K clears what a longer earlier line left behind on the same row.
  if (tty) return `\r${line}\x1b[K`;
  return percent % 10 === 0 ? line : "";
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function stageBundledPacks({
  manifest,
  cacheDir,
  stageDir,
  fetchImpl,
  offline = false,
  log = () => {},
}) {
  const plan = stagePlan(manifest);
  if (plan.errors.length) {
    const error = new Error(plan.errors.join("; "));
    error.errors = plan.errors;
    throw error;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const staged = [];
  for (const pack of plan.packs) {
    const cacheFile = path.join(cacheDir, `${pack.sha256}.bin`);
    let body = null;
    if (fs.existsSync(cacheFile)) body = fs.readFileSync(cacheFile);
    if (!body) {
      if (offline) {
        const error = new Error(`offline build: ${pack.id} is not in the staging cache`);
        error.errors = ["offline"];
        throw error;
      }
      const failures = [];
      for (const url of pack.urls) {
        try {
          const res = await fetchImpl(url, { pack, log });
          const got = Buffer.isBuffer(res) ? res : Buffer.from(res?.body || []);
          if (got.length !== pack.bytes || sha256(got) !== pack.sha256) {
            failures.push(`${new URL(url).hostname}: failed SHA-256 or size check`);
            continue;
          }
          body = got;
          break;
        } catch (err) {
          failures.push(`${new URL(url).hostname}: ${String((err && err.message) || err)}`);
          log(`[friday] ${pack.id}: ${failures[failures.length - 1]}; trying the next source`);
        }
      }
      if (!body) {
        const checked = failures.some((line) => line.includes("SHA-256"));
        const error = new Error(
          checked
            ? `${pack.id} failed SHA-256 or size check (${failures.join("; ")})`
            : `${pack.id} could not be downloaded (${failures.join("; ")})`,
        );
        error.errors = [checked ? "sha256" : "download"];
        throw error;
      }
    }
    if (body.length !== pack.bytes || sha256(body) !== pack.sha256) {
      const error = new Error(`${pack.id} failed SHA-256 or size check`);
      error.errors = ["sha256"];
      throw error;
    }
    if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, body);
    const destDir = path.join(stageDir, pack.dest, pack.id);
    fs.mkdirSync(destDir, { recursive: true });
    const destFile = path.join(destDir, "pack.bin");
    fs.writeFileSync(destFile, body);
    staged.push({ id: pack.id, file: destFile, bytes: body.length, dest: pack.dest });
  }
  return { staged, sum: plan.sum, budget: plan.budget };
}

async function beforePack(options = {}) {
  if (process.env.FRIDAY_SKIP_TOOLCHAIN_STAGE === "1") return { skipped: true };
  const offline = options.offline === true || process.env.FRIDAY_OFFLINE === "1";
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config/toolchain-manifest.json"), "utf8"),
  );
  const { downloadUrl } = require("../electron/model-download.cjs");
  const tty = Boolean(process.stdout.isTTY);
  const fetchImpl = async (url, { pack } = {}) => {
    const temp = path.join(__dirname, "../.cache/toolchain", `${pack?.sha256 || "pack"}.download`);
    let lastLine = "";
    try {
      await downloadUrl(url, temp, {
        label: pack?.id || "pack",
        sha256: pack?.sha256,
        needBytes: pack?.bytes,
        extraHosts: [url, "https://cdn.npmmirror.com"],
        onEvent: (event) => {
          const line = progressLine(pack?.id || "pack", event, tty);
          if (line && line !== lastLine) {
            lastLine = line;
            process.stdout.write(tty ? line : `${line}\n`);
          }
        },
      });
      if (tty) process.stdout.write("\n");
      return { body: fs.readFileSync(temp) };
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  return stageBundledPacks({
    manifest,
    cacheDir: path.join(__dirname, "../.cache/toolchain"),
    stageDir: path.join(__dirname, "../resources"),
    fetchImpl,
    offline,
    log: (line) => console.log(line),
  });
}

module.exports = beforePack;
module.exports.stagePlan = stagePlan;
module.exports.stageBundledPacks = stageBundledPacks;
module.exports.sha256 = sha256;
module.exports.sourceUrls = sourceUrls;
module.exports.progressLine = progressLine;
module.exports.beforePack = beforePack;
