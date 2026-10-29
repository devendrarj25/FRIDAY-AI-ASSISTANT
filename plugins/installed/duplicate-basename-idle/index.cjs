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
    const byName = {};
    let error = null;
    try {
      for (const row of ctx.workspace.walk(".", { depth: 2, max: 250 })) {
        if (row.directory) continue;
        byName[row.name] = byName[row.name] || [];
        byName[row.name].push(row.relative);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const dupes = Object.entries(byName)
      .filter(([, paths]) => paths.length > 1)
      .slice(0, 20)
      .map(([name, paths]) => ({ name, paths }));
    writeJson(ctx, "dupes.json", { at: Date.now(), dupes, error });
    return { ok: true, count: dupes.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
