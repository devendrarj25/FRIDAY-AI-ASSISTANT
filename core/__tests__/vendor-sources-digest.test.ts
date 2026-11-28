/**
 * The GitHub release digest source (`download.digestUrl` = api.github.com releases/tags/<tag>, `digestPath` = the
 * `digest` of the asset named like the download): the json path reader, the `sha256:` prefix, the fail-closed
 * answers, and the shipped rows that install a GitHub release asset. api.github.com is never reached: a fake
 * network answers every address, and nothing here touches the clock or the real PC.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const SOURCES_DIR = path.join(root, "config/tool-sources");

const H = (c: string) => c.repeat(64);

type Download = {
  urlTemplate?: string;
  mirrors?: string[];
  digestUrl?: string;
  digestPath?: string;
  archive?: string;
};
type Row = {
  sources: { kind: string; [k: string]: unknown }[];
  download?: Download;
  notifyOnly?: boolean;
  singleSourceReason?: string;
  silentInstall?: string;
};
const realRows = () => {
  const rows: Record<string, Row> = {};
  for (const f of readdirSync(SOURCES_DIR).filter((n) => n.endsWith(".json")))
    Object.assign(
      rows,
      (JSON.parse(readFileSync(path.join(SOURCES_DIR, f), "utf8")) as { rows: Record<string, Row> })
        .rows,
    );
  return rows;
};

const net = (routes: Record<string, string>) => async (url: string) => {
  const body = routes[url];
  return {
    ok: body !== undefined,
    status: body !== undefined ? 200 : 503,
    url,
    headers: { get: () => null },
    text: async () => body ?? "",
  };
};
const release = (assets: { name: string; digest: string | null }[]) =>
  JSON.stringify({ tag_name: "t", assets });

const GH_DOWNLOAD: Download = {
  urlTemplate: "https://github.com/o/r/releases/download/v{version}/tool-{version}.zip",
  digestUrl: "https://api.github.com/repos/o/r/releases/tags/v{version}",
  digestPath: "$.assets[?(@.name=='{file}')].digest",
  archive: "zip",
};

describe("the json path reader and the GitHub release digest", () => {
  const doc = {
    assets: [
      { name: "tool-1.0.0.zip", digest: `sha256:${H("A")}` },
      { name: "tool-1.0.0.sig", digest: null },
    ],
  };

  it("reads the digest of the asset named in a filter, with a plain or a quoted key", () => {
    const plain = "$.assets[?(@.name=='tool-1.0.0.zip')].digest";
    const quoted = "$.assets[?(@['name']=='tool-1.0.0.zip')]['digest']";
    expect(vendor.queryJsonPath(doc, plain)).toBe(`sha256:${H("A")}`);
    expect(vendor.queryJsonPath(doc, quoted)).toBe(`sha256:${H("A")}`);
    expect(vendor.queryJsonPath(doc, `$['assets'][0]['name']`)).toBe("tool-1.0.0.zip");
  });

  it("a missing or null digest finds nothing, so the row cannot install", () => {
    expect(() => vendor.queryJsonPath(doc, "$.assets[?(@.name=='tool-1.0.0.sig')].digest")).toThrow(
      /found nothing/,
    );
    expect(() => vendor.queryJsonPath(doc, "$.assets[?(@.name=='other.zip')].digest")).toThrow(
      /found nothing/,
    );
  });

  it("strips the sha256: prefix and lower-cases the hex", async () => {
    const got = await vendor.resolveDownloadDigest(GH_DOWNLOAD, "1.0.0", {
      fetchImpl: net({
        "https://api.github.com/repos/o/r/releases/tags/v1.0.0": release([
          { name: "tool-1.0.0.zip", digest: `sha256:${H("A")}` },
        ]),
      }),
    });
    expect(got).toMatchObject({
      ok: true,
      url: "https://github.com/o/r/releases/download/v1.0.0/tool-1.0.0.zip",
      algo: "sha256",
      sha256: H("a"),
    });
  });

  it("an asset the release has no digest for fails closed", async () => {
    const got = await vendor.resolveDownloadDigest(GH_DOWNLOAD, "1.0.0", {
      fetchImpl: net({
        "https://api.github.com/repos/o/r/releases/tags/v1.0.0": release([
          { name: "tool-1.0.0.zip", digest: null },
        ]),
      }),
    });
    expect(got.ok).toBe(false);
    expect(got.sha256).toBeUndefined();
  });

  it("a digest that is not 64 hex fails closed", async () => {
    const got = await vendor.resolveDownloadDigest(GH_DOWNLOAD, "1.0.0", {
      fetchImpl: net({
        "https://api.github.com/repos/o/r/releases/tags/v1.0.0": release([
          { name: "tool-1.0.0.zip", digest: "sha256:abc123" },
        ]),
      }),
    });
    expect(got.ok).toBe(false);
  });

  it("the API being down fails closed", async () => {
    const got = await vendor.resolveDownloadDigest(GH_DOWNLOAD, "1.0.0", { fetchImpl: net({}) });
    expect(got.ok).toBe(false);
  });
});

describe("the shipped GitHub release rows carry the digest source", () => {
  const githubRows = () =>
    Object.entries(realRows()).filter(
      ([, r]) =>
        r.notifyOnly !== true &&
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(
          r.download?.urlTemplate ?? "",
        ),
    );

  it("there are GitHub-hosted installable rows to check", () => {
    expect(githubRows().length).toBeGreaterThanOrEqual(4);
  });

  it("every one has a digest source", () => {
    const without = githubRows()
      .filter(([, r]) => !r.download?.digestUrl)
      .map(([id]) => id);
    expect(without).toEqual([]);
  });

  it("an API digest source reads the tag of the download, in the same repository", () => {
    for (const [id, r] of githubRows()) {
      const d = r.download as Download;
      if (!d.digestUrl?.startsWith("https://api.github.com/")) continue;
      const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//.exec(
        d.urlTemplate ?? "",
      );
      expect(d.digestUrl, id).toBe(
        `https://api.github.com/repos/${url?.[1]}/releases/tags/${url?.[2]}`,
      );
      expect(d.digestPath, id).toBe("$.assets[?(@.name=='{file}')].digest");
    }
  });

  it.each([
    ["Git", "2.50.0", "Git-2.50.0-64-bit.exe", "git-for-windows/git", "v2.50.0.windows.1"],
    [
      "Windows Terminal",
      "1.24.10",
      "Microsoft.WindowsTerminal_1.24.10_8wekyb3d8bbwe.msixbundle",
      "microsoft/terminal",
      "v1.24.10",
    ],
    [
      "Ruby",
      "3.4.5-1",
      "rubyinstaller-3.4.5-1-x64.7z",
      "oneclick/rubyinstaller2",
      "RubyInstaller-3.4.5-1",
    ],
  ])("%s resolves its digest from the release of its tag", async (id, version, file, repo, tag) => {
    const row = realRows()[id] as Row;
    const got = await vendor.resolveDownloadDigest(row.download, version, {
      fetchImpl: net({
        [`https://api.github.com/repos/${repo}/releases/tags/${tag}`]: release([
          { name: "other.zip", digest: `sha256:${H("1")}` },
          { name: file, digest: `sha256:${H("e")}` },
        ]),
      }),
    });
    expect(got).toMatchObject({ ok: true, sha256: H("e") });
    expect(got.url.endsWith(`/${file}`)).toBe(true);
  });

  it("the three rows are installable and a single GitHub source is said so", () => {
    vendor.clearToolSources();
    const rows = vendor.loadToolSources({ dir: SOURCES_DIR }).rows as Record<string, Row>;
    for (const id of ["Git", "Windows Terminal", "Ruby"]) {
      expect(vendor.downloadReadiness(rows[id]).installable, id).toBe(true);
      const roads = 1 + (rows[id]?.download?.mirrors?.length ?? 0);
      expect(roads >= 2 || Boolean(rows[id]?.singleSourceReason), id).toBe(true);
    }
  });
});

describe("the llama.cpp tag in the source reader's notes", () => {
  it("names the 2026-11 build, not the old pin", () => {
    const text = readFileSync(path.join(root, "electron/vendor-sources.cjs"), "utf8");
    expect(text).not.toContain("b12230");
    expect(text).toContain("b12619");
  });

  it("a build tag such as b12619 is still a version the reader hands on", () => {
    expect(vendor.sanitizeVersion("b12619")).toBe("b12619");
  });
});
