/**
 * Test-before-enable proof.
 *
 * Real packs are written into a real temp workspace and really run through
 * electron/sandbox.cjs — nothing here is mocked. The contract under test:
 *
 *   - a broken pack fails its smoke test and stays installed-but-disabled,
 *     with the real error attached to its manifest,
 *   - a healthy pack passes and is enabled,
 *   - a missing dependency named by the failed run is matched against the real
 *     Install Manager catalog (toolchain.cjs) so it can be auto-installed,
 *   - a dependency that is NOT in the catalog produces a step-by-step manual
 *     guide with a retry, never a silent failure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const verify = require_("../../electron/capability-verify.cjs");
const capabilities = require_("../../electron/capabilities.cjs");

let root = "";

const writePack = (tree: string, segment: string, slug: string, files: Record<string, string>) => {
  const dir = path.join(root, tree, segment, slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  return dir;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-verify-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("dependency resolution against the real Install Manager catalog", () => {
  it("names the missing dependency from a real runtime failure", () => {
    expect(verify.missingFromOutput("ModuleNotFoundError: No module named 'numpy'")).toBe("numpy");
    expect(verify.missingFromOutput("Error: Cannot find module 'left-pad'")).toBe("left-pad");
    expect(verify.missingFromOutput("spawn ffmpeg ENOENT")).toBe("ffmpeg");
    // The pack's own broken relative import is not a dependency.
    expect(verify.missingFromOutput("Cannot find module './helper.js'")).toBeNull();
    expect(verify.missingFromOutput("capability loaded")).toBeNull();
  });

  it("matches a catalog dependency so it can be installed automatically", () => {
    const tool = verify.resolveDependency("ffmpeg");
    expect(tool).toBeTruthy();
    expect(verify.isAutomatable(tool)).toBe(true);
  });

  it("gives a real step-by-step guide when a dependency is not automatable", () => {
    const guide = verify.manualGuide("some-licensed-sdk", null);
    expect(guide.kind).toBe("step_card");
    expect(guide.retryable).toBe(true);
    expect(guide.catalogId).toBeNull();
    expect(guide.steps.length).toBeGreaterThan(2);
    expect(guide.steps.join(" ")).toMatch(/Retry/i);
  });

  it("refuses to invent an automatic install for an unknown dependency", async () => {
    const result = await verify.installDependency(root, "some-licensed-sdk", () => {});
    expect(result.ok).toBe(false);
    expect(result.guide.dependency).toBe("some-licensed-sdk");
  });
});

describe("test-before-enable", () => {
  it("keeps a broken capability installed but disabled, with the real error", async () => {
    const dir = writePack("tools", "custom", "broken-tool", {
      "manifest.json": JSON.stringify({ id: "broken-tool", name: "Broken", entry: "index.cjs" }),
      "index.cjs": 'throw new Error("this tool is broken on purpose");\n',
    });
    const result = await verify.verifyCapability(
      { root },
      { id: "tools/custom/broken-tool", tree: "tools", dir },
      { allowInstall: false },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/broken on purpose/);

    capabilities.markVerified({ workspaceRoot: root }, "tools/custom/broken-tool", result);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.verification.error).toMatch(/broken on purpose/);
  }, 60000);

  it("enables a capability only after it really ran its self-test", async () => {
    const dir = writePack("tools", "custom", "good-tool", {
      "manifest.json": JSON.stringify({
        id: "good-tool",
        name: "Good",
        entry: "index.cjs",
        selfTest: { input: { v: 2 } },
      }),
      "index.cjs": "module.exports = { run: (input) => ({ doubled: input.v * 2 }) };\n",
    });
    const result = await verify.verifyCapability(
      { root },
      { id: "tools/custom/good-tool", tree: "tools", dir },
      { allowInstall: false },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("verified");

    capabilities.markVerified({ workspaceRoot: root }, "tools/custom/good-tool", result);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.enabled).toBe(true);
    expect(manifest.verification.status).toBe("verified");
  }, 60000);

  it("stops at a clear manual guide when a declared dependency is unknown", async () => {
    const dir = writePack("tools", "custom", "needs-sdk", {
      "manifest.json": JSON.stringify({
        id: "needs-sdk",
        name: "Needs SDK",
        entry: "index.cjs",
        requiresTools: ["some-licensed-sdk"],
      }),
      "index.cjs": "module.exports = { run: () => true };\n",
    });
    const result = await verify.verifyCapability(
      { root },
      { id: "tools/custom/needs-sdk", tree: "tools", dir },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe("needs-manual-step");
    expect(result.guide.steps.join(" ")).toMatch(/some-licensed-sdk/);
  }, 60000);

  it("detects the missing catalog dependency named by a failed run", async () => {
    const dir = writePack("tools", "custom", "needs-module", {
      "manifest.json": JSON.stringify({ id: "needs-module", name: "Needs", entry: "index.cjs" }),
      "index.cjs": 'require("definitely-not-installed-pkg");\n',
    });
    const test = await verify.smokeTest({ root, dir, tree: "tools" });
    expect(test.ok).toBe(false);
    expect(verify.missingFromOutput(test.output)).toBe("definitely-not-installed-pkg");
  }, 60000);
});

describe("sandbox command argv", () => {
  const sandbox = require_("../../electron/sandbox.cjs") as {
    commandNeedsWindowsShell: (command: string) => boolean;
    runCommand: (
      command: string,
      args: string[],
      cwd: string,
      timeoutMs: number,
    ) => Promise<{ ok: boolean; output?: string }>;
  };

  it("sends git straight to the executable and npm through the Windows shell", () => {
    expect(sandbox.commandNeedsWindowsShell("git")).toBe(false);
    expect(sandbox.commandNeedsWindowsShell("tasklist")).toBe(false);
    expect(sandbox.commandNeedsWindowsShell("npm")).toBe(true);
    expect(sandbox.commandNeedsWindowsShell("npm.cmd")).toBe(true);
  });

  it("keeps an argument that contains a space", async () => {
    const result = await sandbox.runCommand(
      process.execPath,
      ["-e", "process.stdout.write('probe commit')"],
      process.cwd(),
      8000,
    );
    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("probe commit");
  });
});
