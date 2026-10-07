/**
 * FRIDAY · installer download
 *
 * Two rules this defends:
 *   • the download reports real progress and refuses a checksum mismatch;
 *   • the checksum is always read from the manifest of the release the asset
 *     belongs to — a Stable ⇄ Test download re-reads that channel.
 *   • bytes land in a .part file and only replace the destination after verify.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const sync = require_(path.resolve(process.cwd(), "electron/github-sync.cjs"));
const MAIN = fs.readFileSync(path.resolve(process.cwd(), "electron/main.cjs"), "utf8");

let root = "";
const payload = Buffer.alloc(2 * 1024 * 1024, 9);
const digest = crypto.createHash("sha256").update(payload).digest("hex");
const destPath = () => path.join(root, "updates", "installers", "FRIDAY-Setup-9.9.9.exe");

const respond = (body: Buffer = payload, status = 200, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(body), {
    status,
    headers: { "content-length": String(body.length), ...headers },
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-dl-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("downloading a release installer", () => {
  it("streams progress and keeps a matching artifact", async () => {
    const seen: number[] = [];
    const result = await sync.downloadInstaller({
      root,
      url: "https://example.invalid/FRIDAY-Setup-9.9.9.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: digest,
      onProgress: (p: { percent?: number }) => {
        if (typeof p.percent === "number") seen.push(p.percent);
      },
    });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(fs.existsSync(result.file)).toBe(true);
    expect(fs.existsSync(`${destPath()}.part`)).toBe(false);
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBe(100);
  });

  it("deletes a download whose checksum does not match the release", async () => {
    const result = await sync.downloadInstaller({
      root,
      url: "https://example.invalid/FRIDAY-Setup-9.9.9.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: "deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/checksum/i);
    expect(fs.existsSync(destPath())).toBe(false);
    expect(fs.existsSync(`${destPath()}.part`)).toBe(false);
  });

  it("never touches owner config or database when a download fails verify", async () => {
    const config = path.join(root, "config", "settings.json");
    const database = path.join(root, "database", "friday.sqlite3");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(config, '{"voice":"swara"}');
    fs.writeFileSync(database, "owner-bytes");

    const result = await sync.downloadInstaller({
      root,
      url: "https://example.invalid/FRIDAY-Setup-9.9.9.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: "deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(config, "utf8")).toBe('{"voice":"swara"}');
    expect(fs.readFileSync(database, "utf8")).toBe("owner-bytes");
    expect(fs.existsSync(path.join(root, "updates", "installers"))).toBe(true);
  });

  it("does not replace a valid installer when a later download fails verification", async () => {
    const first = await sync.downloadInstaller({
      root,
      url: "https://example.invalid/FRIDAY-Setup-9.9.9.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: digest,
    });
    expect(first.ok).toBe(true);
    const original = fs.readFileSync(destPath());

    const bad = Buffer.alloc(2 * 1024 * 1024, 3);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(bad)),
    );
    const second = await sync.downloadInstaller({
      root,
      url: "https://example.invalid/FRIDAY-Setup-9.9.9.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: digest,
    });
    expect(second.ok).toBe(false);
    expect(fs.readFileSync(destPath()).equals(original)).toBe(true);
  });

  it("refuses a GitHub HTML response instead of treating it as an EXE", async () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>Sign in</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond(html, 200, { "content-type": "text/html; charset=utf-8" })),
    );
    const result = await sync.downloadInstaller({
      root,
      url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/v1.7.1/FRIDAY-Setup-1.7.1.exe",
      name: "FRIDAY-Setup-9.9.9.exe",
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/web page/i);
    expect(fs.existsSync(destPath())).toBe(false);
  });

  it("prefers the GitHub API asset URL and keeps the token off the CDN", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), auth: headers.get("authorization") });
        if (String(url).includes("api.github.com")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://objects.githubusercontent.com/friday-setup.exe" },
          });
        }
        return respond();
      }),
    );
    sync.writeConfig(root, { repo: "devendrarj25/FRIDAY-AI-ASSISTANT", token: "ghp_test_token" });
    const result = await sync.downloadInstaller({
      root,
      url: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/v9.9.9/FRIDAY-Setup-9.9.9.exe",
      apiUrl: "https://api.github.com/repos/devendrarj25/FRIDAY-AI-ASSISTANT/releases/assets/42",
      assetId: 42,
      name: "FRIDAY-Setup-9.9.9.exe",
      sha256: digest,
    });
    expect(result.ok).toBe(true);
    expect(seen[0]?.url).toContain("/releases/assets/42");
    expect(seen[0]?.auth).toBe("Bearer ghp_test_token");
    expect(seen.some((row) => row.url.includes("objects.githubusercontent.com"))).toBe(true);
    expect(
      seen
        .filter((row) => row.url.includes("objects.githubusercontent.com"))
        .every((row) => !row.auth),
    ).toBe(true);
  });
});

describe("checksum source", () => {
  it("resolves the manifest on the channel the asset belongs to", () => {
    expect(MAIN).toContain('updateChannel: wantTest ? "test" : "stable"');
    expect(MAIN).toContain("otherChannel?.manifest");
    expect(MAIN).toContain("github:download-progress");
    expect(MAIN).toContain("apiUrl: asset.apiUrl");
    expect(MAIN).toContain("assetId: asset.id");
  });
});

describe("asset identity", () => {
  it("keeps the GitHub API asset id so a channel is never inferred from a filename", () => {
    const mapped = sync.mapReleaseAsset({
      id: 99,
      name: "FRIDAY-Setup-1.7.1.exe",
      url: "https://api.github.com/repos/devendrarj25/FRIDAY-AI-ASSISTANT/releases/assets/99",
      browser_download_url:
        "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download/v1.7.1/FRIDAY-Setup-1.7.1.exe",
      size: 12,
    });
    expect(mapped.id).toBe(99);
    expect(mapped.apiUrl).toContain("/releases/assets/99");
    expect(mapped.url).toContain("github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases/download");
    expect(sync.assetDownloadUrl(mapped, "devendrarj25/FRIDAY-AI-ASSISTANT")).toBe(mapped.apiUrl);
    expect(
      sync.downloadHeaders("https://api.github.com/repos/o/r/releases/assets/1", "tok")
        .authorization,
    ).toBe("Bearer tok");
    expect(
      sync.downloadHeaders("https://objects.githubusercontent.com/file", "tok").authorization,
    ).toBeUndefined();
  });
});
