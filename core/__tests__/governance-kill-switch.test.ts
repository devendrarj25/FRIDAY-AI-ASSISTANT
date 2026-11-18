/**
 * Stop everything must outrank an approval that was given before it.
 *
 * Found by reading `governance.submit`: the kill switch was read once, at the start, and then the item waited for
 * the owner (minutes or hours). If the owner pressed Stop everything during that wait and later approved the
 * item, `apply()` still ran: an item reached `completed` with `halted` true. Fourteen callers file their work
 * through this one gate (agents, the dev pipeline, the forges, connectors, import, fine-tuning), so the gate is
 * where it is fixed. These tests use the real governance queue and the real autonomy switch, and one of them
 * runs the real downloads-cleanup agent on a scratch folder, so the check is on a real file, not a mock.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { autonomy } from "../../src/lib/friday/self/autonomy";
import { governance, type GovAction } from "../../src/lib/friday/self/governance";
import {
  reviewEnabledAgents,
  type AgentSchedulerHost,
} from "../../src/lib/friday/self/agent-scheduler";

const require_ = createRequire(import.meta.url);
const cleanup = require_(
  path.resolve(__dirname, "../../agents/core/downloads-cleanup/index.cjs"),
) as {
  plan: (input?: Record<string, unknown>) => {
    ok: boolean;
    actionable?: boolean;
    candidates?: { path: string; name: string }[];
  };
  run: (input?: Record<string, unknown>) => Promise<{ ok: boolean; deleted?: string[] }>;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function file(id: string, apply: GovAction["apply"]): GovAction & { id: string } {
  return { id, kind: "system", title: `Agent — ${id}`, rationale: "test", risk: "review", apply };
}

beforeEach(() => {
  governance.resetForTests();
  autonomy.reset();
});

afterEach(() => {
  governance.resetForTests();
  autonomy.reset();
});

describe("an approval given before Stop everything is not used after it", () => {
  it("does not apply an item that was waiting when the switch was thrown", async () => {
    let applied = 0;
    const settled = governance.submit(
      file("wait-then-halt", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    await waitFor(() => governance.get("wait-then-halt")?.stage === "waiting-approval", "waiting");
    autonomy.stopEverything();

    governance.approve("wait-then-halt");
    const item = await settled;

    expect(applied).toBe(0);
    expect(item.stage).toBe("failed");
    expect(item.error).toBe("Stopped.");
    expect(item.logs.some((row) => /stop everything is on/.test(row.line))).toBe(true);
    expect(item.logs.some((row) => row.line === "completed")).toBe(false);
    expect(autonomy.getSnapshot().halted).toBe(true);
  });

  it("holds for every approval path: a spoken or panel yes goes through the same decide()", async () => {
    let applied = 0;
    const settled = governance.submit(
      file("decide-path", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    await waitFor(() => governance.get("decide-path")?.stage === "waiting-approval", "waiting");
    autonomy.stopEverything();
    governance.decide("decide-path", true);
    expect((await settled).stage).toBe("failed");
    expect(applied).toBe(0);
  });

  it("does not apply when the switch is thrown during the dry run, even under Full autonomy", async () => {
    autonomy.update({ approvalLevel: "full" });
    let applied = 0;
    const settled = governance.submit({
      ...file("halt-in-dry-run", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
      dryRun: async () => {
        autonomy.stopEverything();
        return { ok: true, detail: "looked fine" };
      },
    });
    // Full would have auto-approved; the halt turns that into a wait, and a late yes is still refused.
    await waitFor(() => governance.get("halt-in-dry-run")?.stage === "waiting-approval", "waiting");
    governance.approve("halt-in-dry-run");
    const item = await settled;
    expect(applied).toBe(0);
    expect(item.stage).toBe("failed");
    expect(item.error).toBe("Stopped.");
  });

  it("still refuses an item filed while the switch is already on", async () => {
    autonomy.stopEverything();
    let applied = 0;
    const item = await governance.submit(
      file("filed-while-halted", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    expect(applied).toBe(0);
    expect(item.error).toBe("Stopped.");
  });

  it("a rejection while halted is a rejection, and apply is not called", async () => {
    let applied = 0;
    const settled = governance.submit(
      file("reject-halted", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    await waitFor(() => governance.get("reject-halted")?.stage === "waiting-approval", "waiting");
    autonomy.stopEverything();
    governance.reject("reject-halted");
    expect((await settled).stage).toBe("rejected");
    expect(applied).toBe(0);
  });
});

describe("the fix does not make approval harder than it was", () => {
  it("applies an approved item when the switch was never thrown", async () => {
    let applied = 0;
    const settled = governance.submit(
      file("normal", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    await waitFor(() => governance.get("normal")?.stage === "waiting-approval", "waiting");
    governance.approve("normal");
    const item = await settled;
    expect(applied).toBe(1);
    expect(item.stage).toBe("completed");
  });

  it("an approval given after the owner resumed is a fresh decision and is used", async () => {
    let applied = 0;
    const settled = governance.submit(
      file("resumed", async () => {
        applied += 1;
        return { ok: true, detail: "done" };
      }),
    );
    await waitFor(() => governance.get("resumed")?.stage === "waiting-approval", "waiting");
    autonomy.stopEverything();
    autonomy.resume();
    governance.approve("resumed");
    expect((await settled).stage).toBe("completed");
    expect(applied).toBe(1);
  });

  it("only the item approved while halted is refused; another approved after resume still runs", async () => {
    const ran: string[] = [];
    const a = governance.submit(
      file("first", async () => {
        ran.push("first");
        return { ok: true, detail: "ok" };
      }),
    );
    const b = governance.submit(
      file("second", async () => {
        ran.push("second");
        return { ok: true, detail: "ok" };
      }),
    );
    await waitFor(() => governance.pending().length === 2, "two waiting");
    autonomy.stopEverything();
    governance.approve("first");
    expect((await a).stage).toBe("failed");
    autonomy.resume();
    governance.approve("second");
    expect((await b).stage).toBe("completed");
    expect(ran).toEqual(["second"]);
  });

  it("exec-tier work is still never approved automatically at any dial except Full, and not while halted", () => {
    for (const level of ["strict", "balanced", "trusted"] as const) {
      autonomy.update({ approvalLevel: level });
      expect(governance.autoApproves("risky", "system"), level).toBe(false);
    }
    autonomy.update({ approvalLevel: "full" });
    autonomy.stopEverything();
    expect(governance.autoApproves("risky", "system")).toBe(false);
  });

  it("the shipped config keeps automation.auto_approve_exec false", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "../../config/kernel.yaml"), "utf8");
    expect(text).toMatch(/auto_approve_exec:\s*false/);
  });
});

describe("the real agent path: a file is not deleted after Stop everything", () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function scratchWithOldFile(): { dir: string; stale: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-kill-switch-"));
    folders.push(dir);
    const stale = path.join(dir, "old.bin");
    fs.writeFileSync(stale, "x");
    const past = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(stale, past, past);
    return { dir, stale };
  }

  function realHost(dir: string, runs: string[]): AgentSchedulerHost {
    return {
      listEnabledAgents: async () => [
        {
          id: "core/downloads-cleanup",
          name: "Downloads cleanup",
          category: "files",
          risk: "write",
          enabled: true,
          approvalPrompt: "Delete {count} old file(s) in {folder}?",
        },
      ],
      planAgent: async (_id, input) => {
        const value = cleanup.plan(input);
        return { ok: value.ok, value };
      },
      runAgent: async (_id, input) => {
        runs.push(JSON.stringify(input));
        const value = await cleanup.run(input);
        return { ok: value.ok, value };
      },
      getItem: (id) => governance.get(id),
      discover: (input) => governance.discover(input),
      submit: (action) => governance.submit(action),
      inputFor: () => ({ folder: dir, olderThanDays: 1 }),
    };
  }

  it("control: an approved cleanup deletes the stale file when nothing was stopped", async () => {
    const { dir, stale } = scratchWithOldFile();
    const runs: string[] = [];
    expect(await reviewEnabledAgents(realHost(dir, runs))).toBe(1);
    await waitFor(() => governance.pending().length === 1, "the cleanup waiting for approval");
    expect(fs.existsSync(stale)).toBe(true);
    const id = governance.pending()[0]?.id as string;
    governance.approve(id);
    await waitFor(() => governance.get(id)?.stage === "completed", "completed");
    expect(runs).toHaveLength(1);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("Stop everything after the plan and before the yes: the file stays and the agent never runs", async () => {
    const { dir, stale } = scratchWithOldFile();
    const runs: string[] = [];
    expect(await reviewEnabledAgents(realHost(dir, runs))).toBe(1);
    await waitFor(() => governance.pending().length === 1, "the cleanup waiting for approval");
    const id = governance.pending()[0]?.id as string;

    autonomy.stopEverything();
    governance.approve(id);
    await waitFor(() => governance.get(id)?.stage === "failed", "failed");

    expect(runs).toEqual([]);
    expect(fs.existsSync(stale)).toBe(true);
    expect(governance.get(id)?.error).toBe("Stopped.");
  });
});
