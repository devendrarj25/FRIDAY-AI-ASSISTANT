module.exports = {
  register() {},
  "on-error": async function (payload, ctx) {
    const text = String((payload && payload.error) || "").slice(0, 2000);
    ctx.fs.writeFile(
      "last-error.txt",
      JSON.stringify({ at: Date.now(), runId: payload && payload.runId, error: text }, null, 2),
    );
    return { ok: true, bytes: text.length };
  },
  selfTest() {
    return { ok: true, hook: "on-error" };
  },
};
