// FRIDAY · skill: trv-phrase-card
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
  const lang = String(input.lang || "hi")
    .toLowerCase()
    .slice(0, 2);
  const cards = {
    hi: {
      please: "kripya",
      thanks: "dhanyavaad",
      help: "madad",
      water: "paani",
      yes: "haan",
      no: "nahin",
    },
    es: {
      please: "por favor",
      thanks: "gracias",
      help: "ayuda",
      water: "agua",
      yes: "sí",
      no: "no",
    },
    fr: {
      please: "s'il vous plaît",
      thanks: "merci",
      help: "aide",
      water: "eau",
      yes: "oui",
      no: "non",
    },
    en: {
      please: "please",
      thanks: "thank you",
      help: "help",
      water: "water",
      yes: "yes",
      no: "no",
    },
  };
  return {
    ok: true,
    disclaimer: "Planning helper only. FRIDAY does not book tickets, hotels, or visas.",
    lang,
    phrases: cards[lang] || cards.en,
  };
}

export default run;
