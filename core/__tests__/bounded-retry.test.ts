import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KERNEL_STYLE_DELAYS_MS,
  KERNEL_STYLE_MAX_ATTEMPTS,
  nextRetryDelayMs,
  persistentRetryDelayMs,
} from "../../src/lib/friday/bounded-retry";

const require_ = createRequire(import.meta.url);
const kernel = require_("../../electron/kernel-auto-restart.cjs") as {
  DELAYS_MS: readonly number[];
  MAX_ATTEMPTS: number;
};

describe("kernel-style bounded retry", () => {
  it("matches the kernel auto-restart delays and cap", () => {
    expect(KERNEL_STYLE_DELAYS_MS).toEqual([...kernel.DELAYS_MS]);
    expect(KERNEL_STYLE_MAX_ATTEMPTS).toBe(kernel.MAX_ATTEMPTS);
    expect(nextRetryDelayMs(0)).toBe(0);
    expect(nextRetryDelayMs(1)).toBe(2000);
    expect(nextRetryDelayMs(2)).toBe(8000);
    expect(nextRetryDelayMs(3)).toBeNull();
  });

  it("keeps trying after the cap by repeating the last delay", () => {
    expect(persistentRetryDelayMs(3)).toBe(8000);
    expect(persistentRetryDelayMs(9)).toBe(8000);
  });

  it("model-router already classifies a rejected key as not retryable", () => {
    const source = readFileSync(join(__dirname, "../../electron/model-router.cjs"), "utf8");
    expect(source).toContain('category: "invalid_key", retryable: false');
    expect(source).toContain('category: "billing_required", retryable: false');
  });

  it("desktop session websocket reconnects with backoff instead of stopping", () => {
    const source = readFileSync(join(__dirname, "../../electron/main.cjs"), "utf8");
    expect(source).toContain("function scheduleSessionReconnect()");
    expect(source).toContain("sessionBackoff = Math.min(sessionBackoff * 2, 30_000)");
  });
});
