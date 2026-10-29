// FRIDAY · skill: wrt-faq
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
  if (!lines.length) return { ok: false, error: "Paste notes or questions." };
  const pairs = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/\?$/.test(lines[i]) || /^q[:\s]/i.test(lines[i])) {
      pairs.push({
        q: lines[i].replace(/^q[:\s]+/i, ""),
        a: lines[i + 1] && !/\?$/.test(lines[i + 1]) ? lines[i + 1] : "[answer]",
      });
    }
  }
  if (!pairs.length) pairs.push({ q: "What is this about?", a: lines[0] });
  const markdown = pairs.map((p) => "**" + p.q + "**\n" + p.a).join("\n\n");
  return { ok: true, count: pairs.length, pairs, markdown };
}

export default run;
