// FRIDAY · skill: rsn-study-plan
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
export async function run(input = {}) {
  const topics = rows(input);
  if (!topics.length) return { ok: false, error: "Paste topics, one per line." };
  const days = Math.max(topics.length, Math.round(num(input, "days", topics.length)));
  const minutesPerDay = Math.max(10, Math.round(num(input, "minutesPerDay", 45)));
  const plan = [];
  for (let d = 0; d < days; d += 1) {
    const topic = topics[d % topics.length];
    const recap = d >= topics.length;
    plan.push({ day: d + 1, minutes: minutesPerDay, focus: recap ? `Recap: ${topic}` : topic });
  }
  return { ok: true, days, minutesPerDay, plan };
}

export default run;
