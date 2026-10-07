// FRIDAY · skill: std-spaced-rep
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
  const start = Date.parse(String(input.start || "")) || Date.now();
  const items = rows(input);
  if (!items.length) return { ok: false, error: "List items to review." };
  const offsets = [1, 3, 7, 21];
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const schedule = items.map((item) => ({
    item,
    reviews: offsets.map((d) => iso(start + d * 86400000)),
  }));
  return { ok: true, schedule };
}

export default run;
