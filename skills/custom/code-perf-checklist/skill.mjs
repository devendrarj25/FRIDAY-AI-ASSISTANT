// FRIDAY · skill: code-perf-checklist
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
  const findings = [];
  if (/for\s*\([^)]*\)\s*\{[^}]*await /s.test(code))
    findings.push("await inside a for-loop — consider batching.");
  if (/.map\s*\([^)]*await/.test(code)) findings.push("async map without Promise.all.");
  if (/JSON\.parse[^;]+for\s*\(/.test(code) || /for\s*\([^)]*\)[^{]*JSON\.parse/.test(code))
    findings.push("JSON.parse in a loop.");
  if (/innerHTML\s*=/.test(code))
    findings.push("innerHTML assignment — check for XSS if the string is untrusted.");
  return { ok: true, findings };
}

export default run;
