// FRIDAY · skill: sec-phishing-flags
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
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste the message." };
  const flags = [];
  if (/urgent|immediately|act now|suspend/i.test(src)) flags.push("urgency language");
  if (/password|otp|one[- ]time|verify your account/i.test(src))
    flags.push("credential or OTP ask");
  if (/https?:\/\//i.test(src) && /click|login here/i.test(src))
    flags.push("link + login prompt — check the real domain offline");
  if (/dear customer|dear user/i.test(src)) flags.push("generic greeting");
  return {
    ok: true,
    disclaimer:
      "Hygiene checklist only. Not a penetration test, not a security audit, and not a guarantee.",
    flags: flags.length
      ? flags
      : ["no canned flags — still verify unexpected requests out of band"],
  };
}

export default run;
