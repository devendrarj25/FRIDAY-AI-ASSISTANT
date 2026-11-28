/**
 * The toolchain step of scripts/setup-windows.ps1: only what the build cannot run without stops the setup, every other
 * failure is a yellow NOTICE that is repeated in the closing block (FRIDAY_SETUP_STRICT=1 stops instead); official
 * downloads try the mirrors the manifest lists after the official source; direct downloads show the live row; the Visual
 * C++ runtime has a floor; Python is asked newest wheel-proven series first. Source pins plus a real PowerShell 7 run
 * of the functions where `pwsh` exists (a visible skip elsewhere). Linux evidence only: no Windows, no network.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const ps1 = read("scripts/setup-windows.ps1");
const versions = JSON.parse(read("config/toolchain-versions.json")) as Record<string, unknown>;
const manifest = JSON.parse(read("config/toolchain-manifest.json")) as {
  packs: Array<{ id: string; url: string; mirrors?: string[] }>;
};

/** The text of one top-level function (it ends at a `}` in the first column). */
const fn = (name: string) =>
  ps1.match(new RegExp(`^function ${name}\\b[\\s\\S]*?^}\\r?$`, "m"))?.[0] ??
  ps1.match(new RegExp(`^function ${name}\\b[^\\r\\n]*\\r?$`, "m"))?.[0] ??
  "";

describe("what stops the setup and what is a notice", () => {
  it("keeps Node.js, npm, the dependency install and Electron as stops", () => {
    expect(ps1).toMatch(/Ensure-Tool 'Node\.js' 'node\.exe'/);
    expect(ps1).toMatch(/Ensure-Tool 'npm' 'npm\.cmd'/);
    expect(ps1).toContain("throw 'npm ci failed. See the output above for the failing package.'");
    expect(ps1).toContain(
      "throw 'Electron binary installation failed after every official method.'",
    );
    // Ensure-Tool throws unless the call says -Blocking $false, and Node.js, npm and Python never say it.
    expect(fn("Ensure-Tool")).toContain("[bool]$Blocking = $true");
    expect(fn("Ensure-Tool")).toMatch(/if \(\$Blocking\) \{ throw \$message \}/);
    const node = ps1.slice(
      ps1.indexOf("Ensure-Tool 'Node.js'"),
      ps1.indexOf("# winget names each Python"),
    );
    expect(node).not.toContain("$false");
    expect(ps1).toMatch(
      /Ensure-Tool 'Python'[^\r\n]*\$pythonMethods\.ToArray\(\) \$pythonIds\r?\n/,
    );
  });

  it("turns Git, PowerShell, FFmpeg, Tesseract, the Visual C++ runtime, the toolkit and the packs into notices", () => {
    expect(ps1).toMatch(/\) @\('Git\.Git'\) \$false/);
    expect(ps1).toMatch(/\) @\('Microsoft\.PowerShell'\) \$false/);
    const required = fn("Ensure-RequiredCommand");
    expect(required).not.toMatch(/\bthrow\b/);
    expect(ps1).toMatch(/Stop-OrNotice "\$Label could not be installed by any official method/);
    expect(ps1).toContain("Write-Notice 'The Visual C++ Redistributable could not be installed");
    expect(ps1).toMatch(/Stop-OrNotice 'The agent toolkit is not complete/);
    expect(ps1).toMatch(/Stop-OrNotice 'The packs for the EXE could not be downloaded\./);
    // The old stops are gone from those three places.
    expect(ps1).not.toMatch(/throw 'The agent toolkit is not complete/);
    expect(ps1).not.toMatch(/throw 'The packs for the EXE could not be downloaded/);
  });

  it("restores the stop with FRIDAY_SETUP_STRICT=1 and still ends SETUP PASS with the notices listed after it", () => {
    expect(ps1).toContain("$script:SetupStrict = (\"$env:FRIDAY_SETUP_STRICT\".Trim() -eq '1')");
    expect(fn("Stop-OrNotice")).toContain("if ($script:SetupStrict) { throw");
    expect(ps1).toMatch(/if \(\$script:SetupStrict\) \{ throw 'The Visual C\+\+ Redistributable/);
    expect(ps1).toContain(
      "Write-Host '[FRIDAY] SETUP PASS - FRIDAY is ready to test, build and run.' -ForegroundColor Green",
    );
    expect(ps1).toMatch(/Start-RunningToolUpgrades\r?\n {2}Write-FollowUps/);
    // The toolchain-only run (build, Doctor) prints its notices too.
    expect(ps1).toMatch(/TOOLCHAIN PASS[^\r\n]*\r?\n {4}Write-FollowUps\r?\n {4}return/);
    expect(fn("Write-Notice")).toContain("-ForegroundColor Yellow");
    expect(fn("Write-Notice")).toContain("Add-FollowUp $line");
  });
});

describe("official downloads with mirrors", () => {
  const hosts = new Set([
    "registry.npmmirror.com",
    "mirrors.huaweicloud.com",
    "cdn.jsdelivr.net",
    "hf-mirror.com",
  ]);
  const pack = (id: string) => manifest.packs.find((entry) => entry.id === id);

  it("lists https mirrors on the verified hosts for Node.js, Python and get-pip", () => {
    for (const id of ["node-win", "python-embed", "get-pip"]) {
      const mirrors = pack(id)?.mirrors ?? [];
      expect(mirrors.length, id).toBeGreaterThan(0);
      for (const url of mirrors) {
        expect(url.startsWith("https://"), url).toBe(true);
        expect(hosts.has(new URL(url).hostname), url).toBe(true);
      }
    }
    // The mirror of get-pip is the same pinned commit as the official URL.
    const official = pack("get-pip")!.url.match(/get-pip\/([0-9a-f]{40})\//)?.[1];
    expect(official).toBeTruthy();
    expect(pack("get-pip")!.mirrors!.join(" ")).toContain(`get-pip@${official}/public/get-pip.py`);
    expect(pack("node-win")!.mirrors!.map((url) => new URL(url).hostname)).toEqual([
      "registry.npmmirror.com",
      "mirrors.huaweicloud.com",
    ]);
  });

  it("gives Invoke-OfficialDownload a Mirrors list that the file checks still gate", () => {
    expect(ps1).toContain(
      "function Invoke-OfficialDownload([string]$Url, [string]$FileName, [string[]]$Mirrors = @())",
    );
    expect(fn("Invoke-OfficialDownload")).toContain("second source:");
    // Every direct installer is still checked by its caller after the download, whichever source served it.
    expect(fn("Install-NodeDirect")).toMatch(/Get-MirrorUrls 'node-win'/);
    expect(fn("Install-NodeFloor")).toMatch(/Get-MirrorUrls 'node-win'/);
    expect(fn("Install-PythonDirect")).toMatch(/Get-MirrorUrls 'python-embed'/);
    expect(fn("Install-NodeDirect")).toContain("Assert-NodeChecksum $version $file");
    expect(fn("Install-PythonDirect")).toContain("'Python Software Foundation'");
    expect(ps1).not.toMatch(/SkipCertificateCheck|ServerCertificateValidationCallback/);
  });

  it("shows the live row for direct downloads through scripts/fetch-file.cjs, then curl.exe, then Invoke-WebRequest", () => {
    const transports = fn("Receive-FromSource");
    expect(transports.indexOf("Invoke-NodeDownload")).toBeGreaterThan(-1);
    expect(transports.indexOf("Invoke-NodeDownload")).toBeLessThan(
      transports.indexOf("& curl.exe"),
    );
    expect(transports.indexOf("& curl.exe")).toBeLessThan(
      transports.indexOf("Invoke-WebRequest -Uri $Url"),
    );
    expect(fn("Invoke-NodeDownload")).toContain("fetch-file.cjs");
    expect(existsSync(path.join(root, "scripts", "fetch-file.cjs"))).toBe(true);
  });
});

describe("setup-windows.ps1 download and strict hardening (source pins)", () => {
  it("lets curl.exe speak https only, also across redirects", () => {
    expect(fn("Receive-FromSource")).toContain("--proto '=https' --proto-redir '=https'");
  });

  it("honours the same three strict switches as scripts/setup-notices.cjs", () => {
    const line = ps1.match(/^\$script:SetupStrict = .*$/m)?.[0] ?? "";
    for (const name of [
      "FRIDAY_SETUP_STRICT",
      "FRIDAY_PREFETCH_STRICT",
      "FRIDAY_PREFETCH_TOOLKIT_STRICT",
    ]) {
      expect(line).toContain(`$env:${name}`);
    }
  });

  it("checks the version of the Node.js list and reads that list from nodejs.org only", () => {
    const direct = fn("Install-NodeDirect");
    expect(direct).toContain("'^v\\d+\\.\\d+\\.\\d+$'");
    expect(direct).toContain("$Versions.nodeMinimum");
    expect(direct).not.toContain("-AtBase");
    expect(direct).toContain("Install-NodeFloor");
    expect(fn("Invoke-OfficialDownload")).toMatch(/\$FileName -match '\[\\\\\/:\]'/);
  });
});

describe("the Visual C++ runtime floor and the Python series", () => {
  it("reads a vcRedistMinimum floor and upgrades a runtime that is older", () => {
    expect(String(versions["vcRedistMinimum"])).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ps1).toContain("$Versions.vcRedistMinimum");
    expect(fn("Get-VcRuntimeVersion")).toContain("FileMajorPart");
    expect(ps1).toContain(
      "Update-IfNewer 'Visual C++ Redistributable' @('Microsoft.VCRedist.2015+.x64')",
    );
    expect(ps1).toContain(
      "is below the supported minimum $vcFloor - upgrading it from the official source",
    );
    expect(ps1).toContain("1638");
  });

  it("asks winget for the newest wheel-proven Python series first, then 3.13 and 3.12", () => {
    expect(ps1).toContain("@(\"$($Versions.pythonWheelProven)\", '3.13', '3.12')");
    expect(ps1).toContain("Install-WingetPackage '$wingetId'");
    expect(String(versions["pythonWheelProven"])).toMatch(/^3\.\d+$/);
    expect(ps1.indexOf('$wingetId = "Python.Python.$series"')).toBeLessThan(
      ps1.indexOf("official python.org installer download"),
    );
  });

  it("offers a vendor release list when winget is missing, and sends Node.js to its download page", () => {
    expect(fn("Update-IfNewer")).toContain("Write-VendorLatest $Label $Command $VersionArguments");
    expect(fn("Get-VendorLatest")).toContain("Get-GitHubLatestRelease 'git-for-windows/git'");
    expect(fn("Get-VendorLatest")).toContain("Get-GitHubLatestRelease 'PowerShell/PowerShell'");
    expect(ps1).toContain("download the LTS installer from https://nodejs.org/en/download");
  });
});

/** PowerShell 7 where this machine has it (PATH, FRIDAY_PWSH, or a FRIDAY_PWSH_PREFIX/<version>/pwsh install). */
function findPwsh(): string | null {
  const own = process.env["FRIDAY_PWSH"];
  if (own && existsSync(own)) return own;
  if (hasCommand("pwsh")) return "pwsh";
  const prefix = process.env["FRIDAY_PWSH_PREFIX"];
  if (prefix && existsSync(prefix)) {
    for (const version of readdirSync(prefix)) {
      const exe = path.join(prefix, version, "pwsh");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}
const pwsh = findPwsh();

describe.skipIf(pwsh === null || process.platform === "win32")(
  "the notice and mirror functions, run for real in PowerShell 7",
  () => {
    const run = (script: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-notices-"));
      try {
        const file = path.join(dir, "run.ps1");
        const names = [
          "Write-Step",
          "Add-FollowUp",
          "Write-Notice",
          "Stop-OrNotice",
          "Write-FollowUps",
          "Get-MirrorUrls",
          "Invoke-OfficialDownload",
          "Write-DownloadDone",
          "Format-Size",
          "Install-NodeDirect",
          "Install-Package",
        ];
        const body = names.map((name) => fn(name).replace(/\r/g, "")).join("\n");
        writeFileSync(
          file,
          `$ErrorActionPreference = 'Stop'\n$Root = '${root}'\n$script:FollowUps = New-Object System.Collections.Generic.List[string]\n$script:SetupStrict = $false\n$Versions = [pscustomobject]@{ nodeMinimum = '22.19.0' }\nfunction Get-DownloadFolder { '${dir}' }\n${body}\n${script}\n`,
        );
        const out = spawnSync(pwsh!, ["-NoProfile", "-File", file], {
          encoding: "utf8",
          timeout: 60_000,
        });
        return `${out.stdout}${out.stderr}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("parses the whole script", () => {
      const probe =
        "$e = $null; $t = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('" +
        path.join(root, "scripts", "setup-windows.ps1") +
        "', [ref]$t, [ref]$e); $e.Count";
      const out = spawnSync(pwsh!, ["-NoProfile", "-Command", probe], { encoding: "utf8" });
      expect(out.stdout.trim()).toBe("0");
    });

    it("prints a yellow-line NOTICE and lists it once at the end, and stops only when strict", () => {
      const out = run(
        "Stop-OrNotice 'Git could not be installed.' 'Finish it later.'\n$script:SetupStrict = $true\ntry { Stop-OrNotice 'FFmpeg could not be installed.' 'Do X.' } catch { 'STRICT: ' + $_.Exception.Message }\nWrite-FollowUps",
      );
      expect(out).toContain("[FRIDAY] NOTICE - Git could not be installed. Finish it later.");
      expect(out).toContain("STRICT: FFmpeg could not be installed. Do X.");
      expect(out).toContain("[FRIDAY]   - Git could not be installed. Finish it later.");
      expect(out).not.toContain("NOTICE - FFmpeg");
    });

    it("builds the mirror URL of another file of the same release from the manifest", () => {
      const out = run(
        "(Get-MirrorUrls 'node-win' 'node-v22.99.0-x64.msi' 'v22.99.0') -join '|'\n(Get-MirrorUrls 'node-win' 'index.json' -AtBase) -join '|'\n'none=' + @(Get-MirrorUrls 'no-such-pack' 'x').Count",
      );
      expect(out).toContain(
        "https://registry.npmmirror.com/-/binary/node/v22.99.0/node-v22.99.0-x64.msi|https://mirrors.huaweicloud.com/nodejs/v22.99.0/node-v22.99.0-x64.msi",
      );
      expect(out).toContain(
        "https://registry.npmmirror.com/-/binary/node/index.json|https://mirrors.huaweicloud.com/nodejs/index.json",
      );
      expect(out).toContain("none=0");
    });

    it("tries the official URL first, names the second source, and throws when every source fails", () => {
      const out = run(
        [
          "$script:Asked = @()",
          "function Receive-FromSource([string]$Url, [string]$FileName, [string]$Target, $Errors) {",
          "  $script:Asked += $Url",
          "  if ($Url -like '*primary*') { $Errors.Add('curl.exe: HTTP 503') | Out-Null; return $null }",
          "  Set-Content -LiteralPath $Target -Value 'x'; return 'fake'",
          "}",
          "$r = Invoke-OfficialDownload 'https://primary.example/a.msi' 'a.msi' @('https://mirror.example/a.msi')",
          "'ASKED ' + ($script:Asked -join ' | ')",
          "function Receive-FromSource([string]$Url, [string]$FileName, [string]$Target, $Errors) { $Errors.Add('bad ' + $Url) | Out-Null; return $null }",
          "try { Invoke-OfficialDownload 'https://p.example/a' 'a' @('https://m.example/a') | Out-Null } catch { 'THREW ' + $_.Exception.Message }",
        ].join("\n"),
      );
      expect(out).toContain("ASKED https://primary.example/a.msi | https://mirror.example/a.msi");
      expect(out).toContain("second source: mirror.example");
      expect(out).toContain(
        "THREW official download failed for https://p.example/a - bad https://p.example/a; bad https://m.example/a",
      );
    });
    it("refuses a Node.js version list entry that is not vMAJOR.MINOR.PATCH or is below the minimum, before any download", () => {
      const harness = (version: string) =>
        [
          "$script:Downloads = @()",
          "function Invoke-OfficialDownload([string]$Url, [string]$FileName, [string[]]$Mirrors = @()) { $script:Downloads += $Url; throw 'DOWNLOAD ' + $Url }",
          "function Install-NodeFloor { 'FLOOR' }",
          `function Invoke-RestMethod { [pscustomobject]@{ version = '${version}'; lts = 'Jod' } }`,
          "try { Install-NodeDirect } catch { 'THREW ' + $_.Exception.Message }",
          "'DOWNLOADS=' + $script:Downloads.Count",
        ].join("\n");
      for (const bad of ["v1.0.0", "..\\x", "v22.19", "v22.19.0.1", "v99.0.0/../x"]) {
        const out = run(harness(bad));
        expect(out, bad).toContain("THREW the Node.js version list named an unusable release");
        expect(out, bad).toContain("DOWNLOADS=0");
      }
      // A good entry reaches the download (which the stub then refuses).
      expect(run(harness("v26.13.1"))).toContain("DOWNLOADS=1");
    });

    it("installs the pinned minimum when nodejs.org cannot be read, and never asks a mirror for the list", () => {
      const out = run(
        [
          "$script:Asked = @()",
          "function Invoke-OfficialDownload([string]$Url, [string]$FileName, [string[]]$Mirrors = @()) { $script:Asked += ($Url + ' mirrors=' + $Mirrors.Count); throw 'down' }",
          "function Install-NodeFloor { 'FLOOR' }",
          "function Invoke-RestMethod { throw 'offline' }",
          "Install-NodeDirect",
          "'ASKED ' + ($script:Asked -join ' | ')",
        ].join("\n"),
      );
      expect(out).toContain("FLOOR");
      expect(out).toContain("ASKED https://nodejs.org/dist/index.json mirrors=0");
    });

    it("refuses a download file name with a folder, a drive or .. before any transport runs", () => {
      const out = run(
        [
          "function Receive-FromSource([string]$Url, [string]$FileName, [string]$Target, $Errors) { 'TRANSPORT ' + $FileName; Set-Content -LiteralPath $Target -Value 'x'; return 'fake' }",
          "foreach ($name in @('..\\x', 'a/b.msi', 'a\\b.msi', 'C:evil.msi', 'a..b', '')) { try { Invoke-OfficialDownload 'https://x.example/a' $name | Out-Null; 'ALLOWED ' + $name } catch { 'REFUSED ' + $name } }",
          "(Invoke-OfficialDownload 'https://x.example/a' 'node-v26.13.1-x64.msi') -like '*node-v26.13.1-x64.msi'",
        ].join("\n"),
      );
      expect(out).not.toContain("ALLOWED");
      expect(out).not.toContain("TRANSPORT ..");
      expect(out.match(/REFUSED/g)).toHaveLength(6);
      expect(out).toContain("True");
    });

    it("takes exit 1638 (a newer copy is installed) from an MSI or the vc_redist bootstrapper, and fails any other installer on it", () => {
      const out = run(
        [
          "function Assert-InstallerSignature { }",
          "function Wait-InstallerProcess { }",
          "$script:Exit = 1638",
          "function Start-Process { [pscustomobject]@{ ExitCode = $script:Exit } }",
          "foreach ($f in @('a.msi', 'vc_redist.x64.exe', 'python-3.13.exe', 'setup.exe')) { try { Install-Package ('/tmp/' + $f) @('/q') | Out-Null; 'OK ' + $f } catch { 'FAIL ' + $f } }",
          "$script:Exit = 3010; try { Install-Package '/tmp/x.exe' @('/q') | Out-Null; 'OK3010' } catch { 'FAIL3010' }",
        ].join("\n"),
      );
      expect(out).toContain("OK a.msi");
      expect(out).toContain("OK vc_redist.x64.exe");
      expect(out).toContain("FAIL python-3.13.exe");
      expect(out).toContain("FAIL setup.exe");
      expect(out).toContain("OK3010");
    });
  },
);
