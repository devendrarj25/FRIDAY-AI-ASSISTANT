/**
 * Previously kernel-only tool packs now ship index.cjs run(), and the flagged
 * missing tools (ffmpeg, vault, port-scan, git commit/push/merge, reminders,
 * clipboard history, cookie dump) return a real object on a sample input.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "../..");
const require_ = createRequire(import.meta.url);

const WAS_STUBBED = [
  "tools/applications/app-launch",
  "tools/applications/app-focus",
  "tools/applications/app-close",
  "tools/system/window-list",
  "tools/automation/input-click",
  "tools/automation/input-hotkey",
  "tools/automation/input-type",
  "tools/system/screen-read-text",
  "tools/devices/android/android-list",
  "tools/devices/android/android-open-app",
  "tools/devices/android/android-input",
  "tools/devices/android/android-transfer",
  "tools/devices/android/android-mirror",
  "tools/devices/bluetooth/bluetooth-list",
  "tools/devices/bluetooth/bluetooth-scan",
  "tools/devices/bluetooth/bluetooth-media",
  "tools/devices/bluetooth/bluetooth-send-file",
  "tools/devices/network/network-discover",
  "tools/devices/network/network-cast",
];

const NEW_PACKS = [
  "tools/media/ffmpeg-transcode",
  "tools/system/credential-vault",
  "tools/network/port-scan",
  "tools/developer/git-commit",
  "tools/developer/git-push",
  "tools/developer/git-merge",
  "tools/time/reminder-engine",
  "tools/system/clipboard-history",
  "tools/browser/cookie-dump",
];

function runBounded<T>(label: string, fn: () => Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function loadRun(rel: string) {
  const file = path.join(ROOT, rel, "index.cjs");
  const mod = require_(file) as { run: (input?: Record<string, unknown>) => Promise<unknown> };
  expect(typeof mod.run, rel).toBe("function");
  return mod.run;
}

describe("stubbed and missing tool packs", () => {
  it("gives every former kernel-only pack a real index.cjs", () => {
    for (const rel of WAS_STUBBED) {
      expect(fs.existsSync(path.join(ROOT, rel, "index.cjs")), rel).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, rel, "tool.json"), "utf8")) as {
        entry: string;
        enabled: boolean;
        kernelTool?: string;
        risk: string;
      };
      expect(manifest.entry).toBe("index.cjs");
      expect(manifest.enabled).toBe(false);
      expect(manifest.kernelTool).toBeTruthy();
    }
  });

  it("runs each former stub and each new pack on a sample input", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "friday-stubbed-tools-"));
    try {
      const samples: Record<string, Record<string, unknown>> = {
        "tools/applications/app-launch": { app: "friday-missing-app-xyz-probe" },
        "tools/applications/app-focus": {},
        "tools/applications/app-close": {},
        "tools/system/window-list": {},
        "tools/automation/input-click": {},
        "tools/automation/input-hotkey": {},
        "tools/automation/input-type": {},
        "tools/system/screen-read-text": {},
        "tools/devices/android/android-list": {},
        "tools/devices/android/android-open-app": {},
        "tools/devices/android/android-input": { action: "tap" },
        "tools/devices/android/android-transfer": {},
        "tools/devices/android/android-mirror": {},
        "tools/devices/bluetooth/bluetooth-list": {},
        "tools/devices/bluetooth/bluetooth-scan": { seconds: 0.2 },
        "tools/devices/bluetooth/bluetooth-media": {},
        "tools/devices/bluetooth/bluetooth-send-file": {},
        "tools/devices/network/network-discover": { kind: "mdns", seconds: 0.2 },
        "tools/devices/network/network-cast": {},
        "tools/media/ffmpeg-transcode": { probe: true },
        "tools/system/credential-vault": {
          action: "set",
          id: "probe",
          value: "secret-probe",
          root: tmp,
        },
        "tools/network/port-scan": { host: "127.0.0.1", ports: [1], timeoutMs: 200 },
        "tools/developer/git-commit": { probe: true, root: ROOT },
        "tools/developer/git-push": { probe: true, root: ROOT },
        "tools/developer/git-merge": { probe: true, root: ROOT },
        "tools/time/reminder-engine": { action: "add", text: "pay GST in 2 days", root: tmp },
        "tools/system/clipboard-history": { action: "capture", text: "clipboard-probe", root: tmp },
        "tools/browser/cookie-dump": {},
      };
      for (const rel of [...WAS_STUBBED, ...NEW_PACKS]) {
        const result = (await runBounded(rel, () => loadRun(rel)(samples[rel] || {}), 45_000)) as {
          ok?: boolean;
        };
        expect(result, rel).toBeTruthy();
        expect(typeof result).toBe("object");
      }
      const vault = (await loadRun("tools/system/credential-vault")({
        action: "list",
        root: tmp,
      })) as { ok: boolean; ids: string[] };
      expect(vault.ok).toBe(true);
      expect(vault.ids).toContain("probe");
      const reminder = (await loadRun("tools/time/reminder-engine")({
        action: "list",
        root: tmp,
      })) as { ok: boolean; count: number };
      expect(reminder.ok).toBe(true);
      expect(reminder.count).toBeGreaterThan(0);
      const clip = (await loadRun("tools/system/clipboard-history")({
        action: "list",
        root: tmp,
      })) as { ok: boolean; items: { text: string }[] };
      expect(clip.items[0]?.text).toBe("clipboard-probe");
      const ports = (await loadRun("tools/network/port-scan")({
        host: "127.0.0.1",
        ports: [1],
        timeoutMs: 200,
      })) as { ok: boolean; scanned: number };
      expect(ports.ok).toBe(true);
      expect(ports.scanned).toBe(1);

      let ffmpegOnPath = false;
      try {
        execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
          timeout: 4000,
          windowsHide: true,
        });
        ffmpegOnPath = true;
      } catch {
        ffmpegOnPath = false;
      }
      if (ffmpegOnPath) {
        const wav = path.join(tmp, "sine.wav");
        const mp3 = path.join(tmp, "sine.mp3");
        execFileSync(
          "ffmpeg",
          ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.15", wav],
          { timeout: 8000, windowsHide: true, stdio: "pipe" },
        );
        const trans = (await loadRun("tools/media/ffmpeg-transcode")({
          input: wav,
          output: mp3,
          args: ["-ac", "1"],
        })) as { ok: boolean };
        expect(trans.ok).toBe(true);
        expect(fs.existsSync(mp3)).toBe(true);
        expect(fs.statSync(mp3).size).toBeGreaterThan(100);
      }

      const repo = path.join(tmp, "git-repo");
      fs.mkdirSync(repo);
      execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "probe@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Probe"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
      const committed = (await loadRun("tools/developer/git-commit")({
        message: "probe commit",
        paths: ["a.txt"],
        root: repo,
      })) as { ok: boolean; output?: string };
      expect(committed.ok).toBe(true);
      expect(String(committed.output || "")).toMatch(/probe commit/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 180_000);
});
