// FRIDAY · skill: off-memo-outline
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
  const title = String(input.title || "Memo");
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste the notes to outline." };
  const ask =
    lines.find((l) => /\b(please|need|request|approve|decide)\b/i.test(l)) ||
    lines[lines.length - 1];
  return {
    ok: true,
    title,
    outline: {
      to: "",
      from: "",
      date: "today",
      purpose: lines[0],
      facts: lines.slice(1, 8),
      ask,
      nextStep: "Confirm owners and due date.",
    },
    markdown: [
      "# " + title,
      "",
      "## Purpose",
      lines[0],
      "",
      "## Facts",
      ...lines.slice(1, 8).map((l) => "- " + l),
      "",
      "## Ask",
      ask,
      "",
      "## Next step",
      "- Confirm owners and due date.",
    ].join("\n"),
  };
}

export default run;
