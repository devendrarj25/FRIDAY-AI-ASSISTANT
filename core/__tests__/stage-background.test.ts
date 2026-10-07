import { describe, expect, it, beforeEach } from "vitest";

import { stage, showRealChart, showRealImage } from "../../src/lib/friday/stage";
import { backgroundTasks } from "../../src/lib/friday/self/background-tasks";
import { DEFAULT_PREFERENCES } from "../../src/lib/friday/preferences";
import { identity } from "../../src/lib/friday/brain/identity";

describe("presentation stage", () => {
  beforeEach(() => stage.clear());

  it("shows a card on the main screen and keeps it selectable", () => {
    const item = stage.show({ kind: "text", title: "Report", body: "done", source: "Tasks" });
    expect(stage.getSnapshot().open).toBe(true);
    expect(stage.active()?.id).toBe(item.id);
  });

  it("carries charts, tables and media without losing their data", () => {
    stage.show({
      kind: "chart",
      title: "Latency",
      series: [{ label: "a", value: 12 }],
      source: "Network",
    });
    expect(stage.active()?.series?.[0]?.value).toBe(12);
    stage.show({
      kind: "image",
      title: "Screen",
      src: "data:image/png;base64,AA",
      source: "Vision",
    });
    expect(stage.active()?.kind).toBe("image");
    stage.step(1);
    expect(stage.active()?.kind).toBe("chart");
  });

  it("refuses to chart invented or empty numbers", () => {
    expect(showRealChart({ title: "Empty", series: [], source: "test" })).toMatchObject({
      error: expect.stringMatching(/no real numbers/i),
    });
    expect(
      showRealChart({
        title: "NaN",
        series: [{ label: "x", value: Number.NaN }],
        source: "test",
      }),
    ).toMatchObject({ error: expect.stringMatching(/no real numbers/i) });
    const card = showRealChart({
      title: "Measured",
      series: [{ label: "status", value: 200 }],
      source: "test",
    });
    expect("id" in card).toBe(true);
    if ("id" in card) expect(card.series?.[0]?.value).toBe(200);
    expect(showRealImage({ title: "None", src: "", source: "test" })).toMatchObject({
      error: expect.stringMatching(/no image/i),
    });
  });

  it("closes and removes without breaking the list", () => {
    const a = stage.show({ kind: "text", title: "A", source: "Tasks" });
    stage.close();
    expect(stage.getSnapshot().open).toBe(false);
    stage.open(a.id);
    stage.remove(a.id);
    expect(stage.getSnapshot().items).toHaveLength(0);
  });
});

describe("continuous background work", () => {
  it("registers real recurring jobs and never duplicates one", () => {
    const ids = backgroundTasks.getSnapshot().jobs.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining(["health", "memory", "network", "improve"]));
    backgroundTasks.register({ id: "health", label: "dupe", everyMinutes: 1, run: async () => "" });
    expect(backgroundTasks.getSnapshot().jobs.filter((j) => j.id === "health")).toHaveLength(1);
  });

  it("can pause a single job without stopping the rest", () => {
    backgroundTasks.setEnabled("improve", false);
    expect(backgroundTasks.getSnapshot().jobs.find((j) => j.id === "improve")?.enabled).toBe(false);
    backgroundTasks.setEnabled("improve", true);
  });
});

describe("FRIDAY's default voice and language", () => {
  it("defaults to a warm Indian Hindi voice with Hinglish replies", () => {
    expect(DEFAULT_PREFERENCES.voice.speechLang).toBe("hi-IN");
    expect(DEFAULT_PREFERENCES.voice.recognitionLang).toBe("hi-IN");
    expect(DEFAULT_PREFERENCES.voice.hinglish).toBe(true);
    expect(DEFAULT_PREFERENCES.voice.pitch).toBeGreaterThan(1);
  });

  it("puts the language contract into every model prompt", () => {
    const prompt = identity.compile();
    expect(prompt).toMatch(/Hinglish|Hindi/);
  });
});
