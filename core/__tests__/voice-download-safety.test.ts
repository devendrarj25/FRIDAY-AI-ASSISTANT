/**
 * The downloader never replaces a working model with an unverified one, checks the disk before a big
 * download, quarantines unexpected files, keeps the previous verified revision as `<id>.prev` and puts it back
 * when the new one fails. Loopback server and a faked fetch only: no network, no real weights.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
type Pin = { revision: string; files: Record<string, { sha256: string; bytes: number }> };
const download = require_("../../electron/model-download.cjs") as {
  downloadUrl: (url: string, dest: string, options?: Record<string, unknown>) => Promise<number>;
  downloadModel: (
    job: unknown,
    onEvent?: (event: Record<string, unknown>) => void,
    signal?: AbortSignal,
    deps?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string; cause?: string; path?: string }>;
};
const pins = require_("../../electron/voice-pins.cjs") as {
  MARKER: string;
  writeMarker: (dir: string, repo: string, pin: Pin) => boolean;
  readMarker: (dir: string) => { revision: string } | null;
  previousInfo: (dir: string) => { exists: boolean; revision: string };
  rollbackToPrevious: (dir: string) => { ok: boolean; revision: string; error: string };
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-dls-"));
  roots.push(dir);
  return dir;
};
let server: Server | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  server?.close();
  server = null;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("the failure the owner reads", () => {
  const install = require_("../../electron/voice-install.cjs") as {
    classifyDownloadError: (text: string) => { cause: string; line: string };
  };

  it("a disk shortage names the numbers; the plain old wording still reads 'disk full'", () => {
    const rich = install.classifyDownloadError(
      "disk full: not enough disk space: 1300 bytes are needed (1.3 times the 1000-byte download), 5 bytes are free",
    );
    expect(rich.cause).toBe("disk");
    expect(rich.line).toMatch(/1300 bytes are needed/);
    expect(rich.line).toMatch(/5 bytes are free/);
    expect(install.classifyDownloadError("ENOSPC: no space left")).toEqual({
      cause: "disk",
      line: "disk full",
    });
  });
});

describe("pause, cancel and retry keep their wording and their partial file", () => {
  const install = require_("../../electron/voice-install.cjs") as {
    classifyDownloadError: (text: string) => { cause: string; line: string };
  };
  const table: [string, string, RegExp][] = [
    ["cancelled", "cancel", /partial file can resume/],
    ["the download timed out (ETIMEDOUT)", "timeout", /Resume keeps the partial file/],
    ["checksum mismatch for model.bin", "checksum", /checksum mismatch/],
    ["fetch failed: ECONNREFUSED", "offline", /offline/],
    ["EACCES: permission denied", "path", /could not be written/],
    ["401 Unauthorized", "hf-auth", /token already on this PC/],
  ];
  for (const [text, cause, line] of table) {
    it(`"${text}" is ${cause}`, () => {
      const got = install.classifyDownloadError(text);
      expect(got.cause).toBe(cause);
      expect(got.line).toMatch(line);
    });
  }
});

describe("a file is verified before it replaces a working one", () => {
  it("keeps the working file when the new bytes fail their SHA-256", async () => {
    const body = Buffer.from("not-the-pinned-bytes");
    server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": body.length });
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const dir = temp();
    const dest = path.join(dir, "model.bin");
    fs.writeFileSync(dest, "working-model");
    await expect(
      download.downloadUrl(`http://127.0.0.1:${port}/model.bin`, dest, {
        sha256: sha("the-pinned-bytes"),
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(fs.readFileSync(dest, "utf8")).toBe("working-model");
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });
});

describe("a pinned repository download is folder-safe", () => {
  const v1 = { "config.json": "{}", "model.bin": "weights-v1", "tok.json": "tok" };
  const v2 = { "config.json": "{}", "model.bin": "weights-v2!", "tok.json": "tok" };
  const repo = "test/pinned-voice";
  const pinOf = (content: Record<string, string>, revision: string): Pin => ({
    revision,
    files: Object.fromEntries(
      Object.entries(content).map(([name, text]) => [
        name,
        { sha256: sha(text), bytes: text.length },
      ]),
    ),
  });
  const REV1 = "a".repeat(40);
  const REV2 = "b".repeat(40);

  function serve(content: Record<string, string>, listed = Object.keys(content)) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: { method?: string } = {}) => {
        const url = String(input);
        if (url.includes("/api/models/")) {
          return new Response(
            JSON.stringify({ siblings: listed.map((name) => ({ rfilename: name })) }),
            {
              status: 200,
            },
          );
        }
        const name = decodeURIComponent(
          url.split("/resolve/")[1]!.split("/").slice(1).join("/").split("?")[0]!,
        );
        const text = content[name] ?? "";
        if (init.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(text.length) },
          });
        }
        return new Response(text, {
          status: 200,
          headers: { "content-length": String(text.length) },
        });
      }),
    );
  }
  const depsFor = (pin: Pin, extra: Record<string, unknown> = {}) => ({
    pinForRepo: (name: string) => (name === repo ? pin : null),
    hub: { engineMode: () => "own", isBroken: () => false },
    ...extra,
  });
  const job = (dir: string) => ({
    modelId: "pinned-voice",
    dir,
    sources: [{ kind: "hf-repo", repo, label: "test" }],
  });
  const lay = (dir: string, content: Record<string, string>) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(content))
      fs.writeFileSync(path.join(dir, name), text);
  };

  it("refuses to start when the disk has less than 1.3 times the download free, with the honest error", async () => {
    serve(v1);
    const dir = temp();
    const events: string[] = [];
    const result = await download.downloadModel(
      job(dir),
      (event) => events.push(String(event["status"] || "")),
      undefined,
      depsFor(pinOf(v1, REV1), {
        statfs: () => ({ bavail: 5, bsize: 1 }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("disk");
    expect(result.error).toMatch(/not enough disk space: \d+ bytes are needed .* 5 bytes are free/);
    expect(events.join("\n")).toMatch(/not enough disk space/i);
    expect(fs.existsSync(path.join(dir, "pinned-voice", "model.bin"))).toBe(false);
  });

  it("writes the verification marker after a good install and quarantines files the pin does not list", async () => {
    serve(v1);
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, { "README.md": "stray", "payload.dll": "MZ" });
    const root = temp();
    const result = await download.downloadModel(
      job(dir),
      () => {},
      undefined,
      depsFor(pinOf(v1, REV1), { quarantineRoot: root }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.readdirSync(target).sort()).toEqual(
      [pins.MARKER, "config.json", "model.bin", "tok.json"].sort(),
    );
    expect(pins.readMarker(target)?.revision).toBe(REV1);
    const kept = fs.readdirSync(root);
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(root, kept[0]!, "payload.dll"), "utf8")).toBe("MZ");
  });

  it("keeps the previous verified revision as .prev when the pinned revision changes", async () => {
    serve(v2);
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, v1);
    pins.writeMarker(target, repo, pinOf(v1, REV1));
    const events: string[] = [];
    const result = await download.downloadModel(
      job(dir),
      (event) => events.push(String(event["status"] || "")),
      undefined,
      depsFor(pinOf(v2, REV2)),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v2!");
    expect(pins.readMarker(target)?.revision).toBe(REV2);
    expect(fs.readFileSync(path.join(`${target}.prev`, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.previousInfo(target)).toMatchObject({ exists: true, revision: REV1 });
    expect(events.join("\n")).toMatch(/kept the previous verified revision/i);
  });

  it("restores the previous revision when the new one does not verify", async () => {
    serve({ ...v2, "model.bin": "tampered!!!" }); // same size as the pin, wrong bytes
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, v1);
    pins.writeMarker(target, repo, pinOf(v1, REV1));
    const result = await download.downloadModel(
      job(dir),
      () => {},
      undefined,
      depsFor(pinOf(v2, REV2)),
    );
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.readMarker(target)?.revision).toBe(REV1);
    expect(fs.existsSync(`${target}.prev`)).toBe(false);
  });

  it("says so, with the reason and where the old copy is, when the previous revision cannot be restored", async () => {
    serve({ ...v2, "model.bin": "tampered!!!" });
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, v1);
    pins.writeMarker(target, repo, pinOf(v1, REV1));
    const rollback = vi
      .spyOn(pins, "rollbackToPrevious")
      .mockReturnValue({ ok: false, revision: REV1, error: "EBUSY: resource busy" });
    const events: string[] = [];
    try {
      const result = await download.downloadModel(
        job(dir),
        (event) => events.push(String(event["status"] || "")),
        undefined,
        depsFor(pinOf(v2, REV2)),
      );
      expect(result.ok).toBe(false);
      expect(rollback).toHaveBeenCalledTimes(1);
    } finally {
      rollback.mockRestore();
    }
    const line = events.find((text) => /could not restore/i.test(text)) || "";
    expect(line).toMatch(/EBUSY: resource busy/);
    expect(line).toContain("pinned-voice.prev");
  });

  /** A fetch that answers the listing and the sizes, then holds the model file until the caller aborts. */
  function serveThenHang(content: Record<string, string>, onHang: () => void) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: { method?: string; signal?: AbortSignal } = {}) => {
        const url = String(input);
        if (url.includes("/api/models/")) {
          return new Response(
            JSON.stringify({ siblings: Object.keys(content).map((name) => ({ rfilename: name })) }),
            { status: 200 },
          );
        }
        const name = decodeURIComponent(
          url.split("/resolve/")[1]!.split("/").slice(1).join("/").split("?")[0]!,
        );
        const text = content[name] ?? "";
        if (init.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(text.length) },
          });
        }
        if (name !== "model.bin") {
          return new Response(text, {
            status: 200,
            headers: { "content-length": String(text.length) },
          });
        }
        onHang();
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );
  }

  it("cancel while the new revision downloads puts the previous verified revision back", async () => {
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, v1);
    pins.writeMarker(target, repo, pinOf(v1, REV1));
    const controller = new AbortController();
    serveThenHang(v2, () => setTimeout(() => controller.abort("cancel"), 20));
    const result = await download.downloadModel(
      job(dir),
      () => {},
      controller.signal,
      depsFor(pinOf(v2, REV2)),
    );
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("cancel");
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.readMarker(target)?.revision).toBe(REV1);
    expect(fs.existsSync(`${target}.prev`)).toBe(false);
  });

  it("pause keeps the working revision as .prev and the new folder to carry on from", async () => {
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, v1);
    pins.writeMarker(target, repo, pinOf(v1, REV1));
    const controller = new AbortController();
    serveThenHang(v2, () => setTimeout(() => controller.abort("pause"), 20));
    const result = await download.downloadModel(
      job(dir),
      () => {},
      controller.signal,
      depsFor(pinOf(v2, REV2)),
    );
    expect(result).toMatchObject({ ok: false, cause: "pause" });
    expect(fs.readFileSync(path.join(`${target}.prev`, "model.bin"), "utf8")).toBe("weights-v1");
    expect(fs.existsSync(path.join(target, "config.json"))).toBe(true); // the seeded and fetched files stay
    // Resuming finishes the new revision and keeps the previous one.
    serve(v2);
    const again = await download.downloadModel(
      job(dir),
      () => {},
      undefined,
      depsFor(pinOf(v2, REV2)),
    );
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v2!");
    expect(pins.readMarker(target)?.revision).toBe(REV2);
    expect(fs.existsSync(`${target}.prev`)).toBe(true);
  });

  it("a folder with no marker keeps today's repair: only the bad file is replaced, no .prev", async () => {
    serve(v1);
    const dir = temp();
    const target = path.join(dir, "pinned-voice");
    lay(target, { ...v1, "model.bin": "weigh" });
    const result = await download.downloadModel(
      job(dir),
      () => {},
      undefined,
      depsFor(pinOf(v1, REV1)),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(fs.readFileSync(path.join(target, "model.bin"), "utf8")).toBe("weights-v1");
    expect(fs.existsSync(`${target}.prev`)).toBe(false);
  });
});

describe("a record that cannot be true never certifies a folder", () => {
  const files = { "config.json": "{}", "model.bin": "weights-v1", "tok.json": "tok" };
  const REV = "c".repeat(40);
  const pin: Pin = {
    revision: REV,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [
        name,
        { sha256: sha(text), bytes: text.length },
      ]),
    ),
  };
  const audit = download as unknown as {
    auditPinnedFolder: (
      dest: string,
      pin: Pin,
      deps?: { now?: () => Date },
    ) => Promise<{ ok: boolean; hashed?: boolean }>;
  };
  const writeMarkerAt = (dir: string, verifiedAt: string) => {
    pins.writeMarker(dir, "test/pinned-voice", pin);
    const file = path.join(dir, pins.MARKER);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...record, verifiedAt }));
  };
  const folder = (tampered: boolean) => {
    const dir = temp();
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    if (tampered) fs.writeFileSync(path.join(dir, "model.bin"), "weights-v9");
    return dir;
  };

  it("a record dated in the future is not trusted: every file is hashed and the same-size bad file fails", async () => {
    const dir = folder(true);
    writeMarkerAt(dir, "2100-01-01T00:00:00.000Z");
    const result = await audit.auditPinnedFolder(dir, pin, { now: () => new Date() });
    expect(result.hashed).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("a record whose time is not a timestamp is not trusted either", async () => {
    const dir = folder(true);
    writeMarkerAt(dir, "not-a-time");
    const result = await audit.auditPinnedFolder(dir, pin);
    expect(result.hashed).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("a fresh record on an untouched folder still certifies without hashing", async () => {
    const dir = folder(false);
    writeMarkerAt(dir, new Date(Date.now() + 1000).toISOString());
    const result = await audit.auditPinnedFolder(dir, pin);
    expect(result.ok).toBe(true);
    expect(result.hashed).toBeFalsy();
  });
});
