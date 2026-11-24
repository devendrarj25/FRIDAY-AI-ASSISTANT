/**
 * Local side router: which installed local models are not servable right now,
 * and the reason the route trace shows. Fake model lists only; no network.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pinKnowledgeClock } from "./helpers/knowledge-clock";

const require_ = createRequire(import.meta.url);
pinKnowledgeClock();

const localRouting = require_("../../electron/model-routing-local.cjs");
const router = require_("../../electron/model-router.cjs");
const { LOCAL_ENGINES } = require_("../../electron/models.cjs");

type Row = Record<string, unknown> & { id?: string };

const engineModel = (providerId: string, name: string, meta: Row = {}, top: Row = {}): Row => ({
  id: `${providerId}:${name}`,
  type: "local",
  contextK: 8,
  providerId,
  meta: { providerId, kind: "local", modelName: name, connected: true, ...meta },
  ...top,
});

const FREE_CLOUD: Row = {
  id: "gemini:gemini-2.5-flash",
  type: "cloud",
  contextK: 32,
  providerId: "gemini",
  providerModelId: "gemini-2.5-flash",
  meta: { providerId: "gemini", kind: "cloud", modelName: "gemini-2.5-flash", connected: true },
};

/** Every local engine the product lists, plus Ollama (listed apart from LOCAL_ENGINES). */
const ENGINES: string[] = ["ollama", ...Object.keys(LOCAL_ENGINES)];

describe("local side router: prepare", () => {
  it("lists every local engine the product ships", () => {
    for (const id of ["ollama", "lmstudio", "llamacpp", "vllm", "localai", "jan"]) {
      expect(ENGINES).toContain(id);
    }
  });

  it("marks an LM Studio model that is installed but not loaded", () => {
    const view = localRouting.prepare([engineModel("lmstudio", "qwen", { loaded: false })]);
    expect(view.unavailable).toEqual([{ id: "lmstudio:qwen", reason: "not loaded" }]);
  });

  it.each(ENGINES)("marks a model on %s that the engine reports as not loaded", (engine) => {
    const view = localRouting.prepare([engineModel(engine, "m1", { loaded: false })]);
    expect(view.unavailable.map((row: Row) => row.id)).toEqual([`${engine}:m1`]);
    expect(view.unavailable[0].reason).toMatch(/not (loaded|available)/);
  });

  it.each(ENGINES)("marks a delisted (status unavailable) model on %s", (engine) => {
    const gone = engineModel(engine, "gone", {}, { status: "unavailable" });
    const view = localRouting.prepare([gone]);
    expect(view.unavailable.map((row: Row) => row.id)).toEqual([`${engine}:gone`]);
  });

  it.each(ENGINES)("never marks a usable model on %s", (engine) => {
    const rows = [
      engineModel(engine, "loaded", { loaded: true }),
      engineModel(engine, "plain", {}),
      engineModel(engine, "resident", { loaded: true, resident: true }),
      engineModel(engine, "ready", {}, { status: "ready" }),
    ];
    expect(localRouting.prepare(rows).unavailable).toEqual([]);
  });

  it("does not hide Ollama models that are pulled but not resident in memory", () => {
    // Ollama loads a pulled model on first request: resident false is not a fault.
    const rows = [engineModel("ollama", "cold", { loaded: true, resident: false })];
    expect(localRouting.prepare(rows).unavailable).toEqual([]);
  });

  it("returns the same list untouched and only reports the unavailable ids", () => {
    const rows = [
      engineModel("lmstudio", "a", { loaded: false }),
      engineModel("lmstudio", "b", { loaded: true }),
    ];
    const view = localRouting.prepare(rows);
    expect(view.models).toBe(rows);
    expect(view.models).toHaveLength(2);
    expect(view.unavailable.map((row: Row) => row.id)).toEqual(["lmstudio:a"]);
  });

  it("reads the engine from the top-level provider id or from meta", () => {
    const top = { id: "x1", providerId: "vllm", meta: { loaded: false } };
    const nested = { id: "x2", meta: { providerId: "llamacpp", loaded: false } };
    const ids = localRouting.prepare([top, nested]).unavailable.map((row: Row) => row.id);
    expect(ids).toEqual(["x1", "x2"]);
  });

  it("ignores a cloud model even when a delist flagged it", () => {
    const cloud = { ...FREE_CLOUD, status: "unavailable" };
    expect(localRouting.prepare([cloud]).unavailable).toEqual([]);
  });

  it("is safe on empty, missing and malformed input", () => {
    expect(localRouting.prepare([])).toEqual({ models: [], unavailable: [] });
    expect(localRouting.prepare(undefined)).toEqual({ models: [], unavailable: [] });
    expect(localRouting.prepare(null)).toEqual({ models: [], unavailable: [] });
    expect(localRouting.prepare([null, undefined, {}]).unavailable).toEqual([]);
  });
});

describe("local side router: the route", () => {
  const OPTS = { mode: "auto", policy: "free-preferred" };

  it.each(ENGINES)("skips a not-loaded %s model, keeps a loaded sibling, says why", (engine) => {
    const dead = engineModel(engine, "dead", { loaded: false }, { status: "unavailable" });
    const live = engineModel(engine, "live", { loaded: true });
    const routed = router.routeRequest([dead, live, FREE_CLOUD], OPTS);
    expect(routed.candidates).not.toContain(dead.id);
    expect(routed.candidates).toContain(live.id);
    expect(routed.candidates[0]).toBe(live.id);
    const excluded = routed.decisionTrace.exclusions.map((row: Row) => row.id);
    expect(excluded).toEqual([dead.id]);
  });

  it("falls to verified free cloud when the only local model is not loaded", () => {
    const dead = engineModel("lmstudio", "dead", { loaded: false }, { status: "unavailable" });
    const routed = router.routeRequest([dead, FREE_CLOUD], OPTS);
    expect(routed.lane).toBe("cloud-free");
    expect(routed.candidates).toEqual([FREE_CLOUD.id]);
    expect(routed.decisionTrace.exclusions).toEqual([{ id: dead.id, reason: "not loaded" }]);
  });

  it("falls to cloud when the engine is down and lists no model at all", () => {
    const routed = router.routeRequest([FREE_CLOUD], OPTS);
    expect(routed.lane).toBe("cloud-free");
    expect(routed.candidates).toEqual([FREE_CLOUD.id]);
    expect(routed.decisionTrace.exclusions).toEqual([]);
  });

  it("uses an engine that is up with the model, and lists no exclusion", () => {
    const live = engineModel("lmstudio", "qwen", { loaded: true });
    const routed = router.routeRequest([live, FREE_CLOUD], OPTS);
    expect(routed.lane).toBe("local");
    expect(routed.candidates[0]).toBe(live.id);
    expect(routed.decisionTrace.exclusions).toEqual([]);
  });

  it("keeps an Ollama model that is pulled but not resident routable", () => {
    const cold = engineModel("ollama", "cold", { loaded: true, resident: false });
    const routed = router.routeRequest([cold, FREE_CLOUD], OPTS);
    expect(routed.candidates[0]).toBe(cold.id);
    expect(routed.decisionTrace.exclusions).toEqual([]);
  });

  it("never reports a model as excluded when it is also a candidate", () => {
    const rows = ENGINES.flatMap((engine) => [
      engineModel(engine, "dead", { loaded: false }, { status: "unavailable" }),
      engineModel(engine, "live", { loaded: true }),
    ]);
    const routed = router.routeRequest([...rows, FREE_CLOUD], { ...OPTS, limit: 50 });
    const excluded = new Set(routed.decisionTrace.exclusions.map((row: Row) => row.id));
    for (const id of routed.candidates) expect(excluded.has(id)).toBe(false);
  });
});
