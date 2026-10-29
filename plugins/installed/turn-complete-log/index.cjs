function append(ctx, name, line) {
  let prev = "";
  try {
    prev = ctx.fs.readFile(name);
  } catch {
    prev = "";
  }
  ctx.fs.writeFile(name, prev + line + "\n");
}
module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    append(
      ctx,
      "turns.ndjson",
      JSON.stringify({
        at: Date.now(),
        runId: payload && payload.runId,
        ms: payload && payload.ms,
        ok: payload && payload.ok,
      }),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-turn-complete" };
  },
};
