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
  "on-turn-start": async function (payload, ctx) {
    append(
      ctx,
      "starts.ndjson",
      JSON.stringify({
        at: Date.now(),
        runId: payload && payload.runId,
        intent: payload && payload.intent,
      }),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-turn-start" };
  },
};
