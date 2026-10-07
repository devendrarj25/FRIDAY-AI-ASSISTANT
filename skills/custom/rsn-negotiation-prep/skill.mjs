// FRIDAY · skill: rsn-negotiation-prep
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
const SLOTS = ["batna", "reservation", "target", "concessions", "questions"];
export async function run(input = {}) {
  const found = Object.fromEntries(SLOTS.map((s) => [s, []]));
  const other = [];
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    const slot = SLOTS.find((s) => lower.includes(s) || (s === "questions" && line.includes("?")));
    if (slot) found[slot].push(line);
    else other.push(line);
  }
  return { ok: true, ...found, other, missing: SLOTS.filter((s) => !found[s].length) };
}

export default run;
