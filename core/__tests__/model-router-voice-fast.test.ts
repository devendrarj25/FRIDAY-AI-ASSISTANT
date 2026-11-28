/**
 * Two local brains for voice: the small fast model (its tag is listed under `voice.tags` in
 * config/chat-tiers.json) takes a quick spoken side line; the main model answers the real work. The tags are read
 * from that one file (injected here), never typed into the router. Both firewalls run before this score.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();
const router = require_("../../electron/model-router.cjs");

const TAGS = ["qwen3.5:0.8b", "qwen3.5:2b"];
const local = (id: string, sizeGb: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "local" as const,
  contextK: 8,
  providerId: "ollama",
  meta: {
    providerId: "ollama",
    kind: "local",
    modelName: id.replace(/^ollama:/, ""),
    connected: true,
    sizeGb,
    ...extra,
  },
});
const MAIN = () => local("ollama:qwen3.5:9b", 6.6);
const FAST = () => local("ollama:qwen3.5:2b", 2.7);
const route = (models: unknown[], extra: Record<string, unknown> = {}) =>
  router.routeRequest(models, {
    task: "chat",
    mode: "local-only",
    policy: "free-only",
    limit: 4,
    voiceTags: TAGS,
    ...extra,
  });
const first = (plan: { models: { id: string }[] }) => plan.models[0]?.id;

describe("voice tags decide which installed model is the fast one", () => {
  it("matches a tag with or without the provider prefix and never a longer tag", () => {
    expect(router.isVoiceFastModel(FAST(), TAGS)).toBe(true);
    expect(router.isVoiceFastModel(local("qwen3.5:0.8b", 1), TAGS)).toBe(true);
    expect(router.isVoiceFastModel(MAIN(), TAGS)).toBe(false);
    expect(router.isVoiceFastModel(local("ollama:myqwen3.5:2b", 2), TAGS)).toBe(false);
    expect(router.isVoiceFastModel(local("ollama:qwen3.5:2b-instruct", 2), TAGS)).toBe(false);
  });

  it("is false for a cloud model, with no tags, or with garbage tags", () => {
    const cloud = { ...FAST(), type: "cloud" as const };
    expect(router.isVoiceFastModel(cloud, TAGS)).toBe(false);
    for (const tags of [null, [], "qwen3.5:2b", [3, {}], [""]]) {
      expect(router.isVoiceFastModel(FAST(), tags)).toBe(false);
    }
  });

  it("reads the tags from config/chat-tiers.json when none are injected (or none when absent)", () => {
    const file = JSON.parse(
      readFileSync(new URL("../../config/chat-tiers.json", import.meta.url), "utf8"),
    );
    const listed: string[] = Array.isArray(file.voice?.tags) ? file.voice.tags : [];
    expect(router.voiceFastTags()).toEqual(listed);
  });
});

describe("the voice quick lane prefers the fast model; the real answer keeps the main model", () => {
  it("a quick spoken line goes to the fast model when it is installed", () => {
    const plan = route([MAIN(), FAST()], { surface: "voice", lane: "quick" });
    expect(first(plan)).toBe("ollama:qwen3.5:2b");
  });

  it("the full lane keeps the main model first; the chat surface ignores the lane", () => {
    expect(first(route([MAIN(), FAST()], { surface: "voice", lane: "full" }))).toBe(
      "ollama:qwen3.5:9b",
    );
    const ids = (extra: Record<string, unknown>) =>
      route([MAIN(), FAST()], { surface: "chat", ...extra }).models.map(
        (m: { id: string }) => m.id,
      );
    expect(ids({ lane: "quick" })).toEqual(ids({}));
    expect(ids({ lane: "full" })).toEqual(ids({}));
  });

  it("a turn the escalation rule sends up never gets the fast-model preference", () => {
    const fast = router.describe(FAST());
    const score = (extra: Record<string, unknown>) =>
      router.scoreModel(fast, { surface: "voice", voiceTags: TAGS, ...extra });
    for (const task of ["reasoning", "coding", "vision", "tools", "research"]) {
      expect(score({ task, lane: "quick" }), task).toBe(score({ task }));
    }
    const long = { requirements: { contextK: 64 } };
    expect(score({ task: "chat", lane: "quick", ...long })).toBe(score({ task: "chat", ...long }));
    expect(score({ task: "chat", lane: "quick" })).toBeGreaterThan(score({ task: "chat" }));
  });

  it("with no fast model installed or no tags listed, nothing changes", () => {
    const only = route([MAIN()], { surface: "voice", lane: "quick" });
    expect(first(only)).toBe("ollama:qwen3.5:9b");
    const plain = router.routeRequest([MAIN(), FAST()], {
      task: "chat",
      mode: "local-only",
      policy: "free-only",
      limit: 4,
      surface: "voice",
      voiceTags: [],
    });
    const withLane = router.routeRequest([MAIN(), FAST()], {
      task: "chat",
      mode: "local-only",
      policy: "free-only",
      limit: 4,
      surface: "voice",
      voiceTags: [],
      lane: "quick",
    });
    expect(withLane.models.map((m: { id: string }) => m.id)).toEqual(
      plain.models.map((m: { id: string }) => m.id),
    );
  });

  it("the preference is a score, never a pass: a cloud model gets none and a hard-rejected one stays out", () => {
    const cloud = router.describe({ ...FAST(), id: "groq:qwen3.5:2b", type: "cloud" });
    const score = (extra: Record<string, unknown>) =>
      router.scoreModel(cloud, { surface: "voice", voiceTags: TAGS, ...extra });
    expect(score({ lane: "quick" })).toBe(score({}));
    const gone = { ...FAST(), meta: { ...FAST().meta, loaded: false } };
    const plan = route([MAIN(), gone], { surface: "voice", lane: "quick" });
    expect(plan.models.map((m: { id: string }) => m.id)).toEqual(["ollama:qwen3.5:9b"]);
  });

  it("the full lane steps back from the fast model only when a main local model can answer", () => {
    const fast = router.describe(FAST());
    const score = (extra: Record<string, unknown>) =>
      router.scoreModel(fast, { surface: "voice", voiceTags: TAGS, lane: "full", ...extra });
    const none = router.scoreModel(fast, { surface: "voice", voiceTags: TAGS });
    expect(score({})).toBe(none);
    expect(score({ mainLocalPresent: true })).toBeLessThan(none);
  });

  it("an unknown lane value is ignored", () => {
    const base = route([MAIN(), FAST()], { surface: "voice" });
    const odd = route([MAIN(), FAST()], { surface: "voice", lane: "turbo" });
    expect(odd.models.map((m: { id: string }) => m.id)).toEqual(
      base.models.map((m: { id: string }) => m.id),
    );
  });
});
