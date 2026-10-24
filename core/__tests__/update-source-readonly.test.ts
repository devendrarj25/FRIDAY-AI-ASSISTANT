/**
 * Settings → Updates connects to the repository to READ: releases, installers
 * and the source zip. It has its own token (github.update.token) that can be
 * read-only; Friday Hub's write token stays separate. No network here: GitHub
 * is a stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const sync = require_(path.join(root, "electron/github-sync.cjs"));
const credentials = require_(path.join(root, "electron/credentials.cjs"));

let work = "";
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "friday-upd-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(work, { recursive: true, force: true });
});

type Seen = { url: string; method: string; auth: string };

function stubGithub(opts: { push?: boolean; private?: boolean; releases?: unknown[] }) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      seen.push({
        url: String(url),
        method: init.method || "GET",
        auth: init.headers?.["authorization"] || "",
      });
      const body = String(url).includes("/releases")
        ? (opts.releases ?? [])
        : {
            full_name: "owner/repo",
            private: opts.private ?? false,
            default_branch: "main",
            pushed_at: "2026-10-01T00:00:00Z",
            permissions: { push: Boolean(opts.push), pull: true },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return seen;
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: false,
  published_at: "2026-10-02T00:00:00Z",
  assets: [{ id: 1, name: `FRIDAY-Setup-${tag}.exe`, size: 5, browser_download_url: "https://x" }],
  ...extra,
});

describe("the update token is its own credential", () => {
  it("is stored apart from the Hub token and never leaves the main process in the public config", () => {
    sync.writeConfig(work, { repo: "owner/repo", token: "hub-write", updateToken: "upd-read" });
    expect(credentials.getSecret(work, sync.TOKEN_ID)).toBe("hub-write");
    expect(credentials.getSecret(work, sync.UPDATE_TOKEN_ID)).toBe("upd-read");
    const cfg = sync.readConfig(work);
    expect(cfg.token).toBe("hub-write");
    expect(cfg.updateToken).toBe("upd-read");
    const pub = sync.publicConfig(cfg);
    expect(JSON.stringify(pub)).not.toContain("upd-read");
    expect(JSON.stringify(pub)).not.toContain("hub-write");
    expect(pub).toMatchObject({ hasToken: true, hasUpdateToken: true, updateTokenShared: false });
    expect(fs.readFileSync(sync.configFile(work), "utf8")).not.toContain("upd-read");
  });

  it("clears only the update token when asked, and reports a shared token honestly", () => {
    sync.writeConfig(work, { repo: "owner/repo", token: "hub-write", updateToken: "upd-read" });
    sync.writeConfig(work, { updateToken: null });
    const pub = sync.publicConfig(sync.readConfig(work));
    expect(pub).toMatchObject({ hasToken: true, hasUpdateToken: false, updateTokenShared: true });
  });

  it("makes the update path use the update token first and fall back to the Hub token", () => {
    expect(sync.updateCfg({ token: "hub", updateToken: "upd" })).toMatchObject({
      token: "upd",
      tokenKind: "update",
      readOnly: true,
    });
    expect(sync.updateCfg({ token: "hub" })).toMatchObject({ token: "hub", tokenKind: "shared" });
    expect(sync.updateCfg({})).toMatchObject({ token: "", tokenKind: "none", readOnly: true });
  });
});

describe("the update connection only reads", () => {
  it("refuses any write sent through a read-only config", async () => {
    const seen = stubGithub({});
    const out = await sync.api(
      sync.updateCfg({ repo: "owner/repo", updateToken: "t" }),
      "/repos/owner/repo/git/refs",
      { method: "POST", body: { ref: "refs/heads/x" } },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("read-only");
    expect(seen).toHaveLength(0);
  });

  it("tests a private repository with the update token and reports a read-only scope", async () => {
    sync.writeConfig(work, {
      repo: "https://github.com/owner/repo",
      token: "hub-write",
      updateToken: "upd-read",
    });
    const seen = stubGithub({
      private: true,
      push: false,
      releases: [
        release("v1.2.0"),
        release("v1.3.0-test.1", { prerelease: true }),
        release("v1.1.0"),
      ],
    });
    const out = await sync.testUpdateSource(work);
    expect(out).toMatchObject({
      ok: true,
      private: true,
      tokenKind: "update",
      tokenScope: "read-only",
      readOnly: true,
    });
    expect(out.latestOfficial.tag).toBe("v1.2.0");
    expect(out.latestTest.tag).toBe("v1.3.0-test.1");
    expect(seen.every((call) => call.method === "GET")).toBe(true);
    expect(seen.every((call) => call.auth === "Bearer upd-read")).toBe(true);
  });

  it("warns when the token could also write, and when it is the shared Hub token", async () => {
    sync.writeConfig(work, { repo: "owner/repo", token: "hub-write" });
    stubGithub({ private: true, push: true, releases: [release("v1.0.0")] });
    const out = await sync.testUpdateSource(work);
    expect(out).toMatchObject({
      tokenKind: "shared",
      tokenScope: "write-capable",
      readOnly: false,
    });
    expect(out.warning).toContain("same token as Friday Hub");
  });

  it("needs no token for a public repository and says what to do for a private one", async () => {
    sync.writeConfig(work, { repo: "owner/repo" });
    stubGithub({ private: false, releases: [release("v1.0.0")] });
    const pub = await sync.testUpdateSource(work);
    expect(pub).toMatchObject({ ok: true, authenticated: false, tokenScope: "none" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
    );
    const hidden = await sync.testUpdateSource(work);
    expect(hidden.ok).toBe(false);
    expect(hidden.error).toContain("Contents: Read-only");
  });

  it("reports an offline GitHub as offline, not as a bad token", async () => {
    sync.writeConfig(work, { repo: "owner/repo", updateToken: "upd-read" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }),
    );
    const out = await sync.testUpdateSource(work);
    expect(out).toMatchObject({ ok: false, offline: true });
    expect(credentials.getSecret(work, sync.UPDATE_TOKEN_ID)).toBe("upd-read");
  });
});

describe("what a release contains is recognised", () => {
  it("names each kind of published file and what FRIDAY does with it", () => {
    const kind = (name: string) => sync.classifyAsset(name);
    expect(kind("FRIDAY-Setup-1.1.4.0.exe")).toMatchObject({
      kind: "installer",
      installable: true,
    });
    expect(kind("FRIDAY-Portable-1.1.4.0.exe")).toMatchObject({
      kind: "portable",
      installable: true,
    });
    expect(kind("friday-update.json").kind).toBe("update-manifest");
    expect(kind("SHA256SUMS.txt").kind).toBe("checksums");
    expect(kind("latest.yml").kind).toBe("updater-metadata");
    expect(kind("CHANGELOG.md").kind).toBe("notes");
    expect(kind("FRIDAY-source.zip").kind).toBe("source-archive");
    expect(kind("random.bin")).toMatchObject({ kind: "other", installable: false });
    for (const name of ["friday-update.json", "SHA256SUMS.txt", "latest.yml", "random.bin"]) {
      expect(kind(name).installable, name).toBe(false);
      expect(kind(name).purpose.length, name).toBeGreaterThan(20);
    }
  });

  it("lists the full source zip next to the published files", () => {
    const files = sync.describeFiles(
      [sync.mapReleaseAsset({ id: 1, name: "FRIDAY-Setup-1.0.0.exe", size: 9 })],
      "https://api.github.com/repos/o/r/zipball/v1.0.0",
    );
    expect(files.map((f: { kind: string }) => f.kind)).toEqual(["installer", "source-zip"]);
    expect(files[1].purpose).toContain("merges it into a source checkout");
    expect(files[1].purpose).toContain("installed app updates through the installer");
    expect(files[1].purpose).toContain("never touched");
  });

  it("a checked release carries those files for the panel", async () => {
    sync.writeConfig(work, { repo: "owner/repo", channel: "release", updateToken: "t" });
    stubGithub({ releases: [release("v2.0.0")] });
    const out = await sync.checkUpdate(work, { currentVersion: "1.0.0", channel: "release" });
    expect(out.ok).toBe(true);
    expect(out.updateAvailable).toBe(true);
    expect(out.files.map((f: { kind: string }) => f.kind)).toContain("source-zip");
  });
});

describe("the panel", () => {
  const panel = fs.readFileSync(
    path.join(root, "src/components/friday/settings/GithubUpdates.tsx"),
    "utf8",
  );
  const guide = fs.readFileSync(
    path.join(root, "src/components/friday/settings/UpdateGuide.tsx"),
    "utf8",
  );
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

  it("saves the read-only token under its own name and asks for Contents: Read-only", () => {
    expect(panel).toContain("updateToken");
    expect(panel).toContain("Contents: Read-only");
    expect(panel).toContain("Read-only access token");
    expect(panel).toContain("Use the official FRIDAY repository");
    expect(panel).toContain("PROJECT_IDENTITY.repository");
    expect(main).toContain('["token", "updateToken"]');
    expect(main).toContain("githubSync.testUpdateSource(");
  });

  it("shows the guide and the per-file purposes", () => {
    expect(panel).toContain("<UpdateGuide />");
    expect(panel).toContain("<ReleaseFiles files={check.files} />");
    expect(guide).toContain("How updates work");
    expect(guide).toContain("Contents: Read-only");
    expect(guide).toContain("never touched");
    expect(guide).toContain("restore the backup");
  });
});

describe("installing a downloaded update", () => {
  const safety = require_(path.join(root, "electron/update-safety.cjs"));
  const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

  it("runs the installer silently in place and always ends with FRIDAY open", () => {
    expect(safety.SILENT_UPDATE_ARGS).toEqual(["/S", "--updated", "--force-run"]);
    const launch = safety.installerLaunch({
      file: "C:\\Users\\Dev One\\FRIDAY-Setup-1.1.4.0.exe",
      appExe: "D:\\FRIDAY\\App\\FRIDAY.exe",
      platform: "win32",
    });
    expect(launch.command).toBe("cmd.exe");
    const line = launch.args[3] as string;
    expect(line).toContain(
      'start "" /wait "C:\\Users\\Dev One\\FRIDAY-Setup-1.1.4.0.exe" /S --updated --force-run',
    );
    // A failed installer reopens the app that is still installed.
    expect(line).toContain('|| start "" "D:\\FRIDAY\\App\\FRIDAY.exe"');
    expect(launch.options).toMatchObject({ detached: true, windowsVerbatimArguments: true });
  });

  it("falls back to a direct silent start when a path cannot be quoted, and never launches off Windows", () => {
    for (const bad of ['C:\\a"b.exe', "C:\\100%.exe", "C:\\a&b.exe"]) {
      expect(safety.installerLaunch({ file: bad, platform: "win32" })).toBeNull();
    }
    expect(safety.installerLaunch({ file: "x.exe", platform: "linux" })).toBeNull();
    expect(main).toContain("updateSafety.SILENT_UPDATE_ARGS");
    expect(main).not.toMatch(/spawn\(file, \[\], \{/);
  });

  it("verifies, backs up the protected folders and records the update before it launches", () => {
    const install = main.slice(main.indexOf('ipcMain.handle("github:install-update"'));
    const order = [
      "updateSafety.verifyArtifact(",
      "await stopKernel()",
      "updateSafety.backupStateAsync(",
      "updateSafety.beginInstall(",
      "updateSafety.installerLaunch(",
      'life.requestShutdown("installer"',
    ].map((needle) => install.indexOf(needle));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps every user folder in the must-preserve list", () => {
    for (const name of [
      "config",
      "memory",
      "conversations",
      "models",
      "voices",
      "downloads",
      "database",
    ]) {
      expect(safety.MUST_PRESERVE, name).toContain(name);
    }
  });
});
