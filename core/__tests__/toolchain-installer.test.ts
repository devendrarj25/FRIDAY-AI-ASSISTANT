import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const toolchain = require(path.join(root, "electron", "toolchain.cjs"));
const alt = require(path.join(root, "electron", "alt-package-managers.cjs"));
const { jobSucceeded } = toolchain;
const winget = (id: string): string => toolchain.toolById(id)?.winget;

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
    expect(source).toContain("loadWinSpawn");
    expect(source).toContain(".spawnChild(cmd, args || [], {");
    // No keyboard is attached to an installer: stdin is closed so a prompt cannot hang.
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(source).toContain("child = spawnCommand(command[0], command[1])");
    const spawn = readFileSync(path.join(root, "scripts", "win-spawn.cjs"), "utf8");
    expect(spawn).toContain("process.env.ComSpec");
    expect(spawn).toContain("windowsVerbatimArguments: true");
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

describe("fallback package ids install the same major as the data row", () => {
  it("winget ids follow the newest major the rows download", () => {
    expect(winget("Visual Studio")).toBe("Microsoft.VisualStudio.Community");
    expect(winget("VS Build Tools")).toBe("Microsoft.VisualStudio.BuildTools");
    expect(winget("Windows SDK")).toBe("Microsoft.WindowsSDK.10.0.28000");
    expect(winget("PHP")).toBe("PHP.PHP.8.6");
    expect(winget("Ruby")).toBe("RubyInstallerTeam.Ruby.4.0");
    expect(winget("OpenJDK (Temurin)")).toBe("EclipseAdoptium.Temurin.25.JDK");
  });

  it("Chocolatey and Scoop names keep the supported major", () => {
    expect(alt.ALT["Python"]).toEqual({ choco: "python312", scoop: "versions/python312" });
    expect(alt.ALT[".NET SDK"]).toEqual({ choco: "dotnet-10.0-sdk" });
    expect(alt.ALT["OpenJDK (Temurin)"]).toEqual({ choco: "temurin25", scoop: "temurin25-jdk" });
    expect(alt.ALT["Redis (Memurai)"]).toEqual({ choco: "memurai-developer" });
    expect(alt.managersFor(".NET SDK")).toEqual(["choco"]);
  });
});

describe("a data-file download carries its own mirrors", () => {
  it("the vendor installer takes alt.mirrors and never empties them", () => {
    const source = readFileSync(path.join(root, "electron", "toolchain.cjs"), "utf8");
    const start = source.indexOf("const tryVendorInstaller = async (alt = null)");
    const block = source.slice(start, start + 1200);
    expect(block).toContain("installerMirrors: alt.mirrors || [],");
    expect(block).not.toMatch(/installerMirrors:\s*\[\]/);
  });
});

describe("a newer feed release does not inherit the pinned file's mirrors", () => {
  it("keeps a pin mirror only when the feed names the same digest", () => {
    const source = readFileSync(path.join(root, "electron", "toolchain.cjs"), "utf8");
    const start = source.indexOf("function applyFeed(tool, feed)");
    const block = source.slice(start, start + 700);
    expect(block).toContain("tool.sha256 === feed.install.sha256");
    expect(block).toContain("samePin ? tool.installerMirrors || [] : []");
  });
});

describe("fresh pins of the bundled and on-demand archives", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "config", "toolchain-manifest.json"), "utf8"),
  );
  const pack = (id: string) => manifest.packs.find((p: { id: string }) => p.id === id);

  it("Node.js 22.23.5 has the published digest, its size and two mirrors", () => {
    const node = pack("node-win");
    expect(node.version).toBe("22.23.5");
    expect(node.sha256).toBe("4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3");
    expect(node.bytes).toBe(35630346);
    expect(node.mirrors).toEqual([
      "https://registry.npmmirror.com/-/binary/node/v22.23.5/node-v22.23.5-win-x64.zip",
      "https://mirrors.huaweicloud.com/nodejs/v22.23.5/node-v22.23.5-win-x64.zip",
    ]);
    expect(toolchain.toolById("FRIDAY Node").archiveBin).toBe("node-v22.23.5-win-x64/node.exe");
  });

  it("MinGit 2.56.1 has the hashed zip and a second source", () => {
    const git = pack("mingit");
    expect(git.version).toBe("2.56.1");
    expect(git.sha256).toBe("4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd");
    expect(git.bytes).toBe(39849768);
    expect(git.mirrors).toEqual([
      "https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.1.windows.1/MinGit-2.56.1-64-bit.zip",
    ]);
    expect(toolchain.toolById("MinGit").installerMirrors).toEqual(git.mirrors);
  });

  it("Gradle 9.9.3 keeps its three official hosts under one digest", () => {
    const gradle = toolchain.toolById("Gradle");
    expect(gradle.pinVersion).toBe("9.9.3");
    expect(gradle.sha256).toBe("4f2135b741f272acc88c168a52202a0a63fceee0cd61ee753da79694cd2b1e4b");
    expect(gradle.needBytes).toBe(134970743);
    expect(gradle.archiveBin).toBe("gradle-9.9.3/bin/gradle.bat");
    for (const url of [gradle.installerUrl, ...gradle.installerMirrors])
      expect(url).toContain("9.9.3");
  });
});
