// FRIDAY · skill: rsn-habit-loop
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
  const slots = { cue: [], routine: [], reward: [], craving: [], other: [] };
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    if (/cue|trigger|when /.test(lower)) slots.cue.push(line);
    else if (/routine|then i|behaviour|behavior/.test(lower)) slots.routine.push(line);
    else if (/reward|feel|get /.test(lower)) slots.reward.push(line);
    else if (/crav|want/.test(lower)) slots.craving.push(line);
    else slots.other.push(line);
  }
  if (!rows(input).length) return { ok: false, error: "Describe the habit." };
  return { ok: true, ...slots };
}

export default run;
