/**
 * The spoken confirmation digest, wired into the real Auto mode controller (scripted on the turn simulator's fake
 * 80 ms clock; no microphone, speaker, timer or network). Before a consequential order with a where or a how much
 * runs, she reads back what she understood and waits for a short, fresh yes to that digest: her own played-back
 * words never approve, a yes that names another amount or person is asked again, a doubtful yes to a full read-back
 * is asked again, one correction of one field changes the order and is read back in full, a second one cancels, and a
 * yes whose voice began before the corrected digest was asked never approves it. The speaker tag never approves.
 * Also wired: the barge-in contract (onBargeIn) beside the live stop, in the shadow log only; the task speech router
 * that settles a cancelled task so its late result is never said; and the pure voice turn context builder.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ctl,
  ear,
  fin,
  quiet,
  runScenario,
  script,
  ttsEv,
  vad,
  type ScriptEvent,
  type SimResult,
} from "./helpers/voice-turn-sim";
import { SCENARIOS } from "./helpers/voice-turn-scenarios";
// Loaded before any scenario: the mocked speaker library (and so its billing store) is this one for every controller.
import { billing } from "../../src/lib/friday/billing";
import { billingAllowsPaidNow } from "../../src/lib/friday/voice-library";

vi.mock("../../src/lib/friday/voice-library", async (importOriginal) =>
  (await import("./helpers/voice-turn-sim")).simLibraryMock(await importOriginal()),
);

const SOURCE = readFileSync(
  resolve(import.meta.dirname, "../../src/lib/friday/assistant-mode.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

type Quality = { avgLogprob: number; languageProbability: number; language: string };
type Line = {
  id: string;
  at: number;
  text: string;
  /** When the final reaches the controller; default 160 ms after the ear's end. */
  finalAt?: number;
  endAt?: number;
  quality?: Quality;
  speaker?: { tag: "owner" | "other" | "unknown"; score: number };
};

/** One spoken line: the ear frames it, the voice runs for about 240 ms a word, the final follows the end. */
function said(line: Line): ScriptEvent[] {
  const words = line.text.split(/\s+/).length;
  const voiceEnd = line.at + Math.max(240, words * 240);
  const end = line.endAt ?? voiceEnd + 320;
  const finalAt = line.finalAt ?? end + 160;
  return [
    ear(line.at, "start", line.id, "", line.speaker ? { speaker: line.speaker } : {}),
    ...vad(line.at, voiceEnd),
    ...quiet(voiceEnd, voiceEnd + 240),
    ear(end, "end", line.id, line.text, {
      speechMs: voiceEnd - line.at,
      ...(line.speaker ? { speaker: line.speaker } : {}),
    }),
    fin(finalAt, line.text, line.quality ? { quality: line.quality } : {}),
  ];
}

type Pending = {
  command: string;
  at: number;
  digest?: {
    id: string;
    verb: string;
    target?: string;
    amount?: string;
    mode: string;
    askedAt: number;
    expiresAt: number;
  };
} | null;

const pendingOf = (r: SimResult): Pending =>
  (r.h.d.state as unknown as { pending: Pending }).pending;

const SEND = "Friday send 5000 rupees to Rahul";
const DIGEST_RAHUL = "Send 5,000 rupees to rahul. Say yes to confirm.";
const DIGEST_ROHAN = "Send 5,000 rupees to Rohan. Say yes to confirm.";

describe("step 6: a consequential order reads the digest and waits for a short, expiring yes", () => {
  it("an amount and a person are read in full (what, where, how much) and the order waits", async () => {
    const r = await runScenario({
      name: "digest read",
      script: script(said({ id: "t1", at: 0, text: SEND })),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL]);
    expect(r.sent).toEqual([]);
    const pending = pendingOf(r);
    expect(pending?.command).toBe("send 5000 rupees to rahul");
    expect(pending?.digest).toMatchObject({
      verb: "send",
      target: "rahul",
      amount: "5000 rupees",
      mode: "explicit",
    });
    expect(pending?.digest?.askedAt).toBe(pending?.at);
    expect((pending?.digest?.expiresAt ?? 0) - (pending?.digest?.askedAt ?? 0)).toBe(30_000);
  });

  it("a Hinglish order is read back in Hinglish", async () => {
    const r = await runScenario({
      name: "digest hinglish",
      script: script(said({ id: "t1", at: 0, text: "Friday Rahul ko 500 rupaye bhej do" })),
    });
    expect(r.spoken).toEqual(["rahul ko 500 rupaye bhej do. Pakka? Haan boliye."]);
    expect(r.sent).toEqual([]);
  });

  it("an order with no where or how much keeps the short question, and still carries its digest", async () => {
    const r = await runScenario({
      name: "digest short",
      script: script(said({ id: "t1", at: 0, text: "Friday delete all the old invoices" })),
    });
    expect(r.spoken).toEqual(["Should I delete all the old invoices?"]);
    expect(pendingOf(r)?.digest).toMatchObject({ verb: "delete", mode: "explicit" });
  });

  it.each([
    [12, 12_000],
    [3, 10_000],
    [300, 60_000],
  ])("voice.approvalTtlSec %s gives a %s ms window", async (sec, ms) => {
    const r = await runScenario({
      name: `ttl ${sec}`,
      setup: (h) => h.preferences.setVoice({ approvalTtlSec: sec }),
      script: script(said({ id: "t1", at: 0, text: SEND })),
    });
    const digest = pendingOf(r)?.digest;
    expect((digest?.expiresAt ?? 0) - (digest?.askedAt ?? 0)).toBe(ms);
  });

  it("a fresh yes runs the order; a yes after the window never does", async () => {
    const ok = await runScenario({
      name: "yes in time",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "yes" }),
      ),
    });
    expect(ok.sent).toEqual(["send 5000 rupees to rahul"]);
    const late = await runScenario({
      name: "yes too late",
      setup: (h) => h.preferences.setVoice({ approvalTtlSec: 10 }),
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 12_000, text: "yes" }),
      ),
    });
    expect(late.sent).toEqual([]);
    expect(pendingOf(late)).toBeNull();
    expect(late.spoken).toHaveLength(2);
  });
});

describe("step 7: only a short, fresh yes to this digest that is not her own voice approves", () => {
  it("her own played-back read-back never approves, even tagged as the owner's voice", async () => {
    const owner = { tag: "owner" as const, score: 0.99 };
    const r = await runScenario({
      name: "own playback",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        // Her read-back plays from 1840 ms to 4400 ms; its words come back once while she speaks and once after.
        ttsEv(1840, "first-audio", "u1", { turnId: "t1" }),
        said({ id: "t2", at: 3200, text: "yes to confirm", speaker: owner }),
        ttsEv(4400, "drained", "u1", { playedMs: 2560, turnId: "t1" }),
        said({ id: "t3", at: 5600, text: "say yes to confirm", speaker: owner }),
      ),
    });
    expect(r.spoken[0]).toBe(DIGEST_RAHUL);
    expect(r.sent).toEqual([]);
    expect(pendingOf(r)?.command).toBe("send 5000 rupees to rahul");
  });

  it("the owner's own yes after her voice is over still approves (the control)", async () => {
    const r = await runScenario({
      name: "own playback control",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        ttsEv(1840, "first-audio", "u1", { turnId: "t1" }),
        ttsEv(4400, "drained", "u1", { playedMs: 2560, turnId: "t1" }),
        said({ id: "t2", at: 5600, text: "yes" }),
      ),
    });
    expect(r.sent).toEqual(["send 5000 rupees to rahul"]);
  });

  it("a yes that names another person is not a yes to this digest: she asks again, once", async () => {
    const r = await runScenario({
      name: "mismatch",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "yes send it to Rohan" }),
        said({ id: "t3", at: 8000, text: "yes but to Mohan" }),
      ),
    });
    expect(r.sent).toEqual([]);
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_RAHUL]);
  });

  it("a doubtful yes to a full read-back is asked again; a sure one then runs it", async () => {
    const doubtful = { avgLogprob: -1.7, languageProbability: 0.35, language: "en" };
    const r = await runScenario({
      name: "low asr",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "yes", quality: doubtful }),
        said({ id: "t3", at: 8000, text: "haan" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_RAHUL]);
    expect(r.sent).toEqual(["send 5000 rupees to rahul"]);
  });

  it("one correction of the person changes the order, is read back in full, and runs on a yes", async () => {
    const r = await runScenario({
      name: "correct target",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "no, to Rohan" }),
        said({ id: "t3", at: 8000, text: "yes" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_ROHAN]);
    expect(r.sent).toEqual(["send 5000 rupees to Rohan"]);
  });

  it("one correction of the amount changes the order and is read back in full", async () => {
    const r = await runScenario({
      name: "correct amount",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "make it 500" }),
        said({ id: "t3", at: 8000, text: "yes" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, "Send 500 rupees to rahul. Say yes to confirm."]);
    expect(r.sent).toEqual(["send 500 rupees to rahul"]);
  });

  it("a second correction cancels the order", async () => {
    const r = await runScenario({
      name: "second correction",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        said({ id: "t2", at: 4000, text: "no, to Rohan" }),
        said({ id: "t3", at: 8000, text: "no, to Mohan" }),
        said({ id: "t4", at: 12_000, text: "yes" }),
      ),
    });
    // The later "yes" binds to nothing: it may reach the Brain as an ordinary line, never as the order.
    expect(r.sent.filter((line) => /send|rupees/i.test(line))).toEqual([]);
    expect(pendingOf(r)).toBeNull();
    expect(r.spoken.slice(0, 2)).toEqual([DIGEST_RAHUL, DIGEST_ROHAN]);
    expect(r.spoken).toHaveLength(3);
  });

  it("a changed digest never approves an older yes: a yes begun before the correction was read is asked again", async () => {
    const r = await runScenario({
      name: "older yes",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        // The correction's final reaches her at 5600 ms, after the owner's next voice began at 5200 ms.
        said({ id: "t2", at: 3600, text: "no, to Rohan", endAt: 4720, finalAt: 5600 }),
        said({ id: "t3", at: 5200, text: "yes", endAt: 5760, finalAt: 5840 }),
        said({ id: "t4", at: 8960, text: "haan" }),
      ),
    });
    expect(r.spoken).toEqual([DIGEST_RAHUL, DIGEST_ROHAN, DIGEST_ROHAN]);
    expect(r.sent).toEqual(["send 5000 rupees to Rohan"]);
  });

  it("Stop everything still halts: a yes after it runs nothing", async () => {
    const r = await runScenario({
      name: "stop all",
      script: script(
        said({ id: "t1", at: 0, text: SEND }),
        ctl(2960, "stop-all"),
        said({ id: "t2", at: 4000, text: "yes" }),
      ),
    });
    expect(r.sent).toEqual([]);
  });
});

describe("the barge-in contract and the task speech router", () => {
  type ShadowView = {
    turnShadow: { report: () => { log: { k: string; detail: string }[] } } | null;
  };

  it("a confirmed interruption logs the onBargeIn plan in the shadow and acts exactly as before", async () => {
    const takeover = SCENARIOS["takeover3"];
    if (!takeover) throw new Error("the takeover3 scenario is missing");
    const r = await runScenario(takeover);
    expect(r.sent).toEqual(["wait open budget"]);
    expect(r.h.brainStops).toEqual(["foreground"]);
    const log = (r.h.d as unknown as ShadowView).turnShadow?.report().log ?? [];
    const plans = log.filter((row) => row.k === "barge-plan");
    expect(plans.map((row) => row.detail)).toEqual([
      "read-only cancel:true checkpoint:false undo:false",
    ]);
  });

  it("a cancelled task is settled: its late result is never said", async () => {
    const task = {
      id: "x1",
      label: "the report",
      state: "RUNNING",
      risk: "safe",
      createdAt: 0,
      updatedAt: 0,
    };
    const r = await runScenario({
      name: "settled task",
      setup: (h) => {
        const d = h.d as unknown as { narrateTask: (update: unknown, task: unknown) => void };
        d.narrateTask({ taskId: "x1", kind: "cancelled", text: "Cancelled the report." }, task);
        d.narrateTask(
          { taskId: "x1", kind: "completed", text: "" },
          { ...task, state: "COMPLETED", result: "The report is ready." },
        );
        d.narrateTask(
          { taskId: "x1", kind: "failed", text: "" },
          { ...task, state: "FAILED", error: "late" },
        );
      },
      script: script(quiet(0, 400)),
    });
    expect(r.spoken).toEqual(["Cancelled the report."]);
  });
});

describe("the billing firewall reaches the cloud speech calls, failing closed", () => {
  const SARVAM_ON = {
    cloudEnabled: true,
    allowedProviders: ["sarvam"],
    speakWith: "sarvam",
    paidAllowed: true,
    paidApproved: true,
    spendLimitUsd: 5,
    dailyRequests: 5,
    monthlyRequests: 50,
    monthlyAudioMinutes: 5,
  };
  type Gate = { ok: boolean; reason?: string };
  type Clip = (text: string, lang: string, tone: object) => Promise<unknown>;
  type CloudView = {
    cloudSpeechKeys: Record<string, boolean>;
    cloudSpeechKeysAt: number;
    cloudSttGate: () => Gate;
    cloudClipFor: () => Clip | undefined;
    turnSensitive: boolean;
  };

  /** A controller with Sarvam switched on and keyed, paid access as given, and a recorder for cloud speech. */
  async function controller(paid: boolean, privacyMode = false) {
    const r = await runScenario({
      name: `billing ${paid}`,
      script: script(quiet(0, 160)),
      tailMs: 0,
    });
    const calls: unknown[] = [];
    const bridge = (globalThis as unknown as { friday: Record<string, unknown> }).friday;
    bridge["billingPolicy"] = async () => ({
      billing: {
        paidAccess: paid,
        autoPaidUsage: false,
        killSwitch: false,
        grantScope: "off",
        grantUntil: 0,
        grantedAt: 0,
      },
      policy: "free-preferred",
      summary: "test",
    });
    bridge["voiceCloudKeyStatus"] = async () => ({ sarvam: true });
    bridge["voiceCloudSpeak"] = async (provider: string, request: unknown) => {
      calls.push([provider, request]);
      return { ok: true, audioBase64: "UklGRg==", mime: "audio/wav" };
    };
    await billing.refresh();
    expect(billingAllowsPaidNow()).toBe(paid);
    r.h.preferences.setVoice({ cloudVoice: SARVAM_ON as never, privacyMode });
    const d = r.h.d as unknown as CloudView;
    d.cloudSpeechKeys = { sarvam: true };
    d.cloudSpeechKeysAt = Date.now();
    return { d, calls };
  }

  const tone = { rate: 1, pitch: 1, volume: 1 };

  it("paid access off: the Sarvam stream and voice are refused; on: both are allowed", async () => {
    const off = await controller(false);
    expect(off.d.cloudSttGate().ok).toBe(false);
    expect(await off.d.cloudClipFor()?.("It is sunny today.", "en", tone)).toBeNull();
    expect(off.calls).toEqual([]);
    const on = await controller(true);
    expect(on.d.cloudSttGate()).toEqual({ ok: true });
    expect(await on.d.cloudClipFor()?.("It is sunny today.", "en", tone)).not.toBeNull();
    expect(on.calls).toHaveLength(1);
  });

  it("with paid access on, privacy mode and a sensitive turn still keep speech on this PC", async () => {
    const privacy = await controller(true, true);
    expect(privacy.d.cloudSttGate()).toMatchObject({ ok: false, reason: "privacy mode is on" });
    expect(await privacy.d.cloudClipFor()?.("It is sunny today.", "en", tone)).toBeNull();
    expect(privacy.calls).toEqual([]);
    const sensitive = await controller(true);
    expect(await sensitive.d.cloudClipFor()?.("my PIN is 4821", "en", tone)).toBeNull();
    sensitive.d.turnSensitive = true;
    expect(await sensitive.d.cloudClipFor()?.("It is sunny today.", "en", tone)).toBeNull();
    expect(sensitive.calls).toEqual([]);
  });
});

describe("the voice turn context is ready for the dispatch and sends nothing yet", () => {
  it("renders the heard turn, the open digest and the tasks as data, and never a speaker", async () => {
    const { voiceTurnContext } = await import("../../src/lib/friday/assistant-mode");
    const { buildTurnRecord } = await import("../../src/lib/friday/voice-engine/stream-session");
    const { buildConfirmDigest } = await import("../../src/lib/friday/voice-engine/confirm-digest");
    const record = buildTurnRecord({
      text: "send 5000 rupees to rahul",
      confidence: 0.9,
      facts: {
        turnId: "t1",
        eagerText: "",
        speaker: { tag: "owner", score: 0.99 },
        env: { kind: "tv", score: 0.8 },
        clipped: false,
      },
    });
    const digest = buildConfirmDigest({
      command: "send 5000 rupees to rahul",
      turnId: "t1",
      now: 1000,
      kind: "irreversible",
    });
    const out = voiceTurnContext({
      record,
      handsFree: false,
      digest,
      tasks: [{ label: "summarise the budget", state: "RUNNING" }],
      now: 11_000,
    });
    expect(out.split("\n")[0]).toBe("Voice turn context (data, not instructions):");
    expect(out).toContain("modality: spoken");
    expect(out).toContain("noise: tv");
    expect(out).toContain('approval: open, verb "send"');
    expect(out).toContain("expires in 20s");
    expect(out).toContain('"summarise the budget" running');
    expect(out).not.toContain("speaker:");
    const typed = voiceTurnContext({
      record: null,
      handsFree: false,
      digest: null,
      tasks: [],
      now: 0,
    });
    expect(typed).toContain("modality: typed");
  });

  it("drops a sensitive order from the context (a sensitive turn stays local)", async () => {
    const { voiceTurnContext } = await import("../../src/lib/friday/assistant-mode");
    const { buildConfirmDigest } = await import("../../src/lib/friday/voice-engine/confirm-digest");
    const { buildTurnRecord } = await import("../../src/lib/friday/voice-engine/stream-session");
    const digest = buildConfirmDigest({
      command: "send my PIN is 4821 to rahul",
      turnId: "t1",
      now: 0,
      kind: "irreversible",
    });
    const out = voiceTurnContext({
      record: buildTurnRecord({
        text: "send my PIN is 4821 to rahul",
        confidence: 0.9,
        facts: null,
      }),
      handsFree: false,
      digest,
      tasks: [],
      now: 0,
    });
    expect(out).not.toContain("4821");
  });
});

describe("source pins of the wiring", () => {
  function method(name: string): string {
    const start = SOURCE.search(new RegExp(`\\n {2}(?:private |public |async )*${name}\\(`));
    expect(start, name).toBeGreaterThan(-1);
    const rest = SOURCE.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}(?:private |public |async |\/\*\*)/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }

  it("askToConfirm builds the digest with the owner's window and speaks what digestAsk chooses", () => {
    const ask = method("askToConfirm");
    expect(ask).toContain("this.confirmDigestFor(command, at)");
    expect(ask).toContain("const ask = this.digestAsk(digest, command);");
    expect(method("confirmDigestFor")).toContain(
      "ttlSec: preferences.getSnapshot().voice.approvalTtlSec",
    );
    expect(method("confirmDigestFor")).toContain("kind: voiceConfirmKind(command)");
  });

  it("the pending yes is judged on the digest with ownPlayback, then the bound yes, then the saved voice can only refuse", () => {
    const block = SOURCE.slice(
      SOURCE.indexOf("// 1. A consequential command is waiting for a yes/no."),
    );
    const ruling = block.indexOf("explainDigestAnswer(digest, text, Date.now(), {");
    const own = block.indexOf("ownPlayback: this.ownPlaybackHeard(text),");
    const bound = block.indexOf(
      'isBoundConfirmation(text, (value) => confirmationVerdict(value) === "yes")',
    );
    const older = block.indexOf("if (this.answeredBefore(digest)) {");
    const voice = block.indexOf("if (!this.approvalVoiceAllows(text)) return;");
    const run = block.indexOf("this.runApproved(cmd, cmdHints);");
    expect(ruling).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(ruling);
    expect(bound).toBeGreaterThan(own);
    expect(older).toBeGreaterThan(bound);
    expect(voice).toBeGreaterThan(older);
    expect(run).toBeGreaterThan(voice);
    // The digest answer has no identity input: the speaker is not passed in.
    expect(block.slice(ruling, own + 200)).not.toMatch(/speaker|voiceprint/i);
  });

  it("the barge-in plan is computed after the live stop and only written to the shadow", () => {
    const settle = method("settleInterruption");
    expect(settle).toMatch(
      /this\.holdForInterruption\(\);\s*shadow\(\);\s*this\.shadowBargePlan\(text\);/,
    );
    expect(settle).toMatch(
      /this\.confirmInterruption\(\);\s*shadow\(\);\s*this\.shadowBargePlan\(text\);/,
    );
    const plan = method("shadowBargePlan");
    expect(plan).toContain("onBargeIn(risk, ownerSaidCancelTask(heard))");
    expect(plan).toContain("this.shadowTurn((a) => a.bargePlan(risk, plan, Date.now()))");
    for (const banned of [
      "voiceTaskActions",
      "cancelSpeech",
      "brain.",
      ".cancel(",
      "dropPlayback",
    ]) {
      expect(plan, banned).not.toContain(banned);
    }
  });

  it("the task narration goes through the speech router's settled set first", () => {
    const narrate = method("narrateTask");
    expect(narrate.indexOf("this.taskSpeech.isSettled(task.id)")).toBeLessThan(
      narrate.indexOf("narrationEventFor(update, task)"),
    );
    expect(narrate).toContain("this.taskSpeech.route(event, 0, this.narrationLang())");
  });
});
