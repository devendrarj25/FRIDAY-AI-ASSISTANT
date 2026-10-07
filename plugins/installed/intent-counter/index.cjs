function readJson(ctx, name, fallback) {
  try {
    return JSON.parse(ctx.fs.readFile(name));
  } catch {
    return fallback;
  }
}
function writeJson(ctx, name, value) {
  ctx.fs.writeFile(name, JSON.stringify(value, null, 2));
}
function appendNd(ctx, name, row) {
  let prev = "";
  try {
    prev = ctx.fs.readFile(name);
  } catch {
    prev = "";
  }
  ctx.fs.writeFile(name, prev + JSON.stringify(row) + "\n");
}
module.exports = {
  register() {},
  "on-turn-start": async function (payload, ctx) {
    const intent = String((payload && payload.intent) || "unknown");
    const tally = readJson(ctx, "intents.json", { counts: {}, n: 0 });
    tally.counts[intent] = (tally.counts[intent] || 0) + 1;
    tally.n += 1;
    tally.at = Date.now();
    writeJson(ctx, "intents.json", tally);
    return { ok: true, intent, n: tally.n };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-start"] };
  },
};
