// FRIDAY · skill: std-glossary
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
  if (!lines.length) return { ok: false, error: "Paste notes." };
  const terms = new Map();
  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Za-z0-9+\-]{2,})\s*[\-:]\s*(.+)$/);
    if (m) terms.set(m[1], m[2]);
    for (const w of line.match(/\b[A-Z][A-Za-z]{3,}\b/g) || [])
      if (!terms.has(w)) terms.set(w, "[add]");
  }
  const glossary = [...terms.entries()].slice(0, 40).map(([term, def]) => ({ term, def }));
  return { ok: true, glossary };
}

export default run;
