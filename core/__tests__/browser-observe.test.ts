/**
 * FRIDAY Browser live extras: one Chromium session, Chat/Auto attach, no second browser.
 */
import { describe, expect, it } from "vitest";

import { formatBrowserExtra, publishBrowserSession } from "../../src/lib/friday/browser-awareness";
import {
  browserLookRequested,
  shouldAttachBrowserExtra,
  observationFromBrowser,
} from "../../src/lib/friday/brain/browser-observe";
import { SEARCH_ENGINES, toUrl } from "../../src/lib/friday/live-browser";

describe("browser extras", () => {
  it("attaches when the owner looks at the page or a tab is active", () => {
    publishBrowserSession({
      desktop: true,
      mounted: true,
      activeId: "tab-1",
      engine: "google",
      proxyMode: "direct",
      tabs: [{ id: "tab-1", url: "https://example.com/", title: "Example Domain" }],
    });
    expect(browserLookRequested("what is on this page")).toBe(true);
    expect(browserLookRequested("summarise this tab")).toBe(true);
    expect(shouldAttachBrowserExtra("summarise this tab")).toBe(true);
    expect(shouldAttachBrowserExtra("hello")).toBe(true);
    const extra = formatBrowserExtra();
    expect(extra).toMatch(/BROWSER SESSION/);
    expect(extra).toMatch(/example.com/);
    expect(extra).toMatch(/persist:friday-browser/);
    expect(
      observationFromBrowser({
        desktop: true,
        mounted: true,
        activeId: "tab-1",
        engine: "google",
        proxyMode: "direct",
        tabs: [{ id: "tab-1", url: "https://example.com/", title: "Example Domain" }],
      }).summary,
    ).toMatch(/example.com/);
  });

  it("does not attach idle chat when the Browser section is closed", () => {
    publishBrowserSession({
      desktop: true,
      mounted: false,
      activeId: "tab-1",
      tabs: [{ id: "tab-1", url: "https://example.com/", title: "Example Domain" }],
      engine: "duckduckgo",
      proxyMode: "direct",
    });
    expect(shouldAttachBrowserExtra("hello")).toBe(false);
    expect(shouldAttachBrowserExtra("what is on this page")).toBe(true);
  });

  it("does not attach on empty idle chat", () => {
    publishBrowserSession({
      desktop: false,
      mounted: false,
      activeId: null,
      tabs: [],
      engine: "duckduckgo",
      proxyMode: "direct",
    });
    expect(shouldAttachBrowserExtra("")).toBe(false);
    expect(shouldAttachBrowserExtra("hello")).toBe(false);
  });
});

describe("search engines", () => {
  it("covers the shipped engines without inventing a second address bar", () => {
    expect(SEARCH_ENGINES.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        "duckduckgo",
        "google",
        "bing",
        "brave",
        "startpage",
        "ecosia",
        "yahoo",
      ]),
    );
    expect(toUrl("electron webview docs", "google")).toBe(
      "https://www.google.com/search?q=electron%20webview%20docs",
    );
    expect(toUrl("hello world", "wikipedia")).toContain("wikipedia.org");
  });
});
