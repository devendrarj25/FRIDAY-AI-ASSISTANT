// FRIDAY · skill: code-complexity-hotspots
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
  const chunks = code.split(
    /\n(?=(?:export\s+)?(?:async\s+)?function\s+|\s*(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\()/,
  );
  const hotspots = chunks
    .map((chunk, i) => {
      const name = (chunk.match(/function\s+(\w+)/) ||
        chunk.match(/(?:const|let)\s+(\w+)/) || [, `chunk-${i}`])[1];
      const score = (chunk.match(/\b(if|for|while|case|catch|&&|\|\|)\b/g) || []).length + 1;
      return { name, score, lines: chunk.split(/\n/).length };
    })
    .sort((a, b) => b.score - a.score);
  return { ok: true, filename: input.filename || null, hotspots: hotspots.slice(0, 12) };
}

export default run;
