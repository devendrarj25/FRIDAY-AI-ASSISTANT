// FRIDAY · skill: hlt-screen-break
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
  const minutes = Math.max(20, Math.round(num(input, "minutes", 120)));
  const breaks = [];
  for (let t = 20; t < minutes; t += 20)
    breaks.push({ atMinute: t, do: "Look 20 feet away for 20 seconds" });
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    minutes,
    breaks,
  };
}

export default run;
