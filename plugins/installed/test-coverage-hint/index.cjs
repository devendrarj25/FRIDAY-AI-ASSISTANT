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
    const files = scan(ctx, 300).filter((r) =>
      /\.(?:js|cjs|mjs|ts|tsx|jsx|py|rs|go|java|cs)$/i.test(r.name),
    );
    const tests = files.filter((r) =>
      /(?:^|[\\/._-])(?:test|tests|spec|__tests__)(?:[\\/._-]|$)/i.test(r.relative),
    );
    const src = files.length - tests.length;
    const ratio = src ? Math.round((tests.length / src) * 100) : 0;
    say(
      ctx,
      src > 15 && ratio < 10 ? "warn" : "info",
      "Tests vs code",
      tests.length +
        " test file(s) for " +
        src +
        " source file(s) (" +
        ratio +
        "%)." +
        (src > 15 && ratio < 10 ? " Very few tests for this much code." : ""),
      { tests: tests.length, source: src, ratio },
    );
    return { ok: true, ratio };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
