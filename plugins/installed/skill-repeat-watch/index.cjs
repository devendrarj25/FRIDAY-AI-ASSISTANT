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
    const id = String((payload && (payload.skillId || payload.label)) || "unknown");
    const state = readJson(ctx, "repeat.json", { last: null, repeats: 0 });
    const repeated = state.last === id;
    if (repeated) state.repeats += 1;
    state.last = id;
    state.at = Date.now();
    writeJson(ctx, "repeat.json", state);
    return { ok: true, repeated, last: id };
  },
  selfTest() {
    return { ok: true, hooks: ["on-skill-run"] };
  },
};
