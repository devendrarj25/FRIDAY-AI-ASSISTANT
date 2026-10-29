// FRIDAY · skill: wrt-outline
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
  const title = String(input.title || "Outline");
  const lines = rows(input);
  if (!lines.length) return { ok: false, error: "Paste headings or bullets." };
  const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
  const items = lines.slice(0, 8).map((line, i) => ({
    h: roman[i] + ". " + line,
    kids: lines
      .slice(8)
      .filter((_, j) => j % lines.slice(0, 8).length === i)
      .slice(0, 3),
  }));
  const markdown = [
    "# " + title,
    "",
    ...items.flatMap((it) => [it.h, ...it.kids.map((k) => "    A. " + k)]),
  ].join("\n");
  return { ok: true, title, markdown };
}

export default run;
