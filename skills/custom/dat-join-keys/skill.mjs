// FRIDAY · skill: dat-join-keys
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
  const parse = (raw) =>
    String(raw || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const left = new Set(parse(input.left));
  const right = new Set(parse(input.right));
  if (!left.size && !right.size) {
    const parts = text(input).split(/\n\s*\n/);
    parts[0] && parse(parts[0]).forEach((k) => left.add(k));
    parts[1] && parse(parts[1]).forEach((k) => right.add(k));
  }
  if (!left.size && !right.size) return { ok: false, error: "Paste two id lists (left / right)." };
  const both = [...left].filter((k) => right.has(k));
  const onlyLeft = [...left].filter((k) => !right.has(k));
  const onlyRight = [...right].filter((k) => !left.has(k));
  return {
    ok: true,
    both,
    onlyLeft,
    onlyRight,
    counts: { both: both.length, onlyLeft: onlyLeft.length, onlyRight: onlyRight.length },
  };
}

export default run;
