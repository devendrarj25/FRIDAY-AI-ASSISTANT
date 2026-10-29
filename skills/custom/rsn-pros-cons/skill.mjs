// FRIDAY · skill: rsn-pros-cons
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
export async function run(input = {}) {
  const pros = [];
  const cons = [];
  const unsure = [];
  for (const line of rows(input)) {
    if (/^\+|\bpro\b/i.test(line)) pros.push(line.replace(/^\+\s*/, ""));
    else if (/^[-−]|\bcon\b/i.test(line)) cons.push(line.replace(/^[-−]\s*/, ""));
    else if (/^\?|unsure|maybe/i.test(line)) unsure.push(line);
    else unsure.push(line);
  }
  if (!pros.length && !cons.length && !unsure.length)
    return { ok: false, error: "Paste options or +/− lines." };
  return { ok: true, pros, cons, unsure };
}

export default run;
