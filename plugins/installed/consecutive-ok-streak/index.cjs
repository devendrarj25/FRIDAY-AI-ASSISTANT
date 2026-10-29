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
    const ok = payload && payload.ok !== false;
    const state = readJson(ctx, "streak.json", { streak: 0, best: 0 });
    state.streak = ok ? state.streak + 1 : 0;
    if (state.streak > state.best) state.best = state.streak;
    state.at = Date.now();
    writeJson(ctx, "streak.json", state);
    return { ok: true, streak: state.streak, best: state.best };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
