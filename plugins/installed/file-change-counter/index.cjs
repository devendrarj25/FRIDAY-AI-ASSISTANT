module.exports = {
  register() {},
  "on-file-change": async function (payload, ctx) {
    let count = 0;
    try {
      count = Number(JSON.parse(ctx.fs.readFile("count.json")).count) || 0;
    } catch {
      count = 0;
    }
    const next = { count: count + 1, last: (payload && payload.relative) || null, at: Date.now() };
    ctx.fs.writeFile("count.json", JSON.stringify(next, null, 2));
    return { ok: true, count: next.count };
  },
  selfTest() {
    return { ok: true, hook: "on-file-change" };
  },
};
