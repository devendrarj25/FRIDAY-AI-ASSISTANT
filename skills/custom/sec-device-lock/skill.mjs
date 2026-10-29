// FRIDAY · skill: sec-device-lock
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
  const items = [
    "screen locks after a short idle",
    "OS updates not weeks behind",
    "disk encryption on",
    "separate browser profile for money",
    "guest accounts off if you do not need them",
  ];
  return {
    ok: true,
    disclaimer:
      "Hygiene checklist only. Not a penetration test, not a security audit, and not a guarantee.",
    markdown: items.map((i) => "- [ ] " + i).join("\n"),
  };
}

export default run;
