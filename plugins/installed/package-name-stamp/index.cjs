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
    let name = null,
      version = null,
      error = null;
    try {
      if (ctx.workspace.exists("package.json")) {
        const parsed = JSON.parse(ctx.workspace.readFile("package.json", 65536).text || "{}");
        name = typeof parsed.name === "string" ? parsed.name : null;
        version = typeof parsed.version === "string" ? parsed.version : null;
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "package.json", { at: Date.now(), name, version, error });
    return { ok: true, name };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
