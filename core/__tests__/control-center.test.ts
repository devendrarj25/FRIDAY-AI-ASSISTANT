import { describe, expect, it } from "vitest";
import {
  controlNotes,
  controlRows,
  noteReceipt,
  noteSense,
  panicPlan,
} from "../../src/lib/friday/control-center";
import { SENSE_IDS, SENSE_TOGGLE } from "../../src/lib/friday/senses";

describe("owner control center", () => {
  it("lists every sense, listener, and recorder as off until the owner turns it on", () => {
    const rows = controlRows({
      halted: false,
      level: "balanced",
      listening: false,
      handsFree: false,
      screenOn: false,
      cameraOn: false,
      consent: false,
      lastEventAt: null,
      lastReceipt: "",
    });
    for (const id of SENSE_IDS) {
      expect(rows.find((row) => row.id === `sense:${id}`)?.on).toBe(false);
    }
    expect(rows.find((row) => row.id === "listener:mic")?.on).toBe(false);
    expect(rows.find((row) => row.id === "listener:hands-free")?.detail).toMatch(/wake word/);
    expect(rows.find((row) => row.id === "recorder:screen")?.on).toBe(false);
    expect(rows.find((row) => row.id === "recorder:camera")?.on).toBe(false);
    expect(rows.find((row) => row.id === "recorder:watch")?.on).toBe(false);
    expect(rows.find((row) => row.id === "autonomy:dial")?.detail).toContain("Balanced");
  });

  it("shows the last event and redacts the last receipt", () => {
    const rows = controlRows({
      toggles: { senseForeground: true },
      halted: true,
      level: "full",
      listening: true,
      handsFree: true,
      screenOn: true,
      cameraOn: false,
      consent: true,
      lastEventAt: 1_700,
      lastReceipt: "token: abcdef saved",
    });
    expect(rows.find((row) => row.id === "sense:foreground")?.on).toBe(true);
    expect(rows.find((row) => row.id === "sense:foreground")?.detail).toBe("last event 1700");
    expect(rows.find((row) => row.id === "autonomy:dial")?.on).toBe(false);
    expect(rows.find((row) => row.id === "autonomy:dial")?.detail).toContain("Stop everything");
    const open = controlRows({
      halted: false,
      level: "full",
      listening: false,
      handsFree: false,
      screenOn: false,
      cameraOn: false,
      consent: false,
      lastEventAt: null,
      lastReceipt: "token: abcdef saved",
    });
    expect(open.find((row) => row.id === "autonomy:dial")?.detail).toContain("[redacted]");
    expect(open.find((row) => row.id === "autonomy:dial")?.detail).not.toContain("abcdef");
  });

  it("panic turns every sense off and stops everything", () => {
    const plan = panicPlan();
    expect(plan.halt).toBe(true);
    expect(plan.handsFree).toBe(false);
    for (const id of SENSE_IDS) expect(plan.toggles[SENSE_TOGGLE[id]]).toBe(false);
  });

  it("keeps the last sense time on this page", () => {
    noteSense(42);
    noteReceipt("token: secret-value");
    expect(controlNotes().senseAt).toBe(42);
    expect(controlNotes().receipt).toContain("[redacted]");
    expect(controlNotes().receipt).not.toContain("secret-value");
  });
});
