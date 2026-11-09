import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const llama = require_(path.join(root, "electron/llama-runtime.cjs"));
const prefetch = require_(path.join(root, "scripts/prefetch-models.cjs"));
const runners = require_(path.join(root, "config/local-runners.json"));

const quiet = {
  CI: "",
  GITHUB_ACTIONS: "",
  FRIDAY_SETUP_UPDATE: "0",
  FRIDAY_PREFETCH_MOONSHINE: "0",
  // llama.cpp is not part of setup by default; these tests describe the opted-in case.
  FRIDAY_PREFETCH_LLAMACPP: "1",
};
const win = "win32";
const tmp = () => mkdtempSync(path.join(tmpdir(), "friday-llama-"));
const python = process.env["FRIDAY_PYTHON"] || "python3";
const serverName = process.platform === "win32" ? "llama-server.exe" : "llama-server";

function makeZip(dir: string, entries: Record<string, string>): string {
  const zip = path.join(dir, "release.zip");
  const script = `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1], "w")
for name, body in json.loads(sys.argv[2]).items():
    z.writestr(name, body)
z.close()
`;
  execFileSync(python, ["-I", "-c", script, zip, JSON.stringify(entries)]);
  return zip;
}

describe("llama.cpp is planned, downloaded and installed by setup", () => {
  const plan = (env: Record<string, string>, platform = win) =>
    prefetch.prefetchPlan("C:/friday", { ...quiet, FRIDAY_AUTO_INSTALL: "1", ...env }, platform, {
      ollama: true,
    });

  it("adds the pinned release zip and the chat GGUF on Windows, even when Ollama serves chat", () => {
    const jobs = plan({});
    const zip = jobs.find((j: { id: string }) => j.id === "llamacpp-runtime");
    const release = runners.runners.find((r: { id: string }) => r.id === "llamacpp").release;
    expect(zip).toMatchObject({ kind: "archive" });
    expect(zip.job.sources[0]).toMatchObject({
      url: release.url,
      sha256: release.sha256,
      bytes: release.bytes,
    });
    expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(jobs.some((j: { kind: string }) => j.kind === "chat")).toBe(true);
  });

  it("is not part of setup unless opted in; it is added later from Install Manager", () => {
    const { FRIDAY_PREFETCH_LLAMACPP: _on, ...bare } = quiet;
    const ids = prefetch
      .prefetchPlan("C:/friday", { ...bare, FRIDAY_AUTO_INSTALL: "1" }, win, { ollama: true })
      .map((j: { id: string }) => j.id);
    expect(ids).not.toContain("llamacpp-runtime");
    expect(ids).toContain("stt-small");
  });

  it("is off on another platform, on an opt-out and when automatic install is off", () => {
    expect(plan({}, "linux").some((j: { id: string }) => j.id === "llamacpp-runtime")).toBe(false);
    expect(
      plan({ FRIDAY_PREFETCH_LLAMACPP: "0" }).some(
        (j: { id: string }) => j.id === "llamacpp-runtime",
      ),
    ).toBe(false);
    expect(
      plan({ FRIDAY_AUTO_INSTALL: "0" }).some((j: { id: string }) => j.id === "llamacpp-runtime"),
    ).toBe(false);
  });

  it("downloads the zip, unpacks it under the FRIDAY folder and then reports it installed", async () => {
    const dir = tmp();
    try {
      const lines: string[] = [];
      const rows = await prefetch.prefetch(dir, {
        env: {
          ...quiet,
          FRIDAY_AUTO_INSTALL: "1",
          FRIDAY_PREFETCH: "1",
          FRIDAY_PREFETCH_CHAT: "0",
          FRIDAY_PREFETCH_TTS: "0",
          FRIDAY_PREFETCH_STT_LARGE: "0",
          FRIDAY_PREFETCH_OLLAMA: "0",
        },
        platform: win,
        policyRoot: dir,
        log: (l: string) => lines.push(l),
        totalGb: 16,
        board: null,
        download: async (job: { modelId: string; dir: string }) => {
          if (job.modelId === "llamacpp") {
            mkdirSync(job.dir, { recursive: true });
            makeZipAt(
              path.join(
                job.dir,
                runners.runners.find((r: { id: string }) => r.id === "llamacpp").release.asset,
              ),
            );
          }
          return { ok: true };
        },
      });
      const row = rows.find((r: { id: string }) => r.id === "llamacpp-runtime");
      expect(row).toMatchObject({ ok: true });
      expect(llama.installed(dir)).toBe(true);
      expect(lines.join("\n")).toMatch(/llama\.cpp .* installed/);
      // a second run only verifies: nothing is unpacked again
      const second: string[] = [];
      await prefetch.prefetch(dir, {
        env: {
          ...quiet,
          FRIDAY_AUTO_INSTALL: "1",
          FRIDAY_PREFETCH: "1",
          FRIDAY_PREFETCH_CHAT: "0",
          FRIDAY_PREFETCH_TTS: "0",
          FRIDAY_PREFETCH_STT_LARGE: "0",
          FRIDAY_PREFETCH_OLLAMA: "0",
        },
        platform: win,
        policyRoot: dir,
        log: (l: string) => second.push(l),
        totalGb: 16,
        board: null,
        download: async () => {
          throw new Error("must not download again");
        },
      });
      expect(second.join("\n")).toMatch(/llama\.cpp already installed|verified on disk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    function makeZipAt(target: string) {
      const built = makeZip(path.dirname(target), { [serverName]: "MZ", "ggml.dll": "x" });
      writeFileSync(target, readFileSync(built));
    }
  });

  it("names a failed unpack in the row instead of calling it installed", async () => {
    const dir = tmp();
    try {
      const zipDir = path.join(dir, "runtime", "installers", "llamacpp");
      mkdirSync(zipDir, { recursive: true });
      writeFileSync(
        path.join(
          zipDir,
          runners.runners.find((r: { id: string }) => r.id === "llamacpp").release.asset,
        ),
        "not a zip",
      );
      const rows = await prefetch.prefetch(dir, {
        env: {
          ...quiet,
          FRIDAY_AUTO_INSTALL: "1",
          FRIDAY_PREFETCH: "1",
          FRIDAY_PREFETCH_CHAT: "0",
          FRIDAY_PREFETCH_TTS: "0",
          FRIDAY_PREFETCH_STT_LARGE: "0",
          FRIDAY_PREFETCH_OLLAMA: "0",
        },
        platform: win,
        policyRoot: dir,
        log: () => undefined,
        totalGb: 16,
        board: null,
        download: async () => ({ ok: true }),
        llama: { extract: async () => ({ ok: false, error: "bad zip" }) },
      });
      expect(rows.find((r: { id: string }) => r.id === "llamacpp-runtime")).toMatchObject({
        ok: false,
        error: "bad zip",
      });
      expect(llama.installed(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the llama-server FRIDAY installed", () => {
  it("is found in its own folder, newest release first, and only there", () => {
    const dir = tmp();
    try {
      expect(llama.findServer(dir)).toBeNull();
      const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
      for (const tag of ["b9000", "b11609"]) {
        mkdirSync(path.join(llama.engineDir(dir), tag), { recursive: true });
        writeFileSync(path.join(llama.engineDir(dir), tag, name), "x");
      }
      expect(llama.findServer(dir)).toBe(path.join(llama.engineDir(dir), "b11609", name));
      expect(llama.installed(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the chat model setup downloaded when several GGUF files are present, and guesses nothing else", () => {
    const mine = "/m/qwen2.5-1.5b-instruct-q4_k_m.gguf";
    expect(llama.preferred(["/m/other.gguf", mine])).toBe(mine);
    expect(llama.preferred(["/m/a.gguf", "/m/b.gguf"])).toBeNull();
    expect(llama.preferred([mine, "/m/Qwen2.5-1.5B-Instruct-Q8_0.gguf"])).toBeNull(); // two of them: still a guess
    expect(llama.preferred([])).toBeNull();
  });
});

describe("unpacking a release zip", () => {
  it("unpacks every file and refuses a zip that writes outside its folder", async () => {
    const dir = tmp();
    try {
      const good = makeZip(dir, { "llama-server.exe": "MZ", "bin/ggml.dll": "x" });
      const dest = path.join(dir, "out");
      const ok = await llama.extractZip(good, dest, { python });
      expect(ok.ok).toBe(true);
      expect(existsSync(path.join(dest, "llama-server.exe"))).toBe(true);
      expect(existsSync(path.join(dest, "bin", "ggml.dll"))).toBe(true);

      const evil = path.join(dir, "evil.zip");
      execFileSync(python, [
        "-I",
        "-c",
        "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escaped.txt','x'); z.close()",
        evil,
      ]);
      const bad = await llama.extractZip(evil, path.join(dir, "out2"), { python });
      expect(bad.ok).toBe(false);
      expect(existsSync(path.join(dir, "escaped.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an installed server for the same release and reports a zip with no server", async () => {
    const dir = tmp();
    try {
      const empty = makeZip(dir, { "readme.txt": "no server here" });
      const none = await llama.installFromZip(dir, empty, "b1", { python });
      expect(none).toMatchObject({ ok: false });
      expect(none.error).toMatch(/no llama-server/);
      const real = makeZip(dir, {
        [process.platform === "win32" ? "llama-server.exe" : "llama-server"]: "x",
      });
      const first = await llama.installFromZip(dir, real, "b2", { python });
      expect(first.ok).toBe(true);
      const again = await llama.installFromZip(dir, real, "b2", { python });
      expect(again).toMatchObject({ ok: true, kept: true });
      expect(
        (await llama.installFromZip(dir, path.join(dir, "missing.zip"), "b2", { python })).ok,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
