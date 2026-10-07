// FRIDAY · skill: wrt-reading-grade
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
  if (!src.trim()) return { ok: false, error: "Paste the text." };
  const sentences = src
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const wordsN = src.split(/\s+/).filter(Boolean).length;
  const syl =
    src
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .replace(/[^aeiouy]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length || 1;
  const asl = wordsN / Math.max(1, sentences.length);
  const asw = syl / Math.max(1, wordsN);
  const flesch = 206.835 - 1.015 * asl - 84.6 * asw;
  return {
    ok: true,
    sentences: sentences.length,
    words: wordsN,
    flesch: Math.round(flesch * 10) / 10,
  };
}

export default run;
