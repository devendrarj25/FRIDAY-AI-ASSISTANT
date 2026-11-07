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
    const now = Date.now();
    const s = jr(ctx, "block.json", { start: now, last: now });
    if (now - s.last > 20 * 60000) s.start = now;
    s.last = now;
    jw(ctx, "block.json", s);
    const mins = Math.round((now - s.start) / 60000);
    if (mins >= 90)
      say(
        ctx,
        "warn",
        "Take a break",
        "You have been working for " +
          mins +
          " minutes without a 20-minute gap. Stand up, drink water, rest your eyes.",
        { minutes: mins },
      );
    else if (mins >= 45)
      say(
        ctx,
        "info",
        "Working block",
        mins + " minutes so far. A short break around 90 minutes keeps you sharp.",
        { minutes: mins },
      );
    else say(ctx, "good", "Fresh block", mins + " minute(s) into this block.", { minutes: mins });
    return { ok: true, minutes: mins };
  },
  selfTest() {
    return { ok: true, hooks: ["on-turn-complete"] };
  },
};
