// FRIDAY · skill: con-phase-checklist
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
const PHASES = [
  "mobilisation",
  "setting out",
  "substructure",
  "superstructure",
  "envelope",
  "MEP first fix",
  "finishes",
  "commissioning",
  "close-out",
];
export async function run(input = {}) {
  const weeks = Math.max(PHASES.length, Math.round(num(input, "weeks", PHASES.length)));
  const notes = rows(input).map((l) => l.toLowerCase());
  const per = weeks / PHASES.length;
  const schedule = PHASES.map((phase, index) => ({
    phase,
    weekFrom: Math.round(index * per) + 1,
    weekTo: Math.round((index + 1) * per),
    mentioned: notes.some((n) => n.includes(phase.split(" ")[0])),
  }));
  return { ok: true, disclaimer: DISCLAIMER, weeks, schedule };
}

export default run;
