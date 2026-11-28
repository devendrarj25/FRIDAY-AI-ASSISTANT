/**
 * Setup notices (scripts/setup-notices.cjs): a failed download is recorded as a notice and never stops a step.
 * Pure: a temp folder, an injected clock, no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const notices = require_(path.join(root, "scripts/setup-notices.cjs"));

const made: string[] = [];
function tempRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "friday-notices-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) rmSync(made.pop() as string, { recursive: true, force: true });
});

describe("setup notices", () => {
  it("is not strict unless the owner asks, with any of the three flags", () => {
    expect(notices.isStrict({})).toBe(false);
    expect(notices.isStrict({ FRIDAY_PREFETCH_STRICT: "0" })).toBe(false);
    expect(notices.isStrict({ FRIDAY_SETUP_STRICT: "1" })).toBe(true);
    expect(notices.isStrict({ FRIDAY_PREFETCH_STRICT: "1" })).toBe(true);
    expect(notices.isStrict({ FRIDAY_PREFETCH_TOOLKIT_STRICT: "1" })).toBe(true);
  });

  it("records a notice, prints one line that says it is not a stop, and replaces by id", () => {
    const dir = tempRoot();
    const lines: string[] = [];
    const line = notices.recordNotice(
      {
        id: "model:hinglish-ear",
        kind: "model",
        label: "Hinglish ear",
        reason: "download failed",
        installManagerId: "hinglish-ear",
      },
      { root: dir, now: "2026-01-01T00:00:00.000Z", log: (l: string) => lines.push(l) },
    );
    expect(line).toContain("NOTICE Hinglish ear: download failed");
    expect(line).toContain("Not a stop");
    expect(line).toContain("Install Manager / Models");
    expect(lines).toEqual([line]);
    notices.recordNotice(
      { id: "model:hinglish-ear", kind: "model", reason: "still failing" },
      { root: dir, now: "2026-01-02T00:00:00.000Z", print: false },
    );
    const list = notices.readNotices(dir);
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe("still failing");
    const file = JSON.parse(readFileSync(path.join(dir, "runtime", "setup-notices.json"), "utf8"));
    expect(file.schema).toBe(1);
  });

  it("clears a notice once the item is installed and reads an absent or broken file as empty", () => {
    const dir = tempRoot();
    expect(notices.readNotices(dir)).toEqual([]);
    notices.recordNotice(
      { id: "tool:ffmpeg", kind: "tool", reason: "x" },
      { root: dir, print: false },
    );
    expect(notices.clearNotice("tool:ffmpeg", { root: dir })).toBe(true);
    expect(notices.clearNotice("tool:ffmpeg", { root: dir })).toBe(false);
    expect(notices.readNotices(dir)).toEqual([]);
  });

  it("never throws on bad input and keeps one line per entry", () => {
    const dir = tempRoot();
    expect(notices.recordNotice(null, { root: dir })).toBe("");
    expect(notices.recordNotice({ reason: "no id" }, { root: dir })).toBe("");
    const line = notices.recordNotice(
      { id: "a", reason: "two\nlines\r\nhere", kind: "nonsense" },
      { root: dir, print: false },
    );
    expect(line.split("\n")).toHaveLength(1);
    expect(notices.readNotices(dir)[0].kind).toBe("other");
  });

  it("strips every control character, so a hostile reason cannot repaint the console", () => {
    const dir = tempRoot();
    const hostile = "a\x1b[2Jb\x07c\x7fd\x85e f g\ttab\x00z";
    const hasControl = (text: string) =>
      [...text].some((ch) => {
        const code = ch.codePointAt(0) as number;
        return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
      });
    const line = notices.recordNotice(
      { id: "id\x1b[31mxxx", label: hostile, reason: hostile, repair: hostile },
      { root: dir, print: false },
    );
    expect(hasControl(line)).toBe(false);
    expect(line).toContain("[2J");
    for (const entry of notices.readNotices(dir)) {
      for (const value of Object.values(entry as Record<string, string>)) {
        expect(hasControl(value)).toBe(false);
      }
    }
  });

  it("summarises open notices and says nothing when there are none", () => {
    expect(notices.summaryLines([])).toEqual([]);
    const lines = notices.summaryLines([
      { id: "a", label: "A", reason: "r", installManagerId: "a-row" },
    ]);
    expect(lines[0]).toContain("does not stop the build");
    expect(lines[1]).toContain("A: r (a-row)");
  });
});
