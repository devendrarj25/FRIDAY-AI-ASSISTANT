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
    const days = jr(ctx, "days.json", {});
    const k = dayKey();
    const d = days[k] || { turns: 0, errors: 0, ms: 0 };
    d.turns += 1;
    if (payload && payload.ok === false) d.errors += 1;
    d.ms += Number(payload && payload.ms) || 0;
    days[k] = d;
    for (const old of Object.keys(days).sort().slice(0, -60)) delete days[old];
    jw(ctx, "days.json", days);
    say(
      ctx,
      "info",
      "Today",
      d.turns +
        " turn(s), " +
        d.errors +
        " failed, about " +
        Math.round(d.ms / d.turns / 100) / 10 +
        "s each.",
      d,
    );
    return { ok: true, turns: d.turns };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
