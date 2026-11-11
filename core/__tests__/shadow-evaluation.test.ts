/**
 * Evidence for the acoustic barge-in detector: recorded, kept, and judged against fixed criteria. The detector
 * stays a shadow: no test here (or code) lets it make the interruption decision.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BargeShadow } from "../../src/lib/friday/voice-engine/interruption-controller";
import {
  PROMOTION_CRITERIA,
  ShadowLedger,
  bucketOf,
  shadowVerdict,
  verdictLine,
  type ShadowOutcome,
} from "../../src/lib/friday/voice-engine/shadow-evaluation";

const ctx = (playbackLevel = 0.1, micLevel = 0.2) => ({ playbackLevel, micLevel });

describe("the shadow reports each outcome once, with the room it happened in", () => {
  it("reports an agreed pair with the detector's lead, and one-sided hits when their window ends", () => {
    const seen: ShadowOutcome[] = [];
    const shadow = new BargeShadow(700, (o) => seen.push(o));
    shadow.detectorFired(1000, ctx(0.3, 0.5));
    shadow.liveFired(1250, ctx(0.1, 0.4));
    expect(seen).toEqual([{ kind: "both", leadMs: -250, playbackLevel: 0.3, micLevel: 0.5 }]);
    shadow.liveFired(9000, ctx(0.02, 0.1)); // nothing from the detector
    shadow.detectorFired(20_000, ctx(0.4, 0.6)); // nothing from the live path
    shadow.tick(30_000);
    expect(seen.slice(1).map((o) => o.kind)).toEqual(["liveOnly", "detectorOnly"]);
    expect(seen).toHaveLength(3); // the old counters and the callback agree
    expect(shadow.line(30_000)).toBe("1 agreed · 1 detector only · 1 live only");
  });

  it("is late when the detector fires after the live pause", () => {
    const seen: ShadowOutcome[] = [];
    const shadow = new BargeShadow(700, (o) => seen.push(o));
    shadow.liveFired(1000);
    shadow.detectorFired(1400);
    expect(seen[0]).toMatchObject({ kind: "both", leadMs: 400 });
  });
});

describe("the ledger", () => {
  it("counts by outcome and by how loud the speaker was, and keeps lead times bounded", () => {
    const ledger = new ShadowLedger(null, () => 5000);
    ledger.beginSession();
    ledger.record({ kind: "both", leadMs: -100, playbackLevel: 0.01, micLevel: 0.2 });
    ledger.record({ kind: "liveOnly", playbackLevel: 0.1, micLevel: 0.2 });
    ledger.record({ kind: "detectorOnly", playbackLevel: 0.5, micLevel: 0.3 });
    for (let i = 0; i < 500; i += 1)
      ledger.record({ kind: "both", leadMs: i, playbackLevel: 0.1, micLevel: 0.2 });
    const report = ledger.report();
    expect(report.totals).toEqual({ both: 501, liveOnly: 1, detectorOnly: 1 });
    expect(report.byPlaybackLevel.loud.detectorOnly).toBe(1);
    expect(report.byPlaybackLevel.quiet.both).toBe(1);
    expect(report.leadMs).toHaveLength(400);
    expect(report.sessions).toBe(1);
    expect([bucketOf(0.04), bucketOf(0.1), bucketOf(0.3)]).toEqual(["quiet", "mid", "loud"]);
  });

  it("counts only plausible exposure time", () => {
    const ledger = new ShadowLedger();
    ledger.addExposure(1000);
    ledger.addExposure(-5);
    ledger.addExposure(Number.NaN);
    ledger.addExposure(10 * 60_000); // a single frame cannot last ten minutes
    expect(ledger.report().exposureMs).toBe(1000);
  });

  it("survives a restart, a blocked store and damaged data", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const first = new ShadowLedger();
    first.beginSession();
    first.record({ kind: "both", leadMs: 50, playbackLevel: 0.1, micLevel: 0.2 });
    first.save(storage);
    expect(ShadowLedger.load(storage).report().totals.both).toBe(1);
    store.set("friday.voice.bargeShadow.v1", "{not json");
    expect(ShadowLedger.load(storage).report().totals.both).toBe(0);
    expect(() => ShadowLedger.load(null).save(null)).not.toThrow();
    expect(() =>
      first.save({
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
    first.reset();
    expect(first.report().totals.both).toBe(0);
  });
});

describe("the verdict", () => {
  const good = () => {
    const ledger = new ShadowLedger();
    for (let i = 0; i < 3; i += 1) ledger.beginSession();
    for (let i = 0; i < 60; i += 1)
      ledger.record({ kind: "both", leadMs: i % 2 ? 40 : -60, playbackLevel: 0.1, micLevel: 0.3 });
    const report = ledger.report();
    return { ...report, exposureMs: 2.5 * 3_600_000 };
  };

  it("is not ready without enough real-device evidence, and says what is missing", () => {
    const verdict = shadowVerdict(new ShadowLedger().report());
    expect(verdict.ready).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/live pauses seen/);
    expect(verdict.reasons.join(" ")).toMatch(/hours of playback/);
    expect(verdict.reasons.join(" ")).toMatch(/listening sessions/);
    expect(verdictLine(verdict)).toMatch(/^not enough evidence yet/);
  });

  it("is ready only when volume, agreement, false interruptions and lateness all pass", () => {
    const report = good();
    expect(shadowVerdict(report)).toMatchObject({ ready: true, reasons: [], agreement: 1 });
    expect(verdictLine(shadowVerdict(report))).toContain("a person decides");
    // Missing too many real pauses.
    expect(
      shadowVerdict({ ...report, totals: { ...report.totals, liveOnly: 10 } }).reasons.join(" "),
    ).toMatch(/caught 86% of real pauses/);
    // Interrupting her by itself too often.
    expect(
      shadowVerdict({ ...report, totals: { ...report.totals, detectorOnly: 20 } }).reasons.join(
        " ",
      ),
    ).toMatch(/interrupted her 8\.0 times an hour/);
    // Too slow.
    expect(shadowVerdict({ ...report, leadMs: Array(60).fill(500) }).reasons.join(" ")).toMatch(
      /fires up to 500 ms later/,
    );
    // Not enough hours.
    expect(shadowVerdict({ ...report, exposureMs: 3_600_000 }).ready).toBe(false);
  });

  it("states its criteria so a person can read what 'ready' means", () => {
    expect(PROMOTION_CRITERIA).toMatchObject({
      minLivePauses: 50,
      minExposureHours: 2,
      minSessions: 3,
      minAgreement: 0.95,
    });
  });
});

describe("wiring keeps the detector a shadow", () => {
  const mode = readFileSync("src/lib/friday/assistant-mode.ts", "utf8");

  it("records outcomes, exposure and sessions, persists them, and offers a verdict and a report", () => {
    expect(mode).toContain("new BargeShadow(700, (outcome) => this.bargeLedger.record(outcome))");
    expect(mode).toContain("this.bargeLedger.beginSession()");
    expect(mode).toContain("this.bargeLedger.addExposure(");
    expect(mode).toContain("this.saveBargeLedger()");
    expect(mode).toContain("bargeShadowVerdictLine()");
    expect(mode).toContain("bargeShadowReport()");
  });

  it("never lets the detector or the verdict decide an interruption", () => {
    const hold = mode.slice(
      mode.indexOf("private holdForInterruption"),
      mode.indexOf("private armInterruptTimer"),
    );
    expect(hold).not.toContain("bargeDetector");
    expect(hold).not.toContain("shadowVerdict");
    // The detector's result goes only to the shadow, in the one place it is read.
    expect(mode.match(/this\.bargeDetector\.push\(/g)).toHaveLength(1);
    expect(mode).toContain("if (fired) this.bargeShadow.detectorFired(");
    expect(mode).not.toMatch(/if \(fired\) this\.(holdForInterruption|dropPlayback)/);
  });

  it("shows the verdict in Voice diagnostics and includes the data in the copied report", () => {
    const view = readFileSync("src/components/friday/VoiceDiagnostics.tsx", "utf8");
    expect(view).toContain("assistantMode.bargeShadowVerdictLine()");
    expect(view).toContain("assistantMode.bargeShadowReport()");
  });
});
