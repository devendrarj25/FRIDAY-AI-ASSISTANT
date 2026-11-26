/**
 * FRIDAY · command lane: the closed vocabulary of short spoken controls (stop, mute, volume, pause, open an app,
 * repeat) that can be answered without the open speech model or the brain.
 *
 * Pure, deterministic and fast (no timers, no I/O). `matchCommand` accepts a line only when the WHOLE utterance,
 * after a fold, is one known phrase: "ruko" is a hit, "ruko aur mujhe batao ki ..." is not and falls through.
 * The fold lowers case, drops punctuation, politeness (please, zara, ji, na), fillers (um, acha) and a leading
 * "Friday", folds the Devanagari nukta, and reads the usual spellings (kar do, kijiye, awaz) as one.
 * `open` names come only from the injected registry; a name of 5 or more characters may be one edit away, a
 * shorter name never; two registry apps that fit equally give no hit. Consequential words (delete, send, pay,
 * install, run, shutdown and kin) are never in the lane: one such word anywhere in the line is no hit.
 * Nothing here approves, confirms or answers yes: a hit only names a command for the router to place.
 */
import { lexiconKey } from "./hinglish-lexicon";

export type CommandName =
  | "stop"
  | "stop-all"
  | "mute"
  | "unmute"
  | "pause"
  | "resume"
  | "volume-up"
  | "volume-down"
  | "open"
  | "repeat"
  | "louder"
  | "quieter";
export type VocabularyCommand = Exclude<CommandName, "open">;
export type CommandLang = "en" | "hi" | "hinglish";
export type CommandRegistryEntry = { id: string; names: readonly string[] };
export type CommandContext = { registry: readonly CommandRegistryEntry[]; lang?: CommandLang };
export type CommandHit = {
  hit: true;
  command: CommandName;
  args?: { target?: string; id?: string };
  confidence: number;
  folded: string;
};
export type CommandMatch = { hit: false } | CommandHit;

type Phrases = { en: readonly string[]; hinglish: readonly string[]; hi: readonly string[] };
const phrases = (en: string[], hinglish: string[], hi: string[]): Phrases =>
  Object.freeze({
    en: Object.freeze(en),
    hinglish: Object.freeze(hinglish),
    hi: Object.freeze(hi),
  });

/** Every phrase of the lane, by verb and language. The fold also reads the usual spelling variants of each. */
export const COMMAND_VOCABULARY: Readonly<Record<VocabularyCommand, Phrases>> = Object.freeze({
  stop: phrases(
    [
      "stop",
      "stop it",
      "stop that",
      "stop talking",
      "stop speaking",
      "enough",
      "be quiet",
      "silence",
    ],
    ["ruko", "rukiye", "ruk jao", "bas", "bas karo", "bas ho gaya", "ruko ruko", "bas bas"],
    ["रुको", "रुकिए", "रुक जाओ", "बस", "बस करो", "बस हो गया", "रुको रुको", "बस बस"],
  ),
  "stop-all": phrases(
    ["stop all", "stop everything", "stop all tasks", "halt everything"],
    ["sab roko", "sab kuch roko", "sab ruko", "sab band karo", "sab kuch band karo"],
    ["सब रोको", "सब कुछ रोको", "सब रुको", "सब बंद करो", "सब कुछ बंद करो"],
  ),
  mute: phrases(
    ["mute", "mute yourself", "mute mic", "mute the mic", "go silent"],
    ["chup", "chup ho jao", "chup raho", "chup karo", "mute karo"],
    ["म्यूट", "म्यूट करो", "चुप", "चुप हो जाओ", "चुप रहो", "चुप करो"],
  ),
  unmute: phrases(
    ["unmute", "unmute yourself", "unmute mic", "unmute the mic"],
    ["unmute karo"],
    ["अनम्यूट", "अनम्यूट करो"],
  ),
  pause: phrases(
    ["pause", "pause it", "pause that", "pause playback"],
    ["pause karo", "thehro", "roko"],
    ["पॉज", "पॉज करो", "ठहरो", "रोको"],
  ),
  resume: phrases(
    ["resume", "resume it", "continue", "carry on", "go on", "keep going"],
    ["resume karo", "continue karo", "jaari rakho", "phir se chalao", "phir chalao", "chalu rakho"],
    ["रिज्यूम", "रिज्यूम करो", "जारी रखो", "फिर से चलाओ", "फिर चलाओ", "चालू रखो"],
  ),
  "volume-up": phrases(
    ["volume up", "turn up the volume", "turn it up", "increase the volume", "raise the volume"],
    [
      "volume badhao",
      "volume tez karo",
      "volume zyada karo",
      "awaaz badhao",
      "awaaz tez",
      "awaaz tez karo",
    ],
    ["आवाज़ बढ़ाओ", "आवाज़ तेज़", "आवाज़ तेज़ करो", "वॉल्यूम बढ़ाओ", "वॉल्यूम तेज़ करो", "वॉल्यूम अप"],
  ),
  "volume-down": phrases(
    [
      "volume down",
      "turn down the volume",
      "turn it down",
      "decrease the volume",
      "lower the volume",
    ],
    [
      "volume kam karo",
      "volume ghatao",
      "volume dheere karo",
      "awaaz kam karo",
      "awaaz dheere",
      "awaaz dheere karo",
    ],
    ["आवाज़ कम करो", "आवाज़ घटाओ", "आवाज़ धीरे", "आवाज़ धीरे करो", "वॉल्यूम कम करो", "वॉल्यूम डाउन"],
  ),
  louder: phrases(
    ["louder", "speak louder", "speak up", "say it louder"],
    ["zor se bolo", "zor se"],
    ["ज़ोर से बोलो", "ज़ोर से"],
  ),
  quieter: phrases(
    ["quieter", "speak quieter", "softer", "speak softly", "lower your voice"],
    ["dheere bolo", "halke bolo"],
    ["धीरे बोलो", "हल्के बोलो"],
  ),
  repeat: phrases(
    [
      "repeat",
      "repeat that",
      "repeat it",
      "say that again",
      "say it again",
      "say again",
      "once more",
    ],
    [
      "dobara bolo",
      "phir se bolo",
      "phir bolo",
      "ek baar phir bolo",
      "ek baar aur bolo",
      "repeat karo",
    ],
    [
      "दोबारा बोलो",
      "फिर से बोलो",
      "फिर बोलो",
      "एक बार फिर बोलो",
      "एक बार और बोलो",
      "रिपीट",
      "रिपीट करो",
    ],
  ),
});

/** The verbs that may be taken while she speaks without the wake word: each one only makes her quieter or stops. */
export const SAFETY_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "stop",
  "stop-all",
  "mute",
  "pause",
  "volume-down",
  "quieter",
]);

/** Words that make a line consequential. One of them anywhere means it never takes the lane. */
const CONSEQUENTIAL_SOURCE = [
  "delete",
  "remove",
  "erase",
  "format",
  "wipe",
  "uninstall",
  "install",
  "send",
  "pay",
  "payment",
  "buy",
  "purchase",
  "order",
  "transfer",
  "submit",
  "run",
  "execute",
  "kill",
  "shutdown",
  "shut",
  "restart",
  "reboot",
  "logout",
  "signout",
  "mita",
  "mitao",
  "hata",
  "hatao",
  "bhej",
  "bhejo",
  "bhugtan",
  "kharido",
  "khareedo",
  "डिलीट",
  "मिटा",
  "मिटाओ",
  "हटा",
  "हटाओ",
  "भेज",
  "भेजो",
  "पेमेंट",
  "भुगतान",
  "इंस्टॉल",
  "शटडाउन",
  "रीस्टार्ट",
  "रन",
  "खरीदो",
  "खरीद",
];

/** Politeness and filler tokens, and the address, that never change what a command means. */
const DROP_SOURCE = [
  "please",
  "plz",
  "pls",
  "zara",
  "jara",
  "ji",
  "na",
  "kripya",
  "krupya",
  "thoda",
  "thodi",
  "thode",
  "um",
  "umm",
  "uh",
  "uhh",
  "er",
  "hmm",
  "hm",
  "acha",
  "achha",
  "accha",
  "hey",
  "friday",
  "जी",
  "ना",
  "कृपया",
  "जरा",
  "थोड़ा",
  "थोड़ी",
  "थोड़े",
  "उम",
  "अह",
  "हम्म",
  "अच्छा",
  "अछा",
  "फ्राइडे",
  "फ्राईडे",
];

/** Spelling variants read as one: [spoken (one to three words), canonical]. Both sides go through the base fold. */
const CANON_SOURCE: ReadonlyArray<readonly [string, string]> = [
  ["kar do", "karo"],
  ["kar de", "karo"],
  ["kardo", "karo"],
  ["kijiye", "karo"],
  ["kijiyega", "karo"],
  ["kariye", "karo"],
  ["karen", "karo"],
  ["karein", "karo"],
  ["kare", "karo"],
  ["kar", "karo"],
  ["khol do", "kholo"],
  ["khol de", "kholo"],
  ["kholiye", "kholo"],
  ["badha do", "badhao"],
  ["badha de", "badhao"],
  ["badhaao", "badhao"],
  ["badhaye", "badhao"],
  ["badhaiye", "badhao"],
  ["ghata do", "ghatao"],
  ["ghata de", "ghatao"],
  ["ghataao", "ghatao"],
  ["rok do", "roko"],
  ["rok de", "roko"],
  ["jaao", "jao"],
  ["ja", "jao"],
  ["awaz", "awaaz"],
  ["avaaz", "awaaz"],
  ["aawaz", "awaaz"],
  ["awaj", "awaaz"],
  ["awaaj", "awaaz"],
  ["teez", "tez"],
  ["tej", "tez"],
  ["jor", "zor"],
  ["dhire", "dheere"],
  ["dheeray", "dheere"],
  ["dheeme", "dheere"],
  ["dhime", "dheere"],
  ["dheere se", "dheere"],
  ["dubara", "dobara"],
  ["dobaara", "dobara"],
  ["dubaara", "dobara"],
  ["fir se", "phir se"],
  ["firse", "phir se"],
  ["phirse", "phir se"],
  ["fir", "phir"],
  ["jari", "jaari"],
  ["jaari", "jaari"],
  ["thahro", "thehro"],
  ["theharo", "thehro"],
  ["thaharo", "thehro"],
  ["vol", "volume"],
  ["volum", "volume"],
  ["un mute", "unmute"],
  ["ripeat", "repeat"],
  ["कर दो", "करो"],
  ["कर दें", "करो"],
  ["कर दे", "करो"],
  ["कीजिए", "करो"],
  ["कीजिये", "करो"],
  ["करिए", "करो"],
  ["करें", "करो"],
  ["खोल दो", "खोलो"],
  ["खोल दें", "खोलो"],
  ["खोल दे", "खोलो"],
  ["खोलिए", "खोलो"],
  ["बढ़ा दो", "बढ़ाओ"],
  ["बढ़ाइए", "बढ़ाओ"],
  ["बढ़ा दें", "बढ़ाओ"],
  ["घटा दो", "घटाओ"],
  ["घटा दें", "घटाओ"],
  ["रोक दो", "रोको"],
  ["रोक दें", "रोको"],
  ["जा", "जाओ"],
  ["अवाज", "आवाज"],
  ["धीमे", "धीरे"],
  ["धीरे से", "धीरे"],
  ["दुबारा", "दोबारा"],
  ["वाल्यूम", "वॉल्यूम"],
  ["वोल्यूम", "वॉल्यूम"],
  ["म्युट", "म्यूट"],
  ["पाज", "पॉज"],
  ["पौज", "पॉज"],
];

const OPEN_PREFIX: ReadonlySet<string> = new Set(["open", "launch", "ओपन", "लॉन्च"].map(lexiconKey));
const OPEN_SUFFIX_WORDS: ReadonlySet<string> = new Set(["kholo", "खोलो"].map(lexiconKey));
const OPEN_VERB_BEFORE_KARO: ReadonlySet<string> = new Set(
  ["open", "launch", "ओपन", "लॉन्च"].map(lexiconKey),
);
const KARO_WORDS: ReadonlySet<string> = new Set(["karo", "करो"].map(lexiconKey));
const NAME_LEAD_WORDS: ReadonlySet<string> = new Set(["the", "my"]);
const NAME_TAIL_WORDS: ReadonlySet<string> = new Set(["ko", "को"].map(lexiconKey));

const SEPARATORS = /[^\p{L}\p{M}\p{N}]+/gu;
const INVISIBLE = /[\u200b-\u200d\ufeff]/g;

/** The fold without the spelling variants: lower case, nukta, punctuation, politeness and fillers gone. */
function baseTokens(text: string, drop: ReadonlySet<string>): string[] {
  const key = lexiconKey(String(text ?? "").replace(INVISIBLE, "")).replace(SEPARATORS, " ");
  const out: string[] = [];
  for (const token of key.split(" ")) if (token && !drop.has(token)) out.push(token);
  return out;
}

const NO_DROP: ReadonlySet<string> = new Set();
const DROP: ReadonlySet<string> = new Set(DROP_SOURCE.map(lexiconKey));
const CONSEQUENTIAL: ReadonlySet<string> = new Set(CONSEQUENTIAL_SOURCE.map(lexiconKey));
const CANON = new Map<string, string>(
  CANON_SOURCE.map(([from, to]) => [
    baseTokens(from, NO_DROP).join(" "),
    baseTokens(to, NO_DROP).join(" "),
  ]),
);
const CANON_MAX_WORDS = 3;

function foldTokens(text: string): string[] {
  const tokens = baseTokens(text, DROP);
  const out: string[] = [];
  for (let i = 0; i < tokens.length;) {
    let replaced = false;
    for (let n = Math.min(CANON_MAX_WORDS, tokens.length - i); n >= 1; n--) {
      const to = CANON.get(tokens.slice(i, i + n).join(" "));
      if (to === undefined) continue;
      out.push(to);
      i += n;
      replaced = true;
      break;
    }
    if (!replaced) out.push(tokens[i++] as string);
  }
  return out.join(" ").split(" ").filter(Boolean);
}

/** The text a command is matched on: see the file header for what the fold does. */
export function foldCommandText(text: string): string {
  return foldTokens(text).join(" ");
}

type VocabEntry = { command: VocabularyCommand; lang: CommandLang };
const VOCAB = new Map<string, VocabEntry>();
for (const command of Object.keys(COMMAND_VOCABULARY) as VocabularyCommand[]) {
  const set = COMMAND_VOCABULARY[command];
  for (const lang of ["en", "hinglish", "hi"] as const)
    for (const phrase of set[lang]) VOCAB.set(foldCommandText(phrase), { command, lang });
}

const MISS: CommandMatch = Object.freeze({ hit: false });

const langFactor = (want: CommandLang | undefined, phrase: CommandLang): number => {
  if (!want || want === "hinglish" || want === phrase) return 1;
  if (want === "hi" && phrase === "hinglish") return 1;
  return 0.9;
};

const foldedNames = new Map<string, string>();
const FOLDED_NAMES_MAX = 4096;
function foldedName(name: string): string {
  const known = foldedNames.get(name);
  if (known !== undefined) return known;
  if (foldedNames.size >= FOLDED_NAMES_MAX) foldedNames.clear();
  const folded = foldCommandText(name);
  foldedNames.set(name, folded);
  return folded;
}

/** True when `a` and `b` differ by exactly one insertion, deletion or substitution. */
function oneEditApart(a: string, b: string): boolean {
  const diff = a.length - b.length;
  if (diff > 1 || diff < -1 || a === b) return false;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && long[i] === short[i]) i++;
  if (long.length === short.length) return long.slice(i + 1) === short.slice(i + 1);
  return long.slice(i + 1) === short.slice(i);
}

const FUZZY_MIN_NAME_CHARS = 5;
const FUZZY_MIN_HEARD_CHARS = 4;

/** The name part of an open command, or null when the tokens are not shaped like one. */
function openTarget(tokens: readonly string[]): { name: string; lang: CommandLang } | null {
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  let body: string[] | null = null;
  let lang: CommandLang = "en";
  if (first !== undefined && OPEN_PREFIX.has(first) && tokens.length >= 2) {
    body = tokens.slice(1);
  } else if (last !== undefined && OPEN_SUFFIX_WORDS.has(last) && tokens.length >= 2) {
    body = tokens.slice(0, -1);
    lang = "hinglish";
  } else if (
    tokens.length >= 3 &&
    OPEN_VERB_BEFORE_KARO.has(tokens[tokens.length - 2] as string) &&
    KARO_WORDS.has(last as string)
  ) {
    body = tokens.slice(0, -2);
    lang = "hinglish";
  }
  if (!body) return null;
  while (body.length && NAME_LEAD_WORDS.has(body[0] as string)) body = body.slice(1);
  while (body.length && NAME_TAIL_WORDS.has(body[body.length - 1] as string))
    body = body.slice(0, -1);
  if (!body.length) return null;
  const name = body.join(" ");
  if (/[ऀ-ॿ]/u.test(tokens.join(" "))) lang = "hi";
  return { name, lang };
}

function matchOpen(
  tokens: readonly string[],
  ctx: CommandContext,
): { id: string; target: string; fuzzy: boolean; lang: CommandLang } | null {
  const parsed = openTarget(tokens);
  if (!parsed) return null;
  const registry = Array.isArray(ctx.registry) ? ctx.registry : [];
  const exact = new Map<string, string>();
  const near = new Map<string, string>();
  const fuzzyOk = parsed.name.length >= FUZZY_MIN_HEARD_CHARS;
  for (const entry of registry) {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.names)) continue;
    for (const raw of entry.names) {
      if (typeof raw !== "string") continue;
      const folded = foldedName(raw);
      if (!folded) continue;
      if (folded === parsed.name) exact.set(entry.id, raw);
      else if (
        fuzzyOk &&
        folded.length >= FUZZY_MIN_NAME_CHARS &&
        oneEditApart(folded, parsed.name)
      )
        near.set(entry.id, raw);
    }
  }
  const pool = exact.size ? exact : near;
  if (pool.size !== 1) return null;
  const [[id, target]] = [...pool] as [[string, string]];
  return { id, target, fuzzy: !exact.size, lang: parsed.lang };
}

/** Matches one whole utterance against the closed vocabulary; a miss means the open speech path takes it. */
export function matchCommand(text: string, ctx: CommandContext): CommandMatch {
  const tokens = foldTokens(text);
  if (!tokens.length) return MISS;
  for (const token of tokens) if (CONSEQUENTIAL.has(token)) return MISS;
  const folded = tokens.join(" ");
  const phrase = VOCAB.get(folded);
  if (phrase)
    return {
      hit: true,
      command: phrase.command,
      confidence: langFactor(ctx?.lang, phrase.lang),
      folded,
    };
  const open = matchOpen(tokens, ctx);
  if (!open) return MISS;
  return {
    hit: true,
    command: "open",
    args: { target: open.target, id: open.id },
    confidence:
      Math.round((open.fuzzy ? 0.8 : 0.95) * langFactor(ctx?.lang, open.lang) * 1000) / 1000,
    folded,
  };
}
