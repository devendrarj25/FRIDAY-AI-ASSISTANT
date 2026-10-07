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
    const text = String((payload && payload.error) || "").toLowerCase();
    const kind = /timeout|timed out/.test(text)
      ? "timeout"
      : /network|econn|enotfound|fetch/.test(text)
        ? "network"
        : /permission|denied|unauthorized|eacces/.test(text)
          ? "permission"
          : "other";
    const tally = readJson(ctx, "kinds.json", {
      timeout: 0,
      network: 0,
      permission: 0,
      other: 0,
      n: 0,
    });
    tally[kind] += 1;
    tally.n += 1;
    tally.at = Date.now();
    writeJson(ctx, "kinds.json", tally);
    return { ok: true, kind, n: tally.n };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error"] };
  },
};
