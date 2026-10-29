// FRIDAY · skill: wrt-headlines
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
  const src = text(input).trim();
  if (!src) return { ok: false, error: "Paste the topic or blurb." };
  const words = src.split(/\s+/).slice(0, 12);
  const core = words.slice(0, 6).join(" ");
  const options = [
    core,
    core + " — what changed",
    "Why " + core,
    core + ", explained",
    "A practical look at " + words[0],
    words.slice(0, 4).join(" ") + " in one page",
    "Notes on " + core,
    core.replace(/^(the|a|an)\s+/i, ""),
  ].map((h) => h.replace(/\s+/g, " ").trim());
  return { ok: true, options };
}

export default run;
