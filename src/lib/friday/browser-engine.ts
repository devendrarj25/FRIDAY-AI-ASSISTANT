/**
 * FRIDAY · her own browser
 *
 * Search, read, download and capture the web. In the packaged desktop app this
 * goes through the main process (no CORS, real downloads). In the browser
 * preview there is no such bridge, so every call reports honestly that the
 * browser is desktop-only — nothing is faked.
 */

import { withDeadline } from "./brain/turn-timing";
import { redactRunText } from "./self/run-receipt";

export type SearchResult = { title: string; url: string; snippet: string };

export type SearchResponse = {
  ok: boolean;
  query: string;
  results: SearchResult[];
  error?: string;
};

export type PageResponse = {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  links?: { label: string; url: string }[];
  status?: number;
  error?: string;
};

export type DownloadResponse = { ok: boolean; file?: string; bytes?: number; error?: string };

export type BrowserHistoryEntry = {
  kind: string;
  url?: string;
  query?: string;
  ok: boolean;
  at: number;
  error?: string;
};

type BrowserBridge = {
  webSearch?: (query: string, limit?: number) => Promise<SearchResponse>;
  webOpen?: (
    url: string,
    options?: { render?: boolean; maxChars?: number },
  ) => Promise<PageResponse>;
  webDownload?: (url: string, name?: string | null) => Promise<DownloadResponse>;
  webScreenshot?: (url: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>;
  webHistory?: (limit?: number) => Promise<BrowserHistoryEntry[]>;
  webInteract?: (payload: {
    action: string;
    url?: string;
    selector?: string;
    text?: string;
    value?: number;
  }) => Promise<{ ok: boolean; error?: string; text?: string; title?: string; url?: string }>;
};

const bridge = (): BrowserBridge | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.friday as unknown as BrowserBridge | undefined);

const UNAVAILABLE = "FRIDAY's browser runs in the desktop app — open FRIDAY on Windows to use it.";

/** Renderer-side cap so a hung main-process search cannot block the first token. */
export const WEB_SEARCH_DEADLINE_MS = 12_000;

export const browserAvailable = (): boolean => Boolean(bridge()?.webSearch);

export async function webSearch(query: string, limit = 8): Promise<SearchResponse> {
  const api = bridge();
  if (!api?.webSearch) return { ok: false, query, results: [], error: UNAVAILABLE };
  const timedOut: SearchResponse = {
    ok: false,
    query,
    results: [],
    error: `web search timed out after ${WEB_SEARCH_DEADLINE_MS / 1000}s — answering without live results`,
  };
  try {
    const response = await withDeadline(
      api.webSearch(query, limit),
      WEB_SEARCH_DEADLINE_MS,
      timedOut,
      { runId: "browser", stage: "web-search" },
    );
    return {
      ok: Boolean(response?.ok),
      query,
      results: response?.results ?? [],
      ...(response?.error ? { error: response.error } : {}),
    };
  } catch (error) {
    return { ok: false, query, results: [], error: String((error as Error).message || error) };
  }
}

export async function webOpen(
  url: string,
  options: { render?: boolean; maxChars?: number } = {},
): Promise<PageResponse> {
  const api = bridge();
  if (!api?.webOpen) return { ok: false, url, error: UNAVAILABLE };
  try {
    return await api.webOpen(url, options);
  } catch (error) {
    return { ok: false, url, error: String((error as Error).message || error) };
  }
}

export async function webDownload(url: string, name?: string): Promise<DownloadResponse> {
  const api = bridge();
  if (!api?.webDownload) return { ok: false, error: UNAVAILABLE };
  try {
    return await api.webDownload(url, name ?? null);
  } catch (error) {
    return { ok: false, error: String((error as Error).message || error) };
  }
}

export async function webScreenshot(
  url: string,
): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  const api = bridge();
  if (!api?.webScreenshot) return { ok: false, error: UNAVAILABLE };
  try {
    return await api.webScreenshot(url);
  } catch (error) {
    return { ok: false, error: String((error as Error).message || error) };
  }
}

export async function webHistory(limit = 40): Promise<BrowserHistoryEntry[]> {
  const api = bridge();
  if (!api?.webHistory) return [];
  try {
    return (await api.webHistory(limit)) ?? [];
  } catch {
    return [];
  }
}

/**
 * Research helper: search, then read the strongest hits, so FRIDAY can answer
 * from real page content instead of snippets alone.
 */
export async function research(
  query: string,
  depth = 3,
): Promise<{
  ok: boolean;
  query: string;
  results: SearchResult[];
  pages: PageResponse[];
  error?: string;
}> {
  const search = await webSearch(query, Math.max(depth, 5));
  if (!search.ok)
    return { ok: false, query, results: [], pages: [], error: search.error ?? "search failed" };
  const pages: PageResponse[] = [];
  for (const result of search.results.slice(0, depth)) {
    pages.push(await webOpen(result.url, { maxChars: 6000 }));
  }
  return { ok: true, query, results: search.results, pages };
}

/* ---------------------------------------------------------------------------
 * Live tabs — FRIDAY drives the same visible browser the owner uses.
 * When the FRIDAY Browser section is open the command runs in the real tab;
 * otherwise FRIDAY falls back to the headless path above, which shares the
 * very same persistent Chromium session (cookies, logins, cache).
 * ------------------------------------------------------------------------ */
import {
  liveBrowserAvailable,
  sendBrowserCommand,
  type BrowserCommandResult,
} from "@/lib/friday/live-browser";

export const liveBrowsing = (): boolean => liveBrowserAvailable();

/** Open a URL in a real tab; falls back to reading it headlessly. */
export async function liveOpen(url: string): Promise<PageResponse> {
  if (liveBrowserAvailable()) {
    const opened = await sendBrowserCommand({ action: "navigate", url });
    if (opened.ok) {
      const read = await sendBrowserCommand({ action: "read" });
      if (read.ok) {
        return {
          ok: true,
          url: read.url ?? url,
          ...(read.title ? { title: read.title } : {}),
          text: read.text ?? "",
        };
      }
    }
  }
  return webOpen(url, { render: true });
}

/** Read whatever is on screen right now. */
export const liveRead = (): Promise<BrowserCommandResult> => sendBrowserCommand({ action: "read" });

/** Exact browser state (tabs + active tab) so FRIDAY can describe it truthfully. */
export const liveState = (): Promise<BrowserCommandResult> =>
  sendBrowserCommand({ action: "state" });

export const liveClick = (selector: string): Promise<BrowserCommandResult> =>
  sendBrowserCommand({ action: "click", selector });

export const liveType = (selector: string, text: string): Promise<BrowserCommandResult> =>
  sendBrowserCommand({ action: "type", selector, text });

export const liveScroll = (value = 600): Promise<BrowserCommandResult> =>
  sendBrowserCommand({ action: "scroll", value });

export const liveFind = (text: string): Promise<BrowserCommandResult> =>
  sendBrowserCommand({ action: "find", text });

export type PageInteractAction = "click" | "scroll" | "fill" | "read" | "submit";

const CONSEQUENTIAL_PAGE =
  /\b(submit|login|log in|sign in|purchase|buy|checkout|pay|password|card|cvv|otp)\b/i;

export type PageNode = {
  role: string;
  name: string;
  value?: string;
  selector: string;
};

export type PagePerception = {
  url: string;
  title: string;
  source: "dom";
  untrusted: true;
  confidence: number;
  text: string;
  nodes: { role: string; name: string; selector: string }[];
  handoff?: "credential" | "payment" | "captcha";
};

const PAGE_SECRET = /password|passwd|otp|captcha|pay|card|cvv|checkout/i;

/** Accessibility or DOM nodes, before pixels. A secret control returns no content. */
export function perceivePage(raw: {
  url: string;
  title?: string;
  nodes: PageNode[];
}): PagePerception {
  const secret = raw.nodes.find((node) =>
    PAGE_SECRET.test(`${node.role} ${node.name} ${node.selector}`),
  );
  if (secret) {
    const label = `${secret.role} ${secret.name} ${secret.selector}`;
    const handoff = /captcha/i.test(label)
      ? "captcha"
      : /pay|card|cvv|checkout/i.test(label)
        ? "payment"
        : "credential";
    return {
      url: raw.url,
      title: "",
      source: "dom",
      untrusted: true,
      confidence: 0.95,
      text: "",
      nodes: [],
      handoff,
    };
  }
  const nodes = raw.nodes.map((node) => ({
    role: node.role,
    name: redactRunText(node.name),
    selector: node.selector,
  }));
  return {
    url: raw.url,
    title: redactRunText(raw.title || ""),
    source: "dom",
    untrusted: true,
    confidence: nodes.length ? 0.9 : 0.4,
    text: redactRunText(
      nodes
        .map((node) => node.name)
        .filter(Boolean)
        .join("\n"),
    ),
    nodes,
  };
}

export function siteAllowed(url: string, allow: string[]): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  return allow.some((item) => {
    const rule = String(item || "")
      .replace(/^www\./, "")
      .toLowerCase();
    return Boolean(rule) && (host === rule || host.endsWith(`.${rule}`));
  });
}

export function gatePageStep(input: {
  url: string;
  allow: string[];
  action: PageInteractAction;
  target: string;
  perception: PagePerception;
}): { allow: boolean; reason: string } {
  if (input.perception.handoff)
    return { allow: false, reason: `handoff:${input.perception.handoff}` };
  if (!siteAllowed(input.url, input.allow)) return { allow: false, reason: "site" };
  if (pageActionNeedsApproval(input.action, input.target))
    return { allow: false, reason: "approval" };
  return { allow: true, reason: "ok" };
}

/** Submit / login / purchase / password fields always need the existing approval gate. */
export function pageActionNeedsApproval(action: PageInteractAction, extra = ""): boolean {
  if (action === "submit") return true;
  return CONSEQUENTIAL_PAGE.test(`${action} ${extra}`);
}

export type PageInteractResult = {
  ok: boolean;
  action: PageInteractAction;
  error?: string;
  text?: string;
  title?: string;
  url?: string;
  awaitingApproval?: boolean;
};

async function runPageAction(
  action: PageInteractAction,
  options: { url?: string; selector?: string; text?: string; value?: number },
): Promise<PageInteractResult> {
  if (liveBrowserAvailable()) {
    const mapped = action === "fill" ? "type" : action === "submit" ? "click" : action;
    const result = await sendBrowserCommand({
      action: mapped,
      ...(options.url ? { url: options.url } : {}),
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.text ? { text: options.text } : {}),
      ...(options.value !== undefined ? { value: options.value } : {}),
    });
    if (!result.fallback) {
      return {
        ok: Boolean(result.ok),
        action,
        ...(result.error ? { error: result.error } : {}),
        ...(result.text ? { text: result.text } : {}),
        ...(result.title ? { title: result.title } : {}),
        ...(result.url ? { url: result.url } : {}),
      };
    }
  }
  const api = bridge();
  if (!api?.webInteract) {
    return { ok: false, action, error: UNAVAILABLE };
  }
  try {
    const result = await api.webInteract({ action, ...options });
    return {
      ok: Boolean(result?.ok),
      action,
      ...(result?.error ? { error: result.error } : {}),
      ...(result?.text ? { text: result.text } : {}),
      ...(result?.title ? { title: result.title } : {}),
      ...(result?.url ? { url: result.url } : {}),
    };
  } catch (error) {
    return { ok: false, action, error: String((error as Error).message || error) };
  }
}

/**
 * Click, scroll, fill or read a real page. Consequential actions are filed
 * through governance and never run until the owner approves.
 */
export async function webInteract(
  action: PageInteractAction,
  options: { url?: string; selector?: string; text?: string; value?: number } = {},
): Promise<PageInteractResult> {
  const extra = `${options.selector ?? ""} ${options.text ?? ""} ${options.url ?? ""}`;
  if (!pageActionNeedsApproval(action, extra)) {
    return runPageAction(action, options);
  }
  const { governance } = await import("./self/governance");
  const holder: { result: PageInteractResult | null } = { result: null };
  const decision = await governance.submit({
    kind: "research",
    title: `Browser ${action} — ${(options.url || options.selector || "page").slice(0, 60)}`,
    rationale:
      "This page action can submit a form, sign in, or spend money. It waits for your approval.",
    risk: "risky",
    evidence: [`browser:${action}`, options.url ?? "", options.selector ?? ""].filter(Boolean),
    apply: async () => {
      holder.result = await runPageAction(action, options);
      return {
        ok: Boolean(holder.result.ok),
        detail: holder.result.ok ? `${action} ran` : (holder.result.error ?? `${action} failed`),
      };
    },
  });
  if (decision.stage === "rejected" || decision.stage === "waiting-approval") {
    return {
      ok: false,
      action,
      awaitingApproval: decision.stage === "waiting-approval",
      error:
        decision.stage === "rejected"
          ? "You did not approve this page action, so it did not run."
          : "Waiting for your approval before this page action runs.",
    };
  }
  return (
    holder.result ?? {
      ok: false,
      action,
      error: "The page action did not run.",
    }
  );
}

export const webClick = (selector: string, url?: string) =>
  webInteract("click", { selector, ...(url ? { url } : {}) });
export const webScroll = (value = 600, url?: string) =>
  webInteract("scroll", { value, ...(url ? { url } : {}) });
export const webFill = (selector: string, text: string, url?: string) =>
  webInteract("fill", { selector, text, ...(url ? { url } : {}) });
