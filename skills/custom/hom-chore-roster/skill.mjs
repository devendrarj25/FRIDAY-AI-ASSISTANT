// FRIDAY · skill: hom-chore-roster
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
  const chores = rows(input);
  if (!chores.length) return { ok: false, error: "List chores, one per line." };
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const roster = days.map((day, i) => ({ day, chores: chores.filter((_, n) => n % 7 === i) }));
  return {
    ok: true,
    roster,
    markdown: roster.map((r) => "**" + r.day + "** — " + (r.chores.join(", ") || "—")).join("\n"),
  };
}

export default run;
