/**
 * FRIDAY · the sandbox "Ask about errors" button keeps tool output out of the typed prompt
 *
 * Sandbox output is tool output, so it is data. The button keeps promptOrigin typed, but the prompt text is one
 * fixed sentence and the output travels in the extra block, which the brain treats as untrusted context.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const page = fs.readFileSync(path.join(root, "src/routes/sandbox.tsx"), "utf8");

function askButtonSource(): string {
  const start = page.indexOf("Ask about errors");
  expect(start).toBeGreaterThan(0);
  return page.slice(page.lastIndexOf("<Button", start), start);
}

describe("sandbox Ask about errors", () => {
  const button = askButtonSource();

  it("sends the fixed sentence only, with no output spliced into the prompt", () => {
    expect(button).toContain('brain.send("find the errors in the sandbox"');
    expect(button).not.toMatch(/\$\{/);
    expect(button).not.toContain("summarizeSandboxOutput");
  });

  it("still marks the prompt typed and passes the sandbox session as extra", () => {
    expect(button).toContain("extra: formatSandboxExtra()");
    expect(button).toContain('promptOrigin: "typed"');
  });

  it("the extra block already carries the live error lines of the page output", () => {
    const awareness = fs.readFileSync(
      path.join(root, "src/lib/friday/sandbox-awareness.ts"),
      "utf8",
    );
    expect(awareness).toContain("error lines:");
    expect(page).toMatch(/lastErrors: summarizeSandboxOutput\(output\)/);
  });
});
