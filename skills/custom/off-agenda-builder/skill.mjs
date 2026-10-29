// FRIDAY · skill: off-agenda-builder
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
  const topics = rows(input);
  const minutes = Math.max(15, num(input, "minutes", 30));
  if (!topics.length) return { ok: false, error: "List the agenda topics, one per line." };
  const slot = Math.max(3, Math.floor(minutes / (topics.length + 2)));
  const items = [
    { t: "Open + goal", m: slot },
    ...topics.map((t) => ({ t, m: slot })),
    { t: "Decisions + close", m: Math.max(5, minutes - slot * (topics.length + 1)) },
  ];
  return {
    ok: true,
    minutes,
    items,
    markdown: items.map((i, n) => n + 1 + ". " + i.t + " (" + i.m + " min)").join("\n"),
  };
}

export default run;
