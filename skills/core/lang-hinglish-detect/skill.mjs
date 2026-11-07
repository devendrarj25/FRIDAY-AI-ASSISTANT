// FRIDAY · skill: lang-hinglish-detect
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Tells English, Hindi (Devanagari), Hinglish (Hindi in Latin letters) and mixed text apart, and lists the
// Hindi words it recognised with their English meaning, so a spoken or typed Hinglish command is read correctly.

// Romanised Hindi words that are common in everyday commands. "kal" and "parso" mean both a day ahead and a day
// behind, so they are flagged as ambiguous and the tense of the sentence has to decide.
const LEXICON = {
  hai: "is",
  hain: "are",
  tha: "was",
  thi: "was",
  the: "were",
  hoga: "will be",
  nahi: "no / not",
  nahin: "no / not",
  mat: "do not",
  haan: "yes",
  ji: "(polite)",
  na: "no / right?",
  kya: "what",
  kaun: "who",
  kab: "when",
  kahan: "where",
  kyun: "why",
  kyon: "why",
  kaise: "how",
  kitna: "how much",
  kitne: "how many",
  kaunsa: "which",
  aaj: "today",
  kal: "tomorrow / yesterday",
  parso: "day after tomorrow / day before yesterday",
  abhi: "now",
  pehle: "before / first",
  baad: "after / later",
  phir: "then / again",
  jaldi: "quickly",
  der: "late",
  subah: "morning",
  dopahar: "afternoon",
  shaam: "evening",
  raat: "night",
  baje: "o'clock",
  ghanta: "hour",
  ghante: "hours",
  minute: "minute",
  din: "day",
  hafta: "week",
  mahina: "month",
  saal: "year",
  somvar: "Monday",
  mangalvar: "Tuesday",
  budhvar: "Wednesday",
  guruvar: "Thursday",
  brihaspativar: "Thursday",
  shukravar: "Friday",
  shanivar: "Saturday",
  ravivar: "Sunday",
  karo: "do",
  kar: "do",
  karna: "to do",
  kardo: "do it",
  karde: "do it",
  dena: "to give",
  do: "give",
  de: "give",
  dijiye: "please give",
  bhejo: "send",
  bhej: "send",
  bhejna: "to send",
  batao: "tell",
  bata: "tell",
  bolo: "say",
  dikhao: "show",
  dikha: "show",
  kholo: "open",
  khol: "open",
  band: "close / off",
  chalu: "start / on",
  shuru: "start",
  ruko: "stop / wait",
  roko: "stop",
  rok: "stop",
  dhundo: "find",
  khojo: "find",
  dhoondo: "find",
  likho: "write",
  padho: "read",
  suno: "listen",
  dekho: "look",
  dekh: "look",
  yaad: "remember",
  dilana: "remind",
  dilao: "remind",
  bhool: "forget",
  jao: "go",
  aao: "come",
  chalo: "let's go",
  chal: "go",
  rakho: "keep",
  rakh: "keep",
  hatao: "remove",
  mita: "delete",
  mitao: "delete",
  save: "save",
  sunao: "play / tell",
  bajao: "play",
  badlo: "change",
  badal: "change",
  mujhe: "to me",
  mera: "my",
  meri: "my",
  mere: "my",
  tumhara: "your",
  aapka: "your",
  aapki: "your",
  uska: "his / her",
  unka: "their",
  hum: "we",
  main: "I",
  mai: "I",
  tum: "you",
  aap: "you (polite)",
  ye: "this",
  yeh: "this",
  wo: "that",
  woh: "that",
  yahan: "here",
  wahan: "there",
  ke: "of",
  ka: "of",
  ki: "of",
  ko: "to",
  se: "from / with",
  mein: "in",
  me: "in",
  par: "on",
  pe: "on",
  liye: "for",
  saath: "with",
  aur: "and",
  ya: "or",
  lekin: "but",
  agar: "if",
  toh: "then",
  bhi: "also",
  sirf: "only",
  bahut: "very",
  thoda: "a little",
  zyada: "more",
  kam: "less",
  sab: "all",
  sabhi: "all",
  koi: "any",
  kuch: "something",
  accha: "good",
  acha: "good",
  theek: "okay / fine",
  thik: "okay / fine",
  sahi: "correct",
  galat: "wrong",
  naya: "new",
  purana: "old",
  bada: "big",
  chota: "small",
  bhai: "brother (friend)",
  yaar: "friend",
  dost: "friend",
  bhaiya: "brother",
  didi: "sister",
  paisa: "money",
  paise: "money",
  rupaye: "rupees",
  rupay: "rupees",
  kharcha: "expense",
  hisaab: "account / calculation",
  bill: "bill",
  kaam: "work",
  file: "file",
  folder: "folder",
  khaana: "food",
  chai: "tea",
  pani: "water",
  ghar: "home",
  office: "office",
};
const AMBIGUOUS = new Set(["kal", "parso"]);
// Words that are ordinary English as well ("the", "do", "me", "main", "file"): they never count as Hindi evidence.
const SHARED = new Set([
  "the",
  "do",
  "me",
  "main",
  "mai",
  "file",
  "folder",
  "office",
  "bill",
  "minute",
  "save",
  "par",
  "na",
  "ji",
  "de",
  "kar",
  "tha",
  "thi",
  "sal",
  "ya",
]);
const ENGLISH = new Set(
  "the and is are was were will would could should have has had for with this that from your you not what when where how please can open close send show find write read play stop start remind meeting tomorrow today tonight morning evening time file folder message email call set turn off on".split(
    " ",
  ),
);

export async function run(input = {}) {
  const text = String(input?.text ?? input?.prompt ?? "");
  if (!text.trim()) return { ok: false, error: "Give the sentence or transcript to check." };
  const devanagari = (text.match(/[\u0900-\u097f]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const hindiWords = tokens.filter(
    (w) => (LEXICON[w] !== undefined || AMBIGUOUS.has(w)) && !SHARED.has(w),
  );
  const englishWords = tokens.filter((w) => ENGLISH.has(w) && LEXICON[w] === undefined);
  const hindiShare = tokens.length ? hindiWords.length / tokens.length : 0;
  const englishShare = tokens.length ? englishWords.length / tokens.length : 0;
  const total = devanagari + latin;
  const scriptDevanagari = total ? devanagari / total : 0;
  let language;
  if (scriptDevanagari > 0.6) language = "Hindi (Devanagari script)";
  else if (devanagari > 0 && latin > 0) language = "Mixed Hindi (Devanagari) and English";
  else if (hindiWords.length >= 2 && hindiShare >= 0.2 && englishWords.length >= 1)
    language = "Hinglish (Hindi and English in Latin letters)";
  else if (hindiWords.length >= 2 && hindiShare >= 0.3)
    language = "Hinglish (Hindi in Latin letters)";
  else language = "English";
  const seen = new Map();
  for (const w of hindiWords)
    if (!seen.has(w)) seen.set(w, LEXICON[w] ?? "day shifted by one: tomorrow or yesterday");
  const ambiguous = [...new Set(hindiWords.filter((w) => AMBIGUOUS.has(w)))];
  return {
    ok: true,
    language,
    isHinglish: language.startsWith("Hinglish"),
    scripts: { devanagariLetters: devanagari, latinLetters: latin },
    hindiWordShare: Math.round(hindiShare * 100) / 100,
    englishWordShare: Math.round(englishShare * 100) / 100,
    recognisedHindiWords: [...seen.entries()].map(([word, meaning]) => ({ word, meaning })),
    ambiguous: ambiguous.length
      ? ambiguous.map(
          (w) =>
            `"${w}" can mean tomorrow or yesterday (parso: day after tomorrow or day before yesterday); the tense of the sentence decides.`,
        )
      : undefined,
    answer: `${language}.${
      seen.size
        ? ` Recognised: ${[...seen.entries()]
            .slice(0, 8)
            .map(([w, m]) => `${w} = ${m}`)
            .join(", ")}.`
        : ""
    }`,
    note: "A word list, not a translator: unfamiliar words are left out rather than guessed. Meanings are everyday ones; context can change them.",
  };
}

export default run;
