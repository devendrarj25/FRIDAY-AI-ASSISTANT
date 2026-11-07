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
    const hour = new Date().getHours();
    const s = jr(ctx, "nights.json", {});
    if (hour >= 1 && hour < 5) {
      const k = dayKey();
      s[k] = (s[k] || 0) + 1;
      for (const old of Object.keys(s).sort().slice(0, -30)) delete s[old];
      jw(ctx, "nights.json", s);
      const n = s[k];
      if (n >= 3)
        say(
          ctx,
          "warn",
          "Working very late",
          n + " turns since 1 a.m. today. Sleep helps more than another prompt.",
          { turns: n },
        );
      else say(ctx, "info", "Late-night turns", n + " turn(s) since 1 a.m. today.", { turns: n });
    } else
      say(ctx, "good", "Daytime hours", "No turns between 1 a.m. and 5 a.m. so far.", {
        turns: s[dayKey()] || 0,
      });
    return { ok: true, late: hour >= 1 && hour < 5 };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-start"] };
  },
};
