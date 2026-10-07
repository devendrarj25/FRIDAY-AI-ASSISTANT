/**
 * FRIDAY · presentation stage
 *
 * When FRIDAY wants to *show* something instead of only saying it — an image,
 * a video, a file, a table, a chart, a diagram or a longer piece of text — she
 * publishes it here and the main window renders it over the console.
 *
 * Everything on the stage comes from a real subsystem (a notification, a task
 * result, a research finding, a screen capture). Nothing is generated for
 * decoration. The list is bounded and persisted, so a card FRIDAY raised
 * before a restart is still there afterwards.
 */

import { readLocalState, restoreFromDisk, writeState } from "./persist";

const NAMESPACE = "friday.stage";
const MAX_ITEMS = 30;

export type StageKind =
  "text" | "image" | "video" | "file" | "table" | "chart" | "diagram" | "code";

export type StageSeries = { label: string; value: number };

export type StageItem = {
  id: string;
  kind: StageKind;
  title: string;
  /** Text / code / diagram body. */
  body?: string;
  /** Media or file source (data URL, file:// path or https URL). */
  src?: string;
  /** File name shown for `file` cards. */
  fileName?: string;
  /** Table data. */
  columns?: string[];
  rows?: string[][];
  /** Chart data. */
  series?: StageSeries[];
  /** Which subsystem raised it. */
  source: string;
  at: number;
};

export type StageState = {
  items: StageItem[];
  /** Id of the card currently on screen ("" = stage closed). */
  activeId: string;
  open: boolean;
};

type Persisted = { items: StageItem[] };

let seq = 0;
const nextId = () => `stage-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class Stage {
  private state: StageState = { items: [], activeId: "", open: false };
  private snapshot: StageState = this.state;
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
    if (local?.items?.length) this.state.items = local.items.slice(0, MAX_ITEMS);
    restoreFromDisk<Persisted>(NAMESPACE, (value) => {
      if ((value?.items?.length ?? 0) > this.state.items.length) {
        this.state.items = value.items.slice(0, MAX_ITEMS);
        this.emit();
      }
    });
    this.emit();
  }

  private persist() {
    writeState(NAMESPACE, { items: this.state.items } as Persisted);
  }

  private emit() {
    this.snapshot = { ...this.state, items: [...this.state.items] };
    this.listeners.forEach((l) => l());
  }

  /** Publish a card. `open` (default true) brings it to the main screen. */
  show(input: Omit<StageItem, "id" | "at"> & { id?: string; open?: boolean }): StageItem {
    this.hydrate();
    const { open = true, ...rest } = input;
    const item: StageItem = { ...rest, id: input.id ?? nextId(), at: Date.now() };
    this.state.items = [item, ...this.state.items.filter((i) => i.id !== item.id)].slice(
      0,
      MAX_ITEMS,
    );
    if (open) {
      this.state.activeId = item.id;
      this.state.open = true;
    }
    this.persist();
    this.emit();
    return item;
  }

  open(id: string): void {
    this.hydrate();
    if (!this.state.items.some((i) => i.id === id)) return;
    this.state.activeId = id;
    this.state.open = true;
    this.emit();
  }

  close(): void {
    if (!this.state.open) return;
    this.state.open = false;
    this.emit();
  }

  step(delta: number): void {
    const index = this.state.items.findIndex((i) => i.id === this.state.activeId);
    if (index < 0 || this.state.items.length < 2) return;
    const next = (index + delta + this.state.items.length) % this.state.items.length;
    this.state.activeId = this.state.items[next]!.id;
    this.emit();
  }

  remove(id: string): void {
    this.state.items = this.state.items.filter((i) => i.id !== id);
    if (this.state.activeId === id) {
      this.state.activeId = this.state.items[0]?.id ?? "";
      this.state.open = Boolean(this.state.activeId);
    }
    this.persist();
    this.emit();
  }

  clear(): void {
    this.state.items = [];
    this.state.activeId = "";
    this.state.open = false;
    this.persist();
    this.emit();
  }

  active(): StageItem | null {
    return this.state.items.find((i) => i.id === this.state.activeId) ?? null;
  }
}

export const stage = new Stage();

/**
 * Put a chart on the existing stage from numbers that were actually measured.
 * Refuses empty or non-finite values instead of inventing a picture.
 */
export function showRealChart(input: {
  title: string;
  series: StageSeries[];
  source: string;
  body?: string;
}): StageItem | { error: string } {
  const series = (input.series ?? []).filter(
    (point) => point && Number.isFinite(point.value) && String(point.label ?? "").trim().length > 0,
  );
  if (!series.length) {
    return { error: "No real numbers to chart — I will not invent a series." };
  }
  return stage.show({
    kind: "chart",
    title: input.title,
    source: input.source,
    series,
    ...(input.body ? { body: input.body } : {}),
  });
}

/** Put a real screenshot or image on the existing stage. */
export function showRealImage(input: {
  title: string;
  src: string;
  source: string;
  body?: string;
}): StageItem | { error: string } {
  const src = String(input.src || "").trim();
  if (!src) return { error: "No image was captured — I will not invent a screenshot." };
  return stage.show({
    kind: "image",
    title: input.title,
    source: input.source,
    src,
    ...(input.body ? { body: input.body } : {}),
  });
}
