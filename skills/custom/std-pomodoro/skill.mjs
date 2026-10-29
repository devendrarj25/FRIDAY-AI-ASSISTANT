// FRIDAY · skill: std-pomodoro
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
  const minutes = Math.max(25, num(input, "minutes", 100));
  const focus = Math.max(10, num(input, "focus", 25));
  const brk = Math.max(3, num(input, "break", 5));
  const blocks = [];
  let used = 0;
  let n = 1;
  while (used + focus <= minutes) {
    blocks.push({ n, type: "focus", minutes: focus });
    used += focus;
    if (used + brk <= minutes) {
      blocks.push({ n, type: "break", minutes: brk });
      used += brk;
    }
    n += 1;
  }
  return { ok: true, minutes, blocks };
}

export default run;
