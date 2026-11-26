import { describe, expect, it, vi } from "vitest";
import { EchoCanceller } from "../../src/lib/friday/voice-engine/audio-aec";

const RATE = 16_000;

/** Deterministic noise so the test is the same on every machine. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff - 0.5;
  };
}

/** Speech-like far end: noise with a syllable-rate loudness envelope and pauses. */
function farEnd(seconds: number, seed = 1): Float32Array {
  const rand = rng(seed);
  const n = seconds * RATE;
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const env =
      Math.max(0, Math.sin(2 * Math.PI * 3.2 * t)) *
      (Math.sin(2 * Math.PI * 0.4 * t) > -0.6 ? 1 : 0);
    lp = lp * 0.55 + rand() * 0.9; // a little colour, like a voice
    out[i] = lp * env * 0.9;
  }
  return out;
}

/** A room: a delay and a decaying, mixed-sign response. */
function room(delayMs: number, gain = 0.6) {
  const delay = Math.round((delayMs / 1000) * RATE);
  const h = new Float32Array(200);
  const rand = rng(7);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 30) * (k === 0 ? 1 : rand() * 1.6);
  return (far: Float32Array): Float32Array => {
    const out = new Float32Array(far.length);
    for (let i = 0; i < far.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < h.length; k += 1) {
        const j = i - delay - k;
        if (j >= 0) acc += h[k]! * far[j]!;
      }
      out[i] = acc;
    }
    return out;
  };
}

function run(echo: EchoCanceller, far: Float32Array, near: Float32Array, frame = 320) {
  echo.pushReference(0, far);
  const out = new Float32Array(near.length);
  for (let at = 0; at < near.length; at += frame)
    out.set(echo.process(near.subarray(at, at + frame), at), at);
  return out;
}

const power = (a: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i += 1) s += a[i]! * a[i]!;
  return s / Math.max(1, to - from);
};
const db = (ratio: number) => 10 * Math.log10(ratio);

describe("echo canceller (simulated rooms only)", () => {
  it("finds a 90 ms bulk delay and removes most of the echo", () => {
    const far = farEnd(8);
    const near = room(90)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    const last = { from: 6 * RATE, to: 8 * RATE };
    const erle = db(power(near, last.from, last.to) / power(out, last.from, last.to));
    expect(erle).toBeGreaterThan(15);
    expect(Math.abs(echo.stats().delayMs - 90)).toBeLessThan(40);
    expect(echo.stats().erleDb).not.toBeNull();
  });

  it("copes with a long delay of 250 ms", () => {
    const far = farEnd(9, 3);
    const near = room(250, 0.5)(far);
    const out = run(new EchoCanceller({ rate: RATE }), far, near);
    expect(db(power(near, 7 * RATE, 9 * RATE) / power(out, 7 * RATE, 9 * RATE))).toBeGreaterThan(
      12,
    );
  });

  it("keeps the owner's voice while she is talking over the echo (double talk)", () => {
    const far = farEnd(10, 5);
    const echoOnly = room(70)(far);
    const talk = new Float32Array(far.length);
    for (let i = 6 * RATE; i < 9 * RATE; i += 1)
      talk[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / RATE);
    const near = Float32Array.from(echoOnly, (v, i) => v + talk[i]!);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    // while she talks, her tone must survive at close to full strength
    const kept = power(out, 6.5 * RATE, 8.5 * RATE) / power(talk, 6.5 * RATE, 8.5 * RATE);
    expect(kept).toBeGreaterThan(0.6);
    expect(kept).toBeLessThan(1.8);
    expect(echo.stats().doubleTalkFrames).toBeGreaterThan(0);
    // before she talked, the echo was already low
    expect(db(power(near, 4 * RATE, 6 * RATE) / power(out, 4 * RATE, 6 * RATE))).toBeGreaterThan(
      12,
    );
  });

  it("passes a microphone with no playback through unchanged", () => {
    const near = Float32Array.from(
      { length: 2 * RATE },
      (_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / RATE),
    );
    const out = run(new EchoCanceller({ rate: RATE }), new Float32Array(0), near);
    expect(power(out, 0, near.length)).toBeCloseTo(power(near, 0, near.length), 6);
  });

  it("does not learn the owner's voice as echo when nothing is playing", () => {
    const echo = new EchoCanceller({ rate: RATE });
    const near = Float32Array.from(
      { length: 3 * RATE },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE),
    );
    const out = run(echo, new Float32Array(0), near);
    expect(power(out, 2 * RATE, 3 * RATE) / power(near, 2 * RATE, 3 * RATE)).toBeGreaterThan(0.95);
    expect(echo.stats().erleDb).toBeNull();
  });

  it("never makes the signal louder than it came in, and can be reset", () => {
    const far = farEnd(4, 9);
    const near = room(40)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const out = run(echo, far, near);
    expect(power(out, 0, out.length)).toBeLessThan(power(near, 0, near.length) * 1.01);
    echo.reset();
    expect(echo.stats()).toMatchObject({ delayMs: 0, erleDb: null, processedSamples: 0 });
  });

  it("is fast enough for real time", () => {
    const far = farEnd(2, 2);
    const near = room(60)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const t0 = performance.now();
    run(echo, far, near);
    const ms = performance.now() - t0;
    // two seconds of audio must take well under two seconds on any machine that runs the suite
    expect(ms).toBeLessThan(1500);
  });
});

describe("echo canceller with a reference supplied per frame", () => {
  it("gives the same answer as pushing the reference first, and removes the echo", () => {
    const far = farEnd(8);
    const near = room(90)(far);
    const frame = 320;
    const pushed = run(new EchoCanceller({ rate: RATE }), far, near, frame);
    const live = new EchoCanceller({ rate: RATE });
    const out = new Float32Array(near.length);
    for (let at = 0; at < near.length; at += frame)
      out.set(
        live.processWithReference(near.subarray(at, at + frame), far.subarray(at, at + frame)),
        at,
      );
    expect(Array.from(out)).toEqual(Array.from(pushed));
    expect(live.nextNearIndex()).toBe(near.length);
    expect(db(power(near, 6 * RATE, 8 * RATE) / power(out, 6 * RATE, 8 * RATE))).toBeGreaterThan(
      15,
    );
  });

  it("without a reference it is the plain process, frame for frame", () => {
    const near = room(60)(farEnd(3, 4));
    const a = new EchoCanceller({ rate: RATE });
    const b = new EchoCanceller({ rate: RATE });
    for (let at = 0; at < near.length; at += 320) {
      const part = near.subarray(at, at + 320);
      expect(Array.from(a.processWithReference(part, null, at))).toEqual(
        Array.from(b.process(part, at)),
      );
    }
    expect(a.stats()).toEqual(b.stats());
  });

  it("honours an explicit start index after a stretch with no frames", () => {
    const echo = new EchoCanceller({ rate: RATE });
    echo.processWithReference(new Float32Array(320), null, 1000);
    expect(echo.nextNearIndex()).toBe(1320);
    echo.processWithReference(new Float32Array(320), new Float32Array(320).fill(0.1), 5000);
    expect(echo.nextNearIndex()).toBe(5320);
  });
});

/** Same as `run`, with the reference arriving frame by frame like the live path (the reference ring is bounded). */
function runLive(echo: EchoCanceller, far: Float32Array, near: Float32Array, frame = 320) {
  const out = new Float32Array(near.length);
  for (let at = 0; at < near.length; at += frame) {
    echo.pushReference(at, far.subarray(at, at + frame));
    out.set(echo.process(near.subarray(at, at + frame), at), at);
  }
  return out;
}

const erle = (near: Float32Array, out: Float32Array, from: number, to: number) =>
  db(power(near, from * RATE, to * RATE) / power(out, from * RATE, to * RATE));

/** Add deterministic microphone noise (uniform, about -50 dBFS peak). */
const withNoise = (x: Float32Array, amount = 0.004, seed = 99): Float32Array => {
  const r = rng(seed);
  return Float32Array.from(x, (v) => v + amount * r());
};

/** Project `out` on `ref`: how much of `ref` is in `out` (1 is all of it, untouched). */
const kept = (out: Float32Array, ref: Float32Array, from: number, to: number) => {
  let dot = 0;
  let refPower = 0;
  for (let i = from * RATE; i < to * RATE; i += 1) {
    dot += out[i]! * ref[i]!;
    refPower += ref[i]! * ref[i]!;
  }
  return dot / refPower;
};

/**
 * A room whose far end is warped by a clock offset of `eps` (the echo arrives later and later when positive),
 * done with a windowed-sinc interpolation so the simulated path is a clean resampling, not a lossy one.
 */
function driftRoom(delayMs: number, eps: number, gain = 0.6) {
  const delay = Math.round((delayMs / 1000) * RATE);
  const h = new Float32Array(200);
  const rand = rng(7);
  for (let k = 0; k < h.length; k += 1)
    h[k] = gain * Math.exp(-k / 30) * (k === 0 ? 1 : rand() * 1.6);
  const sincAt = (x: Float32Array, pos: number): number => {
    const p0 = Math.floor(pos);
    const f = pos - p0;
    let acc = 0;
    for (let t = -11; t <= 12; t += 1) {
      const j = p0 + t;
      if (j < 0 || j >= x.length) continue;
      const u = t - f;
      const win = 0.5 + 0.5 * Math.cos((Math.PI * u) / 12.5);
      acc += x[j]! * (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * win;
    }
    return acc;
  };
  return (far: Float32Array): Float32Array => {
    const warped = Float32Array.from({ length: far.length }, (_, i) => sincAt(far, i - eps * i));
    const out = new Float32Array(far.length);
    for (let i = 0; i < far.length; i += 1) {
      let acc = 0;
      for (let k = 0; k < h.length; k += 1) {
        const j = i - delay - k;
        if (j >= 0) acc += h[k]! * warped[j]!;
      }
      out[i] = acc;
    }
    return out;
  };
}

describe(
  "echo canceller upgrade: faster and better than before (simulated rooms only)",
  { timeout: 30_000 },
  () => {
    // Echo reduction over the 3 to 6 s window (after the 2.5 s warm-up) of the canceller as it was before this
    // upgrade (a loudness-envelope delay search and a plain NLMS filter), measured on these very rooms.
    const before = [
      ["90 ms, seed 1", { ms: 90, gain: 0.6, seed: 1, seconds: 8 }, 18.4],
      ["250 ms, seed 3", { ms: 250, gain: 0.5, seed: 3, seconds: 9 }, 21.4],
      ["40 ms, seed 9", { ms: 40, gain: 0.6, seed: 9, seconds: 8 }, 20.5],
    ] as const;

    it.each(before)("takes at least 3 dB more echo out than before: %s", (_name, r, was) => {
      const far = farEnd(r.seconds, r.seed);
      const near = room(r.ms, r.gain)(far);
      const out = runLive(new EchoCanceller({ rate: RATE }), far, near);
      expect(erle(near, out, 3, 6)).toBeGreaterThanOrEqual(was + 3);
      // and what it gains is not paid for later
      expect(erle(near, out, r.seconds - 2, r.seconds)).toBeGreaterThan(30);
    });

    it("still takes at least 3 dB more out with microphone noise on top", () => {
      const far = farEnd(8, 1);
      const clean = room(90)(far);
      const out = runLive(new EchoCanceller({ rate: RATE }), far, withNoise(clean));
      expect(erle(clean, out, 3, 6)).toBeGreaterThanOrEqual(18.3 + 3);
    });

    it("locks onto the bulk delay within a second of echo, from the first audible reference", () => {
      const far = farEnd(3, 1);
      const near = room(120)(far);
      const echo = new EchoCanceller({ rate: RATE });
      let lockedAt = -1;
      for (let at = 0; at < near.length; at += 320) {
        echo.pushReference(at, far.subarray(at, at + 320));
        echo.process(near.subarray(at, at + 320), at);
        if (lockedAt < 0 && echo.stats().delayMs > 0) lockedAt = at / RATE;
      }
      expect(lockedAt).toBeGreaterThan(0);
      expect(lockedAt).toBeLessThanOrEqual(1);
    });
  },
);

describe("echo canceller: FFT cross-correlation delay search", { timeout: 30_000 }, () => {
  it.each([37, 123, 310, 480])("finds a %i ms bulk delay to within 2 ms", (ms) => {
    const far = farEnd(4, 21 + ms);
    const near = room(ms, 0.5)(far);
    const echo = new EchoCanceller({ rate: RATE });
    runLive(echo, far, near);
    const stats = echo.stats();
    // the filter starts a quarter of its length before the arrival, so the arrival is the delay plus 8 ms
    expect(Math.abs(stats.delayMs + 8 - ms)).toBeLessThanOrEqual(2);
    expect(stats.delaySearch.best).toBeGreaterThan(6);
    expect(stats.delaySearch.best).toBeGreaterThan(stats.delaySearch.second);
  });

  it("does not lock onto a microphone that has nothing to do with the reference", () => {
    const far = farEnd(5, 4);
    const unrelated = Float32Array.from({ length: far.length }, (_, i) => rng(77 + i)() * 0.2);
    const unrelatedNoise = (() => {
      const r = rng(1234);
      return Float32Array.from({ length: far.length }, () => r() * 0.4);
    })();
    void unrelated;
    const echo = new EchoCanceller({ rate: RATE });
    const out = runLive(echo, far, unrelatedNoise);
    expect(echo.stats().delayMs).toBe(0);
    expect(echo.stats().erleDb).toBeNull();
    expect(Array.from(out)).toEqual(Array.from(unrelatedNoise));
  });

  it("finds the delay with the owner's voice already on the line (double talk from the start)", () => {
    const far = farEnd(5, 6);
    const echoOnly = room(90)(far);
    const near = Float32Array.from(
      echoOnly,
      (v, i) => v + 0.05 * Math.sin((2 * Math.PI * 300 * i) / RATE),
    );
    const echo = new EchoCanceller({ rate: RATE });
    runLive(echo, far, near);
    expect(Math.abs(echo.stats().delayMs + 8 - 90)).toBeLessThanOrEqual(2);
  });
});

describe("echo canceller: warm-up, freezes and double talk", { timeout: 30_000 }, () => {
  it("passes the microphone through unchanged during the warm-up until the filter has converged", () => {
    const far = farEnd(6, 1);
    const near = room(90)(far);
    const echo = new EchoCanceller({ rate: RATE });
    let passedWhileWarm = 0;
    let warmFrames = 0;
    let sawWarmEnd = false;
    for (let at = 0; at < near.length; at += 320) {
      echo.pushReference(at, far.subarray(at, at + 320));
      const frame = near.subarray(at, at + 320);
      const warm = echo.stats().warmingUp;
      const out = echo.process(frame, at);
      if (warm) {
        warmFrames += 1;
        if (Array.from(out).every((v, i) => v === frame[i])) passedWhileWarm += 1;
      } else if (echo.stats().converged) sawWarmEnd = true;
    }
    expect(warmFrames).toBeGreaterThan(5);
    expect(passedWhileWarm).toBe(warmFrames);
    expect(sawWarmEnd).toBe(true);
    expect(echo.stats().warmingUp).toBe(false);
  });

  it("the warm-up never lasts past 2.5 s of audible reference, converged or not", () => {
    const far = farEnd(5, 1);
    // a microphone that is mostly the owner: the filter never converges on it
    const near = Float32Array.from(
      room(90, 0.05)(far),
      (v, i) => v + 0.3 * Math.sin((2 * Math.PI * 233 * i) / RATE),
    );
    const echo = new EchoCanceller({ rate: RATE });
    runLive(echo, far, near);
    expect(echo.stats().warmingUp).toBe(false);
    const off = new EchoCanceller({ rate: RATE, warmupMs: 0 });
    for (let at = 0; at < 2 * RATE; at += 320) {
      off.pushReference(at, far.subarray(at, at + 320));
      off.process(near.subarray(at, at + 320), at);
    }
    expect(off.stats().warmingUp).toBe(false);
  });

  it("keeps what it learned while the reference is silent and the owner talks alone", () => {
    const far = farEnd(14, 8);
    // 4 s of silence in the reference from 6 s; the owner speaks over that stretch
    for (let i = 6 * RATE; i < 10 * RATE; i += 1) far[i] = 0;
    const echoOnly = room(70)(far);
    const talk = Float32Array.from({ length: far.length }, (_, i) =>
      i >= 6 * RATE && i < 10 * RATE
        ? 0.25 * Math.sin((2 * Math.PI * 190 * i) / RATE) * Math.sin((2 * Math.PI * 3 * i) / RATE)
        : 0,
    );
    const near = Float32Array.from(echoOnly, (v, i) => v + talk[i]!);
    const out = runLive(new EchoCanceller({ rate: RATE }), far, near);
    expect(erle(echoOnly, out, 4, 6)).toBeGreaterThan(25);
    // she talked alone: her voice goes through untouched
    expect(kept(out, talk, 6.5, 9.5)).toBeGreaterThan(0.98);
    // and the room is still known the moment the reference is back
    expect(erle(echoOnly, out, 10.5, 12)).toBeGreaterThan(25);
  });

  it.each([false, true])(
    "never cancels the owner out while she talks over the echo (suppressor %s): 90% or more kept",
    (suppressor) => {
      const far = farEnd(12, 5);
      const echoOnly = room(70)(far);
      const talk = new Float32Array(far.length);
      const r = rng(5);
      for (let i = 6 * RATE; i < 9 * RATE; i += 1)
        talk[i] =
          0.2 * Math.sin((2 * Math.PI * 300 * i) / RATE) +
          0.15 *
            Math.sin((2 * Math.PI * 1100 * i) / RATE) *
            (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / RATE)) +
          0.05 * r();
      const near = Float32Array.from(echoOnly, (v, i) => v + talk[i]!);
      const echo = new EchoCanceller({ rate: RATE, suppressor });
      const out = runLive(echo, far, near);
      const keptFraction = kept(out, talk, 6.5, 8.5);
      expect(keptFraction).toBeGreaterThanOrEqual(0.9);
      expect(keptFraction).toBeLessThan(1.15);
      // no divergence: the loudness of the output over the burst is not above what came in
      expect(power(out, 6.5 * RATE, 8.5 * RATE)).toBeLessThan(
        power(near, 6.5 * RATE, 8.5 * RATE) * 1.05,
      );
      expect(echo.stats().doubleTalkFrames).toBeGreaterThan(0);
      // the echo is still being taken out before and after the burst
      expect(erle(echoOnly, out, 4, 6)).toBeGreaterThan(20);
      expect(erle(echoOnly, out, 10, 12)).toBeGreaterThan(20);
    },
  );
});

describe("echo canceller: residual suppressor (behind a flag)", { timeout: 30_000 }, () => {
  it("is off by default and then reports no suppression", () => {
    const far = farEnd(6, 1);
    const echo = new EchoCanceller({ rate: RATE });
    runLive(echo, far, room(90)(far));
    expect(echo.stats().suppressionDb).toBe(0);
  });

  it("takes more of the leftover echo out when it is on, and never makes the signal louder", () => {
    const far = farEnd(9, 1);
    const clean = room(90)(far);
    const near = withNoise(clean, 0.002);
    // a filter a little short for the room leaves a residual for the suppressor to work on
    const shortFilter = { rate: RATE, taps: 160 };
    const off = runLive(new EchoCanceller(shortFilter), far, near);
    const echo = new EchoCanceller({ ...shortFilter, suppressor: true });
    const on = runLive(echo, far, near);
    expect(erle(clean, on, 3, 9)).toBeGreaterThan(erle(clean, off, 3, 9) + 6);
    expect(power(on, 0, on.length)).toBeLessThan(power(near, 0, near.length) * 1.01);
    expect(echo.stats().suppressionDb).toBeGreaterThanOrEqual(0);
  });

  it("lets the owner through when she starts to talk over a settled echo", () => {
    const far = farEnd(10, 1);
    const clean = room(90)(far);
    const talk = Float32Array.from({ length: far.length }, (_, i) =>
      i >= 7 * RATE ? 0.2 * Math.sin((2 * Math.PI * 450 * i) / RATE) : 0,
    );
    const near = Float32Array.from(clean, (v, i) => v + talk[i]!);
    const out = runLive(new EchoCanceller({ rate: RATE, suppressor: true }), far, near);
    // the first 100 ms of her voice already come through at close to full strength
    expect(kept(out, talk, 7.1, 7.6)).toBeGreaterThan(0.85);
    expect(kept(out, talk, 8, 9.5)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("echo canceller: clock drift", { timeout: 30_000 }, () => {
  const SECONDS = 16;
  it.each([150e-6, -100e-6])(
    "follows a clock offset of %d: reports the ppm and keeps the echo down",
    (eps) => {
      const far = farEnd(SECONDS, 11);
      const near = driftRoom(90, eps)(far);
      const tracked = new EchoCanceller({ rate: RATE, taps: 256 });
      const out = runLive(tracked, far, near);
      const loose = new EchoCanceller({ rate: RATE, taps: 256, driftTracking: false });
      const outLoose = runLive(loose, far, near);
      const ppm = tracked.stats().driftPpm;
      expect(Math.abs(ppm - eps * 1e6)).toBeLessThanOrEqual(Math.abs(eps * 1e6) * 0.15);
      expect(loose.stats().driftPpm).toBe(0);
      // without the tracker the room is lost; with it the echo stays well down
      expect(erle(near, outLoose, 10, SECONDS)).toBeLessThan(3);
      expect(erle(near, out, 10, SECONDS)).toBeGreaterThan(8);
    },
    60_000,
  );

  it("reports no drift on a steady clock, and does not disturb it", () => {
    const far = farEnd(10, 1);
    const near = room(90)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const out = runLive(echo, far, near);
    expect(echo.stats().driftPpm).toBe(0);
    expect(erle(near, out, 6, 10)).toBeGreaterThan(40);
  });
});

describe("echo canceller: failures, frame sizes and odd input", { timeout: 30_000 }, () => {
  it("falls back to plain passthrough after five failures in a row, and reset brings it back", () => {
    const far = farEnd(4, 1);
    const near = room(60)(far);
    const echo = new EchoCanceller({ rate: RATE });
    echo.pushReference(0, far);
    const broken = vi
      .spyOn(echo as unknown as { far: () => number }, "far")
      .mockImplementation(() => {
        throw new Error("ring failed");
      });
    for (let n = 0; n < 5; n += 1) {
      const frame = near.subarray(n * 320, (n + 1) * 320);
      const out = echo.process(frame, n * 320);
      expect(Array.from(out)).toEqual(Array.from(frame));
    }
    expect(echo.stats()).toMatchObject({ failures: 5, disabled: true });
    expect(echo.isPassthrough()).toBe(true);
    broken.mockRestore();
    const frame = near.subarray(2 * RATE, 2 * RATE + 320);
    expect(Array.from(echo.process(frame, 2 * RATE))).toEqual(Array.from(frame));
    echo.reset();
    expect(echo.stats()).toMatchObject({ failures: 0, disabled: false });
    expect(echo.isPassthrough()).toBe(false);
  });

  it("a failure that is not repeated does not switch it off", () => {
    const far = farEnd(3, 1);
    const near = room(60)(far);
    const echo = new EchoCanceller({ rate: RATE });
    const spy = vi.spyOn(echo as unknown as { far: () => number }, "far");
    spy.mockImplementationOnce(() => {
      throw new Error("one bad frame");
    });
    echo.pushReference(0, far);
    const first = echo.process(near.subarray(0, 320), 0);
    expect(Array.from(first)).toEqual(Array.from(near.subarray(0, 320)));
    spy.mockRestore();
    for (let at = 320; at < near.length; at += 320) echo.process(near.subarray(at, at + 320), at);
    expect(echo.stats()).toMatchObject({ failures: 1, disabled: false });
  });

  it.each([1, 7, 160, 321, 1000])(
    "works with frames of %i samples",
    (frame) => {
      const far = farEnd(5, 2);
      const near = room(60)(far);
      const echo = new EchoCanceller({ rate: RATE });
      const out = runLive(echo, far, near, frame);
      expect(out.length).toBe(near.length);
      expect(out.every((v) => Number.isFinite(v))).toBe(true);
      expect(echo.stats().processedSamples).toBe(near.length);
      expect(erle(near, out, 3.5, 5)).toBeGreaterThan(15);
    },
    30_000,
  );

  it("copes with empty frames, NaN and infinite samples, and still cancels afterwards", () => {
    const echo = new EchoCanceller({ rate: RATE });
    expect(echo.process(new Float32Array(0), 0).length).toBe(0);
    const messy = Float32Array.from({ length: 320 }, (_, i) =>
      i % 5 === 0 ? Number.NaN : i % 7 === 0 ? Number.POSITIVE_INFINITY : 0.1,
    );
    echo.pushReference(0, messy);
    const out = echo.process(messy, 0);
    expect(out.length).toBe(320);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(echo.stats().failures).toBe(0);
    const far = farEnd(6, 1);
    const near = room(90)(far);
    const after = new Float32Array(near.length);
    for (let at = 0; at < near.length; at += 320) {
      echo.pushReference(320 + at, far.subarray(at, at + 320));
      after.set(echo.process(near.subarray(at, at + 320), 320 + at), at);
    }
    expect(erle(near, after, 4, 6)).toBeGreaterThan(30);
  });
});
