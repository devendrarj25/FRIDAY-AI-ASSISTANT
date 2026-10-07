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
    const counts = {};
    let error = null,
      n = 0;
    try {
      for (const row of ctx.workspace.walk(".", { depth: 2, max: 250 })) {
        if (row.directory) continue;
        const ext = (row.name.split(".").pop() || "").toLowerCase();
        if (!ext || ext === row.name.toLowerCase()) continue;
        counts[ext] = (counts[ext] || 0) + 1;
        n += 1;
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "ext.json", { at: Date.now(), n, counts, error });
    return { ok: true, n };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
