/**
 * The data files (config/tool-sources) wired into the catalogue, the install index and the installer: a row's home,
 * notify-only flag and download come from `rowSpec`, a download falls back to the row's own address only with a
 * checked digest, a bundled runtime is never swapped at run time, a machine install always waits for consent, and
 * the security rules of the readers (no open-ended patterns, bounded pages, no community-only gate). Fake networks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const catalog = require_(path.join(root, "electron/installer-catalog.cjs"));
const inventory = require_(path.join(root, "electron/install-inventory.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));

const H = (c: string) => c.repeat(64);
const H5 = (c: string) => c.repeat(128);

type Res = {
  ok: boolean;
  status: number;
  url: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  body?: unknown;
};
const reply = (body: unknown, { status = 200, url = "" } = {}): Res => ({
  ok: status < 400,
  status,
  url,
  headers: { get: () => null },
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
function network(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return reply("", { status: 503 });
    const v = routes[key];
    if (v && typeof v === "object" && "ok" in (v as object)) return v as Res;
    return reply(v);
  };
  return { fetchImpl, calls };
}

/** A data set in memory: `toolSources` is what `rowSpec` and `chainFor` read instead of the shipped folder. */
const sourcesOf = (rows: Record<string, unknown>) => ({
  rows,
  errors: [],
  warnings: [],
  files: [],
});
const VERSION_PAGE = "https://v.example/latest";
const row = (extra: Record<string, unknown> = {}) => ({
  home: "machine",
  sources: [{ kind: "html-regex", url: VERSION_PAGE, pattern: "v([0-9.]+)" }],
  download: {
    urlTemplate: "https://v.example/{majorMinor}/tool-{version}.exe",
    archive: "exe",
    digestUrl: "https://v.example/sums-{version}",
  },
  silentInstall: "tool-{version}.exe /quiet InstallAll=0",
  ...extra,
});

describe("planRowDownload: the row's own download, verified before anything is fetched", () => {
  it("fills {version} and {majorMinor}, takes the digest from the digest source, and lists plain silent switches", async () => {
    const net = network({
      [VERSION_PAGE]: "v3.14.2",
      "https://v.example/sums-3.14.2": `${H("a")}  tool-3.14.2.exe\n`,
    });
    const got = await vendor.planRowDownload("Py", {
      toolSources: sourcesOf({ Py: row() }),
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({
      ok: true,
      version: "3.14.2",
      url: "https://v.example/3.14/tool-3.14.2.exe",
      algo: "sha256",
      sha256: H("a"),
      archive: "exe",
      home: "machine",
      args: ["/quiet", "InstallAll=0"],
    });
  });

  it("a notify-only row never plans and never asks the network", async () => {
    const net = network({});
    const got = await vendor.planRowDownload("Electron", {
      toolSources: sourcesOf({ Electron: row({ notifyOnly: true }) }),
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({ ok: false, notifyOnly: true });
    expect(net.calls).toEqual([]);
  });

  it("a row with no digest source may only notify: no digest request, no file", async () => {
    const net = network({ [VERSION_PAGE]: "v1.0.0" });
    const noDigest = row({
      download: { urlTemplate: "https://v.example/t.exe", archive: "exe" },
    });
    const got = await vendor.planRowDownload("X", {
      toolSources: sourcesOf({ X: noDigest }),
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({ ok: false, notifyOnly: true });
    expect(got.url).toBeUndefined();
  });

  it("a digest source that is down fails closed to notify-only", async () => {
    const net = network({ [VERSION_PAGE]: "v2.0.0" });
    const got = await vendor.planRowDownload("X", {
      toolSources: sourcesOf({ X: row() }),
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({ ok: false, version: "2.0.0", notifyOnly: true });
  });

  it("reads a SHA-512 digest where the row says so (Maven keeps its sums that way)", async () => {
    const net = network({
      [VERSION_PAGE]: "v3.9.9",
      "https://v.example/sums-3.9.9": `${H5("c")}\n`,
    });
    const zip = row({
      download: {
        urlTemplate: "https://v.example/m/{version}/m-{version}.zip",
        archive: "zip",
        digestUrl: "https://v.example/sums-{version}",
        digestAlgo: "sha512",
      },
    });
    const got = await vendor.planRowDownload("Mv", {
      toolSources: sourcesOf({ Mv: zip }),
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({ ok: true, algo: "sha512", digest: H5("c") });
    expect(got.sha256).toBeUndefined();
  });

  it("the catalogue's pin and the vendor's digest must agree for the same version", async () => {
    const net = network({
      [VERSION_PAGE]: "v1.2.3",
      "https://v.example/sums-1.2.3": `${H("a")}\n`,
    });
    const got = await vendor.planRowDownload("X", {
      toolSources: sourcesOf({ X: row() }),
      fetchImpl: net.fetchImpl,
      pin: { version: "1.2.3", sha256: H("b") },
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/pinned/i);
  });

  it("an exe with no plain silent switches is not planned (nothing composed into a command line)", async () => {
    const net = network({
      [VERSION_PAGE]: "v1.0.0",
      "https://v.example/sums-1.0.0": `${H("a")}\n`,
    });
    const got = await vendor.planRowDownload("X", {
      toolSources: sourcesOf({ X: row({ silentInstall: "setup.exe /D=<dir> & calc" }) }),
      fetchImpl: net.fetchImpl,
    });
    expect(got.ok).toBe(false);
    expect(net.calls).toEqual([]);
  });

  it("downloadReadiness labels a row installable only with an address, a digest source and plain switches", () => {
    const spec = (r: Record<string, unknown>) =>
      vendor.rowSpec("X", { toolSources: sourcesOf({ X: r }) });
    expect(vendor.downloadReadiness(spec(row())).installable).toBe(true);
    expect(vendor.downloadReadiness(spec(row({ download: { archive: "exe" } }))).installable).toBe(
      false,
    );
    expect(
      vendor.downloadReadiness(
        spec(row({ download: { urlTemplate: "https://v.example/t.exe", archive: "exe" } })),
      ),
    ).toMatchObject({ installable: false, reason: expect.stringMatching(/digest/) });
    expect(vendor.downloadReadiness(spec(row({ notifyOnly: true }))).installable).toBe(false);
  });
});

describe("community registries are a second opinion, never the install gate", () => {
  const MANIFEST = "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/tool.json";
  const dl = (archive: string) => ({
    urlTemplate: "https://v.example/t/{version}/tool.zip",
    archive,
    digestUrl: MANIFEST,
    digestPath: "$.architecture.64bit.hash",
  });
  const manifest = (version: string, url: string) => ({
    version,
    architecture: { "64bit": { url, hash: H("a") } },
  });

  it("a manifest for another version is refused before anything is downloaded", async () => {
    const net = network({ [MANIFEST]: manifest("9.9.9", "https://v.example/t/9.9.9/tool.zip") });
    const got = await vendor.resolveDownloadDigest(dl("zip"), "1.0.0", {
      fetchImpl: net.fetchImpl,
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/9\.9\.9|version/);
  });

  it("a manifest that names another file is refused", async () => {
    const net = network({
      [MANIFEST]: manifest("1.0.0", "https://evil.example/other.zip"),
    });
    const got = await vendor.resolveDownloadDigest(dl("zip"), "1.0.0", {
      fetchImpl: net.fetchImpl,
    });
    expect(got.ok).toBe(false);
    expect(got.error).toMatch(/another file/);
  });

  it("a matching manifest gives a digest marked community, and the #/rename suffix is ignored", async () => {
    const net = network({
      [MANIFEST]: manifest("1.0.0", "https://v.example/t/1.0.0/tool.zip#/dl.7z"),
    });
    const got = await vendor.resolveDownloadDigest(dl("zip"), "1.0.0", {
      fetchImpl: net.fetchImpl,
    });
    expect(got).toMatchObject({ ok: true, community: true, sha256: H("a") });
  });

  it("a zip whose only digest is community may only notify; a signed installer may go on to the signature check", async () => {
    const net = network({
      [VERSION_PAGE]: "v1.0.0",
      [MANIFEST]: manifest("1.0.0", "https://v.example/t/1.0.0/tool.zip"),
    });
    const zip = row({ download: dl("zip") });
    const exe = row({
      download: { ...dl("exe"), urlTemplate: "https://v.example/t/{version}/tool.zip" },
    });
    const a = await vendor.planRowDownload("A", {
      toolSources: sourcesOf({ A: zip }),
      fetchImpl: net.fetchImpl,
    });
    expect(a).toMatchObject({ ok: false, notifyOnly: true });
    const b = await vendor.planRowDownload("B", {
      toolSources: sourcesOf({ B: exe }),
      fetchImpl: net.fetchImpl,
    });
    expect(b).toMatchObject({ ok: true, community: true, needsSignature: true });
  });

  it("a Scoop page sent on to another project's path is refused", async () => {
    const net = network({
      [MANIFEST]: reply(manifest("1.0.0", "x"), {
        url: "https://raw.githubusercontent.com/someone-else/repo/master/tool.json",
      }),
    });
    const got = await vendor.resolveLatest("t", [{ kind: "scoop-manifest", name: "tool" }], {
      fetchImpl: net.fetchImpl,
    });
    expect(got.ok).toBe(false);
    expect(got.attempts[0].error).toMatch(/another project/);
  });
});

describe("silent-install text becomes an argument list, never a command line", () => {
  it("keeps plain switches, drops the program name (quoted or not), fills {version}", () => {
    expect(vendor.silentArgv("Git-{version}.exe /VERYSILENT /NORESTART", "2.1.0")).toEqual([
      "/VERYSILENT",
      "/NORESTART",
    ]);
    expect(vendor.silentArgv('"Docker Desktop Installer.exe" install --quiet', "1")).toEqual([
      "install",
      "--quiet",
    ]);
    expect(vendor.silentArgv("/S", "1")).toEqual(["/S"]);
  });

  it("refuses redirects, pipes, quotes, variables, placeholders and an empty text", () => {
    for (const bad of [
      "a.exe /D=<dir>",
      "a.exe /x > out.txt",
      "a.exe & calc",
      "a.exe /x | y",
      "a.exe /x=%TEMP%",
      'a.exe "/x y"',
      "a.exe /x={unfilled}",
      "a.exe /x `id`",
      "",
      "a.exe",
    ]) {
      expect(vendor.silentArgv(bad, "1.0"), bad).toBeNull();
    }
  });
});

describe("the verified-download helper checks SHA-256 and SHA-512", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "friday-sha-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sha512 = (t: string) => createHash("sha512").update(t).digest("hex");

  it("verifyFile reads the algorithm from the digest length", async () => {
    const file = path.join(dir, "a.bin");
    writeFileSync(file, "hello");
    expect(await vendor.verifyFile(file, sha512("hello"))).toMatchObject({
      ok: true,
      algo: "sha512",
    });
    expect(await vendor.verifyFile(file, `sha512:${sha512("hello").toUpperCase()}`)).toMatchObject({
      ok: true,
    });
    const bad = await vendor.verifyFile(file, H5("0"));
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toMatch(/SHA-512/);
    expect((await vendor.verifyFile(file, "abc")).ok).toBe(false);
  });

  it("downloadVerified accepts a SHA-512 candidate, hands the downloader the right digest field, and discards a mismatch", async () => {
    const seen: Record<string, unknown>[] = [];
    const download = async (_u: string, dest: string, opts: Record<string, unknown>) => {
      seen.push(opts);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, "GOOD");
    };
    const ok = await vendor.downloadVerified(
      [{ url: "https://a.example/f", sha512: sha512("GOOD"), source: "data" }],
      { download, dest: path.join(dir, "f.bin") },
    );
    expect(ok).toMatchObject({ ok: true, algo: "sha512" });
    expect(seen[0]).toMatchObject({ sha512: sha512("GOOD") });
    expect(seen[0]?.["sha256"]).toBeUndefined();
    const dest = path.join(dir, "g.bin");
    const bad = await vendor.downloadVerified(
      [{ url: "https://a.example/f", sha512: H5("1"), source: "data" }],
      { download, dest },
    );
    expect(bad.ok).toBe(false);
    expect(() => readFileSync(dest)).toThrow();
  });

  it("a digest of any other length is never downloaded", async () => {
    let called = 0;
    const out = await vendor.downloadVerified(
      [{ url: "https://a.example/f", sha256: "abc123", source: "x" }],
      { download: async () => void (called += 1), dest: path.join(dir, "h.bin") },
    );
    expect(out.ok).toBe(false);
    expect(called).toBe(0);
  });
});

describe("security: patterns, pages and stored answers", () => {
  it("a pattern that opens with an open-ended wildcard is refused by the validator and the reader", async () => {
    for (const pattern of [
      "[\\s\\S]*v([0-9.]+)",
      ".*v([0-9.]+)",
      "^.+v([0-9.]+)",
      "[^]*v([0-9.]+)",
    ]) {
      const file = vendor.validateToolSourceFile({
        version: 1,
        rows: {
          X: row({ sources: [{ kind: "html-regex", url: VERSION_PAGE, pattern }] }),
        },
      });
      expect(file.errors.join(), pattern).toMatch(/wildcard|quadratic/);
      const net = network({ [VERSION_PAGE]: "v1.0" });
      const got = await vendor.resolveLatest(
        "x",
        [{ kind: "html-regex", url: VERSION_PAGE, pattern }],
        {
          fetchImpl: net.fetchImpl,
        },
      );
      expect(got.ok, pattern).toBe(false);
    }
  });

  it("a text-line pattern is checked like the others and never silently shortened", () => {
    const check = (pattern: string) =>
      vendor.validateToolSourceFile({
        version: 1,
        rows: { X: row({ sources: [{ kind: "text-line", url: VERSION_PAGE, pattern }] }) },
      }).errors;
    expect(check("([")).not.toEqual([]);
    expect(check(".*x")).not.toEqual([]);
    expect(check("a".repeat(401))).not.toEqual([]);
    expect(check("^go([0-9.]+)")).toEqual([]);
  });

  it("1 MB of text with no match finishes quickly, and a match beyond the 512 KB cap is never read", async () => {
    const spec = {
      kind: "html-regex",
      url: VERSION_PAGE,
      pattern: 'msys2-base-x86_64-(\\d{8})\\.tar\\.xz"',
    };
    const net = network({ [VERSION_PAGE]: "a".repeat(1024 * 1024) });
    const started = performance.now();
    const got = await vendor.resolveLatest("x", [spec], { fetchImpl: net.fetchImpl });
    expect(got.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    const late = network({
      [VERSION_PAGE]: `${"a".repeat(600 * 1024)}msys2-base-x86_64-20251213.tar.xz"`,
    });
    const miss = await vendor.resolveLatest("x", [spec], { fetchImpl: late.fetchImpl });
    expect(miss.ok).toBe(false);
    const early = network({
      [VERSION_PAGE]: `msys2-base-x86_64-20251213.tar.xz"${"a".repeat(600 * 1024)}`,
    });
    expect(await vendor.resolveLatest("x", [spec], { fetchImpl: early.fetchImpl })).toMatchObject({
      ok: true,
      version: "20251213",
    });
  });

  it("a page that the network sent on to a host off the download allowlist is refused; an allowed host and the same host are fine", async () => {
    const via = (finalUrl: string) =>
      network({ [VERSION_PAGE]: reply("v1.2.3", { url: finalUrl }) });
    const spec = [{ kind: "html-regex", url: VERSION_PAGE, pattern: "v([0-9.]+)" }];
    const off = await vendor.resolveLatest("x", spec, {
      fetchImpl: via("https://attacker.example/v9.9.9").fetchImpl,
    });
    expect(off.ok).toBe(false);
    expect(off.attempts[0].error).toMatch(/not an allowed host/);
    const plain = await vendor.resolveLatest("x", spec, {
      fetchImpl: via("http://v.example/latest").fetchImpl,
    });
    expect(plain.ok).toBe(false);
    const allowed = await vendor.resolveLatest("x", spec, {
      fetchImpl: via("https://github.com/x/y").fetchImpl,
    });
    expect(allowed).toMatchObject({ ok: true, version: "1.2.3" });
    const same = await vendor.resolveLatest("x", spec, {
      fetchImpl: via("https://v.example/other").fetchImpl,
    });
    expect(same.ok).toBe(true);
  });

  it("the body is counted while it streams: over the cap the read stops and the request is aborted", async () => {
    let reads = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const res = {
      ...reply(""),
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            return reads > 100 ? { done: true } : { done: false, value: chunk };
          },
          cancel: async () => void (cancelled = true),
        }),
      },
    };
    const got = await vendor.resolveLatest(
      "x",
      [{ kind: "html-regex", url: VERSION_PAGE, pattern: "v([0-9.]+)" }],
      { fetchImpl: async () => res },
    );
    expect(got.ok).toBe(false);
    expect(got.attempts[0].error).toMatch(/too large/);
    expect(reads).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("a source is never allowed to take the version back below the stored or the pinned one", async () => {
    const store = vendor.createFeedStore({ file: "" });
    const newer = network({ [VERSION_PAGE]: "v5.0.0" });
    const spec = { kind: "html-regex", url: VERSION_PAGE, pattern: "v([0-9.]+)" };
    await vendor.resolveLatest("x", [spec], { fetchImpl: newer.fetchImpl, store });
    const older = network({ [VERSION_PAGE]: "v4.0.0" });
    const got = await vendor.resolveLatest("x", [spec], { fetchImpl: older.fetchImpl, store });
    expect(got.version).toBe("5.0.0");
    expect(got.stale).toBe(true);
    const pinned = await vendor.resolveLatest("y", [spec, { kind: "pinned", version: "6.0.0" }], {
      fetchImpl: older.fetchImpl,
    });
    expect(pinned).toMatchObject({ version: "6.0.0", pinned: true });
  });

  it("a stored answer is checked before it is reused: bad version, http file, odd digest, and a digest that differs from the pin", () => {
    const pin = {
      kind: "pinned",
      version: "1.0",
      assets: [{ name: "a.zip", url: "https://x.example/a.zip", sha256: H("a") }],
    };
    expect(vendor.trustStored({ version: "latest now", assets: [] }, [pin])).toBeNull();
    const kept = vendor.trustStored(
      {
        version: "1.0",
        assets: [
          { name: "ok.zip", url: "https://x.example/ok.zip", sha256: H("b") },
          { name: "http.zip", url: "http://x.example/h.zip", sha256: H("b") },
          { name: "odd.zip", url: "https://x.example/odd.zip", sha256: "zz" },
        ],
      },
      [],
    );
    expect(kept.assets.map((a: { name: string }) => a.name)).toEqual(["ok.zip"]);
    const clash = vendor.trustStored(
      {
        version: "1.0",
        assets: [{ name: "a.zip", url: "https://x.example/a.zip", sha256: H("c") }],
      },
      [pin],
    );
    expect(clash.assets).toEqual([]);
    expect(clash.distrusted).toMatch(/pinned/);
  });

  it("a tampered cache that disagrees with the pin never hands its digest to an install (offline fallback)", async () => {
    const store = vendor.createFeedStore({ file: "" });
    store.putRow("x", {
      value: {
        version: "1.0",
        assets: [{ name: "a.zip", url: "https://x.example/a.zip", sha256: H("c") }],
      },
      source: "html-regex",
      checkedAt: 1,
    });
    const pin = {
      kind: "pinned",
      version: "1.0",
      assets: [{ name: "a.zip", url: "https://x.example/a.zip", sha256: H("a") }],
    };
    const got = await vendor.resolveLatest("x", [pin], { store, offline: true });
    expect(got).toMatchObject({ ok: true, version: "1.0", stale: true });
    expect(got.assets).toEqual([]);
  });
});

describe("the shipped data files obey the same rules", () => {
  it("no shipped pattern opens with an open-ended wildcard and the loader reports no error", () => {
    vendor.clearToolSources();
    const got = vendor.loadToolSources({ dir: path.join(root, "config/tool-sources") });
    expect(got.errors).toEqual([]);
    const text = readFileSync(path.join(root, "config/tool-sources/devtools.json"), "utf8");
    expect(text).not.toContain("[\\\\s\\\\S]*msys2");
  });

  it("a row with a download address and no digest source is warned about, and is not installable", () => {
    const got = vendor.validateToolSourceFile({
      version: 1,
      rows: { X: row({ download: { urlTemplate: "https://v.example/t.exe", archive: "exe" } }) },
    });
    expect(got.errors).toEqual([]);
    expect(got.warnings.join()).toMatch(/no digest source/);
    vendor.clearToolSources();
    for (const id of ["Python", ".NET SDK", "AWS CLI", "VC++ Redistributable", "Ruby", "PHP"]) {
      expect(vendor.downloadReadiness(vendor.rowSpec(id)).installable, id).toBe(false);
    }
  });

  it("every {placeholder} a shipped download or silent text uses is one expandTemplate fills", () => {
    vendor.clearToolSources();
    const rows = vendor.loadToolSources({ dir: path.join(root, "config/tool-sources") }).rows;
    const known = new Set([
      "v",
      "version",
      "major",
      "minor",
      "majorMinor",
      "patch",
      "versionNoDots",
      "file",
    ]);
    for (const [id, r] of Object.entries(rows) as [string, Record<string, unknown>][]) {
      const text = JSON.stringify([r["download"], r["silentInstall"]]);
      for (const m of text.matchAll(/\{(\w+)\}/g))
        expect(known.has(m[1]!), `${id} {${m[1]}}`).toBe(true);
    }
  });
});

describe("the catalogue rows carry what the data file says", () => {
  const rows = (ids: string[]) =>
    catalog.toolRows(
      ids.map((id) => toolchain.toolById(id)),
      { tools: [] },
    );
  const byId = (list: Record<string, unknown>[], id: string) => list.find((r) => r["id"] === id)!;

  it("home, notifyOnly and the download spec come from rowSpec, not from a copy in the catalogue", () => {
    vendor.clearToolSources();
    const list = rows(["Python", "Electron", "Go"]);
    expect(byId(list, "Python")).toMatchObject({ home: "machine", notifyOnly: false });
    expect(byId(list, "Electron")).toMatchObject({ home: "npm-global", notifyOnly: true });
    expect(byId(list, "Go")).toMatchObject({ home: "friday-root" });
    expect(byId(list, "Go")["download"]).toEqual(vendor.rowSpec("Go").download);
    expect(byId(list, "Python")["silentInstall"]).toBe(vendor.rowSpec("Python").silentInstall);
    expect(readFileSync(path.join(root, "electron/installer-catalog.cjs"), "utf8")).toContain(
      "vendor.rowSpec(",
    );
  });

  it("a row with no data entry takes the home written on the tool row, and a winget row has none declared", () => {
    const list = rows(["Docker Compose", "WSL 2", "Hugging Face runner", "Git"]);
    expect(byId(list, "Docker Compose")["home"]).toBe("machine");
    expect(byId(list, "WSL 2")["home"]).toBe("machine");
    expect(byId(list, "Hugging Face runner")["home"]).toBe("friday-root");
    expect(byId(list, "Git")["home"]).toBe("machine");
  });

  it("the snapshot exposes home, notifyOnly and whether the row's own download is installable", () => {
    const api = catalog.createInstallerCatalog({
      root: () => null,
      tools: () => ["Python", "Electron", "Go"].map((id) => toolchain.toolById(id)),
      detected: () => ({ tools: [] }),
      packs: () => [],
      voice: () => [],
      runners: () => [],
    });
    const snap = api.snapshot().rows as Record<string, unknown>[];
    expect(byId(snap, "Electron")).toMatchObject({ home: "npm-global", notifyOnly: true });
    expect(byId(snap, "Python")).toMatchObject({ home: "machine", downloadReady: false });
    expect(byId(snap, "Go")).toMatchObject({ downloadReady: true });
  });
});

describe("planUpdate: bundled runtimes only notify, machine installs always ask", () => {
  const base = { id: "x", updateStatus: "update", fit: { state: "supported" } };

  it("a notify-only row is never allowed, whatever the dial and even with consent", () => {
    for (const autonomy of ["ask", "balanced", "full"]) {
      for (const consent of [undefined, { granted: true }]) {
        const plan = catalog.planUpdate({ row: { ...base, notifyOnly: true }, autonomy, consent });
        expect(plan, autonomy).toMatchObject({
          allowed: false,
          needsConsent: false,
          notifyOnly: true,
        });
        expect(plan.reason).toMatch(/newer version/i);
      }
    }
  });

  it("the real Electron, FRIDAY Node and FRIDAY pip bootstrap rows are notify-only", () => {
    vendor.clearToolSources();
    for (const id of ["Electron", "FRIDAY Node", "FRIDAY pip bootstrap"]) {
      const r = catalog.toolRows([toolchain.toolById(id)], { tools: [] })[0];
      const plan = catalog.planUpdate({
        row: { ...r, updateStatus: "update", fit: { state: "supported" } },
        autonomy: "full",
      });
      expect(plan.allowed, id).toBe(false);
    }
  });

  it("a machine-home row needs consent under Ask and Balanced, and says Windows will ask", () => {
    for (const autonomy of ["ask", "balanced"]) {
      const plan = catalog.planUpdate({ row: { ...base, home: "machine" }, autonomy });
      expect(plan).toMatchObject({ allowed: false, needsConsent: true, home: "machine" });
    }
    const granted = catalog.planUpdate({
      row: { ...base, home: "machine" },
      autonomy: "balanced",
      consent: { granted: true },
    });
    expect(granted).toMatchObject({ allowed: true, via: "consent", elevation: "windows" });
  });

  it("under Full a machine row may go on but is flagged: Windows shows its own prompt, FRIDAY never clicks it", () => {
    const plan = catalog.planUpdate({ row: { ...base, home: "machine" }, autonomy: "full" });
    expect(plan).toMatchObject({ allowed: true, via: "full-autonomy", elevation: "windows" });
    const home = catalog.planUpdate({ row: { ...base, home: "friday-root" }, autonomy: "full" });
    expect(home.elevation).toBeUndefined();
  });

  it("a row that is already at the latest version downloads nothing, whatever the dial", () => {
    const status = catalog.updateStatusOf({
      installed: true,
      installedVersion: "3.14.2",
      latest: { ok: true, version: "3.14.2" },
    });
    expect(status).toBe("current");
    for (const autonomy of ["ask", "balanced", "full"]) {
      expect(
        catalog.planUpdate({
          row: { ...base, updateStatus: status, home: "machine" },
          autonomy,
          consent: { granted: true },
        }).allowed,
      ).toBe(false);
    }
  });
});

describe("the install index files each row under its declared home", () => {
  it("a declared home beats the guess; a real path beats the declaration", () => {
    const at = (over: Record<string, unknown>) =>
      inventory.homeOf({ id: "x", manager: "vendor", ...over }, "/friday");
    expect(at({ home: "machine" })).toBe("machine");
    expect(at({ home: "npm-global" })).toBe("npm-global");
    expect(at({ home: "friday-root" })).toBe("friday-runtime");
    expect(at({ home: "friday-root", manager: "pip" })).toBe("friday-python-env");
    // the program really sits in Program Files: the index says so
    expect(at({ home: "friday-root", path: "C:/Program Files/x/x.exe" })).toBe("machine");
    expect(at({ home: "machine", path: "/friday/runtime/x/x.exe" })).toBe("friday-runtime");
    // nothing declared: the old rule
    expect(at({})).toBe("friday-runtime");
  });

  it("the five rows that used to be guessed land where the install really goes", () => {
    const detected = [
      "Docker Compose",
      "Hugging Face runner",
      "Playwright browsers",
      "WSL 2",
      "dotnet-script",
    ].map((id) => ({
      id,
      installed: false,
      manager: "vendor",
      home: toolchain.declaredHomeOf(toolchain.toolById(id)),
    }));
    const built = inventory.buildInventory("/friday", { tools: detected });
    const home = (id: string) => built.items.find((i: { id: string }) => i.id === id).home;
    expect(home("Docker Compose")).toBe("machine");
    expect(home("WSL 2")).toBe("machine");
    expect(home("dotnet-script")).toBe("machine");
    expect(home("Playwright browsers")).toBe("machine");
    expect(home("Hugging Face runner")).toBe("friday-runtime");
  });

  it("detectTools results carry the declared home, so the index reads it from the scan", async () => {
    const source = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(source).toContain("withHome(");
    expect(toolchain.declaredHomeOf(toolchain.toolById("Go"))).toBe("friday-root");
    const plain = toolchain.TOOLS.find(
      (t: { id: string; winget?: string; home?: string }) =>
        t.winget && !t.home && !vendor.rowSpec(t.id),
    );
    expect(plain).toBeTruthy();
    expect(toolchain.declaredHomeOf(plain)).toBeNull();
  });
});

describe("toolchain: hosts, bundled rows and the fallback download", () => {
  it("only a URL written in the tool table may add its own host; a feed or data-file URL must be on the allowlist", () => {
    const pinned = toolchain.toolById("Gradle");
    const url = String(pinned.installerUrl || "");
    expect(url).toMatch(/^https:/);
    expect(toolchain.installerExtraHosts(url)).toEqual([url]);
    expect(toolchain.installerExtraHosts("https://attacker.example/setup.exe")).toEqual([]);
    const src = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(src).not.toContain("extraHosts: [url]");
  });

  it("an update of a bundled runtime only reports: no download, no installer, Full autonomy or not", async () => {
    const events: Record<string, unknown>[] = [];
    const out = await toolchain.runJob(
      { id: "FRIDAY Node", action: "update", root: "/nowhere" },
      (e: Record<string, unknown>) => events.push(e),
    );
    expect(out).toMatchObject({ ok: false, notifyOnly: true });
    expect(events.some((e) => e["phase"] === "Downloading")).toBe(false);
    expect(String(events.at(-1)?.["line"] ?? events.at(-1)?.["error"])).toMatch(/newer version/i);
  });

  const tool = (extra: Record<string, unknown> = {}) => ({
    id: "Py",
    name: "Py",
    archiveBin: undefined,
    ...extra,
  });
  const goodNet = () =>
    network({
      [VERSION_PAGE]: "v3.14.2",
      "https://v.example/sums-3.14.2": `${H("a")}\n`,
    });

  it("dataFileDownload plans the row's own address with a checked digest", async () => {
    const got = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: row() }),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(got).toMatchObject({ ok: true, version: "3.14.2", sha256: H("a") });
  });

  it("an installed copy at or above the planned version is reused: nothing to download", async () => {
    const got = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: row() }),
      fetchImpl: goodNet().fetchImpl,
      installedVersion: "3.14.2",
    });
    expect(got).toMatchObject({ ok: false, reused: true });
    const newer = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: row() }),
      fetchImpl: goodNet().fetchImpl,
      installedVersion: "3.15.0",
    });
    expect(newer).toMatchObject({ ok: false, reused: true });
    const older = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: row() }),
      fetchImpl: goodNet().fetchImpl,
      installedVersion: "3.13.9",
    });
    expect(older.ok).toBe(true);
  });

  it("an archive FRIDAY does not unpack, or a zip with no program path, is not installed from the fallback", async () => {
    const sevenZ = row({
      download: {
        urlTemplate: "https://v.example/t-{version}.7z",
        archive: "7z",
        digestUrl: "https://v.example/sums-{version}",
      },
    });
    const a = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: sevenZ }),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(a).toMatchObject({ ok: false });
    expect(a.error).toMatch(/unpack/);
    const zip = row({
      download: {
        urlTemplate: "https://v.example/t-{version}.zip",
        archive: "zip",
        digestUrl: "https://v.example/sums-{version}",
      },
    });
    const b = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: zip }),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(b.ok).toBe(false);
    const c = await toolchain.dataFileDownload(tool({ archiveBin: "bin/py.exe" }), {
      toolSources: sourcesOf({ Py: zip }),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(c.ok).toBe(true);
  });

  it("a row with no data entry, or a notify-only one, gives no fallback", async () => {
    const none = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({}),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(none.ok).toBe(false);
    const bundled = await toolchain.dataFileDownload(tool(), {
      toolSources: sourcesOf({ Py: row({ notifyOnly: true }) }),
      fetchImpl: goodNet().fetchImpl,
    });
    expect(bundled).toMatchObject({ ok: false, notifyOnly: true });
  });

  it("the fallback step sits after the primary installer and before the last-resort managers", () => {
    const src = readFileSync(path.join(root, "electron/toolchain.cjs"), "utf8");
    expect(src).toContain("tryDataFileInstaller");
    expect(src).toMatch(
      /\[\s*tryVendorInstaller,\s*tryDataFileInstaller,\s*tryPackageManager,\s*tryAlternateManagers/,
    );
    expect(src).toMatch(
      /\[\s*tryPackageManager,\s*tryVendorInstaller,\s*tryDataFileInstaller,\s*tryAlternateManagers/,
    );
  });
});

describe("Doctor shows a newer bundled runtime without offering to install it", () => {
  it("one warn row, no repair action, only when an update exists", () => {
    const row = (over: Record<string, unknown>) => ({
      id: "Electron",
      name: "Electron",
      notifyOnly: true,
      updateStatus: "update",
      installedVersion: "41.0.0",
      latestVersion: "41.2.0",
      fit: { state: "supported", reasons: [] },
      ...over,
    });
    const shown = catalog.doctorRows([row({})]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ id: "bundled:Electron", status: "warn", repair: null });
    expect(shown[0].detail).toMatch(/41\.2\.0/);
    expect(catalog.doctorRows([row({ updateStatus: "current" })])).toEqual([]);
    expect(catalog.doctorRows([row({ notifyOnly: false })])).toEqual([]);
  });
});
