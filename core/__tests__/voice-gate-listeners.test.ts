/**
 * The microphone loop publishes its level to listeners and then schedules its next frame. A listener that threw
 * ended the loop for good: speech detection stopped and nothing said so. One bad listener now costs only itself.
 */
import { describe, expect, it } from "vitest";
import { VoiceGate } from "../../src/lib/friday/voice-audio";

describe("microphone loop listeners", () => {
  it("keeps publishing to the others when one listener throws", () => {
    const gate = new VoiceGate();
    const seen: number[] = [];
    gate.subscribe(() => {
      throw new Error("a panel failed");
    });
    gate.subscribe((snapshot) => seen.push(snapshot.level));
    expect(() => (gate as unknown as { emit: () => void }).emit()).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it("a listener that unsubscribes itself while being called does not skip the next one", () => {
    const gate = new VoiceGate();
    const order: string[] = [];
    const off = gate.subscribe(() => {
      order.push("first");
      off();
    });
    gate.subscribe(() => order.push("second"));
    (gate as unknown as { emit: () => void }).emit();
    expect(order).toEqual(["first", "second"]);
  });
});
