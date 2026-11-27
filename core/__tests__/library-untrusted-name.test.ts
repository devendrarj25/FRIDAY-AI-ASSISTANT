import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/library.tsx", "utf8");

/** Every `brain.send(` call with its argument text, up to the matching close paren. */
function sendCalls(text: string): string[] {
  const calls: string[] = [];
  let at = text.indexOf("brain.send(");
  while (at >= 0) {
    let depth = 0;
    let end = at + "brain.send".length;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(at, end + 1));
    at = text.indexOf("brain.send(", end);
  }
  return calls;
}

describe("Library file names are untrusted data, not typed prompt text", () => {
  it("no brain.send prompt interpolates a stored file name", () => {
    const calls = sendCalls(src);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const head = call.split("extra:")[0] ?? call;
      expect(head).not.toMatch(/\$\{\s*(item|open)\.name\s*\}/);
      expect(call).toContain('promptOrigin: "typed"');
    }
  });

  it("the name travels in the untrusted extra block", () => {
    expect(src).toMatch(/FILE library:\$\{item\.id\}[^`]*\$\{item\.name\}/);
    expect(src).toMatch(/FILE library:\$\{open\.id\}[^`]*\$\{open\.name\}/);
  });
});
