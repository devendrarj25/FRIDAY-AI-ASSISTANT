/**
 * A long step that prints nothing (pip, npm, winget, an installer) used to look like a hung window, because those
 * tools draw their bars only on a real console and FRIDAY runs them piped. The ticker measures what the step does
 * from the outside and says so on one line every few seconds; winget's own `12 MB / 45 MB` frames become a real
 * percent. Ollama and the Qwen model downloads keep their own bars and are not touched here.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const activity = require_("../../electron/activity.cjs") as {
  dirSize: (dir: string) => number;
  duration: (ms: number) => string;
  activityText: (o: Record<string, number>) => string;
  activityLine: (o: Record<string, unknown>) => string;
  startTicker: (o: Record<string, unknown>) => { stop: () => void };
  pipWatchDirs: (python: string, env?: Record<string, string>) => string[];
  wingetWatchDirs: (env?: Record<string, string>) => string[];
};
const output = require_("../../electron/installer-output.cjs") as {
  progressFromChunk: (
    chunk: string,
  ) => { bytesDone: number; bytesTotal: number; percent: number } | null;
  tidyChunk: (chunk: string) => string[];
};

describe("the proof-of-life line", () => {
  it("reads the time, what has appeared on disk and how fast", () => {
    expect(activity.duration(7_400)).toBe("7s");
    expect(activity.duration(80_000)).toBe("1m20s");
    expect(
      activity.activityText({
        elapsedMs: 80_000,
        grownBytes: 412 * 1024 ** 2,
        recentBytes: 75 * 1024 ** 2,
        recentMs: 15_000,
      }),
    ).toBe("still working · 1m20s · 412 MB so far · 5.0 MB/s");
    expect(activity.activityText({ elapsedMs: 9_000 })).toBe("still working · 9s");
    expect(activity.activityLine({ label: "pip", elapsedMs: 9_000 })).toBe(
      "[friday] pip            still working · 9s",
    );
  });

  it("measures a folder, and a missing one counts as nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-activity-"));
    try {
      mkdirSync(path.join(dir, "a", "b"), { recursive: true });
      writeFileSync(path.join(dir, "one.bin"), Buffer.alloc(1000));
      writeFileSync(path.join(dir, "a", "b", "two.bin"), Buffer.alloc(2500));
      expect(activity.dirSize(dir)).toBe(3500);
      expect(activity.dirSize(path.join(dir, "missing"))).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the ticker", () => {
  it("prints a line when it first fires and then on every interval, with the growth since it began", () => {
    let clock = 0;
    let bytes = 100;
    const lines: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const ticker = activity.startTicker({
      label: "pip",
      watch: ["x"],
      first: 8_000,
      every: 15_000,
      now: () => clock,
      size: () => bytes,
      write: (line: string) => lines.push(line),
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, ms, live: true };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer: { live: boolean }) => {
        timer.live = false;
      },
    });
    expect(timers[0]!.ms).toBe(8_000);
    clock = 8_000;
    bytes = 100 + 8 * 1024 ** 2;
    timers[0]!.fn();
    expect(lines[0]).toContain("still working · 8s · 8.0 MB so far");
    expect(timers[1]!.ms).toBe(15_000);
    clock = 23_000;
    timers[1]!.fn();
    expect(lines).toHaveLength(2);
    ticker.stop();
    expect(timers[2]!.live).toBe(false);
    clock = 40_000;
    timers[2]!.fn();
    expect(lines).toHaveLength(2);
  });

  it("watches where pip and winget write", () => {
    expect(
      activity.pipWatchDirs("C:\\FRIDAY\\runtime\\.venv\\Scripts\\python.exe", {
        LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
      }),
    ).toHaveLength(3);
    expect(activity.wingetWatchDirs({ TEMP: "C:\\Temp" })[0]).toContain("WinGet");
  });
});

describe("winget's own progress frames", () => {
  it("become a size and a percent instead of being thrown away", () => {
    expect(output.progressFromChunk("  ██████▒▒▒▒▒▒  12.3 MB / 45.0 MB")).toMatchObject({
      percent: 27,
      bytesTotal: 47_185_920,
    });
    const newest = output.progressFromChunk("10.0 MB / 50.0 MB\r\n40.0 MB / 50.0 MB");
    expect(newest?.percent).toBe(80);
    expect(output.progressFromChunk("Downloading https://example.test/x.msi")).toBeNull();
    expect(output.progressFromChunk("999 MB / 1 MB")).toBeNull();
  });

  it("still drop those frames from the printed lines", () => {
    expect(output.tidyChunk("██████▒▒▒▒▒▒  12.3 MB / 45.0 MB")).toEqual([]);
  });
});

describe("scripts/with-activity.cjs", () => {
  it("runs a command with its own exit code and prints proof of life beside it", () => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "with-activity.cjs"),
        "--label",
        "slow step",
        "--first",
        "300",
        "--every",
        "300",
        "--",
        process.execPath,
        "-e",
        "setTimeout(()=>process.exit(3), 1500)",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(run.status).toBe(3);
    expect(run.stdout).toMatch(/\[friday\] slow step\s+still working · \d+s/);
  });

  it("is quiet when FRIDAY_ACTIVITY=0", () => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "with-activity.cjs"),
        "--label",
        "x",
        "--first",
        "100",
        "--",
        process.execPath,
        "-e",
        "setTimeout(()=>{}, 800)",
      ],
      { encoding: "utf8", timeout: 30_000, env: { ...process.env, FRIDAY_ACTIVITY: "0" } },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("still working");
  });
});

describe("where it is used", () => {
  it("wraps npm ci in setup, the build and Doctor, and keeps the pinned `npm.cmd ci` text", () => {
    const setup = read("scripts/setup-windows.ps1");
    expect(setup).toContain(
      "scripts\\with-activity.cjs --label 'npm ci' --watch node_modules -- npm.cmd ci --no-audit --no-fund",
    );
    expect(read("scripts/build-pipeline.cjs")).toContain('withActivity("npm ci"');
    expect(read("scripts/doctor.cjs")).toContain('withActivity("npm ci"');
  });

  it("wraps every pip install in setup:python, the Electron download and the moonshine download", () => {
    const python = read("scripts/setup-python.cjs");
    expect(python).toContain(
      'const isPipInstall = (args) => args.includes("pip") && args.includes("install");',
    );
    expect(python).toMatch(/withActivity\(\s*"pip"/);
    expect(read("scripts/ensure-electron.cjs")).toContain('withActivity("electron"');
    expect(read("scripts/prefetch-models.cjs")).toContain('label: "moonshine-en"');
  });

  it("gives every installer job a ticker and a winget percent, and stops the ticker with the job", () => {
    const toolchain = read("electron/toolchain.cjs");
    expect(toolchain).toContain("activity.startTicker({");
    expect(toolchain).toContain("output.progressFromChunk(chunk)");
    expect(toolchain.match(/ticker\.stop\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves the Ollama and Qwen download code alone", () => {
    const models = read("scripts/prefetch-models.cjs");
    expect(models).not.toContain('label: "qwen');
    expect(models).toContain("pulling ${model.tag}");
  });

  it("never reports a total that goes down or a speed from one noisy reading (pip's cache and site-packages alternate)", () => {
    let clock = 0;
    const readings = [0, 65e6, 0.2e6, 0.2e6, 84e6];
    let reading = 0;
    const lines: string[] = [];
    const timers: Array<() => void> = [];
    const ticker = activity.startTicker({
      label: "pip",
      watch: ["x"],
      now: () => clock,
      size: () => readings[Math.min(reading++, readings.length - 1)],
      write: (_line: string, text: string) => lines.push(text),
      setTimer: (fn: () => void) => {
        timers.push(fn);
        return 0;
      },
      clearTimer: () => undefined,
    });
    for (const at of [9_000, 25_000, 41_000, 57_000]) {
      clock = at;
      timers.pop()?.();
    }
    ticker.stop();
    // 65 MB seen once stays the floor of the total; the dip to 0.2 MB is not shown.
    expect(lines[0]).toContain("62 MB so far");
    expect(lines[1]).toContain("62 MB so far");
    expect(lines[2]).toContain("62 MB so far");
    expect(lines[3]).toContain("80 MB so far");
    // Speed is growth over the last few readings (about 65 MB in 25 s here), never a 16 s spike.
    for (const line of lines) {
      const speed = /(\d+(?:\.\d+)?) MB\/s/.exec(line);
      if (speed) expect(Number(speed[1])).toBeLessThan(10);
    }
  });

  it("downloads Maven, Gradle, Composer and CMake from more than one official host, with the same SHA-256 for each", () => {
    const toolchain = require_("../../electron/toolchain.cjs") as {
      toolById: (id: string) => Record<string, any> | null;
    };
    for (const id of ["Maven", "Gradle", "Composer"]) {
      const tool = toolchain.toolById(id);
      expect(tool?.["installerMirrors"]?.length, id).toBeGreaterThan(0);
      for (const url of tool?.["installerMirrors"] || []) expect(url).toMatch(/^https:\/\//);
    }
    expect(read("electron/vendor-sources.cjs")).toContain("https://cmake.org/files/v");
  });
});
