// FRIDAY · skill: rsn-decision-agenda
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
  const minutes = Math.max(topics.length * 5, Math.round(num(input, "minutes", 45)));
  if (!topics.length) return { ok: false, error: "Paste agenda topics." };
  const each = Math.max(5, Math.floor(minutes / topics.length));
  const items = topics.map((topic, index) => ({
    order: index + 1,
    topic,
    decisionQuestion: topic.includes("?") ? topic : `What will we decide about: ${topic}?`,
    minutes: each,
  }));
  return { ok: true, minutes, items };
}

export default run;
