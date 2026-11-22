/**
 * The echo-shadow bridge: renderer echoShadow -> preload -> voice:echo-shadow -> neuralVoice.echoShadow -> the
 * persistent worker op echo-shadow (kernel/voice_runtime.py). It measures only: levels come back, audio never does,
 * and nothing is written or logged. The Python side is kernel/tests/test_echo_shadow.py.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(__dirname, "..", "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

const neuralVoice = require_("../../electron/neural-voice.cjs");
const budget = require_("../../electron/ipc-budget-table.cjs");

const CHANNEL = "voice:echo-shadow";
/** 160 ms of 16 kHz int16 mono, as base64. */
const chunk = (fill = 1200, samples = 2560) =>
  Buffer.from(new Int16Array(samples).fill(fill).buffer).toString("base64");

type Sent = Record<string, unknown>;

function rig(reply: unknown = { ok: true, ready: true }) {
  const sent: Sent[] = [];
  const timeouts: number[] = [];
  const clock = { t: 10_000 };
  let py = 0;
  const echoShadow = neuralVoice.createEchoShadow({
    resolvePy: async () => {
      py += 1;
      return ["python", []];
    },
    request: async (_py: unknown, payload: Sent, timeoutMs: number) => {
      sent.push(payload);
      timeouts.push(timeoutMs);
      return typeof reply === "function" ? (reply as (p: Sent) => unknown)(payload) : reply;
    },
    now: () => clock.t,
  });
  return { echoShadow, sent, timeouts, clock, pythonAsked: () => py };
}

describe("echo-shadow wiring", () => {
  it("registers one handler, one preload entry, one stream budget row and one renderer type", () => {
    const main = read("electron/main.cjs");
    expect(main.match(new RegExp(`ipcMain\\.handle\\("${CHANNEL}"`, "g"))).toHaveLength(1);
    expect(main).toMatch(
      /ipcMain\.handle\("voice:echo-shadow", \(_e, payload\) =>\s*neuralVoice\.echoShadow\(payload \|\| \{\}\)/,
    );
    const preload = read("electron/preload.cjs");
    expect(preload.match(/voice:echo-shadow/g)).toHaveLength(1);
    expect(preload).toMatch(
      /echoShadow: \(payload\) => ipcRenderer\.invoke\("voice:echo-shadow", payload\)/,
    );
    expect(budget.CHANNEL_CLASS[CHANNEL]).toBe("stream");
    expect(budget.budgetFor(CHANNEL).class).toBe("stream");
    expect(read("src/lib/friday/desktop.ts")).toMatch(/\bechoShadow\?: \(payload: \{/);
    // The speak channels keep their classes and handlers.
    expect(budget.CHANNEL_CLASS["voice:neural-speak-pcm"]).toBe("stream");
    expect(main).toMatch(/ipcMain\.handle\("voice:neural-speak-pcm"/);
    expect(typeof neuralVoice.echoShadow).toBe("function");
  });

  it("the worker answers the op the bridge sends", () => {
    expect(read("kernel/voice_runtime.py")).toMatch(/elif op == "echo-shadow":/);
    expect(read("electron/neural-voice.cjs")).toMatch(/op: "echo-shadow"/);
  });
});

describe("echo-shadow request", () => {
  it("sends only the allowed fields to the worker and returns levels, never audio", async () => {
    const mic = chunk(900);
    const ref = chunk(-700);
    const { echoShadow, sent, timeouts } = rig({
      ok: true,
      ready: true,
      playing: true,
      cancelled: true,
      micDb: -24.1,
      residualDb: -38.4,
      reductionDb: 14.3,
      delayMs: 80,
      confidence: 0.9,
      gate: false,
      seq: 3,
      pcm16: "AAAA",
      audio: "AAAA",
    });
    const result = await echoShadow({ mic, ref, reset: true, seq: 3, extra: "x" });
    expect(sent).toEqual([{ op: "echo-shadow", mic, ref, reset: true, seq: 3 }]);
    expect(timeouts[0]).toBeGreaterThanOrEqual(5000);
    expect(result).toEqual({
      ok: true,
      engine: "local",
      cloud: false,
      ready: true,
      playing: true,
      cancelled: true,
      micDb: -24.1,
      residualDb: -38.4,
      reductionDb: 14.3,
      delayMs: 80,
      confidence: 0.9,
      gate: false,
      seq: 3,
    });
    expect(JSON.stringify(result)).not.toMatch(/AAAA|pcm|audio/i);
  });

  it("sends a mic-only chunk without ref or reset and reports an unavailable canceller as not ready", async () => {
    const { echoShadow, sent } = rig({ ok: false, ready: false, reason: "pyaec-missing" });
    const result = await echoShadow({ mic: chunk() });
    expect(sent).toEqual([{ op: "echo-shadow", mic: chunk() }]);
    expect(result).toMatchObject({
      ok: false,
      ready: false,
      engine: "local",
      cloud: false,
      reason: "pyaec-missing",
    });
    const ok = await rig({ ok: true, ready: true, reductionDb: null }).echoShadow({
      mic: chunk(),
    });
    expect(ok.reductionDb).toBeNull();
    expect(ok.gate).toBe(false);
  });

  it("answers a dead worker and a missing Python without throwing", async () => {
    const dead = await rig(null).echoShadow({ mic: chunk() });
    expect(dead).toMatchObject({ ok: false, ready: false, cloud: false });
    const noPython = neuralVoice.createEchoShadow({ resolvePy: async () => null });
    expect(await noPython({ mic: chunk() })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Python/),
    });
  });

  it("never lets a worker value that is not a finite number through", async () => {
    const { echoShadow } = rig({
      ok: true,
      ready: true,
      micDb: "loud",
      residualDb: Infinity,
      reductionDb: "x",
      delayMs: null,
      confidence: {},
      gate: true,
    });
    const result = await echoShadow({ mic: chunk() });
    expect(result).toMatchObject({
      micDb: 0,
      residualDb: 0,
      reductionDb: null,
      delayMs: 0,
      confidence: 0,
      gate: false,
    });
  });
});

describe("echo-shadow input is validated before the worker or Python is touched", () => {
  const bad: Array<[string, unknown, string]> = [
    ["undefined", undefined, "bad-request"],
    ["null", null, "bad-request"],
    ["a string", "mic", "bad-request"],
    ["an array", [chunk()], "bad-request"],
    ["a class instance", new (class Q {})(), "bad-request"],
    ["a missing mic", {}, "bad-audio"],
    ["a mic that is not a string", { mic: 5 }, "bad-audio"],
    ["a mic String object", { mic: new String(chunk()) }, "bad-audio"],
    ["a mic Buffer", { mic: Buffer.from(chunk(), "base64") }, "bad-audio"],
    ["a mic Uint8Array", { mic: new Uint8Array(5120) }, "bad-audio"],
    ["a mic that is not base64", { mic: "not base64 !!!" }, "bad-audio"],
    ["a mic of path characters", { mic: "../../../etc/passwd" }, "bad-audio"],
    ["a mic with padding in the middle", { mic: "AAAA=AAA" }, "bad-audio"],
    ["a mic of an odd byte count", { mic: Buffer.alloc(3).toString("base64") }, "bad-audio"],
    ["a mic of one byte", { mic: Buffer.alloc(1).toString("base64") }, "bad-audio"],
    ["an oversized mic", { mic: chunk(1, 6000) }, "bad-audio"],
    ["a ref that is not base64", { mic: chunk(), ref: "%%%%" }, "bad-audio"],
    ["a ref that is not a string", { mic: chunk(), ref: { a: 1 } }, "bad-audio"],
    ["a ref of another length", { mic: chunk(), ref: chunk(1, 1000) }, "length-mismatch"],
    ["a reset that is not boolean", { mic: chunk(), reset: "true" }, "bad-request"],
    ["a seq that is not an integer", { mic: chunk(), seq: 1.5 }, "bad-request"],
    ["a seq string", { mic: chunk(), seq: "1" }, "bad-request"],
  ];
  for (const [label, payload, reason] of bad) {
    it(`rejects ${label}`, async () => {
      const { echoShadow, sent, pythonAsked } = rig();
      const result = await echoShadow(payload);
      expect(result).toMatchObject({ ok: false, engine: "local", cloud: false, reason });
      expect(sent).toHaveLength(0);
      expect(pythonAsked()).toBe(0);
    });
  }

  it("accepts a full 160 ms chunk (6828 characters) and refuses past the cap", async () => {
    expect(chunk().length).toBe(6828);
    expect(neuralVoice.ECHO_SHADOW_MAX_B64).toBeGreaterThanOrEqual(6828);
    expect(neuralVoice.ECHO_SHADOW_MAX_B64).toBeLessThanOrEqual(8192);
    const { echoShadow, sent } = rig();
    expect((await echoShadow({ mic: chunk(), ref: chunk() })).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("ignores a hostile prototype and an inherited field", async () => {
    const { echoShadow, sent } = rig();
    const inherited = Object.create({ mic: chunk() });
    expect(await echoShadow(inherited)).toMatchObject({ ok: false, reason: "bad-request" });
    expect(
      await echoShadow(JSON.parse(`{"__proto__":{"mic":"x"},"mic":"${chunk()}"}`)),
    ).toMatchObject({
      ok: true,
    });
    expect(Object.keys(sent[0] ?? {}).sort()).toEqual(["mic", "op"]);
  });
});

describe("echo-shadow rate limit", () => {
  it("answers rate-limited without hitting the worker inside 160 ms, then lets the next chunk through", async () => {
    const { echoShadow, sent, clock, pythonAsked } = rig();
    expect(neuralVoice.ECHO_SHADOW_MIN_GAP_MS).toBe(160);
    expect((await echoShadow({ mic: chunk() })).ok).toBe(true);
    clock.t += 159;
    const early = await echoShadow({ mic: chunk() });
    expect(early).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(sent).toHaveLength(1);
    expect(pythonAsked()).toBe(1);
    clock.t += 1;
    expect((await echoShadow({ mic: chunk() })).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("a refused call does not push the window out, and a malformed call does not use it up", async () => {
    const { echoShadow, sent, clock } = rig();
    expect(await echoShadow({ mic: "bad" })).toMatchObject({ reason: "bad-audio" });
    expect((await echoShadow({ mic: chunk() })).ok).toBe(true);
    clock.t += 100;
    expect(await echoShadow({ mic: chunk() })).toMatchObject({ reason: "rate-limited" });
    clock.t += 60;
    expect((await echoShadow({ mic: chunk() })).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("allows one call in flight: a burst while the worker is busy never queues behind it", async () => {
    let release: (value: unknown) => void = () => undefined;
    const sent: Sent[] = [];
    const clock = { t: 0 };
    const echoShadow = neuralVoice.createEchoShadow({
      resolvePy: async () => ["python", []],
      request: (_py: unknown, payload: Sent) => {
        sent.push(payload);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      now: () => clock.t,
    });
    const first = echoShadow({ mic: chunk() });
    await Promise.resolve();
    clock.t += 1000;
    const second = await echoShadow({ mic: chunk() });
    expect(second).toMatchObject({ ok: false, reason: "rate-limited" });
    release({ ok: true, ready: true });
    expect((await first).ok).toBe(true);
    clock.t += 1000;
    const third = echoShadow({ mic: chunk() });
    await Promise.resolve();
    await Promise.resolve();
    release({ ok: true, ready: true });
    expect((await third).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("frees the window after a worker failure", async () => {
    const clock = { t: 0 };
    let call = 0;
    const echoShadow = neuralVoice.createEchoShadow({
      resolvePy: async () => ["python", []],
      request: async () => {
        call += 1;
        if (call === 1) throw new Error("pipe closed");
        return { ok: true, ready: true };
      },
      now: () => clock.t,
    });
    await expect(echoShadow({ mic: chunk() })).rejects.toThrow("pipe closed");
    clock.t += 200;
    expect((await echoShadow({ mic: chunk() })).ok).toBe(true);
  });
});

describe("echo-shadow keeps audio private", () => {
  const source = read("electron/neural-voice.cjs");
  const start = source.indexOf("const ECHO_SHADOW_MIN_GAP_MS");
  const end = source.indexOf("const echoShadow = createEchoShadow()");
  const body = source.slice(start, end);

  it("the bridge code exists and is local only", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).not.toMatch(/speakCloud|speakSystem|speakLocal|edge|fetch\(|https?:|net\./);
    expect(body).not.toMatch(/createHash|cacheDir|tmpdir|os\./);
  });

  it("neither the bridge, its handler nor its preload entry writes to disk or logs", () => {
    expect(body).not.toMatch(
      /\bfs\b|writeFile|appendFile|createWriteStream|mkdtemp|\bconsole\b|\blog\(|logger|audit|process\.stdout|process\.stderr/,
    );
    const main = read("electron/main.cjs");
    const handler = main.slice(main.indexOf(`ipcMain.handle("${CHANNEL}"`)).split("\n")[0] ?? "";
    expect(handler).toMatch(/neuralVoice\.echoShadow\(payload \|\| \{\}\)/);
    expect(handler).not.toMatch(/log\(|writeFile|console/);
    const preload = read("electron/preload.cjs");
    const entry = preload.slice(preload.indexOf("echoShadow:")).split("\n")[0] ?? "";
    expect(entry).not.toMatch(/log|write|console/);
  });

  it("is off unless the renderer asks: no startup, timer or caller inside the Electron side", () => {
    expect(body).not.toMatch(/setInterval|setTimeout|app\.on|whenReady/);
    for (const file of ["electron/main.cjs", "electron/preload.cjs"]) {
      const text = read(file);
      expect(text.match(/echoShadow/g) ?? []).toHaveLength(1);
    }
    const others = fs
      .readdirSync(path.join(root, "electron"))
      .filter(
        (f) =>
          f.endsWith(".cjs") &&
          !["neural-voice.cjs", "main.cjs", "preload.cjs", "ipc-budget-table.cjs"].includes(f),
      );
    for (const file of others) {
      expect(read(`electron/${file}`), file).not.toMatch(/echoShadow|echo-shadow/);
    }
  });
});
