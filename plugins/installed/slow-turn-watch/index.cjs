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
    if (ms < 8000) return { ok: true, skipped: true, ms };
    appendNd(ctx, "slow-turns.ndjson", { at: Date.now(), runId: payload && payload.runId, ms });
    return { ok: true, slow: true, ms };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
