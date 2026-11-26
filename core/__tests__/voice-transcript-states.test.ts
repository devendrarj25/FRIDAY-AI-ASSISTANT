import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIRM_TTL_MS,
  confirmCountdown,
  downloadRetryId,
  emptyTranscriptLine,
} from "../../src/components/friday/voice-transcript-model";
import { ConfirmationCard, VoiceTranscript } from "../../src/components/friday/VoiceTranscript";
import { VoiceDownloadBar } from "../../src/components/friday/VoiceDownloadBar";
import type { VoiceDownload } from "../../src/lib/friday/voice-download";

const source = (file: string) => readFileSync(join(__dirname, "../..", file), "utf8");

const failed = (over: Partial<VoiceDownload> = {}): VoiceDownload => ({
  stage: "failed",
  model: "small",
  label: "Speech model download failed",
  percent: null,
  detail: "network unreachable while fetching the weights from the model host over a long path",
  updateAvailable: false,
  ...over,
});

describe("transcript empty state", () => {
  it("keeps today's text with no inputs", () => {
    expect(emptyTranscriptLine({})).toBe(
      "Nothing heard yet. Say “FRIDAY” followed by what you need.",
    );
  });

  it("uses the stored wake word", () => {
    expect(emptyTranscriptLine({ wakeWord: "Jarvis" })).toContain("Say “Jarvis”");
  });

  it("never says Say FRIDAY when muted, paused or in error", () => {
    for (const input of [
      { muted: true },
      { paused: true },
      { error: "Microphone is blocked by Windows privacy settings." },
      { muted: true, paused: true, error: "x", handsFree: true },
    ]) {
      const line = emptyTranscriptLine(input);
      expect(line).not.toMatch(/Say “/);
      expect(line).not.toMatch(/Nothing heard yet/);
    }
  });

  it("puts the fault first, then pause, then mute", () => {
    expect(emptyTranscriptLine({ error: "Mic is busy.", paused: true, muted: true })).toBe(
      "Mic is busy.",
    );
    expect(emptyTranscriptLine({ paused: true, muted: true })).toMatch(/paused/i);
    expect(emptyTranscriptLine({ muted: true })).toMatch(/muted/i);
  });

  it("says no wake word is needed when hands-free is on", () => {
    const line = emptyTranscriptLine({ handsFree: true, wakeWord: "Friday" });
    expect(line).toMatch(/hands-free/i);
    expect(line).not.toMatch(/Say “/);
  });

  it("renders through VoiceTranscript with the props", () => {
    const base = {
      captions: [],
      interim: "",
      display: null,
      pending: null,
      layout: "line" as const,
      showTime: false,
    };
    const html = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(createElement(VoiceTranscript, { ...base, ...extra }));
    expect(html({})).toContain("Say “FRIDAY” followed by what you need.");
    expect(html({ muted: true })).not.toContain("Say “");
    expect(html({ paused: true })).toContain("paused");
    expect(html({ error: "Mic is busy." })).toContain("Mic is busy.");
    expect(html({ wakeWord: "Nova" })).toContain("Say “Nova”");
  });
});

describe("confirmation countdown", () => {
  it("counts down from the expiry and clamps at zero", () => {
    expect(CONFIRM_TTL_MS).toBe(30_000);
    expect(confirmCountdown(1_000, 1_000)).toMatchObject({ seconds: 30, expired: false });
    expect(confirmCountdown(1_000, 11_400)).toMatchObject({ seconds: 20, expired: false });
    expect(confirmCountdown(1_000, 31_000)).toMatchObject({ seconds: 0, expired: true });
    expect(confirmCountdown(1_000, 99_000)).toMatchObject({ seconds: 0, expired: true });
  });

  it("takes the window as a number, not a constant", () => {
    expect(confirmCountdown(0, 0, 120_000).seconds).toBe(120);
    expect(confirmCountdown(0, 1_000, 5_000).seconds).toBe(4);
  });

  it("states yes or no and the seconds left", () => {
    expect(confirmCountdown(0, 0).label).toBe("Say yes or no · 30 s left");
    expect(confirmCountdown(0, 40_000).label).toMatch(/expired/i);
  });

  it("a bad clock or window never gives NaN", () => {
    expect(confirmCountdown(Number.NaN, 5).seconds).toBe(0);
    expect(confirmCountdown(0, 0, Number.NaN).seconds).toBe(30);
  });

  it("the card draws the countdown, a status role and takes focus", () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmationCard, {
        pending: { command: "delete the folder", reason: "destructive", at: Date.now() },
        ttlMs: 30_000,
      }),
    );
    expect(html).toContain("Say yes or no");
    expect(html).toContain("YES · run it");
    expect(html).toContain("NO · cancel");
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('tabindex="-1"');
    const card = source("src/components/friday/VoiceTranscript.tsx");
    expect(card).toMatch(/\.focus\(/);
    expect(card).toMatch(/clearTimeout/);
    expect(card).not.toContain("setInterval");
    // Enter still never approves.
    expect(card).not.toMatch(/Enter[\s\S]{0,80}confirmPending\(true\)/);
  });
});

describe("failed download", () => {
  it("maps the speech size to its catalog id and refuses an unknown one", () => {
    expect(downloadRetryId("small")).toBe("faster-whisper-small");
    expect(downloadRetryId("faster-whisper-base")).toBe("faster-whisper-base");
    expect(downloadRetryId("")).toBeNull();
    expect(downloadRetryId("not-a-model")).toBeNull();
  });

  it("keeps Retry and Open Models, wraps the reason and is a status", () => {
    const html = renderToStaticMarkup(createElement(VoiceDownloadBar, { download: failed() }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Retry");
    expect(html).toContain("Open Models");
    expect(html).toContain("network unreachable");
    expect(html).toContain("break-words");
    expect(html).not.toMatch(/class="[^"]*truncate[^"]*">network/);
  });

  it("shows only Open Models when the model is not installable", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceDownloadBar, { download: failed({ model: "" }) }),
    );
    expect(html).not.toContain("Retry");
    expect(html).toContain("Open Models");
  });

  it("has no buttons while downloading and still shows the progress bar", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceDownloadBar, {
        download: failed({ stage: "download", percent: 40, label: "Fetching speech model" }),
      }),
    );
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("Open Models");
    expect(html).not.toContain("Retry");
  });

  it("wires Retry to models.install and Open Models to the models page", () => {
    const bar = source("src/components/friday/VoiceDownloadBar.tsx");
    expect(bar).toMatch(/models\.install\(/);
    expect(bar).toMatch(/to: "\/models"/);
    expect(bar).toContain("downloadRetryId");
  });
});
