// FRIDAY · skill: hom-plant-water
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
  const plants = rows(input);
  if (!plants.length) return { ok: false, error: "List plant names (optionally with dry/wet)." };
  const table = plants.map((p) => {
    const kind = /succulent|cactus|dry/i.test(p)
      ? "dry"
      : /fern|wet|tropic/i.test(p)
        ? "wet"
        : "average";
    const days = kind === "dry" ? 14 : kind === "wet" ? 3 : 7;
    return { plant: p, kind, everyDays: days };
  });
  return { ok: true, table };
}

export default run;
