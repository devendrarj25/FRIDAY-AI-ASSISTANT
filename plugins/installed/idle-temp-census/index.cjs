module.exports = {
  register() {},
  "on-idle": async function (payload, ctx) {
    let entries = [];
    let error = null;
    try {
      if (ctx.workspace && ctx.workspace.exists("temporary")) {
        entries = ctx.workspace.list("temporary");
      }
    } catch (err) {
      error = String((err && err.message) || err);
    }
    const report = {
      at: (payload && payload.at) || Date.now(),
      folder: "temporary",
      count: Array.isArray(entries) ? entries.length : 0,
      sample: (entries || []).slice(0, 20).map((row) => row.name),
      error,
    };
    ctx.fs.writeFile("census.json", JSON.stringify(report, null, 2));
    return { ok: true, count: report.count };
  },
  selfTest() {
    return { ok: true, hook: "on-idle" };
  },
};
