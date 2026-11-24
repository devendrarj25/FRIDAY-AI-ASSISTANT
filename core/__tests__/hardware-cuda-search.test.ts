import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require_ = createRequire(import.meta.url);
type Rec = Record<string, unknown>;
const hw = require_("../../electron/hardware.cjs") as {
  findCudaRuntimeFiles: (options: Rec) => Promise<Rec>;
  detectCapabilities: (options: Rec) => Promise<{ cuda: Rec } | null>;
  createCapabilityCache: () => unknown;
};
const NOW = 1_800_000_000_000;
const CUBLAS = "cublas64_12.dll";
const CUDNN = "cudnn64_9.dll";

afterEach(() => {
  vi.useRealTimers();
});

/** A fake file system that records every stat and how many are unanswered at once. */
function fakeFs(files: string[], opts: { delayMs?: number; hang?: (p: string) => boolean } = {}) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const stats: string[] = [];
  const live = { now: 0, peak: 0 };
  return {
    stats,
    live,
    stat: (target: string) => {
      stats.push(target);
      if (opts.hang?.(target)) return new Promise(() => undefined);
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          live.now -= 1;
          if (set.has(target.toLowerCase())) resolve({ isFile: () => true });
          else reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        }, opts.delayMs ?? 0);
      });
    },
    readdir: () => Promise.resolve([] as string[]),
    readFile: () => Promise.reject(new Error("ENOENT")),
  };
}

const win = (path: string[], extra: Rec = {}) => ({
  platform: "win32",
  env: { SystemRoot: "C:\\Windows", PATH: path.join(";") },
  ...extra,
});
const dirsOf = (fsApi: { stats: string[] }) => [
  ...new Set(fsApi.stats.map((p) => p.slice(0, p.lastIndexOf("\\")))),
];

describe("CUDA file search: local folders only, bounded, cached", () => {
  it("never stats a UNC folder, with or without a local-drive list", async () => {
    for (const localDrives of [null, ["C:", "D:"]]) {
      const fsApi = fakeFs([]);
      await hw.findCudaRuntimeFiles({
        ...win(["\\\\nas\\tools\\bin", "//nas/share/bin", "\\\\?\\UNC\\nas\\x", "C:\\Tools"]),
        fsApi,
        localDrives,
      });
      expect(fsApi.stats.some((p) => /^[\\/]{2}/.test(p))).toBe(false);
      expect(dirsOf(fsApi)).toContain("C:\\Tools");
    }
  });

  it("searches only the drives the storage probe called local, plus the Windows drive and the FRIDAY environment", async () => {
    const fsApi = fakeFs([]);
    await hw.findCudaRuntimeFiles({
      ...win(["C:\\a", "E:\\mapped", "D:\\b", "z:\\net"]),
      venvRoots: ["F:\\FRIDAY\\runtime\\.venv"],
      fsApi,
      localDrives: ["C:", "D:"],
    });
    const drives = new Set(fsApi.stats.map((p) => p.slice(0, 2).toUpperCase()));
    expect([...drives].sort()).toEqual(["C:", "D:", "F:"]);
    // With the list unknown, only the Windows drive and the environment's drive are trusted.
    const unknown = fakeFs([]);
    await hw.findCudaRuntimeFiles({
      ...win(["C:\\a", "E:\\mapped", "D:\\b"]),
      venvRoots: ["F:\\v"],
      fsApi: unknown,
    });
    expect([...new Set(unknown.stats.map((p) => p.slice(0, 2).toUpperCase()))].sort()).toEqual([
      "C:",
      "F:",
    ]);
  });

  it("never has more than 4 stats unanswered at once, and keeps the answers of local folders", async () => {
    const dirs = Array.from({ length: 30 }, (_, i) => `C:\\p${i}`);
    const fsApi = fakeFs([`C:\\p7\\${CUBLAS}`, `C:\\p20\\${CUDNN}`], { delayMs: 5 });
    const found = await hw.findCudaRuntimeFiles({ ...win(dirs), fsApi, localDrives: ["C:"] });
    expect(fsApi.live.peak).toBeLessThanOrEqual(4);
    expect(fsApi.live.peak).toBeGreaterThan(1);
    expect(found).toMatchObject({ cublas12: true, cudnn9: true, runtimeFilesFound: true });
    expect(found["dllDirs"]).toEqual(["C:\\p7", "C:\\p20"]);
  });

  it("looks in at most 40 folders, de-duplicated case-insensitively, and keeps System32 and CUDA_PATH", async () => {
    const dirs = [
      ...Array.from({ length: 100 }, (_, i) => `C:\\p${i}`),
      "c:\\P1\\",
      "C:\\WINDOWS\\system32",
    ];
    const fsApi = fakeFs([`C:\\Tools\\CUDA\\bin\\${CUBLAS}`]);
    const found = await hw.findCudaRuntimeFiles({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", PATH: dirs.join(";"), CUDA_PATH: "C:\\Tools\\CUDA" },
      fsApi,
      localDrives: ["C:"],
    });
    const searched = dirsOf(fsApi).map((d) => d.toLowerCase());
    expect(searched.length).toBeLessThanOrEqual(40);
    expect(new Set(searched).size).toBe(searched.length);
    expect(searched).toContain("c:\\windows\\system32");
    expect(searched).toContain("c:\\tools\\cuda\\lib64");
    expect(found["cublas12"]).toBe(true);
    expect(fsApi.stats.filter((p) => /\\p1\\cublas/i.test(p))).toHaveLength(1);
  });

  it("a drive whose stat hangs is given up after the first timeouts: the pool is not held and other drives are searched", async () => {
    vi.useFakeTimers();
    const dirs = [...Array.from({ length: 30 }, (_, i) => `D:\\dead${i}`), `C:\\Good`];
    const fsApi = fakeFs([`C:\\Good\\${CUBLAS}`, `C:\\Good\\${CUDNN}`], {
      hang: (p) => p.toUpperCase().startsWith("D:"),
    });
    const job = hw.findCudaRuntimeFiles({
      ...win(dirs),
      fsApi,
      localDrives: ["C:", "D:"],
      totalMs: 6000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await job).toMatchObject({ cublas12: true, cudnn9: true, runtimeFilesFound: true });
    // Only the 4 workers' first stats were ever sent into the dead drive; the other 56 were skipped.
    expect(fsApi.stats.filter((p) => p.startsWith("D:"))).toHaveLength(4);
  });

  it("when the whole search times out the workers stop starting stats", async () => {
    vi.useFakeTimers();
    const dirs = Array.from({ length: 30 }, (_, i) => `C:\\h${i}`);
    const fsApi = fakeFs([], { hang: () => true });
    const job = hw.findCudaRuntimeFiles({ ...win(dirs), fsApi, localDrives: ["C:"], totalMs: 100 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await job).toMatchObject({ cublas12: null, runtimeFilesFound: null });
    const sent = fsApi.stats.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fsApi.stats.length).toBe(sent);
  });

  describe("the result is kept 10 minutes", () => {
    const shell = (letters: string[] = ["C:"]) => ({
      run: (script: string) =>
        Promise.resolve({
          ok: true,
          stdout: script.includes("Win32_OperatingSystem")
            ? "{}"
            : JSON.stringify({
                storage: letters.map((letter) => ({ letter, media: "SSD", bus: "NVMe" })),
              }),
          error: null,
        }),
    });
    const options = (fsApi: unknown, cache: unknown, now: number, extra: Rec = {}) => ({
      platform: "win32",
      os: { release: () => "10.0.22631", arch: () => "x64" },
      env: { SystemRoot: "C:\\Windows", PATH: "C:\\Tools" },
      fsApi,
      runPowerShell: shell(extra["letters"] as string[] | undefined).run,
      now: () => now,
      root: "C:\\FRIDAY",
      cache,
      ...extra,
    });

    it("is searched once inside 10 minutes, again after, and at once when PATH changed", async () => {
      const cache = hw.createCapabilityCache();
      const fsApi = fakeFs([]);
      await hw.detectCapabilities(options(fsApi, cache, NOW));
      const first = fsApi.stats.length;
      expect(first).toBeGreaterThan(0);
      // 2 minutes later: the 20 s group is read again, the CUDA files are not.
      await hw.detectCapabilities(options(fsApi, cache, NOW + 120_000));
      expect(fsApi.stats.length).toBe(first);
      await hw.detectCapabilities(options(fsApi, cache, NOW + 9 * 60_000));
      expect(fsApi.stats.length).toBe(first);
      await hw.detectCapabilities(options(fsApi, cache, NOW + 10 * 60_000 + 1));
      expect(fsApi.stats.length).toBe(first * 2);
      const changed = {
        env: { SystemRoot: "C:\\Windows", PATH: "C:\\Tools;C:\\New" },
      };
      await hw.detectCapabilities(options(fsApi, cache, NOW + 10 * 60_000 + 25_000, changed));
      expect(fsApi.stats.length).toBeGreaterThan(first * 2);
    });

    it("a search that timed out is retried within a minute, not after ten", async () => {
      vi.useFakeTimers();
      const cache = hw.createCapabilityCache();
      // Twenty dead drives, one folder each: they give up two at a time, 1.5 s each, which is longer than the 6 s total.
      const letters = Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(67 + i)}:`);
      const env = { SystemRoot: "C:\\Windows", PATH: letters.map((l) => `${l}\\t`).join(";") };
      const hung = fakeFs([], { hang: () => true });
      const job = hw.detectCapabilities(options(hung, cache, NOW, { env, letters }));
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await job)?.cuda).toMatchObject({ runtimeFilesFound: null });
      const sent = hung.stats.length;
      const soon = hw.detectCapabilities(options(hung, cache, NOW + 30_000, { env, letters }));
      await vi.advanceTimersByTimeAsync(40_000);
      await soon;
      expect(hung.stats.length).toBe(sent);
      const later = hw.detectCapabilities(options(hung, cache, NOW + 61_000, { env, letters }));
      await vi.advanceTimersByTimeAsync(40_000);
      await later;
      expect(hung.stats.length).toBeGreaterThan(sent);
    });
  });

  it("keeps looking for the same files, in the same places, as kernel/stt.py", () => {
    const stt = readFileSync(new URL("../../kernel/stt.py", import.meta.url), "utf8");
    expect(stt).toContain('("cublas64_12.dll", "cudnn64_9.dll")');
    expect(stt).toContain('("PATH", "LD_LIBRARY_PATH")');
    expect(stt).toContain('Path(cuda) / "bin"');
    const ours = readFileSync(new URL("../../electron/hardware.cjs", import.meta.url), "utf8");
    expect(ours).toContain('cublas: "cublas64_12.dll"');
    expect(ours).toContain('cudnn: "cudnn64_9.dll"');
    expect(ours).toMatch(/for \(const key of \["PATH", "LD_LIBRARY_PATH"\]\)/);
    expect(ours).toContain("CUDA_MAX_DIRS = 40");
    expect(ours).toContain("CUDA_STAT_CONCURRENCY = 4");
  });
});
