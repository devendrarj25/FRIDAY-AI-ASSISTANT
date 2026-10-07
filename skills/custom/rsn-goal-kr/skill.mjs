// FRIDAY · skill: rsn-goal-kr
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
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste a goal and candidate results." };
  const goal = lines.find((l) => /goal|objective|north/i.test(l)) || lines[0];
  const keyResults = lines.filter((l) => l !== goal && /\d|%|by \w/.test(l));
  const fluff = lines.filter((l) => l !== goal && !keyResults.includes(l));
  return { ok: true, goal, keyResults, unmeasured: fluff };
}

export default run;
