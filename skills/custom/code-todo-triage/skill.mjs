// FRIDAY · skill: code-todo-triage
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
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
  const lines = String(input.code || input.text || "").split(/\n/);
  const items = [];
  lines.forEach((line, index) => {
    const match = line.match(/\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)$/i);
    if (!match) return;
    const body = match[2] || "";
    const urgency = /security|inject|secret|auth/i.test(body)
      ? "high"
      : /bug|crash|fail/i.test(body)
        ? "medium"
        : "later";
    items.push({
      line: index + 1,
      marker: match[1].toUpperCase(),
      urgency,
      text: body.trim().slice(0, 200),
    });
  });
  return { ok: true, items, high: items.filter((i) => i.urgency === "high").length };
}

export default run;
