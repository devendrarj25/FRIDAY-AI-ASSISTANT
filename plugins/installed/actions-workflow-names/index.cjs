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
    let names = [];
    let error = null;
    try {
      if (ctx.workspace.exists(".github/workflows")) {
        names = ctx.workspace
          .list(".github/workflows")
          .filter((row) => !row.directory)
          .map((row) => row.name);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "workflows.json", { at: Date.now(), names, error });
    return { ok: true, count: names.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
