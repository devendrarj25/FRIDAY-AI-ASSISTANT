/**
 * Doctor probes (scripts/doctor-probes.cjs): every download source of an item as ordered host names, a cheap per-host
 * reachability probe (parallel, short timeout, cached per run, "not checked" offline), the Tesseract language list,
 * the onnxruntime flavour against the plan, and the Python module presence check. Nothing here touches the network:
 * fetch, the child process and the clock are injected.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasCommand } from "./helpers/environment";

const require_ = createRequire(import.meta.url);
const probes = require_("../../scripts/doctor-probes.cjs");

type Reach = Record<string, { state: string; ms?: number; reason?: string }>;

describe("sources: every host of an item, in the order they are tried", () => {
  it("reads a url, a mirror endpoint and a Hugging Face repository", () => {
    expect(probes.sourceHost({ kind: "url", url: "https://github.com/a/b/x.zip" })).toBe(
      "github.com",
    );
    expect(probes.sourceHost({ kind: "hf-repo", repo: "Supertone/supertonic-3" })).toBe(
      "huggingface.co",
    );
    expect(
      probes.sourceHost({ kind: "hf-repo", repo: "a/b", endpoint: "https://hf-mirror.com" }),
    ).toBe("hf-mirror.com");
    expect(probes.sourceHost({ kind: "hf-gguf", repo: "a/b" })).toBe("huggingface.co");
    expect(probes.sourceHost({})).toBe("");
    expect(probes.sourceHost(null)).toBe("");
  });

  it("keeps the order, drops repeats, and reads one source or many", () => {
    const sources = [
      { kind: "url", url: "https://huggingface.co/pipecat-ai/x/resolve/abc/f.onnx" },
      { kind: "url", url: "https://raw.githubusercontent.com/snakers4/silero-vad/v6/f.onnx" },
      { kind: "hf-repo", repo: "a/b" },
      { kind: "url", url: "https://raw.githubusercontent.com/other" },
    ];
    expect(probes.sourceHosts(sources)).toEqual(["huggingface.co", "raw.githubusercontent.com"]);
    expect(probes.jobHosts({ job: { sources: sources.slice(0, 1) } })).toEqual(["huggingface.co"]);
    expect(probes.jobHosts({ sources: sources.slice(1, 2) })).toEqual([
      "raw.githubusercontent.com",
    ]);
    expect(probes.jobHosts({ job: {} })).toEqual([]);
    expect(probes.sourceHosts(undefined)).toEqual([]);
  });

  it("names a tool's winget index first and then the vendor installer", () => {
    expect(
      probes.toolHosts({
        winget: "UB-Mannheim.TesseractOCR",
        installerUrl: "https://github.com/UB-Mannheim/tesseract/releases/download/v5/x.exe",
      }),
    ).toEqual(["cdn.winget.microsoft.com", "github.com"]);
    expect(probes.toolHosts({ url: "https://www.7-zip.org/" })).toEqual(["www.7-zip.org"]);
    expect(probes.toolHosts(null)).toEqual([]);
  });

  it("is what the real setup plan's jobs carry: Ollama's first source is the official release", () => {
    const prefetch = require_("../../scripts/prefetch-models.cjs");
    const jobs = prefetch.prefetchPlan(
      "/friday",
      { FRIDAY_PREFETCH: "1", FRIDAY_PREFETCH_OLLAMA: "1" },
      "win32",
      {},
    );
    const ollama = jobs.find((job: { id: string }) => job.id === "ollama-setup");
    const hosts: string[] = probes.jobHosts(ollama);
    expect(hosts[0]).toBe("github.com");
    expect(new Set(hosts).size).toBe(hosts.length);
    const silero = jobs.find((job: { id: string }) => job.id === "silero-vad");
    expect(probes.jobHosts(silero).length).toBeGreaterThanOrEqual(1);
    expect(probes.jobHosts(silero)[0]).toBe("huggingface.co");
  });
});

describe("reachability: one cheap request per distinct host, never a failure", () => {
  const answer = (status: number) => async () => ({ status, body: null });

  it("is up for any answer below 500 and down for a 5xx, a refusal or a timeout", async () => {
    expect((await probes.probeHost("a.test", { fetchImpl: answer(200) })).state).toBe("up");
    expect((await probes.probeHost("a.test", { fetchImpl: answer(404) })).state).toBe("up");
    expect((await probes.probeHost("a.test", { fetchImpl: answer(503) })).state).toBe("down");
    const refused = await probes.probeHost("a.test", {
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND a.test");
      },
    });
    expect(refused.state).toBe("down");
    const slow = await probes.probeHost("a.test", {
      timeoutMs: 20,
      fetchImpl: (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    expect(slow.state).toBe("down");
  });

  it("asks with HEAD, over https, once per distinct host and all at the same time", async () => {
    const calls: { url: string; method: string }[] = [];
    let open = 0;
    let peak = 0;
    const fetchImpl = async (url: string, init: { method: string }) => {
      calls.push({ url, method: init.method });
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 15));
      open -= 1;
      return { status: 200, body: null };
    };
    const out = await probes.probeHosts(["a.test", "b.test", "a.test", ""], { fetchImpl });
    expect(Object.keys(out)).toEqual(["a.test", "b.test"]);
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "HEAD"]);
    expect(calls.map((c) => c.url)).toEqual(["https://a.test/", "https://b.test/"]);
    expect(peak).toBe(2);
  });

  it("is off offline, when switched off, and under the test runner: 'not checked'", () => {
    expect(probes.reachEnabled({})).toBe(true);
    expect(probes.reachEnabled({ FRIDAY_OFFLINE: "1" })).toBe(false);
    expect(probes.reachEnabled({ FRIDAY_REACH_PROBE: "0" })).toBe(false);
    expect(probes.reachEnabled({ VITEST: "true" })).toBe(false);
    const never = () => {
      throw new Error("must not run a probe");
    };
    const out: Reach = probes.reachSync(["a.test"], { env: { FRIDAY_OFFLINE: "1" }, run: never });
    expect(out["a.test"]).toEqual({ state: "unchecked", reason: "offline" });
  });

  it("probes only what is not cached, writes the run cache, and reads it in the next process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-reach-test-"));
    try {
      const file = path.join(dir, "reach.json");
      const env = { FRIDAY_REACH_CACHE: file };
      const asked: string[][] = [];
      const run = (_exe: string, args: string[]) => {
        const hosts = args.slice(2);
        asked.push(hosts);
        return {
          status: 0,
          stdout: `noise\n${JSON.stringify(Object.fromEntries(hosts.map((h) => [h, { state: h.startsWith("down") ? "down" : "up", ms: 7 }])))}\n`,
        };
      };
      const first: Reach = probes.reachSync(["a.test", "down.test"], {
        env,
        run,
        now: () => 1000,
        memo: new Map(),
      });
      expect(first["a.test"]?.state).toBe("up");
      expect(first["down.test"]?.state).toBe("down");
      expect(asked).toEqual([["a.test", "down.test"]]);
      // A second step of the same Doctor run (another process: a fresh memo) reads the file, and only asks for the new host.
      const second: Reach = probes.reachSync(["a.test", "b.test"], {
        env,
        run,
        now: () => 2000,
        memo: new Map(),
      });
      expect(second["a.test"]?.state).toBe("up");
      expect(second["b.test"]?.state).toBe("up");
      expect(asked).toEqual([["a.test", "down.test"], ["b.test"]]);
      // Past the time-to-live the answer is asked again.
      probes.reachSync(["a.test"], { env, run, now: () => 1000 + 6 * 60 * 1000, memo: new Map() });
      expect(asked[2]).toEqual(["a.test"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says 'not checked' (never down) when the probe child fails or prints nothing", () => {
    const broken: Reach = probes.reachSync(["x.test"], {
      env: {},
      run: () => ({ status: 1, stdout: "" }),
      memo: new Map(),
    });
    expect(broken["x.test"]?.state).toBe("unchecked");
    const thrown: Reach = probes.reachSync(["y.test"], {
      env: {},
      run: () => {
        throw new Error("spawn failed");
      },
      memo: new Map(),
    });
    expect(thrown["y.test"]?.state).toBe("unchecked");
  });

  it("really runs the child: --probe on a refused host answers down inside a second", () => {
    const { spawnSync } = require_("node:child_process");
    const run = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../../scripts/doctor-probes.cjs"),
        "--probe",
        "127.0.0.1:9",
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(run.status).toBe(0);
    const line = String(run.stdout).trim().split(/\r?\n/).pop() ?? "";
    expect(JSON.parse(line)["127.0.0.1:9"].state).toBe("down");
  });
});

describe("the row detail names every source and which one answers now", () => {
  const reach = (states: Record<string, string>): Reach =>
    Object.fromEntries(Object.entries(states).map(([h, state]) => [h, { state, ms: 5 }]));

  it("lists the hosts in order with their state", () => {
    expect(
      probes.sourcesLine(
        ["huggingface.co", "raw.githubusercontent.com"],
        reach({ "huggingface.co": "up", "raw.githubusercontent.com": "up" }),
      ),
    ).toBe("sources: huggingface.co (up) > raw.githubusercontent.com (up)");
  });

  it("says so when a missing item's first source is down and another is up", () => {
    const line = probes.sourcesLine(
      ["huggingface.co", "github.com"],
      reach({ "huggingface.co": "down", "github.com": "up" }),
      { missing: true },
    );
    expect(line).toContain("huggingface.co (down) > github.com (up)");
    expect(line).toContain("first source huggingface.co is down now; github.com answers");
    expect(line).toContain("setup falls back to it");
  });

  it("says no source answers when every host is down and the item is missing", () => {
    const line = probes.sourcesLine(
      ["a.test", "b.test"],
      reach({ "a.test": "down", "b.test": "down" }),
      {
        missing: true,
      },
    );
    expect(line).toContain("no source answers now");
  });

  it("offline is 'not checked', not a failure, and says why", () => {
    const line = probes.sourcesLine(["a.test", "b.test"], {
      "a.test": { state: "unchecked", reason: "offline" },
      "b.test": { state: "unchecked", reason: "offline" },
    });
    expect(line).toBe("sources: a.test > b.test (not checked: offline)");
    expect(probes.sourcesLine(["a.test"], {})).toBe("sources: a.test (not checked)");
    expect(probes.sourcesLine([], {})).toBe("");
  });
});

describe("Tesseract languages", () => {
  const listing = (codes: string[]) =>
    `List of available languages in "C:\\Program Files\\Tesseract-OCR/tessdata/" (${codes.length}):\n${codes.join("\r\n")}\r\n`;

  it("reads the list without its header and requires eng", () => {
    const got = probes.tesseractLanguages(listing(["eng", "osd"]));
    expect(got).toMatchObject({ listed: true, eng: true, hin: false, langs: ["eng", "osd"] });
  });

  it("sees the Hindi pack when it is there", () => {
    expect(probes.tesseractLanguages(listing(["eng", "hin", "osd"]))).toMatchObject({
      eng: true,
      hin: true,
    });
  });

  it("an empty or missing answer is 'no list', and never reads a path as a language", () => {
    expect(probes.tesseractLanguages("")).toMatchObject({ listed: false, eng: false, hin: false });
    expect(probes.tesseractLanguages(null)).toMatchObject({ listed: false });
    expect(probes.parseTesseractLangs(listing(["eng"]))).not.toContain("tessdata/");
    expect(probes.tesseractLanguages(listing(["hin", "osd"]))).toMatchObject({
      eng: false,
      hin: true,
    });
  });
});

describe("the onnxruntime build against the plan", () => {
  const out = (data: object) => `junk\nORT_JSON ${JSON.stringify(data)}\n`;

  it("reads the flavour from the installed wheel", () => {
    expect(
      probes.parseOrtProbe(out({ onnxruntime: "1.31.1", providers: ["CPUExecutionProvider"] })),
    ).toMatchObject({
      flavour: "cpu",
      version: "1.31.1",
    });
    expect(probes.parseOrtProbe(out({ "onnxruntime-gpu": "1.31.1" }))?.flavour).toBe("gpu");
    expect(probes.parseOrtProbe(out({ "onnxruntime-directml": "1.31.1" }))?.flavour).toBe(
      "directml",
    );
    expect(probes.parseOrtProbe(out({ error: "no module" }))?.flavour).toBe("none");
    expect(probes.parseOrtProbe("nothing")).toBeNull();
  });

  const planRow = { id: "onnxruntime", variant: "cpu", recommended: "gpu", action: "install" };

  it("notes that a better build is recommended, and when the installed one matches", () => {
    const cpu = probes.parseOrtProbe(
      out({ onnxruntime: "1.31.1", providers: ["CPUExecutionProvider"] }),
    );
    const row = probes.ortRow(cpu, planRow);
    expect(row.found).toBe("cpu 1.31.1 (CPUExecutionProvider)");
    expect(row.want).toContain("setup installs the cpu build");
    expect(row.want).toContain("recommends gpu");
    expect(row.note).toContain("the gpu build is recommended for this PC");
    const same = probes.ortRow(cpu, { ...planRow, recommended: "cpu" });
    expect(same.note).toBe("matches this PC's recommendation");
  });

  it("reports two wheels together, a missing runtime and an unreadable plan without failing", () => {
    const both = probes.parseOrtProbe(out({ onnxruntime: "1.31.1", "onnxruntime-gpu": "1.31.1" }));
    expect(probes.ortRow(both, planRow).note).toContain("2 onnxruntime wheels");
    expect(probes.ortRow(probes.parseOrtProbe(out({})), planRow).found).toBe("not installed");
    expect(probes.ortRow(null, planRow).found).toContain("could not be checked");
    expect(
      probes.ortRow(probes.parseOrtProbe(out({ onnxruntime: "1.31.1" })), undefined).want,
    ).toContain("plan could not be read");
  });

  it("asks the interpreter once and treats a failed run as 'not checked'", () => {
    const calls: unknown[][] = [];
    const run = (...args: unknown[]) => {
      calls.push(args);
      return { status: 0, stdout: out({ onnxruntime: "1.31.1" }) };
    };
    expect(probes.probeOrt("py", { run })?.flavour).toBe("cpu");
    expect(calls).toHaveLength(1);
    expect(probes.probeOrt("", { run })).toBeNull();
    expect(probes.probeOrt("py", { run: () => ({ status: 1, stdout: "" }) })).toBeNull();
  });
});

describe("Python modules are found without being imported", () => {
  it("passes the names as arguments and returns what the interpreter printed", () => {
    let seen: string[] = [];
    const run = (_py: string, args: string[]) => {
      seen = args;
      return { status: 0, stdout: 'PYMODS {"pyrnnoise": true, "fasttext": false}\n' };
    };
    const got = probes.probeModules("py", ["pyrnnoise", "fasttext", "pyrnnoise"], { run });
    expect(got).toEqual({ pyrnnoise: true, fasttext: false });
    expect(seen.slice(2)).toEqual(["pyrnnoise", "fasttext"]);
    expect(seen[1]).toContain("find_spec");
    expect(seen[1]).not.toMatch(/__import__|importlib\.import_module/);
  });

  it("returns null (not checked) with no interpreter, no names or a failed run", () => {
    expect(probes.probeModules("", ["a"])).toBeNull();
    expect(probes.probeModules("py", [])).toBeNull();
    expect(probes.probeModules("py", ["a"], { run: () => ({ status: 1, stdout: "" }) })).toBeNull();
    expect(
      probes.probeModules("py", ["a"], { run: () => ({ status: 0, stdout: "garbage" }) }),
    ).toBeNull();
  });

  it.skipIf(!hasCommand("python3"))(
    "finds a real module and a missing one with a real interpreter",
    () => {
      expect(probes.probeModules("python3", ["json", "friday_no_such_module_xyz"])).toEqual({
        json: true,
        friday_no_such_module_xyz: false,
      });
    },
  );
});
