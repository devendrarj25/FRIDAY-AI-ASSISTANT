import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const models = require("../../electron/models.cjs") as {
  ollamaKeepAlive: (o?: { env?: Record<string, string>; tiers?: unknown }) => string | number;
  ollamaWarmBody: (
    m: string,
    k?: string | number,
    o?: { ramGb?: number; env?: Record<string, string>; tiers?: unknown },
  ) => { keep_alive: string | number };
};

const plan = (keep: unknown) => ({ ollamaSettings: { keep_alive: keep } });

describe("Ollama warm-up keep_alive follows the shared plan", () => {
  it("uses the plan value, env first, then 20m", () => {
    expect(models.ollamaKeepAlive({ env: {}, tiers: plan("45m") })).toBe("45m");
    expect(
      models.ollamaKeepAlive({ env: { FRIDAY_OLLAMA_KEEP_ALIVE: "10m" }, tiers: plan("45m") }),
    ).toBe("10m");
    expect(
      models.ollamaKeepAlive({ env: { FRIDAY_OLLAMA_KEEP_ALIVE: "0" }, tiers: plan("45m") }),
    ).toBe(0);
    expect(models.ollamaKeepAlive({ env: {}, tiers: null })).toBe("20m");
    expect(models.ollamaKeepAlive({ env: {}, tiers: plan(true) })).toBe("20m");
  });

  it("the warm body defaults to the plan and an explicit value still wins", () => {
    const opts = { ramGb: 16, env: {}, tiers: plan("45m") };
    expect(models.ollamaWarmBody("m", undefined, opts).keep_alive).toBe("45m");
    expect(models.ollamaWarmBody("m", "5m", opts).keep_alive).toBe("5m");
  });
  it("junk values fall back instead of passing through", () => {
    for (const bad of ["abc", "--5", "5 m", "5x", "1.5", "٣", "5m;x"]) {
      expect(
        models.ollamaKeepAlive({ env: { FRIDAY_OLLAMA_KEEP_ALIVE: bad }, tiers: plan("45m") }),
      ).toBe("45m");
      expect(models.ollamaKeepAlive({ env: {}, tiers: plan(bad) })).toBe("20m");
    }
    expect(
      models.ollamaKeepAlive({ env: { FRIDAY_OLLAMA_KEEP_ALIVE: "500ms" }, tiers: null }),
    ).toBe("500ms");
    expect(models.ollamaKeepAlive({ env: { FRIDAY_OLLAMA_KEEP_ALIVE: "-1" }, tiers: null })).toBe(
      -1,
    );
  });

  it("the main-process warm call passes no hard-coded duration", () => {
    const src = readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
    expect(src).not.toMatch(/ollamaWarm\(tag, "5m"\)/);
    expect(src).toMatch(/modelsApi\.ollamaWarm\(tag\)/);
  });
});
