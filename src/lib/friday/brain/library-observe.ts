/**
 * FRIDAY · read-only Library observation
 *
 * Core Brain / Auto Mode read the live Library snapshot. They never open a
 * second file store. Write/exec still goes through tool-authority.
 */

import { formatLibraryExtra, librarySnapshot, type LibrarySession } from "../library-awareness";
import { library } from "../library-engine";

const LOOK =
  /\b(look at (the |my )?library|library (page|item|file|section)|ask friday about this|use (this|these) (file|document|sheet)|pinned library|library me|yeh file)\b/i;

export function libraryLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export function shouldAttachLibraryExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (libraryLookRequested(text)) return true;
  return library.pinnedForAuto().length > 0;
}

export type LibraryObservation = {
  readOnly: true;
  spawned: false;
  summary: string;
  extra: string;
};

export function observationFromLibrary(snap: LibrarySession): LibraryObservation {
  const items = snap.items.length ? snap.items : library.list();
  const pinned = items.filter((item) => item.pinnedForAuto).length;
  let summary: string;
  if (!items.length) summary = "library idle — no owner files indexed yet";
  else
    summary = `library ${items.length} item(s)${pinned ? `, ${pinned} pinned for Auto Mode` : ""}`;
  return {
    readOnly: true,
    spawned: false,
    summary,
    extra: formatLibraryExtra(),
  };
}

export function observeLibraryState(): LibraryObservation {
  return observationFromLibrary(librarySnapshot());
}
