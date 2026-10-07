/**
 * Real updater.cjs pipeline: checkAllUpdates (app + manifest), then
 * download → backup → swap → rollbackUpdate. No fake "updated" status.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

type FoundUpdate = {
  kind?: string;
  available?: string;
  channel?: string;
  testBuild?: boolean;
  managedByReleaseChannel?: boolean;
  notes?: string;
  download?: string | null;
};

type ApplyResult = {
  ok?: boolean;
  error?: string;
  backup?: string | null;
  target?: string;
};

const require = createRequire(import.meta.url);
const { checkAllUpdates, applyUpdate, rollbackUpdate } = require("../../electron/updater.cjs") as {
  checkAllUpdates: (input: {
    version: string;
    scan?: Record<string, unknown>;
    appUpdate?: (current: string) => Promise<Record<string, unknown> | null>;
  }) => Promise<{ checkedAt: number; updates: FoundUpdate[] }>;
  applyUpdate: (input: {
    root: string;
    update: Record<string, unknown>;
    onProgress?: (p: { id?: string; phase: string }) => void;
  }) => Promise<ApplyResult>;
  rollbackUpdate: (input: { backup: string; target: string }) => { ok: boolean; error?: string };
};

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-updater-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on("error", reject);
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("checkAllUpdates", () => {
  it("lists the application and a manifest pack from real feeds", async () => {
    const pluginDir = path.join(root, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    const { server, url } = await listen((req, res) => {
      if (req.url === "/feed.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: "2.0.0",
            notes: "plugin notes",
            download: `${url}/pack.tar`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    fs.writeFileSync(
      path.join(pluginDir, "manifest.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo plugin",
        version: "1.0.0",
        updateUrl: `${url}/feed.json`,
      }),
    );

    const result = await checkAllUpdates({
      version: "1.0.0.2",
      scan: {
        root,
        plugins: [
          {
            id: "demo",
            name: "Demo plugin",
            version: "1.0.0",
            manifestFile: path.join(pluginDir, "manifest.json"),
          },
        ],
      },
      appUpdate: async () => ({
        available: "1.0.0.3",
        channel: "stable",
        testBuild: false,
        notes: "app notes",
      }),
    });
    await closeServer(server);

    const kinds = result.updates.map((u) => u.kind);
    expect(kinds).toContain("application");
    expect(kinds).toContain("plugin");
    const app = result.updates.find((u) => u.kind === "application");
    expect(app?.available).toBe("1.0.0.3");
    expect(app?.channel).toBe("stable");
    expect(app?.testBuild).toBe(false);
    expect(app?.managedByReleaseChannel).toBe(true);
    const plugin = result.updates.find((u) => u.kind === "plugin");
    expect(plugin?.available).toBe("2.0.0");
    expect(plugin?.notes).toBe("plugin notes");
    expect(plugin?.download).toContain("/pack.tar");
  });

  it("does not offer an application update when compareBuilds says it is not newer", async () => {
    const result = await checkAllUpdates({
      version: "1.0.0.2",
      scan: { root, plugins: [] },
      appUpdate: async () => ({
        available: "1.0.0",
        channel: "stable",
        testBuild: false,
        notes: "npm encoding of the same line",
      }),
    });
    expect(result.updates.filter((u) => u.kind === "application")).toHaveLength(0);
  });
});

describe("applyUpdate download → backup → swap → rollback", () => {
  it("replaces a plugin from a real archive and can restore the backup", async () => {
    const pluginDir = path.join(root, "plugins", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "marker.txt"), "old");
    fs.writeFileSync(
      path.join(pluginDir, "manifest.json"),
      JSON.stringify({ id: "demo", version: "1.0.0" }),
    );

    const staging = path.join(root, "src-pack");
    fs.mkdirSync(path.join(staging, "demo"), { recursive: true });
    fs.writeFileSync(path.join(staging, "demo", "marker.txt"), "new");
    fs.writeFileSync(
      path.join(staging, "demo", "manifest.json"),
      JSON.stringify({ id: "demo", version: "2.0.0" }),
    );
    const archive = path.join(root, "pack.tar");
    execFileSync("tar", ["-cf", archive, "-C", staging, "demo"]);

    const { server, url } = await listen((req, res) => {
      if (req.url === "/pack.tar") {
        const buf = fs.readFileSync(archive);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": buf.length,
        });
        res.end(buf);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const phases: string[] = [];
    const applied = await applyUpdate({
      root,
      update: {
        kind: "plugin",
        id: "demo",
        available: "2.0.0",
        download: `${url}/pack.tar`,
      },
      onProgress: (p) => phases.push(p.phase),
    });
    await closeServer(server);

    expect(applied.ok).toBe(true);
    expect(applied.backup).toBeTruthy();
    expect(fs.readFileSync(path.join(pluginDir, "marker.txt"), "utf8")).toBe("new");
    expect(phases).toContain("Downloading");
    expect(phases).toContain("Backing up");
    expect(phases).toContain("Installing");

    const rolled = rollbackUpdate({
      backup: String(applied.backup),
      target: String(applied.target),
    });
    expect(rolled.ok).toBe(true);
    expect(fs.readFileSync(path.join(pluginDir, "marker.txt"), "utf8")).toBe("old");
  });

  it("returns a real error when the download URL is missing", async () => {
    const result = await applyUpdate({
      root,
      update: { kind: "plugin", id: "demo", available: "2.0.0" },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/download URL/i);
  });
});
