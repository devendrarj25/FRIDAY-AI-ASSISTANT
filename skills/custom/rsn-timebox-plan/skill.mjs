// FRIDAY · skill: rsn-timebox-plan
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
  const tasks = rows(input);
  const minutes = Math.max(5, Math.round(num(input, "minutes", 25)));
  if (!tasks.length) return { ok: false, error: "Paste tasks." };
  const boxes = tasks.map((task, index) => ({ box: index + 1, minutes, task, breakAfter: 5 }));
  return { ok: true, minutes, totalFocused: minutes * tasks.length, boxes };
}

export default run;
