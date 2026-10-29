// FRIDAY · skill: code-pr-checklist
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
const ITEMS = [
  "Tests added or updated for the behaviour change",
  "Docs / FRIDAY_STATE updated if behaviour changed",
  "No unrelated reformatting",
  "Secrets and keys not in the diff",
  "Rollback / feature flag mentioned if needed",
  "Linked issue or reason stated",
];
export async function run(input = {}) {
  const blob = text(input).toLowerCase();
  const checklist = ITEMS.map((item) => ({
    item,
    hinted:
      blob.includes(item.split(" ")[0].toLowerCase()) ||
      (item.includes("secret") && /secret|token|password/.test(blob)),
  }));
  return { ok: true, checklist };
}

export default run;
