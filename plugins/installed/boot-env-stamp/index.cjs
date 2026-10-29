module.exports = {
  register() {},
  "on-app-start": async function (payload, ctx) {
    ctx.fs.writeFile(
      "boot.json",
      JSON.stringify(
        {
          at: (payload && payload.at) || Date.now(),
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          pid: process.pid,
        },
        null,
        2,
      ),
    );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hook: "on-app-start" };
  },
};
