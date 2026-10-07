// FRIDAY · skill: ckn-spice-pair
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
  const TABLE = {
    cumin: ["coriander", "chilli"],
    chilli: ["lime", "garlic"],
    garlic: ["parsley", "lemon"],
    cinnamon: ["clove", "cardamom"],
    basil: ["tomato", "garlic"],
  };
  const q = text(input).toLowerCase();
  const hits = Object.entries(TABLE).filter(([k]) => !q || q.includes(k));
  return {
    ok: true,
    rows: (hits.length ? hits : Object.entries(TABLE)).map(([spice, pairs]) => ({ spice, pairs })),
  };
}

export default run;
