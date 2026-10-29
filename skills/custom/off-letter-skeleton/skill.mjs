// FRIDAY · skill: off-letter-skeleton
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
  const to = String(input.to || "Recipient");
  const purpose = rows(input)[0] || "State the purpose in one sentence.";
  const body = rows(input).slice(1, 6);
  const letter = [
    to,
    "",
    "Dear " + to + ",",
    "",
    purpose,
    "",
    ...(body.length ? body : ["[fact 1]", "[fact 2]", "[request]"]),
    "",
    "Yours sincerely,",
    "[Your name]",
  ].join("\n");
  return { ok: true, to, letter };
}

export default run;
