/**
 * FRIDAY · live workflow introspection
 *
 * "What is your current workflow?", "how do you pick a model?", "what happens
 * when I send a message?" — answered by READING the running state, never from
 * a written-down description that can rot:
 *
 *   · connected providers      → the real connector snapshot + model registry
 *   · free/paid policy         → the usage policy + route mode in force now
 *   · local models             → what discovery actually found installed
 *   · voice mode               → the live voice state machine + preferences
 *   · privacy firewall         → the mirrored egress decisions + tiers
 *   · health                   → the doctor engine's last real scan
 *
 * This is a normal brain capability: `baselineRespond()` routes the question
 * here, so chat, voice and Auto Mode all get the identical answer through the
 * one path they already share. Nothing is invented — when a source cannot be
 * read in this build it says so.
 */

import { modelRegistry as usageRegistry } from "../model-registry";
import { currentPolicy, describePolicy } from "./cost-policy";
import { knownConnectors } from "../connectors";
import { preferences } from "../preferences";
import { privacy } from "../privacy";
import { attentionWindowSeconds } from "../attention-window";

export type WorkflowSnapshot = {
  providers: { id: string; name: string; connected: boolean }[];
  cloudModelProviders: string[];
  policy: string;
  policyLine: string;
  routeMode: string;
  pinned: string[];
  localModels: { id: string; label: string; ready: boolean }[];
  voice: {
    wakeWord: string;
    handsFree: boolean;
    attentionWindowSec: number;
    state: string;
    speakReplies: boolean;
  };
  privacyLine: string;
  privacyTiers: { safeTools: boolean; workspaceWrites: boolean; execApproval: boolean };
  health: { at: number | null; checks: number; problems: number; warnings: number; note: string };
};

/** Live registry read that never throws into a turn. */
function registrySnapshot() {
  try {
    return usageRegistry.getSnapshot();
  } catch {
    return null;
  }
}

/**
 * The real running configuration. Voice and doctor are imported lazily: both
 * sit above the brain in the module graph, and a static import here would
 * create a cycle through brain-engine.
 */
export async function workflowSnapshot(): Promise<WorkflowSnapshot> {
  const registry = registrySnapshot();
  const models = registry?.models ?? [];

  const connectors = (() => {
    try {
      return knownConnectors();
    } catch {
      return [];
    }
  })();

  const prefs = (() => {
    try {
      return preferences.getSnapshot();
    } catch {
      return null;
    }
  })();

  let voiceState = "OFF";
  let handsFree = false;
  try {
    const { assistantMode } = await import("../assistant-mode");
    const snap = assistantMode.getSnapshot();
    voiceState = snap.voiceState;
    handsFree = snap.handsFree;
  } catch {
    /* voice store unavailable in this build — reported as OFF */
  }

  let health: WorkflowSnapshot["health"] = {
    at: null,
    checks: 0,
    problems: 0,
    warnings: 0,
    note: "no diagnostic has run in this session yet",
  };
  try {
    const { doctor, isProblem, isWarning } = await import("../doctor-engine");
    const snap = doctor.getSnapshot();
    if (snap.checks.length) {
      health = {
        at: snap.lastScanAt,
        checks: snap.checks.length,
        problems: snap.checks.filter((c) => isProblem(c.status)).length,
        warnings: snap.checks.filter((c) => isWarning(c.status)).length,
        note: "",
      };
    }
  } catch {
    /* doctor unavailable — the "no scan yet" note stands */
  }

  return {
    providers: connectors.map((c) => ({ id: c.id, name: c.name, connected: c.connected })),
    cloudModelProviders: [
      ...new Set(models.filter((m) => m.type === "cloud" && m.available).map((m) => m.provider)),
    ],
    policy: registry?.policy ?? currentPolicy(),
    policyLine: describePolicy(registry?.policy ?? currentPolicy()),
    routeMode: registry?.routeMode ?? "auto",
    pinned: registry?.selected ?? [],
    localModels: models
      .filter((m) => m.type === "local")
      .map((m) => ({ id: m.id, label: m.label, ready: m.available })),
    voice: {
      wakeWord: prefs?.voice.wakeWord || "friday",
      handsFree,
      attentionWindowSec: attentionWindowSeconds(),
      state: voiceState,
      speakReplies: prefs?.voice.speakReplies ?? true,
    },
    privacyLine: (() => {
      try {
        return privacy.summary();
      } catch {
        return "privacy mirror unavailable in this build";
      }
    })(),
    privacyTiers: {
      safeTools: prefs?.toggles["safeTools"] ?? true,
      workspaceWrites: prefs?.toggles["workspaceWrites"] ?? false,
      execApproval: prefs?.toggles["execApproval"] ?? true,
    },
    health,
  };
}

/** The spoken/typed answer, built entirely from the snapshot above. */
export function renderWorkflow(state: WorkflowSnapshot): string {
  const connected = state.providers.filter((p) => p.connected);
  const readyLocal = state.localModels.filter((m) => m.ready);

  const lines: string[] = [
    "This is my live workflow right now, read from my own running state:",
    "",
    "1. Every message — typed, spoken or from Auto Mode — enters the same core brain: my baseline brain answers what it can, then memory and context are attached, then a model is routed.",
    `2. Model routing: route mode "${state.routeMode}", usage policy "${state.policy}" — ${state.policyLine}.`,
    state.pinned.length
      ? `   You have pinned: ${state.pinned.join(", ")}, so those run instead of my automatic pick.`
      : "   Nothing is pinned, so I choose automatically, local and free first.",
    readyLocal.length
      ? `3. Local models ready on this PC: ${readyLocal.map((m) => m.label).join(", ")}.`
      : "3. No local model is installed and ready right now.",
    state.cloudModelProviders.length
      ? `4. Cloud providers whose key really answered: ${state.cloudModelProviders.join(", ")}.`
      : "4. No cloud provider is currently reachable with a verified key.",
    connected.length
      ? `5. Connected services: ${connected.map((p) => p.name).join(", ")}.`
      : "5. No external service connector is verified yet.",
    `6. Voice: wake word "${state.voice.wakeWord}", ${
      state.voice.handsFree
        ? "hands-free is ON (no wake word needed for follow-ups)"
        : "wake word required"
    }, attention window ${state.voice.attentionWindowSec}s, current voice state ${state.voice.state}.`,
    `7. Privacy firewall: ${state.privacyLine}. Safe tools ${
      state.privacyTiers.safeTools ? "on" : "off"
    }, workspace writes ${state.privacyTiers.workspaceWrites ? "on" : "off"}, exec approval ${
      state.privacyTiers.execApproval ? "required" : "not required"
    }.`,
    state.health.note
      ? `8. Health: ${state.health.note}.`
      : `8. Health: last scan checked ${state.health.checks} items — ${state.health.problems} problem(s), ${state.health.warnings} warning(s).`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** One call for the responder: read live state, render the answer. */
export async function describeWorkflow(): Promise<string> {
  return renderWorkflow(await workflowSnapshot());
}

/** Does this prompt ask FRIDAY to describe her own current workflow? */
export const WORKFLOW_ASK =
  /\b(your|current|the)\s+(workflow|pipeline|routing|decision\s+process)\b|\bhow do you (decide|choose|pick)\b.*\bmodel\b|\bwhat happens when i (send|type|say|ask)\b|\bhow do you work\b|\bexplain your (workflow|pipeline|setup|routing)\b/i;
