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
    const base = (rel.split(/[\\/]/).pop() || "").toLowerCase();
    const watched = [
      "package.json",
      "tsconfig.json",
      "jsconfig.json",
      "plugin.json",
      "skill.json",
      "tool.json",
      "manifest.json",
      "friday-version.json",
    ];
    if (!watched.includes(base)) return { ok: true, skipped: true };
    let okParse = false,
      error = null;
    try {
      JSON.parse(ctx.workspace.readFile(rel, 65536).text || "null");
      okParse = true;
    } catch (err) {
      error = String((err && err.message) || err).slice(0, 200);
    }
    writeJson(ctx, "last-json.json", {
      at: Date.now(),
      relative: rel.slice(0, 240),
      ok: okParse,
      error,
    });
    return { ok: true, okParse };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
