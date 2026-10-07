import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseRecovery } from "../../src/lib/friday/brain/self-diagnosis";
import { doctor } from "../../src/lib/friday/doctor-engine";
import { desktopUiaChecks } from "../../src/lib/friday/doctor-engine";
import {
  classifyFailure,
  idleWithin,
  offlineFlows,
  recoverFailure,
  repairWaveCapability,
  startupWithin,
  waveCapabilityChecks,
} from "../../src/lib/friday/failure-guard";
import { preferences } from "../../src/lib/friday/preferences";
import { SENSE_IDS, SENSE_TOGGLE } from "../../src/lib/friday/senses";
import { APPROVAL_TTL_MS, approvalFresh } from "../../src/lib/friday/voice-session";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stateStore = require("../../electron/state-store.cjs") as {
  commitState: (
    file: string,
    value: unknown,
    opts: { now: number; fail?: "disk-full" | "permission-denied" | "interrupt" },
  ) => { ok: boolean; restored: boolean; reason: string | null; backup: string | null };
  readState: (file: string) => unknown;
  restoreState: (file: string) => { ok: boolean; body?: unknown; reason?: string };
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-failure-"));
  roots.push(root);
  return path.join(root, name);
}

describe("failure injection", () => {
  it("classifies each fault and recovers without a second try loop", () => {
    expect(classifyFailure("kernel crash")).toBe("kernel-crash");
    expect(recoverFailure("kernel-crash").action).toBe("resume");
    expect(classifyFailure("HTTP 429 provider outage")).toBe("provider-outage");
    expect(recoverFailure("provider-outage", 0).action).toBe("retry");
    expect(recoverFailure("provider-outage", 2).action).toBe("fallback");
    expect(chooseRecovery({ failure: "HTTP 429", attempts: 0 }).kind).toBe("retry");
    expect(chooseRecovery({ failure: "HTTP 429", attempts: 2 }).kind).toBe("fallback");
    expect(recoverFailure(classifyFailure("ENOSPC disk full")).action).toBe("stop");
    expect(recoverFailure(classifyFailure("EACCES permission denied")).action).toBe("stop");
    expect(recoverFailure(classifyFailure("clock jump")).action).toBe("expire");
    expect(recoverFailure(classifyFailure("malformed json")).action).toBe("restore");
    expect(recoverFailure(classifyFailure("interrupted write")).action).toBe("restore");
  });

  it("expires a spoken yes when the clock jumps", () => {
    const asked = 1_000_000;
    expect(approvalFresh(asked, asked + APPROVAL_TTL_MS)).toBe(true);
    expect(approvalFresh(asked, asked + APPROVAL_TTL_MS + 1)).toBe(false);
    expect(approvalFresh(asked, asked - 50)).toBe(false);
  });

  it("keeps the previous file when a migration cannot finish", () => {
    const file = scratch("state.json");
    const original = { version: 1, note: "keep" };
    fs.writeFileSync(file, JSON.stringify(original));
    const full = stateStore.commitState(
      file,
      { version: 2, note: "keep" },
      { now: 10, fail: "disk-full" },
    );
    expect(full.ok).toBe(false);
    expect(full.reason).toBe("disk-full");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
    const denied = stateStore.commitState(
      file,
      { version: 2, note: "keep" },
      { now: 11, fail: "permission-denied" },
    );
    expect(denied.reason).toBe("permission-denied");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).note).toBe("keep");
    const cut = stateStore.commitState(
      file,
      { version: 2, note: "next" },
      { now: 12, fail: "interrupt" },
    );
    expect(cut.reason).toBe("interrupted-write");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(1);
    const done = stateStore.commitState(file, { version: 2, note: "next" }, { now: 13 });
    expect(done.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 2, note: "next" });
    fs.writeFileSync(file, "{");
    expect(stateStore.readState(file)).toEqual({ version: 1, note: "keep" });
  });

  it("measures startup and idle from an injected clock", () => {
    expect(startupWithin(0, 1_000).ok).toBe(true);
    expect(startupWithin(0, 9_000).ok).toBe(false);
    expect(startupWithin(5_000, 4_000).ok).toBe(false);
    expect(idleWithin([0.2, 0.4]).ok).toBe(true);
    expect(idleWithin([0.2, 1.5]).ok).toBe(false);
  });

  it("keeps chat, tasks, memory, and a local model while offline", () => {
    const quiet = offlineFlows({ online: false, hasLocalModel: true });
    expect(quiet.chat).toBe(true);
    expect(quiet.tasks).toBe(true);
    expect(quiet.memory).toBe(true);
    expect(quiet.localModel).toBe(true);
    expect(quiet.cloud).toBe(false);
    expect(offlineFlows({ online: false, hasLocalModel: false }).localModel).toBe(false);
  });

  it("repairs senses, consent, and the playbook flag, and leaves the owner the rest", () => {
    const off = waveCapabilityChecks();
    expect(off.find((row) => row.id === "sense:watching")?.status).toBe("Ready");
    expect(off.find((row) => row.id === "speaker:ecapa")?.status).toBe("Missing");
    expect(off.find((row) => row.id === "browser:page")?.fixable).toBe(false);
    const on = waveCapabilityChecks({
      toggles: { senseForeground: true },
      consent: true,
      playbookEnabled: true,
    });
    expect(on.find((row) => row.id === "sense:watching")?.fixable).toBe(true);
    const senses = repairWaveCapability("sense:watching");
    expect(senses.ok).toBe(true);
    for (const id of SENSE_IDS) expect(senses.patch[SENSE_TOGGLE[id]]).toBe(false);
    const watch = repairWaveCapability("watch:learn", {
      consent: true,
      steps: [{ kind: "type", target: "box", payload: "token: abcdef" }],
    });
    expect(watch.session?.consent).toBe(false);
    expect(watch.session?.steps).toEqual([]);
    expect(repairWaveCapability("playbook:daily").playbookEnabled).toBe(false);
    expect(repairWaveCapability("browser:page").kind).toBe("needs-owner");
    expect(repairWaveCapability("speaker:ecapa").kind).toBe("needs-owner");
    expect(desktopUiaChecks()[0]?.fixable).toBe(false);
  });

  it("turns the sense switches off from the doctor repair", async () => {
    preferences.setToggle("senseForeground", true);
    doctor.state.checks = waveCapabilityChecks({ toggles: { senseForeground: true } });
    const ok = await doctor.fix("sense:watching");
    expect(ok).toBe(true);
    expect(preferences.getSnapshot().toggles["senseForeground"]).toBe(false);
    expect(doctor.state.checks.find((row) => row.id === "sense:watching")?.status).toBe("Ready");
    preferences.setToggle("senseForeground", false);
  });
});
