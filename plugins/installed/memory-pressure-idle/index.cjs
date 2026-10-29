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
  "on-idle": async function (payload, ctx) {
    const snap = ctx.os || {};
    const total = Number(snap.totalmem) || 0;
    const free = Number(snap.freemem) || 0;
    const ratio = total ? free / total : 0;
    writeJson(ctx, "pressure.json", {
      at: Date.now(),
      free,
      total,
      ratio: Number(ratio.toFixed(4)),
      pressure: ratio < 0.1,
    });
    return { ok: true, pressure: ratio < 0.1 };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
