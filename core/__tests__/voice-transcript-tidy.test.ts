/** FRIDAY Tidy: fixture-driven transcript cleanup (Hindi, English, Hinglish), script policy, the learn helper, and its wiring. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  proposeDictionaryEntry,
  TIDY_MAX_CHARS,
  tidyTranscript,
  type TidyOptions,
} from "../../src/lib/friday/voice-engine/transcript-tidy";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

type Case = {
  name: string;
  input: string;
  expected: string;
  kinds: string[];
  options?: TidyOptions;
};
const read = (rel: string): string => readFileSync(resolve(__dirname, rel), "utf8");
const cases = (JSON.parse(read("../fixtures/voice-tidy-cases.json")) as { cases: Case[] }).cases;
const DEVANAGARI = /[ऀ-ॿ]/g;
const letters = (line: string, rule: RegExp): number => (line.match(rule) ?? []).length;

describe("FRIDAY Tidy fixtures", () => {
  it("covers at least 50 cases in all three languages", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.some((c) => DEVANAGARI.test(c.input))).toBe(true);
    expect(cases.some((c) => /\b(?:matlab|nahi|purn|naya|suchi)\b/.test(c.input))).toBe(true);
  });

  it("cleans every case as written and lists the edits in order", () => {
    for (const c of cases) {
      const out = tidyTranscript(c.input, c.options);
      expect(out.text, c.name).toBe(c.expected);
      expect(
        out.changes.map((x) => x.kind),
        c.name,
      ).toEqual(c.kinds);
      expect(out.raw, c.name).toBe(c.input);
      expect(out.changed, c.name).toBe(c.kinds.length > 0);
    }
  });

  it("returns the heard text byte for byte when nothing applies", () => {
    for (const c of cases.filter((x) => x.kinds.length === 0)) {
      expect(tidyTranscript(c.input, c.options).text, c.name).toBe(c.input);
    }
  });

  it("is idempotent: tidying a tidied line changes nothing more", () => {
    for (const c of cases) {
      const again = tidyTranscript(c.expected, c.options);
      expect(again.text, c.name).toBe(c.expected);
    }
  });

  it("never transliterates: no Devanagari from Latin, no Latin from Devanagari", () => {
    for (const c of cases) {
      const out = tidyTranscript(c.input, c.options).text;
      const dataDeva = letters(JSON.stringify(c.options ?? {}), DEVANAGARI);
      expect(letters(out, DEVANAGARI), c.name).toBeLessThanOrEqual(
        letters(c.input, DEVANAGARI) + dataDeva,
      );
      const inLatin =
        letters(c.input, /[A-Za-z]/g) + letters(JSON.stringify(c.options ?? {}), /[A-Za-z]/g);
      expect(letters(out, /[A-Za-z]/g), c.name).toBeLessThanOrEqual(inLatin);
    }
  });

  it("every change names what it replaced and what it wrote", () => {
    for (const c of cases) {
      for (const change of tidyTranscript(c.input, c.options).changes) {
        expect(change.from.length, c.name).toBeGreaterThan(0);
        expect(change.from, c.name).not.toBe(change.to);
      }
    }
  });
});

describe("FRIDAY Tidy behaviour", () => {
  it("tags the language of the cleaned text and flags Roman Hindi without converting it", () => {
    const hi = tidyTranscript("um मुझे पानी चाहिए");
    expect(hi.lang).toBe("hi");
    const mixed = tidyTranscript("um मुझे meeting का agenda चाहिए");
    expect(mixed.lang).toBe("mixed");
    const roman = tidyTranscript("um main kal aaunga aur kaam karunga");
    expect(roman.romanHindi).toBe(true);
    expect(roman.text).toBe("main kal aaunga aur kaam karunga");
  });

  it("each step can be switched off", () => {
    expect(tidyTranscript("um hello comma", { fillers: false }).text).toBe("um hello,");
    expect(tidyTranscript("um hello comma", { punctuation: false }).text).toBe("hello comma");
    expect(tidyTranscript("two, actually three", { backtrack: false }).text).toBe(
      "two, actually three",
    );
    expect(tidyTranscript("list one a two b", { lists: false }).text).toBe("list one a two b");
  });

  it("leaves a very long text exactly as heard and survives odd input", () => {
    const long = `um ${"word ".repeat(TIDY_MAX_CHARS)}`;
    expect(tidyTranscript(long).text).toBe(long);
    expect(tidyTranscript(undefined as unknown as string).text).toBe("");
    expect(tidyTranscript("ab um c").text).toBe("ab c");
    expect(tidyTranscript("...").text).toBe("...");
    expect(tidyTranscript("um\n\num\nhello").text).toBe("\n\n\nhello");
  });

  it("ignores broken dictionary and snippet rows", () => {
    const out = tidyTranscript("hello", {
      dictionary: [
        { heard: "", write: "x" },
        { heard: "hello", write: "" },
      ],
      snippets: [{ trigger: "  ", text: "x" }],
    });
    expect(out.text).toBe("hello");
    expect(out.changed).toBe(false);
  });

  it("a snippet text is never re-read by the dictionary or another step", () => {
    const out = tidyTranscript("my email", {
      snippets: [{ trigger: "my email", text: "um chat gpt comma" }],
      dictionary: [{ heard: "chat gpt", write: "ChatGPT" }],
    });
    expect(out.text).toBe("um chat gpt comma");
  });
});

describe("learn from a correction", () => {
  it("proposes one entry from the single changed run and saves nothing", () => {
    const entries = [{ heard: "other", write: "Other" }];
    const proposal = proposeDictionaryEntry(
      "call devendra tomorrow",
      "call Devendra tomorrow",
      entries,
    );
    expect(proposal).toEqual({ ok: true, entry: { heard: "devendra", write: "Devendra" } });
    expect(entries).toHaveLength(1);
    expect(proposeDictionaryEntry("open chat gpt now", "open ChatGPT now")).toEqual({
      ok: true,
      entry: { heard: "chat gpt", write: "ChatGPT" },
    });
  });

  it("refuses a pure insertion, a big rewrite, a script swap, a known word, and no change", () => {
    const reason = (a: string, b: string, known: { heard: string; write: string }[] = []) => {
      const p = proposeDictionaryEntry(a, b, known);
      return p.ok ? "ok" : p.reason;
    };
    expect(reason("hello world", "hello")).toBe("empty");
    expect(reason("a b c d e f", "x y z w v u")).toBe("too-big");
    expect(reason("call raj now", "call राज now")).toBe("script-change");
    expect(
      reason("call devendra", "call Devendra", [{ heard: "Devendra", write: "Devendra" }]),
    ).toBe("known");
    expect(reason("same words", "same words")).toBe("same");
    expect(reason("", "")).toBe("same");
  });
});

describe("FRIDAY Tidy wiring", () => {
  const mode = read("../../src/lib/friday/assistant-mode.ts");

  it("the setting is on by default and shown in the voice settings", () => {
    expect(DEFAULT_PREFERENCES.voice.tidyDictation).toBe(true);
    expect(read("../../src/components/friday/settings/VoiceSettings.tsx")).toContain(
      "prefs.voice.tidyDictation !== false",
    );
  });

  it("only the words shown are tidied, only when the setting is not off, and never the Brain command", () => {
    expect(mode).toMatch(/if \(voice\.tidyDictation === false\) return \{ text: heard \};/);
    expect(mode).toMatch(/const shown = this\.tidyShown\(command\);/);
    expect(mode).toMatch(/this\.caption\("user", shown\.text, false, \{/);
    expect(mode).toMatch(/this\.routeCommand\(command\);/);
    expect(mode).not.toMatch(/routeCommand\(shown/);
  });

  it("is pure local code: no network, no storage, no timer", () => {
    const source = read("../../src/lib/friday/voice-engine/transcript-tidy.ts");
    expect(source).not.toMatch(
      /\b(fetch|XMLHttpRequest|WebSocket|localStorage|setTimeout|Date\.now)\b/,
    );
    expect(source).not.toMatch(/from "node:/);
  });
});
