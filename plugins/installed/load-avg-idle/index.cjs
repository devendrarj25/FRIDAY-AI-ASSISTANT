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
    writeJson(ctx, "idle-load.json", {
      at: (payload && payload.at) || Date.now(),
      loadavg: snap.loadavg,
      freemem: snap.freemem,
      totalmem: snap.totalmem,
    });
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
