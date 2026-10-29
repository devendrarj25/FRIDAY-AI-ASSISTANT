/**
 * FRIDAY · confidence engine
 *
 * Runs BEFORE the local-vs-external decision. It answers one question with a
 * number: "given what I am actually measured to be good at, how likely am I to
 * finish THIS task well on my own machine?"
 *
 * It reads the live capability matrix (self/capability-matrix.ts) — no second
 * store, no invented figures — matches the task to the domains it needs, and
 * returns the weakest-link confidence for those domains. The existing routing
 * decision (brain/cost-policy.ts, used by brain/orchestrator.ts) consumes the
 * result, so "local or cloud" becomes confidence-driven instead of a fixed
 * free-first rule. There is still exactly one router.
 */

import {
  capabilityMatrix,
  DOMAINS,
  DOMAIN_LABEL,
  type CapabilityDomain,
} from "../self/capability-matrix";

/** Below this, FRIDAY does not trust herself to finish the task locally. */
export const CONFIDENT_THRESHOLD = 0.62;

/** Task text → the capability domains it actually exercises. */
const DOMAIN_HINTS: [RegExp, CapabilityDomain][] = [
  [/\b(code|coding|function|bug|refactor|typescript|python|compile|script|api)\b/i, "coding"],
  [
    /\b(why|prove|reason|analyse|analyze|explain|derive|compare|trade-?off|math|tender|rfp|eligibility)\b/i,
    "reasoning",
  ],
  [/\b(search|research|find out|look up|latest|news|documentation|source)\b/i, "research"],
  [/\b(file|folder|directory|path|open|save|copy|move|rename|zip|disk)\b/i, "file-operations"],
  [/\b(plan|steps|workflow|schedule|organi[sz]e|roadmap|break down)\b/i, "planning"],
  [/\b(tool|run|execute|install|command|terminal|automate|browser|connector)\b/i, "tool-use"],
];

export type Confidence = {
  /** 0–1. The weakest required domain, nudged by how many domains are needed. */
  score: number;
  /** Domains this task needs, in the order they were detected. */
  domains: CapabilityDomain[];
  /** True when FRIDAY should try to finish this locally. */
  local: boolean;
  /** One plain line for the pipeline notes and the run log. */
  rationale: string;
};

/** Which capability domains a task exercises. Always at least one. */
export function domainsForTask(text: string): CapabilityDomain[] {
  const found = DOMAIN_HINTS.filter(([re]) => re.test(text ?? "")).map(([, domain]) => domain);
  return found.length ? Array.from(new Set(found)) : ["conversation"];
}

/**
 * Estimate confidence for one task. Pure apart from reading the matrix, and
 * the matrix can be injected so the tests never need a browser.
 */
export function estimateConfidence(
  text: string,
  options: {
    domains?: CapabilityDomain[];
    ability?: (domain: CapabilityDomain) => number;
    threshold?: number;
  } = {},
): Confidence {
  const ability = options.ability ?? ((domain) => capabilityMatrix.ability(domain));
  const threshold = options.threshold ?? CONFIDENT_THRESHOLD;
  const domains = (options.domains ?? domainsForTask(text)).filter((d) => DOMAINS.includes(d));
  const list = domains.length ? domains : (["conversation"] as CapabilityDomain[]);

  // Weakest link: a task is only as safe as its worst required capability.
  const values = list.map((domain) => ability(domain));
  const weakest = Math.min(...values);
  // Every extra required domain is one more chance to fail, so a multi-domain
  // task is discounted slightly rather than scored on its weakest link alone.
  const score = Math.max(0, Math.min(1, weakest * (1 - 0.05 * (list.length - 1))));
  const local = score >= threshold;
  const worst = list[values.indexOf(weakest)] as CapabilityDomain;

  return {
    score,
    domains: list,
    local,
    rationale: local
      ? `confidence ${Math.round(score * 100)}% on ${list.map((d) => DOMAIN_LABEL[d]).join(", ")} — staying local`
      : `confidence ${Math.round(score * 100)}% — ${DOMAIN_LABEL[worst]} is the weak point, a stronger model is preferred`,
  };
}
