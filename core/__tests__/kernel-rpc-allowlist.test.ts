/**
 * FRIDAY · the renderer may only reach an allowlisted kernel method.
 *
 * `kernel:rpc` forwarded any method string straight to the privileged Python
 * dispatch. These tests keep the allowlist honest and, just as importantly,
 * keep it in sync with the typed client and with the kernel's own dispatch —
 * so a method added on one side can never quietly become unreachable, or
 * reachable without review, on another.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { KERNEL_METHODS, isAllowedKernelMethod, CALLER_FORBIDDEN_FIELDS } = require(
  path.join(process.cwd(), "electron/kernel-methods.cjs"),
) as {
  KERNEL_METHODS: string[];
  isAllowedKernelMethod: (method: string) => boolean;
  CALLER_FORBIDDEN_FIELDS: string[];
};

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("kernel:rpc allowlist", () => {
  it("allows a known method and refuses anything else", () => {
    expect(isAllowedKernelMethod("chat.history")).toBe(true);
    expect(isAllowedKernelMethod("tool.exec")).toBe(true);
    expect(isAllowedKernelMethod("os.exec")).toBe(false);
    expect(isAllowedKernelMethod("")).toBe(false);
    expect(isAllowedKernelMethod("../../etc")).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(KERNEL_METHODS).size).toBe(KERNEL_METHODS.length);
  });

  it("matches the typed client's KERNEL_METHODS list", () => {
    const client = read("src/lib/friday/kernel-api.ts");
    const block = client.slice(client.indexOf("KERNEL_METHODS"));
    const declared = [...block.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map(
      (m: RegExpMatchArray) => m[1],
    );
    const missing = KERNEL_METHODS.filter((m) => !declared.includes(m));
    expect(missing).toEqual([]);
  });

  it("only lists methods the kernel actually dispatches", () => {
    const kernel = read("kernel/main.py");
    const unknown = KERNEL_METHODS.filter((m) => !kernel.includes(`"${m}"`));
    expect(unknown).toEqual([]);
  });

  it("strips caller-supplied approval on every method, not just tool.exec", () => {
    const main = read("electron/main.cjs");
    const handler = main.slice(main.indexOf('ipcMain.handle("kernel:rpc"'));
    const body = handler.slice(0, handler.indexOf("\n});"));
    expect(body).toContain("isAllowedKernelMethod");
    // The strip runs BEFORE the tool.exec branch, so it covers all methods.
    expect(body.indexOf("CALLER_FORBIDDEN_FIELDS")).toBeLessThan(
      body.indexOf('name === "tool.exec"'),
    );
    expect(CALLER_FORBIDDEN_FIELDS).toEqual(
      expect.arrayContaining(["approved", "authorization", "privacyConfirmed"]),
    );
  });

  it("turns an empty chat stream result into a real RPC failure", () => {
    const main = read("electron/main.cjs");
    const request = main.slice(
      main.indexOf("async function kernelRequest"),
      main.indexOf("let billingGate"),
    );
    expect(request).toContain('method === "chat.stream"');
    expect(request).toContain("message.data?.done === false");
  });

  it("does not let the renderer stamp privacyConfirmed or call privacy.decide", () => {
    expect(isAllowedKernelMethod("privacy.decide")).toBe(false);
    expect(KERNEL_METHODS).not.toContain("privacy.decide");
    const main = read("electron/main.cjs");
    expect(main).toContain("confirmKernelChat");
    expect(main).toContain("payload.privacyConfirmed");
    expect(main).toContain('handle("skills:invoke"');
    expect(main).toContain("persistToolDecision");
    expect(main).toContain('String(row?.role || "") !== "system"');
  });
});
