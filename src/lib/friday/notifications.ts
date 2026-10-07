/**
 * FRIDAY · notification centre
 *
 * One place for everything FRIDAY needs to tell the owner: warnings, health
 * problems, approvals waiting on a decision, task failures, background-cycle
 * results, upgrades and anything else that needs attention.
 *
 * Everything published here comes from a real FRIDAY subsystem — nothing is
 * synthesised for display. The store is event-driven (no polling), keeps a
 * bounded history and persists through `persist.ts` so the list survives a
 * restart of the installed EXE.
 */

import { readLocalState, restoreFromDisk, writeState } from "./persist";
import type { StageItem } from "./stage";
import {
  notificationAllowed,
  alertsAudible,
  playAlertSound,
  prefOn,
  showDesktopToast,
} from "./settings-runtime";
import { activeVoiceSettings, speakSample } from "./voice-library";

const NAMESPACE = "friday.notifications";
const MAX_ITEMS = 120;

export type NotifyLevel = "info" | "success" | "warn" | "error" | "action";

/** Something FRIDAY wants to *show* on the main screen with this alert. */
export type NotificationPresentation = Omit<StageItem, "id" | "at">;

export type Notification = {
  id: string;
  level: NotifyLevel;
  title: string;
  detail: string;
  /** Which FRIDAY subsystem raised it (doctor, governance, tasks, network…). */
  source: string;
  at: number;
  read: boolean;
  /** Optional in-app route the owner should open to deal with it. */
  route?: string;
  /** Optional visual FRIDAY can put on the main screen (image, chart, file…). */
  present?: NotificationPresentation;
  /** FRIDAY's own explanation + instructions, generated on demand. */
  advice?: string;
};

export type NotificationsState = {
  items: Notification[];
  unread: number;
  /** Owner switch on the title strip: when off nothing new is recorded. */
  enabled: boolean;
};

type Persisted = { items: Notification[]; enabled: boolean };

class Notifications {
  private state: NotificationsState = { items: [], unread: 0, enabled: true };
  private snapshot: NotificationsState = this.state;
  private listeners = new Set<() => void>();
  private hydrated = false;

  subscribe = (fn: () => void) => {
    this.hydrate();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private hydrate() {
    if (this.hydrated || typeof window === "undefined") return;
    this.hydrated = true;
    const local = readLocalState<Persisted>(NAMESPACE);
    if (local) this.apply(local);
    restoreFromDisk<Persisted>(NAMESPACE, (value) => {
      // Disk wins only when it holds more history than the local mirror.
      if ((value?.items?.length ?? 0) >= this.state.items.length) this.apply(value);
    });
    this.emit();
  }

  private apply(value: Persisted) {
    if (!value) return;
    if (Array.isArray(value.items)) this.state.items = value.items.slice(0, MAX_ITEMS);
    if (typeof value.enabled === "boolean") this.state.enabled = value.enabled;
    this.recount();
  }

  private recount() {
    this.state.unread = this.state.items.filter((i) => !i.read).length;
  }

  private persist() {
    writeState(NAMESPACE, { items: this.state.items, enabled: this.state.enabled } as Persisted);
  }

  private emit() {
    this.recount();
    this.snapshot = { ...this.state, items: [...this.state.items] };
    this.listeners.forEach((l) => l());
  }

  /**
   * Record something FRIDAY wants the owner to know. `id` is stable per event
   * so the same finding never stacks up twice; re-publishing refreshes it.
   */
  push(input: {
    id: string;
    level: NotifyLevel;
    title: string;
    detail?: string;
    source: string;
    route?: string;
    present?: NotificationPresentation;
  }): void {
    this.hydrate();
    if (!this.state.enabled) return;
    if (!notificationAllowed(input.source, input.level)) return;
    const existing = this.state.items.find((i) => i.id === input.id);
    const item: Notification = {
      id: input.id,
      level: input.level,
      title: input.title,
      detail: input.detail ?? "",
      source: input.source,
      at: Date.now(),
      read: false,
      ...(input.route ? { route: input.route } : {}),
      ...(input.present ? { present: input.present } : {}),
    };
    if (existing) {
      // Nothing changed — do not re-alert the owner about the same state.
      if (existing.title === item.title && existing.detail === item.detail) return;
      // Keep an explanation FRIDAY already produced for this same condition.
      if (existing.advice) item.advice = existing.advice;
      this.state.items = this.state.items.filter((i) => i.id !== input.id);
    }
    this.state.items = [item, ...this.state.items].slice(0, MAX_ITEMS);
    this.persist();
    this.emit();
    if (alertsAudible() && prefOn("sounds", false) && item.level !== "info") playAlertSound();
    if (
      alertsAudible() &&
      prefOn("speakAlerts", false) &&
      (item.level === "error" || item.level === "action" || item.level === "warn")
    ) {
      try {
        speakSample(item.title, activeVoiceSettings());
      } catch {
        /* speech is best-effort */
      }
    }
    showDesktopToast(item.title, item.detail);
  }

  /** Store FRIDAY's explanation/instructions for one alert. */
  attachAdvice(id: string, advice: string): void {
    const item = this.state.items.find((i) => i.id === id);
    if (!item || !advice.trim()) return;
    item.advice = advice.trim();
    this.persist();
    this.emit();
  }

  markRead(id: string): void {
    const item = this.state.items.find((i) => i.id === id);
    if (!item || item.read) return;
    item.read = true;
    this.persist();
    this.emit();
  }

  markAllRead(): void {
    if (!this.state.items.some((i) => !i.read)) return;
    this.state.items = this.state.items.map((i) => ({ ...i, read: true }));
    this.persist();
    this.emit();
  }

  dismiss(id: string): void {
    this.state.items = this.state.items.filter((i) => i.id !== id);
    this.persist();
    this.emit();
  }

  clear(): void {
    this.state.items = [];
    this.persist();
    this.emit();
  }

  setEnabled(enabled: boolean): void {
    this.hydrate();
    if (this.state.enabled === enabled) return;
    this.state.enabled = enabled;
    this.persist();
    this.emit();
  }

  toggle(): void {
    this.setEnabled(!this.state.enabled);
  }
}

export const notifications = new Notifications();
