import { describe, expect, it } from "vitest";
import {
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
});
