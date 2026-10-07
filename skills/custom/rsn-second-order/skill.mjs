// FRIDAY · skill: rsn-second-order
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
  const items = rows(input).map((line) => {
    const parts = line
      .split(/=>|->|then:/i)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      action: parts[0] || line,
      firstOrder: parts[1] || null,
      secondOrder: parts[2] || null,
    };
  });
  if (!items.length)
    return { ok: false, error: "Paste actions, optionally as action => effect => then." };
  return { ok: true, items };
}

export default run;
