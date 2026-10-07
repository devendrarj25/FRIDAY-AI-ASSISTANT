// FRIDAY · skill: com-follow-up
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
  const ask = rows(input)[0] || "the last request";
  const body = [
    "Hi,",
    "",
    "Following up on: " + ask + ".",
    "If it is easier, a short yes/no or a time this week would help.",
    "",
    "Thanks",
  ].join("\n");
  return { ok: true, body };
}

export default run;
