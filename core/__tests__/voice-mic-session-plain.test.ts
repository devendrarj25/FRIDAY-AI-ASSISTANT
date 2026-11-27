import { describe, expect, it } from "vitest";
import {
  captureRateChanged,
  faultLanguage,
  plainFaultLine,
  savedInputPlan,
} from "../../src/lib/friday/mic-session";
import {
  deviceOptions,
  micListIssue,
  planSavedDevice,
} from "../../src/lib/friday/voice-engine/audio-devices";

describe("saved microphone planner (S3)", () => {
  it("an empty list from a failed enumerate is unknown: never cleared, choice kept", () => {
    const plan = savedInputPlan("bt-headset", [], { enumerated: false });
    expect(plan.cleared).toBe(false);
    expect(plan.deviceId).toBeNull();
    expect(plan.restore).toBe("bt-headset");
  });

  it("an empty list before permission is unknown too", () => {
    expect(savedInputPlan("bt", [], { permitted: false }).cleared).toBe(false);
    expect(savedInputPlan("bt", [], {}).cleared).toBe(false);
    expect(savedInputPlan("bt", [], { remove: true }).cleared).toBe(false);
  });

  it("a missing id in a real list keeps the choice and re-selects it when it returns", () => {
    const gone = savedInputPlan("bt", [{ id: "built-in" }]);
    expect(gone).toMatchObject({ cleared: false, deviceId: null, restore: "bt" });
    const back = savedInputPlan("bt", [{ id: "built-in" }, { id: "bt" }]);
    expect(back).toMatchObject({ cleared: false, deviceId: "bt", restore: null });
  });

  it("clears only on an explicit removal against a permitted, non-empty list", () => {
    expect(
      savedInputPlan("bt", [{ id: "a" }], { enumerated: true, permitted: true, remove: true })
        .cleared,
    ).toBe(true);
    expect(savedInputPlan("bt", [{ id: "a" }], { permitted: false, remove: true }).cleared).toBe(
      false,
    );
  });

  it("the Settings picker and the planner agree on a missing device", () => {
    const rows = deviceOptions("microphone", "bt", [{ id: "a", label: "A" }]);
    expect(rows.at(-1)).toMatchObject({ value: "bt", missing: true });
    expect(planSavedDevice("microphone", "bt", [{ id: "a", label: "A" }]).deviceId).toBe("");
    expect(savedInputPlan("bt", [{ id: "a" }]).restore).toBe("bt");
  });

  it("an unknown list gives the device plan a not-available note, not 'not connected'", () => {
    const plan = planSavedDevice("microphone", "bt", [], { enumerated: false });
    expect(plan.note).toMatch(/not available yet/);
    expect(plan.note).toMatch(/choice is kept/);
    expect(planSavedDevice("microphone", "bt", [], { permitted: false }).note).toMatch(
      /not available yet/,
    );
    expect(planSavedDevice("microphone", "bt", [{ id: "a", label: "A" }]).note).toMatch(
      /not connected/,
    );
  });
});

describe("microphone list issue", () => {
  it("permission never granted says Permission needed", () => {
    const issue = micListIssue([{ id: "default", label: "" }], { permitted: false });
    expect(issue.kind).toBe("permission");
    expect(issue.text).toMatch(/^Permission needed/);
    expect(issue.text).toMatch(/Retry/);
  });

  it("no input when permitted says none, a normal list says nothing", () => {
    expect(micListIssue([], { permitted: true }).kind).toBe("none");
    expect(micListIssue([{ id: "a", label: "A" }], { permitted: true }).kind).toBeNull();
  });
});

describe("sample-rate change (S4)", () => {
  it("fires when the track or the context rate moves", () => {
    expect(captureRateChanged({ ctx: 48000, track: 48000 }, { ctx: 48000, track: 16000 })).toBe(
      true,
    );
    expect(captureRateChanged({ ctx: 48000, track: null }, { ctx: 16000, track: null })).toBe(true);
  });

  it("stays quiet when nothing moved or a rate is unknown", () => {
    expect(captureRateChanged({ ctx: 48000, track: 48000 }, { ctx: 48000, track: 48000 })).toBe(
      false,
    );
    expect(captureRateChanged({ ctx: 48000, track: null }, { ctx: 48000, track: 16000 })).toBe(
      false,
    );
    expect(captureRateChanged({ ctx: null, track: null }, { ctx: null, track: null })).toBe(false);
  });
});

describe("plain fault lines (S11)", () => {
  it("maps the dependency jargon to one short sentence and drops the package text", () => {
    const raw = "dependency-incompatible: av with faster-whisper requires av>=17.0.0,<19 from PyPI";
    const line = plainFaultLine(raw, "en");
    expect(line).toBe("A voice part needs a repair. Open Doctor and press Repair.");
    expect(line).not.toMatch(/PyPI|faster-whisper|av>=/);
  });

  it("maps a permission fault in English, Hindi and Hinglish", () => {
    const raw = "microphone: permission required";
    expect(plainFaultLine(raw, "en")).toMatch(/blocked/);
    expect(plainFaultLine(raw, "hi")).toMatch(/[ऀ-ॿ]/);
    expect(plainFaultLine(raw, "hinglish")).toMatch(/Microphone blocked hai/);
  });

  it("maps a no-frames and a no-microphone fault", () => {
    expect(plainFaultLine("No audio frames arrived. Reopening the microphone.", "en")).toMatch(
      /quiet or busy/,
    );
    expect(plainFaultLine("no-microphone", "en")).toMatch(/Plug one in/);
  });

  it("leaves an unknown or already plain line unchanged and handles empty", () => {
    expect(plainFaultLine("Listening.", "en")).toBe("Listening.");
    expect(plainFaultLine("", "en")).toBe("");
    expect(plainFaultLine(null, "en")).toBe("");
    expect(plainFaultLine("माइक्रोफ़ोन तैयार है", "en")).toBe("माइक्रोफ़ोन तैयार है");
  });

  it("picks the pool from the reply language settings", () => {
    expect(faultLanguage({ hinglish: true, speechLang: "en-IN" })).toBe("hinglish");
    expect(faultLanguage({ hinglish: false, speechLang: "hi-IN" })).toBe("hi");
    expect(faultLanguage({ hinglish: false, speechLang: "English" })).toBe("en");
    expect(faultLanguage({})).toBe("en");
  });
});
