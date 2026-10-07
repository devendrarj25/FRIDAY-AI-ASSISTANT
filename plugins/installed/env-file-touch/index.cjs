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
    const base = rel.split(/[\\/]/).pop() || rel;
    const hit = /^\.env/i.test(base);
    if (hit) appendNd(ctx, "env-touch.ndjson", { at: Date.now(), name: base });
    return { ok: true, hit };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
