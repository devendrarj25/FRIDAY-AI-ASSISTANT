// FRIDAY · tools/system/disk-space
//
// fs.statfsSync on the FRIDAY root or checkout.
const path = require("node:path");
const ELECTRON = path.join(__dirname, "..", "..", "..", "electron");

const fs = require("node:fs");
const contract = require(path.join(ELECTRON, "friday-contract.cjs"));

async function run({ root } = {}) {
  const dir = root || contract.rootFromEnv() || contract.CHECKOUT_ROOT;
  if (typeof fs.statfsSync !== "function") {
    return { ok: false, error: "fs.statfsSync is not available in this Node build." };
  }
  try {
    const st = fs.statfsSync(dir);
    const bsize = Number(st.bsize) || 4096;
    const total = Number(st.blocks) * bsize;
    const free = Number(st.bavail != null ? st.bavail : st.bfree) * bsize;
    return {
      ok: true,
      path: dir,
      totalBytes: total,
      freeBytes: free,
      usedPct: total ? Math.round((1 - free / total) * 100) : null,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

module.exports = { run };
