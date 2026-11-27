/**
 * The "auto" streaming ear on the renderer side: once Electron refuses it (auto-low-ram, auto-few-cores, auto-slow in
 * the speech status `streamAuto`), `streamWanted("auto")` is false so the live-words pass and the barge-in ladder never
 * assume a stream that does not run; and the settings hint says what Auto does and shows the speed-check line.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  STREAM_AUTO_EXPLAINER,
  SttStreamSession,
  noteStreamAuto,
  noteStreamRefusal,
  parseStreamAuto,
  resetStreamAuto,
  streamAutoRefusal,
  streamEarHint,
  streamWanted,
} from "../../src/lib/friday/voice-engine/stream-session";

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

const view = (state: string, reason: string, extra: Record<string, unknown> = {}) => ({
  state,
  reason,
  p95Ms: null,
  limitMs: 160,
  detail: "",
  ...extra,
});

afterEach(() => resetStreamAuto());

describe("streamWanted follows the auto verdict", () => {
  it("is true for auto before any verdict, and for an accepted or unchecked one", () => {
    expect(streamWanted("auto")).toBe(true);
    noteStreamAuto(view("on", "ok", { p95Ms: 42 }));
    expect(streamWanted("auto")).toBe(true);
    noteStreamAuto(view("unknown", "not-checked"));
    expect(streamWanted("auto")).toBe(true);
    noteStreamAuto(view("off", "worker"));
    expect(streamWanted("auto")).toBe(true);
  });

  it("is false for auto once the status says low RAM, few cores or too slow", () => {
    for (const reason of ["low-ram", "few-cores", "slow"]) {
      resetStreamAuto();
      noteStreamAuto(view("off", reason));
      expect(streamAutoRefusal()).toBe(reason);
      expect(streamWanted("auto")).toBe(false);
    }
  });

  it("recovers when a later status accepts it", () => {
    noteStreamAuto(view("off", "slow"));
    expect(streamWanted("auto")).toBe(false);
    noteStreamAuto(view("on", "ok"));
    expect(streamWanted("auto")).toBe(true);
  });

  it("never touches the engines the owner picked, and off or junk stays off", () => {
    noteStreamAuto(view("off", "low-ram"));
    expect(streamWanted("nemotron")).toBe(true);
    expect(streamWanted("stream-ear-nemotron")).toBe(true);
    for (const junk of ["off", "", "Auto", null, undefined, 3])
      expect(streamWanted(junk)).toBe(false);
  });

  it("reads an open refusal word (auto-low-ram, auto-few-cores, auto-slow) the same way", () => {
    noteStreamRefusal("auto-few-cores");
    expect(streamWanted("auto")).toBe(false);
    resetStreamAuto();
    for (const other of ["worker", "busy", "auto-unknown", "low-ram", 7, undefined]) {
      noteStreamRefusal(other);
      expect(streamWanted("auto")).toBe(true);
    }
  });

  it("a stream open that Electron refuses for size or speed stops auto from being assumed", async () => {
    const session = new SttStreamSession({
      bridge: {
        openSttStream: async () => ({ ok: false, fallback: true, reason: "auto-slow" }),
        feedSttStream: async () => ({ ok: true }),
        closeSttStream: async () => ({ ok: true }),
      },
    });
    expect(await session.open({ streamEngine: "auto", locale: "en" })).toBe(false);
    expect(streamWanted("auto")).toBe(false);
  });

  it("a refusal for an engine the owner picked is not an auto verdict", async () => {
    const session = new SttStreamSession({
      bridge: {
        openSttStream: async () => ({ ok: false, fallback: true, reason: "auto-slow" }),
        feedSttStream: async () => ({ ok: true }),
        closeSttStream: async () => ({ ok: true }),
      },
    });
    await session.open({ streamEngine: "nemotron", locale: "en" });
    expect(streamWanted("auto")).toBe(true);
  });
});

describe("parseStreamAuto", () => {
  it("keeps a good view and drops a malformed one", () => {
    expect(parseStreamAuto(view("on", "ok", { p95Ms: 42.5, detail: "fine" }))).toEqual({
      state: "on",
      reason: "ok",
      p95Ms: 42.5,
      limitMs: 160,
      detail: "fine",
    });
    for (const bad of [null, undefined, 7, "on", {}, { state: "maybe" }]) {
      expect(parseStreamAuto(bad)).toBeNull();
      expect(noteStreamAuto(bad)).toBeNull();
    }
    expect(parseStreamAuto({ state: "off", p95Ms: "x", detail: 5 })).toMatchObject({
      p95Ms: null,
      detail: "",
      reason: "",
    });
  });
});

describe("the stream ear hint", () => {
  it("says what Auto does and shows the speed-check line for each verdict", () => {
    expect(STREAM_AUTO_EXPLAINER).toMatch(/12 GB/);
    expect(STREAM_AUTO_EXPLAINER).toMatch(/4 cores/);
    expect(STREAM_AUTO_EXPLAINER).toMatch(/speed check/);
    const on = parseStreamAuto(
      view("on", "ok", {
        p95Ms: 42,
        detail: "the live streaming ear is on: a 320 ms chunk took 42 ms",
      }),
    );
    expect(streamEarHint("auto", on)).toBe(
      `${STREAM_AUTO_EXPLAINER} Now: the live streaming ear is on: a 320 ms chunk took 42 ms.`,
    );
    const slow = parseStreamAuto(
      view("off", "slow", {
        p95Ms: 300,
        detail: "the live streaming ear stays off: over the limit",
      }),
    );
    expect(streamEarHint("auto", slow)).toContain("stays off: over the limit");
    expect(streamEarHint("auto", parseStreamAuto(view("unknown", "not-checked")))).toMatch(
      /Now: not checked yet\.$/,
    );
    expect(streamEarHint("auto", parseStreamAuto(view("on", "ok")))).toMatch(/Now: on\.$/);
    expect(streamEarHint("auto", null)).toBe(`${STREAM_AUTO_EXPLAINER} No verdict yet.`);
  });

  it("tells an owner with off stored that Auto is available, in one line, without changing it", () => {
    const line = streamEarHint("off", null);
    expect(line).toMatch(/Auto is available/);
    expect(line).toMatch(/kept/);
    expect(line).not.toMatch(/\n/);
    expect(streamEarHint("off", parseStreamAuto(view("on", "ok")))).toBe(line);
  });

  it("is silent for a pinned engine", () => {
    expect(streamEarHint("nemotron", null)).toBe("");
    expect(streamEarHint("stream-ear-nemotron", null)).toBe("");
  });
});

describe("VoiceSettings shows it", () => {
  const src = read("src/components/friday/settings/VoiceSettings.tsx");

  it("reads the status, feeds the verdict to the listening path and offers Retry", () => {
    expect(src).toContain(
      "<StreamEarStatus choice={sanitizeStreamEngine(prefs.voice.streamEngine)} />",
    );
    expect(src).toContain(
      "noteStreamAuto((status as { streamAuto?: unknown } | null)?.streamAuto)",
    );
    expect(src).toContain("streamEarHint(choice, read.auto)");
    expect(src).toMatch(/<ErrorState[\s\S]{0,200}onRetry=/);
    expect(src).toContain('<LoadingState label="Checking this PC"');
  });

  it("never rewrites the stored choice from the hint", () => {
    const start = src.indexOf("function StreamEarStatus");
    const end = src.indexOf("export function VoiceSettings");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, end)).not.toContain("setVoice");
  });
});
