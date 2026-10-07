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
    const offset = new Date().getTimezoneOffset();
    writeJson(ctx, "tz.json", {
      at: Date.now(),
      offsetMinutes: offset,
      iso: new Date().toISOString(),
    });
    return { ok: true, offsetMinutes: offset };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
