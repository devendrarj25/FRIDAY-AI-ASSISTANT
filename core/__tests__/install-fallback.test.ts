/**
 * An install that does not come from winget: the vendor's official feed names
 * the installer and its SHA-256, the downloader fetches it (following the
 * vendor's CDN redirect), the digest is checked, the archive is unpacked, the
 * tool is recorded and put on PATH. A wrong digest installs nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));
const vendor = require_(path.join(root, "electron/vendor-sources.cjs"));
const installs = require_(path.join(root, "electron/managed-install.cjs"));
const undici = require_("undici");

/** A zip with a central directory; `descriptor` writes sizes after the data, as many vendors do. */
function makeZip(files: Record<string, string>, descriptor = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const flags = descriptor ? 0x8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(descriptor ? 0 : data.length, 18);
    local.writeUInt32LE(descriptor ? 0 : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const chunk = Buffer.concat([local, nameBuf, data]);
    locals.push(chunk);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += chunk.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const zip = makeZip({ "cmd/git.exe": "echo git", "README.txt": "hello" }, true);

const CDN = "https://objects.githubusercontent.com/mingit-2.99.0.zip";
const ASSET =
  "https://github.com/git-for-windows/git/releases/download/v2.99.0.windows.1/MinGit-2.99.0-64-bit.zip";
let digest = sha(zip);
let feedDown = false;

const realUndici = undici.fetch;
const realFetch = globalThis.fetch;
let tmp = "";

beforeAll(() => {
  undici.fetch = async (url: string) => {
    if (feedDown) throw new Error("network down");
    if (
      String(url).startsWith("https://api.github.com/repos/git-for-windows/git/releases/latest")
    ) {
      const body = {
        tag_name: "v2.99.0.windows.1",
        assets: [
          {
            name: "MinGit-2.99.0-64-bit.zip",
            browser_download_url: ASSET,
            size: zip.length,
            digest: `sha256:${digest}`,
          },
        ],
      };
      return {
        ok: true,
        status: 200,
        url: "",
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    return { ok: false, status: 404, url: "", json: async () => ({}), text: async () => "" };
  };
  // The download itself: the vendor URL redirects to a CDN host, then serves the bytes.
  globalThis.fetch = (async (url: string, init: { method?: string } = {}) => {
    const u = String(url);
    if (u === ASSET) return new Response(null, { status: 302, headers: { location: CDN } });
    if (u === CDN) {
      return init.method === "HEAD"
        ? new Response(null, {
            status: 200,
            headers: { "content-length": String(zip.length), "accept-ranges": "none" },
          })
        : new Response(new Uint8Array(zip), {
            status: 200,
            headers: { "content-length": String(zip.length) },
          });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  tmp = mkdtempSync(path.join(tmpdir(), "friday-install-"));
});
afterAll(() => {
  undici.fetch = realUndici;
  globalThis.fetch = realFetch;
  rmSync(tmp, { recursive: true, force: true });
});

type Event = { phase?: string; line?: string; error?: string; ok?: boolean };
async function install(id: string) {
  const events: Event[] = [];
  vendor.clearFeedCache();
  const result = await toolchain.runJob({ id, action: "install", root: tmp }, (e: Event) =>
    events.push(e),
  );
  return { result, events, text: events.map((e) => e.line || e.error || "").join("\n") };
}

describe("official-feed install", () => {
  it("takes the vendor's installer, checks its digest, unpacks, records and exposes it", async () => {
    const { result, text, events } = await install("MinGit");
    expect(text).toContain("newest official release is 2.99.0.windows.1");
    expect(result.ok, text).toBe(true);
    expect(events.at(-1)?.phase).toBe("Done");
    const found = installs.installedBin(
      tmp,
      toolchain.TOOLS.find((t: { id: string }) => t.id === "MinGit"),
    );
    expect(found.version).toBe("2.99.0.windows.1");
    expect(existsSync(found.bin)).toBe(true);
    const scan = await toolchain.detectTools({ force: true, root: tmp });
    const row = scan.tools.find((t: { id: string }) => t.id === "MinGit");
    expect([row.installed, row.version]).toEqual([true, "2.99.0.windows.1"]);
    const managed = toolchain.applyManagedPath(tmp);
    expect(managed.dirs).toContain(path.dirname(found.bin));
  }, 120_000);

  it("refuses a file whose digest is not the one the vendor published", async () => {
    rmSync(path.join(tmp, "runtime"), { recursive: true, force: true });
    rmSync(path.join(tmp, "downloads"), { recursive: true, force: true });
    digest = "0".repeat(64);
    try {
      const { result, text } = await install("MinGit");
      expect(result.ok).toBe(false);
      expect(text).toMatch(/hash|sha|did not match|failed/i);
      expect(existsSync(path.join(tmp, "runtime", "MinGit", "cmd", "git.exe"))).toBe(false);
    } finally {
      digest = sha(zip);
    }
  }, 120_000);

  it("with the feed down the pinned release is tried, and a file that is not the pin is refused", async () => {
    rmSync(path.join(tmp, "runtime"), { recursive: true, force: true });
    feedDown = true;
    try {
      const { result, text } = await install("MinGit");
      expect(text).not.toContain("newest official release");
      expect(result.ok).toBe(false);
      expect(existsSync(path.join(tmp, "runtime", "MinGit", "cmd", "git.exe"))).toBe(false);
    } finally {
      feedDown = false;
    }
  }, 120_000);

  it("reads a zip whose sizes sit in a data descriptor", () => {
    const out = mkdtempSync(path.join(tmpdir(), "friday-zip-"));
    const file = path.join(out, "a.zip");
    require_("node:fs").writeFileSync(
      file,
      makeZip({ "bin/tool.exe": "payload", "docs/a.txt": "x" }, true),
    );
    toolchain.extractZip(file, path.join(out, "x"));
    expect(require_("node:fs").readFileSync(path.join(out, "x", "bin", "tool.exe"), "utf8")).toBe(
      "payload",
    );
    rmSync(out, { recursive: true, force: true });
  });
});
