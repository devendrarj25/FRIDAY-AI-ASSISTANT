/**
 * A spoken yes bound to the read-back command skips the second on-screen approval exactly once. A token for a
 * different command, an expired token, a used token or a halted app approves nothing. A spoken run's pending
 * approval expires with `voice.approvalTtlSec`; typed chat keeps waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
globals.friday = { isDesktop: true, sendChat: () => "x", abortChat: () => undefined };

const { brain, commandDigest } = await import("../../src/lib/friday/brain-engine");
const { autonomy } = await import("../../src/lib/friday/self/autonomy");
const { preferences } = await import("../../src/lib/friday/preferences");
const { setActionMode } = await import("../../src/lib/friday/brain/action-risk");

type Run = { id: string; prompt: string; state: string; agents: unknown[] };
type Inner = {
  state: Record<string, unknown> & { runs: Run[]; activeRunId: string | null; approval: unknown };
  voiceRuns: Set<string>;
  preApprovalOf: Map<string, string>;
  gateAction: (run: Run, tool: string, risk: string, label: string) => Promise<boolean>;
  startRun: (text: string, options: Record<string, unknown>) => void;
};
const inner = brain as unknown as Inner;

const COMMAND = "delete the build folder on the desktop";
let seq = 0;
const makeRun = (prompt = COMMAND, voice = true): Run => {
  const run: Run = { id: `run-test-${(seq += 1)}`, prompt, state: "running", agents: [] };
  inner.state.runs = [run];
  inner.state.activeRunId = run.id;
  if (voice) inner.voiceRuns.add(run.id);
  return run;
};
const gate = (run: Run) => inner.gateAction(run, "fs_delete", "exec", "delete the build folder");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  autonomy.reset();
  setActionMode("auto");
  inner.state.approval = null;
  inner.preApprovalOf.clear();
});
afterEach(() => {
  vi.useRealTimers();
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("commandDigest", () => {
  it("is stable across case and spacing, and differs for a different command", () => {
    expect(commandDigest("Delete  the build folder")).toBe(
      commandDigest("delete the build folder"),
    );
    expect(commandDigest("delete the build folder")).not.toBe(
      commandDigest("delete the data folder"),
    );
    expect(commandDigest("delete the build folder")).toMatch(/^[0-9a-f]{12,}$/);
  });
});

describe("gateAction with a pre-approval token", () => {
  it("waits for the screen when there is no token", async () => {
    const run = makeRun();
    const pending = gate(run);
    expect(run.state).toBe("awaiting-approval");
    expect(inner.state.approval).not.toBeNull();
    brain.approve(true);
    await expect(pending).resolves.toBe(true);
  });

  it("lets the bound token approve once, then asks again", async () => {
    const run = makeRun();
    const token = brain.preApprove(COMMAND);
    expect(token).toBeTruthy();
    inner.preApprovalOf.set(run.id, token!);
    await expect(gate(run)).resolves.toBe(true);
    expect(run.state).not.toBe("awaiting-approval");
    expect(inner.state.approval).toBeNull();
    // single use
    const second = gate(run);
    expect(run.state).toBe("awaiting-approval");
    brain.approve(false);
    await expect(second).resolves.toBe(false);
  });

  it("ignores a token minted for a different command", async () => {
    const run = makeRun();
    inner.preApprovalOf.set(run.id, brain.preApprove("delete the data folder")!);
    const pending = gate(run);
    expect(run.state).toBe("awaiting-approval");
    brain.approve(false);
    await expect(pending).resolves.toBe(false);
  });

  it("ignores an expired token (voice.approvalTtlSec)", async () => {
    const run = makeRun();
    const ttl = preferences.getSnapshot().voice.approvalTtlSec;
    inner.preApprovalOf.set(run.id, brain.preApprove(COMMAND)!);
    vi.advanceTimersByTime(ttl * 1000 + 1);
    const pending = gate(run);
    expect(run.state).toBe("awaiting-approval");
    brain.approve(false);
    await expect(pending).resolves.toBe(false);
  });

  it("approves nothing while everything is stopped", async () => {
    const run = makeRun();
    inner.preApprovalOf.set(run.id, brain.preApprove(COMMAND)!);
    autonomy.stopEverything();
    const pending = gate(run);
    expect(run.state).toBe("awaiting-approval");
    brain.approve(false);
    await expect(pending).resolves.toBe(false);
  });

  it("is carried from send() to the run", () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(inner, "startRun").mockImplementation((_text, options) => {
      calls.push(options);
    });
    inner.state.activeRunId = null;
    brain.send(COMMAND, { routingSurface: "voice", preApproval: "tok-1" });
    expect(calls[0]?.["preApproval"]).toBe("tok-1");
  });
});

describe("a pending approval", () => {
  it("expires for a spoken run after voice.approvalTtlSec and says so", async () => {
    const run = makeRun(COMMAND, true);
    const ttl = preferences.getSnapshot().voice.approvalTtlSec;
    const pending = gate(run);
    expect(brain.isAwaitingApproval()).toBe(true);
    vi.advanceTimersByTime(ttl * 1000 - 1);
    expect(inner.state.approval).not.toBeNull();
    vi.advanceTimersByTime(2);
    await expect(pending).resolves.toBe(false);
    expect(inner.state.approval).toBeNull();
    expect(brain.isAwaitingApproval()).toBe(false);
  });

  it("keeps waiting for a typed run", async () => {
    const run = makeRun(COMMAND, false);
    const pending = gate(run);
    vi.advanceTimersByTime(10 * 60_000);
    expect(inner.state.approval).not.toBeNull();
    brain.approve(true);
    await expect(pending).resolves.toBe(true);
  });

  it("is exposed as run.state awaiting-approval for the busy reply", () => {
    const run = makeRun();
    expect(brain.isAwaitingApproval()).toBe(false);
    void gate(run);
    expect(run.state).toBe("awaiting-approval");
    expect(brain.isAwaitingApproval()).toBe(true);
    brain.approve(false);
  });
});
