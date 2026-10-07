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
    const day = new Date().toISOString().slice(0, 10);
    const state = readJson(ctx, "days.json", { days: {} });
    state.days[day] = (state.days[day] || 0) + 1;
    writeJson(ctx, "days.json", state);
    return { ok: true, day, n: state.days[day] };
  },
  "on-idle": async function (payload, ctx) {
    const state = readJson(ctx, "days.json", { days: {} });
    const days = Object.entries(state.days || {}).map(([day, n]) => ({ day, n }));
    writeJson(ctx, "rollup.json", {
      at: (payload && payload.at) || Date.now(),
      days: days.slice(-14),
    });
    return { ok: true, days: days.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change", "on-idle"] };
  },
};
