/** The streaming ear's hotword list: real sources only, trimmed, deduplicated, at most 64 of at most 40 characters. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STREAM_HOTWORDS_MAX,
  STREAM_HOTWORD_CHARS,
  acceptLearned,
  applyReplacements,
  buildHints,
  looksSensitive,
  noteUses,
  ownerView,
  phoneticFold,
  proposeLearned,
  replaceKey,
  streamHotwords,
  undoReplacements,
  type VocabEntry,
} from "../../src/lib/friday/voice-engine/hotwords";
import { bestOfMs } from "./helpers/wall-clock";
// Best-of-5 bound: at least 10x the idle median of this work.
const BUILD_HINTS_BOUND_MS = 100;
// Best-of-5 bound: at least 10x the idle median of this work.
const APPLY_REPLACEMENTS_BOUND_MS = 200;

const modeSource = readFileSync(
  resolve(__dirname, "../../src/lib/friday/assistant-mode.ts"),
  "utf8",
);

describe("stream hotwords", () => {
  it("none when there is no source", () => {
    expect(streamHotwords(undefined)).toEqual([]);
    expect(streamHotwords({})).toEqual([]);
    expect(
      streamHotwords({ names: ["", "  ", null, undefined], contacts: [], apps: null }),
    ).toEqual([]);
  });

  it("takes names, contacts, app names and the dictionary in that order", () => {
    expect(
      streamHotwords({
        names: ["FRIDAY", "Devendra"],
        contacts: ["Rahul Sharma", "मीना"],
        apps: ["Visual Studio Code", "Chrome"],
        vocabulary: ["kubectl"],
      }),
    ).toEqual([
      "FRIDAY",
      "Devendra",
      "Rahul Sharma",
      "मीना",
      "Visual Studio Code",
      "Chrome",
      "kubectl",
    ]);
  });

  it("trims, folds whitespace and control characters, and dedupes without regard to case", () => {
    expect(
      streamHotwords({
        names: ["  FRIDAY  ", "friday"],
        contacts: ["Rahul\t\nSharma", "rahul sharma"],
        apps: ["Chrome\u0000", "CHROME", "Note\u200bpad"],
      }),
    ).toEqual(["FRIDAY", "Rahul Sharma", "Chrome", "Note pad"]);
  });

  it("drops entries over 40 characters instead of cutting them", () => {
    const long = "x".repeat(STREAM_HOTWORD_CHARS + 1);
    const edge = "y".repeat(STREAM_HOTWORD_CHARS);
    expect(streamHotwords({ apps: [long, edge] })).toEqual([edge]);
    expect(STREAM_HOTWORD_CHARS).toBe(40);
  });

  it("stops at 64, names first", () => {
    const contacts = Array.from({ length: 100 }, (_, i) => `Contact ${i}`);
    const out = streamHotwords({ names: ["FRIDAY"], contacts, apps: ["Chrome"] });
    expect(STREAM_HOTWORDS_MAX).toBe(64);
    expect(out).toHaveLength(64);
    expect(out[0]).toBe("FRIDAY");
    expect(out).not.toContain("Chrome");
    expect(new Set(out.map((w) => w.toLowerCase())).size).toBe(out.length);
  });

  it("the conductor builds the list from the owner's names and dictionary for the stream plan", () => {
    const plan = modeSource.slice(
      modeSource.indexOf("private streamPlan()"),
      modeSource.indexOf("private streamPlan()") + 700,
    );
    expect(plan).toMatch(/hotwords: streamHotwords\(\{/);
    expect(plan).toMatch(/names: \[voice\.addressName, voice\.wakeWord\]/);
    expect(plan).toMatch(/vocabulary: parseVocabulary\(voice\.vocabulary\)/);
  });
});

function entry(over: Partial<VocabEntry> & { id: string; written: string }): VocabEntry {
  return { heard: [], tier: "hint", source: "owner", uses: 0, ...over };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

describe("phoneticFold: Hindi, Hinglish and English spellings of one sound", () => {
  const same: [string, string][] = [
    ["kya", "kia"],
    ["kya", "kiya"],
    ["nahi", "nahin"],
    ["नहीं", "nahin"],
    ["क्या", "kya"],
    ["वो", "wo"],
    ["wahin", "vahin"],
    ["phir", "fir"],
    ["फिर", "phir"],
    ["jaana", "jana"],
    ["जाना", "jana"],
    ["meeting", "miting"],
    ["mitting", "miting"],
    ["meena", "mina"],
    ["मीना", "Meena"],
    ["राहुल", "Rahul"],
    ["देवेंद्र", "Devendra"],
    ["zindagi", "jindagi"],
    ["ज़िंदगी", "jindagi"],
    ["फ़ोन", "fon"],
    ["फोन", "phon"],
    ["dhanyavad", "dhanyawad"],
    ["धन्यवाद", "dhanyawad"],
    ["shukria", "shukriya"],
    ["dooba", "duba"],
    ["zaroor", "ज़रूर"],
    ["café", "cafe"],
    ["FRIDAY", "friday"],
    ["Rahul   Sharma", "rahul sharma"],
    ["nahi\u200c", "nahi"],
    ["क्\u200dया", "क्या"],
    ["haan,", "haan"],
  ];

  it.each(same)("folds %s and %s to one key", (a, b) => {
    expect(phoneticFold(a)).toBe(phoneticFold(b));
  });

  it("keeps different words apart", () => {
    expect(phoneticFold("rahul")).not.toBe(phoneticFold("rahim"));
    expect(phoneticFold("kal")).toBe(phoneticFold("kaal "));
    expect(phoneticFold("kal")).not.toBe(phoneticFold("kil"));
  });

  it("th stays in the plain fold and folds to t only in the replace key", () => {
    expect(phoneticFold("thakur")).not.toBe(phoneticFold("takur"));
    expect(replaceKey("thakur")).toBe(replaceKey("takur"));
    expect(replaceKey("ठाकुर")).toBe(replaceKey("takur"));
  });

  it("English mode only folds case, accents, spaces and invisible marks", () => {
    expect(phoneticFold("Café  Walter", "en")).toBe("cafe walter");
    expect(phoneticFold("Walter", "en")).not.toBe(phoneticFold("Valter", "en"));
    expect(phoneticFold("Walter")).toBe(phoneticFold("Valter"));
  });

  it("is deterministic and never throws on odd input", () => {
    const text = "Kya  nahin, मीना?";
    expect(phoneticFold(text)).toBe(phoneticFold(text));
    expect(phoneticFold("")).toBe("");
    expect(phoneticFold(null as unknown as string)).toBe("");
    expect(phoneticFold("\u0000\u200b ")).toBe("");
    expect(phoneticFold("call 911 now").split(" ")[1]).toBe("911");
  });
});

describe("buildHints", () => {
  it("lists hint words and the written form of replace entries, owner before registry before learned", () => {
    const entries: VocabEntry[] = [
      entry({ id: "l", written: "Lumen", source: "learned", learnedConsent: true }),
      entry({ id: "r", written: "Chrome", source: "registry" }),
      entry({ id: "o", written: "Rahul", tier: "replace", heard: ["rahool"] }),
      entry({ id: "o2", written: "kubectl" }),
    ];
    expect(buildHints(entries, { max: 60, recentFirst: false })).toEqual([
      "Rahul",
      "kubectl",
      "Chrome",
      "Lumen",
    ]);
  });

  it("puts the most used first inside a source", () => {
    const entries = [
      entry({ id: "a", written: "alpha", uses: 1 }),
      entry({ id: "b", written: "bravo", uses: 9 }),
      entry({ id: "c", written: "charlie", uses: 4 }),
    ];
    expect(buildHints(entries, { max: 60, recentFirst: false })).toEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
  });

  it("recentFirst orders by the last used frame, then by use count", () => {
    const entries = [
      entry({ id: "a", written: "alpha", uses: 9, lastUsedFrame: 10 }),
      entry({ id: "b", written: "bravo", uses: 1, lastUsedFrame: 99 }),
      entry({ id: "c", written: "charlie", uses: 5 }),
    ];
    expect(buildHints(entries, { max: 60, recentFirst: true })).toEqual([
      "bravo",
      "alpha",
      "charlie",
    ]);
  });

  it("caps the list: default 60, never above the ear's 64, never negative", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({ id: `e${i}`, written: `Word${i}x` }),
    );
    expect(buildHints(many, { max: 5, recentFirst: false })).toHaveLength(5);
    expect(buildHints(many, {} as never)).toHaveLength(60);
    expect(buildHints(many, { max: 500, recentFirst: false })).toHaveLength(STREAM_HOTWORDS_MAX);
    expect(buildHints(many, { max: -3, recentFirst: false })).toEqual([]);
    expect(buildHints(many, { max: Number.NaN, recentFirst: false })).toHaveLength(60);
  });

  it("drops duplicates without regard to case and words over the ear's length", () => {
    const entries = [
      entry({ id: "a", written: "Rahul" }),
      entry({ id: "b", written: "rahul" }),
      entry({ id: "c", written: "x".repeat(STREAM_HOTWORD_CHARS + 1) }),
      entry({ id: "d", written: "  Meena\u0000 " }),
    ];
    expect(buildHints(entries, { max: 60, recentFirst: false })).toEqual(["Rahul", "Meena"]);
  });

  it("a learned entry without the owner's consent never reaches the ear", () => {
    const entries = [
      entry({ id: "l1", written: "Pending", source: "learned", learnedConsent: false }),
      entry({ id: "l2", written: "Unset", source: "learned" }),
      entry({ id: "l3", written: "Allowed", source: "learned", learnedConsent: true }),
    ];
    expect(buildHints(entries, { max: 60, recentFirst: false })).toEqual(["Allowed"]);
  });

  it("drops sensitive-looking strings (built in and injected) and fails closed when the check throws", () => {
    const entries = [
      entry({ id: "a", written: "Rahul" }),
      entry({ id: "b", written: "my password is hunter2" }),
      entry({ id: "c", written: "4111 1111 1111 1111" }),
      entry({ id: "d", written: "Secretname" }),
      entry({ id: "e", written: "Boom" }),
      entry({ id: "f", written: "Safe", heard: ["otp 4455"] }),
    ];
    const isSensitive = (s: string): boolean => {
      if (s === "Boom") throw new Error("checker down");
      return s === "Secretname";
    };
    expect(buildHints(entries, { max: 60, recentFirst: false, isSensitive })).toEqual(["Rahul"]);
  });

  it("looksSensitive catches secrets, cards, mail and long tokens but not names", () => {
    expect(looksSensitive("sk-live-abcdef1234567890abcd")).toBe(true);
    expect(looksSensitive("a.b@example.com")).toBe(true);
    expect(looksSensitive("पासवर्ड 1234")).toBe(true);
    expect(looksSensitive("123456789012")).toBe(true);
    expect(looksSensitive("Rahul Sharma")).toBe(false);
    expect(looksSensitive("मीना")).toBe(false);
    expect(looksSensitive("Terminal 2")).toBe(false);
  });

  it("is deterministic, leaves the input untouched and skips malformed entries", () => {
    const entries = deepFreeze([
      entry({ id: "a", written: "Alpha", uses: 2 }),
      entry({ id: "b", written: "Bravo", uses: 2 }),
      null as unknown as VocabEntry,
      { id: "x" } as unknown as VocabEntry,
    ]);
    const first = buildHints(entries, { max: 60, recentFirst: true });
    expect(first).toEqual(["Alpha", "Bravo"]);
    expect(buildHints(entries, { max: 60, recentFirst: true })).toEqual(first);
  });

  it("a thousand entries build inside a generous time bound", () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      entry({
        id: `e${i}`,
        written: `Name${i}`,
        heard: [`nam ${i}`],
        tier: i % 2 ? "replace" : "hint",
        source: i % 3 === 0 ? "owner" : i % 3 === 1 ? "registry" : "learned",
        learnedConsent: true,
        uses: i % 17,
      }),
    );
    const build = () => buildHints(many, { max: 60, recentFirst: true });
    expect(build()).toHaveLength(60);
    expect(bestOfMs(() => void build())).toBeLessThan(BUILD_HINTS_BOUND_MS);
  });
});

describe("applyReplacements", () => {
  const rahul = entry({
    id: "rahul",
    written: "Rahul",
    heard: ["rahool", "राहुल", "rahul"],
    tier: "replace",
  });

  it("replaces a heard variant by the written form on whole tokens", () => {
    const out = applyReplacements("call rahool now", [rahul]);
    expect(out.text).toBe("call Rahul now");
    expect(out.changes).toEqual([{ from: "rahool", to: "Rahul", id: "rahul", at: 5 }]);
  });

  it("matches the Devanagari and the Roman spelling of one name", () => {
    expect(applyReplacements("राहुल को बुलाओ", [rahul]).text).toBe("Rahul को बुलाओ");
    const deva = entry({ id: "m", written: "मीना", heard: ["Meena"], tier: "replace" });
    expect(applyReplacements("meena aayi", [deva]).text).toBe("मीना aayi");
    expect(applyReplacements("mina aayi", [deva]).text).toBe("मीना aayi");
  });

  it("never replaces inside another word", () => {
    const e = entry({ id: "m", written: "Meena", heard: ["mina"], tier: "replace" });
    expect(applyReplacements("terminal ke saath", [e]).changes).toEqual([]);
    expect(applyReplacements("minako", [e]).text).toBe("minako");
    expect(applyReplacements("rahulgandhi", [rahul]).text).toBe("rahulgandhi");
    expect(applyReplacements("rahul's", [rahul]).text).toBe("rahul's");
  });

  it("matches a whole phrase and prefers the longer phrase", () => {
    const kube = entry({
      id: "k",
      written: "Kubernetes",
      heard: ["cooper netties"],
      tier: "replace",
    });
    const net = entry({ id: "n", written: "Netties", heard: ["netties"], tier: "replace" });
    const out = applyReplacements("deploy on Cooper  Netties today", [net, kube]);
    expect(out.text).toBe("deploy on Kubernetes today");
    expect(out.changes.map((c) => c.id)).toEqual(["k"]);
    expect(applyReplacements("cooper, netties", [kube]).changes).toEqual([]);
  });

  it("never touches digits and never matches a token that has one", () => {
    const gpt = entry({ id: "g", written: "GPT", heard: ["gpt 4", "g p t"], tier: "replace" });
    expect(applyReplacements("call 911 and 42", [rahul]).text).toBe("call 911 and 42");
    expect(applyReplacements("rahul2 and rahool 3", [rahul]).text).toBe("rahul2 and Rahul 3");
    expect(applyReplacements("use g p t 4", [gpt]).text).toBe("use GPT 4");
    expect(applyReplacements("gpt 4", [gpt]).text).toBe("GPT 4");
  });

  it("hint entries never rewrite the text", () => {
    const hint = entry({ id: "h", written: "Rahul", heard: ["rahool"], tier: "hint" });
    expect(applyReplacements("call rahool", [hint]).text).toBe("call rahool");
  });

  it("an unconsented learned entry does nothing; after consent it works", () => {
    const learned = entry({
      id: "l",
      written: "Kubernetes",
      heard: ["kuber netis"],
      tier: "replace",
      source: "learned",
      learnedConsent: false,
    });
    expect(applyReplacements("kuber netis", [learned]).changes).toEqual([]);
    expect(applyReplacements("kuber netis", [acceptLearned(learned)]).text).toBe("Kubernetes");
  });

  it("owner entries win over registry and learned on the same sound", () => {
    const a = entry({
      id: "reg",
      written: "Rahool",
      heard: ["rahul"],
      tier: "replace",
      source: "registry",
    });
    const b = entry({ id: "own", written: "Rahul", heard: ["rahul"], tier: "replace" });
    expect(applyReplacements("rahul", [a, b]).text).toBe("Rahul");
  });

  it("reports nothing when the text already reads right and keeps punctuation", () => {
    expect(applyReplacements("Rahul aaya", [rahul]).changes).toEqual([]);
    expect(applyReplacements("rahool, haan.", [rahul]).text).toBe("Rahul, haan.");
  });

  it("skips sensitive entries and fails closed when the check throws", () => {
    const boom = (): boolean => {
      throw new Error("down");
    };
    expect(applyReplacements("rahool", [rahul], { isSensitive: boom }).changes).toEqual([]);
    const secret = entry({
      id: "s",
      written: "api key sk-live-abcdef1234567890abcd",
      heard: ["secret one"],
      tier: "replace",
    });
    expect(applyReplacements("secret one", [secret]).changes).toEqual([]);
  });

  it("ignores very short keys", () => {
    const tiny = entry({ id: "t", written: "A", heard: ["a"], tier: "replace" });
    expect(applyReplacements("a cat", [tiny]).changes).toEqual([]);
  });

  it("returns the undo data and undoReplacements restores the text exactly", () => {
    const kube = entry({
      id: "k",
      written: "Kubernetes",
      heard: ["cooper netties"],
      tier: "replace",
    });
    const original = "rahool, deploy on cooper netties for rahool";
    const out = applyReplacements(original, [rahul, kube]);
    expect(out.changes).toHaveLength(3);
    expect(out.changes.every((c) => out.text.slice(c.at, c.at + c.to.length) === c.to)).toBe(true);
    expect(undoReplacements(out.text, out.changes)).toBe(original);
  });

  it("undo skips a change whose text the owner already edited", () => {
    const out = applyReplacements("rahool aaya", [rahul]);
    expect(undoReplacements("Ramesh Sharma aaya", out.changes)).toBe("Ramesh Sharma aaya");
    expect(undoReplacements("Rahul aaya", [])).toBe("Rahul aaya");
  });

  it("is deterministic, does not mutate its input and handles empty input", () => {
    const entries = deepFreeze([rahul]);
    const a = applyReplacements("rahool rahool", entries);
    expect(applyReplacements("rahool rahool", entries)).toEqual(a);
    expect(applyReplacements("", entries)).toEqual({ text: "", changes: [] });
    expect(applyReplacements("hello", [])).toEqual({ text: "hello", changes: [] });
    expect(applyReplacements(null as unknown as string, entries).text).toBe("");
  });

  it("noteUses counts the applied replacements in a copy", () => {
    const entries = deepFreeze([rahul]);
    const next = noteUses(entries, ["rahul", "rahul", "ghost"], 7);
    expect(next[0]).toMatchObject({ uses: 2, lastUsedFrame: 7 });
    expect(entries[0]!.uses).toBe(0);
  });

  it("replaces a thousand-entry list inside a generous time bound", () => {
    const letters = (n: number): string =>
      n
        .toString(26)
        .split("")
        .map((c) => String.fromCharCode(97 + Number.parseInt(c, 26)))
        .join("");
    const many = Array.from({ length: 1000 }, (_, i) =>
      entry({
        id: `e${i}`,
        written: `Nm${letters(i)}`,
        heard: [`neym ${letters(i)}`, `neym${letters(i)}`],
        tier: "replace",
      }),
    );
    const apply = () => applyReplacements("please call neymh and neym hq about it", many);
    expect(apply().text).toBe("please call Nmh and Nmhq about it");
    expect(bestOfMs(() => void apply())).toBeLessThan(APPLY_REPLACEMENTS_BOUND_MS);
  });
});

describe("proposeLearned", () => {
  const fix = (heard: string, corrected: string, n: number) =>
    Array.from({ length: n }, () => ({ heard, corrected }));

  it("proposes after three of the same correction, never before", () => {
    expect(proposeLearned(fix("open cooper netties", "open Kubernetes", 2))).toEqual([]);
    const out = proposeLearned(fix("open cooper netties", "open Kubernetes", 3));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      heard: ["cooper netties"],
      written: "Kubernetes",
      tier: "replace",
      source: "learned",
      learnedConsent: false,
      uses: 0,
    });
  });

  it("counts spelling variants of the same mishearing together and keeps each heard spelling", () => {
    const history = [
      { heard: "call rahool", corrected: "call Rahul" },
      { heard: "call rahul", corrected: "call Rahul" },
      { heard: "रा हुल", corrected: "Rahul" },
    ];
    const out = proposeLearned(history);
    expect(out).toHaveLength(1);
    expect(out[0]!.written).toBe("Rahul");
    expect(out[0]!.heard).toEqual(expect.arrayContaining(["rahool", "rahul"]));
  });

  it("does not turn a rewrite into a rule: unrelated words, long spans and digit edits are refused", () => {
    expect(proposeLearned(fix("send the mail", "write the mail", 5))).toEqual([]);
    expect(
      proposeLearned(fix("one two three four five", "alpha beta gamma delta epsilon", 5)),
    ).toEqual([]);
    expect(proposeLearned(fix("room 12", "room 13", 5))).toEqual([]);
    expect(proposeLearned(fix("same text", "same text", 5))).toEqual([]);
    expect(proposeLearned(fix("only", "only more", 5))).toEqual([]);
  });

  it("skips what the owner already has and sensitive corrections", () => {
    const have = entry({
      id: "x",
      written: "Kubernetes",
      heard: ["cooper netties"],
      tier: "replace",
    });
    const history = fix("open cooper netties", "open Kubernetes", 4);
    expect(proposeLearned(history, { existing: [have] })).toEqual([]);
    expect(proposeLearned(fix("my pass word is", "my password is", 4))).toEqual([]);
    expect(
      proposeLearned(history, {
        isSensitive: () => {
          throw new Error("down");
        },
      }),
    ).toEqual([]);
  });

  it("orders by how often it was seen, is deterministic, respects minCount and does not mutate", () => {
    const history = deepFreeze([
      ...fix("a rahool", "a Rahul", 3),
      ...fix("a meenaa", "a Meena", 5),
    ]);
    const out = proposeLearned(history);
    expect(out.map((e) => e.written)).toEqual(["Meena", "Rahul"]);
    expect(proposeLearned(history)).toEqual(out);
    expect(out[0]!.id).toMatch(/^learned-[0-9a-f]{8}$/);
    expect(proposeLearned(history, { minCount: 5 }).map((e) => e.written)).toEqual(["Meena"]);
  });

  it("a proposal does nothing until accepted", () => {
    const [proposal] = proposeLearned(fix("open cooper netties", "open Kubernetes", 3));
    expect(buildHints([proposal!], { max: 60, recentFirst: false })).toEqual([]);
    expect(applyReplacements("cooper netties", [proposal!]).changes).toEqual([]);
    const accepted = acceptLearned(proposal!);
    expect(accepted.learnedConsent).toBe(true);
    expect(proposal!.learnedConsent).toBe(false);
    expect(buildHints([accepted], { max: 60, recentFirst: false })).toEqual(["Kubernetes"]);
  });
});

describe("ownerView", () => {
  it("groups by tier in plain words and says what is waiting or blocked", () => {
    const entries = [
      entry({ id: "h", written: "kubectl", uses: 3 }),
      entry({ id: "r", written: "Rahul", heard: ["rahool"], tier: "replace" }),
      entry({
        id: "l",
        written: "Lumen",
        heard: ["loomen"],
        tier: "replace",
        source: "learned",
        learnedConsent: false,
      }),
      entry({ id: "s", written: "api key sk-live-abcdef1234567890abcd", tier: "hint" }),
    ];
    const view = ownerView(entries);
    expect(view.map((g) => g.tier)).toEqual(["hint", "replace"]);
    expect(view[0]!.title).toBe("Words I listen for");
    expect(view[1]!.title).toBe("Words I fix after I hear them");
    expect(view[0]!.rows.map((r) => [r.id, r.status])).toEqual([
      ["h", "on"],
      ["s", "blocked"],
    ]);
    expect(view[1]!.rows.map((r) => [r.id, r.status, r.sourceLabel])).toEqual([
      ["r", "on", "You added"],
      ["l", "waiting", "Noticed from your corrections"],
    ]);
    expect(view[1]!.rows[1]!.statusLabel).toBe("Waiting for your OK");
    expect(view[1]!.rows[0]!.summary).toBe("rahool becomes Rahul");
    expect(view[0]!.rows[0]!.summary).toBe("kubectl");
  });

  it("always returns both groups, even with nothing, and does not mutate", () => {
    expect(ownerView([]).map((g) => g.rows)).toEqual([[], []]);
    const entries = deepFreeze([entry({ id: "a", written: "Alpha" })]);
    expect(ownerView(entries)[0]!.rows).toHaveLength(1);
  });
});
