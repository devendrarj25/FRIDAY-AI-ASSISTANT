/**
 * The hardware validation harness: its scoring and its refusal to call anything verified without a Windows run.
 * These tests run on any machine and say nothing about any device. They prove the checker is honest.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SoakRecorder } from "../../src/lib/friday/voice-engine/soak-recorder";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const lib = require_(path.join(root, "scripts/voice-validation.cjs"));
const cli = path.join(root, "scripts/voice-hardware-validate.cjs");

type Metrics = Record<string, number>;
/** Measured numbers that meet every criterion of every scenario. */
function passingReport() {
  const report = lib.blankReport();
  const best: Record<string, Metrics> = {};
  for (const scenario of lib.catalog().scenarios) {
    best[scenario.id] = Object.fromEntries(
      scenario.criteria.map((c: { metric: string; min?: number; max?: number }) => [
        c.metric,
        c.min !== undefined ? c.min : 0,
      ]),
    );
    report.scenarios[scenario.id] = {
      status: "pass",
      measured: best[scenario.id],
      evidence: "screen recording and notes",
    };
  }
  report.machine = {
    os: "win32",
    osVersion: "10.0.26100",
    appPackaged: true,
    appVersion: "1.1.5.7",
    cpu: "x",
    ramGb: 16,
    gpu: "x",
    inputDevice: "Realtek Microphone Array",
    outputDevice: "Realtek Speakers",
    testedBy: "owner",
    date: "2026-11-12",
  };
  return report;
}

describe("the catalog covers every required check, with numbers", () => {
  const scenarios = lib.catalog().scenarios as Array<{
    id: string;
    steps: string[];
    criteria: Array<{ metric: string; min?: number; max?: number }>;
  }>;

  it("names the eight scenarios the owner asked for", () => {
    expect(scenarios.map((s) => s.id)).toEqual([
      "stt-hindi-hinglish",
      "sarvam-live-captions",
      "sarvam-streaming-tts",
      "speaker-playback",
      "interrupt-mid-sentence",
      "no-self-echo",
      "session-30-minutes",
      "mic-unplug-replug",
    ]);
  });

  it("gives every scenario steps and at least one numeric limit on every criterion", () => {
    for (const s of scenarios) {
      expect(s.steps.length, s.id).toBeGreaterThan(1);
      for (const c of s.criteria)
        expect(typeof c.min === "number" || typeof c.max === "number", `${s.id}.${c.metric}`).toBe(
          true,
        );
    }
  });

  it("asks for the thirty minutes, twenty interruptions, thirty replies and five unplugs literally", () => {
    const limit = (id: string, metric: string) =>
      scenarios.find((s) => s.id === id)?.criteria.find((c) => c.metric === metric);
    expect(limit("session-30-minutes", "durationMinutes")?.min).toBe(30);
    expect(limit("interrupt-mid-sentence", "trials")?.min).toBe(20);
    expect(limit("no-self-echo", "replies")?.min).toBe(30);
    expect(limit("no-self-echo", "selfEchoTurns")?.max).toBe(0);
    expect(limit("mic-unplug-replug", "trials")?.min).toBe(5);
  });
});

describe("speech scoring", () => {
  const phrases = lib.phrases().phrases as Array<{ id: string; group: string; text: string }>;

  it("has the phrases in three groups, each with the same number", () => {
    const count = (g: string) => phrases.filter((p) => p.group === g).length;
    expect([count("hindi"), count("hinglish"), count("english")]).toEqual([8, 8, 8]);
    expect(new Set(phrases.map((p) => p.id)).size).toBe(24);
  });

  it("scores a perfect transcript at zero and a total miss at one", () => {
    const exact = Object.fromEntries(phrases.map((p) => [p.id, p.text]));
    expect(lib.scoreTranscripts(phrases, exact)).toMatchObject({
      phrases: 24,
      hindiWer: 0,
      hinglishWer: 0,
      englishWer: 0,
      missing: [],
    });
    const none = lib.scoreTranscripts(phrases, {});
    expect([none.hindiWer, none.hinglishWer, none.englishWer]).toEqual([1, 1, 1]);
    expect(none.phrases).toBe(0);
    expect(none.missing).toHaveLength(24);
  });

  it("ignores case and punctuation but counts every wrong, extra or missing word", () => {
    expect(lib.words("Open the Downloads folder!")).toEqual(["open", "the", "downloads", "folder"]);
    expect(lib.editDistance(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(lib.editDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(lib.editDistance(["a"], ["a", "b", "c"])).toBe(2);
    const one = [{ id: "en-x", group: "english", text: "set a timer for ten minutes" }];
    expect(
      lib.scoreTranscripts(one, { "en-x": "Set a timer for 10 minutes." }).englishWer,
    ).toBeCloseTo(1 / 6, 3);
  });

  it("counts a transcript in the other script as wrong words, not as a match", () => {
    const one = [{ id: "hx-x", group: "hinglish", text: "volume thoda kam kar do" }];
    expect(lib.scoreTranscripts(one, { "hx-x": "वॉल्यूम थोड़ा कम कर दो" }).hinglishWer).toBe(1);
    const hindi = [{ id: "hi-x", group: "hindi", text: "आज मौसम कैसा रहेगा" }];
    expect(lib.scoreTranscripts(hindi, { "hi-x": "आज मौसम कैसा रहेगा।" }).hindiWer).toBe(0);
  });

  it("does not let skipping a phrase lower the rate", () => {
    const two = [
      { id: "a", group: "english", text: "one two" },
      { id: "b", group: "english", text: "three four" },
    ];
    expect(lib.scoreTranscripts(two, { a: "one two" }).englishWer).toBe(0.5);
  });
});

describe("the report check", () => {
  it("verifies only a complete Windows report that meets every criterion", () => {
    const verdict = lib.checkReport(passingReport());
    expect(verdict.machineProblems).toEqual([]);
    expect(verdict.verified).toBe(true);
  });

  it("is unverified for a blank report, and says nothing was measured", () => {
    const verdict = lib.checkReport(lib.blankReport());
    expect(verdict.verified).toBe(false);
    expect(verdict.results.every((r: { pass: boolean }) => !r.pass)).toBe(true);
    expect(verdict.results[0].rows.every((r: { value: number | null }) => r.value === null)).toBe(
      true,
    );
  });

  it("refuses a Linux run, a development build and a missing device, however good the numbers are", () => {
    const linux = passingReport();
    linux.machine.os = "linux";
    expect(lib.checkReport(linux).verified).toBe(false);
    expect(lib.checkReport(linux).machineProblems.join(" ")).toMatch(/not made on Windows/);
    const dev = passingReport();
    dev.machine.appPackaged = false;
    expect(lib.checkReport(dev).machineProblems.join(" ")).toMatch(/installed or portable build/);
    const noDevice = passingReport();
    noDevice.machine.inputDevice = "";
    expect(lib.checkReport(noDevice).verified).toBe(false);
  });

  it("fails one missed criterion, a metric nobody measured, and a result with no evidence", () => {
    const worse = passingReport();
    worse.scenarios["no-self-echo"].measured.selfEchoTurns = 1;
    const a = lib.checkReport(worse);
    expect(a.verified).toBe(false);
    expect(
      a.results
        .find((r: { id: string }) => r.id === "no-self-echo")
        .rows.find((r: { metric: string }) => r.metric === "selfEchoTurns").pass,
    ).toBe(false);
    const unmeasured = passingReport();
    delete unmeasured.scenarios["session-30-minutes"].measured.heapGrowthMb;
    expect(lib.checkReport(unmeasured).verified).toBe(false);
    const noEvidence = passingReport();
    noEvidence.scenarios["speaker-playback"].evidence = "  ";
    expect(lib.checkReport(noEvidence).verified).toBe(false);
    // A person writing "pass" is not evidence: the numbers decide.
    const claimed = lib.blankReport();
    claimed.scenarios["speaker-playback"].status = "pass";
    expect(
      lib.checkReport(claimed).results.find((r: { id: string }) => r.id === "speaker-playback")
        .pass,
    ).toBe(false);
  });

  it("treats a NaN or text value as not measured", () => {
    const report = passingReport();
    report.scenarios["session-30-minutes"].measured.turns = Number.NaN;
    report.scenarios["session-30-minutes"].measured.durationMinutes = "31";
    expect(lib.checkReport(report).verified).toBe(false);
  });
});

describe("the soak record", () => {
  it("records a minute sample at most once a minute, turns, interventions and faults that did not recover", () => {
    const soak = new SoakRecorder();
    soak.sample(0, 10); // not running: nothing is kept
    soak.start(0);
    soak.sample(0, 100);
    soak.sample(30_000, 120); // too soon
    soak.sample(61_000, 130);
    soak.turn(2000, 800);
    soak.turn(3000, null);
    soak.intervention();
    soak.fault();
    soak.recovered();
    soak.fault();
    expect(soak.record().unrecoveredFaults).toBe(1);
    soak.stop(31 * 60_000);
    const record = soak.record();
    expect(record.samples).toEqual([
      { at: 0, heapMb: 100 },
      { at: 61_000, heapMb: 130 },
    ]);
    expect(record).toMatchObject({
      interventions: 1,
      micFaults: 2,
      unrecoveredFaults: 1,
      endedAt: 31 * 60_000,
    });
    soak.turn(9, 1); // stopped: nothing more is kept
    expect(soak.record().turns).toHaveLength(2);
  });

  it("turns into the numbers the 30-minute scenario asks for", () => {
    const soak = new SoakRecorder();
    soak.start(0);
    for (let minute = 0; minute <= 31; minute += 1) soak.sample(minute * 60_000, 200 + minute * 2);
    for (let i = 0; i < 20; i += 1) soak.turn(i * 90_000, i < 10 ? 600 : 700);
    soak.stop(31 * 60_000);
    const numbers = lib.analyseSoak(soak.record());
    expect(numbers).toMatchObject({
      durationMinutes: 31,
      turns: 20,
      stuckInterventions: 0,
      unrecoveredFaults: 0,
      heapGrowthMb: 62,
    });
    expect(numbers.firstSoundLateVsEarlyRatio).toBeCloseTo(700 / 600, 2);
    const scenario = lib
      .catalog()
      .scenarios.find((s: { id: string }) => s.id === "session-30-minutes");
    expect(lib.judgeScenario(scenario, numbers).pass).toBe(true);
  });

  it("returns nothing for what it could not measure", () => {
    expect(lib.analyseSoak({ samples: [], turns: [] })).toMatchObject({
      durationMinutes: null,
      heapGrowthMb: null,
      firstSoundLateVsEarlyRatio: null,
    });
  });
});

describe("the command line", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  it("prints the plan and judges a report: a blank one exits 1 and says UNVERIFIED", () => {
    expect(run("plan").stdout).toContain("session-30-minutes");
    const dir = mkdtempSync(path.join(tmpdir(), "friday-hw-"));
    try {
      const file = path.join(dir, "report.json");
      expect(run("init", file).status).toBe(0);
      expect(run("init", file).status).not.toBe(0); // never overwrites a report
      const checked = run("check", file);
      expect(checked.status).toBe(1);
      expect(checked.stdout).toContain("UNVERIFIED");
      writeFileSync(file, JSON.stringify(passingReport()));
      const ok = run("check", file);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("VERIFIED on the installed Windows app");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scores transcripts into a report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-hw-"));
    try {
      const phrases = lib.phrases().phrases as Array<{ id: string; text: string }>;
      const transcripts = path.join(dir, "t.json");
      writeFileSync(
        transcripts,
        JSON.stringify(Object.fromEntries(phrases.map((p) => [p.id, p.text]))),
      );
      const report = path.join(dir, "r.json");
      execFileSync(process.execPath, [cli, "init", report]);
      execFileSync(process.execPath, [
        cli,
        "score-stt",
        "--transcripts",
        transcripts,
        "--report",
        report,
      ]);
      const written = JSON.parse(readFileSync(report, "utf8"));
      expect(written.scenarios["stt-hindi-hinglish"].measured).toMatchObject({
        phrases: 24,
        hindiWer: 0,
        hinglishWer: 0,
        englishWer: 0,
      });
      expect(written.machine.os).toBe(""); // scoring never fills in the machine
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the soak record is wired to the app", () => {
  const mode = readFileSync(path.join(root, "src/lib/friday/assistant-mode.ts"), "utf8");
  it("starts and stops with Auto mode, samples on the supervisor beat and ships in the copied diagnostics", () => {
    expect(mode).toContain("this.soak.start(Date.now())");
    expect(mode).toContain("this.soak.stop(Date.now())");
    expect(mode).toContain("this.soak.sample(now, heapMegabytes())");
    expect(mode).toContain("this.soak.intervention()");
    expect(mode).toContain("this.soak.fault()");
    expect(mode).toContain("this.soak.recovered()");
    const view = readFileSync(
      path.join(root, "src/components/friday/VoiceDiagnostics.tsx"),
      "utf8",
    );
    expect(view).toContain("assistantMode.soakReport()");
  });
});
