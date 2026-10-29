// FRIDAY · skill: com-status-update
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
  const lines = rows(input);
  const yesterday = String(input.yesterday || lines[0] || "");
  const today = String(input.today || lines[1] || "");
  const blockers = String(input.blockers || lines[2] || "none");
  const textOut = ["Yesterday: " + yesterday, "Today: " + today, "Blockers: " + blockers].join(
    "\n",
  );
  return { ok: true, text: textOut };
}

export default run;
