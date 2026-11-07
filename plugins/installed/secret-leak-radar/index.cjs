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
    const files = scan(ctx, 300)
      .filter(
        (r) => TEXT_EXT.test(r.name) && r.size < 200000 && !/\.(?:lock|min\.js)$/i.test(r.name),
      )
      .slice(0, 150);
    const hits = {};
    const re = [
      /\bgh[pousr]_[A-Za-z0-9]{30,}/,
      /\bsk-[A-Za-z0-9_-]{20,}/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bxox[abp]-[A-Za-z0-9-]{20,}/,
    ];
    for (const f of files) {
      try {
        const text = ctx.workspace.readFile(f.relative, 32768).text;
        if (re.some((r) => r.test(text))) hits[f.relative] = true;
      } catch {
        /* unreadable file */
      }
    }
    const names = Object.keys(hits);
    if (names.length)
      say(
        ctx,
        "warn",
        "Possible secrets in files",
        names.length +
          " file(s) look like they hold a key or token: " +
          names.slice(0, 4).join(", ") +
          ". Move them to the secret store and rotate them.",
        { files: names.length },
      );
    else
      say(
        ctx,
        "good",
        "No obvious secrets",
        "Scanned " + files.length + " file(s); nothing looked like a key.",
        { scanned: files.length },
      );
    return { ok: true, flagged: names.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
