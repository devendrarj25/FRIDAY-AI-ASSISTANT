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
    const hit = [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "poetry.lock",
      "composer.lock",
      "cargo.lock",
    ].includes(base);
    if (hit) appendNd(ctx, "lock-touch.ndjson", { at: Date.now(), name: base });
    return { ok: true, hit };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
