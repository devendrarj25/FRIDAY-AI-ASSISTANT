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
  "on-error": async function (payload, ctx) {
    const preview = String((payload && payload.error) || "").slice(0, 200);
    writeJson(ctx, "last-error.json", {
      at: Date.now(),
      preview,
      runId: payload && payload.runId,
      ms: payload && payload.ms,
    });
    return { ok: true, chars: preview.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error"] };
  },
};
