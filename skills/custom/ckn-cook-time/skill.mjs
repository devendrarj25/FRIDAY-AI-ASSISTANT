// FRIDAY · skill: ckn-cook-time
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
  const kg = num(input, "kg");
  const kind = String(input.kind || "roast").toLowerCase();
  if (!(kg > 0)) return { ok: false, error: "Type kg." };
  const per = /poultry|chicken/.test(kind) ? 40 : 30;
  const minutes = Math.round(kg * per);
  return {
    ok: true,
    kg,
    kind,
    minutes,
    rest: 15,
    note: "Sketch only — use a thermometer for doneness.",
  };
}

export default run;
