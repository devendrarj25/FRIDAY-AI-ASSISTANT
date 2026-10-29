// FRIDAY · skill: code-env-audit
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
  const code = String(input.code || input.text || "");
  if (!code.trim()) return { ok: false, error: "Paste source." };
  const names = new Set();
  for (const match of code.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(match[1]);
  for (const match of code.matchAll(/process\.env\[([\"'])([A-Z0-9_]+)\1\]/g)) names.add(match[2]);
  for (const match of code.matchAll(/os\.environ(?:\.get)?\((['\"])([A-Z0-9_]+)\1/g))
    names.add(match[2]);
  for (const match of code.matchAll(/%([A-Z0-9_]+)%/g)) names.add(match[1]);
  return { ok: true, names: [...names].sort() };
}

export default run;
