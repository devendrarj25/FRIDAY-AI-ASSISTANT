/**
 * A line typed at the desktop character is never dropped silently: a refused send shows the brain's own message,
 * and a line refused only because a turn is running waits in a short queue and goes out when that turn ends.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const globals = globalThis as unknown as { window?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}

const { routeCharacterAsk } = await import("../../src/lib/friday/character/link");

const result = (over: Record<string, unknown>) =>
  ({ accepted: false, reason: "busy", message: null, ...over }) as never;

describe("routeCharacterAsk", () => {
  it("sends and says nothing when the brain takes the line", () => {
    const say = vi.fn();
    const queue: string[] = [];
    const out = routeCharacterAsk("hello", {
      send: () => result({ accepted: true, reason: "accepted" }),
      say,
      queue,
    });
    expect(out).toBe("sent");
    expect(say).not.toHaveBeenCalled();
    expect(queue).toEqual([]);
  });

  it("queues a busy line, tells the owner, and caps the queue", () => {
    const say = vi.fn();
    const queue: string[] = [];
    const busy = () => result({ message: "I'm still working on the last request — one moment." });
    const deps = { send: busy, say, queue };
    expect(routeCharacterAsk("one", deps)).toBe("queued");
    expect(routeCharacterAsk("two", deps)).toBe("queued");
    expect(routeCharacterAsk("three", deps)).toBe("queued");
    expect(routeCharacterAsk("four", deps)).toBe("refused");
    expect(queue).toEqual(["one", "two", "three"]);
    expect(say).toHaveBeenCalledWith("I'm still working on the last request — one moment.");
  });

  it("shows the message of any other refusal and does not queue it", () => {
    const say = vi.fn();
    const queue: string[] = [];
    const out = routeCharacterAsk("hmm", {
      send: () => result({ reason: "clarify", message: "Did you mean the calendar?" }),
      say,
      queue,
    });
    expect(out).toBe("refused");
    expect(say).toHaveBeenCalledWith("Did you mean the calendar?");
    expect(queue).toEqual([]);
  });

  it("is what the overlay's ask handler and the queue drain both use", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/lib/friday/character/link.ts"),
      "utf8",
    );
    expect(source.match(/routeCharacterAsk\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).not.toMatch(/^\s*brain\.send\(text\);/m);
  });
});
