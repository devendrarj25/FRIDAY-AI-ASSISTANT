import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const hardware = require_("../../electron/hardware.cjs") as {
  detectSecurity: () => Promise<{
    supported: boolean;
    detectedAt: number;
    items: { id: string; label: string; state: string; detail: string | null }[];
  }>;
  openWindowsSecurity: () => boolean;
};

describe("windows security posture", () => {
  it("reports every panel row with a real state, never a decorative one", async () => {
    const result = await hardware.detectSecurity();
    expect(result.detectedAt).toBeGreaterThan(0);
    expect(result.items.map((i) => i.id)).toEqual([
      "defender",
      "firewall",
      "smartscreen",
      "bitlocker",
      "hello",
    ]);
    for (const item of result.items) {
      expect(["on", "off", "partial", "unknown"]).toContain(item.state);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("marks everything unknown off Windows instead of claiming enabled", async () => {
    if (process.platform === "win32") return;
    const result = await hardware.detectSecurity();
    expect(result.supported).toBe(false);
    expect(result.items.every((i) => i.state === "unknown")).toBe(true);
    expect(hardware.openWindowsSecurity()).toBe(false);
  });
});
