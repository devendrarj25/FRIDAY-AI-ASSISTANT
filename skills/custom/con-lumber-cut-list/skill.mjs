// FRIDAY · skill: con-lumber-cut-list
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
const DISCLAIMER =
  "This is a planning aid, not a substitute for a licensed engineer's calculations or sign-off, and it is not professional certification.";
export async function run(input = {}) {
  const stockLength = num(input, "stockLength", 2400);
  const cuts = rows(input)
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b - a);
  if (!cuts.length) return { ok: false, error: "Paste one cut length per line." };
  const boards = [];
  for (const cut of cuts) {
    if (cut > stockLength)
      return { ok: false, error: `Cut ${cut} exceeds stockLength ${stockLength}.` };
    let placed = false;
    for (const board of boards) {
      if (board.remaining >= cut) {
        board.cuts.push(cut);
        board.remaining -= cut;
        placed = true;
        break;
      }
    }
    if (!placed) boards.push({ cuts: [cut], remaining: stockLength - cut });
  }
  return { ok: true, disclaimer: DISCLAIMER, stockLength, boards, boardCount: boards.length };
}

export default run;
