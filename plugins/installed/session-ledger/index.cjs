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
  "on-app-start": async function (payload, ctx) {
    const prev = jr(ctx, "session.json", null);
    if (prev && prev.turns) jw(ctx, "last.json", prev);
    jw(ctx, "session.json", { startedAt: Date.now(), turns: 0, errors: 0, ms: 0 });
    const last = jr(ctx, "last.json", null);
    say(
      ctx,
      "info",
      last ? "Last session" : "First session",
      last
        ? "Last time: " +
            last.turns +
            " turn(s), " +
            last.errors +
            " failed, " +
            Math.round((last.ms || 0) / 1000) +
            "s of answering, on " +
            dayKey(last.startedAt) +
            "."
        : "FRIDAY has started recording sessions.",
      last || {},
    );
    return { ok: true };
  },
  "on-turn-complete": async function (payload, ctx) {
    const s = jr(ctx, "session.json", { startedAt: Date.now(), turns: 0, errors: 0, ms: 0 });
    s.turns += 1;
    if (payload && payload.ok === false) s.errors += 1;
    s.ms += Number(payload && payload.ms) || 0;
    jw(ctx, "session.json", s);
    return { ok: true, turns: s.turns };
  },
  "on-app-quit": async function (payload, ctx) {
    const s = jr(ctx, "session.json", null);
    if (s) jw(ctx, "last.json", { ...s, endedAt: Date.now() });
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start", "on-app-quit", "on-turn-complete"] };
  },
};
