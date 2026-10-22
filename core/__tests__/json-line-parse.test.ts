import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const { parseJsonLine } = require_("../../electron/json-line.cjs");

describe("helper output is read as the last JSON line, nested objects included", () => {
  it("reads a result that ends with a nested object", () => {
    const line = JSON.stringify({
      ok: true,
      skipped: true,
      av: { installed: true, version: "18.1.0" },
    });
    expect(parseJsonLine(`some log\n${line}\n`)).toEqual(JSON.parse(line));
    const status = JSON.stringify({ ok: true, ladder: { whisper: { ready: true } } });
    expect(parseJsonLine(status)?.ladder.whisper.ready).toBe(true);
  });

  it("skips a trailing log line and a partial line, and returns null when none parse", () => {
    const good = JSON.stringify({ ok: true, n: { a: 1 } });
    expect(parseJsonLine(`${good}\n{"broken": \nWARNING later\n`)).toEqual({
      ok: true,
      n: { a: 1 },
    });
    expect(parseJsonLine("no json here")).toBeNull();
    expect(parseJsonLine("")).toBeNull();
    expect(parseJsonLine(undefined)).toBeNull();
  });

  it("is the one parser: no helper cuts at the last brace any more", () => {
    for (const file of ["stt", "neural-voice", "wake-engine", "voice-verify"]) {
      const body = readFileSync(`electron/${file}.cjs`, "utf8");
      expect(body, file).not.toContain('lastIndexOf("{")');
      expect(body, file).toContain("json-line.cjs");
    }
  });
});
