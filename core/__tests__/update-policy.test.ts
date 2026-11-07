/**
 * Setup looks for a newer release of what it installs, at most once a day per topic, never on hosted CI
 * or offline, and a switch turns it off or forces it. No network: this is only the decision.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const policy = require_(path.resolve(__dirname, "../../scripts/update-policy.cjs"));

describe("update policy", () => {
  it("reads the switch: off, force, or daily", () => {
    expect(policy.mode({})).toBe("daily");
    expect(policy.mode({ FRIDAY_SETUP_UPDATE: "0" })).toBe("off");
    expect(policy.mode({ FRIDAY_SETUP_UPDATE: "off" })).toBe("off");
    expect(policy.mode({ FRIDAY_SETUP_UPDATE: "1" })).toBe("force");
    expect(policy.mode({ CI: "true" })).toBe("off");
    expect(policy.mode({ GITHUB_ACTIONS: "true", FRIDAY_SETUP_UPDATE: "1" })).toBe("off");
    expect(policy.mode({ FRIDAY_OFFLINE: "1" })).toBe("off");
  });

  it("asks once a day per topic and remembers when it asked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "friday-update-"));
    try {
      const t0 = Date.parse("2026-11-06T10:00:00Z");
      expect(policy.due("python", { root, env: {}, now: t0 })).toBe(true);
      policy.markChecked("python", { root, now: t0 });
      expect(policy.due("python", { root, env: {}, now: t0 + 60 * 60 * 1000 })).toBe(false);
      expect(policy.due("ollama", { root, env: {}, now: t0 + 60 * 60 * 1000 })).toBe(true);
      expect(policy.due("python", { root, env: {}, now: t0 + 25 * 60 * 60 * 1000 })).toBe(true);
      // A clock that went back is not trusted as "checked".
      expect(policy.due("python", { root, env: {}, now: t0 - 60 * 60 * 1000 })).toBe(true);
      // The switch wins over the stamp, both ways.
      expect(
        policy.due("python", { root, env: { FRIDAY_SETUP_UPDATE: "1" }, now: t0 + 1000 }),
      ).toBe(true);
      expect(
        policy.due("python", { root, env: { FRIDAY_SETUP_UPDATE: "0" }, now: t0 + 99 * 3600e3 }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
