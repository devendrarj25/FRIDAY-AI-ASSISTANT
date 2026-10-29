/**
 * Plugins page Enable / Test selected / boot must use the same roots as
 * capability discovery. Enable is capabilities.json (shipped packs stay in
 * appRoot). Hook data from those packs writes into the workspace, not the
 * install folder. Test selected dispatches one pluginId, not every pack.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugins = require("../../electron/plugins.cjs") as {
  list: (root: unknown) => {
    id: string;
    enabled: boolean;
    path: string;
    origin?: string;
    github?: string | null;
    latest?: string | null;
    version?: string | null;
    updateAvailable?: boolean;
  }[];
  dispatch: (
    roots: { appRoot?: string | null; workspaceRoot?: string | null },
    hook: string,
    payload?: Record<string, unknown>,
    options?: { allowDisabled?: boolean; pluginId?: string },
  ) => Promise<{
    ok: boolean;
    fired?: { ok: boolean; id: string; error?: string }[];
    error?: string;
  }>;
  setEnabled: (
    roots: { appRoot?: string | null; workspaceRoot?: string | null } | string,
    id: string,
    enabled: boolean,
  ) => { ok: boolean; error?: string };
  dataDirFor: (pluginDir: string, pluginId: string, workspaceRoot?: string | null) => string;
  checkUpdates: (
    root: unknown,
    options?: { lookup?: (repo: string) => Promise<string | null> },
  ) => Promise<{
    ok: boolean;
    plugins: {
      id: string;
      github?: string | null;
      latest?: string | null;
      version?: string | null;
      updateAvailable?: boolean;
    }[];
    updates: { id: string }[];
  }>;
};
const capabilities = require("../../electron/capabilities.cjs") as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean }[];
  };
  setEnabled: (roots: { workspaceRoot: string }, id: string, enabled: boolean) => { ok: boolean };
};

const temps: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-wire-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps.length = 0;
});

const APP = process.cwd();

describe("plugins runtime wiring", () => {
  it("lists shipped packs from appRoot and Enable is capabilities.json", () => {
    const workspaceRoot = temp();
    const listed = plugins.list({ appRoot: APP, workspaceRoot });
    expect(listed.length).toBeGreaterThanOrEqual(70);
    const pack = listed.find((item) => item.id === "plugins/installed/turn-complete-log");
    expect(pack).toBeDefined();
    expect(pack?.enabled).toBe(false);
    expect(
      plugins.setEnabled(
        { appRoot: APP, workspaceRoot },
        "plugins/installed/turn-complete-log",
        true,
      ).ok,
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspaceRoot, "plugins", "installed", "turn-complete-log", "index.cjs"),
      ),
    ).toBe(true);
    const after = plugins.list({ appRoot: APP, workspaceRoot });
    expect(after.find((item) => item.id === "plugins/installed/turn-complete-log")?.enabled).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(APP, "plugins", "installed", "turn-complete-log", "plugin.json")),
    ).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(APP, "plugins", "installed", "turn-complete-log", "plugin.json"),
        "utf8",
      ),
    ) as { enabled?: boolean };
    expect(manifest.enabled).toBe(false);
  });

  it("Enable copies the shipped pack into the workspace and dispatch writes there", async () => {
    const workspaceRoot = temp();
    plugins.setEnabled(
      { appRoot: APP, workspaceRoot },
      "plugins/installed/turn-complete-log",
      true,
    );
    const copyData = path.join(
      workspaceRoot,
      "plugins",
      "data",
      "turn-complete-log",
      "turns.ndjson",
    );
    const appData = path.join(APP, "plugins", "installed", "turn-complete-log", "data");
    const before = fs.existsSync(path.join(appData, "turns.ndjson"))
      ? fs.readFileSync(path.join(appData, "turns.ndjson"), "utf8")
      : "";
    const result = await plugins.dispatch({ appRoot: APP, workspaceRoot }, "on-turn-complete", {
      runId: "wire-enable",
      ms: 12,
      ok: true,
    });
    expect(
      result.fired?.some((row) => row.ok && row.id.includes("turn-complete-log")),
      String(result.error),
    ).toBe(true);
    expect(fs.existsSync(copyData)).toBe(true);
    expect(fs.readFileSync(copyData, "utf8")).toMatch(/wire-enable/);
    expect(
      fs.existsSync(
        path.join(
          workspaceRoot,
          "plugins",
          "installed",
          "turn-complete-log",
          "data",
          "turns.ndjson",
        ),
      ),
    ).toBe(false);
    const after = fs.existsSync(path.join(appData, "turns.ndjson"))
      ? fs.readFileSync(path.join(appData, "turns.ndjson"), "utf8")
      : "";
    expect(after).toBe(before);
  }, 60000);

  it("Test selected pluginId fires only that pack even with allowDisabled", async () => {
    const workspaceRoot = temp();
    const a = path.join(workspaceRoot, "plugins", "installed", "alpha-hook");
    const b = path.join(workspaceRoot, "plugins", "installed", "beta-hook");
    for (const [dir, slug] of [
      [a, "alpha-hook"],
      [b, "beta-hook"],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "plugin.json"),
        JSON.stringify({
          id: slug,
          name: slug,
          version: "1.0.0",
          entry: "index.cjs",
          permissions: [],
          hooks: ["on-turn-complete"],
          enabled: false,
        }),
      );
      fs.writeFileSync(
        path.join(dir, "index.cjs"),
        `module.exports = {
          "on-turn-complete": async function (payload, ctx) {
            ctx.fs.writeFile("hit.txt", String(payload.runId || ""));
            return { ok: true };
          },
        };`,
      );
    }
    const all = await plugins.dispatch(
      { workspaceRoot },
      "on-turn-complete",
      { runId: "everyone" },
      { allowDisabled: true },
    );
    expect(all.fired?.length).toBeGreaterThanOrEqual(2);
    expect(
      fs.readFileSync(path.join(workspaceRoot, "plugins", "data", "alpha-hook", "hit.txt"), "utf8"),
    ).toBe("everyone");
    expect(
      fs.readFileSync(path.join(workspaceRoot, "plugins", "data", "beta-hook", "hit.txt"), "utf8"),
    ).toBe("everyone");
    fs.rmSync(path.join(workspaceRoot, "plugins", "data", "alpha-hook"), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(workspaceRoot, "plugins", "data", "beta-hook"), {
      recursive: true,
      force: true,
    });
    const one = await plugins.dispatch(
      { workspaceRoot },
      "on-turn-complete",
      { runId: "just-alpha" },
      { allowDisabled: true, pluginId: "plugins/installed/alpha-hook" },
    );
    expect(one.ok).toBe(true);
    expect(one.fired?.map((row) => row.id).some((id) => id.includes("alpha-hook"))).toBe(true);
    expect(one.fired?.some((row) => String(row.id).includes("beta-hook"))).toBe(false);
    expect(
      fs.readFileSync(path.join(workspaceRoot, "plugins", "data", "alpha-hook", "hit.txt"), "utf8"),
    ).toBe("just-alpha");
    expect(fs.existsSync(path.join(workspaceRoot, "plugins", "data", "beta-hook", "hit.txt"))).toBe(
      false,
    );
    const missing = await plugins.dispatch(
      { workspaceRoot },
      "on-turn-complete",
      { runId: "none" },
      { allowDisabled: true, pluginId: "plugins/installed/does-not-exist" },
    );
    expect(missing.ok).toBe(false);
    expect(String(missing.error || "")).toMatch(/not installed/);
  }, 60000);

  it("jails app-catalog plugin data under the workspace", () => {
    const workspaceRoot = temp();
    const appPack = path.join(APP, "plugins", "installed", "turn-complete-log");
    const dir = plugins.dataDirFor(appPack, "plugins/installed/turn-complete-log", workspaceRoot);
    expect(dir.startsWith(workspaceRoot)).toBe(true);
    expect(dir).toContain(path.join("plugins", "data", "turn-complete-log"));
  });

  it("Test selected can fire a still-disabled shipped pack without enabling it", async () => {
    const workspaceRoot = temp();
    const result = await plugins.dispatch(
      { appRoot: APP, workspaceRoot },
      "on-turn-complete",
      { runId: "test-selected", ms: 5, ok: true },
      { allowDisabled: true, pluginId: "plugins/installed/turn-complete-log" },
    );
    expect(result.ok, String(result.error || result.fired?.[0]?.error)).toBe(true);
    expect(result.fired?.length).toBe(1);
    const jailed = path.join(workspaceRoot, "plugins", "data", "turn-complete-log", "turns.ndjson");
    expect(fs.existsSync(jailed)).toBe(true);
    expect(fs.readFileSync(jailed, "utf8")).toMatch(/test-selected/);
    expect(
      fs.existsSync(path.join(workspaceRoot, "plugins", "installed", "turn-complete-log")),
    ).toBe(false);
  }, 60000);

  it("Test selected and Enable share the same workspace data file", async () => {
    const workspaceRoot = temp();
    await plugins.dispatch(
      { appRoot: APP, workspaceRoot },
      "on-turn-complete",
      { runId: "before-enable", ms: 3, ok: true },
      { allowDisabled: true, pluginId: "plugins/installed/turn-complete-log" },
    );
    plugins.setEnabled(
      { appRoot: APP, workspaceRoot },
      "plugins/installed/turn-complete-log",
      true,
    );
    const result = await plugins.dispatch({ appRoot: APP, workspaceRoot }, "on-turn-complete", {
      runId: "after-enable",
      ms: 4,
      ok: true,
    });
    expect(result.fired?.filter((row) => String(row.id).includes("turn-complete-log")).length).toBe(
      1,
    );
    const file = path.join(workspaceRoot, "plugins", "data", "turn-complete-log", "turns.ndjson");
    const body = fs.readFileSync(file, "utf8");
    expect(body).toMatch(/before-enable/);
    expect(body).toMatch(/after-enable/);
  }, 60000);

  it("capabilities disable stops the workspace copy from firing", async () => {
    const workspaceRoot = temp();
    plugins.setEnabled(
      { appRoot: APP, workspaceRoot },
      "plugins/installed/turn-complete-log",
      true,
    );
    plugins.setEnabled(
      { appRoot: APP, workspaceRoot },
      "plugins/installed/turn-complete-log",
      false,
    );
    const result = await plugins.dispatch({ appRoot: APP, workspaceRoot }, "on-turn-complete", {
      runId: "after-disable",
      ms: 4,
      ok: true,
    });
    expect(result.fired?.some((row) => String(row.id).includes("turn-complete-log"))).toBe(false);
    expect(
      fs.existsSync(
        path.join(workspaceRoot, "plugins", "data", "turn-complete-log", "turns.ndjson"),
      ),
    ).toBe(false);
  }, 60000);

  it("looks up GitHub latest for a declared source and stays blank otherwise", async () => {
    const workspaceRoot = temp();
    const dir = path.join(workspaceRoot, "plugins", "installed", "sample-src");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        id: "sample-src",
        name: "Sample src",
        version: "1.0.0",
        entry: "index.cjs",
        enabled: false,
        github: "acme/sample-src",
        hooks: ["on-idle"],
      }),
    );
    fs.writeFileSync(path.join(dir, "index.cjs"), "module.exports = { register() {} };\n");
    const listed = plugins.list({ workspaceRoot });
    const pack = listed.find(
      (row) => row.id === "sample-src" || String(row.id).endsWith("/sample-src"),
    );
    expect(pack?.github).toBe("acme/sample-src");
    expect(pack?.latest).toBeNull();
    expect(pack?.updateAvailable).toBe(false);
    const checked = await plugins.checkUpdates(
      { workspaceRoot },
      { lookup: async (repo) => (repo === "acme/sample-src" ? "1.2.0" : null) },
    );
    const after = checked.plugins.find((row) => row.github === "acme/sample-src");
    expect(after?.latest).toBe("1.2.0");
    expect(after?.updateAvailable).toBe(true);
    const shipped = plugins
      .list({ appRoot: APP, workspaceRoot })
      .find((row) => row.id === "plugins/installed/turn-complete-log");
    expect(shipped?.github).toBeNull();
    expect(shipped?.latest).toBeNull();
  });
});

describe("desktop IPC wiring", () => {
  const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(process.cwd(), "electron/preload.cjs"), "utf8");
  const page = fs.readFileSync(path.join(process.cwd(), "src/routes/plugins.tsx"), "utf8");
  const brain = fs.readFileSync(path.join(process.cwd(), "src/lib/friday/brain-engine.ts"), "utf8");

  it("lists, enables, loads, and dispatches through capabilityRoots()", () => {
    expect(main).toContain("plugins.list(capabilityRoots())");
    expect(main).toContain("plugins.load(capabilityRoots()");
    expect(main).toContain('key.startsWith("plugins/")');
    expect(main).toContain("plugins.setEnabled(capabilityRoots()");
    expect(main).toContain("plugins.invoke(capabilityRoots()");
    expect(main).toContain("loadEnabled(capabilityRoots()");
    expect(main).toMatch(/pluginId:\s*\n?\s*options && \(options\.pluginId \|\| options\.id\)/);
    expect(main).toContain("plugins.checkUpdates(capabilityRoots())");
    expect(preload).toContain("plugins:check-updates");
    expect(preload).toContain("options || {}");
    expect(page).toContain("pluginId: openRow.id");
    expect(brain).toContain(
      'dispatchPluginHook("on-turn-complete", { runId: run.id, ms: run.ms, ok: false })',
    );
  });
});
