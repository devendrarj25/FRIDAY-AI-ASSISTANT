/**
 * Pack-time staging for the bundled toolchain tier.
 * Downloads each pinned archive, checks SHA-256 and size, and writes it
 * under resources/toolchain or resources/speech. Binaries are not committed.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SPEECH_IDS = new Set(["whisper-cpp", "ggml-base", "ggml-tiny"]);

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
      sha256: String(pack.sha256 || ""),
      bytes: packBytes(pack),
      dest: SPEECH_IDS.has(pack.id) ? "speech" : "toolchain",
    })),
    sum,
    budget,
    errors,
  };
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function stageBundledPacks({ manifest, cacheDir, stageDir, fetchImpl }) {
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
      const res = await fetchImpl(pack.url);
      body = Buffer.isBuffer(res) ? res : Buffer.from(res?.body || []);
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

async function beforePack() {
  if (process.env.FRIDAY_SKIP_TOOLCHAIN_STAGE === "1") return { skipped: true };
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config/toolchain-manifest.json"), "utf8"),
  );
  const fetchImpl = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
    return { body: Buffer.from(await res.arrayBuffer()) };
  };
  return stageBundledPacks({
    manifest,
    cacheDir: path.join(__dirname, "../.cache/toolchain"),
    stageDir: path.join(__dirname, "../resources"),
    fetchImpl,
  });
}

module.exports = beforePack;
module.exports.stagePlan = stagePlan;
module.exports.stageBundledPacks = stageBundledPacks;
module.exports.sha256 = sha256;
module.exports.beforePack = beforePack;
