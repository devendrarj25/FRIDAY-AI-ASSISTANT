function jr(ctx, name, fallback) {
  try {
    return JSON.parse(ctx.fs.readFile(name));
  } catch {
    return fallback;
  }
}
function jw(ctx, name, value) {
  ctx.fs.writeFile(name, JSON.stringify(value));
}
function dayKey(t) {
  const d = new Date(t || Date.now());
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}
function say(ctx, level, title, text, metrics) {
  jw(ctx, "insight.json", { level, title, text, metrics: metrics || {}, at: Date.now() });
}
function top(map, n) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
function norm(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[a-z]:\\[^\s]+|\/[^\s]+/g, "<path>")
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}|\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}
function scan(ctx, max) {
  return ctx.workspace
    .walk(".", { depth: 3, max: max || 300 })
    .filter((r) => !r.directory && !r.symlink);
}
const TEXT_EXT =
  /\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|txt|py|css|html|yml|yaml|toml|ini|cfg|env|sh|ps1|cmd|bat|sql|rs|go|java|c|cpp|h)$/i;

module.exports = {
  register() {},
  "on-turn-complete": async function (payload, ctx) {
    const list = jr(ctx, "ok.json", []);
    list.push(payload && payload.ok === false ? 0 : 1);
    while (list.length > 50) list.shift();
    jw(ctx, "ok.json", list);
    const rate = Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100);
    if (list.length >= 10)
      say(
        ctx,
        rate < 80 ? "warn" : "good",
        "Success rate",
        rate +
          "% of the last " +
          list.length +
          " turns succeeded." +
          (rate < 80 ? " Check the Models page and the error digest." : ""),
        { rate, n: list.length },
      );
    else
      say(ctx, "info", "Success rate", "Collecting data: " + list.length + " of 10 turns seen.", {
        n: list.length,
      });
    return { ok: true, rate };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
