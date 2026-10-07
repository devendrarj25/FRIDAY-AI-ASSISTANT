// FRIDAY · skill: car-resume-bullet
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
  const s = String(input.situation || rows(input)[0] || "");
  const t = String(input.task || rows(input)[1] || "");
  const a = String(input.action || rows(input)[2] || "");
  const r = String(input.result || rows(input)[3] || "");
  if (!a && !text(input)) return { ok: false, error: "Need at least the action you took." };
  const bullet = ["-", a || text(input), t && "(" + t + ")", r && "→ " + r, s && "(" + s + ")"]
    .filter(Boolean)
    .join(" ")
    .replace(/^\- /, "- ");
  return { ok: true, bullet };
}

export default run;
