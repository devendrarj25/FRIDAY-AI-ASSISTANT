// FRIDAY · skill: std-cornell
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
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste class notes." };
  const cues = lines.filter((l) => l.length < 48 || /:$/.test(l)).slice(0, 8);
  const details = lines.filter((l) => !cues.includes(l));
  return {
    ok: true,
    cues,
    details,
    summary: details[details.length - 1] || lines[0],
    markdown: [
      "# Cornell notes",
      "",
      "## Cues",
      ...cues.map((c) => "- " + c),
      "",
      "## Notes",
      ...details.map((d) => "- " + d),
      "",
      "## Summary",
      details[details.length - 1] || "",
    ].join("\n"),
  };
}

export default run;
