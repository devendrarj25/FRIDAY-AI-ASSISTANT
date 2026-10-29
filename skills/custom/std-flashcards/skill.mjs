// FRIDAY · skill: std-flashcards
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
  const cards = rows(input)
    .map((line) => {
      const [term, ...rest] = line.split(/[:=\-–]\s*/);
      return { term: (term || "").trim(), def: rest.join(" — ").trim() || "[definition]" };
    })
    .filter((c) => c.term);
  if (!cards.length) return { ok: false, error: "Paste term: definition lines." };
  return { ok: true, count: cards.length, cards };
}

export default run;
