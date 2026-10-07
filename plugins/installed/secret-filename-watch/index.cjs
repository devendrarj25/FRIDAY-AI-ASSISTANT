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
    const hit =
      /(?:^|\.)env(?:$|\.)|^id_rsa$|\.pem$|\.p12$|\.pfx$|credentials\.json$|secrets?\.|\.key$/i.test(
        base,
      );
    if (hit)
      appendNd(ctx, "hits.ndjson", { at: Date.now(), relative: rel.slice(0, 240), name: base });
    return { ok: true, hit };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
