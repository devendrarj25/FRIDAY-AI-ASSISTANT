/**
 * FRIDAY · fabric limitation → existing governance
 *
 * Detected gaps from conversation-state, knowledge, causal analysis,
 * self-evaluation, routing, modality, etc. become a governance *discovery*
 * on the existing queue. This is not a second self-modification path:
 * nothing is applied, generated, or written to production from here.
 * `code-change` stays always-ask.
 */

import { ALWAYS_ASK_KINDS, governance, type GovKind, type GovRisk } from "./governance";

export type FabricLimitation = {
  id: string;
  title: string;
  rationale: string;
  evidence?: string[];
  kind?: GovKind;
  risk?: GovRisk;
};

export type LimitationProposal = {
  id: string;
  stage: string;
  queued: boolean;
  applied: false;
  autoApproved: false;
};

function limitId(raw: string): string {
  const slug = String(raw || "gap")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug.startsWith("gov:limit:") ? slug : `gov:limit:${slug || "gap"}`;
}

/** File a limitation. Discovery only — never submit/apply. */
export function proposeFabricLimitation(limitation: FabricLimitation): LimitationProposal {
  const id = limitId(limitation.id);
  const kind: GovKind = limitation.kind ?? "code-change";
  const risk: GovRisk = limitation.risk ?? "review";
  const existing = governance.get(id);
  if (existing) {
    return {
      id: existing.id,
      stage: existing.stage,
      queued: false,
      applied: false,
      autoApproved: false,
    };
  }
  const item = governance.discover({
    id,
    kind,
    title: limitation.title,
    rationale: limitation.rationale,
    risk,
    evidence: limitation.evidence ?? [],
  });
  return {
    id: item.id,
    stage: item.stage,
    queued: true,
    applied: false,
    autoApproved: false,
  };
}

/** True when a kind cannot be applied without the owner. */
export function limitationAlwaysAsks(kind: GovKind = "code-change"): boolean {
  return ALWAYS_ASK_KINDS.has(kind);
}
