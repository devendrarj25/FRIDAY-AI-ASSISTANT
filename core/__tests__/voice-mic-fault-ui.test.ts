import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  backoffLine,
  micFaultPanelModel,
  micLiveText,
  micPanelState,
  OPEN_PRIVACY_LABEL,
  showBluetoothNotice,
} from "../../src/components/friday/mic-fault-panel-model";
import {
  accessFault,
  busyFault,
  faultView,
  MIC_PRIVACY_LINK,
} from "../../src/lib/friday/mic-faults";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

const denied = faultView({ state: "permission-denied", reason: "Microphone access is off." });
const unplugged = faultView({ state: "no-microphone", reason: "No microphone found." });
const ended = faultView({ state: "device-offline", reason: "The microphone stopped." });
const broken = faultView({ state: "device-error", reason: "The microphone could not start." });

describe("micFaultPanelModel", () => {
  it("shows nothing without a fault or a Windows block", () => {
    expect(micFaultPanelModel(null, null)).toBeNull();
    expect(micFaultPanelModel(null, "granted")).toBeNull();
    expect(micFaultPanelModel(null, "unknown")).toBeNull();
  });
  it("denied: message, privacy button, Retry", () => {
    const m = micFaultPanelModel(denied, null);
    expect(m).toMatchObject({ kind: "denied", showSettings: true, retry: true });
    expect(m?.message).toBe("Microphone access is off.");
  });
  it("Windows restricted and denied answers show the privacy button without a gate fault", () => {
    for (const s of ["denied", "restricted"]) {
      expect(micFaultPanelModel(null, s)).toMatchObject({
        kind: "denied",
        showSettings: true,
        retry: true,
      });
    }
  });
  it("not-determined is its own kind with the privacy button", () => {
    expect(micFaultPanelModel(null, "not-determined")).toMatchObject({
      kind: "not-determined",
      showSettings: true,
      retry: true,
    });
  });
  it("the Windows privacy answer beats a device error", () => {
    expect(micFaultPanelModel(broken, "denied")?.kind).toBe("denied");
    expect(micFaultPanelModel(ended, "restricted")?.showSettings).toBe(true);
  });
  it("a granted answer keeps the gate's own fault and hides the privacy button", () => {
    const m = micFaultPanelModel(broken, "granted");
    expect(m).toMatchObject({ kind: "error", showSettings: false, retry: true });
    expect(m?.message).toBe(accessFault("granted")?.line ?? broken?.line);
  });
  it("an unknown answer keeps a denied gate fault", () => {
    expect(micFaultPanelModel(denied, "unknown")?.kind).toBe("denied");
  });
  it("busy: another app holds the microphone", () => {
    const m = micFaultPanelModel(busyFault("Zoom"), "granted");
    expect(m).toMatchObject({ kind: "busy", retry: true, showSettings: false });
    expect(m?.message).toContain("Zoom");
    expect(micFaultPanelModel(busyFault(), null)?.kind).toBe("busy");
  });
  it("busy shows no automatic retry wait", () => {
    expect(micFaultPanelModel(busyFault(), null, { autoRetry: true, attempt: 2 })?.backoff).toBe(
      "",
    );
  });
  it("ended device: re-acquiring with the next retry time", () => {
    const m = micFaultPanelModel(ended, "granted", { autoRetry: true, attempt: 0 });
    expect(m).toMatchObject({ kind: "reacquiring", backoff: "Trying again in 1 s" });
  });
  it("unplugged device: reports the wait while FRIDAY retries", () => {
    const m = micFaultPanelModel(unplugged, null, { autoRetry: true, attempt: 1 });
    expect(m).toMatchObject({ kind: "unavailable", backoff: "Trying again in 2 s" });
  });
  it("no wait is shown when FRIDAY is not retrying by herself", () => {
    expect(micFaultPanelModel(ended, null, { attempt: 3 })?.backoff).toBe("");
  });
  it("denied never shows a wait", () => {
    expect(micFaultPanelModel(denied, null, { autoRetry: true })?.backoff).toBe("");
  });
  it("the wait doubles to 8 s and stops there", () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffLine)).toEqual([
      "Trying again in 1 s",
      "Trying again in 2 s",
      "Trying again in 4 s",
      "Trying again in 8 s",
      "Trying again in 8 s",
      "Trying again in 8 s",
    ]);
  });
  it("a bad attempt count falls back to 1 s", () => {
    expect(backoffLine(-3)).toBe("Trying again in 1 s");
    expect(backoffLine(Number.NaN)).toBe("Trying again in 1 s");
  });
  it("an available gate state is not a fault", () => {
    expect(faultView({ state: "available", reason: "" })).toBeNull();
    expect(micFaultPanelModel(faultView({ state: "available", reason: "" }), null)).toBeNull();
  });
  it("device-error is a retryable error without a settings button", () => {
    expect(micFaultPanelModel(broken, null)).toMatchObject({
      kind: "error",
      retry: true,
      showSettings: false,
    });
  });
  it("the settings button carries the fixed label and link", () => {
    expect(OPEN_PRIVACY_LABEL).toBe("Open microphone privacy settings");
    expect(MIC_PRIVACY_LINK).toBe("ms-settings:privacy-microphone");
  });
});

describe("live text and page states", () => {
  it("announces the message and stays empty with no fault", () => {
    expect(micLiveText(micFaultPanelModel(denied, null))).toBe("Microphone access is off.");
    expect(micLiveText(null)).toBe("");
  });
  const model = micFaultPanelModel(denied, null);
  it("loading beats everything", () => {
    expect(micPanelState({ model, checking: true, online: false, checkError: "x" })).toEqual({
      page: "loading",
    });
  });
  it("an error carries its detail for Retry", () => {
    expect(micPanelState({ model, checking: false, online: true, checkError: "boom" })).toEqual({
      page: "error",
      detail: "boom",
    });
  });
  it("a fault shows even offline (the microphone is local)", () => {
    expect(micPanelState({ model, checking: false, online: false, checkError: "" }).page).toBe(
      "fault",
    );
  });
  it("offline with no fault shows the offline note, online shows nothing", () => {
    expect(micPanelState({ model: null, checking: false, online: false, checkError: "" })).toEqual({
      page: "offline",
    });
    expect(micPanelState({ model: null, checking: false, online: true, checkError: "" })).toEqual({
      page: "none",
    });
  });
});

describe("Bluetooth notice", () => {
  it("shows once per headset until dismissed", () => {
    expect(showBluetoothNotice("", "")).toBe(false);
    expect(showBluetoothNotice("thin sound", "")).toBe(true);
    expect(showBluetoothNotice("thin sound", "thin sound")).toBe(false);
    expect(showBluetoothNotice("thin sound", "other")).toBe(true);
  });
});

describe("source pins", () => {
  const bar = read("src/components/friday/VoiceControlBar.tsx");
  const auto = read("src/components/friday/AutoMode.tsx");
  it("buttons call the real handlers", () => {
    expect(bar).toMatch(/onClick=\{openPrivacy\}/);
    expect(bar).toMatch(/openMicPrivacySettings/);
    expect(bar).toMatch(/onClick=\{retry\}/);
    expect(bar).toMatch(/micAccessStatus/);
    expect(bar).toMatch(/setDismissed\(bluetooth\)/);
    expect(bar).toMatch(/voiceGate\.bluetoothNotice\(\)/);
  });
  it("the panel is mounted in Auto mode and Retry runs Fix voice", () => {
    expect(auto).toMatch(/<MicFaultPanel onRetry=\{\(\) => assistantMode\.fixVoice\(\)\} \/>/);
    expect((auto.match(/\{micPanel\}/g) ?? []).length).toBe(2);
  });
  it("one polite live region, 24 px targets and a visible focus ring", () => {
    expect(bar).toMatch(/aria-live="polite"/);
    expect(bar).toMatch(/PANEL_BUTTON/);
    expect(read("src/components/friday/ui.tsx")).toMatch(/PANEL_BUTTON =\s*"[^"]*h-6 min-w-6/);
    expect(bar).toMatch(/focus-visible:ring-1/);
  });
  it("a toggle keeps a stable label with aria-pressed, never both flipping", () => {
    expect(bar).toMatch(/\.\.\.\(flips \? \{\} : \{ "aria-pressed": active \}\)/);
  });
});
