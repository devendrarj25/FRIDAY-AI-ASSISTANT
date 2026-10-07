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
  "on-file-change": async function (payload, ctx) {
    append(
      ctx,
      "changes.ndjson",
      JSON.stringify({
        at: (payload && payload.at) || Date.now(),
        component: payload && payload.component,
        file: payload && payload.file,
        relative: payload && payload.relative,
      }),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-file-change" };
  },
};
