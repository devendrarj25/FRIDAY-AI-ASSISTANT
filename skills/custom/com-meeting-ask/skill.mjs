// FRIDAY · skill: com-meeting-ask
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
  const purpose = String(input.purpose || text(input) || "a short discussion");
  const minutes = num(input, "minutes", 30);
  const options = String(input.options || "Option A / Option B");
  const body = [
    "Hi,",
    "",
    "Could we meet for " + minutes + " minutes about " + purpose + "?",
    "Two options that work on my side: " + options + ".",
    "",
    "Happy to adjust.",
    "",
    "Thanks",
  ].join("\n");
  return { ok: true, body };
}

export default run;
