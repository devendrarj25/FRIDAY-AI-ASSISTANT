import { createRequire } from "node:module";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const stack = require_(path.resolve(import.meta.dirname, "../../scripts/voice-stack.cjs"));

type Row = { layer: string; name: string; state: "PASS" | "FAIL" | "INFO"; detail: string };
const rows: Row[] = stack.inventory({});

describe("the voice stack is complete and connected (scripts/voice-stack.cjs)", () => {
  it("has no gap: every runner, model, package, router, gate and system row passes", () => {
    const failed = rows.filter((r) => r.state === "FAIL");
    expect(failed, failed.map((r) => `${r.layer}/${r.name}: ${r.detail}`).join("\n")).toEqual([]);
  });

  it("covers every layer of the voice mode", () => {
    const layers = new Set(rows.map((r) => r.layer));
    for (const layer of [
      "package",
      "runner",
      "setup",
      "speech",
      "kernel",
      "ipc",
      "router",
      "gate",
      "system",
    ])
      expect(layers.has(layer), layer).toBe(true);
  });

  it("names the pieces the owner asked for: faster-whisper, llama.cpp, Ollama, the big speech size", () => {
    const has = (name: string) => rows.some((r) => r.name === name && r.state === "PASS");
    expect(has("faster-whisper")).toBe(true);
    expect(has("llamacpp release pin")).toBe(true);
    expect(has("ollama release pin")).toBe(true);
    // llama.cpp is added later from Install Manager, so setup must not plan it.
    expect(has("llamacpp-runtime")).toBe(false);
    // medium and large-v3 are part of setup; large-v3-turbo is fetched from inside FRIDAY.
    const big = rows.find((r) => r.name === "big speech sizes in the plan")?.detail ?? "";
    expect(big).toContain("stt-medium");
    expect(big).toContain("stt-large-v3");
    expect(big).not.toContain("turbo");
    expect(rows.some((r) => r.layer === "speech" && r.name.startsWith("kernel/stt.py"))).toBe(true);
  });

  it("lists the two optional Hindi kernel files as passing kernel rows", () => {
    for (const file of ["kernel/hindi_punct.py", "kernel/tts_hindi_light.py"]) {
      const row = rows.find((r) => r.layer === "kernel" && r.name === file);
      expect(row?.state, file).toBe("PASS");
    }
  });

  it("checks what is on disk only when a folder is given", () => {
    expect(rows.some((r) => r.layer === "disk")).toBe(false);
    const withRoot: Row[] = stack.inventory({
      root: path.join(import.meta.dirname, "no-such-friday-folder"),
    });
    const disk = withRoot.filter((r) => r.layer === "disk");
    expect(disk.length).toBeGreaterThan(0);
    // Nothing is there, and it says so: what setup always fetches fails, what it may skip is information.
    expect(disk.every((r) => r.state === "FAIL" || r.state === "INFO")).toBe(true);
    const failing = disk.filter((r) => r.state === "FAIL").map((r) => r.name);
    for (const name of ["stt-small", "supertonic-3", "hindi-ear", "hindi-punct", "ollama-setup"]) {
      expect(failing).toContain(name);
    }
    // Optional helpers have a fallback (energy VAD, silence timer), so a missing file is information only.
    for (const name of ["silero-vad", "smart-turn"]) {
      expect(disk.find((r) => r.name === name)?.state).toBe("INFO");
    }
  });

  it("reads package names from a requirements file and finds a banned one", () => {
    const names = stack.packageNames(
      "# c\nfastapi>=1\nuvicorn[standard]>=2\nfaster_whisper>=1.2 # engine\n\ntorch==2.1\n",
    );
    expect(names).toEqual(["fastapi", "uvicorn", "faster-whisper", "torch"]);
    expect(stack.BANNED_PACKAGES.filter((p: string) => names.includes(p))).toEqual(["torch"]);
    expect(stack.BANNED_PACKAGES).toEqual(
      expect.arrayContaining([
        "torch",
        "vllm",
        "vosk",
        "piper-tts",
        "kokoro-onnx",
        "sherpa-onnx",
        "silero-vad",
      ]),
    );
  });

  it("never reports a real-PC fact as a pass: nothing here claims a microphone, a live account or Windows", () => {
    const text = rows.map((r) => `${r.name} ${r.detail}`).join("\n");
    expect(text).not.toMatch(/live account|real microphone|tested on windows/i);
  });
});

describe("the voice stack does not ask for the Ollama installer when Ollama is installed", () => {
  it("passes the installer row when Ollama is on the PC and fails it when neither is there", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../../scripts/voice-stack.cjs"),
      "utf8",
    );
    expect(source).toContain("prefetch.findOllama()");
    expect(source).toContain('job.kind === "installer" && !here && ollamaHere');
    expect(source).toContain("so its installer was not needed");
  });
});

describe("a Hindi pin that names a revision and a SHA-256 per file counts as verified", () => {
  const rev = "a".repeat(40);
  const sha = "b".repeat(64);
  const repoJob = (repo: string) => ({
    id: "hindi-ear",
    kind: "voice-model",
    job: { sources: [{ kind: "hf-repo", repo }] },
  });
  const pins = (pin: unknown) => ({
    pinForRepo: (repo: string) => (repo === "x/ear" ? pin : null),
  });

  it("passes a repository pin with a 40-character revision and a digest for every file", () => {
    const got = stack.verifiedBy(
      repoJob("x/ear"),
      pins({ revision: rev, files: { "a.onnx": { sha256: sha }, "b.txt": { sha256: sha } } }),
    );
    expect(got.ok).toBe(true);
    expect(got.how).toContain("revision aaaaaaaa");
    expect(got.how).toContain("2 files");
  });

  it("keeps failing when the revision, a file digest or the pin itself is missing", () => {
    const files = { "a.onnx": { sha256: sha } };
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ files })).ok).toBe(false);
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ revision: "main", files })).ok).toBe(false);
    expect(
      stack.verifiedBy(
        repoJob("x/ear"),
        pins({ revision: rev, files: { ...files, "b.txt": { bytes: 3 } } }),
      ).ok,
    ).toBe(false);
    expect(stack.verifiedBy(repoJob("x/ear"), pins({ revision: rev, files: {} })).ok).toBe(false);
    expect(stack.verifiedBy(repoJob("x/unknown"), pins({ revision: rev, files })).ok).toBe(false);
    expect(
      stack.verifiedBy({ id: "q", kind: "voice-model", job: { sources: [] } }, pins(null)).ok,
    ).toBe(false);
  });

  it("still accepts a source digest and the publisher-listing kinds", () => {
    const withDigest = { id: "i", kind: "installer", job: { sources: [{ sha256: sha }] } };
    expect(stack.verifiedBy(withDigest, pins(null)).how).toBe("pinned SHA-256");
    const listed = { id: "s", kind: "stt", job: { sources: [{}] } };
    expect(stack.verifiedBy(listed, pins(null)).how).toContain("publisher's listing");
  });

  it("passes hindi-ear and hindi-punct from the real pins, with no unverified row left", () => {
    const withRoot: Row[] = stack.inventory({
      root: path.join(import.meta.dirname, "no-such-friday-folder"),
    });
    for (const id of ["hindi-ear", "hindi-punct"]) {
      const verdict = withRoot.find((r) => r.layer === "setup" && r.name === `${id} is verified`);
      expect(verdict?.state, id).toBe("PASS");
      expect(verdict?.detail).toMatch(/pinned revision [0-9a-f]{8}/);
    }
    expect(withRoot.filter((r) => /is verified$/.test(r.name) && r.state === "FAIL")).toEqual([]);
  });
});

describe("the voice stack names the active engine and the fallbacks per role", () => {
  const find = (list: Row[], name: string) =>
    list.find((r) => r.layer === "engine" && r.name === name);

  it("reads the chains of the engine registry and lists every role as information", () => {
    const names = rows.filter((r) => r.layer === "engine").map((r) => r.name);
    for (const name of [
      "stt hi",
      "stt en",
      "stt hinglish",
      "tts hi",
      "tts en",
      "vad",
      "turn",
      "denoise",
    ])
      expect(names, name).toContain(name);
    expect(rows.filter((r) => r.layer === "engine").every((r) => r.state === "INFO")).toBe(true);
    expect(find(rows, "stt hi")?.detail).toContain("hindi-ear");
    expect(find(rows, "stt hi")?.detail).toContain("disk state needs --root");
  });

  it("with a folder: the first installed engine is active, the rest installed ones are fallbacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-stack-"));
    try {
      const pin = require_(path.resolve(import.meta.dirname, "../../electron/voice-pins.cjs")).PINS[
        "OpenVoiceOS/ai4bharat-indicconformer-hi-onnx"
      ];
      const ear = path.join(dir, "models", "hindi-ear");
      mkdirSync(ear, { recursive: true });
      for (const name of Object.keys(pin.files)) writeFileSync(path.join(ear, name), "x");
      const list: Row[] = stack.inventory({ root: dir });
      expect(find(list, "stt hi")?.detail).toMatch(/^active hindi-ear/);
      const empty: Row[] = stack.inventory({ root: path.join(dir, "nothing") });
      expect(find(empty, "stt hi")?.detail).toMatch(/^no listening engine installed/);
      // The built-in voices and detectors need no download, so every role still has an answer.
      expect(find(empty, "tts en")?.detail).toMatch(/^active edge-tts/);
      expect(find(empty, "tts en")?.detail).toContain("sapi");
      expect(find(empty, "vad")?.detail).toMatch(/^active energy-vad/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifiedBy looks at every source of a job, not only the first", () => {
  const sha = "b".repeat(64);
  const noPins = { pinForRepo: () => null };

  it("passes when every source carries the digest and says how many", () => {
    const job = {
      id: "silero-vad",
      kind: "pinned",
      job: {
        sources: [
          { url: "https://a.test/x", sha256: sha },
          { url: "https://b.test/x", sha256: sha },
        ],
      },
    };
    expect(stack.verifiedBy(job, noPins)).toEqual({
      ok: true,
      how: "pinned SHA-256 on all 2 sources",
    });
  });

  it("fails and names the second source when only the first has a digest", () => {
    const job = {
      id: "ollama-setup",
      kind: "installer",
      job: {
        sources: [{ url: "https://github.com/x", sha256: sha }, { url: "https://mirror.test/x" }],
      },
    };
    const got = stack.verifiedBy(job, noPins);
    expect(got.ok).toBe(false);
    expect(got.how).toBe("ollama-setup source mirror.test has no digest");
  });

  it("accepts a repository pin on one source and a digest on another", () => {
    const rev = "a".repeat(40);
    const pins = {
      pinForRepo: (repo: string) =>
        repo === "x/ear" ? { revision: rev, files: { "a.onnx": { sha256: sha } } } : null,
    };
    const job = {
      id: "hindi-ear",
      kind: "voice-model",
      job: {
        sources: [
          { kind: "hf-repo", repo: "x/ear" },
          { url: "https://b.test/x", sha256: sha },
        ],
      },
    };
    const got = stack.verifiedBy(job, pins);
    expect(got.ok).toBe(true);
    expect(got.how).toContain("all 2 sources");
    expect(got.how).toContain("pinned revision aaaaaaaa");
    // A second repository without a pin breaks it.
    const mixed = {
      ...job,
      job: {
        sources: [
          { kind: "hf-repo", repo: "x/ear" },
          { kind: "hf-repo", repo: "x/other" },
        ],
      },
    };
    expect(stack.verifiedBy(mixed, pins)).toEqual({
      ok: false,
      how: "hindi-ear source huggingface.co has no digest",
    });
  });

  it("keeps the publisher listing for speech, voice and chat whatever the extra sources are", () => {
    const job = {
      id: "stt-small",
      kind: "stt",
      job: {
        sources: [
          { kind: "hf-repo", repo: "a/b" },
          { kind: "hf-repo", repo: "c/d" },
        ],
      },
    };
    expect(stack.verifiedBy(job, noPins).how).toContain("publisher's listing");
  });
});

describe("every download row names all its sources and which one answers now", () => {
  const root = path.join(import.meta.dirname, "no-such-friday-folder");
  const reachAll = (states: Record<string, string>) => (hosts: string[]) =>
    Object.fromEntries(hosts.map((h) => [h, { state: states[h] ?? "up", ms: 3 }]));

  it("lists the hosts of a verified job, in order, with their state", () => {
    const list: Row[] = stack.inventory({ reach: reachAll({}) });
    const silero = list.find((r) => r.layer === "setup" && r.name === "silero-vad is verified");
    expect(silero?.detail).toMatch(
      /sources: huggingface\.co \(up\) > raw\.githubusercontent\.com \(up\)$/,
    );
    expect(silero?.state).toBe("PASS");
  });

  it("on a missing item whose first source is down but another is up, says so", () => {
    const list: Row[] = stack.inventory({
      root,
      reach: reachAll({ "huggingface.co": "down" }),
    });
    const silero = list.find((r) => r.layer === "disk" && r.name === "silero-vad");
    expect(silero?.detail).toContain("huggingface.co (down) > raw.githubusercontent.com (up)");
    expect(silero?.detail).toContain("first source huggingface.co is down now");
    expect(silero?.detail).toContain("raw.githubusercontent.com answers");
    const ollama = list.find((r) => r.layer === "disk" && r.name === "ollama-setup");
    expect(ollama?.state).toBe("FAIL");
    expect(ollama?.detail).toContain("sources: github.com (up)");
  });

  it("offline is 'not checked', never a failure of its own", () => {
    const offline = (hosts: string[]) =>
      Object.fromEntries(hosts.map((h) => [h, { state: "unchecked", reason: "offline" }]));
    const list: Row[] = stack.inventory({ root, reach: offline });
    const stt = list.find((r) => r.layer === "disk" && r.name === "stt-small");
    expect(stt?.detail).toContain("not checked: offline");
    // The verdict is the same as without any probe.
    const plain: Row[] = stack.inventory({ root });
    const states = (l: Row[]) =>
      l.filter((r) => r.layer === "disk").map((r) => `${r.name}:${r.state}`);
    expect(states(list)).toEqual(states(plain));
  });
});

describe("engines in a Python package are proven with the venv python", () => {
  const chains = {
    denoise: { hi: ["rnnoise"], en: ["rnnoise"], hinglish: ["rnnoise"] },
    stt: { hi: ["moonshine-en"] },
  };

  it("lists an importable package as installed and a missing one as not installed, never 'not checked'", () => {
    const present = stack.engineProof({
      mods: { pyrnnoise: true, moonshine_voice: true },
      root: "",
      exists: () => false,
      moonshineReady: true,
    });
    const here = stack.engineRows(chains, new Set(), present);
    expect(here.find((r: Row) => r.name === "denoise")?.detail).toBe(
      "active rnnoise; no fallback installed",
    );
    expect(here.find((r: Row) => r.name === "stt hi")?.detail).toBe(
      "active moonshine-en; no fallback installed",
    );
    const absent = stack.engineProof({
      mods: { pyrnnoise: false, moonshine_voice: true },
      root: "",
      exists: () => false,
      moonshineReady: false,
    });
    const gone = stack.engineRows(chains, new Set(), absent);
    expect(gone.find((r: Row) => r.name === "denoise")?.detail).toBe(
      "no engine installed (not installed: 1)",
    );
    // The package alone is not the English ear: its model folder must be there too.
    expect(gone.find((r: Row) => r.name === "stt hi")?.detail).toContain("not installed: 1");
    expect(gone.every((r: Row) => !r.detail.includes("not checked here"))).toBe(true);
  });

  it("without a python answer it still says 'not checked here' for the package engines", () => {
    const proof = stack.engineProof({
      mods: null,
      root: "",
      exists: () => false,
      moonshineReady: false,
    });
    const list = stack.engineRows(chains, new Set(), proof);
    expect(list.find((r: Row) => r.name === "denoise")?.detail).toContain(
      "not checked here: rnnoise",
    );
  });

  it("proves the speaker file by its file, in the folders voice_runtime.py looks in", () => {
    const there = new Set([path.join("/f", "models", "voice", "wespeaker-ecapa.onnx")]);
    expect(
      stack
        .engineProof({
          mods: null,
          root: "/f",
          exists: (p: string) => there.has(p),
          moonshineReady: false,
        })
        .present.has("wespeaker-ecapa"),
    ).toBe(true);
    expect(
      stack
        .engineProof({ mods: null, root: "/f", exists: () => false, moonshineReady: false })
        .absent.has("wespeaker-ecapa"),
    ).toBe(true);
  });

  it("the probed modules cover every package engine and the language packages", () => {
    for (const mod of [
      "pyrnnoise",
      "openwakeword",
      "fasttext",
      "moonshine_voice",
      "pyaec",
      "supertonic",
      "onnx_asr",
      "sentencepiece",
      "faster_whisper",
    ])
      expect(stack.VOICE_MODULES, mod).toContain(mod);
  });
});

describe("one row per language and role, by this PC's plan", () => {
  const mods = (over: Record<string, boolean> = {}) => ({
    pyrnnoise: true,
    pyaec: true,
    supertonic: true,
    numpy: true,
    onnx_asr: true,
    sentencepiece: true,
    moonshine_voice: true,
    faster_whisper: true,
    onnxruntime: true,
    ...over,
  });
  const plan = (required: string[], skipped: Record<string, string> = {}) => ({
    required: required.map((id) => ({ id, kind: "voice-model", action: "install" })),
    skipped: Object.entries(skipped).map(([id, reason]) => ({ id, reason })),
  });
  const rowsOf = (over: Record<string, unknown>) =>
    stack.languageRows({
      onDisk: new Set<string>(),
      view: stack.planView(plan([]), null),
      mods: mods(),
      packagesRequired: true,
      moonshine: { ready: false },
      env: {},
      hasPython: true,
      ...over,
    }) as Row[];
  const get = (list: Row[], name: string) => list.find((r) => r.name === name);

  it("has Hindi, English and Hinglish rows for ears, speaking and punctuation, the light voice and the fallback ear", () => {
    const names = rowsOf({}).map((r) => r.name);
    for (const name of [
      "hindi ears (STT)",
      "hindi fallback ear",
      "hindi speaking (TTS)",
      "hindi light TTS",
      "hindi punctuation",
      "english ears (STT)",
      "english speaking (TTS)",
      "hinglish ears (STT)",
      "hinglish speaking (TTS)",
      "hinglish punctuation",
      "noise suppression (all languages)",
      "echo canceller (all languages)",
    ])
      expect(names, name).toContain(name);
    expect(rowsOf({}).every((r) => r.layer === "language")).toBe(true);
  });

  it("a model the plan carries and the disk lacks is MISSING (FAIL); on disk with its package is PASS", () => {
    const view = stack.planView(
      plan(["hindi-ear", "hindi-light-tts", "hinglish-ear", "hindi-fallback-ear"]),
      null,
    );
    const missing = rowsOf({ view });
    for (const name of [
      "hindi ears (STT)",
      "hindi light TTS",
      "hinglish ears (STT)",
      "hindi fallback ear",
    ]) {
      expect(get(missing, name)?.state, name).toBe("FAIL");
      expect(get(missing, name)?.detail, name).toContain("MISSING: planned for this PC");
    }
    const onDisk = new Set(["hindi-ear", "hindi-light-tts", "hinglish-ear", "hindi-fallback-ear"]);
    const fine = rowsOf({ view, onDisk });
    for (const name of [
      "hindi ears (STT)",
      "hindi light TTS",
      "hinglish ears (STT)",
      "hindi fallback ear",
    ])
      expect(get(fine, name)?.state, name).toBe("PASS");
    expect(get(fine, "hindi ears (STT)")?.detail).toBe(
      "hindi-ear on disk; package numpy present; package onnxruntime present; package onnx-asr present (fallback)",
    );
  });

  it("a model the plan skipped on this PC is INFO with the plan's reason, never MISSING", () => {
    const view = stack.planView(
      plan(["hindi-ear"], {
        "hinglish-ear": "not enough RAM: needs 6 GB, the speech budget here is 4 GB",
      }),
      null,
    );
    const list = rowsOf({ view });
    expect(get(list, "hinglish ears (STT)")?.state).toBe("INFO");
    expect(get(list, "hinglish ears (STT)")?.detail).toContain(
      "hinglish-ear skipped on this PC: not enough RAM",
    );
    // Not in the plan at all (an optional extra): information too, and it says where it can be installed.
    expect(get(list, "hindi light TTS")?.state).toBe("INFO");
    expect(get(list, "hindi light TTS")?.detail).toContain("not planned for this PC");
    expect(list.some((r) => /MISSING/.test(r.detail) && r.name === "hinglish ears (STT)")).toBe(
      false,
    );
  });

  it("a missing package is FAIL where the PC must have it and INFO where it need not; unknown stays 'not checked'", () => {
    const view = stack.planView(plan(["hindi-ear"]), null);
    const onDisk = new Set(["hindi-ear"]);
    const strict = rowsOf({ view, onDisk, mods: mods({ onnxruntime: false }) });
    expect(get(strict, "hindi ears (STT)")?.state).toBe("FAIL");
    expect(get(strict, "hindi ears (STT)")?.detail).toContain(
      "package onnxruntime NOT installed in the venv",
    );
    const noNumpy = rowsOf({ view, onDisk, mods: mods({ numpy: false }) });
    expect(get(noNumpy, "hindi ears (STT)")?.state).toBe("FAIL");
    const relaxed = rowsOf({
      view,
      onDisk,
      mods: mods({ onnxruntime: false }),
      packagesRequired: false,
    });
    expect(get(relaxed, "hindi ears (STT)")?.state).toBe("INFO");
    const unknown = rowsOf({ view, onDisk, mods: null });
    expect(get(unknown, "hindi ears (STT)")?.state).toBe("INFO");
    expect(get(unknown, "hindi ears (STT)")?.detail).toContain(
      "package onnxruntime not checked (no venv python)",
    );
    // A package of an engine this PC does not carry is not a gap.
    const none = rowsOf({ view, mods: mods({ faster_whisper: false }) });
    expect(get(none, "hinglish ears (STT)")?.state).toBe("INFO");
  });

  it("the Hindi ear needs only the own runner (numpy + onnxruntime); onnx-asr is an optional fallback", () => {
    const view = stack.planView(plan(["hindi-ear"]), null);
    const onDisk = new Set(["hindi-ear"]);
    const own = rowsOf({ view, onDisk, mods: mods({ onnx_asr: false }) });
    expect(get(own, "hindi ears (STT)")?.state).toBe("PASS");
    expect(get(own, "hindi ears (STT)")?.detail).toContain("own runner");
    const both = rowsOf({ view, onDisk });
    expect(get(both, "hindi ears (STT)")?.state).toBe("PASS");
    expect(get(both, "hindi ears (STT)")?.detail).toContain("package onnx-asr present (fallback)");
    expect(stack.VOICE_MODULES).toContain("numpy");
  });

  it("Moonshine is planned on every PC: missing is MISSING, switched off or no Python is skipped on this PC", () => {
    expect(get(rowsOf({}), "english ears (STT)")?.state).toBe("FAIL");
    expect(get(rowsOf({}), "english ears (STT)")?.detail).toContain("moonshine-en MISSING");
    const off = get(rowsOf({ env: { FRIDAY_PREFETCH_MOONSHINE: "0" } }), "english ears (STT)");
    expect(off?.state).toBe("INFO");
    expect(off?.detail).toContain("moonshine-en skipped on this PC: its prefetch is switched off");
    const noPython = get(rowsOf({ hasPython: false, mods: null }), "english ears (STT)");
    expect(noPython?.state).toBe("INFO");
    expect(noPython?.detail).toContain("no Python runtime yet");
    const ready = get(rowsOf({ moonshine: { ready: true } }), "english ears (STT)");
    expect(ready?.state).toBe("PASS");
    expect(
      get(
        rowsOf({ moonshine: { ready: true }, mods: mods({ moonshine_voice: false }) }),
        "english ears (STT)",
      )?.state,
    ).toBe("FAIL");
  });

  it("noise and echo rows are tied to pyrnnoise and pyaec", () => {
    const list = rowsOf({ mods: mods({ pyrnnoise: false }) });
    expect(get(list, "noise suppression (all languages)")?.state).toBe("FAIL");
    expect(get(list, "noise suppression (all languages)")?.detail).toContain(
      "package pyrnnoise NOT installed",
    );
    expect(get(list, "echo canceller (all languages)")?.state).toBe("PASS");
  });

  it("without the plan data the voice plan decides, and with neither it says the plan could not be read", () => {
    const fromVoicePlan = stack.planView(null, {
      items: [
        { id: "hindi-ear", state: "download" },
        { id: "hinglish-ear", state: "skipped", reason: "disk" },
      ],
    });
    expect(fromVoicePlan.planned.has("hindi-ear")).toBe(true);
    expect(fromVoicePlan.skipped.get("hinglish-ear")).toBe("disk");
    const blind = rowsOf({ view: stack.planView(null, null) });
    expect(get(blind, "hindi ears (STT)")?.state).toBe("INFO");
    expect(get(blind, "hindi ears (STT)")?.detail).toContain("this PC's plan could not be read");
  });
});

describe("inventory with a root reads the plan data, the venv python and the sources together", () => {
  it("builds the language rows from planData and the python probe, and the disk rows from the same plan", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "friday-lang-"));
    try {
      const planData = {
        required: [
          { id: "hindi-ear", kind: "voice-model", action: "install" },
          { id: "hindi-light-tts", kind: "voice-model", action: "install" },
        ],
        skipped: [{ id: "hinglish-ear", reason: "not enough RAM for the ear" }],
      };
      const asked: string[][] = [];
      const run = (_py: string, args: string[]) => {
        asked.push(args.slice(2));
        return {
          status: 0,
          stdout: `PYMODS ${JSON.stringify(Object.fromEntries(args.slice(2).map((m) => [m, m !== "supertonic"])))}\n`,
        };
      };
      const list: Row[] = stack.inventory({
        root: dir,
        planData,
        python: "py",
        run,
        platform: "win32",
        env: {},
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toEqual(stack.VOICE_MODULES);
      const lang = (name: string) => list.find((r) => r.layer === "language" && r.name === name);
      expect(lang("hindi light TTS")?.state).toBe("FAIL");
      expect(lang("hinglish ears (STT)")?.detail).toContain("skipped on this PC: not enough RAM");
      expect(lang("hindi speaking (TTS)")?.detail).toContain("package supertonic NOT installed");
      const disk = list.filter((r) => r.layer === "disk").map((r) => r.name);
      expect(disk).toContain("hindi-light-tts");
      expect(disk).not.toContain("hinglish-ear");
      // The package engines are now proven, not "not checked".
      expect(list.find((r) => r.layer === "engine" && r.name === "denoise")?.detail).toContain(
        "active rnnoise",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the language rows only appear with a folder, so a bare inventory has none", () => {
    expect(rows.some((r) => r.layer === "language")).toBe(false);
  });
});
