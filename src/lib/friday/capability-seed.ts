/**
 * FRIDAY · preinstalled capability pack ("starter kit").
 *
 * FRIDAY ships useful, real, executable capabilities out of the box: skills she
 * can invoke, tools she may use, agents that do background work, plugins that
 * register extra tools, modules and scheduled workflows.
 *
 * Nothing here is decorative and nothing is duplicated:
 *   • the packs themselves come from the one canonical catalog (marketplace.ts);
 *   • installing goes through the same real install path the marketplace uses,
 *     writing manifests + code into the selected FRIDAY workspace;
 *   • a pack that is already present (shipped, user-installed or previously
 *     seeded) is skipped, so seeding is idempotent;
 *   • the seed record lives on disk, so it survives restarts and only re-runs
 *     when the starter kit itself is upgraded.
 *
 * The capability watcher then makes every newly written pack appear in the
 * Skills / Tools / Agents / Modules / Plugins / Workflows sections and in the
 * chat composer automatically — no UI change, no manual registration.
 */
import { readDiskState, readLocalState, writeState } from "./persist";
import { listCapabilities } from "./capability-trees";
import type { CapabilityTree } from "./capability-trees";
import { MARKET_PACKS, capabilityId, installPack, marketplaceSupported } from "./marketplace";
import type { MarketPack } from "./marketplace";

const NAMESPACE = "friday.capability-seed";

/**
 * Bump when the starter kit changes — FRIDAY then installs whatever is newly
 * essential on the next boot, without touching anything already present.
 */
export const SEED_VERSION = 3;

/**
 * The curated starter kit, by tree. These are the capabilities FRIDAY needs to
 * be genuinely useful on a fresh machine: reading and summarising, files, web,
 * code, system, background agents and her own maintenance schedules.
 *
 * Only `safe` and `write` packs are seeded automatically. Anything that can
 * execute code or drive the desktop stays opt-in from the marketplace, so
 * FRIDAY never grants herself an exec permission the owner did not choose.
 */
export const ESSENTIAL_SLUGS: Record<Exclude<CapabilityTree, "models">, string[]> = {
  skills: [
    "text.summarise",
    "text.keywords",
    "json.transform",
    "csv.parse",
    "data.stats",
    "web.readable",
    "web.extract-links",
    "web.rss",
    "files.find-duplicates",
    "files.tree",
    "code.review",
    "git.repo-status",
    "system.disk-usage",
    "system.process-report",
    "net.latency",
    "docs.markdown-outline",
    "time.schedule-plan",
    "memory.digest",
  ],
  tools: ["fs-search", "fs-archive", "http-client", "dns-lookup", "clipboard", "log-tailer"],
  agents: [
    "research-agent",
    "writer-agent",
    "planner-agent",
    "monitor-agent",
    "learning-agent",
    "data-agent",
  ],
  modules: ["rag-index", "prompt-library", "speech-notes"],
  plugins: [
    "uuid-kit",
    "hash-kit",
    "json-tools",
    "text-tools",
    "time-tools",
    "math-kit",
    "password-kit",
    "env-doctor",
  ],
  workflows: [
    "morning-briefing",
    "workspace-cleanup",
    "research-brief",
    "disk-guard",
    "inbox-triage",
    "model-warmup",
  ],
};

const essentialKey = (pack: MarketPack) => `${pack.tree}:${pack.slug}`;

const ESSENTIAL_KEYS = new Set(
  Object.entries(ESSENTIAL_SLUGS).flatMap(([tree, slugs]) =>
    slugs.map((slug) => `${tree}:${slug}`),
  ),
);

/** Every catalog pack that belongs to the shipped starter kit. */
export const essentialPacks = (): MarketPack[] =>
  MARKET_PACKS.filter((pack) => ESSENTIAL_KEYS.has(essentialKey(pack)));

export const isEssential = (pack: MarketPack) => ESSENTIAL_KEYS.has(essentialKey(pack));

export interface SeedRecord {
  version: number;
  at: number;
  installed: string[];
  failed: string[];
}

export interface SeedResult extends SeedRecord {
  skipped: number;
  ran: boolean;
  reason?: string;
}

function readRecord(): SeedRecord | null {
  return readLocalState<SeedRecord>(NAMESPACE);
}

let inFlight: Promise<SeedResult> | null = null;

/**
 * Installs any missing starter-kit capability into the workspace.
 * Safe to call on every boot: it is idempotent, never blocks, and never
 * reinstalls or overwrites something that already exists.
 */
export async function ensureEssentialCapabilities(
  options: { force?: boolean } = {},
): Promise<SeedResult> {
  if (inFlight && !options.force) return inFlight;

  const run = async (): Promise<SeedResult> => {
    const empty: SeedResult = {
      version: SEED_VERSION,
      at: Date.now(),
      installed: [],
      failed: [],
      skipped: 0,
      ran: false,
    };

    if (!marketplaceSupported()) return { ...empty, reason: "no desktop bridge" };

    if (!options.force) {
      const disk = (await readDiskState<SeedRecord>(NAMESPACE)) ?? readRecord();
      if (disk && disk.version >= SEED_VERSION) {
        return { ...empty, ...disk, skipped: 0, ran: false, reason: "already seeded" };
      }
    }

    const index = await listCapabilities();
    if (!index) return { ...empty, reason: "capability scan unavailable" };
    const present = new Set(index.items.map((item) => item.id));

    const installed: string[] = [];
    const failed: string[] = [];
    let skipped = 0;

    for (const pack of essentialPacks()) {
      if (pack.risk === "exec") {
        skipped += 1;
        continue;
      }
      const id = capabilityId(pack);
      // Already shipped, already installed by the owner, or seeded earlier.
      if (present.has(id) || present.has(`${pack.tree}/${pack.segment}/${pack.slug}`)) {
        skipped += 1;
        continue;
      }
      const result = (await installPack(pack)) as { ok?: boolean; id?: string };
      if (result?.ok) installed.push(result.id ?? id);
      else failed.push(id);
    }

    const record: SeedRecord = {
      version: SEED_VERSION,
      at: Date.now(),
      installed,
      failed,
    };
    // Only remember the version when nothing failed, so a partial seed is
    // retried on the next boot instead of being silently dropped.
    writeState(NAMESPACE, failed.length ? { ...record, version: SEED_VERSION - 1 } : record);

    return { ...record, skipped, ran: true };
  };

  const promise = run().finally(() => {
    if (inFlight === promise) inFlight = null;
  });
  inFlight = promise;
  return promise;
}

/** Last seed outcome, for diagnostics. */
export const seedRecord = (): SeedRecord | null => readRecord();
