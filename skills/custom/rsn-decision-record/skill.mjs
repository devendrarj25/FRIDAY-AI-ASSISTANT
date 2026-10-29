// FRIDAY · skill: rsn-decision-record
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
const KEYS = [
  ["context", /context|background|situation/],
  ["options", /option|alternative|vs\b/],
  ["decision", /decision|we will|chose|choose/],
  ["consequences", /consequence|risk|follow-on|trade.?off/],
];
export async function run(input = {}) {
  const buckets = { context: [], options: [], decision: [], consequences: [], other: [] };
  for (const line of rows(input)) {
    const hit = KEYS.find(([, re]) => re.test(line.toLowerCase()));
    buckets[hit ? hit[0] : "other"].push(line);
  }
  return { ok: true, title: input.title || rows(input)[0] || "Decision", ...buckets };
}

export default run;
