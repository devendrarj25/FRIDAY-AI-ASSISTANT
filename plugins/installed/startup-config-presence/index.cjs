module.exports = {
  register() {},
  "on-app-start": async function (payload, ctx) {
    let present = false;
    let error = null;
    try {
      present = Boolean(ctx.workspace && ctx.workspace.exists("config"));
    } catch (err) {
      error = String((err && err.message) || err);
    }
    ctx.fs.writeFile(
      "config-presence.json",
      JSON.stringify({ at: (payload && payload.at) || Date.now(), present, error }, null, 2),
    );
    return { ok: true, present };
  },
  selfTest() {
    return { ok: true, hook: "on-app-start" };
  },
};
