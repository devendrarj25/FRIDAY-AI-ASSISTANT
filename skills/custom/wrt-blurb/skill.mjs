// FRIDAY · skill: wrt-blurb
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
  const src = text(input).replace(/\s+/g, " ").trim();
  if (!src) return { ok: false, error: "Paste the source text." };
  const tokens = src.split(" ");
  const blurb = tokens.slice(0, 40).join(" ") + (tokens.length > 40 ? "…" : "");
  return { ok: true, words: Math.min(40, tokens.length), blurb };
}

export default run;
