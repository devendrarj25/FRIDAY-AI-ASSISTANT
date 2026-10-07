/**
 * Agents-page import: only agent-shaped packs, incomplete packs are healed
 * into manifest.json, install still goes through installPack(), and a skill
 * zip is refused. A real zip of market-data-agent lands disabled then
 * test-before-enable runs.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentPack = require("../../electron/agent-pack.cjs") as {
  looksLikeAgent: (pack: unknown) => boolean;
  healAgentPack: (pack: unknown) => {
    ok: boolean;
    pack?: {
      tree?: string;
      id?: string;
      enabled?: boolean;
      role?: string;
      healed?: boolean;
      segment?: string;
    };
    error?: string;
  };
  prepareAgentsOnly: (
    payload: unknown,
    extra?: { nonAgentKinds?: string[] },
  ) => { ok: boolean; packs?: unknown[]; error?: string; skipped?: number };
  collectAgentPacksFromDir: (dir: string) => {
    packs: { id?: string; slug?: string; role?: string }[];
    nonAgentKinds: string[];
  };
};
const capabilities = require("../../electron/capabilities.cjs") as {
  installPack: (
    roots: { workspaceRoot: string },
    pack: unknown,
    hint?: string,
  ) => { ok: boolean; id?: string; tree?: string; path?: string; error?: string };
  markVerified: (
    roots: { workspaceRoot: string },
    id: string,
    result: { ok: boolean; status?: string },
  ) => { ok: boolean };
};
const importer = require("../../electron/importer.cjs") as {
  scanImport: (args: { root: string; source: string }) => Promise<{
    ok: boolean;
    contentRoot?: string;
    error?: string;
  }>;
};
const verify = require("../../electron/capability-verify.cjs") as {
  verifyCapability: (
    roots: { root: string },
    pack: { id: string; tree: string; dir: string },
    options?: { allowInstall?: boolean },
  ) => Promise<{ ok: boolean; status?: string; error?: string }>;
};

const MARKET_DATA = {
  tree: "agents",
  segment: "installed",
  slug: "market-data-agent",
  name: "Market data agent",
  description:
    "Fetches and normalizes quote data for watched symbols through existing web/http/data skills. Read/analysis only — no broker login or order placement.",
  permissions: ["web.access"],
  risk: "safe",
  tags: ["trading", "markets"],
  role: "market-data",
  skills: ["web.api-probe", "web.readable", "csv.parse", "json.transform"],
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-agent-pack-"));
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
      /* try the next */
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

describe("agent pack healer", () => {
  it("heals an incomplete agent into agents-tree fields and never enables it", () => {
    const healed = agentPack.healAgentPack({ name: "Watch desk", persona: "desk watcher" });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("agents");
    expect(healed.pack?.id).toBe("watch-desk");
    expect(healed.pack?.enabled).toBe(false);
    expect(healed.pack?.role).toBe("watch-desk");
    expect(healed.pack?.healed).toBe(true);
  });

  it("keeps an existing role instead of replacing it", () => {
    const healed = agentPack.healAgentPack({
      id: "market-data-agent",
      name: "Market data agent",
      role: "market-data",
      description: MARKET_DATA.description,
    });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.role).toBe("market-data");
    expect(healed.pack?.enabled).toBe(false);
  });

  it("does not treat a skill pack as an agent", () => {
    expect(
      agentPack.looksLikeAgent({
        tree: "skills",
        name: "Word tally",
        code: "export async function run() { return 1; }",
      }),
    ).toBe(false);
    const prepared = agentPack.prepareAgentsOnly({
      tree: "skills",
      slug: "word-tally",
      name: "Word tally",
      code: "export async function run() { return 1; }",
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Agents page only accepts agent packs/i);
  });
});

describe("agents-only folder collect", () => {
  it("collects manifest.json agent folders and skips skill.json", () => {
    const dir = temp();
    const agentDir = path.join(dir, "market-data-agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, "manifest.json"), JSON.stringify(MARKET_DATA));
    fs.mkdirSync(path.join(dir, "a-skill"));
    fs.writeFileSync(
      path.join(dir, "a-skill", "skill.json"),
      JSON.stringify({ name: "Not an agent", tree: "skills" }),
    );
    const collected = agentPack.collectAgentPacksFromDir(dir);
    expect(collected.nonAgentKinds).toContain("skills");
    expect(collected.packs).toHaveLength(1);
    expect(collected.packs[0]?.id).toBe("market-data-agent");
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.packs).toHaveLength(1);
  });

  it("refuses a folder that only contains a skill", () => {
    const dir = temp();
    fs.writeFileSync(
      path.join(dir, "skill.json"),
      JSON.stringify({ name: "Only skill", tree: "skills" }),
    );
    const collected = agentPack.collectAgentPacksFromDir(dir);
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Agents page only accepts agent packs/i);
    expect(String(prepared.error)).toMatch(/skill/i);
  });

  it("installs a healed agent through installPack into agents/installed, disabled", () => {
    const workspaceRoot = temp();
    const healed = agentPack.healAgentPack({
      name: "Go no go",
      role: "go-no-go",
      description: "Scores a tender's fit and recommends bid or skip.",
    });
    expect(healed.ok).toBe(true);
    const result = capabilities.installPack({ workspaceRoot }, healed.pack, "agents");
    expect(result.ok).toBe(true);
    expect(result.tree).toBe("agents");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, "agents", "installed", "go-no-go", "manifest.json"),
        "utf8",
      ),
    );
    expect(manifest.enabled).toBe(false);
    expect(manifest.verification.status).toBe("pending");
    expect(manifest.role).toBe("go-no-go");
  });
});

describe("real zip import of market-data-agent", () => {
  it("extracts the zip, writes disabled, then test-before-enable verifies it", async () => {
    const workspaceRoot = temp();
    const packDir = path.join(temp(), "market-data-agent");
    fs.mkdirSync(packDir);
    fs.writeFileSync(path.join(packDir, "manifest.json"), JSON.stringify(MARKET_DATA, null, 2));
    const zipPath = path.join(temp(), "market-data-agent.zip");
    zipFolder(packDir, zipPath);
    expect(fs.existsSync(zipPath)).toBe(true);

    const scan = await importer.scanImport({ root: workspaceRoot, source: zipPath });
    expect(scan.ok).toBe(true);
    const collected = agentPack.collectAgentPacksFromDir(scan.contentRoot || "");
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    expect(prepared.ok).toBe(true);
    const pack = (prepared.packs || [])[0];
    const installed = capabilities.installPack({ workspaceRoot }, pack, "agents");
    expect(installed.ok).toBe(true);
    expect(installed.id).toBe("agents/installed/market-data-agent");
    const manifestPath = path.join(
      workspaceRoot,
      "agents",
      "installed",
      "market-data-agent",
      "manifest.json",
    );
    const before = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(before.enabled).toBe(false);
    expect(before.verification.status).toBe("pending");
    expect(before.role).toBe("market-data");

    const checked = await verify.verifyCapability(
      { root: workspaceRoot },
      { id: installed.id!, tree: "agents", dir: installed.path! },
      { allowInstall: false },
    );
    expect(checked.ok).toBe(true);
    capabilities.markVerified({ workspaceRoot }, installed.id!, checked);
    const after = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(after.enabled).toBe(true);
    expect(after.verification.status).toBe("verified");
  }, 60000);

  it("refuses a skill pack zip on the Agents page", async () => {
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
    const scan = await importer.scanImport({ root: workspaceRoot, source: zipPath });
    expect(scan.ok).toBe(true);
    const collected = agentPack.collectAgentPacksFromDir(scan.contentRoot || "");
    const prepared = agentPack.prepareAgentsOnly(collected.packs, {
      nonAgentKinds: collected.nonAgentKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Agents page only accepts agent packs/i);
  }, 60000);
});

describe("Agents page zip/folder/git wiring", () => {
  it("exposes agent IPC, marketplace wrappers, and Agents-only extra buttons", () => {
    const main = read("electron/main.cjs");
    expect(main).toContain('ipcMain.handle("capabilities:install-agent-zip"');
    expect(main).toContain('ipcMain.handle("capabilities:install-agent-folder"');
    expect(main).toContain('ipcMain.handle("capabilities:install-agent-git"');
    expect(main).toContain("agentPack.prepareAgentsOnly");
    expect(main).toContain("collectAgentPacksFromDir");
    expect(main.match(/installCapabilityPayload\(payload, hint\)/g)?.length).toBe(4);

    const preload = read("electron/preload.cjs");
    expect(preload).toContain("capabilities:install-agent-zip");
    expect(preload).toContain("capabilities:install-agent-folder");
    expect(preload).toContain("capabilities:install-agent-git");

    const market = read("src/lib/friday/marketplace.ts");
    expect(market).toContain("export async function installAgentZip");
    expect(market).toContain("export async function installAgentFolder");
    expect(market).toContain("export async function installAgentGit");

    const importerUi = read("src/components/friday/CapabilityImport.tsx");
    expect(importerUi).toContain('tree === "agents"');
    expect(importerUi).toContain("installAgentZip");
    expect(importerUi).toContain("installAgentFolder");
    expect(importerUi).toContain("installAgentGit");
    expect(importerUi).toContain("Git clone");
    expect(importerUi).not.toContain("installSkillZip");
    expect(importerUi).not.toContain("installToolZip");
  });
});
