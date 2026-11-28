/**
 * The wheelhouse lock keeps a 7-day age gate and PyPI mirror roads.
 *
 * Every pin must be at least MIN_PIN_AGE_DAYS old when the lock is written: the lock generator hands pip a cutoff,
 * records each file's upload time, refuses a younger file unless it is named with --allow-young (and records that),
 * and the plan rejects a lock that carries a younger file without that record. The build tries the pinned mirrors
 * after files.pythonhosted.org, and every candidate is still checked against the pinned SHA-256 and size.
 * A fixed clock and injected fetch and spawn make it independent of today's date and of the network.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");

type Wheel = {
  name: string;
  version: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  uploaded?: string;
  allowYoung?: boolean;
  tags: string[];
};
type Lock = {
  schema: number;
  checked: string;
  platform: string;
  index: string;
  requirements: string;
  pythonTags: string[];
  wheels: Wheel[];
};
type Mirror = { id: string; packages: string; simple: string };
const wheelhouse = require_("../../scripts/wheelhouse.cjs") as {
  uploadedCutoff: (now: Date) => string;
  buildLock: (input: Record<string, unknown>) => Lock;
  planWheelhouse: (lock: unknown) => { errors: string[] };
  resolveReport: (input: Record<string, unknown>) => unknown;
  pypiMirrors: (file?: string) => Mirror[];
  mirrorUrls: (url: string, mirrors: Mirror[]) => string[];
  stageWheelhouse: (options: Record<string, unknown>) => Promise<{ wheels: number }>;
  readLock: () => Lock;
};
const freshness = require_("../../scripts/pin-freshness.cjs") as {
  MIN_PIN_AGE_DAYS: number;
};

const NOW = new Date("2026-12-01T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const HOST = "https://files.pythonhosted.org/packages/aa/bb/";
const report = (rows: Array<[string, string, string, string]>) => ({
  install: rows.map(([name, version, filename, digest]) => ({
    metadata: { name, version },
    download_info: { url: `${HOST}${filename}`, archive_info: { hashes: { sha256: digest } } },
  })),
});
const pypiRow = (filename: string, digest: string, uploaded?: string) => ({
  urls: [
    {
      filename,
      size: 10,
      digests: { sha256: digest },
      ...(uploaded ? { upload_time_iso_8601: uploaded } : {}),
    },
  ],
});
const young = {
  reports: { cp312: report([["ctranslate2", "4.9.1", "ctranslate2-4.9.1-py3-none-any.whl", A]]) },
  pypi: {
    "ctranslate2==4.9.1": pypiRow("ctranslate2-4.9.1-py3-none-any.whl", A, ago(5)),
  },
};

describe("the shared pin age", () => {
  it("is seven days and sits beside the report-only grace period", () => {
    expect(freshness.MIN_PIN_AGE_DAYS).toBe(7);
  });

  it("hands pip a cutoff exactly seven days before the injected clock", () => {
    expect(wheelhouse.uploadedCutoff(NOW)).toBe("2026-11-24T12:00:00.000Z");
  });

  it("passes that cutoff to the resolver", () => {
    const seen: string[][] = [];
    const spawn = (_python: string, args: string[]) => {
      seen.push(args);
      return { status: 1 };
    };
    expect(() =>
      wheelhouse.resolveReport({
        python: "python",
        tag: "cp312",
        requirementsFile: "r.txt",
        spawn,
        now: NOW,
      }),
    ).toThrow(/could not resolve/);
    const args = seen[0]!;
    expect(args[args.indexOf("--uploaded-prior-to") + 1]).toBe("2026-11-24T12:00:00.000Z");
    // No cutoff at all when the caller lifts it for --allow-young.
    seen.length = 0;
    expect(() =>
      wheelhouse.resolveReport({
        python: "python",
        tag: "cp312",
        requirementsFile: "r.txt",
        spawn,
        now: NOW,
        uploadedPriorTo: null,
      }),
    ).toThrow();
    expect(seen[0]).not.toContain("--uploaded-prior-to");
  });
});

describe("the lock generator", () => {
  it("records the upload time of every file it pins", () => {
    const old = {
      reports: young.reports,
      pypi: { "ctranslate2==4.9.1": pypiRow("ctranslate2-4.9.1-py3-none-any.whl", A, ago(17)) },
    };
    const lock = wheelhouse.buildLock({ ...old, checked: "2026-12-01", now: NOW });
    expect(lock.wheels[0]!.uploaded).toBe(ago(17));
    expect(lock.wheels[0]!.allowYoung).toBeUndefined();
    expect(wheelhouse.planWheelhouse(lock).errors.filter((e) => /young|days/.test(e))).toEqual([]);
  });

  it("refuses a file younger than seven days", () => {
    expect(() => wheelhouse.buildLock({ ...young, checked: "2026-12-01", now: NOW })).toThrow(
      /ctranslate2-4\.9\.1.*younger than 7 days.*--allow-young ctranslate2/,
    );
  });

  it("takes a young file only when its package is named, and records that", () => {
    const lock = wheelhouse.buildLock({
      ...young,
      checked: "2026-12-01",
      now: NOW,
      allowYoung: ["CTranslate2"],
    });
    expect(lock.wheels[0]!.allowYoung).toBe(true);
    expect(lock.wheels[0]!.uploaded).toBe(ago(5));
    // A different package that is young is still refused.
    expect(() =>
      wheelhouse.buildLock({ ...young, checked: "2026-12-01", now: NOW, allowYoung: ["av"] }),
    ).toThrow(/younger than 7 days/);
  });

  it("refuses a file with no upload time unless --allow-young names it, and keeps schema 1", () => {
    const bare = {
      reports: young.reports,
      pypi: { "ctranslate2==4.9.1": pypiRow("ctranslate2-4.9.1-py3-none-any.whl", A) },
    };
    expect(() => wheelhouse.buildLock({ ...bare, checked: "2026-12-01", now: NOW })).toThrow(
      /no upload time/,
    );
    const lock = wheelhouse.buildLock({
      ...bare,
      checked: "2026-12-01",
      now: NOW,
      allowYoung: ["ctranslate2"],
    });
    expect(lock.schema).toBe(1);
    expect("uploaded" in lock.wheels[0]!).toBe(false);
    expect(lock.wheels[0]!.allowYoung).toBe(true);
  });
});

describe("the plan checks the recorded age", () => {
  const base = (): Lock => {
    const lock = wheelhouse.buildLock({
      reports: young.reports,
      pypi: { "ctranslate2==4.9.1": pypiRow("ctranslate2-4.9.1-py3-none-any.whl", A, ago(30)) },
      checked: "2026-12-01",
      now: NOW,
    });
    return lock;
  };

  it("rejects an entry uploaded within seven days of the lock date unless it is recorded as allowed", () => {
    const lock = base();
    lock.wheels[0]!.uploaded = "2026-11-28T10:00:00.000Z";
    expect(wheelhouse.planWheelhouse(lock).errors.join("\n")).toMatch(
      /ctranslate2-4\.9\.1.*younger than 7 days/,
    );
    lock.wheels[0]!.allowYoung = true;
    expect(wheelhouse.planWheelhouse(lock).errors.join("\n")).not.toMatch(/younger than 7 days/);
  });

  it("rejects an upload time that is not a time", () => {
    const lock = base();
    lock.wheels[0]!.uploaded = "yesterday";
    expect(wheelhouse.planWheelhouse(lock).errors.join("\n")).toMatch(/uploaded/);
  });

  it("holds for the committed lock: no pin is younger than seven days at its lock date", () => {
    const lock = wheelhouse.readLock();
    const limit = Date.parse(`${lock.checked}T23:59:59Z`) - 7 * DAY;
    const youngOnes = lock.wheels
      .filter((w) => w.uploaded && Date.parse(w.uploaded) > limit && !w.allowYoung)
      .map((w) => w.filename);
    expect(youngOnes).toEqual([]);
    expect(lock.wheels.filter((w) => !w.uploaded).map((w) => w.filename)).toEqual([]);
    expect(wheelhouse.planWheelhouse(lock).errors.filter((e) => /younger/.test(e))).toEqual([]);
  });

  it("re-pinned the wheels that were younger than seven days (av crossed the line the day it was locked)", () => {
    const lock = wheelhouse.readLock();
    const version = (name: string) => [
      ...new Set(lock.wheels.filter((w) => w.name === name).map((w) => w.version)),
    ];
    expect(version("ctranslate2")).toEqual(["4.9.0"]);
    for (const [name, bad] of [
      ["packaging", "26.4"],
      ["filelock", "4.3.1"],
      ["httpx", "0.29.0"],
      ["huggingface-hub", "2.5.0"],
    ] as const) {
      expect(version(name), name).not.toContain(bad);
      expect(version(name).length, name).toBe(1);
    }
  });
});

describe("the PyPI mirrors", () => {
  const mirrors = wheelhouse.pypiMirrors();
  const hosts = JSON.parse(readFileSync(path.join(ROOT, "config/download-hosts.json"), "utf8")) as {
    families: Array<{ id: string; hosts?: string[] }>;
    pathPrefixes: Record<string, string[]>;
  };

  it("are the five listed roads, in order, over https, each with a package base and a simple index", () => {
    expect(mirrors.map((m) => m.id)).toEqual(["tuna", "aliyun", "huaweicloud", "ustc", "tencent"]);
    for (const m of mirrors) {
      expect(new URL(m.packages).protocol).toBe("https:");
      expect(m.packages.endsWith("/packages")).toBe(true);
      expect(new URL(m.simple).protocol).toBe("https:");
      expect(m.simple.endsWith("/simple")).toBe(true);
    }
  });

  it("are allowlisted by host and confined to the package and index paths", () => {
    const family = hosts.families.find((f) => f.id === "pypimirrors");
    expect(family).toBeTruthy();
    for (const m of mirrors) {
      for (const base of [m.packages, m.simple]) {
        const url = new URL(base);
        expect(family!.hosts).toContain(url.hostname);
        const list = hosts.pathPrefixes[url.hostname] ?? [];
        expect(
          list.some((prefix) => `${url.pathname}/`.startsWith(prefix)),
          `${url.hostname}${url.pathname}`,
        ).toBe(true);
      }
    }
    // Only package and index folders, plus the named tool-download folders of the same mirror, never a whole host.
    const toolFolders = new Set(["/git-for-windows/", "/nodejs/", "/python/"]);
    for (const m of mirrors) {
      for (const prefix of hosts.pathPrefixes[new URL(m.packages).hostname] ?? []) {
        expect(
          /\/(packages|simple)\/$/.test(prefix) || toolFolders.has(prefix),
          `${m.id} ${prefix}`,
        ).toBe(true);
      }
    }
  });

  it("derive each mirror file url from the pinned PyPI one, keeping the content-addressed path", () => {
    const url = `${HOST}cc/dd/yarl-1.25.1-cp313-cp313-win_amd64.whl`;
    const urls = wheelhouse.mirrorUrls(url, mirrors);
    expect(urls.length).toBe(5);
    expect(urls[0]).toBe(
      "https://pypi.tuna.tsinghua.edu.cn/packages/aa/bb/cc/dd/yarl-1.25.1-cp313-cp313-win_amd64.whl",
    );
    expect(
      urls.every((u) => u.endsWith("/aa/bb/cc/dd/yarl-1.25.1-cp313-cp313-win_amd64.whl")),
    ).toBe(true);
    expect(wheelhouse.mirrorUrls("https://example.invalid/x.whl", mirrors)).toEqual([]);
  });
});

describe("staging falls back to a mirror and still checks every byte", () => {
  const filename = "fastapi-0.165.0-py3-none-any.whl";
  const body = Buffer.from("fastapi wheel body");
  const lock = (): Lock => ({
    schema: 1,
    checked: "2026-12-01",
    platform: "win_amd64",
    index: "https://pypi.org/simple",
    requirements: "kernel/requirements.txt",
    pythonTags: ["cp312"],
    wheels: [
      {
        name: "fastapi",
        version: "0.165.0",
        filename,
        url: `${HOST}${filename}`,
        sha256: sha(body),
        bytes: body.length,
        tags: ["cp312"],
      },
    ],
  });
  const dirs = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-wheel-age-"));
    made.push(dir);
    return { cacheDir: path.join(dir, "cache"), stageDir: path.join(dir, "out") };
  };

  it("hands the downloader the mirrors in pack.mirrors and takes the first road that answers", async () => {
    const seen: Array<{ url: string; mirrors: string[] | undefined }> = [];
    const fetchImpl = async (url: string, opts: { pack: { mirrors?: string[] } }) => {
      seen.push({ url, mirrors: opts.pack.mirrors });
      if (url.startsWith("https://files.pythonhosted.org/")) throw new Error("ECONNRESET");
      return { body };
    };
    const staged = await wheelhouse.stageWheelhouse({ lock: lock(), ...dirs(), fetchImpl });
    expect(staged.wheels).toBe(1);
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual([
      "files.pythonhosted.org",
      "pypi.tuna.tsinghua.edu.cn",
    ]);
    expect(seen[0]!.mirrors!.length).toBe(5);
  });

  it("rejects a mirror that serves other bytes and moves on to the next", async () => {
    const fetchImpl = async (url: string) => {
      if (url.startsWith("https://files.pythonhosted.org/")) throw new Error("down");
      if (url.includes("tsinghua")) return { body: Buffer.from("tampered bytes!!!!!") };
      return { body };
    };
    const staged = await wheelhouse.stageWheelhouse({ lock: lock(), ...dirs(), fetchImpl });
    expect(staged.wheels).toBe(1);
  });

  it("fails with the hash error when every road served the wrong bytes, and with a download error when none answered", async () => {
    const wrong = async () => ({ body: Buffer.from("not the pinned bytes") });
    await expect(
      wheelhouse.stageWheelhouse({ lock: lock(), ...dirs(), fetchImpl: wrong }),
    ).rejects.toMatchObject({ errors: ["sha256"] });
    const dead = async () => {
      throw new Error("offline");
    };
    await expect(
      wheelhouse.stageWheelhouse({ lock: lock(), ...dirs(), fetchImpl: dead }),
    ).rejects.toMatchObject({ errors: ["download"] });
  });
});
