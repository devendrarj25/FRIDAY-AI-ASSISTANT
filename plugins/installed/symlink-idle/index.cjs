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
    let links = [],
      error = null;
    try {
      links = ctx.workspace
        .walk(".", { depth: 2, max: 250 })
        .filter((row) => row.symlink)
        .slice(0, 20)
        .map((row) => row.relative);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "symlinks.json", { at: Date.now(), links, error });
    return { ok: true, count: links.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
