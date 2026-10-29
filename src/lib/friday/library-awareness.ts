/**
 * FRIDAY · live Library session (renderer)
 *
 * One snapshot so Chat, Auto Mode, and Core Brain see the same Library the
 * owner is looking at. The durable store is `electron/library.cjs`.
 */

import { library, type LibraryRecord } from "./library-engine";
import { capPromptText, LIBRARY_PIN_CHARS, libraryTypeHonesty } from "./library-logic";

export type LibrarySession = {
  desktop: boolean;
  dir: string;
  items: LibraryRecord[];
  pinned: string[];
  selectedId: string | null;
};

const empty = (): LibrarySession => ({
  desktop: false,
  dir: "",
  items: [],
  pinned: [],
  selectedId: null,
});

let session: LibrarySession = empty();
let asker: ((prompt: string) => void) | null = null;

export function librarySnapshot(): LibrarySession {
  return session;
}

export function publishLibrarySession(patch: Partial<LibrarySession>): LibrarySession {
  session = {
    ...session,
    ...patch,
    items: patch.items ? patch.items.slice(0, 400) : session.items,
    pinned: patch.pinned ?? session.pinned,
  };
  return session;
}

export function registerLibraryAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestLibraryAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function formatLibraryExtra(maxChars = 8000): string {
  const snap = session.items.length ? session : { ...session, items: library.list() };
  const pinned = snap.items.filter((item) => item.pinnedForAuto);
  const rows = snap.items
    .slice(0, 24)
    .map((item) =>
      `- ${item.name} [${item.type}/${item.origin}] library:${item.id} ${item.truncated ? "partial-extract" : "extract-ok"} ${item.hisabLinked ? "hisab-linked" : ""} ${item.pinnedForAuto ? "pinned-auto" : ""}`.trim(),
    )
    .join("\n");
  const pinBodies = pinned.slice(0, 4).map((item) => {
    const honesty = libraryTypeHonesty(item);
    const extract = item.text?.trim() ? capPromptText(item.text, LIBRARY_PIN_CHARS).text : honesty;
    return `PINNED EXTRACT library:${item.id} ${item.name} [${item.type}]\n${extract}`;
  });
  const body = [
    "LIBRARY SESSION (owner files under FRIDAY_ROOT/library — not Import & Build)",
    snap.dir ? `dir: ${snap.dir}` : "dir: (preview/session copy until desktop persist)",
    `items: ${snap.items.length}`,
    pinned.length
      ? `pinned for Auto Mode:\n${pinned.map((item) => `  ${item.name} library:${item.id}`).join("\n")}`
      : "pinned for Auto Mode: none",
    pinBodies.length ? pinBodies.join("\n") : "",
    "index:",
    rows || "(empty)",
    "Image/audio/video: do not invent pixels, transcripts, or watched frames. Teach uses stored extract text only.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return body.slice(0, maxChars);
}
