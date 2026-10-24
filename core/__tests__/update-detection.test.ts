/**
 * Seeing an update: the connection survives a restart, FRIDAY looks at start-up
 * and says so even with the Updates panel closed, GitHub's answers are used
 * sparingly and honestly, and the download shows size, speed and time left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describeTransfer } from "../../src/lib/friday/github-updates";

const require_ = createRequire(import.meta.url);
const src = (rel: string) =>
  fs.readFileSync(path.resolve(import.meta.dirname, "../..", rel), "utf8");
const sync = require_(path.resolve(import.meta.dirname, "../../electron/github-sync.cjs"));

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-detect-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the repository stays connected across a restart", () => {
  it("keeps the address and watches it again after the app is reopened", () => {
    sync.writeConfig(root, { repo: "https://github.com/o/r.git", updateToken: "ro-token" });
    // A new process reads the same files: address on disk, token in the encrypted store.
    const reopened = sync.readConfig(root);
    expect(reopened.repo).toBe("o/r");
    expect(reopened.updateToken).toBe("ro-token");
    expect(reopened.autoCheck).toBe(true);
    expect(fs.readFileSync(path.join(root, "config", "github.json"), "utf8")).not.toContain(
      "ro-token",
    );
  });

  it("honours an owner who switched checking off", () => {
    sync.writeConfig(root, { repo: "o/r", autoCheck: false });
    expect(sync.readConfig(root).autoCheck).toBe(false);
  });

  it("reconnects at launch and checks once soon after, then on the interval", () => {
    const main = src("electron/main.cjs");
    expect(main).toContain('id: "github-reconnect"');
    expect(main).toContain("async function runGithubCheck()");
    const scheduler = main.slice(main.indexOf("function scheduleGithubChecks()"));
    expect(scheduler.slice(0, 1600)).toContain("sinceLast >= 30 * 60_000");
    expect(scheduler.slice(0, 1600)).toContain("setTimeout(() => void runGithubCheck(), 15_000)");
    expect(scheduler.slice(0, 1600)).toContain("setInterval(() => void runGithubCheck(), every)");
    // Notify-only for an installed app: background polling never installs.
    const check = main.slice(main.indexOf("async function runGithubCheck()"));
    const guard = check.indexOf('if (app.isPackaged || result.channel === "release") {');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(check.indexOf("importer.applyImport"));
    expect(check.slice(guard, guard + 160)).toContain("await stageInBackground(root, result);");
  });

  it("asks GitHub itself when the panel opens before the start-up reconnect finished", () => {
    const panel = src("src/components/friday/settings/GithubUpdates.tsx");
    expect(panel).toContain('snapshot.state === "unknown"');
  });

  it("tells the owner about a new version even when Settings is not open", () => {
    const wiring = src("src/lib/friday/notification-wiring.ts");
    expect(wiring).toContain("onGithubUpdate((check) =>");
    expect(wiring).toContain("Nothing is installed without your go-ahead.");
  });
});

describe("GitHub is asked sparingly and answers honestly", () => {
  const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
    new Response(JSON.stringify(body), { status: 200, ...init });

  it("asks again with the ETag and reuses the answer GitHub says has not changed", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers?: Record<string, string> } = {}) => {
        const sent = init.headers?.["if-none-match"] ?? null;
        seen.push(sent);
        return sent === '"v1"'
          ? new Response(null, { status: 304 })
          : json({ full_name: "o/r" }, { headers: { etag: '"v1"' } });
      }),
    );
    const cfg = { repo: "o/r", token: "t" };
    const first = await sync.api(cfg, "/repos/o/r/etag-case");
    const second = await sync.api(cfg, "/repos/o/r/etag-case");
    expect(first.body.full_name).toBe("o/r");
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(second.body.full_name).toBe("o/r");
    expect(seen).toEqual([null, '"v1"']);
    // A different token never reuses another token's ETag.
    await sync.api({ repo: "o/r", token: "other" }, "/repos/o/r/etag-case");
    expect(seen.at(-1)).toBeNull();
  });

  it("calls an exhausted request limit what it is, with the reset time, not a bad token", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4" }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
          }),
      ),
    );
    const out = await sync.api({ repo: "o/r" }, "/repos/o/r/limit-case");
    expect(out).toMatchObject({ ok: false, status: 403, rateLimited: true });
    expect(out.resetAt).toBe(reset * 1000);
    expect(out.error).toContain("rate limit");
    expect(out.error).toContain("read-only token raises the limit");
    expect(out.error).not.toMatch(/Read and write|Actions/);
  });

  it("keeps the connection and says 'rate limit', not 'sign in again', while rate-limited", async () => {
    sync.writeConfig(root, { repo: "o/r", updateToken: "ro" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "rate limit" }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          }),
      ),
    );
    const state = await sync.connect(root);
    expect(state.state).toBe("offline");
    expect(state.message).toContain("rate limit");
    // The stored credential is still there.
    expect(sync.readConfig(root).updateToken).toBe("ro");
  });

  it("names the read-only permission when the update token is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      ),
    );
    const out = await sync.api({ repo: "o/r", token: "x", readOnly: true }, "/repos/o/r/auth-case");
    expect(out.error).toContain("Bad credentials");
    expect(out.error).toContain("Contents: Read-only");
  });
});

describe("the download shows size, speed and time left", () => {
  it("writes only the parts it knows", () => {
    expect(describeTransfer(null)).toBe("");
    expect(describeTransfer({ phase: "Downloading", received: 5 * 1048576 })).toBe("5.0 MB");
    expect(
      describeTransfer({
        phase: "Downloading",
        received: 42 * 1048576,
        total: 180 * 1048576,
        speedBps: 3.2 * 1048576,
        etaSeconds: 43,
      }),
    ).toBe("42 MB of 180 MB · 3.2 MB/s · about 43 s left");
    expect(
      describeTransfer({
        phase: "Downloading",
        received: 1.2 * 1073741824,
        total: 2 * 1073741824,
        speedBps: 8 * 1048576,
        etaSeconds: 200,
      }),
    ).toBe("1.20 GB of 2.00 GB · 8.0 MB/s · about 3 min left");
  });

  it("does not promise a time when the speed is unknown, and shows no time at the end", () => {
    expect(
      describeTransfer({ phase: "x", received: 10, total: 100, speedBps: 0, etaSeconds: 5 }),
    ).toBe("10 B of 100 B");
    expect(
      describeTransfer({ phase: "x", received: 100, total: 100, speedBps: 50, etaSeconds: 0 }),
    ).toBe("100 B of 100 B · 50 B/s");
  });

  it("draws it under the bar for the installer, the source zip and packs", () => {
    const panel = src("src/components/friday/settings/GithubUpdates.tsx");
    expect(panel).toContain("describeTransfer(progress)");
    expect(panel).toContain("speedBps");
    // The source zip pull reports on the same channel the installer uses.
    const main = src("electron/main.cjs");
    const pull = main.slice(main.indexOf('ipcMain.handle("github:pull"'));
    expect(pull.slice(0, 1500)).toContain('send("github:download-progress", progress)');
  });
});

describe("the new installer is fetched ahead of time, and only fetched", () => {
  const main = src("electron/main.cjs");
  const staging = main.slice(main.indexOf("async function stageInBackground("));

  it("is on by default and can be switched off", () => {
    expect(sync.readConfig(root).autoDownload).toBe(true);
    sync.writeConfig(root, { repo: "o/r", autoDownload: false });
    expect(sync.readConfig(root).autoDownload).toBe(false);
    const panel = src("src/components/friday/settings/GithubUpdates.tsx");
    expect(panel).toContain("Download new versions in the background");
    expect(panel).toContain("autoDownload: !config.autoDownload");
  });

  it("never fetches a TEST build, never interrupts the owner's own download, never installs", () => {
    const body = staging.slice(0, staging.indexOf("/** One background look"));
    expect(body).toContain("if (live.autoDownload === false) return;");
    expect(body).toContain("if (result.testBuild ||");
    expect(body).toContain("if (installerDownload) return;");
    expect(body).not.toContain("install-update");
    expect(body).not.toContain("installerLaunch");
    // Only a verified file is announced as ready.
    expect(body).toContain("staged?.ok && staged.verified");
  });

  it("shares one download path with the button, which takes over a background download", () => {
    expect(main).toContain("async function stageInstaller(");
    const button = main.slice(main.indexOf('ipcMain.handle("github:download-installer"'));
    expect(button.slice(0, 1800)).toContain("installerDownload?.abort();");
    expect(button.slice(0, 1800)).toContain("await stageInstaller(");
    const check = main.slice(main.indexOf("async function runGithubCheck()"));
    expect(check.slice(0, 900)).toContain("await stageInBackground(root, result);");
  });

  it("tells the owner when the installer is already waiting", () => {
    expect(src("src/lib/friday/notification-wiring.ts")).toContain(
      "Downloaded and checked in the background",
    );
    expect(src("src/components/friday/settings/GithubUpdates.tsx")).toContain(
      "The installer is already downloaded and checked",
    );
  });
});
