/**
 * "Correct what I heard": the owner's fix of a heard line becomes a corrected owner row for the glossary, the Learn panel
 * list refreshes from that one event, and nothing that is not the owner's own heard speech is ever sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const learn = vi.fn();
vi.mock("../../src/lib/friday/kernel-api", () => ({
  kernelApi: { glossary: { learn: (...a: unknown[]) => learn(...a) } },
}));

import {
  canCorrect,
  correctionRow,
  heardOf,
  onGlossaryLearned,
  saveCorrection,
} from "../../src/lib/friday/glossary-correction";
import { CorrectHeardForm } from "../../src/components/friday/CorrectHeard";
import type { Caption } from "../../src/lib/friday/assistant-mode";

const source = (file: string) => readFileSync(join(__dirname, "../..", file), "utf8");
const line = (over: Partial<Caption> = {}): Caption => ({
  id: "c1",
  who: "user",
  text: "open the vishwakarma file",
  at: 1,
  ...over,
});

beforeEach(() => {
  learn.mockReset();
});

describe("which lines can be corrected", () => {
  it("allows the owner's finished heard line, addressed or untagged", () => {
    expect(canCorrect(line())).toBe(true);
    expect(canCorrect(line({ tag: "addressed" }))).toBe(true);
  });

  it("refuses her own lines, room talk, partial lines and empty text", () => {
    expect(canCorrect(line({ who: "friday" }))).toBe(false);
    expect(canCorrect(line({ tag: "ambient" }))).toBe(false);
    expect(canCorrect(line({ tag: "self" }))).toBe(false);
    expect(canCorrect(line({ partial: true }))).toBe(false);
    expect(canCorrect(line({ text: "   " }))).toBe(false);
  });

  it("heard is the ear's raw words when Tidy edited the shown line", () => {
    expect(heardOf(line())).toBe("open the vishwakarma file");
    expect(heardOf(line({ tidy: { raw: "open the vishwa karma file", changes: [] } }))).toBe(
      "open the vishwa karma file",
    );
  });
});

describe("the corrected row", () => {
  it("is an owner row marked corrected, with heard and text only", () => {
    expect(correctionRow(line(), "open the Vishwakarma file")).toEqual({
      source: "owner",
      corrected: true,
      heard: "open the vishwakarma file",
      text: "open the Vishwakarma file",
    });
  });

  it("is null for an empty or unchanged fix and for a line that cannot be corrected", () => {
    expect(correctionRow(line(), "   ")).toBeNull();
    expect(correctionRow(line(), " open the vishwakarma file ")).toBeNull();
    expect(correctionRow(line({ who: "friday" }), "something else")).toBeNull();
    expect(correctionRow(line({ tag: "ambient" }), "something else")).toBeNull();
  });
});

describe("saving a correction", () => {
  it("sends one corrected owner row with the glossary setting and returns the words", async () => {
    learn.mockResolvedValue({ terms: ["Vishwakarma"] });
    const out = await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(learn).toHaveBeenCalledTimes(1);
    expect(learn).toHaveBeenCalledWith(
      [
        {
          source: "owner",
          corrected: true,
          heard: "open the vishwakarma file",
          text: "open the Vishwakarma file",
        },
      ],
      true,
    );
    expect(out).toEqual({ ok: true, terms: ["Vishwakarma"], learning: true });
  });

  it("passes the setting through and says nothing was learned while it is off", async () => {
    learn.mockResolvedValue({ terms: [] });
    const out = await saveCorrection(line(), "open the Vishwakarma file", false);
    expect(learn).toHaveBeenCalledWith(expect.any(Array), false);
    expect(out).toEqual({ ok: true, terms: [], learning: false });
  });

  it("reports an offline kernel as an error, never as saved", async () => {
    learn.mockResolvedValue(null);
    const out = await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/offline/i);
  });

  it("reports a failing call as an error with its message", async () => {
    learn.mockRejectedValue(new Error("stalled"));
    const out = await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(out).toEqual({ ok: false, error: "stalled" });
  });

  it("never calls the kernel for a line that is not the owner's or has no change", async () => {
    await saveCorrection(line({ who: "friday" }), "x y z", true);
    await saveCorrection(line({ tag: "ambient" }), "x y z", true);
    await saveCorrection(line(), "open the vishwakarma file", true);
    expect(learn).not.toHaveBeenCalled();
  });
});

describe("the learned words list refreshes from one event", () => {
  it("tells listeners after a save, not after a failure, and unsubscribes", async () => {
    const seen = vi.fn();
    const off = onGlossaryLearned(seen);
    learn.mockResolvedValue(null);
    await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(seen).not.toHaveBeenCalled();
    learn.mockResolvedValue({ terms: ["Vishwakarma"] });
    await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    await saveCorrection(line(), "open the Vishwakarma file", true);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("the Learn panel subscribes and refreshes its list, with no new timer", () => {
    const panel = source("src/components/friday/settings/LearnSettings.tsx");
    expect(panel).toMatch(/onGlossaryLearned\(/);
    expect(panel).toMatch(/onGlossaryLearned\([^)]*refresh|onGlossaryLearned\(\(\) => setReload/);
    expect(panel).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("the form states", () => {
  const base = {
    heard: "open the vishwakarma file",
    value: "open the Vishwakarma file",
    onChange: () => undefined,
    onSave: () => undefined,
    onCancel: () => undefined,
    learning: true,
  };
  const html = (over: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(CorrectHeardForm, { ...base, status: "editing", ...over }));

  it("editing shows the heard words, a field, Save and Cancel", () => {
    const out = html({});
    expect(out).toContain("open the vishwakarma file");
    expect(out).toContain("<textarea");
    expect(out).toMatch(/>Save</);
    expect(out).toMatch(/>Cancel</);
    expect(out).not.toMatch(/disabled=""[^>]*>Save/);
  });

  it("an empty or unchanged value disables Save and says why", () => {
    const out = html({ value: "open the vishwakarma file" });
    expect(out).toMatch(/Change at least one word/);
    expect(out).toMatch(/disabled=""[^>]*>[^<]*(<[^>]+>)*Save/);
  });

  it("saving shows a loading state and disables the controls", () => {
    expect(html({ status: "saving" })).toMatch(/Saving/);
  });

  it("an error shows the message with Retry", () => {
    const out = html({ status: "error", message: "The kernel is offline." });
    expect(out).toContain("The kernel is offline.");
    expect(out).toMatch(/Retry/);
  });

  it("done says whether the word was learned or the setting is off", () => {
    expect(html({ status: "done" })).toMatch(/Saved/);
    expect(html({ status: "done", learning: false })).toMatch(/Learn the words I correct/);
  });
});

describe("wiring", () => {
  it("only the owner's transcript rows offer the action and nothing else sends rows", () => {
    const rows = source("src/components/friday/VoiceTranscript.tsx");
    expect(rows).toMatch(/CorrectHeard/);
    const lib = source("src/lib/friday/glossary-correction.ts");
    expect(lib).toMatch(/source: "owner"/);
    expect(lib).toMatch(/corrected: true/);
    const sources = [...lib.matchAll(/source:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(sources.length).toBeGreaterThan(0);
    expect(new Set(sources)).toEqual(new Set(["owner"]));
  });
});

describe("CorrectHeard focus and hint", () => {
  const src = readFileSync(join(process.cwd(), "src/components/friday/CorrectHeard.tsx"), "utf8");
  it("moves focus on open, close and save, and hints only after an edit", () => {
    expect(src).toContain("areaRef.current?.focus()");
    expect(src).toContain("closeRef.current?.focus()");
    expect(src).toContain("triggerRef.current?.focus()");
    expect(src).toContain("quietUntilEdited");
  });
});
