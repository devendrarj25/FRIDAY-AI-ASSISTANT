// FRIDAY · skill: dat-dedupe-keys
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
  const keys = text(input)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!keys.length) return { ok: false, error: "Paste keys to dedupe." };
  const seen = new Map();
  for (const k of keys) seen.set(k, (seen.get(k) || 0) + 1);
  const unique = [...seen.keys()];
  const duplicates = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([k, n]) => ({ key: k, count: n }));
  return {
    ok: true,
    unique,
    duplicates,
    counts: { in: keys.length, unique: unique.length, duplicated: duplicates.length },
  };
}

export default run;
