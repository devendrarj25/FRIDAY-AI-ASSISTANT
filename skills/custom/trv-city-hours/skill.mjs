// FRIDAY · skill: trv-city-hours
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
  const km = num(input, "km");
  const bufferPct = num(input, "bufferPct", 20);
  if (!(km > 0)) return { ok: false, error: "Type kilometres." };
  const minutes = (km / 5) * 60;
  const withBuffer = minutes * (1 + bufferPct / 100);
  return { ok: true, km, minutes: Math.round(minutes), withBuffer: Math.round(withBuffer) };
}

export default run;
