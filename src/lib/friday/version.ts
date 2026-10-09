/**
 * FRIDAY · one version, everywhere.
 *
 * `config/friday-version.json` is the canonical product version. Both Vite
 * configs inject the public display version as `__FRIDAY_VERSION__` /
 * `__FRIDAY_BUILD__`, and the packaged desktop app confirms it over IPC
 * (`app:version`) from the same identity — so the title strip, the sidebar,
 * Settings, Diagnostics and every "about" line all read the same number.
 */
import { useSyncExternalStore } from "react";

declare const __FRIDAY_VERSION__: string | undefined;
declare const __FRIDAY_BUILD__: string | undefined;

const compiled = (() => {
  try {
    return typeof __FRIDAY_VERSION__ === "string" ? __FRIDAY_VERSION__ : "";
  } catch {
    return "";
  }
})();

const compiledBuild = (() => {
  try {
    return typeof __FRIDAY_BUILD__ === "string" ? __FRIDAY_BUILD__ : "";
  } catch {
    return "";
  }
})();

/** Public four-part identity, e.g. "1.0.0.0". */
export const APP_VERSION = compiled || "1.0.1.2";
/** Display form, e.g. "v1.0.0.0". */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
/** Build stamp (UTC date of the bundle), e.g. "2026.08.11". */
export const APP_BUILD = compiledBuild || new Date().toISOString().slice(0, 10).replace(/-/g, ".");

let runtimeVersion = APP_VERSION;
const listeners = new Set<(v: string) => void>();
let asked = false;

/** Ask the packaged app for its real version once, then notify subscribers. */
function ensureRuntimeVersion() {
  if (asked || typeof window === "undefined") return;
  asked = true;
  const api = (window as unknown as { friday?: { version?: () => Promise<string> } }).friday;
  if (!api?.version) return;
  void api
    .version()
    .then((value) => {
      const clean = String(value || "").trim();
      if (!clean || clean === runtimeVersion) return;
      runtimeVersion = clean;
      listeners.forEach((l) => l(runtimeVersion));
    })
    .catch(() => {
      /* browser preview / bridge not ready — the compiled value stands */
    });
}

function subscribeRuntimeVersion(onChange: () => void): () => void {
  listeners.add(onChange);
  ensureRuntimeVersion();
  return () => {
    listeners.delete(onChange);
  };
}

/** The version to display: the installed app's own version when available. */
export function useAppVersion(): { version: string; label: string; build: string } {
  const version = useSyncExternalStore(
    subscribeRuntimeVersion,
    () => runtimeVersion,
    () => runtimeVersion,
  );
  return { version, label: `v${version}`, build: APP_BUILD };
}
