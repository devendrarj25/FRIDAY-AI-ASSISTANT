/**
 * FRIDAY · in-app feature guide
 *
 * "What does the Sandbox section do?" — answered from FRIDAY's own current
 * code, not from a model's memory of what a sandbox usually is.
 *
 * Two real sources, both already maintained elsewhere:
 *   1. navigation.ts — the single registry of which sections exist.
 *   2. the route file itself, read through the read-only source bridge, where
 *      the page declares its own <AppShell title/subtitle> and <Panel title>s.
 *
 * Because the explanation is parsed out of the live route file, it cannot go
 * stale: rename a panel and the next answer already says the new name. When
 * the source bridge is unavailable (browser preview) the answer degrades to
 * the registry facts and says so instead of inventing behaviour.
 */

import { ALL_NAV_ITEMS, NAV_GROUPS, type NavItem } from "../navigation";
import { readSource, sourceAccessAvailable } from "../self/maintenance-bridge";
import { capabilityMatrix } from "../self/capability-matrix";
import { systemMap } from "../system-map";
import { capabilityRegistry } from "./capability-registry";
import { modelRegistry } from "./model-registry";
import { looksLikeWiringQuestion } from "../wiring-ask";
import { governance } from "../self/governance";
import { memory } from "../self/memory-engine";
import { brainKnowledge } from "./knowledge-base";
import { experiences } from "../self/task-ledger";
import { readWorldState } from "./world-model";

export type FeaturePanel = { title: string; hint?: string };

export type FeatureGuide = {
  route: string;
  label: string;
  group: string;
  /** Path of the real file the explanation was read from, when it was read. */
  source: string | null;
  headline: string | null;
  subtitle: string | null;
  panels: FeaturePanel[];
  /** Live status lines from the system map for this area, when it tracks it. */
  status: string[];
  /** Live capabilities from the registry that actually belong to this section. */
  capabilities: string[];
};

/** Questions like "what does X do", "explain the Y section", "how do I use Z". */
export const GUIDE_ASK =
  /\b(?:what(?:'s| is| does)?|explain|describe|tell me about|how (?:do i|does)|what can i do (?:in|with)|walk me through|guide me)\b/i;

const SECTION_WORD = /\b(section|page|tab|screen|panel|feature|option|menu|area)\b/i;

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Route file that renders a nav entry. */
export function routeFileFor(to: string): string {
  const slug = to === "/" ? "index" : to.replace(/^\//, "");
  return `src/routes/${slug}.tsx`;
}

const norm = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Match a free-text mention of a section against the navigation registry. */
export function findFeature(query: string): NavItem | null {
  const text = norm(query);
  if (!text) return null;

  let best: { item: NavItem; score: number } | null = null;
  for (const item of ALL_NAV_ITEMS) {
    const label = norm(item.label);
    const slug = norm(item.to);
    const words = label.split(" ").filter((w) => w.length > 2);
    let score = 0;
    if (text.includes(label)) score = label.length + 10;
    else if (slug && text.includes(slug)) score = slug.length + 8;
    else {
      const hits = words.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
      if (hits.length) score = hits.join("").length + hits.length;
    }
    if (score && (!best || score > best.score)) best = { item, score };
  }
  return best && best.score >= 4 ? best.item : null;
}

/** Pull the page's own declared headline, subtitle and panel titles. */
export function parseRouteSource(text: string): {
  headline: string | null;
  subtitle: string | null;
  panels: FeaturePanel[];
} {
  const shell = /<AppShell[^>]*?title="([^"]+)"(?:[\s\S]{0,200}?subtitle="([^"]+)")?/.exec(text);
  const panels: FeaturePanel[] = [];
  const seen = new Set<string>();
  // Routes use either <Panel> or <HudPanel> for their cards; both carry the
  // human-readable title that belongs in an explanation.
  const panelRe = /<(?:Hud)?Panel\b([\s\S]{0,260}?)>/g;

  let match: RegExpExecArray | null;
  while ((match = panelRe.exec(text))) {
    const attrs = match[1] ?? "";
    const title = /title="([^"]+)"/.exec(attrs)?.[1];
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const hint = /hint="([^"]+)"/.exec(attrs)?.[1];
    panels.push(hint ? { title: clean(title), hint: clean(hint) } : { title: clean(title) });
  }
  return {
    headline: shell?.[1] ? clean(shell[1]) : null,
    subtitle: shell?.[2] ? clean(shell[2]) : null,
    panels,
  };
}

function statusFor(item: NavItem): string[] {
  try {
    return systemMap
      .find(item.label.replace(/\s*\(.*\)$/, ""))
      .slice(0, 3)
      .map(
        (entry) => `${entry.label} — ${entry.status}${entry.detail ? ` (${entry.detail})` : ""}`,
      );
  } catch {
    return [];
  }
}

/**
 * Capabilities that actually belong to this section, scored from the live
 * registry — never a hardcoded per-page list.
 */
export function capabilitiesFor(item: NavItem): string[] {
  try {
    const snapshot = capabilityRegistry.getSnapshot();
    const hay = `${item.label} ${item.to}`.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    return snapshot.resources
      .map((resource) => {
        const name = resource.name.toLowerCase();
        const ref = resource.ref.replace(/-/g, " ");
        let score = 0;
        if (
          hay.includes(name) ||
          name.split(" ").some((word) => word.length > 3 && hay.includes(word))
        ) {
          score += 4;
        }
        if (hay.includes(ref)) score += 5;
        for (const cap of resource.capabilities) {
          if (cap.length > 3 && hay.includes(cap)) score += 2;
        }
        return { resource, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(
        (row) =>
          `${row.resource.name} — ${row.resource.detail} (${row.resource.health}${
            row.resource.available ? "" : ", unavailable"
          })`,
      );
  } catch {
    return [];
  }
}

/** Build the guide for one section by reading its real route file. */
export async function buildGuide(item: NavItem): Promise<FeatureGuide> {
  const group = NAV_GROUPS.find((g) => g.items.includes(item))?.group ?? "Main";
  const guide: FeatureGuide = {
    route: item.to,
    label: item.label,
    group,
    source: null,
    headline: null,
    subtitle: null,
    panels: [],
    status: statusFor(item),
    capabilities: capabilitiesFor(item),
  };

  if (!sourceAccessAvailable()) return guide;
  const file = routeFileFor(item.to);
  const result = await readSource(file);
  if (!result.ok) return guide;

  const parsed = parseRouteSource(result.text);
  guide.source = result.path;
  guide.headline = parsed.headline;
  guide.subtitle = parsed.subtitle;
  guide.panels = parsed.panels.slice(0, 12);
  return guide;
}

/** How FRIDAY says a guide out loud. */
export function describeGuide(guide: FeatureGuide): string {
  const lines: string[] = [];
  lines.push(
    `**${guide.headline ?? guide.label}** — the "${guide.label}" entry in my ${guide.group} sidebar group (route \`${guide.route}\`).`,
  );
  if (guide.subtitle) lines.push(guide.subtitle);

  if (guide.panels.length) {
    lines.push("", "What's on that screen right now:");
    for (const panel of guide.panels) {
      lines.push(`• ${panel.title}${panel.hint ? ` — ${panel.hint}` : ""}`);
    }
  } else if (!guide.source) {
    lines.push(
      "",
      sourceAccessAvailable()
        ? "I couldn't read that page's source just now, so I'm only giving you what my navigation registry knows."
        : "I can only read my own page source inside the installed desktop app, so this is the registry view of it.",
    );
  }

  if (guide.capabilities.length) {
    lines.push("", "What I can actually do here (from my capability registry):");
    for (const line of guide.capabilities) lines.push(`• ${line}`);
  }

  if (guide.status.length) {
    lines.push("", "Live status from my system map:");
    for (const line of guide.status) lines.push(`• ${line}`);
  }

  if (guide.source) lines.push("", `Read from my own source: ${guide.source}`);
  return lines.join("\n");
}

/** Short list of every section, for "what sections do you have?". */
export function describeSections(): string {
  return [
    "These are the sections I actually have right now, straight from my navigation registry:",
    ...NAV_GROUPS.map(
      (group) => `**${group.group}** — ${group.items.map((i) => i.label).join(", ")}`,
    ),
    "",
    "Ask me about any one of them and I'll read that page's own source and tell you exactly what's on it.",
  ].join("\n");
}

/** True when the question is about a section of FRIDAY's own interface. */
export function looksLikeFeatureQuestion(text: string): boolean {
  if (looksLikeSelfStatusQuestion(text)) return true;
  if (looksLikeWiringQuestion(text)) return true;
  if (!GUIDE_ASK.test(text)) return false;
  if (SECTION_WORD.test(text)) return true;
  return /\b(your|friday'?s|the|this)\s+(app|interface|ui|sidebar)\b/i.test(text);
}

/**
 * "What can you do", "how smart are you", current working status — answered
 * from live registries, not from a model's guess or a hardcoded blurb.
 */
export const SELF_STATUS_ASK =
  /\b(what can you do|what do you do|how smart(?: are you)?|how capable(?: are you)?|your (abilities|capabilities|features)|what are you able|current (working )?status)\b/i;

export function looksLikeSelfStatusQuestion(text: string): boolean {
  return SELF_STATUS_ASK.test(text ?? "");
}

function describeLiveSkills(): string {
  const scores = capabilityMatrix.scores();
  const lines = scores.map((score) => {
    if (score.provisional) {
      return `• ${score.label}: ${score.score}/100 — provisional (declared baseline, no measured runs yet)`;
    }
    return `• ${score.label}: ${score.score}/100 — measured (${score.successes}/${score.runs} succeeded)`;
  });
  return [
    "Per-domain skill (live capability matrix — not a marketing score):",
    ...lines,
    "There is no single intelligence number. A provisional line is still the declared baseline, not a measured result.",
  ].join("\n");
}

function describeLiveModels(): string {
  try {
    const ready = modelRegistry.available();
    if (!ready.length) {
      return "Installed / connected models (live model registry): none available right now.";
    }
    const lines = ready.slice(0, 12).map((record) => {
      const measured =
        record.reliability === null
          ? "unmeasured (installed or connected, no runs recorded)"
          : `${Math.round(record.reliability * 100)}% measured over ${record.performance?.runs ?? 0} runs`;
      return `• ${record.name} (${record.kind}, ${record.provider}) — ${measured}`;
    });
    return ["Installed / connected models (live model registry):", ...lines].join("\n");
  } catch {
    return "Installed / connected models: the model registry could not be read just now.";
  }
}

/**
 * One honest self-answer: capability matrix + installed/connected models +
 * feature/UI registry. Does not claim a capability is proven unless the
 * underlying registry says it was measured or verified.
 */
export function describeLiveSelf(_prompt = ""): string {
  const parts = [
    "One live picture. Ask for one part if you want it narrower.",
    "Answer from these live registries only. Do not claim a capability is proven unless the line says measured. Do not invent models that are not listed.",
  ];
  let answered = false;
  try {
    const skills = describeLiveSkills();
    if (skills.trim()) {
      parts.push(skills);
      answered = true;
    }
  } catch {
    /* capability matrix unavailable */
  }
  try {
    const models = describeLiveModels();
    if (models.trim()) {
      parts.push(models);
      answered = true;
    }
  } catch {
    /* model registry unavailable */
  }
  try {
    const sections = describeSections();
    if (sections.trim()) {
      parts.push(sections);
      answered = true;
    }
  } catch {
    /* navigation registry unavailable */
  }
  try {
    const digest = systemMap.digest();
    if (digest.trim()) {
      parts.push("Live application map:", digest);
      answered = true;
    }
  } catch {
    /* the map is optional context, not a second skill score */
  }
  try {
    const caps = capabilityRegistry.digest();
    if (caps.trim()) {
      parts.push(caps);
      answered = true;
    }
  } catch {
    /* same */
  }
  try {
    const live = describeLiveFabricSignals();
    if (live.trim()) {
      parts.push(live);
      answered = true;
    }
  } catch {
    /* fabric signals are additive, never a second self-status assembler */
  }
  if (!answered) return "";
  return parts.filter(Boolean).join("\n\n");
}

/** Parts 1–7 live signals, still assembled here — not a second self-status. */
function describeLiveFabricSignals(): string {
  const lines: string[] = [
    "Live intelligence-fabric signals (existing registries, not a second map):",
  ];
  try {
    const pending = governance.pending();
    lines.push(
      `• Pending owner approvals (governance queue): ${pending.length}${
        pending[0] ? ` — next: ${pending[0].title}` : ""
      }`,
    );
  } catch {
    lines.push("• Pending owner approvals: governance queue could not be read.");
  }
  try {
    const failures = memory
      .getSnapshot()
      .items.filter((item) => item.kind === "failure" && item.tier !== "archived");
    lines.push(`• Known failure memories: ${failures.length}`);
  } catch {
    lines.push("• Known failure memories: memory engine could not be read.");
  }
  try {
    const clashes = brainKnowledge.entries().filter((entry) => entry.contradiction);
    lines.push(`• Unresolved knowledge contradictions: ${clashes.length}`);
  } catch {
    lines.push("• Unresolved knowledge contradictions: knowledge base could not be read.");
  }
  try {
    const repeats = experiences.repeatedApproaches(2, 90).slice(0, 3);
    if (repeats.length) {
      lines.push(
        `• Recent verified strategies: ${repeats
          .map((row) => `${row.kind} ×${row.count}`)
          .join("; ")}`,
      );
    } else {
      lines.push("• Recent verified strategies: none recorded yet (verified outcomes only).");
    }
  } catch {
    lines.push("• Recent verified strategies: experience store could not be read.");
  }
  try {
    const world = readWorldState();
    lines.push(`• World state snapshot: ${world.summary}`);
  } catch {
    lines.push("• World state snapshot: unreadable.");
  }
  try {
    lines.push(`• Capability availability: ${capabilityRegistry.selfKnowledge().digest}`);
  } catch {
    lines.push("• Capability availability: registry unreadable.");
  }
  lines.push(
    "Limitations are the provisional capability-matrix lines and any cooling-down models above — not a claimed intelligence score.",
  );
  return lines.join("\n");
}

/** Full answer for a section question, or null when it isn't one. */
export async function explainFeature(text: string): Promise<string | null> {
  const item = findFeature(text);
  if (looksLikeWiringQuestion(text) && !item) {
    const { describeWiringLive } = await import("../wiring");
    return describeWiringLive();
  }
  // General capability / status questions read the live registries. A named
  // section still gets that page's own source, even if the wording overlaps.
  if (looksLikeSelfStatusQuestion(text) && !item) {
    return describeLiveSelf(text);
  }
  if (!looksLikeFeatureQuestion(text)) return null;
  if (/\b(all|every|which|what)\s+(sections?|pages?|tabs?|features?)\b/i.test(text)) {
    return describeSections();
  }
  if (!item) return null;
  return describeGuide(await buildGuide(item));
}
