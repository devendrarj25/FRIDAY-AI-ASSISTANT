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
    const names = [];
    let error = null;
    try {
      if (ctx.workspace.exists(".git/config")) {
        const text = String(ctx.workspace.readFile(".git/config", 65536).text || "");
        const re = /\[remote\s+"([^"]+)"\]/g;
        let match;
        while ((match = re.exec(text))) names.push(match[1]);
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    writeJson(ctx, "remotes.json", { at: Date.now(), names, error });
    return { ok: true, names };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
