import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  Bug,
  Download,
  Globe,
  History,
  Home,
  Maximize2,
  Plus,
  RotateCw,
  Search,
  Settings2,
  Square,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  MessageSquare,
} from "lucide-react";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { AppShell, Panel } from "@/components/friday/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { brain } from "@/lib/friday/brain-engine";
import { useBrain } from "@/lib/friday/use-brain";
import {
  formatBrowserExtra,
  publishBrowserSession,
  registerBrowserAsk,
} from "@/lib/friday/browser-awareness";
import {
  DEFAULT_SETTINGS,
  SEARCH_ENGINES,
  addBookmark,
  clearBrowsingData,
  clearDownloads,
  clearOriginCookies,
  clearVisits,
  cookieCount,
  liveBrowserAvailable,
  loadBookmarks,
  loadDownloads,
  loadSettings,
  loadTabs,
  loadVisits,
  onDownload,
  onGuestGone,
  onPopup,
  openExternal,
  publishState,
  recordVisit,
  registerCommandHost,
  removeBookmark,
  revealDownload,
  saveSettings,
  saveTabs,
  setActiveGuest,
  toUrl,
  type BrowserBookmark,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserDownload,
  type BrowserSettings,
  type BrowserVisit,
} from "@/lib/friday/live-browser";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/browser")({
  head: () => ({
    meta: [
      { title: "FRIDAY Browser — Web" },
      {
        name: "description",
        content:
          "A real Chromium browser inside FRIDAY: tabs, bookmarks, history, downloads, find-in-page, zoom, proxy, Ask FRIDAY, and a persistent session shared with FRIDAY's own web tools.",
      },
      { property: "og:title", content: "FRIDAY Browser — Web" },
      {
        property: "og:description",
        content: "Tabs, downloads, bookmarks and one persistent session shared by you and FRIDAY.",
      },
    ],
  }),
  component: BrowserPage,
});

type Tab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
};

type WebviewEl = HTMLElement & {
  src: string;
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  getTitle: () => string;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  reload: () => void;
  stop: () => void;
  setZoomFactor: (factor: number) => void;
  findInPage: (text: string, options?: Record<string, unknown>) => void;
  stopFindInPage: (action: string) => void;
  isLoading: () => boolean;
  openDevTools: () => void;
  closeDevTools: () => void;
  isDevToolsOpened: () => boolean;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  downloadURL: (url: string) => void;
};

const newId = () => `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

type PanelKind = "none" | "bookmarks" | "history" | "downloads" | "settings" | "ask";

/** Keep at most this many live <webview> guests so background tabs cannot freeze Chromium. */
const LIVE_TAB_CAP = 4;

const EXTRACT_SEARCH_JS = `(() => {
  const out = [];
  const seen = new Set();
  const skip = /duckduckgo\\.com|google\\.[^/]+|bing\\.com|search\\.brave\\.com|startpage\\.com|ecosia\\.org|search\\.yahoo\\.com/;
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href || "";
    if (!/^https?:/i.test(href) || seen.has(href) || skip.test(href)) continue;
    const title = (a.innerText || "").replace(/\\s+/g, " ").trim();
    if (title.length < 8) continue;
    seen.add(href);
    out.push({ title: title.slice(0, 200), url: href, snippet: "" });
    if (out.length >= 8) break;
  }
  return out;
})()`;

function waitStopped(el: WebviewEl | null, ms = 12000): Promise<void> {
  if (!el) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("did-stop-loading", finish);
      resolve();
    };
    el.addEventListener("did-stop-loading", finish);
    window.setTimeout(() => {
      try {
        const loading =
          typeof (el as WebviewEl & { isLoading?: () => boolean }).isLoading === "function"
            ? (el as WebviewEl & { isLoading: () => boolean }).isLoading()
            : true;
        if (!loading) finish();
      } catch {
        finish();
      }
    }, 50);
    window.setTimeout(finish, ms);
  });
}

function waitForView(
  map: Map<string, WebviewEl>,
  id: string | null,
  ms = 5000,
): Promise<WebviewEl | null> {
  if (!id) return Promise.resolve(null);
  const hit = map.get(id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const el = map.get(id);
      if (el) {
        resolve(el);
        return;
      }
      if (Date.now() - start >= ms) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 40);
    };
    tick();
  });
}

function BrowserPage() {
  const [desktop, setDesktop] = useState(() => liveBrowserAvailable());
  const brainState = useBrain();

  useEffect(() => {
    setDesktop(liveBrowserAvailable());
  }, []);
  const [settings, setSettings] = useState<BrowserSettings>(DEFAULT_SETTINGS);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [liveIds, setLiveIds] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [panel, setPanel] = useState<PanelKind>("none");
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [visits, setVisits] = useState<BrowserVisit[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownload[]>([]);
  const [cookies, setCookies] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findMatches, setFindMatches] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [ask, setAsk] = useState("");
  const [viewNonce, setViewNonce] = useState<Record<string, number>>({});

  const views = useRef(new Map<string, WebviewEl>());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<Tab[]>([]);
  const activeRef = useRef<string | null>(null);
  tabsRef.current = tabs;
  activeRef.current = activeId;

  const active = useMemo(() => tabs.find((t) => t.id === activeId) ?? null, [tabs, activeId]);
  const view = (id?: string | null) => (id ? (views.current.get(id) ?? null) : null);

  const patch = useCallback((id: string, next: Partial<Tab>) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }, []);

  // ---- initial state ------------------------------------------------------
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [loaded, saved, marks, seen, dls, count] = await Promise.all([
        loadSettings(),
        loadTabs(),
        loadBookmarks(),
        loadVisits(150),
        loadDownloads(),
        cookieCount(),
      ]);
      if (!alive) return;
      setSettings(loaded);
      setBookmarks(marks);
      setVisits(seen);
      setDownloads(dls);
      setCookies(count);
      const restored: Tab[] = (saved.tabs ?? []).map((t) => ({
        id: t.id || newId(),
        url: t.url,
        title: t.title || t.url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoom: loaded.defaultZoom || 1,
      }));
      const list = restored.length
        ? restored
        : [
            {
              id: newId(),
              url: loaded.homepage,
              title: "New tab",
              loading: true,
              canGoBack: false,
              canGoForward: false,
              zoom: loaded.defaultZoom || 1,
            },
          ];
      setTabs(list);
      const nextActive = list.find((t) => t.id === saved.activeId)?.id ?? list[0]!.id;
      setActiveId(nextActive);
      setLiveIds([nextActive]);
      setAddress(list.find((t) => t.id === nextActive)?.url ?? "");
      publishBrowserSession({
        desktop,
        mounted: true,
        tabs: list.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        activeId: nextActive,
        engine: loaded.searchEngine,
        proxyMode: loaded.proxyMode,
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ---- persist + publish live state (debounced so loading flicker cannot freeze disk) ----
  useEffect(() => {
    if (!tabs.length) return;
    const timer = window.setTimeout(() => {
      void saveTabs(
        tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        activeId,
      );
      void publishState({ tabs, activeId, mounted: true });
      publishBrowserSession({
        desktop,
        mounted: true,
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })),
        activeId,
        engine: settings.searchEngine,
        proxyMode: settings.proxyMode,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [tabs, activeId, desktop, settings.searchEngine, settings.proxyMode]);

  useEffect(
    () => () => {
      void publishState({ tabs: tabsRef.current, activeId: activeRef.current, mounted: false });
      publishBrowserSession({ mounted: false });
    },
    [],
  );

  useEffect(() => {
    for (const id of [...views.current.keys()]) {
      if (!liveIds.includes(id)) views.current.delete(id);
    }
  }, [liveIds]);

  // ---- downloads + popups --------------------------------------------------
  useEffect(() => {
    const offDownload = onDownload((item) => {
      setDownloads((list) => [item, ...list.filter((d) => d.id !== item.id)].slice(0, 100));
      setStatus(
        item.state === "completed"
          ? `Downloaded ${item.name}`
          : `Downloading ${item.name} — ${Math.round((item.received / Math.max(item.total, 1)) * 100)}%`,
      );
    });
    const offPopup = onPopup(({ url }) => {
      if (settings.blockPopups) {
        setStatus(`Popup blocked: ${url}`);
        return;
      }
      openTab(url);
    });
    const offGone = onGuestGone((payload) => {
      setStatus(`Tab crashed (${payload.reason}) — reloading.`);
      const hit = tabsRef.current.find((tab) => tab.url === payload.url);
      const id = hit?.id ?? activeRef.current;
      if (!id) return;
      setViewNonce((map) => ({ ...map, [id]: (map[id] || 0) + 1 }));
      patch(id, { loading: true });
    });
    return () => {
      offDownload();
      offPopup();
      offGone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.blockPopups]);

  // ---- tab operations ------------------------------------------------------
  const keepLive = useCallback((id: string) => {
    setLiveIds((list) => {
      const next = [id, ...list.filter((row) => row !== id)];
      return next.slice(0, LIVE_TAB_CAP);
    });
  }, []);

  const activateTab = useCallback(
    (id: string) => {
      setActiveId(id);
      keepLive(id);
      const tab = tabsRef.current.find((row) => row.id === id);
      if (tab) setAddress(tab.url);
      const el = views.current.get(id);
      const guestId =
        el &&
        typeof (el as WebviewEl & { getWebContentsId?: () => number }).getWebContentsId ===
          "function"
          ? (el as WebviewEl & { getWebContentsId: () => number }).getWebContentsId()
          : 0;
      if (guestId) void setActiveGuest(guestId);
    },
    [keepLive],
  );

  const openTab = useCallback(
    (url?: string) => {
      const id = newId();
      const target = url ? toUrl(url, settings.searchEngine) : settings.homepage;
      setTabs((list) => [
        ...list,
        {
          id,
          url: target,
          title: "New tab",
          loading: true,
          canGoBack: false,
          canGoForward: false,
          zoom: settings.defaultZoom || 1,
        },
      ]);
      setActiveId(id);
      keepLive(id);
      setAddress(target);
      return id;
    },
    [keepLive, settings.homepage, settings.searchEngine, settings.defaultZoom],
  );

  const closeTab = useCallback(
    (id: string) => {
      views.current.delete(id);
      setTabs((list) => {
        let next = list.filter((t) => t.id !== id);
        if (!next.length) {
          next = [
            {
              id: newId(),
              url: settings.homepage,
              title: "New tab",
              loading: true,
              canGoBack: false,
              canGoForward: false,
              zoom: settings.defaultZoom || 1,
            },
          ];
        }
        const nextActive =
          activeRef.current === id ? (next[next.length - 1]?.id ?? null) : activeRef.current;
        setActiveId(nextActive);
        setLiveIds((live) => {
          const without = live.filter((row) => row !== id);
          if (!nextActive) return without.slice(0, LIVE_TAB_CAP);
          return [nextActive, ...without.filter((row) => row !== nextActive)].slice(
            0,
            LIVE_TAB_CAP,
          );
        });
        const tab = next.find((row) => row.id === nextActive);
        if (tab) setAddress(tab.url);
        return next;
      });
    },
    [settings.homepage, settings.defaultZoom],
  );

  const navigate = useCallback(
    (value: string, id = activeRef.current) => {
      const target = toUrl(value, settings.searchEngine);
      const tabId = id ?? openTab(target);
      keepLive(tabId);
      const el = view(tabId);
      if (el) {
        if (typeof el.loadURL === "function") {
          void el.loadURL(target).catch(() => undefined);
        } else {
          el.src = target;
        }
      }
      patch(tabId, { url: target, loading: true });
      setAddress(target);
      return tabId;
    },
    [keepLive, openTab, patch, settings.searchEngine],
  );

  // ---- webview wiring ------------------------------------------------------
  const attach = useCallback(
    (id: string, el: WebviewEl | null) => {
      if (!el || views.current.get(id) === el) return;
      views.current.set(id, el);
      if (activeRef.current === id) {
        const guestId =
          typeof (el as WebviewEl & { getWebContentsId?: () => number }).getWebContentsId ===
          "function"
            ? (el as WebviewEl & { getWebContentsId: () => number }).getWebContentsId()
            : 0;
        if (guestId) void setActiveGuest(guestId);
      }
      const sync = () => {
        patch(id, {
          url: el.getURL(),
          title: el.getTitle() || el.getURL(),
          canGoBack: el.canGoBack(),
          canGoForward: el.canGoForward(),
        });
        if (activeRef.current === id) setAddress(el.getURL());
      };
      el.addEventListener("did-start-loading", () => patch(id, { loading: true }));
      el.addEventListener("did-stop-loading", () => {
        patch(id, { loading: false });
        sync();
        if (activeRef.current === id) {
          const guestId =
            typeof (el as WebviewEl & { getWebContentsId?: () => number }).getWebContentsId ===
            "function"
              ? (el as WebviewEl & { getWebContentsId: () => number }).getWebContentsId()
              : 0;
          if (guestId) void setActiveGuest(guestId);
        }
      });
      el.addEventListener("did-navigate", () => {
        sync();
        void recordVisit(el.getURL(), el.getTitle());
        void loadVisits(150).then(setVisits);
      });
      el.addEventListener("did-navigate-in-page", sync);
      el.addEventListener("page-title-updated", sync);
      el.addEventListener("did-fail-load", (event) => {
        const detail = event as unknown as {
          errorCode: number;
          errorDescription: string;
          validatedURL: string;
        };
        if (detail.errorCode === -3) return;
        setStatus(`${detail.errorDescription} (${detail.errorCode}) — ${detail.validatedURL}`);
        patch(id, { loading: false });
      });
      el.addEventListener("found-in-page", (event) => {
        const detail = (event as unknown as { result?: { matches: number } }).result;
        setFindMatches(detail?.matches ?? 0);
      });
      el.addEventListener("enter-html-full-screen", () =>
        setStatus("Page is fullscreen — press Esc to exit"),
      );
      el.addEventListener("leave-html-full-screen", () => setStatus(""));
    },
    [patch],
  );

  // ---- FRIDAY command host -------------------------------------------------
  useEffect(() => {
    return registerCommandHost(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      const snapshot = () => ({
        tabs: tabsRef.current,
        activeId: activeRef.current,
      });
      const current = () => view(activeRef.current);
      switch (command.action) {
        case "state":
          return { ok: true, ...snapshot() };
        case "newTab": {
          const id = openTab(command.url);
          return { ok: true, url: command.url ?? settings.homepage, activeId: id };
        }
        case "closeTab":
          if (command.tabId) closeTab(command.tabId);
          return { ok: true, ...snapshot() };
        case "activate":
          if (command.tabId) activateTab(command.tabId);
          return { ok: true, activeId: command.tabId ?? activeRef.current };
        case "navigate": {
          const id = navigate(command.url ?? "", command.tabId ?? activeRef.current);
          const ready = await waitForView(views.current, id);
          if (ready) await waitStopped(ready);
          const el = view(id);
          const currentUrl = el
            ? typeof el.getURL === "function"
              ? el.getURL()
              : el.src
            : (command.url ?? "");
          const currentTitle = el
            ? typeof el.getTitle === "function"
              ? el.getTitle()
              : currentUrl
            : currentUrl;
          return { ok: true, url: currentUrl, title: currentTitle };
        }
        case "search": {
          const query = String(command.text || command.url || "").trim();
          if (!query) return { ok: false, error: "A search query is required." };
          const id = navigate(query, command.tabId ?? activeRef.current);
          const ready = await waitForView(views.current, id);
          if (ready) await waitStopped(ready);
          const el = view(id);
          let results: { title: string; url: string; snippet: string }[];
          try {
            results = ((await el?.executeJavaScript?.(EXTRACT_SEARCH_JS, false)) || []) as {
              title: string;
              url: string;
              snippet: string;
            }[];
          } catch {
            results = [];
          }
          const currentUrl = el ? (typeof el.getURL === "function" ? el.getURL() : el.src) : "";
          const currentTitle = el
            ? typeof el.getTitle === "function"
              ? el.getTitle()
              : currentUrl
            : currentUrl;
          return {
            ok: true,
            url: currentUrl,
            title: currentTitle,
            results,
          };
        }
        case "back":
          current()?.goBack?.();
          return { ok: true };
        case "forward":
          current()?.goForward?.();
          return { ok: true };
        case "reload":
          current()?.reload?.();
          return { ok: true };
        case "stop":
          current()?.stop?.();
          return { ok: true };
        case "read": {
          const el = current();
          if (!el) return { ok: false, error: "No open tab." };
          let text: string;
          try {
            text = (await el.executeJavaScript?.(
              "document.body ? document.body.innerText.slice(0, 20000) : ''",
              false,
            )) as string;
          } catch (err: unknown) {
            return {
              ok: false,
              error: `Failed to read tab: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          const currentUrl = typeof el.getURL === "function" ? el.getURL() : el.src;
          const currentTitle = typeof el.getTitle === "function" ? el.getTitle() : currentUrl;
          return { ok: true, url: currentUrl, title: currentTitle, text: text || "" };
        }
        case "click": {
          const el = current();
          if (!el || !command.selector) return { ok: false, error: "A selector is required." };
          try {
            const done = await el.executeJavaScript?.(
              `(() => { const n = document.querySelector(${JSON.stringify(command.selector)}); if (!n) return false; n.click(); return true; })()`,
              true,
            );
            return done ? { ok: true } : { ok: false, error: "Element not found." };
          } catch (err: unknown) {
            return {
              ok: false,
              error: `Click failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "type": {
          const el = current();
          if (!el || !command.selector) return { ok: false, error: "A selector is required." };
          try {
            const done = await el.executeJavaScript?.(
              `(() => { const n = document.querySelector(${JSON.stringify(command.selector)}); if (!n) return false; n.focus(); n.value = ${JSON.stringify(command.text ?? "")}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
              true,
            );
            return done ? { ok: true } : { ok: false, error: "Element not found." };
          } catch (err: unknown) {
            return {
              ok: false,
              error: `Type failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "scroll": {
          const el = current();
          if (!el) return { ok: false, error: "No open tab." };
          try {
            await el.executeJavaScript?.(
              `window.scrollBy(0, ${Number(command.value) || 600})`,
              true,
            );
            return { ok: true };
          } catch (err: unknown) {
            return {
              ok: false,
              error: `Scroll failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        case "zoom": {
          const el = current();
          const factor = Math.min(3, Math.max(0.25, Number(command.value) || 1));
          el?.setZoomFactor?.(factor);
          if (activeRef.current) patch(activeRef.current, { zoom: factor });
          return { ok: true };
        }
        case "find": {
          const el = current();
          if (!el || !command.text) return { ok: false, error: "Text is required." };
          el?.findInPage?.(command.text);
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unsupported browser action: ${command.action}` };
      }
    });
  }, [activateTab, closeTab, navigate, openTab, patch, settings.homepage]);

  useEffect(() => {
    registerBrowserAsk((prompt) => {
      const result = brain.send(prompt, { extra: formatBrowserExtra() });
      if (!result.accepted) setStatus(result.message || "FRIDAY is busy.");
    });
    return () => registerBrowserAsk(null);
  }, []);

  const askFriday = () => {
    const text = ask.trim();
    if (!text || brainState.activeRunId) return;
    setAsk("");
    brain.send(text, { extra: formatBrowserExtra() });
  };

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "t") {
        event.preventDefault();
        openTab();
      } else if (key === "w") {
        event.preventDefault();
        if (activeRef.current) closeTab(activeRef.current);
      } else if (key === "r") {
        event.preventDefault();
        view(activeRef.current)?.reload();
      } else if (key === "f") {
        event.preventDefault();
        setFindOpen(true);
      } else if (key === "l") {
        event.preventDefault();
        document.getElementById("friday-browser-address")?.focus();
      } else if (key === "d") {
        event.preventDefault();
        void toggleBookmark();
      } else if (key === "=" || key === "+") {
        event.preventDefault();
        zoomBy(0.1);
      } else if (key === "-") {
        event.preventDefault();
        zoomBy(-0.1);
      } else if (key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab, closeTab, bookmarks, tabs, activeId]);

  const setZoom = (factor: number) => {
    const clamped = Math.min(3, Math.max(0.25, factor));
    view(activeId)?.setZoomFactor(clamped);
    if (activeId) patch(activeId, { zoom: clamped });
  };
  const zoomBy = (delta: number) => setZoom((active?.zoom ?? 1) + delta);

  const bookmarked = Boolean(active && bookmarks.some((b) => b.url === active.url));

  const toggleBookmark = async () => {
    if (!active) return;
    const next = bookmarked
      ? await removeBookmark(active.url)
      : await addBookmark(active.url, active.title);
    setBookmarks(next);
  };

  const runFind = (text: string) => {
    setFindText(text);
    const el = view(activeId);
    if (!el) return;
    if (!text) {
      el.stopFindInPage("clearSelection");
      setFindMatches(null);
      return;
    }
    el.findInPage(text);
  };

  const goFullscreen = () => {
    const node = stageRef.current;
    if (!node) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void node.requestFullscreen();
  };

  const updateSettings = async (change: Partial<BrowserSettings>) => {
    const next = await saveSettings(change);
    setSettings(next);
  };

  return (
    <AppShell
      title="FRIDAY Browser"
      subtitle="One Chromium session — used by you and by FRIDAY"
      fill
      actions={
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">
            {desktop ? "live session" : "desktop only"}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {cookies} cookies
          </Badge>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        {/* Tab strip */}
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-primary/15 pb-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "group flex max-w-[220px] shrink-0 items-center gap-2 rounded-sm border px-2.5 py-1.5 text-xs",
                tab.id === activeId
                  ? "border-primary/50 bg-primary/12 text-primary"
                  : "border-transparent bg-surface text-muted-foreground hover:border-primary/25",
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-2"
                onClick={() => {
                  activateTab(tab.id);
                }}
              >
                <Globe className={cn("size-3.5 shrink-0", tab.loading && "animate-pulse")} />
                <span className="truncate">{tab.title || "New tab"}</span>
              </button>
              <button type="button" aria-label="Close tab" onClick={() => closeTab(tab.id)}>
                <X className="size-3 opacity-60 hover:opacity-100" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => openTab()} aria-label="New tab">
            <Plus className="size-4" />
          </Button>
        </div>

        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Back"
            onClick={() => view(activeId)?.goBack()}
            disabled={!active?.canGoBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Forward"
            onClick={() => view(activeId)?.goForward()}
            disabled={!active?.canGoForward}
          >
            <ArrowRight className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Reload"
            onClick={() => view(activeId)?.reload()}
          >
            <RotateCw className={cn("size-4", active?.loading && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Stop"
            onClick={() => view(activeId)?.stop()}
            disabled={!active?.loading}
          >
            <Square className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Home"
            onClick={() => navigate(settings.homepage)}
          >
            <Home className="size-4" />
          </Button>
          <form
            className="flex min-w-[240px] flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(address);
            }}
          >
            <Input
              id="friday-browser-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              spellCheck={false}
              placeholder="Search or enter address"
              className="h-8 font-mono text-xs"
            />
            <Button size="sm" type="submit" variant="outline" aria-label="Go">
              <Search className="size-4" />
            </Button>
          </form>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Bookmark"
            onClick={() => void toggleBookmark()}
          >
            {bookmarked ? (
              <BookmarkCheck className="size-4 text-primary" />
            ) : (
              <Bookmark className="size-4" />
            )}
          </Button>
          <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(-0.1)}>
            <ZoomOut className="size-4" />
          </Button>
          <span className="font-mono text-[10px] text-muted-foreground">
            {Math.round((active?.zoom ?? 1) * 100)}%
          </span>
          <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(0.1)}>
            <ZoomIn className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Find in page"
            onClick={() => setFindOpen((v) => !v)}
          >
            <Search className="size-4" />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Fullscreen" onClick={goFullscreen}>
            <Maximize2 className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Developer tools"
            onClick={() => {
              const el = view(activeId);
              if (!el) return;
              if (el.isDevToolsOpened()) el.closeDevTools();
              else el.openDevTools();
            }}
          >
            <Bug className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={panel === "bookmarks" ? "default" : "ghost"}
            onClick={() => setPanel(panel === "bookmarks" ? "none" : "bookmarks")}
          >
            <Bookmark className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={panel === "history" ? "default" : "ghost"}
            onClick={() => setPanel(panel === "history" ? "none" : "history")}
          >
            <History className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={panel === "downloads" ? "default" : "ghost"}
            onClick={() => setPanel(panel === "downloads" ? "none" : "downloads")}
          >
            <Download className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={panel === "ask" ? "default" : "ghost"}
            onClick={() => setPanel(panel === "ask" ? "none" : "ask")}
          >
            <MessageSquare className="size-4" />
          </Button>
          <Button
            size="sm"
            variant={panel === "settings" ? "default" : "ghost"}
            onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>

        {findOpen ? (
          <div className="flex shrink-0 items-center gap-2 rounded-sm border border-primary/20 bg-surface px-2 py-1.5">
            <Input
              autoFocus
              value={findText}
              placeholder="Find in page"
              onChange={(event) => runFind(event.target.value)}
              className="h-7 max-w-xs font-mono text-xs"
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {findMatches === null ? "" : `${findMatches} matches`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => view(activeId)?.findInPage(findText, { forward: false })}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => view(activeId)?.findInPage(findText, { forward: true })}
            >
              Next
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                view(activeId)?.stopFindInPage("clearSelection");
                setFindOpen(false);
                setFindMatches(null);
              }}
            >
              Close
            </Button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 gap-2">
          {/* Page stage */}
          <div
            ref={stageRef}
            className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-primary/20 bg-black/40"
          >
            {!desktop ? (
              <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
                FRIDAY Browser runs inside the FRIDAY Windows app — open the installed FRIDAY to
                browse. Bookmarks, history and settings shown here stay in sync with the desktop
                session.
              </div>
            ) : (
              tabs
                .filter((tab) => liveIds.includes(tab.id))
                .map((tab) =>
                  createElement("webview", {
                    key: `${tab.id}-${viewNonce[tab.id] || 0}`,
                    ref: (node: unknown) => attach(tab.id, node as WebviewEl | null),
                    src: tab.url,
                    partition: "persist:friday-browser",
                    ...(settings.blockPopups ? {} : { allowpopups: "true" }),
                    webpreferences:
                      "contextIsolation=yes,sandbox=yes,javascript=yes,backgroundThrottling=no",
                    className: "absolute inset-0",
                    // Electron <webview> blanks out permanently when it is ever
                    // display:none, and collapses to 0px inside a flex parent
                    // unless the box is stated explicitly. Keep live guests laid
                    // out at full size and switch with visibility only. Inactive
                    // tabs beyond LIVE_TAB_CAP are not mounted, so they cannot
                    // freeze Chromium.
                    style: {
                      display: "inline-flex",
                      width: "100%",
                      height: "100%",
                      visibility: tab.id === activeId ? "visible" : "hidden",
                      zIndex: tab.id === activeId ? 1 : 0,
                      pointerEvents: tab.id === activeId ? "auto" : "none",
                    } as CSSProperties,
                  }),
                )
            )}
          </div>

          {/* Side panels */}
          {panel !== "none" ? (
            <div className="min-h-0 w-[320px] shrink-0 overflow-y-auto">
              {panel === "bookmarks" ? (
                <Panel title="Bookmarks">
                  <div className="space-y-1">
                    {bookmarks.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No bookmarks yet.</p>
                    ) : null}
                    {bookmarks.map((item) => (
                      <div key={item.url} className="flex items-center gap-2">
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-xs hover:text-primary"
                          onClick={() => navigate(item.url)}
                        >
                          {item.title}
                        </button>
                        <button
                          type="button"
                          aria-label="Remove bookmark"
                          onClick={() => void removeBookmark(item.url).then(setBookmarks)}
                        >
                          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                        </button>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {panel === "history" ? (
                <Panel
                  title="History"
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void clearVisits().then(setVisits)}
                    >
                      Clear
                    </Button>
                  }
                >
                  <div className="space-y-1">
                    {visits.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No visits recorded.</p>
                    ) : null}
                    {visits.map((item) => (
                      <button
                        key={`${item.url}-${item.at}`}
                        type="button"
                        className="block w-full truncate text-left text-xs hover:text-primary"
                        onClick={() => navigate(item.url)}
                        title={item.url}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {panel === "downloads" ? (
                <Panel
                  title="Downloads"
                  actions={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void clearDownloads().then(setDownloads)}
                    >
                      Clear
                    </Button>
                  }
                >
                  <div className="space-y-2">
                    {downloads.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Nothing downloaded yet.</p>
                    ) : null}
                    {downloads.map((item) => (
                      <div key={item.id} className="rounded-sm border border-primary/15 p-2">
                        <p className="truncate font-mono text-[11px] text-primary">{item.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">
                          {item.state} · {Math.round(item.received / 1024)} KB
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void revealDownload(item.file)}
                        >
                          Show in folder
                        </Button>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : null}

              {panel === "ask" ? (
                <Panel
                  title="Ask FRIDAY"
                  hint={brainState.activeRunId ? "thinking" : "same brain as Chat / Auto Mode"}
                >
                  <p className="mb-2 text-xs text-muted-foreground">
                    FRIDAY sees this tab (URL, title, cookies on the shared session). Ask her to
                    search, read, scroll, or summarise. Login and purchase still wait for you.
                  </p>
                  <div className="mb-3 max-h-48 space-y-2 overflow-auto text-sm">
                    {brainState.messages.slice(-8).length ? (
                      brainState.messages.slice(-8).map((line) => (
                        <p key={line.id} className="whitespace-pre-wrap">
                          <span className="mr-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                            {line.role === "user" ? "You" : "FRIDAY"}
                          </span>
                          {line.text}
                        </p>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No chat yet this session. Type below, or ask her what is on this page.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={ask}
                      onChange={(event) => setAsk(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          askFriday();
                        }
                      }}
                      placeholder="What is on this page?"
                      className="h-8 text-sm"
                      disabled={Boolean(brainState.activeRunId)}
                    />
                    <Button
                      size="sm"
                      disabled={!ask.trim() || Boolean(brainState.activeRunId)}
                      onClick={askFriday}
                    >
                      Ask FRIDAY
                    </Button>
                  </div>
                </Panel>
              ) : null}

              {panel === "settings" ? (
                <Panel title="Browser settings">
                  <div className="space-y-3 text-xs">
                    <label className="block space-y-1">
                      <span className="text-muted-foreground">Homepage</span>
                      <Input
                        value={settings.homepage}
                        className="h-7 font-mono text-[11px]"
                        onChange={(event) =>
                          setSettings({ ...settings, homepage: event.target.value })
                        }
                        onBlur={(event) => void updateSettings({ homepage: event.target.value })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-muted-foreground">Search engine</span>
                      <select
                        value={settings.searchEngine}
                        onChange={(event) =>
                          void updateSettings({ searchEngine: event.target.value })
                        }
                        className="h-7 w-full rounded-sm border border-primary/20 bg-surface px-2 font-mono text-[11px]"
                      >
                        {SEARCH_ENGINES.map((engine) => (
                          <option key={engine.id} value={engine.id}>
                            {engine.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-muted-foreground">Network / VPN proxy</span>
                      <select
                        value={settings.proxyMode}
                        onChange={(event) =>
                          void updateSettings({
                            proxyMode: event.target.value as BrowserSettings["proxyMode"],
                          })
                        }
                        className="h-7 w-full rounded-sm border border-primary/20 bg-surface px-2 font-mono text-[11px]"
                      >
                        <option value="direct">This PC (Windows VPN still applies)</option>
                        <option value="system">System proxy</option>
                        <option value="fixed">SOCKS5 / HTTP proxy</option>
                      </select>
                    </label>
                    {settings.proxyMode === "fixed" ? (
                      <label className="block space-y-1">
                        <span className="text-muted-foreground">Proxy rules</span>
                        <Input
                          value={settings.proxyRules}
                          placeholder="socks5://127.0.0.1:1080"
                          className="h-7 font-mono text-[11px]"
                          onChange={(event) =>
                            setSettings({ ...settings, proxyRules: event.target.value })
                          }
                          onBlur={(event) =>
                            void updateSettings({ proxyRules: event.target.value })
                          }
                        />
                      </label>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      FRIDAY does not ship a VPN tunnel. Use this PC&apos;s VPN, or point the proxy
                      at yours. This is real Chromium — sites can still show CAPTCHAs. Login and
                      purchase wait for your approval.
                    </p>
                    <ToggleRow
                      label="Block popups"
                      checked={settings.blockPopups}
                      onChange={(v) => void updateSettings({ blockPopups: v })}
                    />
                    <ToggleRow
                      label="Send Do Not Track"
                      checked={settings.doNotTrack}
                      onChange={(v) => void updateSettings({ doNotTrack: v })}
                    />
                    <ToggleRow
                      label="Clear session on exit"
                      checked={settings.clearOnExit}
                      onChange={(v) => void updateSettings({ clearOnExit: v })}
                    />
                    <div className="space-y-1">
                      <p className="text-muted-foreground">Site permissions</p>
                      {Object.entries(settings.permissions).map(([key, value]) => (
                        <div key={key} className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[11px]">{key}</span>
                          <select
                            value={value}
                            onChange={(event) =>
                              void updateSettings({
                                permissions: {
                                  ...settings.permissions,
                                  [key]: event.target.value as "allow" | "ask" | "block",
                                },
                              })
                            }
                            className="h-6 rounded-sm border border-primary/20 bg-surface px-1 font-mono text-[10px]"
                          >
                            <option value="allow">allow</option>
                            <option value="ask">ask</option>
                            <option value="block">block</option>
                          </select>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void clearBrowsingData().then(async () => {
                            setCookies(await cookieCount());
                            setStatus("Browsing data cleared");
                          })
                        }
                      >
                        Clear cookies & cache
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (!active?.url) return;
                          void clearOriginCookies(active.url).then(async (result) => {
                            setCookies(await cookieCount());
                            setStatus(
                              result.ok
                                ? `Signed out of this site (${result.cleared ?? 0} cookies)`
                                : result.error || "Could not sign out",
                            );
                            view(activeId)?.reload();
                          });
                        }}
                      >
                        Sign out this site
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => active && void openExternal(active.url)}
                      >
                        Open in system browser
                      </Button>
                    </div>
                  </div>
                </Panel>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="h-4 shrink-0 truncate font-mono text-[10px] text-muted-foreground">
          {status || active?.url || ""}
        </p>
      </div>
    </AppShell>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
