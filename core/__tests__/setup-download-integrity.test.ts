/**
 * The setup downloads stay safe and keep a second source. No network: the Windows script is read as text and the
 * Electron checksum helpers run on throwaway files.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("setup-windows.ps1 download safety", () => {
  const ps1 = read("scripts/setup-windows.ps1");

  it("turns TLS 1.2 on before the first download", () => {
    const tls = ps1.indexOf("SecurityProtocol");
    expect(tls).toBeGreaterThan(-1);
    expect(tls).toBeLessThan(ps1.indexOf("function Invoke-OfficialDownload"));
    expect(ps1).toContain("-bor 3072");
  });

  it("resumes a dropped curl download and retries more than three times", () => {
    expect(ps1).toMatch(/--retry 5[^\r\n]*-C -/);
  });

  it("checks the publisher signature before running a downloaded installer", () => {
    const install = ps1.slice(ps1.indexOf("function Install-Package"));
    expect(install.slice(0, 400)).toContain("Assert-InstallerSignature $File");
    expect(ps1).toContain("Get-AuthenticodeSignature");
    expect(ps1).toMatch(/HashMismatch[\s\S]*Remove-Item[\s\S]*throw/);
  });

  it("checks a published SHA-256 sidecar and deletes a file that does not match", () => {
    expect(ps1).toContain("function Assert-AssetChecksum");
    expect(ps1).toMatch(/Get-FileHash[^\r\n]*SHA256/);
    expect(ps1).toMatch(/SHA-256 mismatch[^\r\n]*file deleted/);
  });

  it("gives FFmpeg a per-user archive fallback after both winget packages", () => {
    const ffmpeg = ps1.slice(ps1.indexOf("Ensure-RequiredCommand 'FFmpeg'"));
    expect(ffmpeg.indexOf("Gyan.FFmpeg.Essentials")).toBeLessThan(
      ffmpeg.indexOf("Install-FfmpegArchive"),
    );
    expect(ps1).toContain("GyanD/codexffmpeg");
  });

  it("checks the Node.js MSI against nodejs.org's SHASUMS256.txt on both direct paths", () => {
    expect(ps1).toContain("function Assert-NodeChecksum");
    expect(ps1).toContain("SHASUMS256.txt");
    const direct = ps1.slice(
      ps1.indexOf("function Install-NodeDirect"),
      ps1.indexOf("function Install-PythonDirect"),
    );
    expect(direct.match(/Assert-NodeChecksum /g)?.length).toBe(2);
    expect(direct.indexOf("Assert-NodeChecksum")).toBeLessThan(direct.indexOf("Install-Package"));
  });

  it("retries the GitHub release lookup and honours GITHUB_TOKEN", () => {
    expect(ps1).toContain("function Get-GitHubLatestRelease");
    expect(ps1).toContain("GITHUB_TOKEN");
    expect(ps1.match(/Invoke-RestMethod -Uri "https:\/\/api\.github\.com/g)?.length).toBe(1);
  });

  it("stays 7-bit ASCII with CRLF line ends (Windows PowerShell 5.1 reads it as ANSI)", () => {
    expect(/[^\x00-\x7F]/.test(ps1)).toBe(false);
    expect(ps1.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("ensure-electron.cjs download sources", () => {
  const ensure = require("../../scripts/ensure-electron.cjs");

  it("lists the GitHub release first and a second public mirror after it", () => {
    const urls: string[] = ensure.releaseArchives("41.0.0");
    expect(urls[0]).toMatch(
      /^https:\/\/github\.com\/electron\/electron\/releases\/download\/v41\.0\.0\//,
    );
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.at(-1)).toContain("npmmirror.com");
  });

  it("reads a SHASUMS256.txt line for one archive only", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const text = `${a} *electron-v1-win32-x64.zip\r\n${b}  electron-v1-linux-x64.zip\n`;
    expect(ensure.shasumFor(text, "electron-v1-win32-x64.zip")).toBe(a);
    expect(ensure.shasumFor(text, "electron-v1-linux-x64.zip")).toBe(b);
    expect(ensure.shasumFor(text, "electron-v1-darwin-x64.zip")).toBeNull();
  });

  it("hashes a file the same way a checksum list does", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "friday-sha-"));
    try {
      const file = path.join(dir, "x.bin");
      writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 7, 5));
      const expected = createHash("sha256").update(readFileSync(file)).digest("hex");
      expect(ensure.sha256File(file)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
