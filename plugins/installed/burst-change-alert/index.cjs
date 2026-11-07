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
  "on-file-change": async function (payload, ctx) {
    const list = jr(ctx, "times.json", []);
    list.push(Date.now());
    while (list.length > 100) list.shift();
    jw(ctx, "times.json", list);
    const recent = list.filter((t) => Date.now() - t < 60000).length;
    if (recent >= 30)
      say(
        ctx,
        "warn",
        "Many files changed at once",
        recent +
          " changes within a minute. Expected after an import or update; otherwise look at what is writing.",
        { recent },
      );
    else
      say(ctx, "good", "File changes are calm", recent + " change(s) in the last minute.", {
        recent,
      });
    return { ok: true, recent };
  },
  selfTest() {
    return { ok: true, hooks: ["on-file-change"] };
  },
};
