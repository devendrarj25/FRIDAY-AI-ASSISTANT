// FRIDAY · skill: trv-doc-checklist
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
  const items = [
    "passport (validity 6+ months where required)",
    "tickets / booking refs",
    "visas if the destination needs them — check official sources",
    "travel insurance summary",
    "vaccination proof if asked",
    "emergency contacts",
    "copies stored separately",
  ];
  return {
    ok: true,
    disclaimer:
      "Planning helper only. FRIDAY does not book tickets, hotels, or visas. Not official visa advice.",
    markdown: items.map((i) => "- [ ] " + i).join("\n"),
  };
}

export default run;
