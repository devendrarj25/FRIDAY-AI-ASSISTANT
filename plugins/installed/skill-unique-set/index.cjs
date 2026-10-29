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
    const state = readJson(ctx, "skills.json", { ids: [], n: 0 });
    if (!state.ids.includes(id)) state.ids.push(id);
    state.n += 1;
    state.at = Date.now();
    writeJson(ctx, "skills.json", state);
    return { ok: true, unique: state.ids.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-skill-run"] };
  },
};
