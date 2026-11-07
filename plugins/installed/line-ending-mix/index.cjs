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
    const files = scan(ctx, 250)
      .filter((r) => TEXT_EXT.test(r.name) && r.size > 0 && r.size < 150000)
      .slice(0, 80);
    let crlf = 0;
    let lf = 0;
    for (const f of files) {
      try {
        const text = ctx.workspace.readFile(f.relative, 16384).text;
        if (/\r\n/.test(text)) crlf += 1;
        else if (/\n/.test(text)) lf += 1;
      } catch {
        /* unreadable file */
      }
    }
    const mixed = crlf > 0 && lf > 0;
    say(
      ctx,
      mixed && Math.min(crlf, lf) > 3 ? "warn" : "info",
      "Line endings",
      crlf +
        " file(s) use CRLF and " +
        lf +
        " use LF." +
        (mixed ? " A .gitattributes or .editorconfig rule would keep them consistent." : ""),
      { crlf, lf },
    );
    return { ok: true, crlf, lf };
  },
  selfTest() {
    return { ok: true, hooks: ["on-idle"] };
  },
};
