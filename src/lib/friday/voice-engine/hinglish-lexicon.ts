/**
 * FRIDAY · a small closed word lexicon for Hindi and English mixed in one sentence.
 *
 * Pure and table-driven: no model, no network, no clock. It answers two questions about a transcript:
 *   1. Which words are Hindi and which are English (`labelLanguages`)? Used to find the language-switch positions.
 *   2. What does the text look like under the script policy (`fixScript`)? Hindi words in Devanagari, English words
 *      in Latin, whatever the engine wrote: a sure Roman Hindi word becomes Devanagari, a Devanagari-spelled English
 *      loanword (डिस्क्रिप्शन) goes back to Latin (description).
 *
 * Only words in the tables change. An unknown word is never guessed at and never touched. A word that is both a
 * Hindi and an English word (do, main, to, me, hai ...) stays as written unless a word next to it is surely Hindi.
 *
 * The scorer folds both sides through `fixScript` before its Roman skeleton fold, which is how the T-WER number is
 * made (`transcript-scorer.ts`). The Python twin is `kernel/stt_bench.py`; `lexiconLines()` is hashed by both test
 * suites against `core/fixtures/voice-eval/twer-vectors.json`, so the two tables cannot drift apart.
 * The text layer may call `fixScript` too; it is not wired into the renderer here.
 */

export const LEXICON_VERSION = "hinglish-lex-1";

export type ScriptPolicy = "codemix" | "hindi" | "english";
export type WordLanguage = "hi" | "en" | "none";

/** Roman Hindi spellings (separated by "|") that mean one Hindi word and nothing in English, then its Devanagari. */
const SURE_HINDI: ReadonlyArray<readonly [string, string]> = [
  ["kal", "कल"],
  ["aaj|aj", "आज"],
  ["subah|subha|subeh", "सुबह"],
  ["shaam|sham", "शाम"],
  ["raat", "रात"],
  ["abhi", "अभी"],
  ["ab", "अब"],
  ["phir|fir", "फिर"],
  ["kya", "क्या"],
  ["kyun|kyu", "क्यों"],
  ["kyunki", "क्योंकि"],
  ["kaise", "कैसे"],
  ["kahan|kaha", "कहाँ"],
  ["kab", "कब"],
  ["kaun", "कौन"],
  ["kitna", "कितना"],
  ["kitne", "कितने"],
  ["mujhe", "मुझे"],
  ["mera", "मेरा"],
  ["meri", "मेरी"],
  ["mere", "मेरे"],
  ["tum", "तुम"],
  ["tumhe", "तुम्हें"],
  ["aap", "आप"],
  ["humein|hame", "हमें"],
  ["yeh", "यह"],
  ["ye", "ये"],
  ["woh|wo|vo", "वो"],
  ["nahi|nahin|nhi", "नहीं"],
  ["haan|han", "हाँ"],
  ["theek|thik", "ठीक"],
  ["achha|accha|acha", "अच्छा"],
  ["bahut|bohot", "बहुत"],
  ["thoda", "थोड़ा"],
  ["zyada|jyada|jyaada", "ज़्यादा"],
  ["kaam", "काम"],
  ["ghar", "घर"],
  ["paani|pani", "पानी"],
  ["khana", "खाना"],
  ["laga", "लगा"],
  ["lagao", "लगाओ"],
  ["lagana", "लगाना"],
  ["karo", "करो"],
  ["karna", "करना"],
  ["dijiye", "दीजिए"],
  ["bhejo", "भेजो"],
  ["bata", "बता"],
  ["batao", "बताओ"],
  ["dikhao", "दिखाओ"],
  ["kholo", "खोलो"],
  ["chalu", "चालू"],
  ["shuru", "शुरू"],
  ["rukho", "रुको"],
  ["suno", "सुनो"],
  ["dekho", "देखो"],
  ["chalo", "चलो"],
  ["bolo", "बोलो"],
  ["chahiye", "चाहिए"],
  ["hoon|hun", "हूँ"],
  ["hain", "हैं"],
  ["tha", "था"],
  ["thi", "थी"],
  ["raha", "रहा"],
  ["rahi", "रही"],
  ["rahe", "रहे"],
  ["jao", "जाओ"],
  ["aao", "आओ"],
  ["se", "से"],
  ["ko", "को"],
  ["ka", "का"],
  ["ki", "की"],
  ["ke", "के"],
  ["bhi", "भी"],
  ["aur", "और"],
  ["lekin", "लेकिन"],
  ["agar", "अगर"],
  ["toh", "तो"],
  ["sab", "सब"],
  ["kuch", "कुछ"],
  ["koi", "कोई"],
  ["bhai", "भाई"],
  ["dost", "दोस्त"],
  ["paise", "पैसे"],
  ["baje", "बजे"],
  ["samajh", "समझ"],
  ["pata", "पता"],
  ["zaroor|jaroor", "ज़रूर"],
  ["bilkul", "बिल्कुल"],
  ["dhanyavaad|dhanyavad", "धन्यवाद"],
  ["namaste", "नमस्ते"],
  ["shukriya", "शुक्रिया"],
  ["kripya", "कृपया"],
  ["jaldi", "जल्दी"],
  ["baad", "बाद"],
  ["pehle|pahle", "पहले"],
];

/** Words that are Hindi and English at once: they turn Devanagari only when a word beside them is surely Hindi. */
const AMBIGUOUS: ReadonlyArray<readonly [string, string]> = [
  ["do", "दो"],
  ["main", "मैं"],
  ["to", "तो"],
  ["me", "में"],
  ["mein", "में"],
  ["hai", "है"],
  ["hum", "हम"],
  ["par", "पर"],
  ["band", "बंद"],
  ["hi", "ही"],
  ["sun", "सुन"],
  ["chal", "चल"],
];

/** English loanwords: the Latin word, then the Devanagari spellings an engine writes for it (separated by "|"). */
const LOANWORDS: ReadonlyArray<readonly [string, string]> = [
  ["description", "डिस्क्रिप्शन|डिस्क्रिपशन"],
  ["meeting", "मीटिंग"],
  ["alarm", "अलार्म|अलारम"],
  ["phone", "फोन"],
  ["mobile", "मोबाइल"],
  ["computer", "कंप्यूटर|कम्प्यूटर"],
  ["laptop", "लैपटॉप"],
  ["email", "ईमेल"],
  ["message", "मैसेज|मेसेज"],
  ["reminder", "रिमाइंडर"],
  ["calendar", "कैलेंडर|कैलेण्डर"],
  ["battery", "बैटरी"],
  ["internet", "इंटरनेट"],
  ["wifi", "वाईफाई|वायफाय"],
  ["bluetooth", "ब्लूटूथ"],
  ["volume", "वॉल्यूम|वॉल्युम"],
  ["screen", "स्क्रीन"],
  ["screenshot", "स्क्रीनशॉट"],
  ["file", "फाइल"],
  ["folder", "फोल्डर"],
  ["download", "डाउनलोड"],
  ["upload", "अपलोड"],
  ["app", "ऐप|एप"],
  ["application", "एप्लीकेशन|एप्लिकेशन"],
  ["update", "अपडेट"],
  ["settings", "सेटिंग्स|सेटिंग"],
  ["password", "पासवर्ड"],
  ["camera", "कैमरा"],
  ["photo", "फोटो"],
  ["video", "वीडियो"],
  ["music", "म्यूजिक"],
  ["song", "सॉन्ग|सांग"],
  ["play", "प्ले"],
  ["pause", "पॉज"],
  ["stop", "स्टॉप"],
  ["next", "नेक्स्ट"],
  ["call", "कॉल"],
  ["number", "नंबर"],
  ["time", "टाइम"],
  ["ok", "ओके"],
  ["sorry", "सॉरी"],
  ["thanks", "थैंक्स"],
  ["please", "प्लीज"],
  ["report", "रिपोर्ट"],
  ["document", "डॉक्यूमेंट|डाक्यूमेंट"],
  ["schedule", "शेड्यूल"],
  ["notification", "नोटिफिकेशन"],
  ["search", "सर्च"],
  ["google", "गूगल"],
  ["youtube", "यूट्यूब"],
  ["whatsapp", "व्हाट्सएप|व्हाट्सऐप"],
  ["chrome", "क्रोम"],
  ["desktop", "डेस्कटॉप"],
  ["window", "विंडो"],
  ["mute", "म्यूट"],
  ["brightness", "ब्राइटनेस"],
  ["timer", "टाइमर"],
  ["note", "नोट"],
  ["task", "टास्क"],
  ["list", "लिस्ट"],
  ["mail", "मेल"],
  ["madam", "मैडम"],
  ["office", "ऑफिस"],
  ["bank", "बैंक"],
  ["doctor", "डॉक्टर"],
  ["hospital", "हॉस्पिटल"],
  ["train", "ट्रेन"],
  ["taxi", "टैक्सी"],
  ["ticket", "टिकट"],
  ["online", "ऑनलाइन"],
  ["offline", "ऑफलाइन"],
  ["mode", "मोड"],
  ["voice", "वॉइस|वॉयस"],
  ["friday", "फ्राइडे"],
  ["button", "बटन"],
  ["click", "क्लिक"],
  ["open", "ओपन"],
  ["close", "क्लोज"],
  ["send", "सेंड"],
  ["save", "सेव"],
  ["delete", "डिलीट"],
  ["project", "प्रोजेक्ट"],
  ["presentation", "प्रेजेंटेशन"],
  ["cancel", "कैंसल"],
  ["reply", "रिप्लाई"],
  ["problem", "प्रॉब्लम"],
  ["plan", "प्लान"],
  ["data", "डेटा"],
  ["traffic", "ट्रैफिक"],
  ["weather", "वेदर"],
  ["news", "न्यूज"],
  ["lunch", "लंच"],
  ["dinner", "डिनर"],
  ["movie", "मूवी"],
  ["bill", "बिल"],
  ["card", "कार्ड"],
  ["link", "लिंक"],
  ["share", "शेयर"],
  ["chat", "चैट"],
  ["team", "टीम"],
  ["client", "क्लाइंट"],
  ["budget", "बजट"],
  ["final", "फाइनल"],
  ["flight", "फ्लाइट"],
  ["hotel", "होटल"],
  ["restaurant", "रेस्टोरेंट"],
];

const DEVANAGARI = /[ऀ-ॿ]/;
const LETTER = /\p{L}/u;
const EDGE = /^([^\p{L}\p{M}\p{N}]*)(.*?)([^\p{L}\p{M}\p{N}]*)$/su;

/** A word on its lexicon key: NFC, lower case, the nukta dropped and the chandrabindu written as the anusvara. */
export function lexiconKey(word: string): string {
  return word.normalize("NFC").toLowerCase().replace(/़/g, "").replace(/ँ/g, "ं");
}

const sureHindi = new Map<string, string>();
const ambiguous = new Map<string, string>();
const loanwords = new Map<string, string>();
for (const [variants, devanagari] of SURE_HINDI) {
  for (const v of variants.split("|")) sureHindi.set(v, devanagari);
}
for (const [roman, devanagari] of AMBIGUOUS) ambiguous.set(roman, devanagari);
for (const [latin, spellings] of LOANWORDS) {
  for (const s of spellings.split("|")) loanwords.set(lexiconKey(s), latin);
}

/** One line per table entry, in a fixed order, so two implementations can compare a hash of their tables. */
export function lexiconLines(): string[] {
  const lines: string[] = [];
  for (const [k, v] of sureHindi) lines.push(`sure|${k}|${v}`);
  for (const [k, v] of ambiguous) lines.push(`ambiguous|${k}|${v}`);
  for (const [k, v] of loanwords) lines.push(`loan|${k}|${v}`);
  return lines.sort();
}

type Kind = { lang: WordLanguage; deva?: string; latin?: string; maybe?: boolean };

function firstPass(core: string): Kind {
  if (!LETTER.test(core)) return { lang: "none" };
  const key = lexiconKey(core);
  if (DEVANAGARI.test(key)) {
    const latin = loanwords.get(key);
    return latin !== undefined ? { lang: "en", latin } : { lang: "hi" };
  }
  const sure = sureHindi.get(key);
  if (sure !== undefined) return { lang: "hi", deva: sure };
  const maybe = ambiguous.get(key);
  if (maybe !== undefined) return { lang: "en", deva: maybe, maybe: true };
  return { lang: "en" };
}

/** Each word of a token list (words already stripped of punctuation) as Hindi, English or neither (digits). */
function classify(cores: readonly string[]): Kind[] {
  const first = cores.map(firstPass);
  return first.map((kind, i) => {
    if (!kind.maybe) return kind;
    const hindiBeside = first[i - 1]?.lang === "hi" || first[i + 1]?.lang === "hi";
    return hindiBeside ? { lang: "hi", deva: kind.deva! } : { lang: "en" as const };
  });
}

/** Hindi, English or none for each word. A Devanagari loanword is English, a sure Roman Hindi word is Hindi. */
export function labelLanguages(cores: readonly string[]): WordLanguage[] {
  return classify(cores).map((k) => k.lang);
}

/** The words of `cores` rewritten to the policy; every other word is returned as it came. */
export function fixCores(cores: readonly string[], policy: ScriptPolicy = "codemix"): string[] {
  const toDevanagari = policy !== "english";
  const toLatin = policy !== "hindi";
  return classify(cores).map((kind, i) => {
    const core = cores[i]!;
    if (toDevanagari && kind.lang === "hi" && kind.deva !== undefined) return kind.deva;
    if (toLatin && kind.lang === "en" && kind.latin !== undefined) return kind.latin;
    return core;
  });
}

/**
 * Put a transcript on the script policy: `codemix` writes Hindi words in Devanagari and English words in Latin;
 * `hindi` only turns Roman Hindi into Devanagari; `english` only turns Devanagari loanwords back into Latin.
 * Spacing and the punctuation around a word are kept; a word that is not in the tables is left exactly as it was.
 */
export function fixScript(text: string, expectedPolicy: ScriptPolicy = "codemix"): string {
  const pieces = String(text).split(/(\s+)/);
  const slots: Array<{ at: number; lead: string; core: string; tail: string }> = [];
  pieces.forEach((piece, at) => {
    if (!piece || /^\s+$/.test(piece)) return;
    const m = EDGE.exec(piece)!;
    slots.push({ at, lead: m[1]!, core: m[2]!, tail: m[3]! });
  });
  const fixed = fixCores(
    slots.map((s) => s.core),
    expectedPolicy,
  );
  slots.forEach((s, i) => {
    pieces[s.at] = s.lead + fixed[i]! + s.tail;
  });
  return pieces.join("");
}
