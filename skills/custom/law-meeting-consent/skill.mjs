// FRIDAY · skill: law-meeting-consent
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
  const where = String(input.where || "this meeting");
  const note =
    "We would like to record " +
    where +
    " so notes stay accurate. Please say now if you do not consent; we will stop or not record.";
  return {
    ok: true,
    disclaimer:
      "Template / education only — not legal advice. Have a licensed lawyer review anything you will sign.",
    note,
  };
}

export default run;
