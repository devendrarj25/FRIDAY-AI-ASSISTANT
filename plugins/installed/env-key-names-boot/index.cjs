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
    const keys = ((ctx.os && ctx.os.envKeys) || []).slice();
    writeJson(ctx, "env-keys.json", { at: Date.now(), count: keys.length, keys });
    return { ok: true, count: keys.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
