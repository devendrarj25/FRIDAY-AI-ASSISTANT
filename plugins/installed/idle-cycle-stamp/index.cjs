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
  "on-idle": async function (payload, ctx) {
    append(
      ctx,
      "idle.ndjson",
      JSON.stringify({
        at: (payload && payload.at) || Date.now(),
        discovered: payload && payload.discovered,
        researched: payload && payload.researched,
        note: payload && payload.note,
      }),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-idle" };
  },
};
