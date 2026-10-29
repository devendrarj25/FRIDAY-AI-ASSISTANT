// FRIDAY · skill: com-ask-update
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
  const item = String(input.item || rows(input)[0] || "the pending item");
  const body = [
    "Hi,",
    "",
    "Just checking in on " + item + ".",
    "When you have a moment, could you share the latest?",
    "",
    "Thanks",
  ].join("\n");
  return { ok: true, body };
}

export default run;
