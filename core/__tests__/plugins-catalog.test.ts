/**
 * Shipped plugin catalog: each pack has plugin.json + index.cjs that actually
 * exports the declared hooks. All stay enabled: false.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);
const pluginsHost = require_(path.join(ROOT, "electron/plugins.cjs")) as {
  HOOKS: string[];
  dispatch: (
    roots: { workspaceRoot: string },
    hook: string,
    payload?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; fired?: { ok: boolean; id: string }[] }>;
};
const capabilities = require_(path.join(ROOT, "electron/capabilities.cjs")) as {
  list: (roots: { appRoot?: string | null; workspaceRoot?: string | null }) => {
    items: { id: string; tree: string; enabled: boolean; path: string }[];
  };
};

function walkPluginJson(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkPluginJson(full, out);
    else if (entry.name === "plugin.json") out.push(full);
  }
  return out;
}

describe("shipped plugin catalog", () => {
  const files = walkPluginJson(path.join(ROOT, "plugins"));

  it("ships at least 70 real plugin.json packs, all disabled", () => {
    expect(files.length).toBeGreaterThanOrEqual(70);
    for (const file of files) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
        enabled?: boolean;
        hooks?: string[];
        entry?: string;
        id?: string;
      };
      expect(manifest.enabled, file).toBe(false);
      expect(Array.isArray(manifest.hooks) && manifest.hooks.length, file).toBeTruthy();
      for (const hook of manifest.hooks || []) {
        expect(pluginsHost.HOOKS, `${file} unknown hook ${hook}`).toContain(hook);
      }
      const entry = path.join(path.dirname(file), manifest.entry || "index.cjs");
      expect(fs.existsSync(entry), entry).toBe(true);
    }
  });

  it("each entry exports the declared hook functions", () => {
    for (const file of files) {
      const dir = path.dirname(file);
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
        hooks: string[];
        entry?: string;
        id?: string;
      };
      const entry = path.join(dir, manifest.entry || "index.cjs");
      const mod = require_(entry) as Record<string, unknown>;
      for (const hook of manifest.hooks) {
        const camel = hook.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const fn = typeof mod[hook] === "function" ? mod[hook] : mod[camel];
        expect(typeof fn, `${manifest.id} missing ${hook}`).toBe("function");
      }
      expect(typeof mod["selfTest"] === "function" || typeof mod["register"] === "function").toBe(
        true,
      );
    }
  });

  it("lists every shipped plugin from appRoot and none are enabled", () => {
    const { items } = capabilities.list({ appRoot: ROOT, workspaceRoot: null });
    const packs = items.filter((item) => item.tree === "plugins");
    expect(packs.length).toBeGreaterThanOrEqual(70);
    expect(packs.every((item) => item.enabled === false)).toBe(true);
  });

  it("turn-complete-log actually writes when dispatched enabled in a workspace copy", async () => {
    const src = path.join(ROOT, "plugins", "installed", "turn-complete-log");
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-cat-"));
    const dest = path.join(workspace, "plugins", "installed", "turn-complete-log");
    fs.cpSync(src, dest, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, "plugin.json"), "utf8"));
    manifest.enabled = true;
    fs.writeFileSync(path.join(dest, "plugin.json"), JSON.stringify(manifest, null, 2));
    const result = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-turn-complete", {
      runId: "catalog-probe",
      ms: 12,
      ok: true,
    });
    expect(result.fired?.some((row) => row.ok)).toBe(true);
    const log = path.join(workspace, "plugins", "data", "turn-complete-log", "turns.ndjson");
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toMatch(/catalog-probe/);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  function enableCopy(slug: string) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-plugin-lib-"));
    const dest = path.join(workspace, "plugins", "installed", slug);
    fs.cpSync(path.join(ROOT, "plugins", "installed", slug), dest, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, "plugin.json"), "utf8"));
    manifest.enabled = true;
    fs.writeFileSync(path.join(dest, "plugin.json"), JSON.stringify(manifest, null, 2));
    return { workspace, dest };
  }

  it("slow-turn-watch records only turns at or above 8s", async () => {
    const { workspace } = enableCopy("slow-turn-watch");
    const fast = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-turn-complete", {
      runId: "fast",
      ms: 20,
      ok: true,
    });
    expect(fast.fired?.some((row) => row.ok)).toBe(true);
    expect(
      fs.existsSync(
        path.join(workspace, "plugins", "data", "slow-turn-watch", "slow-turns.ndjson"),
      ),
    ).toBe(false);
    const slow = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-turn-complete", {
      runId: "slow-one",
      ms: 9000,
      ok: true,
    });
    expect(slow.fired?.some((row) => row.ok)).toBe(true);
    expect(
      fs.readFileSync(
        path.join(workspace, "plugins", "data", "slow-turn-watch", "slow-turns.ndjson"),
        "utf8",
      ),
    ).toMatch(/slow-one/);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  it("git-head-stamp reads .git/HEAD through fs.read", async () => {
    const { workspace } = enableCopy("git-head-stamp");
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/dev-library\n");
    const result = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-app-start", {
      at: Date.now(),
    });
    expect(result.fired?.some((row) => row.ok)).toBe(true);
    const body = fs.readFileSync(
      path.join(workspace, "plugins", "data", "git-head-stamp", "head.json"),
      "utf8",
    );
    expect(body).toMatch(/dev-library/);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  it("secret-filename-watch journals .env names without reading contents", async () => {
    const { workspace } = enableCopy("secret-filename-watch");
    const result = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-file-change", {
      relative: "config/.env.local",
      file: ".env.local",
      at: Date.now(),
    });
    expect(result.fired?.some((row) => row.ok)).toBe(true);
    expect(
      fs.readFileSync(
        path.join(workspace, "plugins", "data", "secret-filename-watch", "hits.ndjson"),
        "utf8",
      ),
    ).toMatch(/\.env\.local/);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  it("os-snapshot-boot writes platform and env key names, not values", async () => {
    const { workspace } = enableCopy("os-snapshot-boot");
    const result = await pluginsHost.dispatch({ workspaceRoot: workspace }, "on-app-start", {
      at: Date.now(),
    });
    expect(result.fired?.some((row) => row.ok)).toBe(true);
    const snap = JSON.parse(
      fs.readFileSync(
        path.join(workspace, "plugins", "data", "os-snapshot-boot", "os.json"),
        "utf8",
      ),
    ) as {
      platform?: string;
      envKeys?: string[];
    };
    expect(String(snap.platform || "").length).toBeGreaterThan(0);
    expect(Array.isArray(snap.envKeys)).toBe(true);
    const raw = fs.readFileSync(
      path.join(workspace, "plugins", "data", "os-snapshot-boot", "os.json"),
      "utf8",
    );
    for (const key of snap.envKeys || []) {
      const value = process.env[key];
      if (value && value.length > 8) expect(raw).not.toContain(value);
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);
});
