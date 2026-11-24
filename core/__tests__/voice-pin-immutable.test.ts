/**
 * The two single-file voice helpers (Silero VAD, Smart Turn) are pinned to an immutable revision, never a
 * moving branch. Setup failed on a real PC with `silero-vad source failed (official release): checksum mismatch`
 * because the pin pointed at a GitHub `master` file that upstream had since replaced. Offline: a loopback
 * server stands in for the sources; no real weights are read.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const req = createRequire(import.meta.url);
type Source = { kind: string; url: string; sha256: string; bytes: number; label: string };
type Job = {
  id: string;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  dir: string[];
  optional?: boolean;
  fallback?: string;
  sources?: Source[];
  failureLine: (result: {
    error?: string;
    attempts?: Array<{ source: string; error: string }>;
  }) => string;
};
const weights = req("../../electron/voice-weights.cjs") as {
  pinnedJobs: () => Job[];
  isOptionalHelper: (id: string) => boolean;
  modelRegistry: () => Array<{ catalogId: string; optional?: boolean }>;
  voiceInstallPlan: (
    root: string,
    probe: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => { items: Array<{ id: string; optional?: boolean; fallback?: string }> };
};
const download = req("../../electron/model-download.cjs") as {
  downloadModel: (
    job: unknown,
    onEvent?: (event: Record<string, unknown>) => void,
  ) => Promise<{
    ok: boolean;
    error?: string;
    path?: string;
    source?: string;
    attempts?: Array<{ source: string; error: string }>;
  }>;
};

const SILERO_REVISION = "b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6";
const SILERO_SHA = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";
const SILERO_BYTES = 2327524;
const TURN_SHA = "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f";
const TURN_BYTES = 8679182;
const BRANCH = /\/(master|main|latest|HEAD|develop)(\/|$|\?)|[?&]ref=(master|main)/i;
const COMMIT = /^[0-9a-f]{40}$/;

const jobs = weights.pinnedJobs();
const job = (id: string) => jobs.find((row) => row.id === id) as Job;

describe("no pinned helper URL points at a moving branch", () => {
  it("lists both helpers and every url and source of them is revision-pinned", () => {
    expect(jobs.map((row) => row.id).sort()).toEqual(["silero-vad", "smart-turn"]);
    for (const row of jobs) {
      const urls = [row.url, ...(row.sources || []).map((source) => source.url)];
      expect(urls.length).toBeGreaterThanOrEqual(2);
      for (const url of urls) {
        expect(url, `${row.id}: ${url}`).toMatch(/^https:\/\//);
        expect(url, `${row.id}: ${url}`).not.toMatch(BRANCH);
      }
    }
  });

  it("the plain source text of voice-weights.cjs and voice-pins.cjs holds no branch URL either", () => {
    for (const file of ["voice-weights.cjs", "voice-pins.cjs"]) {
      const text = fs.readFileSync(path.join(__dirname, "../../electron", file), "utf8");
      const urls =
        text.match(
          /https:\/\/(?:huggingface\.co|github\.com|raw\.githubusercontent\.com)[^\s"'`)]*/g,
        ) || [];
      for (const url of urls) expect(url, `${file}: ${url}`).not.toMatch(BRANCH);
    }
  });
});

describe("Silero VAD is pinned to the immutable Hugging Face commit", () => {
  const row = job("silero-vad");
  it("the primary source is the commit URL with the table's sha and bytes", () => {
    expect(row.url).toBe(
      `https://huggingface.co/istupakov/silero-vad-onnx/resolve/${SILERO_REVISION}/silero_vad.onnx`,
    );
    expect(row.sources?.[0]?.url).toBe(row.url);
    expect(row.sha256).toBe(SILERO_SHA);
    expect(row.bytes).toBe(SILERO_BYTES);
    expect(row.file).toBe("silero_vad.onnx");
  });

  it("every source carries the same sha256 and bytes, so a different file is never accepted", () => {
    for (const source of row.sources || []) {
      expect(source.kind).toBe("url");
      expect(source.sha256).toBe(SILERO_SHA);
      expect(source.bytes).toBe(SILERO_BYTES);
    }
  });

  it("the secondary source is labelled and is a tag, never a branch", () => {
    const second = row.sources?.[1];
    expect(second?.url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/snakers4\/silero-vad\/v\d+\.\d+\.\d+\/src\/silero_vad\/data\/silero_vad\.onnx$/,
    );
    expect(second?.label).toMatch(/secondary/i);
    expect(row.sources?.[0]?.label).toMatch(/Hugging Face/);
  });

  it("the commit is a full 40-character revision", () => {
    expect(SILERO_REVISION).toMatch(COMMIT);
    expect(row.url).toContain(`/resolve/${SILERO_REVISION}/`);
  });
});

describe("Smart Turn is pinned to its Hugging Face commit", () => {
  it("uses a 40-character revision, with the unchanged sha and bytes", () => {
    const row = job("smart-turn");
    const revision = /\/resolve\/([^/]+)\//.exec(row.url)?.[1] || "";
    expect(revision).toMatch(COMMIT);
    expect(row.url).toMatch(
      /pipecat-ai\/smart-turn-v3\/resolve\/[0-9a-f]{40}\/smart-turn-v3\.2-cpu\.onnx$/,
    );
    expect(row.sha256).toBe(TURN_SHA);
    expect(row.bytes).toBe(TURN_BYTES);
    expect(row.sources?.[0]?.url).toBe(row.url);
  });
});

describe("optional helpers expose their fallback", () => {
  it("both helpers are optional with a named fallback, and the helper is exported", () => {
    expect(weights.isOptionalHelper("silero-vad")).toBe(true);
    expect(weights.isOptionalHelper("smart-turn")).toBe(true);
    expect(weights.isOptionalHelper("supertonic-3")).toBe(false);
    expect(weights.isOptionalHelper("faster-whisper-small")).toBe(false);
    expect(weights.isOptionalHelper("")).toBe(false);
    expect(weights.isOptionalHelper(undefined as unknown as string)).toBe(false);
    expect(job("silero-vad").optional).toBe(true);
    expect(job("silero-vad").fallback).toMatch(/energy/i);
    expect(job("smart-turn").optional).toBe(true);
    expect(job("smart-turn").fallback).toBeTruthy();
  });

  it("the registry rows and the install plan carry the flag", () => {
    const rows = weights.modelRegistry();
    expect(rows.find((row) => row.catalogId === "silero-vad")?.optional).toBe(true);
    expect(rows.find((row) => row.catalogId === "smart-turn")?.optional).toBe(true);
    expect(rows.find((row) => row.catalogId === "supertonic-3")?.optional).not.toBe(true);
    const plan = weights.voiceInstallPlan(
      path.join(os.tmpdir(), "friday-plan-none"),
      {
        totalRamGb: 16,
        freeRamGb: 10,
        cpuThreads: 8,
        gpu: { name: "", vramGb: 0, source: "none", cudaRuntimeReady: false },
      },
      { statfs: () => ({ bavail: 10 ** 12, bsize: 1 }), exists: () => false },
    );
    const silero = plan.items.find((item) => item.id === "silero-vad");
    expect(silero?.optional).toBe(true);
    expect(silero?.fallback).toMatch(/energy/i);
    expect(plan.items.find((item) => item.id === "supertonic-3")?.optional).not.toBe(true);
  });

  it("pinnedJobs returns copies: changing one never changes the table", () => {
    const first = weights.pinnedJobs();
    (first[0] as Job).sources?.push({ kind: "url", url: "x", sha256: "", bytes: 0, label: "" });
    (first[0] as Job).dir.push("x");
    const again = weights.pinnedJobs();
    expect(again[0]?.sources?.length).toBe(jobs[0]?.sources?.length);
    expect(again[0]?.dir).toEqual(jobs[0]?.dir);
  });
});

describe("a checksum mismatch on one source tries the next, then reports both", () => {
  let server: Server | null = null;
  const roots: string[] = [];
  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const serve = async (routes: Record<string, Buffer>) => {
    server = createServer((request, response) => {
      const body = routes[String(request.url)];
      if (!body) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-length": body.length });
      response.end(request.method === "HEAD" ? undefined : body);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  };
  const sha = (body: Buffer) => createHash("sha256").update(body).digest("hex");
  const sourcesFor = (port: number, good: Buffer): Source[] =>
    ["first", "second"].map((name) => ({
      kind: "url",
      url: `http://127.0.0.1:${port}/${name}/silero_vad.onnx`,
      sha256: sha(good),
      bytes: good.length,
      label: `source ${name}`,
    }));
  const root = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-pinsrc-"));
    roots.push(dir);
    return dir;
  };

  it("moved first source (other bytes), good second source: the pinned file lands", async () => {
    const good = Buffer.from("the-pinned-silero-bytes");
    const port = await serve({
      "/first/silero_vad.onnx": Buffer.from("upstream-replaced-this-file!"),
      "/second/silero_vad.onnx": good,
    });
    const dir = root();
    const result = await download.downloadModel({
      modelId: "silero-vad",
      dir,
      sources: sourcesFor(port, good),
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBe("source second");
    expect(result.attempts?.map((a) => a.source)).toEqual(["source first"]);
    expect(result.attempts?.[0]?.error).toMatch(/checksum mismatch/);
    expect(fs.readFileSync(path.join(dir, "silero-vad", "silero_vad.onnx"))).toEqual(good);
  });

  it("both sources wrong: nothing is kept and both failures are named", async () => {
    const good = Buffer.from("the-pinned-silero-bytes");
    const port = await serve({
      "/first/silero_vad.onnx": Buffer.from("moved-branch-bytes-aaaa"),
      "/second/silero_vad.onnx": Buffer.from("moved-tag-bytes-bbbbbbb"),
    });
    const dir = root();
    const result = await download.downloadModel({
      modelId: "silero-vad",
      dir,
      sources: sourcesFor(port, good),
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(dir, "silero-vad", "silero_vad.onnx"))).toBe(false);
    const line = job("silero-vad").failureLine(result);
    expect(line).toContain("silero-vad");
    expect(line).toContain("source first");
    expect(line).toContain("source second");
    expect(line).toMatch(/checksum mismatch/);
    expect(line).toMatch(/optional/i);
  });

  it("the failure line stays safe on an empty result", () => {
    expect(job("silero-vad").failureLine({})).toContain("silero-vad");
    expect(job("smart-turn").failureLine({ attempts: [] })).toContain("smart-turn");
  });
});
