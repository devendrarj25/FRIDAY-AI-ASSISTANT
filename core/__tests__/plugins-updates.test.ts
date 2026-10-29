import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugins = require("../../electron/plugins.cjs");
const { rollbackUpdate } = require("../../electron/updater.cjs");

let root: string;

const writePlugin = (
  id: string,
  body: string,
  enabled: boolean | Record<string, unknown> = true,
) => {
  const extra = typeof enabled === "object" ? enabled : { enabled };
  const dir = path.join(root, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, name: id, version: "1.0.0", entry: "index.cjs", ...extra }),
  );
  fs.writeFileSync(path.join(dir, "index.cjs"), body);
  return dir;
};

const services = {
  workspaceRoot: () => root,
  log: () => {},
  emit: () => {},
  on: () => () => {},
  kernel: async () => null,
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugins-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("workspace plugin host", () => {
  it("loads a plugin and invokes its registered command", async () => {
    writePlugin("demo", 'module.exports={register(ctx){ctx.ipc.register("ping",a=>({pong:a.v}))}}');
    expect(plugins.list(root)).toHaveLength(1);
    const loaded = await plugins.load(root, "demo", services);
    expect(loaded.ok).toBe(true);
    // The plugin now runs through sandbox.runIsolated(), not a direct
    // require() in the Electron main process.
    expect(await plugins.invoke(root, "demo", "ping", { v: 7 }, services)).toEqual({
      ok: true,
      result: { pong: 7 },
      sandboxed: true,
    });
    await plugins.unload("demo");
  });

  it("reports a broken plugin instead of throwing", async () => {
    writePlugin("broken", 'module.exports={register(){throw new Error("nope")}}');
    const result = await plugins.load(root, "broken", services);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nope");
  });

  it("skips disabled plugins and can toggle them", async () => {
    writePlugin("off", "module.exports={register(){}}", false);
    expect((await plugins.loadEnabled(root, services)).length).toBe(0);
    expect(plugins.setEnabled(root, "off", true).ok).toBe(true);
    expect((await plugins.loadEnabled(root, services)).length).toBe(1);
    await plugins.unload("off");
  });
});

describe("update rollback", () => {
  it("restores a backup over the live folder", () => {
    const target = path.join(root, "plugins", "thing");
    const backup = path.join(root, "backups", "thing");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(target, "v.txt"), "new");
    fs.writeFileSync(path.join(backup, "v.txt"), "old");
    expect(rollbackUpdate({ backup, target }).ok).toBe(true);
    expect(fs.readFileSync(path.join(target, "v.txt"), "utf8")).toBe("old");
  });

  it("refuses to roll back without a backup", () => {
    expect(rollbackUpdate({ backup: "", target: root }).ok).toBe(false);
  });
});

describe("plugin isolation", () => {
  it("runs a plugin without main-process trust by default", async () => {
    // A sandboxed plugin cannot reach the Electron main process; proving it
    // runs at all while `trusted` stays false is the isolation contract.
    writePlugin(
      "iso",
      'module.exports={register(ctx){ctx.ipc.register("who",()=>({electron:Boolean(process.versions.electron)}))}}',
    );
    const loaded = await plugins.load(root, "iso", services);
    expect(loaded.ok).toBe(true);
    expect(loaded.sandboxed).toBe(true);
    const answer = await plugins.invoke(root, "iso", "who", {}, services);
    expect(answer.ok).toBe(true);
    expect(answer.sandboxed).toBe(true);
    expect(answer.result.electron).toBe(false);
    await plugins.unload("iso");
  }, 60000);

  it("only grants Electron access when the owner approves it", async () => {
    writePlugin("hosty", 'module.exports={register(ctx){ctx.ipc.register("ping",()=>1)}}', {
      permissions: ["electron"],
    });
    const denied = await plugins.load(root, "hosty", {
      ...services,
      approveHostAccess: async () => false,
    });
    expect(denied.ok).toBe(true);
    expect(denied.sandboxed).toBe(true);
    await plugins.unload("hosty");

    const approved = await plugins.load(root, "hosty", {
      ...services,
      approveHostAccess: async () => true,
    });
    expect(approved.ok).toBe(true);
    expect(approved.sandboxed).toBeFalsy();
    await plugins.unload("hosty");
  }, 60000);
});
