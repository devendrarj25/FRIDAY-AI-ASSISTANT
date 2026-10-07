// FRIDAY · skill: std-reading-list
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
  const items = rows(input);
  if (!items.length) return { ok: false, error: "List readings." };
  const rank = (line) => (/\bmust\b/i.test(line) ? 0 : /\bshould\b/i.test(line) ? 1 : 2);
  const ordered = [...items].sort((a, b) => rank(a) - rank(b));
  return { ok: true, ordered, markdown: ordered.map((i, n) => n + 1 + ". " + i).join("\n") };
}

export default run;
