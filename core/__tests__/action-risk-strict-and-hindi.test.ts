/**
 * Two gaps in the shared approval policy:
 *  - "Ask every time" (approvalLevel strict) must ask for every action and every command, the same way the voice
 *    path already does; before this, a read-only action ran without a prompt in Auto mode.
 *  - The early credential ask only knew English and Roman-Hindi verbs. A Devanagari or login / payment phrasing
 *    now asks too. It stays an early ask: the hard refusal lives in the kernel's secure-input guard.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  actionNeedsApproval,
  commandNeedsApproval,
  isCredentialEntry,
} from "../../src/lib/friday/brain/action-risk";
import { autonomy } from "../../src/lib/friday/self/autonomy";

afterEach(() => {
  autonomy.reset();
});

describe("Ask every time (strict) asks for everything", () => {
  it("a safe action asks in Auto mode when the dial is strict", () => {
    autonomy.update({ approvalLevel: "balanced" });
    expect(actionNeedsApproval("safe", "auto")).toBe(false);
    autonomy.update({ approvalLevel: "strict" });
    expect(actionNeedsApproval("safe", "auto")).toBe(true);
  });

  it("a routine check command asks in Auto mode when the dial is strict", () => {
    autonomy.update({ approvalLevel: "balanced" });
    expect(commandNeedsApproval("run git status in the terminal", "auto")).toBe(false);
    autonomy.update({ approvalLevel: "strict" });
    expect(commandNeedsApproval("run git status in the terminal", "auto")).toBe(true);
    expect(commandNeedsApproval("what time is it", "auto")).toBe(true);
  });

  it("Full autonomy still runs a safe action, and halted still asks", () => {
    autonomy.update({ approvalLevel: "full" });
    expect(actionNeedsApproval("safe", "auto")).toBe(false);
    autonomy.update({ halted: true });
    expect(actionNeedsApproval("safe", "auto")).toBe(true);
  });
});

describe("credential entry asks early in Hindi, Hinglish and login / payment phrasing", () => {
  const asks = [
    "मेरा पासवर्ड भर दो",
    "ओटीपी डाल दो",
    "पिन टाइप करो",
    "कार्ड नंबर लिख दो",
    "password bharo",
    "otp daalo",
    "pin daal do",
    "log in to my bank account",
    "login karo meri bank site pe",
    "sign in to my email for me",
    "fill the payment form",
    "enter my card details",
    "ｐａｓｓｗｏｒｄ type karo",
    "paste my password",
    "paste the password into the form",
    "enter my credentials",
    "type in my credentials for me",
    // Cyrillic lookalikes of the Latin letters p and a.
    "type the \u0440\u0430ssword",
    "enter my \u0440\u0430ssw\u043Erd",
  ];
  for (const line of asks) {
    it(`asks: ${line}`, () => {
      expect(isCredentialEntry(line)).toBe(true);
    });
  }

  const plain = [
    "what is a strong password",
    "पासवर्ड क्या होता है",
    "fix the login page bug in my app",
    "explain how OTP works",
    "open the calendar",
    "explain what credentials are",
    "paste the report into the document",
    "how do I reset a forgotten password",
  ];
  for (const line of plain) {
    it(`does not ask: ${line}`, () => {
      expect(isCredentialEntry(line)).toBe(false);
    });
  }
});
