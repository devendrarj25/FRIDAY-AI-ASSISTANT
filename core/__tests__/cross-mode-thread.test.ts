import { describe, expect, it } from "vitest";

import {
  applyLiveConversationSnapshot,
  getConversationSession,
  liveConversationSnapshot,
  resetConversationSession,
} from "../../src/lib/friday/brain/conversation-state";
import { understandTurn } from "../../src/lib/friday/brain/intent-engine";
import { resolvePointer } from "../../src/lib/friday/brain/intent-engine";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { boilerplateHits, resetSocialLines } from "../../src/lib/friday/conversation-style";
import { microphoneAllowed, spokenReplyAllowed } from "../../src/lib/friday/voice-session";

const NOW = Date.UTC(2026, 0, 15, 15, 0, 0);

describe("chat and voice share one thread", () => {
  it("keeps the topic when the surface changes and after a restart", () => {
    resetConversationSession();
    const voice = understandTurn({
      text: "Open the budget spreadsheet for review",
      endpoint: "voice",
    });
    const afterVoice = getConversationSession();
    expect(afterVoice.lastEndpoint).toBe("voice");
    expect(afterVoice.activeTopic).toMatch(/budget spreadsheet/i);
    expect(voice.conversationResolved.length).toBeGreaterThan(0);

    const chat = understandTurn({
      text: "wahi file ko save karo",
      history: [{ role: "user", text: "Open the budget spreadsheet for review" }],
      endpoint: "chat",
    });
    const afterChat = getConversationSession();
    expect(afterChat.id).toBe(afterVoice.id);
    expect(afterChat.lastEndpoint).toBe("chat");
    expect(afterChat.activeTopic).toMatch(/budget spreadsheet/i);
    expect(chat.conversationResolved.toLowerCase()).toMatch(/budget/);
    expect(resolvePointer("wahi file", afterChat.activeTopic)).toMatch(/budget spreadsheet/i);

    const snap = liveConversationSnapshot();
    expect(snap.endpoint).toBe("chat");
    expect(snap.live).toBe(true);
    resetConversationSession();
    expect(getConversationSession().activeTopic).toBe("");
    expect(applyLiveConversationSnapshot(snap)).toBe(true);
    expect(getConversationSession().activeTopic).toMatch(/budget spreadsheet/i);
    expect(getConversationSession().lastEndpoint).toBe("chat");
    expect(getConversationSession().id).not.toBe("");
  });

  it("keeps manual and chat silent, and social lines short in both wordings", () => {
    expect(microphoneAllowed("manual", false)).toBe(false);
    expect(spokenReplyAllowed("manual", false)).toBe(false);
    expect(microphoneAllowed("auto", true)).toBe(false);
    expect(spokenReplyAllowed("auto", true)).toBe(false);
    expect(microphoneAllowed("auto", false)).toBe(true);
    resetSocialLines();
    const typed = baselineRespond("hello", { now: NOW });
    const spoken = baselineRespond("नमस्ते", { now: NOW });
    expect(boilerplateHits(typed.text)).toEqual([]);
    expect(boilerplateHits(spoken.text)).toEqual([]);
    expect(typed.text.length).toBeLessThanOrEqual(90);
    expect(spoken.text).toMatch(/[\u0900-\u097F]/);
  });
});

describe("Hinglish pointers and connectors in the real understanding path", () => {
  it("keeps the rest of the sentence when it swaps the pointer for the topic", async () => {
    const { resolvePointer, splitIntents } =
      await import("../../src/lib/friday/brain/intent-engine");
    expect(resolvePointer("usko khol do", "budget sheet")).toBe("budget sheet khol do");
    expect(resolvePointer("wahi file", "budget sheet")).toBe("budget sheet");
    expect(resolvePointer("usko khol do", "")).toBe("usko khol do");
    expect(resolvePointer("usko khol do", "x".repeat(120))).toBe("usko khol do");
    expect(resolvePointer("open chrome", "budget sheet")).toBe("open chrome");
    expect(splitIntents("chrome kholo aur phir note likho")).toEqual([
      "chrome kholo",
      "note likho",
    ]);
    expect(splitIntents("chrome kholo uske baad note likho")).toHaveLength(2);
  });
});
