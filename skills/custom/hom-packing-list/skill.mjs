// FRIDAY · skill: hom-packing-list
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
  const nights = Math.max(1, Math.round(num(input, "nights", 3)));
  const climate = String(input.climate || "temperate").toLowerCase();
  const base = ["passport/id", "charger", "toiletries", nights + " underwear", nights + " socks"];
  if (/hot|warm/.test(climate)) base.push("sunscreen", "hat", nights + " light shirts");
  else if (/cold|winter/.test(climate)) base.push("warm layer", "gloves", "extra socks");
  if (/rain|wet/.test(climate)) base.push("rain jacket");
  base.push("meds if you use them", "one spare outfit");
  return {
    ok: true,
    nights,
    climate,
    list: base,
    markdown: base.map((i) => "- [ ] " + i).join("\n"),
  };
}

export default run;
