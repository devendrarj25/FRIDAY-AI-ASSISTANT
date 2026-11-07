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
  "on-idle": async function (payload, ctx) {
    const readme = ["README.md", "readme.md", "README"].find((n) => ctx.workspace.exists(n));
    if (!readme) {
      say(ctx, "warn", "No README", "The workspace has no README file.", {});
      return { ok: true, readme: false };
    }
    const m = ctx.workspace.stat(readme).mtimeMs;
    const newest = scan(ctx, 250)
      .filter((r) => TEXT_EXT.test(r.name) && !/readme/i.test(r.name))
      .reduce((a, r) => Math.max(a, r.mtimeMs), 0);
    const days = Math.round((newest - m) / 86400000);
    say(
      ctx,
      days > 60 ? "warn" : "good",
      "README freshness",
      days > 60
        ? "The README is " + days + " days older than the newest file."
        : "The README is up to date with the code.",
      { days },
    );
    return { ok: true, days };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
