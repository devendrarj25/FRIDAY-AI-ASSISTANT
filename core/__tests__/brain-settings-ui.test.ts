/**
 * Brain settings section: the FRIDAY Core switch is wired to the stored preference (default off), the panel is
 * mounted from General settings, and the Install button opens the existing Install Manager route.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const brain = read("src/components/friday/settings/BrainSettings.tsx");
const general = read("src/components/friday/settings/GeneralSettings.tsx");

describe("Brain settings", () => {
  it("switch is stored as brainCoreEnabled and defaults off", () => {
    expect(DEFAULT_PREFERENCES.toggles["brainCoreEnabled"]).toBe(false);
    expect(brain).toContain('prefs.toggles["brainCoreEnabled"] === true');
    expect(brain).toContain('preferences.setToggle("brainCoreEnabled", !on)');
  });

  it("is mounted from General settings", () => {
    expect(general).toContain(
      'import { BrainSettings } from "@/components/friday/settings/BrainSettings"',
    );
    expect(general).toContain("<BrainSettings />");
  });

  it("Install opens the Install Manager route that exists", () => {
    expect(brain).toContain('navigate({ to: "/install-manager" })');
    expect(fs.existsSync(path.join(root, "src/routes/install-manager.tsx"))).toBe(true);
  });

  it("says plainly when status or the desktop app is missing, with no invented status", () => {
    expect(brain).toContain("show after the next update");
    expect(brain).toContain("Offline:");
  });
});
