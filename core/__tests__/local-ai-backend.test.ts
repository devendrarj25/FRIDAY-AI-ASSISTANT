/**
 * Phase 2: allowlisted downloads, transfer states, library parsers,
 * and local multi-model answers. No live network and no installer is run.
 */
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const download = require_("../../electron/model-download.cjs");
const safety = download.safety;
const library = download.library;
const router = require_("../../electron/model-router.cjs");

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("download allowlist", () => {
  it("allows official https hosts and loopback http, and rejects the rest", () => {
    expect(safety.assertAllowedUrl("https://github.com/ollama/ollama/releases").protocol).toBe(
      "https:",
    );
    expect(safety.assertAllowedUrl("http://127.0.0.1:9/file").hostname).toBe("127.0.0.1");
    expect(() => safety.assertAllowedUrl("http://github.com/x")).toThrow(/https/);
    expect(() => safety.assertAllowedUrl("https://evil.example/x")).toThrow(/not allowlisted/);
  });

  it("aborts a redirect that leaves the allowlist and removes the partial file", async () => {
    const server = createServer((req, res) => {
      res.writeHead(302, { location: "https://evil.example/off" });
      res.end();
    });
    const port = await listen(server);
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "fr-dl-")), "model.bin");
    await expect(download.downloadUrl(`http://127.0.0.1:${port}/go`, dest)).rejects.toThrow(
      /not allowlisted/,
    );
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    server.close();
  });

  it("downloads from loopback, checks the checksum, and deletes a mismatch", async () => {
    const body = "hello";
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const port = await listen(server);
    const dir = mkdtempSync(path.join(tmpdir(), "fr-ok-"));
    const dest = path.join(dir, "model.bin");
    const good = createHash("sha256").update(body).digest("hex");
    const bytes = await download.downloadUrl(`http://127.0.0.1:${port}/file`, dest, {
      sha256: good,
    });
    expect(bytes).toBe(body.length);
    expect(readFileSync(dest, "utf8")).toBe(body);
    const bad = path.join(dir, "bad.bin");
    await expect(
      download.downloadUrl(`http://127.0.0.1:${port}/file`, bad, { sha256: "ab".repeat(32) }),
    ).rejects.toThrow(/checksum/);
    expect(existsSync(bad)).toBe(false);
    server.close();
  });

  it("keeps the partial file on pause and removes it on cancel", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": "5" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": "5" });
      res.write("hi");
      void held.then(() => {
        res.end("yo!");
      });
    });
    const port = await listen(server);
    const dir = mkdtempSync(path.join(tmpdir(), "fr-pause-"));
    const pausedDest = path.join(dir, "pause.bin");
    const control = { paused: false, maxBytesPerSecond: 0 };
    const controller = new AbortController();
    const pending = download.downloadUrl(`http://127.0.0.1:${port}/slow`, pausedDest, {
      control,
      signal: controller.signal,
    });
    control.paused = true;
    await new Promise((r) => setTimeout(r, 40));
    controller.abort("pause");
    await expect(pending).rejects.toThrow(/paused/);
    expect(existsSync(`${pausedDest}.part`)).toBe(true);

    const cancelDest = path.join(dir, "cancel.bin");
    const cancel = new AbortController();
    const pendingCancel = download.downloadUrl(`http://127.0.0.1:${port}/slow`, cancelDest, {
      signal: cancel.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    cancel.abort();
    await expect(pendingCancel).rejects.toThrow(/cancelled/);
    expect(existsSync(`${cancelDest}.part`)).toBe(false);
    release();
    server.close();
  });

  it("resumes a partial file with a range request", async () => {
    const body = "hello";
    const server = createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": String(body.length), "accept-ranges": "bytes" });
        res.end();
        return;
      }
      const header = String(req.headers.range || "");
      const start = header.startsWith("bytes=") ? Number(header.slice(6).split("-")[0]) : 0;
      const slice = body.slice(Number.isFinite(start) ? start : 0);
      res.writeHead(start > 0 ? 206 : 200, { "content-length": String(slice.length) });
      res.end(slice);
    });
    const port = await listen(server);
    const dest = path.join(mkdtempSync(path.join(tmpdir(), "fr-resume-")), "model.bin");
    require_("node:fs").writeFileSync(`${dest}.part`, "he");
    const bytes = await download.downloadUrl(`http://127.0.0.1:${port}/file`, dest);
    expect(bytes).toBe(body.length);
    expect(readFileSync(dest, "utf8")).toBe(body);
    server.close();
  });

  it("refuses a download that cannot fit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr-disk-"));
    expect(() => download.assertDiskRoom(dir, 10 ** 18)).toThrow(/disk full/);
  });
});

describe("transfer queue", () => {
  it("moves only along the status list and survives a restart", () => {
    let job = safety.blankTransfer({ id: "t1", modelId: "llama" });
    job = safety.transition(job, "downloading");
    job = safety.transition(job, "paused");
    job = safety.transition(job, "downloading");
    job = safety.transition(job, "verifying");
    job = safety.transition(job, "installing");
    job = safety.transition(job, "installed");
    job = safety.transition(job, "active");
    expect(job.status).toBe("active");
    expect(() => safety.transition(job, "downloading")).toThrow(/cannot move/);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "fr-store-")), "transfers.json");
    safety.saveTransfers(file, [{ ...job, apiKey: "sk-aaaaaaaaaaaaaaaa", token: "secret" }]);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toMatch(/sk-/);
    expect(raw).not.toMatch(/token/);
    const loaded = safety.loadTransfers(file);
    expect(loaded[0]?.status).toBe("active");
    expect(loaded[0]?.modelId).toBe("llama");
  });

  it("starts only as many downloads as the concurrency cap allows", () => {
    const jobs = [
      { id: "a", status: "downloading" },
      { id: "b", status: "queued" },
      { id: "c", status: "queued" },
    ];
    expect(safety.admitJobs(jobs, 1).starting).toEqual([]);
    expect(safety.admitJobs(jobs, 2).starting).toEqual(["b"]);
  });

  it("marks an interrupted download paused after a restart", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "fr-recover-")), "transfers.json");
    safety.saveTransfers(file, [
      {
        id: "live",
        modelId: "llama",
        status: "downloading",
        sourceUrl: "https://github.com/acme/m",
      },
    ]);
    const rows = safety.recoverTransfers(file);
    expect(rows[0]?.status).toBe("paused");
    expect(rows[0]?.error).toMatch(/stopped before it finished/);
    expect(safety.recoverTransfers(file)[0]?.status).toBe("paused");
  });

  it("cleans a partial file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr-part-"));
    const dest = path.join(dir, "m.bin");
    require_("node:fs").writeFileSync(`${dest}.part`, "x");
    expect(safety.cleanupPart(dest)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});

describe("local library parsers", () => {
  it("reads Hugging Face sha256 metadata and a gated flag", () => {
    const rows = library.parseHfModels([
      {
        id: "org/demo",
        gated: "manual",
        cardData: { license: "apache-2.0" },
        siblings: [{ rfilename: "demo-Q4_K_M.gguf", lfs: { sha256: "abc", size: 10 } }],
      },
    ]);
    expect(rows[0]?.gated).toBe(true);
    expect(rows[0]?.files[0]).toMatchObject({ name: "demo-Q4_K_M.gguf", sha256: "abc", bytes: 10 });
    expect(rows[0]?.officialPage).toBe("https://huggingface.co/org/demo");
  });

  it("reads a GitHub release asset digest", () => {
    const asset = library.parseGithubRelease(
      {
        tag_name: "v1",
        assets: [
          {
            name: "app.exe",
            browser_download_url: "https://github.com/acme/app/releases/download/v1/app.exe",
            size: 4,
            digest: "sha256:dddd",
          },
        ],
      },
      "app.exe",
    );
    expect(asset).toMatchObject({ name: "app.exe", sha256: "dddd", bytes: 4, tag: "v1" });
  });

  it("does not offer to run an installer before a signature and an owner click", () => {
    const ollama = library.runnerById("ollama");
    const lmstudio = library.runnerById("lmstudio");
    expect(ollama?.release?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lmstudio?.catalog).toBe("none");
    expect(lmstudio?.release).toBeNull();
    const blocked = library.installOffer(ollama, { sha256: ollama?.release?.sha256 });
    expect(blocked.canRun).toBe(false);
    expect(blocked.reason).toMatch(/signature/i);
    const ready = library.installOffer(ollama, {
      sha256: ollama?.release?.sha256,
      ownerClicked: true,
      authenticode: { ok: true, publisher: "Ollama" },
    });
    expect(ready.canRun).toBe(true);
    const gpt = library.installOffer(library.runnerById("gpt4all"), {
      ownerClicked: true,
      authenticode: { ok: true, publisher: "Nomic" },
    });
    expect(gpt.canRun).toBe(false);
    expect(gpt.reason).toMatch(/sha256/i);
    const card = library.launcherCard(ollama, { now: Date.parse("2026-10-16T00:00:00Z") });
    expect(card.detected).toBe(false);
    expect(card.nextStep).toMatch(/Not installed/);
    expect(card.pinAgeLabel).toBe("Pin age: 2 days");
    expect(JSON.stringify(card)).not.toMatch(/sk-/);
  });

  it("reports a newer official release without installing or replacing an unpublished checksum", async () => {
    const ollama = library.runnerById("ollama");
    const now = Date.parse("2026-10-16T00:00:00Z");
    const pinned = ollama.release.sha256;
    const newer = await library.checkRunnerRelease("ollama", {
      now,
      payload: {
        tag_name: "v9.9.9",
        assets: [
          {
            name: "OllamaSetup.exe",
            browser_download_url:
              "https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe",
            size: 10,
          },
        ],
      },
    });
    expect(newer.updateAvailable).toBe(true);
    expect(newer.label).toContain("update available");
    expect(newer.autoInstall).toBe(false);
    expect(newer.canRun).toBe(false);
    expect(newer.offeredSha256).toBeNull();
    expect(newer.wouldReplaceSha256).toBe(false);
    expect(newer.storedSha256).toBe(pinned);
    expect(library.runnerById("ollama").release.sha256).toBe(pinned);
    const published = await library.checkRunnerRelease("ollama", {
      now,
      payload: {
        tag_name: "v9.9.9",
        assets: [
          {
            name: "OllamaSetup.exe",
            browser_download_url:
              "https://github.com/ollama/ollama/releases/download/v9.9.9/OllamaSetup.exe",
            size: 10,
            digest: "sha256:abc123",
          },
        ],
      },
    });
    expect(published.offeredSha256).toBe("abc123");
    expect(published.wouldReplaceSha256).toBe(true);
    expect(published.storedSha256).toBe(pinned);
    expect(library.runnerById("ollama").release.sha256).toBe(pinned);
    expect(published.autoInstall).toBe(false);
    const same = library.assessOfficialRelease(
      ollama,
      {
        tag_name: "v0.40.4",
        assets: [{ name: "OllamaSetup.exe", digest: `sha256:${pinned}`, size: 1 }],
      },
      now,
    );
    expect(same.updateAvailable).toBe(false);
    expect(same.label).toContain("this pin is current");
    const studio = library.assessOfficialRelease(library.runnerById("lmstudio"), null, now);
    expect(studio.updateAvailable).toBe(false);
    expect(studio.label).toContain("no pinned release");
    expect(studio.offeredSha256).toBeNull();
  });

  it("stops a gated repo before any byte is requested", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr-gate-"));
    const result = await download.downloadModel(
      {
        modelId: "gated",
        dir,
        persist: false,
        sources: [{ kind: "hf-gguf", repo: "org/private", match: [], gated: true, label: "hf" }],
      },
      () => {},
    );
    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.error).toMatch(/gated file needs a token/i);
  });
});

describe("local multi-model answers", () => {
  const drafts = [
    { modelId: "a", text: "yes" },
    { modelId: "b", text: "yes" },
    { modelId: "c", text: "no", error: "" },
  ];

  it("shows every draft, the first good draft, or the majority", () => {
    expect(router.combineLocalAnswers(drafts, { strategy: "show-all" }).answers).toHaveLength(3);
    expect(router.combineLocalAnswers(drafts, { strategy: "first-good" }).chosen).toBe("a");
    const majority = router.combineLocalAnswers(drafts, { strategy: "majority" });
    expect(majority.text).toBe("yes");
    expect(majority.votes).toBe(2);
  });

  it("refuses a judge until the owner enables one, and that judge does not choose a provider", () => {
    const off = router.combineLocalAnswers(drafts, { strategy: "judged" });
    expect(off.refused).toBe(true);
    const on = router.combineLocalAnswers(drafts, {
      strategy: "judged",
      judgeEnabled: true,
      judgeModelId: "ollama:llama3.2",
    });
    expect(on.needsJudge).toBe(true);
    expect(on.judgeModelId).toBe("ollama:llama3.2");
    expect(on.reason).toMatch(/does not choose a provider/);
  });

  it("keeps download admission, crash recovery, and quit-pause on the desktop process", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    expect(main).toContain("admitJobs");
    expect(main).toContain("recoverTransfers");
    expect(main).toContain('abort("pause")');
    expect(main).toContain('ipcMain.handle("models:transfers"');
  });

  it("runs models one at a time when they do not fit", () => {
    const models = [
      { id: "a", ramGb: 8 },
      { id: "b", ramGb: 8 },
    ];
    expect(router.localFanout(models, { freeRamGb: 10 }).mode).toBe("sequential");
    expect(router.localFanout(models, { freeRamGb: 20 }).mode).toBe("parallel");
    expect(router.localFanout(models, {}).mode).toBe("sequential");
  });
});
