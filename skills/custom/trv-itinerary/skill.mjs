// FRIDAY · skill: trv-itinerary
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
  const city = String(input.city || rows(input)[0] || "City");
  const days = Math.max(1, Math.min(14, Math.round(num(input, "days", 3))));
  const plan = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    morning: "",
    afternoon: "",
    evening: "",
  }));
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    city,
    plan,
    markdown: plan
      .map((p) => "### Day " + p.day + " — " + city + "\n- Morning:\n- Afternoon:\n- Evening:")
      .join("\n\n"),
  };
}

export default run;
