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

const MARKERS = [
  ["package.json", "Node / JavaScript"],
  ["tsconfig.json", "TypeScript"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
  ["Cargo.toml", "Rust"],
  ["go.mod", "Go"],
  ["pom.xml", "Java (Maven)"],
  ["build.gradle", "Java / Kotlin (Gradle)"],
  ["composer.json", "PHP"],
  ["Gemfile", "Ruby"],
  ["index.html", "Web page"],
  ["Dockerfile", "Docker"],
];
function detect(ctx) {
  const found = MARKERS.filter(([f]) => ctx.workspace.exists(f)).map(([, label]) => label);
  let net = false;
  try {
    net = ctx.workspace.list(".").some((r) => /\.(?:csproj|sln)$/i.test(r.name));
  } catch {
    /* folder not readable */
  }
  if (net) found.push(".NET");
  const kinds = [...new Set(found)];
  say(
    ctx,
    "info",
    "Project type",
    kinds.length ? kinds.join(", ") + "." : "No known project marker files in the workspace.",
    { kinds },
  );
  return { ok: true, kinds };
}
module.exports = {
  register() {},
  "on-app-start": async function (payload, ctx) {
    return detect(ctx);
  },
  "on-idle": async function (payload, ctx) {
    return detect(ctx);
  },
  selfTest() {
    return { ok: true, hooks: ["on-app-start", "on-idle"] };
  },
};
