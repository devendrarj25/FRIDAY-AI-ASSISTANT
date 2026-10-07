// FRIDAY · skill: trv-day-plan
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
  const places = rows(input);
  if (!places.length) return { ok: false, error: "List places or activities." };
  const n = Math.ceil(places.length / 3);
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    morning: places.slice(0, n),
    afternoon: places.slice(n, 2 * n),
    evening: places.slice(2 * n),
  };
}

export default run;
