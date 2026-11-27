import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { runtimeRow } = require("../../electron/voice-verify.cjs");

const good = { id: "friday-runtime", label: "FRIDAY Runtime", ok: true, detail: "onnxruntime 1.2" };

describe("FRIDAY Runtime doctor row", () => {
  it("passes an ok row through and asks for --runtime-info", async () => {
    let args: string[] = [];
    let timeout = 0;
    const row = await runtimeRow("py", ["-3"], async (_e: string, a: string[], t: number) => {
      args = a;
      timeout = t;
      return { ok: true, stdout: JSON.stringify(good), stderr: "" };
    });
    expect(row).toMatchObject({ id: "friday-runtime", ok: true, detail: good.detail });
    expect(args[0]).toBe("-3");
    expect(args).toContain("--runtime-info");
    expect(timeout).toBe(120000);
  });

  it("shows a failing row as not ready with its detail", async () => {
    const row = await runtimeRow("py", [], async () => ({
      ok: true,
      stdout: JSON.stringify({ ...good, ok: false, detail: "onnxruntime is not installed" }),
      stderr: "",
    }));
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("not installed");
  });

  it("turns bad JSON into a visible not-ready row", async () => {
    const row = await runtimeRow("py", [], async () => ({
      ok: false,
      stdout: "garbage",
      stderr: "Traceback boom",
    }));
    expect(row).toMatchObject({ id: "friday-runtime", ok: false });
    expect(row.detail).toContain("boom");
  });

  it("turns a timeout and a throw into not-ready rows", async () => {
    const slow = await runtimeRow("py", [], async () => ({
      ok: false,
      stdout: "",
      stderr: "",
      timedOut: true,
    }));
    expect(slow.ok).toBe(false);
    expect(slow.detail).toContain("timed out");
    const thrown = await runtimeRow("py", [], async () => {
      throw new Error("spawn ENOENT");
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.detail).toContain("ENOENT");
  });
});
