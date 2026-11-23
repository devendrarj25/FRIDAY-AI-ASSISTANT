import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const SOURCE = path.join(__dirname, "..", "..", "electron", "resource-governor.cjs");
const gov = require_("../../electron/resource-governor.cjs") as {
  createResourceGovernor: (options: Record<string, unknown>) => Governor;
  createCancelToken: () => {
    signal: AbortSignal;
    cancel: (r?: string) => void;
    cancelled: boolean;
  };
  memoryLevel: (freeMb: number, totalMb: number) => "ok" | "high" | "critical";
  vramHeadroomMb: (totalMb: number | null) => number;
  busyModelTags: (owners: string[]) => Set<string>;
  unloadIdleOllama: (o: {
    ollamaRunning: () => Promise<{
      ok: boolean;
      models: Array<{ id: string; expiresAt?: string }>;
    }>;
    ollamaUnload: (id: string) => Promise<unknown>;
    tracker: { observe: (m: Array<{ id: string; expiresAt?: string }>) => string[] };
    busyOwners?: string[];
  }) => Promise<boolean | "pending">;
  createIdleTracker: (o: { now: () => number; minIdleMs: number }) => {
    observe: (m: Array<{ id: string; expiresAt?: string }>) => string[];
  };
  RAM_HEADROOM_MB: number;
};

type Lease = {
  id: string;
  state: string;
  hint: unknown;
  shrunk: boolean;
  heartbeat: () => boolean;
  loaded: () => void;
  release: () => void;
};
type Placed = {
  state: string;
  lease?: Lease;
  reason?: string;
  wait?: Promise<{ state: string; lease?: Lease }>;
  cancel?: () => void;
};
type Governor = {
  acquire: (req: Record<string, unknown>) => Promise<Placed>;
  tick: () => Promise<void>;
  onLag: (w: { p99Ms: number; maxMs: number }) => Promise<void>;
  run: <T>(
    cls: string,
    fn: (ctx: { signal: AbortSignal }) => Promise<T> | T,
    o?: Record<string, unknown>,
  ) => Promise<T>;
  status: () => any;
  level: () => string;
  allowsPrefetch: () => boolean;
  whenIdle: () => Promise<void>;
};

const MB = 1;
function rig(over: Record<string, unknown> = {}) {
  const clock = { t: 1_000_000 };
  const mem = { freeMb: 12_000 * MB, totalMb: 16_384 * MB };
  const vram: { freeMb: number; totalMb: number } | null = { freeMb: 5_000, totalMb: 6_144 };
  const state = { mem: mem as typeof mem | null, vram: vram as typeof vram | null };
  const power = { onBattery: false, saver: false, speedLimit: 100 };
  const actions = {
    unloadIdleModels: vi.fn(async () => ({ unloaded: ["m1"] })),
    unloadSpeech: vi.fn(async () => true),
  };
  const notify = vi.fn();
  const log = vi.fn();
  const g = gov.createResourceGovernor({
    now: () => clock.t,
    readMemory: () => state.mem,
    readVram: () => state.vram,
    getPower: () => power,
    actions,
    notify,
    log,
    ...over,
  });
  return { g, clock, state, power, actions, notify, log };
}

const tickN = async (g: Governor, n = 1) => {
  for (let i = 0; i < n; i += 1) await g.tick();
};

describe("lease grant, headroom and shrink", () => {
  it("grants a lease that fits and keeps desktop headroom (GPU max(0.5 GB, 10%), RAM 1.5 GB)", async () => {
    expect(gov.vramHeadroomMb(6_144)).toBe(614);
    expect(gov.vramHeadroomMb(2_048)).toBe(512);
    expect(gov.vramHeadroomMb(null)).toBe(512);
    expect(gov.RAM_HEADROOM_MB).toBe(1536);
    const { g, state } = rig();
    state.vram = { freeMb: 5_000, totalMb: 6_144 };
    const ok = await g.acquire({ owner: "qwen", kind: "llm", priority: "chat", vramMb: 4_300 });
    expect(ok.state).toBe("granted");
    const g2 = rig().g;
    const tooBig = await g2.acquire({
      owner: "big",
      kind: "llm",
      priority: "chat",
      vramMb: 4_500,
      queue: false,
    });
    // 5000 free - 614 headroom = 4386 < 4500
    expect(tooBig.state).toBe("refused");
    expect(tooBig.reason).toBe("no-room");
  });

  it("shrinks to a smaller option with a hint when the requested one does not fit", async () => {
    const { g } = rig();
    const placed = await g.acquire({
      owner: "qwen",
      kind: "llm",
      priority: "chat",
      options: [
        { vramMb: 6_000, hint: { quant: "q8" } },
        { vramMb: 4_000, hint: { quant: "q4_k_m" } },
        { vramMb: 0, ramMb: 2_000, hint: { device: "cpu" } },
      ],
    });
    expect(placed.state).toBe("granted");
    expect(placed.lease?.shrunk).toBe(true);
    expect(placed.lease?.hint).toEqual({ quant: "q4_k_m" });
  });

  it("falls to the CPU option when the card has no room, and counts RAM headroom", async () => {
    const { g, state } = rig();
    state.vram = { freeMb: 700, totalMb: 6_144 };
    state.mem = { freeMb: 3_000, totalMb: 16_384 };
    const cpu = await g.acquire({
      owner: "q",
      kind: "llm",
      priority: "chat",
      options: [{ vramMb: 4_000 }, { vramMb: 0, ramMb: 1_400, hint: { device: "cpu" } }],
    });
    expect(cpu.lease?.hint).toEqual({ device: "cpu" });
    const g2 = rig({}).g;
    const none = await g2.acquire({
      owner: "q",
      kind: "llm",
      priority: "chat",
      ramMb: 1_600,
      queue: false,
    });
    expect(none.state).toBe("granted"); // 12000 free
    const r = rig();
    r.state.mem = { freeMb: 3_000, totalMb: 16_384 };
    const tight = await r.g.acquire({
      owner: "q",
      kind: "llm",
      priority: "chat",
      ramMb: 1_600,
      queue: false,
    });
    expect(tight.state).toBe("refused"); // 3000 - 1536 = 1464 < 1600
  });

  it("counts a grant that has not loaded yet so two concurrent requests cannot overcommit", async () => {
    const { g, state, clock } = rig();
    const first = await g.acquire({ owner: "a", kind: "llm", priority: "chat", vramMb: 3_000 });
    expect(first.state).toBe("granted");
    const second = await g.acquire({
      owner: "b",
      kind: "image",
      priority: "background",
      vramMb: 3_000,
    });
    expect(second.state).toBe("queued");
    // The OS now shows the first model loaded: free drops, the reserve is released by loaded().
    first.lease?.loaded();
    state.vram = { freeMb: 2_000, totalMb: 6_144 };
    await g.tick();
    expect(g.status().queued.length).toBe(1);
    // The first one is released and the memory comes back: the waiting one is granted.
    first.lease?.release();
    state.vram = { freeMb: 5_000, totalMb: 6_144 };
    await g.tick();
    const after = await second.wait;
    expect(after?.state).toBe("granted");
  });

  it("an unconfirmed grant stops counting after the settle time", async () => {
    const { g, clock } = rig({ settleMs: 20_000 });
    const a = await g.acquire({ owner: "a", kind: "llm", priority: "chat", vramMb: 4_000 });
    expect(a.state).toBe("granted");
    const b = await g.acquire({ owner: "b", kind: "llm", priority: "chat", vramMb: 4_000 });
    expect(b.state).toBe("queued"); // 5000 - 4000 reserved, the OS has not shown it yet
    clock.t += 25_000;
    await g.tick();
    expect((await b.wait)?.state).toBe("granted"); // the reading is trusted again
  });

  it("an unreadable machine never blocks work", async () => {
    const { g, state } = rig();
    state.mem = null;
    state.vram = null;
    const placed = await g.acquire({
      owner: "x",
      kind: "llm",
      priority: "chat",
      vramMb: 9_000,
      ramMb: 9_000,
    });
    expect(placed.state).toBe("granted");
    expect(g.level()).toBe("ok");
  });

  it("falls back to the injected facts when the live readers have nothing", async () => {
    const { g } = rig({
      readMemory: () => null,
      readVram: () => null,
      getFacts: () => ({ vramGb: 6, vramFreeGb: 1, ramGb: 16, ramFreeGb: 10 }),
    });
    const placed = await g.acquire({
      owner: "x",
      kind: "llm",
      priority: "chat",
      vramMb: 4_000,
      queue: false,
    });
    expect(placed.state).toBe("refused");
  });
});

describe("queue, priority and bounds", () => {
  it("serves a voice request before an older background one when room appears", async () => {
    const { g, state } = rig();
    const hold = await g.acquire({ owner: "h", kind: "llm", priority: "chat", vramMb: 4_000 });
    hold.lease?.loaded();
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const bg = await g.acquire({
      owner: "bg",
      kind: "image",
      priority: "background",
      vramMb: 3_500,
    });
    const voice = await g.acquire({ owner: "v", kind: "speech", priority: "voice", vramMb: 3_500 });
    expect(bg.state).toBe("queued");
    expect(voice.state).toBe("queued"); // chat is not preemptable here (no onPause)
    const order: string[] = [];
    void bg.wait?.then(() => order.push("bg"));
    void voice.wait?.then(() => order.push("voice"));
    hold.lease?.release();
    state.vram = { freeMb: 5_000, totalMb: 6_144 };
    await g.tick();
    await g.whenIdle();
    await Promise.resolve();
    expect(order[0]).toBe("voice");
  });

  it("bounds the lease queue and refuses past it", async () => {
    const { g, state } = rig({ maxLeaseQueue: 2 });
    state.vram = { freeMb: 700, totalMb: 6_144 };
    const q = [];
    for (let i = 0; i < 3; i += 1) {
      q.push(await g.acquire({ owner: `o${i}`, kind: "llm", priority: "chat", vramMb: 3_000 }));
    }
    expect(q.map((p) => p.state)).toEqual(["queued", "queued", "refused"]);
    expect(q[2]?.reason).toBe("queue-full");
  });

  it("a queued request can be cancelled and a stale one expires", async () => {
    const { g, state, clock } = rig({ queueTimeoutMs: 10_000 });
    state.vram = { freeMb: 700, totalMb: 6_144 };
    const a = await g.acquire({ owner: "a", kind: "llm", priority: "chat", vramMb: 3_000 });
    const b = await g.acquire({ owner: "b", kind: "llm", priority: "chat", vramMb: 3_000 });
    a.cancel?.();
    expect((await a.wait)?.state).toBe("cancelled");
    clock.t += 11_000;
    await g.tick();
    expect((await b.wait)?.state).toBe("expired");
    expect(g.status().queued.length).toBe(0);
  });
});

describe("preemption", () => {
  it("a voice turn pauses a background lease to get room and it resumes after", async () => {
    const { g, state } = rig();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const bg = await g.acquire({
      owner: "flux",
      kind: "image",
      priority: "background",
      vramMb: 4_000,
      onPause,
      onResume,
    });
    bg.lease?.loaded();
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const voice = await g.acquire({
      owner: "stt",
      kind: "speech",
      priority: "voice",
      vramMb: 1_500,
    });
    expect(voice.state).toBe("granted");
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(bg.lease?.state).toBe("suspended");
    // the image job pauses and frees its card memory; the voice lease ends and it may come back
    state.vram = { freeMb: 5_000, totalMb: 6_144 };
    voice.lease?.release();
    await g.tick();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(bg.lease?.state).toBe("active");
  });

  it("a cancel-mode victim is cancelled, not paused; equal or higher priority is never preempted", async () => {
    const { g, state } = rig();
    const onCancel = vi.fn();
    const prefetch = await g.acquire({
      owner: "warm",
      kind: "llm",
      priority: "prefetch",
      vramMb: 4_000,
      preempt: "cancel",
      onCancel,
    });
    prefetch.lease?.loaded();
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const chat = await g.acquire({ owner: "c", kind: "llm", priority: "chat", vramMb: 3_000 });
    expect(chat.state).toBe("granted");
    expect(onCancel).toHaveBeenCalledTimes(1);

    const onPauseChat = vi.fn();
    const r = rig();
    const c1 = await r.g.acquire({
      owner: "c1",
      kind: "llm",
      priority: "chat",
      vramMb: 4_000,
      onPause: onPauseChat,
    });
    c1.lease?.loaded();
    r.state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const c2 = await r.g.acquire({ owner: "c2", kind: "llm", priority: "chat", vramMb: 3_000 });
    expect(c2.state).toBe("queued");
    expect(onPauseChat).not.toHaveBeenCalled();
  });

  it("a lease without a pause or cancel callback is never touched", async () => {
    const { g, state } = rig();
    const a = await g.acquire({ owner: "a", kind: "image", priority: "background", vramMb: 4_000 });
    a.lease?.loaded();
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const v = await g.acquire({
      owner: "v",
      kind: "speech",
      priority: "voice",
      vramMb: 2_000,
      queue: false,
    });
    expect(v.state).toBe("refused");
    expect(a.lease?.state).toBe("active");
  });
});

describe("heartbeat expiry", () => {
  it("frees a lease whose holder stopped beating, and keeps one that beats", async () => {
    const { g, state, clock } = rig({ leaseTtlMs: 30_000 });
    state.vram = { freeMb: 700, totalMb: 6_144 };
    const dead = await g.acquire({ owner: "dead", kind: "llm", priority: "chat", vramMb: 50 });
    state.vram = { freeMb: 4_000, totalMb: 6_144 };
    const alive = await g.acquire({ owner: "alive", kind: "llm", priority: "chat", vramMb: 100 });
    clock.t += 20_000;
    expect(alive.lease?.heartbeat()).toBe(true);
    clock.t += 15_000;
    await g.tick();
    expect(dead.lease?.state).toBe("expired");
    expect(alive.lease?.state).toBe("active");
    expect(dead.lease?.heartbeat()).toBe(false);
    expect(g.status().actions.some((a: { kind: string }) => a.kind === "lease-expired")).toBe(true);
  });

  it("frees at once when the holder reports it is gone", async () => {
    const { g } = rig();
    let up = true;
    const l = await g.acquire({
      owner: "w",
      kind: "speech",
      priority: "voice",
      vramMb: 100,
      alive: () => up,
    });
    up = false;
    await g.tick();
    expect(l.lease?.state).toBe("expired");
  });
});

describe("paused holders and the video memory probe", () => {
  it("a lease the governor paused does not expire for want of a heartbeat, and gets a fresh beat on resume", async () => {
    const { g, state, clock } = rig({ leaseTtlMs: 30_000 });
    const onPause = vi.fn();
    const bg = await g.acquire({
      owner: "bg",
      kind: "image",
      priority: "background",
      ramMb: 100,
      onPause,
      onResume: vi.fn(),
    });
    await g.onLag({ p99Ms: 500, maxMs: 900 });
    expect(bg.lease?.state).toBe("paused");
    clock.t += 120_000;
    await g.tick();
    expect(bg.lease?.state).toBe("paused");
    await g.onLag({ p99Ms: 10, maxMs: 20 });
    await g.onLag({ p99Ms: 10, maxMs: 20 });
    expect(bg.lease?.state).toBe("active");
    await g.tick();
    expect(bg.lease?.state).toBe("active"); // the beat clock restarted at the resume
    void state;
  });

  it("probes the card only when one is known or a lease wants it", async () => {
    const refreshVram = vi.fn(async () => null);
    const none = rig({ readVram: () => null, refreshVram, getFacts: () => null });
    await tickN(none.g, 8);
    expect(refreshVram).not.toHaveBeenCalled();
    await none.g.acquire({
      owner: "img",
      kind: "image",
      priority: "background",
      vramMb: 100,
      queue: false,
    });
    await none.g.tick();
    expect(refreshVram).toHaveBeenCalledTimes(1);
    const known = rig({ refreshVram, vramProbeEveryTicks: 3 });
    refreshVram.mockClear();
    await tickN(known.g, 7);
    expect(refreshVram).toHaveBeenCalledTimes(3); // ticks 1, 4 and 7
  });
});

describe("class caps, queue bounds and cancellation", () => {
  it("runs at most the cap at once and starts the next when one ends", async () => {
    const { g } = rig({ caps: { download: 2 } });
    let live = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const flush = () => new Promise((r) => setImmediate(r));
    const job = () =>
      g.run("download", async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => gates.push(r));
        live -= 1;
      });
    const all = [job(), job(), job(), job()];
    await flush();
    expect(g.status().jobs.download.running).toBe(2);
    expect(g.status().jobs.download.queued).toBe(2);
    gates.shift()?.();
    await flush();
    expect(g.status().jobs.download.running).toBe(2);
    expect(g.status().jobs.download.queued).toBe(1);
    for (let i = 0; i < 6; i += 1) {
      while (gates.length) gates.shift()?.();
      await flush();
    }
    await Promise.all(all);
    expect(peak).toBe(2);
  });

  it("rejects past the bounded queue (backpressure) and on abort while waiting", async () => {
    const { g } = rig({ caps: { install: 1 }, maxQueue: { install: 1 } });
    let release: () => void = () => {};
    const first = g.run("install", () => new Promise<void>((r) => (release = r)));
    const second = g.run("install", async () => "second");
    await expect(g.run("install", async () => "third")).rejects.toMatchObject({
      code: "QUEUE_FULL",
    });
    expect(g.status().jobs.install.saturated).toBe(true);
    release();
    await first;
    await expect(second).resolves.toBe("second");

    const ctl = gov.createCancelToken();
    let rel2: () => void = () => {};
    const busy = g.run("install", () => new Promise<void>((r) => (rel2 = r)));
    const ran = vi.fn();
    const waiting = g.run("install", ran, { signal: ctl.signal });
    ctl.cancel("owner pressed Cancel");
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    rel2();
    await busy;
    expect(ran).not.toHaveBeenCalled();
  });

  it("a failing job frees its slot, and an unknown class is a programming error", async () => {
    const { g } = rig({ caps: { generation: 1 } });
    await expect(g.run("generation", () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(g.run("generation", async () => 7)).resolves.toBe(7);
    await expect(g.run("nope", async () => 1)).rejects.toThrow(/unknown job class/);
  });

  it("starts higher priority jobs first", async () => {
    const { g } = rig({ caps: { install: 1 } });
    let release: () => void = () => {};
    const gate = g.run("install", () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setImmediate(r));
    const order: string[] = [];
    const lo = g.run("install", async () => order.push("prefetch"), { priority: "prefetch" });
    const hi = g.run("install", async () => order.push("chat"), { priority: "chat" });
    release();
    await Promise.all([gate, lo, hi]);
    expect(order).toEqual(["chat", "prefetch"]);
  });
});

describe("pressure policy", () => {
  it("uses the speech worker thresholds (high from 15%, critical from 7%, with floors and ceilings)", () => {
    expect(gov.memoryLevel(2_000, 16_384)).toBe("high"); // line 2457
    expect(gov.memoryLevel(1_000, 16_384)).toBe("critical"); // line 1146
    expect(gov.memoryLevel(3_000, 16_384)).toBe("ok");
    expect(gov.memoryLevel(3_100, 65_536)).toBe("ok"); // ceiling 3072
    expect(gov.memoryLevel(3_000, 65_536)).toBe("high");
    expect(gov.memoryLevel(2_500, 65_536)).toBe("high");
    expect(gov.memoryLevel(900, 4_096)).toBe("critical"); // floor 1024
    expect(gov.memoryLevel(1_500, 4_096)).toBe("high");
  });

  it("goes up at once, unloads idle models and speech, and comes down only after calm readings", async () => {
    const { g, state, actions } = rig();
    state.mem = { freeMb: 2_000, totalMb: 16_384 };
    await g.tick();
    expect(g.level()).toBe("high");
    expect(actions.unloadIdleModels).toHaveBeenCalledTimes(1);
    expect(actions.unloadSpeech).toHaveBeenCalledTimes(1);
    state.mem = { freeMb: 9_000, totalMb: 16_384 };
    await g.tick();
    expect(g.level()).toBe("high"); // one calm reading is not enough
    await g.tick();
    expect(g.level()).toBe("ok");
    expect(g.status().holds).toEqual([]);
  });

  it("does not unload on every tick while memory stays low, and passes busy owners", async () => {
    const { g, state, actions, clock } = rig({ unloadEveryMs: 60_000 });
    const busy = await g.acquire({
      owner: "chat:qwen3:4b",
      kind: "llm",
      priority: "chat",
      ramMb: 100,
    });
    expect(busy.state).toBe("granted");
    state.mem = { freeMb: 2_000, totalMb: 16_384 };
    await tickN(g, 3);
    expect(actions.unloadIdleModels).toHaveBeenCalledTimes(1);
    expect(actions.unloadIdleModels).toHaveBeenCalledWith({
      busyOwners: ["chat:qwen3:4b"],
      busyKinds: ["llm"],
    });
    clock.t += 61_000;
    await g.tick();
    expect(actions.unloadIdleModels).toHaveBeenCalledTimes(2);
  });

  it("critical refuses new heavy leases except voice, says one line once, and clears it later", async () => {
    const { g, state, notify } = rig();
    state.mem = { freeMb: 900, totalMb: 16_384 };
    await g.tick();
    expect(g.level()).toBe("critical");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0])).toMatch(/memory is very low/i);
    await g.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    const heavy = await g.acquire({
      owner: "x",
      kind: "llm",
      priority: "chat",
      ramMb: 2_500,
      queue: false,
    });
    expect(heavy.state).toBe("refused");
    expect(heavy.reason).toBe("memory-critical");
    // Even a small one waits while free memory is under the desktop headroom.
    const light = await g.acquire({
      owner: "y",
      kind: "embedding",
      priority: "chat",
      ramMb: 200,
      queue: false,
    });
    expect(light.state).toBe("refused");
    expect(light.reason).toBe("no-room");
    state.mem = { freeMb: 14_000, totalMb: 16_384 };
    const voice = await g.acquire({
      owner: "v",
      kind: "speech",
      priority: "voice",
      ramMb: 600,
      queue: false,
    });
    expect(voice.state).toBe("granted");
    await tickN(g, 2);
    expect(g.level()).toBe("ok");
    expect(g.status().notice).toBeNull();
  });

  it("video memory under its headroom is pressure too", async () => {
    const { g, state } = rig();
    state.vram = { freeMb: 500, totalMb: 6_144 };
    await g.tick();
    expect(g.level()).toBe("critical");
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    await tickN(g, 2);
    expect(g.level()).toBe("high");
  });

  it("pauses background leases while pressure holds, resumes after, and defers background starts", async () => {
    const { g, state } = rig();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const bg = await g.acquire({
      owner: "music",
      kind: "music",
      priority: "background",
      ramMb: 500,
      onPause,
      onResume,
    });
    state.mem = { freeMb: 2_000, totalMb: 16_384 };
    await g.tick();
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(bg.lease?.state).toBe("paused");
    const later = await g.acquire({
      owner: "n",
      kind: "image",
      priority: "background",
      ramMb: 500,
    });
    expect(later.state).toBe("queued");
    expect(later.reason).toMatch(/deferred/);
    state.mem = { freeMb: 12_000, totalMb: 16_384 };
    await tickN(g, 2);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(bg.lease?.state).toBe("active");
    expect((await later.wait)?.state).toBe("granted");
  });

  it("an action that throws never stops the tick", async () => {
    const { g, state, actions } = rig();
    actions.unloadIdleModels.mockRejectedValueOnce(new Error("ollama down"));
    state.mem = { freeMb: 2_000, totalMb: 16_384 };
    await expect(g.tick()).resolves.toBeUndefined();
    expect(g.level()).toBe("high");
    expect(g.status().actions.some((a: { kind: string }) => a.kind === "unload-failed")).toBe(true);
  });

  it("critical holds new generation and model-load jobs but lets downloads run", async () => {
    const { g, state } = rig();
    state.mem = { freeMb: 900, totalMb: 16_384 };
    await g.tick();
    const gen = vi.fn(async () => "img");
    const waiting = g.run("generation", gen, { priority: "chat" });
    await Promise.resolve();
    await Promise.resolve();
    expect(gen).not.toHaveBeenCalled();
    await expect(g.run("download", async () => "dl")).resolves.toBe("dl");
    state.mem = { freeMb: 14_000, totalMb: 16_384 };
    await tickN(g, 2);
    await expect(waiting).resolves.toBe("img");
  });
});

describe("battery, saver and thermal throttle", () => {
  it("prefers the smaller option on battery, but a voice turn keeps its best", async () => {
    const { g, power } = rig();
    power.onBattery = true;
    await g.tick();
    const options = [
      { vramMb: 4_000, hint: { q: "big" } },
      { vramMb: 1_500, hint: { q: "small" } },
    ];
    const chat = await g.acquire({ owner: "c", kind: "llm", priority: "chat", options });
    expect(chat.lease?.hint).toEqual({ q: "small" });
    const voice = await g.acquire({
      owner: "v",
      kind: "speech",
      priority: "voice",
      options: [
        { vramMb: 500, hint: { q: "big" } },
        { vramMb: 200, hint: { q: "small" } },
      ],
    });
    expect(voice.lease?.hint).toEqual({ q: "big" });
  });

  it("defers prefetch on battery and background work too under saver or throttle", async () => {
    const { g, power } = rig();
    power.onBattery = true;
    await g.tick();
    expect(g.allowsPrefetch()).toBe(false);
    const warm = await g.acquire({ owner: "w", kind: "llm", priority: "prefetch", ramMb: 300 });
    expect(warm.state).toBe("queued");
    const bg = await g.acquire({ owner: "b", kind: "image", priority: "background", ramMb: 300 });
    expect(bg.state).toBe("granted");
    power.saver = true;
    await g.tick();
    const bg2 = await g.acquire({ owner: "b2", kind: "image", priority: "background", ramMb: 300 });
    expect(bg2.state).toBe("queued");
    power.saver = false;
    power.onBattery = false;
    power.speedLimit = 60;
    await g.tick();
    expect(g.status().power.stress).toBe("thermal");
    power.speedLimit = 100;
    await tickN(g, 2);
    expect(g.status().power.stress).toBe("none");
    expect(g.allowsPrefetch()).toBe(true);
  });
});

describe("event loop lag", () => {
  it("pauses background leases and jobs but never voice, records a row, and resumes after calm windows", async () => {
    const { g } = rig({ lagPauseMs: 250 });
    const bgPause = vi.fn();
    const bgResume = vi.fn();
    const voicePause = vi.fn();
    const bg = await g.acquire({
      owner: "bg",
      kind: "image",
      priority: "background",
      ramMb: 100,
      onPause: bgPause,
      onResume: bgResume,
    });
    const voice = await g.acquire({
      owner: "v",
      kind: "speech",
      priority: "voice",
      ramMb: 100,
      onPause: voicePause,
    });
    await g.onLag({ p99Ms: 400, maxMs: 900 });
    expect(bgPause).toHaveBeenCalledTimes(1);
    expect(voicePause).not.toHaveBeenCalled();
    expect(bg.lease?.state).toBe("paused");
    expect(voice.lease?.state).toBe("active");
    expect(g.status().lag).toMatchObject({ p99Ms: 400, maxMs: 900, paused: true });
    const row = g.status().actions.find((a: { kind: string }) => a.kind === "lag-pause");
    expect(row?.detail).toMatch(/400/);

    const ran: string[] = [];
    const bgJob = g.run("generation", async () => ran.push("bg"), { priority: "background" });
    const voiceJob = g.run("modelLoad", async () => ran.push("voice"), { priority: "voice" });
    await voiceJob;
    expect(ran).toEqual(["voice"]);

    await g.onLag({ p99Ms: 40, maxMs: 90 });
    expect(bg.lease?.state).toBe("paused"); // one calm window is not enough
    await g.onLag({ p99Ms: 30, maxMs: 60 });
    expect(bg.lease?.state).toBe("active");
    expect(bgResume).toHaveBeenCalledTimes(1);
    await bgJob;
    expect(ran).toEqual(["voice", "bg"]);
  });

  it("ignores garbage windows", async () => {
    const { g } = rig();
    await expect(g.onLag({ p99Ms: Number.NaN, maxMs: -1 })).resolves.toBeUndefined();
    expect(g.status().lag.paused).toBe(false);
  });
});

describe("status and hygiene", () => {
  it("reports leases, queues, level, lag and the last actions in a small plain shape", async () => {
    const { g } = rig();
    await g.acquire({ owner: "qwen", kind: "llm", priority: "chat", ramMb: 500 });
    const s = g.status();
    expect(s.ok).toBe(true);
    expect(s.level).toBe("ok");
    expect(s.leases[0]).toMatchObject({
      owner: "qwen",
      kind: "llm",
      priority: "chat",
      state: "active",
    });
    expect(Object.keys(s.jobs).sort()).toEqual(["download", "generation", "install", "modelLoad"]);
    expect(JSON.stringify(s).length).toBeLessThan(4000);
  });

  it("the action log is bounded", async () => {
    const { g } = rig();
    for (let i = 0; i < 60; i += 1) await g.onLag({ p99Ms: i % 2 ? 900 : 10, maxMs: 1 });
    expect(g.status().actions.length).toBeLessThanOrEqual(12);
  });

  it("owns no timer of its own: it rides the shared tick", () => {
    const text = readFileSync(SOURCE, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(text.match(/setInterval\s*\(/g)?.length ?? 0).toBe(0);
    // Only one-shot deadlines (the voice bound, a slow action): each is unref'd and cleared, none repeats.
    const timeouts = text.match(/setTimeout\s*\(/g)?.length ?? 0;
    expect(timeouts).toBeLessThanOrEqual(2);
    expect(text.match(/\.unref\?\.\(\)/g)?.length ?? 0).toBe(timeouts);
    expect(text.match(/clearTimeout\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(timeouts);
  });

  it("a cancel token cancels once and carries a signal", () => {
    const t = gov.createCancelToken();
    expect(t.cancelled).toBe(false);
    t.cancel("x");
    t.cancel("y");
    expect(t.cancelled).toBe(true);
    expect(t.signal.aborted).toBe(true);
  });
});

describe("a slow pressure action never delays a voice request", () => {
  const settleVoice = async (ms: number, g: Governor) => {
    let answer: Placed | null = null;
    void g
      .acquire({ owner: "speech-worker", kind: "speech", priority: "voice", ramMb: 300 })
      .then((r) => {
        answer = r;
      });
    await vi.advanceTimersByTimeAsync(ms);
    return answer as Placed | null;
  };
  const slow = (ms: number, value: unknown = true) =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));

  it("a voice acquire 50 ms after a tick that is unloading for 3 s is granted inside 400 ms", async () => {
    vi.useFakeTimers();
    try {
      const { g, state, actions } = rig();
      actions.unloadIdleModels.mockImplementation(() => slow(3_000) as never);
      state.mem = { freeMb: 2_000, totalMb: 16_384 };
      const ticking = g.tick();
      await vi.advanceTimersByTimeAsync(50);
      const started = Date.now();
      const answer = await settleVoice(300, g);
      expect(Date.now() - started).toBeLessThan(400);
      expect(answer?.state).toBe("granted");
      await vi.advanceTimersByTimeAsync(4_000);
      await ticking;
      expect(actions.unloadIdleModels).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a voice acquire during a hung video-memory probe is granted inside 400 ms", async () => {
    vi.useFakeTimers();
    try {
      const refreshVram = vi.fn(() => slow(18_000, null) as never);
      const { g } = rig({ refreshVram });
      const ticking = g.tick();
      await vi.advanceTimersByTimeAsync(50);
      expect(refreshVram).toHaveBeenCalledTimes(1);
      const answer = await settleVoice(300, g);
      expect(answer?.state).toBe("granted");
      await vi.advanceTimersByTimeAsync(20_000);
      await ticking;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an action that never returns is cut off by its own deadline, is not started twice, and the others still run", async () => {
    vi.useFakeTimers();
    try {
      const { g, state, actions, clock } = rig({ actionTimeoutMs: 5_000, unloadEveryMs: 60_000 });
      actions.unloadIdleModels.mockImplementation(() => new Promise(() => {}) as never);
      state.mem = { freeMb: 2_000, totalMb: 16_384 };
      const ticking = g.tick();
      await vi.advanceTimersByTimeAsync(5_100);
      await ticking;
      expect(actions.unloadSpeech).toHaveBeenCalledTimes(1);
      clock.t += 61_000;
      const again = g.tick();
      await vi.advanceTimersByTimeAsync(5_100);
      await again;
      // The hung models action is still running, so it is not started a second time; speech is asked again.
      expect(actions.unloadIdleModels).toHaveBeenCalledTimes(1);
      expect(actions.unloadSpeech).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a voice acquire behind a hung pause callback answers 'none' inside the bound, then gives back a late lease", async () => {
    vi.useFakeTimers();
    try {
      const { g, state } = rig();
      state.vram = { freeMb: 5_000, totalMb: 6_144 };
      let unhang: () => void = () => {};
      const hung = new Promise<void>((resolve) => {
        unhang = resolve;
      });
      const chat = await g.acquire({
        owner: "c",
        kind: "llm",
        priority: "chat",
        vramMb: 4_000,
        onPause: () => hung,
      });
      chat.lease?.loaded();
      state.vram = { freeMb: 1_000, totalMb: 6_144 };
      let answer: Placed | null = null;
      void g
        .acquire({ owner: "speech-worker", kind: "speech", priority: "voice", vramMb: 3_000 })
        .then((r) => {
          answer = r;
        });
      await vi.advanceTimersByTimeAsync(400);
      expect((answer as Placed | null)?.state).toBe("none");
      unhang();
      await vi.advanceTimersByTimeAsync(10);
      await g.whenIdle();
      expect(g.status().leases.some((l: { owner: string }) => l.owner === "speech-worker")).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("suspended resume entries do not fill the queue for a voice request", () => {
  it("voice is queued, never queue-full, while only a paused lease waits to resume", async () => {
    const { g, state } = rig({ maxLeaseQueue: 1 });
    state.vram = { freeMb: 5_000, totalMb: 6_144 };
    const chat = await g.acquire({
      owner: "c",
      kind: "llm",
      priority: "chat",
      vramMb: 4_000,
      onPause: () => {},
    });
    chat.lease?.loaded();
    state.vram = { freeMb: 1_000, totalMb: 6_144 };
    const first = await g.acquire({
      owner: "v1",
      kind: "speech",
      priority: "voice",
      vramMb: 3_000,
    });
    expect(first.state).toBe("granted");
    expect(g.status().queued.some((q: { resume?: boolean }) => q.resume)).toBe(true);
    const second = await g.acquire({
      owner: "v2",
      kind: "speech",
      priority: "voice",
      vramMb: 3_000,
    });
    expect(second.state).toBe("queued");
    expect(second.reason).not.toBe("queue-full");
  });
});

describe("the busy filter matches the owner a chat turn really holds", () => {
  const TAG = "qwen3:4b";
  const running = (ids: string[]) => ({
    ok: true,
    models: ids.map((id) => ({ id, expiresAt: "2030-01-01T00:00:00Z" })),
  });

  it("reads the Ollama tag out of a chat owner, and ignores owners that are not chat", () => {
    expect(
      [...gov.busyModelTags([`chat:${TAG}`, "speech-worker", "chat:llama3.2:1b"])].sort(),
    ).toEqual(["llama3.2:1b", TAG]);
  });

  it("a model with a turn in flight is kept, an idle one is unloaded (two looks, 60 s apart)", async () => {
    const clock = { t: 0 };
    const tracker = gov.createIdleTracker({ now: () => clock.t, minIdleMs: 45_000 });
    const unload = vi.fn(async () => ({ ok: true }));
    const ask = (busyOwners: string[]) =>
      gov.unloadIdleOllama({
        ollamaRunning: async () => running([TAG, "gemma3:1b"]),
        ollamaUnload: unload,
        tracker,
        busyOwners,
      });
    // The real governor passes the owner it recorded for the lease: `chat:<tag>`.
    const { g } = rig();
    const lease = await g.acquire({
      owner: `chat:${TAG}`,
      kind: "llm",
      priority: "chat",
      ramMb: 100,
    });
    expect(lease.state).toBe("granted");
    const owners = g.status().leases.map((l: { owner: string }) => l.owner);
    expect(owners).toEqual([`chat:${TAG}`]);
    expect(await ask(owners)).toBe("pending");
    clock.t += 60_000;
    expect(await ask(owners)).toBe(true);
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith("gemma3:1b");
  });

  it("nothing resident, or Ollama not answering, frees nothing", async () => {
    const tracker = gov.createIdleTracker({ now: () => 0, minIdleMs: 1 });
    const unload = vi.fn();
    expect(
      await gov.unloadIdleOllama({
        ollamaRunning: async () => ({ ok: false, models: [] }),
        ollamaUnload: unload,
        tracker,
      }),
    ).toBe(false);
    expect(unload).not.toHaveBeenCalled();
  });
});
