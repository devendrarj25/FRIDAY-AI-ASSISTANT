import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUSY_SWITCH_MESSAGE,
  BUSY_TURN_MESSAGE,
  chatSendHold,
  chatSwitchHold,
  manualChatGuide,
  settleInterrupted,
  toolActivity,
  turnLanguage,
} from "../../src/lib/friday/chat-turn";
import { prepareTurn } from "../../src/lib/friday/runtime";

describe("typed chat language", () => {
  it("reads Devanagari as Hindi and a mixed line as Hinglish", () => {
    expect(turnLanguage("क्या हाल है")).toBe("hindi");
    expect(turnLanguage("README.md खोलो")).toBe("hinglish");
    expect(turnLanguage("kya hai ye")).toBe("hinglish");
    expect(turnLanguage("yaad rakhna")).toBe("hinglish");
    expect(turnLanguage("What time is it?")).toBe("english");
  });

  it("matches the last message only while reply language follows the user", () => {
    expect(manualChatGuide("kya hai ye", "follow-user")).toContain("Hinglish");
    expect(manualChatGuide("क्या समय है", "follow-user")).toContain("Reply in Hindi");
    expect(manualChatGuide("What time is it?", "follow-user")).toContain("Reply in English");
    const pinned = manualChatGuide("kya hai ye", "english");
    expect(pinned).toContain("language setting already chosen");
    expect(pinned).not.toContain("Reply in that mix");
  });

  it("keeps a typed turn silent and refuses invented tool facts", () => {
    const guide = manualChatGuide("hello", "follow-user");
    expect(guide).toContain("MANUAL CHAT");
    expect(guide).toContain("microphone");
    expect(guide).toContain("do not say you are speaking");
    expect(guide).toContain("Never invent a file");
  });
});

describe("a refused typed send stays visible", () => {
  it("keeps an empty box quiet and names a busy or refused turn", () => {
    expect(chatSendHold({ text: "   ", busy: false })).toEqual({ send: false, notice: null });
    expect(chatSendHold({ text: "wahi file", busy: true })).toEqual({
      send: false,
      notice: BUSY_TURN_MESSAGE,
    });
    expect(
      chatSendHold({
        text: "continue",
        busy: false,
        accepted: false,
        message: "The local AI service is unavailable.",
      }),
    ).toEqual({ send: false, notice: "The local AI service is unavailable." });
    expect(chatSendHold({ text: "hello", busy: false })).toEqual({ send: true, notice: null });
    expect(chatSwitchHold(false).notice).toBe(BUSY_SWITCH_MESSAGE);
    expect(chatSwitchHold(true).notice).toBeNull();
  });

  it("uses the same busy sentence the brain already returns, and stops before a new chat is wiped", () => {
    const brain = readFileSync(resolve(process.cwd(), "src/lib/friday/brain-engine.ts"), "utf8");
    const dock = readFileSync(resolve(process.cwd(), "src/components/friday/ChatDock.tsx"), "utf8");
    expect(brain).toContain(BUSY_TURN_MESSAGE);
    expect(dock).toContain("chatSendHold");
    expect(dock).toContain("if (!sent.accepted)");
    expect(dock).toContain("chatSwitchHold");
    const clear = brain.slice(brain.indexOf("clearChat()"), brain.indexOf("stop() {"));
    expect(clear.indexOf("this.stop()")).toBeGreaterThan(-1);
    expect(clear.indexOf("this.stop()")).toBeLessThan(clear.indexOf("this.state.messages = []"));
    const load = brain.slice(
      brain.indexOf("loadConversation(messages: Message[])"),
      brain.indexOf("private syncSharedSurfaces"),
    );
    expect(load).toContain("if (this.state.activeRunId) return false;");
  });
});

describe("typed chat stop and tool status", () => {
  it("keeps a stopped partial and writes one line when nothing arrived", () => {
    expect(settleInterrupted("Hello there", "Stopped by you.")).toEqual({
      keep: true,
      text: null,
    });
    expect(settleInterrupted("   ", "Stopped by you.")).toEqual({
      keep: false,
      text: "Stopped.",
    });
  });

  it("folds a real error into the same bubble", () => {
    const settled = settleInterrupted("Half an answer", "the local AI service disconnected");
    expect(settled.keep).toBe(true);
    expect(settled.text).toContain("Half an answer");
    expect(settled.text).toContain("[the local AI service disconnected]");
    expect(settleInterrupted("", "Enter a message before sending.").text).toBe(
      "Enter a message before sending.",
    );
  });

  it("names the read-only tool without putting the notice in the answer", () => {
    expect(toolActivity("fs_read")).toBe("Checking fs.read.");
    expect(toolActivity("bluetooth.scan")).toBe("Checking bluetooth.scan.");
    expect(toolActivity("network_discover")).toBe("Checking network.discover.");
  });
});

describe("prepareTurn typed guide", () => {
  it("adds the manual guide to chat and leaves it off Auto", () => {
    const manual = prepareTurn("kya hai ye", { mode: "manual", multiModel: false });
    const auto = prepareTurn("kya hai ye", { mode: "auto", multiModel: false });
    expect(manual.system).toContain("MANUAL CHAT");
    expect(manual.system).toContain("microphone");
    expect(auto.system).toContain("AUTO MODE");
    expect(auto.system.includes("MANUAL CHAT")).toBe(false);
    expect(manual.modelIds[0]).toBe(auto.modelIds[0]);
  });

  it("keeps a typed turn typed while Auto is listening", () => {
    const typed = prepareTurn("kya hai ye", {
      mode: "auto",
      surface: "chat",
      multiModel: false,
    });
    const spoken = prepareTurn("kya hai ye", {
      mode: "manual",
      surface: "voice",
      multiModel: true,
    });
    expect(typed.system).toContain("MANUAL CHAT");
    expect(typed.system).not.toContain("already been confirmed");
    expect(spoken.system).toContain("AUTO MODE");
    expect(spoken.system).toContain("already been confirmed");
    expect(spoken.system.includes("MANUAL CHAT")).toBe(false);
    expect(spoken.modelIds.length).toBeLessThanOrEqual(1);
  });
});
