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
    const ms = Number(payload && payload.ms);
    const list = jr(ctx, "ms.json", []);
    if (Number.isFinite(ms) && ms > 0) list.push(ms);
    while (list.length > 100) list.shift();
    jw(ctx, "ms.json", list);
    if (list.length >= 5) {
      const sorted = list.slice().sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      say(
        ctx,
        p90 > 30000 ? "warn" : "info",
        "Answer speed",
        "Median " +
          Math.round(p50 / 100) / 10 +
          "s, slowest tenth above " +
          Math.round(p90 / 100) / 10 +
          "s over " +
          sorted.length +
          " turns." +
          (p90 > 30000 ? " Consider a smaller or local model for quick questions." : ""),
        { p50, p90, n: sorted.length },
      );
    } else
      say(ctx, "info", "Answer speed", "Collecting data: " + list.length + " of 5 turns seen.", {
        n: list.length,
      });
    return { ok: true, n: list.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
