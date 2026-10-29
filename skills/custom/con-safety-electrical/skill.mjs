// FRIDAY · skill: con-safety-electrical
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
  "Identify the circuit and energy source",
  "Isolate and prove dead with a tested proving unit",
  "Lock-out / tag-out applied",
  "Stored energy discharged",
  "Temporary supplies RCD-protected",
  "Cables routed to avoid damage and water",
  "Only competent persons in the enclosure",
  "Re-energise sequence agreed",
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
