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
  "on-error": async function (payload, ctx) {
    const now = Date.now();
    const state = readJson(ctx, "burst.json", { times: [], burst: false });
    state.times = [...(state.times || []), now].slice(-5);
    const window = state.times.filter((t) => now - t <= 60000);
    state.burst = window.length >= 3;
    state.at = now;
    writeJson(ctx, "burst.json", state);
    return { ok: true, burst: state.burst, recent: window.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error"] };
  },
};
