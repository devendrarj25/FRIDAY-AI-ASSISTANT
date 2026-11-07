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
  "on-error": async function (payload, ctx) {
    const t = String((payload && payload.error) || "");
    const kinds = [];
    if (/\bgh[pousr]_[A-Za-z0-9]{30,}/.test(t)) kinds.push("GitHub token");
    if (/\bsk-[A-Za-z0-9_-]{20,}/.test(t)) kinds.push("API key");
    if (/\bAKIA[0-9A-Z]{16}\b/.test(t)) kinds.push("AWS key");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) kinds.push("private key");
    if (/\b(?:password|passwd|secret|token)\s*[=:]\s*\S{6,}/i.test(t))
      kinds.push("credential assignment");
    const s = jr(ctx, "counts.json", { errors: 0, flagged: 0 });
    s.errors += 1;
    if (kinds.length) s.flagged += 1;
    jw(ctx, "counts.json", s);
    if (kinds.length)
      say(
        ctx,
        "warn",
        "A secret may be in an error",
        "The last error text contained a " +
          kinds.join(", ") +
          ". Rotate it if it was real. " +
          s.flagged +
          " of " +
          s.errors +
          " errors so far.",
        { flagged: s.flagged },
      );
    return { ok: true, flagged: kinds.length };
  },
  selfTest() {
    return { ok: true, hooks: ["on-error"] };
  },
};
