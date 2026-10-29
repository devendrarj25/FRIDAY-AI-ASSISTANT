const crypto = require("node:crypto");
async function run({ min = 0, max = 100 } = {}) {
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    return { ok: false, error: "Need a min <= max." };
  }
  if (hi - lo > 1_000_000) return { ok: false, error: "Span is too wide (max 1e6)." };
  return { ok: true, value: crypto.randomInt(Math.floor(lo), Math.floor(hi) + 1) };
}
module.exports = { run };
