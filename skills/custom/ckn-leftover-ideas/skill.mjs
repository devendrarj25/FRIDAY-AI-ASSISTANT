// FRIDAY · skill: ckn-leftover-ideas
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
  const src = text(input).toLowerCase();
  const ideas = [];
  if (/rice|grain/.test(src)) ideas.push("fried rice", "stuffed peppers");
  if (/chicken|meat|paneer/.test(src)) ideas.push("wraps", "salad topping", "soup");
  if (/bread/.test(src)) ideas.push("croutons", "bread pudding");
  if (/veg|vegetable/.test(src)) ideas.push("frittata", "pasta toss");
  if (!ideas.length) ideas.push("wrap", "grain bowl", "soup");
  return { ok: true, ideas: [...new Set(ideas)] };
}

export default run;
