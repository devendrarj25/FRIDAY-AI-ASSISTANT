// FRIDAY · skill: code-dep-audit
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
}
function rows(input) {
  return text(input)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function numbers(input, key) {
  const raw = input?.[key] ?? input?.text ?? "";
  return String(raw)
    .split(/[,\s]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}
export async function run(input = {}) {
  const raw = text(input);
  if (!raw.trim())
    return { ok: false, error: "Paste package.json dependencies or requirements.txt." };
  const deps = [];
  try {
    const json = JSON.parse(raw);
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      if (json[key] && typeof json[key] === "object") {
        for (const [name, version] of Object.entries(json[key]))
          deps.push({ name, version: String(version), group: key });
      }
    }
  } catch {
    for (const line of rows({ text: raw })) {
      if (line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*([=<>!~].+)?$/);
      if (match)
        deps.push({
          name: match[1],
          version: (match[2] || "").trim() || "*",
          group: "requirements",
        });
    }
  }
  if (!deps.length) return { ok: false, error: "No dependency lines recognised." };
  return { ok: true, count: deps.length, deps };
}

export default run;
