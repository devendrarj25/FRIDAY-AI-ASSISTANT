// FRIDAY · skill: com-apology
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
  const what = String(input.what || rows(input)[0] || "the mistake");
  const impact = String(input.impact || rows(input)[1] || "the delay");
  const next = String(input.next || rows(input)[2] || "the fix and when");
  const body = [
    "I am sorry for " + what + ".",
    "I know it caused " + impact + ".",
    "Next: " + next + ".",
    "Thank you for your patience.",
  ].join("\n");
  return { ok: true, body };
}

export default run;
