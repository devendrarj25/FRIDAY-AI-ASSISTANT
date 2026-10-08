import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const { jobSucceeded } = require(path.join(root, "electron", "toolchain.cjs"));

describe("Windows installer result handling", () => {
  it("accepts a verified install when winget returns an already-installed code", () => {
    expect(jobSucceeded(0x8a15002b, "install", { installed: true })).toBe(true);
    expect(jobSucceeded(0x8a15002b, "update", { installed: true })).toBe(true);
  });

  it("requires the requested post-install state", () => {
    expect(jobSucceeded(0, "install", { installed: false })).toBe(false);
    expect(jobSucceeded(0, "uninstall", { installed: false })).toBe(true);
    expect(jobSucceeded(1, "repair", { installed: true })).toBe(false);
  });
});
describe("windows batch launchers", () => {
  const source = readFileSync(path.join(root, "electron", "toolchain.cjs"), "utf8");

  it("routes .cmd launchers through the command processor", () => {
    expect(source).toContain("function spawnCommand");
    expect(source).toContain("process.env.ComSpec");
    expect(source).toContain("child = spawnCommand(command[0], command[1])");
  });

  it("falls back to the vendor installer when the package manager fails", () => {
    expect(source).toContain("function directInstaller");
    expect(source).toContain("function downloadInstaller");
    expect(source).toContain("function installerCommand");
    expect(source).toContain("manualUrl: tool.url");
  });

  it("uses npm.cmd on Windows for global installs and uninstalls", () => {
    const npmLines = source.split("\n").filter((l) => l.includes('"npm", ['));
    for (const line of npmLines) expect(line).toContain("npm.cmd");
  });

  it("reports components without an unattended installer as Manual", () => {
    const voiceInstall = require(path.join(root, "electron", "voice-install.cjs"));
    const vendor = voiceInstall.installOutcome({
      vendorOnly: true,
      vendorStep: "enable the optional Windows feature, then reboot",
    });
    expect(vendor.phase).toBe("Manual");
    expect(vendor.error).toMatch(/optional Windows feature/);
    const missing = voiceInstall.installOutcome({ pythonFound: false, cause: "no-python" });
    expect(missing.phase).toBe("Failed");
    expect(missing.manual).toBe(false);
    expect(missing.error).toMatch(/Python/);
    expect(source).toContain("phase: outcome.phase");
    expect(source).toContain("vendor-manual");
  });
});
