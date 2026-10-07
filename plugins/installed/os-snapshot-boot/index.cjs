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
  "on-app-start": async function (payload, ctx) {
    const snap = ctx.os || {};
    writeJson(ctx, "os.json", {
      at: (payload && payload.at) || Date.now(),
      platform: snap.platform,
      arch: snap.arch,
      cpus: snap.cpus,
      freemem: snap.freemem,
      totalmem: snap.totalmem,
      loadavg: snap.loadavg,
      node: snap.node,
      envKeyCount: snap.envKeyCount,
      envKeys: snap.envKeys,
    });
    return { ok: true, platform: snap.platform };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
