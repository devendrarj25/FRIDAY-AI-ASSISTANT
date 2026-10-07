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
  "on-skill-run": async function (payload, ctx) {
    append(
      ctx,
      "skills.ndjson",
      JSON.stringify({
        at: Date.now(),
        skillId: (payload && (payload.skillId || payload.id)) || null,
        name: payload && payload.name,
        ok: payload && payload.ok,
      }),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-skill-run" };
  },
};
