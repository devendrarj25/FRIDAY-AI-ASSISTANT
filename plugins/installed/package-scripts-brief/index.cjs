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
    if (!ctx.workspace.exists("package.json")) {
      say(ctx, "info", "package.json", "No package.json in the workspace.", {});
      return { ok: true, skipped: true };
    }
    let pkg = {};
    try {
      pkg = JSON.parse(ctx.workspace.readFile("package.json", 65536).text);
    } catch {
      say(ctx, "warn", "package.json", "package.json could not be read as JSON.", {});
      return { ok: true, invalid: true };
    }
    const scripts = Object.keys(pkg.scripts || {});
    const deps = Object.keys(pkg.dependencies || {}).length;
    const dev = Object.keys(pkg.devDependencies || {}).length;
    say(
      ctx,
      "info",
      String(pkg.name || "package.json"),
      scripts.length +
        " script(s): " +
        scripts.slice(0, 12).join(", ") +
        ". " +
        deps +
        " dependencies, " +
        dev +
        " dev dependencies.",
      { scripts, deps, dev },
    );
    return { ok: true, scripts: scripts.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start"] };
  },
};
