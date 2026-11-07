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
    const names = (rel) => {
      if (!ctx.workspace.exists(rel)) return null;
      const text = ctx.workspace.readFile(rel, 32768).text;
      return new Set(
        (text.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm) || []).map((l) =>
          l.replace(/^\s*(?:export\s+)?/, "").replace(/\s*=$/, ""),
        ),
      );
    };
    const real = names(".env");
    const example = names(".env.example");
    if (!real || !example) {
      say(
        ctx,
        "info",
        "Env files",
        real || example ? "Only one of .env and .env.example exists." : "No .env files here.",
        {},
      );
      return { ok: true, skipped: true };
    }
    const missingInExample = [...real].filter((k) => !example.has(k));
    const missingInEnv = [...example].filter((k) => !real.has(k));
    const bad = missingInExample.length + missingInEnv.length;
    say(
      ctx,
      bad ? "warn" : "good",
      "Env files",
      bad
        ? "Not in .env.example: " +
            (missingInExample.join(", ") || "none") +
            ". Not in .env: " +
            (missingInEnv.join(", ") || "none") +
            "."
        : "Both files list the same variable names.",
      { missingInExample, missingInEnv },
    );
    return { ok: true, bad };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
