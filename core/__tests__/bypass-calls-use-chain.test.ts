/**
 * The four places that used to ask GitHub's `latest` release directly now go through the one source chain
 * (electron/vendor-sources.cjs): a second source when the first fails, the last answer kept when everything
 * fails, and no request at all offline or in privacy mode. No network: a fake fetch stands in for GitHub.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");

type Store = unknown;
type Opts = Record<string, unknown>;
const vendor = require_("../../electron/vendor-sources.cjs") as {
  createFeedStore: (o: { file: string }) => Store;
};
const library = require_("../../electron/local-library.cjs") as {
  latestOfficialRelease: (
    id: string,
    o?: Opts,
  ) => Promise<{ tag: string; sha256: string; source: string } | null>;
  checkRunnerRelease: (
    id: string,
    o?: Opts,
  ) => Promise<{ ok: boolean; updateAvailable: boolean; latestTag?: string; reason?: string }>;
};
const runners = require_("../../scripts/runners-status.cjs") as {
  newestTag: (repo: string, o: Opts) => Promise<string | null>;
};
const pins = require_("../../scripts/pin-freshness.cjs") as {
  fetchLatest: (
    s: Record<string, string>,
    fetchJson: (url: string) => Promise<unknown>,
    o?: Opts,
  ) => Promise<{ version: string; publishedAt?: string } | null>;
};

const response = (body: unknown, status = 200) => ({
  status,
  ok: status < 400,
  headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const atom = (tag: string) =>
  `<feed><entry><link href="https://github.com/o/r/releases/tag/${tag}"/></entry></feed>`;
const digest = `sha256:${"e".repeat(64)}`;
const release = (tag: string) => ({
  tag_name: tag,
  published_at: "2026-11-01T00:00:00Z",
  assets: [
    {
      name: "OllamaSetup.exe",
      browser_download_url: `https://github.com/ollama/ollama/releases/download/${tag}/OllamaSetup.exe`,
      size: 10,
      digest,
    },
  ],
});
/** api.github.com is down; the public atom feed answers with `tag`. */
const apiDownAtom = (tag: string, seen: string[]) => async (url: string) => {
  seen.push(url);
  return url.includes("api.github.com") ? response("busy", 503) : response(atom(tag));
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const newStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "friday-chain-"));
  dirs.push(dir);
  return vendor.createFeedStore({ file: join(dir, "cache", "vendor-feeds.json") });
};

describe("local runners ask the source chain", () => {
  it("checkRunnerRelease reads the second source when the API fails", async () => {
    const seen: string[] = [];
    const got = await library.checkRunnerRelease("ollama", {
      fetchImpl: apiDownAtom("v99.0.0", seen),
      store: newStore(),
    });
    expect(got.updateAvailable).toBe(true);
    expect(got.latestTag).toBe("v99.0.0");
    expect(seen.some((u) => u.endsWith("/releases.atom"))).toBe(true);
  });

  it("latestOfficialRelease keeps the verified pin when only a digest-less source answers", async () => {
    const seen: string[] = [];
    const got = await library.latestOfficialRelease("ollama", {
      fetchImpl: apiDownAtom("v99.0.0", seen),
      store: newStore(),
    });
    expect(got?.source).toBe("pinned");
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the last answer when every source fails afterwards", async () => {
    const store = newStore();
    const first = await library.latestOfficialRelease("ollama", {
      fetchImpl: async () => response(release("v99.0.0")),
      store,
    });
    expect(first).toMatchObject({ tag: "v99.0.0", source: "live" });
    const offline = await library.latestOfficialRelease("ollama", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
      store,
    });
    expect(offline).toMatchObject({ tag: "v99.0.0", source: "live", sha256: "e".repeat(64) });
  });

  it("makes no request in privacy mode or offline, and answers from the cache", async () => {
    const store = newStore();
    await library.latestOfficialRelease("ollama", {
      fetchImpl: async () => response(release("v99.0.0")),
      store,
    });
    for (const mode of [{ privacy: true }, { online: false }]) {
      const seen: string[] = [];
      const got = await library.latestOfficialRelease("ollama", {
        fetchImpl: async (u: string) => {
          seen.push(u);
          return response(release("v100.0.0"));
        },
        store,
        ...mode,
      });
      expect(seen).toEqual([]);
      expect(got?.tag).toBe("v99.0.0");
    }
  });

  it("reports a failed check without throwing when nothing answers and nothing is stored", async () => {
    const got = await library.checkRunnerRelease("ollama", {
      fetchImpl: async () => {
        throw new Error("offline");
      },
      store: newStore(),
    });
    expect(got.ok).toBe(false);
  });
});

describe("the status scripts ask the source chain", () => {
  it("runners-status takes the tag from the second source, then from the cache", async () => {
    const store = newStore();
    const seen: string[] = [];
    expect(await runners.newestTag("o/r", { fetchImpl: apiDownAtom("v1.2.3", seen), store })).toBe(
      "v1.2.3",
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const down = async () => {
      throw new Error("offline");
    };
    expect(await runners.newestTag("o/r", { fetchImpl: down, store })).toBe("v1.2.3");
    expect(await runners.newestTag("x/y", { fetchImpl: down, store })).toBeNull();
  });

  it("pin-freshness takes the version from the second source and keeps the release date from the first", async () => {
    const seen: string[] = [];
    const viaAtom = await pins.fetchLatest(
      { github: "o/r" },
      async () => {
        throw new Error("unused");
      },
      { fetchImpl: apiDownAtom("v1.7.13", seen), store: newStore() },
    );
    expect(viaAtom?.version).toBe("1.7.13");
    const viaApi = await pins.fetchLatest({ github: "o/r" }, async () => ({
      tag_name: "v1.7.14",
      published_at: "2026-11-01T00:00:00Z",
    }));
    expect(viaApi).toEqual({ version: "1.7.14", publishedAt: "2026-11-01T00:00:00Z" });
  });
});

describe("no raw latest-release URL is left in the bypass files", () => {
  it.each([
    "electron/local-library.cjs",
    "scripts/runners-status.cjs",
    "scripts/pin-freshness.cjs",
  ])("%s", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect(text).not.toContain("releases/latest");
    expect(text).toContain("resolveLatest");
  });
});
