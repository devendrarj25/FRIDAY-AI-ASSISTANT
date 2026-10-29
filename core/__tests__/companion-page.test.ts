/**
 * Phone companion page contracts (pairing overlay CSS + PWA icons).
 *
 * The companion is the kernel-served HTML page, not the React desktop app.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const companion = fs.readFileSync(path.join(root, "kernel/companion.py"), "utf8");

describe("companion page pairing overlay", () => {
  it("hides #pair when the hidden attribute is set, despite display:flex", () => {
    const flex = companion.indexOf("#pair{padding:24px;display:flex");
    const hide = companion.indexOf("#pair[hidden],#composer[hidden]{display:none}");
    expect(flex).toBeGreaterThan(0);
    expect(hide).toBeGreaterThan(flex);
    expect(companion).toContain("el('pair').hidden=true;el('composer').hidden=false");
  });

  it("starts unpaired with #pair present and #composer hidden", () => {
    expect(companion).toContain('<div id="pair" hidden>');
    expect(companion).toContain('<footer id="composer" hidden>');
    expect(companion).toContain("if(!token){el('pair').hidden=false;el('composer').hidden=true");
  });

  it("ships FRIDAY logo links and a non-empty PWA icon list", () => {
    expect(companion).toContain('rel="icon" href="/companion/icon-192.png"');
    expect(companion).toContain('rel="apple-touch-icon" href="/companion/icon-192.png"');
    expect(companion).toContain('src="/companion/icon-192.png"');
    expect(companion).toContain('"/companion/icon-192.png"');
    expect(companion).toContain('"/companion/icon-512.png"');
    expect(companion).not.toMatch(/"icons": \[\]/);
  });

  it("reconnects with the kernel backoff and never gives up", () => {
    expect(companion).toContain("const DELAYS=[0,2000,8000]");
    expect(companion).toContain("function scheduleReconnect()");
    expect(companion).not.toContain("setTimeout(connect,4000)");
  });

  it("uses the full viewport instead of a 430px letterbox", () => {
    expect(companion).not.toMatch(/body\{[^}]*max-width:430px/);
    expect(companion).toContain("width:100%;max-width:100%");
    expect(companion).toContain("env(safe-area-inset-top)");
    expect(companion).toContain("env(safe-area-inset-bottom)");
    expect(companion).toContain("env(safe-area-inset-left)");
    expect(companion).toContain("min-height:44px");
    expect(companion).toContain("@media (min-width:600px)");
    expect(companion).toContain("@media (min-width:900px)");
    expect(companion).toContain("@media (orientation:landscape)");
    expect(companion).toContain("visualViewport");
  });
});
