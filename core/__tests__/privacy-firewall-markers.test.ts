/**
 * One SENSITIVE marker table (config/sensitive-markers.json) feeds the renderer memory policy,
 * the desktop privacy firewall and the kernel privacy module (kernel/tests/test_privacy_markers.py
 * runs the same lines). A Devanagari or Roman Hindi secret must stop at the firewall, not only in memory.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";

const require = createRequire(import.meta.url);
const firewall = require("../../electron/privacy-firewall.cjs") as {
  classify: (content: unknown) => { level: string; reasons: string[] };
  guardEgress: (input: Record<string, unknown>) => { hardStop?: boolean; autoAllowed: boolean };
  loadMarkerSignals: (table: unknown) => { label: string; test?: (t: string) => boolean }[];
  normaliseText: (text: unknown) => string;
  MARKERS_MISSING_LABEL: string;
  SIGNALS: { label: string; level: string }[];
};

const root = resolve(__dirname, "..", "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");
const lines = JSON.parse(read("core/__tests__/fixtures/sensitive-lines.json")) as {
  sensitive: string[];
  ordinary: string[];
  normalise: [string, string][];
};
const table = JSON.parse(read("config/sensitive-markers.json")) as {
  words: Record<"filler" | "stop" | "closed" | "digits", string[]>;
  fragments: Record<string, string>;
  normalise: {
    form: string;
    units: unknown[];
    digitRanges: unknown[];
  };
  markers: {
    id: string;
    kind: string;
    lang: string;
    label: string;
    flags: string;
    pattern: string;
  }[];
};

describe("the shared lines", () => {
  it("is large enough to mean something", () => {
    expect(lines.sensitive.length).toBeGreaterThanOrEqual(50);
    expect(lines.ordinary.length).toBeGreaterThanOrEqual(40);
  });

  it.each(lines.sensitive)("sensitive everywhere: %s", (line) => {
    expect(looksSensitive(line)).toBe(true);
    expect(firewall.classify(line).level).toBe("sensitive");
    const cloud = { type: "cloud", label: "a cloud model" };
    const decision = firewall.guardEgress({ model: cloud, content: line, connected: true });
    expect(decision.hardStop).toBe(true);
    expect(decision.autoAllowed).toBe(false);
  });

  it.each(lines.ordinary)("ordinary everywhere: %s", (line) => {
    expect(looksSensitive(line)).toBe(false);
    expect(firewall.classify(line).level).not.toBe("sensitive");
  });
});

const SECRETS = [
  "password",
  "pin",
  "otp",
  "cvv",
  "passcode",
  "paasword",
  "पासवर्ड",
  "पासकोड",
  "ओटीपी",
  "सीवीवी",
  "पिन",
];
const VALUES = [
  "hunter",
  "हंटर",
  "sunshine",
  "सनशाइन",
  "nine one two",
  "ek do teen",
  "12",
  "abcd1234",
];
const ORDERS: ((secret: string, value: string) => string)[] = [
  (s, v) => `${s} hai ${v}`,
  (s, v) => `${s} है ${v}`,
  (s, v) => `mera ${s} ${v} hai`,
  (s, v) => `${s} ${v} है`,
];
const CLOSED_ORDERS: ((secret: string, word: string) => string)[] = [
  (s, w) => `${s} hai ${w}`,
  (s, w) => `${s} ${w} hai`,
  (s, w) => `mera ${s} ${w} है`,
];

describe("the value rule: any value after or before है / hai, never a question word", () => {
  it("the desktop firewall, the renderer and the table agree on every generated line", () => {
    const wrong: string[] = [];
    const check = (line: string, expected: boolean) => {
      const renderer = looksSensitive(line);
      const desktop = firewall.classify(line).level === "sensitive";
      if (renderer !== expected || desktop !== expected) wrong.push(`${expected}: ${line}`);
    };
    for (const secret of SECRETS)
      for (const value of VALUES) for (const order of ORDERS) check(order(secret, value), true);
    for (const secret of SECRETS)
      for (const word of table.words.closed ?? [])
        for (const order of CLOSED_ORDERS) check(order(secret, word), false);
    expect(wrong).toEqual([]);
  });

  it("the closed lists are data in the table, with no copy in the code", () => {
    for (const word of [
      "kya",
      "kab",
      "kaise",
      "kyun",
      "kaun",
      "kahan",
      "kitna",
      "batao",
      "bata",
      "bolo",
      "dikhao",
      "change",
      "badlo",
      "badal",
      "reset",
      "manager",
      "tarika",
      "tareeka",
      "process",
      "forgot",
      "bhul",
      "bhool",
      "yaad",
      "क्या",
      "कब",
      "कैसे",
      "क्यों",
      "कौन",
      "कहाँ",
      "कितना",
      "बताओ",
      "बता",
      "बोलो",
      "दिखाओ",
      "बदलो",
      "बदल",
      "रीसेट",
      "मैनेजर",
      "तरीका",
      "प्रक्रिया",
      "भूल",
      "याद",
    ])
      expect(table.words.closed, word).toContain(word);
    for (const word of [
      "mera",
      "meri",
      "mere",
      "ka",
      "ki",
      "ke",
      "ko",
      "hai",
      "hain",
      "tha",
      "thi",
      "me",
      "mein",
      "par",
      "se",
      "ye",
      "yeh",
      "wo",
      "woh",
      "aur",
      "या",
      "और",
      "का",
      "की",
      "के",
      "को",
      "है",
      "हैं",
      "था",
      "थी",
      "में",
      "पर",
      "से",
      "यह",
      "वह",
    ])
      expect(table.words.stop, word).toContain(word);
    for (const file of ["src/lib/friday/brain/memory-policy.ts", "electron/privacy-firewall.cjs"]) {
      const text = read(file);
      for (const needle of ["kaise", "manager", "tareeka", "chhah"])
        expect(text, file).not.toContain(needle);
    }
  });

  it("a word list that is not plain words, or an unknown placeholder, stops everything", () => {
    const row = { label: "x", pattern: "\\b(?:{{words.a}})\\b", flags: "i" };
    for (const bad of [
      { markers: [row], words: { a: ["ok|.*"] } },
      { markers: [row], words: {} },
      { markers: [{ ...row, pattern: "{{nope}}" }] },
    ])
      expect(firewall.loadMarkerSignals(bad)[0]?.label).toBe(firewall.MARKERS_MISSING_LABEL);
    const [good] = firewall.loadMarkerSignals({ markers: [row], words: { a: ["ok", "kya"] } });
    expect(good?.label).toBe("x");
  });
});

describe("the shared normalise step", () => {
  it.each(lines.normalise)("%s -> %s (desktop firewall)", (input, expected) => {
    expect(firewall.normaliseText(input)).toBe(expected);
  });

  it("is data in the table, with no copy of its character classes in the code", () => {
    expect(table.normalise.form).toBe("NFKC");
    expect(table.normalise.units.length).toBeGreaterThanOrEqual(2);
    expect(table.normalise.digitRanges.length).toBeGreaterThanOrEqual(1);
    for (const file of ["src/lib/friday/brain/memory-policy.ts", "electron/privacy-firewall.cjs"]) {
      const text = read(file);
      expect(text, file).not.toContain("0966");
      expect(text, file).not.toContain("200d");
    }
  });
});

describe("the table", () => {
  it("covers English, Hindi and Hinglish with plain rows", () => {
    expect(new Set(table.markers.map((row) => row.lang))).toEqual(
      new Set(["en", "hi", "hinglish"]),
    );
    for (const row of table.markers) {
      expect(row.pattern && row.kind && row.label && row.id).toBeTruthy();
      expect(["", "i"]).toContain(row.flags);
    }
  });

  it("every row compiles once its {{placeholders}} are filled, and every placeholder is defined", () => {
    for (const row of table.markers) {
      for (const [, name] of row.pattern.matchAll(/\{\{([\w.]+)\}\}/g)) {
        const known = name?.startsWith("words.")
          ? (table.words as Record<string, string[]>)[name.slice("words.".length)]
          : table.fragments[name ?? ""];
        expect(known, `${row.id}: ${name}`).toBeTruthy();
      }
    }
    expect(firewall.SIGNALS.length).toBeGreaterThanOrEqual(table.markers.length);
  });

  it("is what the firewall classifies by, row for row, ahead of the lower tiers", () => {
    const labels = firewall.SIGNALS.map((signal) => signal.label);
    expect(labels.slice(0, table.markers.length)).toEqual(table.markers.map((row) => row.label));
    expect(
      firewall.SIGNALS.slice(0, table.markers.length).every((s) => s.level === "sensitive"),
    ).toBe(true);
  });

  it("keeps no second copy in the renderer or the firewall", () => {
    const policy = read("src/lib/friday/brain/memory-policy.ts");
    expect(policy).toContain('config/sensitive-markers.json"');
    expect(policy).not.toMatch(/const SENSITIVE_MARKERS = \[/);
    for (const file of ["src/lib/friday/brain/memory-policy.ts", "electron/privacy-firewall.cjs"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/[ऀ-ॿ]/);
      for (const needle of ["paasword", "ghp_", "seed phrase"])
        expect(text, file).not.toContain(needle);
    }
  });

  it("ships with the app: the config copy does not exclude it", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toMatch(/- from: config\n\s+to: config/);
    expect(builder).not.toContain("sensitive-markers");
  });
});

describe("a table that cannot be used stops everything", () => {
  it.each([
    ["no table", null],
    ["no rows", { markers: [] }],
    ["a row that does not compile", { markers: [{ label: "x", pattern: "(", flags: "" }] }],
  ])("%s", (_name, bad) => {
    const signals = firewall.loadMarkerSignals(bad);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.label).toBe(firewall.MARKERS_MISSING_LABEL);
    expect(signals[0]?.test?.("what is 2+2")).toBe(true);
    expect(signals[0]?.test?.("   ")).toBe(false);
  });

  it("a good row becomes a sensitive signal with its own label", () => {
    const [signal] = firewall.loadMarkerSignals({
      markers: [{ label: "word", pattern: "\\bxyzzy\\b", flags: "i" }],
    });
    expect(signal?.label).toBe("word");
  });
});
