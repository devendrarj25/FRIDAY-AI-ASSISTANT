// FRIDAY · skill: code-api-contract
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
const NEED = ["method", "path", "auth", "request", "response", "error"];
export async function run(input = {}) {
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste a route spec or OpenAPI fragment." };
  const lower = src.toLowerCase();
  const found = {
    method: /\b(get|post|put|patch|delete)\b/.test(lower),
    path: /\/\w+/.test(src),
    auth: /auth|bearer|api[_-]?key/.test(lower),
    request: /request|body|payload|parameters/.test(lower),
    response: /response|returns|schema/.test(lower),
    error: /4\d\d|5\d\d|error/.test(lower),
  };
  return { ok: true, found, missing: NEED.filter((k) => !found[k]) };
}

export default run;
