/**
 * FRIDAY · live browser session (renderer)
 *
 * One snapshot so Chat, Auto Mode, Voice, and Core Brain see the same tabs
 * the owner is looking at. The Chromium session lives in
 * `electron/browser-live.cjs` (`persist:friday-browser`). This module never
 * opens a second browser.
 */

export type BrowserSessionTab = {
  id: string;
  url: string;
  title: string;
};

export type BrowserSession = {
  desktop: boolean;
  mounted: boolean;
  activeId: string | null;
  tabs: BrowserSessionTab[];
  engine: string;
  proxyMode: string;
};

const empty = (): BrowserSession => ({
  desktop: false,
  mounted: false,
  activeId: null,
  tabs: [],
  engine: "duckduckgo",
  proxyMode: "direct",
});

let session: BrowserSession = empty();
let asker: ((prompt: string) => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function browserSnapshot(): BrowserSession {
  return session;
}

export function subscribeBrowserSession(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function publishBrowserSession(patch: Partial<BrowserSession>): BrowserSession {
  session = {
    ...session,
    ...patch,
    tabs: patch.tabs ? patch.tabs.slice(0, 40) : session.tabs,
  };
  emit();
  return session;
}

export function registerBrowserAsk(fn: ((prompt: string) => void) | null): void {
  asker = fn;
}

export function requestBrowserAsk(prompt: string): boolean {
  const text = String(prompt || "").trim();
  if (!text || !asker) return false;
  asker(text);
  return true;
}

export function formatBrowserExtra(maxChars = 6000): string {
  const active = session.tabs.find((tab) => tab.id === session.activeId) || session.tabs[0];
  const rows = session.tabs
    .slice(0, 12)
    .map(
      (tab) =>
        `- ${tab.title || tab.url} ${tab.url}${tab.id === session.activeId ? " (active)" : ""}`,
    )
    .join("\n");
  const body = [
    "BROWSER SESSION (one Chromium partition persist:friday-browser — you and FRIDAY share cookies, logins, cache)",
    session.mounted
      ? "section: open"
      : "section: closed (headless shared session still used for search/read)",
    `search engine: ${session.engine}`,
    `proxy: ${session.proxyMode}`,
    active ? `active: ${active.title || active.url}\n${active.url}` : "active: none",
    rows ? `tabs:\n${rows}` : "tabs: none",
    "Login, purchase, and form submit wait for owner approval. This is real Chromium, not a stealth/bot browser.",
  ]
    .filter(Boolean)
    .join("\n");
  return body.slice(0, maxChars);
}
