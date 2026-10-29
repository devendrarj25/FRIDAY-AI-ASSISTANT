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
    let huge = [],
      error = null;
    try {
      huge = ctx.workspace
        .walk(".", { depth: 2, max: 250 })
        .filter((row) => !row.directory && row.size > 20 * 1024 * 1024)
        .slice(0, 20)
        .map((row) => ({ relative: row.relative, size: row.size }));
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "huge.json", { at: Date.now(), huge, error });
    return { ok: true, count: huge.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
