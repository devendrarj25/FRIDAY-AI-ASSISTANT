module.exports = {
  register() {},
  "on-app-start": async function (payload, ctx) {
    const session = {
      id: "sess-" + Date.now().toString(36),
      startedAt: (payload && payload.at) || Date.now(),
      open: true,
    };
    ctx.fs.writeFile("session.json", JSON.stringify(session, null, 2));
    return { ok: true, id: session.id };
  },
  "on-app-quit": async function (payload, ctx) {
    let session = {};
    try {
      session = JSON.parse(ctx.fs.readFile("session.json"));
    } catch {
      session = {};
    }
    session.open = false;
    session.endedAt = (payload && payload.at) || Date.now();
    ctx.fs.writeFile("session.json", JSON.stringify(session, null, 2));
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start", "on-app-quit"] };
  },
};
