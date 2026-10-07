// FRIDAY · skill: trv-weight-pack
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
  const items = rows(input).map((line) => {
    const m = line.match(/:?\s*(\d+(?:\.\d+)?)\s*(g|kg)?/i);
    const grams = m ? Number(m[1]) * (String(m[2]).toLowerCase() === "kg" ? 1000 : 1) : 0;
    return { item: line.replace(/:?\s*\d.*$/, "").trim() || line, grams };
  });
  if (!items.length) return { ok: false, error: "List items as name:grams." };
  const total = items.reduce((n, i) => n + i.grams, 0);
  const cap = num(input, "capGrams", 7000);
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    totalGrams: total,
    capGrams: cap,
    over: total > cap,
    items,
  };
}

export default run;
