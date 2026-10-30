/**
 * PC reliability and host state: parsed from probe output, never invented.
 * The PowerShell host and the WER folders are stood in, so this runs on any machine.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { hasCommand } from "./helpers/environment";

const require_ = createRequire(import.meta.url);

type Item = { id: string; label: string; state: string; detail: string; count?: number };
type Report = { supported: boolean; detectedAt: number; items: Item[] };
const hardware = require_("../../electron/hardware.cjs") as {
  detectReliability: (deps?: Record<string, unknown>) => Promise<Report>;
  parseCrashEvents: (text: string) => { app: string; provider: string; id: number; at: string }[];
  parseWerFolder: (name: string) => { kind: string; app: string };
  jsonRows: (text: string) => Record<string, unknown>[];
  RELIABILITY_SCRIPTS: Record<string, string>;
};

const ok = (stdout: string) => ({ ok: true, stdout, error: null });
const fail = (error: string) => ({ ok: false, stdout: null, error });

/** A PowerShell host that answers by which probe the script is. */
function host(answers: Partial<Record<keyof typeof hardware.RELIABILITY_SCRIPTS, unknown>>) {
  return async (script: string) => {
    for (const [name, body] of Object.entries(hardware.RELIABILITY_SCRIPTS)) {
      if (body === script) {
        const answer = answers[name as keyof typeof answers];
        return answer ?? fail(`no stand-in for ${name}`);
      }
    }
    throw new Error("an unknown script was run");
  };
}

const dirent = (name: string, isDir = true) => ({ name, isDirectory: () => isDir });
function werFs(queue: string[], archive: string[], mtime = 1000) {
  return {
    readdirSync: (dir: string) => {
      if (/ReportQueue$/.test(dir)) return queue.map((name) => dirent(name));
      if (/ReportArchive$/.test(dir)) return archive.map((name) => dirent(name));
      throw new Error("ENOENT");
    },
    statSync: () => ({ mtimeMs: mtime }),
  };
}

const crashJson = JSON.stringify([
  {
    t: "2026-01-14T10:00:00.0000000Z",
    p: "Application Error",
    id: 1000,
    m: "Faulting application name: chrome.exe, version: 140.0.1, time stamp: 0x1",
  },
  {
    t: "2026-01-14T11:00:00.0000000Z",
    p: "Application Error",
    id: 1000,
    m: "Faulting application name: chrome.exe, version: 140.0.1, time stamp: 0x2",
  },
  {
    t: "2026-01-13T09:00:00.0000000Z",
    p: "Application Hang",
    id: 1002,
    m: "The program notepad.exe version 11.0 stopped interacting with Windows",
  },
  {
    t: "2026-01-12T09:00:00.0000000Z",
    p: "Windows Error Reporting",
    id: 1001,
    m: "Fault bucket 123, type 5",
  },
]);

describe("reading crash events", () => {
  it("names the program from the first line of the message only", () => {
    const rows = hardware.parseCrashEvents(crashJson);
    expect(rows.map((row) => row.app)).toEqual([
      "chrome.exe",
      "chrome.exe",
      "notepad.exe",
      "unnamed (Windows Error Reporting)",
    ]);
    expect(rows[0]).toMatchObject({ provider: "Application Error", id: 1000 });
  });

  it("accepts one object, an array, nothing and garbage", () => {
    expect(hardware.jsonRows('{"Name":"a"}')).toEqual([{ Name: "a" }]);
    expect(hardware.jsonRows('[{"Name":"a"},{"Name":"b"}]')).toHaveLength(2);
    expect(hardware.jsonRows("")).toEqual([]);
    expect(hardware.jsonRows("   ")).toEqual([]);
    expect(hardware.jsonRows("not json")).toEqual([]);
    expect(hardware.jsonRows("[1, 2, null]")).toEqual([]);
  });

  it("reads the program out of a WER report folder name", () => {
    expect(hardware.parseWerFolder("AppCrash_FRIDAY.exe_8e1f0c")).toEqual({
      kind: "AppCrash",
      app: "FRIDAY.exe",
    });
    expect(hardware.parseWerFolder("Critical_powershell.exe_abc_cab_1")).toEqual({
      kind: "Critical",
      app: "powershell.exe",
    });
    expect(hardware.parseWerFolder("")).toEqual({ kind: "report", app: "unknown" });
  });
});

describe("detectReliability", () => {
  it("reports every row as unknown off Windows instead of claiming a healthy PC", async () => {
    const result = await hardware.detectReliability({ platform: "linux" });
    expect(result.supported).toBe(false);
    expect(result.items.map((item) => item.id)).toEqual([
      "crashes",
      "wer-reports",
      "reboot-pending",
      "startup",
      "stopped-services",
      "updates",
      "processes",
    ]);
    expect(result.items.every((item) => item.state === "unknown")).toBe(true);
    expect(result.items[0]?.detail).toBe("not available on linux");
  });

  it("turns probe output into counted, ranked rows", async () => {
    const result = await hardware.detectReliability({
      platform: "win32",
      env: { ProgramData: "C:\\ProgramData" },
      fs: werFs(["Critical_a.exe_1", "AppCrash_FRIDAY.exe_2"], ["AppCrash_old.exe_3"]),
      runPowerShell: host({
        PS_CRASHES: ok(crashJson),
        PS_REBOOT: ok("1\r\n"),
        PS_STARTUP: ok('[{"Name":"OneDrive"},{"Name":"Teams"}]'),
        PS_STOPPED: ok('{"DisplayName":"Windows Update"}'),
        PS_UPDATES: ok('[{"HotFixID":"KB5001","on":"2026-01-10"}]'),
        PS_PROCESSES: ok('[{"n":"chrome","mb":900},{"n":"code","mb":700}]'),
      }),
    });
    const by = (id: string) => result.items.find((item) => item.id === id)!;
    expect(result.supported).toBe(true);
    expect(by("crashes")).toMatchObject({ state: "warn", count: 4 });
    expect(by("crashes").detail).toBe(
      "4 event(s): chrome.exe x2, notepad.exe x1, unnamed (Windows Error Reporting) x1",
    );
    expect(by("wer-reports")).toMatchObject({ state: "warn", queue: 2, archive: 1 });
    expect(by("reboot-pending")).toMatchObject({
      state: "warn",
      detail: "Windows is waiting for a restart",
    });
    expect(by("startup")).toMatchObject({ state: "ok", count: 2, detail: "2: OneDrive, Teams" });
    expect(by("stopped-services").detail).toContain("Windows Update");
    expect(by("updates").detail).toBe("KB5001 (2026-01-10)");
    expect(by("processes").detail).toBe("chrome 900 MB, code 700 MB");
  });

  it("says none recorded when the log is empty and no restart is waiting", async () => {
    const result = await hardware.detectReliability({
      platform: "win32",
      fs: werFs([], []),
      runPowerShell: host({
        PS_CRASHES: ok(""),
        PS_REBOOT: ok("0"),
        PS_STARTUP: ok(""),
        PS_STOPPED: ok(""),
        PS_UPDATES: ok(""),
        PS_PROCESSES: ok(""),
      }),
    });
    const by = (id: string) => result.items.find((item) => item.id === id)!;
    expect(by("crashes")).toMatchObject({ state: "ok", detail: "none recorded" });
    expect(by("reboot-pending").state).toBe("ok");
    expect(by("wer-reports").state).toBe("ok");
    expect(by("stopped-services").detail).toBe("all running");
    expect(by("updates").state).toBe("unknown");
  });

  it("raises many crashes to bad and many stopped services to warn", async () => {
    const many = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        t: "2026-01-14T10:00:00Z",
        p: "Application Error",
        id: 1000,
        m: `Faulting application name: app${i % 2}.exe, version: 1`,
      })),
    );
    const services = JSON.stringify(
      Array.from({ length: 11 }, (_, i) => ({ DisplayName: `svc${i}` })),
    );
    const result = await hardware.detectReliability({
      platform: "win32",
      fs: werFs([], []),
      runPowerShell: host({
        PS_CRASHES: ok(many),
        PS_REBOOT: ok("0"),
        PS_STARTUP: ok("[]"),
        PS_STOPPED: ok(services),
        PS_UPDATES: ok("[]"),
        PS_PROCESSES: ok("[]"),
      }),
    });
    expect(result.items.find((item) => item.id === "crashes")?.state).toBe("bad");
    expect(result.items.find((item) => item.id === "stopped-services")?.state).toBe("warn");
  });

  it("keeps the failure reason for each probe that fails and still returns the rest", async () => {
    const result = await hardware.detectReliability({
      platform: "win32",
      fs: {
        readdirSync: () => {
          throw new Error("EACCES");
        },
        statSync: () => ({ mtimeMs: 0 }),
      },
      runPowerShell: host({
        PS_CRASHES: fail("Get-WinEvent needs elevation"),
        PS_REBOOT: ok("0"),
        PS_STARTUP: fail("CIM timed out"),
        PS_STOPPED: ok("[]"),
        PS_UPDATES: fail("Get-HotFix is blocked"),
        PS_PROCESSES: ok("[]"),
      }),
    });
    const by = (id: string) => result.items.find((item) => item.id === id)!;
    expect(by("crashes")).toMatchObject({
      state: "unknown",
      detail: "Get-WinEvent needs elevation",
    });
    expect(by("startup")).toMatchObject({ state: "unknown", detail: "CIM timed out" });
    expect(by("updates")).toMatchObject({ state: "unknown", detail: "Get-HotFix is blocked" });
    expect(by("wer-reports")).toMatchObject({ state: "unknown" });
    expect(by("reboot-pending").state).toBe("ok");
  });

  it("never keeps a message body, a command line or a path", async () => {
    const result = await hardware.detectReliability({
      platform: "win32",
      fs: werFs([], []),
      runPowerShell: host({
        PS_CRASHES: ok(
          JSON.stringify([
            {
              t: "x",
              p: "Application Error",
              id: 1000,
              m: "Faulting application name: tool.exe, path C:\\Users\\Owner\\secret\\tool.exe",
            },
          ]),
        ),
        PS_REBOOT: ok("0"),
        PS_STARTUP: ok("[]"),
        PS_STOPPED: ok("[]"),
        PS_UPDATES: ok("[]"),
        PS_PROCESSES: ok("[]"),
      }),
    });
    const text = JSON.stringify(result);
    expect(text).toContain("tool.exe");
    expect(text).not.toContain("Owner");
    expect(text).not.toContain("secret");
  });

  it("uses no double quote inside any script, which keeps the Windows command line safe", () => {
    for (const [name, script] of Object.entries(hardware.RELIABILITY_SCRIPTS)) {
      expect(script, name).not.toContain('"');
      expect(script, name).not.toMatch(
        /Remove-|Set-|Stop-|Start-|New-Item|Out-File|Invoke-Expression|iex /,
      );
    }
  });

  // The syntax of the PowerShell text is parsed by PowerShell itself where it exists
  // (the Windows runners); a machine without it skips this one test visibly.
  it.skipIf(!hasCommand("pwsh"))("every probe script parses as PowerShell", () => {
    for (const [name, script] of Object.entries(hardware.RELIABILITY_SCRIPTS)) {
      const parse =
        "$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:PROBE_SCRIPT,[ref]$t,[ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }";
      const run = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", parse], {
        env: { ...process.env, PROBE_SCRIPT: script },
        encoding: "utf8",
        timeout: 30000,
      });
      expect(run.status, `${name}: ${run.stdout}${run.stderr}`).toBe(0);
    }
  });
});
