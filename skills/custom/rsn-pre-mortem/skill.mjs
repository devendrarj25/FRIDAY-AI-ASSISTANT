// FRIDAY · skill: rsn-pre-mortem
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
  const failures = [];
  const signals = [];
  const mitigations = [];
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    if (/mitigat|prevent|buffer/.test(lower)) mitigations.push(line);
    else if (/signal|warn|metric|notice/.test(lower)) signals.push(line);
    else failures.push(line);
  }
  if (!failures.length) return { ok: false, error: "Paste how this plan could fail." };
  return {
    ok: true,
    prompt: "It is six months later and this failed. Why?",
    failures,
    signals,
    mitigations,
  };
}

export default run;
