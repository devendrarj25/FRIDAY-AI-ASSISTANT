/**
 * The renderer model catalogue and the live main-process router must agree on
 * provider ids.
 *
 * `models-engine.ts` merges the real inventory with
 * `this.state.providerState[provider.id]` and stores keys with
 * `setProviderKey(id, …)`. When the two sides spell the same provider
 * differently (the real "google" vs "gemini" drift this test locks out), the
 * live status is silently dropped and the owner's API key is written under an
 * id the router never reads — the provider looks configured but can never
 * answer a request.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { providers } from "../../src/lib/friday/model-catalog";

const require_ = createRequire(import.meta.url);
const models = require_("../../electron/models.cjs") as {
  CLOUD: Record<string, unknown>;
  LOCAL_ENGINES: Record<string, unknown>;
};

const liveIds = new Set([
  ...Object.keys(models.CLOUD),
  ...Object.keys(models.LOCAL_ENGINES),
  "ollama",
]);

describe("provider id parity", () => {
  it("gives every live backend provider a catalogue entry", () => {
    const catalogIds = new Set(providers.map((p) => p.id as string));
    const missing = [...liveIds].filter((id) => !catalogIds.has(id));
    expect(missing).toEqual([]);
  });

  it("keeps Gemini on the router's id so keys and status reach it", () => {
    expect(liveIds.has("gemini")).toBe(true);
    expect(providers.some((p) => p.id === "gemini")).toBe(true);
    expect(providers.some((p) => (p.id as string) === "google")).toBe(false);
  });

  /**
   * The billing classifier keys off the same provider ids. A stale alias there
   * (the old "google" / "zai") makes classifyAccess() fall through to
   * "unknown", so the free-only policy can no longer gate that provider.
   */
  it("never classifies a random probe id as free without evidence", () => {
    const router = require_("../../electron/model-router.cjs") as {
      classifyAccess: (m: unknown) => string;
    };
    const accidentalFree = Object.keys(models.CLOUD).filter(
      (id) =>
        router.classifyAccess({
          id: `${id}-probe`,
          provider: id,
          meta: { providerId: id, kind: "cloud", modelName: `${id}-probe` },
        }) === "free",
    );
    expect(accidentalFree).toEqual([]);
  });
});
