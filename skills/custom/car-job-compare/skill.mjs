// FRIDAY · skill: car-job-compare
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
  const left = String(input.left || "Role A");
  const right = String(input.right || "Role B");
  const notes = rows(input);
  const markdown = [
    "| Factor | " + left + " | " + right + " |",
    "| --- | --- | --- |",
    "| Pay band | | |",
    "| Commute / hours | | |",
    "| Growth | | |",
    "| Fit vs notes | " + (notes[0] || "") + " | " + (notes[1] || "") + " |",
  ].join("\n");
  return { ok: true, markdown };
}

export default run;
