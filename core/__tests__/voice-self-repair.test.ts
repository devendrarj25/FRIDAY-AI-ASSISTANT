import { describe, expect, it } from "vitest";
import { detectSelfRepair, repairAuditLine } from "../../src/lib/friday/voice-engine/self-repair";

describe("self-repair", () => {
  it("nahi nahi swaps the number and keeps the raw text", () => {
    const raw = "mujhe do nahi nahi teen file bhejni hai";
    const r = detectSelfRepair(raw);
    expect(r).not.toBeNull();
    expect(r?.raw).toBe(raw);
    expect(r?.repaired).toBe("mujhe teen file bhejni hai");
    expect(r?.from).toBe("do");
    expect(r?.cue).toBe("nahi nahi");
    expect(r?.consequential).toBe(true);
    expect(r?.readBack).toBeTruthy();
  });

  it("I mean swaps a name, is consequential and reads back", () => {
    const r = detectSelfRepair("send it to Rahul I mean Rohan");
    expect(r).toMatchObject({
      repaired: "send it to Rohan",
      from: "Rahul",
      to: "Rohan",
      cue: "I mean",
      consequential: true,
    });
    expect(r?.readBack).toMatch(/Rohan/);
  });

  it("matlab swaps the target of a delete and is consequential", () => {
    const r = detectSelfRepair("delete the file matlab the folder");
    expect(r).toMatchObject({ repaired: "delete the folder", from: "the file", to: "the folder" });
    expect(r?.consequential).toBe(true);
    expect(r?.readBack).toMatch(/folder/);
  });

  it("a leading change cue is left to the router, but a later repair in the same line is found", () => {
    const r = detectSelfRepair("actually send it to Rahul I mean Rohan instead");
    expect(r?.repaired).toBe("actually send it to Rohan instead");
    expect(r?.from).toBe("Rahul");
    expect(r?.consequential).toBe(true);
  });

  it("a stop word is a stop, never a repair", () => {
    expect(detectSelfRepair("ruko")).toBeNull();
    expect(detectSelfRepair("stop")).toBeNull();
  });

  it("empty after, a leading cue, or no cue gives null", () => {
    expect(detectSelfRepair("send it to Rahul I mean")).toBeNull();
    expect(detectSelfRepair("I mean send it to Rohan")).toBeNull();
    expect(detectSelfRepair("nahi nahi teen file")).toBeNull();
    expect(detectSelfRepair("open the notes")).toBeNull();
    expect(detectSelfRepair("")).toBeNull();
  });

  it("weak cues need a parallel span: meaning and plain 'actually' are not repairs", () => {
    expect(detectSelfRepair("iska matlab kya hai")).toBeNull();
    expect(detectSelfRepair("i actually like this song")).toBeNull();
    const r = detectSelfRepair("open the door sorry the window");
    expect(r?.repaired).toBe("open the window");
  });

  it("a harmless repair is not consequential and has no read-back", () => {
    const r = detectSelfRepair("play some jazz I mean rock");
    expect(r?.repaired).toBe("play some rock");
    expect(r?.consequential).toBe(false);
    expect(r).not.toHaveProperty("readBack");
  });

  it("text is data: regex characters are kept literally and the audit line stays short", () => {
    const r = detectSelfRepair("open (.*) I mean [a-z]+ " + "x".repeat(200));
    expect(r?.repaired.startsWith("open [a-z]+")).toBe(true);
    expect(repairAuditLine(r!).length).toBeLessThanOrEqual(80);
  });
});
