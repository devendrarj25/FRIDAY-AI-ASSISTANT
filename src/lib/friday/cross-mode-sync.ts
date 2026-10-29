/**
 * FRIDAY · cross-mode routing sync.
 *
 * Chat, Auto Mode voice and any other surface must reach the same model for
 * the same conditions. They already share brain-engine → runtime → the main
 * router; what CAN drift is the state each surface reads: a stale registry
 * snapshot in the voice session, or a route mode/pinned pick that only the
 * chat dock passed along.
 *
 * This module measures that drift for real (no simulation) and, where the
 * single source of truth can simply be re-read, exposes a safe repair. When a
 * drift has no safe automatic repair it is reported as-is.
 */

import { modelRegistry as usageRegistry } from "./model-registry";
import { prepareTurn } from "./runtime";
import { withRoutingDefaults } from "./brain-engine";

export type SyncDrift = {
  id: string;
  detail: string;
  /** True only when re-reading the source of truth genuinely fixes it. */
  repairable: boolean;
};

export type CrossModeSync = {
  ok: boolean;
  /** Model ids a typed chat turn would use right now. */
  chatModelIds: string[];
  /** Model ids an Auto Mode voice turn would use right now. */
  voiceModelIds: string[];
  routeMode: string;
  pinned: string[];
  drifts: SyncDrift[];
  detail: string;
};

const PROBE = "cross-mode routing self-check";

/** Compare the two surfaces against the same probe, right now. */
export function inspectCrossModeSync(): CrossModeSync {
  const drifts: SyncDrift[] = [];
  let routeMode = "auto";
  let pinned: string[] = [];
  try {
    const snapshot = usageRegistry.getSnapshot();
    routeMode = snapshot.routeMode;
    pinned = [...snapshot.selected];
  } catch {
    drifts.push({
      id: "registry",
      detail: "the model registry could not be read — routing state is unknown",
      repairable: true,
    });
  }

  const chat = prepareTurn(PROBE, { mode: "manual" }).modelIds;
  const voice = prepareTurn(PROBE, { mode: "auto" }).modelIds;
  // Auto Mode deliberately answers with the single best model (spoken latency)
  // while manual chat may fan out — that is by design and NOT drift. What must
  // match is the model both surfaces pick first, and voice must never see a
  // model chat cannot: that would mean two different registries.
  if ((chat[0] ?? "") !== (voice[0] ?? "")) {
    drifts.push({
      id: "model-selection",
      detail: `chat would answer with "${chat[0] ?? "none"}" but voice would answer with "${voice[0] ?? "none"}"`,
      // Both come from the shared router over shared state, so re-reading the
      // single source of truth is the honest automatic remedy.
      repairable: true,
    });
  }
  const unknown = voice.filter((id) => !chat.includes(id));
  if (unknown.length) {
    drifts.push({
      id: "model-visibility",
      detail: `voice can reach models chat cannot: ${unknown.join(", ")}`,
      repairable: true,
    });
  }

  // The routing options each surface carries. Both go through the same
  // defaulting helper, so an empty result here means a real regression.
  const chatOptions = withRoutingDefaults({ routeMode, modelIds: pinned });
  const voiceOptions = withRoutingDefaults({});
  if ((chatOptions.routeMode ?? "") !== (voiceOptions.routeMode ?? "")) {
    drifts.push({
      id: "route-mode",
      detail: `chat sends route mode "${chatOptions.routeMode}" while voice sends "${voiceOptions.routeMode}"`,
      repairable: false,
    });
  }
  if ((chatOptions.modelIds ?? []).join("|") !== (voiceOptions.modelIds ?? []).join("|")) {
    drifts.push({
      id: "pinned-models",
      detail: `pinned models differ between chat (${
        (chatOptions.modelIds ?? []).join(", ") || "none"
      }) and voice (${(voiceOptions.modelIds ?? []).join(", ") || "none"})`,
      repairable: false,
    });
  }

  return {
    ok: drifts.length === 0,
    chatModelIds: chat,
    voiceModelIds: voice,
    routeMode,
    pinned,
    drifts,
    detail: drifts.length
      ? drifts.map((d) => d.detail).join("; ")
      : `chat and voice both answer with ${chat[0] ?? "no model (none available)"} · route mode ${routeMode}`,
  };
}

/**
 * The safe repair: force a real re-read of the single source of truth and
 * re-measure. Returns the log lines and whether the drift actually cleared —
 * it never claims success it did not observe.
 */
export async function resyncModes(): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  const before = inspectCrossModeSync();
  if (before.ok) return { ok: true, log: ["already in sync — nothing to re-sync"] };
  if (!before.drifts.some((d) => d.repairable)) {
    return {
      ok: false,
      log: [`no safe automatic repair for: ${before.drifts.map((d) => d.id).join(", ")}`],
    };
  }
  try {
    await usageRegistry.refresh(true);
    log.push("model registry re-read from the main process");
  } catch (error) {
    log.push(`registry refresh failed: ${(error as Error).message}`);
  }
  const after = inspectCrossModeSync();
  log.push(after.ok ? "chat and voice now agree" : `still drifting: ${after.detail}`);
  return { ok: after.ok, log };
}
