// FRIDAY · skill: com-thanks
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
  const help = String(input.help || rows(input)[0] || "your help");
  const result = String(input.result || rows(input)[1] || "we could move forward");
  const body = [
    "Thank you for " + help + ".",
    "Because of that, " + result + ".",
    "I appreciate it.",
  ].join("\n");
  return { ok: true, body };
}

export default run;
