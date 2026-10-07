module.exports = {
  register() {},
  "on-app-quit": async function (payload, ctx) {
    ctx.fs.writeFile(
      "quit.json",
      JSON.stringify({ at: (payload && payload.at) || Date.now(), closed: true }, null, 2),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-app-quit" };
  },
};
