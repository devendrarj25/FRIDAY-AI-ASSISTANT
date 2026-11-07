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
  "on-turn-start": async function (payload, ctx) {
    const h = jr(ctx, "hours.json", new Array(24).fill(0));
    h[new Date().getHours()] += 1;
    jw(ctx, "hours.json", h);
    const total = h.reduce((a, b) => a + b, 0);
    if (total >= 10) {
      const peak = h.indexOf(Math.max(...h));
      say(
        ctx,
        "info",
        "Your busiest hour",
        "Most turns happen around " +
          String(peak).padStart(2, "0") +
          ":00 (" +
          h[peak] +
          " of " +
          total +
          ").",
        { peak, total },
      );
    } else
      say(ctx, "info", "Your busiest hour", "Learning your day: " + total + " of 10 turns seen.", {
        total,
      });
    return { ok: true, total };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-start"] };
  },
};
