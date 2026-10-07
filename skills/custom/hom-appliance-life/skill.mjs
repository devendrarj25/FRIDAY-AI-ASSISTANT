// FRIDAY · skill: hom-appliance-life
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
  const TABLE = {
    refrigerator: "10–18 years",
    washer: "8–12 years",
    dryer: "8–12 years",
    dishwasher: "7–12 years",
    oven: "13–15 years",
    microwave: "7–10 years",
    ac: "10–15 years",
    waterheater: "8–12 years",
  };
  const q = text(input).toLowerCase();
  const hits = Object.entries(TABLE).filter(
    ([k]) => !q || q.includes(k) || k.includes(q.split(/\s+/)[0]),
  );
  return {
    ok: true,
    disclaimer: "Typical ranges from consumer-repair guides, not a warranty.",
    rows: (hits.length ? hits : Object.entries(TABLE)).map(([k, v]) => ({
      appliance: k,
      typical: v,
    })),
  };
}

export default run;
