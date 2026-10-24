/**
 * Install Manager "latest version": every kind of tool gets an answer from the
 * first source that has one, and a source that is down falls through to the next.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const undici = require_("undici");

const real = undici.fetch;
let routes: Record<string, unknown> = {};
let hits: string[] = [];

const reply = (body: unknown, status = 200, url = "") => ({
  ok: status < 400,
  status,
  url,
  headers: new Headers(),
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

beforeAll(() => {
  undici.fetch = async (url: string) => {
    hits.push(String(url));
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    if (!key) throw new Error("network down");
    const value = routes[key];
    return typeof value === "function" ? (value as () => unknown)() : reply(value);
  };
});
afterAll(() => {
  undici.fetch = real;
});
beforeEach(() => {
  routes = {};
  hits = [];
  vendor.clearFeedCache();
});

const tool = (id: string) => toolchain.TOOLS.find((t: { id: string }) => t.id === id);
// latestFor caches per tool id for 30 minutes; a unique id per test keeps them independent.
const fresh = (base: string, suffix: string) => ({ ...tool(base), id: `${base}#${suffix}` });

describe("latest version sources", () => {
  it("npm falls through to the second official registry", async () => {
    routes = { "https://registry.npmmirror.com/": { version: "11.6.0" } };
    expect(await toolchain.latestFor(fresh("npm", "a"))).toBe("11.6.0");
    expect(hits[0]).toContain("registry.npmjs.org");
    expect(hits.at(-1)).toContain("registry.npmmirror.com");
  });

  it("GitHub keeps the version through the redirect when the API is rate-limited", async () => {
    routes = {
      "https://api.github.com/": () => reply({ message: "rate limit" }, 403),
      "https://github.com/mudler/LocalAI/releases/latest": () =>
        reply({}, 200, "https://github.com/mudler/LocalAI/releases/tag/v3.4.0"),
    };
    expect(await toolchain.latestFor(fresh("LocalAI", "b"))).toBe("3.4.0");
  });

  it("a tool with only a vendor feed (Go) gets its version from the vendor", async () => {
    routes = { "https://go.dev/dl/": [{ version: "go1.25.2", stable: true, files: [] }] };
    expect(await toolchain.latestFor(tool("Go"))).toBe("1.25.2");
  });

  it("a winget-only tool reads the winget upgrade table, and has none when winget says it is current", async () => {
    const ffmpeg = fresh("FFmpeg", "d");
    expect(ffmpeg.winget).toBeTruthy();
    expect(await toolchain.latestFor(ffmpeg, { wingetTable: { [ffmpeg.winget]: "8.0.1" } })).toBe(
      "8.0.1",
    );
    expect(await toolchain.latestFor(fresh("FFmpeg", "e"), { wingetTable: {} })).toBeNull();
  });

  it("every winget tool has some way to learn its newest version", () => {
    const withoutAny = toolchain.TOOLS.filter(
      (t: { id: string; latest?: unknown; winget?: string }) =>
        !t.latest && !t.winget && !vendor.hasFeed(t.id),
    )
      .filter((t: { installerUrl?: string; pip?: string; npm?: string }) => t.pip || t.npm)
      .map((t: { id: string }) => t.id);
    expect(withoutAny).toEqual([]);
  });

  it("the module reads the network through the app's stack, not bare fetch", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    const body = source.slice(
      source.indexOf("async function jsonFrom"),
      source.indexOf("async function latestVersions"),
    );
    expect(body).toContain("fetchCompat");
    expect(body).not.toMatch(/\bawait fetch\(/);
  });
});
