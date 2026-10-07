// FRIDAY · live browser subsystem (main process).
//
// One Chromium session — partition "persist:friday-browser" — is shared by:
//   * the FRIDAY Browser section (real <webview> tabs the owner drives), and
//   * FRIDAY's own programmatic browsing (electron/browser.cjs).
// Cookies, storage, permissions, downloads, history and bookmarks therefore
// belong to a single browser, exactly as asked. Nothing here is simulated.
const fs = require("fs");
const path = require("path");

const PARTITION = "persist:friday-browser";

let electron = null;
function el() {
  if (!electron) electron = require("electron");
  return electron;
}

let sendToRenderer = () => {};
const paths = require("./friday-paths.cjs");

let workspaceRootFn = () => null;
let ready = false;

/** Where the browser keeps its own state. Workspace first, userData fallback. */
function stateDir() {
  const root = workspaceRootFn();
  if (root) paths.setRoot(root);
  // Canonical: <FRIDAY_ROOT>\browser (an existing config/browser is reused).
  return paths.ensureDir("browser");
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(path.join(stateDir(), file), "utf8");
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(path.join(stateDir(), file), JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_SETTINGS = {
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

function getSettings() {
  const stored = readJson("settings.json", {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    permissions: { ...DEFAULT_SETTINGS.permissions, ...(stored.permissions || {}) },
  };
}

function setSettings(patch) {
  const next = {
    ...getSettings(),
    ...(patch || {}),
    permissions: { ...getSettings().permissions, ...((patch || {}).permissions || {}) },
  };
  writeJson("settings.json", next);
  applySessionPolicy();
  return next;
}

// ---- history / bookmarks ----------------------------------------------------
const MAX_HISTORY = 2000;

function getHistory(limit = 200) {
  return readJson("history.json", []).slice(0, Math.max(1, Number(limit) || 200));
}

function addHistory(entry) {
  if (!entry?.url || !/^https?:/i.test(entry.url)) return null;
  const list = readJson("history.json", []);
  const record = { url: entry.url, title: entry.title || entry.url, at: Date.now() };
  const deduped = list.filter((item) => item.url !== record.url || Date.now() - item.at > 60_000);
  deduped.unshift(record);
  if (deduped.length > MAX_HISTORY) deduped.length = MAX_HISTORY;
  writeJson("history.json", deduped);
  return record;
}

function clearHistory() {
  writeJson("history.json", []);
  return [];
}

function getBookmarks() {
  return readJson("bookmarks.json", []);
}

function addBookmark(entry) {
  if (!entry?.url) return getBookmarks();
  const list = getBookmarks().filter((item) => item.url !== entry.url);
  list.unshift({ url: entry.url, title: entry.title || entry.url, at: Date.now() });
  writeJson("bookmarks.json", list);
  return list;
}

function removeBookmark(url) {
  const list = getBookmarks().filter((item) => item.url !== url);
  writeJson("bookmarks.json", list);
  return list;
}

// ---- tabs (persisted so a restart restores the browsing session) ------------
function getTabs() {
  return readJson("tabs.json", { tabs: [], activeId: null });
}

function setTabs(state) {
  const value = {
    tabs: Array.isArray(state?.tabs) ? state.tabs.slice(0, 40) : [],
    activeId: state?.activeId ?? null,
  };
  writeJson("tabs.json", value);
  liveState = { ...liveState, ...value, at: Date.now() };
  return value;
}

// The renderer pushes the real live state of its <webview> tabs here so FRIDAY
// (and diagnostics) can read exactly what the owner is looking at.
let liveState = { tabs: [], activeId: null, mounted: false, at: 0 };

function publishLive(state) {
  liveState = { ...liveState, ...(state || {}), at: Date.now() };
  if (state?.tabs) setTabs({ tabs: state.tabs, activeId: state.activeId });
  sendToRenderer("browser:live-state", liveState);
  return liveState;
}

function getLive() {
  return liveState;
}

// ---- FRIDAY → live tab command bridge ---------------------------------------
// FRIDAY asks for a real action in a real tab. The Browser section answers.
const pending = new Map();
let commandSeq = 0;

function command(payload, timeoutMs = 30000) {
  if (!liveState.mounted) {
    return Promise.resolve({
      ok: false,
      fallback: true,
      error: "FRIDAY Browser section is not open — using the shared session headless.",
    });
  }
  const id = `cmd-${++commandSeq}-${Date.now()}`;
  const request = { id, ...(payload || {}) };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "The FRIDAY Browser section did not respond in time." });
    }, timeoutMs);
    pending.set(id, (result) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(result);
    });
    sendToRenderer("browser:command", request);
  });
}

function resolveCommand(id, result) {
  const fn = pending.get(String(id));
  if (fn) fn(result || { ok: true });
  return true;
}

// ---- session ----------------------------------------------------------------
function browserSession() {
  return el().session.fromPartition(PARTITION);
}

const PERMISSION_MAP = {
  media: "media",
  audioCapture: "media",
  videoCapture: "media",
  geolocation: "geolocation",
  notifications: "notifications",
  midi: "midi",
  midiSysex: "midi",
  "clipboard-read": "clipboard",
  "clipboard-sanitized-write": "clipboard",
  fullscreen: "fullscreen",
  pointerLock: "pointerLock",
  "display-capture": "display-capture",
  openExternal: "openExternal",
};

function applyProxy(ses, settings) {
  const mode = String(settings.proxyMode || "direct");
  const apply = async () => {
    if (mode === "system") {
      await ses.setProxy({ mode: "system" });
      return;
    }
    if (mode === "fixed" && settings.proxyRules) {
      await ses.setProxy({
        proxyRules: String(settings.proxyRules),
        proxyBypassRules: String(settings.proxyBypass || "<local>"),
      });
      return;
    }
    await ses.setProxy({ mode: "direct" });
  };
  void apply().catch(() => undefined);
}

function applySessionPolicy() {
  const ses = browserSession();
  const settings = getSettings();
  // Real Chromium UA without the Electron token. Not fingerprint spoofing.
  ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/[^\s]+/i, ""));
  applyProxy(ses, settings);
  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    const key = PERMISSION_MAP[permission] || permission;
    const policy = settings.permissions[key] || "ask";
    if (policy === "allow") return callback(true);
    if (policy === "block") return callback(false);
    try {
      const { response } = await el().dialog.showMessageBox({
        type: "question",
        buttons: ["Block", "Allow"],
        defaultId: 0,
        cancelId: 0,
        title: "FRIDAY Browser — permission request",
        message: `${details?.requestingUrl || "A page"} wants: ${permission}`,
        detail: "You can change this later in FRIDAY Browser settings.",
      });
      callback(response === 1);
    } catch {
      callback(false);
    }
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    const key = PERMISSION_MAP[permission] || permission;
    return (settings.permissions[key] || "ask") === "allow";
  });
  if (settings.doNotTrack) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: "1" } });
    });
  } else {
    ses.webRequest.onBeforeSendHeaders(null);
  }
}

function downloadDir() {
  const root = workspaceRootFn();
  if (root) paths.setRoot(root);
  // FRIDAY-owned downloads stay in <FRIDAY_ROOT>\downloads, never the OS
  // Downloads folder — the browser session is FRIDAY's, not the user's.
  return paths.ensureDir("downloads");
}

const downloads = [];

function trackDownloads() {
  const ses = browserSession();
  ses.removeAllListeners("will-download");
  ses.on("will-download", (_event, item) => {
    const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const file = path.join(downloadDir(), item.getFilename());
    item.setSavePath(file);
    const record = {
      id,
      url: item.getURL(),
      file,
      name: item.getFilename(),
      total: item.getTotalBytes(),
      received: 0,
      state: "progressing",
      at: Date.now(),
    };
    downloads.unshift(record);
    if (downloads.length > 200) downloads.length = 200;
    sendToRenderer("browser:download", record);
    item.on("updated", (_e, state) => {
      record.received = item.getReceivedBytes();
      record.state =
        state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing";
      sendToRenderer("browser:download", record);
    });
    item.once("done", (_e, state) => {
      record.state = state;
      record.received = item.getReceivedBytes();
      sendToRenderer("browser:download", record);
    });
  });
}

function listDownloads() {
  return downloads.slice(0, 100);
}

function clearDownloads() {
  downloads.length = 0;
  return [];
}

async function clearData(kinds) {
  const ses = browserSession();
  const storages =
    Array.isArray(kinds) && kinds.length
      ? kinds
      : ["cookies", "localstorage", "caches", "indexdb", "serviceworkers", "websql", "shadercache"];
  await ses.clearStorageData({ storages });
  await ses.clearCache();
  return { ok: true, cleared: storages };
}

async function cookieCount() {
  try {
    const cookies = await browserSession().cookies.get({});
    return cookies.length;
  } catch {
    return 0;
  }
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${domain}${cookie.path || "/"}`;
}

/** Drop cookies for one origin so the owner can sign out of that site. */
async function clearOriginCookies(url) {
  try {
    const target = String(url || "");
    if (!/^https?:/i.test(target)) return { ok: false, error: "Need an http(s) page." };
    const origin = new URL(target);
    const ses = browserSession();
    const host = origin.hostname.toLowerCase();
    const cookies = await ses.cookies.get({});
    let cleared = 0;
    for (const cookie of cookies) {
      const domain = String(cookie.domain || "")
        .replace(/^\./, "")
        .toLowerCase();
      if (domain !== host && !host.endsWith(`.${domain}`) && !domain.endsWith(`.${host}`)) continue;
      await ses.cookies.remove(cookieUrl(cookie), cookie.name);
      cleared += 1;
    }
    return { ok: true, cleared };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

function setActiveGuest(id) {
  try {
    const { webContents } = el();
    const target = Number(id);
    for (const wc of webContents.getAllWebContents()) {
      if (wc.getType && wc.getType() === "webview") {
        wc.setBackgroundThrottling(wc.id !== target);
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/** Name/domain/value dump of the FRIDAY Browser session cookies. Exec-tier. */
async function cookieDump({ url, domain } = {}) {
  try {
    const ses = browserSession();
    const filter = {};
    if (url) filter.url = String(url);
    const cookies = await ses.cookies.get(filter);
    const needle = domain ? String(domain).toLowerCase() : "";
    const rows = cookies
      .filter(
        (cookie) =>
          !needle ||
          String(cookie.domain || "")
            .toLowerCase()
            .includes(needle),
      )
      .map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        expirationDate: cookie.expirationDate || null,
        value: cookie.value,
      }));
    return { ok: true, count: rows.length, cookies: rows };
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || error),
      note: "Cookie values are only available inside the FRIDAY Browser session.",
    };
  }
}

/** Shared fetch: same cookies/session as the visible tabs. */
async function sessionFetch(url, options) {
  try {
    const ses = browserSession();
    if (typeof ses.fetch === "function") return ses.fetch(url, options);
  } catch {
    /* no Electron session — fall through to global fetch */
  }
  return fetch(url, options);
}

function init({ send, workspaceRoot }) {
  sendToRenderer = typeof send === "function" ? send : () => {};
  workspaceRootFn = typeof workspaceRoot === "function" ? workspaceRoot : () => null;
  if (ready) return;
  ready = true;
  applySessionPolicy();
  trackDownloads();
  const restored = getTabs();
  liveState = { ...restored, mounted: false, at: Date.now() };
}

async function shutdown() {
  try {
    if (getSettings().clearOnExit) await clearData();
  } catch {
    /* never block quit */
  }
}

/** A password, payment, or captcha control is the owner's. The page text stays data. */
function handoffSelector(selector) {
  const value = String(selector || "");
  if (/captcha/i.test(value)) return "captcha";
  if (/pay|card|cvv|checkout/i.test(value)) return "payment";
  if (/password|passwd|otp/i.test(value)) return "credential";
  return "";
}

function pageTextIsData(text) {
  const secret = /(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi;
  const clean = String(text || "")
    .replace(secret, "[redacted]")
    .slice(0, 240);
  return { untrusted: true, instruction: false, text: clean };
}

module.exports = {
  PARTITION,
  init,
  shutdown,
  getSettings,
  setSettings,
  getHistory,
  addHistory,
  clearHistory,
  getBookmarks,
  addBookmark,
  removeBookmark,
  getTabs,
  setTabs,
  publishLive,
  getLive,
  command,
  resolveCommand,
  listDownloads,
  clearDownloads,
  clearData,
  cookieCount,
  cookieDump,
  clearOriginCookies,
  setActiveGuest,
  sessionFetch,
  browserSession,
  downloadDir,
  handoffSelector,
  pageTextIsData,
};
