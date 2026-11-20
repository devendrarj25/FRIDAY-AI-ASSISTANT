/**
 * Every progress bar of setup, Doctor and the build is one solid coloured line on a real console, and plain text in a
 * log. A long silent install (winget) shows a live line with the share it reports. Numbered steps give the flow a head.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

const bars = require_("../../scripts/console-bar.cjs") as {
  solidBar: (filled: number, total: number, tone?: string) => string;
  solidBarOf: (fraction: number, total: number, tone?: string) => string;
  plainBarOf: (fraction: number, total: number) => string;
  recolorBars: (text: string) => string;
};
const live = require_("../../scripts/live-console.cjs") as {
  recolorStream: (stream: unknown, env?: Record<string, string>) => () => void;
};
const ui = require_("../../scripts/live-console.cjs") as {
  colorize: (line: string) => string;
  LiveLine: new (o: Record<string, unknown>) => {
    start: (label: string) => void;
    setProgress: (f: number | null) => void;
    draw: () => void;
    stop: (final?: string) => void;
  };
  runLive: (o: Record<string, unknown>) => Promise<{ status: number; ms: number }>;
};
const board = require_("../../scripts/download-board.cjs") as {
  paint: (line: string, state?: string) => string;
  renderRow: (row: Record<string, unknown>) => string;
};

function fakeStream() {
  const out: string[] = [];
  return { isTTY: true, columns: 100, out, write: (t: string) => void out.push(t) };
}

describe("a bar is one solid coloured line", () => {
  it("lights the filled cells in the colour of the state and leaves the rest dark grey", () => {
    const bar = bars.solidBar(6, 24, "running");
    expect(plain(bar)).toBe("▬".repeat(24));
    expect(bar).toContain("\x1b[32m" + "▬".repeat(6) + "\x1b[0m");
    expect(bar).toContain("\x1b[90m" + "▬".repeat(18) + "\x1b[0m");
    expect(bars.solidBar(24, 24, "done")).toContain("\x1b[32m");
    expect(bars.solidBar(3, 24, "failed")).toContain("\x1b[31m");
    expect(plain(bars.solidBarOf(0.5, 10))).toBe("▬".repeat(10));
    expect(bars.plainBarOf(0.25, 8)).toBe("##------");
  });

  it("turns a tool's `[#####-----]` bar into that line and never touches a word in brackets", () => {
    const line = "[friday] CMake          [########----------------] 33% 18/54 MB 6.7 MB/s";
    const coloured = bars.recolorBars(line);
    expect(coloured).not.toContain("[#");
    expect(plain(coloured)).toBe(`[friday] CMake          ${"▬".repeat(24)} 33% 18/54 MB 6.7 MB/s`);
    expect(bars.recolorBars("  • downloading [==========>         ] 50% | nsis")).toContain(
      "\x1b[32m",
    );
    expect(bars.recolorBars("[friday] ok [done] [ok]")).toBe("[friday] ok [done] [ok]");
  });

  it("colours the bars of printed lines and keeps every other word", () => {
    const line =
      "[friday] stt-base         [########################] 100%  8.0 MB/s average in 17s";
    const out = ui.colorize(line);
    expect(plain(out)).toBe(
      "[friday] stt-base         " + "▬".repeat(24) + " 100%  8.0 MB/s average in 17s",
    );
    expect(out).toContain("\x1b[32m");
  });

  it("paints the download board's rows as solid lines, and a log keeps `[####----]`", () => {
    const row = {
      id: "stt-small",
      state: "running",
      percent: 25,
      bytesDone: 10 * 1024 ** 2,
      bytesTotal: 40 * 1024 ** 2,
      speed: 4,
      eta: 8,
    };
    const text = board.renderRow(row);
    expect(text).toContain("[######------------------]");
    const painted = board.paint(text, "running");
    expect(painted).toContain("▬");
    expect(painted).not.toContain("[#");
    expect(plain(painted)).toContain("▬".repeat(24));
    const failed = board.paint(board.renderRow({ id: "x", state: "failed", note: "no" }), "failed");
    expect(failed).toContain("\x1b[31m" + "▬".repeat(24));
  });

  it("draws the model, pack and tool downloads through the same bar on a console", () => {
    expect(read("scripts/stage-toolchain.cjs")).toContain(
      'paint(line, percent >= 100 ? "done" : "running")',
    );
    expect(read("scripts/prefetch-toolkit.cjs")).toContain(
      '.paint(line, percent >= 100 ? "done" : "running")',
    );
    expect(read("scripts/download-board.cjs")).toContain('require("./console-bar.cjs")');
  });
});

describe("a bar a library draws itself", () => {
  it("electron-builder's 90 cell download bar becomes the standard 24 cell bar with the same share", () => {
    const wide = `[${"=".repeat(45)}${" ".repeat(45)}] 50% | nsis-3.0.4.1.7z`;
    const out = bars.recolorBars(wide);
    expect(plain(out)).toBe(`${"▬".repeat(24)} 50% | nsis-3.0.4.1.7z`);
    expect(out).toContain("\x1b[32m" + "▬".repeat(12) + "\x1b[0m");
    const done = plain(bars.recolorBars(`[${"=".repeat(90)}] 100% | x`));
    expect(done).toBe(`${"▬".repeat(24)} 100% | x`);
  });

  it("recolorStream recolours what is written straight to a console stream, and gives the stream back", () => {
    const seen: string[] = [];
    const stream = { isTTY: true, write: (t: string) => void seen.push(t) };
    const original = stream.write;
    const restore = live.recolorStream(stream, { TERM: "xterm" });
    stream.write(`\r[${"=".repeat(30)}${" ".repeat(60)}] 33% | a`);
    stream.write("plain words [ok]");
    expect(plain(seen[0]!)).toContain("▬".repeat(24));
    expect(seen[1]).toBe("plain words [ok]");
    restore();
    expect(stream.write).toBe(original);
    const log = { isTTY: false, write: (t: string) => void seen.push(t) };
    const untouched = log.write;
    live.recolorStream(log, { TERM: "xterm" })();
    expect(log.write).toBe(untouched);
  });

  it("the installer-tools download goes through it", () => {
    const text = read("scripts/ensure-electron.cjs");
    expect(text).toContain("recolorStream(process.stdout, env)");
    expect(text).toMatch(/finally \{\s*restoreBars\(\);/);
  });
});

describe("the build prints each check once", () => {
  it("the pipeline's own packaged-requires phase is not repeated inside verify-build; a direct run still does it", () => {
    expect(read("scripts/build-pipeline.cjs")).toContain(
      'const verifyArgs = [mode, "--skip-packaged-requires"];',
    );
    const verify = read("scripts/verify-build.cjs");
    expect(verify).toContain('args.includes("--skip-packaged-requires")');
    expect(verify).toContain('if (!skipPackagedRequires && (wantsInstaller || mode === "dir"))');
  });
});

describe("numbered steps", () => {
  it("gives Doctor and build steps a head with an overall bar, and keeps the title", () => {
    for (const line of [
      "[friday] doctor 4/10: speech, voice and chat models",
      "[friday] build 3/13: stage-toolchain",
    ]) {
      const out = ui.colorize(line);
      expect(out).toContain("▬");
      const title = line.split(": ")[1]!;
      expect(plain(out)).toContain(title);
      expect(plain(out)).toMatch(/^\[friday\] (doctor|build) \d+\/\d+ ▬+ /);
    }
    const half = plain(ui.colorize("[friday] doctor 5/10: x"));
    expect(half).toContain("▬".repeat(12));
  });

  it("numbers every phase of the build before it runs", () => {
    expect(read("scripts/build-pipeline.cjs")).toContain(
      "`[friday] build ${index + 1}/${phases.length}: ${phase}`",
    );
  });

  it("numbers the nine stages of setup in the PowerShell script, with the same bar", () => {
    const ps = read("scripts/setup-windows.ps1");
    expect(ps).toContain("$script:StageTotal = 9");
    const calls = [...ps.matchAll(/^\s*Write-Stage (\d) '/gm)].map((m) => Number(m[1]));
    expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Plain text in a log, a small green rectangle row on a console (written as a code point, so the file is ASCII). A full block is never used (it merged two bars under each other into one slab).
    expect(ps).toContain("[char]0x25AC");
    expect(ps).toContain("Test-LiveConsole");
    expect(ps).not.toContain("[char]0x2501");
    expect(ps).not.toContain("0x2588");
    // The build runs the toolchain step alone: it prints no "Step 1 of 9".
    expect(ps).toMatch(
      /function Write-Stage[^\n]*\n[^\n]*\n\s*if \(\$ToolchainOnly\) \{ return \}/,
    );
  });
});

describe("the live line shows the share an installer reports", () => {
  it("draws a solid bar with the percent after the name, and none when no share is known", () => {
    const stream = fakeStream();
    const live = new ui.LiveLine({ stream, env: {} });
    live.start("winget FFmpeg");
    live.setProgress(0.4);
    live.draw();
    const withBar = plain(stream.out.join(""));
    expect(withBar).toContain("winget FFmpeg");
    expect(withBar).toContain("▬".repeat(16));
    expect(withBar).toContain(" 40%");
    live.setProgress(null);
    stream.out.length = 0;
    live.draw();
    expect(plain(stream.out.join(""))).not.toContain("▬");
    live.stop();
  });

  it("runs an installer tidy: frames are dropped, a line is printed once, an accepted exit code is not a failure", async () => {
    const stream = fakeStream();
    const script = [
      "const w=(t)=>process.stdout.write(t);",
      "w('Found FFmpeg [Gyan.FFmpeg] Version 9.1\\n');",
      "w('\\r  ██▒▒▒▒▒▒  9.0 MB / 45.0 MB');",
      "w('\\r  ████▒▒▒▒  18.0 MB / 45.0 MB');",
      "w('\\n');",
      "w('Starting package install...\\n');",
      "w('Starting package install...\\n');",
      "setTimeout(()=>{w('Successfully installed\\n');process.exit(3);},1700);",
    ].join("");
    const result = await ui.runLive({
      label: "winget FFmpeg",
      cmd: process.execPath,
      args: ["-e", script],
      stream,
      env: { ...process.env },
      tidy: true,
      okCodes: [3],
    });
    expect(result.status).toBe(3);
    const text = plain(stream.out.join(""));
    expect(text).toContain("Found FFmpeg [Gyan.FFmpeg] Version 9.1");
    expect(text.match(/Starting package install\.\.\./g)?.length).toBe(1);
    expect(text).toContain("Successfully installed");
    expect(text).not.toContain("▒");
    expect(text).toContain("√ winget FFmpeg");
    expect(text).not.toContain("failed");
  });

  it("is used for every winget call of setup on a console, with the old filter as the fallback", () => {
    const ps = read("scripts/setup-windows.ps1");
    expect(ps).toContain("live-console.cjs");
    expect(ps).toContain("--tidy --ok '-1978335189' -- winget.exe @WingetArgs");
    // A fresh PC has no Node.js yet: the filter below the host call still prints the same lines.
    expect(ps).toMatch(/Get-Command node\.exe[^\n]*\n[^\n]*Test-LiveConsole/s);
    expect(ps).toContain("$script:WingetNoise");
    expect(ps).toContain('"winget install $PackageId"');
    expect(ps).toContain('"winget $Label"');
  });

  it("runs the command as it is when the host is not on a real console", () => {
    expect(read("scripts/live-console.cjs")).toContain(
      "if (!(process.stdout.isTTY && colorWanted(process.stdout)))",
    );
  });
});

describe("a packaging revision is not a newer release", () => {
  it("Ruby 3.4.13-1 is the same release as 3.4.13, and 3.4.14 is newer than both", () => {
    const toolkit = require_("../../scripts/prefetch-toolkit.cjs") as {
      newer: (a: string, b: string) => boolean;
    };
    expect(toolkit.newer("3.4.13-1", "3.4.13")).toBe(false);
    expect(toolkit.newer("3.4.14", "3.4.13-1")).toBe(true);
    expect(toolkit.newer("3.4.13", "3.4.12")).toBe(true);
    const inventory = require_("../../electron/install-inventory.cjs") as {
      newer: (a: string, b: string) => boolean;
    };
    expect(inventory.newer("3.4.13-1", "3.4.13")).toBe(false);
    expect(inventory.newer("3.4.14-1", "3.4.13")).toBe(true);
  });
});
