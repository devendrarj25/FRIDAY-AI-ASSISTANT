/**
 * FRIDAY · shared composer context
 *
 * One canonical place holding what the owner attached to the next turn:
 * capabilities (skills, agents, tools, workflows, modules, plugins,
 * connectors) and pinned models. Both the typed chat dock and the voice
 * (auto mode) pipeline read from here, so a turn spoken aloud carries exactly
 * the same context as a typed one — continuity across manual and auto mode.
 *
 * Selections survive restarts and are pruned automatically: an entry whose
 * capability no longer exists (plugin removed, model uninstalled) is dropped
 * the next time the live catalog is published.
 */
import { capabilityDirective, type Capability } from "./capabilities";
import { modelRegistry } from "./model-registry";
import { readLocalState, writeState } from "./persist";

const KEY = "friday.composer.attached.v1";

class ComposerStore {
  private selected: Capability[] = [];
  private listeners = new Set<() => void>();
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    const saved = readLocalState<Capability[]>(KEY);
    if (Array.isArray(saved)) this.selected = saved.filter((c) => c && typeof c.id === "string");
  }

  getSnapshot = (): Capability[] => {
    this.load();
    return this.selected;
  };

  subscribe = (fn: () => void) => {
    this.load();
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private commit(next: Capability[]) {
    this.selected = next;
    writeState(KEY, next);
    this.listeners.forEach((fn) => fn());
  }

  has(id: string): boolean {
    return this.getSnapshot().some((c) => c.id === id);
  }

  toggle(cap: Capability) {
    const list = this.getSnapshot();
    this.commit(
      list.some((c) => c.id === cap.id) ? list.filter((c) => c.id !== cap.id) : [...list, cap],
    );
  }

  detach(id: string) {
    this.commit(this.getSnapshot().filter((c) => c.id !== id));
  }

  clear() {
    if (!this.getSnapshot().length) return;
    this.commit([]);
  }

  /** Drop attachments that no longer exist in the live catalog. */
  reconcile(live: Capability[]) {
    const known = new Map(live.map((c) => [c.id, c] as const));
    const current = this.getSnapshot();
    if (!current.length || !known.size) return;
    const next = current.filter((c) => known.has(c.id)).map((c) => known.get(c.id) ?? c);
    if (next.length === current.length && next.every((c, i) => c === current[i])) return;
    this.commit(next);
  }

  /** The instruction block + pinned model ids for the next turn. */
  directive(): { extra: string; modelIds: string[] } {
    const { extra, modelIds } = capabilityDirective(this.getSnapshot());
    const pinned = [...new Set([...modelIds, ...modelRegistry.selectedIds()])];
    return { extra, modelIds: pinned };
  }
}

export const composer = new ComposerStore();
