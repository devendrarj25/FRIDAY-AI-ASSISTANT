import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  BROWSER_PARTITION,
  crashReloadTarget,
  popupDecision,
} from "../../src/lib/friday/browser-engine";
import { DEFAULT_SETTINGS, toUrl } from "../../src/lib/friday/live-browser";

const require = createRequire(import.meta.url);
const browser = require("../../electron/browser.cjs") as {
  interactScript: (action: string, payload: Record<string, unknown>) => string | null;
  speakableError: (error: unknown, fallback?: string) => string;
  parseDuckDuckGoHtml: (
    html: string,
    limit?: number,
  ) => { title: string; url: string; snippet: string }[];
  parseBingHtml: (
    html: string,
    limit?: number,
  ) => { title: string; url: string; snippet: string }[];
  parseWikipediaOpenSearch: (
    json: unknown,
    limit?: number,
  ) => { title: string; url: string; snippet: string }[];
  parseBraveHtml: (
    html: string,
    limit?: number,
  ) => { title: string; url: string; snippet: string }[];
  waitForLoad: (
    contents: {
      once: (event: string, fn: (...args: unknown[]) => void) => void;
      on: (event: string, fn: (...args: unknown[]) => void) => void;
      removeListener: (event: string, fn: (...args: unknown[]) => void) => void;
    } | null,
    ms?: number,
    schedule?: (fn: () => void, ms: number) => void,
  ) => Promise<{ loaded: boolean; timedOut: boolean }>;
  landedUrl: (
    requested: string,
    responseUrl?: string,
  ) => { url: string; finalUrl: string; redirected: boolean };
};
const live = require("../../electron/browser-live.cjs") as {
  PARTITION: string;
  cookieMatchesHost: (domain: string, host: string) => boolean;
};

function fakePage() {
  const once = new Map<string, (...args: unknown[]) => void>();
  const on = new Map<string, (...args: unknown[]) => void>();
  return {
    once(event: string, fn: (...args: unknown[]) => void) {
      once.set(event, fn);
    },
    on(event: string, fn: (...args: unknown[]) => void) {
      on.set(event, fn);
    },
    removeListener(event: string) {
      once.delete(event);
      on.delete(event);
    },
    emit(event: string, ...args: unknown[]) {
      once.get(event)?.(...args);
      on.get(event)?.(...args);
    },
  };
}

describe("FRIDAY Browser address bar", () => {
  it("keeps real URLs untouched", () => {
    expect(toUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(toUrl("about:blank")).toBe("about:blank");
  });

  it("upgrades bare hosts to https", () => {
    expect(toUrl("example.com")).toBe("https://example.com");
    expect(toUrl("docs.python.org/3/library")).toBe("https://docs.python.org/3/library");
  });

  it("searches on the configured engine", () => {
    expect(toUrl("electron webview docs", "google")).toBe(
      "https://www.google.com/search?q=electron%20webview%20docs",
    );
    expect(toUrl("hello world")).toContain("duckduckgo.com/?q=");
    expect(toUrl("trees", "ecosia")).toContain("ecosia.org");
    expect(toUrl("news", "yahoo")).toContain("yahoo.com");
  });

  it("ships safe permission defaults", () => {
    expect(DEFAULT_SETTINGS.permissions["media"]).toBe("ask");
    expect(DEFAULT_SETTINGS.permissions["midi"]).toBe("block");
    expect(DEFAULT_SETTINGS.blockPopups).toBe(true);
    expect(DEFAULT_SETTINGS.proxyMode).toBe("direct");
  });
});

describe("headless page-interact scripts", () => {
  it("builds click/scroll/fill scripts without inventing a DOM", () => {
    expect(browser.interactScript("click", { selector: "#go" })).toMatch(/querySelector/);
    expect(browser.interactScript("scroll", { value: 240 })).toMatch(/scrollBy\(0, 240\)/);
    expect(browser.interactScript("fill", { selector: "#q", text: "hello" })).toMatch(/hello/);
    expect(browser.interactScript("click", {})).toBeNull();
  });
});

describe("programmatic search parsers", () => {
  it("never stringifies a failed fetch as [object Object]", () => {
    const text = browser.speakableError(
      { message: "fetch failed", cause: { message: "Connect Timeout Error" } },
      "network",
    );
    expect(text).toMatch(/fetch failed/);
    expect(text).toMatch(/Connect Timeout/);
    expect(text).not.toBe("[object Object]");
  });

  it("reads DuckDuckGo HTML result__a rows", () => {
    const html = `<body>
      <a class="result__a" href="https://example.com/">Example Domain</a>
      <a class="result__snippet">This domain is for use in documentation.</a>
      </body>`;
    const results = browser.parseDuckDuckGoHtml(html, 3);
    expect(results[0]).toMatchObject({
      title: "Example Domain",
      url: "https://example.com/",
    });
    expect(results[0]?.snippet).toMatch(/documentation/i);
  });

  it("reads Bing b_algo cites instead of tracking ck/a links", () => {
    const html = `<ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc">Example Domain</a></h2>
        <div class="b_caption"><p>This domain is for use in illustrative examples.</p></div>
        <cite>http://www.example.com</cite>
      </li>
    </ol>`;
    const results = browser.parseBingHtml(html, 3);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Example Domain",
      url: "http://www.example.com",
    });
    expect(results[0]?.snippet).toMatch(/illustrative/i);
  });

  it("reads Wikipedia OpenSearch arrays", () => {
    const results = browser.parseWikipediaOpenSearch(
      [
        "example domain",
        ["Example domain"],
        ["Reserved documentation domain"],
        ["https://en.wikipedia.org/wiki/Example_domain"],
      ],
      3,
    );
    expect(results[0]?.snippet).toMatch(/Reserved documentation domain/);
  });

  it("reads Brave-style result anchors without keeping Brave's own search URLs", () => {
    const html = `<body>
      <a href="https://search.brave.com/search?q=x">Brave Search</a>
      <a href="https://example.com/docs">Example documentation page</a>
      </body>`;
    const results = browser.parseBraveHtml(html, 3);
    expect(results.some((row) => row.url.includes("example.com"))).toBe(true);
    expect(results.every((row) => !row.url.includes("search.brave.com"))).toBe(true);
  });
});

describe("browser session decisions", () => {
  it("follows a redirect, times out a hung page, and ignores an aborted load", async () => {
    const landed = browser.landedUrl("https://notes.example/start", "https://notes.example/landed");
    expect(landed.redirected).toBe(true);
    expect(landed.url).toBe("https://notes.example/start");
    expect(landed.finalUrl).toBe("https://notes.example/landed");
    expect(browser.landedUrl("https://notes.example/a", "https://notes.example/a").redirected).toBe(
      false,
    );

    const hung = fakePage();
    const timed = await browser.waitForLoad(hung, 8000, (fn) => fn());
    expect(timed).toEqual({ loaded: false, timedOut: true });

    const page = fakePage();
    const pending = browser.waitForLoad(page, 8000, () => undefined);
    page.emit("did-stop-loading");
    expect(await pending).toEqual({ loaded: true, timedOut: false });

    const aborted = fakePage();
    const still = browser.waitForLoad(aborted, 8000, () => undefined);
    aborted.emit("did-fail-load", {}, -3);
    aborted.emit("did-stop-loading");
    expect(await still).toEqual({ loaded: true, timedOut: false });

    const failed = fakePage();
    const bad = browser.waitForLoad(failed, 8000, () => undefined);
    failed.emit("did-fail-load", {}, -105);
    expect(await bad).toEqual({ loaded: false, timedOut: false });
  });

  it("blocks a popup, reloads the crashed tab, and keeps another site's cookies", () => {
    expect(live.PARTITION).toBe(BROWSER_PARTITION);
    expect(popupDecision("https://ads.example/pop", true)).toEqual({
      openTab: false,
      status: "Popup blocked: https://ads.example/pop",
    });
    expect(popupDecision("https://notes.example/next", false).openTab).toBe(true);
    expect(popupDecision("javascript:alert(1)", false).openTab).toBe(false);
    const tabs = [
      { id: "a", url: "https://notes.example/a" },
      { id: "b", url: "https://other.example/b" },
    ];
    expect(
      crashReloadTarget(tabs, "a", { url: "https://other.example/b", reason: "crashed" }),
    ).toEqual({
      id: "b",
      status: "Tab crashed (crashed) — reloading.",
    });
    expect(crashReloadTarget(tabs, "a", { reason: "unresponsive" }).id).toBe("a");
    expect(live.cookieMatchesHost("notes.example", "www.notes.example")).toBe(true);
    expect(live.cookieMatchesHost("notes.example", "notes.example.evil")).toBe(false);
    expect(live.cookieMatchesHost(".other.example", "notes.example")).toBe(false);
  });
});
