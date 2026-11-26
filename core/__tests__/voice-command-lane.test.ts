import { describe, expect, it } from "vitest";
import * as lane from "../../src/lib/friday/voice-engine/command-lane";
import {
  COMMAND_VOCABULARY,
  SAFETY_COMMANDS,
  foldCommandText,
  matchCommand,
  type CommandName,
  type CommandRegistryEntry,
  type VocabularyCommand,
} from "../../src/lib/friday/voice-engine/command-lane";
import {
  INTERRUPT_STOP_PHRASES,
  isImmediateStop,
} from "../../src/lib/friday/voice-engine/interruption-controller";
import { bestOfMs } from "./helpers/wall-clock";
// Best-of-5 bound: at least 10x the idle median of this work.
const LANE_500_CALLS_BOUND_MS = 200;

const REGISTRY: CommandRegistryEntry[] = [
  { id: "chrome", names: ["Chrome", "Google Chrome", "क्रोम"] },
  { id: "notepad", names: ["Notepad", "नोटपैड"] },
  { id: "spotify", names: ["Spotify"] },
  { id: "calc", names: ["Calculator", "कैलकुलेटर"] },
  { id: "word", names: ["Word"] },
  { id: "slack", names: ["Slack"] },
  { id: "ps", names: ["Photoshop"] },
  { id: "ps-x", names: ["Photoshap"] },
  { id: "run", names: ["Run"] },
];
const ctx = { registry: REGISTRY };
const hit = (text: string, over: Partial<typeof ctx & { lang: "en" | "hi" | "hinglish" }> = {}) =>
  matchCommand(text, { ...ctx, ...over });
const cmd = (text: string) => {
  const r = hit(text);
  return r.hit ? r.command : null;
};

describe("closed vocabulary: each verb in English, Hindi and Roman Hinglish", () => {
  const CASES: Array<[CommandName, string[]]> = [
    ["stop", ["stop", "Stop it", "ruko", "ruk jao", "bas karo", "रुको", "रुकिए", "बस करो"]],
    ["stop-all", ["stop everything", "stop all", "sab roko", "sab kuch roko", "सब रोको"]],
    [
      "mute",
      [
        "mute",
        "mute yourself",
        "chup ho ja",
        "chup ho jao",
        "chup raho",
        "म्यूट",
        "चुप हो जा",
        "चुप रहो",
      ],
    ],
    ["unmute", ["unmute", "unmute yourself", "unmute karo", "अनम्यूट", "अनम्यूट करो"]],
    ["pause", ["pause", "pause it", "pause karo", "thehro", "ठहरो", "पॉज करो", "roko"]],
    [
      "resume",
      [
        "resume",
        "carry on",
        "keep going",
        "phir se chalao",
        "jaari rakho",
        "जारी रखो",
        "फिर से चलाओ",
      ],
    ],
    [
      "volume-up",
      [
        "volume up",
        "turn up the volume",
        "volume badhao",
        "awaaz tez karo",
        "आवाज़ बढ़ाओ",
        "वॉल्यूम बढ़ाओ",
      ],
    ],
    [
      "volume-down",
      [
        "volume down",
        "turn down the volume",
        "volume kam karo",
        "awaaz dheere karo",
        "आवाज़ कम करो",
        "वॉल्यूम कम करो",
      ],
    ],
    ["louder", ["louder", "speak louder", "zor se bolo", "speak up", "ज़ोर से बोलो"]],
    [
      "quieter",
      ["quieter", "speak quieter", "lower your voice", "dheere bolo", "धीरे बोलो", "धीमे बोलो"],
    ],
    [
      "repeat",
      [
        "repeat",
        "repeat that",
        "say that again",
        "dobara bolo",
        "phir se bolo",
        "दोबारा बोलो",
        "फिर से बोलो",
      ],
    ],
  ];
  it.each(CASES.flatMap(([c, ps]) => ps.map((p) => [c, p] as const)))("%s <- %s", (c, p) => {
    const r = hit(p);
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.command).toBe(c);
      expect(r.confidence).toBeGreaterThan(0.9);
    }
  });

  it("the exported vocabulary has all three languages for every verb", () => {
    for (const c of Object.keys(COMMAND_VOCABULARY) as VocabularyCommand[]) {
      const v = COMMAND_VOCABULARY[c];
      expect(v.en.length, c).toBeGreaterThan(0);
      expect(v.hinglish.length, c).toBeGreaterThan(0);
      expect(v.hi.length, c).toBeGreaterThan(0);
    }
    expect(Object.keys(COMMAND_VOCABULARY).sort()).toEqual(
      [
        "louder",
        "mute",
        "pause",
        "quieter",
        "repeat",
        "resume",
        "stop",
        "stop-all",
        "unmute",
        "volume-down",
        "volume-up",
      ].sort(),
    );
  });

  it("no phrase belongs to two verbs, and every phrase hits its own verb", () => {
    const seen = new Map<string, string>();
    for (const c of Object.keys(COMMAND_VOCABULARY) as VocabularyCommand[]) {
      const v = COMMAND_VOCABULARY[c];
      for (const p of [...v.en, ...v.hinglish, ...v.hi]) {
        const key = foldCommandText(p);
        expect(seen.get(key) ?? c, p).toBe(c);
        seen.set(key, c);
        expect(cmd(p), p).toBe(c);
      }
    }
  });

  it("the safety verbs are exactly stop, stop-all, mute, pause, volume-down, quieter", () => {
    expect([...SAFETY_COMMANDS].sort()).toEqual([
      "mute",
      "pause",
      "quieter",
      "stop",
      "stop-all",
      "volume-down",
    ]);
  });
});

describe("fold", () => {
  it("lower-cases, drops punctuation and politeness and fillers, collapses spaces", () => {
    expect(foldCommandText("  Stop,   PLEASE!  ")).toBe("stop");
    expect(foldCommandText("um, acha, stop")).toBe("stop");
    expect(foldCommandText("Ruko zara")).toBe("ruko");
    expect(foldCommandText("mute ji")).toBe("mute");
    expect(foldCommandText("mute na")).toBe("mute");
    expect(foldCommandText("hey Friday, stop")).toBe("stop");
  });
  it("folds the Devanagari nukta so spelling variants meet", () => {
    expect(foldCommandText("आवाज़ बढ़ाओ")).toBe(foldCommandText("आवाज बढाओ"));
    expect(cmd("आवाज बढाओ")).toBe("volume-up");
    expect(cmd("ज़ोर से बोलो")).toBe("louder");
    expect(cmd("जोर से बोलो")).toBe("louder");
  });
  it("reads kar do / kijiye / badha do spellings as one", () => {
    expect(cmd("pause kar do")).toBe("pause");
    expect(cmd("pause kijiye")).toBe("pause");
    expect(cmd("volume badha do")).toBe("volume-up");
    expect(cmd("awaz kam kar do")).toBe("volume-down");
    expect(cmd("thoda dheere bolo")).toBe("quieter");
  });
  it("the folded text is returned on a hit", () => {
    const r = hit("Please, STOP.");
    expect(r).toMatchObject({ hit: true, command: "stop", folded: "stop" });
  });
  it("empty and non-string input never hit", () => {
    expect(hit("").hit).toBe(false);
    expect(hit("   ").hit).toBe(false);
    expect(hit("please").hit).toBe(false);
    expect(matchCommand(undefined as unknown as string, ctx).hit).toBe(false);
  });
});

describe("longer sentences fall through", () => {
  it.each([
    "ruko aur mujhe batao ki kal mausam kaisa rahega",
    "stop the music and play some jazz",
    "volume badhao aur gaana chalao",
    "can you mute the tv in the living room",
    "I said stop yesterday",
    "रुको और मुझे बताओ कि कल क्या है",
    "pause the download of the file",
    "what does repeat mean",
  ])("%s -> no hit", (t) => {
    expect(hit(t).hit).toBe(false);
  });
});

describe("open <registry name>", () => {
  it.each([
    ["open chrome", "chrome"],
    ["Open Chrome please", "chrome"],
    ["open the notepad", "notepad"],
    ["launch spotify", "spotify"],
    ["chrome kholo", "chrome"],
    ["chrome ko kholo", "chrome"],
    ["spotify khol do", "spotify"],
    ["chrome open karo", "chrome"],
    ["open google chrome", "chrome"],
    ["क्रोम खोलो", "chrome"],
    ["नोटपैड को खोलो", "notepad"],
    ["नोटपैड खोल दो", "notepad"],
    ["open calculator", "calc"],
  ])("%s -> open %s", (t, id) => {
    const r = hit(t);
    expect(r.hit).toBe(true);
    if (r.hit) {
      expect(r.command).toBe("open");
      expect(r.args?.id).toBe(id);
      expect(typeof r.args?.target).toBe("string");
    }
  });
  it("one edit on a name of 5 or more characters hits, at lower confidence", () => {
    const exact = hit("open spotify");
    const fuzzy = hit("open spotifi");
    const slack = hit("open slakk");
    expect(fuzzy).toMatchObject({ hit: true, command: "open", args: { id: "spotify" } });
    expect(slack).toMatchObject({ hit: true, args: { id: "slack" } });
    if (exact.hit && fuzzy.hit) expect(fuzzy.confidence).toBeLessThan(exact.confidence);
  });
  it("two edits never hit", () => {
    expect(hit("open spotfy x").hit).toBe(false);
    expect(hit("open spotiffy").hit).toBe(true);
    expect(hit("open sptifiy").hit).toBe(false);
  });
  it("names shorter than 5 characters are exact only", () => {
    expect(hit("open word").hit).toBe(true);
    expect(hit("open wrd").hit).toBe(false);
    expect(hit("open wordd").hit).toBe(false);
    expect(hit("open wor").hit).toBe(false);
  });
  it("ambiguous names give no hit", () => {
    expect(hit("open photoshup").hit).toBe(false);
    const two = [
      { id: "a", names: ["Notes"] },
      { id: "b", names: ["Notes"] },
    ];
    expect(matchCommand("open notes", { registry: two }).hit).toBe(false);
  });
  it("an exact name beats a fuzzy neighbour", () => {
    const r = hit("open photoshop");
    expect(r).toMatchObject({ hit: true, args: { id: "ps" } });
  });
  it("the same id under two names is not ambiguous", () => {
    expect(hit("open google chrome")).toMatchObject({ hit: true, args: { id: "chrome" } });
    expect(hit("open chrome")).toMatchObject({ hit: true, args: { id: "chrome" } });
  });
  it("a name not in the registry never hits, and an empty registry never opens", () => {
    expect(hit("open firefox").hit).toBe(false);
    expect(hit("firefox kholo").hit).toBe(false);
    expect(matchCommand("open chrome", { registry: [] }).hit).toBe(false);
    expect(hit("open").hit).toBe(false);
    expect(hit("kholo").hit).toBe(false);
  });
  it("a sentence around the open command falls through", () => {
    expect(hit("open chrome and search for cats").hit).toBe(false);
    expect(hit("chrome kholo aur google pe search karo").hit).toBe(false);
  });
  it("ignores empty registry names and malformed entries", () => {
    const odd = [
      { id: "x", names: ["", "  "] },
      { id: "y", names: [] },
      { id: "chrome", names: ["Chrome"] },
    ] as CommandRegistryEntry[];
    expect(matchCommand("open chrome", { registry: odd })).toMatchObject({
      hit: true,
      args: { id: "chrome" },
    });
  });
});

describe("consequential words are never in the lane", () => {
  it.each([
    "delete",
    "delete everything",
    "send",
    "send it",
    "send the email",
    "pay",
    "pay the bill",
    "install",
    "install chrome",
    "run",
    "run it",
    "shutdown",
    "shut down",
    "shut down the computer",
    "restart",
    "डिलीट करो",
    "डिलीट",
    "mita do",
    "bhej do",
    "भेज दो",
    "पेमेंट करो",
    "shutdown karo",
  ])("%s -> no hit", (t) => {
    expect(hit(t).hit).toBe(false);
  });
  it("a registry name that is a consequential word is not opened", () => {
    expect(hit("open run").hit).toBe(false);
    expect(hit("run kholo").hit).toBe(false);
  });
  it("no vocabulary phrase contains a consequential word", () => {
    for (const c of Object.keys(COMMAND_VOCABULARY) as VocabularyCommand[]) {
      const v = COMMAND_VOCABULARY[c];
      for (const p of [...v.en, ...v.hinglish, ...v.hi])
        expect(p.toLowerCase(), p).not.toMatch(
          /delete|send|pay|install|run\b|shutdown|shut down|format|erase|bhej|mita|डिलीट|भेज/,
        );
    }
  });
});

describe("agreement with the stop words the voice session already knows", () => {
  it("every stop word the interruption controller lists is a safety verb here or falls through", () => {
    for (const p of INTERRUPT_STOP_PHRASES) {
      const r = hit(p);
      if (r.hit) {
        expect(SAFETY_COMMANDS.has(r.command), p).toBe(true);
        expect(isImmediateStop(p), p).toBe(true);
      }
    }
  });
  it("the plain stops are stops in both places", () => {
    for (const p of ["stop", "ruko", "bas karo", "रुको", "chup"]) {
      expect(isImmediateStop(p), p).toBe(true);
      expect(SAFETY_COMMANDS.has(cmd(p) as CommandName), p).toBe(true);
    }
  });
});

describe("language hint, determinism and immutability", () => {
  it("a language hint only moves the confidence", () => {
    const a = hit("ruko", { lang: "hinglish" });
    const b = hit("ruko", { lang: "en" });
    expect(a).toMatchObject({ hit: true, command: "stop" });
    expect(b).toMatchObject({ hit: true, command: "stop" });
    if (a.hit && b.hit) expect(a.confidence).toBeGreaterThan(b.confidence);
  });
  it("the same input gives the same answer", () => {
    for (const t of ["stop", "open chrome", "volume badhao", "hello there", "आवाज़ कम करो"]) {
      expect(JSON.stringify(hit(t))).toBe(JSON.stringify(hit(t)));
    }
  });
  it("the registry and the context are never changed", () => {
    const registry = REGISTRY.map((e) => ({ id: e.id, names: [...e.names] }));
    const frozen = registry.map((e) =>
      Object.freeze({ id: e.id, names: Object.freeze([...e.names]) }),
    );
    const c = Object.freeze({ registry: Object.freeze(frozen), lang: "hinglish" as const });
    const before = JSON.stringify(c);
    for (const t of ["open spotifi", "open photoshup", "stop", "chrome kholo"]) matchCommand(t, c);
    expect(JSON.stringify(c)).toBe(before);
  });
  it("the vocabulary tables are frozen", () => {
    expect(Object.isFrozen(COMMAND_VOCABULARY)).toBe(true);
    expect(Object.isFrozen(COMMAND_VOCABULARY.stop.en)).toBe(true);
  });
});

describe("safety and speed", () => {
  it("nothing exported can approve, confirm or say yes", () => {
    for (const name of Object.keys(lane))
      expect(name).not.toMatch(/approv|confirm|\byes\b|^yes|grant/i);
    const r = hit("stop");
    expect(Object.keys(r).join(",")).not.toMatch(/approv|confirm/i);
  });
  it("500 calls with a 200-entry registry take under 50 ms in total", () => {
    const big: CommandRegistryEntry[] = Array.from({ length: 200 }, (_, i) => ({
      id: `app-${i}`,
      names: [`Application${i}`, `ऐप ${i}`],
    }));
    const texts = [
      "stop",
      "open application7",
      "open appliction7",
      "open nosuchthing",
      "application150 kholo",
      "this is a long sentence that falls straight through to the brain",
      "volume kam karo",
      "आवाज़ बढ़ाओ",
    ];
    for (const t of texts) matchCommand(t, { registry: big });
    expect(matchCommand("open application7", { registry: big }).hit).toBe(true);
    const ms = bestOfMs(() => {
      for (let i = 0; i < 500; i++)
        matchCommand(texts[i % texts.length] as string, { registry: big });
    });
    expect(ms).toBeLessThan(LANE_500_CALLS_BOUND_MS);
  });
});
