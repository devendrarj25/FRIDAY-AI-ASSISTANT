// FRIDAY · skill: code-naming-pass
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
  const code = String(input.code || input.text || "");
  const ids = [...new Set(code.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [])].filter(
    (id) => !["function", "return", "const", "async", "await", "class"].includes(id),
  );
  const camel = ids.filter((id) => /[a-z][A-Z]/.test(id));
  const snake = ids.filter((id) => id.includes("_") && id === id.toLowerCase());
  return {
    ok: true,
    sample: ids.slice(0, 40),
    camelCount: camel.length,
    snakeCount: snake.length,
    mixed: camel.length && snake.length,
  };
}

export default run;
