import { describe, expect, it, beforeEach } from "vitest";
import {
  actionMode,
  actionNeedsApproval,
  approvalReason,
  brainActionNeedsApproval,
  commandNeedsApproval,
  isConsequential,
  setActionMode,
} from "../../src/lib/friday/brain/action-risk";

describe("manual / auto approval policy", () => {
  beforeEach(() => setActionMode("auto"));

  it("defaults to auto and follows the switch", () => {
    expect(actionMode()).toBe("auto");
    setActionMode("manual");
    expect(actionMode()).toBe("manual");
  });

  it("auto mode lets read-only actions run but gates write/exec", () => {
    expect(actionNeedsApproval("safe")).toBe(false);
    expect(actionNeedsApproval("write")).toBe(true);
    expect(actionNeedsApproval("exec")).toBe(true);
    // Unknown risk is treated as the most dangerous tier.
    expect(actionNeedsApproval(undefined)).toBe(true);
  });

  it("manual mode gates every action, including read-only ones", () => {
    setActionMode("manual");
    expect(actionNeedsApproval("safe")).toBe(true);
    expect(actionNeedsApproval("write")).toBe(true);
    expect(actionNeedsApproval("exec")).toBe(true);
  });

  it("classifies irreversible, system-level and paid commands as consequential", () => {
    for (const cmd of [
      "delete the logs folder",
      "install ollama",
      "restart my pc",
      "write registry key",
      "npm run build",
      "buy the pro plan",
      "download this model",
      "fetch https://example.com/file.zip",
      "git clone https://example.com/repo.git",
    ])
      expect(isConsequential(cmd), cmd).toBe(true);
    expect(isConsequential("what is the weather")).toBe(false);
  });

  it("gates the same command identically for voice and chat", () => {
    expect(commandNeedsApproval("uninstall python", "auto")).toBe(true);
    expect(commandNeedsApproval("tell me a joke", "auto")).toBe(false);
    expect(commandNeedsApproval("tell me a joke", "manual")).toBe(true);
  });

  it("explains why approval is being asked", () => {
    expect(approvalReason("exec", "auto")).toMatch(/system state/i);
    expect(approvalReason("safe", "manual")).toMatch(/manual mode/i);
  });
});

describe("Brain confirm-important overlay", () => {
  beforeEach(() => setActionMode("auto"));

  it("cannot turn off write/exec asks", () => {
    expect(brainActionNeedsApproval("write", "auto", { confirmImportant: false })).toBe(true);
  });

  it("adds a consequential-safe pause when the Brain toggle is on", () => {
    expect(
      brainActionNeedsApproval("safe", "auto", {
        confirmImportant: true,
        prompt: "uninstall python",
      }),
    ).toBe(true);
  });

  it("Auto Mode runs routine terminal checks without a pause, even with confirm-important", () => {
    expect(commandNeedsApproval("npm test", "auto")).toBe(false);
    expect(commandNeedsApproval("run git status in the terminal", "auto")).toBe(false);
    expect(commandNeedsApproval("run the tests", "auto")).toBe(false);
    expect(commandNeedsApproval("npm install", "auto")).toBe(true);
    expect(commandNeedsApproval("winget install Git.Git", "auto")).toBe(true);
    expect(commandNeedsApproval("npm test", "manual")).toBe(true);
    expect(
      brainActionNeedsApproval("safe", "auto", {
        confirmImportant: true,
        prompt: "run npm test",
      }),
    ).toBe(false);
  });
});
