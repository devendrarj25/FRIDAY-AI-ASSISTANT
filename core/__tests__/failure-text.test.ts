import { describe, expect, it } from "vitest";
import { failureText } from "../../src/lib/friday/brain/failure-text";

describe("what is said when a turn fails", () => {
  it("leaves a stop the owner asked for alone", () => {
    expect(failureText("Stopped by you.")).toBe("Stopped by you.");
  });

  it("gives the honest handoff when no model can be reached", () => {
    const text = failureText(
      "Could not reach FRIDAY's local AI service: connection refused. No model is reachable.",
    );
    expect(text).toMatch(/can't answer that one on my own/);
    expect(text).toMatch(/Want me to help you connect a model/);
  });

  it("names a next step: one more try for a timeout, a fallback after retries, a stop for a dangerous action", () => {
    expect(failureText("The model timed out after 60s.")).toMatch(/try once more|plan the rest/i);
    expect(failureText("The model request failed.", { attempts: 2 })).toMatch(/safer way/);
    expect(failureText("Deleting the folder failed.", { dangerous: true })).toMatch(
      /will not retry on my own/,
    );
  });

  it("is always one readable line that carries the original reason", () => {
    const text = failureText("Disk is full.");
    expect(text).toContain("Disk is full.");
    expect(text).not.toMatch(/\n/);
  });
});
