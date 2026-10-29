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
  "on-turn-complete": async function (payload, ctx) {
    const ms = Number(payload && payload.ms) || 0;
    const key = ms < 1000 ? "lt1s" : ms < 4000 ? "lt4s" : ms < 8000 ? "lt8s" : "gte8s";
    const hist = readJson(ctx, "histogram.json", { lt1s: 0, lt4s: 0, lt8s: 0, gte8s: 0, n: 0 });
    hist[key] += 1;
    hist.n += 1;
    hist.at = Date.now();
    writeJson(ctx, "histogram.json", hist);
    return { ok: true, key, n: hist.n };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
