// FRIDAY · skill: code-owasp-static
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
  if (!code.trim()) return { ok: false, error: "Paste source." };
  const rules = [
    { id: "eval", test: /\beval\s*\(/, message: "eval() executes strings." },
    { id: "innerhtml", test: /innerHTML\s*=/, message: "innerHTML can introduce XSS." },
    {
      id: "secret",
      test: /(api[_-]?key|secret|password)\s*[:=]\s*['\"][^'\"]{8,}/i,
      message: "Possible hardcoded secret.",
    },
    {
      id: "sql-concat",
      test: /(select|insert|delete).+\+|(select|insert|delete).+\$\{/,
      message: "SQL string concatenation.",
    },
    { id: "http", test: /http:\/\//, message: "Plain http URL in source." },
  ];
  const findings = rules
    .filter((r) => r.test.test(code))
    .map(({ id, message }) => ({ id, message }));
  return { ok: true, findings, note: "Static hints only — not a penetration test." };
}

export default run;
