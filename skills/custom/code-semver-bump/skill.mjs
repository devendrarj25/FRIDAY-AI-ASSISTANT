// FRIDAY · skill: code-semver-bump
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
  const current = String(input.version || "0.0.0");
  const parts = current.split(".").map((v) => Number(v) || 0);
  while (parts.length < 3) parts.push(0);
  const blob = text(input).toLowerCase();
  let bump = "patch";
  if (/\bbreaking\b|\bmajor\b/.test(blob)) bump = "major";
  else if (/\bfeat\b|\bminor\b|add /.test(blob)) bump = "minor";
  if (bump === "major") {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (bump === "minor") {
    parts[1] += 1;
    parts[2] = 0;
  } else parts[2] += 1;
  return {
    ok: true,
    current,
    bump,
    next: parts.join("."),
    note: "Suggestion only — FRIDAY product version stays in config/friday-version.json.",
  };
}

export default run;
