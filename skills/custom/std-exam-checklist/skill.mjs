// FRIDAY · skill: std-exam-checklist
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
  const subjects = rows(input);
  const base = [
    "sleep window set",
    "bag: pens, id, water",
    "travel time checked",
    "phone plan for the morning",
  ];
  const markdown = [
    "## Logistics",
    ...base.map((i) => "- [ ] " + i),
    "",
    "## Subjects",
    ...(subjects.length ? subjects : ["[subject]"]).map((s) => "- [ ] " + s + " — one more pass"),
  ].join("\n");
  return { ok: true, markdown };
}

export default run;
