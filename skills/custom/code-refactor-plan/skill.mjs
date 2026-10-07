// FRIDAY · skill: code-refactor-plan
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
  if (!code.trim()) return { ok: false, error: "Paste source to plan a refactor." };
  const lines = code.split(/\n/);
  const functions = [];
  let current = null;
  lines.forEach((line, index) => {
    const match = line.match(
      /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()/,
    );
    if (match) {
      if (current) functions.push(current);
      current = { name: match[1] || match[2], start: index + 1, length: 0 };
    }
    if (current) current.length = index + 1 - current.start;
  });
  if (current) functions.push(current);
  const long = functions.filter((f) => f.length > 40);
  const plan = [
    long.length
      ? `Split ${long.map((f) => f.name).join(", ")} (>${40} lines)`
      : "No oversized functions spotted in this paste.",
    "Add characterisation tests around the current behaviour before moving code.",
    "Extract pure helpers; keep I/O at the edges.",
    "Delete dead branches only after a search for callers.",
  ];
  return { ok: true, filename: input.filename || null, functions, long, plan };
}

export default run;
