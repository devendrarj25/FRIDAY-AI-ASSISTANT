// FRIDAY · skill: con-safety-heights
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
  "Avoid work at height if the task can be done from the ground",
  "Scaffold tagged and inspected",
  "Guardrails / edge protection in place",
  "Ladders tied, correct angle, three-point contact",
  "Harness and anchor only where a fall-arrest plan exists",
  "Exclusion zone below",
  "Weather / wind checked",
  "Rescue plan for a suspended worker",
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
