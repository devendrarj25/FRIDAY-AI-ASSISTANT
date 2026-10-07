function readJson(ctx, name, fallback) {
  try {
    return JSON.parse(ctx.fs.readFile(name));
  } catch {
    return fallback;
  }
}
function writeJson(ctx, name, value) {
  ctx.fs.writeFile(name, JSON.stringify(value, null, 2));
}
function appendNd(ctx, name, row) {
  let prev = "";
  try {
    prev = ctx.fs.readFile(name);
  } catch {
    prev = "";
  }
  ctx.fs.writeFile(name, prev + JSON.stringify(row) + "\n");
}
module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    const ms = Number(payload && payload.ms) || 0;
    const peak = readJson(ctx, "peak.json", { ms: 0, runId: null });
    if (ms > Number(peak.ms || 0)) {
      peak.ms = ms;
      peak.runId = payload && payload.runId;
      peak.at = Date.now();
      writeJson(ctx, "peak.json", peak);
    }
    return { ok: true, peakMs: peak.ms };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
