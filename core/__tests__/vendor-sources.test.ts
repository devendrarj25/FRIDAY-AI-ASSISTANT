/**
 * Official release feeds: the newest version and a digest-checked installer for
 * the tools winget would otherwise be the only way to get. A fake network stands
 * in for each vendor, using the shape of its real feed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const vendor = require_(path.resolve(import.meta.dirname, "../../electron/vendor-sources.cjs"));

const H = (c: string) => c.repeat(64);
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  url: "",
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

type Routes = Record<string, unknown | ((url: string) => unknown)>;
function network(routes: Routes) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return json({}, 503);
    const value = routes[key];
    const out = typeof value === "function" ? (value as (u: string) => unknown)(url) : value;
    return out && typeof out === "object" && "ok" in (out as object) ? out : json(out);
  };
  return { fetchImpl, calls };
}

beforeEach(() => vendor.clearFeedCache());

describe("vendor feeds", () => {
  it("Node.js LTS: newest LTS and the digest from SHASUMS256.txt, with mirrors", async () => {
    const net = network({
      "https://nodejs.org/dist/index.json": [
        { version: "v25.0.0", lts: false },
        { version: "v24.9.0", lts: "Krypton" },
        { version: "v22.23.3", lts: "Jod" },
      ],
      "https://nodejs.org/dist/v24.9.0/SHASUMS256.txt": `${H("a")}  node-v24.9.0-x64.msi\n${H("b")}  node-v24.9.0-win-x64.zip\n`,
    });
    const msi = await vendor.resolveFeed("Node.js LTS", { fetchImpl: net.fetchImpl });
    expect(msi.version).toBe("24.9.0");
    expect(msi.install).toEqual({
      url: "https://nodejs.org/dist/v24.9.0/node-v24.9.0-x64.msi",
      sha256: H("a"),
    });
    const zip = await vendor.resolveFeed("FRIDAY Node", { fetchImpl: net.fetchImpl });
    expect(zip.version).toBe("22.23.3");
    expect(zip.install).toBeNull(); // no SHASUMS for that line in this fake: no install is offered
  });

  it("Go, Rust, VS Code and Temurin read their vendor documents", async () => {
    const net = network({
      "https://go.dev/dl/?mode=json": [
        {
          version: "go1.25.1",
          stable: true,
          files: [
            {
              filename: "go1.25.1.windows-amd64.msi",
              os: "windows",
              arch: "amd64",
              kind: "installer",
              sha256: H("c"),
              size: 99,
            },
          ],
        },
      ],
      "https://static.rust-lang.org/dist/channel-rust-stable.toml":
        '[pkg.cargo]\nversion = "0.1.0"\n[pkg.rust]\nversion = "1.90.0 (abc 2026-09-01)"\n',
      "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256": `${H("d")} *rustup-init.exe\n`,
      "https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest": {
        url: "https://vscode.download/VSCodeUserSetup-x64-1.104.0.exe",
        productVersion: "1.104.0",
        sha256hash: H("e"),
      },
      "https://api.adoptium.net/v3/assets/latest/21/hotspot": [
        {
          release_name: "jdk-21.0.8+9",
          version: { semver: "21.0.8+9" },
          binary: {
            installer: { link: "https://adoptium/x.msi", checksum: H("f"), size: 5 },
            package: { link: "https://adoptium/x.zip", checksum: H("1"), size: 6 },
          },
        },
      ],
    });
    const go = await vendor.resolveFeed("Go", { fetchImpl: net.fetchImpl });
    expect([go.version, go.install.sha256]).toEqual(["1.25.1", H("c")]);
    const rust = await vendor.resolveFeed("Rust", { fetchImpl: net.fetchImpl });
    expect(rust.version).toBe("1.90.0");
    expect(rust.install.sha256).toBe(H("d"));
    const code = await vendor.resolveFeed("Visual Studio Code", { fetchImpl: net.fetchImpl });
    expect(code.version).toBe("1.104.0");
    expect(code.install.sha256).toBe(H("e"));
    const jdk = await vendor.resolveFeed("OpenJDK (Temurin)", { fetchImpl: net.fetchImpl });
    expect([jdk.version, jdk.install.url]).toEqual(["21.0.8", "https://adoptium/x.msi"]);
    const zip = await vendor.resolveFeed("Temurin JDK zip", { fetchImpl: net.fetchImpl });
    expect(zip.bin).toBe("jdk-21.0.8+9/bin/java.exe");
    expect(zip.install.sha256).toBe(H("1"));
  });

  it("GitHub: uses the asset digest, and offers no install without one", async () => {
    const release = (digest: string | null) => ({
      tag_name: "v2.51.0.windows.1",
      assets: [
        {
          name: "Git-2.51.0-64-bit.exe",
          browser_download_url: "https://github.com/git.exe",
          size: 7,
          digest,
        },
        {
          name: "MinGit-2.51.0-64-bit.zip",
          browser_download_url: "https://github.com/mingit.zip",
          size: 3,
          digest,
        },
      ],
    });
    let digest: string | null = `sha256:${H("2")}`;
    const net = network({
      "https://api.github.com/repos/git-for-windows/git/releases/latest": () => release(digest),
    });
    const git = await vendor.resolveFeed("Git", { fetchImpl: net.fetchImpl, force: true });
    expect(git.version).toBe("2.51.0.windows.1");
    expect(git.install).toEqual({ url: "https://github.com/git.exe", sha256: H("2") });
    expect(git.installerArgs).toContain("/VERYSILENT");
    expect(
      (await vendor.resolveFeed("MinGit", { fetchImpl: net.fetchImpl, force: true })).bin,
    ).toBe("cmd/git.exe");
    digest = null;
    const bare = await vendor.resolveFeed("Git", { fetchImpl: net.fetchImpl, force: true });
    expect(bare.version).toBe("2.51.0.windows.1");
    expect(bare.install).toBeNull();
  });

  it("KoboldCpp: the executable and the digest GitHub published for it", async () => {
    const net = network({
      "https://api.github.com/repos/LostRuins/koboldcpp/releases/latest": {
        tag_name: "v1.124",
        assets: [
          {
            name: "koboldcpp.exe",
            browser_download_url: "https://github.com/k/koboldcpp.exe",
            size: 9,
            digest: `sha256:${H("7")}`,
          },
          {
            name: "koboldcpp_nocuda.exe",
            browser_download_url: "https://github.com/k/nocuda.exe",
            size: 8,
            digest: `sha256:${H("8")}`,
          },
        ],
      },
    });
    const kobold = await vendor.resolveFeed("KoboldCpp", { fetchImpl: net.fetchImpl });
    expect([kobold.version, kobold.bin, kobold.install.sha256]).toEqual([
      "1.124",
      "koboldcpp.exe",
      H("7"),
    ]);
  });

  it("GitHub: the public redirect keeps the version when the API is rate-limited", async () => {
    const fetchImpl = async (url: string) =>
      url.startsWith("https://api.github.com")
        ? json({ message: "rate limit" }, 403)
        : {
            ok: true,
            status: 200,
            url: "https://github.com/jgm/pandoc/releases/tag/3.8",
            json: async () => ({}),
            text: async () => "",
          };
    const pandoc = await vendor.resolveFeed("Pandoc", { fetchImpl, force: true });
    expect(pandoc.version).toBe("3.8");
    expect(pandoc.install).toBeNull();
  });

  it("a feed that does not answer is no answer, and answers are cached", async () => {
    const down = network({});
    expect(await vendor.resolveFeed("Go", { fetchImpl: down.fetchImpl })).toBeNull();
    expect(await vendor.resolveFeed("Not a tool")).toBeNull();
    const net = network({
      "https://go.dev/dl/?mode=json": [{ version: "go1.25.1", stable: true, files: [] }],
    });
    await vendor.resolveFeed("Go", { fetchImpl: net.fetchImpl, now: () => 0 });
    await vendor.resolveFeed("Go", { fetchImpl: net.fetchImpl, now: () => 1000 });
    expect(net.calls.length).toBe(1);
    await vendor.resolveFeed("Go", { fetchImpl: net.fetchImpl, now: () => 31 * 60 * 1000 });
    expect(net.calls.length).toBe(2);
  });
});

describe("winget upgrade table", () => {
  it("reads Id -> Available from the fixed-width columns", () => {
    const row = (name: string, id: string, version: string, available: string, source = "winget") =>
      `${name.padEnd(20)}${id.padEnd(28)}${version.padEnd(9)}${available.padEnd(10)}${source}`;
    const text = [
      row("Name", "Id", "Version", "Available", "Source"),
      "-".repeat(75),
      row("Git", "Git.Git", "2.50.0", "2.51.0"),
      row("Node.js", "OpenJS.NodeJS.LTS", "22.19.0", "24.9.0"),
      row("Visual Studio Code", "Microsoft.VisualStudioCode", "1.103.2", "1.104.0"),
      "3 upgrades available.",
    ].join("\n");
    const table = vendor.parseWingetUpgrade(text);
    expect(table["Git.Git"]).toBe("2.51.0");
    expect(table["OpenJS.NodeJS.LTS"]).toBe("24.9.0");
    expect(table["Microsoft.VisualStudioCode"]).toBe("1.104.0");
    expect(Object.keys(table)).toHaveLength(3);
  });

  it("an empty or unrelated output is an empty table", () => {
    expect(vendor.parseWingetUpgrade("")).toEqual({});
    expect(
      vendor.parseWingetUpgrade("No installed package found matching input criteria."),
    ).toEqual({});
  });
});
