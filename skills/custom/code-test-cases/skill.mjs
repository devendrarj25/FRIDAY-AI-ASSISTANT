// FRIDAY · skill: code-test-cases
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
  const src = text(input);
  if (!src.trim()) return { ok: false, error: "Paste a spec or function." };
  const params = Array.from(src.matchAll(/\(([^)]*)\)/))
    .flatMap((m) =>
      m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .slice(0, 8);
  const throws = /throw|raise|error/i.test(src);
  const cases = [
    { kind: "happy", idea: "Typical valid inputs produce the documented result." },
    { kind: "empty", idea: "Empty string / empty array / zero — documented behaviour?" },
    {
      kind: "boundary",
      idea: params[0] ? `Boundary values for ${params[0]}` : "Min/max numeric boundaries.",
    },
  ];
  if (throws)
    cases.push({
      kind: "error",
      idea: "Invalid input raises the named error and does not half-write.",
    });
  if (/async|await|Promise/.test(src))
    cases.push({ kind: "async", idea: "Rejection path and timeout." });
  return { ok: true, params, cases };
}

export default run;
