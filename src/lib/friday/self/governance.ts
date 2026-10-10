/**
 * FRIDAY · governance queue (approval gate)
 *
 * Every consequential action FRIDAY wants to take — reading an external site,
 * downloading a file, changing source, installing a package, touching a system
 * setting, running an executable, upgrading herself — is filed here first and
 * moves through one visible lifecycle:
 *
 *   DISCOVERED → ANALYZED → PROPOSED → TESTED → WAITING APPROVAL
 *              → APPLIED → VERIFIED → COMPLETED   (or ROLLED BACK)
 *
 * Nothing is applied without passing the gate. The gate reads the owner's
 * policy from `autonomy` settings: safe reversible work can auto-approve at a
 * relaxed level, risky work always asks. Items persist, so a restart shows the
 * exact same pending queue.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";
import { autonomy } from "./autonomy";
import { memory } from "./memory-engine";

export type GovStage =
  | "discovered"
  | "analyzed"
  | "proposed"
  | "tested"
  | "waiting-approval"
  | "applied"
  | "verified"
  | "completed"
  | "rolled-back"
  | "rejected"
  | "failed";

export const GOVERNANCE_STAGES: { id: GovStage; label: string }[] = [
  { id: "discovered", label: "Discovered" },
  { id: "analyzed", label: "Analyzed" },
  { id: "proposed", label: "Proposed" },
  { id: "tested", label: "Tested / dry-run" },
  { id: "waiting-approval", label: "Waiting approval" },
  { id: "applied", label: "Applied" },
  { id: "verified", label: "Verified" },
  { id: "completed", label: "Completed" },
];

export type GovRisk = "safe" | "review" | "risky";

export type GovKind =
  | "research"
  | "download"
  | "install"
  | "code-change"
  | "self-upgrade"
  | "system"
  | "repair"
  | "security"
  | "skill";

/** Kinds that can never be applied without the owner saying yes. */
export const ALWAYS_ASK_KINDS: ReadonlySet<GovKind> = new Set<GovKind>([
  "self-upgrade",
  "install",
  "download",
  "code-change",
  "system",
  // A skill FRIDAY wrote herself becomes real code she can run later, so it
  // is offered, never self-installed.
  "skill",
]);

/**
 * HARD SAFETY RULE — the approval machinery itself is off limits to routine
 * self-improvement. These files decide whether FRIDAY may act at all, so a
 * self-development run may never quietly rewrite them: dev-pipeline.ts blocks
 * such a run before it is ever proposed, and this gate refuses to auto-approve
 * anything that mentions them even if some other path submits it.
 */
export const PROTECTED_POLICY_FILES: readonly string[] = [
  "src/lib/friday/self/governance.ts",
  "src/lib/friday/brain/action-risk.ts",
  "electron/privacy-firewall.cjs",
  "electron/tool-authority.cjs",
  "electron/credentials.cjs",
  "kernel/privacy.py",
  "kernel/tools.py",
];

const normalisePath = (path: string) => String(path).replace(/\\/g, "/").toLowerCase();

/** Which protected policy files a set of paths / evidence lines touches. */
export type ChangeVerdict = {
  allow: "refuse" | "ask" | "stage";
  applied: false;
  reversible: true;
  reason: string;
};

/**
 * Separate from the proposer. A protected file is refused at every dial.
 * Full may stage a reversible change. This function never applies one.
 */
export function evaluateChange(input: {
  paths: string[];
  level: "strict" | "balanced" | "trusted" | "full";
  halted?: boolean;
}): ChangeVerdict {
  if (input.halted) {
    return { allow: "refuse", applied: false, reversible: true, reason: "halted" };
  }
  if (protectedPolicyPaths(input.paths).length > 0) {
    return { allow: "refuse", applied: false, reversible: true, reason: "protected" };
  }
  if (input.level === "full") {
    return { allow: "stage", applied: false, reversible: true, reason: "staged" };
  }
  return { allow: "ask", applied: false, reversible: true, reason: "dial" };
}

export function protectedPolicyPaths(paths: Iterable<string>): string[] {
  const hit = new Set<string>();
  for (const raw of paths) {
    const path = normalisePath(raw ?? "");
    for (const guarded of PROTECTED_POLICY_FILES) {
      if (path.includes(guarded)) hit.add(guarded);
    }
  }
  return [...hit];
}

export type GovLog = { at: number; line: string; level: "info" | "ok" | "warn" | "error" };

export type GovItem = {
  id: string;
  kind: GovKind;
  title: string;
  rationale: string;
  risk: GovRisk;
  /** What FRIDAY found — file paths, urls, package names, doctor ids. */
  evidence: string[];
  stage: GovStage;
  createdAt: number;
  updatedAt: number;
  /** Result of the dry-run / sandbox pass, filled before approval. */
  dryRun?: { ok: boolean; detail: string } | undefined;
  /** Backup/checkpoint reference so a bad apply can be undone. */
  checkpoint?: string | undefined;
  autoApproved?: boolean;
  error?: string | undefined;
  logs: GovLog[];
};

export type GovState = { items: GovItem[]; pending: GovItem[]; lastChangeAt: number };

export type GovAction = {
  kind: GovKind;
  title: string;
  rationale: string;
  risk: GovRisk;
  evidence?: string[];
  /** Optional dry-run; must pass before the item can be approved. */
  dryRun?: () => Promise<{ ok: boolean; detail: string }>;
  /** Real work. Only ever called after the gate opens. */
  apply: () => Promise<{ ok: boolean; detail: string; checkpoint?: string }>;
  /** Post-apply proof the change actually works. */
  verify?: () => Promise<{ ok: boolean; detail: string }>;
  /** Undo, used automatically when apply or verify fails. */
  rollback?: (checkpoint?: string) => Promise<{ ok: boolean; detail: string }>;
};

const STORAGE_KEY = "friday.governance.v1";
const MAX_ITEMS = 200;
const MAX_LOGS = 60;

let seq = 0;
const newId = () => `gov-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

const OPEN_STAGES: GovStage[] = [
  "discovered",
  "analyzed",
  "proposed",
  "tested",
  "waiting-approval",
];

class Governance {
  private items: GovItem[] = [];
  private snapshot: GovState = { items: [], pending: [], lastChangeAt: 0 };
  private listeners = new Set<() => void>();
  private waiting = new Map<string, (ok: boolean) => void>();
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): GovState => {
    this.load();
    return this.snapshot;
  };

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const settle = (items: GovItem[]) =>
      items.map((item) =>
        item.stage === "applied" || item.stage === "verified"
          ? { ...item, stage: "completed" as GovStage }
          : item,
      );
    const local = readLocalState<GovItem[]>(STORAGE_KEY);
    if (Array.isArray(local)) this.items = settle(local);
    restoreFromDisk<GovItem[]>(STORAGE_KEY, (disk) => {
      if (!Array.isArray(disk) || !disk.length) return;
      this.items = settle(disk);
      this.emit(false);
    });
    this.emit(false);
  }

  private emit(persist = true) {
    this.snapshot = {
      items: [...this.items],
      pending: this.items.filter((i) => OPEN_STAGES.includes(i.stage)),
      lastChangeAt: Date.now(),
    };
    this.listeners.forEach((l) => l());
    if (!persist || typeof window === "undefined") return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      writeState(STORAGE_KEY, this.items.slice(0, MAX_ITEMS));
    }, 500);
  }

  private patch(
    id: string,
    next: Partial<GovItem>,
    line?: string,
    level: GovLog["level"] = "info",
  ) {
    const i = this.items.findIndex((item) => item.id === id);
    if (i < 0) return;
    const current = this.items[i] as GovItem;
    const logs = line
      ? [...current.logs, { at: Date.now(), line, level }].slice(-MAX_LOGS)
      : current.logs;
    this.items[i] = { ...current, ...next, logs, updatedAt: Date.now() };
    this.emit();
  }

  list(): GovItem[] {
    return this.getSnapshot().items;
  }

  pending(): GovItem[] {
    return this.getSnapshot().pending;
  }

  get(id: string): GovItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** Files a finding. Discovery alone never touches anything. */
  discover(
    input: Omit<GovAction, "apply" | "dryRun" | "verify" | "rollback"> & { id?: string },
  ): GovItem {
    this.load();
    const id = input.id ?? newId();
    const existing = this.get(id);
    if (existing) return existing;
    const item: GovItem = {
      id,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      risk: input.risk,
      evidence: input.evidence ?? [],
      stage: "discovered",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logs: [{ at: Date.now(), line: "discovered", level: "info" }],
    };
    this.items = [item, ...this.items].slice(0, MAX_ITEMS);
    this.emit();
    return item;
  }

  /**
   * Does this item pass without asking, under the current policy?
   *
   * Risk level alone is not enough. An upgrade, an install, a code change, or a
   * system action asks at Ask every time, Balanced, and Trusted. Full autonomy
   * applies those kinds. Stop everything applies nothing. A protected policy
   * file still cannot be auto-approved.
   */
  autoApproves(risk: GovRisk, kind?: GovKind): boolean {
    const settings = autonomy.getSnapshot();
    if (settings.halted) return false;
    if (kind && ALWAYS_ASK_KINDS.has(kind) && settings.approvalLevel !== "full") return false;
    const level = settings.approvalLevel;
    if (level === "strict") return false;
    if (level === "full") return true;
    if (level === "balanced") return risk === "safe";
    return risk !== "risky";
  }

  /**
   * Runs one action through the whole gate. Returns the settled item.
   * `apply` is only ever invoked after the gate opens.
   */
  async submit(action: GovAction & { id?: string }): Promise<GovItem> {
    const item = this.discover(action);
    const id = item.id;
    if (autonomy.getSnapshot().halted) {
      this.patch(id, { stage: "failed", error: "Stopped." }, "stop everything", "error");
      return this.get(id) as GovItem;
    }

    this.patch(id, { stage: "analyzed" }, `analyzed — ${action.risk} risk`, "info");
    this.patch(id, { stage: "proposed" }, "proposal prepared", "info");

    if (action.dryRun) {
      try {
        const result = await action.dryRun();
        this.patch(
          id,
          { stage: "tested", dryRun: result },
          `dry-run ${result.ok ? "passed" : "failed"} — ${result.detail}`,
          result.ok ? "ok" : "error",
        );
        if (!result.ok) {
          this.patch(
            id,
            { stage: "failed", error: result.detail },
            "stopped before approval",
            "error",
          );
          return this.get(id) as GovItem;
        }
      } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        this.patch(id, { stage: "failed", error: detail }, `dry-run crashed — ${detail}`, "error");
        return this.get(id) as GovItem;
      }
    } else {
      this.patch(id, { stage: "tested", dryRun: { ok: true, detail: "no dry-run required" } });
    }

    // Anything touching the approval machinery itself gets its own, separately
    // worded, higher-scrutiny request — never the ordinary quick approval.
    const guarded = protectedPolicyPaths([
      action.title,
      action.rationale,
      ...(action.evidence ?? []),
    ]);
    if (guarded.length) {
      this.patch(
        id,
        { risk: "risky" },
        `SAFETY-CRITICAL: this change edits FRIDAY's own approval policy code (${guarded.join(", ")}). It cannot be auto-approved and must be reviewed on its own.`,
        "warn",
      );
    }

    const auto = guarded.length ? false : this.autoApproves(action.risk, action.kind);
    let allowed = auto;
    if (auto) {
      this.patch(id, { autoApproved: true }, "auto-approved by policy", "ok");
    } else {
      this.patch(id, { stage: "waiting-approval" }, "waiting for owner approval", "warn");
      allowed = await new Promise<boolean>((resolve) => this.waiting.set(id, resolve));
    }

    if (!allowed) {
      this.patch(id, { stage: "rejected" }, "rejected by owner", "warn");
      return this.get(id) as GovItem;
    }

    let checkpoint: string | undefined;
    try {
      const result = await action.apply();
      checkpoint = result.checkpoint;
      if (!result.ok) throw new Error(result.detail || "apply failed");
      this.patch(id, { stage: "applied", checkpoint }, `applied — ${result.detail}`, "ok");

      const verified = action.verify
        ? await action.verify()
        : { ok: true, detail: "no verification step" };
      if (!verified.ok) throw new Error(verified.detail || "verification failed");
      this.patch(id, { stage: "verified" }, `verified — ${verified.detail}`, "ok");
      this.patch(id, { stage: "completed" }, "completed", "ok");
      this.remember(id, true);
    } catch (error) {
      const detail = String((error as Error)?.message ?? error);
      this.patch(id, { error: detail }, `failed — ${detail}`, "error");
      if (action.rollback && autonomy.getSnapshot().autoRollback) {
        try {
          const undone = await action.rollback(checkpoint);
          this.patch(
            id,
            { stage: undone.ok ? "rolled-back" : "failed" },
            `rollback ${undone.ok ? "restored the previous state" : "failed"} — ${undone.detail}`,
            undone.ok ? "warn" : "error",
          );
        } catch (rollbackError) {
          this.patch(
            id,
            { stage: "failed" },
            `rollback crashed — ${String(rollbackError)}`,
            "error",
          );
        }
      } else {
        this.patch(id, { stage: "failed" }, "no rollback available", "error");
      }
      this.remember(id, false);
    }
    return this.get(id) as GovItem;
  }

  /** Owner decision from any surface (Tasks page, chat, voice). */
  decide(id: string, allow: boolean): void {
    const resolve = this.waiting.get(id);
    if (resolve) {
      this.waiting.delete(id);
      resolve(allow);
      return;
    }
    // Item is queued but not awaiting a live promise (e.g. after a restart).
    const item = this.get(id);
    if (!item) return;
    this.patch(
      id,
      { stage: allow ? "proposed" : "rejected" },
      allow ? "approved — will re-run on the next cycle" : "rejected by owner",
      allow ? "ok" : "warn",
    );
  }

  approve = (id: string) => this.decide(id, true);
  reject = (id: string) => this.decide(id, false);

  clearSettled(): void {
    this.items = this.items.filter((i) => OPEN_STAGES.includes(i.stage));
    this.emit();
  }

  /** Drops the in-memory queue. Tests use this so one case cannot see another's draft. */
  resetForTests(): void {
    this.items = [];
    this.loaded = true;
    this.waiting.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.emit(false);
  }

  private remember(id: string, ok: boolean) {
    const item = this.get(id);
    if (!item || !autonomy.getSnapshot().learningEnabled) return;
    memory.remember({
      tier: ok ? "episodic" : "temporary",
      title: `${ok ? "Applied" : "Blocked"} — ${item.title}`.slice(0, 100),
      text: `${item.rationale} (${item.kind}, ${item.risk}). ${item.error ?? ""}`.trim(),
      tags: ["governance", item.kind, ok ? "success" : "failure"],
      source: `governance/${item.id}`,
      confidence: ok ? 0.8 : 0.4,
    });
  }
}

export const governance = new Governance();
