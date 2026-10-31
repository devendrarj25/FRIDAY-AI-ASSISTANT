import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const probe = require_(path.resolve(import.meta.dirname, "../../electron/download-probe.cjs"));

/** A fake host that sends `total` bytes in chunks, taking `msPerChunk` of fake time for each. */
function host(clock: { t: number }, total: number, msPerChunk: number, status = 206) {
  return async () => ({
    ok: status < 400,
    status,
    body: {
      getReader: () => {
        let sent = 0;
        return {
          read: async () => {
            if (sent >= total) return { done: true, value: undefined };
            clock.t += msPerChunk;
            sent += 65536;
            return { done: false, value: new Uint8Array(65536) };
          },
          cancel: async () => undefined,
        };
      },
    },
  });
}

describe("download rate probe", () => {
  it("measures bytes per second from the first byte", async () => {
    const clock = { t: 0 };
    const out = await probe.probeRate("https://a.example/x", {
      fetchImpl: host(clock, 262144, 100),
      now: () => clock.t,
    });
    expect(out.ok).toBe(true);
    expect(out.bps).toBeGreaterThan(500_000);
  });

  it("orders mirrors fastest first and keeps failures after them", async () => {
    const clock = { t: 0 };
    const hosts: Record<string, ReturnType<typeof host>> = {
      "https://slow.example/f": host(clock, 262144, 400),
      "https://fast.example/f": host(clock, 262144, 20),
      "https://down.example/f": host(clock, 0, 0, 503),
    };
    const fetchImpl = (url: string) => hosts[url]!();
    const out = await probe.orderByRate(Object.keys(hosts), { fetchImpl, now: () => clock.t });
    expect(out.urls).toEqual([
      "https://fast.example/f",
      "https://slow.example/f",
      "https://down.example/f",
    ]);
  });

  it("changes nothing for one source, and nothing when every probe fails", async () => {
    expect((await probe.orderByRate(["https://only.example/f"])).urls).toEqual([
      "https://only.example/f",
    ]);
    const fail = async () => {
      throw new Error("offline");
    };
    const urls = ["https://a.example/f", "https://b.example/f"];
    expect((await probe.orderByRate(urls, { fetchImpl: fail })).urls).toEqual(urls);
  });

  it("drops repeated and empty entries", async () => {
    const out = await probe.orderByRate(["https://a.example/f", "", "https://a.example/f"]);
    expect(out.urls).toEqual(["https://a.example/f"]);
  });
});
