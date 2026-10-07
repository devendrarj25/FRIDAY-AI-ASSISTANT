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
    writeJson(ctx, "boot.json", {
      at: (payload && payload.at) || Date.now(),
      pid: ctx.os && ctx.os.pid,
    });
    return { ok: true };
  },
  "on-idle": async function (payload, ctx) {
    const boot = readJson(ctx, "boot.json", { at: Date.now() });
    const now = (payload && payload.at) || Date.now();
    writeJson(ctx, "uptime.json", {
      at: now,
      startedAt: boot.at,
      uptimeMs: now - Number(boot.at || now),
    });
    return { ok: true, uptimeMs: now - Number(boot.at || now) };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start", "on-idle"] };
  },
};
