/**
 * Modules-page import: only module-shaped packs, install still goes through
 * installPack(), and a skill zip is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modulePack = require("../../electron/module-pack.cjs") as {
  looksLikeModule: (pack: unknown) => boolean;
  healModulePack: (pack: unknown) => {
    ok: boolean;
    pack?: {
      tree?: string;
      id?: string;
      enabled?: boolean;
      entry?: string;
      healed?: boolean;
    };
    error?: string;
  };
  prepareModulesOnly: (
    payload: unknown,
    extra?: { nonModuleKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string };
  collectModulePacksFromDir: (dir: string) => {
    packs: { id?: string; slug?: string }[];
    nonModuleKinds: string[];
  };
};
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; path?: string; error?: string };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-module-pack-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

function pythonBin(): string | null {
  for (const bin of ["python3", "python"]) {
    try {
      execFileSync(bin, ["-c", "import zipfile"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

function zipFolder(folder: string, zipPath: string) {
  const bin = pythonBin();
  expect(bin, "python zipfile is required for the real zip-import test").toBeTruthy();
  const script = `
import zipfile, os
root = ${JSON.stringify(folder)}
out = ${JSON.stringify(zipPath)}
parent = os.path.dirname(root)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            z.write(full, os.path.relpath(full, parent))
`;
  execFileSync(bin!, ["-c", script]);
}

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const ROOT = path.resolve(__dirname, "../..");
const MODULE_DIR = path.join(ROOT, "modules", "repo-import");

describe("module pack healer", () => {
  it("heals an incomplete module into modules-tree fields and never enables it", () => {
    const healed = modulePack.healModulePack({
      name: "Folder peek",
      entry: "main.py",
      permissions: ["fs.read"],
    });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("modules");
    expect(healed.pack?.id).toBe("folder-peek");
    expect(healed.pack?.enabled).toBe(false);
    expect(healed.pack?.entry).toBe("main.py");
    expect(healed.pack?.healed).toBe(true);
  });

  it("does not treat a skill pack as a module", () => {
    expect(
      modulePack.looksLikeModule({
        tree: "skills",
        name: "Word tally",
        code: "export async function run() { return 1; }",
      }),
    ).toBe(false);
  });
});

describe("module pack install", () => {
  it("installs a healed module as manifest.json + main.py, disabled", () => {
    const workspace = temp();
    const healed = modulePack.healModulePack({
      name: "Folder peek",
      entry: "main.py",
      permissions: ["fs.read"],
      ui: { page: "Folder peek", icon: "folder" },
    });
    expect(healed.ok).toBe(true);
    const written = capabilities.installPack({ workspaceRoot: workspace }, healed.pack, "modules");
    expect(written.ok).toBe(true);
    expect(written.tree).toBe("modules");
    const dir = written.path!;
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "main.py"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.enabled).toBe(false);
    expect(manifest.ui.page).toBe("Folder peek");
  });

  it("refuses a skill pack zip on the Modules page", async () => {
    const workspaceRoot = temp();
    const skillDir = path.join(temp(), "word-tally");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "skill.json"),
      JSON.stringify({
        tree: "skills",
        slug: "word-tally",
        name: "Word tally",
        code: "export async function run() { return { n: 1 }; }\n",
      }),
    );
    const zipPath = path.join(temp(), "skill.zip");
    zipFolder(skillDir, zipPath);
    const importer = require("../../electron/importer.cjs") as {
      scanImport: (args: { root: string; source: string }) => Promise<{
        ok: boolean;
        contentRoot?: string;
      }>;
    };
    const scan = await importer.scanImport({ root: workspaceRoot, source: zipPath });
    expect(scan.ok).toBe(true);
    const collected = modulePack.collectModulePacksFromDir(scan.contentRoot || "");
    const prepared = modulePack.prepareModulesOnly(collected.packs, {
      nonModuleKinds: collected.nonModuleKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(
      /Modules page only accepts module packs|Detected a Skills pack/i,
    );
  }, 60000);
});

describe("Modules page zip/folder/git wiring", () => {
  it("exposes module IPC, marketplace wrappers, and Modules extra buttons", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain('ipcMain.handle("capabilities:install-module-zip"');
    expect(main).toContain('ipcMain.handle("capabilities:install-module-folder"');
    expect(main).toContain('ipcMain.handle("capabilities:install-module-git"');
    expect(main).toContain("modulePack.prepareModulesOnly");
    expect(main).toContain("collectModulePacksFromDir");
    expect(main.match(/installCapabilityPayload\(payload, hint\)/g)?.length).toBe(4);

    const preload = read("electron/preload.cjs");
    expect(preload).toContain("capabilities:install-module-zip");
    expect(preload).toContain("capabilities:install-module-folder");
    expect(preload).toContain("capabilities:install-module-git");

    const market = read("src/lib/friday/marketplace.ts");
    expect(market).toContain("export async function installModuleZip");
    expect(market).toContain("export async function installModuleFolder");
    expect(market).toContain("export async function installModuleGit");

    const importerUi = read("src/components/friday/CapabilityImport.tsx");
    expect(importerUi).toContain('tree === "modules"');
    expect(importerUi).toContain("installModuleZip");
    expect(importerUi).toContain("installModuleFolder");
    expect(importerUi).toContain("installModuleGit");
    expect(importerUi).toContain("Git clone");
    expect(importerUi).not.toContain("installSkillZip");
    expect(importerUi).not.toContain("installToolZip");

    expect(fs.existsSync(path.join(MODULE_DIR, "manifest.json"))).toBe(true);
  });
});
