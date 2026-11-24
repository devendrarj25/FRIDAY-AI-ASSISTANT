import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
type Rec = Record<string, unknown>;
type Connection = {
  connected: boolean | null;
  type: string | null;
  metered: boolean | null;
  roaming: boolean | null;
  overDataLimit: boolean | null;
};
const net = require_("../../electron/net-status.cjs") as {
  PROBES: Array<{ host: string; port: number }>;
  CONNECTION_SCRIPT: string;
  parseConnection: (net: unknown, adapter?: unknown) => Connection;
  detectConnection: (options?: Rec) => Promise<Connection | null>;
  networkFacts: (options?: Rec) => Promise<Rec>;
  measureLatency: (options?: Rec) => Promise<number | null>;
  probeTimed: (
    target: Rec,
    timeoutMs?: number,
    connect?: unknown,
    clock?: () => number,
  ) => Promise<{ ok: boolean; ms: number | null }>;
  resetNetworkCaches: () => void;
};

beforeEach(() => net.resetNetworkCaches());

// What the connection fragment prints inside the larger script (Windows PowerShell 5.1, ConvertTo-Json -Compress).
const WIFI_METERED = '{"net":{"cost":3,"roaming":false,"overLimit":false,"iana":71}}';
const ETHERNET_FREE = '{"net":{"cost":1,"roaming":false,"overLimit":false,"iana":6}}';
const CELLULAR_ROAMING = '{"net":{"cost":2,"roaming":true,"overLimit":true,"iana":243}}';

describe("parseConnection: type and cost as facts", () => {
  it("metered Wi-Fi (a variable per-byte cost)", () => {
    expect(net.parseConnection(JSON.parse(WIFI_METERED).net)).toEqual({
      connected: true,
      type: "wifi",
      metered: true,
      roaming: false,
      overDataLimit: false,
    });
  });

  it("unrestricted Ethernet is not metered; fixed-cost cellular is, with roaming and the data limit reported", () => {
    expect(net.parseConnection(JSON.parse(ETHERNET_FREE).net)).toMatchObject({
      type: "ethernet",
      metered: false,
    });
    expect(net.parseConnection(JSON.parse(CELLULAR_ROAMING).net)).toMatchObject({
      type: "cellular",
      metered: true,
      roaming: true,
      overDataLimit: true,
    });
    expect(net.parseConnection({ cost: 1, iana: 244 })).toMatchObject({ type: "cellular" });
  });

  it("an unknown cost is not 'metered' and not 'free', and an unlisted adapter type is 'unknown'", () => {
    expect(net.parseConnection({ cost: 0, iana: 71 })).toMatchObject({
      type: "wifi",
      metered: null,
    });
    expect(net.parseConnection({ cost: 1, iana: 131 })).toMatchObject({
      type: "unknown",
      metered: false,
    });
    expect(net.parseConnection({ cost: 1 })).toMatchObject({ type: null, metered: false });
  });

  it("no internet profile is disconnected with nothing else guessed", () => {
    expect(net.parseConnection({ none: true })).toEqual({
      connected: false,
      type: null,
      metered: null,
      roaming: null,
      overDataLimit: null,
    });
  });

  it("falls back to the active adapter's media type when the network list is not available", () => {
    expect(net.parseConnection(undefined, { media: "802.3" })).toMatchObject({
      type: "ethernet",
      metered: null,
      connected: true,
    });
    expect(net.parseConnection(undefined, { media: "Native 802.11" })).toMatchObject({
      type: "wifi",
    });
    expect(net.parseConnection(undefined, { media: "Wireless WAN" })).toMatchObject({
      type: "cellular",
    });
    expect(net.parseConnection(undefined, { media: "Tunnel" })).toMatchObject({ type: "unknown" });
    expect(net.parseConnection(undefined, { media: "" })).toMatchObject({
      type: null,
      connected: null,
    });
  });

  it("garbage is all null", () => {
    for (const bad of [null, undefined, "wifi", 7, [], [1, 2]]) {
      expect(net.parseConnection(bad, bad)).toEqual({
        connected: null,
        type: null,
        metered: null,
        roaming: null,
        overDataLimit: null,
      });
    }
    expect(net.parseConnection({ cost: "yes", iana: "wifi", roaming: "no" })).toMatchObject({
      type: null,
      metered: null,
      roaming: null,
    });
  });
});

describe("detectConnection: one asynchronous probe, cached", () => {
  const shell = (answer: string | Error | "hang") => {
    const scripts: string[] = [];
    const run = (script: string) => {
      scripts.push(script);
      if (answer === "hang") return new Promise(() => undefined);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ ok: true, stdout: answer, error: null });
    };
    return { run, scripts };
  };

  it("starts nothing off Windows", async () => {
    const fake = shell(WIFI_METERED);
    expect(await net.detectConnection({ platform: "linux", runPowerShell: fake.run })).toBeNull();
    expect(fake.scripts).toEqual([]);
  });

  it("reads the connection and runs the shared fragment exactly once inside one script", async () => {
    const fake = shell(WIFI_METERED);
    const got = await net.detectConnection({
      platform: "win32",
      runPowerShell: fake.run,
      now: 1000,
    });
    expect(got).toMatchObject({ type: "wifi", metered: true });
    expect(fake.scripts).toHaveLength(1);
    expect(fake.scripts[0]).toContain(net.CONNECTION_SCRIPT);
    expect(fake.scripts[0]).toContain("ConvertTo-Json");
  });

  it("answers from the cache for 30 seconds, then asks again; parallel callers share one run", async () => {
    const fake = shell(ETHERNET_FREE);
    await Promise.all(
      [1, 2, 3].map(() =>
        net.detectConnection({ platform: "win32", runPowerShell: fake.run, now: 5000 }),
      ),
    );
    expect(fake.scripts).toHaveLength(1);
    await net.detectConnection({ platform: "win32", runPowerShell: fake.run, now: 5000 + 29_000 });
    expect(fake.scripts).toHaveLength(1);
    await net.detectConnection({ platform: "win32", runPowerShell: fake.run, now: 5000 + 31_000 });
    expect(fake.scripts).toHaveLength(2);
  });

  it("a failing, throwing or unreadable shell gives null, never an exception", async () => {
    for (const answer of [new Error("spawn ENOENT"), "not json", "[]", ""]) {
      net.resetNetworkCaches();
      const fake = shell(answer);
      expect(await net.detectConnection({ platform: "win32", runPowerShell: fake.run })).toBeNull();
    }
    net.resetNetworkCaches();
    const sync = await net.detectConnection({
      platform: "win32",
      runPowerShell: () => {
        throw new Error("boom");
      },
    });
    expect(sync).toBeNull();
  });
});

describe("latency: only when the owner allows network, one endpoint, no timer", () => {
  it("never touches the network unless allowNetwork is exactly true", async () => {
    let calls = 0;
    const timed = async () => {
      calls += 1;
      return { ok: true, ms: 20 };
    };
    for (const allow of [false, undefined, "yes", 1, null]) {
      expect(await net.measureLatency({ allowNetwork: allow, timed })).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it("measures the first existing probe target once a minute", async () => {
    const asked: Rec[] = [];
    const timed = async (target: Rec) => {
      asked.push(target);
      return { ok: true, ms: 41 };
    };
    expect(await net.measureLatency({ allowNetwork: true, now: 1_000, timed })).toBe(41);
    expect(await net.measureLatency({ allowNetwork: true, now: 30_000, timed })).toBe(41);
    expect(asked).toEqual([net.PROBES[0]]);
    expect(await net.measureLatency({ allowNetwork: true, now: 62_000, timed })).toBe(41);
    expect(asked).toHaveLength(2);
  });

  it("a failed or throwing probe is null, and is not retried within the minute", async () => {
    let calls = 0;
    expect(
      await net.measureLatency({
        allowNetwork: true,
        now: 1,
        timed: async () => {
          calls += 1;
          return { ok: false, ms: null };
        },
      }),
    ).toBeNull();
    expect(
      await net.measureLatency({
        allowNetwork: true,
        now: 2,
        timed: async () => {
          calls += 1;
          return { ok: true, ms: 5 };
        },
      }),
    ).toBeNull();
    expect(calls).toBe(1);
    net.resetNetworkCaches();
    expect(
      await net.measureLatency({
        allowNetwork: true,
        timed: async () => {
          throw new Error("x");
        },
      }),
    ).toBeNull();
  });

  it("probeTimed reports the connect time in whole milliseconds and null on failure", async () => {
    let tick = 100;
    const clock = () => (tick += 37.4);
    expect(await net.probeTimed({ host: "h", port: 1 }, 100, async () => true, clock)).toEqual({
      ok: true,
      ms: 37,
    });
    expect(await net.probeTimed({ host: "h", port: 1 }, 100, async () => false, clock)).toEqual({
      ok: false,
      ms: null,
    });
    expect(
      await net.probeTimed(
        { host: "h", port: 1 },
        100,
        async () => {
          throw new Error("refused");
        },
        clock,
      ),
    ).toEqual({ ok: false, ms: null });
  });

  it("adds no timer and no new endpoint to the module", () => {
    const text = readFileSync(new URL("../../electron/net-status.cjs", import.meta.url), "utf8");
    expect(text).not.toMatch(/setInterval/);
    expect(net.PROBES).toHaveLength(3);
    const hosts = [...text.matchAll(/host:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(hosts).toEqual(["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
  });
});

describe("networkFacts", () => {
  it("is all not-measured before anything ran: online stays null until the first reachability check", async () => {
    expect(await net.networkFacts({})).toEqual({
      online: null,
      type: null,
      metered: null,
      roaming: null,
      latencyMs: null,
    });
  });

  it("combines the connection with the latency when allowed", async () => {
    const connection = net.parseConnection(JSON.parse(WIFI_METERED).net);
    const timed = async () => ({ ok: true, ms: 63 });
    expect(await net.networkFacts({ connection, allowNetwork: true, timed })).toEqual({
      online: null,
      type: "wifi",
      metered: true,
      roaming: false,
      latencyMs: 63,
    });
    net.resetNetworkCaches();
    expect(await net.networkFacts({ connection, allowNetwork: false, timed })).toMatchObject({
      latencyMs: null,
      type: "wifi",
    });
  });

  it("a disconnected profile says offline even before the first reachability check", async () => {
    const connection = net.parseConnection({ none: true });
    expect(await net.networkFacts({ connection })).toMatchObject({ online: false, type: null });
  });

  it("never throws on a corrupted connection", async () => {
    for (const connection of ["x", 5, [], { type: 5, metered: "yes" }]) {
      const facts = await net.networkFacts({ connection });
      expect(facts["metered"]).toBeNull();
    }
  });
});

describe("the shared PowerShell fragment", () => {
  it("is one line with no double quote or backtick, reads only, and starts nothing", () => {
    expect(net.CONNECTION_SCRIPT).not.toMatch(/[\r\n"`]/);
    expect(net.CONNECTION_SCRIPT).not.toMatch(
      /Invoke-|Start-Process|Set-|Remove-|New-|Out-File|\biex\b/i,
    );
    expect(net.CONNECTION_SCRIPT).toContain("GetConnectionCost");
    expect(net.CONNECTION_SCRIPT).toContain("IanaInterfaceType");
    expect(net.CONNECTION_SCRIPT).toContain("Get-NetAdapter -Physical");
  });
});
