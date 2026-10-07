module.exports = {
  register() {},
  "on-error": async function (payload, ctx) {
    let rows = [];
    try {
      rows = JSON.parse(ctx.fs.readFile("errors.json"));
    } catch {
      rows = [];
    }
    if (!Array.isArray(rows)) rows = [];
    rows.unshift({
      at: Date.now(),
      runId: payload && payload.runId,
      error: String((payload && payload.error) || "").slice(0, 400),
    });
    ctx.fs.writeFile("errors.json", JSON.stringify(rows.slice(0, 20), null, 2));
    return { ok: true, kept: Math.min(rows.length, 20) };
  },
  selfTest() {
    return { ok: true, hook: "on-error" };
  },
};
