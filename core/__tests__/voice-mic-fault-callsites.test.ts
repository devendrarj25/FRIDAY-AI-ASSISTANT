/**
 * Auto mode shows a microphone fault through plainFaultLine with the real microphone class and the retry flag, so the
 * corrected text reaches the screen. Source-pinned: every call site passes the context.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../../src/components/friday/AutoMode.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("AutoMode fault lines", () => {
  const calls = source.match(/plainFaultLine\([^()]*(?:\([^()]*\))?[^()]*\)/g) ?? [];
  it("has the four call sites and each passes the fault context", () => {
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call).toContain("faultContext(voice)");
  });
  it("the context carries the microphone class and the retry flag from the real state", () => {
    const fn = source.slice(source.indexOf("function faultContext"));
    expect(fn.slice(0, 500)).toContain("voice.mic.state");
    expect(fn.slice(0, 500)).toContain("micState");
    expect(fn.slice(0, 500)).toContain("healing");
    expect(fn.slice(0, 500)).toContain('state !== "available"');
  });
});
