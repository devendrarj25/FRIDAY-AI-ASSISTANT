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
    if (!/\.md$/i.test(rel)) return { ok: true, skipped: true };
    let headings = 0,
      error = null;
    try {
      const text = ctx.workspace.readFile(rel, 65536).text || "";
      headings = text.split(/\n/).filter((line) => /^#{1,6}\s+/.test(line)).length;
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "headings.json", {
      at: Date.now(),
      relative: rel.slice(0, 240),
      headings,
      error,
    });
    return { ok: true, headings };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
