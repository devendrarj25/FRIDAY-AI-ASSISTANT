// FRIDAY · skill: law-invoice-terms
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
  const days = Math.max(1, num(input, "days", 15));
  const method = String(input.method || "bank transfer");
  const bullets = [
    "Payment due within " + days + " days of invoice date.",
    "Please pay by " + method + ".",
    "Late invoices may pause further work after written notice.",
    "Raise disputes in writing within " + Math.min(7, days) + " days.",
  ];
  return {
    ok: true,
    disclaimer:
      "Template / education only — not legal advice. Have a licensed lawyer review anything you will sign.",
    bullets,
  };
}

export default run;
