/**
 * FRIDAY · choosing the control to act on
 *
 * Given a UI Automation tree and what the owner (or a plan step) named, pick the one control meant, or none.
 * A guess that clicks the wrong button is worse than asking, so a pick needs a clear winner: an exact name
 * wins outright, a partial match must beat the runner-up by a margin, and controls that are never acted on
 * (password, payment, captcha, secure desktop) or that are disabled are not candidates at all.
 */

import type { DeskControl } from "./computer-use";

const NEVER = new Set<DeskControl["role"]>(["password", "payment", "captcha", "uac"]);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);

function flatten(controls: DeskControl[], out: DeskControl[] = []): DeskControl[] {
  for (const control of controls) {
    out.push(control);
    if (control.children) flatten(control.children, out);
  }
  return out;
}

function score(control: DeskControl, wanted: string, role?: DeskControl["role"]): number {
  const name = control.name.toLowerCase().trim();
  const target = wanted.toLowerCase().trim();
  if (!name || !target) return 0;
  if (control.selector && control.selector === wanted) return 100;
  let value: number;
  if (name === target) value = 90;
  else {
    const have = new Set(words(name));
    const need = words(target);
    if (!need.length) return 0;
    const same = (a: string, b: string) =>
      a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
    const hit = need.filter((word) => [...have].some((other) => same(word, other))).length;
    if (hit === 0) return 0;
    const coverage = hit / need.length;
    const tightness = hit / Math.max(have.size, 1);
    value = 40 * coverage + 30 * tightness;
  }
  if (role && control.role === role) value += 10;
  if (role && control.role !== role) value -= 15;
  if (control.stale) value -= 5;
  return value;
}

export type TargetPick = {
  control: DeskControl | null;
  /** Why there is none: nothing matched, or several matched about equally. */
  reason?: "no-match" | "ambiguous";
  alternatives: string[];
};

const MARGIN = 12;
const FLOOR = 45;

export function pickControl(
  tree: DeskControl[],
  wanted: string,
  role?: DeskControl["role"],
): TargetPick {
  const ranked = flatten(tree)
    .filter((control) => !NEVER.has(control.role) && control.enabled !== false)
    .map((control) => ({ control, value: score(control, wanted, role) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const best = ranked[0];
  if (!best || best.value < FLOOR) return { control: null, reason: "no-match", alternatives: [] };
  const next = ranked[1];
  const alternatives = ranked.slice(1, 4).map((row) => row.control.name);
  if (next && best.value < 90 && best.value - next.value < MARGIN) {
    return {
      control: null,
      reason: "ambiguous",
      alternatives: [best.control.name, ...alternatives],
    };
  }
  return { control: best.control, alternatives };
}
