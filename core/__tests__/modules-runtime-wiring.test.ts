/**
 * Modules page discovery and the module runtime must see the same packs,
 * and chat-shaped `{ prompt }` must reach run() on shipped Python packs.
 *
 * Catalog modules ship in the app folder. Enable is a capabilities.json
 * override (no workspace copy — shipped packs run from appRoot). Write/exec
 * packs are listed but the chat router will not auto-pick them.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chooseModules } from "../../src/lib/friday/brain/module-router";
import { observeBrain, noteObserve } from "../../src/lib/friday/brain/observe";
import type { ModulePackManifest } from "../../src/lib/friday/brain/module-forge";

const require = createRequire(import.meta.url);
const modules = require("../../electron/modules.cjs") as {
  list: (root: unknown) => {
    ok: boolean;
    modules: {
      id: string;
      enabled: boolean;
      name: string;
      runnable?: boolean;
      inputs?: string[];
      risk?: string;
      origin?: string;
      permissions?: string[];
    }[];
  };
  invoke: (
    root: unknown,
    id: string,
    input?: unknown,
    ctx?: { allowDisabled?: boolean },
  ) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
  enrichInput: (
    item: { inputs?: string[] } | null,
    raw: unknown,
    workspaceRoot?: string | null,
  ) => Record<string, unknown>;
  inferRisk: (item: { risk?: string; permissions?: string[] }) => string;
  setEnabled: (
    root: unknown,
    id: string,
    enabled: boolean,
    options?: { kernelToggle?: (name: string, enabled: boolean) => Promise<unknown> },
  ) => Promise<{ ok: boolean; name?: string; kernel?: boolean; error?: string }>;
};
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-mod-wire-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

const APP = process.cwd();

function writeWorkspaceModule(workspaceRoot: string, slug: string) {
  const dir = path.join(workspaceRoot, "modules", "custom", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      name: slug,
      version: "1.0.0",
      description: "Deterministic Python probe used to prove chat-shaped module input wiring.",
      category: "custom",
      permissions: ["fs.read"],
      entry: "main.py",
      enabled: false,
      ui: { page: "Wire probe", icon: "blocks" },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "main.py"),
    [
      "async def run(tools, folder='.'):",
      "    listing = await tools.execute('fs.read', {'path': folder})",
      "    if not listing.get('ok'):",
      "        return listing",
      "    return {'ok': True, 'folder': folder, 'entries': listing.get('entries', []), 'probe': True}",
      "",
      "def register(manifest):",
      "    return None",
      "",
      "def self_test(payload=None):",
      "    return {'ok': True}",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

describe("chat-shaped input mapping", () => {
  it("maps a path-shaped prompt onto folder and injects the workspace root", () => {
    const mapped = modules.enrichInput(
      { inputs: ["folder", "path", "root"] },
      { prompt: "src/app.ts" },
      "/tmp/friday-folder",
    );
    expect(mapped["folder"]).toBe("src/app.ts");
    expect(mapped["path"]).toBe("src/app.ts");
    expect(mapped["prompt"]).toBe("src/app.ts");
    expect(mapped["root"]).toBe("/tmp/friday-folder");
  });

  it("defaults folder to the workspace root and never sets apply from a prompt", () => {
    const mapped = modules.enrichInput(
      { inputs: ["folder", "apply"] },
      { prompt: "please apply this" },
      null,
    );
    expect(mapped["folder"]).toBe(".");
    expect(mapped["apply"]).toBeUndefined();
  });

  it("derives exec/write from permissions when the manifest omits risk", () => {
    expect(modules.inferRisk({ permissions: ["fs.read"] })).toBe("safe");
    expect(modules.inferRisk({ permissions: ["git"] })).toBe("safe");
    expect(modules.inferRisk({ permissions: ["fs.read", "fs.write"] })).toBe("write");
    expect(modules.inferRisk({ permissions: ["fs.read", "git", "shell.cmd"] })).toBe("exec");
  });
});

describe("app catalog vs workspace runtime", () => {
  it("lists shipped catalog modules from appRoot even with an empty workspace", () => {
    const workspaceRoot = temp();
    const listed = modules.list({ appRoot: APP, workspaceRoot }).modules;
    expect(listed.some((item) => item.id === "modules/repo-import")).toBe(true);
    expect(listed.find((item) => item.id === "modules/repo-import")?.enabled).toBe(true);
    expect(listed.find((item) => item.id === "modules/repo-import")?.risk).toBe("exec");
    expect(listed.find((item) => item.id === "modules/system/folder-inventory")?.enabled).toBe(
      false,
    );
    expect(listed.find((item) => item.id === "modules/system/folder-inventory")?.runnable).toBe(
      true,
    );
    expect(listed.find((item) => item.id === "modules/developer/project-scaffold")?.risk).toBe(
      "write",
    );
    const page = capabilities
      .list({ appRoot: APP, workspaceRoot })
      .items.filter((item) => item.tree === "modules");
    expect(page.map((item) => item.id)).toContain("modules/system/folder-inventory");
    expect(listed.filter((item) => item.enabled).map((item) => item.id)).toEqual([
      "modules/repo-import",
    ]);
  });

  it("Enable writes capabilities.json and calls kernel module.toggle", async () => {
    const workspaceRoot = temp();
    const calls: { name: string; enabled: boolean }[] = [];
    const result = await modules.setEnabled(
      { appRoot: APP, workspaceRoot },
      "modules/system/folder-inventory",
      true,
      {
        kernelToggle: async (name, enabled) => {
          calls.push({ name, enabled });
          return { ok: true, enabled };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe("folder-inventory");
    expect(calls).toEqual([{ name: "folder-inventory", enabled: true }]);
    expect(
      capabilities
        .list({ appRoot: APP, workspaceRoot })
        .items.find((item) => item.id === "modules/system/folder-inventory")?.enabled,
    ).toBe(true);
  });

  it("applies capabilities.json Enable so the router can pick a shipped module", async () => {
    const workspaceRoot = temp();
    fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "desk note", "utf8");
    const roots = { appRoot: APP, workspaceRoot };
    capabilities.setEnabled({ workspaceRoot }, "modules/system/folder-inventory", true);
    const listed = modules
      .list(roots)
      .modules.find((item) => item.id === "modules/system/folder-inventory");
    expect(listed?.enabled).toBe(true);
    expect(listed?.runnable).toBe(true);
    expect(listed?.risk).toBe("safe");

    const asManifest: ModulePackManifest = {
      id: listed!.id,
      name: listed!.name,
      description: "Shallow-plus-one inventory of a folder",
      category: "system",
      permissions: ["fs.read"],
      risk: "safe",
      inputs: listed!.inputs ?? ["folder"],
      enabled: true,
      ...(typeof listed?.runnable === "boolean" ? { runnable: listed.runnable } : {}),
    };
    expect(
      chooseModules("please folder-inventory this", [asManifest]).map((item) => item.id),
    ).toEqual(["modules/system/folder-inventory"]);

    const ran = await modules.invoke(roots, "modules/system/folder-inventory", { prompt: "." });
    expect(ran.ok, String(ran.error)).toBe(true);
    const value = ran.value as { ok?: boolean; children?: { name: string }[] };
    expect(value?.ok).toBe(true);
    expect((value?.children ?? []).some((child) => child.name === "note.txt")).toBe(true);
  });

  it("lets Test selected run a still-disabled shipped module without enabling it", async () => {
    const workspaceRoot = temp();
    fs.writeFileSync(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({ name: "wire-probe", private: true, scripts: { test: "vitest" } }),
      "utf8",
    );
    const roots = { appRoot: APP, workspaceRoot };
    const blocked = await modules.invoke(roots, "modules/developer/package-scripts", {
      prompt: "package.json",
    });
    expect(blocked.ok).toBe(false);
    expect(String(blocked.error)).toMatch(/disabled/i);
    const tested = await modules.invoke(
      roots,
      "modules/developer/package-scripts",
      { prompt: "package.json" },
      { allowDisabled: true },
    );
    expect(tested.ok, String(tested.error)).toBe(true);
    expect((tested.value as { scripts?: string[] })?.scripts).toEqual(["test"]);
    expect(
      modules.list(roots).modules.find((item) => item.id === "modules/developer/package-scripts")
        ?.enabled,
    ).toBe(false);
  });

  it("does not auto-pick a write or exec pack even when named", () => {
    const catalog: ModulePackManifest[] = [
      {
        id: "modules/developer/project-scaffold",
        name: "Project scaffold",
        description: "Write a small project tree",
        category: "developer",
        permissions: ["fs.write"],
        risk: "write",
        inputs: ["folder"],
        enabled: true,
        runnable: true,
      },
      {
        id: "modules/repo-import",
        name: "Repo import",
        description: "Clone a Git repo",
        category: "developer",
        permissions: ["shell.cmd"],
        risk: "exec",
        inputs: ["url", "folder"],
        enabled: true,
        runnable: true,
      },
    ];
    expect(chooseModules("Project scaffold", catalog)).toEqual([]);
    expect(chooseModules("Repo import", catalog)).toEqual([]);
  });

  it("runs a workspace-forged Python module from chat-shaped prompt input", async () => {
    const workspaceRoot = temp();
    fs.writeFileSync(path.join(workspaceRoot, "alpha.txt"), "a", "utf8");
    writeWorkspaceModule(workspaceRoot, "wire-probe");
    capabilities.setEnabled({ workspaceRoot }, "modules/custom/wire-probe", true);
    const listed = modules
      .list({ appRoot: APP, workspaceRoot })
      .modules.find((item) => item.id === "modules/custom/wire-probe");
    expect(listed?.enabled).toBe(true);
    expect(listed?.origin).toBe("workspace");
    const ran = await modules.invoke({ appRoot: APP, workspaceRoot }, "modules/custom/wire-probe", {
      prompt: ".",
    });
    expect(ran.ok, String(ran.error)).toBe(true);
    expect((ran.value as { probe?: boolean; entries?: string[] })?.probe).toBe(true);
    expect((ran.value as { entries?: string[] })?.entries).toContain("alpha.txt");
  });
});

describe("observability", () => {
  it("records the last catalog module id the same way baseline skills do", () => {
    noteObserve({ tool: "modules/system/folder-inventory" });
    expect(observeBrain().tool).toBe("modules/system/folder-inventory");
  });
});

describe("desktop IPC wiring", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(process.cwd(), "electron/preload.cjs"), "utf8");
  const core = fs.readFileSync(
    path.join(process.cwd(), "src/lib/friday/brain/core-brain.ts"),
    "utf8",
  );

  it("lists and invokes through capabilityRoots() so app packs are visible", () => {
    expect(main).toContain("fridayModules.list(capabilityRoots())");
    expect(main).toContain("fridayModules.invoke(capabilityRoots()");
    expect(main).toContain("fridayModules.setEnabled(capabilityRoots()");
    expect(main).toContain('kernelRequest("module.toggle"');
    expect(main).toContain("allowDisabled: Boolean(options && options.allowDisabled)");
    expect(preload).toContain("modules:invoke");
    expect(preload).toContain("options || {}");
    expect(core).toContain('stage?.("agents.modules"');
    expect(core).toContain("noteObserve({ tool:");
  });
});
