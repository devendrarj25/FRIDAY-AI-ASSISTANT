/**
 * Where the FRIDAY folder sits: a plain local folder is fine; a folder a sync client watches, or one under Program
 * Files or Windows, is reported with the fix. Reporting only (it never blocks and never moves anything).
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const advice = require_("../../scripts/folder-advice.cjs") as {
  assess: (root: string) => { ok: boolean; note: string; fix: string };
};

describe("the FRIDAY folder location", () => {
  it.each([
    "C:\\FRIDAY",
    "D:\\Work\\friday-ai-assistant",
    "C:\\Users\\Devendra Singh\\code\\FRIDAY",
    "E:\\OneDriveBackup\\FRIDAY",
    "C:\\Users\\a\\Documents\\onedrive-notes-export",
  ])("accepts a plain local folder: %s", (folder) => {
    expect(advice.assess(folder).ok).toBe(true);
  });

  it.each([
    ["C:\\Users\\a\\OneDrive\\Desktop\\FRIDAY", "OneDrive"],
    ["C:\\Users\\a\\OneDrive - Contoso\\Projects\\FRIDAY", "OneDrive"],
    ["C:\\Users\\a\\Dropbox\\FRIDAY", "Dropbox"],
    ["C:\\Users\\a\\Dropbox (Personal)\\FRIDAY", "Dropbox"],
    ["G:\\My Drive\\FRIDAY", "Google Drive"],
    ["C:\\Users\\a\\iCloudDrive\\FRIDAY", "iCloud Drive"],
  ])("reports a synced folder: %s", (folder, name) => {
    const result = advice.assess(folder);
    expect(result.ok).toBe(false);
    expect(result.note).toContain(name);
    expect(result.fix).toContain("C:\\FRIDAY");
  });

  it.each([
    "C:\\Program Files\\FRIDAY",
    "C:\\Program Files (x86)\\FRIDAY",
    "C:\\Windows\\Temp\\FRIDAY",
  ])("reports a folder that needs administrator rights: %s", (folder) => {
    const result = advice.assess(folder);
    expect(result.ok).toBe(false);
    expect(result.note).toMatch(/administrator rights/);
  });

  it("is a recommended row in the environment check and never blocks", () => {
    const source = readFileSync(path.join(root, "scripts/check-environment.cjs"), "utf8");
    const at = source.indexOf('name: "FRIDAY folder location"');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, source.indexOf("});", at))).toContain("required: false");
  });
});
