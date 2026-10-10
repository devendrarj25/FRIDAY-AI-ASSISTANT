// FRIDAY · her own browser.
//
// Search, read and download from the web without leaving FRIDAY. Everything
// runs in the main process (no renderer CORS limits) and returns plain data
// the UI or a skill can use directly. Nothing here is simulated: when the
// network is unavailable the call fails honestly.
const fs = require("fs");
const path = require("path");
const paths = require("./friday-paths.cjs");
// One browser: FRIDAY's programmatic requests use the very same persistent
// Chromium session as the visible FRIDAY Browser tabs (cookies, logins, cache).
const live = require("./browser-live.cjs");
const ladder = require("./search-ladder.cjs");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

function sessionUserAgent() {
  try {
    const ses = live.browserSession();
    const ua = typeof ses?.getUserAgent === "function" ? String(ses.getUserAgent() || "") : "";
    if (ua) return ua.replace(/\sElectron\/[^\s]+/i, "").trim() || UA;
  } catch {
    /* not in Electron */
  }
  return UA;
}

function waitForLoad(contents, ms = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        contents.removeListener("did-stop-loading", finish);
        contents.removeListener("did-fail-load", onFail);
      } catch {
        /* guest gone */
      }
      resolve();
    };
    const onFail = (_event, code) => {
      if (code === -3) return;
      finish();
    };
    if (!contents || typeof contents.once !== "function") {
      resolve();
      return;
    }
    contents.once("did-stop-loading", finish);
    contents.on("did-fail-load", onFail);
    setTimeout(finish, ms);
  });
}

const history = [];
const MAX_HISTORY = 200;

function speakableError(error, fallback, seen) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (!error || typeof error !== "object") {
    const text = error == null ? "" : String(error);
    if (text && text !== "[object Object]") return text;
    return fallback || "network";
  }
  const trail = seen || new Set();
  if (trail.has(error)) return fallback || "network";
  trail.add(error);
  const message = error.message || error.error || error.detail;
  const head =
    typeof message === "string" && message.trim() && message !== "[object Object]"
      ? message.trim()
      : "";
  let out = head;
  if (!out) {
    const text = String(error);
    out = text && text !== "[object Object]" ? text : "";
  }
  if (error.cause && error.cause !== error) {
    const nested = speakableError(error.cause, "", trail);
    if (nested && nested !== out) out = out ? `${out}: ${nested}` : nested;
  }
  return out || fallback || "network";
}

function note(entry) {
  history.unshift({ ...entry, at: Date.now() });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  return entry;
}

function decode(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x?([0-9a-fA-F]+);/g, (_m, code) =>
      String.fromCodePoint(parseInt(code, /^x/i.test(_m.slice(2, 3)) ? 16 : 10) || 32),
    );
}

function stripTags(html) {
  return decode(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function request(url, { timeoutMs = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await live.sessionFetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": sessionUserAgent(),
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        ...headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoHtml(html, limit = 8) {
  const results = [];
  const re =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|<\/body>)/gi;
  let match;
  while ((match = re.exec(html)) && results.length < limit) {
    let href = decode(match[1]);
    const direct = /[?&]uddg=([^&]+)/.exec(href);
    if (direct) href = decodeURIComponent(direct[1]);
    if (!/^https?:/i.test(href)) continue;
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
      match[3] || "",
    );
    results.push({
      title: stripTags(match[2]).slice(0, 200),
      url: href,
      snippet: snippetMatch ? stripTags(snippetMatch[1]).slice(0, 400) : "",
    });
  }
  return results;
}

function parseBraveHtml(html, limit = 8) {
  return parseGenericResults(html, limit, ["search.brave.com", "cdn.search.brave.com"]);
}

function parseGenericResults(html, limit = 8, skipHosts = []) {
  const results = [];
  const seen = new Set();
  const skip = new Set([
    "duckduckgo.com",
    "html.duckduckgo.com",
    "google.com",
    "www.google.com",
    "bing.com",
    "www.bing.com",
    "search.brave.com",
    "startpage.com",
    "www.startpage.com",
    "ecosia.org",
    "www.ecosia.org",
    "search.yahoo.com",
    ...skipHosts,
  ]);
  const re = /<a[^>]+href="(https?:[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && results.length < limit) {
    let href = decode(match[1]).replace(/&amp;/g, "&");
    let host = "";
    try {
      host = new URL(href).hostname.toLowerCase();
    } catch {
      continue;
    }
    if ([...skip].some((name) => host === name || host.endsWith(`.${name}`))) continue;
    if (/\/url\?/.test(href) && /google\./.test(host)) continue;
    const title = stripTags(match[2]).slice(0, 200);
    if (title.length < 6) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ title, url: href, snippet: "" });
  }
  return results;
}

function citeToUrl(cite) {
  const cleaned = stripTags(cite)
    .replace(/\s*[›»].*$/, "")
    .trim();
  if (!cleaned) return "";
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^[\w.-]+\.[a-z]{2,}([/:].*)?$/i.test(cleaned)) return `https://${cleaned}`;
  return "";
}

function parseBingHtml(html, limit = 8) {
  const results = [];
  const blocks = String(html)
    .split(/class="b_algo"/)
    .slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const titleMatch = /<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const citeMatch = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
    const capMatch =
      /class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) ||
      /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const url = citeToUrl(citeMatch ? citeMatch[1] : "");
    if (!url) continue;
    const title = titleMatch ? stripTags(titleMatch[1]).slice(0, 200) : url;
    results.push({
      title: title || url,
      url,
      snippet: capMatch ? stripTags(capMatch[1]).slice(0, 400) : "",
    });
  }
  return results;
}

function parseWikipediaOpenSearch(json, limit = 8) {
  if (!Array.isArray(json) || json.length < 4) return [];
  const titles = json[1] || [];
  const snippets = json[2] || [];
  const urls = json[3] || [];
  const results = [];
  for (let i = 0; i < titles.length && results.length < limit; i++) {
    const url = String(urls[i] || "");
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: String(titles[i] || url).slice(0, 200),
      url,
      snippet: String(snippets[i] || "").slice(0, 400),
    });
  }
  return results;
}

function formatSearchError(detail, source) {
  const text = String(detail || "network");
  const labelled = source ? `${source}: ${text}` : text;
  return /search failed|network|fetch|ENOTFOUND|offline|abort/i.test(labelled)
    ? labelled
    : `search failed: ${labelled}`;
}

async function searchFrom(source, query, limit, fetchImpl) {
  try {
    const response = fetchImpl
      ? await fetchImpl(source.url(query, limit), {
          headers: { accept: source.accept },
        })
      : await request(source.url(query, limit), {
          timeoutMs: source.timeoutMs,
          headers: { accept: source.accept },
        });
    if (!response.ok) {
      return { ok: false, results: [], error: `search failed [${source.id} ${response.status}]` };
    }
    if (String(source.accept || "").includes("html")) {
      const html = typeof response.text === "function" ? await response.text() : "";
      if (ladder.looksLikeBotWall(html)) {
        return {
          ok: false,
          results: [],
          error: `search failed [${source.id} bot-wall]`,
          botWall: true,
        };
      }
      const results = await source.parse(
        { text: async () => html, json: async () => JSON.parse(html), ok: true },
        limit,
      );
      if (!results.length) {
        return { ok: false, results: [], error: `search failed [${source.id} empty]` };
      }
      return {
        ok: true,
        results: results.map((row) => ({ ...row, provenance: "web", instruction: false })),
      };
    }
    const results = await source.parse(response, limit);
    if (!results.length) {
      return { ok: false, results: [], error: `search failed [${source.id} empty]` };
    }
    return { ok: true, results };
  } catch (error) {
    return {
      ok: false,
      results: [],
      error: formatSearchError(speakableError(error, "network"), source.id),
    };
  }
}

const SEARCH_SOURCES = [
  {
    id: "duckduckgo",
    timeoutMs: 6000,
    accept: "text/html",
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: async (response, limit) => parseDuckDuckGoHtml(await response.text(), limit),
  },
  {
    id: "bing",
    timeoutMs: 8000,
    accept: "text/html",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    parse: async (response, limit) => parseBingHtml(await response.text(), limit),
  },
  {
    id: "brave",
    timeoutMs: 8000,
    accept: "text/html",
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
    parse: async (response, limit) => parseBraveHtml(await response.text(), limit),
  },
  {
    id: "wikipedia",
    timeoutMs: 5000,
    accept: "application/json",
    url: (q, n) =>
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=${n}&format=json`,
    parse: async (response, limit) => parseWikipediaOpenSearch(await response.json(), limit),
  },
  {
    id: "startpage",
    timeoutMs: 8000,
    accept: "text/html",
    url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`,
    parse: async (response, limit) =>
      parseGenericResults(await response.text(), limit, ["startpage.com", "www.startpage.com"]),
  },
  {
    id: "ecosia",
    timeoutMs: 8000,
    accept: "text/html",
    url: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`,
    parse: async (response, limit) =>
      parseGenericResults(await response.text(), limit, ["ecosia.org", "www.ecosia.org"]),
  },
  {
    id: "yahoo",
    timeoutMs: 8000,
    accept: "text/html",
    url: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`,
    parse: async (response, limit) =>
      parseGenericResults(await response.text(), limit, ["search.yahoo.com", "yahoo.com"]),
  },
];

const CORE_SEARCH_IDS = new Set(["duckduckgo", "bing", "brave", "wikipedia"]);

function orderedSources(preferred) {
  const id = String(preferred || "duckduckgo");
  const core = SEARCH_SOURCES.filter((row) => CORE_SEARCH_IDS.has(row.id));
  const match = SEARCH_SOURCES.find((row) => row.id === id);
  const list = match && !CORE_SEARCH_IDS.has(match.id) ? [match, ...core] : [...core];
  list.sort((a, b) => Number(b.id === id) - Number(a.id === id));
  return list;
}

async function searchViaLive(query, limit) {
  try {
    const state = live.getLive();
    if (!state || !state.mounted) return null;
    const result = await live.command({ action: "search", text: query }, 18000);
    if (result?.fallback) return null;
    if (result?.ok && Array.isArray(result.results) && result.results.length) {
      return result.results
        .filter((row) => row && /^https?:/i.test(row.url || ""))
        .slice(0, limit)
        .map((row) => ({
          title: String(row.title || row.url).slice(0, 200),
          url: String(row.url),
          snippet: String(row.snippet || "").slice(0, 400),
        }));
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Web search. A keyed Brave API call and a loopback SearXNG base run first.
 * Then the live tab, then HTML engines, with Wikipedia JSON in that ladder.
 * A captcha page falls through. Sensitive text is not queried.
 */
async function search(query, { limit = 8, keys = {}, fetchImpl } = {}) {
  const gate = ladder.gateQuery(query);
  if (!gate.ok) return { ok: false, error: gate.error, results: [] };
  const q = gate.query;
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  if (keys && (keys.brave || keys.searxng)) {
    const keyed = await ladder.runKeyed(q, { keys, fetchImpl, limit: n });
    if (keyed.ok && keyed.results.length) {
      return note({
        kind: "search",
        query: q,
        ok: true,
        source: keyed.source,
        results: keyed.results,
      });
    }
    if (keyed.error && /this machine|Sensitive/i.test(keyed.error)) {
      return note({ kind: "search", query: q, ok: false, error: keyed.error, results: [] });
    }
  }
  const liveHits = await searchViaLive(q, n);
  if (liveHits && liveHits.length) {
    return note({
      kind: "search",
      query: q,
      ok: true,
      source: "live-tab",
      results: liveHits,
    });
  }
  const preferred = String((live.getSettings() || {}).searchEngine || "duckduckgo");
  const errors = [];
  for (const source of orderedSources(preferred)) {
    const attempt = await searchFrom(source, q, n, fetchImpl);
    if (attempt.ok && attempt.results.length) {
      return note({
        kind: "search",
        query: q,
        ok: true,
        source: source.id,
        results: attempt.results,
      });
    }
    if (attempt.error) errors.push(attempt.error);
  }
  return note({
    kind: "search",
    query: q,
    ok: false,
    error: errors.join("; ") || "search failed",
    results: [],
  });
}

/** Fetch a page and return readable text plus discovered links. */
async function open(url, { maxChars = 20000, render = false, session } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, url: target, error: "Only http(s) URLs can be opened." };
  }
  try {
    let html = "";
    let status = 200;
    let contentType = "text/html";
    if (render) {
      html = await renderPage(target, session);
    } else {
      const response = await request(target);
      status = response.status;
      contentType = response.headers.get("content-type") || "";
      if (!response.ok) {
        return note({
          kind: "open",
          url: target,
          ok: false,
          status,
          error: `request failed [${status}]`,
        });
      }
      if (/application\/json/i.test(contentType)) {
        const body = await response.text();
        return note({
          kind: "open",
          url: target,
          ok: true,
          status,
          title: target,
          text: body.slice(0, maxChars),
          links: [],
          json: true,
        });
      }
      html = await response.text();
    }
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const links = [];
    const linkRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html)) && links.length < 60) {
      let href = decode(m[1]);
      try {
        href = new URL(href, target).toString();
      } catch {
        continue;
      }
      if (!/^https?:/i.test(href)) continue;
      const label = stripTags(m[2]).slice(0, 120);
      if (label) links.push({ label, url: href });
    }
    const text = stripTags(html).slice(0, maxChars);
    try {
      live.addHistory({
        url: target,
        title: titleMatch ? stripTags(titleMatch[1]).slice(0, 200) : target,
      });
    } catch {
      /* history is best-effort */
    }
    return note({
      kind: "open",
      url: target,
      ok: true,
      status,
      title: titleMatch ? stripTags(titleMatch[1]).slice(0, 200) : target,
      text,
      links,
      json: false,
    });
  } catch (error) {
    return note({
      kind: "open",
      url: target,
      ok: false,
      error: speakableError(error, "network"),
    });
  }
}

/** Render a JS-heavy page in a hidden window and return its final HTML. */
async function renderPage(url, session) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: live.PARTITION,
      ...(session ? { session } : {}),
    },
  });
  try {
    await win.loadURL(url, { userAgent: sessionUserAgent() });
    await waitForLoad(win.webContents, 8000);
    return await win.webContents.executeJavaScript("document.documentElement.outerHTML", true);
  } finally {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Screenshot a page — used when FRIDAY wants to show a page visually. */
async function screenshot(url) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: live.PARTITION,
    },
  });
  try {
    await win.loadURL(String(url), { userAgent: sessionUserAgent() });
    await waitForLoad(win.webContents, 8000);
    const image = await win.webContents.capturePage();
    return note({ kind: "screenshot", url, ok: true, dataUrl: image.toDataURL() });
  } catch (error) {
    return note({ kind: "screenshot", url, ok: false, error: String(error.message || error) });
  } finally {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Download a file into the workspace download folder. */
async function download(url, { root, name } = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target))
    return { ok: false, error: "Only http(s) URLs can be downloaded." };
  if (!root) return { ok: false, error: "No FRIDAY workspace is selected." };
  paths.setRoot(root);
  const dir = paths.ensureDir("downloads");
  const fallback = decodeURIComponent(
    new URL(target).pathname.split("/").filter(Boolean).pop() || "download.bin",
  );
  const file = path.join(dir, String(name || fallback).replace(/[\\/:*?"<>|]/g, "_"));
  try {
    const response = await request(target, { timeoutMs: 10 * 60 * 1000 });
    if (!response.ok)
      return note({
        kind: "download",
        url: target,
        ok: false,
        error: `failed [${response.status}]`,
      });
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(file, buffer);
    return note({ kind: "download", url: target, ok: true, file, bytes: buffer.length });
  } catch (error) {
    return note({
      kind: "download",
      url: target,
      ok: false,
      error: String(error.message || error),
    });
  }
}

function recent(limit = 40) {
  return history.slice(0, limit);
}

/**
 * Build the page-script for click / scroll / fill. Exported so tests can
 * check the script without opening Electron.
 */
function interactScript(action, { selector, text, value } = {}) {
  const act = String(action || "").toLowerCase();
  if (act === "scroll") {
    const dy = Number(value);
    const amount = Number.isFinite(dy) ? dy : 600;
    return `window.scrollBy(0, ${amount}); ({ ok: true, y: window.scrollY })`;
  }
  if (act === "read") {
    return `({ ok: true, title: document.title, text: (document.body && document.body.innerText || "").slice(0, 20000), url: location.href })`;
  }
  if (!selector) return null;
  const sel = JSON.stringify(String(selector));
  if (act === "click") {
    return `(() => { const n = document.querySelector(${sel}); if (!n) return { ok: false, error: "Element not found." }; n.click(); return { ok: true }; })()`;
  }
  if (act === "fill" || act === "type") {
    const valueJson = JSON.stringify(String(text ?? ""));
    return `(() => { const n = document.querySelector(${sel}); if (!n) return { ok: false, error: "Element not found." }; n.focus(); n.value = ${valueJson}; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true }; })()`;
  }
  if (act === "submit") {
    return `(() => { const n = document.querySelector(${sel}); if (!n) return { ok: false, error: "Element not found." }; if (typeof n.submit === "function") n.submit(); else n.click(); return { ok: true }; })()`;
  }
  return null;
}

let interactWin = null;

async function ensureInteractWindow(url, session) {
  const { BrowserWindow } = require("electron");
  if (!interactWin || interactWin.isDestroyed()) {
    interactWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: live.PARTITION,
        ...(session ? { session } : {}),
      },
    });
  }
  if (url) {
    await interactWin.loadURL(String(url), { userAgent: sessionUserAgent() });
    await waitForLoad(interactWin.webContents, 8000);
  }
  return interactWin;
}

/**
 * Click, scroll, fill or read a rendered page in the shared Chromium session.
 * The renderer must gate submit / login / purchase through governance first.
 */
async function interact({ action, url, selector, text, value, session } = {}) {
  const handoff = live.handoffSelector(selector);
  if (handoff) {
    return note({
      kind: "interact",
      action,
      url,
      ok: false,
      handoff,
      error: `handoff:${handoff}`,
    });
  }
  const script = interactScript(action, { selector, text, value });
  if (!script) {
    return note({
      kind: "interact",
      action,
      ok: false,
      error: "Unsupported or incomplete page action.",
    });
  }
  try {
    const win = await ensureInteractWindow(url, session);
    const result = await win.webContents.executeJavaScript(script, true);
    const ok = result && result.ok !== false;
    return note({
      kind: "interact",
      action,
      url: url || (result && result.url) || undefined,
      ok,
      ...(result && typeof result === "object" ? result : { value: result }),
      ...(ok ? {} : { error: (result && result.error) || "page action failed" }),
    });
  } catch (error) {
    return note({
      kind: "interact",
      action,
      url,
      ok: false,
      error: String(error.message || error),
    });
  }
}

module.exports = {
  search,
  open,
  download,
  screenshot,
  recent,
  stripTags,
  speakableError,
  parseDuckDuckGoHtml,
  parseBingHtml,
  parseWikipediaOpenSearch,
  parseBraveHtml,
  parseGenericResults,
  interact,
  interactScript,
};
