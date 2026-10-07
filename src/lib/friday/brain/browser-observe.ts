/**
 * FRIDAY · read-only browser observation
 *
 * Core Brain / Auto Mode read the live FRIDAY Browser snapshot. They never
 * open a second Chromium. Navigation and page actions stay on
 * `electron/browser-live.cjs` / `electron/browser.cjs`.
 */

import { browserSnapshot, formatBrowserExtra, type BrowserSession } from "../browser-awareness";

const LOOK =
  /\b(look at (the |my )?browser|what(?:'s| is) (on|in) (the |this |my )?(page|tab|site|browser)|summaris(?:e|e) this (page|tab|site)|this (page|tab|site|url)|current (page|tab|url)|friday browser|open tabs?|active tab)\b/i;

const USE =
  /\b(search the web|search online|web search|google this|bing this|look this up|look up|browse|open (the )?(site|url|page)|visit |go to https?:|search (google|bing|brave|duckduckgo|the internet))\b/i;

export function browserLookRequested(text: string): boolean {
  return LOOK.test(String(text || ""));
}

export function shouldAttachBrowserExtra(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (browserLookRequested(text)) return true;
  if (USE.test(text)) return true;
  if (/\bBROWSER SESSION\b/.test(text)) return true;
  const snap = browserSnapshot();
  return Boolean(snap.mounted && snap.tabs.length);
}

export type BrowserObservation = {
  readOnly: true;
  spawned: false;
  summary: string;
  extra: string;
};

export function observationFromBrowser(snap: BrowserSession): BrowserObservation {
  const active = snap.tabs.find((tab) => tab.id === snap.activeId) || snap.tabs[0];
  let summary: string;
  if (!snap.tabs.length) summary = "browser idle — no tabs yet";
  else if (!active) summary = `browser ${snap.tabs.length} tab(s), none active`;
  else {
    const host = (() => {
      try {
        return new URL(active.url).hostname;
      } catch {
        return active.url.slice(0, 40);
      }
    })();
    summary = `browser ${host} (${snap.tabs.length} tab${snap.tabs.length === 1 ? "" : "s"})${
      snap.mounted ? "" : ", section closed"
    }`;
  }
  return {
    readOnly: true,
    spawned: false,
    summary,
    extra: formatBrowserExtra(),
  };
}

export function observeBrowserState(): BrowserObservation {
  return observationFromBrowser(browserSnapshot());
}
