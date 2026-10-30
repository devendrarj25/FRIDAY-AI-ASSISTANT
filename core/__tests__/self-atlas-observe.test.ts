/**
 * Asking FRIDAY about herself or this PC is answered from probe results, with their sources.
 * The desktop bridge is a stand-in, so nothing here touches the real machine.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import {
  atlasLookRequested,
  atlasTopics,
  describePcHealth,
  describeSelfAtlas,
  pcHealthLookRequested,
} from "../../src/lib/friday/brain/atlas-observe";
import {
  readWorldInsight,
  readWorldState,
  resetWorldInsightForTests,
} from "../../src/lib/friday/brain/world-model";
import {
  ageText,
  atlasWorldLine,
  describeFact,
  formatAtlas,
  formatReliability,
  publishAtlas,
  publishReliability,
  refreshAtlas,
  reliabilityWorldLine,
  resetSelfAtlasForTests,
  type AtlasFact,
  type AtlasSnapshot,
  type ReliabilityReport,
} from "../../src/lib/friday/self-atlas";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const fact = (over: Partial<AtlasFact>): AtlasFact => ({
  group: "location",
  id: "root",
  label: "FRIDAY folder",
  value: "D:\\FRIDAY",
  status: "ok",
  source: "friday-paths.cjs",
  readAt: NOW - 30_000,
  confidence: 1,
  ...over,
});

const snapshot = (facts: AtlasFact[], readAt = NOW - 30_000): AtlasSnapshot => {
  const counts = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const row of facts) counts[row.status] += 1;
  return {
    schema: 1,
    readAt,
    root: "D:\\FRIDAY",
    facts,
    groups: {},
    counts,
    summary: `${facts.length} facts read: ${counts.ok} ok, ${counts.warn} warn, ${counts.bad} bad, ${counts.unknown} not inspected`,
  };
};

const withBridge = (bridge: Record<string, unknown> | null) => {
  (globalThis as unknown as { window?: unknown }).window = bridge ? { friday: bridge } : {};
};

beforeEach(() => {
  resetSelfAtlasForTests();
  resetWorldInsightForTests();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("recognising the questions", () => {
  it("catches questions about FRIDAY herself and leaves other talk alone", () => {
    for (const ask of [
      "where is your root folder",
      "where is your exe",
      "are you portable or installed",
      "which version are you",
      "what version are you",
      "what is running inside you",
      "check yourself",
      "tumhara root kahan hai",
      "apni state batao",
    ]) {
      expect(atlasLookRequested(ask), ask).toBe(true);
    }
    for (const ask of [
      "where is the nearest chai shop",
      "which version of node do I need",
      "what is running on port 3000",
      "write a poem",
    ]) {
      expect(atlasLookRequested(ask), ask).toBe(false);
    }
  });

  it("catches PC health questions without taking pasted errors", () => {
    for (const ask of [
      "what crashed on my pc",
      "any crashes on this computer",
      "is a restart pending",
      "show my startup items",
      "windows error reporting",
      "how is the pc health",
    ]) {
      expect(pcHealthLookRequested(ask), ask).toBe(true);
    }
    expect(pcHealthLookRequested("TypeError: x is not a function at foo (a.js:1)")).toBe(false);
    expect(pcHealthLookRequested("fix the crash in my code")).toBe(false);
  });

  it("limits the answer to the part asked about, and answers all of it for a general question", () => {
    expect(atlasTopics("where is your root folder")).toEqual(["location"]);
    expect(atlasTopics("show your backups")).toEqual(["backups"]);
    expect(atlasTopics("check yourself")).toEqual([]);
  });
});

describe("the sentences", () => {
  it("cites the source, the age and the confidence of each fact", () => {
    const line = describeFact(fact({ confidence: 0.95 }), NOW);
    expect(line).toBe("FRIDAY folder: D:\\FRIDAY (friday-paths.cjs, read 30 s ago, 95% sure)");
  });

  it("flags a problem and never reports an unread fact as a value", () => {
    expect(describeFact(fact({ status: "bad", note: "does not exist" }), NOW)).toContain(
      "[bad] — does not exist",
    );
    const unread = describeFact(
      fact({ status: "unknown", value: "not inspected", note: "probe failed" }),
      NOW,
    );
    expect(unread).toBe("FRIDAY folder: not inspected (probe failed).");
    expect(unread).not.toContain("friday-paths");
  });

  it("groups by section, keeps a header with the age, and warns about unread lines", () => {
    const text = formatAtlas(
      snapshot([
        fact({}),
        fact({ group: "backups", id: "backups", label: "Backups", status: "unknown", value: "x" }),
      ]),
      { now: NOW },
    );
    expect(text).toContain("Read from live probes 30 s ago — 2 facts read");
    expect(text).toContain("Where I am:");
    expect(text).toContain("Backups: not inspected");
    expect(text).toContain("I will not call it healthy until a probe reads it.");
  });

  it("describes the reliability report and keeps unknown rows out of the clean count", () => {
    const report: ReliabilityReport = {
      detectedAt: NOW - 5 * 60_000,
      supported: true,
      items: [
        {
          id: "crashes",
          label: "Application crashes (7 days)",
          state: "warn",
          detail: "2 event(s): chrome.exe x2",
        },
        { id: "startup", label: "Startup entries", state: "ok", detail: "3: A, B, C" },
        {
          id: "updates",
          label: "Newest installed updates",
          state: "unknown",
          detail: "Get-HotFix is blocked",
        },
      ],
    };
    const text = formatReliability(report, NOW);
    expect(text).toContain("PC reliability, read 5 min ago:");
    expect(text).toContain("Application crashes (7 days) [warn]: 2 event(s): chrome.exe x2");
    expect(text).toContain("Newest installed updates: not inspected (Get-HotFix is blocked)");
    expect(text).toContain("it is not a clean result");
    expect(reliabilityWorldLine(report)).toBe("1 ok, 1 need a look, 1 not inspected");
    expect(
      formatReliability(
        {
          detectedAt: NOW,
          supported: false,
          items: [
            { id: "crashes", label: "x", state: "unknown", detail: "not available on linux" },
          ],
        },
        NOW,
      ),
    ).toContain("Windows only");
  });

  it("formats ages", () => {
    expect(ageText(NOW - 1000, NOW)).toBe("just now");
    expect(ageText(NOW - 30_000, NOW)).toBe("30 s ago");
    expect(ageText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ageText(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
  });
});

describe("asking through the desktop bridge", () => {
  it("reads once, reuses a fresh answer, and asks again when it is old", async () => {
    let calls = 0;
    const answers = [
      snapshot([fact({})], NOW),
      snapshot([fact({ value: "E:\\FRIDAY" })], NOW + 60_000),
    ];
    withBridge({ selfAtlas: async () => answers[calls++] ?? null });
    expect((await refreshAtlas(NOW + 1000))?.facts[0]?.value).toBe("D:\\FRIDAY");
    await refreshAtlas(NOW + 5000);
    expect(calls).toBe(1);
    expect((await refreshAtlas(NOW + 61_000))?.facts[0]?.value).toBe("E:\\FRIDAY");
    expect(calls).toBe(2);
  });

  it("keeps the last answer when the desktop throws", async () => {
    publishAtlas(snapshot([fact({})], NOW - 60_000));
    withBridge({
      selfAtlas: async () => {
        throw new Error("ipc closed");
      },
    });
    expect((await refreshAtlas(NOW))?.facts).toHaveLength(1);
  });

  it("says plainly that it cannot inspect itself outside the desktop app", async () => {
    withBridge(null);
    const text = await describeSelfAtlas("where is your root", NOW);
    expect(text).toContain("only inspect myself from the desktop app");
    expect(await describePcHealth(NOW)).toContain("only inspect myself from the desktop app");
  });

  it("answers a question from the probes, with no model", async () => {
    withBridge({
      selfAtlas: async () =>
        snapshot(
          [
            fact({}),
            fact({
              group: "backups",
              id: "backups",
              label: "Backups",
              value: "3 file(s)",
              source: "backup/",
            }),
          ],
          Date.now() - 2000,
        ),
    });
    const reply = baselineRespond("where is your root folder");
    expect(reply.handled).toBe(true);
    expect(reply.confidence).toBeGreaterThanOrEqual(0.9);
    const text = await (reply as unknown as { resolve: () => Promise<string> }).resolve();
    expect(text).toContain("FRIDAY folder: D:\\FRIDAY");
    expect(text).toContain("friday-paths.cjs");
    expect(text).not.toContain("Backups:");
  });

  it("answers a PC health question from the reliability probe", async () => {
    withBridge({
      detectReliability: async () => ({
        detectedAt: Date.now(),
        supported: true,
        items: [
          {
            id: "crashes",
            label: "Application crashes (7 days)",
            state: "ok",
            detail: "none recorded",
          },
        ],
      }),
    });
    const reply = baselineRespond("what crashed on my pc");
    expect(reply.handled).toBe(true);
    const text = await (reply as unknown as { resolve: () => Promise<string> }).resolve();
    expect(text).toContain("none recorded");
  });
});

describe("the world model", () => {
  it("carries self and pc as unknown until a probe has run", () => {
    const world = readWorldState(NOW);
    const self = world.facts.find((row) => row.domain === "self");
    const pc = world.facts.find((row) => row.domain === "pc");
    expect(self).toMatchObject({ value: "not inspected yet", freshness: "unknown" });
    expect(pc).toMatchObject({ value: "not inspected yet", freshness: "unknown" });
    expect(world.summary).toContain("self:unknown");
  });

  it("reads counts only, so no path or process name reaches a prompt through it", () => {
    publishAtlas(
      snapshot(
        [
          fact({}),
          fact({
            id: "kernel",
            group: "processes",
            label: "Python kernel",
            status: "bad",
            value: "not reachable",
          }),
        ],
        NOW,
      ),
    );
    publishReliability({
      detectedAt: NOW,
      supported: true,
      items: [
        {
          id: "crashes",
          label: "Application crashes (7 days)",
          state: "warn",
          detail: "chrome.exe x9",
        },
      ],
    });
    const world = readWorldState(NOW);
    const text = JSON.stringify(
      world.facts.filter((row) => row.domain === "self" || row.domain === "pc"),
    );
    expect(text).toContain("2 facts read");
    expect(text).not.toContain("D:\\FRIDAY");
    expect(text).not.toContain("chrome.exe");
    expect(atlasWorldLine(null)).toBe("not inspected yet");
    const insight = readWorldInsight(NOW);
    expect(insight.atRisk.some((line) => line.startsWith("self:"))).toBe(true);
  });
});
