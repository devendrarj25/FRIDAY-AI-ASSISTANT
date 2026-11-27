import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const sapi = require_("../../electron/sapi-voice.cjs") as {
  sapiScript: (text: string, options?: { wav?: string; rate?: number; volume?: number }) => string;
  sapiCommand: (text: string, options?: { wav?: string }) => string[];
};

// PowerShell's tokenizer treats all four of these as a single quote (about_Quoting_Rules).
const PS_SINGLE_QUOTES = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);

/**
 * Reads one PowerShell single-quoted literal that starts at `open`, the way PowerShell does:
 * any quote character ends it unless the next character is a quote too (an escaped quote).
 */
function readSingleQuoted(script: string, open: number): { value: string; end: number } {
  expect(PS_SINGLE_QUOTES.has(script[open] ?? "")).toBe(true);
  let value = "";
  let i = open + 1;
  while (i < script.length) {
    const ch = script[i] ?? "";
    if (PS_SINGLE_QUOTES.has(ch)) {
      if (PS_SINGLE_QUOTES.has(script[i + 1] ?? "")) {
        value += "'";
        i += 2;
        continue;
      }
      return { value, end: i };
    }
    value += ch;
    i += 1;
  }
  throw new Error("unterminated literal");
}

/** The literal passed to `call(` and whatever PowerShell would run straight after it. */
function argumentOf(script: string, call: string): { value: string; after: string } {
  const at = script.indexOf(`${call}(`);
  expect(at).toBeGreaterThanOrEqual(0);
  const { value, end } = readSingleQuoted(script, at + call.length + 1);
  expect(script[end + 1]).toBe(")");
  return { value, after: script.slice(end + 2) };
}

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("SAPI command keeps spoken text as data", () => {
  it("a curly quote cannot end the string and run a command", () => {
    const hostile = "Don\u2019t worry\u2018; Remove-Item x; \u201A\u201B";
    const script = sapi.sapiScript(hostile);
    expect(script).not.toContain(hostile);
    expect(script).not.toContain("\u2018; Remove-Item x");
    const spoken = argumentOf(script, "$s.Speak");
    expect(spoken.value).toBe("Don't worry'; Remove-Item x; ''");
    expect(spoken.after).toBe("; $s.Dispose()");
  });

  it("the ASCII quote, $(), backtick and double quote stay text", () => {
    const script = sapi.sapiScript('it\'s $(calc) `x` "q" $5');
    const spoken = argumentOf(script, "$s.Speak");
    expect(spoken.value).toBe('it\'s $(calc) `x` "q" $5');
    expect(spoken.after).toBe("; $s.Dispose()");
  });

  it("control characters and line separators are removed", () => {
    const script = sapi.sapiScript(
      "one\u0000two\u0007\u001b[31m\r\nthree\u2028four\u0085five\u007f",
    );
    expect(script).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    const spoken = argumentOf(script, "$s.Speak");
    expect(spoken.value).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(spoken.value).toContain("three");
    expect(spoken.value).toContain("five");
  });

  it("the 400-character cut never splits a surrogate pair", () => {
    const text = `${"a".repeat(399)}\u{1F600}\u{1F600}`;
    const spoken = argumentOf(sapi.sapiScript(text), "$s.Speak").value;
    expect(spoken).not.toMatch(lone);
    expect(Array.from(spoken).length).toBeLessThanOrEqual(400);
    expect(spoken.startsWith("a".repeat(399))).toBe(true);
    const broken = argumentOf(sapi.sapiScript("hi \uD83D there \uDE00"), "$s.Speak").value;
    expect(broken).not.toMatch(lone);
  });

  it("Hindi and English text survive unchanged", () => {
    const spoken = argumentOf(sapi.sapiScript("नमस्ते, it's ready"), "$s.Speak").value;
    expect(spoken).toBe("नमस्ते, it's ready");
  });

  it("a wave path with a curly quote stays one literal", () => {
    const script = sapi.sapiScript("hello", { wav: "C:\\Users\\O\u2019Neil\\clip.wav" });
    const wav = argumentOf(script, "$s.SetOutputToWaveFile");
    expect(wav.value).toBe("C:\\Users\\O'Neil\\clip.wav");
    expect(wav.after.startsWith("; $s.Speak(")).toBe(true);
  });

  it("the command is one -Command argument", () => {
    const command = sapi.sapiCommand("Don\u2019t; Remove-Item x");
    expect(command.slice(0, 4)).toEqual([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(command).toHaveLength(5);
    expect(argumentOf(command[4] ?? "", "$s.Speak").after).toBe("; $s.Dispose()");
  });
});
