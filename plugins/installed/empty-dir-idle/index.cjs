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
    let empty = [],
      error = null;
    try {
      const rows = ctx.workspace.walk(".", { depth: 2, max: 250 }).filter((row) => row.directory);
      for (const row of rows) {
        let kids = [];
        try {
          kids = ctx.workspace.list(row.relative);
        } catch {
          continue;
        }
        if (!kids.length) empty.push(row.relative);
        if (empty.length >= 20) break;
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "empty.json", { at: Date.now(), empty, error });
    return { ok: true, count: empty.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
