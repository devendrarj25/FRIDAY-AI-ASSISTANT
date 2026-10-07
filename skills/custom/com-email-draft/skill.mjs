// FRIDAY · skill: com-email-draft
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
  const to = String(input.to || "");
  const bullets = rows(input);
  if (!bullets.length) return { ok: false, error: "Paste the points to cover." };
  const subject = bullets[0].slice(0, 70);
  const body = [
    "Hi" + (to ? " " + to : "") + ",",
    "",
    ...bullets.map((b) => "- " + b),
    "",
    "Thanks,",
    "[Your name]",
  ].join("\n");
  return { ok: true, subject, body };
}

export default run;
