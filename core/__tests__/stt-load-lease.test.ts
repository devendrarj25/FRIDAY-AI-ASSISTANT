/**
 * The speech worker asks the resource governor before it loads (electron/stt.cjs `leaseSpeechLoad`): as the voice
 * priority, for the size it wants, falling back to a smaller installed size when the PC cannot carry it, and never
 * blocking a turn when the governor says no.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
const stt = require_("../../electron/stt.cjs") as {
  setLoadLeases: (api: unknown) => void;
  speechLoadOptions: (wanted: string) => Array<{ size: string; option: Record<string, unknown> }>;
  leaseSpeechLoad: (
    wanted: string,
  ) => Promise<{ size: string; done: () => void; fail: () => void; release: () => void }>;
  releaseIdle: (minIdleMs?: number, session?: unknown) => boolean;
  shutdown: (session?: unknown) => void;
};
const paths = require_("../../electron/friday-paths.cjs") as {
  setRoot: (dir: string | null) => string | null;
};
const leaseApi = require_("../../electron/load-lease.cjs") as {
  createLoadLeases: (options: Record<string, unknown>) => unknown;
};
const gov = require_("../../electron/resource-governor.cjs") as {
  createResourceGovernor: (options: Record<string, unknown>) => {
    status: () => { leases: Array<{ owner: string; kind: string; priority: string }> };
  };
};

const GB = 1024;
let root = "";

function install(...sizes: string[]) {
  for (const size of sizes) {
    const dir = path.join(root, "cache", "stt", size);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), "{}");
    writeFileSync(path.join(dir, "model.bin"), "x");
  }
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "friday-stt-lease-"));
  paths.setRoot(root);
  install("tiny", "base", "small");
});
afterEach(() => {
  stt.setLoadLeases(null);
  delete process.env["FRIDAY_STT_CUDA"];
});
afterAll(() => {
  paths.setRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("what a speech load asks for", () => {
  it("lists the wanted size first, then the smaller sizes that are really installed", () => {
    const rows = stt.speechLoadOptions("small");
    expect(rows.map((r) => r.size)).toEqual(["small", "base", "tiny"]);
    expect(rows[0]?.option).toEqual({ ramGb: 0.8, hint: "small" });
    // A size that is not installed is not offered as a fallback (it would have to be downloaded).
    expect(stt.speechLoadOptions("medium").map((r) => r.size)).toEqual([
      "medium",
      "small",
      "base",
      "tiny",
    ]);
    expect(stt.speechLoadOptions("base").map((r) => r.size)).toEqual(["base", "tiny"]);
  });

  it("asks for video memory instead of RAM when the speech worker runs on the card", () => {
    process.env["FRIDAY_STT_CUDA"] = "1";
    expect(stt.speechLoadOptions("small")[0]?.option).toEqual({ vramGb: 0.8, hint: "small" });
  });
});

describe("the voice lease", () => {
  it("is held as voice priority for the speech worker, and fail() gives it back", async () => {
    const governor = gov.createResourceGovernor({
      readMemory: () => ({ freeMb: 12 * GB, totalMb: 16 * GB }),
      readVram: () => null,
      log: () => undefined,
    });
    stt.setLoadLeases(leaseApi.createLoadLeases({ governor }));
    const held = await stt.leaseSpeechLoad("small");
    expect(held.size).toBe("small");
    expect(governor.status().leases).toEqual([
      expect.objectContaining({ owner: "speech-worker", kind: "speech", priority: "voice" }),
    ]);
    held.done();
    expect(governor.status().leases).toHaveLength(1);
    held.fail();
    expect(governor.status().leases).toHaveLength(0);
  });

  it("loads the smaller installed size on a PC that cannot carry the one asked for", async () => {
    // 2 GB free of 4 GB: 512 MB are left after the desktop's headroom, so small (0.8 GB) does not fit and base does.
    const governor = gov.createResourceGovernor({
      readMemory: () => ({ freeMb: 2 * GB, totalMb: 4 * GB }),
      readVram: () => null,
      log: () => undefined,
    });
    stt.setLoadLeases(leaseApi.createLoadLeases({ governor }));
    const held = await stt.leaseSpeechLoad("small");
    expect(held.size).toBe("base");
    held.fail();
  });

  it("never blocks the turn: a refusal loads the smallest installed size anyway", async () => {
    stt.setLoadLeases({
      acquire: vi.fn(async () => ({ state: "refused", reason: "waited", line: "x" })),
    });
    const held = await stt.leaseSpeechLoad("small");
    expect(held.size).toBe("tiny");
    expect(() => {
      held.done();
      held.fail();
    }).not.toThrow();
  });

  it("changes nothing when the governor answers none or throws", async () => {
    stt.setLoadLeases({ acquire: async () => ({ state: "none" }) });
    expect((await stt.leaseSpeechLoad("small")).size).toBe("small");
    stt.setLoadLeases({
      acquire: async () => {
        throw new Error("boom");
      },
    });
    expect((await stt.leaseSpeechLoad("small")).size).toBe("small");
  });

  it("is skipped entirely with no governor wired in", () => {
    stt.setLoadLeases(null);
    expect(() => stt.setLoadLeases({})).not.toThrow();
  });
});

describe("closing the worker for memory", () => {
  const fakeWorker = (lastUsedAt: number, pending = 0) => {
    const writes: string[] = [];
    return {
      writes,
      session: {
        alive: true,
        loaded: true,
        lastUsedAt,
        pending: new Map(Array.from({ length: pending }, (_, i) => [i, {}])),
        child: { pid: 0, stdin: { destroyed: false, write: (line: string) => writes.push(line) } },
      },
    };
  };

  it("an idle worker is closed even though its speech lease is still held, and a busy one is kept", () => {
    vi.useFakeTimers();
    try {
      const idle = fakeWorker(Date.now() - 120_000);
      expect(stt.releaseIdle(60_000, idle.session)).toBe(true);
      expect(idle.writes.some((line) => line.includes('"shutdown"'))).toBe(true);
      const used = fakeWorker(Date.now() - 5_000);
      expect(stt.releaseIdle(60_000, used.session)).toBe(false);
      const inFlight = fakeWorker(Date.now() - 120_000, 1);
      expect(stt.releaseIdle(60_000, inFlight.session)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("release() gives the speech lease back after the load has settled (done() alone never did)", async () => {
    const governor = gov.createResourceGovernor({
      readMemory: () => ({ freeMb: 12 * GB, totalMb: 16 * GB }),
      readVram: () => null,
      log: () => undefined,
    });
    stt.setLoadLeases(leaseApi.createLoadLeases({ governor }));
    const held = await stt.leaseSpeechLoad("small");
    held.done();
    expect(governor.status().leases).toHaveLength(1);
    held.release();
    expect(governor.status().leases).toHaveLength(0);
  });

  it("a governor that never answers cannot hold the speech worker back", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      stt.setLoadLeases({
        acquire: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ state: "granted", lease: { release }, hint: null }), 5_000),
          ),
      });
      let held: { size: string } | null = null;
      void stt.leaseSpeechLoad("small").then((h) => {
        held = h;
      });
      await vi.advanceTimersByTimeAsync(450);
      expect((held as { size: string } | null)?.size).toBe("small");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the worker releases its lease and a new worker starts with a fresh idle clock", () => {
    const text = readFileSync(path.join(__dirname, "..", "..", "electron", "stt.cjs"), "utf8");
    expect(text).toMatch(
      /function shutdown\(session = worker\) \{[\s\S]*?speechHeld\?\.release\(\);/,
    );
    expect(text).toMatch(/intentional: false,\s*err: "",[\s\S]*?lastUsedAt: Date\.now\(\),/);
  });
});
