/**
 * After a sensitive turn (a password, a secret, a payment) the follow-up window stays shut: whatever is said next
 * needs her name again, so a person walking in or a television cannot continue the conversation. An ordinary turn
 * keeps the open follow-up window. The controller is driven directly: no microphone, no speaker, no timers.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { assistantMode } from "../../src/lib/friday/assistant-mode";

type Driver = {
  state: Record<string, unknown> & { mode: string; paused: boolean; muted: boolean };
  openFollowUp: () => void;
  markTurnAccepted: (command?: string) => void;
  addressingFor: (text: string) => { answer: boolean };
  followUpUntil: number;
  replySensitive: boolean;
  turnSensitive: boolean;
};
const d = assistantMode as unknown as Driver;
(globalThis as unknown as { window?: unknown }).window ??= globalThis;

beforeEach(() => {
  Object.assign(d.state, { mode: "auto", paused: false, muted: false });
  d.followUpUntil = 0;
  d.replySensitive = false;
  d.turnSensitive = false;
});

describe("the follow-up window after a sensitive turn", () => {
  it("opens after an ordinary turn (the control)", () => {
    d.markTurnAccepted("what is the weather like today");
    d.openFollowUp();
    expect(d.followUpUntil).toBeGreaterThan(Date.now());
  });

  it("stays shut after a turn that asks for a password or a secret", () => {
    d.followUpUntil = Date.now() + 8000;
    d.markTurnAccepted("read me my bank password");
    expect(d.turnSensitive).toBe(true);
    d.openFollowUp();
    expect(d.followUpUntil).toBe(0);
  });

  it("stays shut while the reply being spoken is sensitive", () => {
    d.markTurnAccepted("what is the weather like today");
    d.replySensitive = true;
    d.followUpUntil = Date.now() + 8000;
    d.openFollowUp();
    expect(d.followUpUntil).toBe(0);
  });

  it("a line without her name is then not addressed to her", () => {
    d.markTurnAccepted("read me my bank password");
    d.openFollowUp();
    expect(d.addressingFor("and what about the other account").answer).toBe(false);
  });

  it("her name still works at once", () => {
    d.markTurnAccepted("read me my bank password");
    d.openFollowUp();
    expect(d.addressingFor("Friday what about the other account").answer).toBe(true);
  });
});
