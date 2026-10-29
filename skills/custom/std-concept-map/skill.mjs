// FRIDAY · skill: std-concept-map
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? input?.notes ?? "");
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
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste A -> B lines or headings." };
  const markdown = lines
    .map((line) => {
      const m = line.split(/\s*->\s*|\s*→\s*/);
      if (m.length > 1) return "- " + m[0] + "\n    - " + m.slice(1).join("\n    - ");
      return "- " + line;
    })
    .join("\n");
  return { ok: true, markdown };
}

export default run;
