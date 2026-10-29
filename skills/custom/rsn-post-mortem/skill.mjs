// FRIDAY · skill: rsn-post-mortem
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
const MAP = [
  ["timeline", /timeline|at \d|then we|T\+\d/],
  ["impact", /impact|users?|downtime|failed/],
  ["rootCause", /root cause|because |why /],
  ["fix", /fix|patch|revert|mitigat/],
  ["followUp", /follow-?up|todo|action/],
];
export async function run(input = {}) {
  const buckets = { timeline: [], impact: [], rootCause: [], fix: [], followUp: [], other: [] };
  for (const line of rows(input)) {
    const hit = MAP.find(([, re]) => re.test(line));
    buckets[hit ? hit[0] : "other"].push(line);
  }
  if (!rows(input).length) return { ok: false, error: "Paste incident notes." };
  return { ok: true, ...buckets };
}

export default run;
