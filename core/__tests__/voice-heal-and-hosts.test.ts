/**
 * Speech downloads follow a source family. A redirect may stay in that family.
 * Voice heal and the Voice buttons share one policy.
 */
import { describe, expect, it, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { advanceVad, quietInputPlan } from "../../src/lib/friday/voice-audio";
import { planLiveStt } from "../../src/lib/friday/speech-stt";
import {
  HEAL_CLASSES,
  classifyVoiceFault,
  emptyHealMemory,
  noteHealFixed,
  planVoiceHeal,
  spokenRepairLine,
} from "../../src/lib/friday/voice-heal";
import { intentStatusLine } from "../../src/lib/friday/use-friday-live";

const require_ = createRequire(import.meta.url);
const safety = require_("../../electron/download-safety.cjs");
const voiceInstall = require_("../../electron/voice-install.cjs");

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

afterEach(() => {
  delete process.env["FRIDAY_HF_MIRROR"];
});

describe("download source families", () => {
  it("allows Hugging Face CDN suffixes and rejects an unknown host", () => {
    expect(
      safety.assertAllowedUrl("https://huggingface.co/Systran/faster-whisper-base").fridayFamily,
    ).toBe("huggingface");
    expect(safety.assertAllowedUrl("https://us.aws.cdn.hf.co/file").fridayFamily).toBe(
      "huggingface",
    );
    expect(safety.assertAllowedUrl("https://cas-bridge.xethub.hf.co/file").fridayFamily).toBe(
      "huggingface",
    );
    expect(safety.assertAllowedUrl("https://cdn-lfs-us-1.huggingface.co/file").fridayFamily).toBe(
      "huggingface",
    );
    expect(() => safety.assertAllowedUrl("https://hf-mirror.com/file")).toThrow(/not allowlisted/);
    expect(() => safety.assertAllowedUrl("https://evil.example/x")).toThrow(/not allowlisted/);
    process.env["FRIDAY_HF_MIRROR"] = "1";
    expect(safety.assertAllowedUrl("https://hf-mirror.com/file").fridayFamily).toBe("opt-in");
  });

  it("follows a recorded Hugging Face redirect and aborts a cross-family hop", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("huggingface.co/repo")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://us.aws.cdn.hf.co/weights" },
        });
      }
      if (href.includes("us.aws.cdn.hf.co")) return new Response("ok", { status: 200 });
      if (href.includes("huggingface.co/cross")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/from-hf" },
        });
      }
      if (href.includes("huggingface.co/unknown")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/blob" },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    try {
      const ok = await safety.fetchAllowlisted("https://huggingface.co/repo");
      expect(ok.url).toContain("us.aws.cdn.hf.co");
      await expect(safety.fetchAllowlisted("https://huggingface.co/cross")).rejects.toThrow(
        /source family/,
      );
      await expect(safety.fetchAllowlisted("https://huggingface.co/unknown")).rejects.toThrow(
        /not allowlisted/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("names blocked, offline, disk, and checksum failures for the owner", () => {
    expect(
      voiceInstall.classifyDownloadError("host is not allowlisted: us.aws.cdn.hf.co").line,
    ).toBe("blocked: us.aws.cdn.hf.co");
    expect(
      voiceInstall.classifyDownloadError("Systran/faster-whisper-base: fetch failed").line,
    ).toBe("offline");
    expect(voiceInstall.classifyDownloadError("ENOSPC").line).toBe("disk full");
    expect(voiceInstall.classifyDownloadError("checksum mismatch for model.bin").line).toBe(
      "checksum mismatch",
    );
    expect(voiceInstall.hfHostList({}).includes("https://hf-mirror.com")).toBe(false);
    expect(
      voiceInstall.hfHostList({ FRIDAY_HF_MIRROR: "1" }).includes("https://hf-mirror.com"),
    ).toBe(true);
  });

  it("resumes a partial file, rejects a bad checksum, and stops when the disk cannot fit", async () => {
    const downloads = require_("../../electron/model-download.cjs");
    const body = Buffer.from("hello-world-speech");
    const server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, {
          "content-length": String(body.length),
          "accept-ranges": "bytes",
        });
        res.end();
        return;
      }
      const range = String(req.headers.range || "");
      const start = range.startsWith("bytes=") ? Number(range.slice(6).split("-")[0]) : 0;
      const from = Number.isFinite(start) ? start : 0;
      const slice = body.subarray(from);
      res.writeHead(from > 0 ? 206 : 200, { "content-length": String(slice.length) });
      res.end(slice);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    const dir = await mkdtemp(join(tmpdir(), "friday-stt-"));
    const dest = join(dir, "model.bin");
    try {
      await writeFile(`${dest}.part`, body.subarray(0, 5));
      const events: Array<{ percent?: number | null }> = [];
      await downloads.downloadUrl(`http://127.0.0.1:${port}/model.bin`, dest, {
        onEvent: (event: { percent?: number | null }) => events.push(event),
      });
      expect(await readFile(dest)).toEqual(body);
      expect(events.some((event) => event.percent === 100)).toBe(true);
      const digest = createHash("sha256").update(body).digest("hex");
      expect(digest).toHaveLength(64);
      const bad = join(dir, "bad.bin");
      await expect(
        downloads.downloadUrl(`http://127.0.0.1:${port}/model.bin`, bad, {
          sha256: "0".repeat(64),
        }),
      ).rejects.toThrow(/checksum mismatch/);
      expect(() => downloads.assertDiskRoom(dir, Number.MAX_SAFE_INTEGER)).toThrow(/disk full/);
      await expect(
        downloads.downloadUrl("https://evil.example/file", join(dir, "no.bin")),
      ).rejects.toThrow(/not allowlisted/);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("speech ladder, hearing, and self-heal", () => {
  it("keeps privacy on a local engine and falls through when whisper is blocked", () => {
    const ready = planLiveStt({
      whisperReady: true,
      weightsReady: true,
      english: false,
      moonshineReady: true,
      windowsSpeech: true,
      privacy: true,
      size: "base",
    });
    expect(ready.engine).toBe("faster-whisper");
    expect(ready.local).toBe(true);
    const next = planLiveStt({
      whisperReady: false,
      weightsReady: false,
      blocked: true,
      blockReason: "blocked: us.aws.cdn.hf.co",
      english: true,
      moonshineReady: true,
      windowsSpeech: true,
      privacy: true,
    });
    expect(next.engine).toBe("moonshine");
    const windows = planLiveStt({
      whisperReady: false,
      weightsReady: false,
      english: false,
      moonshineReady: true,
      windowsSpeech: true,
    });
    expect(windows.engine).toBe("windows-speech");
    const missing = planLiveStt({
      whisperReady: false,
      weightsReady: false,
      english: false,
      moonshineReady: false,
      windowsSpeech: false,
    });
    expect(missing.engine).toBe("none");
    expect(missing.status).toBe("missing");
  });

  it("hears a quiet voice above the floor and ignores a steady hum", () => {
    let floor = 0.004;
    let frames = 0;
    let speech = false;
    for (let i = 0; i < 3; i += 1) {
      const step = advanceVad({
        level: 0.02,
        noiseFloor: floor,
        voiceFrames: frames,
        speakingGuard: false,
        ducked: false,
      });
      floor = step.noiseFloor;
      frames = step.voiceFrames;
      speech = step.speech;
    }
    expect(speech).toBe(true);
    const notice = quietInputPlan({ floor: 0.002, segments: 0, quietMs: 9000, told: false });
    expect(notice.tellOwner).toBe(true);
    expect(notice.gain).toBe(2);
    expect(quietInputPlan({ floor: 0.002, segments: 0, quietMs: 9000, told: true }).tellOwner).toBe(
      false,
    );
  });

  it("does not call a live microphone a missing microphone when recognition is down", () => {
    expect(
      intentStatusLine({
        voice: "unavailable",
        paused: false,
        micAvailable: true,
        sttReason: "not verified",
      }),
    ).toBe("speech recognition not ready (not verified)");
    expect(intentStatusLine({ voice: "unavailable", paused: true, micAvailable: true })).toBe(
      "microphone paused",
    );
    expect(intentStatusLine({ voice: "unavailable", paused: false, micAvailable: false })).toBe(
      "microphone unavailable",
    );
  });

  it("bounds every heal class and never speaks a raw host error", () => {
    expect(spokenRepairLine("host is not allowlisted: us.aws.cdn.hf.co", "detail")).toBe(
      "My speech recognition is still starting, one moment",
    );
    expect(spokenRepairLine("The microphone is busy.", "The microphone is busy.")).toBe(
      "The microphone is busy.",
    );
    const reports: Array<string | null> = [];
    for (const fault of HEAL_CLASSES) {
      let memory = emptyHealMemory();
      let last = "";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const plan = planVoiceHeal({
          fault,
          now: 1_000 + attempt,
          memory,
          auto: true,
        });
        memory = plan.memory;
        last = plan.action;
        if (attempt === 3) {
          expect(plan.retry).toBe(false);
          expect(plan.report).toMatch(/^Needs you:/);
          reports.push(plan.report);
          const again = planVoiceHeal({ fault, now: 1_004, memory, auto: true });
          expect(again.report).toBeNull();
        } else {
          expect(plan.retry).toBe(true);
        }
      }
      expect(last).toBe("needs-you");
      expect(noteHealFixed(fault)).toMatch(/^Fixed:/);
    }
    expect(new Set(reports).size).toBe(HEAL_CLASSES.length);
    expect(classifyVoiceFault("host is not allowlisted: us.aws.cdn.hf.co")).toBe("stt-blocked");
  });

  it("uses the same heal function for Fix voice, the mic, the wake check, and recovery", () => {
    const assistant = read("src/lib/friday/assistant-mode.ts");
    const main = read("electron/main.cjs");
    expect(assistant).toContain("planVoiceHeal");
    expect(assistant).toContain("applyVoiceHeal");
    expect(assistant).toMatch(/fixVoice\(\)[\s\S]*applyVoiceHeal/);
    expect(assistant).toMatch(/resetMicrophone\(\)[\s\S]*applyVoiceHeal/);
    expect(assistant).toMatch(/refreshWakeEngine[\s\S]*applyVoiceHeal/);
    expect(assistant).toMatch(/scheduleSttRecovery[\s\S]*applyVoiceHeal/);
    expect(assistant).toMatch(/async verifyVoiceRuntime\(\)[\s\S]*applyVoiceHeal/);
    expect(main).toContain('id: "voice-heal"');
  });
});
