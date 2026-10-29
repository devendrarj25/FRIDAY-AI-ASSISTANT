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
    const state = readJson(ctx, "turns.json", { n: 0 });
    state.n += 1;
    state.at = Date.now();
    writeJson(ctx, "turns.json", state);
    return { ok: true, n: state.n };
  },
  "on-app-quit": async function (payload, ctx) {
    const state = readJson(ctx, "turns.json", { n: 0 });
    state.quitAt = (payload && payload.at) || Date.now();
    writeJson(ctx, "turns.json", state);
    return { ok: true, n: state.n };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete", "on-app-quit"] };
  },
};
