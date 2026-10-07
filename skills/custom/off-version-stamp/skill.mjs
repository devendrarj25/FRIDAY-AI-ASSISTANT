// FRIDAY · skill: off-version-stamp
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
  const version = String(input.version || "0.0.0");
  const changes = rows(input);
  if (!changes.length) return { ok: false, error: "Paste change bullets." };
  const stamp = [
    "Version " + version,
    new Date().toISOString().slice(0, 10),
    "",
    ...changes.map((c) => "- " + c.replace(/^[-*]\s*/, "")),
  ].join("\n");
  return { ok: true, version, stamp };
}

export default run;
