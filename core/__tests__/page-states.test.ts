/**
 * Shared page states: the pure status and age helpers, the Live badge and
 * error markup (server-rendered, no window), and the unhandled-rejection toast.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ageLabel, liveness, pageStatus } from "../../src/lib/friday/page-state";
import { installRejectionToast, rejectionMessage } from "../../src/lib/friday/rejection-toast";
import { ErrorState, LiveBadge } from "../../src/components/friday/PageStates";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("pageStatus", () => {
  it("shows loading until the first answer, then error, empty or ready", () => {
    expect(pageStatus({ loading: true })).toBe("loading");
    expect(pageStatus({ loading: true, error: "x" })).toBe("error");
    expect(pageStatus({ error: "boom" })).toBe("error");
    expect(pageStatus({ count: 0 })).toBe("empty");
    expect(pageStatus({ count: 3 })).toBe("ready");
  });

  it("keeps what is on screen while it reloads or after a failed refresh", () => {
    expect(pageStatus({ loading: true, count: 2 })).toBe("ready");
    expect(pageStatus({ error: "offline", count: 2 })).toBe("ready");
    expect(pageStatus({ loading: true, hasData: true })).toBe("ready");
  });
});

describe("ageLabel and liveness", () => {
  it("words the age of the last update", () => {
    expect(ageLabel(null, 0)).toBe("not yet");
    expect(ageLabel(1000, 2000)).toBe("just now");
    expect(ageLabel(0, 12_000)).toBe("12 s ago");
    expect(ageLabel(0, 180_000)).toBe("3 min ago");
    expect(ageLabel(0, 7_300_000)).toBe("2 h ago");
  });

  it("is live within two periods, stale after, offline on error or offline", () => {
    const base = { everyMs: 10_000 };
    expect(liveness({ ...base, at: 0, now: 15_000 })).toBe("live");
    expect(liveness({ ...base, at: 0, now: 40_000 })).toBe("stale");
    expect(liveness({ ...base, at: null, now: 1 })).toBe("stale");
    expect(liveness({ ...base, at: 0, now: 1, error: "down" })).toBe("offline");
    expect(liveness({ ...base, at: 0, now: 1, offline: true })).toBe("offline");
  });
});

describe("markup", () => {
  it("ErrorState names the problem, shows the real error and a named Retry", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, {
        title: "Models failed",
        error: new Error("ECONNREFUSED"),
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Models failed");
    expect(html).toContain("ECONNREFUSED");
    expect(html).toContain('aria-label="Retry"');
  });

  it("LiveBadge renders a labelled dot without reading the clock", () => {
    const html = renderToStaticMarkup(createElement(LiveBadge, { at: null, everyMs: 15_000 }));
    expect(html).toContain("data-live-badge");
    expect(html).toContain("live-dot");
    expect(html).toContain("Waiting");
  });

  it("is wired once: shell banner, router error component, rejection toast", () => {
    expect(read("src/components/friday/AppShell.tsx")).toContain("<OfflineBanner />");
    expect(read("src/components/friday/AppShell.tsx")).toContain("installRejectionToast()");
    expect(read("src/router.tsx")).toContain("defaultErrorComponent: RouteError");
  });
});

describe("unhandled rejection toast", () => {
  it("stays quiet for cancelled requests and shows a readable line for real failures", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(rejectionMessage(abort)).toBeNull();
    expect(rejectionMessage(null)).toBeNull();
    expect(rejectionMessage(new Error("Kernel said no"))).toBe("Kernel said no");
    expect(rejectionMessage("plain text")).toBe("plain text");
    expect(rejectionMessage({ message: "from an object" })).toBe("from an object");
    expect(rejectionMessage(new Error("x".repeat(400)))?.length).toBe(198);
  });

  it("shows each message once per window and removes its listener", () => {
    const handlers = new Map<string, (e: Event) => void>();
    const target = {
      addEventListener: (t: string, h: EventListenerOrEventListenerObject) =>
        void handlers.set(t, h as (e: Event) => void),
      removeEventListener: (t: string) => void handlers.delete(t),
    };
    const shown: string[] = [];
    let clock = 0;
    const off = installRejectionToast(
      target,
      (_title, description) => shown.push(description),
      () => clock,
    );
    const fire = (reason: unknown) =>
      handlers.get("unhandledrejection")?.({ reason } as unknown as Event);
    fire(new Error("a"));
    fire(new Error("a"));
    clock = 6000;
    fire(new Error("a"));
    expect(shown).toEqual(["a", "a"]);
    off();
    expect(handlers.size).toBe(0);
  });
});
