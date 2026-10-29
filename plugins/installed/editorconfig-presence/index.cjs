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
  "on-app-start": async function (payload, ctx) {
    let present = false;
    try {
      present = ctx.workspace.exists(".editorconfig");
    } catch {
      present = false;
    }
    writeJson(ctx, "editorconfig.json", { at: Date.now(), present });
    return { ok: true, present };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
