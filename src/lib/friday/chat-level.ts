/**
 * FRIDAY · Manual-mode chat level
 *
 * The main window chat has three levels:
 *   1 Compact   — today's layout: the full live graphic, the last 4 messages.
 *   2 Expanded  — the same graphic scaled down, every message in a taller area.
 *   3 Full chat — no graphic, a saved-chats rail and a centred conversation.
 *
 * The level is one small shared store so the main window layout and the chat
 * dock read the same value without polling. It is remembered on this PC under
 * one key; a corrupt or unknown stored value falls back to Compact.
 */
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { readLocalState, writeState } from "./persist";

export type ChatLevel = 1 | 2 | 3;

export const CHAT_LEVELS: readonly ChatLevel[] = [1, 2, 3];
export const DEFAULT_CHAT_LEVEL: ChatLevel = 1;
export const CHAT_LEVEL_KEY = "friday.chat.level.v1";
export const CHAT_LEVEL_LABELS: Record<ChatLevel, string> = {
  1: "Compact",
  2: "Expanded",
  3: "Full chat",
};
/** Compact shows only the newest few messages; the other levels show all. */
export const COMPACT_MESSAGE_COUNT = 4;

/** Any stored or typed value becomes a valid level. Unknown → Compact. */
export function clampChatLevel(value: unknown): ChatLevel {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (n === 1 || n === 2 || n === 3) return n;
  return DEFAULT_CHAT_LEVEL;
}

export function nextChatLevel(level: ChatLevel): ChatLevel {
  return clampChatLevel(Math.min(3, clampChatLevel(level) + 1));
}

export function previousChatLevel(level: ChatLevel): ChatLevel {
  return clampChatLevel(Math.max(1, clampChatLevel(level) - 1));
}

/** Messages a level shows. A search always shows every match. */
export function visibleMessages<T>(list: readonly T[], level: ChatLevel, searching: boolean): T[] {
  if (searching || level !== 1) return [...list];
  return list.slice(-COMPACT_MESSAGE_COUNT);
}

export type TranscriptMark = {
  first?: string | undefined;
  last?: string | undefined;
  lastRole?: string | undefined;
};

/**
 * Should the transcript scroll to the newest message? Yes while the owner is
 * reading the bottom, when a different conversation was loaded, and when the
 * owner just sent a message. Not while they are reading further up.
 */
export function followsLatest(
  pinned: boolean,
  prev: TranscriptMark,
  next: TranscriptMark,
): boolean {
  if (pinned) return true;
  if (next.first !== prev.first) return true;
  return next.last !== prev.last && next.lastRole === "user";
}

/** Alt+1 / Alt+2 / Alt+3 inside the chat region. Anything else is not ours. */
export function levelForKey(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}): ChatLevel | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const digit = /^Digit([123])$/.exec(event.code ?? "")?.[1] ?? event.key;
  return digit === "1" || digit === "2" || digit === "3" ? clampChatLevel(digit) : null;
}

export type ChatLevelIO = { read: () => unknown; write: (level: ChatLevel) => void };

const defaultIO: ChatLevelIO = {
  read: () => (typeof window === "undefined" ? null : readLocalState<unknown>(CHAT_LEVEL_KEY)),
  write: (level) => writeState(CHAT_LEVEL_KEY, level),
};

export function createChatLevelStore(io: ChatLevelIO = defaultIO) {
  let level: ChatLevel = DEFAULT_CHAT_LEVEL;
  let loaded = false;
  const listeners = new Set<() => void>();
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      level = clampChatLevel(io.read());
    } catch {
      level = DEFAULT_CHAT_LEVEL;
    }
  };
  const getSnapshot = (): ChatLevel => {
    load();
    return level;
  };
  const set = (value: unknown) => {
    load();
    const next = clampChatLevel(value);
    if (next === level) return;
    level = next;
    io.write(next);
    listeners.forEach((fn) => fn());
  };
  return {
    getSnapshot,
    getServerSnapshot: (): ChatLevel => DEFAULT_CHAT_LEVEL,
    subscribe: (fn: () => void) => {
      load();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set,
    next: () => set(nextChatLevel(getSnapshot())),
    previous: () => set(previousChatLevel(getSnapshot())),
  };
}

export const chatLevel = createChatLevelStore();

export function useChatLevel(): ChatLevel {
  return useSyncExternalStore(
    chatLevel.subscribe,
    chatLevel.getSnapshot,
    chatLevel.getServerSnapshot,
  );
}

/**
 * Toolbar overflow: how many of the secondary items, in order, fit in the
 * width left after the fixed items. The rest go into one "More" menu, which
 * itself needs room once anything overflows.
 */
export function toolbarFit(itemWidths: readonly number[], available: number, moreWidth: number) {
  const total = itemWidths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return itemWidths.length;
  let used = moreWidth;
  let fit = 0;
  for (const width of itemWidths) {
    if (used + width > available) break;
    used += width;
    fit += 1;
  }
  return fit;
}

/* Chat toolbar widths in px, estimated from the rendered buttons at the
   default font size (text-[11px], h-7, px-2, gap-1). */
/** Below this toolbar width it shows icons only. styles.css hides the text
 * below a 48rem chat panel, which is this width plus the p-2 padding. */
export const LABELS_MIN_WIDTH = 752;
/** Width of everything in the toolbar that never moves into "More". */
export const FIXED_WIDTH = { labelled: 420, iconOnly: 250 };
/** Secondary buttons in order: Capabilities, Library, Projects, Commands. */
export const SECONDARY_WIDTHS = {
  labelled: [118, 84, 92, 32],
  iconOnly: [44, 44, 44, 32],
};
export const MORE_WIDTH = 34;

export function secondaryFit(width: number): number {
  if (!(width > 0)) return SECONDARY_WIDTHS.labelled.length;
  const labelled = width >= LABELS_MIN_WIDTH;
  const fixed = labelled ? FIXED_WIDTH.labelled : FIXED_WIDTH.iconOnly;
  const widths = labelled ? SECONDARY_WIDTHS.labelled : SECONDARY_WIDTHS.iconOnly;
  return toolbarFit(widths, width - fixed, MORE_WIDTH);
}

/**
 * How many secondary toolbar buttons fit. Measured with one ResizeObserver
 * on the toolbar row (disconnected on unmount); no polling.
 */
export function useToolbarFit(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      setWidth((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return secondaryFit(width);
}

/**
 * Expanded level: the compact graphic is laid out on a virtual stage big
 * enough for its boxes and mark, then scaled down uniformly so nothing
 * touches. The mark's rings are capped by the viewport height (vh), so the
 * stage it needs depends on it. Never enlarges.
 */
const BOX_HALF_WIDTH_PX = 69; // w-[8.6rem] / 2
const BOX_GAP_PX = 8;
const INNER_BOX_EDGE = 0.31; // the innermost box column sits at 19% / 81%

export function circuitDesignSize(viewportH: number): { width: number; height: number } {
  const vh = viewportH > 0 ? viewportH : 680;
  const ring = Math.min(420, 0.38 * vh);
  const orb = Math.min(220, 0.2 * vh);
  return {
    height: Math.ceil(Math.max(300, ring + 16, orb + 2 * 64 + 16)),
    width: Math.ceil(Math.max(560, (ring / 2 + BOX_HALF_WIDTH_PX + BOX_GAP_PX) / INNER_BOX_EDGE)),
  };
}

export function circuitFitScale(stageW: number, stageH: number, viewportH: number): number {
  if (!(stageW > 0) || !(stageH > 0)) return 1;
  const need = circuitDesignSize(viewportH);
  const scale = Math.min(1, stageH / need.height, stageW / need.width);
  return Math.max(0.3, Math.floor(scale * 1000) / 1000);
}
