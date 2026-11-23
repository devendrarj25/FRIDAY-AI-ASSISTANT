/**
 * The folder-level rules that keep a pinned voice model safe on disk: the disk-space preflight, the
 * unexpected-file quarantine, the verified move (across volumes too), the `.prev` revision swap with its
 * rollback, and the manifest fields every pinned model carries. Temp folders only: no network, no weights.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require_ = createRequire(import.meta.url);

type Pin = { revision: string; files: Record<string, { sha256: string; bytes: number }> };
type Facts = {
  repo: string;
  revision: string;
  diskBytes: number;
  minRamGb: number;
  recommendedRamGb: number;
  minVramGb: number;
  cpuOk: boolean;
  gpuOk: boolean;
  quantization: string;
  fallbackPriority: string;
  basis: "measured" | "estimated";
};
const pins = require_("../../electron/voice-pins.cjs") as {
  PINS: Record<string, Pin>;
  MARKER: string;
  DISK_FACTOR: number;
  pinnedBytes: (pin: Pin) => number;
  pinnedRepos: () => string[];
  manifestFor: (repo: string) => Facts | null;
  stateOf: (
    dir: string,
    pin: Pin,
    deps?: Record<string, unknown>,
  ) => Promise<{ installState: string; verifyState: string }>;
  diskPreflight: (
    dir: string,
    need: number,
    deps?: Record<string, unknown>,
  ) => { ok: boolean; requiredBytes: number; freeBytes: number | null; error: string };
  unexpectedFiles: (dir: string, pin: Pin) => string[];
  quarantineFiles: (
    dir: string,
    names: string[],
    to: string,
    deps?: Record<string, unknown>,
  ) => { moved: string[]; failed: string[]; to: string };
  moveVerified: (
    src: string,
    dest: string,
    deps?: Record<string, unknown>,
  ) => { ok: boolean; via: string; error?: string };
  writeMarker: (dir: string, repo: string, pin: Pin, deps?: Record<string, unknown>) => boolean;
  readMarker: (dir: string) => { repo: string; revision: string } | null;
  beginRevisionSwap: (
    dir: string,
    repo: string,
    pin: Pin,
    deps?: Record<string, unknown>,
  ) => { swapped: boolean; prev: string; seeded: string[]; reason: string };
  rollbackToPrevious: (dir: string) => { ok: boolean; revision: string; error: string };
  recoverSwap: (dir: string) => { recovered: boolean };
  auditDir: (dir: string, pin: Pin, deps?: Record<string, unknown>) => Promise<{ ok: boolean }>;
  previousInfo: (dir: string) => { exists: boolean; revision: string; bytes: number };
  discardPrevious: (dir: string) => boolean;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "friday-store-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function pinOf(content: Record<string, string>, revision: string): Pin {
  return {
    revision,
    files: Object.fromEntries(
      Object.entries(content).map(([name, text]) => [
        name,
        { sha256: sha(text), bytes: text.length },
      ]),
    ),
  };
}
function lay(dir: string, content: Record<string, string>) {
  for (const [name, text] of Object.entries(content)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}
const REV1 = "1".repeat(40);
const REV2 = "2".repeat(40);

describe("disk-space preflight (free space must be at least 1.3 times the bytes)", () => {
  it("passes when there is room, fails honestly when there is not, and says the numbers", () => {
    const dir = temp();
    const statfs = (free: number) => () => ({ bavail: free, bsize: 1 });
    expect(pins.DISK_FACTOR).toBe(1.3);
    expect(pins.diskPreflight(dir, 1000, { statfs: statfs(1300) }).ok).toBe(true);
    const short = pins.diskPreflight(dir, 1000, { statfs: statfs(1299) });
    expect(short.ok).toBe(false);
    expect(short.requiredBytes).toBe(1300);
    expect(short.freeBytes).toBe(1299);
    expect(short.error).toMatch(/not enough disk space/i);
    expect(short.error).toMatch(/1300 bytes/);
  });

  it("measures the nearest existing parent for a folder that is not there yet", () => {
    const dir = temp();
    const seen: string[] = [];
    pins.diskPreflight(path.join(dir, "a", "b"), 10, {
      statfs: (where: string) => {
        seen.push(where);
        return { bavail: 10 ** 9, bsize: 1 };
      },
    });
    expect(seen[0]).toBe(dir);
  });

  it("does not call an unreadable volume full", () => {
    const result = pins.diskPreflight(temp(), 10 ** 12, {
      statfs: () => {
        throw new Error("EPERM");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.freeBytes).toBeNull();
  });
});

describe("unexpected files in a pinned model folder are quarantined, never kept in place", () => {
  const content = { "config.json": "{}", "model.bin": "weights-v1", "onnx/a.onnx": "graph" };

  it("lists a file that is not in the pin and ignores FRIDAY's own and in-flight files", () => {
    const dir = temp();
    lay(dir, content);
    lay(dir, {
      "README.md": "x",
      "onnx/evil.dll": "MZ",
      "model.bin.part": "half",
      "model.bin.part.json": "{}",
      [pins.MARKER]: "{}",
      ".friday-complete": "t",
      ".cache/huggingface/download/model.bin.metadata": "m",
    });
    expect(pins.unexpectedFiles(dir, pinOf(content, REV1))).toEqual(["README.md", "onnx/evil.dll"]);
  });

  it("moves them out under a quarantine folder, keeping the relative path, and keeps the pinned files", () => {
    const dir = temp();
    const model = path.join(dir, "models", "voice");
    lay(model, { ...content, "extra/payload.bin": "zz", "notes.txt": "n" });
    const pin = pinOf(content, REV1);
    const to = path.join(dir, "cache", "quarantine", "voice-1");
    const extras = pins.unexpectedFiles(model, pin);
    const out = pins.quarantineFiles(model, extras, to);
    expect(out.failed).toEqual([]);
    expect(out.moved.sort()).toEqual(["extra/payload.bin", "notes.txt"]);
    expect(fs.readFileSync(path.join(to, "extra", "payload.bin"), "utf8")).toBe("zz");
    expect(pins.unexpectedFiles(model, pin)).toEqual([]);
    expect(fs.existsSync(path.join(model, "extra"))).toBe(false); // the emptied folder is gone too
    expect(fs.readFileSync(path.join(model, "model.bin"), "utf8")).toBe("weights-v1");
  });

  it("never moves a path that climbs out of the model folder", () => {
    const dir = temp();
    const model = path.join(dir, "m");
    lay(model, content);
    fs.writeFileSync(path.join(dir, "outside.txt"), "keep");
    const out = pins.quarantineFiles(model, ["../outside.txt"], path.join(dir, "q"));
    expect(out.moved).toEqual([]);
    expect(out.failed).toEqual(["../outside.txt"]);
    expect(fs.readFileSync(path.join(dir, "outside.txt"), "utf8")).toBe("keep");
  });
});

describe("a verified move: rename in one volume, copy + verify + delete across volumes", () => {
  it("renames when it can", () => {
    const dir = temp();
    const src = path.join(dir, "a.bin.part");
    fs.writeFileSync(src, "abc");
    const dest = path.join(dir, "a.bin");
    expect(pins.moveVerified(src, dest)).toMatchObject({ ok: true, via: "rename" });
    expect(fs.readFileSync(dest, "utf8")).toBe("abc");
    expect(fs.existsSync(src)).toBe(false);
  });

  it("falls back to copy, checks the copy, and only then deletes the source (EXDEV)", () => {
    const dir = temp();
    const src = path.join(dir, "a.part");
    fs.writeFileSync(src, "abc");
    const dest = path.join(dir, "out", "a.bin");
    const result = pins.moveVerified(src, dest, {
      rename: () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
    });
    expect(result).toMatchObject({ ok: true, via: "copy" });
    expect(fs.readFileSync(dest, "utf8")).toBe("abc");
    expect(fs.existsSync(src)).toBe(false);
  });

  it("keeps the source and removes a bad copy when the copy does not match", () => {
    const dir = temp();
    const src = path.join(dir, "a.part");
    fs.writeFileSync(src, "abc");
    const dest = path.join(dir, "a.bin");
    const result = pins.moveVerified(src, dest, {
      rename: () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      },
      copy: (from: string, to: string) => fs.writeFileSync(to, "ab"),
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("does not hide a failure that is not a volume change", () => {
    const dir = temp();
    const src = path.join(dir, "a.part");
    fs.writeFileSync(src, "abc");
    const result = pins.moveVerified(src, path.join(dir, "a.bin"), {
      rename: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(src)).toBe(true);
  });
});

describe("the previous verified revision is kept as <id>.prev and can be restored", () => {
  const v1 = { "config.json": "{}", "model.bin": "weights-v1", "tok.json": "tok" };
  const v2 = { "config.json": "{}", "model.bin": "weights-v2!", "tok.json": "tok" };

  it("a folder without a verification marker is never swapped (the old repair path runs)", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    expect(swap.swapped).toBe(false);
    expect(fs.existsSync(`${dir}.prev`)).toBe(false);
  });

  it("the same revision is not swapped", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    const pin = pinOf(v1, REV1);
    expect(pins.writeMarker(dir, "t/r", pin)).toBe(true);
    expect(pins.readMarker(dir)).toMatchObject({ repo: "t/r", revision: REV1 });
    expect(pins.beginRevisionSwap(dir, "t/r", pin).swapped).toBe(false);
  });

  it("a new pinned revision moves the verified folder to .prev and seeds the unchanged files", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    expect(swap).toMatchObject({ swapped: true, prev: `${dir}.prev` });
    expect(swap.seeded.sort()).toEqual(["config.json", "tok.json"]);
    // The unchanged files are already in the new folder; the changed one is not, and the old copy is whole.
    expect(fs.readFileSync(path.join(dir, "config.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(path.join(dir, "model.bin"))).toBe(false);
    expect(fs.readFileSync(path.join(`${dir}.prev`, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.previousInfo(dir)).toMatchObject({ exists: true, revision: REV1 });
  });

  it("an incomplete old folder is not kept as the previous revision", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    fs.rmSync(path.join(dir, "model.bin"));
    expect(pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2)).swapped).toBe(false);
  });

  it("a folder that cannot be moved (a file is open) loses nothing, not even an older .prev", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    lay(`${dir}.prev`, { "model.bin": "older" });
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2), {
      rename: () => {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    expect(swap.swapped).toBe(false);
    expect(swap.reason).toMatch(/could not be moved/);
    expect(fs.readFileSync(path.join(dir, "model.bin"), "utf8")).toBe("weights-v1");
    expect(fs.readFileSync(path.join(`${dir}.prev`, "model.bin"), "utf8")).toBe("older");
  });

  it("a kill after the folder moved aside leaves .swap as the only copy: the next swap restores it first", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    fs.renameSync(dir, `${dir}.swap`); // the process died right after step one
    expect(fs.existsSync(dir)).toBe(false);
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    expect(swap.swapped).toBe(true);
    expect(fs.existsSync(`${dir}.swap`)).toBe(false);
    expect(fs.readFileSync(path.join(`${dir}.prev`, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.readMarker(`${dir}.prev`)?.revision).toBe(REV1);
  });

  it("a kill after the older .prev was removed also restores the verified copy (recoverSwap, and the audit)", async () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    fs.renameSync(dir, `${dir}.swap`);
    expect(pins.recoverSwap(dir)).toEqual({ recovered: true });
    expect(pins.readMarker(dir)?.revision).toBe(REV1);
    expect(pins.recoverSwap(dir)).toEqual({ recovered: false });
    fs.renameSync(dir, `${dir}.swap`);
    const audit = await pins.auditDir(dir, pinOf(v1, REV1));
    expect(audit.ok).toBe(true);
    expect(fs.existsSync(`${dir}.swap`)).toBe(false);
  });

  it("a failed rename that also fails to restore keeps .swap, and the next call puts it back", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    let calls = 0;
    const dying = (from: string, to: string) => {
      calls += 1;
      if (calls === 1) return fs.renameSync(from, to);
      throw Object.assign(new Error("killed"), { code: "EBUSY" });
    };
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2), { rename: dying });
    expect(swap.swapped).toBe(false);
    expect(fs.readFileSync(path.join(`${dir}.swap`, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.recoverSwap(dir).recovered).toBe(true);
    expect(fs.readFileSync(path.join(dir, "model.bin"), "utf8")).toBe("weights-v1");
  });

  it("a leftover .swap is deleted only when the folder is certified or .prev keeps a verified copy", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, { "model.bin": "half-written" }); // no marker, the only verified copy is the leftover
    lay(`${dir}.swap`, v1);
    pins.writeMarker(`${dir}.swap`, "t/r", pinOf(v1, REV1));
    const swap = pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    expect(swap.swapped).toBe(false);
    expect(fs.readFileSync(path.join(`${dir}.swap`, "model.bin"), "utf8")).toBe("weights-v1");
    // A certified folder makes the leftover redundant.
    fs.rmSync(dir, { recursive: true, force: true });
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    expect(pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2)).swapped).toBe(true);
    expect(fs.existsSync(`${dir}.swap`)).toBe(false);
  });

  it("rollback puts the previous revision back and drops the failed one", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    lay(dir, { "model.bin": "broken" }); // the new revision failed part way
    const back = pins.rollbackToPrevious(dir);
    expect(back).toMatchObject({ ok: true, revision: REV1 });
    expect(fs.readFileSync(path.join(dir, "model.bin"), "utf8")).toBe("weights-v1");
    expect(pins.readMarker(dir)?.revision).toBe(REV1);
    expect(fs.existsSync(`${dir}.prev`)).toBe(false);
  });

  it("rollback with nothing to restore says so and touches nothing", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v2);
    const back = pins.rollbackToPrevious(dir);
    expect(back.ok).toBe(false);
    expect(back.error).toMatch(/no previous/i);
    expect(fs.readFileSync(path.join(dir, "model.bin"), "utf8")).toBe("weights-v2!");
  });

  it("only one previous generation is kept: the next swap replaces an older .prev", () => {
    const root = temp();
    const dir = path.join(root, "m");
    lay(dir, v1);
    pins.writeMarker(dir, "t/r", pinOf(v1, REV1));
    pins.beginRevisionSwap(dir, "t/r", pinOf(v2, REV2));
    lay(dir, v2);
    pins.writeMarker(dir, "t/r", pinOf(v2, REV2));
    const v3 = { ...v2, "model.bin": "weights-v3!!" };
    pins.beginRevisionSwap(dir, "t/r", pinOf(v3, "3".repeat(40)));
    expect(pins.previousInfo(dir).revision).toBe(REV2);
    expect(pins.discardPrevious(dir)).toBe(true);
    expect(pins.previousInfo(dir).exists).toBe(false);
  });
});

describe("every pinned voice model carries honest manifest fields", () => {
  const repos = () => pins.pinnedRepos();

  it("has the fields, with diskBytes equal to the sum of the pinned bytes", () => {
    expect(repos().length).toBeGreaterThanOrEqual(12);
    for (const repo of repos()) {
      const facts = pins.manifestFor(repo);
      expect(facts, repo).not.toBeNull();
      const f = facts!;
      expect(f.diskBytes, repo).toBe(pins.pinnedBytes(pins.PINS[repo]!));
      expect(f.revision, repo).toBe(pins.PINS[repo]!.revision);
      expect(f.minRamGb, repo).toBeGreaterThan(0);
      expect(f.recommendedRamGb, repo).toBeGreaterThanOrEqual(f.minRamGb);
      expect(f.minVramGb, repo).toBeGreaterThanOrEqual(0);
      expect(typeof f.cpuOk, repo).toBe("boolean");
      expect(typeof f.gpuOk, repo).toBe("boolean");
      expect(f.cpuOk || f.gpuOk, repo).toBe(true);
      expect(f.quantization, repo).toMatch(/\S/);
      expect(["primary", "lightweight", "accuracy", "experimental", "optional-cloud"]).toContain(
        f.fallbackPriority,
      );
      expect(["measured", "estimated"]).toContain(f.basis);
    }
  });

  it("a model that needs a GPU says so, and a CPU model needs no video memory", () => {
    for (const repo of repos()) {
      const f = pins.manifestFor(repo)!;
      if (f.cpuOk) expect(f.minVramGb, repo).toBe(0);
      else expect(f.minVramGb, repo).toBeGreaterThan(0);
    }
  });

  it("resolves the renamed turbo repository to the same facts", () => {
    expect(pins.manifestFor("mobiuslabsgmbh/faster-whisper-large-v3-turbo")).toEqual(
      pins.manifestFor("dropbox-dash/faster-whisper-large-v3-turbo"),
    );
    expect(pins.manifestFor("someone/else")).toBeNull();
  });

  it("derives install and verify state from the folder, never from a stored flag", async () => {
    const dir = temp();
    const content = { "config.json": "{}", "model.bin": "weights-v1" };
    const pin = pinOf(content, REV1);
    expect(await pins.stateOf(path.join(dir, "none"), pin)).toEqual({
      installState: "missing",
      verifyState: "unverified",
    });
    lay(dir, { "config.json": "{}" });
    expect(await pins.stateOf(dir, pin)).toMatchObject({ installState: "partial" });
    lay(dir, content);
    expect(await pins.stateOf(dir, pin)).toEqual({ installState: "installed", verifyState: "ok" });
    fs.writeFileSync(path.join(dir, "model.bin"), "weights-XX");
    expect(await pins.stateOf(dir, pin, { hash: true })).toEqual({
      installState: "installed",
      verifyState: "damaged",
    });
  });
});

describe("Doctor rows for the model folders (unexpected files, previous revision, rollback)", () => {
  const weights = require_("../../electron/voice-weights.cjs") as {
    HINDI_EAR_REPO: string;
    folderChecks: (
      root: string,
      deps?: Record<string, unknown>,
    ) => Promise<
      {
        id: string;
        ok: boolean;
        optional?: boolean;
        installId?: string;
        rollbackId?: string;
        detail: string;
      }[]
    >;
    restoreModel: (
      root: string,
      catalogId: string,
    ) => { ok: boolean; revision: string; error: string };
    modelPath: (root: string, id: string) => string;
  };
  const earPin = () => pins.PINS[weights.HINDI_EAR_REPO]!;
  const layEar = (root: string) => {
    const dir = path.join(root, "models", "hindi-ear");
    for (const name of Object.keys(earPin().files)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), "x");
    }
    return dir;
  };
  const real = { exists: (file: string) => fs.existsSync(file) };

  it("no row at all for a clean folder", async () => {
    const root = temp();
    layEar(root);
    expect(await weights.folderChecks(root, real)).toEqual([]);
  });

  it("an unexpected file is a failing optional row that offers the reinstall which quarantines it", async () => {
    const root = temp();
    const dir = layEar(root);
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    const rows = await weights.folderChecks(root, real);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "extras-hindi-ear",
      ok: false,
      optional: true,
      installId: "hindi-ear",
    });
    expect(rows[0]!.detail).toMatch(/README\.md/);
  });

  it("a kept previous revision is a green info row, and red with a restore offer when the pin row fails", async () => {
    const root = temp();
    const dir = layEar(root);
    fs.mkdirSync(`${dir}.prev`, { recursive: true });
    pins.writeMarker(`${dir}.prev`, weights.HINDI_EAR_REPO, { ...earPin(), revision: REV1 });
    const quiet = await weights.folderChecks(root, { ...real, pinRows: [] });
    expect(quiet).toHaveLength(1);
    expect(quiet[0]).toMatchObject({ id: "rollback-hindi-ear", ok: true, rollbackId: "hindi-ear" });
    expect(quiet[0]!.detail).toMatch(new RegExp(REV1.slice(0, 8)));
    const loud = await weights.folderChecks(root, {
      ...real,
      pinRows: [
        { id: "hindi-ear-pin", ok: false, label: "x", detail: "model.int8.onnx fails SHA-256" },
      ],
    });
    expect(loud[0]).toMatchObject({ id: "rollback-hindi-ear", ok: false, rollbackId: "hindi-ear" });
    expect(loud[0]!.detail).toMatch(/restore/i);
  });

  it("a speech-load failure the caller reports also offers the restore", async () => {
    const root = temp();
    const dir = layEar(root);
    fs.mkdirSync(`${dir}.prev`, { recursive: true });
    const rows = await weights.folderChecks(root, {
      ...real,
      pinRows: [],
      loadFailed: ["hindi-ear"],
    });
    expect(rows[0]).toMatchObject({ ok: false, rollbackId: "hindi-ear" });
  });

  it("adopts a folder whose pin row passed a hashed check, so the next pinned revision can keep it as .prev", async () => {
    const root = temp();
    const dir = layEar(root);
    expect(pins.readMarker(dir)).toBeNull();
    await weights.folderChecks(root, {
      ...real,
      adopt: true,
      pinRows: [{ id: "hindi-ear-pin", ok: true, label: "x", detail: "" }],
    });
    expect(pins.readMarker(dir)?.revision).toBe(earPin().revision);
    // A failing row is never adopted.
    const other = temp();
    const bad = layEar(other);
    await weights.folderChecks(other, {
      ...real,
      adopt: true,
      pinRows: [{ id: "hindi-ear-pin", ok: false, label: "x", detail: "" }],
    });
    expect(pins.readMarker(bad)).toBeNull();
  });

  it("restoreModel puts the previous revision back by catalog id", () => {
    const root = temp();
    const dir = layEar(root);
    fs.mkdirSync(`${dir}.prev`, { recursive: true });
    fs.writeFileSync(path.join(`${dir}.prev`, "vocab.txt"), "old");
    pins.writeMarker(`${dir}.prev`, weights.HINDI_EAR_REPO, { ...earPin(), revision: REV1 });
    const back = weights.restoreModel(root, "hindi-ear");
    expect(back).toMatchObject({ ok: true, revision: REV1 });
    expect(fs.readFileSync(path.join(dir, "vocab.txt"), "utf8")).toBe("old");
    expect(weights.restoreModel(root, "hindi-ear").ok).toBe(false);
    expect(weights.restoreModel(root, "no-such-model").error).toMatch(/unknown/i);
    expect(weights.restoreModel(root, "silero-vad").ok).toBe(false);
  });
});
