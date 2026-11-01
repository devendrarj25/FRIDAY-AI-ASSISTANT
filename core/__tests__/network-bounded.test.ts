import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fetchTimeout } from "../../src/lib/friday/safe-fetch";

const ROOT = join(__dirname, "..", "..");
const require_ = (await import("node:module")).createRequire(import.meta.url);
const { boundedInit } = require_("../../electron/net-fetch.cjs") as {
  boundedInit: (init?: RequestInit, ms?: number) => { init: RequestInit; clear: () => void };
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "__tests__") return [];
    return statSync(full).isDirectory() ? walk(full) : /\.(cjs|ts|tsx)$/.test(name) ? [full] : [];
  });

/** Places where a bare fetch is correct: the helper itself, a server entry that forwards a request it was given. */
const ALLOWED = new Set(["electron/net-fetch.cjs", "src/server.ts"]);

describe("every request has an end", () => {
  it("no fetch( in the app is left without a timeout or a signal", () => {
    const loose: string[] = [];
    for (const file of [...walk(join(ROOT, "electron")), ...walk(join(ROOT, "src"))]) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(?<![\w.])fetch\(/g)) {
        const index = match.index ?? 0;
        const start = text.lastIndexOf("\n", index) + 1;
        if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(start, index + 8))) continue;
        let segment = text.slice(index, index + 700);
        const end = segment.indexOf(");");
        segment = end > 0 ? segment.slice(0, end + 2) : segment;
        if (!/signal|timeout|AbortController|AbortSignal|bounded/i.test(segment)) {
          loose.push(`${rel}:${text.slice(0, index).split("\n").length}`);
        }
      }
    }
    expect(loose).toEqual([]);
  });
});

describe("the bounded request", () => {
  it("main process: aborts with a clear ETIMEDOUT after the limit, and stops its timer once cleared", async () => {
    vi.useFakeTimers();
    const bounded = boundedInit({ method: "GET" }, 5_000);
    const failed = new Promise((_, reject) =>
      bounded.init.signal!.addEventListener("abort", () => reject(bounded.init.signal!.reason)),
    );
    vi.advanceTimersByTime(5_001);
    await expect(failed).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: /timed out after 5s/,
    });
    const cleared = boundedInit({}, 5_000);
    cleared.clear();
    vi.advanceTimersByTime(10_000);
    expect(cleared.init.signal!.aborted).toBe(false);
    vi.useRealTimers();
  });

  it("main process: the caller's own abort still wins", () => {
    const outer = new AbortController();
    const bounded = boundedInit({ signal: outer.signal }, 60_000);
    outer.abort(new Error("owner cancelled"));
    expect(bounded.init.signal!.aborted).toBe(true);
    expect((bounded.init.signal!.reason as Error).message).toBe("owner cancelled");
    bounded.clear();
  });

  it("renderer: a page that never answers ends with a clear timeout error", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    try {
      await expect(fetchTimeout("https://example.invalid/", {}, 30)).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: /timed out after 0s|timed out after/,
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("renderer: a fast answer passes through untouched", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
    try {
      const res = await fetchTimeout("https://example.invalid/", {}, 1000);
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = real;
    }
  });
});
