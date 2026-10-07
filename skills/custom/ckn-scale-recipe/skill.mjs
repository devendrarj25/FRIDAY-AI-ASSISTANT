// FRIDAY · skill: ckn-scale-recipe
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
  const from = Math.max(0.1, num(input, "from", 1));
  const to = Math.max(0.1, num(input, "to", 2));
  const factor = to / from;
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste ingredients as qty unit name." };
  const scaled = lines.map((line) => {
    const m = line.match(/^(\d+(?:\.\d+)?)(.*)$/);
    if (!m) return { original: line, scaled: line };
    const n = Math.round(Number(m[1]) * factor * 100) / 100;
    return { original: line, scaled: n + m[2] };
  });
  return { ok: true, factor, scaled };
}

export default run;
