/**
 * One yes table. Every path that can approve something (the utterance router's answer to the open prompt, the
 * acknowledgement catalogue's yes-word gate, the confirmation digest) reads the allowlist in voice-session.ts
 * (`CONFIRM_WORDS`, `confirmationVerdict`) and nothing else, so the three agree line by line and none of them
 * gives a false yes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AFFIRM } from "../../src/lib/friday/brain/action-risk";
import { conversationalMove } from "../../src/lib/friday/brain/intent-engine";
import {
  clearPendingChange,
  readSettingsIntent,
  useVoicePreferenceStorage,
} from "../../src/lib/friday/brain/settings-intents";
import { isYesLike } from "../../src/lib/friday/voice-engine/instant-ack";
import {
  buildConfirmDigest,
  explainDigestAnswer,
} from "../../src/lib/friday/voice-engine/confirm-digest";
import { routeUtterance } from "../../src/lib/friday/voice-engine/utterance-router";
import { confirmationVerdict, mentionsConfirmWord } from "../../src/lib/friday/voice-session";

type Verdict = "yes" | "no" | "unclear";

/** [line, what the table must say]. The first block is a true yes in English, Roman Hindi and Devanagari. */
const LINES: ReadonlyArray<readonly [string, Verdict]> = [
  // True yes, English.
  ["yes", "yes"],
  ["Yes.", "yes"],
  ["yeah", "yes"],
  ["yep", "yes"],
  ["okay", "yes"],
  ["go ahead", "yes"],
  ["do it", "yes"],
  ["sure", "yes"],
  ["yes please", "yes"],
  ["yes, go ahead", "yes"],
  // True yes, Roman Hindi.
  ["haan", "yes"],
  ["haan ji", "yes"],
  ["ji haan", "yes"],
  ["theek hai", "yes"],
  ["haan kar do", "yes"],
  ["bilkul", "yes"],
  // True yes, Devanagari.
  ["हाँ", "yes"],
  ["हां", "yes"],
  ["हाँ जी", "yes"],
  ["जी हाँ", "yes"],
  ["ठीक है", "yes"],
  ["हाँ करो", "yes"],
  ["बिल्कुल", "yes"],
  ["हाँ कर दो", "yes"],
  // No, three scripts.
  ["no", "no"],
  ["nope", "no"],
  ["don't", "no"],
  ["cancel that", "no"],
  ["nahi", "no"],
  ["nahi mat karo", "no"],
  ["mat karo", "no"],
  ["नहीं", "no"],
  ["नहीं करो", "no"],
  ["मत करो", "no"],
  // Mixed: a no anywhere is a no, never a yes.
  ["yes no", "no"],
  ["haan nahi", "no"],
  ["हाँ नहीं", "no"],
  ["yes but don't", "no"],
  ["ok nahi", "no"],
  // The false-yes traps the old Devanagari fallback let through.
  ["हाँ शायद", "unclear"],
  ["हाँ परसों", "unclear"],
  ["हाँ?", "unclear"],
  ["जी", "unclear"],
  ["करो", "unclear"],
  ["हा हा", "unclear"],
  ["haha", "unclear"],
  ["हाँ बाद में", "no"],
  ["हां कल", "no"],
  ["ठीक", "unclear"],
  ["ओके", "yes"],
  // Later, skip, wait: the table reads them as a no, never as a yes. Maybe stays unclear.
  ["yes maybe", "unclear"],
  ["haan shayad", "unclear"],
  ["yes later", "no"],
  ["haan baad mein", "no"],
  ["ok parso", "unclear"],
  ["haan kabhi aur", "unclear"],
  ["maybe", "unclear"],
  ["shayad", "unclear"],
  ["later", "no"],
  ["baad mein karna", "no"],
  ["ok skip", "no"],
  ["haan ruk", "no"],
  ["ok tham jao", "no"],
  ["pause karo", "no"],
  ["wait a second", "no"],
  ["ek minute", "unclear"],
  ["ok रहने दे", "no"],
  ["ok ठहरो", "no"],
  // A question back, or yes followed by something else.
  ["yes?", "unclear"],
  ["haan?", "unclear"],
  ["okay so what happens next", "unclear"],
  ["yes and also open the browser", "unclear"],
  ["haan aur ek kaam bhi karna", "unclear"],
  ["yes send it to Rohan", "unclear"],
  ["yes delete everything on the drive", "unclear"],
  ["I said yes yesterday", "unclear"],
  // Names, including names that sound like a yes-word.
  ["Rahul", "unclear"],
  ["Priya", "unclear"],
  ["Friday", "unclear"],
  ["Asha ji", "unclear"],
  ["Hina", "unclear"],
  ["Okay Priya", "unclear"],
  ["Hannah", "unclear"],
  ["Jiya", "unclear"],
  ["Sureshbhai", "unclear"],
  ["Ok Google", "unclear"],
  // Empty, noise, other talk.
  ["", "unclear"],
  ["   ", "unclear"],
  ["hmm", "unclear"],
  ["what time is it", "unclear"],
  ["kya", "unclear"],
  ["क्या बात है", "unclear"],
  ["mujhe nahin pata kya karna hai", "no"],
];

const NOW = 1_000_000;
const OPEN = { pendingApproval: { askedAt: NOW - 5_000, taskId: "t1" } } as const;
const router = (text: string) => routeUtterance({ text, now: NOW, tasks: [], busy: true, ...OPEN });
const digestFor = (text: string) =>
  explainDigestAnswer(
    buildConfirmDigest({
      command: "delete the old backups",
      turnId: "t1",
      now: NOW,
      kind: "irreversible",
    }),
    text,
    NOW + 2_000,
    { ownPlayback: false },
  );

describe("one yes table: the table itself", () => {
  it("has at least 80 lines, with every verdict and three scripts in it", () => {
    expect(LINES.length).toBeGreaterThanOrEqual(80);
    for (const verdict of ["yes", "no", "unclear"] as const)
      expect(LINES.some(([, v]) => v === verdict)).toBe(true);
    expect(LINES.some(([l]) => /\p{Script=Devanagari}/u.test(l))).toBe(true);
    expect(LINES.some(([l]) => /^[A-Za-z' ,.]+$/.test(l))).toBe(true);
  });

  it.each(LINES)("confirmationVerdict(%j) is %s", (line, want) => {
    expect(confirmationVerdict(line)).toBe(want);
  });
});

describe("one yes table: every approval path agrees with it", () => {
  it.each(LINES)("%j", (line, want) => {
    const base = confirmationVerdict(line);

    // The utterance router: an answer to the open prompt only when the table gives one, with the table's verdict,
    // and never a yes the table did not give.
    const routed = router(line);
    if (base === "unclear") expect(routed.kind).not.toBe("approval-answer");
    if (routed.kind === "approval-answer") expect(routed.verdict).toBe(base);
    if (base === "yes") expect(routed).toMatchObject({ kind: "approval-answer", verdict: "yes" });

    // The acknowledgement gate: a line the table reads as a yes or a no, or that carries a table word, is yes-like,
    // so she never says it herself. It may be stricter (a bare Devanagari "जी"), never looser.
    if (base !== "unclear" || mentionsConfirmWord(line)) expect(isYesLike(line)).toBe(true);
    if (!line.trim()) expect(isYesLike(line)).toBe(true);

    // The confirmation digest: a yes only when the table says yes; a no only when the table says no.
    const digest = digestFor(line).answer;
    if (digest === "yes") expect(base).toBe("yes");
    if (digest === "no") expect(base).toBe("no");
    if (base === "yes") expect(digest).toBe("yes");
  });

  it("gives zero false yes on any path", () => {
    const falseYes = LINES.filter(([line, want]) => {
      if (want === "yes") return false;
      return (
        confirmationVerdict(line) === "yes" ||
        (router(line).kind === "approval-answer" && router(line).verdict === "yes") ||
        digestFor(line).answer === "yes"
      );
    });
    expect(falseYes).toEqual([]);
  });
});

describe("one yes table: the typed paths agree with it too", () => {
  const storage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };
  beforeEach(() => {
    useVoicePreferenceStorage(storage());
    clearPendingChange();
  });
  afterEach(() => {
    useVoicePreferenceStorage(null);
    clearPendingChange();
  });

  it.each(LINES)("%j", (line, want) => {
    const yes = want === "yes";
    // The action-risk yes test, the intent engine's approval move and the settings confirmation: a yes only for a yes.
    expect(AFFIRM.test(line)).toBe(yes);
    expect(conversationalMove(line) === "approval").toBe(yes);
    readSettingsIntent("from now on speak slower");
    expect(readSettingsIntent(line)?.kind === "applied").toBe(yes);
  });

  it("keeps the real typed phrases that approve, and never a bare apply, ya or approved", () => {
    for (const line of ["yes", "ok", "confirm", "kar do", "proceed", "do it", "haan kar do"])
      expect(AFFIRM.test(line)).toBe(true);
    for (const line of ["apply", "ya", "approved", "bas kar do", "yes send it to Rohan"])
      expect(AFFIRM.test(line)).toBe(false);
  });

  it("the three sources keep no yes list of their own", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["action-risk", "settings-intents", "intent-engine"]) {
      const source = readFileSync(`src/lib/friday/brain/${file}.ts`, "utf8");
      expect(source).toMatch(/confirmationVerdict/);
      expect(source).not.toMatch(/\^?\(yes\|yeah|\\b\(yes\|yeah/);
    }
  });
});

describe("one yes table: the old fallback is gone", () => {
  it("the router source has no yes or no word list of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/friday/voice-engine/utterance-router.ts", "utf8");
    expect(source).not.toMatch(/DEV_YES|DEV_NO/);
    expect(source).toMatch(
      /function verdictOf\([^)]*\)[^{]*\{\s*const base = confirmationVerdict\(text\);\s*return base;\s*\}/,
    );
  });
});
