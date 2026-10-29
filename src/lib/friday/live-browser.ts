/**
 * FRIDAY · live browser bridge (renderer side)
 *
 * Thin, honest wrapper over the main-process browser subsystem
 * (electron/browser-live.cjs). Everything here talks to the one shared
 * Chromium session used by both the FRIDAY Browser section and FRIDAY's own
 * programmatic browsing. In the web preview the bridge is absent and every
 * call reports that the browser is desktop-only — nothing is simulated.
 */

export type BrowserTabState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
};

export type BrowserProxyMode = "direct" | "system" | "fixed";

export type SearchEngineId =
  "duckduckgo" | "google" | "bing" | "brave" | "startpage" | "ecosia" | "wikipedia" | "yahoo";

export const SEARCH_ENGINES: Array<{ id: SearchEngineId; label: string; url: string }> = [
  { id: "duckduckgo", label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  { id: "google", label: "Google", url: "https://www.google.com/search?q=" },
  { id: "bing", label: "Bing", url: "https://www.bing.com/search?q=" },
  { id: "brave", label: "Brave", url: "https://search.brave.com/search?q=" },
  { id: "startpage", label: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
  { id: "ecosia", label: "Ecosia", url: "https://www.ecosia.org/search?q=" },
  { id: "wikipedia", label: "Wikipedia", url: "https://en.wikipedia.org/w/index.php?search=" },
  { id: "yahoo", label: "Yahoo", url: "https://search.yahoo.com/search?p=" },
];

export type BrowserSettings = {
  homepage: string;
  searchEngine: string;
  blockPopups: boolean;
  doNotTrack: boolean;
  clearOnExit: boolean;
  defaultZoom: number;
  /** How Chromium reaches the network. `direct` still uses the PC's Windows VPN. */
  proxyMode: BrowserProxyMode;
  /** SOCKS5 / HTTP proxy, e.g. socks5://127.0.0.1:1080 — only when proxyMode is fixed. */
  proxyRules: string;
  proxyBypass: string;
  permissions: Record<string, "allow" | "ask" | "block">;
};

export type BrowserVisit = { url: string; title: string; at: number };
export type BrowserBookmark = BrowserVisit;

export type BrowserDownload = {
  id: string;
  url: string;
  file: string;
  name: string;
  total: number;
  received: number;
  state: string;
  at: number;
};

export type BrowserCommand = {
  id: string;
  /** navigate | back | forward | reload | stop | search | newTab | closeTab | activate | read | click | type | scroll | zoom | find | state */
  action: string;
  url?: string;
  tabId?: string;
  selector?: string;
  text?: string;
  value?: number;
};

export type BrowserCommandResult = {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  tabs?: BrowserTabState[];
  activeId?: string | null;
  matches?: number;
  results?: { title: string; url: string; snippet: string }[];
  fallback?: boolean;
};

type Bridge = {
  browserSettings?: () => Promise<BrowserSettings>;
  setBrowserSettings?: (patch: Partial<BrowserSettings>) => Promise<BrowserSettings>;
  browserVisits?: (limit?: number) => Promise<BrowserVisit[]>;
  addBrowserVisit?: (entry: { url: string; title?: string }) => Promise<unknown>;
  clearBrowserVisits?: () => Promise<BrowserVisit[]>;
  browserBookmarks?: () => Promise<BrowserBookmark[]>;
  addBrowserBookmark?: (entry: { url: string; title?: string }) => Promise<BrowserBookmark[]>;
  removeBrowserBookmark?: (url: string) => Promise<BrowserBookmark[]>;
  browserTabs?: () => Promise<{
    tabs: { id: string; url: string; title: string }[];
    activeId: string | null;
  }>;
  saveBrowserTabs?: (state: { tabs: unknown[]; activeId: string | null }) => Promise<unknown>;
  publishBrowserState?: (state: unknown) => Promise<unknown>;
  liveBrowserState?: () => Promise<unknown>;
  browserCommand?: (payload: Omit<BrowserCommand, "id">) => Promise<BrowserCommandResult>;
  browserCommandResult?: (id: string, result: BrowserCommandResult) => Promise<unknown>;
  browserDownloads?: () => Promise<BrowserDownload[]>;
  clearBrowserDownloads?: () => Promise<BrowserDownload[]>;
  clearBrowserData?: (kinds?: string[] | null) => Promise<{ ok: boolean }>;
  browserCookieCount?: () => Promise<number>;
  clearOriginCookies?: (url: string) => Promise<{ ok: boolean; cleared?: number; error?: string }>;
  revealDownload?: (file: string) => Promise<{ ok: boolean }>;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  browserActiveGuest?: (id: number) => Promise<{ ok: boolean }>;
  onBrowserCommand?: (cb: (payload: BrowserCommand) => void) => () => void;
  onBrowserDownload?: (cb: (payload: BrowserDownload) => void) => () => void;
  onBrowserPopup?: (cb: (payload: { url: string; disposition: string }) => void) => () => void;
  onBrowserContextMenu?: (cb: (payload: Record<string, unknown>) => void) => () => void;
  onBrowserGuestGone?: (cb: (payload: { reason: string; url?: string }) => void) => () => void;
};

const api = (): Bridge | undefined =>
  typeof window === "undefined" ? undefined : (window.friday as unknown as Bridge | undefined);

export const liveBrowserAvailable = (): boolean => Boolean(api()?.browserCommand);

export const DEFAULT_SETTINGS: BrowserSettings = {
  homepage: "https://duckduckgo.com/",
  searchEngine: "duckduckgo",
  blockPopups: true,
  doNotTrack: true,
  clearOnExit: false,
  defaultZoom: 1,
  proxyMode: "direct",
  proxyRules: "",
  proxyBypass: "<local>",
  permissions: {
    media: "ask",
    geolocation: "ask",
    notifications: "ask",
    clipboard: "ask",
    midi: "block",
    "display-capture": "ask",
    fullscreen: "allow",
    pointerLock: "allow",
    openExternal: "ask",
  },
};

export async function loadSettings(): Promise<BrowserSettings> {
  return (await api()?.browserSettings?.()) ?? DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings> {
  return (await api()?.setBrowserSettings?.(patch)) ?? { ...DEFAULT_SETTINGS, ...patch };
}

export const loadVisits = async (limit = 200): Promise<BrowserVisit[]> =>
  (await api()?.browserVisits?.(limit)) ?? [];
export const recordVisit = async (url: string, title?: string) => {
  await api()?.addBrowserVisit?.({ url, title: title ?? url });
};
export const clearVisits = async (): Promise<BrowserVisit[]> =>
  (await api()?.clearBrowserVisits?.()) ?? [];

export const loadBookmarks = async (): Promise<BrowserBookmark[]> =>
  (await api()?.browserBookmarks?.()) ?? [];
export const addBookmark = async (url: string, title?: string): Promise<BrowserBookmark[]> =>
  (await api()?.addBrowserBookmark?.({ url, title: title ?? url })) ?? [];
export const removeBookmark = async (url: string): Promise<BrowserBookmark[]> =>
  (await api()?.removeBrowserBookmark?.(url)) ?? [];

export const loadTabs = async () => (await api()?.browserTabs?.()) ?? { tabs: [], activeId: null };
export const saveTabs = async (
  tabs: { id: string; url: string; title: string }[],
  activeId: string | null,
) => {
  await api()?.saveBrowserTabs?.({ tabs, activeId });
};
export const publishState = async (state: {
  tabs: BrowserTabState[];
  activeId: string | null;
  mounted: boolean;
}) => {
  await api()?.publishBrowserState?.(state);
};

export const loadDownloads = async (): Promise<BrowserDownload[]> =>
  (await api()?.browserDownloads?.()) ?? [];
export const clearDownloads = async (): Promise<BrowserDownload[]> =>
  (await api()?.clearBrowserDownloads?.()) ?? [];
export const revealDownload = async (file: string) => {
  await api()?.revealDownload?.(file);
};

export const clearBrowsingData = async (kinds?: string[]) =>
  (await api()?.clearBrowserData?.(kinds ?? null)) ?? { ok: false };
export const cookieCount = async (): Promise<number> => (await api()?.browserCookieCount?.()) ?? 0;
export const clearOriginCookies = async (url: string) =>
  (await api()?.clearOriginCookies?.(url)) ?? { ok: false, error: "desktop only" };
export const setActiveGuest = async (id: number) => {
  await api()?.browserActiveGuest?.(id);
};
export const openExternal = async (url: string) => api()?.openExternalUrl?.(url);

/** FRIDAY → live tab. Resolves with the real result from the Browser section. */
export async function sendBrowserCommand(
  payload: Omit<BrowserCommand, "id">,
): Promise<BrowserCommandResult> {
  const bridge = api();
  if (!bridge?.browserCommand) {
    return { ok: false, error: "FRIDAY Browser runs in the desktop app." };
  }
  try {
    return await bridge.browserCommand(payload);
  } catch (error) {
    return { ok: false, error: String((error as Error).message || error) };
  }
}

/** The Browser section registers itself as the executor for FRIDAY commands. */
export function registerCommandHost(
  handler: (command: BrowserCommand) => Promise<BrowserCommandResult>,
): () => void {
  const bridge = api();
  if (!bridge?.onBrowserCommand || !bridge.browserCommandResult) return () => {};
  return bridge.onBrowserCommand(async (command) => {
    let result: BrowserCommandResult;
    try {
      result = await handler(command);
    } catch (error) {
      result = { ok: false, error: String((error as Error).message || error) };
    }
    void bridge.browserCommandResult?.(command.id, result);
  });
}

export const onDownload = (cb: (item: BrowserDownload) => void) =>
  api()?.onBrowserDownload?.(cb) ?? (() => {});
export const onPopup = (cb: (payload: { url: string; disposition: string }) => void) =>
  api()?.onBrowserPopup?.(cb) ?? (() => {});
export const onGuestGone = (cb: (payload: { reason: string; url?: string }) => void) =>
  api()?.onBrowserGuestGone?.(cb) ?? (() => {});

/** Address bar input → a real URL (or a search on the configured engine). */
export function toUrl(input: string, engine = "duckduckgo"): string {
  const value = String(input || "").trim();
  if (!value) return "about:blank";
  if (/^(https?|file|about):/i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value)) return `https://${value}`;
  const engineRow = SEARCH_ENGINES.find((row) => row.id === engine);
  const prefix = engineRow?.url ?? "https://duckduckgo.com/?q=";
  return `${prefix}${encodeURIComponent(value)}`;
}
