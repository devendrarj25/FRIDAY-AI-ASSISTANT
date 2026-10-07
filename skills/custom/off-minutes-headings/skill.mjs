// FRIDAY · skill: off-minutes-headings
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
  const title = String(input.title || "Meeting");
  const markdown = [
    "# Minutes — " + title,
    "",
    "## Attendance",
    "- ",
    "",
    "## Agenda",
    "- ",
    "",
    "## Discussion",
    "- ",
    "",
    "## Decisions",
    "- ",
    "",
    "## Actions",
    "| Item | Owner | Due |",
    "| --- | --- | --- |",
    "",
    "## Next meeting",
    "- ",
  ].join("\n");
  return { ok: true, title, markdown };
}

export default run;
