/**
 * FRIDAY · anti-repetition
 *
 * Same brain for chat and voice. Picks a natural variant and refuses to
 * repeat the last few lines in a bucket. Does not randomly rewrite every
 * sentence — only greetings, acknowledgements, thanks and closings.
 *
 * Vocatives come from the conversational user profile, never from the
 * project publisher string.
 */

import { vocative } from "./user-profile";

export type RepeatBucket =
  | "greeting"
  | "ack"
  | "thanks"
  | "done"
  | "listening"
  | "wake"
  | "cancelled"
  | "expired"
  | "checking"
  | "allGood"
  | "ready";

/** The language the owner is speaking, so a short line is not Hindi in an English talk. */
export type LineRegister = "en" | "hinglish" | "hi";

const LAST: Record<RepeatBucket, string[]> = {
  greeting: [],
  ack: [],
  thanks: [],
  done: [],
  listening: [],
  wake: [],
  cancelled: [],
  expired: [],
  checking: [],
  allGood: [],
  ready: [],
};

const KEEP = 5;

/** Lines for one situation, by register. A bucket missing a register falls back to Hinglish, then English. */
type Pools = Partial<Record<LineRegister, string[]>>;

const WAKE: Pools = {
  en: [
    "Yes?",
    "I'm here.",
    "Go ahead.",
    "Listening.",
    "Yes, tell me.",
    "Right here.",
    "What's up?",
  ],
  hinglish: ["Haan?", "Boliye.", "Haan, batao.", "Sun rahi hoon.", "Ji?", "Yahin hoon.", "Kahiye."],
  hi: ["हाँ?", "बोलिए।", "जी, बताइए।", "मैं सुन रही हूँ।", "जी?", "यहीं हूँ।", "कहिए।"],
};

const CANCELLED: Pools = {
  en: [
    "Cancelled. Nothing was executed.",
    "Okay, dropped it. Nothing ran.",
    "Stopped before it ran. Nothing happened.",
    "Scrapped. Nothing was done.",
  ],
  hinglish: [
    "Cancel kar diya. Kuch run nahi hua.",
    "Theek hai, chhod diya. Kuch nahi chala.",
    "Rok diya, kuch execute nahi hua.",
    "Cancel. Kuch bhi nahi hua.",
  ],
  hi: [
    "रद्द कर दिया। कुछ नहीं चला।",
    "ठीक है, छोड़ दिया। कुछ नहीं हुआ।",
    "रोक दिया, कुछ नहीं चलाया।",
  ],
};

const EXPIRED: Pools = {
  en: [
    "That confirmation expired. Ask again if you still want it.",
    "That approval timed out, so nothing ran. Ask me again.",
    "That one timed out, so I didn't run it. Say it again if you want it.",
  ],
  hinglish: [
    "Wo confirmation expire ho gaya. Chahiye to dobara bolo.",
    "Time nikal gaya, isliye maine kuch nahi chalaya. Phir se bolo.",
    "Approval timeout ho gaya. Dobara kahenge to kar dungi.",
  ],
  hi: [
    "वह पुष्टि समाप्त हो गई। चाहिए तो दोबारा कहिए।",
    "समय निकल गया, इसलिए मैंने कुछ नहीं चलाया। फिर से कहिए।",
  ],
};

const CHECKING: Pools = {
  en: [
    "Checking my ears and voice.",
    "Let me look at the microphone, the speech engine and my voice.",
    "Running a quick check on how I hear and speak.",
    "One moment, going through my voice setup.",
  ],
  hinglish: [
    "Apni sunne aur bolne ki setting check kar rahi hoon.",
    "Ek minute, mic, speech engine aur awaaz dekh rahi hoon.",
    "Quick check chal raha hai, sab kuch dekh rahi hoon.",
    "Ruko, apna voice setup check karti hoon.",
  ],
  hi: [
    "अपना माइक, सुनना और बोलना जाँच रही हूँ।",
    "एक पल, अपनी आवाज़ की सेटिंग देख रही हूँ।",
    "जल्दी जाँच कर रही हूँ।",
  ],
};

const READY: Pools = {
  en: [
    "Auto mode is on. I'm listening.",
    "I'm up and listening.",
    "Ready when you are.",
    "Listening. Go ahead whenever.",
  ],
  hinglish: [
    "Auto mode on hai, main sun rahi hoon.",
    "Taiyaar hoon, bolo.",
    "Main sun rahi hoon, jab chaaho bolo.",
    "Sab ready hai, batao.",
  ],
  hi: [
    "ऑटो मोड चालू है, मैं सुन रही हूँ।",
    "तैयार हूँ, बोलिए।",
    "मैं सुन रही हूँ, जब चाहें बोलिए।",
  ],
};

const ALL_GOOD: Pools = {
  en: [
    "All good. I can hear and speak fine.",
    "Everything checks out: microphone, speech and voice.",
    "Nothing wrong. I'm hearing you and speaking properly.",
    "Checked it all — working as it should.",
  ],
  hinglish: [
    "Sab theek hai. Main sun bhi sakti hoon, bol bhi sakti hoon.",
    "Mic, speech aur voice, sab sahi chal raha hai.",
    "Kuch gadbad nahi mili. Sab kaam kar raha hai.",
    "Sab check kar liya, sab theek hai.",
  ],
  hi: [
    "सब ठीक है। मैं सुन भी सकती हूँ और बोल भी।",
    "माइक, स्पीच और आवाज़, सब सही चल रहा है।",
    "कोई गड़बड़ी नहीं मिली।",
  ],
};

function greetingPool(address: string): string[] {
  const named = address
    ? [`Haan ${address}?`, `${address} — boliye.`, `Yes ${address}?`, `Ji, ${address}.`]
    : [];
  return [
    ...named,
    "I'm here.",
    "Batao.",
    "Ready.",
    "Boliye.",
    "Haan, boliye.",
    "मैं सुन रही हूँ।",
    "What do you need?",
    "Listening.",
  ];
}

function fromPools(pools: Pools, register: LineRegister): string[] {
  return pools[register] ?? pools.hinglish ?? pools.en ?? ["Okay."];
}

function pool(bucket: RepeatBucket, address: string, register: LineRegister): string[] {
  switch (bucket) {
    case "greeting":
      return greetingPool(address);
    case "wake":
      return fromPools(WAKE, register);
    case "cancelled":
      return fromPools(CANCELLED, register);
    case "expired":
      return fromPools(EXPIRED, register);
    case "checking":
      return fromPools(CHECKING, register);
    case "allGood":
      return fromPools(ALL_GOOD, register);
    case "ready":
      return fromPools(READY, register);
    case "ack":
      return [
        "Got it.",
        "ठीक है।",
        "On it.",
        "Understood.",
        "हाँ।",
        "Right.",
        "Okay — doing that.",
      ];
    case "thanks":
      return ["Anytime.", "Done.", "खुशी हुई।", "Glad it helped.", "What's next?", "Happy to."];
    case "done":
      return ["Done.", "That's in.", "हो गया।", "Finished.", "Ready for the next thing."];
    case "listening":
      return ["मैं देखती हूँ।", "I'm looking.", "One moment.", "Checking."];
    default:
      return ["Okay."];
  }
}

/** The choice for one call: a number in [0, 1). Tests pass their own. */
export type Chance = () => number;

const KEYED = new Map<string, string[]>();

/**
 * One of `choices`, never one of the last few said under the same `key`, picked at random. For lines that
 * are built from facts (a list of what was found) where the wording around the facts is what repeats.
 */
export function chooseFresh(key: string, choices: readonly string[], chance: Chance = Math.random) {
  if (!choices.length) return "";
  const recent = KEYED.get(key) ?? [];
  const fresh = choices.filter((line) => !recent.includes(line));
  const list = fresh.length ? fresh : choices.filter((line) => line !== recent[recent.length - 1]);
  const open = list.length ? list : [...choices];
  const pick =
    open[Math.min(open.length - 1, Math.floor(chance() * open.length))] ?? choices[0] ?? "";
  recent.push(pick);
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  KEYED.set(key, recent);
  return pick;
}

/**
 * Pick a line that is not among the last few used in this bucket, at random among the rest (the choice
 * used to follow the clock, so the same hour gave the same line). `register` keeps it in the language
 * the owner is using.
 */
export function vary(
  bucket: RepeatBucket,
  options: { register?: LineRegister; chance?: Chance } = {},
): string {
  const address = bucket === "greeting" ? vocative() : "";
  const choices = pool(bucket, address, options.register ?? "hinglish");
  const recent = LAST[bucket];
  const fresh = choices.filter((line) => !recent.includes(line));
  const left = fresh.length ? fresh : choices.filter((line) => line !== recent[recent.length - 1]);
  const list = left.length ? left : choices;
  const roll = (options.chance ?? Math.random)();
  const pick =
    list[Math.min(list.length - 1, Math.floor(roll * list.length))] ?? choices[0] ?? "Okay.";
  recent.push(pick);
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  return pick;
}

export function lastSaid(bucket: RepeatBucket): string[] {
  return [...LAST[bucket]];
}

/** Test hook — never called from UI. */
export function resetAntiRepeat(): void {
  KEYED.clear();
  (Object.keys(LAST) as RepeatBucket[]).forEach((key) => {
    LAST[key] = [];
  });
}
