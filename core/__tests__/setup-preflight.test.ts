/**
 * The PC preflight and the proxy part of scripts/setup-windows.ps1: a quick look at the PC before Step 1 of 9 (it is not
 * a numbered step), the corporate-proxy settings Windows already has, and the plan print that moves up front. Source pins
 * plus a real PowerShell 7 run of the functions where `pwsh` exists (a visible skip elsewhere). Linux evidence only: no
 * Windows, no network, no proxy server.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const root = path.resolve(__dirname, "..", "..");
const ps1Path = path.join(root, "scripts", "setup-windows.ps1");
const bytes = readFileSync(ps1Path);
const ps1 = bytes.toString("latin1");

/** The text of one top-level function (it ends at a `}` in the first column). */
const fn = (name: string) =>
  ps1.match(new RegExp(`^function ${name}\\b[\\s\\S]*?^}\\r?$`, "m"))?.[0] ?? "";

describe("the proxy line on the console never shows a password", () => {
  it("prints the proxy address without user:password@ (the exported variable keeps it for authentication)", () => {
    const body = fn("Set-ProxyEnvFromWindows");
    expect(body).toContain("$env:HTTPS_PROXY = $found.Https");
    expect(body).toContain("$($found.Https -replace '://[^/@]*@', '://')");
    expect(body).not.toContain("settings: $($found.Https) (set");
  });
});

describe("setup-windows.ps1 stays a 7-bit ASCII CRLF file", () => {
  it("has no byte above 127 and no bare line feed", () => {
    expect(bytes.every((b) => b < 128)).toBe(true);
    const lf = (ps1.match(/\n/g) ?? []).length;
    expect((ps1.match(/\r\n/g) ?? []).length).toBe(lf);
  });
});

describe("the PC preflight runs before Step 1 and is not a step", () => {
  const body = fn("Test-PcPreflight");

  it("is called after the PATH refresh and ahead of the first numbered step", () => {
    const call = ps1.indexOf("\r\n  Test-PcPreflight\r\n");
    expect(call).toBeGreaterThan(ps1.indexOf("Push-Location $Root"));
    expect(call).toBeGreaterThan(ps1.indexOf("\r\n  Refresh-Path\r\n"));
    expect(call).toBeLessThan(ps1.indexOf("Write-Stage 1 '"));
    expect(body).not.toContain("Write-Stage");
    expect(ps1).toContain("$script:StageTotal = 9");
    expect([...ps1.matchAll(/Write-Stage (\d) '/g)]).toHaveLength(9);
  });

  it("checks the Windows build, the disk, the TEMP drive, the folder name, administrator rights and nodejs.org", () => {
    expect(body).toContain("17763");
    expect(body).toMatch(/Get-DiskLevel/);
    expect(body).toMatch(/TEMP/);
    expect(body).toMatch(/Get-RootPathProblem/);
    expect(body).toContain("$script:IsAdmin");
    expect(body).toMatch(/NodeReachable/);
    expect(fn("Get-PcFacts")).toMatch(
      /-Method Head[^\r\n]*nodejs\.org|nodejs\.org[^\r\n]*-Method Head/,
    );
  });

  it("notices below 25 GB, stops (or a strict notice) below 8 GB, and names an over-long or non-ASCII folder", () => {
    const level = fn("Get-DiskLevel");
    expect(level).toMatch(/-lt 8\b/);
    expect(level).toMatch(/-lt 25\b/);
    expect(body).toMatch(/Stop-OrNotice/);
    expect(body).toMatch(/Write-Notice/);
    const path80 = fn("Get-RootPathProblem");
    expect(path80).toMatch(/-gt 80\b/);
    expect(path80).toMatch(/\\x7F/);
  });

  it("prints the administrator line yellow and once, not as a follow-up notice", () => {
    expect(body).toMatch(/Write-Host[^\r\n]*administrator[^\r\n]*-ForegroundColor Yellow/i);
  });

  it("measures this PC for the plan right after the preflight, before Step 1, and Step 4 does not print it again", () => {
    const call = ps1.indexOf("\r\n  Show-PcPlan\r\n");
    expect(call).toBeGreaterThan(ps1.indexOf("\r\n  Test-PcPreflight\r\n"));
    expect(call).toBeLessThan(ps1.indexOf("Write-Stage 1 '"));
    const show = fn("Show-PcPlan");
    expect(show).toContain("prefetch-models.cjs");
    expect(show).toContain("--plan");
    expect(show).toContain("$env:FRIDAY_PLAN_PRINTED = '1'");
    // A failed early run (no Node.js yet, or a plan that could not be made) leaves the print to Step 4.
    expect(show).toMatch(/Get-Command node\.exe/);
    expect(show).toMatch(/this PC:/);
    expect(ps1).toMatch(
      /--plan\r\n {2}if \(\$LASTEXITCODE -eq 0\) \{ \$env:FRIDAY_PLAN_PRINTED = '1' \}/,
    );
    expect(ps1).toMatch(
      /if \(\$env:FRIDAY_PLAN_PRINTED -ne '1'\) \{ Write-Step 'Measuring this PC/,
    );
  });
});

describe("the proxy settings Windows already has reach the tools setup starts", () => {
  const head = ps1.slice(0, ps1.indexOf("$Root = Split-Path"));

  it("trusts the Windows certificate store for Node.js only when the user has not chosen", () => {
    expect(head).toMatch(
      /if \(-not \$env:NODE_USE_SYSTEM_CA\) \{ \$env:NODE_USE_SYSTEM_CA = '1' \}/,
    );
  });

  it("gives the web proxy the signed-in user's credentials before the first download", () => {
    const tls = ps1.indexOf("SecurityProtocol");
    const proxy = ps1.indexOf("GetSystemWebProxy");
    expect(proxy).toBeGreaterThan(tls);
    expect(proxy).toBeLessThan(ps1.indexOf("Invoke-WebRequest"));
    expect(ps1).toContain("[Net.CredentialCache]::DefaultNetworkCredentials");
    expect(ps1).toContain("[Net.WebRequest]::DefaultWebProxy");
  });

  it("exports HTTPS_PROXY from the HKCU Internet Settings only when no proxy variable exists", () => {
    const set = fn("Set-ProxyEnvFromWindows");
    expect(set).toContain("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "ALL_PROXY"])
      expect(set).toContain(`'${name}'`);
    expect(set).toMatch(/\$env:HTTPS_PROXY = /);
    expect(set).toMatch(/NO_PROXY/);
    expect(head).toMatch(/^Set-ProxyEnvFromWindows\r?$/m);
  });
});

describe("prefetch-models --plan is silent when setup already printed it", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(root, "scripts", "prefetch-models.cjs"), "--plan"], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, FRIDAY_PLAN_PRINTED: "", ...env },
    });

  it("prints nothing for FRIDAY_PLAN_PRINTED=1 and the block otherwise", () => {
    const quiet = run({ FRIDAY_PLAN_PRINTED: "1" });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).not.toContain("this PC:");
    const loud = run({});
    expect(loud.stdout).toContain("this PC:");
  }, 240_000);
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

describe.runIf(pwsh !== null && process.platform !== "win32")(
  "the preflight and proxy functions, run for real in PowerShell 7",
  () => {
    const run = (script: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-preflight-"));
      try {
        const file = path.join(dir, "run.ps1");
        const names = [
          "Get-DiskLevel",
          "Get-RootPathProblem",
          "ConvertTo-ProxyUrl",
          "Get-WindowsProxyEnv",
          "Test-PcPreflight",
          "Assert-AssetDigest",
        ];
        const body = names.map((name) => fn(name).replace(/\r/g, "")).join("\n");
        const stubs =
          "function Write-Notice([string]$Text, [string]$Finish = '') { 'NOTICE ' + $Text }\n" +
          "function Stop-OrNotice([string]$Text, [string]$Finish = '') { if ($script:SetupStrict) { throw $Text }; 'STOPNOTICE ' + $Text }\n" +
          "function Write-Step([string]$Message) { 'STEP ' + $Message }\n" +
          "$script:SetupStrict = $false\n$ToolchainOnly = $false\n";
        writeFileSync(file, `$ErrorActionPreference = 'Stop'\n${stubs}${body}\n${script}\n`);
        const out = spawnSync(pwsh!, ["-NoProfile", "-File", file], {
          encoding: "utf8",
          timeout: 60_000,
        });
        return `${out.stdout}${out.stderr}`;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const facts = (over: string) =>
      `$f = @{ Build = 19045; Root = 'C:\\FRIDAY'; RootFreeGb = 120; TempPath = 'C:\\Temp\\'; TempFreeGb = 120; SameDrive = $true; IsAdmin = $false; NodeReachable = $true }\n${over}\nTest-PcPreflight $f\n`;

    it("parses the whole script", () => {
      const probe =
        "$e = $null; $t = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('" +
        ps1Path +
        "', [ref]$t, [ref]$e); $e.Count";
      const out = spawnSync(pwsh!, ["-NoProfile", "-Command", probe], { encoding: "utf8" });
      expect(out.stdout.trim()).toBe("0");
    });

    it("says nothing alarming for a healthy PC", () => {
      const out = run(facts(""));
      expect(out).not.toMatch(/NOTICE|STOPNOTICE|administrator/i);
    });

    it("stops below Windows build 17763", () => {
      const out = run(facts("$f.Build = 17134") + "");
      expect(out).toMatch(/17763/);
      expect(out).not.toMatch(/STEP PC check/);
    });

    it("grades the disk: a notice below 25 GB, a stop-or-notice below 8 GB", () => {
      expect(run(facts("$f.RootFreeGb = 20"))).toMatch(/^NOTICE .*20/m);
      const tight = run(facts("$f.RootFreeGb = 5"));
      expect(tight).toMatch(/^STOPNOTICE .*5/m);
      expect(run(facts("$f.RootFreeGb = 5\n$script:SetupStrict = $true"))).toMatch(/Only 5/);
      expect(run(facts("$f.RootFreeGb = 25"))).not.toMatch(/NOTICE/);
      expect(run(facts("$f.RootFreeGb = -1"))).not.toMatch(/NOTICE/);
    });

    it("checks the TEMP drive when it is another drive", () => {
      expect(run(facts("$f.SameDrive = $false; $f.TempFreeGb = 1"))).toMatch(/^NOTICE .*TEMP/m);
      expect(run(facts("$f.SameDrive = $true; $f.TempFreeGb = 1"))).not.toMatch(/TEMP/);
    });

    it("names a folder path over 80 characters or with a non-ASCII letter", () => {
      const long = `C:\\\\${"a".repeat(90)}`;
      expect(run(facts(`$f.Root = '${long}'`))).toMatch(/^NOTICE .*80/m);
      expect(run(facts("$f.Root = 'C:\\' + [string][char]0x00E9 + 'cole'"))).toMatch(
        /^NOTICE .*(ASCII|letters)/im,
      );
    });

    it("prints one yellow administrator line and reports a silent nodejs.org", () => {
      const admin = run(facts("$f.IsAdmin = $true"));
      expect((admin.match(/administrator/gi) ?? []).length).toBe(1);
      expect(run(facts("$f.NodeReachable = $false"))).toMatch(/^NOTICE .*nodejs\.org/m);
    });

    it("matches a file against the digest GitHub lists, and deletes a file that differs", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "friday-digest-"));
      try {
        const file = path.join(dir, "installer.exe");
        writeFileSync(file, "abc");
        const good = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        const out = run(
          [
            `$file = '${file}'`,
            `'match=' + (Assert-AssetDigest ([pscustomobject]@{ name = 'installer.exe'; digest = 'sha256:${good}' }) $file)`,
            "'none=' + (Assert-AssetDigest ([pscustomobject]@{ name = 'installer.exe' }) $file)",
            "'odd=' + (Assert-AssetDigest ([pscustomobject]@{ name = 'installer.exe'; digest = 'md5:abc' }) $file)",
            `try { Assert-AssetDigest ([pscustomobject]@{ name = 'installer.exe'; digest = 'sha256:${"0".repeat(64)}' }) $file } catch { 'threw=' + $_.Exception.Message }`,
            "'left=' + (Test-Path -LiteralPath $file)",
          ].join("\n"),
        );
        expect(out).toMatch(/match=.*True/);
        expect(out).toContain("none=False");
        expect(out).toContain("odd=False");
        expect(out).toMatch(/threw=SHA-256 mismatch for installer\.exe/);
        expect(out).toContain("left=False");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("turns the registry ProxyServer shapes into one proxy URL", () => {
      const out = run(
        [
          "ConvertTo-ProxyUrl 'proxy.corp:8080'",
          "ConvertTo-ProxyUrl 'http=a.corp:80;https=b.corp:443;ftp=c.corp:21'",
          "ConvertTo-ProxyUrl 'http=a.corp:80'",
          "ConvertTo-ProxyUrl 'https://secure.corp:3128'",
          "'socks=' + (ConvertTo-ProxyUrl 'socks=s.corp:1080')",
          "'empty=' + (ConvertTo-ProxyUrl '')",
        ].join("\n"),
      );
      expect(out).toContain("http://proxy.corp:8080");
      expect(out).toContain("http://b.corp:443");
      expect(out).toContain("http://a.corp:80");
      expect(out).toContain("https://secure.corp:3128");
      expect(out).toContain("socks=\n");
      expect(out).toContain("empty=\n");
    });

    it("exports nothing when the proxy is off, and keeps localhost out of the proxy when it is on", () => {
      const out = run(
        [
          "$off = Get-WindowsProxyEnv $false 'proxy.corp:8080' ''",
          "'off=' + $off.Https",
          "$on = Get-WindowsProxyEnv $true 'proxy.corp:8080' '*.corp.local;<local>;10.0.0.5'",
          "'on=' + $on.Https",
          "'skip=' + $on.NoProxy",
        ].join("\n"),
      );
      expect(out).toContain("off=\n");
      expect(out).toContain("on=http://proxy.corp:8080");
      expect(out).toMatch(/skip=.*localhost/);
      expect(out).toMatch(/skip=.*127\.0\.0\.1/);
      expect(out).toMatch(/skip=.*\.corp\.local/);
      expect(out).toMatch(/skip=.*10\.0\.0\.5/);
    });
  },
);
