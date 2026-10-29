/**
 * Proof for this pass:
 *
 *  1. the GitHub connector really declares write actions, and the state-changing
 *     ones are write/exec tier so brain/action-risk.ts gates them;
 *  2. "import from GitHub" reuses the ONE capability install path — the IPC
 *     handler calls the same installCapabilityPayload() the file import uses;
 *  3. the skill forge asks for a single approval that names the destination
 *     (local only vs also pushed to a repo).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { actionNeedsApproval } from "../../src/lib/friday/brain/action-risk";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("GitHub connector write actions", () => {
  const source = read("electron/connectors.cjs");

  it("declares real read and write actions on the Contents API", () => {
    for (const action of ["list-contents", "read-file", "put-file", "create-repo"])
      expect(source).toContain(`"${action}"`);
    expect(source).toContain("api.github.com/repos");
    expect(source).toContain("/user/repos");
  });

  it("keeps writes above the safe tier, so every mode pauses for approval", () => {
    const put = source.slice(source.indexOf('"put-file"'));
    expect(put.slice(0, 200)).toContain('risk: "write"');
    const create = source.slice(source.indexOf('"create-repo"'));
    expect(create.slice(0, 200)).toContain('risk: "exec"');
    expect(actionNeedsApproval("write", "auto")).toBe(true);
    expect(actionNeedsApproval("exec", "auto")).toBe(true);
  });
});

describe("import from GitHub reuses the file-import install path", () => {
  const main = read("electron/main.cjs");

  it("routes both sources through installCapabilityPayload", () => {
    expect(main).toContain('ipcMain.handle("capabilities:install-file"');
    expect(main).toContain('ipcMain.handle("capabilities:install-github"');
    // one declaration + file import + GitHub import + skills zip/folder/git source.
    expect(main.match(/installCapabilityPayload\(payload, hint\)/g)?.length).toBe(4);
  });

  it("fetches manifests through the connector, not a second HTTP client", () => {
    const handler = main.slice(main.indexOf('ipcMain.handle("capabilities:install-github"'));
    const body = handler.slice(0, handler.indexOf("ipcMain.handle", 10));
    expect(body).toContain('connectors.callConnector(root, "github", "read-file"');
    expect(body).toContain('"list-contents"');
    expect(body).toContain("attachSiblingSkillCode");
    expect(body).toContain("attachSiblingToolCode");
  });

  it("is exposed on the preload bridge and the renderer wrapper", () => {
    expect(read("electron/preload.cjs")).toContain("capabilities:install-github");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-skill-zip");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-skill-folder");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-skill-git");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-tool-zip");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-tool-folder");
    expect(read("electron/preload.cjs")).toContain("capabilities:install-tool-git");
    expect(read("src/lib/friday/marketplace.ts")).toContain(
      "export async function installFromGithub",
    );
    expect(read("src/lib/friday/marketplace.ts")).toContain(
      "export async function installSkillZip",
    );
    expect(read("src/lib/friday/marketplace.ts")).toContain("export async function installToolZip");
    expect(read("electron/tools.cjs")).toContain("createRequire");
    expect(read("electron/tool-pack.cjs")).toContain("prepareToolsOnly");
    expect(read("src/components/friday/CapabilityImport.tsx")).toContain("installFromGithub");
  });
});

describe("skill forge destination choice", () => {
  const forge = read("src/lib/friday/brain/skill-forge.ts");

  it("offers keep-in-FRIDAY vs also-push, under one approval", () => {
    expect(forge).toContain("publishTo?: string");
    expect(forge).toContain("Stays in FRIDAY only.");
    expect(forge).toContain("pushes it to ${publishTo} on GitHub");
    // Only one governance submission in the whole forge flow.
    expect(forge.match(/governance\.submit\(/g)?.length).toBe(1);
    expect(forge).toContain("connector.github.put-file");
  });

  it("writes skills through chat.complete and refuses to install a silent stub", () => {
    expect(forge).toContain("kernelApi.chat.complete");
    expect(forge).toContain("generated: false");
    expect(forge).not.toMatch(/Falls back to a working stub/);
    expect(forge).toContain("the coder model did not produce skill code");
  });

  it("gives the owner the choice in the Skill forge panel", () => {
    expect(read("src/components/friday/SelfCore.tsx")).toContain("Also push to GitHub");
  });
});

describe("updates panel reports current and latest version", () => {
  const panel = read("src/components/friday/settings/GithubUpdates.tsx");

  it("shows installed version, latest version, channel, changelog and manual check", () => {
    expect(panel).toContain("Installed version:");
    expect(panel).toContain("Latest on this channel:");
    expect(panel).toContain("APP_VERSION_LABEL");
    expect(panel).toContain("Update channel");
    expect(panel).toContain("What's new");
    expect(panel).toContain("githubCheck()");
  });
});
