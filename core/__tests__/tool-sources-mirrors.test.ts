/**
 * Second download roads for tool rows (`download.mirrors` in config/tool-sources/*.json): the row schema, the
 * `{sqliteNumeric}` token, the plan that carries the mirrors beside the primary address, the shipped rows that gained
 * a verified mirror, and the rows that are notice-only for a recorded reason. A fake network stands in for every host;
 * nothing here touches the network, the clock or the real PC.
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
  archive?: string;
};
type Row = {
  home: string;
  sources: { kind: string; [k: string]: unknown }[];
  download?: Download;
  notifyOnly?: boolean;
  singleSourceReason?: string;
  silentInstall?: string;
  signer?: string;
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
/** The row problem the loader reports for one row, or "" when the row loads. */
const problem = (row: Row): string =>
  String(vendor.validateToolSourceFile({ version: 1, rows: { T: row } }, "t.json").errors[0] ?? "");
const filed = () => vendor.loadToolSources({ dir: SOURCES_DIR });

const base = (download: Record<string, unknown>): Row =>
  ({
    home: "machine",
    sources: [{ kind: "html-regex", url: "https://v.example/latest", pattern: "v([0-9.]+)" }],
    download: { urlTemplate: "https://v.example/t-{version}.zip", archive: "zip", ...download },
  }) as Row;

describe("download.mirrors in the row schema", () => {
  it("accepts a list of https templates", () => {
    const row = base({
      mirrors: ["https://m1.example/t-{version}.zip", "https://m2.example/x.zip"],
    });
    expect(problem(row)).toBe("");
  });

  it("refuses a mirror that is not a list of plain https addresses", () => {
    expect(problem(base({ mirrors: "https://m.example/t.zip" }))).toMatch(/mirrors/);
    expect(problem(base({ mirrors: ["http://m.example/t.zip"] }))).toMatch(/mirrors/);
    expect(problem(base({ mirrors: [42] }))).toMatch(/mirrors/);
    expect(problem(base({ mirrors: ["file:///C:/t.zip"] }))).toMatch(/mirrors/);
  });

  it("refuses mirrors on a row with no primary address, and a mirror equal to the primary", () => {
    const noPrimary = base({ mirrors: ["https://m.example/t.zip"] });
    delete (noPrimary.download as Download).urlTemplate;
    expect(problem(noPrimary)).toMatch(/mirrors/);
    expect(problem(base({ mirrors: ["https://v.example/t-{version}.zip"] }))).toMatch(/mirrors/);
  });
});

describe("{sqliteNumeric}", () => {
  it("is major*1000000 + minor*10000 + patch*100", () => {
    expect(vendor.expandTemplate("{sqliteNumeric}", "3.54.1")).toBe("3540100");
    expect(vendor.expandTemplate("s-{sqliteNumeric}.zip", "3.45.3")).toBe("s-3450300.zip");
    expect(vendor.expandTemplate("{sqliteNumeric}", "3.9.0")).toBe("3090000");
  });
});

describe("the plan carries the mirrors beside the primary address", () => {
  const net = (routes: Record<string, string>) => async (url: string) => {
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key ? routes[key] : "";
    return {
      ok: !!key,
      status: key ? 200 : 503,
      url,
      headers: { get: () => null },
      text: async () => body,
    };
  };

  it("resolveDownloadDigest expands each mirror with the same tokens", async () => {
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/{majorMinor}/t-{version}.zip",
        mirrors: ["https://m.example/{version}/t-{version}.zip"],
        digestUrl: "https://v.example/sums-{version}",
        archive: "zip",
      },
      "1.2.3",
      { fetchImpl: net({ "https://v.example/sums-1.2.3": `${H("a")}  t-1.2.3.zip\n` }) },
    );
    expect(got).toMatchObject({
      ok: true,
      url: "https://v.example/1.2/t-1.2.3.zip",
      mirrors: ["https://m.example/1.2.3/t-1.2.3.zip"],
      sha256: H("a"),
    });
  });

  it("a row with no mirrors answers an empty list", async () => {
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/t-{version}.zip",
        digestUrl: "https://v.example/sums-{version}",
        archive: "zip",
      },
      "1.0.0",
      { fetchImpl: net({ "https://v.example/sums-1.0.0": `${H("b")}  t-1.0.0.zip\n` }) },
    );
    expect(got).toMatchObject({ ok: true, mirrors: [] });
  });

  it("planRowDownload returns {url, mirrors} and the one digest that covers every road", async () => {
    const row = base({
      mirrors: ["https://m.example/t-{version}.zip"],
      digestUrl: "https://v.example/sums-{version}",
    });
    const plan = await vendor.planRowDownload("T", {
      toolSources: { rows: { T: row }, errors: [], warnings: [], files: [] },
      fetchImpl: net({
        "https://v.example/latest": "v2.5.0",
        "https://v.example/sums-2.5.0": `${H("c")}  t-2.5.0.zip\n`,
      }),
    });
    expect(plan).toMatchObject({
      ok: true,
      version: "2.5.0",
      url: "https://v.example/t-2.5.0.zip",
      mirrors: ["https://m.example/t-2.5.0.zip"],
      sha256: H("c"),
    });
  });

  it("a mirror with an unfilled token is dropped, never sent", async () => {
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/t-{version}.zip",
        mirrors: ["https://m.example/{nothing}/t.zip", "https://m.example/ok-{version}.zip"],
        digestUrl: "https://v.example/sums-{version}",
        archive: "zip",
      },
      "1.0.0",
      { fetchImpl: net({ "https://v.example/sums-1.0.0": `${H("d")}  t-1.0.0.zip\n` }) },
    );
    expect(got.mirrors).toEqual(["https://m.example/ok-1.0.0.zip"]);
  });
});

describe("the shipped rows", () => {
  const MIRRORED = [
    "FRIDAY Node",
    "Node.js LTS",
    "Python",
    "Git",
    "Gradle",
    "Maven",
    "FFmpeg",
    "Rust",
    ".NET SDK",
    "Go",
  ];

  it("load with no error", () => {
    vendor.clearToolSources();
    expect(filed().errors).toEqual([]);
  });

  it.each(MIRRORED)("%s has a second download road that differs from the first", (id) => {
    const d = realRows()[id]?.download;
    expect(d?.mirrors?.length ?? 0, `${id} mirrors`).toBeGreaterThanOrEqual(1);
    for (const m of d?.mirrors ?? []) {
      expect(m).toMatch(/^https:\/\//);
      expect(m).not.toBe(d?.urlTemplate);
    }
    expect(new Set(d?.mirrors).size).toBe(d?.mirrors?.length);
  });

  it("every mirror fills with the row's own tokens and no brace is left", () => {
    for (const [id, r] of Object.entries(realRows()))
      for (const m of r.download?.mirrors ?? [])
        expect(vendor.expandTemplate(m, "1.2.3"), `${id}: ${m}`).not.toMatch(/\{\w+\}/);
  });

  it("every installable row has two download roads, or says why it has one", () => {
    vendor.clearToolSources();
    const rows = filed().rows as Record<string, Row>;
    const thin = Object.entries(rows)
      .filter(([, r]) => vendor.downloadReadiness(r).installable)
      .filter(([, r]) => 1 + (r.download?.mirrors?.length ?? 0) < 2 && !r.singleSourceReason)
      .map(([id]) => id);
    expect(thin).toEqual([]);
  });

  it("mirror hosts are on the download allowlist (rows whose host is not listed yet are named here)", () => {
    const policy = JSON.parse(
      readFileSync(path.join(root, "config/download-hosts.json"), "utf8"),
    ) as { hosts: string[]; families: { hosts?: string[]; suffixes?: string[] }[] };
    const allowed = (h: string) =>
      policy.hosts.includes(h) ||
      policy.families.some(
        (f) =>
          (f.hosts ?? []).includes(h) ||
          (f.suffixes ?? []).some((s) => h === s || h.endsWith(`.${s}`)),
      );
    const missing = new Set<string>();
    for (const r of Object.values(realRows()))
      for (const m of r.download?.mirrors ?? []) {
        const host = new URL(m.replace(/\{\w+\}/g, "x")).hostname;
        if (!allowed(host)) missing.add(host);
      }
    expect([...missing]).toEqual([]);
  });

  it("whisper.cpp only notifies: the latest release has no Windows zip", () => {
    const r = filed().rows["whisper.cpp"] as Row;
    expect(r.notifyOnly).toBe(true);
    expect(vendor.downloadReadiness(r).installable).toBe(false);
    expect(String((r as Row & { homeReason?: string }).homeReason ?? "")).toMatch(/1\.9\.2/);
  });

  it("CUDA names the real installer file and stays notice-only (NVIDIA publishes MD5 only)", () => {
    const r = filed().rows["CUDA Toolkit"] as Row;
    expect(r.download?.urlTemplate).toBe(
      "https://developer.download.nvidia.com/compute/cuda/{version}/local_installers/cuda_{version}_windows_x86_64.exe",
    );
    expect(r.silentInstall).toContain("cuda_{version}_windows_x86_64.exe");
    expect(vendor.downloadReadiness(r).installable).toBe(false);
  });

  it("the Python embed row follows the 3.12 series only and never offers 3.14", () => {
    const r = filed().rows["FRIDAY Python embed"] as Row;
    const text = JSON.stringify(r.sources);
    expect(text).toContain("3\\\\.12");
    expect(text).not.toMatch(/3\\\\\.14|"cycle":"3\.14"/);
    expect(r.notifyOnly).toBe(true);
  });

  it("SQLite names its file with {sqliteNumeric}", () => {
    const r = filed().rows["SQLite"] as Row;
    expect(r.download?.urlTemplate).toContain("{sqliteNumeric}");
  });

  it("the data files carry at least ten mirror lists", () => {
    const n = Object.values(realRows()).filter((r) => (r.download?.mirrors ?? []).length).length;
    expect(n).toBeGreaterThanOrEqual(10);
  });
});
