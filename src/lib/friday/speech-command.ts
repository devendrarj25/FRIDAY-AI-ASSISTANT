import { featuresFor } from "./speech-features";

export type CommandTemplate = { name: string; frames: number[][] };

const templates: CommandTemplate[] = [];

export function resetCommandTemplates(): void {
  templates.length = 0;
}

export function enrollCommand(name: string, samples: Float32Array, rate = 16000): CommandTemplate {
  const row = { name, frames: framesOf(samples, rate) };
  const existing = templates.findIndex((item) => item.name === name);
  if (existing >= 0) templates.splice(existing, 1, row);
  else templates.push(row);
  return row;
}

export function forgetCommand(name: string): void {
  const index = templates.findIndex((item) => item.name === name);
  if (index >= 0) templates.splice(index, 1);
}

function dtw(left: number[][], right: number[][]): number {
  if (!left.length || !right.length) return Number.POSITIVE_INFINITY;
  const rows = left.length;
  const cols = right.length;
  const cost: number[] = new Array((rows + 1) * (cols + 1)).fill(Number.POSITIVE_INFINITY);
  const at = (r: number, c: number) => r * (cols + 1) + c;
  cost[at(0, 0)] = 0;
  for (let r = 1; r <= rows; r += 1) {
    for (let c = 1; c <= cols; c += 1) {
      const a = left[r - 1] ?? [];
      const b = right[c - 1] ?? [];
      let dist = 0;
      const width = Math.max(a.length, b.length);
      for (let i = 0; i < width; i += 1) dist += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
      const best = Math.min(
        cost[at(r - 1, c)] ?? Infinity,
        cost[at(r, c - 1)] ?? Infinity,
        cost[at(r - 1, c - 1)] ?? Infinity,
      );
      cost[at(r, c)] = dist + best;
    }
  }
  return cost[at(rows, cols)] ?? Number.POSITIVE_INFINITY;
}

/**
 * Keyword fallback. It never approves an action. A spoken yes still has to
 * pass the existing short-lived confirmation.
 */
function framesOf(samples: Float32Array, rate: number): number[][] {
  const frame = 32;
  const frames: number[][] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    frames.push(featuresFor(samples.subarray(start, start + frame), rate).mfcc);
  }
  return frames.slice(0, 8);
}

export function matchCommand(
  samples: Float32Array,
  rate = 16000,
): {
  name: string | null;
  distance: number;
  approvesAction: false;
  quality: "fallback-keywords";
} {
  const probe = framesOf(samples, rate);
  let bestName: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const template of templates) {
    const distance = dtw(probe, template.frames);
    if (distance < best) {
      best = distance;
      bestName = template.name;
    }
  }
  const hit = bestName && best < 8 ? bestName : null;
  return { name: hit, distance: best, approvesAction: false, quality: "fallback-keywords" };
}
