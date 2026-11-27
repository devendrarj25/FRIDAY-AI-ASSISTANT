import { describe, expect, it } from "vitest";
import { COMMAND_HINTS_MAX, commandHints } from "../../src/lib/friday/voice-engine/hotwords";
import { matchCommand } from "../../src/lib/friday/voice-engine/command-lane";
import { bestOfMs } from "./helpers/wall-clock";
// Best-of-5 bound: at least 10x the idle median of this work.
const MATCH_200_NAMES_BOUND_MS = 50;

const LONG = "Visual Studio Code Insiders";

describe("commandHints from registry names", () => {
  it("returns the written names, deduped by phonetic fold, in first-seen order", () => {
    expect(commandHints(["Chrome", "chrome ", "Photo", "Foto", "Notepad"])).toEqual([
      "Chrome",
      "Photo",
      "Notepad",
    ]);
  });

  it("caps at 100 and drops private, empty and over-long strings", () => {
    const many = Array.from({ length: 150 }, (_, i) => `App Number ${i * 7919}x`);
    expect(COMMAND_HINTS_MAX).toBe(100);
    expect(commandHints(many)).toHaveLength(100);
    const out = commandHints(["", "   ", "my password manager", "a".repeat(41), "Slack"]);
    expect(out).toEqual(["Slack"]);
  });

  it("tolerates a missing or non-string list", () => {
    expect(commandHints(null)).toEqual([]);
    expect(commandHints([1, undefined, "Word"] as unknown as string[])).toEqual(["Word"]);
  });
});

describe("command lane fuzzy snap, one edit per five characters", () => {
  const registry = [
    { id: "vsc", names: [LONG] },
    { id: "uninst", names: ["Uninstall Helper"] },
    { id: "spotify", names: ["Spotify"] },
  ];

  it("allows two edits on a name of ten characters or more", () => {
    const r = matchCommand("open visual studio cod insiderz", { registry });
    expect(r).toMatchObject({ hit: true, command: "open", args: { id: "vsc" } });
    expect(matchCommand("open vsual stdio cd insidrz", { registry }).hit).toBe(false);
  });

  it("keeps one edit for a short name and two edits never snap it", () => {
    expect(matchCommand("open spotifi", { registry }).hit).toBe(true);
    expect(matchCommand("open sptifiy", { registry }).hit).toBe(false);
  });

  it("falls through on a miss", () => {
    expect(matchCommand("open firefox", { registry }).hit).toBe(false);
  });

  it("marks a snap to a consequential name as read-back and ask", () => {
    const r = matchCommand("open uninstal helper", { registry });
    expect(r).toMatchObject({ hit: true, args: { id: "uninst" }, readBack: true });
    const plain = matchCommand("open spotifi", { registry });
    expect(plain.hit && plain.readBack).toBeFalsy();
    const exact = matchCommand("open uninstall helper", { registry });
    expect(exact.hit).toBe(false);
  });

  it("matches 200 names inside a generous time bound", () => {
    const big = Array.from({ length: 200 }, (_, i) => ({
      id: `id${i}`,
      names: [`Application Suite ${i} Pro`],
    }));
    const once = () => matchCommand("open aplication suite 77 pro", { registry: big });
    expect(once()).toEqual(once());
    expect(matchCommand("open application suite 77 pro", { registry: big }).hit).toBe(true);
    expect(bestOfMs(() => once())).toBeLessThan(MATCH_200_NAMES_BOUND_MS);
  });
});
