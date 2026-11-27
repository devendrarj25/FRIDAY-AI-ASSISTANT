/**
 * The kernel reads `brain.learn.glossary` itself, so the Learn panel writes the switch there too (`settings.set`),
 * and writes it again when the kernel holds another value (after a restart or an offline toggle).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const set = vi.fn();
const get = vi.fn();
vi.mock("../../src/lib/friday/kernel-api", () => ({
  kernelApi: { settings: { set: (...a: unknown[]) => set(...a), get: () => get() } },
}));

import {
  GLOSSARY_SETTING_KEY,
  mirrorGlossarySetting,
  reconcileGlossarySetting,
} from "../../src/lib/friday/learn-from-me";

beforeEach(() => {
  set.mockReset();
  get.mockReset();
});

describe("glossary switch reaches the kernel", () => {
  it("writes brain.learn.glossary with a boolean", async () => {
    set.mockResolvedValue({ ok: true });
    expect(await mirrorGlossarySetting(false)).toBe(true);
    expect(set).toHaveBeenCalledWith("brain.learn.glossary", false);
    expect(GLOSSARY_SETTING_KEY).toBe("brain.learn.glossary");
    await mirrorGlossarySetting(true);
    expect(set).toHaveBeenLastCalledWith("brain.learn.glossary", true);
  });

  it("reports an offline kernel instead of pretending", async () => {
    set.mockResolvedValue(null);
    expect(await mirrorGlossarySetting(true)).toBe(false);
    set.mockRejectedValue(new Error("down"));
    expect(await mirrorGlossarySetting(true)).toBe(false);
  });

  it("an unset kernel value means on: nothing is written for an untouched on", async () => {
    get.mockResolvedValue({ settings: {} });
    expect(await reconcileGlossarySetting(true)).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it("writes again when the kernel holds another choice", async () => {
    set.mockResolvedValue({ ok: true });
    get.mockResolvedValue({ settings: { "brain.learn.glossary": true } });
    await reconcileGlossarySetting(false);
    expect(set).toHaveBeenCalledWith("brain.learn.glossary", false);
    get.mockResolvedValue({ settings: { "brain.learn.glossary": false } });
    set.mockClear();
    await reconcileGlossarySetting(true);
    expect(set).toHaveBeenCalledWith("brain.learn.glossary", true);
  });

  it("the toggle in the panel goes through that mirror", () => {
    const learn = fs.readFileSync(
      path.resolve(__dirname, "../../src/components/friday/settings/LearnSettings.tsx"),
      "utf8",
    );
    expect(learn).toContain("mirrorGlossarySetting(next)");
    expect(learn).toContain('preferences.setToggle("brainLearnGlossary", next)');
  });
});
