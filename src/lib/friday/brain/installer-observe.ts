/**
 * FRIDAY · read-only Install Manager observation
 *
 * Core Brain only reads the live Install Manager session the owner (or FRIDAY)
 * already produced. It never opens a second installer. The store stays
 * `installer-engine.ts`. Bare “what's wrong” stays inspectSelf — this LOOK
 * is the Install Manager page.
 */

import {
  formatInstallerExtra,
  installerSnapshot,
  type InstallerSession,
} from "../installer-awareness";

const LOOK =
  /\b(look at (the |my )?install(er|ation)? manager|install manager (page|catalog|queue|log|session|list)|what(?:'s| is) on (the |my )?install manager|scan (the )?install manager|installer (status|queue|log|catalog)|show (me )?(the )?install manager|install required|update all packages|verify all packages)\b/i;

export function installerLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export function shouldAttachInstallerExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  return installerLookRequested(text);
}

export type InstallerObservation = {
  readOnly: true;
  spawned: false;
  scanning: boolean;
  summary: string;
  extra: string;
};

export function observationFromInstaller(snap: InstallerSession): InstallerObservation {
  let summary: string;
  if (snap.scanning) {
    summary = `install manager scanning · ${snap.entries.length} catalog rows`;
  } else if (!snap.entries.length) {
    summary = "install manager idle — catalog not loaded yet";
  } else {
    summary = `install manager ${snap.installed}/${snap.entries.length} installed · ${snap.updates} update(s) · ${snap.requiredMissing} required missing`;
  }
  return {
    readOnly: true,
    spawned: false,
    scanning: snap.scanning,
    summary,
    extra: formatInstallerExtra(),
  };
}

export function observeInstallerState(): InstallerObservation {
  return observationFromInstaller(installerSnapshot());
}
