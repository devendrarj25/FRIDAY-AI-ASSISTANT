// FRIDAY · skill: rsn-bias-check
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
const BIASES = [
  {
    id: "confirmation",
    test: /as I thought|proves me|always knew/i,
    note: "Looks for confirming evidence only?",
  },
  {
    id: "sunk-cost",
    test: /already spent|too late to stop|we've come this far/i,
    note: "Past cost driving a future choice?",
  },
  {
    id: "anchoring",
    test: /first offer|started at|the number is/i,
    note: "First number anchoring the rest?",
  },
  {
    id: "availability",
    test: /just saw|in the news|everyone talks/i,
    note: "Recent story standing in for base rates?",
  },
  { id: "groupthink", test: /nobody disagrees|we all agree|don't rock/i, note: "Dissent missing?" },
];
export async function run(input = {}) {
  const blob = text(input);
  if (!blob.trim()) return { ok: false, error: "Paste the argument." };
  const hits = BIASES.filter((b) => b.test.test(blob)).map(({ id, note }) => ({ id, note }));
  return { ok: true, hits, clean: hits.length === 0 };
}

export default run;
