// FRIDAY · skill: con-safety-general
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
const ITEMS = [
  "Site induction complete for everyone on the log",
  "PPE worn for the task (helmet, boots, eye/ear as required)",
  "First-aid kit and trained person identified",
  "Emergency assembly point posted",
  "Housekeeping: access routes clear",
  "Plant isolation / keys controlled",
  "Temporary works inspected where used",
  "Welfare (water, toilets, rest) available",
];
export async function run(input = {}) {
  const notes = rows(input);
  const checklist = ITEMS.map((item) => ({
    item,
    marked: notes.some((line) => line.toLowerCase().includes(item.toLowerCase().slice(0, 12))),
  }));
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    checklist,
    unanswered: checklist.filter((c) => !c.marked).length,
  };
}

export default run;
