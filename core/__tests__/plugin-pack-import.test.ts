/**
 * Plugin-page import: only plugin-shaped packs, install still goes through
 * installPack(), and a skill folder is refused.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pluginPack = require("../../electron/plugin-pack.cjs") as {
  looksLikePlugin: (pack: unknown) => boolean;
  healPluginPack: (pack: unknown) => {
    ok: boolean;
    pack?: { tree?: string; id?: string; enabled?: boolean; hooks?: string[]; healed?: boolean };
    error?: string;
  };
  preparePluginsOnly: (
    payload: unknown,
    extra?: { nonPluginKinds?: string[] },
  ) => { ok: boolean; packs?: { id?: string; enabled?: boolean }[]; error?: string };
  collectPluginPacksFromDir: (dir: string) => {
    packs: { id?: string }[];
    nonPluginKinds: string[];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-pack-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, "../..");
const PLUGIN_DIR = path.join(ROOT, "plugins", "installed", "turn-complete-log");
const SKILL_DIR = path.join(ROOT, "skills", "custom", "wrt-headlines");

describe("plugin-pack heal and plugins-only prepare", () => {
  it("heals an incomplete plugin into plugin.json shape, still disabled", () => {
    const healed = pluginPack.healPluginPack({
      name: "Scratch logger",
      hooks: ["on-error"],
    });
    expect(healed.ok).toBe(true);
    expect(healed.pack?.tree).toBe("plugins");
    expect(healed.pack?.enabled).toBe(false);
    expect(healed.pack?.hooks).toContain("on-error");
    expect(healed.pack?.healed).toBe(true);
  });

  it("collects a real shipped plugin and installPack writes plugin.json disabled", () => {
    const dir = temp();
    fs.cpSync(PLUGIN_DIR, path.join(dir, "turn-complete-log"), { recursive: true });
    const collected = pluginPack.collectPluginPacksFromDir(dir);
    expect(collected.packs.length).toBeGreaterThanOrEqual(1);
    const prepared = pluginPack.preparePluginsOnly(collected.packs, {
      nonPluginKinds: collected.nonPluginKinds,
    });
    expect(prepared.ok).toBe(true);
    const workspace = temp();
    const written = capabilities.installPack(
      { workspaceRoot: workspace },
      (prepared.packs || [])[0],
      "plugins",
    );
    expect(written.ok, written.error).toBe(true);
    expect(written.tree).toBe("plugins");
    expect(fs.existsSync(path.join(written.path || "", "plugin.json"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(written.path || "", "plugin.json"), "utf8"),
    );
    expect(manifest.enabled).toBe(false);
    expect(manifest.hooks).toContain("on-turn-complete");
  });

  it("refuses a skill folder on the Plugins importer", () => {
    const dir = temp();
    fs.cpSync(SKILL_DIR, path.join(dir, "wrt-headlines"), { recursive: true });
    const collected = pluginPack.collectPluginPacksFromDir(dir);
    expect(collected.nonPluginKinds).toContain("skills");
    const prepared = pluginPack.preparePluginsOnly(collected.packs, {
      nonPluginKinds: collected.nonPluginKinds,
    });
    expect(prepared.ok).toBe(false);
    expect(String(prepared.error)).toMatch(/Detected a Skills pack/i);
  });
});

describe("main process wires preparePluginsOnly", () => {
  it("installCapabilityPayload and classified source mention plugins", () => {
    const main = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
    expect(main).toContain("pluginPack.preparePluginsOnly");
    expect(main).toContain("collectPluginPacksFromDir");
    expect(main).toContain("capabilities:install-plugin-zip");
  });
});
