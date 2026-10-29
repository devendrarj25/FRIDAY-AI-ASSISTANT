// FRIDAY · skill: dat-json-keys
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? input?.notes ?? "");
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
  let data;
  try {
    data = JSON.parse(text(input) || String(input.json || ""));
  } catch {
    return { ok: false, error: "Paste valid JSON." };
  }
  const paths = [];
  const walk = (node, prefix) => {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) walk(v, prefix ? prefix + "." + k : k);
    } else if (Array.isArray(node)) {
      paths.push(prefix + "[]");
      if (node[0] && typeof node[0] === "object") walk(node[0], prefix + "[]");
    } else paths.push(prefix);
  };
  walk(data, "");
  return { ok: true, count: paths.length, paths: paths.slice(0, 200) };
}

export default run;
