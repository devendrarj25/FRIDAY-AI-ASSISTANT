// FRIDAY · skill: hlt-vaccine-record
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
  const rows = ["tetanus", "influenza", "covid", "hepatitis B", "other"].map(
    (n) => "| " + n + " | | | |",
  );
  const markdown = [
    "# Personal immunisation record (template)",
    "",
    "| Vaccine | Date | Batch / clinic | Notes |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  return {
    ok: true,
    disclaimer:
      "Education and templates only — not medical advice, diagnosis, or treatment. Ask a clinician for personal health decisions.",
    markdown,
  };
}

export default run;
