// FRIDAY · skill: hom-cleaning-cadence
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
  const rooms = rows(input);
  if (!rooms.length) return { ok: false, error: "List rooms." };
  const cadence = rooms.map((room, i) => ({
    room,
    daily: i % 3 === 0 ? "quick wipe" : "—",
    weekly: "vacuum / mop",
    monthly: "deeper sort",
  }));
  return { ok: true, cadence };
}

export default run;
