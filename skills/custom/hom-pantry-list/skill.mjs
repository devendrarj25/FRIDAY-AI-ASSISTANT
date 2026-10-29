// FRIDAY · skill: hom-pantry-list
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
  const items = rows(input).map((l) =>
    l
      .toLowerCase()
      .replace(/^[-*\d.\s]+/, "")
      .replace(/\s+/g, " "),
  );
  if (!items.length) return { ok: false, error: "Paste ingredient lines." };
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  const list = [...counts.entries()].map(([name, n]) => ({ name, n }));
  return {
    ok: true,
    list,
    markdown: list.map((i) => "- [ ] " + i.name + (i.n > 1 ? " ×" + i.n : "")).join("\n"),
  };
}

export default run;
