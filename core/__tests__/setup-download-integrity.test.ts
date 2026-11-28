/**
 * The setup downloads stay safe and keep a second source. No network: the Windows script is read as text and the
 * Electron checksum helpers run on throwaway files.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("fails closed: a direct download runs only with a pinned or published SHA-256, or a valid signature from its publisher", () => {
    const check = ps1.slice(
      ps1.indexOf("function Assert-InstallerSignature"),
      ps1.indexOf("function Wait-InstallerProcess"),
    );
    expect(check).toContain("Get-InstallerPin");
    expect(check).toContain("$status -eq 'Valid'");
    expect(check).toContain("$subject -like");
    expect(check).toMatch(/has no pinned or published SHA-256[\s\S]*It was deleted and not run/);
    expect(check).toMatch(/Remove-Item[^\r\n]*\r?\n\s*throw "\$name has no pinned/);
    // the old "keep it anyway" outcomes are gone
    expect(ps1).not.toMatch(/not blocking, the download came over TLS/);
    expect(ps1).not.toMatch(/signature check (could not run|not available)[^\r\n]*kept/);
    expect(ps1).not.toMatch(/download kept/);
    // the pin table lives in the config the doctor and the build read, not in the script
    expect(ps1).toContain("$Versions.installerPins");
  });

  it("names the expected publisher at every direct installer call site", () => {
    const calls = [...ps1.matchAll(/^\s*Install-Package \$\w+ [^\r\n]*$/gm)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      if (call.includes("$Publishers")) continue;
      expect(call, call).toMatch(/@\('[A-Za-z .]+'\)/);
    }
    expect(ps1).toMatch(/Install-Package \$file \$SilentArgs \$Publishers \$verified/);
    for (const publisher of [
      "OpenJS Foundation",
      "Python Software Foundation",
      "Johannes Schindelin",
      "Microsoft Corporation",
      "Mannheim",
    ]) {
      expect(ps1, publisher).toContain(`'${publisher}'`);
    }
  });

  it("returns whether a checksum matched, and an archive is never unpacked unverified", () => {
    expect(ps1).toMatch(
      /function Assert-AssetChecksum[\s\S]*return \$false[\s\S]*function Install-FromGitHubRelease/,
    );
    expect(ps1).toContain("function Assert-PublishedChecksum");
    const ffmpeg = ps1.slice(
      ps1.indexOf("function Install-FfmpegArchive"),
      ps1.indexOf("Expand-Archive"),
    );
    // The sidecar is tied to the exact file name (the moving release-essentials alias could name another build).
    expect(ffmpeg).toContain("gyan.dev/ffmpeg/builds/packages/$($asset.name).sha256");
    expect(ffmpeg).not.toContain("ffmpeg-release-essentials.zip.sha256");
    expect(ffmpeg).toMatch(/if \(-not \$verified\) \{[\s\S]*throw "no published SHA-256/);
  });

  it("adds the Hindi OCR data after Tesseract, detect first, offline skipped, from the pinned source", () => {
    const hindi = ps1.slice(ps1.indexOf("function Get-TesseractExe"));
    expect(hindi).toContain("function Install-TesseractHindi");
    expect(hindi).toContain("--list-langs");
    expect(
      hindi.indexOf("Test-TesseractHindi $exe", hindi.indexOf("function Install-TesseractHindi")),
    ).toBeLessThan(hindi.indexOf("FRIDAY_OFFLINE"));
    expect(hindi.indexOf("FRIDAY_OFFLINE")).toBeLessThan(hindi.indexOf("Invoke-OfficialDownload"));
    expect(hindi).toContain("$Versions.tessdataHin");
    expect(hindi).toMatch(/SHA-256 mismatch for hin\.traineddata[^\r\n]*file deleted/);
    expect(hindi).toContain("TESSDATA_PREFIX");
    expect(hindi).toContain("FRIDAY\\tools\\tessdata");
    const tool = ps1.indexOf("Ensure-RequiredCommand 'Tesseract OCR'");
    expect(ps1.indexOf("\n  Install-TesseractHindi\r", tool)).toBeGreaterThan(tool);
    expect(ps1.match(/\$script:StageTotal = 9/g)?.length).toBe(1);
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

/** The text of one top-level function of the script (it ends at a `}` in the first column). */
const fnText = (ps1: string, name: string) =>
  ps1.match(new RegExp(`^function ${name}\\b[\\s\\S]*?^}\\r?$`, "m"))?.[0] ?? "";

describe("setup-windows.ps1 PowerShell 7 fallback (per-user zip, checksum by asset name, signature after unpacking)", () => {
  const ps1 = read("scripts/setup-windows.ps1");
  const pwshMethods = ps1.slice(
    ps1.indexOf("Ensure-Tool 'PowerShell'"),
    ps1.indexOf("Ensure-Tool 'npm'"),
  );

  it("keeps winget first and the MSI as the first direct try, then adds the zip", () => {
    const winget = pwshMethods.indexOf("Install-WingetPackage 'Microsoft.PowerShell'");
    const msi = pwshMethods.indexOf("'*win-x64.msi'");
    const zip = pwshMethods.indexOf("Install-PwshArchive");
    expect(winget).toBeGreaterThan(-1);
    expect(msi).toBeGreaterThan(winget);
    expect(zip).toBeGreaterThan(msi);
    expect(pwshMethods).toMatch(/\) @\('Microsoft\.PowerShell'\) \$false/);
  });

  it("unpacks only a zip whose published checksum matched, into a per-user folder on the user PATH", () => {
    const body = fnText(ps1, "Install-PwshArchive");
    expect(body).toContain("PowerShell/PowerShell");
    expect(body).toContain("^PowerShell-[0-9.]+-win-x64\\.zip$");
    expect(body).toContain("hashes.sha256");
    expect(body).toMatch(/Assert-PublishedChecksum \$file [^\r\n]*\$asset\.name \$asset\.name/);
    expect(body).toMatch(
      /if \(-not \$verified\) \{[\s\S]*Remove-Item[\s\S]*throw "no published SHA-256/,
    );
    expect(body).toContain("FRIDAY\\tools\\pwsh");
    expect(body.indexOf('throw "no published SHA-256')).toBeLessThan(
      body.indexOf("Expand-Archive"),
    );
    expect(body).toMatch(/SetEnvironmentVariable\('Path'[^\r\n]*'User'\)/);
  });

  it("checks pwsh.exe is Valid and signed by Microsoft Corporation before it replaces anything", () => {
    const body = fnText(ps1, "Install-PwshArchive");
    expect(body).toContain("Get-AuthenticodeSignature");
    expect(body).toContain("'Valid'");
    expect(body).toContain("Microsoft Corporation");
    // Fail closed: no signature cmdlet, a bad status or another signer deletes the unpacked copy and throws.
    expect(body.indexOf("Get-AuthenticodeSignature")).toBeLessThan(body.indexOf("Move-Item"));
    expect(body).toMatch(/Remove-Item -LiteralPath \$staging -Recurse -Force[\s\S]*throw/);
  });

  it("Assert-PublishedChecksum takes an optional asset name and reads UTF-16 lists", () => {
    const body = fnText(ps1, "Assert-PublishedChecksum");
    expect(body).toContain("[string]$AssetName = ''");
    expect(body).toContain("[regex]::Escape($AssetName)");
    expect(body).toContain("([0-9a-f]{64})");
    expect(body).toContain("\\*?");
    expect(body).toContain("[Text.Encoding]::Unicode");
    expect(body).toMatch(/0xFF[\s\S]*0xFE/);
    // Old callers (no asset name) keep the first-64-hex reading; a named asset never falls back to another line.
    expect(body).toContain("(?i)\\b[0-9a-f]{64}\\b");
  });
});

describe("setup-windows.ps1 second sources: every mirror goes through the same hash or signature check", () => {
  const ps1 = read("scripts/setup-windows.ps1");

  it("gives Install-FromGitHubRelease a mirror template with {tag} and {asset}, validated before use", () => {
    const body = fnText(ps1, "Install-FromGitHubRelease");
    expect(body).toContain("[string]$MirrorTemplate = ''");
    expect(body).toContain("{tag}");
    expect(body).toContain("{asset}");
    expect(body).toMatch(
      /Invoke-OfficialDownload \$asset\.browser_download_url \$asset\.name \$mirrors/,
    );
    expect(body.indexOf("Invoke-OfficialDownload")).toBeLessThan(
      body.indexOf("Assert-AssetChecksum"),
    );
    expect(body).toContain("Install-Package $file $SilentArgs $Publishers $verified");
  });

  it("refuses a file from a mirror unless the sidecar, the GitHub digest or the pinned hash matched it", () => {
    const body = fnText(ps1, "Install-FromGitHubRelease");
    const digest = fnText(ps1, "Assert-AssetDigest");
    expect(digest).toContain("sha256:");
    expect(digest).toMatch(/-ne \$expected[\s\S]*Remove-Item[\s\S]*throw/);
    expect(ps1).toContain("$script:LastDownloadSource = $sources[$index]");
    // Digest check after the sidecar, the mirror gate after both, and the install only after the gate.
    const sidecar = body.indexOf("Assert-AssetChecksum");
    const byDigest = body.indexOf("Assert-AssetDigest $asset $file");
    const gate = body.indexOf("$script:LastDownloadSource");
    const install = body.indexOf("Install-Package $file");
    expect(sidecar).toBeGreaterThan(-1);
    expect(byDigest).toBeGreaterThan(sidecar);
    expect(gate).toBeGreaterThan(byDigest);
    expect(install).toBeGreaterThan(gate);
    expect(body).toMatch(/Get-InstallerPin \$asset\.name/);
    expect(body).toMatch(/came from a mirror and no sidecar, GitHub digest or pinned SHA-256/);
  });

  it("Git uses npmmirror, FFmpeg gyan.dev packages, Tesseract digi.bib (pinned), tessdata jsdelivr, VC++ a pinned visualstudio URL", () => {
    expect(ps1).toMatch(
      /Install-FromGitHubRelease 'git-for-windows\/git'[^\r\n]*'https:\/\/registry\.npmmirror\.com\/-\/binary\/git-for-windows\/\{tag\}\/\{asset\}'/,
    );
    expect(ps1).toMatch(
      /Install-FromGitHubRelease 'UB-Mannheim\/tesseract'[^\r\n]*'https:\/\/digi\.bib\.uni-mannheim\.de\/tesseract\/\{asset\}'/,
    );
    const ffmpeg = fnText(ps1, "Install-FfmpegArchive");
    expect(ffmpeg).toMatch(
      /Invoke-OfficialDownload \$asset\.browser_download_url \$asset\.name @\("https:\/\/www\.gyan\.dev\/ffmpeg\/builds\/packages\/\$\(\$asset\.name\)"\)/,
    );
    const hindi = fnText(ps1, "Install-TesseractHindi");
    expect(hindi).toContain("https://cdn.jsdelivr.net/gh/");
    expect(hindi).toMatch(/Invoke-OfficialDownload \$pin\.url 'hin\.traineddata' \$hindiMirrors/);
    expect(hindi.indexOf("$hindiMirrors")).toBeLessThan(hindi.indexOf("Get-FileHash"));
    expect(ps1).toMatch(
      /Invoke-OfficialDownload 'https:\/\/aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe' 'vc_redist\.x64\.exe' @\('https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/[0-9a-f-]+\/[0-9A-F]{64}\/VC_redist\.x64\.exe'\)/,
    );
    // The VC++ installer still needs the Microsoft signature whichever host served it.
    expect(ps1).toMatch(
      /Install-Package \$vcFile @\('\/install', '\/quiet', '\/norestart'\) @\('Microsoft Corporation'\)/,
    );
  });

  it("a pinned Tesseract installer is a last direct method: digi.bib first, GitHub second, the pin decides", () => {
    const body = fnText(ps1, "Install-PinnedTesseract");
    expect(body).toContain("installerPins");
    expect(body).toContain("https://digi.bib.uni-mannheim.de/tesseract/$name");
    expect(body).toContain("https://github.com/UB-Mannheim/tesseract/releases/download/$tag/$name");
    expect(body).toContain("Install-Package $file @('/S') @('Mannheim')");
    const tool = ps1.slice(ps1.indexOf("Ensure-RequiredCommand 'Tesseract OCR'"));
    expect(tool.indexOf("UB-Mannheim.TesseractOCR")).toBeLessThan(
      tool.indexOf("Install-PinnedTesseract"),
    );
  });

  it("names no other mirror host than the reviewed ones", () => {
    const hosts = new Set(
      [...ps1.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map((m) => m[1] as string),
    );
    for (const host of [
      "registry.npmmirror.com",
      "www.gyan.dev",
      "digi.bib.uni-mannheim.de",
      "cdn.jsdelivr.net",
      "download.visualstudio.microsoft.com",
    ]) {
      expect(hosts.has(host), host).toBe(true);
    }
  });
});

const pwshExe = (() => {
  const prefix = process.env["FRIDAY_PWSH_PREFIX"];
  if (process.env["FRIDAY_PWSH"] && existsSync(process.env["FRIDAY_PWSH"]))
    return process.env["FRIDAY_PWSH"];
  if (prefix && existsSync(prefix)) {
    for (const version of readdirSync(prefix)) {
      const exe = path.join(prefix, version, "pwsh");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
})();

describe.runIf(pwshExe !== null && process.platform !== "win32")(
  "Assert-PublishedChecksum, run for real in PowerShell 7 against a loopback server",
  () => {
    const ps1 = read("scripts/setup-windows.ps1");
    const zipHash = createHash("sha256").update("the zip bytes").digest("hex");
    const otherHash = createHash("sha256").update("another file").digest("hex");
    const list = `${otherHash.toUpperCase()} *PowerShell-7.7.0.msixbundle\r\n${zipHash.toUpperCase()} *PowerShell-7.7.0-win-x64.zip\r\n`;
    const bodies: Record<string, { type: string; data: Buffer }> = {
      "/utf16": {
        type: "application/octet-stream",
        data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(list, "utf16le")]),
      },
      "/utf16-text": {
        type: "text/plain",
        data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(list, "utf16le")]),
      },
      "/ascii": { type: "text/plain", data: Buffer.from(list, "ascii") },
      "/bare": { type: "text/plain", data: Buffer.from(`${zipHash}\n`, "ascii") },
    };

    const run = async (route: string, assetName: string, content: string) => {
      const server = createServer((req, res) => {
        const body = bodies[req.url ?? ""];
        if (!body) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", body.type);
        res.end(body.data);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as { port: number }).port;
      const dir = mkdtempSync(path.join(os.tmpdir(), "friday-pubsum-"));
      try {
        const data = path.join(dir, "asset.bin");
        writeFileSync(data, content);
        const script = path.join(dir, "run.ps1");
        const named = assetName ? ` '${assetName}'` : "";
        writeFileSync(
          script,
          [
            "$ErrorActionPreference = 'Stop'",
            "function Write-Step([string]$Message) { Write-Host ('STEP ' + $Message) }",
            fnText(ps1, "Assert-PublishedChecksum").replace(/\r/g, ""),
            `try { $r = Assert-PublishedChecksum '${data}' 'http://127.0.0.1:${port}${route}' 'asset'${named}; Write-Output ('RESULT ' + $r) } catch { Write-Output ('THROW ' + $_.Exception.Message) }`,
            `Write-Output ('EXISTS ' + (Test-Path '${data}'))`,
          ].join("\n"),
        );
        const out = await new Promise<string>((resolve) => {
          const child = spawn(pwshExe as string, ["-NoProfile", "-File", script]);
          let text = "";
          child.stdout.on("data", (chunk) => (text += chunk));
          child.stderr.on("data", (chunk) => (text += chunk));
          child.on("close", () => resolve(text));
        });
        return out;
      } finally {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("finds the line of the named asset in a UTF-16 list with a BOM, as bytes or as text", async () => {
      for (const route of ["/utf16", "/utf16-text", "/ascii"]) {
        const out = await run(route, "PowerShell-7.7.0-win-x64.zip", "the zip bytes");
        expect(out, route).toContain("RESULT True");
        expect(out, route).toContain("EXISTS True");
      }
    });

    it("deletes the file when the named asset's line does not match, never using another line", async () => {
      const out = await run("/utf16", "PowerShell-7.7.0-win-x64.zip", "tampered bytes");
      expect(out).toContain("THROW SHA-256 mismatch for asset");
      expect(out).toContain("file deleted");
      expect(out).toContain("EXISTS False");
    });

    it("returns false (unverified) when the list has no line for the asset, and keeps the file", async () => {
      const out = await run("/utf16", "PowerShell-9.9.9-win-x64.zip", "the zip bytes");
      expect(out).toContain("RESULT False");
      expect(out).toContain("EXISTS True");
    });

    it("keeps the first-hash reading for a sidecar with no asset name", async () => {
      const out = await run("/bare", "", "the zip bytes");
      expect(out).toContain("RESULT True");
    });
  },
);

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
