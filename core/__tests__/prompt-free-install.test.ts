/**
 * Setup and Doctor run with nobody at the keyboard: no installer may wait for a
 * typed answer, Rust installs per user from the official rustup-init, and the
 * model downloads use several connections. No network here.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");

const download = require_(path.join(root, "electron/model-download.cjs"));
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));
const alt = require_(path.join(root, "electron/alt-package-managers.cjs"));
const toolchain = require_(path.join(root, "electron/toolchain.cjs"));

describe("installers never wait for a typed answer", () => {
  const source = read("electron/toolchain.cjs");

  it("closes stdin on every install command and every probe", () => {
    expect(source).toContain('stdio: ["ignore", "pipe", "pipe"]');
    expect(read("scripts/win-spawn.cjs")).toContain('stdio: ["ignore", "pipe", "pipe"]');
  });

  it("asks winget for its own source only, so the Store agreement prompt never appears", () => {
    const installs = source.match(/"--source",\n\s+"winget",/g) || [];
    expect(installs.length).toBeGreaterThanOrEqual(2);
  });

  it("skips Chocolatey unless FRIDAY is elevated, and says why", () => {
    expect(alt.needsAdmin("choco")).toBe(true);
    expect(alt.needsAdmin("scoop")).toBe(false);
    expect(source).toContain("alt.needsAdmin(manager) && !(await isElevated())");
    expect(source).toContain("needs administrator rights and FRIDAY is not elevated");
  });
});

describe("Rust installs without a prompt", () => {
  it("tries the official rustup-init first, per user, with -y", () => {
    const rust = toolchain.toolById("Rust");
    expect(rust.vendorFirst).toBe(true);
    expect(rust.requireCommand).toBe(true);
    const feed = read("electron/vendor-sources.cjs");
    expect(feed).toContain(
      'installerArgs: ["-y", "--default-toolchain", "stable", "--profile", "minimal"]',
    );
    expect(feed).toContain("rustup-init.exe");
    expect(read("electron/toolchain.cjs")).toContain(
      "(tool.release && fallback) || (tool.vendorFirst && vendorFeeds.hasFeed(tool.id))",
    );
  });

  it("finishes the job when winget only left the rustup-init launcher", () => {
    const source = read("electron/toolchain.cjs");
    expect(source).toContain('await which("rustup-init")');
    expect(source).toContain('["-y", "--default-toolchain", "stable", "--profile", "minimal"]');
    expect(source).toContain("process.env.CARGO_HOME");
  });
});

describe("model downloads use several connections", () => {
  it("splits files over a few tens of MB into chunks pulled by up to sixteen connections", () => {
    expect(download.SEGMENT_THRESHOLD).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(download.MAX_SEGMENTS).toBe(16);
    expect(download.PARALLEL_FILES).toBeGreaterThanOrEqual(2);
  });

  it("mapPool keeps the order, never exceeds the limit and stops on the first failure", async () => {
    let live = 0;
    let peak = 0;
    const out = await download.mapPool([1, 2, 3, 4, 5, 6], 3, async (n: number) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5 * (7 - n)));
      live -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(3);

    const started: number[] = [];
    await expect(
      download.mapPool([1, 2, 3, 4], 1, async (n: number) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  it("reports files that download together as one transfer that only goes forward", () => {
    const seen: { bytesDone: number; bytesTotal: number; percent: number }[] = [];
    // The repo listing gives both sizes before the first byte, so a tiny file finishing first is not 100%.
    const progress = download.combinedProgress(
      2,
      (event: (typeof seen)[number]) => seen.push(event),
      [1000, 3000],
    );
    const a = progress.forFile(0, "a.json");
    const b = progress.forFile(1, "b.bin");
    b({ bytesTotal: 3000, bytesDone: 600 });
    a({ bytesTotal: 1000, bytesDone: 1000, status: "downloaded" });
    b({ bytesTotal: 3000, bytesDone: 3000, status: "downloaded" });
    expect(seen.map((row) => row.bytesTotal)).toEqual([4000, 4000, 4000]);
    expect(seen.map((row) => row.percent)).toEqual([15, 40, 100]);
    expect(seen[1]?.bytesDone).toBe(1600);
  });

  it("downloads the setup models side by side and keeps the result order", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-parallel-"));
    try {
      let live = 0;
      let peak = 0;
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        platform: "linux",
        env: { CI: "", GITHUB_ACTIONS: "", FRIDAY_PREFETCH_PARALLEL: "3" },
        log: (line: string) => lines.push(line),
        download: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 15));
          live -= 1;
          return { ok: true, source: "stand-in" };
        },
      });
      expect(peak).toBe(3);
      expect(rows.map((row: { id: string }) => row.id)).toEqual(
        prefetch
          .prefetchPlan(dir, { CI: "", GITHUB_ACTIONS: "" }, "linux")
          .map((row: { id: string }) => row.id),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can be turned down to one at a time", () => {
    expect(prefetch.prefetchParallelism({ FRIDAY_PREFETCH_PARALLEL: "1" })).toBe(1);
    expect(prefetch.prefetchParallelism({})).toBe(1);
    expect(prefetch.prefetchParallelism({ FRIDAY_PREFETCH_PARALLEL: "99" })).toBe(4);
    expect(prefetch.prefetchParallelism({ FRIDAY_PREFETCH_PARALLEL: "nope" })).toBe(1);
  });
});
