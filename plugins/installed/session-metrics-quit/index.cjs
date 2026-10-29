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
  "on-app-quit": async function (payload, ctx) {
    const snap = ctx.os || {};
    writeJson(ctx, "quit.json", {
      at: (payload && payload.at) || Date.now(),
      uptime: snap.uptime,
      freemem: snap.freemem,
      loadavg: snap.loadavg,
      cpus: snap.cpus,
    });
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-quit"] };
  },
};
