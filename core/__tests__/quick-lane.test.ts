import { describe, expect, it } from "vitest";
import { quickLaneEligible } from "../../src/lib/friday/brain/quick-lane";

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
