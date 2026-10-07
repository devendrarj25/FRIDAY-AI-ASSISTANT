// FRIDAY · skill: mkt-tax-lot-terms
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
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
const SCOPE =
  "Informational analysis, education, or calculation only. FRIDAY has no brokerage or exchange connection and cannot place, execute, or automate a real trade.";
export async function run(input = {}) {
  const lots = [];
  for (const line of rows(input)) {
    const match = line.match(/([0-9.]+)\s+([0-9.]+)(?:\s+(\S+))?/);
    if (match)
      lots.push({ qty: Number(match[1]), price: Number(match[2]), date: match[3] || null });
  }
  const fifo = [...lots];
  const lifo = [...lots].reverse();
  const hifo = [...lots].sort((a, b) => b.price - a.price);
  return {
    ok: true,
    scope: SCOPE,
    glossary: {
      fifo: "Oldest lot first.",
      lifo: "Newest lot first.",
      hifo: "Highest-cost lot first.",
      specificId: "You name the lot; the broker must support it.",
    },
    lots,
    fifoOrder: fifo,
    lifoOrder: lifo,
    hifoOrder: hifo,
  };
}

export default run;
