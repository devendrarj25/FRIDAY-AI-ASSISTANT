/**
 * FRIDAY · billing safety (renderer view)
 *
 * A thin, honest mirror of the main process record. Nothing here decides
 * anything: the router in `electron/main.cjs` is authoritative, this store
 * only reads it and asks it to change. In the browser preview (no desktop
 * bridge) the safe defaults are shown and the controls report that paid usage
 * cannot be unlocked outside the desktop app.
 */

import type { BillingState } from "./desktop";

export type { BillingState };
export type AccessTier = "auto" | "free" | "paid";
export type GrantScope = BillingState["grantScope"];

export type BillingSnapshot = {
  billing: BillingState;
  /** The policy the router is really enforcing right now. */
  policy: string;
  /** The policy the owner asked for (may be capped by the flags above). */
  requestedPolicy: string;
  summary: string;
  /** Per-provider cost tier chosen when connecting the provider. */
  tiers: Record<string, AccessTier>;
  bridge: "desktop" | "preview";
  loading: boolean;
  error: string | null;
};

export const DEFAULT_BILLING: BillingState = {
  paidAccess: false,
  autoPaidUsage: false,
  killSwitch: false,
  grantScope: "off",
  grantUntil: 0,
  grantedAt: 0,
};

const initial: BillingSnapshot = {
  billing: DEFAULT_BILLING,
  policy: "free-preferred",
  requestedPolicy: "free-preferred",
  summary: "paid AI access is off — free and local models only",
  tiers: {},
  bridge: "preview",
  loading: false,
  error: null,
};

type Bridge = {
  billingPolicy?: () => Promise<{
    billing: BillingState;
    policy: string;
    requestedPolicy?: string;
    summary: string;
  }>;
  setBillingPolicy?: (
    patch: Partial<BillingState>,
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  grantPaidUsage?: (
    scope: GrantScope,
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  setPaidKillSwitch?: (
    on: boolean,
  ) => Promise<{ billing: BillingState; policy: string; summary: string }>;
  providerAccessTiers?: () => Promise<Record<string, AccessTier>>;
  setProviderAccessTier?: (
    id: string,
    tier: AccessTier,
    declaration?: {
      ownerFreeTier?: boolean;
      modelId?: string;
      mark?: "free" | "paid" | "auto";
    } | null,
  ) => Promise<{ ok: boolean; id: string; tier: string }>;
};

const bridge = (): Bridge | null =>
  typeof window === "undefined"
    ? null
    : ((window as unknown as { friday?: Bridge }).friday ?? null);

class BillingStore {
  private state: BillingSnapshot = initial;
  private snapshot: BillingSnapshot = initial;
  private listeners = new Set<() => void>();
  private started = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.started) {
      this.started = true;
      void this.refresh();
    }
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): BillingSnapshot => this.snapshot;

  private emit(patch: Partial<BillingSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.snapshot = this.state;
    this.listeners.forEach((fn) => fn());
  }

  /** Reads the real record from the main process. Never invents a value. */
  async refresh(): Promise<BillingSnapshot> {
    const api = bridge();
    if (!api?.billingPolicy) {
      this.emit({ bridge: "preview", loading: false });
      return this.snapshot;
    }
    this.emit({ bridge: "desktop", loading: true, error: null });
    try {
      const [state, tiers] = await Promise.all([
        api.billingPolicy(),
        api.providerAccessTiers?.() ?? Promise.resolve({}),
      ]);
      this.emit({
        billing: state.billing,
        policy: state.policy,
        requestedPolicy: state.requestedPolicy || state.policy,
        summary: state.summary,
        tiers: tiers || {},
        loading: false,
      });
    } catch (error) {
      this.emit({ loading: false, error: (error as Error).message });
    }
    return this.snapshot;
  }

  private applied(result?: { billing: BillingState; policy: string; summary: string }) {
    if (!result) return;
    this.emit({ billing: result.billing, policy: result.policy, summary: result.summary });
  }

  async setPaidAccess(on: boolean) {
    this.applied(await bridge()?.setBillingPolicy?.({ paidAccess: on }));
  }

  async setAutoPaidUsage(on: boolean) {
    this.applied(await bridge()?.setBillingPolicy?.({ autoPaidUsage: on }));
  }

  async grant(scope: GrantScope) {
    this.applied(await bridge()?.grantPaidUsage?.(scope));
  }

  async setKillSwitch(on: boolean) {
    this.applied(await bridge()?.setPaidKillSwitch?.(on));
  }

  /**
   * Owner evidence for one provider. A free-tier flag promotes UNKNOWN only.
   * A per-model mark is stored as owner-declared evidence.
   */
  async setOwnerDeclaration(
    id: string,
    declaration: { ownerFreeTier?: boolean; modelId?: string; mark?: "free" | "paid" | "auto" },
  ) {
    const api = bridge();
    if (!api?.setProviderAccessTier) return;
    await api.setProviderAccessTier(id, this.tierOf(id), declaration);
  }

  /** Cost tier for one provider: auto, free models only, or paid models only. */
  async setProviderTier(id: string, tier: AccessTier) {
    const api = bridge();
    if (!api?.setProviderAccessTier) return;
    await api.setProviderAccessTier(id, tier);
    const tiers = { ...this.state.tiers };
    if (tier === "auto") delete tiers[id];
    else tiers[id] = tier;
    this.emit({ tiers });
  }

  tierOf(id: string): AccessTier {
    return this.state.tiers[id] || "auto";
  }
}

export const billing = new BillingStore();
