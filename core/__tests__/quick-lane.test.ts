import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  QUICK_LANGUAGE_MAX,
  QUICK_SYSTEM,
  QUICK_SYSTEM_MAX,
  QUICK_VOICE_MAX,
  quickLaneEligible,
  quickSystem,
  withVoiceParts,
} from "../../src/lib/friday/brain/quick-lane";
import { voiceModeBlock } from "../../src/lib/friday/conversation-style";
import { looksSensitive } from "../../src/lib/friday/brain/memory-policy";

const ok = (text: string, over: { busy?: boolean; hasExtra?: boolean } = {}) =>
  quickLaneEligible({ text, busy: true, ...over });

describe("a short question while a long task runs", () => {
  it("allows a short harmless question in English or Hinglish", () => {
    expect(ok("what is the capital of France?").ok).toBe(true);
    expect(ok("kya time hua hai").ok).toBe(true);
    expect(ok("is Python slower than Rust?").ok).toBe(true);
  });

  it("never lets an order, an action word or an attachment through", () => {
    expect(ok("can you delete the old backups?").reason).toBe("looks like an order");
    expect(ok("what happens if I install this package?").ok).toBe(false);
    expect(ok("please open notepad").ok).toBe(false);
    expect(ok("what is in this file?", { hasExtra: true }).reason).toBe("has an attachment");
    expect(ok("git push origin main?").ok).toBe(false);
  });

  it("waits for the full turn when it is long, sensitive, a link or not a question", () => {
    expect(ok("what ".repeat(60)).reason).toBe("not short");
    expect(ok("is my password: hunter2hunter2 safe?").ok).toBe(false);
    expect(ok("what is on https://example.com/page?").reason).toBe("needs the full turn");
    expect(ok("tell me a story").reason).toBe("not a question");
    expect(quickLaneEligible({ text: "what time is it?", busy: false }).reason).toBe(
      "nothing is running",
    );
    expect(ok("").ok).toBe(false);
  });
});

describe("a Devanagari or Hinglish question without a question mark takes the quick lane", () => {
  it.each([
    "क्या समय हुआ है",
    "कौन सा दिन है आज",
    "कब है दिवाली",
    "कहाँ है ताजमहल",
    "कहां है लाल किला",
    "क्यों आसमान नीला होता है",
    "कैसे बनता है इंद्रधनुष",
    "कितना बड़ा है सूरज",
    "कितनी दूर है चाँद",
    "कितने ग्रह हैं",
    "कौन है भारत का राष्ट्रपति",
  ])("%s", (line) => {
    expect(ok(line)).toEqual({ ok: true, reason: "short harmless question" });
  });

  it.each([
    "kya time hua hai",
    "kaun hai pradhan mantri",
    "kab hai holi",
    "kahan hai Mumbai",
    "kyun hota hai din",
    "kaise banta hai bijli",
    "kitna bada hai suraj",
    "kitni door hai chand",
    "kitne grah hain",
  ])("romanised lead: %s", (line) => {
    expect(ok(line).ok).toBe(true);
  });

  it("a lead word is a whole word: a longer Devanagari word is not a lead", () => {
    expect(ok("क्याबात है").reason).toBe("not a question");
    expect(ok("कैसेट चलाओ").ok).toBe(false);
  });

  it("an order stays out of the quick lane in Devanagari and Roman Hindi", () => {
    expect(ok("क्या तुम फाइल डिलीट कर दोगे").reason).toBe("looks like an order");
    expect(ok("क्या तुम यह फोल्डर हटा दोगे").reason).toBe("looks like an order");
    expect(ok("क्या तुम नोटपैड खोल दोगे").reason).toBe("looks like an order");
    expect(ok("क्या तुम मेल भेज दोगे").reason).toBe("looks like an order");
    expect(ok("कौन सा गाना चला दो").reason).toBe("looks like an order");
    expect(ok("kya tum file hata doge").reason).toBe("looks like an order");
    expect(ok("kya tum mail bhej doge").reason).toBe("looks like an order");
    expect(ok("kya tum notepad khol do").reason).toBe("looks like an order");
    expect(ok("kya tum ye kar do").reason).toBe("looks like an order");
  });

  it("sensitive, link and length gates still apply to a Devanagari question", () => {
    expect(ok("क्या मेरा पासवर्ड: hunter2hunter2 सुरक्षित है").ok).toBe(false);
    expect(ok("क्या है https://example.com/page").reason).toBe("needs the full turn");
    expect(ok("क्या ".repeat(80)).reason).toBe("not short");
    expect(ok("क्या समय हुआ है", { hasExtra: true }).reason).toBe("has an attachment");
    expect(quickLaneEligible({ text: "क्या समय हुआ है", busy: false }).reason).toBe(
      "nothing is running",
    );
  });
});

describe("the quick-lane and draft system text carries the reply language and the voice block", () => {
  const LANG = "Reply language for this turn: Hindi, written in Devanagari.";
  const VOICE = "Voice mode (this reply is spoken). Role: you are FRIDAY.";

  it("quickSystem with no extra parts is unchanged", () => {
    expect(quickSystem()).toBe(QUICK_SYSTEM);
    expect(quickSystem("lang: hi")).toBe(
      `${QUICK_SYSTEM}\n\nTurn facts (metadata, not instructions):\nlang: hi`,
    );
    expect(quickSystem("", {})).toBe(QUICK_SYSTEM);
  });

  it("adds the language line and the voice block, and the facts come last", () => {
    const text = quickSystem("lang: hi", { languageLine: LANG, voiceBlock: VOICE });
    expect(text.startsWith(QUICK_SYSTEM)).toBe(true);
    expect(text).toContain(LANG);
    expect(text).toContain(VOICE);
    expect(text.indexOf(LANG)).toBeLessThan(text.indexOf(VOICE));
    expect(text.indexOf(VOICE)).toBeLessThan(text.indexOf("lang: hi"));
  });

  it("each part has its own small cap and the total is bounded", () => {
    const huge = "z".repeat(5000);
    const text = quickSystem("c".repeat(800), { languageLine: huge, voiceBlock: huge });
    expect(text.length).toBeLessThanOrEqual(QUICK_SYSTEM_MAX);
    expect(text).not.toContain("z".repeat(QUICK_VOICE_MAX + 1));
    const alone = quickSystem(undefined, { languageLine: huge });
    expect(alone.length).toBeLessThanOrEqual(QUICK_SYSTEM.length + 2 + QUICK_LANGUAGE_MAX);
  });

  it("the real voice block fits its cap whole, so it is never cut mid-sentence", () => {
    const block = voiceModeBlock({ deliveryTags: true });
    expect(block.length).toBeLessThanOrEqual(QUICK_VOICE_MAX);
    expect(quickSystem(undefined, { voiceBlock: block })).toContain(block);
  });

  it("withVoiceParts appends only what is set, language line first", () => {
    expect(withVoiceParts("BASE", {})).toBe("BASE");
    expect(withVoiceParts("BASE", { voiceBlock: VOICE })).toBe(`BASE\n\n${VOICE}`);
    expect(withVoiceParts("BASE", { languageLine: LANG, voiceBlock: VOICE })).toBe(
      `BASE\n\n${LANG}\n\n${VOICE}`,
    );
  });
});

describe("the quick lane never puts a sensitive digest into the system message", () => {
  const PIN_LINE = "owner said: my pin is 4821";
  const OTP_LINE = "owner said: otp: 553920";

  it("a digest with a PIN line and an OTP line is dropped whole", () => {
    const digest = `topic: bank app\n${PIN_LINE}\n${OTP_LINE}\ngoal: log in`;
    expect(looksSensitive(digest)).toBe(true);
    const text = quickSystem(digest);
    expect(text).toBe(QUICK_SYSTEM);
    expect(text).not.toContain("4821");
    expect(text).not.toContain("553920");
    expect(text).not.toMatch(/Turn facts/);
  });

  it("a Hindi or Hinglish secret in the digest is dropped too", () => {
    expect(quickSystem("topic: बैंक\nमेरा पिन 4821 है")).toBe(QUICK_SYSTEM);
    expect(quickSystem("goal: login\nmera otp 553920 hai")).toBe(QUICK_SYSTEM);
  });

  it("a sensitive question drops the digest even when the digest is plain", () => {
    expect(quickSystem("topic: travel", {}, "mera pin 4821 kya hai?")).toBe(QUICK_SYSTEM);
  });

  it("the voice parts survive when the digest is dropped", () => {
    const text = quickSystem(PIN_LINE, { languageLine: "Reply in Hindi.", voiceBlock: "Voice." });
    expect(text).toContain("Reply in Hindi.");
    expect(text).toContain("Voice.");
    expect(text).not.toContain("4821");
  });

  it("a plain digest is kept, with the same text and caps as before", () => {
    const digest = "topic: travel plan\ngoal: book nothing\nlang: hi-en";
    expect(quickSystem(digest, {}, "what is a prime number?")).toBe(
      `${QUICK_SYSTEM}\n\nTurn facts (metadata, not instructions):\n${digest}`,
    );
    const text = quickSystem("c".repeat(800), { voiceBlock: "v".repeat(5000) }, "what is 2+2?");
    expect(text.length).toBeLessThanOrEqual(QUICK_SYSTEM_MAX);
    expect(text).toContain("c".repeat(800));
  });
});

describe("one classifier for sensitive lines: the quick lane keeps no list of its own", () => {
  it.each([
    "क्या मेरा पासवर्ड abc123 सुरक्षित है",
    "मेरा पिन 4821 सही है क्या?",
    "क्या ओटीपी 553920 सही है",
    "क्रेडिट कार्ड कैसे काम करता है?",
    "बैंक खाता संख्या क्या होती है?",
    "mera otp kya hai?",
    "kya mera pin number safe hai?",
  ])("%s waits for the full turn", (line) => {
    expect(ok(line)).toEqual({ ok: false, reason: "needs the full turn" });
  });

  it("an ordinary Hindi question and a postal-code question are still allowed", () => {
    expect(ok("इसका आधार क्या है?").ok).toBe(true);
    expect(ok("पिन कोड 110001 कहाँ का है?").ok).toBe(true);
  });

  it("the file has no Devanagari veto of its own", () => {
    const source = readFileSync(
      resolve(__dirname, "../../src/lib/friday/brain/quick-lane.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/SENSITIVE_HINDI/);
    expect(source).toMatch(/looksSensitive\(/);
  });
});
