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
  "on-skill-run": async function (payload, ctx) {
    const hour = new Date().getHours();
    const rates = readJson(ctx, "hourly.json", { hours: {}, n: 0 });
    rates.hours[hour] = (rates.hours[hour] || 0) + 1;
    rates.n += 1;
    rates.at = Date.now();
    writeJson(ctx, "hourly.json", rates);
    return { ok: true, hour };
  },
  selfTest() {
    return { ok: true, hooks: ["on-skill-run"] };
  },
};
