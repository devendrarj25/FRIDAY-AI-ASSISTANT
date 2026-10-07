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
    const depth = rel.split(/[\\/]/).filter(Boolean).length;
    if (depth >= 8)
      appendNd(ctx, "deep.ndjson", { at: Date.now(), relative: rel.slice(0, 240), depth });
    return { ok: true, depth };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
