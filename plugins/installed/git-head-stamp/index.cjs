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
    let head = null;
    let error = null;
    try {
      if (ctx.workspace.exists(".git/HEAD")) {
        head = String(ctx.workspace.readFile(".git/HEAD", 4096).text || "")
          .trim()
          .slice(0, 200);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "head.json", { at: Date.now(), head, error });
    return { ok: true, present: Boolean(head) };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
