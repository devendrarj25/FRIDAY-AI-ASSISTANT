/**
 * The data-driven source chains (config/tool-sources/*.json): the six extra readers, the file loader, chainFor and
 * rowSpec, and the rules every data file must keep (hosts allowlisted, two sources or a reason, real catalogue ids).
 * A fake network stands in for each vendor page; nothing here touches the network, the clock or the real PC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));

const H = (c: string) => c.repeat(64);
const SOURCES_DIR = path.join(root, "config/tool-sources");

type Res = {
  ok: boolean;
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};
const reply = (
  body: unknown,
  { status = 200, url = "", headers = {} as Record<string, string> } = {},
): Res => ({
  ok: status < 400,
  status,
  url,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

type Routes = Record<string, unknown | ((url: string, init: Record<string, unknown>) => Res)>;
function network(routes: Routes) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({
      url,
      method: String(init["method"] || "GET"),
      headers: (init["headers"] as Record<string, string>) || {},
    });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return reply("", { status: 503 });
    const value = routes[key];
    if (typeof value === "function") return (value as (u: string, i: unknown) => Res)(url, init);
    if (value && typeof value === "object" && "ok" in (value as object)) return value as Res;
    return reply(value);
  };
  return { fetchImpl, calls };
}

const read = (spec: Record<string, unknown>, fetchImpl: unknown) =>
  vendor.resolveLatest("row", [spec], { fetchImpl, timeoutMs: 500 });

describe("new readers", () => {
  it("json-path reads a nested key and an array index", async () => {
    const net = network({ "https://v.example/a": { a: { b: [{ c: "3.15.2" }] } } });
    const got = await read(
      { kind: "json-path", url: "https://v.example/a", path: "$.a.b[0].c" },
      net.fetchImpl,
    );
    expect([got.ok, got.version, got.source, got.via]).toEqual([
      true,
      "3.15.2",
      "json-path",
      "primary",
    ]);
  });

  it("json-path reads a root array and the one filter form", async () => {
    const net = network({
      "https://v.example/arr": [{ version: "9.1.0" }],
      "https://v.example/eol": [
        { cycle: "3.15", latest: "3.15.2" },
        { cycle: "3.14", latest: "3.14.10" },
      ],
    });
    const first = await read(
      { kind: "json-path", url: "https://v.example/arr", path: "[0].version" },
      net.fetchImpl,
    );
    const filter = await read(
      { kind: "json-path", url: "https://v.example/eol", path: "$[?(@.cycle=='3.14')].latest" },
      net.fetchImpl,
    );
    expect([first.version, filter.version]).toEqual(["9.1.0", "3.14.10"]);
  });

  it("json-path strips a prefix with `strip` and refuses a path that leads nowhere", async () => {
    const net = network({ "https://v.example/n": { version: "v22.1.0" } });
    const ok = await read(
      { kind: "json-path", url: "https://v.example/n", path: "$.version", strip: "^v" },
      net.fetchImpl,
    );
    const miss = await read(
      { kind: "json-path", url: "https://v.example/n", path: "$.nope.deeper" },
      net.fetchImpl,
    );
    expect(ok.version).toBe("22.1.0");
    expect(miss.ok).toBe(false);
    expect(miss.attempts[0].error).toMatch(/path/i);
  });

  it("json-path cannot walk into the prototype", async () => {
    const net = network({ "https://v.example/p": { a: "1.0" } });
    const got = await read(
      { kind: "json-path", url: "https://v.example/p", path: "$.__proto__.constructor" },
      net.fetchImpl,
    );
    expect(got.ok).toBe(false);
  });

  it("html-regex takes the one capture group; `pick: highest` takes the newest of many", async () => {
    const net = network({
      "https://v.example/dl": "<p>Latest Python 3 Release - Python 3.15.2</p>",
      "https://v.example/ftp":
        '<a href="3.9.1/">a</a><a href="3.15.2/">b</a><a href="3.10.4/">c</a>',
    });
    const one = await read(
      {
        kind: "html-regex",
        url: "https://v.example/dl",
        pattern: "Latest Python 3 Release - Python ([0-9.]+)",
      },
      net.fetchImpl,
    );
    const many = await read(
      {
        kind: "html-regex",
        url: "https://v.example/ftp",
        pattern: 'href="(\\d+\\.\\d+\\.\\d+)/"',
        pick: "highest",
      },
      net.fetchImpl,
    );
    expect([one.version, many.version]).toEqual(["3.15.2", "3.15.2"]);
  });

  it("html-regex refuses a pattern with no capture group or with two", async () => {
    const net = network({ "https://v.example/dl": "version 1.2.3" });
    for (const pattern of ["version [0-9.]+", "(version) ([0-9.]+)"]) {
      const got = await read(
        { kind: "html-regex", url: "https://v.example/dl", pattern },
        net.fetchImpl,
      );
      expect(got.ok, pattern).toBe(false);
      expect(got.attempts[0].error).toMatch(/capture group/);
    }
  });

  it("text-line reads a numbered line, or the first line a pattern fits", async () => {
    const net = network({ "https://v.example/t": "# header\n\n 4.2.1 \nnext 9.9\n" });
    const byLine = await read(
      { kind: "text-line", url: "https://v.example/t", line: 1 },
      net.fetchImpl,
    );
    const byPattern = await read(
      { kind: "text-line", url: "https://v.example/t", pattern: "^next ([0-9.]+)" },
      net.fetchImpl,
    );
    expect([byLine.version, byPattern.version]).toEqual(["4.2.1", "9.9"]);
  });

  it("redirect-regex reads the final URL and never downloads the body", async () => {
    let bodyRead = false;
    const net = network({
      "https://aka.example/latest": (_url: string, init: Record<string, unknown>) => ({
        ...reply("", { url: "https://github.com/o/r/dl/tool-5.6.7-x64.msi" }),
        text: async () => {
          bodyRead = true;
          return "x".repeat(10);
        },
        method: init["method"],
      }),
    });
    const got = await read(
      { kind: "redirect-regex", url: "https://aka.example/latest", pattern: "tool-([0-9.]+)-x64" },
      net.fetchImpl,
    );
    expect([got.version, got.assets]).toEqual(["5.6.7", []]);
    expect(bodyRead).toBe(false);
    expect(net.calls[0]?.method).toBe("HEAD");
  });

  it("redirect-regex retries a refused HEAD once as a body-less GET", async () => {
    const net = network({
      "https://aka.example/latest": (_url: string, init: Record<string, unknown>) =>
        init["method"] === "HEAD"
          ? reply("", { status: 405 })
          : reply("", { url: "https://github.com/o/r/tool-1.2.3.exe" }),
    });
    const got = await read(
      {
        kind: "redirect-regex",
        url: "https://aka.example/latest",
        pattern: "tool-([0-9.]+)\\.exe",
      },
      net.fetchImpl,
    );
    expect(got.version).toBe("1.2.3");
    expect(net.calls.map((c) => c.method)).toEqual(["HEAD", "GET"]);
  });

  it("redirect-regex fails when nothing redirected", async () => {
    const net = network({
      "https://aka.example/latest": reply("", { url: "https://aka.example/latest" }),
    });
    const got = await read(
      { kind: "redirect-regex", url: "https://aka.example/latest", pattern: "tool-([0-9.]+)" },
      net.fetchImpl,
    );
    expect(got.ok).toBe(false);
  });

  it("endoflife reads the newest cycle, or the named one", async () => {
    const cycles = [
      { cycle: "3.15", latest: "3.15.2" },
      { cycle: "3.14", latest: "3.14.10" },
    ];
    const net = network({ "https://endoflife.date/api/python.json": cycles });
    const newest = await read({ kind: "endoflife", product: "python" }, net.fetchImpl);
    const named = await read(
      { kind: "endoflife", product: "python", cycle: "3.14" },
      net.fetchImpl,
    );
    const none = await read({ kind: "endoflife", product: "python", cycle: "2.7" }, net.fetchImpl);
    expect([newest.version, named.version, none.ok]).toEqual(["3.15.2", "3.14.10", false]);
    expect(net.calls[0]?.url).toBe("https://endoflife.date/api/python.json");
  });

  it("endoflife refuses a product name that is not a plain name", async () => {
    const net = network({});
    const got = await read({ kind: "endoflife", product: "../x?y=1" }, net.fetchImpl);
    expect(got.ok).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("scoop-manifest reads .version from the bucket (Main by default)", async () => {
    const net = network({
      "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/python.json": {
        version: "3.15.2",
      },
      "https://raw.githubusercontent.com/ScoopInstaller/Extras/master/bucket/obs.json": {
        version: "31.0.1",
      },
    });
    const main = await read({ kind: "scoop-manifest", name: "python" }, net.fetchImpl);
    const extras = await read(
      { kind: "scoop-manifest", name: "obs", bucket: "Extras" },
      net.fetchImpl,
    );
    expect([main.version, extras.version]).toEqual(["3.15.2", "31.0.1"]);
  });

  it("every reader refuses a version that is not a version, and an http or odd URL", async () => {
    const net = network({
      "https://v.example/bad": { v: "<html>not a version</html>" },
      "https://v.example/latest": { v: "latest" },
      "https://v.example/long": { v: `1.${"9".repeat(80)}` },
    });
    for (const u of ["bad", "latest", "long"]) {
      const got = await read(
        { kind: "json-path", url: `https://v.example/${u}`, path: "$.v" },
        net.fetchImpl,
      );
      expect(got.ok, u).toBe(false);
      expect(got.attempts[0].error, u).toMatch(/version/i);
    }
    for (const url of [
      "http://v.example/bad",
      "ftp://v.example/x",
      "not a url",
      "https://u:p@v.example/x",
    ]) {
      const got = await read({ kind: "json-path", url, path: "$.v" }, net.fetchImpl);
      expect(got.ok, url).toBe(false);
    }
  });

  it("a response over the size cap is refused, from the header or from the body", async () => {
    const big = "x".repeat(vendor.MAX_BODY_BYTES + 1);
    const net = network({
      "https://v.example/header": reply('{"v":"1.0"}', {
        headers: { "content-length": String(vendor.MAX_BODY_BYTES + 1) },
      }),
      "https://v.example/body": reply(big),
    });
    for (const u of ["header", "body"]) {
      const got = await read(
        { kind: "json-path", url: `https://v.example/${u}`, path: "$.v" },
        net.fetchImpl,
      );
      expect(got.ok, u).toBe(false);
      expect(got.attempts[0].error, u).toMatch(/too large|size/i);
    }
  });
});

describe("chain behaviour of the new readers", () => {
  it("falls to the second source when the first fails", async () => {
    const net = network({
      "https://one.example": reply("", { status: 500 }),
      "https://endoflife.date/api/go.json": [{ cycle: "1.25", latest: "1.25.4" }],
    });
    const got = await vendor.resolveLatest(
      "Go",
      [
        { kind: "html-regex", url: "https://one.example/x", pattern: "go([0-9.]+)" },
        { kind: "endoflife", product: "go" },
      ],
      { fetchImpl: net.fetchImpl },
    );
    expect([got.ok, got.version, got.source, got.via]).toEqual([
      true,
      "1.25.4",
      "endoflife",
      "fallback",
    ]);
  });

  it("two sources of the same kind keep separate stored answers and validators", async () => {
    const store = vendor.createFeedStore({ file: null });
    const net = network({
      "https://v.example/a": reply({ v: "1.0.0" }, { headers: { etag: '"a"' } }),
      "https://v.example/b": reply({ v: "2.0.0" }, { headers: { etag: '"b"' } }),
    });
    const specs = [
      { kind: "json-path", url: "https://v.example/a", path: "$.v" },
      { kind: "json-path", url: "https://v.example/b", path: "$.v" },
    ];
    await vendor.resolveLatest("R", [specs[0]], { fetchImpl: net.fetchImpl, store });
    await vendor.resolveLatest("R", [specs[1]], { fetchImpl: net.fetchImpl, store });
    await vendor.resolveLatest("R", [specs[0]], { fetchImpl: net.fetchImpl, store });
    expect(net.calls[2]?.headers["if-none-match"]).toBe('"a"');
  });

  it("a 304 reuses the stored answer", async () => {
    const store = vendor.createFeedStore({ file: null });
    let n = 0;
    const net = network({
      "https://v.example/a": () =>
        n++ === 0
          ? reply({ v: "1.0.0" }, { headers: { etag: '"a"' } })
          : reply("", { status: 304 }),
    });
    const spec = { kind: "json-path", url: "https://v.example/a", path: "$.v" };
    await vendor.resolveLatest("R", [spec], { fetchImpl: net.fetchImpl, store });
    const again = await vendor.resolveLatest("R", [spec], { fetchImpl: net.fetchImpl, store });
    expect([again.version, again.notModified]).toEqual(["1.0.0", true]);
  });

  it("offline asks nobody: the stored answer, else the pin", async () => {
    const store = vendor.createFeedStore({ file: null });
    const net = network({ "https://v.example/a": { v: "1.0.0" } });
    const spec = { kind: "json-path", url: "https://v.example/a", path: "$.v" };
    await vendor.resolveLatest("R", [spec], { fetchImpl: net.fetchImpl, store });
    const calls = net.calls.length;
    const cached = await vendor.resolveLatest("R", [spec], {
      fetchImpl: net.fetchImpl,
      store,
      offline: true,
    });
    const pinned = await vendor.resolveLatest(
      "Other",
      [spec, { kind: "pinned", version: "0.9.0" }],
      { fetchImpl: net.fetchImpl, store, offline: true },
    );
    expect([cached.via, cached.version, cached.stale]).toEqual(["cache", "1.0.0", true]);
    expect([pinned.via, pinned.version]).toEqual(["pinned", "0.9.0"]);
    expect(net.calls).toHaveLength(calls);
  });

  it("the weekly cadence applies to the new readers", async () => {
    const store = vendor.createFeedStore({ file: null });
    let version = "1.0.0";
    const net = network({ "https://v.example/a": () => reply({ v: version }) });
    const spec = { kind: "json-path", url: "https://v.example/a", path: "$.v", cadenceDays: 7 };
    let clock = 1_000_000;
    const opts = { fetchImpl: net.fetchImpl, store, now: () => clock };
    await vendor.resolveLatest("R", [spec], opts);
    version = "1.1.0";
    clock += 24 * 60 * 60 * 1000;
    const held = await vendor.resolveLatest("R", [spec], { ...opts, force: true });
    clock += 7 * 24 * 60 * 60 * 1000;
    const adopted = await vendor.resolveLatest("R", [spec], { ...opts, force: true });
    expect([held.version, adopted.version]).toEqual(["1.0.0", "1.1.0"]);
  });
});

describe("digest handling: a version alone never authorises an install", () => {
  const specs: [string, Record<string, unknown>, Routes][] = [
    [
      "json-path",
      { kind: "json-path", url: "https://v.example/a", path: "$.v" },
      { "https://v.example/a": { v: "1.2.3" } },
    ],
    [
      "html-regex",
      { kind: "html-regex", url: "https://v.example/a", pattern: "v([0-9.]+)" },
      { "https://v.example/a": "v1.2.3" },
    ],
    [
      "text-line",
      { kind: "text-line", url: "https://v.example/a" },
      { "https://v.example/a": "1.2.3" },
    ],
    [
      "redirect-regex",
      { kind: "redirect-regex", url: "https://v.example/a", pattern: "-([0-9.]+)\\." },
      { "https://v.example/a": reply("", { url: "https://github.com/o/r/t-1.2.3.exe" }) },
    ],
    [
      "endoflife",
      { kind: "endoflife", product: "x" },
      { "https://endoflife.date/api/x.json": [{ cycle: "1", latest: "1.2.3" }] },
    ],
    [
      "scoop-manifest",
      { kind: "scoop-manifest", name: "x" },
      {
        "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/x.json": {
          version: "1.2.3",
          hash: H("a"),
        },
      },
    ],
  ];
  for (const [kind, spec, routes] of specs) {
    it(`${kind}: no assets, no digest, authorisesInstall is false`, async () => {
      const got = await read(spec, network(routes).fetchImpl);
      expect(got.version).toBe("1.2.3");
      expect(got.assets).toEqual([]);
      expect(vendor.authorisesInstall(got)).toBe(false);
    });
  }

  it("authorisesInstall is true only for a file with a SHA-256", () => {
    expect(vendor.authorisesInstall({ assets: [{ url: "https://x/y.zip", sha256: H("a") }] })).toBe(
      true,
    );
    expect(vendor.authorisesInstall({ assets: [{ url: "https://x/y.zip", sha256: "" }] })).toBe(
      false,
    );
    expect(vendor.authorisesInstall({ assets: [] })).toBe(false);
    expect(vendor.authorisesInstall(null)).toBe(false);
  });

  it("resolveDownloadDigest takes the digest from digestUrl (sums file or JSON path), else refuses", async () => {
    const net = network({
      "https://v.example/SHASUMS": `${H("c")}  tool-1.2.3-x64.msi\n${H("d")}  other.zip\n`,
      "https://v.example/api": [
        { url: "https://v.example/f/1.2.3/tool.exe", sha256_sum: H("e") },
        { url: "https://v.example/f/1.2.3/other.exe", sha256_sum: H("f") },
      ],
    });
    const sums = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/f/{v}/tool-{v}-x64.msi",
        archive: "msi",
        digestUrl: "https://v.example/SHASUMS",
      },
      "1.2.3",
      { fetchImpl: net.fetchImpl },
    );
    const api = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/f/{v}/tool.exe",
        archive: "exe",
        digestUrl: "https://v.example/api",
        digestPath: "$[?(@.url=='https://v.example/f/{v}/tool.exe')].sha256_sum",
      },
      "1.2.3",
      { fetchImpl: net.fetchImpl },
    );
    const none = await vendor.resolveDownloadDigest(
      { urlTemplate: "https://v.example/f/{v}/tool.exe", archive: "exe" },
      "1.2.3",
      { fetchImpl: net.fetchImpl },
    );
    expect([sums.ok, sums.url, sums.sha256]).toEqual([
      true,
      "https://v.example/f/1.2.3/tool-1.2.3-x64.msi",
      H("c"),
    ]);
    expect([api.ok, api.sha256]).toEqual([true, H("e")]);
    expect(none.ok).toBe(false);
    expect(none.sha256).toBeUndefined();
  });
});

describe("the data-file loader", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tool-sources-"));
    vendor.clearToolSources();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, body: unknown) =>
    writeFileSync(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  const goodRow = {
    home: "machine",
    homeReason: "per-user installer",
    sources: [
      {
        kind: "html-regex",
        url: "https://www.python.org/downloads/windows/",
        pattern: "Python ([0-9.]+)",
      },
      { kind: "endoflife", product: "python" },
    ],
    download: {
      urlTemplate: "https://www.python.org/ftp/python/{v}/python-{v}-amd64.exe",
      archive: "exe",
    },
    silentInstall: "/quiet",
    notifyOnly: false,
    checked: "2026-11-27",
  };

  it("a missing folder is an empty set, not an error", () => {
    const got = vendor.loadToolSources({ dir: path.join(dir, "nope") });
    expect([Object.keys(got.rows), got.errors]).toEqual([[], []]);
  });

  it("loads rows from every file and rowSpec gives home, download, silentInstall and notifyOnly", () => {
    put("runtimes.json", { version: 1, rows: { Python: goodRow } });
    put("tools.json", { version: 1, rows: { Git: { ...goodRow, notifyOnly: true } } });
    const got = vendor.loadToolSources({ dir });
    expect(got.errors).toEqual([]);
    expect(Object.keys(got.rows).sort()).toEqual(["Git", "Python"]);
    const spec = vendor.rowSpec("Python", { toolSources: got });
    expect(spec).toMatchObject({
      home: "machine",
      silentInstall: "/quiet",
      notifyOnly: false,
      download: { archive: "exe" },
    });
    expect(vendor.rowSpec("Git", { toolSources: got })?.notifyOnly).toBe(true);
    expect(vendor.rowSpec("Unknown", { toolSources: got })).toBeNull();
  });

  it("an unknown reader kind is a plain error for that row; the other rows still load", () => {
    put("a.json", {
      version: 1,
      rows: {
        Good: goodRow,
        Bad: { ...goodRow, sources: [{ kind: "vendor-json", url: "https://www.python.org/x" }] },
      },
    });
    const got = vendor.loadToolSources({ dir });
    expect(Object.keys(got.rows)).toEqual(["Good"]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toMatch(/Bad/);
    expect(got.errors[0]).toMatch(/unknown reader kind "vendor-json"/);
  });

  it("bad shapes give clear errors and never throw", () => {
    put("broken.json", "{ not json");
    put("v2.json", { version: 2, rows: {} });
    put("rowsarray.json", { version: 1, rows: [] });
    put("shapes.json", {
      version: 1,
      rows: {
        NoHome: { ...goodRow, home: "cloud" },
        NoSources: { ...goodRow, sources: [] },
        HttpUrl: {
          ...goodRow,
          sources: [{ kind: "json-path", url: "http://x.example/a", path: "$.v" }],
        },
        MissingField: { ...goodRow, sources: [{ kind: "json-path", url: "https://x.example/a" }] },
        BadRegex: {
          ...goodRow,
          sources: [{ kind: "html-regex", url: "https://x.example/a", pattern: "(" }],
        },
        TwoGroups: {
          ...goodRow,
          sources: [{ kind: "html-regex", url: "https://x.example/a", pattern: "(a)(b)" }],
        },
        BadArchive: {
          ...goodRow,
          download: { urlTemplate: "https://x.example/{v}", archive: "rpm" },
        },
        BadDownloadUrl: {
          ...goodRow,
          download: { urlTemplate: "ftp://x.example/{v}", archive: "exe" },
        },
        BadNotify: { ...goodRow, notifyOnly: "yes" },
        NotAnObject: 5,
      },
    });
    const got = vendor.loadToolSources({ dir });
    expect(got.rows).toEqual({});
    const text = got.errors.join("\n");
    for (const needle of [
      "broken.json",
      "v2.json",
      "rowsarray.json",
      "NoHome",
      "NoSources",
      "HttpUrl",
      "MissingField",
      "BadRegex",
      "TwoGroups",
      "BadArchive",
      "BadDownloadUrl",
      "BadNotify",
      "NotAnObject",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("the same row in two files keeps the first (by file name) and reports the second", () => {
    put("a.json", { version: 1, rows: { Python: goodRow } });
    put("b.json", { version: 1, rows: { Python: { ...goodRow, home: "friday-root" } } });
    const got = vendor.loadToolSources({ dir });
    expect(got.rows.Python.home).toBe("machine");
    expect(got.errors.join("\n")).toMatch(/Python.*already/);
  });

  it("chainFor uses the file sources when the row has none, then its feed and its pin", () => {
    put("a.json", { version: 1, rows: { Python: goodRow, "Node.js LTS": goodRow } });
    const toolSources = vendor.loadToolSources({ dir });
    const pin = { version: "3.14.0" };
    const chain = vendor.chainFor({ id: "Python", pinnedLatest: pin }, { toolSources });
    expect(chain.map((s: { kind: string }) => s.kind)).toEqual([
      "html-regex",
      "endoflife",
      "pinned",
    ]);
    const withFeed = vendor.chainFor({ id: "Node.js LTS", pinnedLatest: pin }, { toolSources });
    expect(withFeed.map((s: { kind: string }) => s.kind)).toEqual([
      "html-regex",
      "endoflife",
      "feed",
      "pinned",
    ]);
  });

  it("a row's own sources, and a row with no file entry, are exactly as before", () => {
    put("a.json", { version: 1, rows: { Python: goodRow } });
    const toolSources = vendor.loadToolSources({ dir });
    const own = [{ kind: "npm", pkg: "x" }];
    expect(vendor.chainFor({ id: "Python", sources: own }, { toolSources })).toBe(own);
    expect(
      vendor
        .chainFor({ id: "Other", latest: { kind: "npm", ref: "left-pad" } }, { toolSources })
        .map((s: { kind: string }) => s.kind),
    ).toEqual(["npm", "npm-mirror"]);
  });
});

/* ---------------------------------------------------------------- the real data files */

const realFiles = () => {
  try {
    return readdirSync(SOURCES_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [] as string[];
  }
};
type Row = {
  sources?: { url?: string }[];
  download?: { urlTemplate?: string; digestUrl?: string };
  singleSourceReason?: string;
};
const realRows = (): Record<string, Row> => {
  const out: Record<string, Row> = {};
  for (const f of realFiles()) {
    const doc = JSON.parse(readFileSync(path.join(SOURCES_DIR, f), "utf8")) as {
      rows?: Record<string, Row>;
    };
    Object.assign(out, doc.rows || {});
  }
  return out;
};
const hostOf = (u: string) => {
  try {
    return new URL(u.replace(/\{\w+\}/g, "x")).hostname.toLowerCase();
  } catch {
    return "";
  }
};
/** The host a source reads: the fixed host of the endoflife and scoop readers, else the `url` it names. */
const readerHosts = (spec: Record<string, unknown>) =>
  spec["kind"] === "endoflife"
    ? ["endoflife.date"]
    : spec["kind"] === "scoop-manifest"
      ? ["raw.githubusercontent.com"]
      : spec["url"]
        ? [hostOf(String(spec["url"]))]
        : [];
const usedHosts = () => {
  const hosts = new Set<string>();
  for (const row of Object.values(realRows())) {
    for (const s of (row.sources || []) as Record<string, unknown>[])
      for (const h of readerHosts(s)) hosts.add(h);
    for (const u of [row.download?.urlTemplate, row.download?.digestUrl])
      if (u) hosts.add(hostOf(u));
  }
  hosts.delete("");
  return hosts;
};
const policy = JSON.parse(readFileSync(path.join(root, "config/download-hosts.json"), "utf8")) as {
  checked: string;
  hosts: string[];
  families: { id: string; hosts?: string[]; suffixes?: string[] }[];
};
const allowed = (host: string) =>
  policy.hosts.includes(host) ||
  policy.families.some(
    (f) =>
      (f.hosts || []).includes(host) ||
      (f.suffixes || []).some((s) => host === s || host.endsWith(`.${s}`)),
  );

describe("the shipped data files (config/tool-sources/*.json)", () => {
  it("load with no error", () => {
    vendor.clearToolSources();
    const got = vendor.loadToolSources({ dir: SOURCES_DIR });
    expect(got.errors).toEqual([]);
    expect(Object.keys(got.rows).length).toBe(Object.keys(realRows()).length);
  });

  it("every URL host a data file uses is on the download allowlist", () => {
    const missing = [...usedHosts()].filter((h) => !allowed(h));
    expect(missing).toEqual([]);
  });

  it("the toolvendors family holds hosts the data files use, and nothing else", () => {
    const family = policy.families.find((f) => f.id === "toolvendors");
    expect(family).toBeTruthy();
    expect(family?.suffixes ?? []).toEqual([]);
    const used = usedHosts();
    if (used.size) expect((family?.hosts ?? []).filter((h) => !used.has(h))).toEqual([]);
    expect(new Set(family?.hosts).size).toBe(family?.hosts?.length);
    expect(family?.hosts ?? []).toEqual([...(family?.hosts ?? [])].sort());
  });

  it("hosts that rows reach only through the tool table or a redirect are listed exactly", () => {
    for (const h of [
      "downloads.gradle.org",
      "archive.apache.org",
      "getcomposer.org",
      "cmake.org",
    ]) {
      expect(policy.hosts.filter((x) => x === h)).toEqual([h]);
      expect(allowed(h)).toBe(true);
    }
    expect(allowed("evil.gradle.org")).toBe(false);
    expect(policy.families.some((f) => (f.suffixes || []).includes("gradle.org"))).toBe(false);
  });

  it("Graphviz has no usable digest source, so it only notifies and never installs", () => {
    const spec = vendor.rowSpec("Graphviz", {
      toolSources: vendor.loadToolSources({ dir: SOURCES_DIR }),
    });
    expect(spec?.download?.digestUrl).toBeUndefined();
    expect(vendor.downloadReadiness(spec).installable).toBe(false);
  });

  it("the allowlist date is a real, current date", () => {
    expect(policy.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(policy.checked >= "2026-11-27").toBe(true);
  });

  it("every row has at least two sources, or says why it has one", () => {
    const thin = Object.entries(realRows())
      .filter(([, r]) => (r.sources || []).length < 2 && !r.singleSourceReason)
      .map(([id]) => id);
    expect(thin).toEqual([]);
  });

  it("every row id is a row of the catalogue", () => {
    const ids = new Set((toolchain.TOOLS as { id: string }[]).map((t) => t.id));
    const unknown = Object.keys(realRows()).filter((id) => !ids.has(id));
    expect(unknown).toEqual([]);
  });
});

describe("the module keeps the old surface", () => {
  it("exports the old readers and the new ones in SOURCE_READERS", () => {
    for (const kind of [
      "github-api",
      "github-atom",
      "github-list",
      "pypi-json",
      "pypi-simple",
      "npm",
      "npm-mirror",
      "hf-api",
      "feed",
      "json-path",
      "html-regex",
      "text-line",
      "redirect-regex",
      "endoflife",
      "scoop-manifest",
    ])
      expect(typeof vendor.SOURCE_READERS[kind], kind).toBe("function");
  });
});

describe("devtools data shapes", () => {
  it("json-path walks on after a filter (a nested field of the matched entry)", async () => {
    const net = network({
      "https://v.example/tree": [
        { path: "ggml-tiny.bin", lfs: { oid: H("1") } },
        { path: "ggml-base.bin", lfs: { oid: H("2") } },
      ],
    });
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/resolve/ggml-base.bin",
        digestUrl: "https://v.example/tree",
        digestPath: "$[?(@.path=='ggml-base.bin')].lfs.oid",
      },
      "1.0",
      { fetchImpl: net.fetchImpl },
    );
    expect([got.ok, got.sha256]).toEqual([true, H("2")]);
  });

  it("a strip pattern removes every match (v prefix and .windows.N suffix together)", async () => {
    const net = network({ "https://v.example/g": { v: "v2.47.1.windows.1" } });
    const got = await read(
      {
        kind: "json-path",
        url: "https://v.example/g",
        path: "$.v",
        strip: "^v|\\.windows\\.\\d+$",
      },
      net.fetchImpl,
    );
    expect(got.version).toBe("2.47.1");
    const feed = vendor.parseGithubRelease(
      { tag_name: "v2.47.1.windows.1", assets: [] },
      "^v|\\.windows\\.\\d+$",
    );
    expect(feed.version).toBe("2.47.1");
  });

  it("{version} and {versionNoDots} fill the download address; a scoop manifest can hold the digest", async () => {
    const net = network({
      "https://v.example/scoop/tool.json": {
        version: "3.4.5",
        architecture: { "64bit": { hash: `sha256:${H("a")}` } },
      },
    });
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/dl/{version}/tool-{versionNoDots}.zip",
        archive: "zip",
        digestUrl: "https://v.example/scoop/tool.json",
        digestPath: "$.architecture.64bit.hash",
      },
      "3.4.5",
      { fetchImpl: net.fetchImpl },
    );
    expect([got.ok, got.url, got.sha256]).toEqual([
      true,
      "https://v.example/dl/3.4.5/tool-345.zip",
      H("a"),
    ]);
  });

  it("a plain-text digestUrl gives its first hex token; sha512 is read at its own length", async () => {
    const net = network({
      "https://v.example/t256": `${H("b")}\n`,
      "https://v.example/t512": `${"c".repeat(128)}  tool.jar\n`,
      "https://v.example/short": "deadbeef\n",
    });
    const dl = { urlTemplate: "https://v.example/f/tool.jar", archive: "zip" };
    const a = await vendor.resolveDownloadDigest(
      { ...dl, digestUrl: "https://v.example/t256" },
      "1.0",
      { fetchImpl: net.fetchImpl },
    );
    const b = await vendor.resolveDownloadDigest(
      { ...dl, digestUrl: "https://v.example/t512", digestAlgo: "sha512" },
      "1.0",
      { fetchImpl: net.fetchImpl },
    );
    const c = await vendor.resolveDownloadDigest(
      { ...dl, digestUrl: "https://v.example/short" },
      "1.0",
      { fetchImpl: net.fetchImpl },
    );
    expect([a.ok, a.sha256]).toEqual([true, H("b")]);
    expect([b.ok, b.algo, b.digest, b.sha256]).toEqual([
      true,
      "sha512",
      "c".repeat(128),
      undefined,
    ]);
    expect(c.ok).toBe(false);
  });

  it("a sums list never lends the digest of another file", async () => {
    const net = network({ "https://v.example/sums": `${H("d")}  other.zip\n` });
    const got = await vendor.resolveDownloadDigest(
      {
        urlTemplate: "https://v.example/f/tool.zip",
        archive: "zip",
        digestUrl: "https://v.example/sums",
      },
      "1.0",
      { fetchImpl: net.fetchImpl },
    );
    expect(got.ok).toBe(false);
  });

  it("the loader takes tar.gz, tar.xz, a download with no archive or no address, and sha512; it refuses odd ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tool-sources-shapes-"));
    try {
      const sources = [
        { kind: "endoflife", product: "x" },
        { kind: "scoop-manifest", name: "x" },
      ];
      const row = (download: unknown) => ({ home: "friday-root", sources, download });
      writeFileSync(
        path.join(dir, "a.json"),
        JSON.stringify({
          version: 1,
          rows: {
            TarGz: row({ urlTemplate: "https://v.example/{version}.tar.gz", archive: "tar.gz" }),
            TarXz: row({ urlTemplate: "https://v.example/{version}.tar.xz", archive: "tar.xz" }),
            Plain: row({ urlTemplate: "https://v.example/m.bin" }),
            NoAddress: row({ archive: "exe" }),
            Sha512: row({ urlTemplate: "https://v.example/m.jar", digestAlgo: "sha512" }),
            Md5: row({ urlTemplate: "https://v.example/m.jar", digestAlgo: "md5" }),
          },
        }),
      );
      vendor.clearToolSources();
      const got = vendor.loadToolSources({ dir });
      expect(Object.keys(got.rows).sort()).toEqual([
        "NoAddress",
        "Plain",
        "Sha512",
        "TarGz",
        "TarXz",
      ]);
      expect(got.errors).toHaveLength(1);
      expect(got.errors[0]).toContain("Md5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/sources-probe.cjs", () => {
  const probe = require_(path.join(root, "scripts/sources-probe.cjs"));
  const fakeCatalog = (sources: unknown[]) => ({ chainOfTool: () => ({ key: "x", sources }) });
  const fakeToolchain = { toolById: () => null };
  let dir = "";
  let out: string[] = [];
  const realLog = console.log;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "probe-"));
    vendor.clearToolSources();
    out = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    writeFileSync(
      path.join(dir, "a.json"),
      JSON.stringify({
        version: 1,
        rows: {
          Alpha: {
            home: "machine",
            sources: [
              { kind: "json-path", url: "https://v.example/a", path: "$.v" },
              { kind: "endoflife", product: "alpha" },
            ],
          },
        },
      }),
    );
  });
  afterEach(() => {
    console.log = realLog;
    rmSync(dir, { recursive: true, force: true });
  });
  const sources = [{ kind: "json-path", url: "https://v.example/a", path: "$.v" }];

  it("prints one line per row (row, source, version, via, ms) and exits 0 when all answer", async () => {
    const net = network({ "https://v.example/a": { v: "1.2.3" } });
    const code = await probe.main([], {
      dir,
      root: "",
      catalog: fakeCatalog(sources),
      toolchain: fakeToolchain,
      fetchImpl: net.fetchImpl,
    });
    const text = out.join("\n");
    expect(code).toBe(0);
    expect(text).toMatch(/Alpha\s+json-path\s+1\.2\.3\s+primary\s+\d+/);
    expect(text).toContain("1/1 rows answered");
  });

  it("exits 1 and names the row when nothing answers", async () => {
    const net = network({});
    const code = await probe.main(["--row", "Alpha"], {
      dir,
      root: "",
      catalog: fakeCatalog(sources),
      toolchain: fakeToolchain,
      fetchImpl: net.fetchImpl,
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/NO ANSWER/);
    expect(out.join("\n")).toContain("no answer: Alpha");
  });

  it("--offline makes no request and falls back to the pin", async () => {
    const net = network({ "https://v.example/a": { v: "1.2.3" } });
    const code = await probe.main(["--offline"], {
      dir,
      root: "",
      catalog: fakeCatalog([...sources, { kind: "pinned", version: "0.9.0" }]),
      toolchain: fakeToolchain,
      fetchImpl: net.fetchImpl,
    });
    expect(code).toBe(0);
    expect(net.calls).toHaveLength(0);
    expect(out.join("\n")).toMatch(/Alpha\s+pinned\s+0\.9\.0\s+pinned/);
  });

  it("an unknown row id is reported and exits 1", async () => {
    const code = await probe.main(["--row", "Nope"], { dir, root: "" });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain('no data-file row named "Nope"');
  });
});
