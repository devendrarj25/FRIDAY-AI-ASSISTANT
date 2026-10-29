module.exports = {
  register() {},
  "on-idle": async function (payload, ctx) {
    let names = [];
    let error = null;
    try {
      names = (ctx.workspace.list(".") || []).map((row) => row.name);
    } catch (err) {
      error = String((err && err.message) || err);
    }
    ctx.fs.writeFile(
      "top.json",
      JSON.stringify({ at: (payload && payload.at) || Date.now(), names, error }, null, 2),
    );
    return { ok: true, count: names.length };
  },
  selfTest() {
    return { ok: true, hook: "on-idle" };
  },
};
