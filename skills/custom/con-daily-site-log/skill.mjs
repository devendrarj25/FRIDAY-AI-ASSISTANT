// FRIDAY · skill: con-daily-site-log
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
export async function run(input = {}) {
  const buckets = { workforce: [], work: [], delays: [], safety: [], other: [] };
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    if (/crew|labour|labor|carpenter|mason|operator/.test(lower)) buckets.workforce.push(line);
    else if (/delay|wait|rain|hold/.test(lower)) buckets.delays.push(line);
    else if (/ppe|incident|near miss|toolbox/.test(lower)) buckets.safety.push(line);
    else if (/poured|installed|erected|completed/.test(lower)) buckets.work.push(line);
    else buckets.other.push(line);
  }
  return {
    ok: true,
    disclaimer: DISCLAIMER,
    date: input.date || null,
    weather: input.weather || null,
    ...buckets,
  };
}

export default run;
