/**
 * On Windows `child.kill()` ends one process only, so a shell, npx, a Python launcher or an installer left what it
 * started running (a timed-out terminal command, a stopped MCP server, a cancelled fine-tune or model download, a pip
 * run). `stopChild` ends the whole tree there and signals the child elsewhere, and every site that used a bare kill uses it.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const { stopChild } = require_("../../electron/app-lifecycle.cjs") as {
  stopChild: (
    child: unknown,
    signal?: string,
    options?: { platform?: string; spawn?: (...a: unknown[]) => unknown },
  ) => boolean;
};

describe("stopChild", () => {
  it("ends the whole tree with taskkill /T /F on Windows", () => {
    const calls: unknown[][] = [];
    const spawn = (...a: unknown[]) => (calls.push(a), { unref() {} });
    const child = { pid: 4242, kill: () => expect.fail("kill() must not be used on Windows") };
    expect(stopChild(child, "SIGTERM", { platform: "win32", spawn })).toBe(true);
    expect(calls[0]?.slice(0, 2)).toEqual(["taskkill", ["/pid", "4242", "/T", "/F"]]);
  });

  it("signals the child elsewhere, and never throws", () => {
    const sent: unknown[] = [];
    expect(
      stopChild({ pid: 1, kill: (s: string) => (sent.push(s), true) }, "SIGTERM", {
        platform: "linux",
      }),
    ).toBe(true);
    expect(sent).toEqual(["SIGTERM"]);
    expect(
      stopChild(
        {
          pid: 1,
          kill: () => {
            throw new Error("gone");
          },
        },
        "SIGKILL",
        { platform: "linux" },
      ),
    ).toBe(false);
    expect(stopChild(null)).toBe(false);
  });

  it("falls back to kill() for a child with no pid (a test double or a failed spawn)", () => {
    const sent: unknown[] = [];
    stopChild({ kill: (s?: string) => (sent.push(s ?? "default"), true) }, undefined, {
      platform: "win32",
    });
    expect(sent).toEqual(["default"]);
  });
});

describe("the places that start a program on the owner's behalf", () => {
  it.each([
    "terminal.cjs",
    "mcp-client.cjs",
    "modules.cjs",
    "finetune.cjs",
    "hf-hub-download.cjs",
    "kernel-deps.cjs",
    "whisper-cpp.cjs",
  ])("%s stops its child through stopChild, not a bare kill()", (file) => {
    const source = readFileSync(path.join(root, "electron", file), "utf8");
    expect(source).toContain("stopChild");
    const bare = source
      .split("\n")
      .filter((line) => /\bchild\.kill\(/.test(line) && !/^\s*(\*|\/\/)/.test(line));
    // terminal.cjs keeps its explicit POSIX SIGTERM then SIGKILL pair inside cancelRun.
    expect(bare.filter((line) => !/SIGTERM|SIGKILL/.test(line))).toEqual([]);
  });
});
