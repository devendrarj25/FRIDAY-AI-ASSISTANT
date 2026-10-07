/**
 * FRIDAY · privacy / data-egress mirror (renderer view)
 *
 * The decision lives in the main process (electron/privacy-firewall.cjs) at
 * the point where data would actually leave the PC. This store only *mirrors*
 * what was asked and what the owner answered, so the existing status surfaces
 * can show it. It decides nothing and it cannot grant anything.
 */

import { desktopApi } from "./desktop";
import type { EgressEvent } from "./desktop";

export type { EgressEvent };

export type PrivacyState = {
  /** A confirmation currently on screen, if any. */
  pending: EgressEvent | null;
  /** The most recent settled decision. */
  last: EgressEvent | null;
  bridge: "desktop" | "preview";
};

const EMPTY: PrivacyState = { pending: null, last: null, bridge: "preview" };

class PrivacyStore {
  private state: PrivacyState = EMPTY;
  private listeners = new Set<() => void>();
  private wired = false;

  subscribe = (fn: () => void) => {
    this.wire();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): PrivacyState => {
    this.wire();
    return this.state;
  };

  private set(patch: Partial<PrivacyState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  private wire() {
    if (this.wired) return;
    this.wired = true;
    const api = desktopApi();
    if (!api) return;
    this.set({ bridge: "desktop" });
    api
      .privacyLastEgress?.()
      .then((last) => this.set({ last: last ?? null }))
      .catch(() => undefined);
    api.onEgressPending?.((event) => this.set({ pending: event }));
    api.onEgressDecided?.((event) => this.set({ pending: null, last: event }));
  }

  /** One honest line for the status surfaces. */
  summary(): string {
    const { pending, last } = this.getSnapshot();
    if (pending)
      return `waiting for your confirmation — ${pending.classification} data to ${pending.destination ?? "an external service"}`;
    if (!last) return "nothing has been sent off this PC yet";
    return `${last.allowed ? "you allowed" : "you blocked"} ${last.classification} data to ${last.destination ?? "an external service"}`;
  }
}

export const privacy = new PrivacyStore();
