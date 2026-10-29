// FRIDAY · skill: code-regex-explain
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
  const pattern = String(input.pattern || input.text || "");
  const sample = String(input.sample || "");
  if (!pattern) return { ok: false, error: "Pass pattern." };
  const tokens = [];
  const parts = pattern.match(/\\.|\[[^\]]*\]|\{\d+,?\d*\}|[.?+*|()]|\(\?:|./g) || [pattern];
  for (const part of parts) {
    if (part === ".") tokens.push({ part, meaning: "any character except newline (default)" });
    else if (part === "^") tokens.push({ part, meaning: "start" });
    else if (part === "$") tokens.push({ part, meaning: "end" });
    else if (part.startsWith("[")) tokens.push({ part, meaning: "character class" });
    else if (part.startsWith("\\")) tokens.push({ part, meaning: "escape or class" });
    else tokens.push({ part, meaning: "literal or quantifier" });
  }
  let matched = null;
  let error = null;
  try {
    matched = sample ? new RegExp(pattern).test(sample) : null;
  } catch (err) {
    error = String(err.message || err);
  }
  return { ok: !error, tokens, sample: sample || null, matched, error };
}

export default run;
