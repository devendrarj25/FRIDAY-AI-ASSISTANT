// FRIDAY · skill: car-star-story
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
  const lines = rows(input);
  if (lines.length < 2) return { ok: false, error: "Paste situation, task, action, result lines." };
  const story = {
    situation: lines[0],
    task: lines[1] || "",
    action: lines[2] || "",
    result: lines[3] || "",
  };
  return {
    ok: true,
    story,
    spoken: [story.situation, story.task, story.action, story.result].filter(Boolean).join(" "),
  };
}

export default run;
