/**
 * Stop everything reaches the brain. Before this, the voice and Settings called autonomy.stopEverything() but the
 * brain was not a stop participant: a run waiting on an exec approval kept its pending action, and a later Approve
 * tap ran the tool. Now the brain registers as a stop participant (stop the run, deny the pending action), and
 * approve() denies while the app is halted whatever the tap says. No kernel, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const globals = globalThis as unknown as { window?: unknown; friday?: unknown };
globals.window ??= globalThis;
for (const name of ["addEventListener", "removeEventListener"] as const) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= () => undefined;
}
globals.friday = { isDesktop: true, sendChat: () => "x", abortChat: () => undefined };

const { brain } = await import("../../src/lib/friday/brain-engine");
const { autonomy } = await import("../../src/lib/friday/self/autonomy");
const { setActionMode } = await import("../../src/lib/friday/brain/action-risk");

type Run = { id: string; prompt: string; state: string; agents: unknown[] };
type Inner = {
  state: Record<string, unknown> & { runs: Run[]; activeRunId: string | null; approval: unknown };
  gateAction: (run: Run, tool: string, risk: string, label: string) => Promise<boolean>;
};
const inner = brain as unknown as Inner;

let seq = 0;
const makeRun = (): Run => {
  const run: Run = {
    id: `run-halt-${(seq += 1)}`,
    prompt: "delete the build folder",
    state: "running",
    agents: [],
  };
  inner.state.runs = [run];
  inner.state.activeRunId = run.id;
  return run;
};
const gate = (run: Run) => inner.gateAction(run, "fs_delete", "exec", "delete the build folder");
const settle = async (pending: Promise<boolean>) =>
  Promise.race([
    pending,
    new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 20)),
  ]);

beforeEach(() => {
  autonomy.reset();
  setActionMode("auto");
  inner.state.approval = null;
});
afterEach(() => {
  autonomy.reset();
  vi.restoreAllMocks();
});

describe("brain and Stop everything", () => {
  it("denies the pending approval when Stop everything runs", async () => {
    const run = makeRun();
    const pending = gate(run);
    expect(inner.state.approval).not.toBeNull();
    void autonomy.stopEverything();
    expect(await settle(pending)).toBe(false);
    expect(inner.state.approval).toBeNull();
  });

  it("a later Approve tap after Stop everything runs nothing", async () => {
    const run = makeRun();
    const pending = gate(run);
    void autonomy.stopEverything();
    brain.approve(true);
    expect(await settle(pending)).toBe(false);
  });

  it("approve(true) while halted denies even when the approval is still pending", async () => {
    const run = makeRun();
    const pending = gate(run);
    // Halted by a path that did not fan out (the persisted flag came back from disk).
    autonomy.update({ halted: true });
    brain.approve(true);
    expect(await settle(pending)).toBe(false);
  });

  it("approve(true) still allows when the app is not halted", async () => {
    const run = makeRun();
    const pending = gate(run);
    brain.approve(true);
    expect(await settle(pending)).toBe(true);
  });
});
