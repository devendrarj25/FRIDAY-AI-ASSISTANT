/**
 * The speech and speaking workers are stopped when they hang and when the app closes. Before this the speaker
 * process (text to speech) had no stop at all: it outlived the app and kept the bundled Python locked, and a hung
 * one made every later line wait out another full timeout.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const lifecycle = require(path.join(root, "electron", "app-lifecycle.cjs"));
const neural = require(path.join(root, "electron", "neural-voice.cjs"));
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe("voice worker lifecycle", () => {
  it("stops the speaker with the app: a shutdown step, an owned role, and the right place in the order", () => {
    const order: string[] = lifecycle.shutdownPlan().order;
    expect(order.indexOf("tts")).toBeGreaterThan(order.indexOf("stt"));
    expect(order.indexOf("tts")).toBeLessThan(order.indexOf("wake"));
    expect(order.indexOf("tts")).toBeLessThan(order.indexOf("windows"));
    expect(lifecycle.OWNED_ROLES.has("tts")).toBe(true);
    expect(lifecycle.restartPlan().order).toContain("tts");
    const main = read("electron/main.cjs");
    expect(main).toMatch(/lifeSteps\.tts = \(\) => \{[\s\S]{0,120}neuralVoice\.shutdown\(\)/);
    expect(read("electron/neural-voice.cjs")).toContain('trackOwned("tts"');
  });

  it("stops a speaker that misses its deadline, so the next line starts a fresh one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-tts-"));
    const pidFile = path.join(dir, "pid");
    process.env["FRIDAY_TEST_PIDFILE"] = pidFile;
    try {
      const script =
        "require('fs').writeFileSync(process.env.FRIDAY_TEST_PIDFILE,String(process.pid));setInterval(()=>{},1000)";
      const reply = await neural.speakerRequest(
        [process.execPath, ["-e", script, "--"]],
        { op: "x" },
        400,
      );
      expect(reply).toBeNull();
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(await until(() => !alive(pid))).toBe(true);
      neural.shutdown();
    } finally {
      delete process.env["FRIDAY_TEST_PIDFILE"];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shutdown stops a running speaker and is safe to call again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-tts-"));
    const pidFile = path.join(dir, "pid");
    process.env["FRIDAY_TEST_PIDFILE"] = pidFile;
    try {
      const script =
        "require('fs').writeFileSync(process.env.FRIDAY_TEST_PIDFILE,String(process.pid));setInterval(()=>{},1000)";
      const pending = neural.speakerRequest(
        [process.execPath, ["-e", script, "--"]],
        { op: "x" },
        60000,
      );
      expect(
        await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== ""),
      ).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      neural.shutdown();
      expect(await pending).toBeNull();
      expect(await until(() => !alive(pid))).toBe(true);
      neural.shutdown();
    } finally {
      delete process.env["FRIDAY_TEST_PIDFILE"];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the wake worker is stopped on a timeout too", () => {
    const wake = read("electron/wake-engine.cjs");
    expect(wake).toMatch(/wake worker timed out[\s\S]{0,260}killTree\(session\.child\)/);
    expect(read("electron/stt.cjs")).toMatch(
      /STT worker timed out[\s\S]{0,400}killTree\(session\.child\)/,
    );
  });
});
