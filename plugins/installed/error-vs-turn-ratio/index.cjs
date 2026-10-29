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
    const state = readJson(ctx, "ratio.json", { errors: 0, turns: 0 });
    state.errors += 1;
    state.ratio = state.turns ? Number((state.errors / state.turns).toFixed(3)) : state.errors;
    state.at = Date.now();
    writeJson(ctx, "ratio.json", state);
    return { ok: true, ratio: state.ratio };
  },
  "on-turn-complete": async function (payload, ctx) {
    const state = readJson(ctx, "ratio.json", { errors: 0, turns: 0 });
    state.turns += 1;
    state.ratio = state.turns ? Number((state.errors / state.turns).toFixed(3)) : 0;
    state.at = Date.now();
    writeJson(ctx, "ratio.json", state);
    return { ok: true, ratio: state.ratio };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error", "on-turn-complete"] };
  },
};
