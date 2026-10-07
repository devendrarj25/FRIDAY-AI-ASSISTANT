// FRIDAY · skill: sec-backup-321
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
  const locs = rows(input);
  const copies = locs.length
    ? locs
    : ["this PC", "external drive", "off-site / cloud you already pay for"];
  return {
    ok: true,
    disclaimer:
      "Hygiene checklist only. Not a penetration test, not a security audit, and not a guarantee.",
    plan: {
      copies: copies.slice(0, 3),
      note: "3 copies, 2 different media, 1 off-site. Test a restore.",
    },
  };
}

export default run;
