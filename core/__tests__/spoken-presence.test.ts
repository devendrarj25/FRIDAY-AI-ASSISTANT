/**
 * How she sounds and behaves in a talk: the conversation reaches the model, she greets from the
 * moment, narrates work in different words, ignores what is not for her, and keeps talking while
 * she works. Chat and Voice read the same code. Pure functions and wiring only: no microphone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { decideAddressing, followUpFits } from "../../src/lib/friday/addressing";
import {
  contextualGreeting,
  resetSocialLines,
  scoreSocial,
  socialLine,
} from "../../src/lib/friday/conversation-style";
import { toolNarration } from "../../src/lib/friday/assistant-conduct";
import {
  createNarrator,
  holdLines,
  stepSubject,
  whileBusy,
} from "../../src/lib/friday/voice-session";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const history = require_(path.join(root, "electron/chat-history.cjs"));

describe("the conversation reaches the model", () => {
  it("keeps the recent turns in order, bounded, and without the question being asked", () => {
    const rows = history.sanitiseHistory(
      [
        { role: "user", text: "open the report" },
        { role: "friday", text: "Opened it." },
        { role: "tool", text: "ignored" },
        { role: "user", text: "make it shorter" },
      ],
      "make it shorter",
    );
    expect(rows).toEqual([
      { role: "user", text: "open the report" },
      { role: "assistant", text: "Opened it." },
    ]);
  });

  it("bounds a long talk, keeps the newest, and flags sensitive lines for the kernel", () => {
    const long = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 ? "friday" : "user",
      text: `line ${i} ${"x".repeat(500)}`,
    }));
    const rows = history.sanitiseHistory(long, "next");
    expect(rows.length).toBeLessThanOrEqual(history.MAX_TURNS);
    expect(
      rows.reduce((n: number, r: { text: string }) => n + r.text.length, 0),
    ).toBeLessThanOrEqual(history.MAX_TOTAL);
    expect(rows.at(-1).text).toContain("line 79");
    expect(
      history.sanitiseHistory([{ role: "user", text: "my pin", sensitive: true }], "x")[0]
        .sensitive,
    ).toBe(true);
    expect(history.sanitiseHistory("nonsense")).toEqual([]);
  });

  it("is sent by the app, checked in the main process and used by the kernel for every model", () => {
    expect(read("src/lib/friday/brain-engine.ts")).toContain(
      "history: this.historyForModel(run.id)",
    );
    expect(read("electron/main.cjs")).toContain('require("./chat-history.cjs").sanitiseHistory');
    expect(read("kernel/main.py")).toContain("history=history");
    expect(read("kernel/router.py")).toContain("messages.extend(history_messages(history");
  });
});

describe("greetings come from the moment", () => {
  const ok = (text: string, lang: "en" | "hi" | "hinglish") =>
    expect(scoreSocial({ prompt: "hi", text, lang })).toEqual([]);

  it("names the part of the day, the gap and the address, in a short line", () => {
    const morning = contextualGreeting({ hour: 8, gapMin: 600, address: "sir" }, "en", 0) || "";
    expect(morning).toMatch(/morning/i);
    expect(morning).toContain("sir");
    ok(morning, "en");
    const late = contextualGreeting({ hour: 1, gapMin: 600 }, "en", 0) || "";
    expect(late).toMatch(/up|late/i);
  });

  it("does not say good morning in the middle of a talk", () => {
    const line = contextualGreeting({ hour: 9, gapMin: 2 }, "en", 0) || "";
    expect(line).not.toMatch(/morning/i);
    ok(line, "en");
  });

  it("answers how they sound, and picks up what they were last on", () => {
    expect(contextualGreeting({ hour: 22, gapMin: 30, feeling: "tired" }, "en", 0)).toMatch(
      /easy|push/i,
    );
    const topic = contextualGreeting({ hour: 15, gapMin: 90, topic: "the report" }, "en", 0) || "";
    expect(topic).toContain("the report");
    ok(topic, "en");
  });

  it("follows the language: Hinglish and Hindi", () => {
    const mix = contextualGreeting({ hour: 8, gapMin: 600 }, "hinglish", 0) || "";
    expect(mix).toMatch(/suprabhat|subah/i);
    ok(mix, "hinglish");
    const hi = contextualGreeting({ hour: 8, gapMin: 600 }, "hi", 0) || "";
    expect(hi).toMatch(/[ऀ-ॿ]/);
    ok(hi, "hi");
  });

  it("is not the same line every time", () => {
    resetSocialLines();
    const lines = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      lines.add(
        socialLine({
          kind: "greeting",
          prompt: "hello",
          salt: i,
          context: { hour: 9, gapMin: 700, address: "sir" },
        }).text,
      );
    }
    expect(lines.size).toBeGreaterThanOrEqual(4);
    resetSocialLines();
  });

  it("reaches Chat and Voice through one responder", () => {
    expect(read("src/lib/friday/brain-engine.ts")).toContain("social: this.momentForGreeting(");
    expect(read("src/lib/friday/brain/baseline-responder.ts")).toContain("session?.social");
  });
});

describe("what she says while work runs", () => {
  it("never says 'Opening it.' and names the real step in the step's own words", () => {
    expect(
      toolNarration({ nodeId: "execution.runners", state: "running", detail: "opening Chrome" }),
    ).toBe("opening Chrome");
    expect(stepSubject("opening Chrome")).toBe("Opening Chrome");
    expect(stepSubject("classify intent with a very odd internal id #4a")).toBe("");
    expect(read("src/lib/friday/assistant-conduct.ts")).not.toContain('"Opening it."');
  });

  it("starts with the usual first line, then different ones, never the same twice in a row", () => {
    let clock = 0;
    const narrator = createNarrator(() => clock);
    const seen: string[] = [];
    narrator.begin();
    for (let i = 0; i < 4; i += 1) {
      clock += 10_000;
      const line = narrator.say(i === 0 ? "first" : "later", {
        text: "open the report",
        elapsedMs: clock,
      });
      if (line) seen.push(line);
    }
    expect(seen[0]).toBe(holdLines("open the report").first);
    expect(new Set(seen).size).toBe(seen.length);
    clock += 10_000;
    expect(narrator.say("later", { text: "open the report", elapsedMs: clock })).toBe("");
  });

  it("is sparse: not twice inside a few seconds, and tool lines only once the work has taken a while", () => {
    let clock = 100_000;
    const narrator = createNarrator(() => clock);
    narrator.begin();
    expect(narrator.say("tool", { text: "x", detail: "opening Chrome", elapsedMs: 500 })).toBe("");
    const first = narrator.say("tool", {
      text: "open chrome",
      detail: "opening Chrome",
      elapsedMs: 5000,
    });
    expect(first).toMatch(/Opening Chrome/);
    clock += 2000;
    expect(narrator.say("later", { text: "x", elapsedMs: 9000 })).toBe("");
  });

  it("speaks Hinglish to Hinglish", () => {
    const narrator = createNarrator(() => 1);
    narrator.begin();
    expect(narrator.say("first", { text: "kya kar rahi ho", elapsedMs: 3000 })).toBe(
      holdLines("kya kar rahi ho").first,
    );
  });

  it("is what Auto mode uses, with no fixed line left", () => {
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("this.narrator.say(");
    expect(mode).not.toContain("this.speak(narration)");
    expect(mode).toContain('setTimeout(() => say("later"), 40000)');
  });
});

describe("she keeps talking while she works", () => {
  const work = (elapsedMs: number) => ({ task: "build the report", elapsedMs });

  it("answers a status question or small talk at once, and says the work goes on", () => {
    const status = whileBusy("kya kar rahi ho", work(9000));
    expect(status.kind).toBe("reply");
    const social = whileBusy("how are you", work(9000));
    expect(social).toMatchObject({ kind: "reply" });
    expect("line" in social && social.line).toMatch(/still running/i);
    expect(whileBusy("thank you", work(9000)).kind).toBe("reply");
    // "hello" while she works is a check that she is there: she says she is on it.
    const there = whileBusy("hello", work(9000));
    expect("line" in there && there.line).toMatch(/on it/i);
  });

  it("queues a new request that came while real work was running, and says so", () => {
    const decision = whileBusy("also check the calendar", work(9000), { queued: 0 });
    expect(decision.kind).toBe("queue");
    const other = whileBusy("also check the mail", work(9000), { queued: 1 });
    expect(other.kind === "queue" && other.line).not.toBe(
      decision.kind === "queue" && decision.line,
    );
  });

  it("stops and listens when the owner changes their mind, or the work only just began", () => {
    expect(whileBusy("stop, cancel that", work(9000)).kind).toBe("interrupt");
    expect(whileBusy("nahi nahi, chhodo", work(9000)).kind).toBe("interrupt");
    expect(whileBusy("also check the calendar", work(1000)).kind).toBe("interrupt");
  });

  it("does not queue without limit", () => {
    expect(whileBusy("one more thing", work(9000), { queued: 3 }).kind).toBe("reply");
  });

  it("is wired: queued requests run after the work and its answer, and a stop word clears them", () => {
    const mode = read("src/lib/friday/assistant-mode.ts");
    expect(mode).toContain("this.queuedCommands.push(command)");
    expect(mode).toContain("this.drainQueuedCommands()");
    const stop = mode.slice(mode.indexOf("stop word — cancelling speech"));
    expect(stop.slice(0, 400)).toContain("this.queuedCommands = []");
  });
});

describe("what is not for her stays unheard", () => {
  const open = {
    followUpOpen: true,
    lastSpoken: "Opened the report.",
    recentWork: "open the report",
  };

  it("ignores talk about what somebody else said or will do", () => {
    expect(followUpFits({ text: "he said that tomorrow we will go to the market" }).fits).toBe(
      false,
    );
    expect(followUpFits({ text: "usne bola ki kal mausam kharab rahega" }).fits).toBe(false);
    expect(followUpFits({ text: "main kal chrome kholunga aur dekhunga" }).fits).toBe(false);
    expect(
      followUpFits({ text: "the match was great yesterday and everybody was cheering loudly" })
        .fits,
    ).toBe(false);
  });

  it("still hears an answer, a correction, a request and the same topic", () => {
    expect(followUpFits({ text: "haan", ...open }).fits).toBe(true);
    expect(followUpFits({ text: "no no, I meant the other one", ...open }).fits).toBe(true);
    expect(followUpFits({ text: "now open the calendar please", ...open }).fits).toBe(true);
    expect(followUpFits({ text: "make the report shorter", ...open }).fits).toBe(true);
    expect(
      followUpFits({
        text: "mujhe table chahiye",
        lastSpoken: "Kya aap table chahte hain?",
      }).fits,
    ).toBe(true);
  });

  it("does not let a follow-up window turn room talk into a task", () => {
    const heard = decideAddressing({
      text: "he said that tomorrow we will go to the market",
      mode: "conversation",
      ...open,
    });
    expect(heard).toMatchObject({ answer: false, tools: false, tag: "ambient" });
    const asked = decideAddressing({
      text: "ok now open the calendar",
      mode: "conversation",
      ...open,
    });
    expect(asked).toMatchObject({ answer: true, tools: true, reason: "follow-up" });
    // Her name always counts.
    expect(
      decideAddressing({ text: "friday, he said hello to you", mode: "conversation" }).answer,
    ).toBe(true);
  });
});

describe("the persona is the same for every model", () => {
  it("is seeded into the identity every model reads, in Chat and in Voice", () => {
    const identity = read("src/lib/friday/brain/identity.ts");
    expect(identity).toContain("one continuous conversation");
    expect(identity).toContain("Greet differently each time");
    expect(identity).toContain("never the same sentence twice");
    expect(identity).toContain("Stay quiet.");
    // The kernel always leads with the persona whichever model answers.
    expect(read("kernel/router.py")).toContain("friday_persona()");
  });
});
