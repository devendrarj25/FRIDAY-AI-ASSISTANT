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
  "on-error": async function (payload, ctx) {
    const key = norm(payload && payload.error) || "unknown error";
    const m = jr(ctx, "groups.json", {});
    m[key] = (m[key] || 0) + 1;
    const keep = Object.fromEntries(top(m, 40));
    jw(ctx, "groups.json", keep);
    const times = jr(ctx, "times.json", []);
    times.push(Date.now());
    while (times.length > 50) times.shift();
    jw(ctx, "times.json", times);
    const lastHour = times.filter((t) => Date.now() - t < 3600000).length;
    const t3 = top(keep, 3);
    say(
      ctx,
      lastHour >= 5 ? "warn" : "info",
      lastHour >= 5 ? "Errors are piling up" : "Common failures",
      t3.map(([k, v]) => v + "x " + k).join("; "),
      { lastHour },
    );
    return { ok: true, lastHour };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error"] };
  },
};
