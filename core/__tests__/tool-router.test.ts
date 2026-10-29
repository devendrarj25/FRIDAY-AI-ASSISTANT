import { describe, expect, it } from "vitest";
import {
  candidateTools,
  chooseTools,
  resetToolIndex,
  scoreTool,
} from "../../src/lib/friday/brain/tool-router";
import type { ToolPackManifest } from "../../src/lib/friday/brain/tool-forge";

const tool = (
  id: string,
  name: string,
  description: string,
  extra: Partial<ToolPackManifest> = {},
): ToolPackManifest => ({
  id,
  name,
  description,
  category: "text",
  permissions: [],
  risk: "safe",
  inputs: [],
  enabled: true,
  ...extra,
});

describe("tool router", () => {
  it("indexes by token and does not score the whole catalog on a miss", () => {
    resetToolIndex();
    const catalog = [
      tool("tools/text/base64-encode", "Base64 encode", "Encode UTF-8 text as base64"),
      tool("tools/filesystem/file-read", "Read a file", "Read a UTF-8 text file"),
      tool("tools/network/dns-lookup", "DNS lookup", "Resolve a hostname"),
    ];
    const hits = candidateTools("please encode this as base64", catalog);
    expect(hits.map((item) => item.id)).toContain("tools/text/base64-encode");
    expect(candidateTools("good morning friday", catalog)).toEqual([]);
  });

  it("runs named tools in sequence and skips disabled or write tools", () => {
    resetToolIndex();
    const catalog = [
      tool("tools/text/slugify-text", "Slugify text", "Lowercase hyphen slug"),
      tool("tools/text/line-sort", "Sort lines", "Sort lines of text"),
      tool("tools/filesystem/file-write", "Write a file", "Write a file", {
        risk: "write",
      }),
      tool("tools/text/unique-lines", "Unique lines", "Keep first occurrence", { enabled: false }),
    ];
    const chained = chooseTools("Slugify text then Sort lines", catalog);
    expect(chained.map((item) => item.name)).toEqual(["Slugify text", "Sort lines"]);
    expect(scoreTool("write a file please", catalog[2]!)).toBeGreaterThan(0);
    expect(chooseTools("Write a file", catalog)).toEqual([]);
  });

  it("picks a distinctive id token without scoring the whole catalog", () => {
    resetToolIndex();
    const catalog = [
      tool("tools/text/base64-encode", "Base64 encode", "Encode UTF-8 text as base64", {
        keywords: ["base64", "encode"],
      }),
      tool("tools/filesystem/file-read", "Read a file", "Read a UTF-8 text file"),
    ];
    expect(scoreTool("please encode this as base64", catalog[0]!)).toBeGreaterThanOrEqual(0.8);
    expect(chooseTools("please encode this as base64", catalog).map((item) => item.id)).toEqual([
      "tools/text/base64-encode",
    ]);
  });

  it("skips named tools that cannot run (no index.cjs) or failed health", () => {
    resetToolIndex();
    const catalog = [
      tool(
        "tools/devices/bluetooth/bluetooth-scan",
        "Bluetooth scan",
        "Scan for Bluetooth devices",
        {
          runnable: false,
        },
      ),
      tool("tools/system/sensors-read", "Read sensors", "Read hardware sensors", {
        healthy: false,
      }),
      tool("tools/text/base64-encode", "Base64 encode", "Encode UTF-8 text as base64"),
    ];
    expect(chooseTools("Bluetooth scan", catalog)).toEqual([]);
    expect(chooseTools("Read sensors", catalog)).toEqual([]);
    expect(chooseTools("Base64 encode", catalog).map((item) => item.id)).toEqual([
      "tools/text/base64-encode",
    ]);
  });
});
