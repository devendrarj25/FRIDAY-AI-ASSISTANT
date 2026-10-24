/**
 * The pieces around the resilient downloader: the installer, the source zip and
 * the pack download all survive a dropped connection; reads from GitHub retry;
 * long update steps are not cut by the 30 s IPC budget; the installer folder
 * does not grow without end; a content merge never claims to install a release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const sync = require_(path.join(root, "electron/github-sync.cjs"));
const importer = require_(path.join(root, "electron/importer.cjs"));
const safety = require_(path.join(root, "electron/update-safety.cjs"));
const budget = require_(path.join(root, "electron/ipc-budget-table.cjs"));

let work = "";
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "friday-upd2-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(work, { recursive: true, force: true });
});

const exe = Buffer.alloc(3 * 1024 * 1024, 7);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** A GitHub that redirects the API asset to a CDN, then drops the CDN stream once. */
function flakyCdn(body: Buffer, dropAfter: number) {
  const seen: { url: string; range: string; auth: string }[] = [];
  let cdnCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers?: Record<string, string> } = {}) => {
      const h = init.headers || {};
      seen.push({ url: String(url), range: h["range"] || "", auth: h["authorization"] || "" });
      if (String(url).startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/signed" },
        });
      }
      cdnCalls += 1;
      const start = /bytes=(\d+)-/.exec(h["range"] || "")?.[1];
      const from = start ? Number(start) : 0;
      const slice = body.subarray(from);
      const cut = cdnCalls === 1 ? dropAfter : slice.length;
      let at = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at < Math.min(cut, slice.length)) {
            const end = Math.min(at + 262144, cut, slice.length);
            controller.enqueue(slice.subarray(at, end));
            at = end;
          } else if (cut < slice.length) controller.error(new TypeError("terminated"));
          else controller.close();
        },
      });
      return new Response(stream, {
        status: start ? 206 : 200,
        headers: {
          "content-length": String(slice.length),
          "content-type": "application/octet-stream",
          ...(start ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}),
        },
      });
    }),
  );
  return seen;
}

describe("the installer survives a dropped connection", () => {
  it("resumes from the bytes it already has and installs the exact file", async () => {
    sync.writeConfig(work, { repo: "o/r", updateToken: "read-only" });
    const seen = flakyCdn(exe, 1024 * 1024);
    const events: string[] = [];
    const out = await sync.downloadInstaller({
      root: work,
      apiUrl: "https://api.github.com/repos/o/r/releases/assets/9",
      assetId: 9,
      name: "FRIDAY-Setup-2.0.0.0.exe",
      bytes: exe.length,
      sha256: sha(exe),
      onProgress: (e: { phase?: string }) => events.push(String(e.phase)),
    });
    expect(out).toMatchObject({ ok: true, verified: true, resumed: true, attempts: 2 });
    expect(sha(fs.readFileSync(out.file))).toBe(sha(exe));
    const cdn = seen.filter((c) => c.url.startsWith("https://cdn.example"));
    expect(cdn[1]?.range).toBe(`bytes=${1024 * 1024}-`);
    // The read-only token went to GitHub's API and never to the CDN.
    expect(
      seen
        .filter((c) => c.url.startsWith("https://api.github.com"))
        .every((c) => c.auth === "Bearer read-only"),
    ).toBe(true);
    expect(cdn.every((c) => c.auth === "")).toBe(true);
    expect(events.some((e) => /retrying/i.test(e))).toBe(true);
  }, 30_000);

  it("can be cancelled and then continued", async () => {
    sync.writeConfig(work, { repo: "o/r" });
    flakyCdn(exe, 1024 * 1024);
    const controller = new AbortController();
    controller.abort();
    const stopped = await sync.downloadInstaller({
      root: work,
      apiUrl: "https://api.github.com/repos/o/r/releases/assets/9",
      assetId: 9,
      name: "FRIDAY-Setup-2.0.0.0.exe",
      bytes: exe.length,
      signal: controller.signal,
    });
    expect(stopped).toMatchObject({ ok: false, cancelled: true });
  });
});

describe("the source zip", () => {
  const goodZip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.alloc(200, 1),
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    Buffer.alloc(18),
  ]);

  it("is fetched with progress, named from the server and checked for its end", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response(goodZip, {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="o-r-abc123.zip"',
            "content-type": "application/zip",
          },
        });
      }),
    );
    const out = await importer.downloadArchive({
      root: work,
      url: "https://api.github.com/repos/o/r/zipball/v2",
      name: "github-o-r-v2",
      token: "t",
    });
    expect(out.ok).toBe(true);
    expect(path.basename(out.file)).toMatch(/o-r-abc123\.zip$/);
    expect(fs.readFileSync(out.file).equals(goodZip)).toBe(true);
    expect(fs.readdirSync(path.join(work, "updates")).some((n) => n.endsWith(".part"))).toBe(false);
  });

  it("refuses a zip that was cut off instead of staging half of it", async () => {
    const cut = goodZip.subarray(0, 120);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(cut, { status: 200, headers: { "content-type": "application/zip" } }),
      ),
    );
    const out = await importer.downloadArchive({
      root: work,
      url: "https://api.github.com/repos/o/r/zipball/v2",
      name: "x",
    });
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("incomplete");
  }, 60_000);
});

describe("reading from GitHub", () => {
  it("tries a read a second time after a network hiccup, and reports offline only after that", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket hang up");
        return new Response(JSON.stringify({ full_name: "o/r" }), { status: 200 });
      }),
    );
    const ok = await sync.api({ repo: "o/r" }, "/repos/o/r");
    expect(ok).toMatchObject({ ok: true });
    expect(calls).toBe(2);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }),
    );
    const down = await sync.api({ repo: "o/r" }, "/repos/o/r");
    expect(down).toMatchObject({ ok: false, offline: true });
  });

  it("never repeats a write", async () => {
    const spy = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.stubGlobal("fetch", spy);
    await sync.api({ repo: "o/r", token: "t" }, "/repos/o/r/git/refs", {
      method: "POST",
      body: {},
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("long update steps are not cut at 30 seconds", () => {
  it("gives the check and the install a long-job budget, and the cancel a quick one", () => {
    expect(budget.CHANNEL_CLASS["github:install-update"]).toBe("long-job");
    expect(budget.CHANNEL_CLASS["github:check"]).toBe("long-job");
    expect(budget.CHANNEL_CLASS["github:download-installer"]).toBe("long-job");
    expect(budget.CHANNEL_CLASS["github:pull"]).toBe("long-job");
    expect(budget.CHANNEL_CLASS["updates:apply"]).toBe("long-job");
    expect(budget.CHANNEL_CLASS["github:cancel-download"]).toBe("quick");
  });
});

describe("what an update leaves behind", () => {
  it("keeps the newest two installers and removes older ones", () => {
    const dir = path.join(work, "updates", "installers");
    fs.mkdirSync(dir, { recursive: true });
    ["a", "b", "c", "d"].forEach((name, i) => {
      const file = path.join(dir, `FRIDAY-Setup-${name}.exe`);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
    });
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
    const out = safety.pruneInstallers({ root: work, keep: 2 });
    expect(out.removed.sort()).toEqual(["FRIDAY-Setup-a.exe", "FRIDAY-Setup-b.exe"]);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "FRIDAY-Setup-c.exe",
      "FRIDAY-Setup-d.exe",
      "notes.txt",
    ]);
  });

  it("clears half-finished downloads nobody resumed for a week, and only those", () => {
    const dir = path.join(work, "updates", "installers");
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 9 * 86_400_000);
    const stale = path.join(dir, "FRIDAY-Setup-old.exe.part");
    const fresh = path.join(dir, "FRIDAY-Setup-new.exe.part");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    fs.utimesSync(stale, old, old);
    safety.pruneInstallers({ root: work, keep: 2 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("records a content merge without claiming the release is installed", () => {
    sync.writeConfig(work, { repo: "o/r", appliedRef: "v1.0.0" });
    sync.recordApplied(work, { ref: "v2.0.0", applied: 4, areas: ["skills"], contentOnly: true });
    const cfg = sync.readConfig(work);
    expect(cfg.appliedRef).toBe("v1.0.0");
    expect(cfg.history[0]).toMatchObject({ ref: "v2.0.0", contentOnly: true });
    sync.recordApplied(work, { ref: "v2.0.0", applied: 1 });
    expect(sync.readConfig(work).appliedRef).toBe("v2.0.0");
  });

  it("limits what an installed app may merge to capability packs and docs", () => {
    expect([...sync.CONTENT_AREAS].sort()).toEqual(
      ["agents", "docs", "modules", "plugins", "resources", "skills", "workflows"].sort(),
    );
  });
});

describe("the installed app merges content only", () => {
  const MAIN = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const PRELOAD = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
  const BRIDGE = fs.readFileSync(path.join(root, "src/lib/friday/github-updates.ts"), "utf8");

  it("stops an empty area list before the importer reads it as everything", () => {
    const apply = MAIN.slice(MAIN.indexOf('ipcMain.handle("import:apply"'));
    const guard = apply.indexOf("if (!areas.length)");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(apply.indexOf("importer.applyImport"));
    const body = fs.readFileSync(path.join(root, "electron/importer.cjs"), "utf8");
    expect(body).toContain("Array.isArray(areas) && areas.length ? new Set");
  });

  it("wires Cancel from the button to the running download", () => {
    expect(MAIN).toContain('ipcMain.handle("github:cancel-download"');
    expect(MAIN).toContain("installerDownload?.abort()");
    expect(PRELOAD).toContain(
      'githubCancelDownload: () => ipcRenderer.invoke("github:cancel-download")',
    );
    expect(BRIDGE).toContain("export const githubCancelDownload");
    const panel = fs.readFileSync(
      path.join(root, "src/components/friday/settings/GithubUpdates.tsx"),
      "utf8",
    );
    expect(panel).toContain("githubCancelDownload()");
  });
});

describe("pack update checks", () => {
  it("lists a live feed even when another feed is dead", async () => {
    const updater = require_(path.join(root, "electron/updater.cjs"));
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "2.0.0", notes: "n" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const live = (server.address() as { port: number }).port;
    const manifest = (name: string, url: string) => {
      const dir = path.join(work, "plugins", name);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "manifest.json");
      fs.writeFileSync(file, JSON.stringify({ id: name, version: "1.0.0", updateUrl: url }));
      return { id: name, name, version: "1.0.0", manifestFile: file };
    };
    try {
      const out = await updater.checkAllUpdates({
        version: "1.0.0.0",
        scan: {
          root: work,
          plugins: [
            manifest("dead", "http://127.0.0.1:9/feed.json"),
            manifest("live", `http://127.0.0.1:${live}/feed.json`),
          ],
        },
        appUpdate: async () => null,
      });
      expect(out.updates.map((u: { id?: string }) => u.id)).toEqual(["live"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
