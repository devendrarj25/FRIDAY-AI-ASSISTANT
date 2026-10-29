// FRIDAY · skill: wrt-cliche-hunt
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
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste the draft." };
  const phrases = [
    "at the end of the day",
    "think outside the box",
    "low-hanging fruit",
    "move the needle",
    "circle back",
    "synergy",
    "going forward",
    "it is what it is",
    "game changer",
    "at this point in time",
  ];
  const hits = phrases.filter((p) => src.toLowerCase().includes(p));
  return { ok: true, hits, count: hits.length };
}

export default run;
