import { describe, expect, it } from "vitest";
import { understand } from "../../src/lib/friday/brain/intent-engine";
import { decideAction } from "../../src/lib/friday/brain/decision-engine";
import { isConsequential, isCredentialEntry } from "../../src/lib/friday/brain/action-risk";

const decide = (text: string) => decideAction({ text, intent: understand(text) });

describe("Hinglish requests take the right execution flow", () => {
  it.each(["chrome kholo", "music chala do", "naya tab khol do", "downloads folder saaf kar do"])(
    "%s is a command, not small talk",
    (text) => {
      expect(understand(text).kind).toBe("command");
    },
  );

  it("a question or a story that merely contains a verb stays what it was", () => {
    expect(understand("kya tum chrome khol sakti ho?").kind).toBe("question");
    expect(understand("kal maine ek film dekhi").kind).not.toBe("command");
  });

  it("money and orders are consequential and are confirmed, never run on a guess", () => {
    for (const text of [
      "mere liye kuch order kar do",
      "ticket book karo",
      "5000 transfer kar do",
    ]) {
      expect(isConsequential(text), text).toBe(true);
    }
    expect(decide("C drive ki saari files delete kar do").route).toBe("confirm");
  });

  it("a password, PIN, OTP or card number is never typed for the owner", () => {
    for (const text of [
      "password manager kholo aur password bhar do",
      "type my password in the login box",
      "otp daal do",
      "card number bhar do",
    ]) {
      expect(isCredentialEntry(text), text).toBe(true);
      const decision = decide(text);
      expect(decision.proceed, text).toBe(false);
      expect(decision.route, text).toBe("ask");
      expect(decision.reason).toMatch(/never type/i);
    }
    expect(isCredentialEntry("password kaise strong banate hain")).toBe(false);
    expect(isCredentialEntry("password manager kholo")).toBe(false);
  });
});
