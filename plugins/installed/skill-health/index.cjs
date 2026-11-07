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
  "on-skill-run": async function (payload, ctx) {
    const id = String((payload && (payload.skillId || payload.name)) || "unknown").slice(0, 80);
    const m = jr(ctx, "skills.json", {});
    const e = m[id] || { runs: 0, last: [] };
    e.runs += 1;
    e.last.push(payload && payload.ok === false ? 0 : 1);
    while (e.last.length > 5) e.last.shift();
    m[id] = e;
    const keys = Object.keys(m);
    if (keys.length > 80) delete m[keys[0]];
    jw(ctx, "skills.json", m);
    const bad = Object.entries(m).filter(
      ([, v]) => v.last.length >= 3 && v.last.filter((x) => x === 0).length >= 3,
    );
    if (bad.length)
      say(
        ctx,
        "warn",
        "A skill keeps failing",
        bad
          .map(([k]) => k)
          .slice(0, 3)
          .join(", ") + " failed at least 3 of its last 5 runs.",
        { failing: bad.length },
      );
    else
      say(
        ctx,
        "good",
        "Skills are healthy",
        Object.keys(m).length + " skill(s) seen, none failing repeatedly.",
        { skills: Object.keys(m).length },
      );
    return { ok: true };
  },
  selfTest() {
    return { ok: true, hooks: ["on-skill-run"] };
  },
};
