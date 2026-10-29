/**
 * Every committed PowerShell script must parse with the real PowerShell parser.
 * The installer smoke, the runtime repair and the signing helper only run on a
 * Windows machine, so a syntax slip in one would otherwise surface in a release.
 * It runs where PowerShell exists (every Windows runner) and skips visibly elsewhere.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { hasCommand } from "./helpers/environment";

const ROOT = path.resolve(import.meta.dirname, "../..");

function listScripts(): string[] {
  const out = spawnSync("git", ["ls-files", "*.ps1", "*.psm1"], { cwd: ROOT, encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout.split(/\r?\n/).filter(Boolean);
}

const shell = ["pwsh", "powershell"].find((name) => hasCommand(name));
const scripts = listScripts();

describe("PowerShell scripts parse", () => {
  it.skipIf(!shell || scripts.length === 0)(
    "reports no syntax error in any committed .ps1 or .psm1",
    () => {
      const program = [
        "$bad = @()",
        "foreach ($f in $args) {",
        "  $e = $null; $t = $null",
        "  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $f).Path, [ref]$t, [ref]$e)",
        "  foreach ($x in $e) { $bad += ($f + ':' + $x.Extent.StartLineNumber + ' ' + $x.Message) }",
        "}",
        "if ($bad.Count) { $bad | ForEach-Object { Write-Output $_ }; exit 1 }",
      ].join("\n");
      const run = spawnSync(
        shell as string,
        ["-NoProfile", "-NonInteractive", "-Command", `& { ${program} } @args`, ...scripts],
        { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
      );
      expect(`${run.stdout}${run.stderr}`.trim()).toBe("");
      expect(run.status).toBe(0);
    },
  );

  it("finds the scripts the installer and the smoke depend on", () => {
    if (scripts.length === 0) return; // an export without .git has no file list
    for (const needed of [
      "scripts/windows-installer-smoke.ps1",
      "installer/build/repair-runtime.ps1",
      "installer/build/close-friday.ps1",
    ]) {
      expect(scripts, needed).toContain(needed);
    }
  });
});
