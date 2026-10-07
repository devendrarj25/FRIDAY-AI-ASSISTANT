/**
 * FRIDAY · world / state model
 *
 * A live snapshot assembled from existing sources of truth. This file is not a
 * second registry: every fact names the module it was read from. `world-model.ts`
 * did not exist before this upgrade, so it lives here with the rest of the
 * brain fabric (not under a parallel `world/` tree).
 *
 * Devices/surfaces use the same usage registry `cross-mode-sync.ts` reads,
 * without calling `inspectCrossModeSync()` (that path pulls `prepareTurn` /
 * `brain-engine` and would cycle if Core Brain imported this file).
 */

import { ownerContextDigest } from "./identity";
import { userProfileDigest } from "./user-profile";
import { brainKnowledge } from "./knowledge-base";
import { modelRegistry } from "./model-registry";
import { capabilityRegistry } from "./capability-registry";
import { governance } from "../self/governance";
import { taskGraph } from "../self/task-graph";
import { lastDecision } from "./decision-trace";
import { modelRegistry as usageRegistry } from "../model-registry";
import { actionMode } from "./action-risk";
import { terminalSnapshot } from "../terminal-awareness";
import { browserSnapshot } from "../browser-awareness";
import { library } from "../library-engine";
import { projectWorkspaces } from "../project-workspace-engine";

export type WorldDomain =
  | "owner"
  | "project"
  | "files"
  | "tasks"
  | "devices"
  | "apps"
  | "models"
  | "capabilities"
  | "events"
  | "approvals"
  | "risks";

export type WorldFreshness = "verified" | "unknown" | "stale";

export type WorldFact = {
  domain: WorldDomain;
  key: string;
  value: string;
  source: string;
  at: number;
  ttlMs: number;
  freshness: WorldFreshness;
};

export const WORLD_TTL_MS: Record<WorldDomain, number> = {
  owner: 60 * 60 * 1000,
  project: 10 * 60 * 1000,
  files: 30 * 1000,
  tasks: 20 * 1000,
  devices: 30 * 1000,
  apps: 60 * 1000,
  models: 15 * 1000,
  capabilities: 30 * 1000,
  events: 60 * 1000,
  approvals: 10 * 1000,
  risks: 30 * 1000,
};

export type WorldSnapshot = {
  at: number;
  facts: WorldFact[];
  summary: string;
};

function fact(
  domain: WorldDomain,
  key: string,
  value: string,
  source: string,
  freshness: WorldFreshness,
  at: number,
): WorldFact {
  return { domain, key, value, source, at, ttlMs: WORLD_TTL_MS[domain], freshness };
}

export function factFreshness(entry: WorldFact, now = Date.now()): WorldFreshness {
  if (entry.freshness === "unknown") return "unknown";
  if (now - entry.at > entry.ttlMs) return "stale";
  return "verified";
}

function pushCaught(
  facts: WorldFact[],
  domain: WorldDomain,
  key: string,
  source: string,
  at: number,
  read: () => { value: string; freshness: WorldFreshness },
): void {
  try {
    const got = read();
    facts.push(fact(domain, key, got.value, source, got.freshness, at));
  } catch {
    facts.push(fact(domain, key, "unreadable", source, "unknown", at));
  }
}

/** Live world state from existing registries only. */
export function readWorldState(now = Date.now()): WorldSnapshot {
  const facts: WorldFact[] = [];

  pushCaught(facts, "owner", "identity", "brain/identity.ts", now, () => {
    const digest = ownerContextDigest();
    return {
      value: `${digest.name} (publisher on-ask)`,
      freshness: digest.owner ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "owner", "user-profile", "brain/user-profile.ts", now, () => {
    const user = userProfileDigest();
    const bits = [
      user.honorific ? `address ${user.honorific}` : "honorific unset",
      user.preferredName ? `name ${user.preferredName}` : "",
      user.occupation ? `work ${user.occupation}` : "",
      user.location ? `in ${user.location}` : "",
      user.about ? "about set" : "",
      user.notes ? "notes set" : "",
    ].filter(Boolean);
    return {
      value: bits.join("; ") || "empty",
      freshness:
        user.preferredName || user.about || user.occupation || user.notes ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "project", "active", "brain/knowledge-base.ts", now, () => {
    const projects = brainKnowledge.entries("project");
    const first = projects[0];
    return {
      value: first ? first.title : "none declared",
      freshness: first ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "project", "workspace", "project-workspace-engine.ts", now, () => {
    const active = projectWorkspaces.active();
    if (!active) {
      return { value: "none active", freshness: "unknown" };
    }
    const lock = active.handsOffAuto || active.preferences.handsOffAuto ? "; Auto hands-off" : "";
    return {
      value: `${active.name} (${active.kind})${lock}`,
      freshness: "verified",
    };
  });

  pushCaught(facts, "files", "library", "library-engine.ts", now, () => {
    const items = library.list();
    const pinned = items.filter((item) => item.pinnedForAuto).length;
    return {
      value: items.length
        ? `${items.length} library item(s)${pinned ? `, ${pinned} pinned` : ""}`
        : "empty",
      freshness: items.length ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "tasks", "open", "self/task-graph.ts + brain/knowledge-base.ts", now, () => {
    const graphs = taskGraph
      .list()
      .filter((graph) => graph.state !== "completed" && graph.state !== "cancelled");
    const brainTasks = brainKnowledge.unfinishedTasks();
    const n = graphs.length + brainTasks.length;
    return {
      value: n ? `${n} open (${graphs.length} graph, ${brainTasks.length} brain)` : "none",
      freshness: "verified",
    };
  });

  pushCaught(
    facts,
    "devices",
    "surfaces",
    "model-registry.ts (same SOT as cross-mode-sync.ts)",
    now,
    () => {
      const snap = usageRegistry.getSnapshot();
      return {
        value: `route ${snap.routeMode}; pinned ${snap.selected.length}`,
        freshness: "verified",
      };
    },
  );

  pushCaught(facts, "apps", "services", "brain/capability-registry.ts", now, () => {
    const snap = capabilityRegistry.getSnapshot();
    const tools = snap.resources.filter(
      (row) => row.type === "tool" || row.type === "system",
    ).length;
    return {
      value: `${tools} tool/system resources (${snap.availableCount} available overall)`,
      freshness: snap.resources.length ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "apps", "terminal", "terminal-awareness.ts", now, () => {
    const term = terminalSnapshot();
    const value = term.cwd
      ? `${term.shell} @ ${term.cwd}${term.running ? " (running)" : ""}${
          term.lastCommand ? `; last ${term.lastCommand}` : ""
        }`
      : "idle (no FRIDAY root session yet)";
    return { value, freshness: term.cwd ? "verified" : "unknown" };
  });

  pushCaught(facts, "apps", "browser", "browser-awareness.ts", now, () => {
    const snap = browserSnapshot();
    const active = snap.tabs.find((tab) => tab.id === snap.activeId) || snap.tabs[0];
    const value = active
      ? `${active.title || active.url} (${snap.tabs.length} tab${snap.tabs.length === 1 ? "" : "s"}; ${snap.engine})`
      : "idle (no tabs)";
    return { value, freshness: active ? "verified" : "unknown" };
  });

  pushCaught(facts, "models", "available", "brain/model-registry.ts", now, () => {
    const ids = modelRegistry.available().map((row) => row.id);
    return {
      value: ids.length ? ids.slice(0, 8).join(", ") : "none routable",
      freshness: ids.length ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "capabilities", "counts", "brain/capability-registry.ts", now, () => {
    const snap = capabilityRegistry.getSnapshot();
    const parts = Object.entries(snap.counts)
      .filter(([, n]) => n > 0)
      .map(([type, n]) => `${type}:${n}`);
    return {
      value: parts.join(", ") || "empty",
      freshness: snap.resources.length ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "events", "last-decision", "brain/decision-trace.ts", now, () => {
    const last = lastDecision();
    return {
      value: last ? last.routing.slice(0, 160) : "none this session",
      freshness: last ? "verified" : "unknown",
    };
  });

  pushCaught(facts, "approvals", "pending", "self/governance.ts", now, () => {
    const pending = governance.pending();
    return {
      value: pending.length
        ? pending
            .slice(0, 4)
            .map((item) => item.title)
            .join("; ")
        : "none",
      freshness: "verified",
    };
  });

  pushCaught(facts, "risks", "known", "self/governance.ts + brain/action-risk.ts", now, () => {
    const pending = governance.pending();
    const risky = pending.filter((item) => item.risk === "risky");
    const degraded = capabilityRegistry
      .getSnapshot()
      .resources.filter((row) => row.health === "degraded" || row.health === "offline")
      .slice(0, 4);
    const bits = [
      `mode ${actionMode()}`,
      risky.length ? `${risky.length} high-risk pending` : "no high-risk pending",
      degraded.length
        ? `degraded: ${degraded.map((row) => row.name).join(", ")}`
        : "no degraded resources",
    ];
    return { value: bits.join("; "), freshness: "verified" };
  });

  const stale = facts.filter((entry) => entry.freshness === "unknown").length;
  const summary = facts.map((entry) => `${entry.domain}:${entry.freshness}`).join(" · ");

  return {
    at: now,
    facts,
    summary: stale ? `${summary} (${stale} unknown)` : summary,
  };
}

export type WorldInsight = {
  snapshot: WorldSnapshot;
  exists: string[];
  happening: string[];
  changed: string[];
  expected: string[];
  depends: string[];
  atRisk: string[];
  unknown: string[];
  /** FRIDAY-ops only: pending approvals, cooling models, open graphs. */
  likelyNext: string[];
};

let previousWorld = new Map<string, string>();

export function resetWorldInsightForTests(): void {
  previousWorld = new Map();
}

/**
 * What exists / is happening / changed / expected / depends / at risk / unknown
 * — assembled from the same snapshot, not a second registry.
 */
export function readWorldInsight(now = Date.now()): WorldInsight {
  const snapshot = readWorldState(now);
  const exists: string[] = [];
  const happening: string[] = [];
  const changed: string[] = [];
  const expected: string[] = [];
  const depends: string[] = [];
  const atRisk: string[] = [];
  const unknown: string[] = [];
  const likelyNext: string[] = [];

  for (const row of snapshot.facts) {
    const live = factFreshness(row, now);
    if (live === "unknown") unknown.push(`${row.domain}: ${row.value}`);
    if (live === "stale") unknown.push(`${row.domain} stale`);
    if (row.domain === "owner" || row.domain === "project" || row.domain === "apps") {
      exists.push(`${row.domain}: ${row.value}`);
    }
    if (row.domain === "tasks" || row.domain === "events") {
      happening.push(`${row.domain}: ${row.value}`);
    }
    if (row.domain === "approvals") happening.push(`approvals: ${row.value}`);
    if (row.domain === "risks") atRisk.push(row.value);
    if (live === "verified" && row.ttlMs > 0 && now - row.at > row.ttlMs * 0.8) {
      atRisk.push(`${row.domain} nearing stale`);
    }
    if (row.domain === "models" && /cooling|none routable|degraded/i.test(row.value)) {
      changed.push(`models: ${row.value}`);
      atRisk.push(`models: ${row.value}`);
    }
    const key = `${row.domain}:${row.key}`;
    const prior = previousWorld.get(key);
    if (prior !== undefined && prior !== row.value) {
      changed.push(`${row.domain}.${row.key}: ${prior} → ${row.value}`);
    }
  }
  previousWorld = new Map(snapshot.facts.map((row) => [`${row.domain}:${row.key}`, row.value]));

  try {
    const graphs = taskGraph
      .list()
      .filter((graph) => graph.state !== "completed" && graph.state !== "cancelled");
    for (const graph of graphs.slice(0, 4)) {
      const goal = graph.horizon?.goal ?? graph.request;
      expected.push(goal.slice(0, 120));
      if (graph.horizon?.blockers.length) {
        depends.push(graph.horizon.blockers.slice(-2).join("; "));
        changed.push(`blocked: ${graph.horizon.blockers[graph.horizon.blockers.length - 1]}`);
      }
    }
  } catch {
    unknown.push("task graph unreadable");
  }

  try {
    const cooling = modelRegistry
      .list()
      .filter((row) => row.coolingDown)
      .slice(0, 4);
    if (cooling.length) {
      changed.push(`cooling: ${cooling.map((row) => row.name).join(", ")}`);
      atRisk.push(`cooling: ${cooling.map((row) => row.name).join(", ")}`);
    }
  } catch {
    /* optional */
  }

  const approvals = snapshot.facts.find((row) => row.domain === "approvals");
  if (approvals && !/^none$/i.test(approvals.value)) {
    likelyNext.push(`resolve pending approval: ${approvals.value.slice(0, 80)}`);
  }
  const coolingLine = atRisk.find((row) => /^cooling:/i.test(row));
  if (coolingLine) likelyNext.push(`switch away from ${coolingLine}`);
  const openTasks = snapshot.facts.find((row) => row.domain === "tasks");
  if (openTasks && !/^none$/i.test(openTasks.value)) {
    likelyNext.push(`continue open work: ${openTasks.value.slice(0, 80)}`);
  }

  return { snapshot, exists, happening, changed, expected, depends, atRisk, unknown, likelyNext };
}

export type BeliefProvenance = "verified" | "user" | "observed" | "model";

export type TemporalClaim = {
  key: string;
  value: string;
  source: string;
  at: number;
  confidence: number;
  stale?: boolean;
  provenance: BeliefProvenance;
};

export type BeliefStatus = "known" | "unknown" | "stale" | "contradicted" | "uncertain";

export type BeliefMark = {
  key: string;
  value: string;
  status: BeliefStatus;
  confidence: number;
  provenance: string;
  at: string;
  challenger?: string;
};

const PROVENANCE_RANK: Record<BeliefProvenance, number> = {
  verified: 4,
  user: 3,
  observed: 2,
  model: 1,
};

const BELIEF_STALE_MS = 14 * 86_400_000;

function clampBelief(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Two fresh values for one key stay contradicted.
 * Ties keep the earlier claim. A newer model write does not erase an
 * observed or verified one.
 */
export function reconcileTemporalBeliefs(claims: TemporalClaim[], now = Date.now()): BeliefMark[] {
  const groups = new Map<string, TemporalClaim[]>();
  for (const claim of claims) {
    const key = claim.key.trim().toLowerCase();
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(claim);
    groups.set(key, list);
  }

  const marks: BeliefMark[] = [];
  for (const [key, rows] of groups) {
    const distinct = new Map<string, TemporalClaim>();
    for (const row of rows) {
      const value = row.value.trim();
      const slot = value.toLowerCase();
      const prev = distinct.get(slot);
      if (!prev || PROVENANCE_RANK[row.provenance] > PROVENANCE_RANK[prev.provenance]) {
        distinct.set(slot, { ...row, value });
      }
    }
    const values = [...distinct.values()];
    if (values.length >= 2) {
      const ranked = [...values].sort((a, b) => {
        const bySource = PROVENANCE_RANK[b.provenance] - PROVENANCE_RANK[a.provenance];
        if (bySource !== 0) return bySource;
        const byConfidence = clampBelief(b.confidence) - clampBelief(a.confidence);
        if (Math.abs(byConfidence) > 0.001) return byConfidence;
        return a.at - b.at;
      });
      const kept = ranked[0]!;
      const challenger = ranked.find(
        (row) => row.value.toLowerCase() !== kept.value.toLowerCase(),
      )!;
      const bothStale = Boolean(kept.stale) && Boolean(challenger.stale);
      marks.push({
        key,
        value: kept.value.slice(0, 280),
        status: bothStale ? "stale" : "contradicted",
        confidence: clampBelief(Math.min(kept.confidence, challenger.confidence)),
        provenance: `${kept.provenance} (${kept.source})`,
        at: new Date(kept.at).toISOString(),
        challenger: `${challenger.value.slice(0, 180)} @ ${new Date(challenger.at).toISOString()} (${challenger.provenance})`,
      });
      continue;
    }

    const row = values[0];
    if (!row || !row.value) {
      marks.push({
        key,
        value: "",
        status: "unknown",
        confidence: 0,
        provenance: row ? `${row.provenance} (${row.source})` : "none",
        at: new Date(row?.at ?? now).toISOString(),
      });
      continue;
    }
    const stale = Boolean(row.stale) || now - row.at > BELIEF_STALE_MS;
    const confidence = clampBelief(stale ? row.confidence * 0.5 : row.confidence);
    let status: BeliefStatus = "known";
    if (stale) status = "stale";
    else if (confidence < 0.45) status = "uncertain";
    marks.push({
      key,
      value: row.value.slice(0, 280),
      status,
      confidence,
      provenance: `${row.provenance} (${row.source})`,
      at: new Date(row.at).toISOString(),
    });
  }
  return marks;
}
