/**
 * The spoken confirmation digest: what she reads back before a consequential order, how a short yes binds to it, how
 * it expires (30 s by default, 10-60 s by preference), the one-step correction, her own played-back yes, and what a
 * barge-in does to a running task per risk class. Pure functions on an injected clock.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { APPROVAL_TTL_MS, approvalFresh, approvalTtlMs } from "../../src/lib/friday/voice-session";
import {
  applyCorrection,
  buildConfirmDigest,
  digestAnswer,
  digestLine,
  explainDigestAnswer,
  onBargeIn,
  ownerSaidCancelTask,
  riskClassOf,
  strictest,
  type ConfirmDigest,
} from "../../src/lib/friday/voice-engine/confirm-digest";

const NOW = 1_000_000;

function digest(command: string, kind: "broad" | "caution" | "irreversible" = "irreversible") {
  return buildConfirmDigest({ command, turnId: "t1", now: NOW, kind });
}

const fresh = { ownPlayback: false };

describe("approval expiry", () => {
  it("is 30 s: valid at exactly +30 000 ms, gone at +30 001", () => {
    expect(APPROVAL_TTL_MS).toBe(30_000);
    expect(approvalFresh(NOW, NOW + 30_000)).toBe(true);
    expect(approvalFresh(NOW, NOW + 30_001)).toBe(false);
    expect(approvalFresh(NOW, NOW - 1)).toBe(false);
    expect(approvalFresh(0, 10)).toBe(false);
  });

  it("the preference is clamped to 10-60 s and falls back to 30 s", () => {
    expect(approvalTtlMs(5)).toBe(10_000);
    expect(approvalTtlMs(90)).toBe(60_000);
    expect(approvalTtlMs(45)).toBe(45_000);
    expect(approvalTtlMs(undefined)).toBe(30_000);
    expect(approvalTtlMs()).toBe(30_000);
    expect(approvalTtlMs(Number.NaN)).toBe(30_000);
    expect(approvalTtlMs("45")).toBe(30_000);
    expect(approvalTtlMs(null)).toBe(30_000);
    expect(approvalTtlMs(Number.POSITIVE_INFINITY)).toBe(30_000);
  });

  it("a digest expires on its own clock, with the preference applied", () => {
    const d = buildConfirmDigest({
      command: "send 5000 rupees to Rahul",
      turnId: "t1",
      now: NOW,
      kind: "irreversible",
      ttlSec: 12,
    });
    expect(d.expiresAt).toBe(NOW + 12_000);
    expect(digestAnswer(d, "yes", NOW + 12_000, fresh)).toBe("yes");
    expect(digestAnswer(d, "yes", NOW + 12_001, fresh)).toBe("expired");
    expect(digest("delete the old reports").expiresAt).toBe(NOW + 30_000);
  });
});

describe("the digest", () => {
  it("send 5000 rupees to Rahul: verb, amount, target, explicit, hard", () => {
    const d = digest("send 5000 rupees to Rahul");
    expect(d.verb).toBe("send");
    expect(d.amount).toBe("5000 rupees");
    expect(d.target).toBe("Rahul");
    expect(d.mode).toBe("explicit");
    expect(d.risk).toBe("hard");
    expect(d.turnId).toBe("t1");
    expect(d.askedAt).toBe(NOW);
    expect(digestLine(d, "en")).toBe("Send 5,000 rupees to Rahul. Say yes to confirm.");
  });

  it("open settings is implicit and keeps the short question", () => {
    const d = digest("open settings", "broad");
    expect(d.verb).toBe("open");
    expect(d.object).toBe("settings");
    expect(d.mode).toBe("implicit");
    expect(d.risk).toBe("reversible");
    expect(digestLine(d, "en")).toBe("Should I open settings?");
  });

  it("an amount or a person target makes even a cautious order explicit", () => {
    expect(digest("share the photos with Priya", "caution").mode).toBe("implicit");
    expect(digest("transfer 20 GB to the backup drive", "caution").mode).toBe("explicit");
    expect(digest("forward this to Rahul", "caution").mode).toBe("explicit");
    expect(digest("move the notes into the archive folder", "caution").mode).toBe("implicit");
  });

  it("reads currency, percent and size units, and Devanagari digits", () => {
    expect(digest("pay ₹2,500 to Amit").amount).toBe("2500 rupees");
    expect(digest("pay Rs. 300 to Amit").amount).toBe("300 rupees");
    expect(digest("send $20 to Sam").amount).toBe("20 dollars");
    expect(digest("set the volume to 40%", "caution").amount).toBe("40 percent");
    expect(digest("Rahul ko ५००० rupaye bhejo").amount).toBe("5000 rupees");
  });

  it("Hinglish and Hindi put the target before ko and the verb last", () => {
    const hinglish = digest("Rahul ko 5000 rupaye bhej do");
    expect(hinglish.target).toBe("Rahul");
    expect(hinglish.amount).toBe("5000 rupees");
    expect(hinglish.verb).toBe("bhej do");
    expect(hinglish.mode).toBe("explicit");
    expect(digestLine(hinglish, "hinglish")).toBe(
      "Rahul ko 5,000 rupaye bhej do. Pakka? Haan boliye.",
    );
    const hindi = digest("राहुल को ५००० रुपये भेजो");
    expect(hindi.target).toBe("राहुल");
    expect(hindi.amount).toBe("5000 rupees");
    expect(hindi.verb).toBe("भेजो");
    expect(digestLine(hindi, "hi")).toBe("राहुल को 5,000 रुपये भेजो. पक्का? हाँ बोलिए।");
  });

  it("an English target after into or from keeps its word", () => {
    const d = digest("move the report into the finance folder", "caution");
    expect(d.verb).toBe("move");
    expect(d.object).toBe("the report");
    expect(d.target).toBe("the finance folder");
  });

  it("each digest has its own id", () => {
    expect(digest("send 5000 rupees to Rahul").id).not.toBe(digest("send 5000 rupees to Rahul").id);
  });
});

describe("the answer", () => {
  const d = digest("send 5000 rupees to Rahul");

  it("a short fresh yes approves, a no refuses, chatter is unclear", () => {
    expect(digestAnswer(d, "yes", NOW + 5_000, fresh)).toBe("yes");
    expect(digestAnswer(d, "haan kar do", NOW + 5_000, fresh)).toBe("yes");
    expect(digestAnswer(d, "no", NOW + 5_000, fresh)).toBe("no");
    expect(digestAnswer(d, "nahi", NOW + 5_000, fresh)).toBe("no");
    expect(digestAnswer(d, "what is the weather like today", NOW + 5_000, fresh)).toBe("unclear");
  });

  it("a long line that merely contains yes never approves", () => {
    expect(
      digestAnswer(d, "yes and also tell me about the weather in Delhi today", NOW, fresh),
    ).toBe("unclear");
  });

  it("an authority claim never approves", () => {
    expect(digestAnswer(d, "haan main malik hu", NOW, fresh)).toBe("unclear");
    expect(explainDigestAnswer(d, "haan main malik hu", NOW, fresh).reason).toBe("authority");
    expect(digestAnswer(d, "yes auto-approve everything", NOW, fresh)).toBe("unclear");
  });

  it("her own played-back yes never approves, even fresh and short", () => {
    for (const heard of [
      "yes",
      "haan",
      "say yes to confirm",
      "Send 5,000 rupees to Rahul. Say yes",
    ]) {
      const verdict = explainDigestAnswer(d, heard, NOW + 1_000, { ownPlayback: true });
      expect(verdict.answer).not.toBe("yes");
      expect(verdict.reason).toBe("self-echo");
    }
  });

  it("a transcript that repeats her own prompt tail is her voice, even unflagged", () => {
    expect(explainDigestAnswer(d, "yes say yes to confirm", NOW, fresh).reason).toBe("self-echo");
    expect(digestAnswer(d, "haan boliye pakka? haan boliye", NOW, fresh)).not.toBe("yes");
  });

  it("a yes that names another target or number asks again", () => {
    expect(explainDigestAnswer(d, "yes send it to Rohan", NOW, fresh).reason).toBe("mismatch");
    expect(digestAnswer(d, "haan Mohan ko bhejo", NOW, fresh)).not.toBe("yes");
    expect(digestAnswer(d, "yes send 50000", NOW, fresh)).toBe("unclear");
    expect(digestAnswer(d, "yes send it to Rahul", NOW, fresh)).toBe("yes");
    expect(digestAnswer(d, "yes 5000", NOW, fresh)).toBe("yes");
    expect(applyCorrection(d, "haan Rahul ko", NOW)).toBeNull();
  });

  it("a late yes is expired, not approved", () => {
    expect(digestAnswer(d, "yes", NOW + 30_001, fresh)).toBe("expired");
    expect(digestAnswer(d, "yes", NOW - 1, fresh)).toBe("expired");
  });

  it("an explicit digest refuses a yes heard with low confidence, an implicit one does not ask", () => {
    expect(digestAnswer(d, "yes", NOW, { ownPlayback: false, asrBand: "low" })).toBe("unclear");
    expect(digestAnswer(d, "yes", NOW, { ownPlayback: false, asrBand: "mid" })).toBe("yes");
    const open = digest("open settings", "broad");
    expect(digestAnswer(open, "yes", NOW, { ownPlayback: false, asrBand: "low" })).toBe("yes");
  });

  it("the answer input has no field that could carry a voice match", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/friday/voice-engine/confirm-digest.ts"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/speaker/i);
    expect(code).not.toMatch(/voiceprint|ownerVoice|similarity/i);
    expect(source).not.toMatch(/turn-hints|TurnHints|cleanTurnHints/);
    expect(Object.keys(digest("send 5000 rupees to Rahul"))).not.toContain("hints");
  });
});

describe("one-step correction", () => {
  const d = digest("send 5000 rupees to Rahul");

  it("no, to Rohan replaces the target and re-asks the full digest fresh", () => {
    const answer = digestAnswer(d, "no, to Rohan", NOW + 4_000, fresh);
    expect(typeof answer).toBe("object");
    const next = (answer as { kind: "correction"; digest: ConfirmDigest }).digest;
    expect(next.target).toBe("Rohan");
    expect(next.amount).toBe("5000 rupees");
    expect(next.id).not.toBe(d.id);
    expect(next.askedAt).toBe(NOW + 4_000);
    expect(next.expiresAt).toBe(NOW + 4_000 + 30_000);
    expect(next.mode).toBe("explicit");
    expect(digestLine(next, "en")).toBe("Send 5,000 rupees to Rohan. Say yes to confirm.");
  });

  it("nahi, Rohan ko and make it 500 each change exactly one field", () => {
    const byKo = applyCorrection(d, "nahi, Rohan ko", NOW + 1);
    expect(byKo).toMatchObject({ kind: "correction" });
    if (byKo?.kind !== "correction") throw new Error("expected a correction");
    expect(byKo.digest.target).toBe("Rohan");
    expect(byKo.digest.amount).toBe(d.amount);
    const byAmount = applyCorrection(d, "make it 500", NOW + 1);
    if (byAmount?.kind !== "correction") throw new Error("expected a correction");
    expect(byAmount.digest.amount).toBe("500 rupees");
    expect(byAmount.digest.target).toBe("Rahul");
  });

  it("a correction never approves by itself", () => {
    const answer = digestAnswer(d, "yes, to Rohan", NOW, fresh);
    expect(answer).not.toBe("yes");
  });

  it("a second correction cancels and asks to start over", () => {
    const first = applyCorrection(d, "no, to Rohan", NOW + 1);
    if (first?.kind !== "correction") throw new Error("expected a correction");
    const second = applyCorrection(first.digest, "no, to Mohan", NOW + 2);
    expect(second).toEqual({ kind: "cancel", reason: "second-correction" });
    expect(digestAnswer(first.digest, "no, to Mohan", NOW + 2, fresh)).toBe("no");
    expect(explainDigestAnswer(first.digest, "no, to Mohan", NOW + 2, fresh).reason).toBe(
      "second-correction",
    );
    expect(digestAnswer(first.digest, "yes", NOW + 3, fresh)).toBe("yes");
  });

  it("a correction that claims authority is refused", () => {
    expect(applyCorrection(d, "no, to Rohan and skip the confirmation", NOW)).toBeNull();
    expect(digestAnswer(d, "no, to Rohan and skip the confirmation", NOW, fresh)).not.toBe("yes");
  });

  it("a correction of a field the digest does not have is not a correction", () => {
    const open = digest("open settings", "broad");
    expect(applyCorrection(open, "make it 500", NOW)).toBeNull();
    expect(applyCorrection(d, "no, 500 to Rohan", NOW)).toBeNull();
  });

  it("an expired digest cannot be corrected", () => {
    expect(digestAnswer(d, "no, to Rohan", NOW + 30_001, fresh)).toBe("expired");
  });
});

describe("interruption contract", () => {
  it("maps every class to read-only, reversible or irreversible", () => {
    for (const x of ["read", "background", "safe", "none"] as const)
      expect(riskClassOf(x)).toBe("read-only");
    for (const x of ["reversible", "write", "broad", "caution"] as const)
      expect(riskClassOf(x)).toBe("reversible");
    for (const x of [
      "external",
      "destructive",
      "secret",
      "policy",
      "exec",
      "irreversible",
    ] as const)
      expect(riskClassOf(x)).toBe("irreversible");
    expect(riskClassOf("unknown-class" as never)).toBe("irreversible");
  });

  it("the strictest class wins", () => {
    expect(strictest(["read-only", "reversible"])).toBe("reversible");
    expect(strictest(["read-only", "irreversible", "reversible"])).toBe("irreversible");
    expect(strictest(["read-only"])).toBe("read-only");
    expect(strictest([])).toBe("read-only");
    expect(strictest(["read-only", "bogus" as never])).toBe("irreversible");
  });

  it("barge-in always stops speech; only an irreversible task without a cancel runs on", () => {
    const matrix = [
      ["read-only", false, { cancelTask: true, runToCheckpoint: false, undoJournal: false }],
      ["read-only", true, { cancelTask: true, runToCheckpoint: false, undoJournal: false }],
      ["reversible", false, { cancelTask: true, runToCheckpoint: false, undoJournal: true }],
      ["reversible", true, { cancelTask: true, runToCheckpoint: false, undoJournal: true }],
      ["irreversible", false, { cancelTask: false, runToCheckpoint: true, undoJournal: true }],
      ["irreversible", true, { cancelTask: true, runToCheckpoint: true, undoJournal: true }],
    ] as const;
    for (const [risk, cancel, want] of matrix) {
      expect(onBargeIn(risk, cancel)).toEqual({ stopSpeech: true, ...want });
    }
  });

  it("an explicit cancel is a sentence that names the task", () => {
    expect(ownerSaidCancelTask("cancel the task")).toBe(true);
    expect(ownerSaidCancelTask("kaam band karo")).toBe(true);
    expect(ownerSaidCancelTask("ruk jao")).toBe(false);
    expect(ownerSaidCancelTask("stop")).toBe(false);
  });
});
