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

function streak(ctx) {
  const days = jr(ctx, "days.json", []);
  const today = dayKey();
  if (!days.includes(today)) days.push(today);
  while (days.length > 400) days.shift();
  jw(ctx, "days.json", days);
  let n = 0;
  const seen = new Set(days);
  for (let i = 0; i < 400; i++) {
    const k = dayKey(Date.now() - i * 86400000);
    if (seen.has(k)) n += 1;
    else if (i > 0) break;
    else continue;
  }
  say(ctx, n >= 3 ? "good" : "info", "Streak", n + " day(s) in a row using FRIDAY.", {
    streak: n,
    daysUsed: days.length,
  });
  return { ok: true, streak: n };
}
module.exports = {
  register() {},
  "on-app-start": async function (payload, ctx) {
    return streak(ctx);
  },
  "on-turn-complete": async function (payload, ctx) {
    return streak(ctx);
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start", "on-turn-complete"] };
  },
};
