import { describe, expect, it } from "vitest";
import {
  createNarrationMemory,
  digestLine,
  holdDigest,
  LINE_POOLS,
  narrate,
  sanitizeForSpeech,
  type NarrateContext,
  type NarrateEvent,
  type NarrateResult,
} from "../../src/lib/friday/voice-engine/narration-policy";

const T0 = 5_000_000;

/** A fixed clock and one memory, so a sequence of events reads like a conversation. */
const desk = (over: Partial<NarrateContext> = {}) => {
  const memory = createNarrationMemory();
  let now = T0;
  const ctx = (extra: Partial<NarrateContext> = {}): NarrateContext => ({
    now,
    lang: "en",
    speakReplies: true,
    muted: false,
    callHold: false,
    alertsAudible: true,
    whisperMode: false,
    progressLinesPerMinute: 3,
    runningTasks: 1,
    ownerIdleMs: 0,
    sensitive: false,
    memory,
    ...over,
    ...extra,
  });
  return {
    memory,
    advance: (ms: number) => void (now += ms),
    say: (event: NarrateEvent, extra: Partial<NarrateContext> = {}): NarrateResult =>
      narrate(event, ctx(extra)),
  };
};

/** Everything a spoken line must never contain. */
const LEAKS: Array<[string, RegExp]> = [
  ["url", /https?:|www\.|\.com\/|\.org\//i],
  ["windows path", /[A-Za-z]:\\|\\\\[\w.$-]+\\/],
  ["unix path", /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+\/|(?:^|\s)\/\w/],
  ["code", /`|```|=>|;\s*$|\{\s*\w+:|\bconst\s+\w+\s*=/],
  ["stack trace", /Traceback|\bat\s+[\w.$<>]+\s*\(|File ".*", line \d+|\w+(?:Error|Exception):/],
  ["errno", /\b(?:ENOENT|EACCES|ECONN\w+|ETIMEDOUT|ENOTFOUND|ENOSPC)\b|0x[0-9a-f]{4,}/i],
  [
    "command",
    /\b(?:npm|npx|pip3?|git|sudo|rm|curl|wget|powershell)\s+[-\w]+|(?:^|\s)--[a-z][\w-]*/i,
  ],
  [
    "secret",
    /\bsk-[\w-]{12,}|\bgh[pousr]_\w{16,}|\bAKIA[0-9A-Z]{12,}|\b[A-Fa-f0-9]{32,}\b|Bearer\s+\S{12,}/,
  ],
];
const leaks = (line: string | null | undefined): string[] =>
  line ? LEAKS.filter(([, re]) => re.test(line)).map(([name]) => name) : [];

describe("the acknowledgement is one batched line", () => {
  it("says one short ack and holds back a second inside the batch window", () => {
    const d = desk();
    const first = d.say({ kind: "ack", taskId: "t1" });
    expect(first.say).toBeTruthy();
    expect(first.priority).toBe("progress");
    d.advance(2_000);
    expect(d.say({ kind: "ack", taskId: "t2" }).say).toBeNull();
    d.advance(5_000);
    expect(d.say({ kind: "ack", taskId: "t3" }).say).toBeTruthy();
  });

  it("names the count when several tasks start together", () => {
    const d = desk();
    expect(d.say({ kind: "ack", taskId: "t1", count: 3 }).say).toContain("3");
    const hi = desk({ lang: "hi" });
    expect(hi.say({ kind: "ack", taskId: "t1", count: 2 }).say).toContain("2");
  });

  it("does not repeat the same wording twice in a row", () => {
    const d = desk();
    const a = d.say({ kind: "ack", taskId: "t1" }).say;
    d.advance(10_000);
    const b = d.say({ kind: "ack", taskId: "t2" }).say;
    expect(a).not.toBe(b);
  });
});

describe("progress says only real milestones", () => {
  it("speaks a percent step of 25 or more, at most every 20 seconds, per task", () => {
    const d = desk();
    expect(d.say({ kind: "progress", taskId: "t1", percent: 25 }).say).toBe(
      "About 25 percent done.",
    );
    d.advance(5_000);
    expect(d.say({ kind: "progress", taskId: "t1", percent: 50 }).say).toBeNull(); // too soon
    d.advance(15_000);
    expect(d.say({ kind: "progress", taskId: "t1", percent: 40 }).say).toBeNull(); // step of 15
    expect(d.say({ kind: "progress", taskId: "t1", percent: 50 }).say).toBe(
      "About 50 percent done.",
    );
  });

  it("keeps a separate memory for each task", () => {
    const d = desk({ progressLinesPerMinute: 10 });
    expect(d.say({ kind: "progress", taskId: "a", percent: 30 }).say).toBeTruthy();
    expect(d.say({ kind: "progress", taskId: "b", percent: 30 }).say).toBeTruthy();
  });

  it("never invents a percent the task did not give", () => {
    const d = desk({ progressLinesPerMinute: 99 });
    expect(d.say({ kind: "progress", taskId: "t1" }).say).toBeNull();
    const r = d.say({ kind: "progress", taskId: "t1", step: "Running tests 90% complete" });
    expect(r.say ?? "").not.toMatch(/\d/);
    expect(d.say({ kind: "progress", taskId: "t2", percent: Number.NaN }).say).toBeNull();
    expect(d.say({ kind: "progress", taskId: "t3", percent: 140 }).say ?? "").not.toMatch(/140/);
  });

  it("says a named tool step at most once every 15 seconds", () => {
    const d = desk({ progressLinesPerMinute: 10 });
    expect(d.say({ kind: "progress", taskId: "t1", step: "opening Chrome" }).say).toBe(
      "Opening Chrome.",
    );
    d.advance(14_000);
    expect(d.say({ kind: "progress", taskId: "t1", step: "reading the file" }).say).toBeNull();
    d.advance(1_000);
    expect(d.say({ kind: "progress", taskId: "t1", step: "reading the file" }).say).toBe(
      "Reading the file.",
    );
  });

  it("does not read a step that is not a plain action, or that holds a path", () => {
    const d = desk({ progressLinesPerMinute: 10 });
    expect(d.say({ kind: "progress", taskId: "t1", step: "reading /etc/passwd" }).say).toBeNull();
    d.advance(60_000);
    expect(
      d.say({ kind: "progress", taskId: "t1", step: "tool_call(search, {q: 'x'})" }).say,
    ).toBeNull();
  });

  it("a Hindi owner gets a generic step line, not the English step text", () => {
    const d = desk({ lang: "hi" });
    const line = d.say({ kind: "progress", taskId: "t1", step: "opening Chrome" }).say;
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/chrome/i);
  });

  it("caps spoken progress lines per minute and frees the slot after the minute", () => {
    const d = desk({ progressLinesPerMinute: 3 });
    const said: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) {
      said.push(d.say({ kind: "progress", taskId: `t${i}`, percent: 30 }).say);
      d.advance(1_000);
    }
    expect(said.filter(Boolean)).toHaveLength(3);
    d.advance(60_000);
    expect(d.say({ kind: "progress", taskId: "late", percent: 30 }).say).toBeTruthy();
  });

  it("a cap of zero silences progress entirely", () => {
    const d = desk({ progressLinesPerMinute: 0 });
    expect(d.say({ kind: "progress", taskId: "t1", percent: 90 }).say).toBeNull();
  });

  it("whisper mode flags progress lines and nothing else", () => {
    const d = desk({ whisperMode: true });
    expect(d.say({ kind: "progress", taskId: "t1", percent: 30 }).whisper).toBe(true);
    expect(
      d.say({ kind: "needs-approval", taskId: "t1", label: "Clean up" }).whisper,
    ).toBeUndefined();
    expect(d.say({ kind: "done", taskId: "t1", answer: "Finished." }).whisper).toBeUndefined();
  });
});

describe("three or more tasks roll up", () => {
  it("speaks no per-task progress, and one summary per minute when the owner has been idle", () => {
    const d = desk();
    const many = { runningTasks: 3 } as const;
    expect(d.say({ kind: "progress", taskId: "a", percent: 50 }, many).say).toBeNull();
    expect(d.say({ kind: "rollup" }, { ...many, ownerIdleMs: 5_000 }).say).toBeNull();
    const idle = { ...many, ownerIdleMs: 20_000 };
    expect(d.say({ kind: "rollup" }, idle).say).toBe("3 tasks are running.");
    d.advance(59_000);
    expect(d.say({ kind: "rollup" }, idle).say).toBeNull();
    d.advance(1_000);
    expect(d.say({ kind: "rollup" }, { ...idle, runningTasks: 4 }).say).toBe(
      "4 tasks are running.",
    );
  });

  it("a progress event can carry the roll-up too", () => {
    const d = desk();
    const r = d.say(
      { kind: "progress", taskId: "a", percent: 50 },
      { runningTasks: 3, ownerIdleMs: 30_000 },
    );
    expect(r.say).toBe("3 tasks are running.");
  });

  it("is silent when fewer than three run", () => {
    expect(desk().say({ kind: "rollup" }, { runningTasks: 2, ownerIdleMs: 60_000 }).say).toBeNull();
  });

  it("a roll-up in Hindi", () => {
    const r = desk({ lang: "hi" }).say(
      { kind: "rollup" },
      { runningTasks: 3, ownerIdleMs: 30_000 },
    );
    expect(r.say).toBe("3 kaam chal rahe hain.");
  });
});

describe("approval is said at once, then again once, then stays on screen", () => {
  it("follows that timeline and ignores the progress cap", () => {
    const d = desk({ progressLinesPerMinute: 0 });
    const first = d.say({ kind: "needs-approval", taskId: "t1", label: "Clean temp files" });
    expect(first.say).toContain("Clean temp files");
    expect(first.priority).toBe("approval");
    d.advance(10_000);
    expect(d.say({ kind: "needs-approval", taskId: "t1", label: "Clean temp files" })).toEqual({
      say: null,
    });
    d.advance(10_000);
    const again = d.say({ kind: "needs-approval", taskId: "t1", label: "Clean temp files" });
    expect(again.say).toBeTruthy();
    expect(again.say).not.toBe(first.say);
    d.advance(30_000);
    const third = d.say({ kind: "needs-approval", taskId: "t1", label: "Clean temp files" });
    expect(third.say).toBeNull();
    expect(third.screenOnly).toBeTruthy();
  });

  it("a settled task forgets its prompt", () => {
    const d = desk();
    d.say({ kind: "needs-approval", taskId: "t1" });
    d.say({ kind: "settled", taskId: "t1" });
    expect(d.say({ kind: "needs-approval", taskId: "t1" }).say).toBeTruthy();
  });

  it("asks for input in its own words", () => {
    const r = desk().say({ kind: "needs-input", taskId: "t1" });
    expect(r.say).toMatch(/one thing|answer/i);
    expect(r.priority).toBe("approval");
  });

  it("does not read a label that holds a link or path", () => {
    const r = desk().say({
      kind: "needs-approval",
      taskId: "t1",
      label: "Delete C:\\Users\\me\\x and https://a.io/x",
    });
    expect(leaks(r.say)).toEqual([]);
    expect(r.say).toBeTruthy();
  });

  it("is spoken in Hindi for a Hindi owner", () => {
    expect(desk({ lang: "hi" }).say({ kind: "needs-approval", taskId: "t1" }).say).toMatch(
      /haan|ha ya na/i,
    );
  });
});

describe("a failure gives a plain cause once and offers a retry", () => {
  it.each([
    ["getaddrinfo ENOTFOUND api.example.com", "no connection"],
    ["ETIMEDOUT after 30000ms", "too long"],
    ["EACCES: permission denied, open 'C:\\x'", "allowed"],
    ["ENOENT: no such file or directory", "find"],
    ["429 Too Many Requests", "busy"],
    ["ENOSPC: no space left on device", "full"],
    [
      "TypeError: Cannot read properties of undefined (reading 'x')\n    at run (C:\\app\\a.js:10:5)",
      "went wrong",
    ],
  ])("%s", (raw, word) => {
    const r = desk().say({ kind: "failed", taskId: "t1", label: "Sales sheet", cause: raw });
    expect(r.say).toContain(word);
    expect(r.say).toMatch(/try again|retry/i);
    expect(leaks(r.say)).toEqual([]);
    expect(r.say).not.toContain(raw.slice(0, 12));
    expect(r.priority).toBe("direct");
  });

  it("says it once per task", () => {
    const d = desk();
    expect(d.say({ kind: "failed", taskId: "t1", cause: "timeout" }).say).toBeTruthy();
    expect(d.say({ kind: "failed", taskId: "t1", cause: "timeout" }).say).toBeNull();
    expect(d.say({ kind: "failed", taskId: "t2", cause: "timeout" }).say).toBeTruthy();
  });

  it("works with no cause at all, and in Hindi", () => {
    expect(desk().say({ kind: "failed", taskId: "t1" }).say).toContain("went wrong");
    expect(desk({ lang: "hi" }).say({ kind: "failed", taskId: "t1" }).say).toMatch(/dobara|phir/i);
  });
});

describe("done is the model's own first sentence, cleaned", () => {
  it("takes the first sentence", () => {
    const r = desk().say({
      kind: "done",
      taskId: "t1",
      answer: "I found three invoices from March. Two are paid. One is overdue.",
    });
    expect(r.say).toBe("I found three invoices from March.");
    expect(r.priority).toBe("direct");
  });

  it("strips links, paths and code before choosing the sentence", () => {
    const answer =
      "I saved the report to C:\\Users\\me\\Documents\\report.pdf and https://example.com/r/1 is the link. ```js\nconsole.log(1)\n```";
    const r = desk().say({ kind: "done", taskId: "t1", answer });
    expect(leaks(r.say)).toEqual([]);
    expect(r.say).toMatch(/saved the report/);
  });

  it("falls back to a plain line when the answer is only code, a stack trace or a command", () => {
    for (const answer of [
      "```py\nprint('hi')\n```",
      'Traceback (most recent call last):\n  File "a.py", line 3, in <module>',
      "npm install --save left-pad",
      "$ rm -rf build",
      "   ",
      "",
    ]) {
      const r = desk().say({ kind: "done", taskId: "t1", label: "Build site", answer });
      expect(r.say, answer).toBeTruthy();
      expect(leaks(r.say)).toEqual([]);
    }
  });

  it("says once per task", () => {
    const d = desk();
    expect(d.say({ kind: "done", taskId: "t1", answer: "Done." }).say).toBeTruthy();
    expect(d.say({ kind: "done", taskId: "t1", answer: "Done." }).say).toBeNull();
  });

  it("does not read a secret-looking value, and sends the details to the screen", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const r = desk().say({
      kind: "done",
      taskId: "t1",
      answer: `Your key is ${key}. Keep it safe.`,
    });
    expect(r.say).not.toContain(key);
    expect(r.say).toMatch(/screen/i);
  });

  it("is spoken in Hindi, keeping the model's Devanagari", () => {
    const r = desk({ lang: "hi" }).say({
      kind: "done",
      taskId: "t1",
      answer: "रिपोर्ट तैयार है। दो फ़ाइलें बनीं।",
    });
    expect(r.say).toBe("रिपोर्ट तैयार है।");
  });
});

describe("things she never says", () => {
  const nasty = [
    "See https://evil.example/login?token=abc123 for details.",
    "Open www.example.com now.",
    "The file is at C:\\Windows\\System32\\config\\SAM okay.",
    "It lives in /home/user/.ssh/id_rsa today.",
    "Run `rm -rf /` to clean up.",
    "Error: ENOENT: no such file\n    at Object.openSync (node:fs:601:3)",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "The hash is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08.",
    "Use pip install requests --upgrade first.",
    "const x = await fetch(url); done",
    "password: hunter2 was set",
  ];

  it.each(nasty)("done never leaks: %s", (answer) => {
    const r = desk().say({ kind: "done", taskId: "t1", label: "Job", answer });
    expect(leaks(r.say), `${r.say}`).toEqual([]);
    expect(r.say ?? "").not.toMatch(/hunter2|abc123|id_rsa/);
  });

  it.each(nasty)("a failure cause never leaks: %s", (cause) => {
    const r = desk().say({ kind: "failed", taskId: "t1", label: "Job", cause });
    expect(leaks(r.say), `${r.say}`).toEqual([]);
  });

  it.each(nasty)("a label never leaks: %s", (label) => {
    const r = desk().say({ kind: "needs-approval", taskId: "t1", label });
    expect(leaks(r.say), `${r.say}`).toEqual([]);
  });

  it("sanitizeForSpeech reports what it removed", () => {
    expect(sanitizeForSpeech("Look at https://a.io/x please.")).toMatchObject({
      removed: true,
      unsafe: false,
    });
    expect(sanitizeForSpeech("Look at https://a.io/x please.").text).not.toContain("http");
    expect(sanitizeForSpeech("sk-abcdefghijklmnopqrstuvwxyz0123").secret).toBe(true);
    expect(sanitizeForSpeech("Plain words only.")).toEqual({
      text: "Plain words only.",
      removed: false,
      unsafe: false,
      secret: false,
    });
    expect(sanitizeForSpeech("and/or 10/12 are fine").unsafe).toBe(false);
  });

  it("no fixed line claims to be human or to feel", () => {
    for (const pool of Object.values(LINE_POOLS)) {
      for (const line of pool) {
        expect(line).not.toMatch(
          /\b(?:i feel|i'?m (?:a )?human|as a human|my heart|i am alive)\b/i,
        );
        expect(leaks(line)).toEqual([]);
      }
    }
  });
});

describe("when she must not speak", () => {
  const events: NarrateEvent[] = [
    { kind: "ack", taskId: "t1" },
    { kind: "progress", taskId: "t1", percent: 50 },
    { kind: "failed", taskId: "t1", cause: "timeout" },
    { kind: "done", taskId: "t1", answer: "Finished the report." },
  ];

  it("a call holds everything back and a text digest follows", () => {
    const d = desk({ callHold: true });
    for (const e of events) expect(d.say(e).say).toBeNull();
    const ask = d.say({ kind: "needs-approval", taskId: "t2", label: "Send the file" });
    expect(ask.say).toBeNull();
    expect(ask.notify).toBeTruthy();
    const digest = holdDigest(d.memory, "en");
    expect(digest?.count).toBeGreaterThanOrEqual(3);
    expect(digest?.text).toContain("Finished the report.");
    expect(holdDigest(d.memory, "en")).toBeNull();
  });

  it("a call digest keeps a sensitive line neutral", () => {
    const d = desk({ callHold: true, sensitive: true });
    d.say({ kind: "done", taskId: "t1", answer: "Your balance is 12,345 rupees." });
    expect(holdDigest(d.memory, "en")?.text).not.toContain("12,345");
  });

  it("quiet hours or DND speak nothing but notify for an approval", () => {
    const d = desk({ alertsAudible: false });
    for (const e of events) {
      const r = d.say(e);
      expect(r.say).toBeNull();
    }
    const ask = d.say({ kind: "needs-approval", taskId: "t2", label: "Send the file" });
    expect(ask.say).toBeNull();
    expect(ask.notify).toContain("Send the file");
    expect(ask.screenOnly).toBeTruthy();
  });

  it("muted or replies off means screen only", () => {
    for (const off of [{ muted: true }, { speakReplies: false }] as const) {
      const d = desk(off);
      const done = d.say({ kind: "done", taskId: "t1", answer: "Finished the report." });
      expect(done.say).toBeNull();
      expect(done.screenOnly).toBe("Finished the report.");
      const ask = d.say({ kind: "needs-approval", taskId: "t1" });
      expect(ask.say).toBeNull();
      expect(ask.screenOnly).toBeTruthy();
    }
  });

  it("a muted failure still shows its plain cause on screen", () => {
    const r = desk({ muted: true }).say({ kind: "failed", taskId: "t1", cause: "ENOTFOUND host" });
    expect(r.screenOnly).toContain("no connection");
  });
});

describe("sensitive work stays neutral", () => {
  it("done and failure say that details are on screen and carry no content", () => {
    const d = desk({ sensitive: true });
    const done = d.say({
      kind: "done",
      taskId: "t1",
      label: "Tax return",
      answer: "Your PAN is ABCDE1234F.",
    });
    expect(done.say).toMatch(/on (?:the |your )?screen/i);
    expect(done.say).not.toMatch(/PAN|ABCDE|tax/i);
    const bad = d.say({ kind: "failed", taskId: "t2", label: "Tax return", cause: "timeout" });
    expect(bad.say).toMatch(/on (?:the |your )?screen/i);
    expect(bad.say).not.toMatch(/tax/i);
  });

  it("an approval for sensitive work never names it", () => {
    const r = desk({ sensitive: true }).say({
      kind: "needs-approval",
      taskId: "t1",
      label: "Bank transfer",
    });
    expect(r.say).toMatch(/screen/i);
    expect(r.say).not.toMatch(/bank/i);
  });

  it("a tool step is not read for sensitive work", () => {
    expect(
      desk({ sensitive: true }).say({ kind: "progress", taskId: "t1", step: "reading statement" })
        .say,
    ).toBeNull();
  });
});

describe("digest line for lines that aged out", () => {
  it("counts finished tasks and sends details to the screen", () => {
    expect(digestLine({ count: 1, sensitive: 0 }, "en")).toBe(
      "While you were busy, one task finished. Details are on screen.",
    );
    expect(digestLine({ count: 3, sensitive: 1 }, "en")).toContain("3 tasks");
    expect(digestLine({ count: 2, sensitive: 0 }, "hi")).toContain("2");
    expect(digestLine({ count: 0, sensitive: 0 }, "en")).toBeNull();
  });
});
