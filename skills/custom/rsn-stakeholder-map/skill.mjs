// FRIDAY · skill: rsn-stakeholder-map
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
  const people = [];
  for (const line of rows(input)) {
    const parts = line
      .split(/[,|;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) continue;
    const influence = /high|4|5/i.test(parts[2] || parts[1] || "") ? "high" : "low";
    const interest = /high|4|5/i.test(parts[1] || "") ? "high" : "low";
    people.push({ name: parts[0], interest, influence });
  }
  if (!people.length) return { ok: false, error: "Paste name, interest, influence lines." };
  return {
    ok: true,
    manageClosely: people.filter((p) => p.interest === "high" && p.influence === "high"),
    keepInformed: people.filter((p) => p.interest === "high" && p.influence === "low"),
    keepSatisfied: people.filter((p) => p.interest === "low" && p.influence === "high"),
    monitor: people.filter((p) => p.interest === "low" && p.influence === "low"),
  };
}

export default run;
