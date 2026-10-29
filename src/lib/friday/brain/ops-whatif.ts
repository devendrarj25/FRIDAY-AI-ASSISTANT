/**
 * FRIDAY · ops what-if
 *
 * What-if for FRIDAY's own operations only: routing one model vs another from
 * recorded health, and which stored components depend on an entity. Not a
 * forecasting model and not user-world prediction (prices, project dates).
 */

import { modelRegistry } from "./model-registry";
import { dependentsOf } from "./knowledge-graph";

export type WhatIfKind = "route" | "dependency";

export type WhatIfResult = {
  kind: WhatIfKind;
  asked: string;
  outcome: string;
  historical: boolean;
  inconclusive: boolean;
};

function perfOf(modelId: string) {
  return modelRegistry.performance().find((row) => row.modelId === modelId) ?? null;
}

/** Historical comparison of two model ids FRIDAY has actually run. */
export function whatIfRoute(fromId: string, toId: string): WhatIfResult {
  const from = String(fromId || "").trim();
  const to = String(toId || "").trim();
  const asked = `if I route to ${to} instead of ${from}`;
  const a = perfOf(from);
  const b = perfOf(to);
  if (!a && !b) {
    return {
      kind: "route",
      asked,
      outcome: "no historical runs for either model — will not invent a forecast",
      historical: false,
      inconclusive: true,
    };
  }
  const bits: string[] = [];
  if (a) {
    bits.push(
      `${from}: ${a.successes}/${a.runs} ok, avg ${a.avgMs}ms` +
        (a.lastError ? `, last error ${a.lastError}` : ""),
    );
  } else bits.push(`${from}: no recorded runs`);
  if (b) {
    bits.push(
      `${to}: ${b.successes}/${b.runs} ok, avg ${b.avgMs}ms` +
        (b.lastError ? `, last error ${b.lastError}` : ""),
    );
  } else bits.push(`${to}: no recorded runs`);
  return {
    kind: "route",
    asked,
    outcome: bits.join("; "),
    historical: true,
    inconclusive: !a || !b,
  };
}

/** Who already declares a depends-on edge to this entity. */
export function whatIfDependencyChange(entity: string): WhatIfResult {
  const name = String(entity || "").trim();
  const asked = `if I change ${name}`;
  const hops = dependentsOf(name);
  if (!hops.length) {
    return {
      kind: "dependency",
      asked,
      outcome: `no stored depends-on edges point at ${name} — will not guess breakages`,
      historical: false,
      inconclusive: true,
    };
  }
  return {
    kind: "dependency",
    asked,
    outcome:
      hops.map((hop) => `${hop.from} depends-on ${hop.to}`).join("; ") +
      ` (${hops.length} stored dependent${hops.length === 1 ? "" : "s"})`,
    historical: true,
    inconclusive: false,
  };
}

const ROUTE =
  /\b(?:if I|what if I)\s+(?:route|switch|use)\s+(?:to\s+)?([\w.:-]+)\s+instead of\s+([\w.:-]+)/i;
const DEPEND = /\b(?:if I|what if I)\s+change\s+([\w./:-]+)/i;

/** Parse an owner prompt; returns null when this is not an ops what-if. */
export function whatIfFromPrompt(prompt: string): WhatIfResult | null {
  const text = String(prompt || "").trim();
  const route = ROUTE.exec(text);
  if (route) return whatIfRoute(String(route[2]), String(route[1]));
  const depend = DEPEND.exec(text);
  if (depend) return whatIfDependencyChange(String(depend[1]));
  return null;
}
