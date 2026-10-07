// FRIDAY · skill: rsn-assumption-audit
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
  const assumptions = rows(input).filter((line) =>
    /\b(assume|always|never|must|everyone|obviously)\b/i.test(line),
  );
  const rest = rows(input).filter((line) => !assumptions.includes(line));
  if (!rows(input).length) return { ok: false, error: "Paste the plan or argument." };
  return {
    ok: true,
    assumptions,
    evidenceNeeded: assumptions.map((a) => ({ assumption: a, ask: "What would disprove this?" })),
    rest,
  };
}

export default run;
