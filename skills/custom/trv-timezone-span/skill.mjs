// FRIDAY · skill: trv-timezone-span
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
    utc: 0,
    london: 0,
    paris: 1,
    delhi: 5.5,
    dubai: 4,
    tokyo: 9,
    sydney: 10,
    "new york": -5,
    chicago: -6,
    denver: -7,
    "los angeles": -8,
  };
  const names = rows(input).map((s) => s.toLowerCase());
  const wanted = names.length ? names : Object.keys(TABLE);
  const rowsOut = wanted.map((n) => ({ place: n, utcOffsetHours: TABLE[n] ?? null }));
  return {
    ok: true,
    disclaimer:
      "Planning helper only. FRIDAY does not book tickets, hotels, or visas. DST not applied.",
    rows: rowsOut,
  };
}

export default run;
