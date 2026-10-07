// FRIDAY · skill: com-intro-blurb
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
  const name = String(input.name || "");
  const role = String(input.role || "");
  const helps = String(input.helps || text(input) || "");
  if (!name && !helps) return { ok: false, error: "Need a name or what you help with." };
  const blurb = [name, role, helps].filter(Boolean).join(" — ");
  return { ok: true, blurb };
}

export default run;
