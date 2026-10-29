// FRIDAY · skill: rsn-feedback-draft
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
  if (!lines.length) return { ok: false, error: "Paste what you want to say." };
  const observation = lines.find((l) => /when |I saw|on \d/i.test(l)) || lines[0];
  const feeling = lines.find((l) => /I feel|frustrated|worried|glad/i.test(l)) || null;
  const request = lines.find((l) => /please |would you|can we/i.test(l)) || null;
  return {
    ok: true,
    draft: {
      observation,
      feeling: feeling || "(name a feeling, not a judgement)",
      need: lines.find((l) => /need |because /i.test(l)) || null,
      request: request || "(one concrete request)",
    },
  };
}

export default run;
