/**
 * Load leases (electron/load-lease.cjs): the step every heavy model load takes before it starts. Each path runs the real
 * resource governor with injected memory readings: granted, shrunk to a smaller option, queued then granted, queued then
 * refused, refused outright, and the "no governor" and "governor failed" paths that must change nothing.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const leaseApi = require_("../../electron/load-lease.cjs") as {
  createLoadLeases: (options: Record<string, unknown>) => Leases;
  toOptions: (list: unknown) => Array<{ vramMb: number; ramMb: number; hint: unknown }>;
  refusalLine: (label: string, reason: string) => string;
  QUEUE_WAIT_MS: Record<string, number>;
  SLOT_WAIT_MS: Record<string, number>;
};
const gov = require_("../../electron/resource-governor.cjs") as {
  createResourceGovernor: (options: Record<string, unknown>) => Governor;
};

type Lease = { release: () => void; loaded: () => void };
type Governor = {
  status: () => {
    leases: Array<{ owner: string; kind: string; priority: string }>;
    queued: unknown[];
  };
  tick: () => Promise<void>;
};
type Taken = {
  state: string;
  lease: Lease | null;
  hint: unknown;
  shrunk: boolean;
  reason: string | null;
  line: string | null;
};
type Leases = {
  enabled: boolean;
  acquire: (spec: Record<string, unknown>) => Promise<Taken>;
  runLoad: <T>(
    priority: string,
    fn: () => Promise<T> | T,
    o?: { waitMs?: number },
  ) => Promise<{ ran: boolean; value?: T; reason?: string }>;
};

/** A governor with the memory this "PC" has right now; `mem` and `vram` can be changed between asks. */
function pc(
  mem: { freeMb: number; totalMb: number },
  vram: { freeMb: number; totalMb: number } | null = null,
  over: Record<string, unknown> = {},
) {
  const state = { mem, vram };
  const notify = vi.fn();
  const log = vi.fn();
  const governor = gov.createResourceGovernor({
    readMemory: () => state.mem,
    readVram: () => state.vram,
    log: () => undefined,
    ...over,
  });
  const leases = leaseApi.createLoadLeases({ governor, log, notify });
  return { state, notify, log, governor, leases };
}

const GB = 1024;

describe("options", () => {
  it("turns GB options into MB and drops the ones with no size", () => {
    expect(
      leaseApi.toOptions([
        { vramGb: 4, hint: null },
        { ramGb: 0.5, hint: "cpu" },
        { hint: "empty" },
        { vramGb: Number.NaN },
        null,
      ]),
    ).toEqual([
      { vramMb: 4096, ramMb: 0, hint: null },
      { vramMb: 0, ramMb: 512, hint: "cpu" },
    ]);
    expect(leaseApi.toOptions("nope")).toEqual([]);
  });

  it("words a refusal in plain language with the model's own name", () => {
    expect(leaseApi.refusalLine("Qwen 7B", "memory-critical")).toBe(
      "Qwen 7B was not loaded: memory is critically low.",
    );
    expect(leaseApi.refusalLine("Qwen 7B", "waited")).toContain("did not free up in time");
    expect(leaseApi.refusalLine("Qwen 7B", "something-new")).toContain("no room for it right now");
    expect(leaseApi.refusalLine("", "no-room")).toMatch(/^The model was not loaded/);
  });
});

describe("granted", () => {
  it("grants a model that fits, holds a lease under the caller's owner and priority, and frees it on release", async () => {
    const { leases, governor } = pc({ freeMb: 12 * GB, totalMb: 16 * GB });
    const taken = await leases.acquire({
      owner: "chat:llama3",
      kind: "llm",
      priority: "chat",
      label: "Llama 3",
      options: [{ ramGb: 5, hint: null }],
    });
    expect(taken).toMatchObject({ state: "granted", hint: null, shrunk: false, line: null });
    expect(governor.status().leases).toEqual([
      expect.objectContaining({ owner: "chat:llama3", kind: "llm", priority: "chat" }),
    ]);
    taken.lease?.release();
    expect(governor.status().leases).toHaveLength(0);
  });

  it("gives the Auto-mode turn the voice priority", async () => {
    const { leases, governor } = pc({ freeMb: 12 * GB, totalMb: 16 * GB });
    await leases.acquire({
      owner: "speech-worker",
      kind: "speech",
      priority: "voice",
      options: [{ ramGb: 0.8, hint: "small" }],
    });
    expect(governor.status().leases[0]).toMatchObject({ priority: "voice", kind: "speech" });
  });
});

describe("shrunk", () => {
  it("falls back to the CPU option (with its hint) when the video memory is too small", async () => {
    // 3 GB of a 4 GB card is free: a 5 GB model does not fit it, but 12 GB of RAM is free for the CPU plan.
    const { leases } = pc(
      { freeMb: 12 * GB, totalMb: 16 * GB },
      { freeMb: 3 * GB, totalMb: 4 * GB },
    );
    const taken = await leases.acquire({
      owner: "chat:big",
      kind: "llm",
      priority: "chat",
      options: [
        { vramGb: 5, hint: null },
        { ramGb: 5, hint: "cpu" },
      ],
    });
    expect(taken).toMatchObject({ state: "granted", hint: "cpu", shrunk: true });
  });

  it("on a 4 GB RAM PC the smaller speech size is the one that fits", async () => {
    const { leases, log } = pc({ freeMb: 2 * GB, totalMb: 4 * GB });
    const taken = await leases.acquire({
      owner: "speech-worker",
      kind: "speech",
      priority: "voice",
      options: [
        { ramGb: 0.8, hint: "small" },
        { ramGb: 0.4, hint: "base" },
        { ramGb: 0.3, hint: "tiny" },
      ],
    });
    // 2048 free - 1536 headroom = 512 MB: small (819 MB) does not fit, base (410 MB) does.
    expect(taken).toMatchObject({ state: "granted", hint: "base", shrunk: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fits only as "base"'));
  });
});

describe("queued", () => {
  it("waits a bounded time, and a grant that arrives inside it is honoured", async () => {
    const { leases, state, governor } = pc({ freeMb: 2 * GB, totalMb: 16 * GB });
    const pending = leases.acquire({
      owner: "chat:big",
      kind: "llm",
      priority: "chat",
      waitMs: 2000,
      options: [{ ramGb: 5, hint: null }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(governor.status().queued).toHaveLength(1);
    state.mem = { freeMb: 12 * GB, totalMb: 16 * GB };
    await governor.tick();
    await expect(pending).resolves.toMatchObject({ state: "granted" });
    expect(governor.status().queued).toHaveLength(0);
  });

  it("a request that waits too long is refused with a line, leaves the queue and never hangs the turn", async () => {
    const { leases, governor, notify } = pc({ freeMb: 2 * GB, totalMb: 16 * GB });
    const started = Date.now();
    const taken = await leases.acquire({
      owner: "chat:big",
      kind: "llm",
      priority: "chat",
      label: "Big model",
      waitMs: 40,
      options: [{ ramGb: 5, hint: null }],
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(taken).toMatchObject({ state: "refused", reason: "waited", lease: null });
    expect(taken.line).toBe("Big model was not loaded: memory did not free up in time.");
    expect(governor.status().queued).toHaveLength(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(taken.line);
  });
});

describe("refused", () => {
  it("refuses a heavy chat load at once while memory is critical, with one plain line", async () => {
    // 800 MB free of 16 GB is critical pressure.
    const { leases, notify, governor } = pc({ freeMb: 800, totalMb: 16 * GB });
    await governor.tick();
    const heavy = await leases.acquire({
      owner: "chat:big",
      kind: "llm",
      priority: "chat",
      label: "Big model",
      options: [{ ramGb: 5, hint: null }],
    });
    expect(heavy).toMatchObject({ state: "refused", reason: "memory-critical" });
    expect(heavy.line).toContain("memory is critically low");
    expect(notify).toHaveBeenCalledWith(heavy.line);
  });

  it("a prefetch that does not fit is refused at once (no queue) instead of waiting", async () => {
    const { leases, governor } = pc({ freeMb: 2 * GB, totalMb: 16 * GB });
    const taken = await leases.acquire({
      owner: "warm",
      kind: "llm",
      priority: "prefetch",
      options: [{ ramGb: 5, hint: null }],
    });
    expect(taken).toMatchObject({ state: "refused", reason: "no-room" });
    expect(governor.status().queued).toHaveLength(0);
  });
});

describe("none: the load behaves exactly as it did before", () => {
  it("has no effect without a governor", async () => {
    const leases = leaseApi.createLoadLeases({ governor: null });
    expect(leases.enabled).toBe(false);
    await expect(leases.acquire({ options: [{ ramGb: 5 }] })).resolves.toMatchObject({
      state: "none",
      lease: null,
    });
    await expect(leases.runLoad("chat", () => 7)).resolves.toEqual({ ran: true, value: 7 });
  });

  it("has no effect when nothing is sized (unknown model size) and never asks the governor", async () => {
    const acquire = vi.fn();
    const leases = leaseApi.createLoadLeases({ governor: { acquire } });
    await expect(leases.acquire({ options: [{ hint: "x" }] })).resolves.toMatchObject({
      state: "none",
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("swallows a failing governor and says so in the log", async () => {
    const log = vi.fn();
    const leases = leaseApi.createLoadLeases({
      governor: { acquire: () => Promise.reject(new Error("boom")) },
      log,
    });
    await expect(leases.acquire({ options: [{ ramGb: 2 }] })).resolves.toMatchObject({
      state: "none",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("a notify that throws does not stop the refusal", async () => {
    const { governor } = pc({ freeMb: 800, totalMb: 16 * GB });
    const leases = leaseApi.createLoadLeases({
      governor,
      notify: () => {
        throw new Error("no window");
      },
    });
    await expect(
      leases.acquire({ priority: "chat", options: [{ ramGb: 5 }] }),
    ).resolves.toMatchObject({ state: "refused" });
  });
});

describe("runLoad: the model-load slot", () => {
  it("runs the load in the slot and hands its value back", async () => {
    const { leases } = pc({ freeMb: 12 * GB, totalMb: 16 * GB });
    await expect(leases.runLoad("chat", async () => "loaded")).resolves.toEqual({
      ran: true,
      value: "loaded",
    });
  });

  it("gives up waiting for the slot (the turn goes on) and reports the queue as full", async () => {
    const { leases, log } = pc({ freeMb: 12 * GB, totalMb: 16 * GB }, null, {
      caps: { modelLoad: 1 },
      maxQueue: { modelLoad: 1 },
    });
    let finish: () => void = () => undefined;
    const first = leases.runLoad(
      "voice",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const waiter = leases.runLoad("chat", () => "second", { waitMs: 30 });
    await expect(waiter).resolves.toEqual({ ran: false, reason: "waited" });
    // The queue now has room again: a third waits (queue size 1), a fourth finds it full.
    const third = leases.runLoad("chat", () => "third", { waitMs: 200 });
    const fourth = await leases.runLoad("chat", () => "fourth", { waitMs: 10 });
    expect(fourth).toEqual({ ran: false, reason: "queue-full" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("QUEUE_FULL"));
    finish();
    await first;
    await expect(third).resolves.toEqual({ ran: true, value: "third" });
  });

  it("a load that has started is never abandoned and its own error passes through", async () => {
    const { leases } = pc({ freeMb: 12 * GB, totalMb: 16 * GB });
    await expect(
      leases.runLoad("chat", async () => {
        throw new Error("the engine refused");
      }),
    ).rejects.toThrow("the engine refused");
  });

  it("voice and chat wait less than background work would, and prefetch does not wait at all", () => {
    expect(leaseApi.SLOT_WAIT_MS["prefetch"]).toBe(0);
    expect(leaseApi.QUEUE_WAIT_MS["prefetch"]).toBe(0);
    expect(leaseApi.QUEUE_WAIT_MS["voice"]).toBeLessThanOrEqual(
      leaseApi.QUEUE_WAIT_MS["chat"] ?? 0,
    );
  });
});

describe("voice never waits long for a decision", () => {
  const hanging = (answer: unknown, ms = 3_000) => ({
    acquire: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(answer), ms))),
  });

  it("a governor that does not answer inside the bound gives 'none' and the speech model loads anyway", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      const governor = hanging({ state: "granted", lease: { release } });
      const leases = leaseApi.createLoadLeases({ governor, log: () => undefined });
      let taken: Taken | null = null;
      void leases
        .acquire({
          owner: "speech-worker",
          kind: "speech",
          priority: "voice",
          options: [{ ramGb: 1 }],
        })
        .then((t) => {
          taken = t;
        });
      await vi.advanceTimersByTimeAsync(350);
      expect((taken as Taken | null)?.state).toBe("none");
      expect((taken as Taken | null)?.line).toBeNull();
      // The grant that lands late is nobody's: it is handed back at once.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chat request keeps waiting for the governor (the bound is for voice only)", async () => {
    vi.useFakeTimers();
    try {
      const governor = hanging(
        { state: "granted", lease: { release: vi.fn(), hint: null } },
        1_000,
      );
      const leases = leaseApi.createLoadLeases({ governor, log: () => undefined });
      let taken: Taken | null = null;
      void leases
        .acquire({ owner: "chat:x", kind: "llm", priority: "chat", options: [{ ramGb: 1 }] })
        .then((t) => {
          taken = t;
        });
      await vi.advanceTimersByTimeAsync(500);
      expect(taken).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      expect((taken as Taken | null)?.state).toBe("granted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the governor's own 'none' answer means load as before", async () => {
    const governor = { acquire: vi.fn(async () => ({ state: "none", reason: "voice-bound" })) };
    const leases = leaseApi.createLoadLeases({ governor, log: () => undefined });
    const taken = await leases.acquire({
      owner: "speech-worker",
      kind: "speech",
      priority: "voice",
      options: [{ ramGb: 1 }],
    });
    expect(taken.state).toBe("none");
    expect(taken.line).toBeNull();
  });

  it("voice waits at most the bound in the queue and for the load slot", () => {
    expect(leaseApi.QUEUE_WAIT_MS["voice"]).toBeLessThanOrEqual(300);
    expect(leaseApi.SLOT_WAIT_MS["voice"]).toBeLessThanOrEqual(300);
  });
});
