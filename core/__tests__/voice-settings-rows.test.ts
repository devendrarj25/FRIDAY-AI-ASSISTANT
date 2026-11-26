/**
 * Settings, Voice: honest rows. Mute and Pause are two rows on their own stores, a hint names the default only where
 * the code default is really on, and "Delete voice data" tells the truth about what happened (count, nothing, failure
 * with Retry, a rejection caught).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToggleRow } from "../../src/components/friday/ui";
import {
  deleteVoiceDataFailure,
  deleteVoiceDataOutcome,
  ON_BY_DEFAULT_HINT,
} from "../../src/components/friday/settings/voice-settings-model";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";

const root = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8").replace(/\r\n/g, "\n");
const source = read("src/components/friday/settings/VoiceSettings.tsx");

describe("deleteVoiceDataOutcome", () => {
  it("says how many files went", () => {
    expect(deleteVoiceDataOutcome({ ok: true, removed: 4, failed: 0 })).toEqual({
      kind: "deleted",
      message: "Deleted 4 voice files",
      retry: false,
    });
    expect(deleteVoiceDataOutcome({ ok: true, removed: 1, failed: 0 }).message).toBe(
      "Deleted 1 voice file",
    );
  });
  it("says nothing was there when nothing went", () => {
    expect(deleteVoiceDataOutcome({ ok: true, removed: 0, failed: 0 })).toEqual({
      kind: "empty",
      message: "Nothing to delete",
      retry: false,
    });
  });
  it("a refused answer or a file that stayed is a failure with Retry", () => {
    const refused = deleteVoiceDataOutcome({ ok: false });
    expect(refused).toMatchObject({ kind: "failed", retry: true });
    const stayed = deleteVoiceDataOutcome({ ok: true, removed: 3, failed: 2 });
    expect(stayed).toMatchObject({ kind: "failed", retry: true });
    expect(stayed.message).toContain("2");
  });
  it("a missing or odd answer is never reported as a success count", () => {
    for (const odd of [undefined, null, "x", 3, {}]) {
      expect(deleteVoiceDataOutcome(odd)).toMatchObject({ kind: "failed", retry: true });
    }
  });
  it("an older answer without counts is still a plain success", () => {
    expect(deleteVoiceDataOutcome({ ok: true })).toMatchObject({ kind: "deleted", retry: false });
  });
  it("a rejection becomes a failure with Retry and keeps the reason", () => {
    expect(deleteVoiceDataFailure(new Error("disk busy"))).toEqual({
      kind: "failed",
      message: "Could not delete voice data: disk busy",
      retry: true,
    });
    expect(deleteVoiceDataFailure("boom").message).toContain("boom");
  });
});

describe("ToggleRow hint and hit area", () => {
  const out = renderToStaticMarkup(
    createElement(ToggleRow, {
      label: "Quiet",
      hint: "A long hint",
      on: false,
      onToggle: () => {},
    }),
  );
  it("clamps the hint to three lines, keeps the full text in a title, and describes the switch", () => {
    expect(out).toContain("line-clamp-3");
    expect(out).toContain('title="A long hint"');
    const id = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
  });
  it("a row without a hint has no description link", () => {
    const bare = renderToStaticMarkup(
      createElement(ToggleRow, { label: "Quiet", on: true, onToggle: () => {} }),
    );
    expect(bare).not.toContain("aria-describedby");
  });
  it("the switch hit area is 24 px high through a pseudo-element, the look unchanged", () => {
    expect(out).toContain("after:absolute");
    expect(out).toContain("after:-inset-y-0.5");
    expect(out).toContain("h-5 w-9");
  });
});

describe("Settings, Voice rows", () => {
  it("has a Mute row on muted and a Pause row on paused, and no old single mute row", () => {
    expect(source).toContain('label="Mute voice and microphone"');
    expect(source).toContain("on={voice.muted}");
    expect(source).toContain("assistantMode.toggleMuted()");
    expect(source).toContain('label="Pause listening"');
    expect(source).toContain("on={voice.paused}");
    expect(source).toContain("assistantMode.setPaused(!voice.paused)");
    expect(source).not.toContain('label="Mute microphone"');
  });
  it("names a default as on only where the code default is on", () => {
    const voice = DEFAULT_PREFERENCES.voice;
    expect(voice.fastFirstClause).toBe(true);
    expect(voice.pcmPlayback).toBe(true);
    expect(ON_BY_DEFAULT_HINT).toBe("On by default. Reversible.");
    for (const key of ["fastFirstClause", "pcmPlayback"]) {
      const at = source.indexOf(`on={prefs.voice.${key} === true}`);
      expect(at).toBeGreaterThan(0);
      const row = source.slice(source.lastIndexOf("<ToggleRow", at), at);
      expect(row).toContain("${ON_BY_DEFAULT_HINT}");
      expect(row).not.toContain("Off by default");
    }
    // Hands-free is off by default and never described as on.
    const hf = source.indexOf("on={voice.handsFree}");
    const hfRow = source.slice(source.lastIndexOf("<ToggleRow", hf), hf);
    expect(hfRow).not.toContain("ON_BY_DEFAULT_HINT");
    expect(hfRow).not.toMatch(/on by default/i);
  });
  it("Delete voice data confirms, reports the outcome, offers Retry and catches a rejection", () => {
    expect(source).toContain("window.confirm(");
    expect(source).toContain("deleteVoiceDataOutcome(");
    expect(source).toContain("deleteVoiceDataFailure(");
    expect(source).toMatch(/action: \{ label: "Retry"/);
    expect(source).toMatch(/clearVoiceprint[\s\S]{0,400}catch/);
  });
  it("the local voice picker sits beside the FRIDAY voice row under the committed label", () => {
    expect(source).toContain("FRIDAY voice (default)");
    const picker = source.indexOf("<LocalVoicePicker />");
    const friday = source.indexOf("<FridayVoice />");
    expect(picker).toBeGreaterThan(friday);
    expect(picker - friday).toBeLessThan(200);
    expect(source.match(/<LocalVoicePicker \/>/g)?.length).toBe(1);
  });
});
