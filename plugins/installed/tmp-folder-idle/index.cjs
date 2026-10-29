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
  "on-idle": async function (payload, ctx) {
    const names = ["tmp", "temp", "temporary", ".cache", ".tmp"];
    const present = {};
    for (const name of names) {
      try {
        present[name] = ctx.workspace.exists(name);
      } catch {
        present[name] = false;
      }
    }
    writeJson(ctx, "tmp.json", { at: Date.now(), present });
    return { ok: true, present };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
