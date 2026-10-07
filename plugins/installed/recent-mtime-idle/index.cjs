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
    let recent = [],
      error = null;
    try {
      recent = ctx.workspace
        .walk(".", { depth: 2, max: 250 })
        .filter((row) => !row.directory)
        .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
        .slice(0, 15)
        .map((row) => ({ relative: row.relative, mtimeMs: row.mtimeMs, size: row.size }));
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "recent.json", { at: Date.now(), recent, error });
    return { ok: true, count: recent.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
