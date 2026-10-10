/**
 * FRIDAY · web search ladder.
 *
 * A keyed Brave Search API call and a loopback SearXNG instance run before
 * HTML scraping. Wikipedia stays the keyless JSON source inside the browser
 * module. Sensitive text never becomes a query. A captcha page is a failed
 * attempt, not a result.
 *
 * Brave Search API (read 2026-10-10): GET
 * https://api.search.brave.com/res/v1/web/search
 * header X-Subscription-Token. Plans include monthly credits and are not a
 * standalone free tier.
 * SearXNG (docs.searxng.org/dev/search_api, read 2026-10-10):
 * GET /search?q=&format=json on a loopback base the owner configured.
 */
const privacy = require("./privacy-firewall.cjs");

const BRAVE_SEARCH = "https://api.search.brave.com/res/v1/web/search";

function gateQuery(query) {
  const text = String(query || "").trim();
  if (!text) return { ok: false, error: "Empty search query." };
  if (privacy.classify(text).level === "sensitive") {
    return { ok: false, error: "Sensitive text is not sent in a search." };
  }
  return { ok: true, query: text };
}

function looksLikeBotWall(html) {
  const text = String(html || "").slice(0, 12000);
  return /captcha|cf-challenge|unusual traffic|g-recaptcha|verify you are human|attention required/i.test(
    text,
  );
}

function loopbackBase(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function stamp(row, source) {
  return {
    title: String(row.title || row.url || "").slice(0, 200),
    url: String(row.url || ""),
    snippet: String(row.snippet || row.content || "").slice(0, 400),
    provenance: "web",
    instruction: false,
    source,
  };
}

function parseBrave(json, limit) {
  const rows = json && json.web && Array.isArray(json.web.results) ? json.web.results : [];
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const url = String(row.url || "");
    if (!/^https?:\/\//i.test(url)) continue;
    out.push(stamp({ title: row.title, url, snippet: row.description }, "brave-api"));
  }
  return out;
}

function parseSearx(json, limit) {
  const rows = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const url = String(row.url || "");
    if (!/^https?:\/\//i.test(url)) continue;
    out.push(stamp({ title: row.title, url, snippet: row.content }, "searxng"));
  }
  return out;
}

function requestsFor(query, keys, limit) {
  const list = [];
  const brave = String(keys.brave || "").trim();
  if (brave) {
    const url = new URL(BRAVE_SEARCH);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    list.push({
      id: "brave-api",
      url: url.toString(),
      headers: {
        accept: "application/json",
        "x-subscription-token": brave,
      },
    });
  }
  const searx = loopbackBase(keys.searxng);
  if (keys.searxng && !searx) {
    list.push({ id: "searxng", refused: "SearXNG stays on this machine." });
  } else if (searx) {
    const url = new URL("/search", searx);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    list.push({
      id: "searxng",
      url: url.toString(),
      headers: { accept: "application/json" },
    });
  }
  return list;
}

async function runKeyed(query, { keys = {}, fetchImpl, limit = 8 } = {}) {
  const gate = gateQuery(query);
  if (!gate.ok) return { ok: false, results: [], error: gate.error, attempted: [] };
  if (typeof fetchImpl !== "function") {
    return { ok: false, results: [], error: "No search fetch is configured.", attempted: [] };
  }
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const attempted = [];
  for (const attempt of requestsFor(gate.query, keys, n)) {
    attempted.push(attempt.id);
    if (attempt.refused) {
      return { ok: false, results: [], error: attempt.refused, attempted };
    }
    let response;
    try {
      response = await fetchImpl(attempt.url, { headers: attempt.headers || {} });
    } catch (error) {
      continue;
    }
    if (!response || response.ok === false) continue;
    let json;
    try {
      json = typeof response.json === "function" ? await response.json() : {};
    } catch {
      continue;
    }
    const results = attempt.id === "brave-api" ? parseBrave(json, n) : parseSearx(json, n);
    if (results.length) return { ok: true, results, source: attempt.id, attempted };
  }
  return { ok: false, results: [], error: "", attempted };
}

module.exports = {
  BRAVE_SEARCH,
  gateQuery,
  looksLikeBotWall,
  loopbackBase,
  parseBrave,
  parseSearx,
  requestsFor,
  runKeyed,
};
