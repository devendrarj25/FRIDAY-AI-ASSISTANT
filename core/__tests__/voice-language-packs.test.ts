/**
 * Voice language packs: named bundles (English, Hindi, Hinglish) of the voice models this repository already pins.
 * One action installs every missing member through the existing Install Manager path, in a safe order, skipping
 * what is installed and repairing what is damaged. Offline: the disk is a temp folder, the installer is injected,
 * and no weight is downloaded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  ENGLISH_EAR_CHOICES,
  STT_SIZE_MODEL,
  englishEarSize,
  modelById,
  packBytes,
  packMembers,
  packPlan,
  packStatus,
  voicePackById,
  voicePacks,
} from "../../src/lib/friday/model-catalog";
import { runPackInstall, VOICE_MODEL_IDS } from "../../src/lib/friday/models-engine";
import { applySttTier } from "../../src/lib/friday/voice-session";

type Pin = { files: Record<string, { bytes: number }> };
type PackRow = {
  id: string;
  members: Array<{ id: string; swap?: string }>;
};
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  pinForRepo: (repo: string) => Pin | null;
  pinnedBytes: (pin: Pin) => number;
};
const weights = req("../../electron/voice-weights.cjs") as {
  STT_REPOS: Record<string, string>;
  STT_CATALOG: Record<string, string>;
  TTS_REPO: string;
  EAR_MODELS: Array<{ catalogId: string; repo: string }>;
  EXTRA_MODELS: Array<{ catalogId: string; repo: string }>;
  pinnedJobs: () => Array<{ id: string; bytes: number }>;
  VOICE_PACKS: PackRow[];
  packChecks: (
    root: string,
    deps: Record<string, unknown>,
  ) => Promise<
    Array<{
      id: string;
      ok: boolean;
      optional: boolean;
      required: boolean;
      installId: string;
      detail: string;
    }>
  >;
};
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");

/** The pinned size of a catalog id, from the pins (the speech sizes, the ears, the voices, the two helpers). */
function pinnedBytesOf(catalogId: string): number {
  const size = Object.keys(weights.STT_CATALOG).find(
    (key) => weights.STT_CATALOG[key] === catalogId,
  );
  if (size) return pins.pinnedBytes(pins.pinForRepo(weights.STT_REPOS[size]!)!);
  const extra = [...weights.EAR_MODELS, ...weights.EXTRA_MODELS].find(
    (row) => row.catalogId === catalogId,
  );
  if (extra) return pins.pinnedBytes(pins.pinForRepo(extra.repo)!);
  if (catalogId === "supertonic-3") return pins.pinnedBytes(pins.pinForRepo(weights.TTS_REPO)!);
  const helper = weights.pinnedJobs().find((row) => row.id === catalogId);
  if (helper) return helper.bytes;
  throw new Error(`no pin for ${catalogId}`);
}

const ids = (pack: string) => packMembers(voicePackById.get(pack)!).map((m) => m.id);
const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the pack catalog", () => {
  it("has the three packs as kind voice-pack with plain words", () => {
    expect(voicePacks.map((p) => p.id)).toEqual([
      "voice-pack-english",
      "voice-pack-hindi",
      "voice-pack-hinglish",
    ]);
    for (const pack of voicePacks) {
      expect(pack.kind).toBe("voice-pack");
      expect(pack.label.length).toBeGreaterThan(3);
      expect(pack.description.length).toBeGreaterThan(40);
      expect(pack.description).not.toMatch(/torch|vosk|sherpa|kokoro|piper-tts/i);
    }
  });

  it("holds exactly the members the owner asked for, in a safe order", () => {
    expect(ids("voice-pack-english")).toEqual([
      "silero-vad",
      "smart-turn",
      "faster-whisper-small",
      "supertonic-3",
    ]);
    expect(ids("voice-pack-hindi")).toEqual([
      "hindi-ear",
      "hindi-punct",
      "hindi-light-tts",
      "supertonic-3",
      "hindi-fallback-ear",
    ]);
    expect(ids("voice-pack-hinglish")).toEqual([
      "hinglish-ear",
      "hindi-ear",
      "hindi-punct",
      "silero-vad",
      "smart-turn",
      "faster-whisper-small",
      "supertonic-3",
    ]);
  });

  it("has no orphan member: every id is a catalog row and a voice model the page tracks", () => {
    for (const pack of voicePacks) {
      for (const choice of [null, ...Object.keys(ENGLISH_EAR_CHOICES)]) {
        for (const member of packMembers(pack, { sttSize: choice ?? undefined })) {
          expect(modelById.has(member.id), `${pack.id}: ${member.id}`).toBe(true);
          expect(VOICE_MODEL_IDS as readonly string[]).toContain(member.id);
          expect(modelById.get(member.id)!.kind).toBe("local");
        }
      }
    }
  });

  it("never lists an ear that is not pinned here: Moonshine weights are not pinned, so they are not a member", () => {
    for (const pack of voicePacks) {
      expect(JSON.stringify(pack)).not.toMatch(/moonshine/i);
      for (const member of packMembers(pack)) expect(() => pinnedBytesOf(member.id)).not.toThrow();
    }
  });

  it("adds each member's bytes from the pins, and the pack total is their sum", () => {
    for (const pack of voicePacks) {
      let sum = 0;
      for (const member of packMembers(pack)) {
        expect(member.bytes, `${pack.id}: ${member.id}`).toBe(pinnedBytesOf(member.id));
        sum += member.bytes;
      }
      expect(packBytes(pack)).toBe(sum);
      expect(sum).toBeGreaterThan(0);
    }
    for (const [size, row] of Object.entries(ENGLISH_EAR_CHOICES)) {
      expect(row.id).toBe(STT_SIZE_MODEL[size]);
      expect(row.bytes).toBe(pinnedBytesOf(row.id));
    }
  });

  it("shows the CC-BY credits of the Collabora ear and the light Hindi voice", () => {
    const hindi = voicePackById.get("voice-pack-hindi")!;
    const text = hindi.credits.join("\n");
    expect(text).toMatch(/Collabora/);
    expect(text).toMatch(/Sulabh Katiyar/);
    expect(text).toMatch(/CC-BY-4\.0/);
    for (const pack of voicePacks) {
      const members = packMembers(pack).map((m) => modelById.get(m.id)!);
      for (const model of members.filter((m) => /CC-BY/.test(m.license))) {
        const credited = pack.credits.some((line) => line.includes("CC-BY-4.0"));
        expect(credited, `${pack.id} credits ${model.id}`).toBe(true);
      }
    }
    // The Hinglish pack does not carry the Collabora ear, so it does not claim that credit either.
    expect(voicePackById.get("voice-pack-hinglish")!.credits.join("\n")).not.toMatch(/Collabora/);
  });

  it("keeps the memberships equal to the Doctor's copy in electron/voice-weights.cjs", () => {
    expect(weights.VOICE_PACKS.map((p) => p.id)).toEqual(voicePacks.map((p) => p.id));
    for (const pack of voicePacks) {
      const cjs = weights.VOICE_PACKS.find((p) => p.id === pack.id)!;
      expect(cjs.members.map((m) => [m.id, m.swap ?? null])).toEqual(
        pack.members.map((m) => [m.id, m.swap ?? null]),
      );
    }
  });

  it("names the recognition language that makes the listening path use each pack", () => {
    expect(voicePackById.get("voice-pack-english")!.recognitionLang).toBe("en-IN");
    expect(voicePackById.get("voice-pack-hindi")!.recognitionLang).toBe("hi-IN");
    expect(voicePackById.get("voice-pack-hinglish")!.recognitionLang).toBe("hi-Latn");
  });
});

describe("the English ear size", () => {
  it("is the size the listening path really opens: small on auto, the owner's size when locked", () => {
    expect(englishEarSize("auto")).toBe("small");
    expect(englishEarSize(undefined)).toBe("small");
    expect(englishEarSize("medium")).toBe("medium");
    expect(englishEarSize("large-v3-turbo")).toBe("large-v3-turbo");
    expect(englishEarSize("huge")).toBe("small");
    expect(ids("voice-pack-english")).toContain("faster-whisper-small");
    expect(
      packMembers(voicePackById.get("voice-pack-english")!, { sttSize: "medium" }).map((m) => m.id),
    ).toContain("faster-whisper-medium");
  });

  it("agrees with the renderer's tier table for the default, so the two cannot drift", () => {
    expect(applySttTier({ auto: false, ramGb: 16, gpu: false, battery: false })).toBe(
      englishEarSize("auto"),
    );
  });

  it("does not let a stored odd value swap in a model the pins do not hold", () => {
    for (const odd of ["", "  ", "__proto__", "constructor", "toString", "मध्यम"]) {
      expect(englishEarSize(odd)).toBe("small");
    }
  });
});

describe("pack status from the real installed state", () => {
  const english = () => voicePackById.get("voice-pack-english")!;
  const all = (pack: string) => ids(pack);

  it("is not installed when nothing is, partly installed when some members are, installed when all are", () => {
    expect(packStatus(english(), new Set()).state).toBe("not-installed");
    expect(packStatus(english(), new Set(["silero-vad"])).state).toBe("partial");
    expect(packStatus(english(), new Set(all("voice-pack-english"))).state).toBe("installed");
  });

  it("reads a set, a list, and the Models-page record (a null or empty version is not installed)", () => {
    const have = ["silero-vad", "smart-turn"];
    const record = Object.fromEntries(have.map((id) => [id, "1"]));
    const a = packStatus(english(), new Set(have));
    const b = packStatus(english(), have);
    const c = packStatus(english(), {
      ...record,
      "supertonic-3": null,
      "faster-whisper-small": "",
    });
    for (const row of [a, b, c]) {
      expect(row.state).toBe("partial");
      expect(row.have).toEqual(have);
      expect(row.missing).toEqual(["faster-whisper-small", "supertonic-3"]);
    }
  });

  it("counts a damaged member as not complete and says which one", () => {
    const row = packStatus(english(), new Set(all("voice-pack-english")), {
      damaged: ["smart-turn", "not-a-member"],
    });
    expect(row.state).toBe("partial");
    expect(row.damaged).toEqual(["smart-turn"]);
    expect(row.missing).toEqual([]);
    expect(row.members.find((m) => m.id === "smart-turn")!.state).toBe("damaged");
  });

  it("sums the bytes still to fetch from the pins, and nothing for an installed pack", () => {
    const none = packStatus(english(), new Set());
    expect(none.bytesTotal).toBe(packBytes(english()));
    expect(none.bytesMissing).toBe(packBytes(english()));
    const some = packStatus(english(), new Set(["supertonic-3"]));
    expect(some.bytesMissing).toBe(packBytes(english()) - pinnedBytesOf("supertonic-3"));
    expect(packStatus(english(), new Set(all("voice-pack-english"))).bytesMissing).toBe(0);
  });

  it("follows the English ear size: a different locked size is a different member", () => {
    const have = new Set(all("voice-pack-english"));
    expect(packStatus(english(), have, { sttSize: "medium" }).missing).toEqual([
      "faster-whisper-medium",
    ]);
  });

  it("shares Supertonic between packs: installing one pack completes the other's common members", () => {
    const hindi = voicePackById.get("voice-pack-hindi")!;
    const row = packStatus(hindi, new Set(["supertonic-3"]));
    expect(row.have).toEqual(["supertonic-3"]);
    expect(row.state).toBe("partial");
  });
});

describe("pack plan", () => {
  const hindi = () => voicePackById.get("voice-pack-hindi")!;

  it("queues every missing member in the declared order, with its size", () => {
    const plan = packPlan(hindi(), new Set());
    expect(plan.steps.map((s) => s.id)).toEqual(ids("voice-pack-hindi"));
    expect(plan.steps.every((s) => s.action === "install")).toBe(true);
    expect(plan.skipped).toEqual([]);
    expect(plan.bytes).toBe(packBytes(hindi()));
  });

  it("skips what is installed", () => {
    const plan = packPlan(hindi(), new Set(["hindi-ear", "supertonic-3"]));
    expect(plan.steps.map((s) => s.id)).toEqual([
      "hindi-punct",
      "hindi-light-tts",
      "hindi-fallback-ear",
    ]);
    expect(plan.skipped).toEqual(["hindi-ear", "supertonic-3"]);
  });

  it("repairs a damaged member in place instead of skipping it", () => {
    const plan = packPlan(hindi(), new Set(ids("voice-pack-hindi")), { damaged: ["hindi-punct"] });
    expect(plan.steps).toEqual([expect.objectContaining({ id: "hindi-punct", action: "repair" })]);
    expect(plan.skipped).toEqual(ids("voice-pack-hindi").filter((id) => id !== "hindi-punct"));
  });

  it("has nothing to do for a complete pack", () => {
    const plan = packPlan(hindi(), new Set(ids("voice-pack-hindi")));
    expect(plan.steps).toEqual([]);
    expect(plan.bytes).toBe(0);
  });
});

describe("installing a pack", () => {
  const hinglish = () => voicePackById.get("voice-pack-hinglish")!;
  const okInstaller = () =>
    vi.fn(async (_id: string, _action: "install" | "repair") => ({ ok: true as const }));

  it("installs each missing member once, in order, and reports them done", async () => {
    const installer = okInstaller();
    const done: string[] = [];
    const run = await runPackInstall(hinglish(), {
      installed: new Set(["hindi-ear"]),
      installer,
      onMember: (row) => done.push(`${row.id}:${row.state}`),
    });
    const expected = ids("voice-pack-hinglish").filter((id) => id !== "hindi-ear");
    expect(installer.mock.calls.map((c) => c[0])).toEqual(expected);
    expect(run).toMatchObject({ ok: true, failed: null, remaining: [], skipped: ["hindi-ear"] });
    expect(run.installed).toEqual(expected);
    expect(done[0]).toBe(`${expected[0]}:installing`);
    expect(done).toContain(`${expected[0]}:done`);
  });

  it("does nothing, and says so, when the pack is already complete", async () => {
    const installer = okInstaller();
    const run = await runPackInstall(hinglish(), {
      installed: new Set(ids("voice-pack-hinglish")),
      installer,
    });
    expect(installer).not.toHaveBeenCalled();
    expect(run).toMatchObject({ ok: true, installed: [], failed: null });
  });

  it("stops at the first failed member, names it, and leaves the rest resumable", async () => {
    const order = ids("voice-pack-hinglish");
    const installer = vi.fn(async (id: string, _action?: string) =>
      id === "hindi-punct"
        ? { ok: false as const, error: "no route to huggingface.co" }
        : { ok: true as const },
    );
    const have = new Set<string>();
    const first = await runPackInstall(hinglish(), {
      installed: have,
      installer: async (id, action) => {
        const result = await installer(id, action);
        if (result.ok) have.add(id);
        return result;
      },
    });
    expect(first.ok).toBe(false);
    expect(first.failed).toEqual({ id: "hindi-punct", error: "no route to huggingface.co" });
    expect(first.installed).toEqual(["hinglish-ear", "hindi-ear"]);
    expect(first.remaining).toEqual(order.slice(order.indexOf("hindi-punct")));
    expect(installer.mock.calls.map((c) => c[0])).toEqual(order.slice(0, 3));

    // The network is back: the second run touches only what is left, and installs it.
    const again = okInstaller();
    const second = await runPackInstall(hinglish(), { installed: have, installer: again });
    expect(again.mock.calls.map((c) => c[0])).toEqual(order.slice(order.indexOf("hindi-punct")));
    expect(second.ok).toBe(true);
    expect(second.skipped).toEqual(["hinglish-ear", "hindi-ear"]);
  });

  it("turns a thrown installer into an honest failure for that member", async () => {
    const run = await runPackInstall(hinglish(), {
      installed: new Set(),
      installer: async () => {
        throw new Error("disk full");
      },
    });
    expect(run.ok).toBe(false);
    expect(run.failed).toEqual({ id: "hinglish-ear", error: "disk full" });
    expect(run.remaining).toEqual(ids("voice-pack-hinglish"));
  });

  it("repairs a damaged member and installs a missing one in the same run", async () => {
    const installer = okInstaller();
    const have = new Set(ids("voice-pack-hinglish").filter((id) => id !== "silero-vad"));
    const run = await runPackInstall(hinglish(), {
      installed: have,
      damaged: ["hindi-ear"],
      installer,
    });
    expect(installer.mock.calls).toEqual([
      ["hindi-ear", "repair"],
      ["silero-vad", "install"],
    ]);
    expect(run.ok).toBe(true);
  });

  it("stops before the next member when cancelled, and keeps what finished", async () => {
    const controller = new AbortController();
    const installer = vi.fn(async (id: string) => {
      if (id === "hindi-ear") controller.abort();
      return { ok: true as const };
    });
    const run = await runPackInstall(hinglish(), {
      installed: new Set(),
      installer,
      signal: controller.signal,
    });
    expect(run.ok).toBe(false);
    expect(run.cancelled).toBe(true);
    expect(run.failed).toBeNull();
    expect(run.installed).toEqual(["hinglish-ear", "hindi-ear"]);
    expect(run.remaining[0]).toBe("hindi-punct");
  });

  it("refuses a pack id it does not know", async () => {
    const installer = okInstaller();
    const run = await runPackInstall("voice-pack-klingon", { installed: new Set(), installer });
    expect(run.ok).toBe(false);
    expect(run.failed?.error).toMatch(/unknown voice pack/i);
    expect(installer).not.toHaveBeenCalled();
  });
});

describe("the Models store installs a pack through its own install path", () => {
  const stub = (friday: Record<string, unknown>) =>
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout,
      friday: { isDesktop: true, ...friday },
    });

  it("queues one download job per missing member, one at a time, and finishes the pack", async () => {
    let onDone: (event: Record<string, unknown>) => void = () => {};
    const seen: string[] = [];
    stub({
      onModelPullProgress: () => () => {},
      onModelPullDone: (cb: typeof onDone) => {
        onDone = cb;
        return () => {};
      },
      downloadModel: async (req: { modelId: string; jobId: string }) => {
        seen.push(req.modelId);
        queueMicrotask(() => onDone({ jobId: req.jobId, ok: true, model: req.modelId }));
        return { ok: true };
      },
    });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    for (const id of ["silero-vad", "smart-turn"]) models.state.installed[id] = "1";
    const run = await models.installPack("voice-pack-english");
    expect(seen).toEqual(["faster-whisper-small", "supertonic-3"]);
    expect(run.ok).toBe(true);
    expect(models.state.packRuns["voice-pack-english"]?.phase).toBe("done");
  });

  it("reports the failed member when a download fails and does not queue the rest", async () => {
    let onDone: (event: Record<string, unknown>) => void = () => {};
    const seen: string[] = [];
    stub({
      onModelPullProgress: () => () => {},
      onModelPullDone: (cb: typeof onDone) => {
        onDone = cb;
        return () => {};
      },
      downloadModel: async (req: { modelId: string; jobId: string }) => {
        seen.push(req.modelId);
        queueMicrotask(() =>
          onDone({ jobId: req.jobId, ok: false, model: req.modelId, error: "hash mismatch" }),
        );
        return { ok: false, error: "hash mismatch" };
      },
    });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    const run = await models.installPack("voice-pack-hindi");
    expect(seen).toEqual(["hindi-ear"]);
    expect(run.ok).toBe(false);
    expect(run.failed?.id).toBe("hindi-ear");
    expect(models.state.packRuns["voice-pack-hindi"]).toMatchObject({
      phase: "failed",
      failed: { id: "hindi-ear" },
    });
    expect(models.state.packRuns["voice-pack-hindi"]?.remaining).toEqual(ids("voice-pack-hindi"));
  });

  it("lets the Doctor's install button name a pack id", async () => {
    stub({ downloadModel: async () => ({ ok: false, error: "offline" }) });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    models.install("voice-pack-hinglish");
    await vi.waitFor(() =>
      expect(models.state.packRuns["voice-pack-hinglish"]?.phase).toBe("failed"),
    );
  });

  it("does not start a second run of the same pack while one is running", async () => {
    let release: () => void = () => {};
    stub({
      onModelPullProgress: () => () => {},
      onModelPullDone: () => () => {},
      downloadModel: () =>
        new Promise<{ ok: boolean }>((resolve) => (release = () => resolve({ ok: false }))),
    });
    const { models } = await import("../../src/lib/friday/models-engine");
    models.state.bridge = "desktop";
    const first = models.installPack("voice-pack-hindi");
    const second = await models.installPack("voice-pack-hindi");
    expect(second.ok).toBe(false);
    expect(second.failed?.error).toMatch(/already running/i);
    models.cancel(models.state.jobs[0]!.id);
    release();
    await first;
  });
});

describe("Doctor rows for the packs", () => {
  const make = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-packs-"));
    folders.push(root);
    return root;
  };
  const touch = (root: string, ...parts: string[]) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  };
  const exists = (file: string) => fs.existsSync(file);

  /** Put the files a pin lists on disk, so the member counts as installed (sizes are not checked here). */
  function install(root: string, catalogId: string) {
    const size = Object.keys(weights.STT_CATALOG).find((k) => weights.STT_CATALOG[k] === catalogId);
    if (size) {
      touch(root, "cache", "stt", size, "config.json");
      touch(root, "cache", "stt", size, "model.bin");
      return;
    }
    const row = weights.pinnedJobs().find((r) => r.id === catalogId) as
      ({ id: string; file: string; dir: string[] } & { bytes: number }) | undefined;
    if (row) return touch(root, ...row.dir, row.file);
    if (catalogId === "supertonic-3")
      return touch(root, "models", "supertonic-3", "onnx", "vocoder.onnx");
    const extra = [...weights.EAR_MODELS, ...weights.EXTRA_MODELS].find(
      (r) => r.catalogId === catalogId,
    )!;
    const pin = pins.pinForRepo(extra.repo)!;
    for (const name of Object.keys(pin.files)) touch(root, "models", catalogId, name);
  }

  it("shows one optional row per pack, with the install button, when nothing is installed", async () => {
    const rows = await weights.packChecks(make(), { exists, pinRows: [] });
    expect(rows.map((r) => r.id)).toEqual(voicePacks.map((p) => p.id));
    for (const row of rows) {
      expect(row).toMatchObject({ ok: false, optional: true, required: false, installId: row.id });
      expect(row.detail).toMatch(/not installed/i);
    }
  });

  it("is green and offers nothing to install when every member is on disk and matches its pin", async () => {
    const root = make();
    for (const id of ids("voice-pack-hindi")) install(root, id);
    const rows = await weights.packChecks(root, { exists, pinRows: [] });
    const row = rows.find((r) => r.id === "voice-pack-hindi")!;
    expect(row).toMatchObject({ ok: true, installId: "" });
    expect(rows.find((r) => r.id === "voice-pack-english")!.ok).toBe(false);
  });

  it("names what is missing in a partly installed pack", async () => {
    const root = make();
    for (const id of ["hindi-ear", "supertonic-3"]) install(root, id);
    const row = (await weights.packChecks(root, { exists, pinRows: [] })).find(
      (r) => r.id === "voice-pack-hindi",
    )!;
    expect(row.ok).toBe(false);
    expect(row.installId).toBe("voice-pack-hindi");
    expect(row.detail).toMatch(/partly installed/i);
    expect(row.detail).toMatch(/hindi-punct/);
    expect(row.detail).not.toMatch(/hindi-ear[,)]/);
  });

  it("flags a member whose pin row failed, so the install button repairs it", async () => {
    const root = make();
    for (const id of ids("voice-pack-hindi")) install(root, id);
    const row = (
      await weights.packChecks(root, {
        exists,
        pinRows: [
          { id: "hindi-punct-pin", ok: false, detail: "punct_cap_seg_47lang.onnx fails SHA-256" },
          { id: "hindi-ear-pin", ok: true, detail: "ok" },
        ],
      })
    ).find((r) => r.id === "voice-pack-hindi")!;
    expect(row.ok).toBe(false);
    expect(row.installId).toBe("voice-pack-hindi");
    expect(row.detail).toMatch(/damaged/i);
    expect(row.detail).toMatch(/hindi-punct/);
  });

  it("is wired into the voice check next to the pin rows", () => {
    const source = read("electron/voice-verify.cjs");
    expect(source).toMatch(/weights\.packChecks\(/);
    expect(source).toMatch(/pinRows/);
  });
});
