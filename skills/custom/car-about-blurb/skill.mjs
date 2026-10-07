// FRIDAY · skill: car-about-blurb
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
  const role = String(input.role || "specialist");
  const years = num(input, "years", 0);
  const focus = String(input.focus || text(input) || "clear, finished work");
  const blurb =
    "I work as a " +
    role +
    (years ? " (" + years + " years)" : "") +
    ". Focus: " +
    focus +
    ". I care about finishing the job and saying clearly what I do not know.";
  return { ok: true, blurb, words: blurb.split(/\s+/).length };
}

export default run;
