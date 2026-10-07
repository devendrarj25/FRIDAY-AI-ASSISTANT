// FRIDAY · skill: trv-pack-climate
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
  const climate = String(input.climate || text(input) || "temperate").toLowerCase();
  const extras = [];
  if (/hot|humid|desert/.test(climate)) extras.push("electrolytes", "sun sleeves", "light scarf");
  if (/cold|snow|alpine/.test(climate)) extras.push("base layer", "lip balm", "hand warmers");
  if (/rain|monsoon/.test(climate)) extras.push("dry bag", "quick-dry towel");
  if (/altitude|himalaya|andes/.test(climate)) extras.push("slow first day", "layers");
  if (!extras.length) extras.push("comfortable walking shoes", "universal adapter");
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    climate,
    extras,
  };
}

export default run;
