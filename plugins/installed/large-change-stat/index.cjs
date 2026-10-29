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
  "on-file-change": async function (payload, ctx) {
    const rel = String((payload && (payload.relative || payload.file)) || "");
    if (!rel) return { ok: true, skipped: true };
    let info = null,
      error = null;
    try {
      info = ctx.workspace.stat(rel);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const large = Boolean(info && !info.directory && info.size > 5 * 1024 * 1024);
    if (large)
      appendNd(ctx, "large.ndjson", {
        at: Date.now(),
        relative: rel.slice(0, 240),
        size: info.size,
      });
    writeJson(ctx, "last.json", {
      at: Date.now(),
      relative: rel.slice(0, 240),
      size: info && info.size,
      large,
      error,
    });
    return { ok: true, large };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
