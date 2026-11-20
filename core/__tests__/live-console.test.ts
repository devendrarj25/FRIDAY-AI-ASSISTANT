/**
 * Setup, Doctor and the build look alive and readable on a real console: colour that means something, one moving
 * line that proves a step is working, one summary when it ends, tables that follow the console's width. Off a real
 * console (a log, CI, NO_COLOR) none of it draws and the words are the same.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const ui = require_("../../scripts/live-console.cjs") as {
  colorWanted: (stream: unknown, env: Record<string, string>) => boolean;
  colorize: (line: string) => string;
  redrawsInPlace: (text: string) => boolean;
  shimmer: (label: string, tick: number) => string;
  summaryLine: (o: {
    label: string;
    ok: boolean;
    ms: number;
    bytes: number;
    code?: number;
  }) => string;
  spinnerFrames: (env: Record<string, string>) => string[];
  formatBytes: (n: number) => string;
  LiveLine: new (o: Record<string, unknown>) => {
    active: boolean;
    start: (label: string) => void;
    setDetail: (t: string) => void;
    write: (t: string) => void;
    raw: (c: string) => void;
    resume: (close?: boolean) => void;
    draw: () => void;
    stop: (final?: string) => void;
  };
  runLive: (o: Record<string, unknown>) => Promise<{ status: number; ms: number }>;
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const tty = { isTTY: true };

function fakeStream() {
  const out: string[] = [];
  return { isTTY: true, columns: 100, out, write: (t: string) => void out.push(t) };
}

describe("when colour is used", () => {
  it("only on a real console that wants it, never with NO_COLOR, a dumb terminal or the activity switch off", () => {
    expect(ui.colorWanted(tty, {})).toBe(true);
    expect(ui.colorWanted({ isTTY: false }, {})).toBe(false);
    expect(ui.colorWanted(tty, { NO_COLOR: "1" })).toBe(false);
    expect(ui.colorWanted(tty, { TERM: "dumb" })).toBe(false);
    expect(ui.colorWanted(tty, { FRIDAY_ACTIVITY: "0" })).toBe(false);
    expect(ui.colorWanted({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
    // A step run under the live host is piped but the host prints to a console.
    expect(ui.colorWanted({ isTTY: false }, { FRIDAY_LIVE_TTY: "1" })).toBe(true);
  });
});

describe("colouring a line", () => {
  const lines = [
    "[friday] ok       ripgrep 15.2.0 already installed; not downloaded again",
    "[friday] INFO     Ruby 3.4.13-1 is installed, but 3.4.13 is found first on PATH",
    "[friday] updating CMake 4.4.4 -> 4.5.1 (winget first)",
    "[friday] FAIL     CMake was not installed",
    "[FRIDAY] Installing the exact Node dependency lockfile",
    "[friday] numpy ok",
    "PASS prepare-environment    environment ready",
    "SKIP readiness              skipped: a local build stops here",
    "PASS      Node.js                           v26.5.1               >=22.19.0",
    "DOCTOR PASS - FRIDAY is ready to test, build and run.",
    "FRIDAY BUILD READY - every check that applies passed",
    "FRIDAY BUILD FAILED - see the first error above",
    "==============================================================================",
    "plain text that means nothing special",
  ];

  it("never changes the words: with the colour codes removed every line is exactly as it was", () => {
    for (const line of lines) expect(plain(ui.colorize(line)), line).toBe(line);
  });

  it("colours by meaning: ok green, FAIL red, INFO yellow, a working step cyan, banners bold", () => {
    expect(ui.colorize(lines[0]!)).toContain("\x1b[32mok\x1b[0m");
    expect(ui.colorize(lines[3]!)).toContain("\x1b[1;31mFAIL");
    expect(ui.colorize(lines[1]!)).toContain("\x1b[33mINFO");
    expect(ui.colorize(lines[2]!)).toContain("\x1b[36mupdating");
    expect(ui.colorize(lines[5]!)).toContain("\x1b[32mok\x1b[0m");
    expect(ui.colorize(lines[6]!)).toContain("\x1b[1;32mPASS");
    expect(ui.colorize(lines[7]!)).toContain("\x1b[33mSKIP");
    expect(ui.colorize(lines[9]!)).toContain("\x1b[1;32m");
    expect(ui.colorize(lines[11]!)).toContain("\x1b[1;31m");
    expect(ui.colorize(lines[13]!)).toBe(lines[13]);
  });

  it("leaves a line that is already coloured, and an empty one, alone", () => {
    const coloured = "\x1b[32mdone\x1b[0m";
    expect(ui.colorize(coloured)).toBe(coloured);
    expect(ui.colorize("")).toBe("");
  });

  it("tells a coloured line from output that redraws a row itself", () => {
    expect(ui.redrawsInPlace("\x1b[32mok\x1b[0m done")).toBe(false);
    expect(ui.redrawsInPlace("bar 40%\rbar 50%")).toBe(true);
    expect(ui.redrawsInPlace("row\x1b[K")).toBe(true);
    expect(ui.redrawsInPlace("\x1b[3A\x1b[Jboard")).toBe(true);
  });
});

describe("the live line", () => {
  it("draws a spinner with the step's name and the time, and prints text above it without overwriting", () => {
    const stream = fakeStream();
    let now = 0;
    const live = new ui.LiveLine({
      stream,
      now: () => now,
      frames: ["a", "b"],
      boardActive: () => false,
    });
    live.start("pip");
    now = 12_000;
    live.setDetail("12s · 139 MB so far · 2.1 MB/s");
    live.draw();
    const drawn = plain(stream.out.join(""));
    expect(drawn).toContain("pip");
    expect(drawn).toContain("139 MB so far");
    stream.out.length = 0;
    live.write("[friday] ok       something finished");
    const joined = stream.out.join("");
    // erase the line, print the text with its newline, draw the line again
    expect(joined.startsWith("\r\x1b[K")).toBe(true);
    expect(joined).toContain("something finished\n");
    expect(plain(joined).trimEnd().endsWith("139 MB so far · 2.1 MB/s")).toBe(true);
    live.stop("done");
    expect(stream.out.join("").endsWith("done\n")).toBe(true);
    expect(live.active).toBe(false);
  });

  it("steps aside for a live download bar and for a command that draws its own row", () => {
    const stream = fakeStream();
    let busy = false;
    const live = new ui.LiveLine({ stream, frames: ["a"], boardActive: () => busy });
    live.start("Ruby installing");
    busy = true;
    live.draw();
    // The first draw only takes the spinner off the row; after that it writes nothing while the bar is live.
    expect(stream.out.join("").endsWith("\r\x1b[K")).toBe(true);
    stream.out.length = 0;
    live.draw();
    expect(stream.out.join("")).toBe("");
    busy = false;
    live.raw("bar 40%\r");
    stream.out.length = 0;
    live.draw();
    expect(stream.out.join("")).toBe("");
    live.resume(true);
    expect(stream.out.join("").startsWith("\n")).toBe(true);
    live.stop();
  });

  it("lights one letter of the step's name at a time, and the words stay the same", () => {
    expect(plain(ui.shimmer("installing Ruby", 4))).toBe("installing Ruby");
    expect(ui.shimmer("pip", 1)).toContain("\x1b[1;97m");
    expect(ui.shimmer("pip", 0)).not.toBe(ui.shimmer("pip", 2));
    expect(ui.spinnerFrames({ FRIDAY_ASCII: "1" })).toEqual(["|", "/", "-", "\\"]);
  });

  it("closes a step with one summary line: what it did, how long it took and how much it moved", () => {
    expect(
      plain(ui.summaryLine({ label: "pip", ok: true, ms: 108_000, bytes: 507 * 1024 ** 2 })),
    ).toBe("✔ pip  done in 1m48s · 507 MB");
    expect(plain(ui.summaryLine({ label: "pip", ok: false, ms: 5000, bytes: 0, code: 1 }))).toBe(
      "✖ pip  failed (exit 1) after 5s",
    );
    expect(ui.formatBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
  });
});

describe("running a command under the live line", () => {
  it("prints the command's lines coloured above the line, passes a bar through, and reports its exit", async () => {
    const stream = fakeStream();
    const script =
      "console.log('[friday] ok       first'); process.stdout.write('\\rbar 50%\\x1b[K\\n'); console.error('[friday] FAIL     second'); process.exit(3);";
    const result = await ui.runLive({
      label: "fake step",
      cmd: process.execPath,
      args: ["-e", script],
      stream,
      env: { ...process.env },
    });
    expect(result.status).toBe(3);
    const text = plain(stream.out.join(""));
    expect(text).toContain("[friday] ok       first");
    expect(text).toContain("bar 50%");
    // A failure always gets its summary, however short the step was.
    expect(text).toContain("✖ fake step  failed (exit 3)");
  });
});

describe("where it is used", () => {
  it("runs the silent steps of setup, Doctor and the build under it, and leaves self-drawing scripts alone", () => {
    const pipeline = read("scripts/build-pipeline.cjs");
    expect(pipeline).toContain("withActivityCommand(");
    expect(pipeline).toMatch(/SELF_DISPLAY = new Set\(\[[^\]]*"scripts\/setup-python\.cjs"/s);
    expect(pipeline).toContain("scripts/prefetch-toolkit.cjs");
    expect(pipeline).toContain('"building the interface"');
    expect(read("scripts/setup-python.cjs")).toMatch(/withActivityCommand\(\s*"pip"/);
    expect(read("scripts/doctor.cjs")).toContain('withActivityCommand("npm ci"');
    expect(read("scripts/prefetch-toolkit.cjs")).toContain("live?.start(");
    expect(read("scripts/prefetch-toolkit.cjs")).toContain("live?.stop()");
  });

  it("falls back to plain lines off a real console, so a log stays readable", () => {
    const act = require_("../../scripts/with-activity.cjs") as {
      liveWanted: (env?: Record<string, string>, stream?: unknown) => boolean;
    };
    expect(act.liveWanted({}, { isTTY: false })).toBe(false);
    expect(act.liveWanted({ NO_COLOR: "1" }, tty)).toBe(false);
    expect(act.liveWanted({ FRIDAY_LIVE_LINE: "0" }, tty)).toBe(false);
    expect(act.liveWanted({ FRIDAY_ACTIVITY: "0" }, tty)).toBe(false);
    expect(act.liveWanted({}, tty)).toBe(true);
  });

  it("colours the plain-text scripts and sizes the environment table to the console", () => {
    for (const file of [
      "setup-python",
      "doctor",
      "check-environment",
      "init-runtime",
      "verify-build",
    ]) {
      expect(read(`scripts/${file}.cjs`), file).toContain("installColorConsole()");
    }
    const check = read("scripts/check-environment.cjs");
    expect(check).toContain("process.stdout.columns");
    expect(check).toContain("…");
    expect(check).not.toContain("~`");
  });
});
