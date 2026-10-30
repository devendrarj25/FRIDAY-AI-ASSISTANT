/**
 * The format registry is honest: every tool it names exists, a gap says so in plain words, and the
 * brain answers "can you read or make X" from it without a model.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  FORMAT_ROWS,
  answerFormatQuestion,
  asksAboutFormats,
  describeFormats,
  findFormats,
  formatGaps,
} from "../../src/lib/friday/brain/format-atlas";
import { publishAtlas, resetSelfAtlasForTests } from "../../src/lib/friday/self-atlas";

const ROOT = path.resolve(__dirname, "../..");
const kernelTools = () => {
  const source = fs.readFileSync(path.join(ROOT, "kernel/tools.py"), "utf8");
  const block = source.slice(source.indexOf("RISK = {"), source.indexOf("SUMMARY = {"));
  return new Set([...block.matchAll(/"([a-z_]+\.[a-z_]+|git)"\s*:/g)].map((m) => m[1] ?? ""));
};

describe("the registry", () => {
  it("names only kernel tools that exist, and a built ability always names its tool", () => {
    const known = kernelTools();
    expect(known.has("fs.make")).toBe(true);
    for (const row of FORMAT_ROWS) {
      for (const side of ["read", "make", "run"] as const) {
        const ability = row[side];
        if (!ability) continue;
        if (ability.status === "built") expect(ability.tool, `${row.id}.${side}`).not.toBe("");
        for (const tool of ability.tool.match(/\b[a-z]+\.[a-z_]+\b/g) ?? []) {
          if (/^(?:code|fs|archive|media|python|node|cpp|java|test|screen)\./.test(tool)) {
            expect(known.has(tool), `${row.id}.${side}: ${tool}`).toBe(true);
          }
        }
        expect(ability.note.length, `${row.id}.${side} note`).toBeGreaterThan(10);
      }
    }
  });

  it("has unique ids, and every extension belongs to one row except the shared csv", () => {
    expect(new Set(FORMAT_ROWS.map((row) => row.id)).size).toBe(FORMAT_ROWS.length);
    const seen = new Map<string, string>();
    for (const row of FORMAT_ROWS) {
      for (const ext of row.match) {
        const other = seen.get(ext);
        if (other && ext !== "csv") throw new Error(`.${ext} is in ${other} and ${row.id}`);
        seen.set(ext, row.id);
      }
    }
  });

  it("lists the gaps instead of hiding them", () => {
    const gaps = formatGaps();
    expect(gaps.some((gap) => gap.id === "pdf" && gap.side === "make")).toBe(true);
    expect(gaps.some((gap) => gap.id === "data-stores" && gap.side === "make")).toBe(true);
    expect(gaps.some((gap) => gap.id === "text-code")).toBe(false);
  });
});

describe("finding the kind a message is about", () => {
  it("reads extensions, plain names and long extension words", () => {
    expect(findFormats("make a report.docx").map((r) => r.id)).toContain("word");
    expect(findFormats("a powerpoint for tomorrow").map((r) => r.id)).toContain("slides");
    expect(findFormats("convert this mp4").map((r) => r.id)).toContain("video");
    expect(findFormats("write a php script").map((r) => r.id)).toContain("text-code");
    expect(findFormats("a song for me").map((r) => r.id)).toContain("audio");
    expect(findFormats("what time is it")).toEqual([]);
    // A short common word is not an extension.
    expect(findFormats("go to the shop")).toEqual([]);
  });

  it("tells a question about ability from a request to do the work", () => {
    expect(asksAboutFormats("can you read a pdf?")).toEqual({ read: true, make: false });
    expect(asksAboutFormats("can you make an excel sheet")).toEqual({ read: false, make: true });
    expect(asksAboutFormats("can you handle zip files")).toEqual({ read: true, make: true });
    expect(asksAboutFormats("make an excel sheet of my sales")).toBeNull();
    expect(asksAboutFormats("can you tell the time")).toBeNull();
    // A pasted error or a long text is data, not a question about ability.
    expect(
      asksAboutFormats(
        'kya ye error theek hoga?\nTraceback (most recent call last):\n  File "a.py", line 1, in <module>\nValueError: python',
      ),
    ).toBeNull();
  });
});

describe("the answers", () => {
  it("say what is partial and what is missing, in plain words", () => {
    const pdf = answerFormatQuestion("can you make a pdf?") ?? "";
    expect(pdf).toContain("PDF");
    expect(pdf).toContain("partly");
    expect(pdf).toContain("Latin letters only");
    const video = answerFormatQuestion("can you make a video?") ?? "";
    expect(video).toContain("generating new video from a prompt is not built");
  });

  it("answer in Hinglish when the owner writes it", () => {
    const text = answerFormatQuestion("kya tum excel file bana sakti ho", true) ?? "";
    expect(text).toContain("Banana: kuch hisse tak");
  });

  it("use the installed tools the Self Atlas reports", () => {
    const rows = FORMAT_ROWS.filter((row) => row.id === "video");
    resetSelfAtlasForTests();
    const unknown = describeFormats(rows);
    expect(unknown).toContain("with an installed program");
    const fact = (status: "ok" | "bad") => ({
      readAt: 1,
      supported: true,
      summary: "",
      counts: { ok: 0, warn: 0, bad: 0, unknown: 0 },
      facts: [
        {
          group: "inventory",
          id: "tool-ffmpeg",
          label: "ffmpeg",
          value: status === "ok" ? "7.1 installed" : "missing",
          status,
          source: "inventory.json",
          readAt: 1,
          confidence: 0.9,
        },
      ],
    });
    publishAtlas(fact("bad") as never);
    expect(describeFormats(rows)).toContain("ffmpeg is not installed");
    publishAtlas(fact("ok") as never);
    expect(describeFormats(rows)).toContain("ffmpeg is installed");
    resetSelfAtlasForTests();
  });

  it("are given by the brain with no model", async () => {
    const reply = baselineRespond("can you read and make a powerpoint?");
    expect(reply.handled).toBe(true);
    const text = reply.text || (reply.resolve ? await reply.resolve() : "");
    expect(text).toContain("Presentations");
    expect(text).toContain("fs.make");
  });
});
